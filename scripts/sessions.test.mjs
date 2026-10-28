import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const cli = join(import.meta.dir, 'sessions.mjs');
const procStat = process.platform === 'linux' ? readFileSync(`/proc/${process.pid}/stat`, 'utf8') : null;
const procStart = procStat === null ? execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim() : procStat.slice(procStat.lastIndexOf(')') + 2).split(/\s+/)[19];
const turn = (type, text, parentUuid = null, extra = {}) => ({ type, uuid: randomUUID(), parentUuid, timestamp: new Date().toISOString(), message: { role: type, content: text }, ...extra });
const boundary = (compactMetadata = {}) => ({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), parentUuid: null, compactMetadata });

async function fixture(check) {
  // A short path avoids macOS's Unix socket path limit; never inspect ~/.claude.
  const root = mkdtempSync('/tmp/ccs-test-'), id = randomUUID(), peers = new Set(), received = [];
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'sessions')); mkdirSync(join(root, 'projects')); mkdirSync(join(root, 'projects', 'fixture'));
  const socketPath = join(root, 'inbox.sock'), registry = join(root, 'sessions', `${process.pid}.json`), transcript = join(root, 'projects', 'fixture', `${id}.jsonl`);
  let connections = 0;
  const server = createServer({ allowHalfOpen: true }, socket => {
    connections++; peers.add(socket); socket.setEncoding('utf8'); let text = '';
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', () => { received.push(text); socket.end(); });
    socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
  });
  const registration = patch => writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: id, procStart, cwd: root, name: 'fixture', status: 'idle', messagingSocketPath: socketPath, ...patch }));
  const conversation = (rows, suffix = '') => writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n' + suffix);
  const run = async (argv, input = '') => {
    // A synchronous child would starve this process's mock socket server.
    const child = Bun.spawn([process.execPath, cli, '--config-dir', root, ...argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLAUDE_CONFIG_DIR: root } });
    const timeout = setTimeout(() => child.kill(), 7000);
    try {
      child.stdin.write(input); child.stdin.end();
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, data: JSON.parse(code === 0 ? stdout : stderr) };
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); await child.exited; }
  };
  const read = (...args) => run(['read', '--id', id, ...args]);
  const send = (text = 'hello', ...args) => run(['send', '--id', id, '--pid', String(process.pid), '--text', '-', ...args], text);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    registration(); conversation([]);
    await check({ root, id, registry, transcript, socketPath, registration, conversation, run, read, send, received, connections: () => connections });
  } finally {
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
  expect(listed.data.sessions[0]).toMatchObject({ id: f.id, pid: process.pid, processIdentity: 'verified', latestUser: request.message.content });
  expect(read.data.messages.map(row => row.text)).toEqual(['Review this branch', 'Still reviewing']);
  expect(f.connections()).toBe(0);
}));

test('a stale process start identity blocks sending before connection', () => fixture(async f => {
  f.registration({ procStart: 'stale' });
  const result = await f.send();
  expect(result.code).toBe(1); expect(result.data.error).toBe('process_changed'); expect(f.connections()).toBe(0);
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

test('batch recovery cannot revive messages removed by compaction', () => fixture(async f => {
  const u = turn('user', 'old question'), old = batch('old block', u), c = boundary(), summary = turn('user', 'summary', c.uuid, { isCompactSummary: true }), current = batch('current block', summary);
  f.conversation([u, old, c, summary, current]);
  const read = await f.read('--tail', '0');
  expect(read.data.messages.map(row => row.text)).toEqual(['summary', 'current block']);
}));
