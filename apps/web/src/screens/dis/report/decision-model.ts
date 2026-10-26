import type { components } from '@machvon/contracts';
import { CELLS, cellId } from './model';
import type { FundingForm, ReportDetail, ReportStatus } from './model';
import { digitsOf } from './money';

/** DIS-07 the detail of a report with the decision of its reviewer, DIS-08 the correction of a report, DIS-11 the history of its revisions and their comparison (ST-DIS-006, DIS 3 F2). */
export const DETAIL_PATH = '/dis/dis-07';
export const CORRECTION_PATH = '/dis/dis-08';
export const HISTORY_PATH = '/dis/dis-11';

/** The permissions that gate the buttons; the server decides again on every request. */
export const REVIEW_PERMISSION = 'report.review';
export const CORRECT_PERMISSION = 'report.correct';

type Mode = 'FULL' | 'READ_ONLY' | undefined;

/** The statuses a reviewer approves or returns a report in, and the one a reviewer asks an accepted report to be amended in. */
const DECIDABLE: readonly ReportStatus[] = ['SUBMITTED', 'UNDER_REVIEW'];
/** The statuses a correction starts from. */
const CORRECTABLE: readonly ReportStatus[] = ['ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED'];

const allowed = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** The buttons of the reviewer: accept or return a report that was handed in. */
export const canDecide = (permissions: readonly string[] | undefined, mode: Mode, status: ReportStatus): boolean => DECIDABLE.includes(status) && allowed(permissions, REVIEW_PERMISSION, mode);
/** The reviewer asks the amendment of a report that was accepted and is the one current. */
export const canAskAmendment = (permissions: readonly string[] | undefined, mode: Mode, detail: ReportDetail): boolean => detail.status === 'ACCEPTED' && detail.isCurrent && allowed(permissions, REVIEW_PERMISSION, mode);
/** The maker answers a decision with a new revision. */
export const canCorrect = (permissions: readonly string[] | undefined, mode: Mode, status: ReportStatus): boolean => CORRECTABLE.includes(status) && allowed(permissions, CORRECT_PERMISSION, mode);

export type DecisionKindChoice = 'approve' | 'return' | 'request_amendment';

/** What a reviewer writes: the decision, the reason, the items to fix (one a line) and the day they are due. */
export interface DecisionForm {
  kind: DecisionKindChoice;
  reason: string;
  items: string;
  dueOn: string;
}

export const emptyDecision = (kind: DecisionKindChoice): DecisionForm => ({ kind, reason: '', items: '', dueOn: '' });

export type DecisionProblem = 'required' | 'tooLong' | 'itemTooShort' | 'itemTooLong' | 'tooMany' | 'dueRequired' | 'dueInvalid';
export interface DecisionProblems {
  reason?: DecisionProblem;
  items?: DecisionProblem;
  dueOn?: DecisionProblem;
}

const REASON_MAX = 2000;
const ITEM_MIN = 3;
const ITEM_MAX = 2000;
const ITEMS_MAX = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The lines of the items as a reviewer typed them: trimmed, the empty ones left out. */
export const itemsOf = (value: string): string[] => value.split('\n').map((line) => line.trim()).filter((line) => line !== '');

/**
 * What the form can tell before the server does (the server judges the same again): the reason is words, a return names at least one item (3 to 2000 characters, at most 20) and the day it is due;
 * a request for an amendment may name them, but if it names a day it is a date.
 */
export function validateDecision(form: DecisionForm, today: Date): DecisionProblems {
  const problems: DecisionProblems = {};
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length > REASON_MAX) problems.reason = 'tooLong';
  if (form.kind === 'approve') return problems;
  const items = itemsOf(form.items);
  if (items.length === 0 && form.kind === 'return') problems.items = 'required';
  else if (items.length > ITEMS_MAX) problems.items = 'tooMany';
  else if (items.some((item) => item.length < ITEM_MIN)) problems.items = 'itemTooShort';
  else if (items.some((item) => item.length > ITEM_MAX)) problems.items = 'itemTooLong';
  if (form.dueOn === '') {
    if (form.kind === 'return') problems.dueOn = 'dueRequired';
  } else if (!isRealDay(form.dueOn) || endOfDay(form.dueOn) <= today.getTime()) problems.dueOn = 'dueInvalid';
  return problems;
}

/** A day that is on the calendar (the 30th of February is not). */
const isRealDay = (day: string): boolean => {
  const moment = new Date(`${day}T00:00:00Z`);
  return DAY.test(day) && !Number.isNaN(moment.getTime()) && moment.toISOString().slice(0, 10) === day;
};

/** The day is due at the end of it (Vietnam time, UTC+7). */
const endOfDay = (day: string): number => Date.parse(`${day}T23:59:59+07:00`);

export type DecisionBody = components['schemas']['DisReportDecision'];

export function decisionBody(form: DecisionForm): DecisionBody {
  const items = itemsOf(form.items);
  return {
    decision: form.kind,
    reason: form.reason.trim(),
    evidence_ids: [],
    ...(form.kind === 'approve' || items.length === 0 ? {} : { return_items: items }),
    ...(form.kind === 'approve' || form.dueOn === '' ? {} : { due_at: new Date(endOfDay(form.dueOn)).toISOString() }),
  };
}

/** What a maker writes to correct a report: why, the cells as they now are, and the explanation of a fall. */
export interface CorrectionForm {
  reason: string;
  funding: FundingForm;
}

export type CorrectionBody = components['schemas']['DisReportCorrection'];
const AMENDMENT_MIN = 10;
export type ReasonProblem = 'required' | 'tooShort' | 'tooLong';

export function validateReason(reason: string): ReasonProblem | undefined {
  const words = reason.trim();
  if (words === '') return 'required';
  if (words.length < AMENDMENT_MIN) return 'tooShort';
  return words.length > REASON_MAX ? 'tooLong' : undefined;
}

/** The request of a correction: the reason, and only the cells that changed (the others stay as they were), the explanation of a fall when given. */
export function correctionBody(detail: ReportDetail, form: CorrectionForm): CorrectionBody {
  const changed = CELLS.flatMap((key) => {
    const entry = form.funding.cells[cellId(key)];
    const kept = detail.cells.find((cell) => cell.bucket === key.bucket && cell.level === key.level);
    if (entry === undefined || kept === undefined) return [];
    const cumulative = digitsOf(entry.cumulative) ?? kept.cumulativeVnd;
    const subset = entry.ctmtqg.trim() === '' ? null : (digitsOf(entry.ctmtqg) ?? null);
    if (cumulative === kept.cumulativeVnd && subset === kept.ctmtqgVnd) return [];
    return [
      {
        bucket: key.bucket,
        budget_level: key.level,
        cumulative_vnd: cumulative,
        ...(subset === null ? {} : { ctmtqg_subset_vnd: subset }),
        ...(kept.sourceYear === null ? {} : { source_year: kept.sourceYear }),
        next_month_vnd: kept.nextMonthVnd,
        ...(kept.nextMonthCtmtqgVnd === null ? {} : { next_month_ctmtqg_subset_vnd: kept.nextMonthCtmtqgVnd }),
      },
    ];
  });
  const explanation = form.funding.explanation.trim();
  return {
    amendment_reason: form.reason.trim(),
    ...(changed.length === 0 ? {} : { funding_lines: changed }),
    ...(explanation === '' ? {} : { negative_delta_explanation: explanation }),
  };
}

/** One cell of two revisions side by side: what each reported and what the later one changed (a fall is negative, never shown as zero). */
export interface CellComparison {
  bucket: string;
  level: string;
  firstVnd: string;
  secondVnd: string;
  changeVnd: string;
}

export function compareRevisions(first: ReportDetail, second: ReportDetail): CellComparison[] {
  return CELLS.map((key) => {
    const a = first.cells.find((cell) => cell.bucket === key.bucket && cell.level === key.level)?.cumulativeVnd ?? '0';
    const b = second.cells.find((cell) => cell.bucket === key.bucket && cell.level === key.level)?.cumulativeVnd ?? '0';
    return { bucket: key.bucket, level: key.level, firstVnd: a, secondVnd: b, changeVnd: (BigInt(b) - BigInt(a)).toString() };
  });
}

/** The change as a person reads it: a rise has a plus, a fall a minus, no change none. */
export const signed = (value: string): string => (value.startsWith('-') ? value : value === '0' ? value : `+${value}`);

/** `dd/mm/yyyy hh:mm` in Vietnam time, the clock the deadlines of the reports are judged by; the text as given when it is not a moment. */
export function formatMoment(instant: string): string {
  const moment = new Date(instant);
  if (Number.isNaN(moment.getTime())) return instant;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(moment);
  const part = (type: string): string => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}
