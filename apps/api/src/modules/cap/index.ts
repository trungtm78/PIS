import { defineModule } from '../module-descriptor';
import { AppropriationController, AppropriationReadsController } from './appropriation.controller';
import { CapitalPlanApprovalController } from './plan-approval.controller';
import { CapitalPlanRevisionController } from './plan-revision.controller';
import { DisbursementScheduleController } from './schedule.controller';
import { AllocationLineReadsController, CapitalPlanController, CapitalPlanLinesController, PlanVersionReadsController } from './plan.controller';

/**
 * CAP, plan and capital sources: the appropriation register by origin, published by an approver who is not its planner (ST-CAP-001), and the
 * drafting of the capital plan with its allocation lines under the ceiling of the appropriations (ST-CAP-002), and its approval and publication
 * with the ledger and the balances (ST-CAP-003), the revision of a published plan with its reading as of a date (ST-CAP-004), and the registration of the
 * disbursement schedule, which is a promise and never money paid (ST-CAP-009).
 */
export const capModule = defineModule({
  code: 'CAP',
  controllers: [AppropriationController, AppropriationReadsController, CapitalPlanController, CapitalPlanApprovalController, CapitalPlanRevisionController, CapitalPlanLinesController, PlanVersionReadsController, AllocationLineReadsController, DisbursementScheduleController],
});

export { APPROVAL_STATES, CAPITAL_PLAN_APPROVAL_WORKFLOW, capitalPlanApprovalWorkflow } from './plan-approval.workflow';
export type { ApprovalWorkflowDeps } from './plan-approval.workflow';
