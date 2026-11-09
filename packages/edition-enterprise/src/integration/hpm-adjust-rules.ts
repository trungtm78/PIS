import { DomainError } from '@machvon/kernel';
import { hpmReasonOf, isHpmPeriod } from './hpm-rules.ts';

/**
 * The adjustment in the next period (ENT-3c, requirement TH.01), the second way to put right a figure of a period the receiver already accepted: instead of reopening the period and overwriting it (`hpm_correction`), the
 * difference is booked in the next period of the same layout and the accepted period stays as it was. This module is the pure rules; the ledger that keeps them true lives in `hpm-adjust-store.ts`.
 */

export const HPM_ADJUSTMENT_STATES = ['PROPOSED', 'APPROVED', 'REJECTED', 'APPLIED'] as const;
export type HpmAdjustmentState = (typeof HPM_ADJUSTMENT_STATES)[number];
/** The journal of an adjustment records each of its moves once, in this order. */
export const HPM_ADJUSTMENT_JOURNAL_KINDS = HPM_ADJUSTMENT_STATES;

const LAYOUT_CODE = /^[A-Z][A-Z0-9_-]{1,59}$/;
const SUBJECT_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const SIGNED_DONG = /^-?[1-9]\d{0,23}$/;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * The period after a report period of the same grain: `2026-M12` is `2027-M01`, `2026-Q4` is `2027-Q1`, `2026-H2` is `2027-H1`, `2026` is `2027`. A period named by a day has no next one the rules can name (a weekly package
 * is replaced by a newer revision, not adjusted), so it is undefined and the adjustment is refused.
 */
export function nextHpmPeriod(period: string): string | undefined {
  if (!isHpmPeriod(period)) return undefined;
  const year = Number(period.slice(0, 4));
  const suffix = period.slice(5);
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (suffix === '') return String(year + 1).padStart(4, '0');
  if (/^M(0[1-9]|1[0-2])$/.test(suffix)) {
    const month = Number(suffix.slice(1));
    return month === 12 ? `${String(year + 1).padStart(4, '0')}-M01` : `${period.slice(0, 5)}M${pad(month + 1)}`;
  }
  if (/^Q[1-4]$/.test(suffix)) {
    const quarter = Number(suffix.slice(1));
    return quarter === 4 ? `${String(year + 1).padStart(4, '0')}-Q1` : `${period.slice(0, 5)}Q${quarter + 1}`;
  }
  if (/^H[12]$/.test(suffix)) return suffix === 'H2' ? `${String(year + 1).padStart(4, '0')}-H1` : `${period.slice(0, 5)}H2`;
  return undefined;
}

export interface HpmAdjustmentRequest {
  layoutCode: string;
  sourcePeriod: string;
  /** The accepted revision the figure was wrong in. */
  sourceRevision: number;
  /** The period the difference is booked in: always the next one of the source. */
  targetPeriod: string;
  /** What the amount is about (an indicator or a project code), as the package names it. */
  subjectCode: string;
  /** Signed whole dong, never zero: positive adds to the target period, negative takes off. */
  amountVnd: string;
  reason: string;
}

/** The proposal of an adjustment, judged field by field (422 `VALIDATION_FAILED` naming the field). */
export function hpmAdjustmentRequestOf(body: Readonly<Record<string, unknown>>): HpmAdjustmentRequest {
  const layoutCode = body.layout_code;
  const sourcePeriod = body.source_period;
  const revision = body.source_revision;
  const subject = body.subject_code;
  const amount = body.amount_vnd;
  if (typeof layoutCode !== 'string' || !LAYOUT_CODE.test(layoutCode)) throw invalid('layout_code');
  if (!isHpmPeriod(sourcePeriod)) throw invalid('source_period');
  const targetPeriod = nextHpmPeriod(sourcePeriod);
  if (targetPeriod === undefined) throw invalid('source_period');
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1 || revision > 10_000) throw invalid('source_revision');
  if (typeof subject !== 'string' || !SUBJECT_CODE.test(subject)) throw invalid('subject_code');
  if (typeof amount !== 'string' || !SIGNED_DONG.test(amount)) throw invalid('amount_vnd');
  return { layoutCode, sourcePeriod, sourceRevision: revision, targetPeriod, subjectCode: subject, amountVnd: amount, reason: hpmReasonOf(body.reason) };
}

/**
 * A decision on an adjustment: only a proposed one is decided (409 `HPM_ADJUSTMENT_STATE_INVALID`), never by the person who proposed it (403 `SELF_APPROVAL_DENIED`), and always with a reason. The proposer and the decider
 * are two people, the way a correction by overwrite is decided.
 */
export function hpmAdjustmentDecision(adjustment: { state: HpmAdjustmentState; proposedBy: string }, step: { decision: unknown; actorId: string; reason: unknown }): { to: 'APPROVED' | 'REJECTED'; reason: string } {
  if (step.decision !== 'APPROVE' && step.decision !== 'REJECT') throw invalid('decision');
  if (adjustment.state !== 'PROPOSED') throw new DomainError('HPM_ADJUSTMENT_STATE_INVALID', 409, 'state');
  if (adjustment.proposedBy === step.actorId) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
  return { to: step.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reason: hpmReasonOf(step.reason) };
}

/**
 * Whether an adjustment may be proposed against what the receiver holds: the revision it names is one the receiver accepted (404 otherwise, there is nothing to put right), and the target period has not been accepted
 * already (409 `HPM_ADJUSTMENT_STATE_INVALID`: the next period was sent, so the difference has no package left to ride on; it is a correction by overwrite then).
 */
export function assertAdjustable(held: { acceptedRevision: number | undefined; targetAccepted: boolean }, request: Pick<HpmAdjustmentRequest, 'sourceRevision'>): void {
  if (held.acceptedRevision === undefined || held.acceptedRevision !== request.sourceRevision) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'source_revision');
  if (held.targetAccepted) throw new DomainError('HPM_ADJUSTMENT_STATE_INVALID', 409, 'target_period');
}

/** The line of an applied adjustment as the package of the target period carries it (ids and codes and the signed amount, never the reason). */
export type HpmAdjustmentLine = {
  id: string;
  source_period: string;
  source_revision: number;
  subject_code: string;
  amount_vnd: string;
};

export const hpmAdjustmentLineOf = (row: { id: string; sourcePeriod: string; sourceRevision: number; subjectCode: string; amountVnd: string }): HpmAdjustmentLine => ({
  id: row.id,
  source_period: row.sourcePeriod,
  source_revision: row.sourceRevision,
  subject_code: row.subjectCode,
  amount_vnd: row.amountVnd,
});

/** The signed total of some lines per subject: what the target period adds to or takes off each subject. Whole dong, exact (BigInt). */
export function hpmAdjustmentTotals(lines: ReadonlyArray<Pick<HpmAdjustmentLine, 'subject_code' | 'amount_vnd'>>): Array<{ subject_code: string; amount_vnd: string }> {
  const totals = new Map<string, bigint>();
  for (const line of lines) totals.set(line.subject_code, (totals.get(line.subject_code) ?? 0n) + BigInt(line.amount_vnd));
  return [...totals.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([subject, amount]) => ({ subject_code: subject, amount_vnd: amount.toString() }));
}
