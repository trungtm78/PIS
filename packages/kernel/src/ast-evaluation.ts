import { addMonthsClamped } from './billing-period.ts';
import { DomainError } from './errors.ts';

/**
 * The trigger of the evaluation after the investment (ST-AST-006, AST 3.4, UC-AST-04, UAT-AC394): the kinds of trigger, its statuses, the earliest day a trigger after a handover may fall due, the stages of
 * a project at which a trigger is set and the moves of its status. Pure functions of their input, kept apart from the database.
 */

export const EVALUATION_TRIGGER_KINDS = ['POST_HANDOVER_12M', 'POST_HANDOVER_24M', 'SETTLEMENT_CLOSED', 'MANUAL'] as const;
export type EvaluationTriggerKind = (typeof EVALUATION_TRIGGER_KINDS)[number];

export const EVALUATION_TRIGGER_STATUSES = ['SCHEDULED', 'FIRED', 'ACKNOWLEDGED', 'CANCELLED'] as const;
export type EvaluationTriggerStatus = (typeof EVALUATION_TRIGGER_STATUSES)[number];

const MONTHS_AFTER_HANDOVER: Readonly<Partial<Record<EvaluationTriggerKind, number>>> = { POST_HANDOVER_12M: 12, POST_HANDOVER_24M: 24 };

/** A trigger after a handover is set on an accepted handover and falls due a fixed number of months after the day it was accepted. */
export const isPostHandoverKind = (kind: EvaluationTriggerKind): boolean => MONTHS_AFTER_HANDOVER[kind] !== undefined;

/** The earliest day a trigger after a handover may fall due: the day of acceptance plus 12 or 24 months (the last day of the month when that month is shorter); undefined for the other kinds. */
export function earliestDueOn(kind: EvaluationTriggerKind, acceptedOn: string): string | undefined {
  const months = MONTHS_AFTER_HANDOVER[kind];
  return months === undefined ? undefined : addMonthsClamped(acceptedOn, months);
}

/** A project is evaluated once the work is under way: not before it is implemented, and never when it was rejected or cancelled. */
const EVALUABLE_STAGES: ReadonlySet<string> = new Set(['IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED']);
/** The settlement of the project is what the trigger of the closed settlement waits for. */
const SETTLED_STAGES: ReadonlySet<string> = new Set(['SETTLED', 'CLOSED']);

/** The stage of the project has to admit the trigger (422 `PROJECT_STAGE_INVALID`): a trigger of the closed settlement needs a project that is settled. */
export function assertTriggerStage(kind: EvaluationTriggerKind, projectStatus: string): void {
  const admitted = kind === 'SETTLEMENT_CLOSED' ? SETTLED_STAGES.has(projectStatus) : EVALUABLE_STAGES.has(projectStatus);
  if (!admitted) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id', { extensions: { status: projectStatus } });
}

/** What happens to a trigger: the job fires it on its day, the evaluation of MNE acknowledges it. */
export type TriggerMove = 'FIRE' | 'ACKNOWLEDGE';

/** The status after the move; any other start is 409 `TRIGGER_STATE_INVALID` with the status the trigger is in. */
export function nextTriggerStatus(from: EvaluationTriggerStatus, move: TriggerMove): EvaluationTriggerStatus {
  if (move === 'FIRE' && from === 'SCHEDULED') return 'FIRED';
  if (move === 'ACKNOWLEDGE' && from === 'FIRED') return 'ACKNOWLEDGED';
  throw new DomainError('TRIGGER_STATE_INVALID', 409, 'status', { extensions: { status: from } });
}
