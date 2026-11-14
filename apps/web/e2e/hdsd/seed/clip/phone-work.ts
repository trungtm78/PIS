import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { ensureWorkCalendar } from '../field-assurance/shared.ts';

/**
 * Group `clip-public-phone-work` and `clip-ent-phone-work`: the person who signs in on the phone (the first person of the test identity provider, the owner) has work of their own in a project workflow, so
 * that "Việc của tôi theo hạn" (MOB-80), the task (MOB-81) and the Maestro flow apps/mobile/qa/device/flows/40_project_workflow.yaml (TC-UAT-PWF-15, TC-UAT-PWF-OFF-01) have a task that is IN PROGRESS
 * to open and complete. Before this group the stack had no project workflow at all and the flow could not run (UAT 2026-11-14).
 *
 * Real commands of the product only, the way a person does it on the web: the kind of workflow the rule suggests is read for a project that has none (`suggestProjectWorkflow`), the calendars the schedule
 * needs are published, the workflow is started (`startProjectWorkflow`), the first tasks that can start are given to the person (`assignProjectTask`, RESPONSIBLE) and started by them
 * (`startProjectTask`). Idempotent: nothing is done while the person holds enough tasks in progress; the flow completes one in each run, so the group keeps two.
 */

const PERSON = 'owner';
/** The flow of the phone completes one task; a second one is left for the next run and for the screen of the list. */
const WANTED_IN_PROGRESS = 2;
/** The workflow is planned to have started two weeks ago: its first tasks are under way and one deadline is near, as on a project that is running. */
const PLANNED_START_DAYS = -14;
const ASSIGN_REASON = 'Giao việc cho người phụ trách trực tiếp theo phân công của dự án';
const TERMINAL = ['COMPLETED', 'CLOSED', 'CANCELLED', 'REJECTED', 'TERMINATED'];

interface Preview {
  missing_facts?: string[];
  findings?: Array<{ code: string; year?: number }>;
}

interface Suggestion {
  suggested_template_code: string | null;
  templates: Array<{ code: string }>;
  facts: Record<string, string>;
  preview: Preview | null;
  can_start: boolean;
}

const inProgress = async (ctx: SeedContext): Promise<number> => (await ctx.get<{ items: Obj[] }>(PERSON, '/me/project-tasks', { status: 'IN_PROGRESS', limit: 50 })).items.length;

/** The facts the branches of a template read and the project does not say yet: the group the project holds, a middle group otherwise, and the budget as the source. */
function factsFor(missing: readonly string[], project: Obj): Record<string, string> {
  const facts: Record<string, string> = {};
  if (missing.includes('project_group')) facts.project_group = typeof project.project_group === 'string' && project.project_group !== '' ? project.project_group : 'B';
  if (missing.includes('funding_source')) facts.funding_source = 'STATE_BUDGET';
  return facts;
}

/** Starts the workflow of the project with the kind the rule suggests; returns false when the tenant has nothing to start one with. */
async function startWorkflow(ctx: SeedContext, project: Obj): Promise<boolean> {
  const projectId = String(project.id);
  const plannedStart = ctx.day(PLANNED_START_DAYS);
  const read = (facts: Record<string, string>): Promise<Suggestion> => ctx.get<Suggestion>(PERSON, '/project-workflow/suggestion', { project_id: projectId, planned_start_date: plannedStart, ...facts });
  let facts: Record<string, string> = {};
  let suggestion = await read(facts);
  if (!suggestion.can_start) {
    ctx.warn(`${PERSON} may not start a workflow for the project ${String(project.code)}`);
    return false;
  }
  if (suggestion.suggested_template_code === null) {
    ctx.warn(`the rule suggests no kind of workflow for the project ${String(project.code)} (templates: ${suggestion.templates.map((one) => one.code).join(', ') || 'none'})`);
    return false;
  }
  const missing = suggestion.preview?.missing_facts ?? [];
  if (missing.length > 0) {
    facts = factsFor(missing, project);
    suggestion = await read(facts);
  }
  // The schedule runs on published calendars to its last day: each year the preview says is missing is published, and the preview is read again until it names none.
  for (let round = 0; round < 8; round += 1) {
    const years = [...new Set((suggestion.preview?.findings ?? []).filter((one) => one.code === 'CALENDAR_UNAVAILABLE' && typeof one.year === 'number').map((one) => Number(one.year)))];
    if (years.length === 0) break;
    await ensureWorkCalendar(ctx, years);
    suggestion = await read(facts);
  }
  const started = await ctx.attempt<CommandReply>(PERSON, 'POST', `/projects/${projectId}/workflow`, { planned_start_date: plannedStart, ...(Object.keys(facts).length === 0 ? {} : { facts }) });
  if (started.ok) ctx.record({ module: 'PWF', kind: 'project-workflow', id: String(started.json.resource_id), code: String(project.code), note: `kind ${suggestion.suggested_template_code}, planned start ${plannedStart}`, screen: 'PWF-03' });
  return started.ok;
}

/** Gives the person the tasks of the workflow that can start and starts them, until `wanted` are in progress; returns how many were started. */
async function startTasks(ctx: SeedContext, projectId: string, wanted: number): Promise<number> {
  const tasks = (await ctx.list<Obj>(PERSON, `/projects/${projectId}/workflow/tasks`, { status: 'NOT_STARTED', limit: 100 }))
    .filter((task) => task.kind !== 'MILESTONE' && task.excluded !== true && task.tracked !== false)
    .sort((left, right) => String(left.planned_start ?? '9999').localeCompare(String(right.planned_start ?? '9999')));
  let started = 0;
  // A task whose predecessors are not done is refused (PREDECESSORS_NOT_READY) and the next one is tried: only the first tasks of the chain can start, so a handful is enough.
  for (const task of tasks.slice(0, 8)) {
    if (started >= wanted) break;
    const taskId = String(task.id);
    // The leader in charge of the project holds every task from the start (the default of the ledger) and hands it over the day before; when that leader is this person the task is theirs already, the
    // ledger refuses a second full share, and the start below is what tells.
    await ctx.call(PERSON, 'POST', `/project-tasks/${taskId}/assignments`, { membership_id: ctx.person(PERSON).membershipId, role: 'RESPONSIBLE', valid_from: ctx.today, share_pct: 100, reason: ASSIGN_REASON });
    const now = await ctx.get<Obj>(PERSON, `/project-tasks/${taskId}`);
    const begun = await ctx.call(PERSON, 'POST', `/project-tasks/${taskId}/start`, {}, { version: Number(now.version) });
    if (!begun.ok) continue;
    started += 1;
    ctx.record({ module: 'PWF', kind: 'project-task', id: taskId, code: String(task.task_code), note: `in progress, held by ${ctx.nameOf(PERSON)}`, screen: 'MOB-80' });
  }
  return started;
}

async function workInProgress(ctx: SeedContext): Promise<void> {
  let held = await inProgress(ctx);
  if (held >= WANTED_IN_PROGRESS) return;
  const projects = (await ctx.list<Obj>(PERSON, '/resources/project')).filter((project) => !TERMINAL.includes(String(project.status)));
  // A workflow that exists first (a rerun finds the one it made); then one project that has none gets a workflow.
  const without: Obj[] = [];
  for (const project of projects.slice(0, 40)) {
    if (held >= WANTED_IN_PROGRESS) return;
    const workflow = await ctx.call(PERSON, 'GET', `/projects/${String(project.id)}/workflow`);
    if (workflow.status === 404) without.push(project);
    else if (workflow.ok) held += await startTasks(ctx, String(project.id), WANTED_IN_PROGRESS - held);
  }
  for (const project of without) {
    if (held >= WANTED_IN_PROGRESS) return;
    if (!(await startWorkflow(ctx, project))) continue;
    held += await startTasks(ctx, String(project.id), WANTED_IN_PROGRESS - held);
  }
  if (held === 0) ctx.warn(`no task of a project workflow is in progress for ${PERSON}: the phone flow 40 has nothing to open`);
}

export async function seedClipPhoneWork(ctx: SeedContext): Promise<void> {
  await ctx.step('PWF', `tasks in progress for the person of the phone (${WANTED_IN_PROGRESS}, MOB-80, MOB-81)`, () => workInProgress(ctx));
}
