// Shared setup for the OpenCode relay tests: temporary directories under the system temp area
// (never the real HOME), a capturing fake diagnostic log, a test MCP host wired to a relay
// through the SDK's in-memory transport, and polling helpers for the upstream fixture's log.
// Every relay opened by these tests also gets LCU_DIAGNOSTIC_LOG=0 from the process env below,
// so nothing writes to the real per-user log directory even for a relay without an injected log.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LCU_DIAGNOSTIC_LOG = '0';

/** The fake upstream command the relay's `--lcu` points at in every test. */
export const FIXTURE_PATH = fileURLToPath(new URL('./upstream-fixture.mjs', import.meta.url));

/** The fixed relay argv tests inject, so the fallback session name is deterministic. */
export const RELAY_ARGV = ['node', 'relay.mjs', '--lcu', '/fixture/lcu'];

/** A fresh temp directory, preferring the workspace's pre-created temp area. */
export function makeTempDirectory(prefix) {
  const base = join(tmpdir(), 'opencode');
  const root = (() => {
    try { return statSync(base).isDirectory() ? base : tmpdir(); } catch { return tmpdir(); }
  })();
  return mkdtempSync(join(root, prefix));
}

/** A diagnostics-log stand-in that records events in memory instead of writing anywhere. */
export function captureLog() {
  const events = [];
  return {
    events,
    path: undefined,
    event(type, fields) {
      // Like the real diagnostic log: undefined fields and an `event` key are dropped.
      const clean = {};
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (value === undefined || key === 't' || key === 'event') continue;
        clean[key] = value;
      }
      events.push({ event: type, ...clean });
    },
  };
}

/** Connect a test MCP client (OpenCode's stand-in) to the relay's server in memory. */
export async function connectHost(relay) {
  const client = new Client({ name: 'opencode-test-host', version: '1' }, { capabilities: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([relay.server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: () => client.close().catch(() => {}) };
}

/** All JSON lines of a fixture log file, or [] when it does not exist yet. */
export function readFixtureLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Poll `read()` until `match(value)` holds; fails with the last value after `timeoutMs`. */
export async function waitFor(read, match, { timeoutMs = 10_000, message = 'condition not met' } = {}) {
  const started = Date.now();
  let value = await read();
  while (!match(value)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${message}; last value: ${JSON.stringify(value)?.slice(0, 2000)}`);
    }
    await delay(10);
    value = await read();
  }
  return value;
}

/** The first fixture-log entry matching `match`, waiting for it to appear. */
export function waitForEntry(logPath, match, options = {}) {
  return waitFor(
    () => readFixtureLog(logPath).find(match),
    entry => entry !== undefined,
    { message: 'fixture log entry did not appear', ...options },
  );
}

/** The session id a fixture js/js_reset entry ran for (from the turn metadata the relay sends). */
export const entrySession = entry => entry?.meta?.['x-codex-turn-metadata']?.session_id;

/** A UUID as the relay mints turn ids. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The `_meta` OpenCode sends with a tools/call for `sessionId`. */
export const sessionMeta = sessionId => ({ 'ai.opencode/sessionID': sessionId });

/** Remove a temp directory, best effort (tests call this in finally). */
export function removeTempDirectory(directory) {
  rmSync(directory, { recursive: true, force: true });
}

/** Save, set, and restore an environment variable around one test. */
export function withEnv(name, value, run) {
  const previous = process.env[name];
  process.env[name] = value;
  return Promise.resolve().then(run).finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}