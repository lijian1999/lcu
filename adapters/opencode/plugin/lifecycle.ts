// Pure lifecycle logic for the LCU × OpenCode plugin: the OpenCode event → relay IPC message
// mapping (the adapter SPEC's §1.8 table), the throttled warning discipline for every IPC
// failure (§2), and the state-directory resolution shared with the relay. No I/O and no
// dependencies beyond Node built-ins: `node --test` imports this file directly (Node strips
// the types), and index.ts wires it to the real socket, token file and console.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The OpenCode events the plugin consumes; every other event type is ignored (SPEC §1.8). */
export const LIFECYCLE_EVENT_TYPES: readonly string[] = [
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.deleted',
];

/** One relay IPC message; the sender adds the `token` field around it. */
export type RelayMessage =
  | { type: 'bind'; sessionID: string }
  | { type: 'turn_ended'; sessionID: string; event: 'Stop' | 'Interrupt' };

/** The turn end each non-started lifecycle event asks for (`session.deleted`: the session is gone). */
const TURN_END_EVENTS: Record<string, 'Stop' | 'Interrupt'> = {
  'session.execution.succeeded': 'Stop',
  'session.execution.failed': 'Interrupt',
  'session.execution.interrupted': 'Interrupt',
  'session.deleted': 'Interrupt',
};

/**
 * Map one OpenCode event to the relay IPC message it produces, or null when the plugin must
 * stay silent (an unknown event type, or a session id that is not a non-empty string). The
 * session id always comes from `event.data.sessionID`; nothing else of the event is read.
 */
export function eventToMessage(event: unknown): RelayMessage | null {
  const type = (event as { type?: unknown } | null | undefined)?.type;
  const sessionID = (event as { data?: { sessionID?: unknown } } | null | undefined)?.data?.sessionID;
  if (typeof sessionID !== 'string' || !sessionID) return null;
  if (type === 'session.execution.started') return { type: 'bind', sessionID };
  const turnEnd = typeof type === 'string' ? TURN_END_EVENTS[type] : undefined;
  return turnEnd === undefined ? null : { type: 'turn_ended', sessionID, event: turnEnd };
}

export interface ThrottledWarnOptions {
  /** Clock for the quiet windows (tests inject a fake one). */
  now?: () => number;
  /** Warning sink; defaults to console.warn (the caller adds any prefix). */
  warn?: (message: string) => void;
  /** How long a key stays quiet after emitting. */
  windowMs?: number;
}

/**
 * One warning per key per window (60 s by default): the first failure of a kind is reported,
 * its repeats inside the window are dropped, and the window reopens once it has passed. The
 * clock and the sink are injected so tests advance time without sleeping.
 */
export function makeThrottledWarn(
  { now = Date.now, warn = message => console.warn(message), windowMs = 60_000 }: ThrottledWarnOptions = {},
) {
  const lastEmittedAt = new Map<string, number>();
  return (key: string, message: string): void => {
    const stamp = now();
    const last = lastEmittedAt.get(key);
    if (last !== undefined && stamp - last < windowMs) return;
    lastEmittedAt.set(key, stamp);
    warn(message);
  };
}

/**
 * The relay state directory, resolved exactly like `defaultStateDirectory` in ../singleton.mjs
 * (copied rather than imported so the installed plugin directory stays self-contained):
 * `LCU_OPENCODE_STATE_DIR` wins, else `~/.local/state/lcu-opencode`.
 */
export function defaultStateDirectory(
  { env = process.env, home = homedir() }: { env?: Record<string, string | undefined>; home?: string } = {},
): string {
  return env.LCU_OPENCODE_STATE_DIR || join(home, '.local', 'state', 'lcu-opencode');
}