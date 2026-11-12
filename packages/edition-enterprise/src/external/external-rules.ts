import { DomainError, hasControlChar } from '@machvon/kernel';

/**
 * What the two ports to systems of the customer have in common (CN.02, TH.03; eng-review R18): the eProcurement system that holds the procurement of equipment, and the registry of documents (van thu) that holds the
 * legal documents. Neither interface has been specified by the customer (PENDING-EXTERNAL PX-06 and PX-07), so each port has one adapter, a fake that serves a fixed list from memory and never opens a connection; a real
 * adapter replaces it when the customer publishes the interface, with nothing else changing, because the readers depend on the port and the contract test (`test/support/port-contract.ts`) is what an adapter must pass.
 */

/** An adapter that stands for a system we cannot see is a substitute: the verdict on it is PROPOSED and never VERIFIED. */
export const EXTERNAL_ADAPTER_STATUS = 'PROPOSED' as const;

export type ExternalAcceptance = 'PENDING_EXTERNAL' | 'ACCEPTABLE';

/** Whether what rests on this layout can be accepted: a working assumption cannot; the owner of the other system has to confirm the interface first. */
export function externalAcceptance(layoutVersion: string): ExternalAcceptance {
  return layoutVersion.includes('WORKING-ASSUMPTION') ? 'PENDING_EXTERNAL' : 'ACCEPTABLE';
}

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;
const VND = /^(0|[1-9]\d{0,17})$/u;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A calendar day `YYYY-MM-DD` that exists. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** An instant in UTC, `YYYY-MM-DDTHH:MM:SS(.mmm)Z`, that exists. */
export function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !INSTANT.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export const isKey = (value: unknown): value is string => typeof value === 'string' && KEY.test(value);
/** An amount of whole dong as text: no sign, no leading zero, at most 18 digits. */
export const isVnd = (value: unknown): value is string => typeof value === 'string' && VND.test(value);
export const isLine = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max && !hasControlChar(value);

export interface PageRequest {
  /** The key of the last record of the previous page; absent on the first. */
  after?: string | undefined;
  limit?: number | undefined;
}

export interface Page<T> {
  records: T[];
  /** The key to give as `after` for the next page; null on the last. */
  next: string | null;
}

/** The common part of a query: `after` is a key and `limit` is 1..PAGE_MAX (default PAGE_DEFAULT). Anything else is 422 naming the field. */
export function pageRequestOf(query: Record<string, unknown>): { after: string | undefined; limit: number } {
  const { after, limit } = query;
  if (after !== undefined && !isKey(after)) throw invalid('after');
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX)) throw invalid('limit');
  return { after, limit: limit ?? PAGE_DEFAULT };
}

/** One page of records already in the order of their keys: the records after `after`, at most `limit`, and the key of the next page. */
export function pageOf<T>(sorted: readonly T[], keyOf: (item: T) => string, request: { after: string | undefined; limit: number }): Page<T> {
  const start = request.after === undefined ? 0 : sorted.findIndex((item) => keyOf(item) > (request.after as string));
  if (start < 0) return { records: [], next: null };
  const records = sorted.slice(start, start + request.limit);
  const more = start + request.limit < sorted.length;
  return { records, next: more && records.length > 0 ? keyOf(records[records.length - 1] as T) : null };
}
