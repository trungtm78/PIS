import { describe, expect, it } from 'vitest';
import type { TaskRow } from '../db';
import { E } from '../template/engine.js';
import { assemble, referenceProblems } from './assemble';
import { DIRECTIVE, PROJECT_TASK, TASKS_FLOOR, dayOf, directiveStatus, meetingGroup, phaseGroup, taskStatus, tasksFromSystem } from './tasks';
import type { SystemDirective, SystemProjectTask, TasksInput } from './tasks';
import { loadTemplateDb } from './template-db';

const TODAY = '2026-11-17';
const UNITS = ['CM-BQLDAGT', 'CM-BQLDAXD', 'CM-STC', 'CM-SXD'];
const PROJECTS = ['DA-DT205', 'DA-TH012', 'DA-YT007', 'DA-NN031', 'DA-MT019', 'DA-CN026'];
const PHASES = ['PREPARATION', 'FEASIBILITY', 'APPROVAL', 'IMPLEMENTATION', 'ACCEPTANCE', 'SETTLEMENT'];
const STATUSES = ['DONE', 'IN_PROGRESS', 'NOT_STARTED', 'AWAITING_APPROVAL', 'ON_HOLD', 'CANCELLED'];

const directive = (i: number, over: Partial<SystemDirective> = {}): SystemDirective => ({
  code: `CD-${i}`, text: `Chỉ đạo số ${i}`, status: i % 2 === 0 ? 'DONE' : 'OVERDUE', unit_code: UNITS[i % UNITS.length] ?? null, project_code: i % 5 === 0 ? 'DA-DT205' : null,
  meeting_id: `m-${i % 3}`, meeting_code: `GB-${i % 3}`, due_on: '2026-10-20', closed_at: i % 2 === 0 ? '2026-10-23T08:30:00Z' : null, overdue_days: i % 2 === 0 ? 0 : 19, ...over,
});
const task = (project: number, k: number, over: Partial<SystemProjectTask> = {}): SystemProjectTask => {
  const status = STATUSES[k % STATUSES.length] as string;
  return {
    project_id: `p-${project}`, task_code: `T${k}`, name: `Công việc ${k}`, phase_code: PHASES[k % PHASES.length] as string, kind: k % 7 === 6 ? 'MILESTONE' : 'TASK', status, excluded: false, tracked: true,
    planned_finish: '2026-10-30', late_days: status === 'IN_PROGRESS' ? 12 : 0, receiving_unit_id: k % 2 === 0 ? 'u-2' : null, actual_finish: status === 'DONE' ? '2026-10-28' : null, ...over,
  };
};

/** A province with `directives` directives over three meetings and `perProject` tasks in each of `projects` workflows; every project is held by the first unit. */
function province(directives: number, projects: number, perProject: number): TasksInput {
  return {
    today: TODAY,
    directives: Array.from({ length: directives }, (_, i) => directive(i)),
    meetings: [{ id: 'm-0', meeting_type: 'MONTHLY' }, { id: 'm-1', meeting_type: 'EXTRAORDINARY' }, { id: 'm-2', meeting_type: 'SITE_VISIT' }],
    tasks: Array.from({ length: projects }, (_, p) => Array.from({ length: perProject }, (__, k) => task(p, k))).flat(),
    projects: PROJECTS.map((code, i) => ({ id: `p-${i}`, code, investor_unit_id: 'u-0' })),
    units: UNITS.map((code, i) => ({ id: `u-${i}`, code })),
    phases: {},
    knownUnitCodes: new Set(UNITS),
    knownProjectCodes: new Set(PROJECTS),
  };
}
const rowsOf = (input: TasksInput): TaskRow[] => tasksFromSystem(input).rows ?? [];
const one = (input: TasksInput, ma: string): TaskRow | undefined => rowsOf(input).find((row) => row.ma === ma);

describe('the small rules of the tasks bundle', () => {
  it('reads a directive as done, cancelled or open: the engine tells an overdue one by its deadline', () => {
    expect(['OPEN', 'IN_PROGRESS', 'OVERDUE', 'DONE', 'CANCELLED', 'SOMETHING'].map(directiveStatus)).toEqual(['OPEN', 'OPEN', 'OPEN', 'DONE', 'CANCELLED', 'OPEN']);
  });

  it('reads a project task as done, cancelled, paused, open or not tracked', () => {
    const of = (status: string, excluded = false, tracked = true) => taskStatus({ status, excluded, tracked });
    expect(['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'DONE', 'ON_HOLD', 'CANCELLED'].map((status) => of(status))).toEqual(['OPEN', 'OPEN', 'OPEN', 'DONE', 'PAUSED', 'CANCELLED']);
    // A task left out of the project is not tracked whatever its status; a task that is not tracked and was finished is still finished.
    expect(of('DONE', true)).toBe('NOT_TRACKED');
    expect(of('IN_PROGRESS', false, false)).toBe('NOT_TRACKED');
    expect(of('DONE', false, false)).toBe('DONE');
  });

  it('writes the meeting types under the kinds of meeting the template draws', () => {
    expect(['WEEKLY', 'MONTHLY', 'QUARTERLY'].map(meetingGroup)).toEqual(['Giao ban tháng', 'Giao ban tháng', 'Giao ban tháng']);
    expect(['EXTRAORDINARY', 'SITE_VISIT', 'OTHER', 'NEW_TYPE'].map(meetingGroup)).toEqual(['Ban chỉ đạo', 'Họp chuyên đề', 'Họp chuyên đề', 'Họp chuyên đề']);
    expect(meetingGroup(undefined)).toBe('Họp chuyên đề');
  });

  it('writes the phases of the standard workflows under the five phases the template draws, and keeps the name of a phase of the tenant', () => {
    expect(PHASES.map((code) => phaseGroup(code, undefined))).toEqual(['Chuẩn bị đầu tư', 'Đánh giá khả thi', 'Chuẩn bị thực hiện', 'Thi công', 'Nghiệm thu, quyết toán', 'Nghiệm thu, quyết toán']);
    // The engine joins kind and group with a bar: a name of the tenant never carries one, nor markup.
    expect(phaseGroup('HANDOVER', [{ code: 'HANDOVER', name: 'Bàn giao | <b>vận hành</b>' }])).toBe('Bàn giao / ‹b›vận hành‹/b›');
    expect(phaseGroup('HANDOVER', [])).toBe('HANDOVER');
  });

  it('takes a day out of a day or a moment, and nothing out of what is not a day that exists', () => {
    expect(dayOf('2026-10-23')).toBe('2026-10-23');
    expect(dayOf('2026-10-23T08:30:00Z')).toBe('2026-10-23');
    expect([null, undefined, '', '23/10/2026', '2026-13-01', '2026-02-30', '2026-1-5'].map(dayOf)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe('the tasks bundle', () => {
  it('writes a directive under its meeting, with the day it was closed and how late that was', () => {
    const input = province(24, 5, 24);
    expect(one(input, 'CD-0')).toEqual({
      ma: 'CD-0', loai: DIRECTIVE, nhom: 'Giao ban tháng', noi_dung: 'Chỉ đạo số 0', du_an: 'DA-DT205', don_vi: 'CM-BQLDAGT', la_moc: 0, cho_duyet: 0,
      han: '2026-10-20', ngay_xong: '2026-10-23', ngay_tre: 3, trang_thai: 'DONE', cuoc_hop: 'GB-0', van_ban: 'GB-0',
    });
    // An overdue directive is open: the days it runs late are the system's.
    expect(one(input, 'CD-1')).toMatchObject({ nhom: 'Ban chỉ đạo', du_an: null, han: '2026-10-20', ngay_xong: null, ngay_tre: 19, trang_thai: 'OPEN' });
    // A meeting the list of meetings does not have is a topic meeting; a cancelled directive is not late.
    const odd = { ...input, directives: [...input.directives, directive(100, { meeting_id: 'm-9', status: 'CANCELLED', overdue_days: 4 }), directive(101, { meeting_id: null, status: 'DONE', closed_at: '2026-10-19', due_on: null })] };
    expect(one(odd, 'CD-100')).toMatchObject({ nhom: 'Họp chuyên đề', trang_thai: 'CANCELLED', ngay_tre: 0, ngay_xong: null });
    expect(one(odd, 'CD-101')).toMatchObject({ nhom: 'Họp chuyên đề', trang_thai: 'DONE', han: null, ngay_xong: '2026-10-19', ngay_tre: 0 });
  });

  it('writes a project task under its phase, with the unit that receives it or else the investor of its project', () => {
    const input = province(24, 5, 24);
    expect(one(input, 'DA-DT205/T0')).toEqual({
      ma: 'DA-DT205/T0', loai: PROJECT_TASK, nhom: 'Chuẩn bị đầu tư', noi_dung: 'Công việc 0', du_an: 'DA-DT205', don_vi: 'CM-STC', la_moc: 0, cho_duyet: 0,
      han: '2026-10-30', ngay_xong: '2026-10-28', ngay_tre: 0, trang_thai: 'DONE', cuoc_hop: null, van_ban: null,
    });
    // No receiving unit: the investor. Open and overdue: the working days the system counts.
    expect(one(input, 'DA-DT205/T1')).toMatchObject({ nhom: 'Đánh giá khả thi', don_vi: 'CM-BQLDAGT', trang_thai: 'OPEN', ngay_tre: 12, ngay_xong: null });
    expect(one(input, 'DA-DT205/T3')).toMatchObject({ nhom: 'Thi công', cho_duyet: 1, trang_thai: 'OPEN' });
    expect(one(input, 'DA-DT205/T4')).toMatchObject({ nhom: 'Nghiệm thu, quyết toán', trang_thai: 'PAUSED' });
    expect(one(input, 'DA-DT205/T5')).toMatchObject({ nhom: 'Nghiệm thu, quyết toán', trang_thai: 'CANCELLED' });
    expect(one(input, 'DA-DT205/T6')).toMatchObject({ la_moc: 1, trang_thai: 'DONE' });
    // A receiving unit the register does not have falls back to the investor too; a task finished after its deadline is late by the days between.
    const more = { ...input, tasks: [...input.tasks, task(0, 90, { receiving_unit_id: 'u-gone', status: 'DONE', actual_finish: '2026-11-04', late_days: 9 }), task(0, 91, { status: 'IN_PROGRESS', tracked: false, late_days: 5 })] };
    expect(one(more, 'DA-DT205/T90')).toMatchObject({ don_vi: 'CM-BQLDAGT', ngay_xong: '2026-11-04', ngay_tre: 5 });
    expect(one(more, 'DA-DT205/T91')).toMatchObject({ trang_thai: 'NOT_TRACKED', ngay_tre: 0 });
  });

  it('leaves out a row whose unit or project the tables in use do not have, and a directive without a meeting', () => {
    const input = province(24, 5, 24);
    const odd: TasksInput = {
      ...input,
      directives: [...input.directives, directive(200, { unit_code: 'CM-KHAC' }), directive(201, { unit_code: null }), directive(202, { project_code: 'DA-KHAC' }), directive(203, { meeting_code: null })],
      tasks: [...input.tasks, task(5, 1), task(9, 0), task(0, 300, { receiving_unit_id: 'u-3' })],
      projects: [...input.projects.slice(0, 5), { id: 'p-5', code: 'DA-CN026', investor_unit_id: null }],
      knownUnitCodes: new Set(UNITS.slice(0, 3)),
    };
    const rows = rowsOf(odd);
    expect(rows.filter((row) => /^CD-20\d$/.test(row.ma))).toEqual([]);
    // The project without an investor and without a receiving unit, the project the register does not have, and the task of a unit the tables do not have.
    expect(rows.filter((row) => row.ma === 'DA-CN026/T1' || row.ma.endsWith('/T300'))).toEqual([]);
    expect(rows.every((row) => odd.knownUnitCodes.has(row.don_vi) && (row.du_an === null || odd.knownProjectCodes.has(row.du_an)))).toBe(true);
    // A project of the register that the tables in use do not have takes its tasks with it.
    expect(rowsOf({ ...input, knownProjectCodes: new Set(PROJECTS.slice(1)) }).some((row) => row.du_an === 'DA-DT205')).toBe(false);
  });

  it('treats a day that is not a day, and a completion day that has not come, as absent', () => {
    const input = province(24, 5, 24);
    const odd = {
      ...input,
      directives: [...input.directives, directive(300, { status: 'DONE', due_on: '20/10/2026', closed_at: 'yesterday' }), directive(301, { status: 'DONE', closed_at: '2026-12-01T00:00:00Z' }), directive(302, { status: 'OPEN', closed_at: '2026-10-01', overdue_days: null })],
      tasks: [...input.tasks, task(0, 400, { status: 'DONE', planned_finish: '2026-02-30', actual_finish: '2026-13-40' })],
    };
    expect(one(odd, 'CD-300')).toMatchObject({ han: null, ngay_xong: null, ngay_tre: 0, trang_thai: 'DONE' });
    expect(one(odd, 'CD-301')).toMatchObject({ ngay_xong: null, ngay_tre: 0 });
    // A closing day on a directive that is not done is not a completion day.
    expect(one(odd, 'CD-302')).toMatchObject({ ngay_xong: null, ngay_tre: 0, trang_thai: 'OPEN' });
    expect(one(odd, 'DA-DT205/T400')).toMatchObject({ han: null, ngay_xong: null });
    // A day the screen is read on that is not a day does not make every completion day a day to come.
    expect(one({ ...input, today: 'now' }, 'CD-0')).toMatchObject({ ngay_xong: '2026-10-23' });
  });

  it('lets no markup of a text through', () => {
    const input = province(24, 5, 24);
    const odd = {
      ...input,
      directives: [...input.directives, directive(400, { code: 'CD-<400>', text: '<img src=x onerror="alert(1)">Rà soát', meeting_code: 'GB-`7`' })],
      tasks: [...input.tasks, task(0, 500, { task_code: "T'500", name: '<script>alert(1)</script>Lập hồ sơ' })],
    };
    const rows = rowsOf(odd);
    expect(rows.find((row) => row.ma === 'CD-‹400›')).toMatchObject({ noi_dung: '‹img src=x onerror=”alert(1)”›Rà soát', cuoc_hop: 'GB-’7’', van_ban: 'GB-’7’' });
    expect(rows.find((row) => row.ma === 'DA-DT205/T’500')).toMatchObject({ noi_dung: '‹script›alert(1)‹/script›Lập hồ sơ' });
    for (const row of rows) for (const value of Object.values(row)) if (typeof value === 'string') expect(value).not.toMatch(/[<>"'`]/);
  });

  it('stays on the template, and says each thing that is missing, under the floors', () => {
    const reasons = (input: TasksInput) => tasksFromSystem(input).reasons.join(' | ');
    expect(tasksFromSystem(province(19, 5, 24)).rows).toBeUndefined();
    expect(reasons(province(TASKS_FLOOR.directives - 1, 5, 24))).toMatch(/^19 directives name a unit of the tables \(at least 20 are needed\)$/);
    expect(reasons(province(24, 5, 19))).toMatch(/^95 project tasks name a unit and a project of the tables \(at least 100 are needed\)$/);
    expect(reasons(province(24, 4, 30))).toMatch(/^4 projects run a workflow \(at least 5 are needed\)$/);
    // Nothing carries the day it was finished: the weekly rhythm would be empty.
    const noDays = province(24, 5, 24);
    const undated = { ...noDays, directives: noDays.directives.map((row) => ({ ...row, closed_at: null })), tasks: noDays.tasks.map((row) => ({ ...row, actual_finish: null })) };
    expect(reasons(undated)).toMatch(/^0 finished rows carry the day they were finished \(at least 20 are needed/);
    expect(reasons({ ...province(0, 0, 0) }).split(' | ')).toHaveLength(4);
    // Rows the tables in use cannot hold do not count towards a floor.
    expect(reasons({ ...province(24, 5, 24), knownUnitCodes: new Set<string>() })).toMatch(/0 directives .* 0 project tasks/);
  });

  it('is taken from the system when it holds enough, and the engine of the template draws it', async () => {
    const template = await loadTemplateDb();
    const input = { ...province(24, 5, 24), knownUnitCodes: new Set(template.don_vi.map((unit) => unit.ma)), knownProjectCodes: new Set(template.du_an.map((project) => project.ma)) };
    const result = tasksFromSystem(input);
    expect(result.reasons).toEqual([]);
    expect(result.rows).toHaveLength(24 + 5 * 24);
    const data = assemble(template, { nhiem_vu: result.rows ?? [] });
    expect(data.origins).toMatchObject({ nhiem_vu: 'system', du_an: 'template', nv_goc: 'template' });
    expect(referenceProblems(data.db)).toEqual([]);

    const invest = E.invest(data.db) as unknown as {
      tc: Record<string, number>; groupsT: { loai: string; nhom: string; c: { total: number } }[]; weeks: { done: number; late: number }[]; byDocT: { doc: string; nhom: string }[]; aging: { dir: number; pwf: number }[];
    };
    expect(() => E.gov(data.db)).not.toThrow();
    // 12 directives and 5 × 4 tasks are done; 5 × 4 tasks are cancelled, 5 × 4 paused (the engine counts those as not tracked); the other 12 and 5 × 12 are past their deadline.
    expect(invest.tc).toMatchObject({ total: 144, DONE: 32, CANCELLED: 20, NOT_TRACKED: 20, OVERDUE: 72, IN_TERM: 0, NO_DEADLINE: 0 });
    // Every group carries a name the charts of the template draw.
    const drawn = ['Giao ban tháng', 'Họp chuyên đề', 'Ban chỉ đạo', 'Chuẩn bị đầu tư', 'Đánh giá khả thi', 'Chuẩn bị thực hiện', 'Thi công', 'Nghiệm thu, quyết toán'];
    expect(invest.groupsT.every((group) => drawn.includes(group.nhom))).toBe(true);
    expect(invest.groupsT.reduce((sum, group) => sum + group.c.total, 0)).toBe(144);
    // The weekly rhythm finds the days: everything was finished in the twelve weeks before the day of the screen.
    expect(invest.weeks.reduce((sum, week) => sum + week.done, 0)).toBe(32);
    expect(invest.weeks.reduce((sum, week) => sum + week.late, 0)).toBeGreaterThan(0);
    expect(invest.byDocT.map((row) => row.doc).sort()).toEqual(['GB-0', 'GB-1', 'GB-2']);
    expect(invest.aging.reduce((sum, band) => sum + band.dir + band.pwf, 0)).toBe(72);
  });
});
