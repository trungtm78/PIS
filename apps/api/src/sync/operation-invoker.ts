import { SYNC_FORWARD_HEADER, syncForwardMark } from './forward-mark';

/** Injection token of the port through which a queued command reaches the operation it stands for. */
export const SYNC_OPERATION_INVOKER = Symbol('SYNC_OPERATION_INVOKER');

export interface OperationCall {
  /** Where the platform listens for this call: the address of the server that took the batch. */
  baseUrl: string;
  path: string;
  body: Record<string, unknown>;
  /** The key the phone gave the command: the operation is idempotent on it, so a command sent twice is carried out once. */
  idempotencyKey: string;
  ifMatch: string | undefined;
  /** The credentials of the person who sent the batch, as they came. */
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface OperationAnswer {
  /** 0 when there was no answer. */
  status: number;
  body: unknown;
}

/**
 * Carries a queued command out through the platform's own public API (ST-MOB-005): the call goes in as the person who sent the batch, with their credentials, so the permission, the scope, the license, the period, the
 * version and the idempotency rules of the operation decide it exactly as they would online, and the audit rows and events are the operation's own. Nothing about a queued command is trusted for being queued.
 */
export interface SyncOperationInvoker {
  invoke(call: OperationCall): Promise<OperationAnswer>;
}

/** The headers of the batch that must not be copied to a call of the server to itself. */
const NOT_FORWARDED: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'transfer-encoding',
  'content-length',
  'content-type',
  'content-encoding',
  'accept',
  'accept-encoding',
  'expect',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'etag',
  'range',
  // A client cannot hand the mark on: only the batch puts it on the calls it makes.
  SYNC_FORWARD_HEADER,
]);

/** The credentials and the context of the batch, ready for the calls it makes: every header but the ones that belong to this one request. */
export function forwardedHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (NOT_FORWARDED.has(lower) || value === undefined) continue;
    forwarded[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return forwarded;
}

/** The calls over HTTP to the server itself. */
export class HttpSyncOperationInvoker implements SyncOperationInvoker {
  async invoke(call: OperationCall): Promise<OperationAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), call.timeoutMs);
    try {
      const response = await fetch(`${call.baseUrl}${call.path}`, {
        method: 'POST',
        headers: {
          ...call.headers,
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': call.idempotencyKey,
          [SYNC_FORWARD_HEADER]: syncForwardMark(),
          ...(call.ifMatch === undefined ? {} : { 'if-match': call.ifMatch }),
        },
        body: JSON.stringify(call.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : (JSON.parse(text) as unknown);
      } catch {
        body = undefined;
      }
      return { status: response.status, body };
    } catch {
      return { status: 0, body: undefined };
    } finally {
      clearTimeout(timer);
    }
  }
}
