import { describe, expect, it } from 'vitest';
import builtIn from './test/builtin-templates.json';
import roadRepair from './test/cb-road-repair.json';
import { addRow, linesOf, moveLine, nameLine, setBand, setLeadUnit, setLimit, settleCodes, tableOf, toggleOverall } from './table-model';
import { localProblems, originOf, paramsOfTemplate, readTemplate } from './template-model';
import type { Template } from './template-model';

/*
 * The CRITICAL regression contract of the new editor (R62): a template that exists opens on the new screen and, written back, is the params it was: deep equal with the same keys present. The three fixtures of the
 * platform are the params of packages/kernel/src/project-workflow-defaults.ts (`PUBLIC_*_PROCESS`) and the fourth is the template the seed of the tenant writes (apps/web/e2e/hdsd/seed/clip/pwf-review.ts,
 * `tenantTemplate`), copied as JSON because the web may not import the kernel.
 * Value: protects=an existing template read and written gives its params and so its hash; fails_when=the new screen drops, adds or rewrites a field nobody touched; no_claim=templates outside these four shapes
 * beyond the odd shapes listed below.
 */

type Params = Record<string, unknown>;
const TEMPLATES: Record<string, Params> = { ...(builtIn as Record<string, Params>), CB_ROAD_REPAIR: roadRepair as Params };

/** Every path of a value with whether it is there: `a.b[0].c`. Deep equality alone does not tell `{ a: undefined }` from `{}`; the keys do. */
function keyPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return [`${path}[]:${value.length}`, ...value.flatMap((item, index) => keyPaths(item, `${path}[${index}]`))];
  if (typeof value === 'object' && value !== null) return Object.keys(value).sort().flatMap((key) => [`${path}.${key}`, ...keyPaths((value as Params)[key], `${path}.${key}`)]);
  return [];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('R62: a template read into the editor and written back is the params it was', () => {
  it.each(Object.keys(TEMPLATES))('%s: deep equal, the same keys present, and nothing the editor itself finds wrong', (code) => {
    const params = TEMPLATES[code] as Params;
    const before = clone(params);
    const written = paramsOfTemplate(readTemplate(params));
    expect(written).toEqual(params);
    expect(keyPaths(written)).toEqual(keyPaths(params));
    // Reading never changes what was read.
    expect(params).toEqual(before);
    expect(localProblems(readTemplate(params))).toEqual([]);
  });

  it.each(Object.keys(TEMPLATES))('%s: every task and step is shown by the table (a row, or a task under its step)', (code) => {
    const template = readTemplate(TEMPLATES[code]);
    const lines = linesOf(template);
    const shown = new Set(lines.flatMap((line) => line.taskIndexes));
    expect(shown.size).toBe(template.tasks.length);
    expect(lines.filter((line) => line.kind === 'step')).toHaveLength((template.steps ?? []).length);
    expect(tableOf(template).map((group) => group.phase?.code)).toEqual(template.phases.map((phase) => phase.code));
  });

  it('keeps shapes the editor would not write itself: an approver that is null, an empty list, a policy that says the default, a constraint that is null, keys it does not know', () => {
    const params: Params = {
      name: 'Mẫu có hình lạ',
      project_type: null,
      note_of_the_tenant: 'giữ nguyên',
      phases: [{ code: 'P1', name: 'Một', gates: [], colour: 'blue' }],
      steps: [],
      tasks: [
        { code: 'T1', name: 'A', phase: 'P1', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'PM', approver_role: null, priority: 'NORMAL', predecessors: [], constraint: null, legal_basis: [], form_templates: ['F_01'], form_policies: [{ form: 'F_01', policy: 'LATEST_APPROVED', revision: null }], future_field: { any: 1 } },
        { code: 'T2', name: 'B', phase: 'P1', kind: 'TASK', duration_working_days: 2, required: true, responsible_role: 'PM', priority: 'NORMAL', predecessors: [{ task: 'T1', kind: 'SS', lag_working_days: 2 }], step: null },
        { code: 'T3', name: 'C', phase: 'P1', kind: 'TASK', duration_working_days: 15, required: true, responsible_role: 'PM', priority: 'NORMAL', predecessors: [], duration: { value: 20, unit: 'CALENDAR_DAY', roll_to_working_day: false }, bands: { yellow_days: 5, red_days: 2 }, responsible_units: [{ unit_ref: 'PROJECT_OWNER', role: 'PM', part: 'LEAD' }], extension: { allowed: true, max_times: 1, unit: 'CALENDAR_DAY' }, legal_basis: [{ document: 'LAW_58_2024_QH15', verification: 'VERIFIED', verified_by: '00000000-0000-4000-8000-000000000001', verified_at: '2026-11-16T03:00:00.000Z' }] },
      ],
      parties: [{ code: 'APPRAISER', name: 'Đơn vị thẩm định' }],
      overall_deadline_task: 'T3',
    };
    const written = paramsOfTemplate(readTemplate(params));
    expect(written).toEqual(params);
    expect(keyPaths(written)).toEqual(keyPaths(params));
  });

  it('writes only the field the person used: a limit changed on one row leaves every other task, and every other field of that task, as stored', () => {
    const params = TEMPLATES.CB_ROAD_REPAIR as Params;
    const template = readTemplate(params);
    const at = template.tasks.findIndex((task) => task.code === 'RR_APPRAISAL');
    const written = paramsOfTemplate(setLimit(template, at, { value: 20, unit: 'CALENDAR_DAY' })) as unknown as { tasks: Params[] };
    const stored = (params.tasks as Params[])[at] as Params;
    expect(written.tasks[at]).toEqual({ ...stored, duration_working_days: 15, duration: { value: 20, unit: 'CALENDAR_DAY', roll_to_working_day: true } });
    written.tasks.forEach((task, index) => {
      if (index !== at) expect(task).toEqual((params.tasks as Params[])[index]);
    });
    // Back to what it was: the params are the stored ones again (the hash of an untouched template never moves).
    const back = setLimit(setLimit(template, at, { value: 20, unit: 'CALENDAR_DAY' }), at, { value: 5, unit: 'WORKING_DAY' });
    expect(paramsOfTemplate(back)).toEqual(params);
  });

  it('a template nobody touched in the new columns has none of the new keys', () => {
    for (const params of Object.values(TEMPLATES)) {
      const written = JSON.stringify(paramsOfTemplate(readTemplate(params)));
      for (const key of ['"duration"', '"bands"', '"responsible_units"', '"extension"', '"parties"', '"overall_deadline_task"', '"verified_by"']) expect(written.includes(key)).toBe(false);
    }
  });

  it('keeps every advanced field through the edits of the table: links of four kinds with a lag, branches, form policies, checklists and legal grounds survive a rename, a new row, a move and the new columns', () => {
    const params = TEMPLATES.PUBLIC_INVESTMENT as Params;
    let template: Template = readTemplate(params);
    const line = linesOf(template).find((one) => one.kind === 'step') ?? linesOf(template)[0];
    if (line === undefined) throw new Error('the fixture has no row');
    template = nameLine(template, line, 'Tên bước đã sửa');
    const firstPhase = template.phases[0]?.code ?? '';
    const added = addRow(template, firstPhase);
    if (added === undefined) throw new Error('no row was added');
    const newLine = linesOf(added.template).find((one) => one.key === added.key);
    if (newLine === undefined || newLine.taskIndex === null) throw new Error('the new row has no task');
    template = settleCodes(nameLine(added.template, newLine, 'Bước mới của ca kiểm'));
    template = moveLine(template, linesOf(template).find((one) => one.name === 'Bước mới của ca kiểm')?.key ?? '', -1);
    const some = template.tasks.findIndex((task) => task.kind === 'TASK');
    template = setBand(setBand(template, some, 'yellow_days', 3), some, 'red_days', 1);
    template = setLeadUnit(template, some, 'PROJECT_OWNER');
    template = toggleOverall(template, template.tasks[some]?.code ?? '');
    const written = paramsOfTemplate(template) as unknown as { tasks: Params[]; steps: Params[] };
    const advanced = ['predecessors', 'when', 'checklist', 'legal_doc_types', 'form_templates', 'kpi_codes', 'legal_basis', 'approver_role', 'priority', 'kind', 'required'];
    for (const stored of params.tasks as Params[]) {
      const now = written.tasks.find((task) => task.code === stored.code);
      expect(now, `task ${String(stored.code)} is still there`).toBeDefined();
      for (const key of advanced) {
        expect(now?.[key], `${String(stored.code)}.${key}`).toEqual(stored[key]);
        expect(key in (now ?? {}), `${String(stored.code)}.${key} is present as it was`).toBe(key in stored);
      }
    }
    for (const stored of params.steps as Params[]) expect(written.steps.find((step) => step.code === stored.code)?.legal_basis).toEqual(stored.legal_basis);
    expect(localProblems(template)).toEqual([]);
  });

  it('remembers where each entity was read from, and a template made in the editor is written in the editor\'s own form', () => {
    const params = TEMPLATES.PUBLIC_REPAIR as Params;
    const template = readTemplate(params);
    expect(originOf(template)).toBe(params);
    expect(originOf(template.tasks[0] as object)).toBe((params.tasks as Params[])[0]);
  });
});
