import { ApiError } from '@machvon/api-client';

export const CATEGORIES = ['ACCESS', 'DATA', 'BILLING', 'INCIDENT', 'HOWTO', 'OTHER'] as const;
export type Category = (typeof CATEGORIES)[number];
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const STATUSES = ['Open', 'InProgress', 'WaitingCustomer', 'Resolved', 'Closed'] as const;
export type Status = (typeof STATUSES)[number];
/** The statuses in which the operator still owes an answer: a ticket past its SLA in one of them is overdue. */
const WAITING_ON_OPERATOR: readonly Status[] = ['Open', 'InProgress'];

export const SUBJECT_MIN = 5;
export const SUBJECT_MAX = 200;
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 10_000;

const TIME_ZONE = 'Asia/Ho_Chi_Minh';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <Value extends string>(list: readonly Value[], value: unknown): Value | undefined => list.find((candidate) => candidate === value);

/** One support ticket as the list gives it: the metadata and the SLA, never what the member wrote. */
export interface TicketView {
  id: string;
  code: string;
  category: Category;
  subject: string;
  priority: Priority;
  status: Status;
  slaDueAt: string;
  createdAt: string;
  attachmentCount: number;
  /** Whether the caller asked for it (someone who manages support on the whole tenant also sees the tickets of others). */
  own: boolean;
  version: number;
}

export function toTicket(raw: unknown): TicketView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const code = text(raw.ticket_code);
  const category = oneOf(CATEGORIES, raw.category);
  const subject = text(raw.subject);
  const priority = oneOf(PRIORITIES, raw.priority);
  const status = oneOf(STATUSES, raw.status);
  const slaDueAt = text(raw.sla_due_at);
  const createdAt = text(raw.created_at);
  const version = whole(raw.version);
  if (id === undefined || code === undefined || category === undefined || subject === undefined || priority === undefined || status === undefined) return undefined;
  if (slaDueAt === undefined || createdAt === undefined || version === undefined) return undefined;
  return { id, code, category, subject, priority, status, slaDueAt, createdAt, attachmentCount: whole(raw.attachment_count) ?? 0, own: raw.own === true, version };
}

/** `dd/mm/yyyy hh:mm` in Vietnam time, the clock the SLA is judged by; the text as given when it is not a moment. */
export function formatInstant(instant: string): string {
  const moment = new Date(instant);
  if (Number.isNaN(moment.getTime())) return instant;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(moment);
  const part = (type: string): string => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}

/** Whether the operator still owes an answer and the time for it has passed. */
export const isOverdue = (ticket: Pick<TicketView, 'status' | 'slaDueAt'>, now: Date): boolean =>
  WAITING_ON_OPERATOR.includes(ticket.status) && new Date(ticket.slaDueAt).getTime() < now.getTime();

// ---- the form ---------------------------------------------------------------------------------------------------------

export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidText';
export type TicketField = 'subject' | 'description';

export interface TicketForm {
  category: Category;
  subject: string;
  description: string;
}

export const EMPTY_FORM: TicketForm = { category: 'HOWTO', subject: '', description: '' };
export type TicketErrors = Partial<Record<TicketField, FieldProblem>>;

const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const DELETE = 127;

/** Whether the text holds a control character; with `lineBreaks`, tabs and line breaks are allowed (a description spans lines). */
function hasControl(value: string, lineBreaks: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (lineBreaks && (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN)) continue;
    if (code < SPACE || code === DELETE) return true;
  }
  return false;
}

function check(value: string, min: number, max: number, lineBreaks: boolean): FieldProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  if (trimmed.length < min) return 'tooShort';
  if (trimmed.length > max) return 'tooLong';
  return hasControl(trimmed, lineBreaks) ? 'invalidText' : undefined;
}

export function validateTicket(form: TicketForm): TicketErrors {
  const errors: TicketErrors = {};
  const subject = check(form.subject, SUBJECT_MIN, SUBJECT_MAX, false);
  if (subject !== undefined) errors.subject = subject;
  const description = check(form.description, DESCRIPTION_MIN, DESCRIPTION_MAX, true);
  if (description !== undefined) errors.description = description;
  return errors;
}

export const hasErrors = (errors: TicketErrors): boolean => Object.keys(errors).length > 0;

export interface TicketBody {
  category: Category;
  subject: string;
  description: string;
}

/** The body of createSupportTicket: the allowlist of the contract, trimmed. The priority and the SLA are the server's. */
export const ticketBody = (form: TicketForm): TicketBody => ({ category: form.category, subject: form.subject.trim(), description: form.description.trim() });

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type ProblemReason = 'validation' | 'denied' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: TicketField | undefined;
}

const FIELD_OF_DETAIL: Readonly<Record<string, TicketField>> = { subject: 'subject', description: 'description' };

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  if (error.code === 'VALIDATION_FAILED' || error.code === 'FIELD_NOT_ALLOWED' || error.code === 'INVALID_REQUEST') return { reason: 'validation', field: error.detail === undefined ? undefined : FIELD_OF_DETAIL[error.detail] };
  if (error.code === 'SCOPE_DENIED' || error.code === 'PERMISSION_DENIED') return { reason: 'denied', field: undefined };
  return { reason: 'general', field: undefined };
}

export const SUPPORT_CREATE_PERMISSION = 'support.ticket.create';
