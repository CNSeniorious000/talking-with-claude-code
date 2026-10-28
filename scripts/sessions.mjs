#!/usr/bin/env bun
import { createReadStream, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class Failure extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new Failure(code, message); };
const missing = e => e.code === 'ENOENT' || e.code === 'ESRCH';
const normalize = s => String(s).trim().replace(/\s+/g, ' ');
const options = {id:{type:'string'},pid:{type:'string'},text:{type:'string'},tail:{type:'string'},'max-chars':{type:'string'},before:{type:'string'},after:{type:'string'},events:{type:'boolean'},'config-dir':{type:'string'},help:{type:'boolean'}};
const {values:args,positionals} = parseArgs({args:process.argv.slice(2),options,allowPositionals:true});
const command = positionals[0], root = resolve(args['config-dir'] || process.env.CLAUDE_CONFIG_DIR || join(homedir(),'.claude'));
const number = (name, fallback, max) => { const value=args[name]===undefined?fallback:Number(args[name]); if(!Number.isSafeInteger(value)||value<0||value>max)fail('invalid_argument',`--${name} must be an integer between 0 and ${max}`); return value; };
function sessionId() { if(!UUID.test(args.id||''))fail('invalid_argument','--id requires a full session UUID'); return args.id; }
function readRegistration(file) {
  const st=lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid())fail('unsafe_registry','Registration must be a regular file owned by this user');
  const row=JSON.parse(readFileSync(file,'utf8')),pid=Number(basename(file,'.json'));
  if(!Number.isSafeInteger(pid)||pid<1||row.pid!==pid||!UUID.test(row.sessionId||''))fail('invalid_registry','Registration has inconsistent PID or session UUID');
  return {...row,registryFile:file};
}
function processIdentity(row) {
  try { process.kill(row.pid,0); } catch(e) { if(e.code==='ESRCH')return 'gone'; throw e; }
  // Claude records lstart in UTC; local-time comparison falsely treats every PID as reused.
  const procStat=process.platform==='linux'?readFileSync(`/proc/${row.pid}/stat`,'utf8'):null;
  const start=procStat!==null ? procStat.slice(procStat.lastIndexOf(')')+2).split(/\s+/)[19] : execFileSync('/bin/ps',['-p',String(row.pid),'-o','lstart='],{encoding:'utf8',timeout:3000,env:{...process.env,TZ:'UTC',LC_ALL:'C'}}).trim();
  if(!start)return 'gone';
  return typeof row.procStart==='string'&&normalize(row.procStart)===normalize(start)?'verified':'unverified';
}
function registrations() {
  let files; try { files=readdirSync(join(root,'sessions')).filter(f=>/^\d+\.json$/.test(f)); } catch(e) { if(e.code==='ENOENT')return {rows:[],warnings:[]}; throw e; }
  const rows=[],warnings=[];
  for(const f of files)try {
    const row=readRegistration(join(root,'sessions',f)),identity=processIdentity(row);
    if(identity!=='gone')rows.push({...row,processIdentity:identity});
  } catch(e) { if(!missing(e))warnings.push({file:f,error:e.code||'unreadable_registry',message:e.message}); }
  return {rows,warnings};
}
async function transcriptPath(id) {
  let dirs; try { dirs=await readdir(join(root,'projects'),{withFileTypes:true}); } catch(e) { if(e.code==='ENOENT')fail('transcript_missing','No local transcript directory'); throw e; }
  const found=[];
  for(const d of dirs.filter(d=>d.isDirectory())) {
    const file=join(root,'projects',d.name,`${id}.jsonl`);
    try { const s=lstatSync(file); if(s.isSymbolicLink()||!s.isFile())fail('unsafe_transcript','Transcript must be a regular file'); found.push(file); } catch(e) { if(e.code!=='ENOENT')throw e; }
  }
  if(found.length!==1)fail(found.length?'ambiguous_transcript':'transcript_missing',`Expected one transcript for ${id}; found ${found.length}`);
  return found[0];
}
function content(row,events) {
  const body=row.message?.content;
  if(typeof body==='string')return body;
  if(!Array.isArray(body))return '';
  return body.flatMap(b=>{
    if(b.type==='text')return [b.text||''];
    if(events&&b.type==='tool_result')return [typeof b.content==='string'?b.content:JSON.stringify(b.content)];
    if(events&&b.type==='tool_use')return [`[tool ${b.name}] ${JSON.stringify(b.input)}`];
    return [];
  }).join('\n');
}
function relinkCompaction(nodes,warnings) {
  const entries=[...nodes.values()], boundaries=entries.filter(r=>r.type==='system'&&r.subtype==='compact_boundary');
  if(!boundaries.some(r=>r.compactMetadata?.preservedMessages||r.compactMetadata?.preservedSegment))return {};
  const boundary=boundaries.at(-1),meta=boundary.compactMetadata||{},cut=entries.indexOf(boundary);
  let kept=meta.preservedMessages;
  if(!kept&&meta.preservedSegment){
    const segment=meta.preservedSegment,ids=[],seen=new Set();let node=nodes.get(segment.tailUuid);
    while(node&&!seen.has(node.uuid)){seen.add(node.uuid);ids.unshift(node.uuid);if(node.uuid===segment.headUuid)break;node=nodes.get(node.parentUuid);}
    if(ids[0]!==segment.headUuid){warnings.push('Cannot reconstruct preserved compaction segment');return {incomplete:true};}
    kept={anchorUuid:segment.anchorUuid,uuids:ids};
  }
  const ids=kept?.uuids||[];
  if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!nodes.has(id))||(ids.length&&(!nodes.has(kept.anchorUuid)||ids.includes(kept.anchorUuid)))){
    warnings.push('Preserved compaction references are incomplete or invalid');return {incomplete:true};
  }
  // Compaction keeps selected old turns but changes their place in the active parent chain.
  if(ids.length){
    let parent=kept.anchorUuid;
    for(const id of ids){nodes.set(id,{...nodes.get(id),parentUuid:parent});parent=id;}
    for(const [id,node] of nodes)if(node.parentUuid===kept.anchorUuid&&id!==ids[0])nodes.set(id,{...node,parentUuid:parent});
  }
  const retained=new Set(ids),removed=new Set(entries.slice(0,cut).filter(r=>!retained.has(r.uuid)).map(r=>r.uuid));
  for(const id of removed)nodes.delete(id);
  if(ids.length)for(const [id,node] of nodes)if(['user','assistant'].includes(node.type)&&removed.has(node.parentUuid))nodes.set(id,{...node,parentUuid:ids.at(-1)});
  return {tail:ids.at(-1),boundary:boundary.uuid};
}
async function conversation(id,events=false) {
  const file=await transcriptPath(id),records=[],warnings=[];
  let line=0;
  for await(const text of createInterface({input:createReadStream(file),crlfDelay:Infinity})) {
    line++;if(!text.trim())continue;
    try { records.push(JSON.parse(text)); } catch { warnings.push(`Unparsed transcript line ${line}; it may be an incomplete write`); }
  }
  const nodes=new Map(records.filter(r=>r.uuid).map(r=>[r.uuid,r]));
  const compact=relinkCompaction(nodes,warnings);let ancestryIncomplete=!!compact.incomplete;
  const after=compact.tail?records.slice(records.findIndex(r=>r.uuid===compact.boundary)+1):[...nodes.values()];
  const leaf=after.findLast(r=>['user','assistant'].includes(r.type)&&r.uuid&&!r.isSidechain);
  const last=nodes.get(leaf?.uuid||compact.tail);
  let branch=[...nodes.values()];
  if(last) {
    const chain=[],visited=new Set();let node=last;
    while(node){ if(visited.has(node.uuid)){warnings.push('Conversation ancestry contains a cycle');break} visited.add(node.uuid);chain.push(node);if(!node.parentUuid)break;const parent=nodes.get(node.parentUuid);if(!parent){ancestryIncomplete=true;break}node=parent; }
    branch=chain.reverse();
  }
  const messages=branch.flatMap(r=>{
    if(!['user','assistant'].includes(r.type)||r.isSidechain)return [];
    const text=content(r,events);if(!text)return [];
    const peer=r.origin?.kind==='peer',summary=r.isCompactSummary||text.startsWith('This session is being continued');
    const event=r.isMeta&&!peer&&!summary||/^<(task-notification|local-command|command-name|bash-)/.test(text)||Array.isArray(r.message?.content)&&r.message.content.every(b=>b.type==='tool_result'||b.type==='tool_use');
    if(event&&!events)return [];
    return [{id:r.uuid||null,role:summary?'context':peer?'peer':event?'event':r.type,timestamp:r.timestamp||null,text,...peer&&{from:r.origin.from}}];
  });
  return {source:file,messages,branchIds:branch.map(r=>r.uuid),cursor:last?.uuid||null,ancestryIncomplete,warnings};
}
function page(data) {
  if(args.before&&args.after)fail('invalid_argument','Use --before or --after, not both');
  let messages=data.messages;
  const anchor=args.before||args.after;
  if(anchor){const index=data.branchIds.indexOf(anchor);if(index<0)fail('cursor_missing','Cursor is not on the current conversation branch; reread without the cursor');const ids=new Set(args.before?data.branchIds.slice(0,index):data.branchIds.slice(index+1));messages=messages.filter(m=>ids.has(m.id));}
  const tail=number('tail',12,100000),budget=number('max-chars',12000,1000000),total=messages.length;
  if(tail)messages=messages.slice(-tail);
  let left=budget,truncated=messages.length<total;
  // Budget from newest backwards so an old long message cannot hide the latest request.
  messages=messages.slice().reverse().flatMap(m=>{if(left===0){truncated=true;return []}const text=m.text.slice(0,left),cut=text.length<m.text.length;left-=text.length;truncated ||= cut;return [{...m,text,...cut&&{truncated:true}}]}).reverse();
  const {branchIds,...visible}=data;
  return {...visible,messages,availableMessages:total,truncated,firstCursor:messages[0]?.id||null,lastCursor:messages.at(-1)?.id||null};
}
function socketIdentity(row) {
  if(processIdentity(row)!=='verified')fail('process_changed','Process start time is missing or no longer matches the registration');
  const socket=row.messagingSocketPath;if(typeof socket!=='string'||!socket.startsWith('/'))fail('socket_unavailable','Session has no local Unix socket');
  const stat=lstatSync(socket),parent=lstatSync(dirname(socket));
  if(!stat.isSocket()||stat.isSymbolicLink()||stat.uid!==process.getuid())fail('unsafe_socket','Socket must belong to this user and must not be a symlink');
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||(parent.mode&0o022)!==0)fail('unsafe_socket','Socket directory must be private and owned by this user');
  return {path:socket,ino:stat.ino,dev:stat.dev};
}
async function send() {
  const id=sessionId(),pid=number('pid',0,2147483647);if(!pid)fail('invalid_argument','--pid is required; use the exact PID from a fresh list');
  if(args.text===undefined)fail('invalid_argument','--text is required; use --text - to read stdin');
  const text=args.text==='-'?await Bun.stdin.text():args.text;if(!text.trim())fail('invalid_argument','Message must not be empty');
  const file=join(root,'sessions',`${pid}.json`),row=readRegistration(file);
  if(row.sessionId!==id)fail('target_mismatch','UUID and PID do not refer to the same registered session');
  const socket=socketIdentity(row),msgId=randomUUID(),payload=JSON.stringify({type:'user',session_id:id,uuid:msgId,msg_id:msgId,from:'external-agent',message:{role:'user',content:text}})+'\n';
  if(payload.length>1000000)fail('message_too_large','Serialized message exceeds 1,000,000 characters');
  let cursor=null;try{cursor=(await conversation(id,true)).messages.at(-1)?.id||null}catch(e){if(e.code!=='transcript_missing')throw e}
  await new Promise((resolve,reject)=>{
    let submitted=false;
    const client=createConnection({path:socket.path},()=>{
      try {
        // Discovery is a snapshot. Revalidate after connect, before any bytes leave.
        const current=readRegistration(file),now=socketIdentity(current);
        if(current.sessionId!==id||current.procStart!==row.procStart||now.path!==socket.path||now.ino!==socket.ino||now.dev!==socket.dev)fail('target_changed','Session or socket changed; nothing sent');
        client.end(payload,()=>{submitted=true;});
      }catch(e){client.destroy(e)}
    });
    client.setTimeout(5000,()=>client.destroy(new Failure(submitted?'outcome_unknown':'socket_timeout',submitted?'Bytes were written but the connection did not close; inspect the recipient before retrying':'Socket timed out')));
    client.on('error',e=>reject(submitted?new Failure('outcome_unknown','Connection failed after writing; inspect the recipient before retrying'):e));
    client.on('data',()=>{});client.on('close',error=>{if(!error){if(submitted)resolve();else reject(new Failure('not_submitted','Connection closed before write completed'));}});
  });
  return {status:'submitted',acceptance:'unconfirmed',sessionId:id,pid,messageId:msgId,cursor,sentAt:new Date().toISOString(),note:'Read the recipient transcript to verify receipt or completion. Do not infer either from this write.'};
}
async function main() {
  if(args.help||!command)return {usage:'bun scripts/sessions.mjs list | read --id UUID [--tail N --max-chars N --before UUID --after UUID --events] | send --id UUID --pid PID --text TEXT',configDir:root};
  if(positionals.length!==1)fail('invalid_argument','Unexpected positional arguments; pass message text with --text');
  if(!['darwin','linux'].includes(process.platform))fail('unsupported_platform','Only macOS and Linux Unix sockets are supported');
  if(command==='read')return {sessionId:sessionId(),...page(await conversation(args.id,args.events))};
  if(command==='send')return send();
  if(command!=='list')fail('invalid_argument',`Unknown command: ${command}`);
  const {rows,warnings}=registrations(),sessions=[];
  for(const row of rows) {
    let context={};try{const c=await conversation(row.sessionId),last=c.messages.at(-1);context={source:c.source,lastMessage:last?{...last,text:last.text.slice(0,500),truncated:last.text.length>500}:null,latestUser:c.messages.findLast(m=>m.role==='user')?.text.slice(0,300),ancestryIncomplete:c.ancestryIncomplete,transcriptWarnings:c.warnings};}catch(e){context={transcriptError:e.code||e.message}}
    sessions.push({id:row.sessionId,pid:row.pid,name:row.name||null,cwd:row.cwd,status:row.status||'unknown',statusUpdatedAt:row.statusUpdatedAt||null,waitingFor:row.waitingFor||null,version:row.version,processIdentity:row.processIdentity,socket:row.messagingSocketPath||null,...context});
  }
  return {capturedAt:new Date().toISOString(),configDir:root,sessions,warnings};
}
try { console.log(JSON.stringify(await main(),null,2)); } catch(e) { console.error(JSON.stringify({error:e.code||'failed',message:e.message}));process.exitCode=1; }
