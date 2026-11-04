// The LCU × OpenCode plugin (SPEC §2): an OpenCode V2 plugin that translates session
// lifecycle events into the relay owner's token-gated Unix-socket IPC, so the relay closes a
// session's open turn when a new prompt round starts (`bind`) and when the round ends or the
// session dies (`turn_ended`) — the SPEC §1.8 event table. Every message is one short
// connection (connect → one token-tagged JSON line → one ack line → close); a missing socket
// or token and every other failure are skipped with a throttled `[lcu-opencode]` warning and
// never propagate into the session, and there is no retry queue (the next event tries again).
// The execute.after hook re-binds sessions whose started event never surfaced — bookkeeping
// only: tool arguments and results are never read. The plugin writes no files and spawns no
// processes.
//
// Zero dependencies on purpose: `Plugin.define` in @opencode/plugin 2.2.5 is an identity
// function (`export function define(plugin) { return plugin; }`, dist/promise/plugin.js), so
// the bare plugin object below is exactly what the wrapped form would be, and installing the
// plugin means copying this directory — nothing to npm-install.
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { defaultStateDirectory, eventToMessage, LIFECYCLE_EVENT_TYPES, makeThrottledWarn } from './lifecycle.ts';
import type { RelayMessage } from './lifecycle.ts';

/** How long one message waits for the relay's single ack line (SPEC §2: 1 s). */
export const ACK_TIMEOUT_MS = 1_000;

/** The relay's file names in the state directory (same names as ../singleton.mjs). */
const SOCKET_NAME = 'relay.sock';
const TOKEN_NAME = 'relay.token';

/** The socket and token paths inside a relay state directory. */
export function relayEndpoints(stateDir: string): { socketPath: string; tokenPath: string } {
  return { socketPath: join(stateDir, SOCKET_NAME), tokenPath: join(stateDir, TOKEN_NAME) };
}

const asText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What one relay send came back with; transport and rejection failures are values, not throws. */
export interface SendOutcome {
  ok: boolean;
  /** The parsed ack line when the relay answered. */
  response?: Record<string, unknown>;
  /** Failure detail for the throttled warning; undefined on success. */
  error?: string;
}

/**
 * Send one message to the relay and await its ack — modeled on `ipcRequest` in ../ipc.mjs
 * (same one-line request, one-line-response framing) but resolving failures as values so the
 * caller can throttle-warn them instead of catching: connect, write `{...message}\n`, read
 * one JSON line with a boolean `ok`, then close. Never rejects.
 */
export function sendIpcMessage(
  socketPath: string,
  message: Record<string, unknown>,
  { timeoutMs = ACK_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<SendOutcome> {
  return new Promise(resolve => {
    let buffer = '';
    let settled = false;
    let socket: ReturnType<typeof createConnection> | undefined;
    const decoder = new StringDecoder('utf8');
    const finish = (outcome: SendOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `relay ack timed out after ${timeoutMs} ms` }),
      timeoutMs,
    );
    try {
      socket = createConnection(socketPath);
    } catch (error) {
      finish({ ok: false, error: asText(error) });
      return;
    }
    socket.on('error', error => finish({ ok: false, error: asText(error) }));
    socket.on('connect', () => socket?.write(`${JSON.stringify(message)}\n`));
    socket.on('data', chunk => {
      buffer += decoder.write(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0 || settled) return;
      let ack: unknown;
      try {
        ack = JSON.parse(buffer.slice(0, newline));
        if (!ack || typeof ack !== 'object' || typeof (ack as { ok?: unknown }).ok !== 'boolean') {
          throw new Error('invalid response shape');
        }
      } catch (error) {
        finish({ ok: false, error: `invalid relay ack: ${asText(error)}` });
        return;
      }
      const response = ack as { ok: boolean; error?: unknown };
      if (response.ok) finish({ ok: true, response });
      else {
        finish({
          ok: false,
          response,
          error: `relay refused the message (${asText(response.error ?? 'unknown error')})`,
        });
      }
    });
    socket.on('close', () => finish({ ok: false, error: 'relay closed the connection before an ack' }));
  });
}

export interface LcuBridgeOptions {
  socketPath: string;
  tokenPath: string;
  ackTimeoutMs?: number;
  /** Injected clock for the warning throttle (tests). */
  now?: () => number;
  /** Base warning sink; the `[lcu-opencode] ` prefix is added here (tests). */
  warn?: (message: string) => void;
}

/**
 * The plugin's event → IPC engine with every side effect injectable: the token file is read
 * fresh per message (a standby takeover rotates it), each mapped message gets one short
 * connection, failures become throttled `[lcu-opencode]` warnings, and the in-memory bound
 * set lets the execute.after hook detect sessions whose started event never surfaced.
 */
export function createLcuBridge(options: LcuBridgeOptions) {
  const {
    socketPath, tokenPath, ackTimeoutMs = ACK_TIMEOUT_MS, now = Date.now, warn = message => console.warn(message),
  } = options;
  const throttledWarn = makeThrottledWarn({ now, warn: message => warn(`[lcu-opencode] ${message}`) });
  const boundSessions = new Set<string>();

  /** Read the owner's token (mirrors readToken in ../singleton.mjs); undefined when absent. */
  function readRelayToken(): string | undefined {
    try {
      return readFileSync(tokenPath, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Deliver one message; every failure path lands in exactly one throttled warning. */
  async function send(message: RelayMessage): Promise<void> {
    const token = readRelayToken();
    if (token === undefined) {
      throttledWarn('token_missing', `relay token not readable at ${tokenPath}; skipping the ${message.type} message`);
      return;
    }
    const outcome = await sendIpcMessage(socketPath, { token, ...message }, { timeoutMs: ackTimeoutMs });
    if (outcome.ok) return;
    if (outcome.response === undefined) {
      throttledWarn('send_failed', `the ${message.type} message could not be delivered: ${outcome.error}`);
      return;
    }
    const reason = String((outcome.response as { error?: unknown }).error ?? 'unknown error');
    throttledWarn(`rejected_${reason}`, `the relay refused the ${message.type} message (${reason})`);
  }

  /** One OpenCode event in: map it, keep the bound set honest, deliver. Never throws. */
  async function applyEvent(event: unknown): Promise<void> {
    let message: RelayMessage | null;
    try {
      message = eventToMessage(event);
    } catch (error) {
      throttledWarn('mapping_failed', `could not read an OpenCode lifecycle event: ${asText(error)}`);
      return;
    }
    if (message === null) return;
    if (message.type === 'bind') boundSessions.add(message.sessionID);
    else boundSessions.delete(message.sessionID);
    await send(message);
  }

  /**
   * The execute.after hook body: when an lcu tool ran (through Code Mode the js tool
   * surfaces under names like `lcu_js` or `lcu__lcu__js`), re-bind its session unless the
   * started event already did. Bookkeeping only — the event's input and result are never read.
   */
  async function onToolEvent(event: unknown): Promise<void> {
    try {
      const tool = (event as { tool?: unknown } | null | undefined)?.tool;
      if (typeof tool !== 'string' || !tool.toLowerCase().includes('lcu')) return;
      const sessionID = (event as { sessionID?: unknown } | null | undefined)?.sessionID;
      if (typeof sessionID !== 'string' || !sessionID || boundSessions.has(sessionID)) return;
      boundSessions.add(sessionID);
      await send({ type: 'bind', sessionID });
    } catch (error) {
      throttledWarn('tool_hook_failed', `the lcu tool backstop failed: ${asText(error)}`);
    }
  }

  /** Throttled warning for wiring-level failures (e.g. a dead event subscription). */
  function warnOnce(key: string, message: string): void {
    throttledWarn(key, message);
  }

  return { applyEvent, onToolEvent, warnOnce, boundSessions };
}

/** The slice of the OpenCode V2 plugin context the plugin uses (loose on purpose). */
export interface PluginContext {
  event: {
    subscribe(options: { types: readonly string[]; signal: AbortSignal }): AsyncIterable<unknown>;
  };
  tool: {
    hook(name: 'execute.after', handler: (event: unknown) => Promise<void> | void): Promise<{ dispose(): unknown }>;
  };
}

export interface CreatePluginOptions {
  /** Relay state directory; defaults to the shared resolution (LCU_OPENCODE_STATE_DIR or ~/.local/state/lcu-opencode). */
  stateDir?: string;
  /** Explicit socket/token paths (tests); default to the ones inside `stateDir`. */
  socketPath?: string;
  tokenPath?: string;
  ackTimeoutMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

/**
 * Wire the plugin to a live OpenCode context: subscribe to the §1.8 lifecycle events, hook
 * execute.after, and return the cleanup that aborts the subscription and disposes the hook
 * (the host calls it; with the plugin living as long as the process it may never run).
 */
export async function createPlugin(context: PluginContext, options: CreatePluginOptions = {}) {
  const endpoints = relayEndpoints(options.stateDir ?? defaultStateDirectory());
  const bridge = createLcuBridge({
    socketPath: options.socketPath ?? endpoints.socketPath,
    tokenPath: options.tokenPath ?? endpoints.tokenPath,
    ackTimeoutMs: options.ackTimeoutMs,
    now: options.now,
    warn: options.warn,
  });
  const controller = new AbortController();
  void (async () => {
    const events = context.event.subscribe({ types: LIFECYCLE_EVENT_TYPES, signal: controller.signal });
    for await (const event of events) await bridge.applyEvent(event);
  })().catch(error => {
    // The subscription died (e.g. a host restart); warn once and leave reconnection to the
    // next plugin load, exactly like the reference plugin's idle tracker does.
    if (!controller.signal.aborted) {
      bridge.warnOnce('subscription_ended', `the lifecycle event subscription ended: ${asText(error)}`);
    }
  });
  const registration = await context.tool.hook('execute.after', event => bridge.onToolEvent(event));
  return () => {
    controller.abort();
    try {
      registration?.dispose();
    } catch {
      // Disposal is best effort, mirroring the reference plugin's cleanup discipline.
    }
  };
}

/** The plugin OpenCode loads: id + setup, zero dependencies (see the file header). */
export default {
  id: 'lcu-opencode-plugin',
  async setup(context: PluginContext) {
    return createPlugin(context);
  },
};