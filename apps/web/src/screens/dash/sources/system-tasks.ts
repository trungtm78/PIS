import type { ApiClient } from '@machvon/api-client';
import { inGroups, list, NotEnoughError, record, text } from './system';
import type { LooseClient } from './system';
import { TASKS_FLOOR } from './tasks';
import type { SystemDirective, SystemMeeting, SystemPhase, SystemProjectTask, SystemTaskProject, SystemTaskUnit, TasksRead } from './tasks';

/**
 * Reads what the tasks bundle is built from: the directives with the meetings they were given at, and the tasks of every project that runs a workflow. The answers are
 * taken loosely typed, field by field, as `system.ts` takes them: an answer of another shape gives an absent value, which `tasksFromSystem` leaves out or counts as
 * "not enough", and never as a row.
 *
 * The reads go from the cheapest to the dearest (one list, then one read for each project, then one for each finished task), and stop as soon as what was read already
 * shows the bundle cannot replace the template's.
 */
const PAGE = { limit: 200 } as const;

const flag = (value: unknown): boolean => value === true;

export async function readTasksInput(apiClient: ApiClient, today: string): Promise<TasksRead> {
  const client = apiClient as unknown as LooseClient;

  const directives: SystemDirective[] = (await client.readAll('listDirectives', { query: PAGE })).map(record).flatMap((row) => {
    const code = text(row.code), words = text(row.text), status = text(row.status) ?? text(row.stored_status);
    if (code === null || words === null || status === null) return [];
    const meeting = record(row.meeting);
    return [{
      code, text: words, status, unit_code: text(record(row.assignee_unit).code), project_code: text(record(row.project).code), meeting_id: text(meeting.id), meeting_code: text(meeting.code),
      due_on: text(row.due_on), closed_at: text(row.closed_at), overdue_days: typeof row.overdue_days === 'number' ? row.overdue_days : null,
    }];
  });
  // The list of directives already says it: with too few of them the bundle cannot replace the template's, and the reads below (one or more for each project, one for each
  // finished task) would be asked of the server for nothing every time the leader home opens.
  if (directives.length < TASKS_FLOOR.directives) throw new NotEnoughError(`${directives.length} directives are recorded (at least ${TASKS_FLOOR.directives} are needed)`);

  const [meetingsRaw, unitsRaw, projectsRaw] = await Promise.all([
    client.readAll('listSteeringMeetings', { query: PAGE }),
    client.readAll('get_resources_organization_unit'),
    client.readAll('get_resources_project'),
  ]);
  const meetings: SystemMeeting[] = meetingsRaw.map(record).flatMap((meeting) => {
    const id = text(meeting.id), type = text(meeting.meeting_type);
    return id === null || type === null ? [] : [{ id, meeting_type: type }];
  });
  const units: SystemTaskUnit[] = unitsRaw.map(record).flatMap((unit) => {
    const id = text(unit.id), code = text(unit.code);
    return id === null || code === null ? [] : [{ id, code }];
  });
  const projects: SystemTaskProject[] = projectsRaw.map(record).flatMap((project) => {
    const id = text(project.id), code = text(project.code);
    return id === null || code === null ? [] : [{ id, code, investor_unit_id: text(project.investor_unit_id) }];
  });

  // Which projects run a workflow, and the phases of it: a project without one answers 404. Any other failure is a failure of the read: counting the projects that answered
  // would draw a part of the tasks as the whole.
  const phases: Record<string, SystemPhase[]> = {};
  await inGroups(projects, async (project) => {
    const workflow = record(await client.read('getProjectWorkflow', { path: { project_id: project.id } }).catch((error: unknown) => {
      if (record(error).status === 404) return undefined;
      throw error;
    }));
    if (text(workflow.id) === null) return;
    phases[project.id] = list(workflow.phases).flatMap((phase) => {
      const code = text(phase.code), name = text(phase.name);
      return code === null || name === null ? [] : [{ code, name }];
    });
  });
  const running = projects.filter((project) => phases[project.id] !== undefined);
  if (running.length < TASKS_FLOOR.projectsWithTasks) throw new NotEnoughError(`${running.length} projects run a workflow (at least ${TASKS_FLOOR.projectsWithTasks} are needed)`);

  const read = await inGroups(running, async (project) =>
    (await client.readAll('listProjectTasks', { path: { project_id: project.id }, query: PAGE })).map(record).flatMap((row) => {
      const id = text(row.id), code = text(row.task_code), name = text(row.name), phase = text(row.phase_code), status = text(row.status);
      if (id === null || code === null || name === null || phase === null || status === null) return [];
      const band = record(row.band);
      const task: SystemProjectTask = {
        project_id: project.id, task_code: code, name, phase_code: phase, kind: text(row.kind) ?? 'TASK', status, excluded: flag(row.excluded), tracked: flag(row.tracked), planned_finish: text(row.planned_finish),
        late_days: band.overdue === true && typeof band.remaining_days === 'number' ? Math.max(0, -band.remaining_days) : 0, receiving_unit_id: text(row.receiving_unit_id), actual_finish: null,
      };
      return [{ id, task }];
    }),
  );
  const found = read.flat();
  if (found.length < TASKS_FLOOR.projectTasks) throw new NotEnoughError(`${found.length} project tasks are recorded (at least ${TASKS_FLOOR.projectTasks} are needed)`);

  // The list does not say when a task was finished; the task in full does. It is read for the finished tasks only, a few at a time. A read that fails fails the bundle: a
  // finished task without its day would be counted as finished on time.
  await inGroups(found.filter(({ task }) => task.status === 'DONE' && !task.excluded), async ({ id, task }) => {
    const detail = record(await client.read('getProjectTask', { path: { task_id: id } }));
    task.actual_finish = text(detail.actual_finish);
  });

  return { today, directives, meetings, tasks: found.map(({ task }) => task), projects, units, phases };
}
