import { ApiError } from '@machvon/api-client';
import { businessToday } from '../../adm/org-tree/business-date';

export const MANAGE_PERMISSION = 'capital.reservation.manage';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const PURPOSES = ['CONTRACT_PENDING', 'ADVANCE_PENDING', 'LAND_CLEARANCE', 'OTHER'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const STATUSES = ['ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED'] as const;
export type Status = (typeof STATUSES)[number];

export interface ReservationView {
  id: string;
  allocationLineId: string;
  project: { id: string; code: string; name: string } | null;
  planYear: number;
  purpose: Purpose;
  referenceKind: string | null;
  referenceId: string | null;
  amountVnd: string;
  expiresAt: string;
  status: Status;
  releaseReason: string | null;
  avcWarningAcknowledged: boolean;
  version: number;
}

export interface ReservationPage {
  items: ReservationView[];
  nextCursor: string | undefined;
}

function toReservation(raw: unknown): ReservationView | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const line = text(row?.allocation_line_id);
  const amount = text(row?.amount_vnd);
  const expiresAt = text(row?.expires_at);
  const purpose = PURPOSES.find((known) => known === row?.purpose);
  const status = STATUSES.find((known) => known === row?.status);
  if (row === undefined || id === undefined || line === undefined || amount === undefined || expiresAt === undefined || purpose === undefined || status === undefined || typeof row.version !== 'number') return undefined;
  const project = asRecord(row.project);
  const projectId = text(project?.id);
  return {
    id,
    allocationLineId: line,
    project: projectId === undefined ? null : { id: projectId, code: text(project?.code) ?? '', name: text(project?.name) ?? '' },
    planYear: typeof row.plan_year === 'number' ? row.plan_year : 0,
    purpose,
    referenceKind: nullableText(row.reference_kind),
    referenceId: nullableText(row.reference_id),
    amountVnd: amount,
    expiresAt,
    status,
    releaseReason: nullableText(row.release_reason),
    avcWarningAcknowledged: row.avc_warning_acknowledged === true,
    version: row.version,
  };
}

export function toReservationPage(raw: unknown): ReservationPage {
  const page = asRecord(raw);
  return { items: (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toReservation(item) ?? []), nextCursor: text(page?.next_cursor) };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

// ---- the countdown ------------------------------------------------------------------------------------------------------------

export type Countdown = { kind: 'days'; count: number } | { kind: 'hours'; count: number } | { kind: 'over' };

/** How long an active reservation has left, in words the screen can say: whole days while there are some, then hours, then over (the job returns the capital at the next pass). */
export function countdownOf(expiresAt: string, now: Date = new Date()): Countdown {
  const left = Date.parse(expiresAt) - now.getTime();
  if (Number.isNaN(left) || left <= 0) return { kind: 'over' };
  const days = Math.floor(left / 86_400_000);
  return days >= 1 ? { kind: 'days', count: days } : { kind: 'hours', count: Math.max(1, Math.ceil(left / 3_600_000)) };
}

// ---- the form ----------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid';
export type CreateField = 'lineId' | 'amount' | 'expiresOn' | 'referenceKind' | 'referenceId';

export interface CreateForm {
  lineId: string;
  amount: string;
  purpose: Purpose;
  /** The last day it stands, in Vietnamese time: it runs out at the end of that day. */
  expiresOn: string;
  referenceKind: string;
  referenceId: string;
}

export const EMPTY_CREATE: CreateForm = { lineId: '', amount: '', purpose: 'CONTRACT_PENDING', expiresOn: '', referenceKind: '', referenceId: '' };
export const MAX_DAYS = 366;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^[1-9][0-9]{0,23}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const isDay = (value: string): boolean => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function validateCreate(form: CreateForm, today: string = businessToday(), now: Date = new Date()): Partial<Record<CreateField, FormProblem>> {
  const found: Partial<Record<CreateField, FormProblem>> = {};
  const line = form.lineId.trim();
  if (line === '') found.lineId = 'required';
  else if (!UUID.test(line)) found.lineId = 'invalid';
  const amount = form.amount.trim().replace(/[.,\s]/g, '');
  if (amount === '') found.amount = 'required';
  else if (!DIGITS.test(amount)) found.amount = 'invalid';
  const day = form.expiresOn.trim();
  if (day === '') found.expiresOn = 'required';
  // The server judges the instant that is sent, the end of that day in Vietnamese time, against a rolling year from now.
  else if (!isDay(day) || day <= today || Date.parse(`${day}T23:59:59+07:00`) - now.getTime() > MAX_DAYS * DAY_MS) found.expiresOn = 'invalid';
  const kind = form.referenceKind.trim();
  const reference = form.referenceId.trim();
  if (kind !== '' && kind.length > 50) found.referenceKind = 'invalid';
  if (kind === '' && reference !== '') found.referenceKind = 'required';
  if (reference === '' && kind !== '') found.referenceId = 'required';
  else if (reference !== '' && !UUID.test(reference)) found.referenceId = 'invalid';
  return found;
}

/** The body of the command for a form that passed `validateCreate`; the day becomes the end of that day in Vietnamese time. */
export function createBody(form: CreateForm, acknowledged: boolean): Record<string, unknown> {
  return {
    allocation_line_id: form.lineId.trim().toLowerCase(),
    amount_vnd: form.amount.trim().replace(/[.,\s]/g, ''),
    purpose: form.purpose,
    expires_at: new Date(`${form.expiresOn.trim()}T23:59:59+07:00`).toISOString(),
    ...(form.referenceKind.trim() === '' ? {} : { reference_kind: form.referenceKind.trim(), reference_id: form.referenceId.trim().toLowerCase() }),
    ...(acknowledged ? { avc_acknowledged: true } : {}),
  };
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type CreateProblem = 'warn' | 'blocked' | 'yearLocked' | 'scopeDenied' | 'notFound' | 'validation' | 'general';

export interface Refusal {
  problem: CreateProblem;
  /** The share the reservation would take, as the server judged it. */
  consumptionPct: string | undefined;
  warnPct: string | undefined;
  blockPct: string | undefined;
}

const PROBLEM_BY_CODE: Readonly<Record<string, CreateProblem>> = {
  AVC_WARNING_ACK_REQUIRED: 'warn',
  AVC_BLOCKED: 'blocked',
  FISCAL_YEAR_LOCKED: 'yearLocked',
  SCOPE_DENIED: 'scopeDenied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

const figure = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export function describeCreate(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return { problem: 'general', consumptionPct: undefined, warnPct: undefined, blockPct: undefined };
  return { problem: PROBLEM_BY_CODE[error.code] ?? 'general', consumptionPct: figure(error.extensions.consumption_pct), warnPct: figure(error.extensions.warn_pct), blockPct: figure(error.extensions.block_pct) };
}

export type ReleaseProblem = 'notActive' | 'stale' | 'scopeDenied' | 'notFound' | 'validation' | 'general';

const RELEASE_BY_CODE: Readonly<Record<string, ReleaseProblem>> = {
  RESERVATION_NOT_ACTIVE: 'notActive',
  VERSION_CONFLICT: 'stale',
  SCOPE_DENIED: 'scopeDenied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

export const describeRelease = (error: unknown): ReleaseProblem => (error instanceof ApiError ? (RELEASE_BY_CODE[error.code] ?? 'general') : 'general');

export const REASON_MIN = 5;
export const REASON_MAX = 2000;
export const validReason = (reason: string): boolean => reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;
