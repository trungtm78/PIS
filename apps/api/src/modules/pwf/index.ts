import { defineModule } from '../module-descriptor';
import { PwfDeadlineReadsController } from './deadline.controller';
import { PwfKpiReadsController } from './kpi.controller';
import { ProjectRescheduleController } from './reschedule.controller';
import { StaffScoreReadsController } from './score-reads.controller';
import { PwfScoreResponseBinding } from './score-response.binding';
import { StaffScoreController } from './score.controller';
import { ProjectTaskController, ProjectTaskReadsController } from './task.controller';
import { ProjectWorkflowController, ProjectWorkflowReadsController } from './workflow.controller';

/**
 * PWF, the workflow of a project: an approved template of the kind of project is frozen into the project when its workflow starts or a running project is taken in (PWF-1), the schedule of the tasks and milestones is laid on the
 * working calendar and published in versions (PWF-2), and the legal commands that move a project are kept closed by a gate until the required tasks of the phase are done (R29). The KPIs of the tasks and the scores of the staff by period (PWF-3) are read and written here, with the privacy of R33 and the answer of the person scored through the approval engine (R43). Public code for both editions: the types of
 * legal document of an edition are resolved through its manifest (R42).
 */
export const pwfModule = defineModule({
  code: 'PWF',
  providers: [PwfScoreResponseBinding],
  controllers: [ProjectWorkflowController, ProjectWorkflowReadsController, ProjectTaskController, ProjectTaskReadsController, ProjectRescheduleController, PwfDeadlineReadsController, PwfKpiReadsController, StaffScoreController, StaffScoreReadsController],
});
