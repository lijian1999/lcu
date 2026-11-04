// Session and turn bookkeeping for the OpenCode relay: which OpenCode session owns the
// single LCU runtime right now, and which turn (a relay-owned UUID per prompt round) each
// session's calls belong to. Pure logic, no I/O: the relay wires it to its upstream client
// and its IPC surface, and tests drive it directly. Nothing here talks to OpenCode or LCU.
import { randomUUID } from 'node:crypto';

/** Most distinct sessions the relay remembers; the oldest fully idle one is dropped first. */
export const MAX_SESSIONS = 1024;

/**
 * One entry per OpenCode session the relay has seen. `open` marks a turn the upstream worker
 * still believes is running (until an IPC bind/turn_ended or a js_reset ends it); `inFlight`
 * counts the js/js_reset calls currently running for the session; `pendingEnd` holds a turn
 * end the upstream refused, retried before the session's next call.
 */
function newState() {
  return { turnId: undefined, inFlight: 0, open: false, pendingEnd: undefined, pendingRetry: undefined };
}

/** Create the session table; `limit` bounds remembered sessions (LRU, idle entries only). */
export function createSessions({ limit = MAX_SESSIONS, randomUUID: makeTurnId = randomUUID } = {}) {
  const table = new Map();
  // The session the last admitted call belonged to; the mutex compares against it.
  let activeSession;
  const touch = (sessionId, state) => {
    table.delete(sessionId);
    table.set(sessionId, state);
  };
  const evictIdle = () => {
    if (table.size <= limit) return;
    for (const [sessionId, state] of table) {
      if (state.inFlight !== 0 || state.open) continue;
      table.delete(sessionId);
      if (table.size <= limit) return;
    }
  };
  /** The session's state, creating (and refreshing recency of) it when missing. */
  const stateOf = sessionId => {
    let state = table.get(sessionId);
    if (!state) {
      evictIdle();
      state = newState();
    }
    touch(sessionId, state);
    return state;
  };
  return {
    get activeSession() { return activeSession; },
    /** The session's state or undefined; never creates one (IPC handlers use this). */
    lookup(sessionId) {
      return sessionId === undefined ? undefined : table.get(sessionId);
    },
    stateOf,
    /**
     * Whether `sessionId` may call now: a different session may not start while another
     * session's call is in flight. Otherwise `sessionId` becomes the active session.
     */
    admit(sessionId) {
      const busy = [...table.entries()].find(([id, state]) => id !== sessionId && state.inFlight > 0);
      if (sessionId !== activeSession && busy !== undefined) return { ok: false, other: busy[0] };
      const from = activeSession;
      activeSession = sessionId;
      return { ok: true, switched: from !== undefined && from !== sessionId, from };
    },
    /** The session's open turn id, opening a fresh turn (a new UUID) when none is open. */
    openTurn(sessionId) {
      const state = stateOf(sessionId);
      if (!state.open) {
        state.turnId = makeTurnId();
        state.open = true;
      }
      return state.turnId;
    },
    /** Count one call of the session as started; the returned function marks it finished. */
    beginCall(sessionId) {
      const state = stateOf(sessionId);
      state.inFlight += 1;
      return () => { state.inFlight -= 1; };
    },
    /** Mark the session's turn ended; its next call opens a fresh one. */
    endTurn(sessionId) {
      const state = table.get(sessionId);
      if (state) state.open = false;
    },
    /** Every session with a turn the upstream still believes is open. */
    openTurns() {
      return [...table.entries()].filter(([, state]) => state.open)
        .map(([sessionId, state]) => ({ sessionId, turnId: state.turnId, inFlight: state.inFlight }));
    },
    /** Whether any session currently has a call in flight; the owner's gate for a yield. */
    hasInFlight() {
      for (const state of table.values()) {
        if (state.inFlight > 0) return true;
      }
      return false;
    },
    /** End every session's open turn; used after js_reset, which replaced the worker. */
    clearAllTurns() {
      for (const state of table.values()) state.open = false;
    },
  };
}