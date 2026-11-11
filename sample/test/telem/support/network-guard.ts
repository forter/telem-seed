// Refuses every outbound TCP connection except loopback, so an IO client nobody faked fails loudly
// instead of reaching a real host. Every HTTP/DB/Kafka client ends in net.Socket#connect, which makes it
// the one choke point. Loopback stays open for supertest -> the in-process server (world.ts); IPC paths
// (tsx, worker channels) are not TCP and pass through.

import net from 'net';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

type ConnectArgs = Parameters<net.Socket['connect']>;

/** The `{ host, port, path }` a Socket#connect call targets, whatever overload it used. */
function target(args: unknown[]): { host?: string; hostname?: string; port?: unknown; path?: string | null } {
  // net.connect() hands Socket#connect an already-normalised [options, callback] array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === 'object') return first as { host?: string; hostname?: string; port?: unknown; path?: string | null };
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
}

const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const { host, hostname, port, path } = target(args);
  // Like net itself: a non-empty `path` means IPC. http's agent passes `path: null` and may set only `hostname`.
  const ipc = typeof path === 'string' && path !== '';
  const to = host ?? hostname ?? 'localhost';
  if (!ipc && !LOOPBACK.has(to)) {
    throw new Error(
      `[network-guard] Outbound connection to ${to}:${String(port)} refused under BDD. ` +
        'Probable cause: production code reached an IO client that has no fake (a new dependency, or a ' +
        'module required before its require.cache seed). ' +
        'Fix: fake the boundary and seed it in world.ts — see WRITING-FAKES.md § "Wiring new fakes".',
    );
  }
  return originalConnect.apply(this, args as ConnectArgs);
} as net.Socket['connect'];
