import { defineModule } from '../module-descriptor';
import { AllocationExtensionController, AllocationExtensionReadsController } from './allocation-extension.controller';
import { AppropriationController, AppropriationReadsController } from './appropriation.controller';
import { FiscalYearController, FiscalYearReadsController } from './fiscal-year.controller';
import { AvcPolicyController } from './avc-policy.controller';
import { CapitalAvailabilityController } from './availability.controller';
import { ContractAvcController } from './contract-avc.controller';
import { CapitalLedgerController } from './ledger.controller';
import { FundReservationController } from './reservation.controller';
import { CapitalCommitments } from './commitment.port';
import { CapitalPlanApprovalController } from './plan-approval.controller';
import { CapitalPlanRevisionController } from './plan-revision.controller';
import { DisbursementScheduleController } from './schedule.controller';
import { ReallocationController } from './reallocation.controller';
import { ScenarioController } from './scenario.controller';
import { AllocationLineReadsController, CapitalPlanController, CapitalPlanLinesController, PlanVersionReadsController } from './plan.controller';

/**
 * CAP, plan and capital sources: the appropriation register by origin, published by an approver who is not its planner (ST-CAP-001), and the
 * drafting of the capital plan with its allocation lines under the ceiling of the appropriations (ST-CAP-002), and its approval and publication
 * with the ledger and the balances (ST-CAP-003), the revision of a published plan with its reading as of a date (ST-CAP-004), and the registration of the
 * disbursement schedule, which is a promise and never money paid (ST-CAP-009), and the availability control: the policy with its thresholds, the capital left on a line, and the
 * port that commits capital against it (ST-CAP-005), and the carry-over of undisbursed capital to the next year with the document that allows it (ST-CAP-007), and the closing of the fiscal year with its lapse and its time-boxed reopening (ST-CAP-008), and the simulation of an allocation that never touches the ledger (ST-CAP-013).
 */
export const capModule = defineModule({
  code: 'CAP',
  controllers: [CapitalLedgerController, FundReservationController, AppropriationController, AppropriationReadsController, CapitalPlanController, CapitalPlanApprovalController, CapitalPlanRevisionController, ReallocationController, ScenarioController, CapitalPlanLinesController, PlanVersionReadsController, AllocationLineReadsController, DisbursementScheduleController, AvcPolicyController, CapitalAvailabilityController, ContractAvcController, AllocationExtensionController, AllocationExtensionReadsController, FiscalYearController, FiscalYearReadsController],
  // The port the spending modules commit capital through (ST-CAP-005).
  providers: [CapitalCommitments],
});

export { CapitalCommitments } from './commitment.port';

export { APPROVAL_STATES, CAPITAL_PLAN_APPROVAL_WORKFLOW, capitalPlanApprovalWorkflow } from './plan-approval.workflow';
export type { ApprovalWorkflowDeps } from './plan-approval.workflow';

export { CAPITAL_REALLOCATION_WORKFLOW, REALLOCATION_STATES, capitalReallocationWorkflow } from './reallocation.workflow';
export type { ReallocationWorkflowDeps } from './reallocation.workflow';
