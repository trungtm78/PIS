import { defineModule } from '../module-descriptor';
import { ProjectController, ProjectReadsController } from './project.controller';

/** PRJ, the project register: projects are created in CONCEPT and described within an allowlist, read in the scope of the caller (ST-PRJ-001). */
export const prjModule = defineModule({
  code: 'PRJ',
  controllers: [ProjectController, ProjectReadsController],
});
