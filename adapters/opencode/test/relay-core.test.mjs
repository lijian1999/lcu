// The relay's model-facing MCP surface, against a fake LCU upstream subprocess:
// which tools OpenCode sees, how the session identity and turn metadata reach the upstream,
// strict identity, the single-runtime session mutex, and the v0.4 approval policy.
// SPEC §4 stage-1 items 1, 2, 3, 4 and 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createSessions } from '../sessions.mjs';
import { createRelay, createApprovalPolicy, fallbackIdentity, parseRelayArgs } from '../relay.mjs';
import { readToken } from '../singleton.mjs';
import { ipcRequest } from '../ipc.mjs';
import {
  captureLog, connectHost, entrySession, FIXTURE_PATH, makeTempDirectory, readFixtureLog,
  RELAY_ARGV, removeTempDirectory, sessionMeta, UUID_PATTERN, waitFor, waitForEntry, withEnv,
} from './helpers.mjs';

test('relay arguments parse, and the fallback identity is a stable per-connection name', () => {
  assert.deepEqual(parseRelayArgs(['--lcu', '/a/lcu', '--state-dir', '/b/state']),
    { lcuPath: '/a/lcu', stateDir: '/b/state' });
  assert.deepEqual(parseRelayArgs(['--lcu=/a/lcu']), { lcuPath: '/a/lcu' });
  assert.deepEqual(parseRelayArgs(['--state-dir=/b/state']), { stateDir: '/b/state' });
  assert.deepEqual(parseRelayArgs([]), {});
  assert.throws(() => parseRelayArgs(['--bogus']), /Unknown relay argument/);
  assert.throws(() => parseRelayArgs(['--lcu']), /needs a value/);
  const identity = fallbackIdentity(RELAY_ARGV);
  assert.match(identity, /^opencode-conn-[0-9a-f]{8}$/);
  assert.equal(fallbackIdentity(RELAY_ARGV), identity, 'stable for the same connection argv');
  assert.notEqual(fallbackIdentity(['node', 'relay.mjs', '--lcu', '/other']), identity);
});

test('tools/list exposes exactly js/js_reset with the original descriptors, and no instructions yet', async () => {
  const directory = makeTempDirectory('lcu-opencode-list-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const log = captureLog();
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log, argv: RELAY_ARGV });
      const host = await connectHost(relay);
      try {
        assert.equal(host.client.getInstructions() ?? '', '', 'the lazy upstream is not connected at initialize');
        const listed = await host.client.listTools();
        assert.deepEqual(listed.tools.map(tool => tool.name), ['js', 'js_reset']);
        assert.equal(listed.tools[0].description, 'Fixture JS description.');
        assert.deepEqual(listed.tools[0].inputSchema.required, ['code']);
        assert.deepEqual(log.events[0], { event: 'relay_start', role: 'owner', pid: process.pid, lcu: FIXTURE_PATH });
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('js calls carry the OpenCode session id and a relay-minted turn UUID upstream', async () => {
  const directory = makeTempDirectory('lcu-opencode-meta-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV });
      const host = await connectHost(relay);
      try {
        await host.client.callTool({ name: 'js', arguments: { code: 'ping' }, _meta: sessionMeta('meta-session') });
        const metaEntry = await waitForEntry(logPath, entry => entry.name === 'js');
        assert.equal(entrySession(metaEntry), 'meta-session');
        assert.equal(metaEntry.meta['ai.opencode/sessionID'], 'meta-session');
        assert.match(metaEntry.meta['x-codex-turn-metadata'].turn_id, UUID_PATTERN);
        // Without the OpenCode meta, the relay's stable fallback name is used, unchanged across calls.
        await host.client.callTool({ name: 'js', arguments: { code: 'ping' } });
        await host.client.callTool({ name: 'js', arguments: { code: 'ping' } });
        const entries = await waitFor(() => readFixtureLog(logPath).filter(entry => entry.name === 'js'),
          entries => entries.length >= 3);
        const fallback = entries.slice(1);
        assert.equal(fallback[0].meta['ai.opencode/sessionID'], undefined);
        const name = entrySession(fallback[0]);
        assert.match(name, /^opencode-conn-[0-9a-f]{8}$/);
        assert.equal(entrySession(fallback[1]), name, 'the fallback name is stable for the connection');
        assert.notEqual(name, 'meta-session');
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('strict identity refuses calls without the OpenCode session id', async () => {
  const directory = makeTempDirectory('lcu-opencode-strict-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const log = captureLog();
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log, argv: RELAY_ARGV,
        env: { ...process.env, LCU_OPENCODE_IDENTITY: 'strict' } });
      const host = await connectHost(relay);
      try {
        const refused = await host.client.callTool({ name: 'js', arguments: { code: 'ping' } });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text,
          /^identity_refused: OpenCode did not provide a session id \(_meta\.ai\.opencode\/sessionID missing\)$/);
        assert.ok(log.events.some(event => event.event === 'identity_refused' && event.tool === 'js'));
        const allowed = await host.client.callTool({ name: 'js', arguments: { code: 'ping' }, _meta: sessionMeta('strict-session') });
        assert.notEqual(allowed.isError, true);
        const entry = await waitForEntry(logPath, entry => entry.name === 'js');
        assert.equal(entrySession(entry), 'strict-session');
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('a second session cannot use the runtime while one is busy, and takes over when it is idle', async () => {
  const directory = makeTempDirectory('lcu-opencode-mutex-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const log = captureLog();
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log, argv: RELAY_ARGV });
      const host = await connectHost(relay);
      try {
        await host.client.callTool({ name: 'js', arguments: { code: 'warm' }, _meta: sessionMeta('warm-session') });
        const busyCall = host.client.callTool({ name: 'js', arguments: { code: 'sleep-400' }, _meta: sessionMeta('session-a') });
        await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === 'session-a');
        const refused = await host.client.callTool({ name: 'js', arguments: { code: 'other' }, _meta: sessionMeta('session-b') });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text,
          /^LCU is in use by another session \(session-a\)\. Wait for it to finish or switch to that OpenCode session\.$/);
        assert.equal((await busyCall).isError, undefined);
        const admitted = await host.client.callTool({ name: 'js', arguments: { code: 'other' }, _meta: sessionMeta('session-b') });
        assert.notEqual(admitted.isError, true);
        assert.ok(log.events.some(event =>
          event.event === 'session_switch' && event.from === 'session-a' && event.to === 'session-b'));
        // The same session may call concurrently; both reach the upstream.
        const first = host.client.callTool({ name: 'js', arguments: { code: 'sleep-300' }, _meta: sessionMeta('session-b') });
        await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === 'session-b' && entry.args.code === 'sleep-300');
        const second = await host.client.callTool({ name: 'js', arguments: { code: 'again' }, _meta: sessionMeta('session-b') });
        assert.notEqual(second.isError, true);
        assert.equal((await first).isError, undefined);
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('approval elicitations are auto-accepted and logged; agent-hosting apps are declined by the guard', async () => {
  const directory = makeTempDirectory('lcu-opencode-approval-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const log = captureLog();
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log, argv: RELAY_ARGV });
      const host = await connectHost(relay);
      try {
        const accepted = await host.client.callTool({ name: 'js', arguments: { code: 'approval' }, _meta: sessionMeta('approval-session') });
        assert.deepEqual(JSON.parse(accepted.content[0].text), { action: 'accept', content: {} });
        const event = log.events.find(item => item.event === 'approval_auto_accepted');
        assert.equal(event.app, 'dev.lcu.fixture.generated');
        assert.equal(event.risk, 'low');
        assert.equal(event.tool, 'get_app_state');
        assert.equal(event.connector, 'computer-use');
        assert.equal(event.persist_offered, 'session,always');
        // The guard in the shared client declines an agent-hosting app before the policy is asked.
        const declined = await host.client.callTool({ name: 'js', arguments: { code: 'approval-host' }, _meta: sessionMeta('approval-session') });
        assert.deepEqual(JSON.parse(declined.content[0].text), { action: 'decline' });
        assert.equal(log.events.filter(item => item.event === 'approval_auto_accepted').length, 1);
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('js_reset clears every open turn, so a later bind ends nothing upstream', async () => {
  const directory = makeTempDirectory('lcu-opencode-reset-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV });
      const host = await connectHost(relay);
      try {
        const sessionId = 'reset-session';
        await host.client.callTool({ name: 'js', arguments: { code: 'first' }, _meta: sessionMeta(sessionId) });
        const reset = await host.client.callTool({ name: 'js_reset', arguments: {}, _meta: sessionMeta(sessionId) });
        assert.notEqual(reset.isError, true);
        const entries = await waitFor(() => readFixtureLog(logPath), all => all.some(entry => entry.name === 'js_reset'));
        const resetAt = entries.findIndex(entry => entry.name === 'js_reset');
        assert.deepEqual(entries.slice(0, resetAt).filter(entry => entry.name === 'turn_ended')
          .map(entry => [entry.args.hook_event_name, entry.args.session_id]), [['Interrupt', sessionId]],
          'the client ends the turns that ran js before the reset');
        // The worker generation changed, so the session has no open turn: bind is a no-op.
        const token = readToken(relay.tokenPath);
        const before = readFixtureLog(logPath).filter(entry => entry.name === 'turn_ended').length;
        const bound = await ipcRequest(relay.socketPath, { token, type: 'bind', sessionID: sessionId });
        assert.equal(bound.ok, true);
        assert.equal(readFixtureLog(logPath).filter(entry => entry.name === 'turn_ended').length, before);
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('calls for other tools are rejected as unknown, and upstream failures become tool errors', async () => {
  const directory = makeTempDirectory('lcu-opencode-guard-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV });
      const host = await connectHost(relay);
      try {
        await assert.rejects(host.client.callTool({ name: 'turn_ended', arguments: {}, _meta: sessionMeta('s') }),
          /Unknown tool: turn_ended/);
        await assert.rejects(host.client.callTool({ name: 'js_add_node_module_dir', arguments: {}, _meta: sessionMeta('s') }),
          /Unknown tool/);
        const failed = await host.client.callTool({ name: 'js', arguments: { code: 'throw' }, _meta: sessionMeta('s') });
        assert.equal(failed.isError, true);
        assert.match(failed.content[0].text, /LCU call failed:.*fixture js failure/);
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('the approval policy answers accept with empty content and logs only metadata', async () => {
  const events = captureLog();
  const policy = createApprovalPolicy(events);
  const decision = await policy({
    message: 'Allow Computer Use to use "Secret App"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { connector_id: 'computer-use', riskLevel: 'high', tool_name: 'click', tool_params: { app: 'com.example.secret' }, persist: ['session'] },
  });
  assert.deepEqual(decision, { action: 'accept', content: {} });
  assert.deepEqual(events.events, [{
    event: 'approval_auto_accepted', app: 'com.example.secret', connector: 'computer-use',
    risk: 'high', tool: 'click', persist_offered: 'session',
  }]);
  assert.deepEqual((await policy({})), { action: 'accept', content: {} });
  assert.deepEqual(events.events.at(-1), { event: 'approval_auto_accepted' }, 'no fields without metadata');
});
test('the session table keeps one open turn per session, refuses a busy switch, and evicts idle entries', () => {
  let nextId = 0;
  const sessions = createSessions({ limit: 3, randomUUID: () => `turn-${String(++nextId).padStart(2, '0')}` });
  assert.deepEqual(sessions.openTurns(), []);
  assert.equal(sessions.admit('first').switched, false, 'the first session switches silently');
  assert.equal(sessions.admit('first').switched, false, 're-admitting the active session is not a switch');
  assert.deepEqual(sessions.admit('a'), { ok: true, switched: true, from: 'first' });
  const finishA = sessions.beginCall('a');
  assert.deepEqual(sessions.admit('b'), { ok: false, other: 'a' }, 'another session is refused while a is in flight');
  finishA();
  const admission = sessions.admit('b');
  assert.equal(admission.ok, true);
  assert.deepEqual([admission.switched, admission.from], [true, 'a']);
  assert.equal(sessions.openTurn('b'), 'turn-01');
  assert.equal(sessions.openTurn('b'), 'turn-01', 'the open turn is reused');
  assert.equal(sessions.lookup('a')?.open, false, 'a has no open turn until it calls again');
  sessions.clearAllTurns();
  assert.deepEqual(sessions.openTurns(), []);
  // Idle entries are evicted oldest first; busy or open ones survive past the limit.
  sessions.openTurn('a');
  sessions.openTurn('b');
  sessions.openTurn('c');
  sessions.openTurn('d');
  assert.deepEqual(sessions.openTurns().map(turn => turn.sessionId).sort(), ['a', 'b', 'c', 'd'],
    'nothing idle, so nothing is evicted even past the limit');
  sessions.endTurn('a');
  sessions.openTurn('e');
  assert.equal(sessions.lookup('a'), undefined, 'the oldest idle entry made room');
  assert.deepEqual(sessions.openTurns().map(turn => turn.sessionId).sort(), ['b', 'c', 'd', 'e']);
});
