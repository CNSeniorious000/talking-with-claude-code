import { appendFileSync, closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const readers=new Map(),maxBytes=16*1024*1024,maxEvents=256;
export function eventWriter(directory){
  const file=join(directory,'events.ndjson');writeFileSync(file,'',{flag:'wx',mode:0o600});
  let seq=0,bytes=0;
  return event=>{
    const line=JSON.stringify({...event,seq:seq+1})+'\n',size=Buffer.byteLength(line);
    if(seq>=maxEvents||bytes+size>maxBytes)return {status:'queue_full'};
    appendFileSync(file,line);seq++;bytes+=size;
  };
}
export function channelEvents(directory){
  const file=join(directory,'events.ndjson'),fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>maxBytes)throw failure('unsafe_request','Invalid channel event log');
    let reader=readers.get(file);
    if(!reader){reader={ino:stat.ino,dev:stat.dev,offset:0,decoder:new StringDecoder('utf8'),tail:'',events:[]};readers.set(file,reader)}
    if(reader.ino!==stat.ino||reader.dev!==stat.dev||stat.size<reader.offset)throw failure('invalid_event_log','Channel event log was replaced or truncated');
    // A follower reuses this reader. Decode only appended bytes and retain any incomplete final line.
    const chunk=Buffer.alloc(Math.min(65536,stat.size-reader.offset));
    while(reader.offset<stat.size){
      const count=readSync(fd,chunk,0,Math.min(chunk.length,stat.size-reader.offset),reader.offset);if(!count)break;
      reader.offset+=count;reader.tail+=reader.decoder.write(chunk.subarray(0,count));
      for(let end;(end=reader.tail.indexOf('\n'))>=0;){
        const event=JSON.parse(reader.tail.slice(0,end));reader.tail=reader.tail.slice(end+1);
        if(event.seq!==reader.events.length+1||reader.events.length>=maxEvents)throw failure('invalid_event_log','Channel event sequence is invalid');
        reader.events.push(event);
      }
    }
    return reader.events;
  }finally{closeSync(fd)}
}
export function channelCursor(data,after='0'){
  if(!data.channel.id){const value=Number(after);if(!Number.isSafeInteger(value)||value<0)throw failure('invalid_argument','--after requires a nonnegative sequence');return value}
  if(String(after)==='0')return 0;
  const match=/^([0-9a-f-]{36}):(0|[1-9]\d*)$/.exec(String(after));
  if(!match)throw failure('invalid_cursor','Use 0 to start, then the cursor returned by this channel');
  if(match[1]!==data.channel.id)throw failure('cursor_mismatch','Cursor belongs to another channel');
  const seq=Number(match[2]);if(!Number.isSafeInteger(seq))throw failure('invalid_cursor','Invalid cursor sequence');
  return seq;
}
export const cursorFor=(data,seq)=>data.channel.id?`${data.channel.id}:${seq}`:String(seq);
