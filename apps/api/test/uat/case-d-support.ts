import net from 'node:net';

/**
 * What the case suites of the integration areas (EBS, HPM, IND, INT) share beyond the world: the log of the network connections the process opens while a case runs, so that "no outbound network call" is
 * a measured fact (every connection that is not to this machine is named) and not a claim.
 */
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', 'unix'];

export interface ConnectionLog {
  /** The hosts every connection opened since the log began was made to (`unix` for a socket path). */
  readonly targets: string[];
  stop(): void;
}

/** Starts recording the connections of this process: the test server, the test client and the database are loopback; whatever else appears is an outbound call. */
export function recordConnections(): ConnectionLog {
  const targets: string[] = [];
  const original = net.Socket.prototype.connect;
  const spy = jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    const first = args[0];
    const host = typeof first === 'object' && first !== null ? ((first as { host?: string; path?: string }).host ?? ((first as { path?: string }).path === undefined ? 'localhost' : 'unix')) : typeof args[1] === 'string' ? args[1] : 'localhost';
    targets.push(host);
    return (original as (...parameters: unknown[]) => net.Socket).apply(this, args);
  });
  return { targets, stop: () => spy.mockRestore() };
}

/** Throws when any of the connections went somewhere else than this machine. */
export function assertNoOutbound(targets: readonly string[]): void {
  const outside = targets.filter((target) => !LOOPBACK.includes(target));
  if (outside.length > 0) throw new Error(`the run opened an outbound connection to ${[...new Set(outside)].join(', ')}`);
}

/** An item of an answer, read by the name of its members where the case knows the shape of what the product answers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the members of an answer are read by name and checked by the assertions of the case
export type Doc = Record<string, any>;
