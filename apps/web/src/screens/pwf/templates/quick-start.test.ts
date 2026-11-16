import { describe, expect, it } from 'vitest';
import roadRepair from './test/cb-road-repair.json';
import { appendPasted, cloneTemplate, emptyTemplate, parsePaste } from './quick-start';
import { linesOf, unverifiedRows } from './table-model';
import { MAX_TASKS, localProblems, originOf, paramsOfTemplate, readTemplate } from './template-model';
import type { Template } from './template-model';

const unitRefOf = (name: string): string | undefined => ({ 'chủ đầu tư': 'PROJECT_PARTY:INVESTOR', 'sở xây dựng': 'UNIT:00000000-0000-4000-8000-000000000011' })[name.toLowerCase()];

describe('rows pasted from a spreadsheet (R70)', () => {
  it('reads tab-separated lines of up to three cells (name, unit, days) and skips empty lines', () => {
    const rows = parsePaste('Khảo sát hiện trạng\tChủ đầu tư\t4\r\n\r\nLập dự toán\t\t\nThẩm định\tSở Xây dựng\n');
    expect(rows).toEqual([
      { line: 1, name: 'Khảo sát hiện trạng', unit: 'Chủ đầu tư', days: 4, problems: [] },
      { line: 3, name: 'Lập dự toán', unit: '', days: null, problems: [] },
      { line: 4, name: 'Thẩm định', unit: 'Sở Xây dựng', days: null, problems: [] },
    ]);
  });

  it('tells what is wrong with a row before anything is added: no name, too many cells, days that are not a number of days', () => {
    const rows = parsePaste(['\tChủ đầu tư\t3', 'A\tB\t3\tthừa', 'Bước\t\tba ngày', 'Bước\t\t0', 'Bước\t\t2000', `${'x'.repeat(201)}`, 'Đủ\t\t5\t\t'].join('\n'));
    expect(rows.map((row) => row.problems)).toEqual([['noName'], ['tooManyColumns'], ['badDays'], ['badDays'], ['badDays'], ['nameTooLong'], []]);
    expect(parsePaste('   \n\t\t\n')).toEqual([]);
  });

  it('only appends: the rows of the template stay as they are and the new rows come after them, each waiting for the one before', () => {
    const params = roadRepair as Record<string, unknown>;
    const template = readTemplate(params);
    const before = paramsOfTemplate(template) as unknown as { tasks: unknown[]; steps: unknown[] };
    const rows = parsePaste('Khảo sát bổ sung\tChủ đầu tư\t4\n\t\t3\nBàn giao mặt bằng\tĐơn vị lạ\t\nKiểm tra\tSở Xây dựng\t2');
    const outcome = appendPasted(template, 'ACCEPTANCE', rows, unitRefOf);
    expect(outcome.added).toBe(3);
    expect(outcome.overLimit).toBe(0);
    const after = paramsOfTemplate(outcome.template) as unknown as { tasks: Array<Record<string, unknown>>; steps: Array<Record<string, unknown>> };
    expect(after.tasks.slice(0, before.tasks.length)).toEqual(before.tasks);
    expect(after.steps.slice(0, before.steps.length)).toEqual(before.steps);
    const made = after.tasks.slice(before.tasks.length);
    expect(made.map((task) => [task.code, task.name, task.phase, task.duration_working_days])).toEqual([
      ['KHAO_SAT_BO_SUNG', 'Khảo sát bổ sung', 'ACCEPTANCE', 4],
      ['BAN_GIAO_MAT_BANG', 'Bàn giao mặt bằng', 'ACCEPTANCE', 4],
      ['KIEM_TRA', 'Kiểm tra', 'ACCEPTANCE', 2],
    ]);
    // A unit that is one of the choices is set; a unit nobody knows is not guessed (the row copies the row above instead).
    expect((made[0]?.responsible_units as Array<{ unit_ref: string }>)[0]?.unit_ref).toBe('PROJECT_PARTY:INVESTOR');
    expect((made[1]?.responsible_units as Array<{ unit_ref: string }>)[0]?.unit_ref).toBe('PROJECT_PARTY:INVESTOR');
    expect((made[2]?.responsible_units as Array<{ unit_ref: string }>)[0]?.unit_ref).toBe('UNIT:00000000-0000-4000-8000-000000000011');
    expect(made[1]?.predecessors).toEqual([{ task: 'KHAO_SAT_BO_SUNG', kind: 'FS', lag_working_days: 0 }]);
    expect(localProblems(outcome.template)).toEqual([]);
  });

  it('stops at the limit of the template and says how many rows were left out', () => {
    const base = emptyTemplate('Đầy', 'Một');
    const text = Array.from({ length: MAX_TASKS + 3 }, (_, index) => `Bước ${index + 1}`).join('\n');
    // The steps of a template are capped lower than its tasks: what does not fit is counted, never dropped silently.
    const outcome = appendPasted(base, 'MOT', parsePaste(text), unitRefOf);
    expect(outcome.added + outcome.overLimit).toBe(MAX_TASKS + 3);
    expect(outcome.added).toBeLessThanOrEqual(MAX_TASKS);
    expect(outcome.overLimit).toBeGreaterThanOrEqual(3);
  });
});

describe('a copy of a procedure in use', () => {
  it('keeps everything but the name and the verification: every ground comes unverified, and the copy is written in the editor\'s own form', () => {
    const params = roadRepair as Record<string, unknown>;
    const stamped = { ...(params as { tasks: Array<Record<string, unknown>> }) };
    const source: Template = readTemplate({ ...stamped, tasks: (params.tasks as Array<Record<string, unknown>>).map((task, at) => (at === 0 ? { ...task, legal_basis: [{ document: 'LAW_58_2024_QH15', verification: 'VERIFIED', verified_by: '00000000-0000-4000-8000-000000000001', verified_at: '2026-11-16T03:00:00.000Z' }] } : task)) });
    const copy = cloneTemplate(source, 'Bản sao của sửa chữa đường');
    expect(copy.name).toBe('Bản sao của sửa chữa đường');
    expect(originOf(copy)).toBeUndefined();
    expect(copy.tasks.every((task) => originOf(task) === undefined)).toBe(true);
    expect(copy.tasks.map((task) => task.code)).toEqual(source.tasks.map((task) => task.code));
    expect(copy.tasks[0]?.legal_basis).toEqual([{ document: 'LAW_58_2024_QH15', verification: 'UNVERIFIED' }]);
    expect(JSON.stringify(paramsOfTemplate(copy)).includes('verified_by')).toBe(false);
    expect(unverifiedRows(copy)).toBeGreaterThan(0);
    expect(linesOf(copy)).toHaveLength(linesOf(source).length);
    expect(localProblems(copy)).toEqual([]);
    // The source is not touched.
    expect(paramsOfTemplate(readTemplate(params))).toEqual(params);
  });

  it('an empty procedure has its name and its first phase', () => {
    const template = emptyTemplate('Quy trình mới', 'Chuẩn bị');
    expect(template).toMatchObject({ name: 'Quy trình mới', phases: [{ code: 'CHUAN_BI', name: 'Chuẩn bị', gates: [] }], tasks: [] });
  });
});
