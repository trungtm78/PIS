import { ApiError } from '@machvon/api-client';

/** Permission of the screen (x-permission in openapi.json). */
export const EXPORT_PERMISSION = 'contractor.export';

export const SCOPES = ['PERFORMANCE', 'VIOLATION', 'BOTH'] as const;
export type Scope = (typeof SCOPES)[number];
export const FORMATS = ['CSV', 'JSON'] as const;
export type Format = (typeof FORMATS)[number];
export const STATUSES = ['GENERATED', 'SUBMITTED_EXTERNALLY', 'CONFIRMED', 'FAILED'] as const;
export type Status = (typeof STATUSES)[number];
export const REFERENCE_MAX = 100;
/** The longest period a file covers: five years. */
export const MAX_PERIOD_DAYS = 5 * 366;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], raw: unknown): T | undefined => values.find((value) => value === raw);

export interface Batch {
  id: string;
  scope: Scope;
  periodFrom: string;
  periodTo: string;
  format: Format;
  rows: number;
  sha256: string;
  status: Status;
  submittedRef: string | undefined;
  submittedOn: string | undefined;
  createdAt: string;
}

export interface Adapter {
  state: string;
  api: string;
}

export interface Batches {
  items: Batch[];
  adapter: Adapter;
  nextCursor: string | undefined;
}

function toBatch(raw: unknown): Batch | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const scope = oneOf(SCOPES, raw.scope);
  const format = oneOf(FORMATS, raw.format);
  const status = oneOf(STATUSES, raw.status);
  if (scope === undefined || format === undefined || status === undefined) return undefined;
  return {
    id: raw.id,
    scope,
    periodFrom: text(raw.period_from) ?? '',
    periodTo: text(raw.period_to) ?? '',
    format,
    rows: typeof raw.row_count === 'number' ? raw.row_count : 0,
    sha256: text(raw.file_sha256) ?? '',
    status,
    submittedRef: text(raw.submitted_ref),
    submittedOn: text(raw.submitted_on),
    createdAt: text(raw.created_at) ?? '',
  };
}

export function toBatches(raw: unknown): Batches | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  const adapter = isRecord(raw.adapter) ? raw.adapter : {};
  return { items: raw.items.flatMap((item) => toBatch(item) ?? []), adapter: { state: text(adapter.state) ?? 'PROPOSED', api: text(adapter.api) ?? 'MISSING' }, nextCursor: text(raw.next_cursor) };
}

export interface Download {
  url: string;
  expiresAt: string;
  rows: number;
}

export function toDownload(raw: unknown): Download | undefined {
  if (!isRecord(raw)) return undefined;
  const url = text(raw.url);
  return url === undefined ? undefined : { url, expiresAt: text(raw.expires_at) ?? '', rows: typeof raw.rows === 'number' ? raw.rows : 0 };
}

// ---- forms --------------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'day' | 'order' | 'tooLong' | 'future';

export interface ExportForm {
  scope: Scope;
  from: string;
  to: string;
  format: Format;
}

export const emptyExport = (): ExportForm => ({ scope: 'BOTH', from: '', to: '', format: 'CSV' });

const isDay = (value: string): boolean => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function validateExport(form: ExportForm): Partial<Record<'from' | 'to', FormProblem>> {
  const problems: Partial<Record<'from' | 'to', FormProblem>> = {};
  const from = form.from.trim();
  const to = form.to.trim();
  if (from === '') problems.from = 'required';
  else if (!isDay(from)) problems.from = 'day';
  if (to === '') problems.to = 'required';
  else if (!isDay(to)) problems.to = 'day';
  if (problems.from === undefined && problems.to === undefined && (from > to || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS > MAX_PERIOD_DAYS)) problems.to = 'order';
  return problems;
}

export const exportBody = (form: ExportForm): Record<string, unknown> => ({ scope: form.scope, period_from: form.from.trim(), period_to: form.to.trim(), format: form.format });

export interface SubmissionForm {
  reference: string;
  day: string;
}

export const emptySubmission = (today: string): SubmissionForm => ({ reference: '', day: today });

export function validateSubmission(form: SubmissionForm, today: string): Partial<Record<'reference' | 'day', FormProblem>> {
  const problems: Partial<Record<'reference' | 'day', FormProblem>> = {};
  const reference = form.reference.trim();
  if (reference === '') problems.reference = 'required';
  else if (reference.length > REFERENCE_MAX) problems.reference = 'tooLong';
  const day = form.day.trim();
  if (day === '') problems.day = 'required';
  else if (!isDay(day)) problems.day = 'day';
  else if (day > today) problems.day = 'future';
  return problems;
}

export const submissionBody = (form: SubmissionForm): Record<string, unknown> => ({ submitted_ref: form.reference.trim(), submitted_on: form.day.trim() });

// ---- refusals -----------------------------------------------------------------------------------------------------------------------

export type Problem = 'empty' | 'tooMany' | 'state' | 'validation' | 'denied' | 'notFound' | 'session' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, Problem>> = {
  EXPORT_EMPTY: 'empty',
  EXPORT_ROW_CAP_EXCEEDED: 'tooMany',
  EXPORT_STATE_INVALID: 'state',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export const describeProblem = (error: unknown): Problem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

/** The error the screen shows for a read: one that has nothing loaded shows any error; one that has something shows only a refusal and keeps what it has through a break in the network. */
export const shownError = (error: unknown, loaded: boolean): unknown => {
  if (error === null || error === undefined) return undefined;
  return !loaded || (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) ? error : undefined;
};

/** The link the server returned is a path of the API: it is resolved against the base the web app calls the API on. */
export function linkOf(path: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
