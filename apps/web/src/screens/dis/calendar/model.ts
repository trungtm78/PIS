import type { Tone } from '../../../ui';

/** The steps of the chain of a period, in order (the same words as the schedule rule `REPORTING_SCHEDULE`). */
export const STEP_KINDS = ['ENTRY', 'UNIT_APPROVAL', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_STATES = ['DONE', 'DONE_LATE', 'DUE_SOON', 'OPEN', 'OVERDUE', 'NOT_TRACKED'] as const;
export type StepState = (typeof STEP_STATES)[number];

export const ITEM_KINDS = ['REPORT_PERIOD', 'PLAN_ADJUSTMENT', 'MEETING', 'DIRECTIVE_DUE'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const SCHEDULE_CODES = ['MONTH', 'QUARTER', 'YEAR', 'MEETING', 'PLAN_ADJUSTMENT'] as const;

/** The tone of a state on the board: late and overdue are red, done late is amber, a step with no fact is neutral (never green). */
export const STATE_TONE: Readonly<Record<StepState, Tone>> = { DONE: 'success', DONE_LATE: 'warning', DUE_SOON: 'warning', OPEN: 'info', OVERDUE: 'danger', NOT_TRACKED: 'neutral' };

export const isStepKind = (value: unknown): value is StepKind => typeof value === 'string' && (STEP_KINDS as readonly string[]).includes(value);
export const stepStateOf = (value: unknown): StepState => (typeof value === 'string' && (STEP_STATES as readonly string[]).includes(value) ? (value as StepState) : 'NOT_TRACKED');
export const itemKindOf = (value: unknown): ItemKind | undefined => (typeof value === 'string' && (ITEM_KINDS as readonly string[]).includes(value) ? (value as ItemKind) : undefined);

/** The first year offered and the last: a calendar is read a year at a time. */
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2200;

/** A year typed in the filter, or undefined when it is not one the API takes. */
export function yearOf(value: string): number | undefined {
  if (!/^\d{4}$/.test(value)) return undefined;
  const year = Number(value);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : undefined;
}

export const stepKeyOf = (kind: StepKind): string => {
  switch (kind) {
    case 'ENTRY':
      return 'entry';
    case 'UNIT_APPROVAL':
      return 'unitApproval';
    case 'PLANNING_REVIEW':
      return 'planningReview';
    case 'PERIOD_CLOSE':
      return 'periodClose';
    case 'PUSH':
      return 'push';
  }
};

export function stateKeyOf(state: StepState): string {
  switch (state) {
    case 'DONE':
      return 'done';
    case 'DONE_LATE':
      return 'doneLate';
    case 'DUE_SOON':
      return 'dueSoon';
    case 'OPEN':
      return 'open';
    case 'OVERDUE':
      return 'overdue';
    case 'NOT_TRACKED':
      return 'notTracked';
  }
}

export function kindKeyOf(kind: ItemKind): string {
  switch (kind) {
    case 'REPORT_PERIOD':
      return 'period';
    case 'PLAN_ADJUSTMENT':
      return 'planAdjustment';
    case 'MEETING':
      return 'meeting';
    case 'DIRECTIVE_DUE':
      return 'directive';
  }
}

export function scheduleKeyOf(code: string): string {
  switch (code) {
    case 'MONTH':
      return 'month';
    case 'QUARTER':
      return 'quarter';
    case 'YEAR':
      return 'year';
    case 'MEETING':
      return 'meeting';
    default:
      return 'planAdjustment';
  }
}

export function reminderKindKeyOf(kind: string): string {
  return kind === 'ESCALATED' ? 'escalated' : kind === 'OVERDUE' ? 'overdue' : 'beforeDue';
}
