import { DomainError } from './errors.ts';

/**
 * The investment evaluation of a project (ST-MNE-009, MNE F9, BR-MNE-08, UAT-AC292, UAT-PLAN-74): which kind of evaluation the stage of the project allows, what a submission needs and who may decide. The kinds
 * and their stages are a working assumption until the business owner confirms the decree (CXN-13). Pure functions of their input, kept apart from the database.
 */

export const MNE_EVALUATION_KINDS = ['INITIAL', 'MIDTERM', 'FINAL', 'IMPACT', 'AD_HOC'] as const;
export type MneEvaluationKind = (typeof MNE_EVALUATION_KINDS)[number];
export const MNE_EVALUATION_STATUSES = ['PLANNED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'RETURNED'] as const;
export type MneEvaluationStatus = (typeof MNE_EVALUATION_STATUSES)[number];
export const MNE_EVALUATION_CONCLUSIONS = ['SATISFACTORY', 'PARTIALLY_SATISFACTORY', 'UNSATISFACTORY'] as const;
export type MneEvaluationConclusion = (typeof MNE_EVALUATION_CONCLUSIONS)[number];

/** The months after the start of the implementation within which the initial evaluation is made. */
export const INITIAL_EVALUATION_MONTHS = 12;

/** The project stages (the statuses of PRJ) in which each kind may be planned; `AD_HOC` is allowed in every stage. */
const STAGES: Readonly<Record<MneEvaluationKind, readonly string[] | 'ANY'>> = {
  INITIAL: ['IMPLEMENTATION'],
  MIDTERM: ['IMPLEMENTATION'],
  FINAL: ['COMPLETED', 'SETTLED'],
  IMPACT: ['CLOSED'],
  AD_HOC: 'ANY',
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whole months from one day to another (both calendar days), counted as full months. */
function monthsBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return b.getUTCDate() < a.getUTCDate() ? months - 1 : months;
}

/**
 * Whether the kind of evaluation may be planned for a project at its stage: 409 `STAGE_TRANSITION_DENIED` otherwise, naming the kind and the stage. The initial evaluation is made within twelve months of the day the
 * project entered its implementation (`stageSince`, a calendar day; when it is not known the stage alone decides).
 */
export function assertKindAtStage(kind: MneEvaluationKind, projectStatus: string, stageSince: string | null, today: string): void {
  const allowed = STAGES[kind];
  const late = kind === 'INITIAL' && stageSince !== null && DAY.test(stageSince) && monthsBetween(stageSince, today) >= INITIAL_EVALUATION_MONTHS;
  if ((allowed !== 'ANY' && !allowed.includes(projectStatus)) || late) {
    throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'evaluation_kind', { extensions: { evaluation_kind: kind, project_status: projectStatus, ...(late ? { reason: 'INITIAL_WINDOW_PASSED' } : {}) } });
  }
}

/** The statuses an evaluation is submitted from: planned, in progress, or returned for another try. */
export const EVALUATION_SUBMITTABLE: readonly MneEvaluationStatus[] = ['PLANNED', 'IN_PROGRESS', 'RETURNED'];

export interface EvaluationSubmissionFacts {
  /** What the evaluation found: a list of findings, each one an object. */
  findings: readonly unknown[];
  conclusion: string | undefined;
  completedDate: string | undefined;
}

/**
 * What a submission needs (BR-MNE-08): a conclusion of the three the evaluation ends in and the day it was completed, which is not in the future; the findings are objects. 422 `VALIDATION_FAILED` names the field.
 */
export function assertEvaluationSubmission(facts: EvaluationSubmissionFacts, today: string): MneEvaluationConclusion {
  const conclusion = MNE_EVALUATION_CONCLUSIONS.find((candidate) => candidate === facts.conclusion);
  if (conclusion === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'conclusion');
  if (facts.completedDate === undefined || !DAY.test(facts.completedDate) || new Date(`${facts.completedDate}T00:00:00Z`).toISOString().slice(0, 10) !== facts.completedDate) throw new DomainError('VALIDATION_FAILED', 422, 'completed_date');
  if (facts.completedDate > today) throw new DomainError('VALIDATION_FAILED', 422, 'completed_date', { extensions: { reason: 'IN_THE_FUTURE' } });
  if (facts.findings.some((finding) => typeof finding !== 'object' || finding === null || Array.isArray(finding))) throw new DomainError('VALIDATION_FAILED', 422, 'findings');
  return conclusion;
}

/** The person who decides an evaluation is neither the one who planned it nor the one who submitted it (403 `SELF_APPROVAL_DENIED`). */
export function assertEvaluationDecider(actor: string, planner: string, submitter: string | null): void {
  const who = actor.toLowerCase();
  if (who === planner.toLowerCase() || (submitter !== null && who === submitter.toLowerCase())) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}
