import { ApiError } from '@machvon/api-client';
import type { HandoverLine } from '../handover/model';

/** AST-07: the trigger of the evaluation after the investment (ST-AST-006, AST 3.4, UC-AST-04, UAT-AC394). The server judges every request again. */
export const MANAGE_PERMISSION = 'evaluation.trigger.manage';

export const KINDS = ['POST_HANDOVER_12M', 'POST_HANDOVER_24M', 'SETTLEMENT_CLOSED', 'MANUAL'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['SCHEDULED', 'FIRED', 'ACKNOWLEDGED', 'CANCELLED'] as const;
export type Status = (typeof STATUSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS_AFTER: Readonly<Partial<Record<Kind, number>>> = { POST_HANDOVER_12M: 12, POST_HANDOVER_24M: 24 };

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

export interface TriggerLine {
  id: string;
  kind: Kind;
  handover: { id: string; handoverNo: string | null; acceptedOn: string | null } | null;
  dueOn: string;
  status: Status;
  firedAt: string | null;
  evaluation: { id: string; kind: string; status: string } | null;
  version: number;
}

export function toTrigger(raw: unknown): TriggerLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const kind = oneOf(KINDS, row?.trigger_kind);
  const status = oneOf(STATUSES, row?.status);
  const dueOn = text(row?.due_on);
  if (row === undefined || id === undefined || kind === undefined || status === undefined || dueOn === undefined) return undefined;
  const handover = asRecord(row.handover);
  const handoverId = text(handover?.id);
  const evaluation = asRecord(row.evaluation);
  const evaluationId = text(evaluation?.id);
  return {
    id,
    kind,
    handover: handoverId === undefined ? null : { id: handoverId, handoverNo: nullableText(handover?.handover_no), acceptedOn: nullableText(handover?.accepted_on) },
    dueOn,
    status,
    firedAt: nullableText(row.fired_at),
    evaluation: evaluationId === undefined ? null : { id: evaluationId, kind: text(evaluation?.evaluation_kind) ?? '', status: text(evaluation?.status) ?? '' },
    version: typeof row.version === 'number' ? row.version : 0,
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const canManage = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';

// ---- the days ------------------------------------------------------------------------------------------------------------------

const pad = (value: number): string => String(value).padStart(2, '0');

/** A calendar day written YYYY-MM-DD that exists. */
export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The day plus a number of months, the last day of the month when that month is shorter (as the server counts it). */
export function addMonths(day: string, months: number): string {
  const match = DAY.exec(day);
  const [year, month, date] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index % 12;
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(date, last))}`;
}

/** The day in Vietnam of a moment given as a timestamp. */
export function vietnamDay(timestamp: string): string | undefined {
  const moment = Date.parse(timestamp);
  return Number.isNaN(moment) ? undefined : new Date(moment + 7 * 3_600_000).toISOString().slice(0, 10);
}

export const isPostHandover = (kind: string): boolean => MONTHS_AFTER[kind as Kind] !== undefined;

/** The earliest day a trigger after a handover may fall due: 12 or 24 months after the day the handover was accepted; undefined for the other kinds. */
export function earliestDue(kind: string, acceptedOn: string): string | undefined {
  const months = MONTHS_AFTER[kind as Kind];
  return months === undefined ? undefined : addMonths(acceptedOn, months);
}

// ---- the handovers the form offers ---------------------------------------------------------------------------------------------

export interface AcceptedHandover {
  id: string;
  handoverNo: string;
  acceptedOn: string;
}

/** The accepted handovers of the project, with the day each was accepted (in Vietnam): what a trigger after a handover can follow. */
export function acceptedHandovers(lines: readonly HandoverLine[], projectId: string): AcceptedHandover[] {
  return lines.flatMap((line) => {
    const acceptedOn = line.acceptedAt === null ? undefined : vietnamDay(line.acceptedAt);
    return line.status === 'ACCEPTED' && line.projectId === projectId && acceptedOn !== undefined ? [{ id: line.id, handoverNo: line.handoverNo, acceptedOn }] : [];
  });
}

// ---- the form ------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid' | 'early';
export type FormField = 'kind' | 'handover' | 'dueOn';

export interface ScheduleForm {
  kind: string;
  handoverId: string;
  dueOn: string;
}

export const EMPTY_FORM: ScheduleForm = { kind: '', handoverId: '', dueOn: '' };

export function validateSchedule(form: ScheduleForm, handovers: readonly AcceptedHandover[]): Partial<Record<FormField, FormProblem>> {
  const found: Partial<Record<FormField, FormProblem>> = {};
  const handover = handovers.find((candidate) => candidate.id === form.handoverId);
  if (form.kind === '') found.kind = 'required';
  else if (oneOf(KINDS, form.kind) === undefined) found.kind = 'invalid';
  if (isPostHandover(form.kind) && form.handoverId === '') found.handover = 'required';
  else if (form.handoverId !== '' && handover === undefined) found.handover = 'invalid';
  if (form.dueOn.trim() === '') found.dueOn = 'required';
  else if (!isDay(form.dueOn.trim())) found.dueOn = 'invalid';
  else if (handover !== undefined) {
    const earliest = earliestDue(form.kind, handover.acceptedOn);
    if (earliest !== undefined && form.dueOn.trim() < earliest) found.dueOn = 'early';
  }
  return found;
}

/** The body of the command for a form that passed `validateSchedule`. */
export function scheduleBody(form: ScheduleForm): Record<string, unknown> {
  return { trigger_kind: form.kind, due_on: form.dueOn.trim(), ...(form.handoverId === '' ? {} : { source_handover_id: form.handoverId }) };
}

export const isEvaluationId = (value: string): boolean => UUID.test(value.trim());

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type Problem =
  | 'duplicate'
  | 'stage'
  | 'notAccepted'
  | 'early'
  | 'past'
  | 'otherProject'
  | 'state'
  | 'evaluationMissing'
  | 'evaluationOther'
  | 'scopeDenied'
  | 'notFound'
  | 'validation'
  | 'general';

export interface Refusal {
  problem: Problem;
  /** The earliest day the server will accept, when it refused the day. */
  earliest: string | undefined;
}

const BY_CODE: Readonly<Record<string, Problem>> = {
  TRIGGER_DUPLICATE: 'duplicate',
  PROJECT_STAGE_INVALID: 'stage',
  HANDOVER_NOT_ACCEPTED: 'notAccepted',
  TRIGGER_STATE_INVALID: 'state',
  SCOPE_DENIED: 'scopeDenied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

const BY_REASON: Readonly<Record<string, Problem>> = {
  BEFORE_EARLIEST: 'early',
  IN_THE_PAST: 'past',
  NOT_A_HANDOVER_OF_THE_PROJECT: 'otherProject',
  NOT_FOUND: 'evaluationMissing',
  NOT_AN_EVALUATION_OF_THE_PROJECT: 'evaluationOther',
};

export function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return { problem: 'general', earliest: undefined };
  const reason = text(error.extensions.reason);
  const problem = (error.code === 'VALIDATION_FAILED' && reason !== undefined ? BY_REASON[reason] : undefined) ?? BY_CODE[error.code] ?? 'general';
  return { problem, earliest: text(error.extensions.earliest_due_on) };
}
