import type { components } from '@machvon/contracts';
import { cellId } from './model';
import type { ReportDetail, ReportLine, ReportStatus } from './model';
import type { DecisionEntry } from './detail-parts';
import { cellOfFinding } from './step-model';

/** The words of the screens of the weekly report that are neither a request nor a rule of the server: the deadline and the countdown, the progress of the period, the figures of the list, the status strip of the form and the receipt. */

type Tone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** The permission that hands a draft in; the server decides again and keeps the maker and the checker apart. */
export const SUBMIT_PERMISSION = 'report.submit';

type Mode = 'FULL' | 'READ_ONLY' | undefined;

/** A draft is handed in by a holder of the permission to submit, in a tenant that is not read only. */
export const canSubmit = (permissions: readonly string[] | undefined, mode: Mode, status: ReportStatus): boolean => status === 'DRAFT' && (permissions === undefined || permissions.includes(SUBMIT_PERMISSION)) && mode !== 'READ_ONLY';

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const vietnamDay = (instant: number): number => Math.floor((instant + VIETNAM_OFFSET_MS) / DAY_MS);

export interface DeadlineView {
  /** `open` while the deadline is ahead, `late` once it has passed. */
  kind: 'open' | 'late';
  /** Calendar days (Vietnam time) between now and the deadline: days left when open (0 is today), days late when late (0 is the same day). */
  days: number;
  tone: Tone;
}

/** The deadline of a period as a person counts it, in whole calendar days of the Vietnam clock: no seconds, so that nothing on the screen ticks. */
export function deadlineOf(deadlineAt: string, now: number): DeadlineView | undefined {
  const due = Date.parse(deadlineAt);
  if (Number.isNaN(due)) return undefined;
  if (now >= due) return { kind: 'late', days: vietnamDay(now) - vietnamDay(due), tone: 'danger' };
  const days = vietnamDay(due) - vietnamDay(now);
  return { kind: 'open', days, tone: days <= 1 ? 'warning' : 'default' };
}

/** `HH:mm dd/MM/yyyy` in Vietnam time; the text as given when it is not a moment. */
export function dueMoment(instant: string): string {
  const moment = new Date(instant);
  if (Number.isNaN(moment.getTime())) return instant;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(moment);
  const part = (type: string): string => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} ${part('day')}/${part('month')}/${part('year')}`;
}

export interface PeriodProgressView {
  sent: number;
  total: number;
  missing: number;
  percent: number | null;
}

/** How many of the projects that must report have handed in; with none that must report there is no percentage to give. */
export function periodProgressOf(counts: { mustReport: number; submitted: number }): PeriodProgressView {
  const total = counts.mustReport;
  const sent = Math.min(counts.submitted, total);
  return { sent, total, missing: total - sent, percent: total === 0 ? null : Math.round((sent * 100) / total) };
}

/** The shortcuts above the list: what is still a draft and what was sent back. Each is a status the server filters by. */
export const QUICK_FILTERS = [
  { key: 'DRAFT', status: 'DRAFT' },
  { key: 'RETURNED', status: 'RETURNED' },
] as const;
export type QuickStatus = (typeof QUICK_FILTERS)[number]['status'];

/** The tone of the status pill of a report. */
export function statusTone(status: ReportStatus): Tone {
  switch (status) {
    case 'ACCEPTED':
      return 'success';
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return 'info';
    case 'RETURNED':
    case 'AMENDMENT_REQUESTED':
      return 'warning';
    case 'DRAFT':
      return 'neutral';
    case 'WITHDRAWN':
    case 'SUPERSEDED':
      return 'neutral';
  }
}

/** Whole dong as billions with two decimals and a comma ("1.250.000.000" is "1,25"); the exact figure is always given next to it, so nothing is lost by the shorter form. */
export function billionsOf(vnd: string): string {
  const negative = vnd.startsWith('-');
  const value = BigInt(negative ? vnd.slice(1) : vnd);
  const hundredths = (value * 100n + 500_000_000n) / 1_000_000_000n;
  const whole = (hundredths / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return `${negative && hundredths !== 0n ? '-' : ''}${whole},${fraction}`;
}

/** The two totals of the rows that are shown: what a page of the list adds up to, and nothing about the pages that are not shown. */
export function totalsOfLines(lines: readonly ReportLine[]): { cumulativeVnd: string; ctmtqgVnd: string } {
  let cumulative = 0n;
  let ctmtqg = 0n;
  for (const line of lines) {
    cumulative += BigInt(line.cumulativeVnd);
    ctmtqg += BigInt(line.ctmtqgVnd);
  }
  return { cumulativeVnd: cumulative.toString(), ctmtqgVnd: ctmtqg.toString() };
}

/** The share of the amount that is disbursed under the plan, in percent with one decimal; none when there is no plan to compare with. */
export function ratioOf(partVnd: string, wholeVnd: string): string | null {
  const whole = BigInt(wholeVnd);
  if (whole === 0n) return null;
  const tenths = (BigInt(partVnd) * 1000n + whole / 2n) / whole;
  return `${(tenths / 10n).toString()},${(tenths % 10n).toString()}`;
}

export interface ReturnedView {
  reason: string;
  items: string[];
  dueAt: string | null;
  decidedAt: string;
}

/** What the reviewer said when the report was sent back: the latest decision that returned it, or the reason the report carries. */
export function returnedOf(detail: Pick<ReportDetail, 'status' | 'returnedReason' | 'decisions'>): ReturnedView | undefined {
  if (detail.status !== 'RETURNED' && detail.status !== 'AMENDMENT_REQUESTED' && detail.returnedReason === null) return undefined;
  const decisions: readonly DecisionEntry[] = detail.decisions;
  const last = [...decisions].reverse().find((entry) => entry.decision === 'RETURNED' || entry.decision === 'AMENDMENT_REQUESTED');
  const reason = last?.reason ?? detail.returnedReason;
  if (reason === null || reason === undefined) return undefined;
  return { reason, items: last?.returnItems ?? [], dueAt: last?.dueAt ?? null, decidedAt: last?.decidedAt ?? '' };
}

/** The cells the review of the report marks, by `cellId`: an error or a warning that names a cell puts a mark on it. */
export function markedCells(detail: Pick<ReportDetail, 'review'>): Set<string> {
  const marked = new Set<string>();
  const findings = [...(detail.review?.errors ?? []), ...(detail.review?.warnings ?? [])];
  for (const finding of findings) {
    const cell = cellOfFinding(finding);
    if (cell !== undefined) marked.add(cellId(cell));
  }
  return marked;
}

/** The first thing a person has to do with a form, for the strip on top: put right what was sent back, go on with the draft, or nothing (it was handed in). */
export type NextStep = 'fixReturned' | 'finishDraft' | 'wait' | 'done';

export function nextStepOf(status: ReportStatus): NextStep {
  switch (status) {
    case 'RETURNED':
    case 'AMENDMENT_REQUESTED':
      return 'fixReturned';
    case 'DRAFT':
      return 'finishDraft';
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return 'wait';
    case 'ACCEPTED':
    case 'WITHDRAWN':
    case 'SUPERSEDED':
      return 'done';
  }
}

export type SubmitResult = components['schemas']['DisReportSubmitResult'];

export interface Receipt {
  /** The code of the receipt, taken from the seal of the report so that the same report always gives the same code. */
  code: string;
  submittedAt: string;
  isLate: boolean;
  payloadHash: string;
  /** What the period moved by with this report (the total of the six cells less the period before), none for the first report. */
  periodDeltaVnd: string | null;
  warnings: number;
}

const HASH = /^[0-9a-f]{8,}$/i;

/** The receipt of a report that was handed in, from the answer of the server; none when the answer is not one. */
export function receiptOf(raw: unknown): Receipt | undefined {
  const row = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const hash = row?.payload_hash;
  const submittedAt = row?.submitted_at;
  if (row === undefined || typeof hash !== 'string' || !HASH.test(hash) || typeof submittedAt !== 'string') return undefined;
  const delta = row.period_delta_vnd;
  return {
    code: `BN-${hash.slice(0, 8).toUpperCase()}`,
    submittedAt,
    isLate: row.is_late === true,
    payloadHash: hash,
    periodDeltaVnd: typeof delta === 'string' && /^-?[0-9]{1,24}$/.test(delta) ? delta : null,
    warnings: Array.isArray(row.warnings) ? row.warnings.length : 0,
  };
}

/** A cell of a file that a spreadsheet opens: quoted, and a text that would be read as a formula is put in front of a quote mark so that it stays text. */
const csvCell = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** The rows of a table as a file the spreadsheet opens with the right letters: a byte order mark first, then the rows with the Windows line end. */
export function csvOf(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
