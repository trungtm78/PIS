import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import type { Severity, Tone } from '../../../ui';

/** BID-22: the connection `egp.muasamcong` to the national e-procurement network. A read screen with one command: switch the connection on or off with a reason. */
export type Connection = components['schemas']['EgpConnection'];
export type ImportRun = components['schemas']['EgpImportRun'];
export type Position = Connection['positions'][number];
export type Layout = Connection['layouts'][number];
export type PendingItem = Connection['pending_external'][number];
export type HistoryEntry = Connection['history'][number];
export type HealthStatus = Connection['health']['status'];

export const CONNECTOR_CODE = 'egp.muasamcong';
export const READ_PERMISSION = 'bid.read';
export const ADMIN_PERMISSION = 'bid.egp.admin';
/** The reason of a switch is at least this long (the contract: minLength 10); the screen refuses a shorter one before it sends. */
export const MIN_REASON = 10;
export const PATHS = { mapping: '/bid/bid-23', imports: '/bid/bid-24' } as const;
/** The five kinds of file, in the order the register lists them. */
export const KINDS = ['KHLCNT', 'TBMT', 'RESULT', 'CONTRACTOR', 'RESTRICTION'] as const;

// ---- reading the answer: the shape is checked, a wrong shape is an error of the read (never an empty screen) --------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

const ARRAYS = ['supported_layouts', 'pending_external', 'positions', 'layouts', 'last_runs', 'history'] as const;
const OBJECTS = ['api_adapter', 'health', 'actions', 'record_counts', 'mapping_counts'] as const;

export function toConnection(raw: unknown): Connection {
  const body = asRecord(raw);
  if (body === undefined || ARRAYS.some((key) => !Array.isArray(body[key])) || OBJECTS.some((key) => asRecord(body[key]) === undefined) || asRecord(asRecord(body.health)?.rule) === undefined) {
    throw new Error('unexpected connection');
  }
  return body as unknown as Connection;
}

// ---- time and numbers -------------------------------------------------------------------------------------------------------------------------------------------------

const VIETNAM_OFFSET_MS = 7 * 3_600_000;

/** An instant as the people of the screen read it: the Vietnam day and minute ("08/11/2026 14:05"). An unreadable value is shown as it came. */
export function vietnamStamp(instant: string | null | undefined): string {
  if (instant === null || instant === undefined) return '';
  const moment = Date.parse(instant);
  if (Number.isNaN(moment)) return instant;
  const text = new Date(moment + VIETNAM_OFFSET_MS).toISOString();
  return `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)} ${text.slice(11, 16)}`;
}

/** A day (`YYYY-MM-DD`) or an instant as a day: the rule's day of effect comes as either. */
export function dayText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
  const stamp = vietnamStamp(value);
  return stamp.slice(0, 10);
}

/** A count or an age with the digits of the locale; an age keeps one decimal at most. */
export function numberText(value: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 1 });
}

// ---- health -----------------------------------------------------------------------------------------------------------------------------------------------------------

const HEALTH_TONE: Readonly<Record<HealthStatus, Tone>> = { FRESH: 'success', AGING: 'info', STALE: 'warning', NEVER_IMPORTED: 'neutral' };
const HEALTH_ICON: Readonly<Record<HealthStatus, string>> = { FRESH: '✓', AGING: '◔', STALE: '⚠', NEVER_IMPORTED: '○' };
export const healthTone = (status: HealthStatus): Tone => HEALTH_TONE[status];
export const healthIcon = (status: HealthStatus): string => HEALTH_ICON[status];

/** The severity of an alert as the kit knows it; a word the kit does not know is not drawn as a level. */
export function severityOf(value: string | null | undefined): Severity | null {
  return value === 'URGENT' || value === 'ACTION' || value === 'WATCH' ? value : null;
}

/** The rule that made the freshness is a starting value nobody confirmed: the server flags it, and the legal status says so too. */
export const isUnverified = (connection: Connection): boolean => connection.health.rule.unverified || connection.health.rule.legal_status === 'UNVERIFIED';

export const isFirstUse = (connection: Connection): boolean => !connection.registered;

// ---- what the caller may do ---------------------------------------------------------------------------------------------------------------------------------------

export type SwitchBlock = 'MODE' | 'RIGHT' | null;

/** Why the button is not offered: the workspace is read-only, or the server did not give the caller the command. */
export function switchBlock(connection: Connection, mode: 'FULL' | 'READ_ONLY' | undefined): SwitchBlock {
  if (mode === 'READ_ONLY') return 'MODE';
  return connection.actions.set_state ? null : 'RIGHT';
}

/** The reason of a switch, trimmed: null when it is long enough, else why not. */
export function reasonProblem(reason: string): 'EMPTY' | 'SHORT' | null {
  const text = reason.trim();
  if (text === '') return 'EMPTY';
  return text.length < MIN_REASON ? 'SHORT' : null;
}

// ---- the numbers ------------------------------------------------------------------------------------------------------------------------------------------------------

/** The records the register holds from the network, the five kinds first and in their order, then any kind the server adds. */
export function recordRows(counts: Readonly<Record<string, number>>): Array<{ kind: string; count: number }> {
  const known = KINDS.map((kind) => ({ kind: kind as string, count: counts[kind] ?? 0 }));
  const extra = Object.keys(counts)
    .filter((kind) => !(KINDS as readonly string[]).includes(kind))
    .sort()
    .map((kind) => ({ kind, count: counts[kind] ?? 0 }));
  return [...known, ...extra];
}

export const recordTotal = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((sum, count) => sum + count, 0);

/** The positions in the order of the five kinds (a kind the server adds goes last). */
export function orderedPositions(positions: readonly Position[]): Position[] {
  const rank = (kind: string): number => {
    const found = (KINDS as readonly string[]).indexOf(kind);
    return found === -1 ? KINDS.length : found;
  };
  return [...positions].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** The kind of a pending item that is a file sample (`SAMPLE_KHLCNT` is the sample of KHLCNT), else null. */
export const sampleKind = (code: string): string | null => (code.startsWith('SAMPLE_') ? code.slice('SAMPLE_'.length) : null);

// ---- a failed command -------------------------------------------------------------------------------------------------------------------------------------------------

/** The code of a failed command, when the server named one. */
export const failureCode = (error: unknown): string | undefined => (error instanceof ApiError ? error.code : undefined);

export const failureStatus = (error: unknown): number | undefined => (error instanceof ApiError ? error.status : undefined);

export const failureDetail = (error: unknown): string | undefined => (error instanceof ApiError && typeof error.detail === 'string' && error.detail !== '' ? error.detail : undefined);
