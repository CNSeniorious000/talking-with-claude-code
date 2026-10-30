import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { replyInbox } from './reply.mjs';
import { writeFrame } from './transport.mjs';
import { eventWriter, channelEvents, channelCursor, cursorFor, forgetChannelEvents } from './channel-events.mjs';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const validMessageId=id=>{if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw failure('invalid_argument','Message ID must be a lowercase UUID')};
const json=file=>JSON.parse(readFileSync(file,'utf8'));
function privateFile(file){
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw failure('unsafe_request','Reply state must be a private regular file owned by this user');
  return json(file);
}
function publish(directory,name,value){
  const file=join(directory,name),temporary=file+'.tmp';
  writeFileSync(temporary,JSON.stringify(value),{mode:0o600});renameSync(temporary,file);
}
function load(request){
  if(!request||basename(request)!=='request.json')throw failure('invalid_argument','--request requires the request.json path returned by send');
  request=resolve(request);const directory=dirname(request),stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)||!basename(directory).startsWith('ccs-request-'))throw failure('unsafe_request','Invalid reply request directory');
  const data=privateFile(request);
  if(data.kind!=='claude-code-reply'||data.version!==1||data.directory!==realpathSync(directory)||!Number.isFinite(Date.parse(data.expiresAt)))throw failure('invalid_request','Invalid reply request metadata');
  return {request,directory,data};
}
function observe(directory,read,seconds){
  return new Promise((resolve,reject)=>{
    let watcher,timer,finished=false;
    const done=(value,error)=>{if(finished)return;finished=true;watcher?.close();clearTimeout(timer);error?reject(error):resolve(value)};
    const check=()=>{try{const value=read();if(value!==undefined)done(value)}catch(e){done(undefined,e)}};
    try{
      // Subscribe before reading so a reply arriving between invocations cannot be missed.
      watcher=watch(directory,check);watcher.on('error',e=>done(undefined,e));
      timer=setTimeout(()=>{check();done(undefined)},seconds*1000);check();
    }catch(e){done(undefined,e)}
  });
}
export async function startReply(entrypoint,row,socket,messageId,ttl,channel,configDir){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'ccs-request-')));chmodSync(directory,0o700);
  const request=join(directory,'request.json'),expiresAt=new Date(Date.now()+ttl*1000).toISOString();
  publish(directory,'request.json',{kind:'claude-code-reply',version:1,directory,expiresAt,row,socket,messageId,...channel&&{channel}});
  if(channel?.id)mkdirSync(join(directory,'outgoing'),{mode:0o700});
  const child=spawn(process.execPath,[entrypoint,'_receive','--request',request],{detached:true,stdio:'ignore',env:{...process.env,...configDir&&{CLAUDE_CONFIG_DIR:configDir}}});let startupError;
  child.on('error',e=>startupError=e);
  try{
    const ready=await observe(directory,()=>{
      if(startupError)throw startupError;
      if(existsSync(join(directory,'ready.json')))return privateFile(join(directory,'ready.json'));
      if(existsSync(join(directory,'reply.json')))throw failure('reply_start_failed',privateFile(join(directory,'reply.json')).message||'Reply receiver exited before becoming ready');
    },10);
    if(!ready)throw startupError||failure('reply_start_timeout','Reply receiver did not become ready');
    child.unref();return {request,expiresAt,address:ready.address};
  }catch(e){if(child.exitCode===null)child.kill('SIGTERM');throw Object.assign(e,{request,expiresAt})}
}
export async function receiveReply(request,validateTarget){
  const {directory,data}=load(request);let inbox,watcher,outgoingWatcher,result,bytes=0,draining,stopping=false,wake=false;const messages=[],seen=new Set(),processed=new Set(),receiptStates=new Map();
  const cancel=()=>{stopping=true;inbox?.cancel()};
  try{
    validateTarget(data.row,data.socket);
    const append=data.channel?.id?eventWriter(directory):null,outgoing=join(directory,'outgoing');
    const drain=()=>{
      wake=true;if(draining||stopping)return;
      draining=(async()=>{
        while(wake&&!stopping){
          wake=false;
          for(const name of readdirSync(outgoing).filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)&&!processed.has(name))){
            if(stopping)break;
            const job=privateFile(join(outgoing,name));processed.add(name);if(job.result)continue;
            let result;
            try{
              if(job.messageId+'.json'!==name||typeof job.payload!=='string')throw failure('invalid_outgoing','Invalid queued message');
              if(Date.now()>=Date.parse(data.expiresAt))throw failure('channel_closed','Channel expired before sending');
              await writeFrame(data.socket,job.payload,()=>validateTarget(data.row,data.socket));result={status:'submitted',sentAt:new Date().toISOString()};
            }catch(e){result={error:e.code||'failed',message:e.message}}
            // Retain correlation metadata, but discard the potentially large payload after attempting delivery.
            publish(outgoing,name,{messageId:job.messageId,hash:job.hash,queuedAt:job.queuedAt,result});
          }
        }
      })().catch(e=>{result={status:'inbox_error',message:e.message};cancel()}).finally(()=>{draining=undefined});
    };
    inbox=await replyInbox(data.socket.path,data.messageId,()=>validateTarget(data.row,data.socket),{signals:false,persistent:!!data.channel,nativeReceipts:!!append,onReceipt:receipt=>{
      if(!append){publish(directory,'receipt.json',receipt);return}
      const id=receipt.messageId,correlated=typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id)&&existsSync(join(outgoing,id+'.json'));
      const key=JSON.stringify([id,receipt.status,receipt.reason]);if(receiptStates.get(id)===key)return;receiptStates.set(id,key);
      return append({kind:'receipt',status:'receipt',receipt:{...receipt,correlated}});
    },onReply:reply=>{
      if(reply.messageId&&seen.has(reply.messageId))return;
      if(append){const ended=append({...reply,kind:'reply'});if(!ended&&reply.messageId)seen.add(reply.messageId);return ended}
      const size=Buffer.byteLength(JSON.stringify(reply));
      // Bound retained state without silently evicting unread messages. The terminal status is observable after draining the queue.
      if(messages.length>=256||bytes+size>16*1024*1024)return {status:'queue_full'};
      messages.push({...reply,seq:messages.length+1});publish(directory,'messages.json',messages);bytes+=size;if(reply.messageId)seen.add(reply.messageId);
    }});
    const check=()=>{if(existsSync(join(directory,'cancel')))cancel()};
    watcher=watch(directory,check);watcher.on('error',cancel);process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    if(append){outgoingWatcher=watch(outgoing,drain);outgoingWatcher.on('error',cancel);drain()}
    const ownSocket=lstatSync(inbox.address.slice(4));
    publish(directory,'ready.json',{address:inbox.address,pid:process.pid,ino:ownSocket.ino,dev:ownSocket.dev});check();
    const settled=await inbox.wait(Math.max(0,(Date.parse(data.expiresAt)-Date.now())/1000));result ||= settled;
    if(result.status==='timeout')result.status='expired';
  }catch(e){result={status:'inbox_error',message:e.message}}
  finally{
    stopping=true;watcher?.close();outgoingWatcher?.close();process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
    await draining;
    if(data.channel?.id){
      const outgoing=join(directory,'outgoing'),undelivered=[];
      for(const name of readdirSync(outgoing).filter(name=>/^[0-9a-f-]{36}\.json$/.test(name))){
        const job=privateFile(join(outgoing,name));if(job.result)continue;
        undelivered.push(job.messageId);
        publish(outgoing,name,{messageId:job.messageId,hash:job.hash,queuedAt:job.queuedAt,result:{error:'channel_closed',message:'Channel closed before this queued message was sent'}});
      }
      if(undelivered.length)result={...result,undelivered};
    }
    await inbox?.close();
    publish(directory,'reply.json',result);publish(directory,'done.json',{closedAt:new Date().toISOString()});
  }
}
export async function waitReply(request,seconds){
  const {directory,data}=load(request);
  if(data.channel)throw failure('invalid_argument','Use wait --channel for a persistent channel');
  const read=()=>!existsSync(join(directory,'request.json'))?{status:'closed'}:existsSync(join(directory,'reply.json'))?privateFile(join(directory,'reply.json')):Date.now()>=Date.parse(data.expiresAt)?{status:'expired'}:undefined;
  const result=seconds?await observe(directory,read,Math.min(seconds,Math.max(0,(Date.parse(data.expiresAt)-Date.now())/1000))):read();
  const receipt=existsSync(join(directory,'receipt.json'))?privateFile(join(directory,'receipt.json')):null;
  return {request:join(directory,'request.json'),expiresAt:data.expiresAt,sessionId:data.row.sessionId,messageId:data.messageId,reply:result||{status:seconds?'timeout':'pending',...receipt&&{receipt}}};
}
export function loadChannel(channel,{active=false}={}){
  const state=load(channel),{directory,data}=state;
  if(!data.channel)throw failure('invalid_channel','--channel requires a handle returned by open');
  const ready=privateFile(join(directory,'ready.json'));
  if(active){
    if(existsSync(join(directory,'cancel'))||existsSync(join(directory,'done.json'))||Date.now()>=Date.parse(data.expiresAt))throw failure('channel_closed','Channel is closed or expired; cached messages can still be read');
    try{process.kill(ready.pid,0);const socket=lstatSync(ready.address.slice(4));if(!socket.isSocket()||socket.uid!==process.getuid()||socket.ino!==ready.ino||socket.dev!==ready.dev)throw Error('Socket identity changed')}
    catch(e){throw failure('channel_unavailable',`Channel receiver unavailable: ${e.message}`)}
  }
  return {...state,ready};
}
export async function sendChannel(channel,payload,messageId){
  validMessageId(messageId);
  const {directory}=loadChannel(channel,{active:true}),outgoing=join(directory,'outgoing'),file=join(outgoing,messageId+'.json');
  const hash=createHash('sha256').update(payload).digest('hex');let reused=true;
  if(!existsSync(file)){
    const entries=readdirSync(outgoing).filter(name=>name.endsWith('.json'));
    if(entries.length>=1024||entries.reduce((size,name)=>size+lstatSync(join(outgoing,name)).size,0)+Buffer.byteLength(payload)>16*1024*1024)throw failure('outgoing_full','Channel outgoing journal is full; drain it before opening a new channel');
    const temporary=file+'.'+randomUUID()+'.tmp';
    // link() publishes a complete job only if its ID is still unused, including concurrent retries.
    try{writeFileSync(temporary,JSON.stringify({messageId,hash,payload,queuedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});try{linkSync(temporary,file);reused=false}catch(e){if(e.code!=='EEXIST')throw e}}
    finally{try{unlinkSync(temporary)}catch(e){if(e.code!=='ENOENT')throw e}}
  }
  const job=privateFile(file);if(job.hash!==hash)throw failure('idempotency_conflict','This message ID was already used with different content');
  // The worker owns both sockets, matching Claude's verified sender PID. Publish before connecting so fast receipts correlate.
  let result;
  try{result=await observe(outgoing,()=>privateFile(file).result,10)}
  catch(e){if(e.code==='ENOENT')throw failure('outcome_unknown','Channel state was removed during submission; do not resend with a new ID');throw e}
  if(result?.error)throw failure(result.error,result.message);
  return {...result||{status:'queued'},queuedAt:job.queuedAt,reused};
}
export function outgoingStatus(channel,messageId){
  validMessageId(messageId);
  try{
    const {directory}=loadChannel(channel),file=join(directory,'outgoing',messageId+'.json');
    if(!existsSync(file))throw failure('message_unknown','No outgoing message with this ID is recorded in this channel');
    const job=privateFile(file);return {channel,messageId,queuedAt:job.queuedAt,...job.result||{status:'queued'}};
  }catch(e){if(e.code==='ENOENT')throw failure('channel_closed','Channel state is no longer available');throw e}
}
export function listChannels(configDir,validateTarget){
  const channels=[],warnings=[];
  for(const entry of readdirSync(tmpdir(),{withFileTypes:true}).filter(entry=>entry.name.startsWith('ccs-request-'))){
    const channel=join(tmpdir(),entry.name,'request.json');
    try{
      const {directory,data}=load(channel);if(!data.channel||resolve(dirname(dirname(data.row.registryFile)))!==resolve(configDir))continue;
      const {ready}=loadChannel(channel);let status='open';
      if(existsSync(join(directory,'reply.json')))status=privateFile(join(directory,'reply.json')).status;
      else if(Date.now()>=Date.parse(data.expiresAt))status='expired';
      else try{loadChannel(channel,{active:true});validateTarget(data.row,data.socket)}catch(e){status=e.code||'channel_unavailable'}
      channels.push({channel:join(data.directory,'request.json'),name:data.channel.name,sessionId:data.row.sessionId,pid:data.row.pid,address:ready.address,expiresAt:data.expiresAt,status,cursor:cursorFor(data,0)});
    }catch(e){if(e.code!=='ENOENT')warnings.push({channel,error:e.code||'invalid_request',message:e.message})}
  }
  return {capturedAt:new Date().toISOString(),channels,warnings};
}
export async function waitChannel(channel,after,seconds,validateTarget){
  const {directory,data,ready}=loadChannel(channel);
  const seq=channelCursor(data,after);
  const terminal=()=>!existsSync(join(directory,'request.json'))?{status:'closed'}:existsSync(join(directory,'reply.json'))?privateFile(join(directory,'reply.json')):Date.now()>=Date.parse(data.expiresAt)?{status:'expired'}:existsSync(join(directory,'cancel'))?{status:'cancelled'}:undefined;
  const read=()=>{
    try{
    if(!existsSync(join(directory,'request.json')))return {status:'closed'};
    const messages=data.channel.id?channelEvents(directory):existsSync(join(directory,'messages.json'))?privateFile(join(directory,'messages.json')):[];
    if(seq>messages.length)throw failure('cursor_ahead','Cursor is beyond the latest channel event');
    const next=messages.find(message=>message.seq>seq);if(next)return next;
    const ended=terminal();if(ended)return ended;
    try{validateTarget(data.row,data.socket)}catch{return {status:'target_changed'}}
    // Shutdown can occur between the queue snapshot and liveness check. Prefer its recorded terminal reason.
    try{loadChannel(channel,{active:true})}catch(e){return terminal()||{status:e.code||'channel_unavailable'}}
    }catch(e){if(e.code==='ENOENT'&&!existsSync(join(directory,'request.json')))return {status:'closed'};throw e}
  };
  const reply=await observe(directory,read,Math.min(seconds,Math.max(0,(Date.parse(data.expiresAt)-Date.now())/1000)));
  return {channel,address:ready.address,name:data.channel.name,sessionId:data.row.sessionId,expiresAt:data.expiresAt,cursor:cursorFor(data,reply?.seq||seq),reply:reply||{status:'timeout'}};
}
export async function closeReply(request){
  const {directory}=load(request);
  if(!existsSync(join(directory,'done.json'))){
    writeFileSync(join(directory,'cancel'),'',{mode:0o600});
    const done=await observe(directory,()=>existsSync(join(directory,'done.json'))?true:undefined,6);
    if(!done)throw failure('reply_close_timeout','Receiver has not confirmed shutdown; request state was retained');
  }
  const ended=privateFile(join(directory,'reply.json')),outgoing=join(directory,'outgoing');
  if(existsSync(outgoing)){
    const stat=lstatSync(outgoing);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw failure('unsafe_request','Invalid outgoing directory');
    for(const name of readdirSync(outgoing)){
      if(!/^[0-9a-f-]{36}\.json(?:\.[0-9a-f-]{36})?(?:\.tmp)?$/.test(name))throw failure('unsafe_request','Unexpected outgoing file');
      const file=join(outgoing,name);privateFile(file);unlinkSync(file);
    }
    rmdirSync(outgoing);
  }
  // Delete only our known files; never recursively remove a caller-provided directory.
  for(const name of ['request.json','ready.json','reply.json','receipt.json','messages.json','events.ndjson','done.json','cancel']){
    for(const suffix of ['', '.tmp']){
      const file=join(directory,name+suffix);if(!existsSync(file))continue;
      const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw failure('unsafe_request','Unexpected file in reply state');
      unlinkSync(file);
    }
  }
  rmdirSync(directory);forgetChannelEvents(directory);return {status:'closed',request,...ended.undelivered?.length&&{undelivered:ended.undelivered}};
}
