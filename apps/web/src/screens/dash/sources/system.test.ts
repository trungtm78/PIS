import type { ApiClient } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { readDashboard } from '../hooks';
import { E } from '../template/engine.js';
import { referenceProblems } from './assemble';
import { readCapitalInput } from './system';
import { readSubmissionsInput } from './system-submissions';
import { readTasksInput } from './system-tasks';

const BN = 1_000_000_000;
const dong = (billions: number): string => String(Math.round(billions * BN));
const TODAY = '2026-11-17';
const SNAPSHOT = 's-1';
const ROOT = { id: 'u-root', code: 'CM-UBND', name: 'Ủy ban nhân dân tỉnh Cà Mau', unit_type: 'OTHER', parent_id: null };

interface World {
  units: number;
  perUnit: number;
  baselines: boolean;
  /** Five projects run a workflow; the first has two overdue tasks. */
  workflows?: boolean;
  /** Operations that fail. */
  broken?: readonly string[];
  /** What the province holds of tasks: directives over three meetings, and `perWorkflow` tasks (the first `done` of them finished) in each of the first `workflows` projects. The deadline board names the first `onBoard` projects (the ones that run a workflow when absent). None when absent. */
  tasks?: { directives: number; workflows: number; perWorkflow: number; done: number; onBoard?: number };
  /** What waits on the desk of the leader: `explanations` requests owed since 10 November (beside one due later and one answered) and `papers` tasks that wait for a decision. None when absent. */
  submissions?: { explanations: number; papers: number };
}

const NO_TASKS = 'tasks: 0 directives are recorded (at least 20 are needed)';
const NO_SUBMISSIONS = 'submissions: 0 papers wait for a decision and 0 explanations are owed (at least 3 in all and 1 of each are needed)';

const PHASES = [['PREPARATION', 'Chuẩn bị đầu tư: chủ trương'], ['FEASIBILITY', 'Chuẩn bị đầu tư: nghiên cứu khả thi và thẩm định'], ['APPROVAL', 'Quyết định đầu tư và kế hoạch vốn'], ['IMPLEMENTATION', 'Thực hiện đầu tư'], ['ACCEPTANCE', 'Nghiệm thu và bàn giao'], ['SETTLEMENT', 'Quyết toán và đánh giá']] as const;
const OPEN_STATUSES = ['IN_PROGRESS', 'NOT_STARTED', 'AWAITING_APPROVAL', 'ON_HOLD', 'CANCELLED'] as const;

/** A stand-in for the API of a province: `units` investor units of the demo tenant, `perUnit` planned projects each. The codes are the ones the template uses, so its other bundles stand beside the system's. */
function clientOf(world: World): { client: ApiClient; calls: string[] } {
  const calls: string[] = [];
  const unitCodes = ['CM-BQLDAGT', 'CM-BQLDAXD', 'CM-BQLDANN', 'CM-STC', 'CM-SXD', 'CM-SYT', 'CM-SGDDT'].slice(0, world.units);
  const units = [ROOT, ...unitCodes.map((code, i) => ({ id: `u-${i}`, code, name: `Đơn vị ${code}`, unit_type: i < 3 ? 'PROJECT_MANAGEMENT_BOARD' : 'DEPARTMENT', parent_id: 'u-root' }))];
  const projectCodes = ['DA-DT205', 'DA-TH012', 'DA-YT007', 'DA-NN031', 'DA-MT019', 'DA-CN026', 'DA-VH044', 'DA-GT118', 'DA-GD022', 'DA-ICT03', 'DA-TL001', 'DA-DC071', 'DA-TT015', 'DA-MT101', 'DA-MT102', 'DA-NN103', 'DA-NN104', 'DA-GT105', 'DA-GT106', 'DA-GT107', 'DA-CN108'];
  const projects = Array.from({ length: world.units * world.perUnit }, (_, i) => ({ id: `p-${i}`, code: projectCodes[i] ?? `DA-X${i}`, name: `Dự án ${i}`, status: 'IMPLEMENTATION', project_group: 'B', total_investment_vnd: dong(300), investor_unit_id: `u-${i % world.units}`, status_changed_at: '2026-05-01T00:00:00Z', area: { label: 'Xã Tân Tiến' }, sector: { label: 'Giao thông' } }));
  const held = world.tasks ?? { directives: 0, workflows: 0, perWorkflow: 0, done: 0 };
  // The directives as the list of the system gives them: every second one closed two days after its deadline, the others overdue.
  const directives = Array.from({ length: held.directives }, (_, i) => ({
    id: `d-${i}`, code: `CD-${i}`, meeting: { id: `m-${i % 3}`, code: `GB-${i % 3}`, meeting_date: '2026-09-15', title: 'Giao ban' }, project: i % 4 === 0 ? { id: 'p-0', code: projectCodes[0], name: 'Dự án 0' } : null,
    assignee_unit: { id: `u-${i % world.units}`, code: unitCodes[i % world.units], name: 'Đơn vị' }, text: `Chỉ đạo số ${i}`, due_on: '2026-10-20', status: i % 2 === 0 ? 'DONE' : 'OVERDUE', stored_status: i % 2 === 0 ? 'DONE' : 'OPEN',
    overdue_days: i % 2 === 0 ? 0 : 19, closed_at: i % 2 === 0 ? '2026-10-22T08:30:00Z' : null,
  }));
  // The tasks of a workflow as the list gives them (no completion day): the unit that receives every second one is not in the register.
  const tasksOf = (projectId: string) => Array.from({ length: held.perWorkflow }, (_, k) => ({
    id: `${projectId}-t${k}`, task_code: `T${k}`, name: `Công việc ${k}`, phase_code: PHASES[k % PHASES.length]?.[0], kind: k % 7 === 6 ? 'MILESTONE' : 'TASK', status: k < held.done ? 'DONE' : OPEN_STATUSES[k % OPEN_STATUSES.length],
    excluded: false, tracked: true, planned_finish: '2026-10-30', band: k < held.done ? { overdue: false, remaining_days: null } : { overdue: true, remaining_days: -12 }, receiving_unit_id: k % 2 === 0 ? 'u-1' : 'u-unknown',
  }));
  // The requests as the list of the system gives them: about a project (no unit: the investor of the project owes the answer) or about a unit, overdue or still asked.
  const request = (i: number, over: Record<string, unknown> = {}) => ({
    id: `e-${i}`, subject_kind: i % 2 === 0 ? 'PROJECT' : 'UNIT', project: i % 2 === 0 ? { id: 'p-1', code: projectCodes[1], name: 'Dự án 1' } : null, unit: i % 2 === 0 ? null : { id: 'u-2', name: 'Đơn vị CM-BQLDANN' },
    trigger_code: 'MANUAL', question: 'Giải trình tiến độ giải ngân thấp', requested_from_membership_id: 'm-1', due_at: '2026-11-10T10:00:00.000Z', original_due_at: '2026-11-10T10:00:00.000Z', response_text: null, responded_at: null,
    is_late: false, status: i % 3 === 0 ? 'OVERDUE' : 'REQUESTED', created_at: '2026-11-03T02:00:00.000Z', ...over,
  });
  const requests = world.submissions === undefined ? [] : [...Array.from({ length: world.submissions.explanations }, (_, i) => request(i)), request(90, { status: 'REQUESTED', due_at: '2026-11-21T10:00:00.000Z' }), request(91, { status: 'RESPONDED', response_text: 'Đã giải trình' })];
  // The tasks that wait, as the monitor of the workflows gives them: no summary of the record, the unit of the workflow, the moment the step says the decision is due.
  const papers = Array.from({ length: world.submissions?.papers ?? 0 }, (_, i) => ({
    id: `a-${i}`, workflow_instance_id: `w-${i}`, step_name: 'Lãnh đạo duyệt', assignee: { id: 'm-9', name: 'Lãnh đạo' }, due_at: '2026-11-19T10:00:00.000Z', status: 'Pending', business_type: i % 2 === 0 ? 'plan.publish' : 'report.accept',
    resource: i % 2 === 0 ? { type: 'capital_plan', id: `cp-${i}` } : { type: 'project', id: 'p-2' }, created_at: '2026-11-12T02:00:00.000Z', submitted_at: '2026-11-11T18:30:00.000Z', instance: { id: `w-${i}`, unit_id: `u-${i % world.units}` }, overdue: false,
  }));
  const answer = (operation: string, input: { path?: { id?: string; project_id?: string; task_id?: string }; query?: Record<string, string> } = {}): unknown => {
    calls.push(operation);
    if (world.broken?.includes(operation)) throw new Error(`${operation} failed`);
    const id = input.path?.id ?? input.path?.project_id ?? input.path?.task_id ?? input.query?.project_id ?? '';
    switch (operation) {
      case 'getCommandCenter': return { snapshot_id: SNAPSHOT, as_of_date: '2026-11-13', treasury_cutoff_date: '2026-11-12' };
      case 'getCommitteeWorkspace': return { policy: { curve: [4, 8, 15, 25, 35, 50, 60, 70, 80, 90, 95, 100].map((cumulative_pct, i) => ({ month: i + 1, cumulative_pct })) }, units: [{ unit_id: 'u-1', not_reporting: true }] };
      case 'get_resources_organization_unit': return units;
      case 'get_resources_project': return projects.map(({ id: projectId, code, name, investor_unit_id }) => ({ id: projectId, code, name, investor_unit_id }));
      case 'get_resources_project_id': return projects.find((project) => project.id === id);
      case 'listPeriodSnapshotLines': return projects.flatMap((project) => [{ project_id: project.id, fund_source_version_id: 'fs-tw', budget_level: 'CENTRAL', plan_total_vnd: dong(60) }, { project_id: project.id, fund_source_version_id: null, budget_level: 'LOCAL', plan_total_vnd: dong(40) }, { project_id: project.id, fund_source_version_id: 'fs-oda', budget_level: 'CENTRAL', plan_total_vnd: dong(20) }]);
      case 'listAppropriations': return [{ fund_source: { version_id: 'fs-tw', business_key: 'NSTW-DTPT' }, origin: 'PM_ASSIGNED', amount_vnd: dong(2000), status: 'PUBLISHED' }, { fund_source: { version_id: 'fs-oda', business_key: 'ODA-ONLEND' }, origin: 'CENTRAL_SUPPORT', amount_vnd: dong(500), status: 'PUBLISHED' }, { fund_source: { version_id: 'fs-grant', business_key: 'ODA-NONLEND' }, origin: 'CENTRAL_SUPPORT', amount_vnd: dong(400), status: 'PUBLISHED' }];
      case 'getDisbursementForecast': return { disbursed_vnd: dong(55), curve: Array.from({ length: 11 }, (_, m) => ({ month: m + 1, actual_cumulative_vnd: dong((m + 1) * 5), forecast_cumulative_vnd: null })) };
      // The board lists open tasks: one row of each project that runs a workflow in the worlds of tasks.
      case 'getDeadlineBoard': return world.tasks !== undefined ? Array.from({ length: world.tasks.onBoard ?? held.workflows }, (_, i) => ({ project_id: `p-${i}`, band: { overdue: false, remaining_days: 6 } })) : world.workflows === true ? [{ project_id: 'p-0', band: { overdue: true, remaining_days: -18 } }, { project_id: 'p-0', band: { overdue: true, remaining_days: -4 } }, ...['p-1', 'p-2', 'p-3', 'p-4'].map((id) => ({ project_id: id, band: { overdue: false, remaining_days: 6 } }))] : [];
      case 'getProjectBaseline': return world.baselines ? { has_baseline: true, deviation: { finish_slip_days: 21 } } : { has_baseline: false, deviation: null };
      // The list keeps the requests of the status it is asked for.
      case 'listExplanationRequests': return requests.filter((row) => input.query?.status === undefined || row.status === input.query.status);
      case 'get_resources_approval_task': return papers;
      case 'listDirectives': return directives;
      case 'listSteeringMeetings': return [{ id: 'm-0', code: 'GB-0', meeting_type: 'MONTHLY', meeting_date: '2026-09-15' }, { id: 'm-1', code: 'GB-1', meeting_type: 'EXTRAORDINARY', meeting_date: '2026-09-22' }, { id: 'm-2', code: 'GB-2', meeting_type: 'QUARTERLY', meeting_date: '2026-09-29' }];
      case 'getProjectWorkflow': {
        // A project without a workflow answers 404.
        if (Number(id.slice(2)) >= held.workflows) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
        return { id: `w-${id}`, project_id: id, status: 'ACTIVE', phases: PHASES.map(([code, name], order) => ({ code, name, order })) };
      }
      case 'listProjectTasks': return tasksOf(id);
      case 'getProjectTask': return { id, actual_finish: '2026-10-28' };
      default: throw new Error(`unexpected operation ${operation}`);
    }
  };
  const client = { read: (operation: string, input?: never) => Promise.resolve().then(() => answer(operation, input)), readAll: (operation: string, input?: never) => Promise.resolve().then(() => answer(operation, input) as unknown[]) };
  return { client: client as unknown as ApiClient, calls };
}

describe('what the capital bundle is read from', () => {
  it('reads the snapshot, the curve, the units, every project with its plan lines, monthly series and baseline', async () => {
    const { client, calls } = clientOf({ units: 5, perUnit: 2, baselines: true });
    const input = await readCapitalInput(client, TODAY);
    expect(input).toMatchObject({ today: TODAY, asOfDate: '2026-11-13', treasuryCutoffDate: '2026-11-12' });
    expect(input.targetCurve).toHaveLength(12);
    expect(input.units).toHaveLength(6);
    expect([...input.notReportingUnitIds]).toEqual(['u-1']);
    expect(input.projects).toHaveLength(10);
    expect(input.projects[0]).toMatchObject({ code: 'DA-DT205', investor_unit_id: 'u-0', area: { label: 'Xã Tân Tiến' }, sector: { label: 'Giao thông' } });
    expect(input.lines).toHaveLength(30);
    expect(Object.keys(input.curves)).toHaveLength(10);
    expect(input.delays['p-0']).toBe(21);
    // One read of the detail, of the series and of the baseline for each project, and no more.
    expect(calls.filter((name) => name === 'get_resources_project_id')).toHaveLength(10);
    expect(calls.filter((name) => name === 'getDisbursementForecast')).toHaveLength(10);
    expect(calls.filter((name) => name === 'getProjectBaseline')).toHaveLength(10);
  });

  it('fails when the command center names no frozen snapshot', async () => {
    const client = { read: () => Promise.resolve({}), readAll: () => Promise.resolve([]) } as unknown as ApiClient;
    await expect(readCapitalInput(client, TODAY)).rejects.toThrow(/no frozen snapshot/);
  });
});

describe('the dashboard: real figures where there are enough, the template where there are not', () => {
  it('takes the capital bundle from the system when it holds enough, and keeps the other bundles of the template that still name its units and projects', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: true });
    const read = await readDashboard(client, TODAY);
    // This province records no directive: the tasks stay on the template, and the note says why.
    expect(read.notes).toEqual([NO_TASKS, NO_SUBMISSIONS]);
    expect(read.origins).toMatchObject({ du_an: 'system', don_vi: 'system', giai_ngan: 'system', nguon_von: 'system', muc_tieu: 'system', moc_thoi_gian: 'system', nhiem_vu: 'template', ho_so_trinh: 'template', nv_goc: 'template', luot_giao: 'template' });
    expect(read.db.du_an).toHaveLength(10);
    expect(read.db.moc_thoi_gian[0]).toMatchObject({ hom_nay: TODAY, thang_chot: 10, ngay_chot_so: '2026-11-13', kho_bac_den: '2026-11-12' });
    // The tasks of the template that name a unit or a project the system does not have are left out; what is left holds together.
    expect(read.db.nhiem_vu.length).toBeGreaterThan(0);
    expect(read.db.nhiem_vu.length).toBeLessThan(930);
    expect(referenceProblems(read.db)).toEqual([]);
    expect(read.db.nv_goc).toHaveLength(60);
  });

  it('keeps the template, and says what is missing, when one investor holds every project and no project has a baseline', async () => {
    const { client, calls } = clientOf({ units: 1, perUnit: 12, baselines: false });
    const read = await readDashboard(client, TODAY);
    expect(new Set(Object.values(read.origins))).toEqual(new Set(['template']));
    expect(read.db.du_an).toHaveLength(45);
    expect(read.notes.join(' | ')).toMatch(/1 investor units/);
    // The register of projects already shows it: the projects are not read one by one for a bundle that cannot be used.
    expect(calls.filter((name) => name === 'get_resources_project_id' || name === 'getDisbursementForecast' || name === 'getProjectBaseline')).toHaveLength(0);
  });

  it('keeps the template when the projects are spread over enough units but none has a baseline', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: false });
    const read = await readDashboard(client, TODAY);
    expect(new Set(Object.values(read.origins))).toEqual(new Set(['template']));
    expect(read.notes.join(' | ')).toMatch(/0 projects have a measure of delay/);
  });

  it('measures the delay of a project by its workflow when it has no baseline: the most overdue open task, and none overdue is on time', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: false, workflows: true });
    const read = await readDashboard(client, TODAY);
    expect(read.notes.filter((note) => note.startsWith('capital'))).toEqual([]);
    expect(read.origins.du_an).toBe('system');
    const late = Object.fromEntries(read.db.du_an.map((project) => [project.ma, project.ngay_cham]));
    expect(late['DA-DT205']).toBe(18);
    expect(late['DA-TH012']).toBe(0);
  });

  it('keeps the template, and says so, when the system cannot be read', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: true, broken: ['getCommitteeWorkspace'] });
    const read = await readDashboard(client, TODAY);
    expect(new Set(Object.values(read.origins))).toEqual(new Set(['template']));
    expect(read.notes.join(' | ')).toMatch(/could not be read/);
    expect(read.db.nhiem_vu).toHaveLength(930);
  });
});

const ENOUGH = { directives: 24, workflows: 5, perWorkflow: 24, done: 6 } as const;
const count = (calls: readonly string[], operation: string): number => calls.filter((name) => name === operation).length;
const TASK_READS = ['listDirectives', 'listSteeringMeetings', 'getProjectWorkflow', 'listProjectTasks', 'getProjectTask', 'listExplanationRequests', 'get_resources_approval_task'];
type Loose = { read(operation: string, input?: unknown): Promise<unknown>; readAll(operation: string, input?: unknown): Promise<unknown[]> };

describe('what the tasks bundle is read from', () => {
  it('reads the directives with their meetings, the workflow of every project, the tasks of the ones that run one, and the finished tasks in full', async () => {
    const { client, calls } = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH });
    const input = await readTasksInput(client, TODAY);
    expect(input.today).toBe(TODAY);
    expect(input.directives).toHaveLength(24);
    expect(input.directives[0]).toEqual({ code: 'CD-0', text: 'Chỉ đạo số 0', status: 'DONE', unit_code: 'CM-BQLDAGT', project_code: 'DA-DT205', meeting_id: 'm-0', meeting_code: 'GB-0', due_on: '2026-10-20', closed_at: '2026-10-22T08:30:00Z', overdue_days: 0 });
    expect(input.directives[1]).toMatchObject({ status: 'OVERDUE', project_code: null, closed_at: null, overdue_days: 19 });
    expect(input.meetings).toEqual([{ id: 'm-0', meeting_type: 'MONTHLY' }, { id: 'm-1', meeting_type: 'EXTRAORDINARY' }, { id: 'm-2', meeting_type: 'QUARTERLY' }]);
    expect(input.units).toHaveLength(6);
    expect(input.projects).toHaveLength(10);
    expect(Object.keys(input.phases).sort()).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'p-4']);
    expect(input.phases['p-0']?.[3]).toEqual({ code: 'IMPLEMENTATION', name: 'Thực hiện đầu tư' });
    expect(input.tasks).toHaveLength(120);
    expect(input.tasks[0]).toEqual({ project_id: 'p-0', task_code: 'T0', name: 'Công việc 0', phase_code: 'PREPARATION', kind: 'TASK', status: 'DONE', excluded: false, tracked: true, planned_finish: '2026-10-30', late_days: 0, receiving_unit_id: 'u-1', actual_finish: '2026-10-28' });
    expect(input.tasks[6]).toMatchObject({ kind: 'MILESTONE', status: 'NOT_STARTED', late_days: 12, receiving_unit_id: 'u-1', actual_finish: null });
    // One read of the workflow and one list of tasks for each project the deadline board names (the other five are not asked: each would answer 404), and the task in
    // full for the finished ones only.
    expect(count(calls, 'getProjectWorkflow')).toBe(5);
    expect(count(calls, 'listProjectTasks')).toBe(5);
    expect(count(calls, 'getProjectTask')).toBe(5 * 6);
  });

  it('follows the pages of the directives to the end, two hundred at a time', async () => {
    const loose = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH }).client as unknown as Loose;
    const asked: unknown[] = [];
    // The directives come ten to a page, and `readAll` does what the client's does: it asks for the next page until the server names none.
    const page = async (query: { cursor?: string } = {}): Promise<{ items: unknown[]; next_cursor: string | null }> => {
      asked.push(query);
      const all = await loose.readAll('listDirectives');
      const from = Number(query.cursor ?? 0);
      return { items: all.slice(from, from + 10), next_cursor: from + 10 < all.length ? String(from + 10) : null };
    };
    const paged = {
      read: loose.read,
      readAll: async (operation: string, input: { query?: Record<string, unknown> } = {}) => {
        if (operation !== 'listDirectives') return loose.readAll(operation, input);
        const items: unknown[] = [];
        let cursor: string | null | undefined;
        while (cursor !== null) {
          const answer = await page(cursor === undefined ? input.query : { ...input.query, cursor });
          items.push(...answer.items);
          cursor = answer.next_cursor;
        }
        return items;
      },
    } as unknown as ApiClient;
    const input = await readTasksInput(paged, TODAY);
    expect(input.directives.map((directive) => directive.code)).toEqual(Array.from({ length: 24 }, (_, i) => `CD-${i}`));
    expect(asked).toEqual([{ limit: 200 }, { limit: 200, cursor: '10' }, { limit: 200, cursor: '20' }]);
  });

  it('stops before the reads by project when the directives are too few, before the tasks when too few projects run a workflow, and before the tasks in full when the tasks are too few', async () => {
    const few = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: { ...ENOUGH, directives: 19 } });
    await expect(readTasksInput(few.client, TODAY)).rejects.toThrow(/^19 directives are recorded \(at least 20 are needed\)$/);
    expect(few.calls).toEqual(['listDirectives']);

    const noWorkflows = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: { ...ENOUGH, workflows: 4 } });
    await expect(readTasksInput(noWorkflows.client, TODAY)).rejects.toThrow(/^4 projects run a workflow \(at least 5 are needed\)$/);
    expect(count(noWorkflows.calls, 'getProjectWorkflow')).toBe(0);
    expect(count(noWorkflows.calls, 'listProjectTasks')).toBe(0);

    // A project the board names that answers 404 runs no workflow after all: it is asked once, and not counted.
    const gone = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: { ...ENOUGH, workflows: 4, onBoard: 5 } });
    await expect(readTasksInput(gone.client, TODAY)).rejects.toThrow(/^4 projects run a workflow \(at least 5 are needed\)$/);
    expect(count(gone.calls, 'getProjectWorkflow')).toBe(5);
    expect(count(gone.calls, 'listProjectTasks')).toBe(0);

    const fewTasks = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: { ...ENOUGH, perWorkflow: 19 } });
    await expect(readTasksInput(fewTasks.client, TODAY)).rejects.toThrow(/^95 project tasks are recorded \(at least 100 are needed\)$/);
    expect(count(fewTasks.calls, 'getProjectTask')).toBe(0);
  });

  it('leaves out an answer of another shape', async () => {
    const loose = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH }).client as unknown as Loose;
    const odd = {
      read: (operation: string, input?: unknown) => (operation === 'getProjectWorkflow' ? loose.read(operation, input).then((workflow) => ({ ...(workflow as object), phases: [{ code: 'PREPARATION' }, 'x', { code: 'HANDOVER', name: 'Bàn giao' }] })) : loose.read(operation, input)),
      readAll: async (operation: string, input?: unknown) => {
        const items = await loose.readAll(operation, input);
        if (operation === 'listDirectives') return [...items, { code: 'CD-X' }, 'x', { code: 'CD-Y', text: 'Chỉ đạo', stored_status: 'OPEN', overdue_days: '3' }];
        if (operation === 'listSteeringMeetings') return [...items, { id: 'm-9' }];
        if (operation === 'get_resources_organization_unit') return [...items, { id: 'u-9' }];
        if (operation === 'get_resources_project') return [...items, { code: 'DA-KHONG-ID' }];
        // A row of the board without a project, and one of a project the register does not have, find nothing.
        if (operation === 'getDeadlineBoard') return [...items, { band: {} }, 'x', { project_id: 'p-99' }];
        if (operation === 'listProjectTasks') return [...items, { id: 't-x', task_code: 'TX' }, { id: 't-y', task_code: 'TY', name: 'Việc', phase_code: 'HANDOVER', status: 'IN_PROGRESS', band: { overdue: true, remaining_days: null } }];
        return items;
      },
    } as unknown as ApiClient;
    const input = await readTasksInput(odd, TODAY);
    expect(input.directives).toHaveLength(25);
    // The stored status stands in for a status that is absent; days that are not a number are absent.
    expect(input.directives[24]).toEqual({ code: 'CD-Y', text: 'Chỉ đạo', status: 'OPEN', unit_code: null, project_code: null, meeting_id: null, meeting_code: null, due_on: null, closed_at: null, overdue_days: null });
    expect(input.meetings).toHaveLength(3);
    expect(input.units).toHaveLength(6);
    expect(input.projects).toHaveLength(10);
    expect(input.phases['p-0']).toEqual([{ code: 'HANDOVER', name: 'Bàn giao' }]);
    expect(input.tasks).toHaveLength(125);
    expect(input.tasks[24]).toEqual({ project_id: 'p-0', task_code: 'TY', name: 'Việc', phase_code: 'HANDOVER', kind: 'TASK', status: 'IN_PROGRESS', excluded: false, tracked: false, planned_finish: null, late_days: 0, receiving_unit_id: null, actual_finish: null });
    expect(input.tasks.filter((task) => task.actual_finish !== null)).toHaveLength(5 * 6);
  });

  it('fails when a finished task cannot be read in full: a finished task without its day would count as finished on time', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH, broken: ['getProjectTask'] });
    await expect(readTasksInput(client, TODAY)).rejects.toThrow(/^getProjectTask failed$/);
  });

  it('fails when the tasks of a project cannot be listed: a part of the tasks is not drawn as the whole', async () => {
    const { client, calls } = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH, broken: ['listProjectTasks'] });
    await expect(readTasksInput(client, TODAY)).rejects.toThrow(/^listProjectTasks failed$/);
    expect(count(calls, 'getProjectTask')).toBe(0);
  });

  it('fails when the deadline board cannot be read: the projects that run a workflow are not known', async () => {
    const { client, calls } = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH, broken: ['getDeadlineBoard'] });
    await expect(readTasksInput(client, TODAY)).rejects.toThrow(/^getDeadlineBoard failed$/);
    expect(count(calls, 'getProjectWorkflow')).toBe(0);
  });

  it('reads only an answer of 404 as a project without a workflow: any other failure of that read fails', async () => {
    const { client, calls } = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH, broken: ['getProjectWorkflow'] });
    await expect(readTasksInput(client, TODAY)).rejects.toThrow(/^getProjectWorkflow failed$/);
    expect(count(calls, 'listProjectTasks')).toBe(0);
    // A failure that carries another status is not "none" either.
    const loose = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH }).client as unknown as Loose;
    const down = { read: (operation: string, input?: unknown) => (operation === 'getProjectWorkflow' ? Promise.reject(Object.assign(new Error('UNAVAILABLE'), { status: 503 })) : loose.read(operation, input)), readAll: loose.readAll } as unknown as ApiClient;
    await expect(readTasksInput(down, TODAY)).rejects.toThrow(/^UNAVAILABLE$/);
  });
});

describe('the dashboard: the tasks bundle beside the capital bundle', () => {
  it('takes both bundles from the system when it holds enough of each, and the engine of the template draws them', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH });
    const read = await readDashboard(client, TODAY);
    expect(read.notes).toEqual([NO_SUBMISSIONS]);
    expect(read.origins).toMatchObject({ du_an: 'system', don_vi: 'system', nhiem_vu: 'system', ho_so_trinh: 'template', nv_goc: 'template', luot_giao: 'template' });
    expect(read.db.nhiem_vu).toHaveLength(24 + 5 * 24);
    expect(referenceProblems(read.db)).toEqual([]);
    // The unit that receives a task when the register has it, the investor of the project when it does not.
    const byCode = Object.fromEntries(read.db.nhiem_vu.map((task) => [task.ma, task]));
    expect(byCode['DA-TH012/T0']).toMatchObject({ loai: 'Quy trình dự án', nhom: 'Chuẩn bị đầu tư', don_vi: 'CM-BQLDAXD', trang_thai: 'DONE', ngay_xong: '2026-10-28', han: '2026-10-30' });
    expect(byCode['DA-YT007/T1']).toMatchObject({ don_vi: 'CM-BQLDANN', trang_thai: 'DONE' });
    expect(byCode['CD-2']).toMatchObject({ loai: 'Chỉ đạo', nhom: 'Giao ban tháng', don_vi: 'CM-BQLDANN', trang_thai: 'DONE', ngay_xong: '2026-10-22', ngay_tre: 2, van_ban: 'GB-2' });
    const invest = E.invest(read.db) as unknown as { tc: { total: number; DONE: number }; weeks: { done: number }[] };
    expect(invest.tc).toMatchObject({ total: 144, DONE: 12 + 5 * 6 });
    expect(invest.weeks.reduce((sum, week) => sum + week.done, 0)).toBe(42);
    expect(() => E.gov(read.db)).not.toThrow();
  });

  it('leaves the tasks on the template, and reads none of them, while the capital tables are those of the template: the board keeps one clock', async () => {
    // One investor holds every project: the capital tables stay those of the template, though the province holds enough tasks.
    const { client, calls } = clientOf({ units: 1, perUnit: 12, baselines: false, tasks: ENOUGH });
    const read = await readDashboard(client, TODAY);
    expect(read.notes).toHaveLength(3);
    expect(read.notes[0]).toMatch(/^capital: 1 investor units/);
    expect(read.notes[2]).toBe('submissions: left on the template, whose clock the board keeps while the capital tables are those of the template');
    expect(read.notes[1]).toBe('tasks: left on the template, whose clock the board keeps while the capital tables are those of the template');
    expect(new Set(Object.values(read.origins))).toEqual(new Set(['template']));
    expect(read.db.du_an).toHaveLength(45);
    expect(read.db.nhiem_vu).toHaveLength(930);
    expect(calls.filter((name) => TASK_READS.includes(name))).toEqual([]);
    expect(referenceProblems(read.db)).toEqual([]);
    expect(() => E.invest(read.db)).not.toThrow();
    expect(() => E.gov(read.db)).not.toThrow();
  });

  it('keeps the capital bundle of the system, and the tasks of the template, when the tasks are too few or cannot be read', async () => {
    const few = await readDashboard(clientOf({ units: 5, perUnit: 2, baselines: true, tasks: { ...ENOUGH, done: 0 } }).client, TODAY);
    expect(few.notes).toEqual(['tasks: 12 finished rows carry the day they were finished (at least 20 are needed for the weekly rhythm)', NO_SUBMISSIONS]);
    expect(few.origins).toMatchObject({ du_an: 'system', nhiem_vu: 'template' });

    const broken = await readDashboard(clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH, broken: ['listSteeringMeetings'] }).client, TODAY);
    expect(broken.notes).toEqual(['tasks: the system could not be read (listSteeringMeetings failed)', NO_SUBMISSIONS]);
    expect(broken.origins).toMatchObject({ du_an: 'system', giai_ngan: 'system', nhiem_vu: 'template' });
    expect(broken.db.du_an).toHaveLength(10);
    // The tasks of the template that still name a unit and a project of the system stand beside it, as before.
    expect(broken.db.nhiem_vu.length).toBeGreaterThan(0);
    expect(broken.db.nhiem_vu.length).toBeLessThan(930);
    expect(referenceProblems(broken.db)).toEqual([]);

    // A read by project or by task that fails is a failure of the whole read of the tasks, and of nothing else.
    for (const operation of ['getDeadlineBoard', 'getProjectWorkflow', 'listProjectTasks', 'getProjectTask']) {
      const read = await readDashboard(clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH, broken: [operation] }).client, TODAY);
      expect(read.notes).toEqual([`tasks: the system could not be read (${operation} failed)`, NO_SUBMISSIONS]);
      expect(read.origins).toMatchObject({ du_an: 'system', don_vi: 'system', giai_ngan: 'system', moc_thoi_gian: 'system', nhiem_vu: 'template' });
      expect(read.db.du_an).toHaveLength(10);
      expect(referenceProblems(read.db)).toEqual([]);
    }
  });
});

const DESK = { explanations: 3, papers: 2 } as const;

describe('what the submissions bundle is read from', () => {
  it('reads the explanation requests and the tasks that wait for a decision, then the registers of units and projects', async () => {
    const { client, calls } = clientOf({ units: 5, perUnit: 2, baselines: true, submissions: DESK });
    const loose = client as unknown as Loose;
    const asked: [string, unknown][] = [];
    const watched = { read: loose.read, readAll: (operation: string, input?: unknown) => { asked.push([operation, input]); return loose.readAll(operation, input); } } as unknown as ApiClient;
    const input = await readSubmissionsInput(watched, TODAY);
    expect(input.today).toBe(TODAY);
    // The request that was answered is not asked for: the three that are owed past their day and the one due later are.
    expect(input.explanations).toHaveLength(4);
    expect(input.explanations[0]).toEqual({ status: 'OVERDUE', project: { id: 'p-1', code: 'DA-TH012', name: 'Dự án 1' }, unit: null, question: 'Giải trình tiến độ giải ngân thấp', due_at: '2026-11-10T10:00:00.000Z' });
    expect(input.explanations[1]).toMatchObject({ status: 'REQUESTED', project: null, unit: { id: 'u-2', name: 'Đơn vị CM-BQLDANN' } });
    expect(input.approvals).toHaveLength(2);
    expect(input.approvals[0]).toEqual({ status: 'Pending', business_type: 'plan.publish', step_name: 'Lãnh đạo duyệt', due_at: '2026-11-19T10:00:00.000Z', received_at: '2026-11-11T18:30:00.000Z', unit_id: 'u-0', resource: { type: 'capital_plan', id: 'cp-0' }, subject_name: null, project_code: null, unit_code: null });
    expect(input.units).toHaveLength(6);
    expect(input.projects[2]).toEqual({ id: 'p-2', code: 'DA-YT007', name: 'Dự án 2', investor_unit_id: 'u-2' });
    // Only the tasks that wait for the reader's own decision, and the requests of the three statuses that are owed, each status by itself: the closed history is not read.
    expect(asked.slice(0, 4)).toEqual([
      ['get_resources_approval_task', { query: { limit: 200, status: 'Pending', mine: 'true' } }],
      ['listExplanationRequests', { query: { limit: 200, status: 'OVERDUE' } }],
      ['listExplanationRequests', { query: { limit: 200, status: 'REQUESTED' } }],
      ['listExplanationRequests', { query: { limit: 200, status: 'RETURNED' } }],
    ]);
    expect(calls).toEqual(['get_resources_approval_task', 'listExplanationRequests', 'listExplanationRequests', 'listExplanationRequests', 'get_resources_organization_unit', 'get_resources_project']);
  });

  it('stops before the registers when nothing waits or what waits and what is owed are too few together', async () => {
    // The request that is due later counts here as owed: the lists are judged roughly before the registers are read, and to the day afterwards.
    for (const [desk, message] of [[{ explanations: 3, papers: 0 }, /^0 papers wait for a decision and 4 explanations are owed/], [{ explanations: 0, papers: 1 }, /^1 papers wait for a decision and 1 explanations are owed \(at least 3 in all and 1 of each are needed\)$/]] as const) {
      const { client, calls } = clientOf({ units: 5, perUnit: 2, baselines: true, submissions: desk });
      await expect(readSubmissionsInput(client, TODAY)).rejects.toThrow(message);
      expect(calls).toEqual(['get_resources_approval_task', 'listExplanationRequests', 'listExplanationRequests', 'listExplanationRequests']);
    }
  });

  it('leaves out an answer of another shape, takes what the owning module says of a record, and the day the task was made when the day it was sent is absent', async () => {
    const loose = clientOf({ units: 5, perUnit: 2, baselines: true, submissions: DESK }).client as unknown as Loose;
    const odd = {
      read: loose.read,
      readAll: async (operation: string, input?: unknown) => {
        const items = await loose.readAll(operation, input);
        if (operation === 'listExplanationRequests') return (input as { query: { status: string } }).query.status === 'RETURNED' ? [...items, 'x', { id: 'e-x' }, { status: 'RETURNED' }] : items;
        if (operation === 'get_resources_approval_task') return [...items, 'x', { status: 'Pending' }, { status: 'Pending', business_type: 'document.review', created_at: '2026-11-14T02:00:00.000Z', resource: { type: 'document' }, summary: { subject: { name: 'Hồ sơ thiết kế' }, project: { id: 'p-3', code: 'DA-NN031', name: 'Dự án 3' }, unit: { id: 'u-3', code: 'CM-STC', name: null } } }];
        if (operation === 'get_resources_organization_unit') return [...items, { id: 'u-9' }];
        if (operation === 'get_resources_project') return [...items, { code: 'DA-KHONG-ID' }];
        return items;
      },
    } as unknown as ApiClient;
    const input = await readSubmissionsInput(odd, TODAY);
    expect(input.explanations).toHaveLength(5);
    expect(input.explanations[4]).toEqual({ status: 'RETURNED', project: null, unit: null, question: null, due_at: null });
    expect(input.approvals).toHaveLength(3);
    expect(input.approvals[2]).toEqual({ status: 'Pending', business_type: 'document.review', step_name: null, due_at: null, received_at: '2026-11-14T02:00:00.000Z', unit_id: null, resource: null, subject_name: 'Hồ sơ thiết kế', project_code: 'DA-NN031', unit_code: 'CM-STC' });
    expect(input.units).toHaveLength(6);
    expect(input.projects).toHaveLength(10);
  });

  it('fails when one of its lists cannot be read, were it the requests of one status only', async () => {
    for (const operation of ['listExplanationRequests', 'get_resources_approval_task']) {
      await expect(readSubmissionsInput(clientOf({ units: 5, perUnit: 2, baselines: true, submissions: DESK, broken: [operation] }).client, TODAY)).rejects.toThrow(`${operation} failed`);
    }
    const loose = clientOf({ units: 5, perUnit: 2, baselines: true, submissions: DESK }).client as unknown as Loose;
    const down = { read: loose.read, readAll: (operation: string, input?: unknown) => (operation === 'listExplanationRequests' && (input as { query: { status: string } }).query.status === 'RETURNED' ? Promise.reject(new Error('the returned requests failed')) : loose.readAll(operation, input)) } as unknown as ApiClient;
    await expect(readSubmissionsInput(down, TODAY)).rejects.toThrow('the returned requests failed');
  });
});

describe('the dashboard: the submissions bundle beside the capital and the tasks bundles', () => {
  it('takes the three bundles from the system when it holds enough of each, and the engine of the template draws them', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH, submissions: DESK });
    const read = await readDashboard(client, TODAY);
    expect(read.notes).toEqual([]);
    expect(read.origins).toMatchObject({ du_an: 'system', nhiem_vu: 'system', ho_so_trinh: 'system', nv_goc: 'template', luot_giao: 'template' });
    expect(referenceProblems(read.db)).toEqual([]);
    expect(read.db.ho_so_trinh).toEqual([
      { ma: 'A1', loai: 'Tờ trình chờ duyệt', noi_dung: 'Ban hành kế hoạch vốn: Lãnh đạo duyệt', don_vi: 'CM-BQLDAGT', du_an: null, ngay_nhan: '2026-11-12', han: '2026-11-19' },
      { ma: 'A2', loai: 'Tờ trình chờ duyệt', noi_dung: 'Tiếp nhận báo cáo: Dự án 2', don_vi: 'CM-BQLDAXD', du_an: 'DA-YT007', ngay_nhan: '2026-11-12', han: '2026-11-19' },
      // A request about a project is owed by the investor of the project; one about a unit by that unit. The one due later and the one answered are not rows.
      { ma: 'E1', loai: 'Giải trình', noi_dung: 'Giải trình: Dự án 1', don_vi: 'CM-BQLDAXD', du_an: 'DA-TH012', ngay_nhan: null, han: '2026-11-10' },
      { ma: 'E2', loai: 'Giải trình', noi_dung: 'Giải trình: Đơn vị CM-BQLDANN', don_vi: 'CM-BQLDANN', du_an: null, ngay_nhan: null, han: '2026-11-10' },
      { ma: 'E3', loai: 'Giải trình', noi_dung: 'Giải trình: Dự án 1', don_vi: 'CM-BQLDAXD', du_an: 'DA-TH012', ngay_nhan: null, han: '2026-11-10' },
    ]);
    const invest = E.invest(read.db) as unknown as { queue: { kind: string; late: number }[]; tc: { total: number } };
    expect(invest.queue.map((row) => `${row.kind} ${row.late}`)).toEqual(['Chờ lãnh đạo duyệt 0', 'Chờ lãnh đạo duyệt 0', 'Giải trình quá hạn 5', 'Giải trình quá hạn 5', 'Giải trình quá hạn 5']);
    expect(invest.tc.total).toBe(144);
    expect(() => E.gov(read.db)).not.toThrow();
  });

  it('takes the submissions beside the tasks of the template, and keeps the capital and the tasks of the system when the submissions are too few or cannot be read', async () => {
    const alone = await readDashboard(clientOf({ units: 5, perUnit: 2, baselines: true, submissions: DESK }).client, TODAY);
    expect(alone.notes).toEqual([NO_TASKS]);
    expect(alone.origins).toMatchObject({ du_an: 'system', nhiem_vu: 'template', ho_so_trinh: 'system' });
    expect(alone.db.ho_so_trinh).toHaveLength(5);
    expect(referenceProblems(alone.db)).toEqual([]);

    const few = await readDashboard(clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH, submissions: { explanations: 1, papers: 1 } }).client, TODAY);
    expect(few.notes).toEqual(['submissions: 2 papers and explanations wait (at least 3 are needed)']);
    expect(few.origins).toMatchObject({ du_an: 'system', nhiem_vu: 'system', ho_so_trinh: 'template' });

    for (const operation of ['listExplanationRequests', 'get_resources_approval_task']) {
      const broken = await readDashboard(clientOf({ units: 5, perUnit: 2, baselines: true, tasks: ENOUGH, submissions: DESK, broken: [operation] }).client, TODAY);
      expect(broken.notes).toEqual([`submissions: the system could not be read (${operation} failed)`]);
      expect(broken.origins).toMatchObject({ du_an: 'system', giai_ngan: 'system', nhiem_vu: 'system', ho_so_trinh: 'template' });
      expect(broken.db.nhiem_vu).toHaveLength(144);
      // The papers of the template that still name a unit and a project of the system stand beside it, as before.
      expect(broken.db.ho_so_trinh.length).toBeLessThan(7);
      expect(referenceProblems(broken.db)).toEqual([]);
    }
  });
});
