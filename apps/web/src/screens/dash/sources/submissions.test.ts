import { describe, expect, it } from 'vitest';
import type { SubmissionRow } from '../db';
import { E } from '../template/engine.js';
import { assemble, referenceProblems } from './assemble';
import { EXPLANATION, PAPER, SUBMISSIONS_FLOOR, submissionsFromSystem, vietnamDayOf, workingDaysLate } from './submissions';
import type { SubmissionsInput, SystemApprovalTask, SystemExplanation } from './submissions';
import { loadTemplateDb } from './template-db';

// A Tuesday.
const TODAY = '2026-11-17';
const UNITS = ['CM-BQLDAGT', 'CM-BQLDAXD', 'CM-STC', 'CM-SXD'];
const PROJECTS = ['DA-DT205', 'DA-TH012', 'DA-YT007'];

const explanation = (over: Partial<SystemExplanation> = {}): SystemExplanation => ({
  status: 'OVERDUE', project: { id: 'p-1', code: 'DA-TH012', name: 'Trường học số 12' }, unit: null, question: 'Giải trình tiến độ giải ngân thấp', due_at: '2026-11-10T10:00:00.000Z', ...over,
});
const paper = (over: Partial<SystemApprovalTask> = {}): SystemApprovalTask => ({
  status: 'Pending', business_type: 'plan.publish', step_name: 'Lãnh đạo duyệt', due_at: '2026-11-19T10:00:00.000Z', received_at: '2026-11-11T18:30:00.000Z', unit_id: 'u-2', resource: { type: 'capital_plan', id: 'cp-1' },
  subject_name: null, project_code: null, unit_code: null, ...over,
});

function province(explanations: readonly SystemExplanation[], approvals: readonly SystemApprovalTask[]): SubmissionsInput {
  return {
    today: TODAY, explanations, approvals,
    projects: PROJECTS.map((code, i) => ({ id: `p-${i}`, code, name: `Dự án ${i}`, investor_unit_id: i === 2 ? null : `u-${i}` })),
    units: UNITS.map((code, i) => ({ id: `u-${i}`, code })),
    knownUnitCodes: new Set(UNITS), knownProjectCodes: new Set(PROJECTS),
  };
}
const rowsOf = (input: SubmissionsInput): SubmissionRow[] => submissionsFromSystem(input).rows ?? [];
/** Enough of each kind for the floor, so that the rows of a case are returned beside them. */
const beside = (explanations: readonly SystemExplanation[], approvals: readonly SystemApprovalTask[]): SubmissionRow[] => rowsOf(province([explanation(), explanation(), ...explanations], [paper(), ...approvals]));

describe('the small rules of the submissions bundle', () => {
  it('takes the day of Viet Nam a moment falls on, a plain day as it is, and nothing out of what is neither', () => {
    expect(vietnamDayOf('2026-11-21T10:00:00.000Z')).toBe('2026-11-21');
    // Half past five in the afternoon in UTC is half past midnight of the next day in Viet Nam.
    expect(vietnamDayOf('2026-11-21T17:30:00.000Z')).toBe('2026-11-22');
    expect(vietnamDayOf('2026-11-21')).toBe('2026-11-21');
    expect([null, undefined, '', '21/11/2026', '2026-02-30', 'not a moment at all'].map(vietnamDayOf)).toEqual([null, null, null, null, null, null]);
  });

  it('counts the working days a deadline lies behind a day as the engine of the template does', () => {
    const cases: [string, string][] = [['2026-11-10', TODAY], ['2026-11-16', TODAY], [TODAY, TODAY], ['2026-11-20', TODAY], ['2026-11-14', '2026-11-16'], ['2026-11-13', '2026-11-16'], ['2026-10-01', TODAY]];
    expect(cases.map(([deadline, today]) => workingDaysLate(deadline, today))).toEqual([5, 1, 0, 0, 0, 1, 33]);
    // The engine counts the same days with the other sign.
    for (const [deadline, today] of cases) expect(workingDaysLate(deadline, today)).toBe(Math.max(0, -(E as unknown as { wd(today: string, day: string): number }).wd(today, deadline)));
  });
});

describe('the submissions bundle', () => {
  it('writes an explanation that is owed past its deadline under its project, with the investor of the project when no unit was asked', () => {
    const rows = beside([explanation({ status: 'REQUESTED', project: null, unit: { id: 'u-3', name: 'Sở Xây dựng' } }), explanation({ status: 'RETURNED', project: { id: 'p-0', code: null, name: null }, due_at: '2026-11-16' })], []);
    expect(rows.filter((row) => row.loai === EXPLANATION)).toEqual([
      { ma: 'E1', loai: 'Giải trình', noi_dung: 'Giải trình: Trường học số 12', don_vi: 'CM-BQLDAXD', du_an: 'DA-TH012', ngay_nhan: null, han: '2026-11-10' },
      { ma: 'E2', loai: 'Giải trình', noi_dung: 'Giải trình: Trường học số 12', don_vi: 'CM-BQLDAXD', du_an: 'DA-TH012', ngay_nhan: null, han: '2026-11-10' },
      // A request about a unit: the unit that was asked, and its name.
      { ma: 'E3', loai: 'Giải trình', noi_dung: 'Giải trình: Sở Xây dựng', don_vi: 'CM-SXD', du_an: null, ngay_nhan: null, han: '2026-11-10' },
      // A project the request names by its id only: the code and the name of the register.
      { ma: 'E4', loai: 'Giải trình', noi_dung: 'Giải trình: Dự án 0', don_vi: 'CM-BQLDAGT', du_an: 'DA-DT205', ngay_nhan: null, han: '2026-11-16' },
    ]);
    // Neither a project nor a unit with a name: the question that was asked.
    expect(beside([explanation({ project: null, unit: { id: 'u-0', name: null } })], [])[3]).toMatchObject({ noi_dung: 'Giải trình: Giải trình tiến độ giải ngân thấp', don_vi: 'CM-BQLDAGT' });
    expect(beside([explanation({ project: null, unit: { id: 'u-0', name: null }, question: null })], [])[3]).toMatchObject({ noi_dung: 'Giải trình' });
  });

  it('leaves out an explanation that is answered, closed, not yet due, without a day, or of a unit or a project the tables do not have', () => {
    const out = [
      explanation({ status: 'RESPONDED' }), explanation({ status: 'ACCEPTED' }), explanation({ status: 'CANCELLED' }),
      // Due later this week, due today, and due on the Saturday before a Monday: the engine would call each "late by 0 days" or less.
      explanation({ due_at: '2026-11-21T10:00:00.000Z' }), explanation({ due_at: `${TODAY}T01:00:00.000Z` }),
      explanation({ due_at: null }), explanation({ due_at: 'soon' }),
      explanation({ project: { id: 'p-9', code: 'DA-KHAC', name: 'Dự án khác' } }), explanation({ project: { id: 'p-9', code: null, name: null } }),
      // The project has no investor; the unit asked is not in the register; nothing was named at all.
      explanation({ project: { id: 'p-2', code: 'DA-YT007', name: null } }), explanation({ project: null, unit: { id: 'u-9', name: 'Đơn vị khác' } }), explanation({ project: null, unit: null }),
    ];
    expect(beside(out, []).filter((row) => row.loai === EXPLANATION)).toHaveLength(2);
    expect(rowsOf({ ...province([explanation(), explanation({ due_at: '2026-11-14' })], [paper(), paper()]), today: '2026-11-16' }).filter((row) => row.loai === EXPLANATION)).toHaveLength(1);
    // A unit or a project of the register that the tables in use do not have takes its rows with it.
    expect(submissionsFromSystem({ ...province([explanation(), explanation()], [paper()]), knownProjectCodes: new Set(['DA-DT205']) }).reasons.join(' | ')).toMatch(/no explanation/);
    expect(submissionsFromSystem({ ...province([explanation(), explanation()], [paper()]), knownUnitCodes: new Set(['CM-STC']) }).reasons.join(' | ')).toMatch(/no explanation/);
  });

  it('writes a task that waits for a decision as a paper: the day it was sent, the day the workflow says it is due, the unit of the workflow', () => {
    const rows = beside([], [
      paper({ business_type: 'report.accept', resource: { type: 'project', id: 'p-0' }, unit_id: 'u-0', step_name: null }),
      paper({ business_type: 'something.new', subject_name: 'Điều chỉnh đợt 3', project_code: 'DA-YT007', unit_code: 'CM-SXD', unit_id: null, received_at: null }),
      paper({ business_type: 'payment.approve', step_name: null, resource: null, received_at: 'yesterday' }),
    ]);
    expect(rows.filter((row) => row.loai === PAPER)).toEqual([
      // Sent at half past six in the evening in UTC: the next day in Viet Nam.
      { ma: 'A1', loai: 'Tờ trình chờ duyệt', noi_dung: 'Ban hành kế hoạch vốn: Lãnh đạo duyệt', don_vi: 'CM-STC', du_an: null, ngay_nhan: '2026-11-12', han: '2026-11-19' },
      // A task about a project: the project of the register, and its name.
      { ma: 'A2', loai: 'Tờ trình chờ duyệt', noi_dung: 'Tiếp nhận báo cáo: Dự án 0', don_vi: 'CM-BQLDAGT', du_an: 'DA-DT205', ngay_nhan: '2026-11-12', han: '2026-11-19' },
      // What the owning module says of the record comes first; a kind of record without a name of its own is a record that waits.
      { ma: 'A3', loai: 'Tờ trình chờ duyệt', noi_dung: 'Hồ sơ chờ duyệt: Điều chỉnh đợt 3', don_vi: 'CM-SXD', du_an: 'DA-YT007', ngay_nhan: null, han: '2026-11-19' },
      { ma: 'A4', loai: 'Tờ trình chờ duyệt', noi_dung: 'Phê duyệt đề nghị thanh toán', don_vi: 'CM-STC', du_an: null, ngay_nhan: null, han: '2026-11-19' },
    ]);
  });

  it('leaves out a task that is decided, personal, without the day it is due, or of a unit or a project the tables do not have', () => {
    const out = [
      paper({ status: 'Decided' }), paper({ status: 'Cancelled' }), paper({ business_type: 'score.response' }),
      // No deadline is made up for a task that carries none.
      paper({ due_at: null }), paper({ due_at: 'later' }),
      paper({ unit_id: null }), paper({ unit_id: 'u-9' }), paper({ unit_code: 'CM-KHAC' }), paper({ project_code: 'DA-KHAC' }),
    ];
    expect(beside([], out).filter((row) => row.loai === PAPER)).toHaveLength(1);
    // A task about a project the register does not have is a paper without a project.
    expect(beside([], [paper({ resource: { type: 'project', id: 'p-9' } })])[1]).toMatchObject({ du_an: null, noi_dung: 'Ban hành kế hoạch vốn: Lãnh đạo duyệt' });
  });

  it('lets no markup of a text through', () => {
    const rows = beside([explanation({ project: { id: 'p-1', code: 'DA-TH012', name: '<img src=x onerror="alert(1)">Trường' } })], [paper({ subject_name: "<script>alert('x')</script>Tờ trình" })]);
    expect(rows.map((row) => row.noi_dung)).toContain('Giải trình: ‹img src=x onerror=”alert(1)”›Trường');
    expect(rows.map((row) => row.noi_dung)).toContain('Ban hành kế hoạch vốn: ‹script›alert(’x’)‹/script›Tờ trình');
    for (const row of rows) for (const value of Object.values(row)) if (typeof value === 'string') expect(value).not.toMatch(/[<>"'`]/);
  });

  it('stays on the template, and says each thing that is missing, under the floor', () => {
    const reasons = (input: SubmissionsInput) => submissionsFromSystem(input).reasons;
    expect(SUBMISSIONS_FLOOR).toEqual({ rows: 3, ofEachKind: 1 });
    expect(reasons(province([explanation()], [paper()]))).toEqual(['2 papers and explanations wait (at least 3 are needed)']);
    expect(reasons(province([explanation(), explanation(), explanation()], []))).toEqual(['no paper of a unit of the tables waits for a decision']);
    expect(reasons(province([], [paper(), paper(), paper()]))).toEqual(['no explanation of a unit of the tables is owed past its deadline']);
    expect(reasons(province([], []))).toHaveLength(3);
    expect(submissionsFromSystem(province([], [])).rows).toBeUndefined();
    // The rows are judged against the day of the screen: without it nothing is.
    expect(reasons({ ...province([explanation(), explanation()], [paper()]), today: 'now' })).toEqual(['the day the screen is read is not a day']);
  });

  it('is taken from the system when it holds enough, and the engine of the template draws it', async () => {
    const template = await loadTemplateDb();
    const input = { ...province([explanation(), explanation({ due_at: '2026-11-16' })], [paper(), paper({ due_at: '2026-11-13T02:00:00.000Z' })]), knownUnitCodes: new Set(template.don_vi.map((unit) => unit.ma)), knownProjectCodes: new Set(template.du_an.map((project) => project.ma)) };
    const result = submissionsFromSystem(input);
    expect(result.reasons).toEqual([]);
    expect(result.rows).toHaveLength(4);
    const data = assemble(template, { ho_so_trinh: result.rows ?? [] });
    expect(data.origins).toMatchObject({ ho_so_trinh: 'system', nhiem_vu: 'template', du_an: 'template' });
    expect(referenceProblems(data.db)).toEqual([]);
    // The clock of the template is the same Tuesday: the engine reads the papers as waiting or overdue, and every explanation as overdue by a whole number of days.
    const invest = E.invest(data.db) as unknown as { queue: { kind: string; late: number; left?: number; level: string }[] };
    expect(invest.queue.map(({ kind, late, left, level }) => ({ kind, late, left, level }))).toEqual([
      { kind: 'Chờ lãnh đạo duyệt', late: 0, left: 2, level: 'ACT' },
      { kind: 'Chờ lãnh đạo duyệt', late: 2, left: -2, level: 'URGENT' },
      { kind: 'Giải trình quá hạn', late: 5, left: undefined, level: 'URGENT' },
      { kind: 'Giải trình quá hạn', late: 1, left: undefined, level: 'ACT' },
    ]);
    expect(() => E.gov(data.db)).not.toThrow();
  });
});
