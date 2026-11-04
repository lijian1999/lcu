// Singleton election for the OpenCode relay: one relay process per state directory becomes
// the owner (it talks to LCU and serves the lifecycle IPC), and every other relay started
// beside it runs as standby until the owner is gone. This module only owns the lock and
// token files; role transitions and the socket live in relay.mjs and ipc.mjs.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** File names inside the state directory; the lock names the owner, the token gates the socket. */
export const LOCK_NAME = 'relay.lock';
export const TOKEN_NAME = 'relay.token';
export const SOCKET_NAME = 'relay.sock';

/** Default state directory (the environment override the plugin shares is applied by the relay). */
export function defaultStateDirectory({ env = process.env, home = homedir() } = {}) {
  return env.LCU_OPENCODE_STATE_DIR || join(home, '.local', 'state', 'lcu-opencode');
}

/** The default installed LCU launcher the relay drives. */
export function defaultLcuPath({ home = homedir() } = {}) {
  return join(home, '.local', 'share', 'lcu', 'current', 'bin', 'lcu');
}

/** True when `pid` is a process this user can signal (a live one); EPERM counts as alive. */
export function pidAlive(pid, kill = (target, signal) => process.kill(target, signal)) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** The owner pid recorded in a lock file, or undefined when unreadable or malformed. */
export function readLockOwner(lockPath) {
  try {
    const { pid } = JSON.parse(readFileSync(lockPath, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create the lock file exclusively. A lock naming a dead process is stale: it is removed and
 * the creation retried once. Returns `{acquired: true}` or, when a live owner holds the lock,
 * `{acquired: false, pid}` with that owner's pid.
 */
export function acquireLock(directory, { pid = process.pid, startedAt = Date.now(), alive = pidAlive } = {}) {
  const lockPath = join(directory, LOCK_NAME);
  const write = () => {
    const fd = openSync(lockPath, 'wx', 0o600);
    try { writeSync(fd, `${JSON.stringify({ pid, startedAt })}\n`); } finally { closeSync(fd); }
  };
  try {
    write();
    return { acquired: true, lockPath };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = readLockOwner(lockPath);
    if (owner !== undefined && alive(owner)) return { acquired: false, lockPath, pid: owner };
    rmSync(lockPath, { force: true });
    try {
      write();
      return { acquired: true, lockPath };
    } catch (retryError) {
      if (retryError?.code !== 'EEXIST') throw retryError;
      return { acquired: false, lockPath, pid: readLockOwner(lockPath) };
    }
  }
}

/** Whether the lock (if any) names `pid` as its owner; used before removing it on exit. */
export function lockOwnedBy(directory, pid) {
  return readLockOwner(join(directory, LOCK_NAME)) === pid;
}

/**
 * Create the relay's IPC token (32 random bytes hex, file mode 0600), replacing any stale one.
 * Only the owner writes it; plugin connections present it on the socket.
 */
export function writeToken(directory, { bytes = 32, randomBytes: makeBytes = randomBytes } = {}) {
  const tokenPath = join(directory, TOKEN_NAME);
  rmSync(tokenPath, { force: true });
  const token = makeBytes(bytes).toString('hex');
  const fd = openSync(tokenPath, 'wx', 0o600);
  try { writeSync(fd, `${token}\n`); } finally { closeSync(fd); }
  return { tokenPath, token };
}

/** The token from the owner's token file, or undefined; the relay reads its own file back in tests. */
export function readToken(tokenPath) {
  try {
    return readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Prepare the state directory (0700, owned by this user) before any file is created in it. */
export function prepareStateDirectory(directory, { mkdir = mkdirSync, stat = statSync, uid = process.getuid?.() } = {}) {
  mkdir(directory, { recursive: true, mode: 0o700 });
  if (typeof uid === 'function') uid = uid();
  const owner = stat(directory).uid;
  if (typeof uid === 'number' && owner !== uid) {
    throw new Error(`LCU relay state directory belongs to another account: ${directory}`);
  }
}