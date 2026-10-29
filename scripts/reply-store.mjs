import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { replyInbox } from './reply.mjs';

const failure=(code,message)=>Object.assign(new Error(message),{code});
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
export async function startReply(entrypoint,row,socket,messageId,ttl){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'ccs-request-')));chmodSync(directory,0o700);
  const request=join(directory,'request.json'),expiresAt=new Date(Date.now()+ttl*1000).toISOString();
  publish(directory,'request.json',{kind:'claude-code-reply',version:1,directory,expiresAt,row,socket,messageId});
  const child=spawn(process.execPath,[entrypoint,'_receive','--request',request],{detached:true,stdio:'ignore'});let startupError;
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
  const {directory,data}=load(request);let inbox,watcher,result;
  const cancel=()=>inbox?.cancel();
  try{
    validateTarget(data.row,data.socket);
    inbox=await replyInbox(data.socket.path,data.messageId,()=>validateTarget(data.row,data.socket),{signals:false,onReceipt:receipt=>publish(directory,'receipt.json',receipt)});
    const check=()=>{if(existsSync(join(directory,'cancel')))cancel()};
    watcher=watch(directory,check);watcher.on('error',cancel);process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    publish(directory,'ready.json',{address:inbox.address,pid:process.pid});check();
    result=await inbox.wait(Math.max(0,(Date.parse(data.expiresAt)-Date.now())/1000));
    if(result.status==='timeout')result.status='expired';
  }catch(e){result={status:'inbox_error',message:e.message}}
  finally{
    watcher?.close();process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
    await inbox?.close();
    publish(directory,'reply.json',result);publish(directory,'done.json',{closedAt:new Date().toISOString()});
  }
}
export async function waitReply(request,seconds){
  const {directory,data}=load(request);
  const read=()=>existsSync(join(directory,'reply.json'))?privateFile(join(directory,'reply.json')):Date.now()>=Date.parse(data.expiresAt)?{status:'expired'}:undefined;
  const result=seconds?await observe(directory,read,Math.min(seconds,Math.max(0,(Date.parse(data.expiresAt)-Date.now())/1000))):read();
  const receipt=existsSync(join(directory,'receipt.json'))?privateFile(join(directory,'receipt.json')):null;
  return {request:join(directory,'request.json'),expiresAt:data.expiresAt,sessionId:data.row.sessionId,messageId:data.messageId,reply:result||{status:seconds?'timeout':'pending',...receipt&&{receipt}}};
}
export async function closeReply(request){
  const {directory}=load(request);
  if(!existsSync(join(directory,'done.json'))){
    writeFileSync(join(directory,'cancel'),'',{mode:0o600});
    const done=await observe(directory,()=>existsSync(join(directory,'done.json'))?true:undefined,5);
    if(!done)throw failure('reply_close_timeout','Receiver has not confirmed shutdown; request state was retained');
  }
  // Delete only our known files; never recursively remove a caller-provided directory.
  for(const name of ['request.json','ready.json','reply.json','receipt.json','done.json','cancel']){
    for(const suffix of ['', '.tmp']){
      const file=join(directory,name+suffix);if(!existsSync(file))continue;
      const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw failure('unsafe_request','Unexpected file in reply state');
      unlinkSync(file);
    }
  }
  rmdirSync(directory);return {status:'closed',request};
}
