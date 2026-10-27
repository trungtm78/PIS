import { defineModule } from '../module-descriptor';
import { ProjectAccountabilityController } from './accountability.controller';
import { ExplanationController } from './explanation.controller';
import { AccountabilityReadsController } from './accountability-reads.controller';
import { ProjectAppraisalController } from './appraisal.controller';
import { NationalCodeController } from './national-code.controller';
import { NationalCodeFileController } from './national-code-file.controller';
import { ProjectController, ProjectReadsController } from './project.controller';
import { ProjectLifecycleReadsController, ProjectStageController } from './stage.controller';
import { TaskForceController } from './task-force.controller';
import { TransferController } from './transfer.controller';

/**
 * PRJ, the project register: projects are created in CONCEPT and described within an allowlist, read in the scope of the caller (ST-PRJ-001),
 * and move along the PIMA life cycle only through guarded commands, with the history and the project bank to read (ST-PRJ-002); a project is
 * appraised by scored sheets and admitted to the project bank by a decision (ST-PRJ-003), and given its national code by hand or from the file of the
 * national system (ST-PRJ-004); who answers for a project and the task forces that press its disbursement are administered for the whole tenant (ST-PRJ-005); a leader asks the
 * person who answers for a project or a unit to explain, and someone else accepts the answer or returns it (ST-PRJ-006); a project passes from one unit to another by a request and a decision of someone else,
 * from a day, with the reports and snapshots before it kept under the old unit (ST-PRJ-007).
 */
export const prjModule = defineModule({
  code: 'PRJ',
  controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController, ProjectAppraisalController, NationalCodeController, NationalCodeFileController, ProjectAccountabilityController, AccountabilityReadsController, TaskForceController, ExplanationController, TransferController],
});
