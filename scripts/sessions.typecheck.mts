import { createSessions, type SenderMode, type ReplyAddress, type ReceiptEvent, type LegacyReplyEvent, type RequestWaitResult, type OutgoingStatus } from './sessions.mjs';
// Valid wire shapes include null IDs, timestamps nested in receipts, and outgoing failures without a status.
({kind:'receipt',status:'receipt',seq:1,receipt:{messageId:null,status:'held',correlated:false,receivedAt:'timestamp'}} satisfies ReceiptEvent);
({status:'received',seq:1,text:'legacy',from:'uds:peer',messageId:null,receivedAt:'timestamp'} satisfies LegacyReplyEvent);
({status:'refused',receipt:{status:'refused',reason:'approval denied'}} satisfies RequestWaitResult['reply']);
({channel:'handle',messageId:'uuid',queuedAt:'timestamp',error:'target_changed',message:'gone'} satisfies OutgoingStatus);
const sessions = createSessions();
const channel = await sessions.connect({ id: 'uuid', pid: 1, name: 'review', senderMode: 'prompting' });
const address: ReplyAddress = channel.address;
await channel.send({ text: 'hello', messageId: 'uuid' });
const result = await channel.wait({ timeout: 20 });
if (result.reply.kind === 'reply') result.reply.text.toUpperCase();
if (result.reply.kind === 'receipt') {
  result.reply.receipt.receivedAt.toUpperCase();
  // @ts-expect-error receipt timestamps belong to the receipt, not its event envelope
  result.reply.receivedAt;
}
const status = await channel.status({ messageId: 'uuid' });
if (status.error !== undefined) status.message.toUpperCase();
sessions.resumeChannel(channel.snapshot());
await sessions.send({ channel: channel.handle, text: 'compatible API' });
await sessions.send({ id: 'uuid', pid: 1, text: 'standalone', senderMode: 'prompting' });
// This previously observed error must fail even for a non-literal options object.
const wrong = { text: 'hello', senderMode: 'bypass' as SenderMode };
// @ts-expect-error permission class is fixed when connecting
await channel.send(wrong);
// @ts-expect-error a channel send cannot attest sender permissions again
await sessions.send({ channel: channel.handle, ...wrong });
// @ts-expect-error channel object owns the cursor
await channel.wait({ after: '0' });
// @ts-expect-error handle and address belong to the channel, not send options
await channel.send({ text: 'hello', channel: channel.handle });
// @ts-expect-error outgoing submissions do not have incoming sequence numbers
(await channel.send({ text: 'hello' })).seq;
// @ts-expect-error methods must not be confused with the legacy file handle
const handle: string = channel;
// @ts-expect-error cursor is read-only
channel.cursor = '0';
// @ts-expect-error a filesystem handle is not a uds address
const wrongAddress: ReplyAddress = channel.handle;
await channel.close();
void address;
