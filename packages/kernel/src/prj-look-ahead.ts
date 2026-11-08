import { DomainError } from './errors.ts';

/**
 * The look-ahead plan of a project and the lessons learned at its closing gate (G1-19, QMS/PRJ, roadmap K13). A look-ahead plan is the rolling plan of the work of the next 2 to 6 weeks (the window is a rule): each item
 * of work names what has to be ready before it starts (a constraint: design, material, labour, equipment, permit, site access, inspection, payment), and at the end of the week it is recorded as done or not done with
 * a standard reason, so the share of the committed work that was done (PPC, the percent plan complete) can be read week by week. The lessons learned are the record of what the project would do differently; the
 * closing gate asks for approved lessons (or an approved waiver with a reason) before a project is closed. Everything is pure: dates are Vietnam calendar days `YYYY-MM-DD`, percents are made from whole numbers.
 */

export const LOOK_AHEAD_RULE_TYPE = 'LOOK_AHEAD_POLICY';
export const LESSONS_RULE_TYPE = 'LESSONS_LEARNED_POLICY';
export const POLICY_RULE_CODE = 'DEFAULT';

export const CONSTRAINT_KINDS = ['DESIGN', 'MATERIAL', 'LABOUR', 'EQUIPMENT', 'PERMIT', 'SITE_ACCESS', 'INSPECTION', 'PAYMENT', 'OTHER'] as const;
export const VARIANCE_REASONS = ['CONSTRAINT_NOT_CLEARED', 'WEATHER', 'LABOUR_SHORTAGE', 'MATERIAL_LATE', 'EQUIPMENT_DOWN', 'DESIGN_CHANGE', 'PRECEDING_WORK_LATE', 'QUALITY_REWORK', 'SAFETY_STOP', 'OTHER'] as const;
export const LESSON_CATEGORIES = ['PLANNING', 'PROCUREMENT', 'DESIGN', 'COST', 'SCHEDULE', 'QUALITY', 'SAFETY', 'CONTRACTOR', 'LAND', 'STAKEHOLDERS', 'OTHER'] as const;

export interface LookAheadPolicy {
  minWeeks: number;
  maxWeeks: number;
  defaultWeeks: number;
  /** A project in implementation should publish a new plan at least this often (calendar days). */
  cadenceDays: number;
  /** An item that starts within this many days must have no open constraint; one that has is not ready. */
  readyLeadDays: number;
  ppcTargetPct: number;
  /** A week whose PPC is below this raises the alert (percent). */
  ppcAlertBelowPct: number;
  constraintKinds: readonly string[];
  varianceReasons: readonly string[];
}

export function lookAheadDefaults(): Record<string, unknown> {
  return {
    min_weeks: 2,
    max_weeks: 6,
    default_weeks: 3,
    cadence_days: 7,
    ready_lead_days: 7,
    ppc_target_pct: 80,
    ppc_alert_below_pct: 60,
    constraint_kinds: [...CONSTRAINT_KINDS],
    variance_reasons: [...VARIANCE_REASONS],
  };
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

function codes(value: unknown, field: string, mustHave: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40 || !value.every((entry) => typeof entry === 'string' && CODE.test(entry)) || new Set(value).size !== value.length) throw invalid(field);
  for (const required of mustHave) if (!value.includes(required)) throw invalid(field);
  return value as string[];
}

export function lookAheadPolicyOf(params: unknown): LookAheadPolicy {
  if (!isRecord(params)) throw invalid('params');
  const int = (key: string, min: number, max: number): number => {
    const value = params[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(key);
    return value;
  };
  const pct = (key: string): number => {
    const value = params[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw invalid(key);
    return value;
  };
  const minWeeks = int('min_weeks', 1, 12);
  const maxWeeks = int('max_weeks', 1, 26);
  const defaultWeeks = int('default_weeks', 1, 26);
  if (maxWeeks < minWeeks) throw invalid('max_weeks');
  if (defaultWeeks < minWeeks || defaultWeeks > maxWeeks) throw invalid('default_weeks');
  const target = pct('ppc_target_pct');
  const below = pct('ppc_alert_below_pct');
  if (below > target) throw invalid('ppc_alert_below_pct');
  return {
    minWeeks,
    maxWeeks,
    defaultWeeks,
    cadenceDays: int('cadence_days', 1, 31),
    readyLeadDays: int('ready_lead_days', 0, 60),
    ppcTargetPct: target,
    ppcAlertBelowPct: below,
    // OTHER is always there: a constraint nobody foresaw must still be recordable, and so must the reason of a week that went wrong.
    constraintKinds: codes(params.constraint_kinds, 'constraint_kinds', ['OTHER']),
    varianceReasons: codes(params.variance_reasons, 'variance_reasons', ['OTHER']),
  };
}

// -- Days -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayMs = (day: string): number => {
  const match = DAY.exec(day);
  if (match === null) throw invalid('day');
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDaysTo = (day: string, days: number): string => dayOf(dayMs(day) + days * 86_400_000);
export const daysBetweenDays = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / 86_400_000);
/** The Monday of the week that holds the day. */
export const mondayOf = (day: string): string => addDaysTo(day, -((new Date(dayMs(day)).getUTCDay() + 6) % 7));
export const isMonday = (day: string): boolean => new Date(dayMs(day)).getUTCDay() === 1;

/** The first day after the window: a plan of `weeks` weeks that starts on `weekStart` covers the days before it. */
export const windowEnd = (weekStart: string, weeks: number): string => addDaysTo(weekStart, weeks * 7);

// -- The plan -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ItemDraft {
  description: string;
  plannedStart: string;
  plannedFinish: string;
  /** The trade, crew or subcontractor that is to do the work. */
  responsible: string | null;
}

/** The weeks a plan covers must be within the rule (422 `LOOK_AHEAD_WINDOW_INVALID`), and it starts on a Monday so that weeks of different plans line up. */
export function assertWindow(weekStart: string, weeks: number, policy: LookAheadPolicy): void {
  if (!Number.isInteger(weeks) || weeks < policy.minWeeks || weeks > policy.maxWeeks) throw new DomainError('LOOK_AHEAD_WINDOW_INVALID', 422, 'horizon_weeks', { extensions: { min_weeks: policy.minWeeks, max_weeks: policy.maxWeeks } });
  if (!isMonday(weekStart)) throw new DomainError('VALIDATION_FAILED', 422, 'week_start');
}

/** The items of a plan: each has words, a start that is not after its finish, and lies inside the window of the plan. */
export function assertItems(items: readonly ItemDraft[], weekStart: string, weeks: number): void {
  if (items.length === 0 || items.length > 500) throw invalid('items');
  const end = windowEnd(weekStart, weeks);
  items.forEach((item, index) => {
    if (item.description.trim().length < 3 || item.description.length > 500) throw invalid(`items[${index}].description`);
    if (dayMs(item.plannedStart) > dayMs(item.plannedFinish)) throw invalid(`items[${index}].planned_finish`);
    if (item.plannedStart < weekStart || item.plannedStart >= end) throw invalid(`items[${index}].planned_start`);
  });
}

export const ITEM_STATES = ['READY', 'CONSTRAINED', 'NOT_READY', 'DONE', 'NOT_DONE'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export interface ItemFacts {
  plannedStart: string;
  outcome: 'PLANNED' | 'DONE' | 'NOT_DONE';
  openConstraints: number;
}

/**
 * Where an item stands on a day: DONE or NOT_DONE once recorded; READY when it has no open constraint; NOT_READY when it has one and starts within the lead days of the rule (or already should have started), so
 * somebody must clear it now; CONSTRAINED when it has one but there is still time.
 */
export function itemState(item: ItemFacts, today: string, policy: Pick<LookAheadPolicy, 'readyLeadDays'>): ItemState {
  if (item.outcome === 'DONE') return 'DONE';
  if (item.outcome === 'NOT_DONE') return 'NOT_DONE';
  if (item.openConstraints === 0) return 'READY';
  return daysBetweenDays(today, item.plannedStart) <= policy.readyLeadDays ? 'NOT_READY' : 'CONSTRAINED';
}

export interface Ppc {
  committed: number;
  done: number;
  /** done / committed as a percent, one decimal, half up; null when nothing was recorded yet. */
  pct: string | null;
  band: 'ON_TARGET' | 'BELOW_TARGET' | 'ALERT' | 'NO_DATA';
}

/** The percent plan complete of a week: the items that were recorded (done or not done), never the ones still planned. */
export function ppcOf(outcomes: readonly ('PLANNED' | 'DONE' | 'NOT_DONE')[], policy: Pick<LookAheadPolicy, 'ppcTargetPct' | 'ppcAlertBelowPct'>): Ppc {
  const done = outcomes.filter((outcome) => outcome === 'DONE').length;
  const committed = done + outcomes.filter((outcome) => outcome === 'NOT_DONE').length;
  if (committed === 0) return { committed: 0, done: 0, pct: null, band: 'NO_DATA' };
  const scaled = Math.floor((done * 2000 + committed) / (2 * committed));
  const pct = `${Math.floor(scaled / 10)}.${scaled % 10}`;
  const value = scaled / 10;
  return { committed, done, pct, band: value < policy.ppcAlertBelowPct ? 'ALERT' : value < policy.ppcTargetPct ? 'BELOW_TARGET' : 'ON_TARGET' };
}

/** A not-done item must say why with a reason of the list; a done item carries none. */
export function assertOutcome(outcome: string, reasonCode: string | undefined, policy: Pick<LookAheadPolicy, 'varianceReasons'>): 'DONE' | 'NOT_DONE' {
  if (outcome !== 'DONE' && outcome !== 'NOT_DONE') throw invalid('outcome');
  if (outcome === 'DONE') {
    if (reasonCode !== undefined) throw invalid('reason_code');
    return 'DONE';
  }
  if (reasonCode === undefined || !policy.varianceReasons.includes(reasonCode)) throw invalid('reason_code');
  return 'NOT_DONE';
}

export function assertConstraintKind(kind: string, policy: Pick<LookAheadPolicy, 'constraintKinds'>): void {
  if (!policy.constraintKinds.includes(kind)) throw invalid('kind');
}

/** Whether the project is overdue for a plan: the latest published plan began more than the cadence ago (or there is none and the project has been in implementation longer than the cadence). */
export function planOverdue(latestWeekStart: string | null, today: string, policy: Pick<LookAheadPolicy, 'cadenceDays'>, implementingSince: string | null): boolean {
  const since = latestWeekStart ?? implementingSince;
  if (since === null) return false;
  return daysBetweenDays(since, today) > policy.cadenceDays + (latestWeekStart === null ? 0 : 6);
}

// -- Lessons learned ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const LESSON_GATES = ['CLOSE'] as const;

export interface LessonsPolicy {
  requiredAt: readonly string[];
  minApproved: number;
  allowWaiver: boolean;
  minTextLength: number;
  categories: readonly string[];
}

export function lessonsDefaults(): Record<string, unknown> {
  return { required_at: ['CLOSE'], min_approved: 1, allow_waiver: true, min_text_length: 20, categories: [...LESSON_CATEGORIES] };
}

export function lessonsPolicyOf(params: unknown): LessonsPolicy {
  if (!isRecord(params)) throw invalid('params');
  const required = params.required_at;
  if (!Array.isArray(required) || !required.every((gate) => typeof gate === 'string' && (LESSON_GATES as readonly string[]).includes(gate)) || new Set(required).size !== required.length) throw invalid('required_at');
  const minApproved = params.min_approved;
  if (typeof minApproved !== 'number' || !Number.isInteger(minApproved) || minApproved < 0 || minApproved > 20) throw invalid('min_approved');
  if (typeof params.allow_waiver !== 'boolean') throw invalid('allow_waiver');
  const text = params.min_text_length;
  if (typeof text !== 'number' || !Number.isInteger(text) || text < 5 || text > 500) throw invalid('min_text_length');
  return { requiredAt: required as string[], minApproved, allowWaiver: params.allow_waiver, minTextLength: text, categories: codes(params.categories, 'categories', ['OTHER']) };
}

export interface LessonDraft {
  category: string;
  title: string;
  situation: string;
  recommendation: string;
}

/** A lesson has a category of the list, a title, what happened and what to do next time, each with enough words to be of use to the next project. */
export function assertLesson(draft: LessonDraft, policy: LessonsPolicy): void {
  if (!policy.categories.includes(draft.category)) throw invalid('category');
  if (draft.title.trim().length < 5 || draft.title.length > 200) throw invalid('title');
  if (draft.situation.trim().length < policy.minTextLength || draft.situation.length > 4000) throw invalid('situation');
  if (draft.recommendation.trim().length < policy.minTextLength || draft.recommendation.length > 4000) throw invalid('recommendation');
}

export type LessonsGateReason = 'NOT_REQUIRED' | 'APPROVED_LESSONS' | 'WAIVER_APPROVED' | 'MISSING' | 'PENDING_REVIEW' | 'WAIVER_PENDING';

export interface LessonsGateFacts {
  gate: string;
  approved: number;
  pending: number;
  waiverApproved: boolean;
  waiverPending: boolean;
}

export interface LessonsGateReading {
  met: boolean;
  reason: LessonsGateReason;
  required: number;
  approved: number;
}

/**
 * The closing gate: met when the rule does not require lessons at this gate, when the project has the number of approved lessons the rule asks for, or when a waiver was approved (and the rule allows one). The
 * reason says what is missing so the screen can tell the person what to do: nothing proposed, lessons waiting for a reviewer, or a waiver waiting for a second person.
 */
export function lessonsGate(facts: LessonsGateFacts, policy: LessonsPolicy): LessonsGateReading {
  const base = { required: policy.minApproved, approved: facts.approved };
  if (!policy.requiredAt.includes(facts.gate) || policy.minApproved === 0) return { ...base, met: true, reason: 'NOT_REQUIRED' };
  if (facts.approved >= policy.minApproved) return { ...base, met: true, reason: 'APPROVED_LESSONS' };
  if (policy.allowWaiver && facts.waiverApproved) return { ...base, met: true, reason: 'WAIVER_APPROVED' };
  if (facts.pending > 0) return { ...base, met: false, reason: 'PENDING_REVIEW' };
  if (policy.allowWaiver && facts.waiverPending) return { ...base, met: false, reason: 'WAIVER_PENDING' };
  return { ...base, met: false, reason: 'MISSING' };
}
