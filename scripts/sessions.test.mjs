import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const cli = join(import.meta.dir, 'sessions.mjs');
const procStat = process.platform === 'linux' ? readFileSync(`/proc/${process.pid}/stat`, 'utf8') : null;
const procStart = procStat === null ? execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim() : procStat.slice(procStat.lastIndexOf(')') + 2).split(/\s+/)[19];
const turn = (type, text, parentUuid = null, extra = {}) => ({ type, uuid: randomUUID(), parentUuid, timestamp: new Date().toISOString(), message: { role: type, content: text }, ...extra });
const boundary = (compactMetadata = {}) => ({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), parentUuid: null, compactMetadata });

async function fixture(check, { onData, onMessage } = {}) {
  // A short path avoids macOS's Unix socket path limit; never inspect ~/.claude.
  const root = mkdtempSync('/tmp/ccs-test-'), id = randomUUID(), peers = new Set(), received = [], requests = new Set();
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'sessions')); mkdirSync(join(root, 'projects')); mkdirSync(join(root, 'projects', 'fixture'));
  const socketPath = join(root, 'inbox.sock'), registry = join(root, 'sessions', `${process.pid}.json`), transcript = join(root, 'projects', 'fixture', `${id}.jsonl`);
  let connections = 0;
  const server = createServer({ allowHalfOpen: true }, socket => {
    connections++; peers.add(socket); socket.setEncoding('utf8'); let text = '';
    socket.on('data', chunk => { text += chunk; onData?.(socket, chunk); });
    socket.on('end', () => { received.push(text); onMessage?.(text,socketPath); socket.end(); });
    socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
  });
  const registration = patch => writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: id, procStart, cwd: root, name: 'fixture', status: 'idle', messagingSocketPath: socketPath, ...patch }));
  const conversation = (rows, suffix = '') => writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n' + suffix);
  const run = async (argv, input = '') => {
    // A synchronous child would starve this process's mock socket server.
    const child = Bun.spawn([process.execPath, cli, '--config-dir', root, ...argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLAUDE_CONFIG_DIR: root, TMPDIR:root } });
    const timeout = setTimeout(() => child.kill(), 7000);
    try {
      child.stdin.write(input); child.stdin.end();
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const data=JSON.parse(stdout||stderr);if(data.request&&argv[0]!=='close')requests.add(data.request);
      return {code,data};
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); await child.exited; }
  };
  const read = (...args) => run(['read', '--id', id, ...args]);
  const send = (text = 'hello', ...args) => run(['send', '--id', id, '--pid', String(process.pid), '--text', '-', ...args], text);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    registration(); conversation([]);
    await check({ root, id, registry, transcript, socketPath, registration, conversation, run, read, send, received, connections: () => connections });
  } finally {
    for(const request of requests){const closed=await run(['close','--request',request]);if(closed.code!==0&&closed.data.error!=='ENOENT')throw Error(JSON.stringify(closed.data))}
    for (const peer of peers) peer.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

test('list and read inspect the owned live PID without connecting to its inbox', () => fixture(async f => {
  const request = turn('user', 'Review this branch'), reply = turn('assistant', 'Still reviewing', request.uuid);
  f.conversation([request, reply]);
  const listed = await f.run(['list']), read = await f.read();
  expect(listed.code).toBe(0); expect(listed.data.sessions).toHaveLength(1);
  expect(listed.data.counts).toEqual({ verified: 1, unverified: 0 });
  expect(listed.data.sessions[0]).toMatchObject({ id: f.id, pid: process.pid, processIdentity: 'verified', latestUser: request.message.content });
  expect(read.data.messages.map(row => row.text)).toEqual(['Review this branch', 'Still reviewing']);
  expect(f.connections()).toBe(0);
}));

test('a stale process start identity blocks sending before connection', () => fixture(async f => {
  f.registration({ procStart: 'stale' });
  const result = await f.send();
  expect(result.code).toBe(1); expect(result.data.error).toBe('process_changed'); expect(f.connections()).toBe(0);
  expect((await f.run(['list'])).data.counts).toEqual({ verified: 0, unverified: 1 });
}));

test('a session UUID mismatch blocks sending before connection', () => fixture(async f => {
  f.registration({ sessionId: randomUUID() });
  const result = await f.send();
  expect(result.code).toBe(1); expect(result.data.error).toBe('target_mismatch'); expect(f.connections()).toBe(0);
}));

test('a registry PID mismatch blocks sending before connection', () => fixture(async f => {
  f.registration({ pid: process.pid + 1 });
  const result = await f.send();
  expect(result.code).toBe(1); expect(result.data.error).toBe('invalid_registry'); expect(f.connections()).toBe(0);
}));

test('a symlinked registration is refused', () => fixture(async f => {
  const target = join(f.root, 'registration.json'); writeFileSync(target, readFileSync(f.registry)); rmSync(f.registry); symlinkSync(target, f.registry);
  const result = await f.send();
  expect(result.code).toBe(1); expect(result.data.error).toBe('unsafe_registry'); expect(f.connections()).toBe(0);
}));

test('a symlinked socket is refused', () => fixture(async f => {
  const alias = join(f.root, 'alias.sock'); symlinkSync(f.socketPath, alias); f.registration({ messagingSocketPath: alias });
  const result = await f.send();
  expect(result.code).toBe(1); expect(result.data.error).toBe('unsafe_socket'); expect(f.connections()).toBe(0);
}));

test('a symlinked socket directory is refused', () => fixture(async f => {
  const alias = join(f.root, 'alias'); symlinkSync(f.root, alias); f.registration({ messagingSocketPath: join(alias, 'inbox.sock') });
  const result = await f.send();
  expect(result.code).toBe(1); expect(result.data.error).toBe('unsafe_socket'); expect(f.connections()).toBe(0);
}));

test('a group/world-writable socket directory is refused', () => fixture(async f => {
  chmodSync(f.root, 0o777);
  const result = await f.send();
  expect(result.code).toBe(1); expect(result.data.error).toBe('unsafe_socket'); expect(f.connections()).toBe(0);
}));

test('stdin preserves multiline content and a socket write never claims acceptance', () => fixture(async f => {
  const previous = turn('assistant', 'Before delivery'); f.conversation([previous]);
  const before = readFileSync(f.transcript, 'utf8'), text = 'First line\nQuotes: "single\'"; $HOME; $(touch nope); `echo nope`\n最后一行\n';
  const result = await f.send(text);
  expect(result.code).toBe(0); expect(result.data).toMatchObject({ status: 'submitted', acceptance: 'unconfirmed', sessionId: f.id, pid: process.pid, cursor: previous.uuid });
  expect(f.connections()).toBe(1); expect(f.received).toHaveLength(1);
  const payload = JSON.parse(f.received[0]);
  expect(payload).toMatchObject({ type: 'user', session_id: f.id, uuid: result.data.messageId, msg_id: result.data.messageId, message: { role: 'user', content: text } });
  expect(f.received[0].endsWith('\n')).toBe(true); expect(readFileSync(f.transcript, 'utf8')).toBe(before);
}));

test('a large Unicode message is flushed completely before submission is reported', () => fixture(async f => {
  const text = '汉😀'.repeat(50000), result = await f.send(text);
  expect(result.code).toBe(0); expect(result.data.status).toBe('submitted');
  expect(f.received).toHaveLength(1); expect(JSON.parse(f.received[0]).message.content).toBe(text);
}));

test('a disconnect during a write reports an unknown outcome instead of safe failure or submission', async () => {
  let bytes = 0;
  await fixture(async f => {
    const result = await f.send('x'.repeat(900000));
    expect(bytes).toBeGreaterThan(0); expect(bytes).toBeLessThan(900000);
    expect(result.code).toBe(1); expect(result.data.error).toBe('outcome_unknown'); expect(f.connections()).toBe(1);
  }, { onData(socket, chunk) { bytes += Buffer.byteLength(chunk); socket.destroy(); } });
});

test('a half-closed peer that stops reading cannot leave a write hanging', async () => {
  let bytes = 0;
  await fixture(async f => {
    const result = await f.send('x'.repeat(900000));
    expect(bytes).toBeGreaterThan(0); expect(bytes).toBeLessThan(900000);
    // Some kernels buffer the entire frame before pause takes effect; local completion still cannot prove consumption.
    if (result.code === 0) expect(result.data).toMatchObject({ status: 'submitted', acceptance: 'unconfirmed' });
    else { expect(result.code).toBe(1); expect(result.data.error).toBe('outcome_unknown'); }
    expect(f.connections()).toBe(1);
  }, { onData(socket, chunk) { bytes += Buffer.byteLength(chunk); socket.pause(); socket.end(); } });
}, 10000);

test('read follows the active branch and excludes its superseded answer', () => fixture(async f => {
  const request = turn('user', 'Start'), stale = turn('assistant', 'Superseded', request.uuid), active = turn('assistant', 'Corrected', request.uuid);
  f.conversation([request, stale, active]);
  const result = await f.read('--tail', '0');
  expect(result.code).toBe(0); expect(result.data.messages.map(row => row.id)).toEqual([request.uuid, active.uuid]);
  expect(result.data.ancestryIncomplete).toBe(false);
}));

for (const format of ['preservedMessages', 'preservedSegment']) {
  test(`compaction restores ${format} before post-boundary turns`, () => fixture(async f => {
    const obsolete = turn('user', 'Discard'), a = turn('user', 'Keep request', obsolete.uuid), b = turn('assistant', 'Keep answer', a.uuid), c = boundary();
    c.compactMetadata[format] = format === 'preservedMessages' ? { anchorUuid: c.uuid, uuids: [a.uuid, b.uuid] } : { anchorUuid: c.uuid, headUuid: a.uuid, tailUuid: b.uuid };
    const next = turn('user', 'Continue', c.uuid); f.conversation([obsolete, a, b, c, next]);
    const result = await f.read('--tail', '0');
    expect(result.code).toBe(0); expect(result.data.messages.map(row => row.id)).toEqual([a.uuid, b.uuid, next.uuid]);
    expect(result.data.ancestryIncomplete).toBe(false);
  }));
}

test('reordered preserved context chooses its logical tail without a new turn', () => fixture(async f => {
  const a = turn('user', 'Now last'), b = turn('assistant', 'Now first', a.uuid), c = boundary();
  c.compactMetadata.preservedMessages = { anchorUuid: c.uuid, uuids: [b.uuid, a.uuid] }; f.conversation([a, b, c]);
  const result = await f.read('--tail', '0');
  expect(result.code).toBe(0); expect(result.data.messages.map(row => row.id)).toEqual([b.uuid, a.uuid]);
  expect(result.data.cursor).toBe(a.uuid); expect(result.data.ancestryIncomplete).toBe(false);
}));

test('a subsequent non-preserving compaction drops earlier retained context', () => fixture(async f => {
  const a = turn('user', 'Old retained turn'), b = boundary();
  b.compactMetadata.preservedMessages = { anchorUuid: b.uuid, uuids: [a.uuid] };
  const c = boundary(), summary = turn('user', 'Fresh summary', c.uuid, { isCompactSummary: true, isMeta: true }); f.conversation([a, b, c, summary]);
  const result = await f.read('--tail', '0');
  expect(result.code).toBe(0); expect(result.data.messages.map(row => row.text)).toEqual(['Fresh summary']);
  expect(result.data.messages[0].role).toBe('context');
}));

test('pagination accepts a hidden tool cursor on the raw conversation branch', () => fixture(async f => {
  const a = turn('user', 'Question'), tool = turn('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: 'fixture.txt' } }], a.uuid), b = turn('assistant', 'Answer', tool.uuid);
  f.conversation([a, tool, b]);
  const after = await f.read('--after', tool.uuid), before = await f.read('--before', tool.uuid), events = await f.read('--events');
  expect(after.code).toBe(0); expect(after.data.messages.map(row => row.id)).toEqual([b.uuid]);
  expect(before.code).toBe(0); expect(before.data.messages.map(row => row.id)).toEqual([a.uuid]);
  expect(events.data.messages.map(row => row.id)).toEqual([a.uuid, tool.uuid, b.uuid]);
}));

test('partial JSON writes produce warnings and the text budget keeps the newest body', () => fixture(async f => {
  const a = turn('user', 'Old request'), b = turn('assistant', 'Newest answer', a.uuid); f.conversation([a, b], '{"type":');
  const result = await f.read('--tail', '0', '--max-chars', '6');
  expect(result.code).toBe(0); expect(result.data.warnings).toHaveLength(1); expect(result.data.warnings[0]).toContain('line 3');
  expect(result.data.truncated).toBe(true); expect(result.data.availableMessages).toBe(2);
  expect(result.data.messages).toHaveLength(1); expect(result.data.messages[0]).toMatchObject({ id: b.uuid, text: 'Newest', truncated: true });
}));

const checkpoint = leafUuid => ({ type: 'last-prompt', leafUuid, explicit: true, rewound: true });
for (const [name, arrange, texts] of [
  ['explicit rewind', (a, b) => [a, b, checkpoint(a.uuid)], ['request']],
  ['explicit clear', (a, b) => [a, b, checkpoint(null)], []],
  ['clear followed by a sidechain', (a, b) => [a, b, checkpoint(null), turn('assistant', 'subagent', b.uuid, { isSidechain: true })], []],
  ['clear followed by a new main turn', (a, b) => [a, b, checkpoint(null), turn('user', 'fresh')], ['fresh']],
  ['rewind followed by a descendant', (a, b) => [a, b, checkpoint(a.uuid), turn('assistant', 'new answer', a.uuid)], ['request', 'new answer']],
  ['checkpoint followed by a sibling', (a, b) => [a, b, checkpoint(b.uuid), turn('assistant', 'other branch', a.uuid)], ['request', 'answer']],
  ['checkpoint replaced by another checkpoint', (a, b) => [a, b, checkpoint(a.uuid), checkpoint(b.uuid)], ['request', 'answer']],
  ['rewind followed by metadata snapshots', (a, b) => [a, b, checkpoint(a.uuid), { type: 'file-history-snapshot', messageId: b.uuid, snapshot: {} }, { type: 'last-prompt', lastPrompt: 'preview' }], ['request']],
]) test(name, () => fixture(async f => {
  const a = turn('user', 'request'), b = turn('assistant', 'answer', a.uuid);
  f.conversation(arrange(a, b).map(row => ({ sessionId: f.id, ...row })));
  const result = await f.read('--tail', '0');
  expect(result.code).toBe(0); expect(result.data.messages.map(row => row.text)).toEqual(texts); expect(result.data.ancestryIncomplete).toBe(false);
}));

test('non-preserving compaction clears old context even before its summary is written', () => fixture(async f => {
  const a = turn('user', 'old request'), c = boundary();
  f.conversation([a, checkpoint(a.uuid), c]);
  const result = await f.read('--tail', '0');
  expect(result.code).toBe(0); expect(result.data.messages).toEqual([]); expect(result.data.ancestryIncomplete).toBe(false);
}));

test('an explicit checkpoint overrides the preserved compaction tail', () => fixture(async f => {
  const a = turn('user', 'request'), b = turn('assistant', 'answer', a.uuid), c = boundary();
  c.compactMetadata.preservedMessages = { anchorUuid: c.uuid, uuids: [a.uuid, b.uuid] };
  f.conversation([a, b, c, checkpoint(a.uuid)]);
  const result = await f.read('--tail', '0');
  expect(result.code).toBe(0); expect(result.data.messages.map(row => row.id)).toEqual([a.uuid]);
}));

test('an appended UUID revision updates both content and active branch choice', () => fixture(async f => {
  const a = turn('user', 'request'), b = turn('assistant', 'draft', a.uuid), other = turn('assistant', 'other branch', a.uuid);
  const revision = { ...b, message: { role: 'assistant', content: 'final answer' } };
  f.conversation([a, b, other, revision]);
  const result = await f.read('--tail', '0');
  expect(result.code).toBe(0); expect(result.data.messages.map(row => row.text)).toEqual(['request', 'final answer']);
}));

test('cycles report incomplete ancestry instead of appearing complete', () => fixture(async f => {
  const a = turn('user', 'request'), b = turn('assistant', 'answer', a.uuid); a.parentUuid = b.uuid; f.conversation([a, b]);
  const result = await f.read();
  expect(result.code).toBe(0); expect(result.data.ancestryIncomplete).toBe(true); expect(result.data.warnings.some(w => w.includes('cycle'))).toBe(true);
}));

for (const args of [['read', '--unknown'], ['read', '--id'], ['read', '--events=false']]) {
  test(`invalid arguments remain JSON: ${args.join(' ')}`, () => fixture(async f => {
    const result = await f.run(args);
    expect(result.code).toBe(1); expect(typeof result.data.error).toBe('string'); expect(typeof result.data.message).toBe('string'); expect(f.connections()).toBe(0);
  }));
}

const batch = (text, parent, id = 'batch', content = text) => turn('assistant', content, parent.uuid, { message: { role: 'assistant', id, content } });
const call = id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: 'fixture' } });
const result = (text, parent, id) => turn('user', [{ type: 'tool_result', tool_use_id: id, content: text }], parent.uuid);
test('sibling response blocks preserve the selected anchor and support pagination', () => fixture(async f => {
  const u = turn('user', 'question'), a = batch('first written', u), b = batch('selected anchor', u); f.conversation([u, a, b]);
  const read = await f.read('--tail', '0'), after = await f.read('--after', b.uuid);
  expect(read.data.messages.map(row => row.text)).toEqual(['question', 'selected anchor', 'first written']);
  expect(after.data.messages.map(row => row.id)).toEqual([a.uuid]); expect(read.data.ancestryIncomplete).toBe(false);
}));

test('recovered blocks stay before the next user turn without reviving other responses', () => fixture(async f => {
  const u = turn('user', 'question'), old = batch('abandoned', u, 'old'), a = batch('first', u), next = turn('user', 'next question', a.uuid), done = batch('next answer', next, 'next'), b = batch('sibling', u);
  f.conversation([u, old, a, next, done, b, checkpoint(done.uuid)]);
  const read = await f.read('--tail', '0');
  expect(read.data.messages.map(row => row.text)).toEqual(['question', 'first', 'sibling', 'next question', 'next answer']);
}));

test('parallel tool blocks restore their associated results in native anchor order', () => fixture(async f => {
  const u = turn('user', 'question'), a = batch('a', u, 'batch', [call('a')]), b = batch('b', u, 'batch', [call('b')]), ra = result('ra', a, 'a'), rb = result('rb', b, 'b'), done = batch('done', rb, 'done');
  f.conversation([u, a, b, ra, rb, done]);
  const read = await f.read('--events', '--tail', '0');
  expect(read.data.messages.map(row => row.id)).toEqual([u, b, a, ra, rb, done].map(row => row.uuid));
}));

for (const mode of ['unique', 'ambiguous', 'different-parent', 'sidechain', 'other-agent', 'already-present']) {
  test(`orphan tool result recovery: ${mode}`, () => fixture(async f => {
    const u = turn('user', 'question'), a = batch('a', u, 'batch', [call('a')]), orphan = result('orphan', u, 'a'), direct = result('direct', a, 'a'), other = batch('other', u, 'other', [call('a')]);
    if (mode === 'sidechain') orphan.isSidechain = true;
    if (mode === 'other-agent') orphan.agentId = 'other';
    if (mode === 'different-parent') { delete other.message.id; orphan.parentUuid = other.uuid; }
    const done = batch('done', mode === 'already-present' ? direct : a, 'done');
    f.conversation([u, orphan, a, ...(['ambiguous', 'different-parent'].includes(mode) ? [other] : []), ...(mode === 'already-present' ? [direct] : []), done]);
    const read = await f.read('--events', '--tail', '0');
    const expected = [u, a, ...(mode === 'unique' ? [orphan] : mode === 'already-present' ? [direct] : []), done];
    expect(read.data.messages.map(row => row.id)).toEqual(expected.map(row => row.uuid)); expect(read.data.ancestryIncomplete).toBe(false);
  }));
}

for (const mode of ['linear', 'ordinary-user', 'branched']) {
  test(`metadata tail recovery: ${mode}`, () => fixture(async f => {
    const u = turn('user', 'question'), a = batch('a', u, 'batch', [call('a')]), b = batch('b', u, 'batch', [call('b')]), r = result('result', a, 'a');
    const meta = turn('user', 'notification', r.uuid, { isMeta: true }), next = turn('user', 'abandoned next turn', meta.uuid), x = turn('user', 'x', meta.uuid, { isMeta: true }), y = turn('user', 'y', meta.uuid, { isMeta: true }), done = batch('done', b, 'done');
    f.conversation([u, a, b, r, meta, ...(mode === 'ordinary-user' ? [next] : mode === 'branched' ? [x, y] : []), done]);
    const read = await f.read('--events', '--tail', '0'), expected = [u, b, a, r, ...(mode === 'linear' ? [meta] : []), done];
    expect(read.data.messages.map(row => row.id)).toEqual(expected.map(row => row.uuid));
  }));
}

for (const mode of ['unique-call', 'explicit-source', 'other-agent', 'parent-owns-call']) {
  test(`active orphan result metadata tail: ${mode}`, () => fixture(async f => {
    const u = turn('user', 'question'), a = batch('a', u, 'batch', [call('a')]), other = batch('other', u, 'other', [call('a')]);
    const bridge = mode === 'parent-owns-call' ? turn('assistant', [call('a')], a.uuid) : turn('user', 'context', a.uuid, { isMeta: true });
    const r = result('result', bridge, 'a'), meta = turn('user', 'notification', r.uuid, { isMeta: true }), done = batch('done', r, 'done');
    if (mode === 'explicit-source' || mode === 'parent-owns-call') r.sourceToolAssistantUUID = a.uuid;
    if (mode === 'other-agent') r.agentId = 'other';
    f.conversation([u, a, ...(mode === 'explicit-source' ? [other] : []), bridge, r, meta, done]);
    const read = await f.read('--events', '--tail', '0'), restored = ['unique-call', 'explicit-source'].includes(mode);
    expect(read.data.messages.map(row => row.id)).toEqual([u, a, bridge, r, ...(restored ? [meta] : []), done].map(row => row.uuid));
    expect(read.data.ancestryIncomplete).toBe(false); expect(f.connections()).toBe(0);
    if (restored) expect((await f.read('--events', '--after', meta.uuid)).data.messages.map(row => row.id)).toEqual([done.uuid]);
  }));
}

test('batch recovery cannot revive messages removed by compaction', () => fixture(async f => {
  const u = turn('user', 'old question'), old = batch('old block', u), c = boundary(), summary = turn('user', 'summary', c.uuid, { isCompactSummary: true }), current = batch('current block', summary);
  f.conversation([u, old, c, summary, current]);
  const read = await f.read('--tail', '0');
  expect(read.data.messages.map(row => row.text)).toEqual(['summary', 'current block']);
}));

function postReply(address,frames) {
  const peer=createConnection(address.slice(4),()=>{
    peer.write(frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n',()=>peer.end());
  });
  peer.on('error',()=>{});
}

test('send --wait receives the first native reply and removes its request-specific inbox', () => fixture(async f=>{
  const result=await f.send('Explain ORCHID','--wait','2'),sent=JSON.parse(f.received[0]);
  expect(result.code).toBe(0);expect(result.data.reply.status).toBe('received');expect(result.data.reply.text).toBe('ORCHID uses PostgreSQL');
  expect(sent.message.content).toContain(`from="${sent.from}"`);expect(sent.message.content).toContain('Explain ORCHID');
  expect(existsSync(sent.from.slice(4))).toBe(false);expect(f.connections()).toBe(1);
},{onMessage:(text,path)=>{
  const sent=JSON.parse(text);
  postReply(sent.from,[{type:'user',from:'uds:'+path,msg_id:randomUUID(),message:{role:'user',content:'ORCHID uses PostgreSQL'}}]);
}}));

test('delivery receipts and foreign senders do not satisfy --wait', () => fixture(async f=>{
  const result=await f.send('Wait for an answer','--wait','1'),sent=JSON.parse(f.received[0]);
  expect(result.code).toBe(2);expect(result.data.status).toBe('submitted');expect(result.data.reply.status).toBe('timeout');
  expect(result.data.reply.receipt.status).toBe('delivered');expect(existsSync(sent.from.slice(4))).toBe(true);expect(f.connections()).toBe(1);
},{onMessage:(text,path)=>{
  const sent=JSON.parse(text);
  postReply(sent.from,[
    {type:'control',from:'uds:'+path,action:'peer_message_status',status:'delivered',orig_msg_id:sent.msg_id},
    {type:'user',from:sent.from,message:{role:'user',content:'Not the intended sender'}},
    {type:'user',from:'uds:'+path,message:{role:'user',content:''}}
  ]);
}}));

test('a matching refusal returns without resending', () => fixture(async f=>{
  const result=await f.send('Ask once','--wait','2'),sent=JSON.parse(f.received[0]);
  expect(result.code).toBe(2);expect(result.data.reply.status).toBe('refused');expect(f.connections()).toBe(1);expect(existsSync(sent.from.slice(4))).toBe(false);
},{onMessage:(text,path)=>{
  const sent=JSON.parse(text);postReply(sent.from,[{type:'control',from:'uds:'+path,action:'peer_message_status',status:'refused',orig_msg_id:sent.msg_id}]);
}}));

test('concurrent requests have distinct reply inboxes', () => fixture(async f=>{
  const results=await Promise.all([f.send('FIRST','--wait','2'),f.send('SECOND','--wait','2')]);
  expect(results.map(r=>r.data.reply.text)).toEqual(['FIRST','SECOND']);
  const addresses=f.received.map(text=>JSON.parse(text).from);expect(new Set(addresses).size).toBe(2);
  expect(addresses.every(address=>!existsSync(address.slice(4)))).toBe(true);
},{onMessage:(text,path)=>{
  const sent=JSON.parse(text),answer=sent.message.content.includes('FIRST')?'FIRST':'SECOND';
  setTimeout(()=>postReply(sent.from,[{type:'user',from:'uds:'+path,message:{role:'user',content:answer}}]),answer==='FIRST'?80:10);
}}));

test('invalid wait arguments cannot send a message', () => fixture(async f=>{
  for(const wait of ['-1','1.5','3601'])expect((await f.send('hello',`--wait=${wait}`)).data.error).toBe('invalid_argument');
  expect((await f.run(['list','--wait','1'])).data.error).toBe('invalid_argument');expect(f.connections()).toBe(0);
}));

test('a reply from a changed session identity is not accepted', async ()=>{
  let change;
  await fixture(async f=>{
    change=()=>f.registration({sessionId:randomUUID()});
    const result=await f.send('Check identity','--wait','2');
    expect(result.code).toBe(2);expect(result.data.reply.status).toBe('target_changed');expect(result.data.reply.text).toBeUndefined();expect(f.connections()).toBe(1);
  },{onMessage:(text,path)=>{
    const sent=JSON.parse(text);change();postReply(sent.from,[{type:'user',from:'uds:'+path,message:{role:'user',content:'An answer after target change'}}]);
  }});
});

test('held receipts remain distinct from answers and do not trigger retries', () => fixture(async f=>{
  const result=await f.send('Hold this request','--wait','1');
  expect(result.code).toBe(2);expect(result.data.reply).toMatchObject({status:'timeout',receipt:{status:'held'}});expect(f.connections()).toBe(1);
},{onMessage:(text,path)=>{
  const sent=JSON.parse(text);postReply(sent.from,[{type:'control',from:'uds:'+path,action:'peer_message_status',status:'held',orig_msg_id:sent.msg_id}]);
}}));

test('interrupting a standalone waiter leaves its receiving inbox available', () => fixture(async f=>{
  const sent=await f.send('hello','--wait','0'),request=sent.data.request;
  const child=Bun.spawn([process.execPath,cli,'wait','--request',request,'--timeout','60'],{stdout:'pipe',stderr:'pipe'});
  try{
    expect(f.received).toHaveLength(1);
    const address=JSON.parse(f.received[0]).from.slice(4),directory=address.slice(0,address.lastIndexOf('/'));
    expect(existsSync(address)).toBe(true);child.kill('SIGTERM');await child.exited;
    expect(existsSync(address)).toBe(true);expect(f.connections()).toBe(1);
    expect((await f.run(['close','--request',request])).code).toBe(0);
    expect(existsSync(address)).toBe(false);expect(existsSync(directory)).toBe(false);
  }finally{if(child.exitCode===null)child.kill();await child.exited}
}));

test('fragmented native reply frames are assembled before returning', () => fixture(async f=>{
  const result=await f.send('Unicode reply','--wait','2');
  expect(result.code).toBe(0);expect(result.data.reply.text).toBe('你好 🌱');
},{onMessage:(text,path)=>{
  const sent=JSON.parse(text),frame=Buffer.from(JSON.stringify({type:'user',from:'uds:'+path,message:{role:'user',content:'你好 🌱'}})+'\n');
  const split=frame.indexOf(Buffer.from('🌱'))+1,peer=createConnection(sent.from.slice(4),()=>{
    peer.write(frame.subarray(0,split));setTimeout(()=>peer.write(frame.subarray(split),()=>peer.end()),10);
  });peer.on('error',()=>{});
}}));

for(const frame of [{status:'expired',status_detail:'refused'},{status:'denied'},{status:'dropped'}]){
  test(`terminal native delivery status: ${JSON.stringify(frame)}`,()=>fixture(async f=>{
    const result=await f.send('No retry','--wait','2');
    expect(result.code).toBe(2);expect(result.data.reply.status).toBe(frame.status_detail||frame.status);expect(f.connections()).toBe(1);
  },{onMessage:(text,path)=>{
    const sent=JSON.parse(text);postReply(sent.from,[{type:'control',from:'uds:'+path,action:'peer_message_status',orig_msg_id:sent.msg_id,...frame}]);
  }}));
}

test('two timeouts can be followed by a cached reply without another send',()=>fixture(async f=>{
  const first=await f.send('Answer later','--wait','1'),request=first.data.request;
  expect(first.code).toBe(2);expect(first.data.reply.status).toBe('timeout');
  const second=await f.run(['wait','--request',request,'--timeout','1']);
  expect(second.data.reply.status).toBe('timeout');expect(second.data.expiresAt).toBe(first.data.expiresAt);
  const sent=JSON.parse(f.received[0]),directory=request.slice(0,request.lastIndexOf('/'));
  await new Promise((resolve,reject)=>{
    const watcher=watch(directory,()=>{if(existsSync(join(directory,'reply.json'))){clearTimeout(timer);watcher.close();resolve()}});
    const timer=setTimeout(()=>{watcher.close();reject(Error('Reply was not cached'))},2000);
    postReply(sent.from,[{type:'user',from:'uds:'+f.socketPath,msg_id:'late-reply',message:{role:'user',content:'Late but retained'}}]);
  });
  expect(existsSync(sent.from.slice(4))).toBe(false);
  for(let i=0;i<2;i++){
    const result=await f.run(['wait','--request',request,'--timeout','1']);
    expect(result.code).toBe(0);expect(result.data.reply).toMatchObject({status:'received',messageId:'late-reply',text:'Late but retained'});
  }
  expect(f.connections()).toBe(1);
}));

test('standalone wait observes a live receiver event after send returns immediately',()=>fixture(async f=>{
  const sent=await f.send('Async request','--wait','0');expect(sent.code).toBe(0);expect(sent.data.reply.status).toBe('pending');
  const pending=f.run(['wait','--request',sent.data.request,'--timeout','2']),frame=JSON.parse(f.received[0]);
  setTimeout(()=>postReply(frame.from,[{type:'user',from:'uds:'+f.socketPath,message:{role:'user',content:'Event received'}}]),100);
  const result=await pending;expect(result.code).toBe(0);expect(result.data.reply.text).toBe('Event received');expect(f.connections()).toBe(1);
}));

test('receiver lifetime expires independently of wait duration',()=>fixture(async f=>{
  const sent=await f.send('No reply','--wait','0','--reply-ttl','1'),frame=JSON.parse(f.received[0]);
  const waited=await f.run(['wait','--request',sent.data.request,'--timeout','2']);
  expect(waited.code).toBe(2);expect(waited.data.reply.status).toBe('expired');expect(waited.data.expiresAt).toBe(sent.data.expiresAt);
  expect((await f.run(['close','--request',sent.data.request])).code).toBe(0);
  expect(existsSync(frame.from.slice(4))).toBe(false);expect(existsSync(sent.data.request)).toBe(false);
}));

test('failed sends close their receiver without retaining an orphan request',()=>fixture(async f=>{
  const result=await f.send('x'.repeat(1000000),'--wait','0');
  expect(result.data.error).toBe('message_too_large');expect(f.connections()).toBe(0);
  expect(readdirSync(f.root).filter(name=>name.startsWith('ccs-request-')||name.startsWith('ccs-reply-'))).toEqual([]);
}));

test('close refuses unrelated or symlinked request directories',()=>fixture(async f=>{
  const unrelated=join(f.root,'keep.json');writeFileSync(unrelated,'important');
  expect((await f.run(['close','--request',unrelated])).code).toBe(1);expect(readFileSync(unrelated,'utf8')).toBe('important');
  const sent=await f.send('Pending','--wait','0'),alias=join(f.root,'ccs-request-alias');
  symlinkSync(sent.data.request.slice(0,sent.data.request.lastIndexOf('/')),alias);
  expect((await f.run(['close','--request',join(alias,'request.json')])).data.error).toBe('unsafe_request');
  expect(existsSync(JSON.parse(f.received[0]).from.slice(4))).toBe(true);
}));

test('a post-submission wait error preserves the handle and receiver',async()=>{
  let makeUnreadable,request;
  await fixture(async f=>{
    makeUnreadable=()=>{
      const directory=readdirSync(f.root).find(name=>name.startsWith('ccs-request-'));
      request=join(f.root,directory,'request.json');chmodSync(request,0o644);
    };
    const result=await f.send('Keep receiving','--wait','1');
    chmodSync(request,0o600);
    expect(result.data.error).toBe('unsafe_request');expect(result.data.request).toBeDefined();
    const sent=JSON.parse(f.received[0]);expect(existsSync(sent.from.slice(4))).toBe(true);
    postReply(sent.from,[{type:'user',from:'uds:'+f.socketPath,message:{role:'user',content:'Recovered after wait error'}}]);
    const recovered=await f.run(['wait','--request',result.data.request,'--timeout','2']);
    expect(recovered.data.reply.text).toBe('Recovered after wait error');expect(f.connections()).toBe(1);
  },{onMessage:()=>makeUnreadable()});
});

test('closing a request wakes its active waiter without resending',()=>fixture(async f=>{
  const sent=await f.send('Await cancellation','--wait','0'),pending=f.run(['wait','--request',sent.data.request,'--timeout','3']);
  await Bun.sleep(100);
  expect((await f.run(['close','--request',sent.data.request])).code).toBe(0);
  const stopped=await pending;expect(stopped.code).toBe(2);expect(['cancelled','closed']).toContain(stopped.data.reply.status);expect(f.connections()).toBe(1);
}));
