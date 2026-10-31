import { DomainError } from './errors.ts';

/**
 * The enforcement of a land recovery (ST-LND-011, LND 3.3, UC-LND-03, LND-09, UAT-AC385): the steps of a case, the moves between them, what each step needs and who may not advance a case. Pure functions of their input,
 * kept apart from the database. The procedure is a working assumption until the business owner confirms the rule (CXN-12).
 */

export const ENFORCEMENT_STEPS = ['PERSUASION', 'NOTICE', 'ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING', 'COMPLETED', 'SUSPENDED'] as const;
export type EnforcementStep = (typeof ENFORCEMENT_STEPS)[number];

/** The steps a case goes through, in order; a case may be suspended from any of them but the last. */
const FLOW: readonly EnforcementStep[] = ['PERSUASION', 'NOTICE', 'ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING', 'COMPLETED'];

/** The step after the given one in the flow; undefined for the last and for a suspended case. */
export const stepAfter = (step: EnforcementStep): EnforcementStep | undefined => {
  const at = FLOW.indexOf(step);
  return at < 0 ? undefined : FLOW[at + 1];
};

/**
 * Whether a case may go from a step to another: forward by one step; to `SUSPENDED` from any step that is not the last; from `SUSPENDED` back to the step it was suspended from (when the flow can be entered there) or to the step
 * after it. Anything else is 422 `ENFORCEMENT_STEP_INVALID` with the steps.
 */
export function assertEnforcementMove(from: EnforcementStep, to: EnforcementStep, suspendedFrom: EnforcementStep | null): void {
  const allowed = (): boolean => {
    if (from === 'COMPLETED') return false;
    if (to === 'SUSPENDED') return from !== 'SUSPENDED';
    if (from === 'SUSPENDED') return suspendedFrom !== null && (to === suspendedFrom || to === stepAfter(suspendedFrom)) && to !== 'PERSUASION';
    return stepAfter(from) === to;
  };
  if (!allowed()) throw new DomainError('ENFORCEMENT_STEP_INVALID', 422, 'to_step', { extensions: { from_step: from, to_step: to } });
}

/** The steps that are decisions: they come with the document of the decision. */
const DECISION_STEPS: ReadonlySet<EnforcementStep> = new Set(['ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING']);

export interface StepFacts {
  decisionDocumentVersionId: string | undefined;
  plannedOn: string | undefined;
  executedOn: string | undefined;
  suspendReason: string | undefined;
}

/**
 * What a step needs: a decision step the document of the decision (422 `DECISION_DOCUMENT_REQUIRED`), the step of execution also the day it is planned for, the completion the day it was carried out, and a suspension its
 * reason (422 `VALIDATION_FAILED` naming the field).
 */
export function assertStepFacts(to: EnforcementStep, facts: StepFacts): void {
  if (DECISION_STEPS.has(to) && facts.decisionDocumentVersionId === undefined) throw new DomainError('DECISION_DOCUMENT_REQUIRED', 422, 'decision_document_version_id');
  if (to === 'EXECUTING' && facts.plannedOn === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'planned_on');
  if (to === 'COMPLETED' && facts.executedOn === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'executed_on');
  if (to === 'SUSPENDED' && facts.suspendReason === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'suspend_reason');
}

/** The person who advances a case is not the person who drew it up (403 `SELF_APPROVAL_DENIED`). */
export function assertAdvancerIsNotDrafter(actor: string, drafter: string): void {
  if (actor.toLowerCase() === drafter.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}
