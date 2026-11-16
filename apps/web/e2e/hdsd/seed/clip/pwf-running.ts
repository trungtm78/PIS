import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { ensureWorkCalendar } from '../field-assurance/shared.ts';
import { CHECKER, MAKER, OWNER, TEMPLATE_TYPE, TENANT_TEMPLATE, arr, begin, complete, detailOf, effectiveParams, play, rule, work, startDay, str, tasksOf, team } from './pwf-review.ts';
import type { ProjectSpec } from './pwf-review.ts';

/**
 * Group `clip-public-pwf-running`: the named projects of the province (the 45 of the dataset, not the eight demonstration ones of `clip-public-pwf-review`) run a "quy trình", so that the tab of the
 * project (PWF-03), the task (PWF-04), the deadline board (PWF-07), the alerts of the home and the phone (MOB-78 to MOB-80) show real work on projects a viewer knows by name.
 *
 * Real commands of the product only, the way people do it on the screens (maker is never checker):
 *   - the people who can take a task for a unit hold a role at that unit (`grantRole`, scope UNIT_ONLY): the officer of the project board and the officer of the staff at the Ban Quản lý dự án xây dựng
 *     (PWF.md 22.3; a grant over the whole tenant makes nobody a member of a unit);
 *   - ONE template of the tenant that names the unit that receives each task (`responsible_units`), the extensions each task allows (`extension`) and the overall deadline of the file
 *     (`overall_deadline_task`): drafted by the owner, approved by the leader (the built-in templates and CB_ROAD_REPAIR name no unit);
 *   - nine projects of the dataset started with a workflow (`startProjectWorkflow`) from the three built-in templates, CB_ROAD_REPAIR and the template above, on planned starts spread over the last four
 *     months, and played by the same routine as the eight demonstration projects (tasks done and approved by a second person, handed in and waiting, sent back, late and open, under way);
 *   - on the two projects of the template with units: the overall deadline at risk, an extension asked for (`proposeProjectReschedule` with `extensions[]`, left waiting), tasks nobody has taken
 *     ("Chưa có người nhận") and one task taken for the unit by the officer through "Nhận việc" (`claimProjectTask`) and started by them.
 *
 * Idempotent and add-only: a project that has a workflow is only played further when nothing was started in it; a rule, a grant, a proposal that exists is found by its code and left alone.
 */

const STAFFER = 'projectViewer';
export const UNIT_TEMPLATE = 'CB_ROAD_REPAIR_UNITS';
const OWNER_UNIT_KEY = 'CB-SKHDT-QLDA';
/** The two roles of the unit the template names: the officer of the project board (a role of the tenant) and the officer of the staff (the system role every person of the staff holds over the tenant). */
const OFFICER_ROLE = 'CAN_BO_BAN_QLDA';
const STAFF_ROLE = 'STAFF_MEMBER';
const GRANT_REASON = 'Phân công cán bộ vào đơn vị chủ đầu tư để nhận việc của quy trình dự án';

interface RunSpec extends ProjectSpec {
  /** A project of the dataset by its code (the work starts on it); a project that is not there is skipped with a warning. */
  existing: string;
}

/** The kinds of project and what became of them, spread over four months: the longer ago the workflow started, the more of it is finished. */
const PROJECTS: RunSpec[] = [
  // Investment construction: a long one, well on its way (four months), and a younger one with a step waiting for the approval of its completion.
  { existing: 'DA-MT101', code: 'DA-MT101', name: '', template: 'PUBLIC_INVESTMENT', elapsed: 84, billions: 0, facts: { project_group: 'B', funding_source: 'STATE_BUDGET' }, consulted: 'unitAdmin', workers: [MAKER, OWNER, MAKER, OWNER, MAKER], past: [0, 0, 1, 0, 'OPEN'] },
  { existing: 'DA-GD110', code: 'DA-GD110', name: '', template: 'PUBLIC_INVESTMENT', elapsed: 46, billions: 0, facts: { project_group: 'B', funding_source: 'STATE_BUDGET' }, consulted: 'treasuryMaker', workers: [OWNER, MAKER, OWNER, MAKER], past: [0, 0, 2], current: 'HANDED_IN' },
  // Procurement: one that is a quarter done with a late step sent back, one whose first step is still open and late (red).
  { existing: 'DA-TT112', code: 'DA-TT112', name: '', template: 'PUBLIC_PROCUREMENT', elapsed: 58, billions: 0, reason: 'Dự án chỉ mua sắm thiết bị, không có hạng mục xây dựng', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, consulted: 'docHead', workers: [MAKER, OWNER, OWNER, MAKER, MAKER], past: [0, 0, 0, 3, 0], current: 'SENT_BACK' },
  { existing: 'DA-ICT03', code: 'DA-ICT03', name: '', template: 'PUBLIC_PROCUREMENT', elapsed: 22, billions: 0, reason: 'Dự án chỉ mua sắm thiết bị, không có hạng mục xây dựng', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, consulted: 'unitAdmin', workers: [OWNER, MAKER, OWNER], past: [0, 'OPEN'] },
  // Repair: a long one (a quarter and more) with its latest step handed in, one that only began.
  { existing: 'DA-NN031', code: 'DA-NN031', name: '', template: 'PUBLIC_REPAIR', elapsed: 70, billions: 0, reason: 'Dự án sửa chữa, cải tạo công trình hiện có, không xây dựng mới', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, consulted: 'treasuryMaker', workers: [OWNER, MAKER, MAKER, OWNER, MAKER], past: [0, 0, 0, 2, 0], current: 'HANDED_IN' },
  { existing: 'DA-NN114', code: 'DA-NN114', name: '', template: 'PUBLIC_REPAIR', elapsed: 9, billions: 0, reason: 'Dự án sửa chữa, cải tạo công trình hiện có, không xây dựng mới', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, fresh: true, consulted: 'docHead' },
  // The template of the tenant for the roads, as the province ran it before the units were named.
  { existing: 'DA-GT107', code: 'DA-GT107', name: '', template: TENANT_TEMPLATE, elapsed: 38, billions: 0, reason: 'Sửa chữa đường giao thông địa phương theo mẫu quy trình của tỉnh', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, consulted: 'nobody', workers: [OWNER, MAKER, MAKER, OWNER], past: [0, 0, 2, 0, 'OPEN'] },
  // The template with units: the overall deadline at risk and an extension asked for on the first; tasks nobody has taken, and one taken through "Nhận việc", on the second.
  { existing: 'DA-DT205', code: 'DA-DT205', name: '', template: UNIT_TEMPLATE, elapsed: 14, billions: 0, reason: 'Sửa chữa đường giao thông địa phương theo mẫu có đơn vị nhận việc của tỉnh', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, consulted: 'unitAdmin', workers: [MAKER, OWNER, MAKER], past: [0, 0, 0] },
  { existing: 'DA-GT105', code: 'DA-GT105', name: '', template: UNIT_TEMPLATE, elapsed: 3, billions: 0, reason: 'Sửa chữa đường giao thông địa phương theo mẫu có đơn vị nhận việc của tỉnh', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, fresh: true, consulted: 'unitAdmin' },
];

const UNITS_PROJECTS = { overallAtRisk: 'DA-DT205', claim: 'DA-GT105' } as const;

// ---- who is of the unit ---------------------------------------------------------------------------------------------------------------

/** The roles of the unit that receives the tasks, held at that unit by the two people who take them (UNIT_ONLY: the grant that makes a person of the unit and gives them the role there). */
async function unitGrants(ctx: SeedContext): Promise<void> {
  const unitId = ctx.unitId(OWNER_UNIT_KEY);
  const roles = await ctx.list<Obj>(OWNER, '/resources/role_definition');
  const roleId = (code: string): string | undefined => roles.find((row) => row.code === code && row.status === 'Active')?.id as string | undefined;
  const grants = await ctx.list<Obj>(OWNER, '/resources/role_grant');
  for (const [person, code] of [[MAKER, OFFICER_ROLE], [MAKER, STAFF_ROLE], [STAFFER, STAFF_ROLE]] as const) {
    const id = roleId(code);
    if (id === undefined) {
      ctx.warn(`the role ${code} is not in the tenant: ${person} is not made a member of the unit with it`);
      continue;
    }
    const membership = ctx.person(person).membershipId;
    const held = grants.some((one) => one.membership_id === membership && one.role_code === code && one.status === 'Active' && one.scope_kind === 'UNIT_ONLY' && arr<string>(one.scope_ref_ids).includes(unitId));
    if (held) continue;
    const made = await ctx.attempt<CommandReply>(OWNER, 'POST', '/role-grants', { membership_id: membership, role_id: id, scope_kind: 'UNIT_ONLY', scope_ref_ids: [unitId], reason: GRANT_REASON });
    if (made.ok) ctx.record({ module: 'ADM', kind: 'role-grant', id: made.json.resource_id, code: `${person}/${code}`, note: `held at the unit ${OWNER_UNIT_KEY} (UNIT_ONLY)`, screen: 'ADM-03' });
  }
}

// ---- the template with units ----------------------------------------------------------------------------------------------------------

/** The template of the tenant for the roads, with the unit that receives each task, the extensions allowed and the overall deadline of the file. */
function templateWithUnits(base: Obj): Obj {
  let turn = 0;
  const tasks = arr(base.tasks).map((task) => {
    if (task.kind === 'MILESTONE') return task;
    const role = turn % 2 === 0 ? OFFICER_ROLE : STAFF_ROLE;
    turn += 1;
    const days = Number(task.duration_working_days ?? 0);
    return {
      ...task,
      responsible_role: role,
      responsible_units: [{ unit_ref: 'PROJECT_OWNER', role, part: 'LEAD' }],
      // A task may be extended twice, by at most the half of its duration (at least two days): the ceiling a reschedule with `extensions[]` is checked against.
      extension: { allowed: true, max_times: 2, max_value: Math.max(2, Math.ceil(days / 2)), unit: 'WORKING_DAY' },
    };
  });
  return { ...base, name: 'Sửa chữa, bảo trì đường giao thông địa phương (có đơn vị nhận việc)', tasks, overall_deadline_task: 'RR_DECISION' };
}

async function unitTemplate(ctx: SeedContext): Promise<boolean> {
  const base = await effectiveParams(ctx, TEMPLATE_TYPE, TENANT_TEMPLATE);
  const params = templateWithUnits(base);
  const checked = await ctx.attempt<{ findings?: Array<{ code: string; path: string; severity: string }> }>(OWNER, 'POST', '/project-workflow/templates/validate', params);
  const errors = (checked.json.findings ?? []).filter((one) => one.severity === 'ERROR');
  if (errors.length > 0) {
    ctx.warn(`the template ${UNIT_TEMPLATE} has findings: ${errors.map((one) => `${one.code} ${one.path}`).join('; ')}`);
    return false;
  }
  await rule(ctx, { type: TEMPLATE_TYPE, code: UNIT_TEMPLATE, params, reason: 'Ban hành mẫu quy trình sửa chữa đường giao thông có nêu đơn vị nhận việc của từng việc, thời hạn gia hạn tối đa và hạn chung của hồ sơ', upTo: 'APPROVED', maker: OWNER, checker: CHECKER });
  return true;
}

/** The leader who answers for a project (PRJ-17: LEADER_IN_CHARGE, with the officer of the board as focal officer) by the decision of the board; without one the alert of the overall deadline has nobody to go to and the tasks are not given to the leader. */
async function leaderInCharge(ctx: SeedContext, spec: RunSpec): Promise<void> {
  const project = await ctx.find(OWNER, '/resources/project', (row) => row.code === spec.existing);
  if (project === undefined) return;
  const projectId = str(project.id);
  if ((await ctx.list<Obj>(OWNER, '/resources/project_accountability', { project_id: projectId })).length > 0) return;
  const decision = await ctx.letter({ symbol: `PWF-PC-${spec.existing.replace(/D/gu, '')}/QD-BQLDA`, title: `Quyết định phân công lãnh đạo phụ trách dự án ${spec.existing}`, issuedOn: ctx.day(-90), sender: 'Ban Quản lý dự án xây dựng tỉnh Cà Mau', person: 'owner' });
  const made = await ctx.attempt<CommandReply>(OWNER, 'POST', `/projects/${projectId}/accountability-assignments`, { leader_membership_id: ctx.person(CHECKER).membershipId, accountability_role: 'LEADER_IN_CHARGE', valid_from: ctx.day(-90), assignment_document_id: decision.documentId });
  if (!made.ok) return;
  await ctx.attempt(OWNER, 'POST', `/projects/${projectId}/accountability-assignments`, { leader_membership_id: ctx.person(MAKER).membershipId, accountability_role: 'FOCAL_OFFICER', valid_from: ctx.day(-90) });
  ctx.record({ module: 'PRJ', kind: 'accountability', id: str(made.json.resource_id), code: spec.existing, note: `leader in charge: ${ctx.nameOf(CHECKER)}`, screen: 'PRJ-17' });
}

// ---- the workflows --------------------------------------------------------------------------------------------------------------------

interface Suggestion {
  can_start: boolean;
  preview: { findings?: Array<{ code: string; year?: number }>; missing_facts?: string[] } | null;
}

/** Starts the workflow of a project of the dataset that has none; returns the project id when it has one afterwards. */
async function ensureWorkflow(ctx: SeedContext, spec: RunSpec): Promise<{ id: string; started: boolean } | undefined> {
  const project = await ctx.find(OWNER, '/resources/project', (row) => row.code === spec.existing);
  if (project === undefined) {
    ctx.warn(`the project ${spec.existing} is not in the register: no workflow is started on it`);
    return undefined;
  }
  const projectId = str(project.id);
  const there = await ctx.call(OWNER, 'GET', `/projects/${projectId}/workflow`);
  if (there.ok) return { id: projectId, started: false };
  if (there.status !== 404) {
    ctx.expectOk(there);
    return undefined;
  }
  const plannedStart = startDay(ctx.today, spec.elapsed);
  const read = (): Promise<Suggestion> => ctx.get<Suggestion>(OWNER, '/project-workflow/suggestion', { project_id: projectId, template_code: spec.template, planned_start_date: plannedStart, ...spec.facts });
  let suggestion = await read();
  // The schedule runs on published calendars to its last day: every year the preview says is missing is published, and the preview is read again until it names none.
  for (let round = 0; round < 8; round += 1) {
    const years = [...new Set((suggestion.preview?.findings ?? []).filter((one) => one.code === 'CALENDAR_UNAVAILABLE' && typeof one.year === 'number').map((one) => Number(one.year)))];
    if (years.length === 0) break;
    await ensureWorkCalendar(ctx, years);
    suggestion = await read();
  }
  const started = await ctx.attempt<CommandReply>(OWNER, 'POST', `/projects/${projectId}/workflow`, {
    template_code: spec.template,
    planned_start_date: plannedStart,
    facts: spec.facts,
    ...(spec.reason === undefined ? {} : { selection_reason: spec.reason }),
  });
  if (!started.ok) return undefined;
  ctx.record({ module: 'PWF', kind: 'project-workflow', id: str(started.json.resource_id), code: spec.existing, note: `started from ${spec.template}, planned start ${plannedStart}`, screen: 'PWF-03' });
  return { id: projectId, started: true };
}

/**
 * The work of a workflow whose tasks name a unit, as far as it stands today: every task whose planned finish is past is begun on its planned day, finished on its planned finish and approved by the leader where
 * it asks; the task that is under way today is begun and a part of its work is in. Unlike `play` it reads the state of each task, so a run that stopped half way is taken up where it stopped.
 * The officer of the staff (STAFF_MEMBER) holds no right to the tasks of a project: the people who do the work here are the owner and the officer of the project board.
 */
async function resume(ctx: SeedContext, spec: RunSpec, projectId: string): Promise<void> {
  const tasks = (await tasksOf(ctx, projectId)).filter((task) => task.planned_finish !== null);
  let turn = 0;
  const next = (index: number): string => spec.workers?.[index] ?? [MAKER, OWNER][(turn += 1) % 2] as string;
  for (const [index, task] of tasks.entries()) {
    const past = str(task.planned_finish) < ctx.today;
    const under = str(task.planned_start) <= ctx.today && !past;
    if ((!past && !under) || task.status === 'DONE') continue;
    const who = next(index);
    if (!(await begin(ctx, task, who, str(task.planned_start), spec.consulted))) continue;
    if (under) {
      await work(ctx, task.id, who, 'PART');
      continue;
    }
    if (task.status === 'AWAITING_APPROVAL') continue;
    if (!(await complete(ctx, task.id, who, str(task.planned_finish)))) continue;
    const now = await detailOf(ctx, CHECKER, task.id);
    if (now.status === 'AWAITING_APPROVAL') await ctx.attempt(CHECKER, 'POST', `/project-tasks/${task.id}/approve-completion`, { decision: 'APPROVE', note: 'Hồ sơ đủ, đồng ý hoàn thành' }, { version: Number(now.version) });
  }
}

// ---- the extension and the claim ------------------------------------------------------------------------------------------------------

/** An extension asked for by the officer on the first project with units: the step now under way gets two more working days, and the proposal waits for the decision (PWF-06). */
async function extensionAsked(ctx: SeedContext, projectId: string): Promise<void> {
  const workflow = await ctx.get<Obj>(OWNER, `/projects/${projectId}/workflow`);
  if (workflow.pending_reschedule !== null && workflow.pending_reschedule !== undefined) return;
  const current = (await tasksOf(ctx, projectId)).find((task) => ['IN_PROGRESS', 'NOT_STARTED'].includes(task.status) && task.task_code === 'RR_DECISION');
  if (current === undefined) return;
  const asked = await ctx.attempt<Obj>(MAKER, 'POST', `/projects/${projectId}/workflow/reschedules`, {
    reason: 'Đề nghị gia hạn thêm hai ngày làm việc cho việc quyết định phê duyệt: chờ ý kiến bằng văn bản của Sở Tài chính về nguồn vốn',
    extensions: [{ task_code: 'RR_DECISION', add_value: 2 }],
  }, { version: Number(workflow.version) });
  if (asked.ok) ctx.record({ module: 'PWF', kind: 'reschedule', id: str(asked.json.proposal_id), code: UNITS_PROJECTS.overallAtRisk, note: 'an extension of RR_DECISION asked for, waiting for the decision', screen: 'PWF-06' });
}

/** The officer takes the first task of the second project for the unit ("Nhận việc") and starts it; the other tasks stay "Chưa có người nhận" for the next person. */
async function claimOne(ctx: SeedContext, projectId: string): Promise<void> {
  const tasks = await tasksOf(ctx, projectId);
  if (tasks.some((task) => task.status !== 'NOT_STARTED')) return;
  const first = tasks.find((task) => task.task_code === 'RR_SURVEY');
  if (first === undefined) return;
  const claimed = await ctx.attempt<CommandReply>(MAKER, 'POST', `/project-tasks/${first.id}/claim`, {});
  if (!claimed.ok) return;
  ctx.record({ module: 'PWF', kind: 'project-task', id: first.id, code: `${UNITS_PROJECTS.claim}/RR_SURVEY`, note: `taken for the unit by ${ctx.nameOf(MAKER)} ("Nhận việc")`, screen: 'PWF-04' });
  const now = await detailOf(ctx, MAKER, first.id);
  await ctx.attempt(MAKER, 'POST', `/project-tasks/${first.id}/start`, {}, { version: Number(now.version) });
}

// ---- the group ------------------------------------------------------------------------------------------------------------------------

export async function seedClipPwfRunning(ctx: SeedContext): Promise<void> {
  await ctx.step('ADM', 'the officer of the project board and the officer of the staff are of the unit that receives the tasks (grants UNIT_ONLY)', () => unitGrants(ctx));
  const ready = { units: false };
  await ctx.step('PWF', `the template ${UNIT_TEMPLATE}: the unit that receives each task, the extensions allowed, the overall deadline (drafted by the owner, approved by the leader)`, async () => {
    ready.units = await unitTemplate(ctx);
  });
  await ctx.step('PRJ', 'the leader in charge of each of the nine projects (PRJ-17): the alert of the overall deadline goes to them', async () => {
    for (const spec of PROJECTS) await leaderInCharge(ctx, spec);
  });
  const ids: Record<string, string> = {};
  for (const [turn, spec] of PROJECTS.entries()) {
    if (spec.template === UNIT_TEMPLATE && !ready.units) continue;
    await ctx.step('PWF', `a workflow started on ${spec.existing} from ${spec.template}, planned ${spec.elapsed} working days ago`, async () => {
      const made = await ensureWorkflow(ctx, spec);
      if (made === undefined) return;
      ids[spec.existing] = made.id;
      // A workflow that did not begin here (an earlier run, or somebody's) is not played over.
      if (made.started && spec.template !== UNIT_TEMPLATE) await play(ctx, spec, made.id, turn);
    });
  }
  await ctx.step('PWF', `${UNITS_PROJECTS.overallAtRisk}: the steps done, the overall deadline near, an extension asked for (PWF-03, PWF-06)`, async () => {
    const id = ids[UNITS_PROJECTS.overallAtRisk];
    if (id === undefined) return;
    const spec = PROJECTS.find((one) => one.existing === UNITS_PROJECTS.overallAtRisk) as RunSpec;
    await resume(ctx, spec, id);
    for (const task of await tasksOf(ctx, id)) if (['IN_PROGRESS', 'AWAITING_APPROVAL'].includes(task.status)) await team(ctx, task.id, spec.consulted);
    await extensionAsked(ctx, id);
  });
  await ctx.step('PWF', `${UNITS_PROJECTS.claim}: tasks nobody has taken, one taken for the unit by the officer ("Nhận việc")`, async () => {
    const id = ids[UNITS_PROJECTS.claim];
    if (id !== undefined) await claimOne(ctx, id);
  });
}
