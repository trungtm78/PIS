import { DomainError } from './errors.ts';
import type { RuleParams } from './governance-rules.ts';

/**
 * The bottlenecks of the work and the halted projects (G3-9, HOME, ISS, LND and PMT). A bottleneck is something that holds money or work up: a payment request that waits to be checked or to be paid by the Treasury, a
 * compensation that is due and not paid, an issue that is not solved. Each is told with the amount that is held (whole dong, or none with the reason: an issue has no amount), a standard cause, how old it is, and who holds
 * it; one amount that two sources describe is counted once. A project that is halted has a dossier: why, since when, and a restart plan with owners and days that a different person approved. Pure and deterministic;
 * the causes, the age buckets and the minimum of a plan are a governance rule, unverified until approved.
 */

export const BOTTLENECK_RULE_TYPE = 'BOTTLENECK_POLICY';
export const BOTTLENECK_RULE_CODE = 'DEFAULT';
export const BOTTLENECK_SOURCES = ['PAYMENT', 'LAND', 'ISSUE', 'HALT'] as const;
export type BottleneckSource = (typeof BOTTLENECK_SOURCES)[number];
export const ISSUE_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export interface CauseRule {
  code: string;
  /** The module that owns the remedy. */
  ownerModule: string;
}
export interface BottleneckModel {
  causes: CauseRule[];
  /** The upper bounds, in days, of the age buckets, ascending: [7, 30, 90] gives up to 7, up to 30, up to 90 and over 90. */
  ageBucketsDays: number[];
  /** An issue is a bottleneck from this severity up. */
  issueMinSeverity: IssueSeverity;
  /** A restart plan has at least this many steps before it can be approved. */
  planMinSteps: number;
}

export const BOTTLENECK_DEFAULTS: Readonly<Record<string, unknown>> = {
  causes: [
    { code: 'LAND_CLEARANCE', owner_module: 'LND' },
    { code: 'PAYMENT_PENDING_TREASURY', owner_module: 'PAY' },
    { code: 'PAYMENT_PENDING_DOSSIER', owner_module: 'PAY' },
    { code: 'ISSUE_UNRESOLVED', owner_module: 'ISS' },
    { code: 'DESIGN_APPROVAL', owner_module: 'PRJ' },
    { code: 'PROCUREMENT_DELAY', owner_module: 'BID' },
    { code: 'CONTRACTOR_CAPACITY', owner_module: 'CTR' },
    { code: 'FORCE_MAJEURE', owner_module: 'PRJ' },
    { code: 'LEGAL_PROCEDURE', owner_module: 'PRJ' },
    { code: 'OTHER', owner_module: 'PRJ' },
  ],
  age_buckets_days: [7, 30, 90],
  issue_min_severity: 'HIGH',
  plan_min_steps: 1,
};

const fail = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The model from the params of the approved rule or the default; a model that is not whole is refused rather than half applied. */
export function bottleneckModelOf(params: RuleParams): BottleneckModel {
  if (!Array.isArray(params.causes) || params.causes.length === 0) throw fail('causes');
  const causes = params.causes.map((one, index): CauseRule => {
    if (!isRecord(one) || typeof one.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(one.code) || typeof one.owner_module !== 'string' || !/^[A-Z][A-Z0-9]{1,7}$/.test(one.owner_module)) throw fail(`causes[${index}]`);
    return { code: one.code, ownerModule: one.owner_module };
  });
  if (new Set(causes.map((one) => one.code)).size !== causes.length) throw fail('causes');
  for (const required of ['LAND_CLEARANCE', 'PAYMENT_PENDING_TREASURY', 'PAYMENT_PENDING_DOSSIER', 'ISSUE_UNRESOLVED', 'OTHER']) if (!causes.some((one) => one.code === required)) throw fail('causes');
  const buckets = params.age_buckets_days;
  if (!Array.isArray(buckets) || buckets.length === 0 || buckets.length > 6 || !buckets.every((one, index) => typeof one === 'number' && Number.isInteger(one) && one >= 1 && one <= 3650 && (index === 0 || one > (buckets[index - 1] as number)))) throw fail('age_buckets_days');
  if (!(ISSUE_SEVERITIES as readonly unknown[]).includes(params.issue_min_severity)) throw fail('issue_min_severity');
  const planMinSteps = params.plan_min_steps;
  if (typeof planMinSteps !== 'number' || !Number.isInteger(planMinSteps) || planMinSteps < 1 || planMinSteps > 20) throw fail('plan_min_steps');
  return { causes, ageBucketsDays: buckets as number[], issueMinSeverity: params.issue_min_severity as IssueSeverity, planMinSteps };
}

// ---- the items and their analysis -------------------------------------------------------------------------------------------------------------------------

export interface Holder {
  kind: 'UNIT' | 'PERSON' | 'EXTERNAL';
  id: string | null;
  name: string | null;
  /** EXTERNAL: who it is (the Treasury). */
  code: string | null;
}
export interface BottleneckItem {
  /** `<source>:<id>`, unique. */
  key: string;
  source: BottleneckSource;
  sourceId: string;
  projectId: string | null;
  projectCode: string | null;
  unitId: string | null;
  causeCode: string;
  /** Whole dong held, or null when the source has no amount (said with `amountNullReason`, never 0). */
  amountVnd: string | null;
  amountNullReason: 'NO_AMOUNT' | null;
  /** The day it began to hold (`YYYY-MM-DD`). */
  since: string;
  holder: Holder;
  /** Two sources that describe one thing carry the same key: the amount is counted once. */
  dedupeKey: string | null;
}

const DAY_MS = 86_400_000;
/** Whole days from `since` to `today`; a day in the future is age 0. */
export const ageDays = (since: string, today: string): number => Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS));

/** The bucket of an age: `LE_<bound>` for the first bound it does not pass, or `GT_<last>`. */
export function bucketOf(model: Pick<BottleneckModel, 'ageBucketsDays'>, age: number): string {
  for (const bound of model.ageBucketsDays) if (age <= bound) return `LE_${bound}`;
  return `GT_${model.ageBucketsDays[model.ageBucketsDays.length - 1] as number}`;
}

export const bucketCodes = (model: Pick<BottleneckModel, 'ageBucketsDays'>): string[] => [...model.ageBucketsDays.map((bound) => `LE_${bound}`), `GT_${model.ageBucketsDays[model.ageBucketsDays.length - 1] as number}`];

export interface AnalysedItem extends BottleneckItem {
  ageDays: number;
  bucket: string;
  /** The causes' owner module, or null for a cause the rule does not know (it is counted under OTHER and says so). */
  ownerModule: string | null;
  causeKnown: boolean;
  /** Items of other sources that describe the same thing and were folded into this one. */
  mergedKeys: string[];
}
export interface Total {
  key: string;
  count: number;
  /** The sum of the amounts that are known, whole dong. */
  amountVnd: string;
  /** How many items have no amount: the sum is a lower bound when this is not 0. */
  noAmount: number;
}
export interface Analysis {
  items: AnalysedItem[];
  heldVnd: string;
  noAmount: number;
  merged: number;
  byCause: Total[];
  byHolder: Array<Total & { holder: Holder }>;
  byBucket: Total[];
  byUnit: Total[];
}

const SOURCE_ORDER: Readonly<Record<BottleneckSource, number>> = { PAYMENT: 0, LAND: 1, ISSUE: 2, HALT: 3 };

function holderKey(holder: Holder): string {
  return holder.kind === 'EXTERNAL' ? `EXTERNAL:${holder.code ?? ''}` : `${holder.kind}:${holder.id ?? ''}`;
}

function totalsOf<T>(items: readonly AnalysedItem[], keyOf: (item: AnalysedItem) => string, make: (key: string, base: Total, first: AnalysedItem) => T): T[] {
  const map = new Map<string, { total: Total; first: AnalysedItem; sum: bigint }>();
  for (const item of items) {
    const key = keyOf(item);
    const held = map.get(key) ?? { total: { key, count: 0, amountVnd: '0', noAmount: 0 }, first: item, sum: 0n };
    held.total.count += 1;
    if (item.amountVnd === null) held.total.noAmount += 1;
    else held.sum += BigInt(item.amountVnd);
    map.set(key, held);
  }
  return [...map.values()].map((held) => make(held.total.key, { ...held.total, amountVnd: held.sum.toString() }, held.first));
}

/**
 * The analysis: each item gets its age, bucket and the owner of its cause; items of two sources that describe the same thing (the same `dedupeKey`) become one, the one that has an amount (else the earlier source); the
 * ranking is the amount held times the age in days (an item younger than a day counts as one), the items with no amount after the ones that have, oldest first; totals by cause, by holder, by bucket and by unit say how many
 * items have no amount, so no sum looks more complete than it is.
 */
export function analyseBottlenecks(model: BottleneckModel, items: readonly BottleneckItem[], today: string): Analysis {
  const known = new Map(model.causes.map((cause) => [cause.code, cause.ownerModule]));
  const byDedupe = new Map<string, BottleneckItem[]>();
  const free: BottleneckItem[] = [];
  for (const item of items) {
    if (item.dedupeKey === null) free.push(item);
    else byDedupe.set(item.dedupeKey, [...(byDedupe.get(item.dedupeKey) ?? []), item]);
  }
  const kept: Array<{ item: BottleneckItem; merged: string[] }> = free.map((item) => ({ item, merged: [] }));
  let merged = 0;
  for (const group of byDedupe.values()) {
    const ordered = [...group].sort((left, right) => (left.amountVnd === null ? 1 : 0) - (right.amountVnd === null ? 1 : 0) || SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || (left.key < right.key ? -1 : 1));
    kept.push({ item: ordered[0] as BottleneckItem, merged: ordered.slice(1).map((one) => one.key) });
    merged += ordered.length - 1;
  }
  const analysed: AnalysedItem[] = kept.map(({ item, merged: keys }) => {
    const age = ageDays(item.since, today);
    const owner = known.get(item.causeCode) ?? null;
    return { ...item, causeCode: owner === null ? 'OTHER' : item.causeCode, ageDays: age, bucket: bucketOf(model, age), ownerModule: owner ?? known.get('OTHER') ?? null, causeKnown: owner !== null, mergedKeys: keys };
  });
  const score = (item: AnalysedItem): bigint => (item.amountVnd === null ? -1n : BigInt(item.amountVnd) * BigInt(Math.max(item.ageDays, 1)));
  analysed.sort((left, right) => {
    const a = score(left);
    const b = score(right);
    if (a !== b) return a > b ? -1 : 1;
    if (left.ageDays !== right.ageDays) return right.ageDays - left.ageDays;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  const sum = analysed.reduce((total, item) => (item.amountVnd === null ? total : total + BigInt(item.amountVnd)), 0n);
  const bucketOrder = bucketCodes(model);
  return {
    items: analysed,
    heldVnd: sum.toString(),
    noAmount: analysed.filter((item) => item.amountVnd === null).length,
    merged,
    byCause: totalsOf(analysed, (item) => item.causeCode, (_key, base) => base).sort((left, right) => (BigInt(right.amountVnd) > BigInt(left.amountVnd) ? 1 : BigInt(right.amountVnd) < BigInt(left.amountVnd) ? -1 : left.key < right.key ? -1 : 1)),
    byHolder: totalsOf(analysed, (item) => holderKey(item.holder), (_key, base, first) => ({ ...base, holder: first.holder })).sort((left, right) => (BigInt(right.amountVnd) > BigInt(left.amountVnd) ? 1 : BigInt(right.amountVnd) < BigInt(left.amountVnd) ? -1 : left.key < right.key ? -1 : 1)),
    byBucket: totalsOf(analysed, (item) => item.bucket, (_key, base) => base).sort((left, right) => bucketOrder.indexOf(left.key) - bucketOrder.indexOf(right.key)),
    byUnit: totalsOf(analysed, (item) => item.unitId ?? '', (_key, base) => base).sort((left, right) => (BigInt(right.amountVnd) > BigInt(left.amountVnd) ? 1 : BigInt(right.amountVnd) < BigInt(left.amountVnd) ? -1 : left.key < right.key ? -1 : 1)),
  };
}

// ---- the halted project: reason, restart plan, lifecycle --------------------------------------------------------------------------------------------------------

export const HALT_STATUSES = ['HALTED', 'RESTART_PLANNED', 'RESTARTED', 'CANCELLED'] as const;
export type HaltStatus = (typeof HALT_STATUSES)[number];
export const STEP_STATUSES = ['OPEN', 'DONE', 'DROPPED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const words = (value: unknown): string => (typeof value === 'string' ? value.trim().normalize('NFC') : '');
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export interface HaltDraft {
  projectId: string;
  reasonCode: string;
  reasonText: string;
  haltedOn: string;
  orderRef: string | null;
  expectedRestartOn: string | null;
}

/** The dossier of a halt: the project, a cause of the closed list, the reason in words, the day it began (not in the future), the order that halted it when there is one, and the day a restart is expected. */
export function checkHalt(input: unknown, model: BottleneckModel, today: string): HaltDraft {
  const body = record(input);
  if (typeof body.project_id !== 'string' || !UUID.test(body.project_id)) throw invalid('project_id');
  if (typeof body.reason_code !== 'string' || !model.causes.some((cause) => cause.code === body.reason_code)) throw invalid('reason_code');
  const reasonText = words(body.reason_text);
  if (reasonText.length < 10 || reasonText.length > 2000) throw invalid('reason_text');
  if (!isDay(body.halted_on) || body.halted_on > today) throw invalid('halted_on');
  const orderRef = body.order_ref === undefined || body.order_ref === null ? null : words(body.order_ref);
  if (orderRef !== null && (orderRef.length < 1 || orderRef.length > 200)) throw invalid('order_ref');
  let expected: string | null = null;
  if (body.expected_restart_on !== undefined && body.expected_restart_on !== null) {
    if (!isDay(body.expected_restart_on) || body.expected_restart_on < body.halted_on) throw invalid('expected_restart_on');
    expected = body.expected_restart_on;
  }
  return { projectId: body.project_id, reasonCode: body.reason_code, reasonText, haltedOn: body.halted_on, orderRef, expectedRestartOn: expected };
}

export interface StepDraft {
  title: string;
  ownerId: string | null;
  ownerUnitId: string | null;
  dueOn: string;
}

/** The restart plan: at least the minimum number of steps, each with words, somebody to do it (a person or a unit) and a day that is not in the past; the days do not have to be in order, but none is before the day the halt began. */
export function checkRestartPlan(input: unknown, model: BottleneckModel, today: string, haltedOn: string): { steps: StepDraft[]; expectedRestartOn: string | null } {
  const body = record(input);
  if (!Array.isArray(body.steps) || body.steps.length < model.planMinSteps || body.steps.length > 40) throw invalid('steps');
  const steps = body.steps.map((one, index): StepDraft => {
    const step = record(one);
    const title = words(step.title);
    if (title.length < 5 || title.length > 300) throw invalid(`steps[${index}].title`);
    const ownerId = step.owner_id === undefined || step.owner_id === null ? null : typeof step.owner_id === 'string' && UUID.test(step.owner_id) ? step.owner_id : undefined;
    const ownerUnitId = step.owner_unit_id === undefined || step.owner_unit_id === null ? null : typeof step.owner_unit_id === 'string' && UUID.test(step.owner_unit_id) ? step.owner_unit_id : undefined;
    if (ownerId === undefined) throw invalid(`steps[${index}].owner_id`);
    if (ownerUnitId === undefined) throw invalid(`steps[${index}].owner_unit_id`);
    if (ownerId === null && ownerUnitId === null) throw invalid(`steps[${index}].owner_id`);
    if (!isDay(step.due_on) || step.due_on < today || step.due_on < haltedOn) throw invalid(`steps[${index}].due_on`);
    return { title, ownerId, ownerUnitId, dueOn: step.due_on };
  });
  let expected: string | null = null;
  if (body.expected_restart_on !== undefined && body.expected_restart_on !== null) {
    if (!isDay(body.expected_restart_on) || body.expected_restart_on < haltedOn) throw invalid('expected_restart_on');
    expected = body.expected_restart_on;
  }
  return { steps, expectedRestartOn: expected };
}

export const PLAN_DECISIONS = ['APPROVE', 'RETURN'] as const;
export type PlanDecision = (typeof PLAN_DECISIONS)[number];

export function checkPlanDecision(input: unknown): { decision: PlanDecision; note: string } {
  const body = record(input);
  if (!(PLAN_DECISIONS as readonly unknown[]).includes(body.decision)) throw invalid('decision');
  const note = words(body.note);
  if (note.length < 5 || note.length > 1000) throw invalid('note');
  return { decision: body.decision as PlanDecision, note };
}

/** Maker is not checker: the person who saved the plan does not approve it. */
export function assertPlanApprover(savedBy: string, approver: string): void {
  if (savedBy === approver) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'decision');
}

export function checkStepUpdate(input: unknown): { status: Exclude<StepStatus, 'OPEN'>; note: string } {
  const body = record(input);
  if (body.status !== 'DONE' && body.status !== 'DROPPED') throw invalid('status');
  const note = words(body.note);
  if (note.length < 5 || note.length > 1000) throw invalid('note');
  return { status: body.status, note };
}

export const HALT_CLOSE_OUTCOMES = ['RESTARTED', 'CANCELLED'] as const;
export type HaltCloseOutcome = (typeof HALT_CLOSE_OUTCOMES)[number];

export interface CloseDraft {
  outcome: HaltCloseOutcome;
  note: string;
  restartedOn: string | null;
}

/** The close of a halt: restarted (with the day) or cancelled, with words. */
export function checkHaltClose(input: unknown, today: string, haltedOn: string): CloseDraft {
  const body = record(input);
  if (!(HALT_CLOSE_OUTCOMES as readonly unknown[]).includes(body.outcome)) throw invalid('outcome');
  const outcome = body.outcome as HaltCloseOutcome;
  const note = words(body.note);
  if (note.length < 5 || note.length > 1000) throw invalid('note');
  let restartedOn: string | null = null;
  if (outcome === 'RESTARTED') {
    if (!isDay(body.restarted_on) || body.restarted_on > today || body.restarted_on < haltedOn) throw invalid('restarted_on');
    restartedOn = body.restarted_on;
  } else if (body.restarted_on !== undefined && body.restarted_on !== null) throw invalid('restarted_on');
  return { outcome, note, restartedOn };
}

/** What a dossier may do next: save a plan while halted, be approved or returned once a plan is saved and not decided, close as restarted only from a planned restart, close as cancelled from either open state. */
export function haltCan(status: HaltStatus, action: 'PLAN' | 'DECIDE' | 'UPDATE_STEP' | 'RESTARTED' | 'CANCELLED'): boolean {
  switch (action) {
    case 'PLAN':
      return status === 'HALTED';
    case 'DECIDE':
      return status === 'HALTED';
    case 'UPDATE_STEP':
      return status === 'RESTART_PLANNED';
    case 'RESTARTED':
      return status === 'RESTART_PLANNED';
    case 'CANCELLED':
      return status === 'HALTED' || status === 'RESTART_PLANNED';
  }
}

export interface PlanStepFacts {
  status: StepStatus;
  dueOn: string;
}

/** Whether a restart may be recorded: every step of the approved plan is done or dropped. */
export const allStepsClosed = (steps: readonly PlanStepFacts[]): boolean => steps.length > 0 && steps.every((step) => step.status !== 'OPEN');

/** How the plan of a halted project stands on a day: no plan yet, waiting for approval, on its way, with the steps that are past their day, or finished. */
export type PlanState = 'NO_PLAN' | 'AWAITING_APPROVAL' | 'ON_TRACK' | 'OVERDUE' | 'DONE';
export function planState(status: HaltStatus, hasPlan: boolean, steps: readonly PlanStepFacts[], today: string): PlanState {
  if (status === 'RESTARTED' || status === 'CANCELLED') return 'DONE';
  if (!hasPlan) return 'NO_PLAN';
  if (status === 'HALTED') return 'AWAITING_APPROVAL';
  return steps.some((step) => step.status === 'OPEN' && step.dueOn < today) ? 'OVERDUE' : 'ON_TRACK';
}
