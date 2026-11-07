import { DomainError } from './errors.ts';
import type { BaselineDeviationPolicy } from './gov-b1-policy.ts';
import { daysBetween } from './pay-project-settlement.ts';
import { isCalendarDate } from './retention.ts';

/**
 * The baseline of a project (G1-3, G1-4, G1-5; research F21, F3): version 0 is taken once from the approved work breakdown and the baseline days of the milestones and never changes; every approved revision of the
 * investment total or the schedule adds the next version; the deviation is always measured against version 0, so a plan that was corrected again and again cannot hide how late or how dear it became. A date that
 * moves is counted, and the count is what the auditors are told about. Pure functions of their input.
 */
export const BASELINE_KINDS = ['V0', 'REVISION'] as const;
export type BaselineKind = (typeof BASELINE_KINDS)[number];
/** The curve a line is spread on between its two days. Only the straight one exists today; the column leaves room for a calendar-weighted or S-shaped one without a migration. */
export const BASELINE_CURVES = ['LINEAR'] as const;
export type BaselineCurve = (typeof BASELINE_CURVES)[number];

const SCALE = 10_000n;
const HUNDRED = 100n;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface ComponentFact {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  plannedValueVnd: string;
  validFrom: string;
  validUntil: string | null;
}

export interface MilestoneFact {
  id: string;
  componentId: string | null;
  code: string;
  baselineDate: string;
  plannedDate: string;
  status: 'PLANNED' | 'DONE' | 'DELAYED' | 'CANCELLED';
}

export interface BaselineLineDraft {
  componentId: string;
  code: string;
  name: string;
  bacVnd: string;
  plannedStart: string;
  plannedFinish: string;
}

export type BaselineIssueCode = 'NO_FINISH_DATE' | 'FINISH_BEFORE_START';
export interface BaselineIssue {
  code: BaselineIssueCode;
  componentCode: string;
}

/** The first-level component a component belongs to (the baseline is kept per first-level work package, the level BR-PRJ-08 adds up against the investment total). */
export function firstLevelRootOf(componentId: string, parents: ReadonlyMap<string, string | null>): string | undefined {
  let current: string | undefined = componentId;
  const seen = new Set<string>();
  while (current !== undefined) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const parent = parents.get(current);
    if (parent === undefined) return undefined;
    if (parent === null) return current;
    current = parent;
  }
  return undefined;
}

/**
 * The lines a baseline is made of: one for each first-level component that is still in force, with its planned value, the day it starts and the day it finishes. The finish is the last milestone day of the component
 * and of the components under it (the baseline days for version 0, the planned days for a later version; a cancelled milestone counts for nothing), or the last day of the final year of the project when the
 * component has no milestone. A component that has neither, or that would finish before it starts, is an issue, never a guess.
 */
export function deriveBaselineLines(input: { components: readonly ComponentFact[]; milestones: readonly MilestoneFact[]; basis: 'BASELINE' | 'PLANNED'; projectFinish: string | null }): { lines: BaselineLineDraft[]; issues: BaselineIssue[] } {
  const active = input.components.filter((component) => component.validUntil === null);
  const parents = new Map<string, string | null>(input.components.map((component) => [component.id, component.parentId]));
  const roots = active.filter((component) => component.parentId === null).sort((a, b) => a.code.localeCompare(b.code));
  const latest = new Map<string, string>();
  for (const milestone of input.milestones) {
    if (milestone.status === 'CANCELLED' || milestone.componentId === null) continue;
    const root = firstLevelRootOf(milestone.componentId, parents);
    if (root === undefined) continue;
    const day = input.basis === 'BASELINE' ? milestone.baselineDate : milestone.plannedDate;
    const seen = latest.get(root);
    if (seen === undefined || day > seen) latest.set(root, day);
  }
  const lines: BaselineLineDraft[] = [];
  const issues: BaselineIssue[] = [];
  for (const root of roots) {
    const finish = latest.get(root.id) ?? input.projectFinish;
    if (finish === null) {
      issues.push({ code: 'NO_FINISH_DATE', componentCode: root.code });
      continue;
    }
    if (finish < root.validFrom) {
      issues.push({ code: 'FINISH_BEFORE_START', componentCode: root.code });
      continue;
    }
    lines.push({ componentId: root.id, code: root.code, name: root.name, bacVnd: root.plannedValueVnd, plannedStart: root.validFrom, plannedFinish: finish });
  }
  return { lines, issues };
}

/**
 * What it takes to take version 0: a work breakdown with value, and every first-level component with a start and a finish day. Nothing is taken from a partial plan (422 `BASELINE_NO_WBS`, `BASELINE_INCOMPLETE`
 * naming the components), because a baseline taken from a guess is the one that cannot be corrected later.
 */
export function assertBaselineCapturable(draft: { lines: readonly BaselineLineDraft[]; issues: readonly BaselineIssue[] }): void {
  const total = draft.lines.reduce((sum, line) => sum + BigInt(line.bacVnd), 0n);
  if (draft.lines.length === 0 && draft.issues.length === 0) throw new DomainError('BASELINE_NO_WBS', 422, 'components');
  if (draft.issues.length > 0) throw new DomainError('BASELINE_INCOMPLETE', 422, 'components', { extensions: { issues: draft.issues.map((issue) => ({ code: issue.code, component_code: issue.componentCode })) } });
  if (total <= 0n) throw new DomainError('BASELINE_NO_WBS', 422, 'components');
}

export const baselineTotal = (lines: ReadonlyArray<Pick<BaselineLineDraft, 'bacVnd'>>): string => lines.reduce((sum, line) => sum + BigInt(line.bacVnd), 0n).toString();

export const earliestStart = (lines: ReadonlyArray<Pick<BaselineLineDraft, 'plannedStart'>>): string | null => lines.reduce<string | null>((first, line) => (first === null || line.plannedStart < first ? line.plannedStart : first), null);

export const latestFinish = (lines: ReadonlyArray<Pick<BaselineLineDraft, 'plannedFinish'>>): string | null => lines.reduce<string | null>((last, line) => (last === null || line.plannedFinish > last ? line.plannedFinish : last), null);

/**
 * The value planned by a day, on the straight curve: nothing before the first day, all of it from the last day, and in between the share of the days that have passed (both ends count), rounded down to the dong.
 * An unknown day is a refusal, not a zero.
 */
export function plannedValueAt(line: Pick<BaselineLineDraft, 'bacVnd' | 'plannedStart' | 'plannedFinish'>, asOf: string): bigint {
  if (!isCalendarDate(asOf)) throw invalid('as_of');
  const bac = BigInt(line.bacVnd);
  if (asOf < line.plannedStart) return 0n;
  if (asOf >= line.plannedFinish) return bac;
  const total = BigInt(daysBetween(line.plannedStart, line.plannedFinish) + 1);
  const elapsed = BigInt(daysBetween(line.plannedStart, asOf) + 1);
  return (bac * elapsed) / total;
}

/** A signed percent with four decimals (`-12.5000`), half away from zero, from whole numbers; null when there is nothing to divide by. Never a float. */
export function percentOf(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) return null;
  return decimal(scaledRatio(numerator * HUNDRED, denominator));
}

/** A signed ratio with four decimals (`0.9523`), half away from zero; null when there is nothing to divide by. */
export function ratioOf(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) return null;
  return decimal(scaledRatio(numerator, denominator));
}

function scaledRatio(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n * SCALE * 2n + d) / (2n * d);
  return negative ? -rounded : rounded;
}

function decimal(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const text = `${abs / SCALE}.${(abs % SCALE).toString().padStart(4, '0')}`;
  return negative && abs !== 0n ? `-${text}` : text;
}

/** A decimal written by `ratioOf` or `percentOf`, back to the whole number it was scaled to (four decimals). */
export function scaledOf(text: string): bigint {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const value = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0').slice(0, 4));
  return negative ? -value : value;
}

export interface MilestoneSlip {
  code: string;
  baselineDate: string;
  plannedDate: string;
  /** Calendar days the planned day is after the baseline day (negative when it is before). */
  slipDays: number;
  /** How many times the planned day was moved. */
  moves: number;
}

export interface BaselineFigures {
  totalInvestmentVnd: string;
  bacVnd: string;
  plannedStart: string | null;
  plannedFinish: string | null;
}

export interface Deviation {
  /** The investment total now, against version 0, whole dong. */
  costVnd: string;
  costPct: string | null;
  /** The budget at completion of the work breakdown now, against version 0. */
  bacVnd: string;
  bacPct: string | null;
  /** Calendar days from the finish of version 0 to the finish forecast now; null when the forecast has no milestone to stand on. */
  finishSlipDays: number | null;
  forecastFinish: string | null;
  milestones: MilestoneSlip[];
}

/** The deviation of what the project holds now from its baseline version 0. The forecast finish is the last planned day of a milestone that is not cancelled, never a date made up. */
export function baselineDeviation(input: { v0: BaselineFigures; currentTotalInvestmentVnd: string; currentBacVnd: string; milestones: ReadonlyArray<MilestoneFact & { moves: number }> }): Deviation {
  const v0Total = BigInt(input.v0.totalInvestmentVnd);
  const v0Bac = BigInt(input.v0.bacVnd);
  const live = input.milestones.filter((milestone) => milestone.status !== 'CANCELLED');
  const forecastFinish = live.reduce<string | null>((last, milestone) => (last === null || milestone.plannedDate > last ? milestone.plannedDate : last), null);
  return {
    costVnd: (BigInt(input.currentTotalInvestmentVnd) - v0Total).toString(),
    costPct: percentOf(BigInt(input.currentTotalInvestmentVnd) - v0Total, v0Total),
    bacVnd: (BigInt(input.currentBacVnd) - v0Bac).toString(),
    bacPct: percentOf(BigInt(input.currentBacVnd) - v0Bac, v0Bac),
    finishSlipDays: forecastFinish === null || input.v0.plannedFinish === null ? null : daysBetween(input.v0.plannedFinish, forecastFinish),
    forecastFinish,
    milestones: input.milestones.map((milestone) => ({ code: milestone.code, baselineDate: milestone.baselineDate, plannedDate: milestone.plannedDate, slipDays: daysBetween(milestone.baselineDate, milestone.plannedDate), moves: milestone.moves })),
  };
}

export type ReappraisalReason = 'COST' | 'SLIP';

/** Whether the deviation passes a threshold: the investment total moved by more than the percent (up or down) or the finish by more than the days (later only). Nothing is asked when a figure is unknown. */
export function reappraisalReasons(deviation: Pick<Deviation, 'costPct' | 'finishSlipDays'>, policy: BaselineDeviationPolicy): ReappraisalReason[] {
  const reasons: ReappraisalReason[] = [];
  if (deviation.costPct !== null) {
    const moved = scaledOf(deviation.costPct);
    const limit = BigInt(Math.round(policy.costPct * 10_000));
    if ((moved < 0n ? -moved : moved) > limit) reasons.push('COST');
  }
  if (deviation.finishSlipDays !== null && deviation.finishSlipDays > policy.slipDays) reasons.push('SLIP');
  return reasons;
}

export interface RescheduleFact {
  source: 'MILESTONE' | 'REVISION';
  milestoneId: string | null;
}

export interface RescheduleCount {
  /** How many times each milestone was moved. */
  perMilestone: ReadonlyMap<string, number>;
  /** How many times the final day of the project was moved by an approved revision of the schedule. */
  projectMoves: number;
  /** The figure the auditors are told about: the most that any one date was moved. */
  count: number;
}

export function rescheduleCount(events: readonly RescheduleFact[]): RescheduleCount {
  const perMilestone = new Map<string, number>();
  let projectMoves = 0;
  for (const event of events) {
    if (event.source === 'REVISION' || event.milestoneId === null) {
      projectMoves += 1;
      continue;
    }
    perMilestone.set(event.milestoneId, (perMilestone.get(event.milestoneId) ?? 0) + 1);
  }
  const most = [...perMilestone.values()].reduce((top, value) => Math.max(top, value), 0);
  return { perMilestone, projectMoves, count: Math.max(most, projectMoves) };
}

/** An alert goes to AUD when a date was moved as many times as the policy says, or more. */
export const rescheduleNeedsAlert = (count: number, policy: BaselineDeviationPolicy): boolean => count >= policy.rescheduleAlertCount;
