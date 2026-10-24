import { defineModule } from '../module-descriptor';
import { AppropriationController, AppropriationReadsController } from './appropriation.controller';
import { AllocationLineReadsController, CapitalPlanController, CapitalPlanLinesController, PlanVersionReadsController } from './plan.controller';

/**
 * CAP, plan and capital sources: the appropriation register by origin, published by an approver who is not its planner (ST-CAP-001), and the
 * drafting of the capital plan with its allocation lines under the ceiling of the appropriations (ST-CAP-002).
 */
export const capModule = defineModule({
  code: 'CAP',
  controllers: [AppropriationController, AppropriationReadsController, CapitalPlanController, CapitalPlanLinesController, PlanVersionReadsController, AllocationLineReadsController],
});
