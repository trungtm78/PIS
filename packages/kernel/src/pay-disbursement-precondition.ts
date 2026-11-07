import { DomainError } from './errors.ts';
import type { DisbursementPreconditionPolicy } from './gov-b1-policy.ts';

/**
 * The precondition of a disbursement (G1-2; NĐ 85/2025 Điều 53, research F-PAY): money is paid only for a project that is on the list of the investment projects and has an approved amount in the capital plan on the
 * system. The number on the system wins over paper: a paper decision that the system does not hold does not open the payment. Each refusal names its cause and the way to fix it, so the person at the counter is never
 * told only "refused". Pure function of its input.
 */
export const DISBURSEMENT_REFUSALS = ['DISBURSEMENT_PROJECT_NOT_LISTED', 'DISBURSEMENT_NO_APPROVED_PLAN'] as const;
export type DisbursementRefusal = (typeof DISBURSEMENT_REFUSALS)[number];

/** Where a refusal is fixed: the screen of the register of projects or of the capital plan. The text of the fix is the key of the catalogue, never a sentence made here. */
export type DisbursementFix = 'COMPLETE_STAGE_TRANSITION' | 'ENTER_APPROVED_PLAN';

export interface DisbursementFacts {
  projectId: string;
  projectCode: string;
  /** The stage of the project in the register. */
  projectStatus: string;
  /** What the capital plan of the system allots to the project, the sum of the balances of its lines, whole dong. */
  allocatedVnd: string;
  /** A re-appraisal of the project is asked for and not decided (G1-3): only a warning, the payment is not stopped by it. */
  reappraisalOpen: boolean;
}

export interface DisbursementVerdict {
  allowed: boolean;
  refusal: DisbursementRefusal | null;
  /** The stage that closes the door, or the amount that is missing: what the screen shows next to the cause. */
  cause: { projectStatus: string; allocatedVnd: string };
  fix: DisbursementFix | null;
  warnings: Array<'REAPPRAISAL_OPEN'>;
}

/** The verdict, without throwing: the read operation and the guard both stand on it. */
export function disbursementVerdict(facts: DisbursementFacts, policy: DisbursementPreconditionPolicy): DisbursementVerdict {
  const cause = { projectStatus: facts.projectStatus, allocatedVnd: facts.allocatedVnd };
  const warnings: Array<'REAPPRAISAL_OPEN'> = facts.reappraisalOpen ? ['REAPPRAISAL_OPEN'] : [];
  if (policy.unlistedStatuses.includes(facts.projectStatus)) return { allowed: false, refusal: 'DISBURSEMENT_PROJECT_NOT_LISTED', cause, fix: 'COMPLETE_STAGE_TRANSITION', warnings };
  if (policy.requireApprovedPlan && BigInt(facts.allocatedVnd) <= 0n) return { allowed: false, refusal: 'DISBURSEMENT_NO_APPROVED_PLAN', cause, fix: 'ENTER_APPROVED_PLAN', warnings };
  return { allowed: true, refusal: null, cause, fix: null, warnings };
}

/** 422 with the cause and the fix when the project may not be paid; the warnings otherwise. */
export function assertDisbursementAllowed(facts: DisbursementFacts, policy: DisbursementPreconditionPolicy): Array<'REAPPRAISAL_OPEN'> {
  const verdict = disbursementVerdict(facts, policy);
  if (!verdict.allowed && verdict.refusal !== null) {
    throw new DomainError(verdict.refusal, 422, 'project_id', {
      extensions: { project_id: facts.projectId, project_code: facts.projectCode, project_status: verdict.cause.projectStatus, allocated_vnd: verdict.cause.allocatedVnd, fix: verdict.fix },
    });
  }
  return verdict.warnings;
}
