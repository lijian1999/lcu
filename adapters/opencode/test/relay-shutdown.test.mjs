// Process exit: a real relay subprocess on stdio receives SIGTERM while a js call is in
// flight, drains its open turns with Interrupts upstream, and cleans up its files.
// SPEC §4 stage-1 item 10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  entrySession, FIXTURE_PATH, makeTempDirectory, readFixtureLog, removeTempDirectory,
  sessionMeta, waitFor, waitForEntry, withEnv,
} from './helpers.mjs';

const RELAY_PATH = fileURLToPath(new URL('../relay.mjs', import.meta.url));

/** A minimal newline-JSON MCP client for one relay subprocess. */
function startRelayProcess(directory, logPath) {
  const child = spawn(process.execPath, [RELAY_PATH, '--lcu', FIXTURE_PATH, '--state-dir', directory], {
    env: { ...process.env, LCU_OPENCODE_FIXTURE_LOG: logPath, LCU_DIAGNOSTIC_LOG: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  let nextId = 0;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle.resolve(message);
      }
    }
  });
  const request = (method, params, { timeoutMs = 15_000 } = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`relay request ${method} timed out; stderr: ${stderr.slice(-500)}`));
    }, timeoutMs);
    pending.set(id, { resolve: message => { clearTimeout(timer); resolve(message); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  });
  const notify = message => child.stdin.write(`${JSON.stringify(message)}\n`, () => {});
  const closed = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, request, notify, closed, stderr: () => stderr };
}

test('SIGTERM interrupts every open turn upstream, then exits cleanly', async () => {
  const directory = makeTempDirectory('lcu-opencode-sigterm-');
  const logPath = join(directory, 'fixture.jsonl');
  try {
    await withEnv('LCU_OPENCODE_FIXTURE_LOG', logPath, async () => {
      const relay = startRelayProcess(directory, logPath);
      try {
        const initialize = await relay.request('initialize', {
          protocolVersion: '2025-06-18', capabilities: {},
          clientInfo: { name: 'opencode-test-host', version: '1' },
        });
        assert.equal(initialize.result?.serverInfo?.name, 'lcu-opencode-relay');
        relay.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
        // An earlier finished call of another session left an open turn, drained too; the slow js
// call keeps a second open turn (and one in-flight call) when the signal lands.
        const idleResult = await relay.request('tools/call', {
          name: 'js', arguments: { code: 'quick' }, _meta: sessionMeta('idle-session'),
        });
        assert.notEqual(idleResult.result?.isError, true);
        const slowCall = relay.request('tools/call', {
          name: 'js', arguments: { code: 'sleep-3000' }, _meta: sessionMeta('drain-session'),
        });
        slowCall.catch(() => {}, 'the response never arrives; the drain must not wait for it');
        await waitForEntry(logPath, entry => entry.name === 'js' && entrySession(entry) === 'drain-session');
        process.kill(relay.child.pid, 'SIGTERM');
        const { code, signal } = await Promise.race([
          relay.closed,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('relay did not exit after SIGTERM')), 15_000)),
        ]);
        assert.equal(signal, null, `expected a clean exit, got signal ${signal}`);
        assert.equal(code, 0);
        // The fixture saw an Interrupt for each session with an open turn.
        const ended = await waitFor(() => readFixtureLog(logPath).filter(entry => entry.name === 'turn_ended'),
          entries => entries.length === 2);
        assert.deepEqual(ended.map(entry => [entry.args.hook_event_name, entry.args.session_id]).sort(),
          [['Interrupt', 'drain-session'], ['Interrupt', 'idle-session']]);
        // The singleton's files are gone.
        assert.equal(existsSync(join(directory, 'relay.lock')), false);
        assert.equal(existsSync(join(directory, 'relay.sock')), false);
        assert.equal(existsSync(join(directory, 'relay.token')), false);
      } finally {
        relay.child.kill('SIGKILL');
      }
    });
  } finally { removeTempDirectory(directory); }
});