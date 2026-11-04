// LCU × OpenCode relay: a stdio MCP server that OpenCode starts as `mcp.lcu` and that stands
// between OpenCode's model and the installed LCU. It exposes exactly js/js_reset to the model,
// drives the LCU runtime through the shared CUA client (`../client.mjs`), owns turn identity
// (OpenCode gives the session id, the relay mints a turn UUID per prompt round), refuses a
// second session while one is using the runtime, answers approval elicitations itself (accept,
// except when the host guard in the client refuses an agent-hosting app), and ends turns when
// the OpenCode lifecycle plugin reports bind/turn_ended over a private token-gated Unix socket.
// It is a per-state-directory singleton: the first relay wins and owns the socket, later ones
// serve static standby descriptors and try to take the lock over on each call. This file does
// not install anything, does not run `lcu setup`, and never writes tool arguments or results
// to the diagnostic log.
import { createHash, randomUUID as defaultRandomUUID } from 'node:crypto';
import { accessSync, constants, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createCuaClient, isMainModule, MODEL_TOOLS, TURN_CLEANUP_TIMEOUT_CODE } from '../client.mjs';
import { openDiagnosticLog } from '../diagnostics.mjs';
import { startIpcServer } from './ipc.mjs';
import { createSessions } from './sessions.mjs';
import {
  acquireLock, defaultLcuPath, defaultStateDirectory, lockOwnedBy, LOCK_NAME, pidAlive,
  prepareStateDirectory, SOCKET_NAME, TOKEN_NAME, writeToken,
} from './singleton.mjs';

/** Every session's open turn gets this long, together, to end upstream before the relay exits. */
export const DRAIN_BUDGET_MS = 2_000;

const SERVER_INFO = { name: 'lcu-opencode-relay', version: '0.1.0' };
const SESSION_ID_META = 'ai.opencode/sessionID';
const STANDBY_SUFFIX = ' (LCU relay standby: calls are refused while another OpenCode session owns the runtime).';

/** The static tool list a standby relay shows; the descriptions tell the model why calls fail. */
export const STANDBY_TOOLS = [
  {
    name: 'js',
    description: `Run JavaScript with the cua_repl computer-use API${STANDBY_SUFFIX}`,
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, timeout_ms: { type: 'integer' } },
      required: ['code'],
    },
  },
  {
    name: 'js_reset',
    description: `Reset the cua_repl JavaScript kernel${STANDBY_SUFFIX}`,
    inputSchema: { type: 'object' },
  },
];

/** `node relay.mjs [--lcu <path>] [--state-dir <dir>]` — unknown arguments are refused. */
export function parseRelayArgs(argv = []) {
  const options = {};
  const inlineValue = (arg, name) =>
    arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--lcu' || arg === '--state-dir') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || !value) throw new Error(`relay option ${arg} needs a value`);
      if (arg === '--lcu') options.lcuPath = value; else options.stateDir = value;
      index += 1;
      continue;
    }
    const inline = inlineValue(arg, '--lcu') ?? inlineValue(arg, '--state-dir');
    if (inline !== undefined) {
      if (arg.startsWith('--lcu=')) options.lcuPath = inline; else options.stateDir = inline;
      continue;
    }
    throw new Error(`Unknown relay argument: ${arg}`);
  }
  return options;
}

/** A stable per-connection session name for OpenCode calls that carry no session id. */
export function fallbackIdentity(argv = process.argv) {
  const digest = createHash('sha1').update(argv.join('\0')).digest('hex');
  return `opencode-conn-${digest.slice(0, 8)}`;
}

const asText = error => (error instanceof Error ? error.message : String(error));
const errorResult = text => ({ isError: true, content: [{ type: 'text', text }] });

/** The v0.4 approval policy: accept every elicitation the client's guard let through, log the metadata. */
export function createApprovalPolicy(log) {
  return async params => {
    const meta = params?._meta ?? {};
    const app = meta?.tool_params?.app;
    log.event('approval_auto_accepted', {
      app: typeof app === 'string' ? app : undefined,
      connector: meta?.connector_id,
      risk: meta?.riskLevel,
      tool: meta?.tool_name,
      persist_offered: Array.isArray(meta?.persist) ? meta.persist.join(',') : undefined,
    });
    return { action: 'accept', content: {} };
  };
}

/** Reject the tool call with the SDK's InvalidParams error when OpenCode calls another tool. */
function unknownTool(name) {
  return new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}. This relay exposes only js and js_reset.`);
}

/**
 * Build the relay. Returns the MCP `Server` (connect a transport to serve OpenCode) plus
 * control handles; it does not touch process signals — `main` does that, tests call `dispose`.
 * Injectable for tests: `log` (a diagnostics-like object), `env`, `argv`, `pid`, `randomUUID`,
 * `alive` (the liveness check for lock takeover). The upstream LCU process starts lazily.
 */
export async function createRelay({
  lcuPath = defaultLcuPath(),
  stateDir = defaultStateDirectory(),
  log = openDiagnosticLog({ adapter: 'opencode' }),
  env = process.env,
  argv = process.argv,
  pid = process.pid,
  randomUUID = defaultRandomUUID,
  alive = pidAlive,
} = {}) {
  accessSync(lcuPath, constants.X_OK);
  prepareStateDirectory(stateDir);
  const startedAt = Date.now();
  const sessions = createSessions({ randomUUID });
  const fallbackSession = fallbackIdentity(argv);
  const socketPath = `${stateDir}/${SOCKET_NAME}`;
  const identityMode = env.LCU_OPENCODE_IDENTITY === 'strict' ? 'strict' : 'fallback';

  const election = acquireLock(stateDir, { pid, startedAt, alive });
  let role = election.acquired ? 'owner' : 'standby';
  let ownerPid = election.acquired ? pid : election.pid;
  log.event('relay_start', { role, pid, lcu: lcuPath });

  // The upstream LCU client, connected lazily on the first tools/list or tools/call.
  let upstream;
  let upstreamReady = false;
  let connecting;
  // Owner-only services: the lifecycle IPC server.
  let ipc;

  const approvalPolicy = createApprovalPolicy(log);

  function ensureUpstream() {
    if (upstreamReady) return upstream;
    if (!connecting) {
      connecting = (async () => {
        try {
          upstream ??= createCuaClient({ command: [lcuPath], adapter: 'opencode', log, onElicitation: approvalPolicy });
          await upstream.connect();
          upstreamReady = true;
          return upstream;
        } catch {
          log.event('upstream_unavailable', {});
          throw new Error('LCU could not be reached. Check that LCU is installed and try `lcu doctor`; ' +
            'then restart OpenCode and retry.');
        } finally {
          connecting = undefined;
        }
      })();
    }
    return connecting;
  }

  /**
   * End one open turn upstream. The host's cleanup timeout is a success for the relay (the
   * worker keeps cleaning up in the background); any other failure is rethrown for the caller
   * to record as a pending end.
   */
  async function endTurn(sessionId, turnId, event) {
    if (!upstreamReady) return 'ignored';
    try {
      await upstream.turnEnded({ sessionId, turnId, event });
      return 'ok';
    } catch (error) {
      if (error?.code === TURN_CLEANUP_TIMEOUT_CODE) {
        log.event('turn_end', { outcome: 'cleanup_timeout', session: sessionId, hook_event: event });
        return 'cleanup_timeout';
      }
      throw error;
    }
  }

  /** Record a turn end the upstream refused, to be retried before the session's next call. */
  function deferTurnEnd(state, sessionId, turnId, event) {
    state.pendingEnd = { turnId, event };
    log.event('turn_end_deferred', { session: sessionId, event });
    return { ok: false, error: 'turn_end_failed' };
  }

  /** IPC `bind`: a new prompt round started; the session's open turn ends (Interrupt when busy). */
  async function onBind(sessionId) {
    const state = sessions.lookup(sessionId);
    if (!state?.open) return { ok: true, pid };
    const event = state.inFlight > 0 ? 'Interrupt' : 'Stop';
    const turnId = state.turnId;
    sessions.endTurn(sessionId);
    try {
      await endTurn(sessionId, turnId, event);
      return { ok: true, pid };
    } catch {
      return deferTurnEnd(state, sessionId, turnId, event);
    }
  }

  /** IPC `turn_ended`: the OpenCode session finished (or was interrupted); end its open turn. */
  async function onTurnEnded(sessionId, event) {
    const state = sessions.lookup(sessionId);
    if (!state?.open) return { ok: true };
    const effective = state.inFlight > 0 || event === 'Interrupt' ? 'Interrupt' : 'Stop';
    const turnId = state.turnId;
    sessions.endTurn(sessionId);
    try {
      await endTurn(sessionId, turnId, effective);
      return { ok: true };
    } catch {
      return deferTurnEnd(state, sessionId, turnId, effective);
    }
  }

  const handleIpcMessage = async message => {
    switch (message.type) {
      case 'ping': return { ok: true, pid, role: 'owner' };
      case 'bind':
        if (typeof message.sessionID !== 'string' || !message.sessionID) break;
        return onBind(message.sessionID);
      case 'turn_ended':
        if (typeof message.sessionID !== 'string' || !message.sessionID) break;
        if (message.event !== undefined && message.event !== 'Stop' && message.event !== 'Interrupt') break;
        return onTurnEnded(message.sessionID, message.event);
    }
    return { ok: false, error: 'bad_request' };
  };

  async function startOwnerServices() {
    try {
      const { token } = writeToken(stateDir);
      ipc = await startIpcServer({ socketPath, token, handle: handleIpcMessage });
    } catch {
      log.event('ipc_start_failed', {});
    }
  }

  if (role === 'owner') await startOwnerServices();

  /** A standby relay tries the lock again per call and, when it wins, upgrades in place. */
  async function takeOver() {
    if (role === 'owner') return true;
    const election = acquireLock(stateDir, { pid, alive });
    if (!election.acquired) {
      ownerPid = election.pid;
      return false;
    }
    role = 'owner';
    log.event('relay_takeover', { waitedMs: Date.now() - startedAt });
    await startOwnerServices();
    return true;
  }

  /** Identity, mutex, pending-end retry, and turn bookkeeping shared by js and js_reset. */
  async function handleModelCall(name, args, meta, signal) {
    const metaSession = typeof meta?.[SESSION_ID_META] === 'string' && meta[SESSION_ID_META]
      ? meta[SESSION_ID_META] : undefined;
    if (metaSession === undefined && identityMode === 'strict') {
      log.event('identity_refused', { tool: name });
      return errorResult('identity_refused: OpenCode did not provide a session id ' +
        '(_meta.ai.opencode/sessionID missing)');
    }
    const sessionId = metaSession ?? fallbackSession;
    log.event('identity', { source: metaSession === undefined ? 'fallback' : 'meta', sessionID: sessionId });

    const admission = sessions.admit(sessionId);
    if (!admission.ok) {
      log.event('session_busy', { session: sessionId, other: admission.other });
      return errorResult(`LCU is in use by another session (${admission.other}). ` +
        'Wait for it to finish or switch to that OpenCode session.');
    }
    if (admission.switched) log.event('session_switch', { from: admission.from, to: sessionId });

    const finishCall = sessions.beginCall(sessionId);
    try {
      await ensureUpstream();
      const state = sessions.stateOf(sessionId);
      if (state.pendingEnd) {
        state.pendingRetry ??= (async () => {
          try {
            await endTurn(sessionId, state.pendingEnd.turnId, state.pendingEnd.event);
            state.pendingEnd = undefined;
          } finally {
            state.pendingRetry = undefined;
          }
        })();
        try {
          await state.pendingRetry;
        } catch {
          return errorResult('LCU is still finishing the previous turn. Try again in a few seconds.');
        }
      }
      const turnId = sessions.openTurn(sessionId);
      const result = await upstream.call(name, args, { sessionId, turnId, metadata: meta, signal });
      if (name === 'js_reset') sessions.clearAllTurns();
      return result;
    } finally {
      finishCall();
    }
  }

  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    // The relay connects to LCU lazily, so initialization always precedes the connection and
    // the js tool description carries the cua_repl guide instead (v0.4 accepts this).
    instructions: '',
  });
  server.onerror = error => console.error('LCU OpenCode relay server error:', asText(error));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (role === 'standby') return { tools: STANDBY_TOOLS };
    try {
      await ensureUpstream();
      return { tools: upstream.publicTools() };
    } catch {
      // Stay serveable: the next call retries the connection.
      return { tools: [] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args, _meta } = request.params;
    if (!MODEL_TOOLS.has(name)) throw unknownTool(name);
    try {
      if (role === 'standby' && !await takeOver()) {
        return errorResult(`LCU is in use by another OpenCode session (owner pid ${ownerPid}). ` +
          'Switch to that OpenCode window or close it, then retry here.');
      }
      return await handleModelCall(name, args, _meta, extra.signal);
    } catch (error) {
      // A failed call is a tool error for the model, never a relay crash; only the
      // unknown-tool protocol error above rejects the request itself.
      return errorResult(`LCU call failed: ${asText(error)}`);
    }
  });

  let stopping;
  async function drainOpenTurns() {
    const open = sessions.openTurns();
    if (open.length === 0) return;
    let timer;
    const budget = new Promise(resolve => { timer = setTimeout(resolve, DRAIN_BUDGET_MS); });
    const ended = Promise.allSettled(open.map(turn =>
      upstream.turnEnded({ sessionId: turn.sessionId, turnId: turn.turnId, event: 'Interrupt' }).catch(() => {})));
    await Promise.race([ended, budget]);
    clearTimeout(timer);
  }

  /** Stop serving: end open turns (2 s budget), close LCU, and remove the singleton's files. */
  function dispose(reason = 'shutdown') {
    stopping ??= (async () => {
      try {
        await drainOpenTurns();
      } catch { /* each turn end reports its own outcome */ }
      await upstream?.close().catch(() => {});
      await ipc?.close().catch(() => {});
      rmSync(socketPath, { force: true });
      rmSync(join(stateDir, TOKEN_NAME), { force: true });
      if (role === 'owner' && lockOwnedBy(stateDir, pid)) {
        rmSync(join(stateDir, LOCK_NAME), { force: true });
      }
      log.event('relay_stop', { reason });
    })();
    return stopping;
  }

  return {
    server,
    sessions,
    get role() { return role; },
    get ownerPid() { return ownerPid; },
    get socketPath() { return role === 'owner' ? socketPath : undefined; },
    get tokenPath() { return join(stateDir, TOKEN_NAME); },
    get lockPath() { return join(stateDir, LOCK_NAME); },
    dispose,
  };
}

/** Serve one relay process on stdio; signals and stdin EOF drain open turns and clean up. */
export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseRelayArgs(argv);
  } catch (error) {
    console.error(`LCU OpenCode relay failed to start: ${asText(error)}`);
    process.exitCode = 2;
    return;
  }
  let relay;
  try {
    relay = await createRelay(options);
  } catch (error) {
    console.error(`LCU OpenCode relay failed to start: ${asText(error)}`);
    process.exitCode = 2;
    return;
  }
  await relay.server.connect(new StdioServerTransport());
  const stop = reason => { void relay.dispose(reason).finally(() => process.exit(0)); };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  // The SDK stdio transport does not report stdin EOF; OpenCode closing the pipe ends the relay.
  process.stdin.once('end', () => stop('stdin_eof'));
  process.on('beforeExit', () => { void relay.dispose('beforeExit'); });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error('LCU OpenCode relay failed:', asText(error));
    process.exitCode = 1;
  });
}