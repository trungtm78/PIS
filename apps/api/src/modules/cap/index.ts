import { defineModule } from '../module-descriptor';
import { AppropriationController, AppropriationReadsController } from './appropriation.controller';

/** CAP, plan and capital sources: the appropriation register by origin, published by an approver who is not its planner (ST-CAP-001). */
export const capModule = defineModule({
  code: 'CAP',
  controllers: [AppropriationController, AppropriationReadsController],
});
