import { ApiError } from '@machvon/api-client';
import { computeImpact } from './approval-model';
import type { Impact, ImpactRow } from './approval-model';
import { PLAN_DRAFT_PERMISSION, canDraft, toPlanLine } from './plan-model';
import type { PlanLine, PlanStatus, PlanSummary } from './plan-model';

export { PLAN_DRAFT_PERMISSION as REVISE_PERMISSION };

export const ADJUSTMENT_PATH = '/cap/cap-07';
export const TRACKING_PATH = '/cap/cap-15';

export const REASON_MIN = 10;
export const REASON_MAX = 2000;

/** The revisions that are still in work: a published plan has at most one of them at a time. */
const PENDING_STATUSES: readonly PlanStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED'];
/** The revisions that were in force at some time: the plan can be read as of a date through any of them. */
const IN_FORCE_STATUSES: readonly PlanStatus[] = ['PUBLISHED', 'SUPERSEDED'];

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const signedAmount = (value: unknown): string => (typeof value === 'string' && /^-?\d+$/.test(value) ? value : '0');

// ---- the revision of a plan --------------------------------------------------------------------------------------------

/** The revision of the same plan that is still in work (the one the next revision would have to wait for), when there is one. */
export const pendingRevisionOf = (plan: PlanSummary, plans: readonly PlanSummary[]): PlanSummary | undefined =>
  plans.find((candidate) => candidate.planCode === plan.planCode && candidate.id !== plan.id && PENDING_STATUSES.includes(candidate.status));

/** Whether a revision of the plan can be asked for: it is the published one, none is in work, the caller drafts plans and the tenant is not frozen. */
export function mayRevise(plan: PlanSummary, plans: readonly PlanSummary[], permissions: readonly string[] | undefined, mode: string | undefined): boolean {
  return plan.status === 'PUBLISHED' && pendingRevisionOf(plan, plans) === undefined && canDraft(permissions, mode);
}

export type ReasonProblem = 'required' | 'tooShort' | 'tooLong';

export function validateRevisionReason(reason: string): ReasonProblem | undefined {
  const length = reason.trim().length;
  if (length === 0) return 'required';
  if (length < REASON_MIN) return 'tooShort';
  return length > REASON_MAX ? 'tooLong' : undefined;
}

export type RevisionProblem = 'pending' | 'notPublished' | 'versionConflict' | 'yearLocked' | 'denied' | 'notFound' | 'validation' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, RevisionProblem>> = {
  REVISION_PENDING_EXISTS: 'pending',
  PLAN_NOT_PUBLISHED: 'notPublished',
  VERSION_CONFLICT: 'versionConflict',
  FISCAL_YEAR_LOCKED: 'yearLocked',
  SCOPE_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
};

/** Maps the failure of the revision command to what the screen says. */
export function describeRevisionProblem(error: unknown): RevisionProblem {
  if (!(error instanceof ApiError)) return 'general';
  return PROBLEM_BY_CODE[error.code] ?? (error.status === 403 ? 'denied' : 'general');
}

// ---- the transfer between lines ----------------------------------------------------------------------------------------

/**
 * What a revision moves, line by line: the lines that give capital up (they shrink or are dropped) beside the lines that receive it (they
 * grow or are new), with the exact totals of both sides. A transfer that keeps the total has the two sides equal.
 */
export interface Transfer {
  down: ImpactRow[];
  up: ImpactRow[];
  downVnd: string;
  upVnd: string;
  netVnd: string;
  balanced: boolean;
}

export function transferOf(impact: Impact): Transfer {
  const down = impact.rows.filter((row) => BigInt(row.deltaVnd) < 0n);
  const up = impact.rows.filter((row) => BigInt(row.deltaVnd) > 0n);
  const downTotal = down.reduce((sum, row) => sum - BigInt(row.deltaVnd), 0n);
  const upTotal = up.reduce((sum, row) => sum + BigInt(row.deltaVnd), 0n);
  return { down, up, downVnd: downTotal.toString(), upVnd: upTotal.toString(), netVnd: (upTotal - downTotal).toString(), balanced: upTotal === downTotal };
}

/** The transfer of a revision against the revision it replaces. */
export const transferBetween = (lines: readonly PlanLine[], base: readonly PlanLine[]): Transfer => transferOf(computeImpact(lines, base));

// ---- the plan as of a date ---------------------------------------------------------------------------------------------

export interface AsOfLine {
  line: PlanLine;
  /** What the first revision of the plan gave the line. */
  initialVnd: string;
  /** What the revision in force gave beyond (or took from) that; negative when the line was reduced. */
  adjustmentVnd: string;
  /** What had been paid on the line by the date. */
  disbursedVnd: string;
}

export interface PlanAsOf {
  planId: string;
  planCode: string;
  revision: number;
  status: PlanStatus;
  decisionDocumentId: string | null;
  effectiveAt: string | null;
  asOf: string;
  /** True when the plan has more lines than the answer carries. */
  truncated: boolean;
  totals: { currentVnd: string; initialVnd: string; adjustmentVnd: string; disbursedVnd: string };
  lines: AsOfLine[];
}

const PLAN_STATUS_VALUES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED'];

/** The answer of `getCapitalPlanAsOf`; undefined when it is not the shape of one. */
export function toPlanAsOf(raw: unknown): PlanAsOf | undefined {
  const row = asRecord(raw);
  const planId = text(row?.capital_plan_id);
  const planCode = text(row?.plan_code);
  const status = text(row?.status);
  const asOf = text(row?.as_of);
  const revision = row?.revision;
  if (row === undefined || planId === undefined || planCode === undefined || asOf === undefined || status === undefined || !PLAN_STATUS_VALUES.includes(status)) return undefined;
  if (typeof revision !== 'number' || !Number.isInteger(revision)) return undefined;
  const totals = asRecord(row.totals) ?? {};
  return {
    planId,
    planCode,
    revision,
    status: status as PlanStatus,
    decisionDocumentId: nullableText(row.decision_document_id),
    effectiveAt: nullableText(row.effective_at),
    asOf,
    truncated: row.truncated === true,
    totals: { currentVnd: signedAmount(totals.amount_vnd), initialVnd: signedAmount(totals.initial_vnd), adjustmentVnd: signedAmount(totals.adjustment_vnd), disbursedVnd: signedAmount(totals.disbursed_vnd) },
    lines: (Array.isArray(row.lines) ? row.lines : []).flatMap((item: unknown) => {
      const line = toPlanLine(item);
      const extra = asRecord(item);
      return line === undefined || extra === undefined
        ? []
        : [{ line, initialVnd: signedAmount(extra.initial_vnd), adjustmentVnd: signedAmount(extra.adjustment_vnd), disbursedVnd: signedAmount(extra.as_of_disbursed_vnd) }];
    }),
  };
}

/**
 * The plans the tracking screen offers: one per plan code, the latest revision that was in force. The plan can be read as of a date through
 * any revision of its code, so this one is enough to name it.
 */
export function trackedPlans(plans: readonly PlanSummary[]): PlanSummary[] {
  const latest = new Map<string, PlanSummary>();
  for (const plan of plans) {
    if (!IN_FORCE_STATUSES.includes(plan.status)) continue;
    const seen = latest.get(plan.planCode);
    if (seen === undefined || plan.revision > seen.revision) latest.set(plan.planCode, plan);
  }
  return [...latest.values()].sort((a, b) => (a.planCode < b.planCode ? -1 : a.planCode > b.planCode ? 1 : 0));
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The date the person typed as the `at` the server reads: a real calendar day, or nothing (the plan as it stands now). */
export function asOfDate(value: string): { at: string | undefined; valid: boolean } {
  const trimmed = value.trim();
  if (trimmed === '') return { at: undefined, valid: true };
  const match = DATE.exec(trimmed);
  if (match === null) return { at: undefined, valid: false };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const real = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
  return real ? { at: trimmed, valid: true } : { at: undefined, valid: false };
}
