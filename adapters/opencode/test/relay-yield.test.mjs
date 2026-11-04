// The D3.1 idle-owner yield: a standby whose lock attempt finds a live owner asks it to step
// down over the token-gated socket; an idle owner ends its open turns upstream, closes its
// upstream and IPC surface, and releases the lock so the caller takes over in the same
// request — while an owner with a call in flight refuses with `busy` and keeps the runtime.
// Design D3.1; extends SPEC §4 stage-1 item 8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRelay } from '../relay.mjs';
import { ipcRequest } from '../ipc.mjs';
import { prepareStateDirectory, readLockOwner, readToken, writeToken } from '../singleton.mjs';
import {
  captureLog, connectHost, entrySession, FIXTURE_PATH, LISTED_JS_DESCRIPTION, makeTempDirectory, readFixtureLog,
  RELAY_ARGV, removeTempDirectory, sessionMeta, waitFor, waitForEntry, withEnv,
} from './helpers.mjs';

// Distinct fake pids so the lock file and IPC replies can tell the two in-process relays
// apart; `alive` must accept them or acquireLock would treat the lock as stale.
const OWNER_PID = 41001;
const STANDBY_PID = 41002;

/** Two relays on one state directory (owner first), each with its own connected host. */
async function openPair(directory) {
  const ownerLog = captureLog();
  const standbyLog = captureLog();
  const owner = await createRelay({
    lcuPath: FIXTURE_PATH, stateDir: directory, log: ownerLog, argv: RELAY_ARGV,
    pid: OWNER_PID, alive: () => true,
  });
  const standby = await createRelay({
    lcuPath: FIXTURE_PATH, stateDir: directory, log: standbyLog, argv: RELAY_ARGV,
    pid: STANDBY_PID, alive: () => true,
  });
  const ownerHost = await connectHost(owner);
  const standbyHost = await connectHost(standby);
  return { owner, standby, ownerLog, standbyLog, ownerHost, standbyHost };
}

/** Close both hosts and dispose both relays of a pair; the lock gate makes the order safe. */
async function closePair(pair) {
  await pair.ownerHost.close();
  await pair.standbyHost.close();
  await pair.standby.dispose('test end');
  await pair.owner.dispose('test end');
}

const turnEnds = (logPath, sessionId) => readFixtureLog(logPath)
  .filter(entry => entry.name === 'turn_ended' && entry.args?.session_id === sessionId);

/** Kill a spawned process once, then wait for its exit (a second kill would wait forever). */
async function killProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit').catch(() => {});
}

const IN_USE = pid => new RegExp(`^LCU is in use by another OpenCode session \\(owner pid ${pid}\\)\\. ` +
  'Switch to that OpenCode window or close it, then retry here\\.$');

test('an idle owner yields to a standby caller: the open turn is interrupted and the caller is served', async () => {
  const directory = makeTempDirectory('lcu-opencode-yield-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const pair = await openPair(directory);
      try {
        assert.equal(pair.owner.role, 'owner');
        assert.equal(pair.standby.role, 'standby');
        // The owner's finished call leaves an open turn upstream; the yield must end it.
        await pair.ownerHost.client.callTool({ name: 'js', arguments: { code: 'warm' }, _meta: sessionMeta('home-session') });
        const firstTurn = await waitForEntry(logPath,
          entry => entry.name === 'js' && entrySession(entry) === 'home-session');

        const served = await pair.standbyHost.client.callTool({
          name: 'js', arguments: { code: 'real-work' }, _meta: sessionMeta('work-session'),
        });
        assert.notEqual(served.isError, true, 'the standby took over and served the call in the same request');
        assert.equal(pair.standby.role, 'owner');
        assert.equal(pair.owner.role, 'standby');
        assert.equal(pair.owner.socketPath, undefined, 'the stepped-down owner serves no socket');
        const interrupted = await waitFor(() => turnEnds(logPath, 'home-session'), entries => entries.length === 1);
        assert.deepEqual(interrupted[0].args, {
          hook_event_name: 'Interrupt', session_id: 'home-session',
          turn_id: firstTurn.meta['x-codex-turn-metadata'].turn_id,
        });
        assert.ok(pair.ownerLog.events.some(event => event.event === 'relay_yield' && event.openTurns === 1),
          'the step-down is logged with the number of drained open turns');
        assert.ok(pair.standbyLog.events.some(event => event.event === 'relay_takeover'));
        assert.deepEqual(pair.owner.sessions.openTurns(), [], 'no open turn survives the closed upstream');

        // The old owner's OpenCode connection still works: its next call re-takes over from
        // the now-idle new owner (the same yield path in reverse), so both roles flip back.
        const backHome = await pair.ownerHost.client.callTool({
          name: 'js', arguments: { code: 'home-work' }, _meta: sessionMeta('home-session-2'),
        });
        assert.notEqual(backHome.isError, true, 'the stepped-down relay takes the runtime back when its session works');
        assert.equal(pair.owner.role, 'owner');
        assert.equal(pair.standby.role, 'standby');
        const backInterrupt = await waitFor(() => turnEnds(logPath, 'work-session'), entries => entries.length === 1);
        assert.equal(backInterrupt[0].args.hook_event_name, 'Interrupt', 'the new owner drained its open turn on yield');
      } finally {
        await closePair(pair);
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('an owner with a call in flight refuses the yield, then yields once its call is done', async () => {
  const directory = makeTempDirectory('lcu-opencode-yield-busy-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const pair = await openPair(directory);
      try {
        const busyCall = pair.ownerHost.client.callTool({
          name: 'js', arguments: { code: 'sleep-700' }, _meta: sessionMeta('busy-session'),
        });
        await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === 'busy-session');
        const refused = await pair.standbyHost.client.callTool({
          name: 'js', arguments: { code: 'want-runtime' }, _meta: sessionMeta('waiting-session'),
        });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, IN_USE(OWNER_PID));
        assert.equal(pair.owner.role, 'owner', 'a busy owner keeps the runtime');
        assert.equal(pair.standby.role, 'standby');
        assert.equal(pair.ownerLog.events.some(event => event.event === 'relay_yield'), false,
          'no yield happened while the call was in flight');
        assert.equal(turnEnds(logPath, 'busy-session').length, 0, 'the busy turn was not interrupted');

        // The owner's call finishes; the standby's next call yields the idle owner and wins.
        assert.equal((await busyCall).isError, undefined);
        const served = await pair.standbyHost.client.callTool({
          name: 'js', arguments: { code: 'now-mine' }, _meta: sessionMeta('waiting-session'),
        });
        assert.notEqual(served.isError, true);
        assert.equal(pair.standby.role, 'owner');
        assert.equal(pair.owner.role, 'standby');
        const interrupted = await waitFor(() => turnEnds(logPath, 'busy-session'), entries => entries.length === 1);
        assert.equal(interrupted[0].args.hook_event_name, 'Interrupt',
          'the drained open turn of the finished call is interrupted at the yield');
      } finally {
        await closePair(pair);
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('a yield message reaches only an owner: a standby answers not_owner', async () => {
  const directory = makeTempDirectory('lcu-opencode-yield-idle-');
  try {
    const pair = await openPair(directory);
    try {
      // A standby does not listen on the socket, so this seam is the only way a yield can
      // reach one; it is the race window reply (an owner mid-step-down) for real senders.
      assert.deepEqual(await pair.standby.handleIpcMessage({ type: 'yield' }), { ok: false, error: 'not_owner' });
      assert.equal(pair.owner.role, 'owner');
      assert.equal(pair.standby.role, 'standby');
    } finally {
      await closePair(pair);
    }
  } finally { removeTempDirectory(directory); }
});

test('a yield carrying a wrong token is refused by the gate and the standby reports in-use', async () => {
  const directory = makeTempDirectory('lcu-opencode-yield-token-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const pair = await openPair(directory);
      try {
        const realToken = readToken(pair.standby.tokenPath);
        // The standby reads the owner's token file before asking; a tampered file means the
        // yield attempt presents a wrong token and the owner's gate refuses it.
        writeFileSync(pair.standby.tokenPath, `${'0'.repeat(64)}\n`);
        const refused = await pair.standbyHost.client.callTool({
          name: 'js', arguments: { code: 'x' }, _meta: sessionMeta('token-session'),
        });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, IN_USE(OWNER_PID));
        assert.equal(pair.owner.role, 'owner');
        assert.equal(pair.standby.role, 'standby');
        assert.deepEqual(await ipcRequest(pair.owner.socketPath, { token: realToken, type: 'ping' }),
          { ok: true, pid: OWNER_PID, role: 'owner' }, 'the owner is unharmed and still serving IPC');
      } finally {
        await closePair(pair);
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('after a yield the lock, token, and socket belong to the new owner', async () => {
  const directory = makeTempDirectory('lcu-opencode-yield-files-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const pair = await openPair(directory);
      try {
        // A never-called owner (the idle home-project relay of the production incident); its
        // eager upstream connect may have started the fixture, but no model call reached it.
        assert.equal(readFixtureLog(logPath).filter(entry => entry.name === 'js' || entry.name === 'turn_ended').length, 0);
        const served = await pair.standbyHost.client.callTool({
          name: 'js', arguments: { code: 'take-it' }, _meta: sessionMeta('files-session'),
        });
        assert.notEqual(served.isError, true);
        assert.equal(readLockOwner(pair.owner.lockPath), STANDBY_PID, 'the lock names the new owner');
        assert.equal(readLockOwner(pair.owner.lockPath), readLockOwner(pair.standby.lockPath));
        assert.equal(pair.owner.socketPath, undefined, 'the old owner exposes no socket path');
        assert.match(pair.standby.socketPath, /relay\.sock$/);
        assert.deepEqual(await ipcRequest(pair.standby.socketPath, { token: readToken(pair.standby.tokenPath), type: 'ping' }),
          { ok: true, pid: STANDBY_PID, role: 'owner' });
        assert.notEqual(readToken(pair.standby.tokenPath), undefined, 'a fresh token file exists');
        const listed = await pair.ownerHost.client.listTools();
        assert.equal(listed.tools[0].description, LISTED_JS_DESCRIPTION,
          'the stepped-down relay inherits the new owner\'s descriptors');
      } finally {
        await closePair(pair);
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('two standbys contending for a yielding owner are arbitrated by the lock', async () => {
  const directory = makeTempDirectory('lcu-opencode-yield-race-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const owner = await createRelay({
        lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV,
        pid: OWNER_PID, alive: () => true,
      });
      const first = await createRelay({
        lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV,
        pid: 41003, alive: () => true,
      });
      const second = await createRelay({
        lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV,
        pid: 41004, alive: () => true,
      });
      const ownerHost = await connectHost(owner);
      const firstHost = await connectHost(first);
      const secondHost = await connectHost(second);
      try {
        // Both standbys call at once: both ask the idle owner to yield, and the O_EXCL lock
        // elects exactly one of them; the other reports the plain in-use error and waits.
        const [firstResult, secondResult] = await Promise.all([
          firstHost.client.callTool({ name: 'js', arguments: { code: 'first-contender' }, _meta: sessionMeta('contender-1') }),
          secondHost.client.callTool({ name: 'js', arguments: { code: 'second-contender' }, _meta: sessionMeta('contender-2') }),
        ]);
        const outcomes = [firstResult, secondResult]
          .map(result => (result.isError === true ? 'refused' : 'served')).sort();
        assert.deepEqual(outcomes, ['refused', 'served'], 'exactly one contender wins the runtime');
        assert.equal([owner, first, second].filter(relay => relay.role === 'owner').length, 1);
        const refused = firstResult.isError === true ? firstResult : secondResult;
        assert.match(refused.content[0].text,
          /^LCU is in use by another OpenCode session \(owner pid \d+\)\. Switch to that OpenCode window or close it, then retry here\.$/);
        assert.equal(turnEnds(logPath, 'contender-1').length + turnEnds(logPath, 'contender-2').length, 0,
          'no contender had an open turn yet, so the yield drained nothing');
      } finally {
        await ownerHost.close();
        await firstHost.close();
        await secondHost.close();
        // The lock gate makes the disposal order safe whichever relay owns the lock now.
        await second.dispose('test end');
        await first.dispose('test end');
        await owner.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('an unresponsive owner keeps the lock until it dies; then the stale lock is cleared', async () => {
  const directory = makeTempDirectory('lcu-opencode-yield-stale-');
  const logPath = join(directory, 'fixture.jsonl');
  const sockPath = join(directory, 'relay.sock');
  // A live process holding the lock whose socket accepts but never replies.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)']);
  const blocker = createServer(socket => { socket.on('error', () => {}); });
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      prepareStateDirectory(directory);
      writeFileSync(join(directory, 'relay.lock'), `${JSON.stringify({ pid: holder.pid, startedAt: 1 })}\n`);
      writeToken(directory);
      blocker.listen(sockPath);
      await once(blocker, 'listening');
      const standbyLog = captureLog();
      const standby = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: standbyLog, argv: RELAY_ARGV });
      // A silent owner must not stall the standby's initialize ask, so the channel files are
      // out of the way for it; the yield attempt below restores and uses them.
      rmSync(join(directory, 'relay.token'), { force: true });
      const host = await connectHost(standby);
      writeToken(directory);
      try {
        assert.equal(standby.role, 'standby');
        const refused = await host.client.callTool({ name: 'js', arguments: { code: 'x' }, _meta: sessionMeta('stale-session') });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, IN_USE(holder.pid), 'a live but silent owner is reported as in-use');
        assert.equal(standby.role, 'standby');
        assert.equal(readFixtureLog(logPath).length, 0);
        // The holder dies: the same standby's next call finds the lock stale (the recorded
        // pid is gone), clears it, and takes over — still within that one call.
        blocker.close();
        blocker.closeAllConnections?.();
        await killProcess(holder);
        const served = await host.client.callTool({ name: 'js', arguments: { code: 'after-death' }, _meta: sessionMeta('stale-session') });
        assert.notEqual(served.isError, true, 'the stale lock of the dead holder is removed and retaken');
        assert.equal(standby.role, 'owner');
        assert.equal(readLockOwner(standby.lockPath), process.pid);
        assert.equal(existsSync(standby.socketPath), true);
        const entry = await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === 'stale-session');
        assert.equal(entry.args.code, 'after-death');
      } finally {
        await host.close();
        await standby.dispose('test end');
      }
    });
  } finally {
    blocker.close();
    blocker.closeAllConnections?.();
    await killProcess(holder);
    removeTempDirectory(directory);
  }
});