import { DomainError } from './errors.ts';
import { isWorkingDay } from './working-time.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * Incoming documents (ST-DOC-011, DOC.md F10, BR-DOC-18, BR-DOC-20): a letter that arrives is received, registered in the incoming register (which gives it its number), assigned to a unit and a handler with a
 * deadline, processed and resolved, and filed; a letter that should not be kept is rejected before it is registered. Nobody skips a step and nobody works a letter that was not assigned to them.
 */
export const INCOMING_STATUSES = ['RECEIVED', 'REGISTERED', 'ASSIGNED', 'PROCESSING', 'RESOLVED', 'FILED', 'REJECTED'] as const;
export type IncomingStatus = (typeof INCOMING_STATUSES)[number];
export const INCOMING_CHANNELS = ['PAPER_SCAN', 'EMAIL', 'LGSP', 'PORTAL', 'UPLOAD'] as const;
export type IncomingChannel = (typeof INCOMING_CHANNELS)[number];
export const INCOMING_URGENCIES = ['NORMAL', 'KHAN', 'THUONG_KHAN', 'HOA_TOC'] as const;
export type IncomingUrgency = (typeof INCOMING_URGENCIES)[number];

export const INCOMING_COMMANDS = ['register', 'assign', 'startProcessing', 'resolve', 'reject', 'file'] as const;
export type IncomingCommand = (typeof INCOMING_COMMANDS)[number];

/** Where each command may be taken from and where it leads. `assign` is also the reassignment: from ASSIGNED or PROCESSING it keeps the history and sends the letter back to ASSIGNED. */
const TRANSITIONS: Readonly<Record<IncomingCommand, { from: readonly IncomingStatus[]; to: IncomingStatus }>> = {
  register: { from: ['RECEIVED'], to: 'REGISTERED' },
  assign: { from: ['REGISTERED', 'ASSIGNED', 'PROCESSING'], to: 'ASSIGNED' },
  startProcessing: { from: ['ASSIGNED'], to: 'PROCESSING' },
  resolve: { from: ['PROCESSING'], to: 'RESOLVED' },
  reject: { from: ['RECEIVED'], to: 'REJECTED' },
  file: { from: ['RESOLVED'], to: 'FILED' },
};

/** 409 `DOCUMENT_STATE_INVALID` unless the command applies to the letter as it stands. */
export function assertIncomingTransition(command: IncomingCommand, status: IncomingStatus): IncomingStatus {
  const rule = TRANSITIONS[command];
  if (!rule.from.includes(status)) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status', { extensions: { incoming_status: status } });
  return rule.to;
}

/** Whether a letter is still to be worked, and so can be overdue. */
export const isWorkable = (status: IncomingStatus): boolean => status === 'ASSIGNED' || status === 'PROCESSING';

// ---- state secrets (BR-DOC-20) -----------------------------------------------------------------------------------------------------

// The combining marks (U+0300 to U+036F) that NFD splits off the letters.
const STRIP_MARKS = /[\u0300-\u036f]/g;
/** The text without marks and with the letters that have a stroke written plainly, in capitals: how a marking is compared. */
const fold = (text: string): string => text.normalize('NFD').replace(STRIP_MARKS, '').replace(/\u0111/g, 'd').replace(/\u0110/g, 'D'); // the letters d and D with a stroke

/**
 * A letter that declares a level of state secret ("Mat", "Toi mat", "Tuyet mat": confidential, secret, top secret) is not taken in (422 `STATE_SECRET_NOT_SUPPORTED`): it travels by the channel made for it, outside this system. The declaration is read from the words
 * the clerk typed (the title, the symbol, the sender) as the marking is written on a letter: "TOI MAT" or "TUYET MAT" in capitals (with their marks), and "MAT" in capitals when it names the degree ("Do mat:", "dau do mat", or alone in brackets).
 * A word like "bao mat" (security) or a title in capitals about "mat do" (density) is not a marking.
 */
export function stateSecretMarking(text: string): boolean {
  // The marks are removed and the case is kept, so that "TOI MAT" with or without its marks is the stamp and "Toi mat" in a sentence is not.
  const folded = fold(text.normalize('NFC'));
  if (/(^|[^A-Za-z0-9])(TUYET MAT|TOI MAT)(?![A-Za-z0-9])/.test(folded)) return true;
  if (/(?:DO MAT|Do mat|do mat)\s*[:-]\s*MAT(?![A-Za-z0-9])/.test(folded)) return true;
  return /[([{]\s*MAT\s*[)\]}]/.test(folded);
}

// ---- the duplicate (BR-DOC-18) -----------------------------------------------------------------------------------------------------

/** What makes two letters the same letter: the sender, the symbol they wrote and the day on it, compared without case, marks and spaces. */
export function incomingIdentity(input: { senderName: string; originalSymbol: string | undefined; originalIssuedOn: string | undefined }): string | undefined {
  if (input.originalSymbol === undefined || input.originalIssuedOn === undefined) return undefined;
  const squash = (text: string): string => fold(text.normalize('NFC')).toUpperCase().replace(/\s+/g, ' ').trim();
  return `${squash(input.senderName)}|${squash(input.originalSymbol)}|${input.originalIssuedOn}`;
}

// ---- the deadline (BR-DOC-18) ------------------------------------------------------------------------------------------------------

const isoOf = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);
const dayOf = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
/** A year beyond this many days of lateness is a mistake of the data and is not counted further. */
const MAX_LATE_SCAN_DAYS = 3660;

/**
 * How many working days late a letter is: the working days after the deadline, up to and including `today` (the deadline day itself is not late). A letter due on Tuesday the 27th is one day late on the 28th. A year without a
 * published calendar is counted by the weekdays alone (Monday to Friday), because a reminder must not wait for a calendar. Zero when it is not late.
 */
export function workingDaysLate(dueOn: string, today: string, calendars: WorkCalendarSource | undefined): number {
  const due = dayOf(dueOn);
  const end = dayOf(today);
  if (end <= due) return 0;
  let late = 0;
  for (let step = 1; step <= Math.min(end - due, MAX_LATE_SCAN_DAYS); step += 1) {
    const date = isoOf(due + step);
    const calendar = calendars?.forYear(Number(date.slice(0, 4)));
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const worked = calendar === undefined ? weekday !== 0 && weekday !== 6 : isWorkingDay(calendar, date);
    if (worked) late += 1;
  }
  return late;
}
