// The owner relay's lifecycle IPC on its Unix socket: token gate, ping, bind and turn_ended
// semantics (including the in-flight override to Interrupt and the upstream cleanup-timeout
// tolerance), and the pending turn end retried before the session's next call.
// SPEC §4 stage-1 items 5, 6 and 9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { ipcRequest } from '../ipc.mjs';
import { createRelay } from '../relay.mjs';
import { readToken } from '../singleton.mjs';
import {
  captureLog, connectHost, entrySession, FIXTURE_PATH, makeTempDirectory, readFixtureLog,
  RELAY_ARGV, removeTempDirectory, sessionMeta, waitFor, waitForEntry, withEnv,
} from './helpers.mjs';

/** Open one owner relay with a connected host and its IPC token read back from the file. */
async function ownerRelay(directory, logPath) {
  const log = captureLog();
  const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log, argv: RELAY_ARGV });
  const host = await connectHost(relay);
  const token = readToken(relay.tokenPath);
  assert.match(token, /^[0-9a-f]{64}$/, 'the owner writes a 32-byte hex token with mode 0600');
  return { relay, host, token, log, socketPath: relay.socketPath };
}

const turnEnds = (logPath, sessionId) => readFixtureLog(logPath)
  .filter(entry => entry.name === 'turn_ended' && entry.args?.session_id === sessionId);

test('IPC answers ping, refuses a wrong token, and closes on bad or unknown input', async () => {
  const directory = makeTempDirectory('lcu-opencode-ipc-gate-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const { relay, host, token, socketPath } = await ownerRelay(directory, logPath);
      try {
        const pong = await ipcRequest(socketPath, { token, type: 'ping' });
        assert.deepEqual(pong, { ok: true, pid: process.pid, role: 'owner' });
        // A wrong token gets one error line; the server stays alive for correct ones.
        const stranger = await ipcRequest(socketPath, { token: `${token}0`, type: 'ping' });
        assert.deepEqual(stranger, { ok: false, error: 'invalid_token' });
        assert.deepEqual(await ipcRequest(socketPath, { token, type: 'ping' }), pong);
        // Broken JSON and unknown types are refused as bad requests.
        const raw = await new Promise((resolve, reject) => {
          let buffer = '';
          const socket = createConnection(socketPath);
          socket.on('error', reject);
          socket.on('connect', () => socket.write('this is not json\n'));
          socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.includes('\n')) {
              socket.destroy();
              resolve(JSON.parse(buffer));
            }
          });
        });
        assert.deepEqual(raw, { ok: false, error: 'bad_request' });
        assert.deepEqual(await ipcRequest(socketPath, { token, type: 'surprise' }),
          { ok: false, error: 'bad_request' });
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('bind ends the open turn with Stop upstream, and repeated binds are no-ops', async () => {
  const directory = makeTempDirectory('lcu-opencode-ipc-bind-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const { relay, host, token, socketPath } = await ownerRelay(directory, logPath);
      try {
        const sessionId = 'bind-session';
        // A bind for a session with no open turn: no-op.
        assert.deepEqual(await ipcRequest(socketPath, { token, type: 'bind', sessionID: sessionId }),
          { ok: true, pid: process.pid });
        await host.client.callTool({ name: 'js', arguments: { code: 'first' }, _meta: sessionMeta(sessionId) });
        const jsEntry = await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === sessionId);
        const turnId = jsEntry.meta['x-codex-turn-metadata'].turn_id;
        // The new prompt round rebinds: the still-open turn ends with Stop.
        assert.deepEqual(await ipcRequest(socketPath, { token, type: 'bind', sessionID: sessionId }),
          { ok: true, pid: process.pid });
        const ended = await waitFor(() => turnEnds(logPath, sessionId), entries => entries.length === 1);
        assert.deepEqual(ended[0].args, { hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId });
        // Another bind, now with no open turn again: no-op, nothing further upstream.
        assert.deepEqual(await ipcRequest(socketPath, { token, type: 'bind', sessionID: sessionId }),
          { ok: true, pid: process.pid });
        assert.equal(turnEnds(logPath, sessionId).length, 1);
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('bind and turn_ended interrupt the open turn while a call of the session is in flight', async () => {
  const directory = makeTempDirectory('lcu-opencode-ipc-busy-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const { relay, host, token, socketPath } = await ownerRelay(directory, logPath);
      try {
        const bound = 'busy-bound-session';
        // Scenario 1: a bind during the session's own in-flight call interrupts it.
        const boundCall = host.client.callTool({ name: 'js', arguments: { code: 'sleep-500' }, _meta: sessionMeta(bound) });
        await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === bound);
        assert.deepEqual(await ipcRequest(socketPath, { token, type: 'bind', sessionID: bound }),
          { ok: true, pid: process.pid });
        await waitFor(() => turnEnds(logPath, bound), entries => entries.length === 1);
        assert.deepEqual(turnEnds(logPath, bound)[0].args.hook_event_name, 'Interrupt');
        assert.equal((await boundCall).isError, undefined);
        // Scenario 2: an explicit Interrupt event ends the idle-open turn the same way.
        assert.ok((await ipcRequest(socketPath, { token, type: 'turn_ended', sessionID: bound, event: 'Interrupt' })).ok);
        assert.equal(turnEnds(logPath, bound).length, 1, 'no open turn after the bind, nothing further upstream');
        // Scenario 3: turn_ended for a session whose call is in flight is interrupted even when
        // it says Stop, and the same request for an idle session is a no-op.
        const ended = 'busy-ended-session';
        const again = host.client.callTool({ name: 'js', arguments: { code: 'sleep-500' }, _meta: sessionMeta(ended) });
        await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === ended);
        assert.ok((await ipcRequest(socketPath, { token, type: 'turn_ended', sessionID: ended, event: 'Stop' })).ok);
        await waitFor(() => turnEnds(logPath, ended), entries => entries.length === 1);
        assert.deepEqual(turnEnds(logPath, ended)[0].args.hook_event_name, 'Interrupt');
        assert.equal((await again).isError, undefined);
        const before = turnEnds(logPath, ended).length;
        assert.ok((await ipcRequest(socketPath, { token, type: 'turn_ended', sessionID: ended, event: 'Stop' })).ok);
        assert.equal(turnEnds(logPath, ended).length, before, 'no open turn, nothing sent upstream');
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('the upstream cleanup timeout is accepted as a turn end and cleared from the bookkeeping', async () => {
  const directory = makeTempDirectory('lcu-opencode-ipc-timeout-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const { relay, host, token, socketPath, log } = await ownerRelay(directory, logPath);
      try {
        const sessionId = 'timeout-1-session';
        await host.client.callTool({ name: 'js', arguments: { code: 'work' }, _meta: sessionMeta(sessionId) });
        await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === sessionId);
        // The fixture refuses this session's first turn end with the host's timeout error.
        assert.ok((await ipcRequest(socketPath, { token, type: 'turn_ended', sessionID: sessionId })).ok,
          'the timeout is treated as accepted');
        assert.equal(turnEnds(logPath, sessionId).length, 1);
        assert.ok(log.events.some(event => event.event === 'turn_end' && event.outcome === 'cleanup_timeout'),
          'the diagnostic log records the tolerated cleanup timeout');
        // The turn was still ended: a second request is a no-op.
        assert.ok((await ipcRequest(socketPath, { token, type: 'turn_ended', sessionID: sessionId })).ok);
        assert.equal(turnEnds(logPath, sessionId).length, 1);
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('a refused turn end is deferred and retried before the session\u2019s next call', async () => {
  const directory = makeTempDirectory('lcu-opencode-ipc-retry-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const { relay, host, token, socketPath } = await ownerRelay(directory, logPath);
      try {
        // The fixture fails every turn end of this session.
        const failing = 'fail-session';
        await host.client.callTool({ name: 'js', arguments: { code: 'work' }, _meta: sessionMeta(failing) });
        await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === failing);
        assert.deepEqual(await ipcRequest(socketPath, { token, type: 'turn_ended', sessionID: failing }),
          { ok: false, error: 'turn_end_failed' });
        const nextCall = await host.client.callTool({ name: 'js', arguments: { code: 'next' }, _meta: sessionMeta(failing) });
        assert.equal(nextCall.isError, true);
        assert.match(nextCall.content[0].text, /^LCU is still finishing the previous turn/);
        assert.equal(readFixtureLog(logPath).filter(entry => entry.name === 'js').length, 1,
          'the retried turn end ran, but no second js reached the upstream');
        assert.equal(turnEnds(logPath, failing).length, 2, 'the pending end was retried once');

        // A turn end that fails once succeeds on the retry, and the call then proceeds.
        const once = 'fail-once-session';
        await host.client.callTool({ name: 'js', arguments: { code: 'work' }, _meta: sessionMeta(once) });
        await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === once);
        assert.deepEqual(await ipcRequest(socketPath, { token, type: 'turn_ended', sessionID: once }),
          { ok: false, error: 'turn_end_failed' });
        const retried = await host.client.callTool({ name: 'js', arguments: { code: 'next' }, _meta: sessionMeta(once) });
        assert.notEqual(retried.isError, true, 'the retry cleared the pending end and the call ran');
        const jsCalls = await waitFor(() => readFixtureLog(logPath).filter(entry => entry.name === 'js'),
          entries => entries.length === 3);
        assert.equal(entrySession(jsCalls[2]), once);
        assert.equal(turnEnds(logPath, once).length, 2);
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});