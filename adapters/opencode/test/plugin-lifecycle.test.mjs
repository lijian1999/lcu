// Stage-2 tests for the LCU × OpenCode plugin: the pure event→IPC mapping and throttled
// warning discipline (plugin/lifecycle.ts), and the plugin wiring end-to-end against a fake
// relay owner socket (plugin/index.ts — importable because the plugin is zero-dependency).
// SPEC §4 stage 2 + the §1.8 event table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { defaultStateDirectory, eventToMessage, makeThrottledWarn } from '../plugin/lifecycle.ts';
import plugin, { ACK_TIMEOUT_MS, createPlugin, relayEndpoints } from '../plugin/index.ts';
import { makeTempDirectory, removeTempDirectory, waitFor } from './helpers.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Write a relay token file the way the owner does (0600, trailing newline). */
const writeTokenFile = (path, token) => writeFileSync(path, `${token}\n`, { mode: 0o600 });

const EVENT_TYPES = [
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.deleted',
];

const startOf = sessionId => ({ type: 'session.execution.started', data: { sessionID: sessionId } });

/**
 * A minimal relay owner the plugin can talk to: the token gate plus the bind/turn_ended/ping
 * acks of relay.mjs, with every parsed first line recorded. `reply: false` never answers, to
 * exercise the plugin's ack timeout.
 */
function startFakeOwner(socketPath, { token, reply = true } = {}) {
  const received = [];
  const server = createServer(socket => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      let message;
      try { message = JSON.parse(line); } catch { return; }
      received.push(message);
      if (!reply) return;
      const answer = message.token !== token ? { ok: false, error: 'invalid_token' }
        : message.type === 'bind' ? { ok: true, pid: process.pid }
        : message.type === 'turn_ended' ? { ok: true }
        : message.type === 'ping' ? { ok: true, pid: process.pid, role: 'owner' }
        : { ok: false, error: 'bad_request' };
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  return new Promise(resolve => {
    server.listen(socketPath, () => {
      resolve({
        received,
        close: () => new Promise(done => {
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

/**
 * A plugin context stand-in: event.subscribe returns a pushable async iterable that ends when
 * the subscription's signal aborts (like the real one), and tool.hook captures its handler
 * with a disposing registration.
 */
function fakePluginContext() {
  const subscriptions = [];
  const hooks = [];
  const streams = [];
  const ctx = {
    event: {
      subscribe(options) {
        const pending = [];
        const readers = [];
        let ended = false;
        options.signal.addEventListener('abort', () => {
          ended = true;
          for (const resolve of readers.splice(0)) resolve({ done: true });
        });
        streams.push({
          push(event) {
            const resolve = readers.shift();
            if (resolve) resolve({ value: event, done: false });
            else pending.push(event);
          },
        });
        subscriptions.push(options);
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                if (pending.length > 0) return Promise.resolve({ value: pending.shift(), done: false });
                if (ended) return Promise.resolve({ done: true });
                return new Promise(resolve => readers.push(resolve));
              },
            };
          },
        };
      },
    },
    tool: {
      async hook(name, handler) {
        const registration = {
          name, handler, disposed: false,
          dispose() { registration.disposed = true; },
        };
        hooks.push(registration);
        return registration;
      },
    },
  };
  return { ctx, subscriptions, hooks, streams };
}

/**
 * Open the plugin wiring against a fake owner inside `directory`. The plugin warns into a
 * collected array (returned as `warnings`) with a frozen clock, so failures stay silent in
 * the output and throttled to one per kind unless a test overrides `pluginOptions`.
 */
async function wiredPlugin(directory, { token, pluginOptions = {}, ownerOptions = {} } = {}) {
  const socketPath = join(directory, 'relay.sock');
  const tokenPath = join(directory, 'relay.token');
  if (token !== undefined) writeTokenFile(tokenPath, token);
  const owner = await startFakeOwner(socketPath, { token, ...ownerOptions });
  const fake = fakePluginContext();
  const warnings = [];
  const cleanup = await createPlugin(fake.ctx, {
    socketPath, tokenPath, now: () => 0, warn: message => warnings.push(message), ...pluginOptions,
  });
  return { owner, fake, cleanup, warnings, socketPath, tokenPath };
}

test('eventToMessage maps every lifecycle event of the §1.8 table onto its relay message', () => {
  assert.deepEqual(eventToMessage({ type: 'session.execution.started', data: { sessionID: 's1' } }),
    { type: 'bind', sessionID: 's1' });
  assert.deepEqual(eventToMessage({ type: 'session.execution.succeeded', data: { sessionID: 's1' } }),
    { type: 'turn_ended', sessionID: 's1', event: 'Stop' });
  for (const type of ['session.execution.failed', 'session.execution.interrupted', 'session.deleted']) {
    assert.deepEqual(eventToMessage({ type, data: { sessionID: 's1' } }),
      { type: 'turn_ended', sessionID: 's1', event: 'Interrupt' }, type);
  }
});

test('eventToMessage ignores unknown events and unusable session ids', () => {
  // Events the plugin does not consume, malformed events, and non-string session ids.
  for (const event of [
    { type: 'session.idle', data: { sessionID: 's1' } },
    { type: 'session.status', data: { sessionID: 's1', status: { type: 'busy' } } },
    { type: 'session.updated', data: { sessionID: 's1' } },
    { type: 'session.execution.started' },
    { type: 'session.execution.started', data: {} },
    { type: 'session.execution.started', data: { sessionID: 42 } },
    { type: 'session.execution.started', data: { sessionID: '' } },
    {},
    null,
    undefined,
  ]) {
    assert.equal(eventToMessage(event), null);
  }
});

test('defaultStateDirectory resolves like the relay singleton', () => {
  assert.equal(defaultStateDirectory({ env: { LCU_OPENCODE_STATE_DIR: '/tmp/state' }, home: '/home/me' }), '/tmp/state');
  assert.equal(defaultStateDirectory({ env: { LCU_OPENCODE_STATE_DIR: '' }, home: '/home/me' }),
    join('/home/me', '.local', 'state', 'lcu-opencode'));
  assert.equal(defaultStateDirectory({ env: {}, home: '/home/me' }),
    join('/home/me', '.local', 'state', 'lcu-opencode'));
});

test('makeThrottledWarn emits once per key per 60 s window', () => {
  let clock = 0;
  const emitted = [];
  const warn = makeThrottledWarn({ now: () => clock, warn: message => emitted.push(message) });
  warn('socket', 'first');
  warn('socket', 'second');
  warn('token', 'other kind');
  clock = 59_999;
  warn('socket', 'still inside the window');
  clock = 60_000;
  warn('socket', 'window passed');
  assert.deepEqual(emitted, ['first', 'other kind', 'window passed']);
});

test('the plugin entry exports the bare V2 plugin object with the relay endpoint contract', () => {
  assert.equal(plugin.id, 'lcu-opencode-plugin');
  assert.equal(typeof plugin.setup, 'function');
  assert.deepEqual(relayEndpoints('/state/dir'),
    { socketPath: '/state/dir/relay.sock', tokenPath: '/state/dir/relay.token' });
  assert.equal(ACK_TIMEOUT_MS, 1000);
});

test('the wiring maps a lifecycle event stream onto the exact IPC message sequence', async () => {
  const directory = makeTempDirectory('lcu-opencode-plugin-events-');
  try {
    const token = 'e2e-token';
    const { owner, fake, cleanup, warnings } = await wiredPlugin(directory, { token });
    try {
      // The subscription asks for exactly the five §1.8 event types and carries an AbortSignal.
      assert.equal(fake.subscriptions.length, 1);
      assert.deepEqual(fake.subscriptions[0].types, EVENT_TYPES);
      assert.ok(fake.subscriptions[0].signal instanceof AbortSignal);
      assert.equal(fake.hooks.length, 1);
      assert.equal(fake.hooks[0].name, 'execute.after');

      const push = event => fake.streams[0].push(event);
      push(startOf('sess-a'));
      push({ type: 'session.execution.succeeded', data: { sessionID: 'sess-a' } });
      push({ type: 'session.execution.failed', data: { sessionID: 'sess-b' } });
      push({ type: 'session.execution.interrupted', data: { sessionID: 'sess-c' } });
      push({ type: 'session.deleted', data: { sessionID: 'sess-d' } });
      // Shapes that must stay silent.
      push({ type: 'session.idle', data: { sessionID: 'sess-e' } });
      push({ type: 'session.status', data: { sessionID: 'sess-e' } });
      push({ type: 'session.execution.started', data: { sessionID: 42 } });
      push({ type: 'session.updated', data: { sessionID: 'sess-e' } });
      push({ type: 'session.execution.started' });

      await waitFor(() => owner.received.length, length => length === 5);
      assert.deepEqual(owner.received, [
        { token, type: 'bind', sessionID: 'sess-a' },
        { token, type: 'turn_ended', sessionID: 'sess-a', event: 'Stop' },
        { token, type: 'turn_ended', sessionID: 'sess-b', event: 'Interrupt' },
        { token, type: 'turn_ended', sessionID: 'sess-c', event: 'Interrupt' },
        { token, type: 'turn_ended', sessionID: 'sess-d', event: 'Interrupt' },
      ]);
      assert.equal(warnings.length, 0, 'a healthy relay produces no warnings');
    } finally {
      await cleanup();
      await owner.close();
    }
  } finally { removeTempDirectory(directory); }
});

test('the execute.after backstop re-binds lcu tool sessions whose started event was missed', async () => {
  const directory = makeTempDirectory('lcu-opencode-plugin-hook-');
  try {
    const token = 'hook-token';
    const { owner, fake, cleanup } = await wiredPlugin(directory, { token });
    try {
      const handler = fake.hooks[0].handler;
      // The hook event is flat: the tool name is `tool`, the session id is `sessionID`.
      await handler({ tool: 'lcu_js', sessionID: 'hook-1' });
      await handler({ tool: 'LCU__LCU__JS', sessionID: 'hook-2' });
      await handler({ tool: 'bash', sessionID: 'hook-3' });
      await handler({ tool: 'lcu_js' });
      await handler({ tool: 'lcu_js', sessionID: 'hook-1' });
      assert.deepEqual(owner.received, [
        { token, type: 'bind', sessionID: 'hook-1' },
        { token, type: 'bind', sessionID: 'hook-2' },
      ]);
      // A turn end clears the bookkeeping, so the next lcu call of that session re-binds.
      fake.streams[0].push({ type: 'session.execution.succeeded', data: { sessionID: 'hook-1' } });
      await waitFor(() => owner.received.length, length => length === 3);
      await handler({ tool: 'lcu_js', sessionID: 'hook-1' });
      assert.deepEqual(owner.received[3], { token, type: 'bind', sessionID: 'hook-1' });
      // And a fresh started event binds directly again.
      fake.streams[0].push(startOf('hook-4'));
      await waitFor(() => owner.received.length, length => length === 5);
      assert.deepEqual(owner.received[4], { token, type: 'bind', sessionID: 'hook-4' });
    } finally {
      await cleanup();
      await owner.close();
    }
  } finally { removeTempDirectory(directory); }
});

test('cleanup aborts the event subscription and disposes the tool hook', async () => {
  const directory = makeTempDirectory('lcu-opencode-plugin-cleanup-');
  try {
    const { owner, fake, cleanup } = await wiredPlugin(directory, { token: 'cleanup-token' });
    try {
      fake.streams[0].push(startOf('sess-x'));
      await waitFor(() => owner.received.length, length => length === 1);
      await cleanup();
      assert.equal(fake.hooks[0].disposed, true);
      fake.streams[0].push(startOf('sess-y'));
      await delay(50);
      assert.equal(owner.received.length, 1, 'nothing is sent after the cleanup ran');
    } finally {
      await owner.close();
    }
  } finally { removeTempDirectory(directory); }
});

test('a missing relay socket is skipped silently behind one throttled warning', async () => {
  const directory = makeTempDirectory('lcu-opencode-plugin-nosock-');
  try {
    let clock = 0;
    // The owner runs on relay.sock, but the plugin points at a path with no listener.
    const { owner, fake, cleanup, warnings } = await wiredPlugin(directory, {
      token: 'lonely-token',
      pluginOptions: { socketPath: join(directory, 'absent.sock'), now: () => clock },
    });
    try {
      fake.streams[0].push(startOf('sess-1'));
      fake.streams[0].push(startOf('sess-2'));
      fake.streams[0].push(startOf('sess-3'));
      await delay(100);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^\[lcu-opencode\] /);
      assert.equal(owner.received.length, 0, 'nothing reached the relay, which is not the target anyway');
      // After the quiet window the warning reopens on the next failure.
      clock += 60_000;
      fake.streams[0].push(startOf('sess-4'));
      await waitFor(() => warnings.length, length => length === 2);
    } finally {
      await cleanup();
      await owner.close();
    }
  } finally { removeTempDirectory(directory); }
});

test('a missing token file skips the send with a throttled warning', async () => {
  const directory = makeTempDirectory('lcu-opencode-plugin-notoken-');
  try {
    // token is left undefined: the owner starts, but the plugin's token file is never written.
    const { owner, fake, cleanup, warnings } = await wiredPlugin(directory, { ownerOptions: { token: 'owner-token' } });
    try {
      fake.streams[0].push(startOf('sess-1'));
      fake.streams[0].push({ type: 'session.execution.succeeded', data: { sessionID: 'sess-1' } });
      await waitFor(() => warnings.length, length => length === 1);
      assert.match(warnings[0], /^\[lcu-opencode\] /);
      assert.match(warnings[0], /token/);
      await delay(50);
      assert.equal(owner.received.length, 0, 'no message reaches the relay without a token');
      assert.equal(warnings.length, 1, 'the repeats inside the quiet window are dropped');
    } finally {
      await cleanup();
      await owner.close();
    }
  } finally { removeTempDirectory(directory); }
});

test('a token mismatch sends the file token verbatim and warns once per window', async () => {
  const directory = makeTempDirectory('lcu-opencode-plugin-token-');
  try {
    let clock = 0;
    // The plugin reads a stale token file while the owner expects the fresh one.
    const { owner, fake, cleanup, warnings } = await wiredPlugin(directory, {
      token: 'stale-token',
      ownerOptions: { token: 'fresh-token' },
      pluginOptions: { now: () => clock },
    });
    try {
      fake.streams[0].push(startOf('sess-1'));
      await waitFor(() => owner.received.length, length => length === 1);
      assert.equal(owner.received[0].token, 'stale-token', 'the plugin passes the token file content verbatim');
      await delay(50);
      assert.equal(warnings.length, 1, 'the invalid_token ack warns once');
      assert.match(warnings[0], /^\[lcu-opencode\] /);
      assert.match(warnings[0], /invalid_token/);
      // More events still go out (no suppression, no retry queue); the warning stays throttled.
      fake.streams[0].push(startOf('sess-2'));
      fake.streams[0].push(startOf('sess-3'));
      await waitFor(() => owner.received.length, length => length === 3);
      assert.equal(warnings.length, 1);
      clock += 60_000;
      fake.streams[0].push(startOf('sess-4'));
      await waitFor(() => warnings.length, length => length === 2);
      assert.equal(owner.received.length, 4);
    } finally {
      await cleanup();
      await owner.close();
    }
  } finally { removeTempDirectory(directory); }
});

test('a relay that never acks times out, warns once, and never blocks the stream', async () => {
  const directory = makeTempDirectory('lcu-opencode-plugin-timeout-');
  try {
    const { owner, fake, cleanup, warnings } = await wiredPlugin(directory, {
      token: 'quiet-token',
      ownerOptions: { reply: false },
      pluginOptions: { ackTimeoutMs: 25 },
    });
    try {
      fake.streams[0].push(startOf('sess-1'));
      await waitFor(() => warnings.length, length => length === 1, { timeoutMs: 2_000 });
      assert.match(warnings[0], /^\[lcu-opencode\] /);
      assert.match(warnings[0], /timed out/);
      fake.streams[0].push({ type: 'session.execution.succeeded', data: { sessionID: 'sess-1' } });
      await waitFor(() => owner.received.length, length => length === 2);
      assert.equal(warnings.length, 1, 'repeats inside the quiet window are dropped');
    } finally {
      await cleanup();
      await owner.close();
    }
  } finally { removeTempDirectory(directory); }
});