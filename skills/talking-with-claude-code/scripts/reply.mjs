import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createServer } from 'node:net';

export async function replyInbox(socketPath, messageId, validateTarget, {signals=true,onReceipt=()=>{},persistent=false,onReply=()=>{},nativeReceipts=false}={}) {
  // Bun on macOS cannot realpath a socket itself; resolve only its directory.
  const canonical=path=>`uds:${join(realpathSync(dirname(path)),basename(path))}`,expected=canonical(socketPath);
  // Claude sends automatic receipts only inside its socket namespace. Never remove that shared parent directory.
  const directory=nativeReceipts?dirname(socketPath):mkdtempSync(join(tmpdir(),'ccs-reply-'));
  const path=join(directory,nativeReceipts?randomUUID().replaceAll('-','').slice(0,16)+'.sock':'inbox.sock'),peers=new Set();
  let finish,timer,receipt,ownedSocket,closed=false,settled=false;
  const response=new Promise(resolve=>finish=result=>{if(!settled){settled=true;resolve(result)}});
  const error=(code,message)=>Object.assign(new Error(message),{code});
  // One inbox per request correlates replies without relying on Claude to echo an ID.
  const server=createServer(peer=>{
    if(peers.size>=16){peer.destroy();return}
    peers.add(peer);peer.setEncoding('utf8');peer.setTimeout(5000,()=>peer.destroy());let buffer='';
    peer.on('error',()=>{});peer.on('close',()=>peers.delete(peer));
    peer.on('data',chunk=>{
      if(settled)return;
      buffer+=chunk;if(Buffer.byteLength(buffer)>1048576){peer.destroy();return}
      for(let index;(index=buffer.indexOf('\n'))>=0;){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let frame;
        try{frame=JSON.parse(line)}catch{peer.destroy();return}
        if(typeof frame?.from!=='string'||!frame.from.startsWith('uds:'))continue;
        let from;try{from=canonical(frame.from.slice(4))}catch{continue}
        if(from!==expected)continue;
        if(frame.type==='control'&&frame.action==='peer_message_status'&&(persistent||frame.orig_msg_id===messageId)&&['held','delivered','refused','denied','expired','dropped'].includes(frame.status)){
          try{validateTarget()}catch{finish({status:'target_changed'});return}
          const status=frame.status==='expired'&&frame.status_detail==='refused'?'refused':frame.status;
          receipt={status,reason:frame.reason,...persistent&&{messageId:typeof frame.orig_msg_id==='string'?frame.orig_msg_id:null,receivedAt:new Date().toISOString()}};
          try{const terminal=onReceipt(receipt);if(terminal){finish(terminal);return}}catch(e){finish({status:'inbox_error',message:e.message});return}
          if(!persistent&&!['held','delivered'].includes(status)){finish({status,receipt});return}
          continue;
        }
        if(frame.type!=='user'||frame.message?.role!=='user'||typeof frame.message.content!=='string'||!frame.message.content.trim())continue;
        try{validateTarget()}catch{finish({status:'target_changed'});return}
        const result={status:'received',from:frame.from,messageId:frame.msg_id||null,text:frame.message.content,receivedAt:new Date().toISOString()};
        if(!persistent){finish(result);return}
        try{const terminal=onReply(result);if(terminal){finish(terminal);return}}catch(e){finish({status:'inbox_error',message:e.message});return}
      }
    });
  });
  async function close(){
    if(closed)return;closed=true;clearTimeout(timer);
    process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
    for(const peer of peers)peer.destroy();
    try{if(server.listening)await new Promise(resolve=>server.close(resolve))}finally{
      if(!nativeReceipts)rmSync(directory,{recursive:true,force:true});
      else if(ownedSocket)try{const current=lstatSync(path);if(current.ino===ownedSocket.ino&&current.dev===ownedSocket.dev&&current.isSocket())unlinkSync(path)}catch(e){if(e.code!=='ENOENT')throw e}
    }
  }
  const interrupt=()=>{void close().finally(()=>process.exit(130))},terminate=()=>{void close().finally(()=>process.exit(143))};
  try{
    if(!nativeReceipts)chmodSync(directory,0o700);
    else{const parent=lstatSync(directory);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||(parent.mode&0o022))throw error('unsafe_socket','Native receipt socket directory must be owned by this user and not writable by others')}
    if(Buffer.byteLength(path)>100)throw error('reply_path_too_long','TMPDIR is too long for a Unix reply socket; use a shorter private temporary directory');
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve)});
    ownedSocket=lstatSync(path);chmodSync(path,0o600);if(signals){process.on('SIGINT',interrupt);process.on('SIGTERM',terminate)}
    return {address:`uds:${path}`,close,cancel:()=>finish({status:'cancelled'}),wait:async seconds=>{
      timer=setTimeout(()=>finish({status:'timeout',...receipt&&{receipt}}),seconds*1000);
      return response;
    }};
  }catch(e){await close();throw e}
}
