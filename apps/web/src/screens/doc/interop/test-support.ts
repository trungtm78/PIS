import { harness as baseHarness } from '../test-support';
import type { Harness } from '../test-support';

export { mountInSession, routeOf } from '../test-support';
export type { Harness };

/** The manager of the messages, a reader who only watches, and a caller who holds neither right. */
export const MANAGER = ['doc.interop.read', 'doc.interop.manage'];
export const WATCHER = ['doc.interop.read'];
export const OUTSIDER = ['doc.register.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const messageId = (n: number): string => uuid('00f0', n);
export const outgoingId = (n: number): string => uuid('00f1', n);
export const incomingId = (n: number): string => uuid('00f2', n);

/** A message that left and waits for its next attempt after two failures: the plain case of the monitor. Overrides change what a test needs. */
export const failed = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: messageId(n),
  direction: 'OUTBOUND',
  status: 'FAILED',
  adapter_code: 'LGSP_EDXML',
  adapter_status: 'MOCK',
  external_message_id: null,
  sender_code: 'G08.SO-XD',
  receiver_code: 'G08.SKHDT',
  outgoing_document_id: outgoingId(n),
  incoming_document_id: null,
  attempts: 2,
  next_attempt_at: '2026-11-03T03:03:00.000Z',
  error_code: 'PROVIDER_UNAVAILABLE',
  processed_at: null,
  created_at: '2026-11-03T03:00:00.000Z',
  updated_at: '2026-11-03T03:01:00.000Z',
  actions: { retry: true },
  version: 4,
  ...overrides,
});

export const dead = (n: number, overrides: Record<string, unknown> = {}) => failed(n, { status: 'DEAD', attempts: 20, next_attempt_at: null, error_code: 'EGRESS_NOT_ALLOWED', version: 22, ...overrides });

export const acked = (n: number, overrides: Record<string, unknown> = {}) =>
  failed(n, { status: 'ACKED', attempts: 1, next_attempt_at: null, error_code: null, external_message_id: `LGSP-${n}`, processed_at: '2026-11-03T03:05:00.000Z', actions: { retry: false }, version: 3, ...overrides });

export const received = (n: number, overrides: Record<string, unknown> = {}) =>
  failed(n, {
    direction: 'INBOUND',
    status: 'PROCESSED',
    adapter_status: 'VERIFIED',
    external_message_id: `E-IN-${n}`,
    sender_code: 'G08.BTC',
    receiver_code: null,
    outgoing_document_id: null,
    incoming_document_id: incomingId(n),
    attempts: 0,
    next_attempt_at: null,
    error_code: null,
    processed_at: '2026-11-03T03:02:00.000Z',
    actions: { retry: false },
    version: 2,
    ...overrides,
  });

export interface World {
  messages: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Map<string, Error>;
}

export const world = (messages: Array<Record<string, unknown>> = [], failing: Map<string, Error> = new Map()): World => ({ messages, failing });

/** A client over `state`: the list answers from it, narrowed and paged as the server does, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    if (operation !== 'listInteropMessages') return new Error(`unexpected read ${operation}`);
    const query = (input as { query?: { status?: string; direction?: string; cursor?: string; limit?: number } } | undefined)?.query ?? {};
    const matching = state.messages.filter((item) => (query.status === undefined || item.status === query.status) && (query.direction === undefined || item.direction === query.direction));
    const from = query.cursor === undefined ? 0 : Number(query.cursor);
    const limit = query.limit ?? 50;
    const shown = matching.slice(from, from + limit);
    return { items: shown, next_cursor: from + limit < matching.length ? String(from + limit) : null, as_of: '2026-11-03T03:10:00.000Z' };
  }, command);
}
