// Line-JSON IPC between the OpenCode plugin and the relay owner, over a Unix socket in the
// state directory. One request per connection: the client connects, sends one JSON line whose
// first field is the owner's token, and reads back one JSON line. This module owns only the
// framing, the size limit, and the token gate; the message semantics (bind/turn_ended/ping)
// live in the `handle` callback the relay passes. The module never logs message contents.
import { rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

/** Reject an oversized line before parsing it. */
export const IPC_REQUEST_LIMIT = 64 * 1024;

/** Send one request to a relay socket and resolve its `{ok, ...}` response. Test/plugin helper. */
export function ipcRequest(socketPath, message, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const decoder = new StringDecoder('utf8');
    const socket = createConnection(socketPath);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`LCU relay IPC request timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', chunk => {
      buffer += decoder.write(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
          throw new Error('invalid response shape');
        }
        finish(undefined, response);
      } catch (error) {
        finish(new Error(`Invalid LCU relay IPC response: ${error.message}`));
      }
    });
    socket.on('close', () => finish(new Error('LCU relay IPC connection ended before a response')));
  });
}

/**
 * Serve the newline-JSON protocol on `socketPath` (any stale file is removed first). A
 * connection's first line must carry the exact token; anything else is refused with one
 * error line and the connection is closed, as are malformed lines, oversized lines and
 * unknown message types. `handle(message)` returns the response object. The socket file
 * is left in place by `close` — the next owner unlinks it before listening again.
 */
export function startIpcServer({ socketPath, token, handle, limit = IPC_REQUEST_LIMIT }) {
  if (typeof token !== 'string' || !token) throw new TypeError('A relay IPC token is required');
  if (typeof handle !== 'function') throw new TypeError('A relay IPC message handler is required');
  rmSync(socketPath, { force: true });
  const server = createServer(socket => {
    let buffer = '';
    let consumed = false;
    let replied = false;
    const decoder = new StringDecoder('utf8');
    const reply = value => {
      if (replied || socket.destroyed) return;
      replied = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (consumed) return;
      buffer += decoder.write(chunk);
      if (buffer.length > limit) {
        consumed = true;
        reply({ ok: false, error: 'bad_request' });
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      consumed = true;
      const line = buffer.slice(0, newline);
      void (async () => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          reply({ ok: false, error: 'bad_request' });
          return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.token !== token) {
          reply({ ok: false, error: 'invalid_token' });
          return;
        }
        try {
          reply(await handle(message));
        } catch {
          // Handler failures are reported to the plugin, never to a log with their detail.
          reply({ ok: false, error: 'internal_error' });
        }
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve({
        server,
        socketPath,
        close: ({ force = true } = {}) => new Promise(resolveClose => {
          server.close(() => resolveClose());
          // Force (process exit) destroys lingering plugin connections so they cannot hold
          // the exit open. A graceful close (the owner yielding mid-reply) keeps existing
          // connections until they finish, so the step-down response is still delivered.
          if (force) server.closeAllConnections?.();
        }),
      });
    });
  });
}