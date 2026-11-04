// Singleton election: the lock file with stale-pid takeover, the standby role with static
// descriptors, the in-use refusal, and the standby's takeover once the owner's lock is gone.
// SPEC §4 stage-1 item 8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, prepareStateDirectory, readLockOwner, readToken, writeToken } from '../singleton.mjs';
import { createRelay } from '../relay.mjs';
import { ipcRequest } from '../ipc.mjs';
import {
  captureLog, connectHost, FIXTURE_PATH, makeTempDirectory, readFixtureLog, RELAY_ARGV,
  removeTempDirectory, sessionMeta, waitFor, withEnv,
} from './helpers.mjs';

const statModule = { statSync };

/** A pid that is gone: a child process that exited. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise(resolve => child.on('exit', resolve));
  return child.pid;
}

test('the lock is exclusive, names its owner, and a stale lock is removed and retaken', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-opencode-lock-'));
  try {
    prepareStateDirectory(directory);
    // A live holder blocks any second contender and is named in the result.
    const first = acquireLock(directory, { pid: process.pid, startedAt: 1000 });
    assert.equal(first.acquired, true);
    assert.equal(readLockOwner(first.lockPath), process.pid);
    const blocked = acquireLock(directory, { pid: 4242, startedAt: 2000 });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.pid, process.pid);
    // A lock naming a dead process is stale: it is removed and the creation retried once.
    const gone = await deadPid();
    writeFileSync(join(directory, 'relay.lock'), `${JSON.stringify({ pid: gone, startedAt: 3 })}\n`);
    const taken = acquireLock(directory, { pid: 7, startedAt: 3000 });
    assert.equal(taken.acquired, true, 'a stale lock does not block the takeover');
    assert.equal(readLockOwner(taken.lockPath), 7);
    // A malformed lock is stale too.
    writeFileSync(join(directory, 'relay.lock'), 'not json\n');
    assert.equal(acquireLock(directory, { pid: 8, startedAt: 4000 }).acquired, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the token file is private, replaced per owner, and readable back', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-opencode-token-'));
  try {
    const first = writeToken(directory);
    assert.match(first.token, /^[0-9a-f]{64}$/);
    assert.equal(readToken(first.tokenPath), first.token);
    // The next owner replaces the token with a fresh secret.
    const second = writeToken(directory);
    assert.notEqual(second.token, first.token);
    assert.equal(readToken(second.tokenPath), second.token);
    const { statSync } = statModule;
    assert.equal(statSync(first.tokenPath).mode & 0o777, 0o600, 'the token is private to the account');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a second relay beside the owner serves standby descriptors and refuses its calls with the owner pid', async () => {
  const directory = makeTempDirectory('lcu-opencode-standby-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const ownerLog = captureLog();
      const standbyLog = captureLog();
      const owner = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: ownerLog, argv: RELAY_ARGV });
      const standby = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: standbyLog, argv: RELAY_ARGV });
      const host = await connectHost(standby);
      try {
        assert.equal(owner.role, 'owner');
        assert.equal(standby.role, 'standby');
        assert.equal(standby.socketPath, undefined, 'the standby serves no socket');
        assert.deepEqual(ownerLog.events[0], { event: 'relay_start', role: 'owner', pid: process.pid, lcu: FIXTURE_PATH });
        assert.deepEqual(standbyLog.events[0], { event: 'relay_start', role: 'standby', pid: process.pid, lcu: FIXTURE_PATH });
        const listed = await host.client.listTools();
        assert.deepEqual(listed.tools.map(tool => tool.name), ['js', 'js_reset']);
        assert.match(listed.tools[0].description, /standby/);
        // D3.1: an idle owner would yield to this caller, so the refusal scenario here is an
        // owner with no yield channel (its token file is gone): the takeover falls back to
        // the plain in-use error.
        rmSync(owner.tokenPath, { force: true });
        assert.equal((await host.client.callTool({ name: 'js', arguments: { code: 'x' }, _meta: sessionMeta('standby-session') })).isError, true);
        const refused = await host.client.callTool({ name: 'js', arguments: { code: 'x' }, _meta: sessionMeta('standby-session') });
        assert.match(refused.content[0].text,
          new RegExp(`^LCU is in use by another OpenCode session \\(owner pid ${process.pid}\\)\\. ` +
            'Switch to that OpenCode window or close it, then retry here\\.$'));
        assert.equal(standby.role, 'standby', 'the takeover was refused');
        assert.equal(readFixtureLog(logPath).length, 0, 'a standby refusal never reaches the upstream');
      } finally {
        await host.close();
        // The owner goes first so its cleanup cannot touch the standby's files; the standby
        // owns them now only after a takeover, which a later test covers.
        await owner.dispose('test end');
        await standby.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('a standby takes the lock over once the owner is gone and serves the call in the same request', async () => {
  const directory = makeTempDirectory('lcu-opencode-takeover-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const standbyLog = captureLog();
      const owner = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV });
      const standby = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: standbyLog, argv: RELAY_ARGV });
      const host = await connectHost(standby);
      try {
        // The owner "crashes": its lock file disappears without any cleanup.
        rmSync(owner.lockPath, { force: true });
        const result = await host.client.callTool({ name: 'js', arguments: { code: 'after-takeover' }, _meta: sessionMeta('resumed-session') });
        assert.notEqual(result.isError, true, 'the standby upgraded itself and served the call');
        assert.equal(standby.role, 'owner');
        assert.match(standby.socketPath, /relay\.sock$/);
        assert.ok(standbyLog.events.some(event =>
          event.event === 'relay_takeover' && Number.isFinite(event.waitedMs)));
        assert.ok(readToken(standby.tokenPath), 'a fresh token file exists');
        // The upgraded relay also owns the IPC surface.
        assert.deepEqual(await ipcRequest(standby.socketPath, { token: readToken(standby.tokenPath), type: 'ping' }),
          { ok: true, pid: process.pid, role: 'owner' });
        await waitFor(() => readFileSync(logPath, 'utf8'), text => text.includes('after-takeover'));
      } finally {
        await host.close();
        // The upgraded standby first (it owns the lock now), then the crashed owner's shell.
        await standby.dispose('test end');
        await owner.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});