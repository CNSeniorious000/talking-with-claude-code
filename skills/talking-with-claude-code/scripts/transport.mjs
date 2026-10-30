import { createConnection } from 'node:net';

const failure=(code,message)=>Object.assign(new Error(message),{code});
export async function writeFrame(socket,payload,validate){
  let deadline;
  await new Promise((resolve,reject)=>{
    let submitted=false,attempted=false;
    const client=createConnection({path:socket.path},()=>{
      try{
        // Discovery is a snapshot. Validate again after connect, before any bytes leave.
        validate();attempted=true;
        // Bun can finish end(data) after a short write; flush and check the actual byte count.
        client.write(payload,error=>{
          if(error||client.bytesWritten<Buffer.byteLength(payload)){client.destroy(error||failure('outcome_unknown','Write interrupted; inspect the recipient before retrying'));return}
          submitted=true;client.end();
        });
      }catch(e){client.destroy(e)}
    });
    deadline=setTimeout(()=>{reject(failure(attempted?'outcome_unknown':'socket_timeout',attempted?'Bytes may have been written; inspect the recipient before retrying':'Socket timed out'));client.destroy()},5000);
    client.on('error',e=>reject(attempted?failure('outcome_unknown','Connection failed after a write attempt; inspect the recipient before retrying'):e));
    client.on('data',()=>{});
    client.on('close',error=>{if(!error){if(submitted)resolve();else reject(failure(attempted?'outcome_unknown':'not_submitted','Connection closed before write completed; inspect the recipient before retrying'))}});
  }).finally(()=>clearTimeout(deadline));
}
