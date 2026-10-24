import { defineModule } from '../module-descriptor';
import { ProjectAppraisalController } from './appraisal.controller';
import { NationalCodeController } from './national-code.controller';
import { NationalCodeFileController } from './national-code-file.controller';
import { ProjectController, ProjectReadsController } from './project.controller';
import { ProjectLifecycleReadsController, ProjectStageController } from './stage.controller';

/**
 * PRJ, the project register: projects are created in CONCEPT and described within an allowlist, read in the scope of the caller (ST-PRJ-001),
 * and move along the PIMA life cycle only through guarded commands, with the history and the project bank to read (ST-PRJ-002); a project is
 * appraised by scored sheets and admitted to the project bank by a decision (ST-PRJ-003), and given its national code by hand or from the file of the
 * national system (ST-PRJ-004).
 */
export const prjModule = defineModule({
  code: 'PRJ',
  controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController, ProjectAppraisalController, NationalCodeController, NationalCodeFileController],
});
