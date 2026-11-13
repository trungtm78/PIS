import { defineModule } from '../module-descriptor';
import { PwfDeadlineReadsController } from './deadline.controller';
import { PwfPreferenceController } from './preference.controller';
import { ProjectRescheduleController } from './reschedule.controller';
import { ProjectTaskController, ProjectTaskReadsController } from './task.controller';
import { ProjectWorkflowController, ProjectWorkflowReadsController } from './workflow.controller';

/**
 * PWF, the workflow of a project: an approved template of the kind of project is frozen into the project when its workflow starts or a running project is taken in (PWF-1), the schedule of the tasks and milestones is laid on the
 * working calendar and published in versions (PWF-2), and the legal commands that move a project are kept closed by a gate until the required tasks of the phase are done (R29). Public code for both editions: the types of
 * legal document of an edition are resolved through its manifest (R42).
 */
export const pwfModule = defineModule({
  code: 'PWF',
  controllers: [ProjectWorkflowController, ProjectWorkflowReadsController, ProjectTaskController, ProjectTaskReadsController, ProjectRescheduleController, PwfDeadlineReadsController, PwfPreferenceController],
});
