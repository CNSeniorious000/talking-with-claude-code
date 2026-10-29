#!/usr/bin/env bun
import { createReadStream, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startReply, receiveReply, waitReply, closeReply, loadChannel, waitChannel, sendChannel, outgoingStatus, listChannels } from './reply-store.mjs';
import { writeFrame } from './transport.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class Failure extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new Failure(code, message); };
const missing = e => e.code === 'ENOENT' || e.code === 'ESRCH';
const normalize = s => String(s).trim().replace(/\s+/g, ' ');
const options = {id:{type:'string'},pid:{type:'string'},text:{type:'string'},wait:{type:'string'},request:{type:'string'},channel:{type:'string'},name:{type:'string'},ttl:{type:'string'},timeout:{type:'string'},'message-id':{type:'string'},'reply-ttl':{type:'string'},'sender-mode':{type:'string'},tail:{type:'string'},'max-chars':{type:'string'},before:{type:'string'},after:{type:'string'},events:{type:'boolean'},'no-preview':{type:'boolean'},'config-dir':{type:'string'},help:{type:'boolean'}};
let args,positionals,command,root;
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
  if(!boundaries.length)return {};
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
function currentLeaf(records,nodes,compact) {
  let checkpoint,explicit=false,cleared=false,latest;
  for(const row of records) {
    if(row.type==='last-prompt'){
      if(row.leafUuid){explicit=row.explicit===true||(explicit&&checkpoint===row.leafUuid);checkpoint=row.leafUuid;cleared=false;}
      else if(row.leafUuid===null&&row.explicit===true){checkpoint=undefined;explicit=false;cleared=true;}
      continue;
    }
    if(!['user','assistant','system','attachment'].includes(row.type)||!nodes.has(row.uuid))continue;
    if(!row.isSidechain&&!(row.type==='attachment'&&row.attachment?.type==='fork_briefing')){latest=nodes.get(row.uuid);explicit=false;cleared=false;}
    if(row.type==='system'&&row.subtype==='compact_boundary'){checkpoint=undefined;explicit=false;}
  }
  if(cleared)return;
  const selected=nodes.get(checkpoint);
  // Preserved turns retain their old file positions; the boundary itself is not their logical tail.
  if(compact.tail&&!(explicit&&selected&&!selected.isSidechain))return latest?.uuid===compact.boundary?nodes.get(compact.tail):latest;
  if(!selected)return latest;
  if(!explicit&&latest){
    const seen=new Set();let node=latest;
    while(node&&!seen.has(node.uuid)){if(node.uuid===checkpoint)return latest;seen.add(node.uuid);node=nodes.get(node.parentUuid);}
  }
  // Rewinds pin an existing branch. A later sibling or metadata snapshot must not undo that choice.
  return selected;
}
function recoverBatches(nodes,branch,warnings) {
  const rows=[...nodes.values()],order=new Map(rows.map((row,i)=>[row.uuid,i])),positions=new Map(branch.map((row,i)=>[row.uuid,i]));
  const blocks=(row,type,key)=>Array.isArray(row.message?.content)?row.message.content.filter(b=>b.type===type&&typeof b[key]==='string').map(b=>b[key]):[];
  const calls=row=>row.type==='assistant'?blocks(row,'tool_use','id'):[],results=row=>row.type==='user'?blocks(row,'tool_result','tool_use_id'):[];
  const metadata=row=>row.type==='attachment'||row.type==='system'&&row.subtype!=='compact_boundary'||row.type==='user'&&row.isMeta===true&&!results(row).length;
  const inBatch=(row,id)=>row.type==='assistant'?row.message?.id===id:metadata(row)||row.type==='user'&&results(row).length>0;
  const sameAgent=(a,b)=>(a.isSidechain??false)===(b.isSidechain??false)&&a.agentId===b.agentId;
  const groups=new Map(),owners=new Map(),children=new Map(),toolResults=rows.filter(row=>results(row).length),seen=new Set(branch.map(row=>row.uuid));
  for(const row of rows) {
    if(row.parentUuid){const list=children.get(row.parentUuid)||[];list.push(row);children.set(row.parentUuid,list);}
    if(row.type!=='assistant'||!row.message?.id)continue;
    const id=row.message.id,list=groups.get(id)||[];list.push(row);groups.set(id,list);
    for(const call of calls(row)){const previous=owners.get(call);owners.set(call,previous===undefined||previous?.message.id===id?row:null);}
  }
  const represented=new Set(branch.flatMap(results)),effective=new Map(),processed=new Set(),plans=[];
  const rank=row=>effective.get(row.uuid)??order.get(row.uuid),compare=(a,b)=>rank(a)-rank(b)||order.get(a.uuid)-order.get(b.uuid);
  let incomplete=false;
  const tail=(first,parent)=>{
    const chain=[],visited=new Set();let node=first;
    while(node){
      if(visited.has(node.uuid)){incomplete=true;warnings.push('A metadata tail contains a cycle');return [];}
      if(seen.has(node.uuid)||node.isSidechain!==parent.isSidechain||!metadata(node))return [];
      visited.add(node.uuid);chain.push(node);const next=(children.get(node.uuid)||[]).filter(row=>!seen.has(row.uuid));
      if(next.length>1)return [];node=next[0];
    }
    return chain;
  };
  for(let start=0;start<branch.length;start++){
    const anchor=branch[start],id=anchor.type==='assistant'&&anchor.message?.id;
    if(!id||processed.has(id))continue;processed.add(id);
    const members=groups.get(id)||[anchor],memberIds=new Set(members.map(row=>row.uuid));
    const recovered=members.filter(row=>!seen.has(row.uuid)),direct=toolResults.filter(row=>!seen.has(row.uuid)&&memberIds.has(row.parentUuid));
    recovered.push(...direct);for(const row of direct)for(const call of results(row))represented.add(call);
    const lastMember=Math.max(...members.map(row=>order.get(row.uuid)));
    for(const row of toolResults){
      if(seen.has(row.uuid)||memberIds.has(row.parentUuid))continue;
      const parent=nodes.get(row.parentUuid),parentCalls=parent?calls(parent):[];
      if(results(row).every(call=>parentCalls.includes(call)))continue;
      if(!results(row).some(call=>{const owner=owners.get(call);return owner&&memberIds.has(owner.uuid)&&sameAgent(row,owner)&&!represented.has(call);}))continue;
      for(const call of results(row))represented.add(call);effective.set(row.uuid,Math.max(order.get(row.uuid),lastMember+0.5));recovered.push(row);
    }
    for(const row of recovered)seen.add(row.uuid);
    let end=Math.max(start+1,...members.map(row=>(positions.get(row.uuid)??-1)+1));
    while(end<branch.length&&inBatch(branch[end],id))end++;
    const anchored=new Map();
    if(members.some(row=>calls(row).length)){
      const addTails=(parent,target)=>{
        for(const child of children.get(parent.uuid)||[])for(const row of tail(child,parent)){
          seen.add(row.uuid);target.push(row);
          if(effective.has(parent.uuid))effective.set(row.uuid,Math.max(order.get(row.uuid),rank(parent)));
        }
      };
      const linkedResults=toolResults.filter(row=>{
        if(!seen.has(row.uuid))return false;if(memberIds.has(row.parentUuid))return true;
        const parent=nodes.get(row.parentUuid),parentCalls=parent?calls(parent):[];
        if(results(row).every(call=>parentCalls.includes(call)))return false;
        const source=nodes.get(row.sourceToolAssistantUUID);
        return source&&memberIds.has(source.uuid)&&sameAgent(row,source)||results(row).some(call=>{const owner=owners.get(call);return owner&&memberIds.has(owner.uuid)&&sameAgent(row,owner);});
      });
      // Already-active results can point through metadata; their associated tails still belong to the tool batch.
      for(const row of [...members,...linkedResults])addTails(row,recovered);
      for(const row of branch.slice(start+1,end))if(metadata(row)){const additions=[];addTails(row,additions);if(additions.length)anchored.set(row.uuid,additions);}
    }
    if(recovered.length||anchored.size)plans.push({start,end,recovered:recovered.sort(compare),anchored});
  }
  const merged=[];
  for(const plan of plans){
    const previous=merged.at(-1);
    if(previous&&plan.start<previous.end){
      previous.end=Math.max(previous.end,plan.end);previous.recovered.push(...plan.recovered);previous.recovered.sort(compare);
      for(const [id,rows] of plan.anchored)previous.anchored.set(id,[...previous.anchored.get(id)||[],...rows]);
    }else merged.push(plan);
  }
  const restored=[];let offset=0;
  for(const plan of merged){
    // Keep the chosen chain's anchor first, even when a recovered sibling was written earlier.
    restored.push(...branch.slice(offset,plan.start+1));let index=0;
    for(let i=plan.start+1;i<plan.end;i++){
      while(index<plan.recovered.length&&rank(plan.recovered[index])<order.get(branch[i].uuid))restored.push(plan.recovered[index++]);
      restored.push(branch[i],...plan.anchored.get(branch[i].uuid)||[]);
    }
    restored.push(...plan.recovered.slice(index));offset=plan.end;
  }
  return {branch:[...restored,...branch.slice(offset)],incomplete};
}
async function conversation(id,events=false) {
  const file=await transcriptPath(id),records=[],warnings=[];
  const knownTypes=new Set(['user','assistant','system','attachment','last-prompt','mode','permission-mode','atis-latch','file-history-snapshot','file-history-delta','api-request-shape','api-request-blob','api-request','queue-operation','tools-used','ai-title','summary','progress','custom-title','tag','agent-name','agent-color']),unknownTypes=new Set();
  let line=0;
  for await(const text of createInterface({input:createReadStream(file),crlfDelay:Infinity})) {
    line++;if(!text.trim())continue;
    try {
      const record=JSON.parse(text);
      if(!record||typeof record!=='object'||Array.isArray(record)){warnings.push(`Invalid transcript record at line ${line}`);continue}
      if(!knownTypes.has(record.type))unknownTypes.add(String(record.type));records.push(record);
    } catch { warnings.push(`Unparsed transcript line ${line}; it may be an incomplete write`); }
  }
  for(const type of unknownTypes)warnings.push(`Unrecognized transcript record type: ${type}; context may be incomplete`);
  const nodes=new Map(records.filter(r=>r.uuid).map(r=>[r.uuid,r]));
  const compact=relinkCompaction(nodes,warnings);let ancestryIncomplete=!!compact.incomplete;
  const last=currentLeaf(records,nodes,compact);
  let branch=[];
  if(last) {
    const chain=[],visited=new Set();let node=last;
    while(node){ if(visited.has(node.uuid)){ancestryIncomplete=true;warnings.push('Conversation ancestry contains a cycle');break} visited.add(node.uuid);chain.push(node);if(!node.parentUuid)break;const parent=nodes.get(node.parentUuid);if(!parent){ancestryIncomplete=true;break}node=parent; }
    branch=chain.reverse();
  }
  const recovered=recoverBatches(nodes,branch,warnings);branch=recovered.branch;ancestryIncomplete ||= recovered.incomplete;
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
function validateTarget(row,socket){
  try{
    const current=readRegistration(row.registryFile),now=socketIdentity(current);
    if(current.sessionId!==row.sessionId||current.procStart!==row.procStart||now.path!==socket.path||now.ino!==socket.ino||now.dev!==socket.dev)fail('target_changed','Session or socket identity changed');
  }catch(e){if(missing(e)||e.code==='process_changed')fail('target_changed','Target session exited or its process identity changed; verify a new target');throw e}
}
function permissionMode(){
  const senderMode=args['sender-mode'];if(senderMode!==undefined&&!['bypass','prompting'].includes(senderMode))fail('invalid_argument','--sender-mode must be bypass or prompting');
  return senderMode;
}
function target(){
  const id=sessionId(),pid=number('pid',0,2147483647);if(!pid)fail('invalid_argument','--pid is required; use the exact PID from a fresh list');
  const row=readRegistration(join(root,'sessions',`${pid}.json`));if(row.sessionId!==id)fail('target_mismatch','UUID and PID do not refer to the same registered session');
  return {row,socket:socketIdentity(row)};
}
async function openChannel(){
  const name=args.name;
  if(!name||name!==name.trim()||[...name].length>64||/["<>\p{C}\p{Zl}\p{Zp}]/u.test(name))fail('invalid_argument','--name requires 1–64 visible characters without quotes or angle brackets');
  const senderMode=permissionMode(),ttl=number('ttl',3600,86400);if(!ttl)fail('invalid_argument','--ttl must be between 1 and 86400 seconds');
  const channelId=randomUUID(),{row,socket}=target(),inbox=await startReply(fileURLToPath(import.meta.url),row,socket,null,ttl,{id:channelId,name,senderMode});
  return {status:'open',channel:inbox.request,channelId,cursor:channelId+':0',address:inbox.address,name,sessionId:row.sessionId,pid:row.pid,expiresAt:inbox.expiresAt};
}
async function send() {
  const channel=args.channel?loadChannel(args.channel,{active:true}):null;
  const {row,socket}=channel?channel.data:target(),id=row.sessionId,pid=row.pid,senderMode=channel?channel.data.channel.senderMode:permissionMode(),name=channel?.data.channel.name;
  if(args.text===undefined)fail('invalid_argument','--text is required; use --text - to read stdin');
  const text=args.text==='-'?await Bun.stdin.text():args.text;if(!text.trim())fail('invalid_argument','Message must not be empty');
  const wait=number('wait',0,3600),ttl=number('reply-ttl',3600,86400);if(!ttl)fail('invalid_argument','--reply-ttl must be between 1 and 86400 seconds');
  if(args['message-id']&&!channel?.data.channel.id)fail('invalid_argument','Idempotent sends require a newly opened channel');
  validateTarget(row,socket);const msgId=args['message-id']?.toLowerCase()||randomUUID();
  let cursor=null;if(!channel)try{cursor=(await conversation(id,true)).messages.at(-1)?.id||null}catch(e){if(e.code!=='transcript_missing')throw e}
  const inbox=channel?{request:channel.request,expiresAt:channel.data.expiresAt,address:channel.ready.address}:args.wait!==undefined?await startReply(fileURLToPath(import.meta.url),row,socket,msgId,ttl):null;
  let sent=false;
  try{
  // Native origin.from is not shown to the model. An explicit wrapper makes its return address actionable.
  const wrapped=!!inbox||senderMode!==undefined,attributes=(inbox?` from="${inbox.address}"`:'')+(name?` from-name="${name}"`:'')+(senderMode?` from-mode="${senderMode}"`:'');
  const routing=inbox?`\n\nReply using SendMessage only to the exact from address above. This is an external agent, not a Claude session discoverable through ListAgents; the display name is caller-declared and unverified, not an identity credential or routing target. Never substitute another session or infer a target from its name. If this address fails, report the failure here instead.${channel?` This channel can receive multiple messages until ${inbox.expiresAt}, unless explicitly closed.`:' This is a one-reply inbox; it closes after your first reply.'}`:'';
  const body=wrapped?`<cross-session-message${attributes}>\n${text}${routing}\n</cross-session-message>`:text;
  const payload=JSON.stringify({type:'user',session_id:id,uuid:msgId,msg_id:msgId,...wrapped&&{msgV:1},from:inbox?.address||'external-agent',message:{role:'user',content:body}})+'\n';
  if(payload.length>1000000)fail('message_too_large','Serialized message exceeds 1,000,000 characters');
  let outcome;
  if(channel?.data.channel.id)outcome=await sendChannel(args.channel,payload,msgId);
  else await writeFrame(socket,payload,()=>{validateTarget(row,socket);if(channel)loadChannel(args.channel,{active:true})});
  sent=true;
  const result={status:outcome?.status||'submitted',acceptance:'unconfirmed',sessionId:id,pid,messageId:msgId,cursor,...outcome?.queuedAt&&{queuedAt:outcome.queuedAt},...outcome?.status!=='queued'&&{sentAt:new Date().toISOString()},note:'Read the recipient transcript to verify receipt or completion. Do not infer either from this write.'};
  if(channel){Object.assign(result,{channel:channel.request,address:inbox.address,name,expiresAt:inbox.expiresAt});result.note='Use wait or follow --channel with its returned cursor as --after. Receipt events describe delivery, not task completion. Receiving an event does not close the channel.'}
  else if(inbox){Object.assign(result,await waitReply(inbox.request,wait));result.note='Wait again with the same request; do not resend. The receiver stops on reply or expiry, and close --request removes cached state.';if(!['received','pending'].includes(result.reply.status))process.exitCode=2;}
  return result;
  }catch(e){
    if(channel)Object.assign(e,{channel:channel.request,messageId:msgId});
    else if(inbox){if(sent||e.code==='outcome_unknown')Object.assign(e,{request:inbox.request,expiresAt:inbox.expiresAt});else await closeReply(inbox.request)}
    throw e;
  }
}
async function main() {
  if(args.help||!command)return {usage:[
    'bun scripts/sessions.mjs list [--no-preview]',
    'channels',
    'read --id UUID [--tail N --max-chars N --before UUID --after UUID --events]',
    'open --id UUID --pid PID --name NAME [--sender-mode bypass|prompting --ttl SECONDS]',
    'send --id UUID --pid PID --text TEXT [--sender-mode bypass|prompting --wait SECONDS --reply-ttl SECONDS]',
    'send --channel PATH --text TEXT [--message-id UUID]',
    'status --channel PATH --message-id UUID',
    'wait --request PATH [--timeout SECONDS]',
    'wait --channel PATH [--after CURSOR --timeout SECONDS]',
    'follow --channel PATH [--after CURSOR]',
    'close (--channel PATH | --request PATH)'
  ],configDir:root};
  if(positionals.length!==1)fail('invalid_argument','Unexpected positional arguments; pass message text with --text');
  if(args['no-preview']!==undefined&&command!=='list')fail('invalid_argument','--no-preview is only supported by list');
  if(!['darwin','linux'].includes(process.platform))fail('unsupported_platform','Only macOS and Linux Unix sockets are supported');
  if(args.wait!==undefined&&command!=='send')fail('invalid_argument','--wait is only supported by send');
  if(args['reply-ttl']!==undefined&&(command!=='send'||args.wait===undefined))fail('invalid_argument','--reply-ttl requires send --wait');
  if(args.timeout!==undefined&&command!=='wait')fail('invalid_argument','--timeout is only supported by wait');
  if(args['sender-mode']!==undefined&&!['send','open'].includes(command))fail('invalid_argument','--sender-mode is only supported by send or open');
  if((args.name!==undefined||args.ttl!==undefined)&&command!=='open')fail('invalid_argument','--name and --ttl are only supported by open');
  if(args.channel!==undefined){
    if(!['send','wait','follow','close','status'].includes(command))fail('invalid_argument','--channel is only supported by send, wait, follow, close or status');
    if(['id','pid','request','wait','sender-mode'].some(key=>args[key]!==undefined))fail('invalid_argument','A channel fixes its target and identity; do not combine it with --id, --pid, --request, --wait or --sender-mode');
  }
  if(args['message-id']!==undefined&&(!args.channel||!['send','status'].includes(command)||!UUID.test(args['message-id'])))fail('invalid_argument','--message-id requires send/status --channel and a full UUID');
  if(command==='status'){
    if(!args.channel||!args['message-id'])fail('invalid_argument','status requires --channel and --message-id');
    return outgoingStatus(args.channel,args['message-id'].toLowerCase());
  }
  if(args.after!==undefined&&command!=='read'&&!(args.channel&&['wait','follow'].includes(command)))fail('invalid_argument','--after requires read or channel wait/follow');
  if(command==='_receive'){await receiveReply(args.request,validateTarget);return {status:'closed'}}
  if(command==='open')return openChannel();
  if(command==='close'){if(args.channel)loadChannel(args.channel);const result=await closeReply(args.channel||args.request);return args.channel?{status:result.status,channel:args.channel,...result.undelivered&&{undelivered:result.undelivered}}:result}
  if(command==='follow'&&!args.channel)fail('invalid_argument','follow requires --channel');
  if(args.channel&&['wait','follow'].includes(command)){
    let after=args.after||'0';const timeout=number('timeout',60,3600);if(!timeout)fail('invalid_argument','--timeout must be between 1 and 3600 seconds');
    if(command==='follow')process.stdout.on('error',e=>{if(e.code==='EPIPE')process.exit(0);throw e});
    do{
      const result=await waitChannel(args.channel,after,timeout,validateTarget);
      if(command==='wait'){if(!['received','receipt'].includes(result.reply.status))process.exitCode=2;return result}
      if(result.reply.status==='timeout')continue;
      console.log(JSON.stringify(result));
      if(!['received','receipt'].includes(result.reply.status)){process.exitCode=2;return}
      after=result.cursor;
    }while(true);
  }
  if(command==='wait'){
    const timeout=number('timeout',60,3600);if(!timeout)fail('invalid_argument','--timeout must be between 1 and 3600 seconds');
    const result=await waitReply(args.request,timeout);if(result.reply.status!=='received')process.exitCode=2;return result;
  }
  if(command==='read')return {sessionId:sessionId(),...page(await conversation(args.id,args.events))};
  if(command==='channels')return listChannels(root,validateTarget);
  if(command==='send')return send();
  if(command!=='list')fail('invalid_argument',`Unknown command: ${command}`);
  const {rows,warnings}=registrations(),sessions=[];
  for(const row of rows) {
    let context={};if(!args['no-preview'])try{const c=await conversation(row.sessionId),last=c.messages.at(-1);context={source:c.source,lastMessage:last?{...last,text:last.text.slice(0,500),truncated:last.text.length>500}:null,latestUser:c.messages.findLast(m=>m.role==='user')?.text.slice(0,300),ancestryIncomplete:c.ancestryIncomplete,transcriptWarnings:c.warnings};}catch(e){context={transcriptError:e.code||e.message}}
    sessions.push({id:row.sessionId,pid:row.pid,name:row.name||null,cwd:row.cwd,status:row.status||'unknown',statusUpdatedAt:row.statusUpdatedAt||null,waitingFor:row.waitingFor||null,version:row.version,processIdentity:row.processIdentity,socket:row.messagingSocketPath||null,...context});
  }
  const verified=sessions.filter(s=>s.processIdentity==='verified').length;
  return {capturedAt:new Date().toISOString(),configDir:root,counts:{verified,unverified:sessions.length-verified},sessions,warnings};
}
try {
  ({values:args,positionals}=parseArgs({args:process.argv.slice(2),options,allowPositionals:true}));
  command=positionals[0];root=resolve(args['config-dir']||process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'));
  const result=await main();if(result!==undefined)console.log(JSON.stringify(result,null,2));
} catch(e) { console.error(JSON.stringify({error:e.code||'failed',message:e.message,...e.request&&{request:e.request,expiresAt:e.expiresAt},...e.channel&&{channel:e.channel},...e.messageId&&{messageId:e.messageId}}));process.exitCode=1; }
