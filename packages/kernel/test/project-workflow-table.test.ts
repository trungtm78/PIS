import fc from 'fast-check';
import { DomainError } from '../src/errors.ts';
import { builtInDefault } from '../src/governance-rules.ts';
import { PROJECT_WORKFLOW_RULE_TYPE, nominalWorkingDays, parseProjectWorkflowTemplate, templateDefect, templateHash, templateParamsOf } from '../src/project-workflow.ts';
import { scheduleProject, standardTimes, tasksFromTemplate } from '../src/project-schedule.ts';
import type { PinnedCalendar } from '../src/project-schedule.ts';
import { assessExtensions, resolveResponsibleUnits, stampLegalVerification, workflowCodeFrom } from '../src/project-workflow-table.ts';

/*
 * The table of steps (PWF section 22): the new fields of a template are optional and a template without them is, byte for byte, what it was (R62, the CRITICAL regression contract); the checks of each new field; the codes made once
 * (R63); the stamp of a verified legal ground (R75); the units of a project (R61); the caps of an extension (R72).
 */

const CALENDARS: PinnedCalendar[] = [2026, 2027, 2028, 2029, 2030, 2031].map((year) => ({
  year,
  version: 1,
  content: { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [{ date: `${year}-09-02`, name: 'Quốc khánh' }, { date: `${year}-01-01`, name: 'Tết dương lịch' }], legal_basis_ref: 'fixture' },
}));

/** Taken from the code as it was before the table of steps (commit 16ae4dae1): the hash of each built-in template, and of its schedule from 2 November 2026 on the calendars above. */
const GOLDEN: Record<string, { templateHash: string; scheduleHash: string; projectFinish: string; standard: number }> = {
  PUBLIC_INVESTMENT: { templateHash: '4b9c3d921a37422e2d1e50b34474e8ccab968082d20d316306546c45aa6d5efa', scheduleHash: '2407a8d401ade118cb0875ec00022954f0d636187c035741ea368cbed8006d8b', projectFinish: '2028-10-06', standard: 503 },
  PUBLIC_PROCUREMENT: { templateHash: '5e19bfe027c21edb11be946d05794d1846ae70bef6f9181d3aa226044116b37d', scheduleHash: '08043ea9794434d4531255f0548c6d5cf6b32e9db6e283a879ea1fb4b4aa07cb', projectFinish: '2027-09-08', standard: 221 },
  PUBLIC_REPAIR: { templateHash: '32a6be881afd07f4ffd5db6ddccfb3ec5a154507261955294737695d619c5a6e', scheduleHash: 'b666469bef00a121eec38168ae31583aa4d9a833971915b45805f9915790f2e1', projectFinish: '2027-08-27', standard: 214 },
};

describe('a template written before the table of steps is what it always was', () => {
  it.each(Object.keys(GOLDEN))('%s keeps its params, its hash, its schedule and its standard time', (code) => {
    const params = builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, code)?.params;
    const template = parseProjectWorkflowTemplate(params);
    const golden = GOLDEN[code] as (typeof GOLDEN)[string];
    expect(templateParamsOf(template)).toEqual(params);
    expect(templateHash(template)).toBe(golden.templateHash);
    const result = scheduleProject({ tasks: tasksFromTemplate(template, {}), plannedStart: '2026-11-02', calendars: CALENDARS });
    expect(result.hash).toBe(golden.scheduleHash);
    expect(result.projectFinish).toBe(golden.projectFinish);
    expect(result.tasks.every((one) => !('durationUnit' in one) && !('effectiveWorkingDays' in one))).toBe(true);
    expect(standardTimes(template, {}).totalWorkingDays).toBe(golden.standard);
  });

  it('leaves every new field out of the params of a template that has none', () => {
    const params = templateParamsOf(parseProjectWorkflowTemplate(builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, 'PUBLIC_REPAIR')?.params)) as { tasks: Array<Record<string, unknown>> } & Record<string, unknown>;
    expect(Object.keys(params)).not.toEqual(expect.arrayContaining(['parties']));
    expect('overall_deadline_task' in params).toBe(false);
    for (const task of params.tasks) for (const field of ['duration', 'bands', 'responsible_units', 'extension']) expect(field in task).toBe(false);
  });
});

const UNIT = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const task = (code: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  code,
  name: `Bước ${code}`,
  phase: 'PREP',
  kind: 'TASK',
  duration_working_days: 4,
  required: true,
  responsible_role: 'PMB_PLANNER',
  priority: 'NORMAL',
  predecessors: [],
  ...extra,
});
const template = (tasks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'Sửa chữa đường', phases: [{ code: 'PREP', name: 'Chuẩn bị', gates: [] }], tasks, ...extra });

const FULL = template(
  [
    task('SURVEY', {
      duration: { value: 4, unit: 'WORKING_DAY', roll_to_working_day: false },
      bands: { green_days: 3, yellow_days: 2, red_days: 1 },
      responsible_units: [
        { unit_ref: 'PROJECT_OWNER', role: 'PMB_PLANNER', part: 'LEAD' },
        { unit_ref: 'PROJECT_PARTY:APPRAISER', role: 'APPRAISER_OFFICER', part: 'SUPPORT' },
        { unit_ref: `UNIT:${UNIT}`, role: 'FINANCE_OFFICER', part: 'SUPPORT' },
      ],
      extension: { allowed: true, max_times: 2, max_value: 10, unit: 'WORKING_DAY' },
      legal_basis: [{ document: 'ND_15_2021', article: 'Điều 5', verification: 'VERIFIED', verified_by: PERSON, verified_at: '2026-11-16T03:00:00.000Z' }],
    }),
    task('APPRAISE', { duration_working_days: 15, duration: { value: 20, unit: 'CALENDAR_DAY', roll_to_working_day: true }, predecessors: [{ task: 'SURVEY', kind: 'FS', lag_working_days: 0 }], bands: { yellow_days: 5, red_days: 2 } }),
    task('DECIDE', { duration_working_days: 22, duration: { value: 1, unit: 'MONTH', roll_to_working_day: true }, predecessors: [{ task: 'APPRAISE', kind: 'FS', lag_working_days: 0 }], extension: { allowed: false, unit: 'MONTH' } }),
  ],
  { parties: [{ code: 'APPRAISER', name: 'Đơn vị thẩm định' }], overall_deadline_task: 'DECIDE' },
);

describe('the fields of the table of steps', () => {
  it('reads them and writes them back unchanged', () => {
    expect(templateDefect(FULL)).toBeUndefined();
    const parsed = parseProjectWorkflowTemplate(FULL);
    expect(parsed.overallDeadlineTask).toBe('DECIDE');
    expect(parsed.tasks[1]?.duration).toEqual({ value: 20, unit: 'CALENDAR_DAY', rollToWorkingDay: true });
    expect(parsed.tasks[1]?.bands).toEqual({ green_days: null, yellow_days: 5, red_days: 2 });
    expect(parsed.tasks[0]?.extension).toEqual({ allowed: true, maxTimes: 2, maxValue: 10, unit: 'WORKING_DAY' });
    expect(parsed.tasks[0]?.responsibleUnits?.[0]).toEqual({ unitRef: 'PROJECT_OWNER', role: 'PMB_PLANNER', part: 'LEAD' });
    expect(parsed.tasks[0]?.legalBasis?.[0]).toMatchObject({ verification: 'VERIFIED', verifiedBy: PERSON, verifiedAt: '2026-11-16T03:00:00.000Z' });
    const written = templateParamsOf(parsed) as { tasks: Array<Record<string, unknown>> } & Record<string, unknown>;
    expect(written.parties).toEqual(FULL.parties);
    expect(written.overall_deadline_task).toBe('DECIDE');
    for (const [index, source] of (FULL.tasks as Array<Record<string, unknown>>).entries()) for (const field of ['duration', 'bands', 'responsible_units', 'extension']) expect(written.tasks[index]?.[field]).toEqual(source[field]);
    expect(templateHash(parseProjectWorkflowTemplate(written))).toBe(templateHash(parsed));
  });

  it.each([
    [3, 'WORKING_DAY', 3],
    [1, 'CALENDAR_DAY', 1],
    [7, 'CALENDAR_DAY', 5],
    [20, 'CALENDAR_DAY', 15],
    [1, 'MONTH', 22],
    [3, 'MONTH', 66],
  ] as const)('%i %s stands for %i nominal working days', (value, unit, nominal) => {
    expect(nominalWorkingDays({ value, unit })).toBe(nominal);
  });

  const defects: Array<[string, Record<string, unknown>, string]> = [
    ['working days that are not the nominal ones', template([task('A', { duration: { value: 20, unit: 'CALENDAR_DAY', roll_to_working_day: true } })]), 'tasks[0].duration_working_days'],
    ['a duration on a milestone', template([task('A', { kind: 'MILESTONE', duration_working_days: 0, duration: { value: 1, unit: 'WORKING_DAY', roll_to_working_day: false } })]), 'tasks[0].duration'],
    ['a ladder that is not strictly ordered', template([task('A', { bands: { green_days: 3, yellow_days: 3, red_days: 1 } })]), 'tasks[0].bands.green_days'],
    ['a yellow line at or under the red one', template([task('A', { bands: { yellow_days: 1, red_days: 1 } })]), 'tasks[0].bands.yellow_days'],
    ['no leading unit', template([task('A', { responsible_units: [{ unit_ref: 'PROJECT_OWNER', role: 'PMB_PLANNER', part: 'SUPPORT' }] })]), 'tasks[0].responsible_units'],
    ['two leading units', template([task('A', { responsible_units: [{ unit_ref: 'PROJECT_OWNER', role: 'PMB_PLANNER', part: 'LEAD' }, { unit_ref: 'PROJECT_PARTY:INVESTOR', role: 'PMB_PLANNER', part: 'LEAD' }] })]), 'tasks[0].responsible_units'],
    ['a lead whose role is not the role of the task', template([task('A', { responsible_units: [{ unit_ref: 'PROJECT_OWNER', role: 'SOMEONE_ELSE', part: 'LEAD' }] })]), 'tasks[0].responsible_units[0].role'],
    ['a unit that holds a role twice', template([task('A', { responsible_units: [{ unit_ref: 'PROJECT_OWNER', role: 'PMB_PLANNER', part: 'LEAD' }, { unit_ref: 'PROJECT_OWNER', role: 'PMB_PLANNER', part: 'SUPPORT' }] })]), 'tasks[0].responsible_units[1].unit_ref'],
    ['a party the template does not name', template([task('A', { responsible_units: [{ unit_ref: 'PROJECT_OWNER', role: 'PMB_PLANNER', part: 'LEAD' }, { unit_ref: 'PROJECT_PARTY:APPRAISER', role: 'X_ROLE', part: 'SUPPORT' }] })]), 'tasks[0].responsible_units[1].unit_ref'],
    ['a party that repeats a built-in one', template([task('A')], { parties: [{ code: 'INVESTOR', name: 'Chủ đầu tư' }] }), 'parties[0].code'],
    ['an extension in another unit than the limit', template([task('A', { extension: { allowed: true, unit: 'MONTH' } })]), 'tasks[0].extension.unit'],
    ['a cap on an extension that is not allowed', template([task('A', { extension: { allowed: false, max_times: 1, unit: 'WORKING_DAY' } })]), 'tasks[0].extension.max_times'],
    ['an extension on a milestone', template([task('A', { kind: 'MILESTONE', duration_working_days: 0, extension: { allowed: true, unit: 'WORKING_DAY' } })]), 'tasks[0].extension'],
    ['an overall deadline that is no task', template([task('A')], { overall_deadline_task: 'NOWHERE' }), 'overall_deadline_task'],
    ['half a stamp', template([task('A', { legal_basis: [{ document: 'ND_15_2021', verification: 'VERIFIED', verified_by: PERSON }] })]), 'tasks[0].legal_basis[0].verified_by'],
    ['a stamp on an unverified ground', template([task('A', { legal_basis: [{ document: 'ND_15_2021', verification: 'UNVERIFIED', verified_by: PERSON, verified_at: '2026-11-16T03:00:00Z' }] })]), 'tasks[0].legal_basis[0].verified_by'],
  ];
  it.each(defects)('refuses %s', (_name, params, field) => {
    expect(templateDefect(params)).toBe(field);
    expect(() => parseProjectWorkflowTemplate(params)).toThrow(DomainError);
  });

  it('accepts a verified ground without a stamp (a template written before stamps)', () => {
    expect(templateDefect(template([task('A', { legal_basis: [{ document: 'ND_15_2021', verification: 'VERIFIED' }] })]))).toBeUndefined();
  });
});

describe('workflowCodeFrom (R63)', () => {
  it.each([
    ['Khảo sát hiện trạng', 'KHAO_SAT_HIEN_TRANG'],
    ['Thẩm định, phê duyệt (đợt 2)', 'THAM_DINH_PHE_DUYET_DOT_2'],
    ['Đấu thầu', 'DAU_THAU'],
    ['2 bước đầu', 'C_2_BUOC_DAU'],
    ['a', 'CODE'],
    ['   ', 'CODE'],
  ])('%s becomes %s', (name, code) => {
    expect(workflowCodeFrom(name)).toBe(code);
  });

  it('cuts at 40 characters and never ends on an underscore', () => {
    const code = workflowCodeFrom('Lập hồ sơ và dự toán công trình sửa chữa đường giao thông địa phương');
    expect(code.length).toBeLessThanOrEqual(40);
    expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,39}$/);
    expect(code.endsWith('_')).toBe(false);
  });

  it('adds a number to a code that is taken, within 40 characters', () => {
    expect(workflowCodeFrom('Thẩm định', ['THAM_DINH'])).toBe('THAM_DINH_2');
    expect(workflowCodeFrom('Thẩm định', ['THAM_DINH', 'THAM_DINH_2'])).toBe('THAM_DINH_3');
    const long = 'A'.repeat(60);
    const second = workflowCodeFrom(long, [workflowCodeFrom(long)]);
    expect(second).toHaveLength(40);
    expect(second.endsWith('_2')).toBe(true);
  });

  it('always gives a valid code that is not taken, and the same one for the same input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }), (name, names) => {
        const taken = names.map((one) => workflowCodeFrom(one));
        const code = workflowCodeFrom(name, taken);
        expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,39}$/);
        expect(taken).not.toContain(code);
        expect(workflowCodeFrom(name, taken)).toBe(code);
      }),
    );
  });
});

describe('stampLegalVerification (R75)', () => {
  const NOW = '2026-11-16T08:30:00.000Z';
  const ground = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ document: 'ND_15_2021', article: 'Điều 5', verification: 'VERIFIED', ...extra });
  const draft = (grounds: Array<Record<string, unknown>>, code = 'A'): Record<string, unknown> => template([task(code, { legal_basis: grounds })]);
  const groundsOf = (params: Record<string, unknown>): Array<Record<string, unknown>> => ((params.tasks as Array<Record<string, unknown>>)[0]?.legal_basis ?? []) as Array<Record<string, unknown>>;

  it('stamps a ground the person marks as verified, with the person and the time of the server', () => {
    const result = stampLegalVerification(draft([ground()]), null, PERSON, NOW);
    expect(groundsOf(result.params)[0]).toEqual(ground({ verified_by: PERSON, verified_at: NOW }));
    expect(result).toMatchObject({ stamped: 1, reset: 0 });
    expect(templateDefect(result.params)).toBeUndefined();
  });

  it('never believes a stamp the client sends', () => {
    const forged = stampLegalVerification(draft([ground({ verified_by: OTHER, verified_at: '2020-01-01T00:00:00.000Z' })]), null, PERSON, NOW);
    expect(groundsOf(forged.params)[0]).toEqual(ground({ verification: 'UNVERIFIED' }));
    expect(forged).toMatchObject({ stamped: 0, reset: 1 });
  });

  it('keeps the stamp of the version before for the same ground at the same place', () => {
    const before = draft([ground({ verified_by: OTHER, verified_at: '2026-11-01T00:00:00.000Z' })]);
    expect(groundsOf(stampLegalVerification(before, before, PERSON, NOW).params)[0]).toEqual(groundsOf(before)[0]);
    // The screen may also send the ground without its stamp: the server puts back the one of the version before, not a new one.
    expect(groundsOf(stampLegalVerification(draft([ground()]), before, PERSON, NOW).params)[0]).toEqual(groundsOf(before)[0]);
  });

  it('keeps a ground verified before stamps existed as it is, so an untouched template keeps its hash', () => {
    const before = draft([ground()]);
    const result = stampLegalVerification(before, before, PERSON, NOW);
    expect(result.params).toEqual(before);
    expect(result).toMatchObject({ stamped: 0, reset: 0 });
  });

  it('resets an edited article, a line copied to another task and a template cloned under another code', () => {
    const stamp = { verified_by: OTHER, verified_at: '2026-11-01T00:00:00.000Z' };
    const before = draft([ground(stamp)]);
    const edited = stampLegalVerification(draft([ground({ ...stamp, article: 'Điều 6' })]), before, PERSON, NOW);
    expect(groundsOf(edited.params)[0]).toEqual({ document: 'ND_15_2021', article: 'Điều 6', verification: 'UNVERIFIED' });
    const copied = stampLegalVerification(draft([ground(stamp)], 'B'), before, PERSON, NOW);
    expect(groundsOf(copied.params)[0]?.verification).toBe('UNVERIFIED');
    const cloned = stampLegalVerification(before, null, PERSON, NOW);
    expect(groundsOf(cloned.params)[0]).toEqual(ground({ verification: 'UNVERIFIED' }));
  });

  it('takes the stamp off a ground that is no longer verified, and does the same on steps', () => {
    const stamp = { verified_by: OTHER, verified_at: '2026-11-01T00:00:00.000Z' };
    const unverified = stampLegalVerification(draft([ground({ ...stamp, verification: 'UNVERIFIED' })]), null, PERSON, NOW);
    expect(groundsOf(unverified.params)[0]).toEqual(ground({ verification: 'UNVERIFIED' }));
    const withStep = { ...template([task('A', { step: 'S1' })]), steps: [{ code: 'S1', name: 'Bước 1', phase: 'PREP', legal_basis: [ground()] }] };
    const stepped = stampLegalVerification(withStep, null, PERSON, NOW).params as { steps: Array<{ legal_basis: unknown[] }> };
    expect(stepped.steps[0]?.legal_basis[0]).toEqual(ground({ verified_by: PERSON, verified_at: NOW }));
  });
});

describe('resolveResponsibleUnits (R61)', () => {
  const parsed = parseProjectWorkflowTemplate(FULL);
  const OWNER = '44444444-4444-4444-8444-444444444444';
  const APPRAISER = '55555555-5555-4555-8555-555555555555';
  const project = { ownerUnitId: OWNER, investorUnitId: null, decisionAuthorityUnitId: null };

  it('answers the owner and a named unit by itself and asks for the slot of a party', () => {
    const result = resolveResponsibleUnits(parsed, {}, project);
    expect(result.refs).toEqual([
      { unit_ref: 'PROJECT_OWNER', unit_id: OWNER, source: 'PROJECT' },
      { unit_ref: 'PROJECT_PARTY:APPRAISER', unit_id: null, source: 'NONE' },
      { unit_ref: `UNIT:${UNIT}`, unit_id: UNIT, source: 'TEMPLATE' },
    ]);
    expect(result.unresolved).toEqual(['PROJECT_PARTY:APPRAISER']);
    expect(result.byTask.SURVEY?.map((one) => one.unit_ref)).toEqual(['PROJECT_OWNER', `UNIT:${UNIT}`]);
  });

  it('takes the unit the starter names for a slot, the leading unit first', () => {
    const result = resolveResponsibleUnits(parsed, {}, project, { 'PROJECT_PARTY:APPRAISER': APPRAISER });
    expect(result.unresolved).toEqual([]);
    expect(result.byTask.SURVEY).toEqual([
      { unit_ref: 'PROJECT_OWNER', unit_id: OWNER, role: 'PMB_PLANNER', part: 'LEAD' },
      { unit_ref: 'PROJECT_PARTY:APPRAISER', unit_id: APPRAISER, role: 'APPRAISER_OFFICER', part: 'SUPPORT' },
      { unit_ref: `UNIT:${UNIT}`, unit_id: UNIT, role: 'FINANCE_OFFICER', part: 'SUPPORT' },
    ]);
    expect(result.byTask.APPRAISE).toBeUndefined();
  });

  it('refuses to override what the project says and names a reference no task uses', () => {
    const result = resolveResponsibleUnits(parsed, {}, project, { PROJECT_OWNER: APPRAISER, 'PROJECT_PARTY:NOBODY': APPRAISER });
    expect(result.overridden).toEqual(['PROJECT_OWNER']);
    expect(result.unknown).toEqual(['PROJECT_PARTY:NOBODY']);
  });

  it('reads the investor from the project, and lets the starter name one the project has not recorded', () => {
    const investor = parseProjectWorkflowTemplate(template([task('A', { responsible_units: [{ unit_ref: 'PROJECT_PARTY:INVESTOR', role: 'PMB_PLANNER', part: 'LEAD' }] })]));
    expect(resolveResponsibleUnits(investor, {}, { ...project, investorUnitId: APPRAISER }).byTask.A?.[0]?.unit_id).toBe(APPRAISER);
    expect(resolveResponsibleUnits(investor, {}, project).unresolved).toEqual(['PROJECT_PARTY:INVESTOR']);
    expect(resolveResponsibleUnits(investor, {}, project, { 'PROJECT_PARTY:INVESTOR': UNIT }).refs[0]).toEqual({ unit_ref: 'PROJECT_PARTY:INVESTOR', unit_id: UNIT, source: 'CHOSEN' });
  });

  it('does not ask for the units of a branch the project does not have', () => {
    const branched = parseProjectWorkflowTemplate(
      template([task('A'), task('B', { when: [{ field: 'project_group', in: ['A'] }], responsible_units: [{ unit_ref: 'PROJECT_PARTY:INVESTOR', role: 'PMB_PLANNER', part: 'LEAD' }] })]),
    );
    expect(resolveResponsibleUnits(branched, { project_group: 'C' }, project).refs).toEqual([]);
    expect(resolveResponsibleUnits(branched, { project_group: 'A' }, project).unresolved).toEqual(['PROJECT_PARTY:INVESTOR']);
  });
});

describe('assessExtensions (R72)', () => {
  const rule = { allowed: true, maxTimes: 2, maxValue: 10, unit: 'WORKING_DAY' as const };
  const subject = (extra: Record<string, unknown> = {}) => ({ code: 'A', extension: rule, timesUsed: 0, valueUsed: 0, closed: false, ...extra });

  it('accepts an extension within both caps and says what the task will have used', () => {
    expect(assessExtensions([subject({ timesUsed: 1, valueUsed: 4 })], [{ taskCode: 'A', addValue: 6 }])).toEqual({ ok: true, refusals: [], totals: [{ task: 'A', times: 2, value: 10, unit: 'WORKING_DAY' }] });
  });

  it('counts what was used before: one time too many, one day too many', () => {
    expect(assessExtensions([subject({ timesUsed: 2, valueUsed: 2 })], [{ taskCode: 'A', addValue: 1 }]).refusals).toEqual([{ code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task: 'A', limit: 'TIMES', used: 2, asked: 1, max: 2 }]);
    expect(assessExtensions([subject({ timesUsed: 1, valueUsed: 8 })], [{ taskCode: 'A', addValue: 3 }]).refusals).toEqual([{ code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task: 'A', limit: 'VALUE', used: 8, asked: 3, max: 10 }]);
  });

  it('judges a proposal that bundles several tasks and several lines of one task as a whole', () => {
    const verdict = assessExtensions(
      [subject(), subject({ code: 'B', extension: { ...rule, maxTimes: null, maxValue: 5 } }), subject({ code: 'C' })],
      [{ taskCode: 'A', addValue: 4 }, { taskCode: 'A', addValue: 4 }, { taskCode: 'A', addValue: 1 }, { taskCode: 'B', addValue: 6 }, { taskCode: 'C', addValue: 10 }],
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals).toEqual([
      { code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task: 'A', limit: 'TIMES', used: 0, asked: 3, max: 2 },
      { code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task: 'B', limit: 'VALUE', used: 0, asked: 6, max: 5 },
    ]);
    expect(verdict.totals.find((one) => one.task === 'C')).toEqual({ task: 'C', times: 1, value: 10, unit: 'WORKING_DAY' });
  });

  it('has no cap where the template sets none', () => {
    expect(assessExtensions([subject({ extension: { allowed: true, maxTimes: null, maxValue: null, unit: 'MONTH' }, timesUsed: 9, valueUsed: 90 })], [{ taskCode: 'A', addValue: 12 }]).ok).toBe(true);
  });

  it('refuses a task that allows none, a task without the rule, a closed task and a task that is not there', () => {
    const codeOf = (subjects: Parameters<typeof assessExtensions>[0], code = 'A'): string | undefined => assessExtensions(subjects, [{ taskCode: code, addValue: 1 }]).refusals[0]?.code;
    expect(codeOf([subject({ extension: { allowed: false, maxTimes: null, maxValue: null, unit: 'WORKING_DAY' } })])).toBe('PWF_EXTENSION_NOT_ALLOWED');
    expect(codeOf([subject({ extension: null })])).toBe('PWF_EXTENSION_NOT_ALLOWED');
    expect(codeOf([subject({ closed: true })])).toBe('PWF_EXTENSION_TASK_CLOSED');
    expect(codeOf([subject()], 'Z')).toBe('PWF_EXTENSION_TASK_UNKNOWN');
  });
});
