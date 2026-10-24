import { defineModule } from '../module-descriptor';
import { ProjectController, ProjectReadsController } from './project.controller';
import { ProjectLifecycleReadsController, ProjectStageController } from './stage.controller';

/**
 * PRJ, the project register: projects are created in CONCEPT and described within an allowlist, read in the scope of the caller (ST-PRJ-001),
 * and move along the PIMA life cycle only through guarded commands, with the history and the project bank to read (ST-PRJ-002).
 */
export const prjModule = defineModule({
  code: 'PRJ',
  controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController],
});
