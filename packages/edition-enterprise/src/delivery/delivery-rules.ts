import { DomainError, hasControlCharExceptWhitespace, parseCron, scheduleDue } from '@machvon/kernel';
import type { ChannelSendResult } from '@machvon/kernel';
import { textsOf } from '../report-forms/texts.ts';

/**
 * The scheduled delivery of issued report forms by e-mail (ENT-4d, HSKT BC.02 "ho tro gui bao cao tu dong qua email theo lich"): the pure rules. A schedule names a form (the layout code), a five-field cron, a file format,
 * the members who receive it and a note. On its time the runner sends every ISSUED head copy of the form that was issued after the schedule was made to every recipient, once: the unique key of the log is
 * (schedule, copy, recipient). The attachment is the issued file itself, its SHA-256 is in the message, a copy made on a DEMO form is never sent (R18), a correction (a later revision) is a new copy and is sent as one.
 * No clock, no database, no network here.
 */

export const DELIVERY_FORMATS = ['XLSX', 'DOCX', 'PDF'] as const;
export type DeliveryFormat = (typeof DELIVERY_FORMATS)[number];
export const DELIVERY_STATUSES = ['SENT', 'FAILED', 'REFUSED', 'UNKNOWN', 'SKIPPED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_MAX_RECIPIENTS = 50;
export const DELIVERY_MAX_NOTE = 1000;
/** A send that failed for a reason that may pass (the relay was busy) is tried again on the next runs, up to this many attempts in all. */
export const DELIVERY_MAX_ATTEMPTS = 3;
/** How many head copies one run of one schedule takes up (the oldest first), so a schedule made over a long backlog is delivered over several runs. */
export const DELIVERY_BATCH = 20;
export const DELIVERY_MEDIA_TYPES: Readonly<Record<DeliveryFormat, string>> = {
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PDF: 'application/pdf',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAYOUT = /^[A-Za-z0-9._-]{2,80}$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface DeliveryScheduleRequest {
  layoutCode: string;
  cron: string;
  format: DeliveryFormat;
  recipients: string[];
  note: string | null;
}

/** The request to make a schedule, judged: the cron by the kernel's own parser (409 `CRON_INVALID` naming the field), the recipients one to fifty distinct ids, the note one to a thousand characters without control characters. */
export function scheduleRequestOf(body: Record<string, unknown>): DeliveryScheduleRequest {
  const layoutCode = body.layout_code;
  if (typeof layoutCode !== 'string' || !LAYOUT.test(layoutCode)) throw invalid('layout_code');
  const cron = body.cron;
  if (typeof cron !== 'string' || cron !== cron.trim() || cron.length < 9 || cron.length > 120) throw invalid('cron');
  parseCron(cron);
  const format = DELIVERY_FORMATS.find((candidate) => candidate === body.format);
  if (format === undefined) throw invalid('format');
  const recipients = body.recipients;
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > DELIVERY_MAX_RECIPIENTS || recipients.some((id) => typeof id !== 'string' || !UUID.test(id))) throw invalid('recipients');
  const normalized = (recipients as string[]).map((id) => id.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw invalid('recipients');
  const note = body.note;
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string' || note.trim().length < 1 || note.length > DELIVERY_MAX_NOTE || hasControlCharExceptWhitespace(note)) throw invalid('note');
  }
  return { layoutCode, cron, format, recipients: normalized, note: typeof note === 'string' ? note.trim() : null };
}

/** The time zone of every schedule: the one of Vietnam, as the schedules of BI (BI.md F7). */
export const DELIVERY_TIMEZONE = 'Asia/Ho_Chi_Minh';

/** Whether the schedule is due: its next fire after its last run (or after it was made) has come. */
export function deliveryDue(schedule: { cron: string; timezone: string; lastRunAt: string | null; createdAt: string }, now: Date): boolean {
  return scheduleDue(parseCron(schedule.cron), new Date(schedule.lastRunAt ?? schedule.createdAt), now, schedule.timezone);
}

export interface IssuedHead {
  id: string;
  layoutCode: string;
  periodCode: string;
  revision: number;
  countsAsAccepted: boolean;
  issuedAt: string;
  xlsxSha256: string;
  docxSha256: string | null;
}

/** A row of the log as the decision needs it. */
export interface HeldDelivery {
  status: DeliveryStatus;
  attempts: number;
}

export type DeliveryDecision =
  | { kind: 'SEND' }
  /** Not sent now and not sent later either: the reason is recorded once (the log is the answer to "why did I not get it"). */
  | { kind: 'SKIP'; reason: 'DEMO_FORM' | 'FORMAT_UNAVAILABLE' }
  /** Nothing to do for this recipient: already sent, or refused for good, or the send is in doubt and never repeated on its own, or the attempts are used. */
  | { kind: 'DONE' };

/**
 * What to do with one (copy, recipient): copies issued before the schedule was made are history and are not sent (`DONE`, nothing is written); a copy of a DEMO form is skipped with its reason; a format the copy does
 * not have (a form with no Word narrative asked in DOCX) is skipped with its reason; a delivery that was SENT, REFUSED, SKIPPED or UNKNOWN is done; one that FAILED is tried again until the attempts are used.
 */
export function decideDelivery(input: { copy: IssuedHead; format: DeliveryFormat; scheduleCreatedAt: string; held: HeldDelivery | undefined; pdfAvailable: boolean }): DeliveryDecision {
  const { copy, held } = input;
  if (Date.parse(copy.issuedAt) < Date.parse(input.scheduleCreatedAt)) return { kind: 'DONE' };
  if (held !== undefined) return held.status === 'FAILED' && held.attempts < DELIVERY_MAX_ATTEMPTS ? { kind: 'SEND' } : { kind: 'DONE' };
  if (!copy.countsAsAccepted) return { kind: 'SKIP', reason: 'DEMO_FORM' };
  if ((input.format === 'DOCX' && copy.docxSha256 === null) || (input.format === 'PDF' && !input.pdfAvailable)) return { kind: 'SKIP', reason: 'FORMAT_UNAVAILABLE' };
  return { kind: 'SEND' };
}

export interface DeliveryOutcome {
  status: Exclude<DeliveryStatus, 'SKIPPED'>;
  errorCode: string | null;
  providerMessageId: string | null;
}

/** What the channel said, as the log keeps it: accepted is SENT; a failure that may pass is FAILED (tried again); a failure for good is REFUSED; a lost answer is UNKNOWN and never repeated on its own. */
export function outcomeOf(result: ChannelSendResult): DeliveryOutcome {
  if (result.kind === 'ACCEPTED') return { status: 'SENT', errorCode: null, providerMessageId: result.providerMessageId };
  if (result.kind === 'UNKNOWN') return { status: 'UNKNOWN', errorCode: result.errorCode, providerMessageId: null };
  return { status: result.failureClass === 'RETRYABLE' ? 'FAILED' : 'REFUSED', errorCode: result.errorCode, providerMessageId: null };
}

interface DeliveryTexts {
  subject: string;
  greeting: string;
  intro: string;
  correction: string;
  file: string;
  hash: string;
  noteLead: string;
  closing: string;
}
const fill = (template: string, values: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));

export interface DeliveryMessageInput {
  formName: string;
  periodCode: string;
  revision: number;
  issuedOn: string;
  fileName: string;
  fileSha256: string;
  note: string | null;
}

/** The subject and the text of the message: what was issued, the file, and its SHA-256 so that the recipient can check the file they hold against the copy the system keeps. */
export function deliveryMessage(input: DeliveryMessageInput): { subject: string; text: string } {
  const texts = textsOf<DeliveryTexts>('delivery');
  const values = { form: input.formName, period: input.periodCode, revision: input.revision, issuedOn: input.issuedOn, fileName: input.fileName, sha256: input.fileSha256 };
  const lines = [texts.greeting, '', fill(texts.intro, values), ...(input.revision > 1 ? [texts.correction] : []), fill(texts.file, values), fill(texts.hash, values)];
  if (input.note !== null) lines.push('', texts.noteLead, input.note);
  lines.push('', texts.closing);
  return { subject: fill(texts.subject, values), text: lines.join('\n') };
}
