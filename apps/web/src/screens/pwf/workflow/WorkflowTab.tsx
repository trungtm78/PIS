import type { ProjectView } from '../../prj/model';
import { WorkflowBody } from './WorkflowBody';

/** PRJ-03, tab "Workflow": the workflow of the project (phases, tree, schedule, milestones, board, gates). */
export default function WorkflowTab({ project }: { project: ProjectView }) {
  return (
    <div data-testid="tab-workflow">
      <WorkflowBody projectId={project.id} />
    </div>
  );
}
