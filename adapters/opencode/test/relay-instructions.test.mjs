// Instruction delivery parity with bare LCU registration: the owner connects its upstream
// eagerly so its initialize answer can carry the upstream's cua guide (OpenCode injects the
// instructions into the system prompt — the model's only complete source of the js API's
// shape), a standby inherits them from the owner over the token-gated IPC, and every failure
// degrades to the pre-instructions behavior in bounded time.
// SPEC §1.2 initialize (as amended by the 2026-11 instruction-delivery fix).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRelay } from '../relay.mjs';
import { ipcRequest } from '../ipc.mjs';
import { prepareStateDirectory, readToken } from '../singleton.mjs';
import {
  captureLog, connectHost, FIXTURE_PATH, makeTempDirectory, readFixtureLog, RELAY_ARGV,
  removeTempDirectory, sessionMeta, waitFor, withEnv,
} from './helpers.mjs';

const GUIDE = 'Fixture CUA initialization guide.';

// Distinct fake pids so the lock file and IPC replies can tell the in-process relays apart.
const OWNER_PID = 42001;
const STANDBY_PID = 42002;
const SUCCESSOR_PID = 42003;

/** Open an owner and a standby on one state directory, both with fake pids. */
async function openPair(directory, { slowStartMs } = {}) {
  return withEnv('LCU_OPENCODE_FIXTURE_SLOW_START_MS', slowStartMs === undefined ? undefined : String(slowStartMs),
    async () => {
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
      return { owner, standby, ownerLog, standbyLog };
    });
}

test('an owner initialize answer forwards the upstream instructions (eager connect)', async () => {
  const directory = makeTempDirectory('lcu-opencode-instr-owner-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const log = captureLog();
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log, argv: RELAY_ARGV });
      const host = await connectHost(relay);
      try {
        assert.equal(host.client.getInstructions() ?? '', GUIDE);
        const listed = await host.client.listTools();
        assert.deepEqual(listed.tools.map(tool => tool.name), ['js', 'js_reset']);
        assert.equal(listed.tools[0].description, 'Fixture JS description.');
        assert.ok(log.events.some(event => event.event === 'upstream_connect' && event.ok === true),
          'the owner connected its upstream eagerly, before any model call');
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('a slow upstream still delivers its instructions within the initialize budget', async () => {
  const directory = makeTempDirectory('lcu-opencode-instr-slow-');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_SLOW_START_MS', '400', async () => {
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV });
      const host = await connectHost(relay);
      try {
        // An instant '' would mean the answer did not wait for the slow connect.
        assert.equal(host.client.getInstructions() ?? '', GUIDE);
        assert.equal(relay.upstreamReady, true, 'the upstream connected while the initialize waited');
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('an instructions request waits for the owner\'s eager connect instead of degrading at once', async () => {
  const directory = makeTempDirectory('lcu-opencode-instr-wait-');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_SLOW_START_MS', '400', async () => {
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV });
      const token = readToken(relay.tokenPath);
      // The ask arrives while the slow upstream is still connecting; the guide in the reply
      // proves the owner waited for its connect rather than answering empty at once.
      const reply = await ipcRequest(relay.socketPath, { token, type: 'instructions' }, { timeoutMs: 15_000 });
      assert.deepEqual(reply, { ok: true, instructions: GUIDE });
      assert.equal(relay.upstreamReady, true);
      await relay.dispose('test end');
    });
  } finally { removeTempDirectory(directory); }
});

test('an unavailable upstream degrades the initialize answer and later calls still retry the connection', async () => {
  const directory = makeTempDirectory('lcu-opencode-instr-dead-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, () => withEnv('LCU_OPENCODE_FIXTURE_CRASH', '1', async () => {
      const log = captureLog();
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log, argv: RELAY_ARGV });
      const host = await connectHost(relay);
      try {
        const started = Date.now();
        assert.equal(host.client.getInstructions() ?? '', '', 'the dead upstream degrades to no instructions');
        assert.ok(Date.now() - started < 10_000, 'the initialize answer did not hang on the dead upstream');
        assert.ok(log.events.some(event => event.event === 'instructions_unavailable'),
          'the degrade is logged');
        // A later call builds a fresh client and retries the connection (the fixture crashes
        // again): a tool error, never a hang.
        const failed = await host.client.callTool({
          name: 'js', arguments: { code: 'x' }, _meta: sessionMeta('dead-session'),
        });
        assert.equal(failed.isError, true);
        assert.match(failed.content[0].text, /LCU could not be reached/);
        const crashes = await waitFor(() => readFixtureLog(logPath).filter(entry => entry.type === 'fixture-crash'),
          entries => entries.length >= 2, { message: 'the later call should have retried the connection' });
        assert.ok(crashes.length >= 2);
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    }));
  } finally { removeTempDirectory(directory); }
});

test('a standby initialize and tools/list inherit the owner\'s instructions and descriptors', async () => {
  const directory = makeTempDirectory('lcu-opencode-instr-standby-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const { owner, standby } = await openPair(directory);
      const host = await connectHost(standby);
      try {
        assert.equal(owner.role, 'owner');
        assert.equal(standby.role, 'standby');
        assert.equal(host.client.getInstructions() ?? '', GUIDE,
          'the standby forwards the owner\'s instructions at initialize');
        const listed = await host.client.listTools();
        assert.deepEqual(listed.tools.map(tool => tool.name), ['js', 'js_reset']);
        assert.equal(listed.tools[0].description, 'Fixture JS description.', 'not the standby descriptors');
        // The standby never started an upstream of its own: exactly one fixture process exists.
        assert.equal(readFixtureLog(logPath).filter(entry => entry.type === 'fixture-start').length, 1);
        // The answer is cached: with the owner's channel gone, a re-list still serves it.
        rmSync(owner.tokenPath, { force: true });
        const again = await host.client.listTools();
        assert.equal(again.tools[0].description, 'Fixture JS description.');
      } finally {
        await host.close();
        await owner.dispose('test end');
        await standby.dispose('test end');
      }
    });
  } finally { removeTempDirectory(directory); }
});

test('a standby with no owner degrades to empty instructions and the static descriptors', async () => {
  const directory = makeTempDirectory('lcu-opencode-instr-noowner-');
  try {
    prepareStateDirectory(directory);
    // A live lock holder makes this relay a standby, and no token or socket file exists.
    writeFileSync(join(directory, 'relay.lock'), `${JSON.stringify({ pid: process.pid, startedAt: 1 })}\n`);
    const standbyLog = captureLog();
    const standby = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: standbyLog, argv: RELAY_ARGV });
    const host = await connectHost(standby);
    try {
      assert.equal(standby.role, 'standby');
      const started = Date.now();
      assert.equal(host.client.getInstructions() ?? '', '');
      const listed = await host.client.listTools();
      assert.match(listed.tools[0].description, /standby/);
      assert.ok(Date.now() - started < 5_000, 'the degrade is immediate, not a hang');
      assert.ok(standbyLog.events.some(event => event.event === 'instructions_unavailable'),
        'the degraded initialize is logged');
      assert.equal(readFixtureLog(join(directory, 'fixture.jsonl')).length, 0,
        'no upstream was ever started for the absent runtime');
    } finally {
      await host.close();
      await standby.dispose('test end');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an owner that cannot connect answers a standby honestly and its tools ask fails closed', async () => {
  const directory = makeTempDirectory('lcu-opencode-instr-deadowner-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, () => withEnv('LCU_OPENCODE_FIXTURE_CRASH', '1', async () => {
      const owner = await createRelay({
        lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV,
        pid: OWNER_PID, alive: () => true,
      });
      const standby = await createRelay({
        lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV,
        pid: STANDBY_PID, alive: () => true,
      });
      const host = await connectHost(standby);
      try {
        // The owner's upstream connect failed fast, so its instructions answer arrives at
        // once and honestly empty; the tools ask reports the owner not ready.
        assert.equal(host.client.getInstructions() ?? '', '');
        const listed = await host.client.listTools();
        assert.match(listed.tools[0].description, /standby/);
        assert.equal(readFixtureLog(logPath).filter(entry => entry.name === 'js').length, 0);
      } finally {
        await host.close();
        await owner.dispose('test end');
        await standby.dispose('test end');
      }
    }));
  } finally { removeTempDirectory(directory); }
});

test('an instructions request that lands on a yielding owner is retried against its successor', async () => {
  const directory = makeTempDirectory('lcu-opencode-instr-race-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, () =>
      // The owner starts with a slow upstream so its instructions answer pends, and the
      // yield below lands mid-wait — the production race window.
      withEnv('LCU_OPENCODE_FIXTURE_SLOW_START_MS', '800', async () => {
        const owner = await createRelay({
          lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV,
          pid: OWNER_PID, alive: () => true,
        });
        const standby = await createRelay({
          lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV,
          pid: STANDBY_PID, alive: () => true,
        });
        const hostPromise = connectHost(standby); // its initialize ask pends on the owner below
        const ownerSocket = owner.socketPath;
        const token = readToken(owner.tokenPath);
        // Let the standby's ask reach the owner and start waiting on its slow connect, so
        // the yield lands mid-wait and the reply is `not_owner` (not a refused connection).
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.deepEqual(await ipcRequest(ownerSocket, { token, type: 'yield' }), { ok: true });
        assert.equal(owner.role, 'standby');
        // The successor takes over (with a fast upstream) while the standby's first attempt
        // is still pending on the stepped-down owner.
        const successor = await withEnv('LCU_OPENCODE_FIXTURE_SLOW_START_MS', '0', async () => {
          const relay = await createRelay({
            lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV,
            pid: SUCCESSOR_PID, alive: () => true,
          });
          await waitFor(() => ({ role: relay.role, socket: relay.socketPath }),
            state => state.role === 'owner' && state.socket !== undefined,
            { message: 'the successor never finished its takeover' });
          return relay;
        });
        const host = await hostPromise;
        try {
          assert.equal(successor.role, 'owner');
          assert.equal(standby.role, 'standby');
          assert.equal(host.client.getInstructions() ?? '', GUIDE,
            'the retried ask re-read the token and reached the new owner');
          const listed = await host.client.listTools();
          assert.equal(listed.tools[0].description, 'Fixture JS description.',
            'the tools ask reached the new owner too');
        } finally {
          await host.close();
          await successor.dispose('test end');
          await standby.dispose('test end');
          await owner.dispose('test end');
        }
      }));
  } finally { removeTempDirectory(directory); }
});

test('a yield during the eager connect leaves no zombie ready state and no orphan upstream', async () => {
  const directory = makeTempDirectory('lcu-opencode-instr-zombie-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, () => withEnv('LCU_OPENCODE_FIXTURE_SLOW_START_MS', '500', async () => {
      const relay = await createRelay({ lcuPath: FIXTURE_PATH, stateDir: directory, log: captureLog(), argv: RELAY_ARGV });
      const token = readToken(relay.tokenPath);
      // The eager connect is still running; the step-down must invalidate it.
      assert.deepEqual(await ipcRequest(relay.socketPath, { token, type: 'yield' }), { ok: true });
      assert.equal(relay.role, 'standby');
      assert.equal(relay.upstreamReady, false, 'the step-down is not a ready state');
      // The superseded child comes up, sees the stale epoch, and closes itself.
      await waitFor(() => readFixtureLog(logPath).filter(entry => entry.type === 'fixture-exit'),
        exits => exits.length === 1, { timeoutMs: 10_000, message: 'the superseded upstream child never closed' });
      assert.equal(relay.upstreamReady, false, 'still not ready after the stale connect settled');
      // The relay is a working standby: its call takes the runtime over and is served — a
      // zombie ready would have handed the call a closed client.
      const host = await connectHost(relay);
      try {
        const served = await host.client.callTool({
          name: 'js', arguments: { code: 'after-yield' }, _meta: sessionMeta('zombie-session'),
        });
        assert.notEqual(served.isError, true);
        assert.equal(relay.role, 'owner');
        const starts = readFixtureLog(logPath).filter(entry => entry.type === 'fixture-start');
        assert.equal(starts.length, 2, 'the takeover connected a fresh upstream');
      } finally {
        await host.close();
        await relay.dispose('test end');
      }
    }));
  } finally { removeTempDirectory(directory); }
});