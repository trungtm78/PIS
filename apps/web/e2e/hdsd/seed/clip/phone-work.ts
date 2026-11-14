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
 *
 * The papers a task of the person still asks for are handed in as well (`attachProjectTaskEvidence`: its legal documents, its forms, the evidence of a checklist item), the way the person does at the
 * desk, and the checklist itself is left alone: on the phone the person ticks the mandatory items that are open and then completes the task, which is what the flow does. Before this a task could be
 * first in the list of the phone with a legal document missing, and the flow had no way on (lane fix9, 2026-11-14).
 *
 * The person also gets reminder levels of their own (`putMyDeadlinePreference`, earlier than the official 5/2/0), so that the list of the phone is coloured by a personal setting and each row says
 * "Theo cài đặt của bạn" (MOB-80, the field "Màu cá nhân kèm nhãn"), which the flow reads. Without them the API answers `personal_band: null` and the rows say they follow the official level: that is
 * what the enterprise dataset had (only the public one ran the group `clip-public-pwf-review`, which sets the same levels), and the flow could not read a personal colour there (UAT 2026-11-15 run 3).
 *
 * The person has a score as well (MOB-81, PWF-11): where no scoring period holds a line of theirs (the enterprise dataset; the public one has the period of `clip-public-pwf-review`), one of their
 * tasks is finished the way the phone does it (the mandatory items ticked, the task completed, its completion approved by a second person where the task asks for it), the leader and the officer of
 * the project are named in the working group of the tasks (ACCOUNTABLE, CONSULTED: both carry a part of the score), the tasks in progress are topped up again, and the period of the quarter is
 * computed and locked for the top unit. Before this the screen of the score was empty on the enterprise stack and the flow 40 stopped at it (lane shots2, 2026-11-15).
 */

const PERSON = 'owner';
/** The flow of the phone completes one task; a second one is left for the next run and for the screen of the list. */
const WANTED_IN_PROGRESS = 2;
/** The workflow is planned to have started two weeks ago: its first tasks are under way and one deadline is near, as on a project that is running. */
const PLANNED_START_DAYS = -14;
const ASSIGN_REASON = 'Giao việc cho người phụ trách trực tiếp theo phân công của dự án';
const TERMINAL = ['COMPLETED', 'CLOSED', 'CANCELLED', 'REJECTED', 'TERMINATED'];
/** The people named around the tasks of the person and asked to approve a completion: the leader first, the officer of the project board second. */
const LEADER = 'capApprover';
const OFFICER = 'projectManager';

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

interface TaskNeeds {
  task_code: string;
  legal_doc_types: Array<{ code: string; name?: string; satisfied: boolean }>;
  form_templates: Array<{ code: string; current_title?: string | null; satisfied: boolean }>;
  checklist: Array<{ item_code: string; name?: string; done: boolean; evidence_kinds: string[] }>;
  evidence: Array<{ item_code: string | null; evidence_kind: string }>;
  completion: { blockers: Array<{ code: string; subject: string }> };
}

/** Hands in what the task still asks for besides the ticks of its checklist; what it already has is not given twice (the blockers of the task say what is missing). */
async function handInPapers(ctx: SeedContext, taskId: string): Promise<void> {
  const task = await ctx.get<TaskNeeds>(PERSON, `/project-tasks/${taskId}`);
  const give = (body: Obj): Promise<unknown> => ctx.attempt(PERSON, 'POST', `/project-tasks/${taskId}/evidence`, body);
  for (const blocker of task.completion.blockers) {
    if (blocker.code === 'LEGAL_DOC_MISSING') await give({ evidence_kind: 'DECISION_DOCUMENT', legal_doc_type: blocker.subject, external_ref: `Văn bản "${wordsOf(task.legal_doc_types.find((one) => one.code === blocker.subject)?.name, blocker.subject)}", bản gốc lưu tại văn thư`, note: 'Văn bản đã ký' });
    else if (blocker.code === 'FORM_MISSING') await give({ evidence_kind: 'DOCUMENT', form_template_code: blocker.subject, external_ref: `Văn bản lập theo biểu mẫu "${wordsOf(task.form_templates.find((one) => one.code === blocker.subject)?.current_title, blocker.subject)}"`, note: 'Lập từ biểu mẫu của kho văn bản' });
  }
  // An open item that asks for evidence of a kind cannot be ticked without it (the server answers PWF_TASK_COMPLETION_BLOCKED, EVIDENCE_MISSING, to the tick): its paper is handed in here, the tick stays for the phone.
  for (const item of task.checklist) {
    const kind = item.evidence_kinds[0];
    if (item.done || kind === undefined) continue;
    if (task.evidence.some((one) => one.item_code === item.item_code && item.evidence_kinds.includes(one.evidence_kind))) continue;
    await give({ evidence_kind: kind, item_code: item.item_code, external_ref: `Hồ sơ kèm mục "${wordsOf(item.name, item.item_code)}", lưu tại Ban quản lý dự án` });
  }
}

/** The words a paper is named with on the screens: the name the product gives, the code only when there is none. */
const wordsOf = (name: string | null | undefined, code: string): string => (typeof name === 'string' && name.trim() !== '' ? name.trim() : code);

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

/** Every task the person has in progress, whichever run started it, has its papers in. */
async function papersOfMyTasks(ctx: SeedContext): Promise<void> {
  const mine = (await ctx.get<{ items: Array<{ task_id: string }> }>(PERSON, '/me/project-tasks', { status: 'IN_PROGRESS', limit: 50 })).items;
  for (const task of mine) await handInPapers(ctx, task.task_id);
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

/** The reminder levels of the person of the phone, the same as the group `clip-public-pwf-review` gives them: set once, never over a level the person chose. */
async function ownReminderLevels(ctx: SeedContext): Promise<void> {
  const now = await ctx.get<Obj>(PERSON, '/me/deadline-preference');
  if (now.green_days !== null && now.green_days !== undefined) return;
  await ctx.attempt(PERSON, 'PUT', '/me/deadline-preference', { green_days: 8, yellow_days: 4, red_days: 1, reminder_days: [5, 3, 1, 0] }, { version: Number(now.version ?? 0) });
}

// ---- the score of the person ---------------------------------------------------------------------------------------------------------------

interface OpenTask extends TaskNeeds {
  id: string;
  status: string;
  version: number;
  checklist: Array<{ item_code: string; name?: string; required: boolean; done: boolean; evidence_kinds: string[] }>;
}

const myTasks = async (ctx: SeedContext, status: string): Promise<string[]> => (await ctx.get<{ items: Array<{ task_id: string }> }>(PERSON, '/me/project-tasks', { status, limit: 50 })).items.map((one) => one.task_id);

/** The leader answers for the task and the officer is asked: named once, from the day the person holds it (the ledger takes no line for a task that is closed, so this comes before the completion). */
async function workingGroup(ctx: SeedContext, taskId: string): Promise<void> {
  const held = await ctx.list<Obj>(PERSON, `/project-tasks/${taskId}/assignments`);
  const from = String(held.find((line) => line.role === 'RESPONSIBLE')?.valid_from ?? ctx.today);
  for (const [person, role, reason] of [
    [LEADER, 'ACCOUNTABLE', 'Lãnh đạo phụ trách chịu trách nhiệm về kết quả của việc theo phân công của dự án'],
    [OFFICER, 'CONSULTED', 'Tham gia ý kiến chuyên môn theo quyết định thành lập tổ công tác của dự án'],
  ] as const) {
    if (held.some((line) => line.role === role)) continue;
    await ctx.attempt(PERSON, 'POST', `/project-tasks/${taskId}/assignments`, { membership_id: ctx.person(person).membershipId, role, valid_from: from, share_pct: 100, reason });
  }
}

/** Finishes one task of the person the way the phone does: every mandatory item that is open is ticked (its paper is in already), the task is completed and, where it then waits, approved by a second person. */
async function finishOne(ctx: SeedContext, taskId: string): Promise<boolean> {
  await handInPapers(ctx, taskId);
  let task = await ctx.get<OpenTask>(PERSON, `/project-tasks/${taskId}`);
  for (const item of task.checklist.filter((one) => one.required && !one.done)) {
    const proof = task.evidence.find((one) => one.item_code === item.item_code) as Obj | undefined;
    const ticked = await ctx.attempt(PERSON, 'POST', `/project-tasks/${taskId}/checklist/${item.item_code}/complete`, { note: 'Đã kiểm tra, đủ theo yêu cầu', ...(typeof proof?.id === 'string' ? { evidence_id: proof.id } : {}) }, { version: Number(task.version) });
    if (!ticked.ok) return false;
    task = await ctx.get<OpenTask>(PERSON, `/project-tasks/${taskId}`);
  }
  const done = await ctx.attempt(PERSON, 'POST', `/project-tasks/${taskId}/complete`, { note: 'Đã hoàn thành theo yêu cầu của bước' }, { version: Number(task.version) });
  if (!done.ok) return false;
  for (const approver of [LEADER, OFFICER]) {
    const now = await ctx.get<OpenTask>(PERSON, `/project-tasks/${taskId}`);
    if (now.status !== 'AWAITING_APPROVAL') break;
    await ctx.call(approver, 'POST', `/project-tasks/${taskId}/approve-completion`, { decision: 'APPROVE', note: 'Hồ sơ đủ, đồng ý hoàn thành' }, { version: Number(now.version) });
  }
  ctx.record({ module: 'PWF', kind: 'project-task', id: taskId, code: task.task_code, note: `finished by ${ctx.nameOf(PERSON)}`, screen: 'MOB-81' });
  return true;
}

/** The quarter today falls in, as the scoring policy counts its periods. */
function quarterOf(today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const first = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
  const last = first + 2;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return { from: `${year}-${pad(first)}-01`, to: `${year}-${pad(last)}-${pad(new Date(Date.UTC(year, last, 0)).getUTCDate())}` };
}

async function scoreOfThePerson(ctx: SeedContext): Promise<void> {
  const mine = await ctx.get<{ items: Obj[] }>(PERSON, '/me/staff-scores', { limit: 5 });
  if (mine.items.length > 0) return;
  const window = quarterOf(ctx.today);
  // A period of the quarter an earlier run left as a draft is locked below; only a stack without one gets the work that gives the score something to say (one task finished: the list of
  // the person's tasks names the open ones only, so the period itself is what tells that this was done before).
  const units = await ctx.list<Obj>(PERSON, '/resources/organization_unit');
  const top = units.find((unit) => unit.parent_id === null || unit.parent_id === undefined) ?? units[0];
  if (top === undefined) {
    ctx.warn('the tenant has no unit to compute a scoring period for');
    return;
  }
  let period = (await ctx.list<Obj>(PERSON, '/staff-score-periods', { scope_unit_id: String(top.id) })).find((one) => one.period_from === window.from);
  if (period === undefined) {
    const open = await myTasks(ctx, 'IN_PROGRESS');
    for (const taskId of open) await workingGroup(ctx, taskId);
    // One task is finished and the others stay for the phone; the list is then topped up to what the flow needs.
    if (open[0] !== undefined) await finishOne(ctx, open[0]);
    await workInProgress(ctx);
    for (const taskId of await myTasks(ctx, 'IN_PROGRESS')) await workingGroup(ctx, taskId);
    await papersOfMyTasks(ctx);
    const computed = await ctx.attempt<{ period: Obj }>(PERSON, 'POST', '/staff-score-periods', { scope_unit_id: String(top.id), period_from: window.from, period_to: window.to, policy_code: 'DEFAULT' });
    if (!computed.ok) return;
    period = computed.json.period;
    ctx.record({ module: 'PWF', kind: 'score-period', id: String(period.id), code: `${window.from}..${window.to}`, note: 'computed', screen: 'PWF-14' });
  }
  if (period.status === 'DRAFT') await ctx.attempt<CommandReply>(PERSON, 'POST', `/staff-score-periods/${String(period.id)}/lock`, {}, { version: Number(period.version) });
  if ((await ctx.get<{ items: Obj[] }>(PERSON, '/me/staff-scores', { limit: 5 })).items.length === 0) ctx.warn(`no scoring period holds a line of ${PERSON}: the screen of the score of the phone stays empty`);
}

export async function seedClipPhoneWork(ctx: SeedContext): Promise<void> {
  await ctx.step('PWF', 'reminder levels of their own for the person of the phone (MOB-80, MOB-82)', () => ownReminderLevels(ctx));
  await ctx.step('PWF', `tasks in progress for the person of the phone (${WANTED_IN_PROGRESS}, MOB-80, MOB-81)`, () => workInProgress(ctx));
  await ctx.step('PWF', 'the papers the tasks of the person still ask for are handed in (the checklist is left for the phone)', () => papersOfMyTasks(ctx));
  await ctx.step('PWF', 'a scoring period that holds a score of the person of the phone (MOB-81, PWF-11)', () => scoreOfThePerson(ctx));
}
