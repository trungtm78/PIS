import { describe, expect, it } from 'vitest';
import builtIn from './test/builtin-templates.json';
import {
  addNamedPhase,
  addParty,
  addRole,
  addRow,
  addSupport,
  advancedNotes,
  anchorOf,
  anchorTargets,
  basisState,
  dossierCount,
  dropUnusedParties,
  duplicateLine,
  editBasis,
  extensionChoice,
  leadOf,
  limitOf,
  lineOfProblem,
  linesOf,
  markBasis,
  moveLine,
  movePhase,
  nameLine,
  removeLine,
  removePhaseRows,
  rowCount,
  setAnchor,
  setBand,
  setExtension,
  setLeadUnit,
  setLimit,
  setRole,
  settleCodes,
  splitStep,
  tableOf,
  toggleOverall,
  unverifiedRows,
  updateSupport,
  usesSteps,
} from './table-model';
import type { Added } from './table-model';
import { blankTemplate, isPending, localProblems, nominalWorkingDays, originOf, paramsOfTemplate, readTemplate } from './template-model';
import type { EditorTask, LegalBasisInput, Template } from './template-model';

type Params = Record<string, unknown>;
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected a value');
  return value;
};
const lineAt = (template: Template, key: string) => must(linesOf(template).find((line) => line.key === key));
const taskOf = (template: Template, key: string): EditorTask => must(template.tasks[must(lineAt(template, key).taskIndex ?? undefined)]);

/** A named row added to a phase, its code settled: what a person does with "+ Thêm bước" and a name. */
function row(template: Template, phase: string, name: string): Added {
  const added = must(addRow(template, phase));
  let named = settleCodes(nameLine(added.template, lineAt(added.template, added.key), name));
  const key = must(linesOf(named).find((line) => line.name === name && !line.child)).key;
  // The first row of a template has nobody to copy the role from: the person picks one.
  const at = must(lineAt(named, key).taskIndex ?? undefined);
  if (must(named.tasks[at]).responsible_role === '') named = setRole(named, at, 'PMB_PLANNER');
  return { template: named, key };
}

const started = (): Template => addNamedPhase({ ...blankTemplate(), name: 'Sửa chữa đường' }, 'Chuẩn bị');

describe('the rows of the table (R64)', () => {
  it('a new template is written with steps: a row is a step with exactly one task, and the cells edit that task', () => {
    const base = started();
    expect(usesSteps(base)).toBe(true);
    const { template, key } = row(base, 'CHUAN_BI', 'Khảo sát hiện trạng');
    expect(key).toBe('step:KHAO_SAT_HIEN_TRANG');
    expect(template.steps).toEqual([{ code: 'KHAO_SAT_HIEN_TRANG', name: 'Khảo sát hiện trạng', phase: 'CHUAN_BI' }]);
    expect(template.tasks).toHaveLength(1);
    expect(template.tasks[0]).toMatchObject({ code: 'KHAO_SAT_HIEN_TRANG', name: 'Khảo sát hiện trạng', step: 'KHAO_SAT_HIEN_TRANG', phase: 'CHUAN_BI', predecessors: [] });
    const line = lineAt(template, key);
    expect(line).toMatchObject({ kind: 'step', number: '1', child: false, taskIndex: 0, taskIndexes: [0] });
    expect(localProblems(template)).toEqual([]);
  });

  it('a step with several tasks is a read-only row with its tasks under it, numbered 2.1, 2.2', () => {
    const template = readTemplate((builtIn as Record<string, Params>).PUBLIC_REPAIR);
    const groups = tableOf(template);
    const first = must(groups[0]).lines;
    const multi = must(first.find((line) => line.kind === 'step' && line.taskIndexes.length > 1));
    expect(multi.taskIndex).toBeNull();
    const children = first.filter((line) => line.child && line.stepIndex === multi.stepIndex);
    expect(children.map((line) => line.number)).toEqual(multi.taskIndexes.map((_, at) => `${multi.number}.${at + 1}`));
    expect(children.every((line) => line.kind === 'task' && line.taskIndex !== null)).toBe(true);
    const single = must(linesOf(template).find((line) => line.kind === 'step' && line.taskIndexes.length === 1));
    expect(single.taskIndex).toBe(single.taskIndexes[0]);
    expect(rowCount(template)).toBe((template.steps ?? []).length);
  });

  it('a template without steps shows each task as a row under its phase and is saved in its old shape', () => {
    const params: Params = {
      name: 'Hai tầng',
      project_type: null,
      phases: [{ code: 'P1', name: 'Một', gates: [] }, { code: 'P2', name: 'Hai', gates: [] }],
      tasks: [
        { code: 'T1', name: 'A', phase: 'P1', kind: 'TASK', duration_working_days: 2, required: true, responsible_role: 'PM', priority: 'NORMAL', predecessors: [] },
        { code: 'T2', name: 'B', phase: 'P2', kind: 'TASK', duration_working_days: 2, required: true, responsible_role: 'PM', priority: 'NORMAL', predecessors: [{ task: 'T1', kind: 'FS', lag_working_days: 0 }] },
      ],
    };
    const template = readTemplate(params);
    expect(usesSteps(template)).toBe(false);
    expect(tableOf(template).map((group) => group.lines.map((line) => `${line.number}:${line.key}`))).toEqual([['1:task:T1'], ['2:task:T2']]);
    const added = row(template, 'P1', 'Việc mới');
    expect(added.key).toBe('task:VIEC_MOI');
    const written = paramsOfTemplate(added.template) as unknown as { steps?: unknown; tasks: Params[] };
    expect('steps' in written).toBe(false);
    expect(written.tasks.map((task) => task.code)).toEqual(['T1', 'VIEC_MOI', 'T2']);
    expect(written.tasks.every((task) => !('step' in task))).toBe(true);
    expect(written.tasks[0]).toEqual((params.tasks as Params[])[0]);
  });

  it('shows a task that names no step of its phase, and the tasks of a phase that is not there', () => {
    const template = readTemplate({
      name: 'Lạc',
      project_type: null,
      phases: [{ code: 'P1', name: 'Một', gates: [] }],
      steps: [{ code: 'S1', name: 'Bước', phase: 'P1' }],
      tasks: [
        { code: 'T1', name: 'A', phase: 'P1', kind: 'TASK', duration_working_days: 1, required: true, responsible_role: 'PM', priority: 'NORMAL', predecessors: [], step: 'S1' },
        { code: 'T2', name: 'B', phase: 'P1', kind: 'TASK', duration_working_days: 1, required: true, responsible_role: 'PM', priority: 'NORMAL', predecessors: [], step: 'GONE' },
        { code: 'T3', name: 'C', phase: 'NOWHERE', kind: 'TASK', duration_working_days: 1, required: true, responsible_role: 'PM', priority: 'NORMAL', predecessors: [] },
      ],
    });
    const groups = tableOf(template);
    expect(groups.map((group) => group.lines.map((line) => line.key))).toEqual([['step:S1', 'task:T2'], ['task:T3']]);
    expect(must(groups[1]).phase).toBeNull();
  });
});

describe('adding a row copies the row above', () => {
  it('copies the unit and the role, the limit with its unit, the three colours and the extension; never the name, the papers, the grounds; and starts when the row above is done', () => {
    const made = row(started(), 'CHUAN_BI', 'Khảo sát');
    const key = made.key;
    let template = made.template;
    const at = must(lineAt(template, key).taskIndex ?? undefined);
    template = setRole(template, at, 'SITE_ENGINEER');
    template = setLeadUnit(template, at, 'PROJECT_OWNER');
    template = addSupport(template, at, 'PROJECT_PARTY:INVESTOR', 'PMB_PLANNER');
    template = setLimit(template, at, { value: 20, unit: 'CALENDAR_DAY', roll_to_working_day: false });
    template = setBand(setBand(setBand(template, at, 'red_days', 2), at, 'yellow_days', 5), at, 'green_days', 10);
    template = setExtension(template, at, 'allowed', { max_times: 1, max_value: 10 });
    template = { ...template, tasks: template.tasks.map((task) => ({ ...task, checklist: [{ code: 'C1', name: 'Biên bản', required: true, evidence_kinds: [] }], legal_basis: [{ document: 'LAW_58_2024_QH15', verification: 'VERIFIED' as const }] })) };
    const added = must(addRow(template, 'CHUAN_BI'));
    const next = taskOf(added.template, added.key);
    expect(next).toMatchObject({
      name: '',
      responsible_role: 'SITE_ENGINEER',
      duration_working_days: nominalWorkingDays(20, 'CALENDAR_DAY'),
      duration: { value: 20, unit: 'CALENDAR_DAY', roll_to_working_day: false },
      bands: { red_days: 2, yellow_days: 5, green_days: 10 },
      extension: { allowed: true, max_times: 1, max_value: 10, unit: 'CALENDAR_DAY' },
      responsible_units: [
        { unit_ref: 'PROJECT_OWNER', role: 'SITE_ENGINEER', part: 'LEAD' },
        { unit_ref: 'PROJECT_PARTY:INVESTOR', role: 'PMB_PLANNER', part: 'SUPPORT' },
      ],
      checklist: [],
      predecessors: [{ task: 'KHAO_SAT', kind: 'FS', lag_working_days: 0 }],
    });
    expect(next.legal_basis).toBeUndefined();
    expect(anchorOf(added.template, must(lineAt(added.template, added.key).taskIndex ?? undefined))).toEqual({ kind: 'after', key });
    // The copy is its own: changing the new row leaves the row above.
    const changed = setBand(added.template, must(lineAt(added.template, added.key).taskIndex ?? undefined), 'red_days', 9);
    expect(taskOf(changed, key).bands).toEqual({ red_days: 2, yellow_days: 5, green_days: 10 });
  });

  it('the first row of a template starts with the project, and a row of a later phase copies the last row before it', () => {
    const first = row(started(), 'CHUAN_BI', 'Một');
    expect(anchorOf(first.template, 0)).toEqual({ kind: 'start' });
    const twoPhases = settleCodes({ ...addNamedPhase(first.template), phases: addNamedPhase(first.template, 'Thực hiện').phases });
    const second = must(addRow(setLimit(twoPhases, 0, { value: 7 }), 'THUC_HIEN'));
    expect(taskOf(second.template, second.key).duration_working_days).toBe(7);
    expect(taskOf(second.template, second.key).predecessors).toEqual([{ task: 'MOT', kind: 'FS', lag_working_days: 0 }]);
    expect(taskOf(second.template, second.key).phase).toBe('THUC_HIEN');
  });

  it('refuses a row for a phase that is not there', () => {
    expect(addRow(started(), 'NOWHERE')).toBeUndefined();
  });
});

describe('codes are made once from the name (R63)', () => {
  it('a new row has a provisional code until it is named; naming it makes the code, in the links and the mark of the overall deadline too', () => {
    const one = row(started(), 'CHUAN_BI', 'Khảo sát');
    const added = must(addRow(one.template, 'CHUAN_BI'));
    const fresh = taskOf(added.template, added.key);
    expect(isPending(fresh)).toBe(true);
    expect(fresh.code).toBe('NEW_1');
    // A third row waits for the unnamed second one, and the second is the overall deadline.
    const third = must(addRow(toggleOverall(added.template, 'NEW_1'), 'CHUAN_BI'));
    expect(taskOf(third.template, third.key).predecessors).toEqual([{ task: 'NEW_1', kind: 'FS', lag_working_days: 0 }]);
    // Typing does not make a code; leaving the field does.
    const typing = nameLine(third.template, lineAt(third.template, added.key), 'Thẩm định');
    expect(taskOf(typing, added.key).code).toBe('NEW_1');
    const done = settleCodes(typing);
    const named = must(done.tasks.find((task) => task.name === 'Thẩm định'));
    expect(named.code).toBe('THAM_DINH');
    expect(isPending(named)).toBe(false);
    expect(done.steps?.map((step) => step.code)).toEqual(['KHAO_SAT', 'THAM_DINH', 'NEW_2']);
    expect(done.overall_deadline_task).toBe('THAM_DINH');
    expect(must(done.tasks.find((task) => isPending(task))).predecessors).toEqual([{ task: 'THAM_DINH', kind: 'FS', lag_working_days: 0 }]);
  });

  it('renaming a row never changes its code, and a code that exists is kept as it is', () => {
    const one = row(started(), 'CHUAN_BI', 'Khảo sát');
    const renamed = settleCodes(nameLine(one.template, lineAt(one.template, one.key), 'Khảo sát và đo đạc hiện trạng'));
    expect(renamed.steps?.[0]).toMatchObject({ code: 'KHAO_SAT', name: 'Khảo sát và đo đạc hiện trạng' });
    expect(renamed.tasks[0]).toMatchObject({ code: 'KHAO_SAT', name: 'Khảo sát và đo đạc hiện trạng' });
    const stored = readTemplate((builtIn as Record<string, Params>).PUBLIC_REPAIR);
    const line = must(linesOf(stored).find((one2) => one2.kind === 'step'));
    const again = settleCodes(nameLine(stored, line, 'Tên khác hẳn'));
    expect(again.steps?.map((step) => step.code)).toEqual(stored.steps?.map((step) => step.code));
    expect(again.tasks.map((task) => task.code)).toEqual(stored.tasks.map((task) => task.code));
  });

  it('two rows of the same name get different codes, and a phase is coded from its name too', () => {
    const one = row(started(), 'CHUAN_BI', 'Thẩm định');
    const two = row(one.template, 'CHUAN_BI', 'Thẩm định');
    expect(two.template.tasks.map((task) => task.code)).toEqual(['THAM_DINH', 'THAM_DINH_2']);
    expect(two.template.steps?.map((step) => step.code)).toEqual(['THAM_DINH', 'THAM_DINH_2']);
    const phased = addNamedPhase(two.template);
    expect(isPending(must(phased.phases[1]))).toBe(true);
    const named = settleCodes({ ...phased, phases: phased.phases.map((phase, at) => (at === 1 ? { ...phase, name: 'Thực hiện' } : phase)) });
    expect(named.phases.map((phase) => phase.code)).toEqual(['CHUAN_BI', 'THUC_HIEN']);
  });

  it('a task named apart from its step keeps its own name when the step is renamed', () => {
    const template = readTemplate({
      name: 'X',
      project_type: null,
      phases: [{ code: 'P1', name: 'Một', gates: [] }],
      steps: [{ code: 'S1', name: 'Bước thẩm định', phase: 'P1' }],
      tasks: [{ code: 'T1', name: 'Lập báo cáo thẩm định', phase: 'P1', kind: 'TASK', duration_working_days: 1, required: true, responsible_role: 'PM', priority: 'NORMAL', predecessors: [], step: 'S1' }],
    });
    const renamed = nameLine(template, lineAt(template, 'step:S1'), 'Thẩm định');
    expect(renamed.steps?.[0]?.name).toBe('Thẩm định');
    expect(renamed.tasks[0]?.name).toBe('Lập báo cáo thẩm định');
  });
});

describe('reordering, copying and removing rows', () => {
  const three = (): Template => row(row(row(started(), 'CHUAN_BI', 'Một').template, 'CHUAN_BI', 'Hai').template, 'CHUAN_BI', 'Ba').template;

  it('moves a step among the steps of its phase; the links say when it starts, not where it stands', () => {
    const template = three();
    const up = moveLine(template, 'step:BA', -1);
    expect(up.steps?.map((step) => step.code)).toEqual(['MOT', 'BA', 'HAI']);
    expect(linesOf(up).map((line) => `${line.number}:${line.code}`)).toEqual(['1:MOT', '2:BA', '3:HAI']);
    expect(must(up.tasks.find((task) => task.code === 'BA')).predecessors).toEqual([{ task: 'HAI', kind: 'FS', lag_working_days: 0 }]);
    expect(moveLine(up, 'step:MOT', -1)).toBe(up);
    expect(moveLine(up, 'step:HAI', 1).steps?.map((step) => step.code)).toEqual(['MOT', 'BA', 'HAI']);
  });

  it('at the edge of a phase a step goes to the neighbouring phase with its tasks', () => {
    const two = settleCodes(addNamedPhase(three(), 'Thực hiện'));
    const down = moveLine(two, 'step:BA', 1);
    expect(must(down.steps?.find((step) => step.code === 'BA')).phase).toBe('THUC_HIEN');
    expect(must(down.tasks.find((task) => task.code === 'BA')).phase).toBe('THUC_HIEN');
    expect(tableOf(down).map((group) => group.lines.map((line) => line.code))).toEqual([['MOT', 'HAI'], ['BA']]);
    const back = moveLine(down, 'step:BA', -1);
    expect(tableOf(back).map((group) => group.lines.map((line) => line.code))).toEqual([['MOT', 'HAI', 'BA'], []]);
    expect(localProblems(back)).toEqual([]);
  });

  it('moves a task among the tasks of its step, and a phase among the phases', () => {
    const split = must(splitStep(three(), 0));
    const named = settleCodes(nameLine(split.template, lineAt(split.template, split.key), 'Việc thứ hai'));
    const lines = linesOf(named).filter((line) => line.child);
    expect(lines.map((line) => line.code)).toEqual(['MOT', 'VIEC_THU_HAI']);
    const moved = moveLine(named, 'task:VIEC_THU_HAI', -1);
    expect(linesOf(moved).filter((line) => line.child).map((line) => line.code)).toEqual(['VIEC_THU_HAI', 'MOT']);
    const phases = settleCodes(addNamedPhase(named, 'Thực hiện'));
    expect(movePhase(phases, 1, -1).phases.map((phase) => phase.code)).toEqual(['THUC_HIEN', 'CHUAN_BI']);
    expect(movePhase(phases, 1, 1)).toBe(phases);
  });

  it('splitting a step gives it a second task that copies the first and waits for it', () => {
    const base = setLimit(three(), 0, { value: 6 });
    const split = must(splitStep(base, 0));
    const second = taskOf(split.template, split.key);
    expect(second).toMatchObject({ step: 'MOT', duration_working_days: 6, predecessors: [{ task: 'MOT', kind: 'FS', lag_working_days: 0 }] });
    expect(lineAt(split.template, 'step:MOT').taskIndex).toBeNull();
    expect(lineAt(split.template, 'step:MOT').taskIndexes).toHaveLength(2);
  });

  it('removes a step with its tasks, the links that pointed at them and the mark of the overall deadline', () => {
    const template = toggleOverall(three(), 'HAI');
    const left = removeLine(template, 'step:HAI');
    expect(left.steps?.map((step) => step.code)).toEqual(['MOT', 'BA']);
    expect(left.tasks.map((task) => task.code)).toEqual(['MOT', 'BA']);
    expect(must(left.tasks.find((task) => task.code === 'BA')).predecessors).toEqual([]);
    expect('overall_deadline_task' in left).toBe(false);
    const none = removeLine(removeLine(left, 'step:MOT'), 'step:BA');
    expect(none.tasks).toEqual([]);
    expect(none.steps ?? []).toEqual([]);
    expect(removeLine(none, 'step:GONE')).toBe(none);
  });

  it('removes a phase with its rows and the mark on one of them', () => {
    const two = row(settleCodes(addNamedPhase(three(), 'Thực hiện')), 'THUC_HIEN', 'Thi công').template;
    const marked = toggleOverall(two, 'THI_CONG');
    const left = removePhaseRows(marked, 1);
    expect(left.phases.map((phase) => phase.code)).toEqual(['CHUAN_BI']);
    expect(left.tasks.map((task) => task.code)).toEqual(['MOT', 'HAI', 'BA']);
    expect('overall_deadline_task' in left).toBe(false);
    expect(removePhaseRows(toggleOverall(two, 'MOT'), 1).overall_deadline_task).toBe('MOT');
  });

  it('a copy is a new row under the original: new codes from its name, its grounds unverified without a stamp, the links inside the copy following the copy', () => {
    const stamped: LegalBasisInput = { document: 'LAW_58_2024_QH15', article: 'Điều 5', verification: 'VERIFIED', verified_by: '00000000-0000-4000-8000-000000000001', verified_at: '2026-11-16T03:00:00.000Z' };
    const base = three();
    const withBasis: Template = { ...base, steps: base.steps?.map((step) => (step.code === 'HAI' ? { ...step, legal_basis: [stamped] } : step)), tasks: base.tasks.map((task) => (task.code === 'HAI' ? { ...task, legal_basis: [stamped], checklist: [{ code: 'C1', name: 'Biên bản', required: true, evidence_kinds: [] }] } : task)) };
    const copied = must(duplicateLine(withBasis, 'step:HAI', (name) => `${name} (bản sao)`));
    expect(copied.key).toBe('step:HAI_BAN_SAO');
    expect(copied.template.steps?.map((step) => step.code)).toEqual(['MOT', 'HAI', 'HAI_BAN_SAO', 'BA']);
    const copy = taskOf(copied.template, copied.key);
    expect(copy).toMatchObject({ code: 'HAI_BAN_SAO', name: 'Hai (bản sao)', step: 'HAI_BAN_SAO', checklist: [{ code: 'C1' }], predecessors: [{ task: 'MOT', kind: 'FS', lag_working_days: 0 }] });
    expect(copy.legal_basis).toEqual([{ document: 'LAW_58_2024_QH15', article: 'Điều 5', verification: 'UNVERIFIED' }]);
    expect(must(copied.template.steps?.find((step) => step.code === 'HAI_BAN_SAO')).legal_basis).toEqual([{ document: 'LAW_58_2024_QH15', article: 'Điều 5', verification: 'UNVERIFIED' }]);
    // The original keeps its stamp.
    expect(taskOf(copied.template, 'step:HAI').legal_basis).toEqual([stamped]);
    expect(localProblems(copied.template)).toEqual([]);
  });

  it('a copy of a stored row is not tied to the rule the original was read from', () => {
    const stored = readTemplate((builtIn as Record<string, Params>).PUBLIC_REPAIR);
    const line = must(linesOf(stored).find((one) => one.kind === 'step' && one.taskIndexes.length > 1));
    const copied = must(duplicateLine(stored, line.key, (name) => `${name} 2`));
    const copies = linesOf(copied.template).filter((one) => one.stepIndex === lineAt(copied.template, copied.key).stepIndex && one.child);
    expect(copies).toHaveLength(line.taskIndexes.length);
    for (const one of copies) expect(originOf(must(copied.template.tasks[must(one.taskIndex ?? undefined)]))).toBeUndefined();
    expect(new Set(copied.template.tasks.map((task) => task.code)).size).toBe(copied.template.tasks.length);
  });
});

describe('the anchor: when a row starts (R57)', () => {
  it('reads "with the project", "when row N is done" and anything else as advanced', () => {
    const template = readTemplate((builtIn as Record<string, Params>).PUBLIC_INVESTMENT);
    const kinds = template.tasks.map((_, index) => anchorOf(template, index).kind);
    expect(kinds).toContain('start');
    expect(kinds).toContain('advanced');
    const lagged = template.tasks.findIndex((task) => task.predecessors.some((link) => link.kind !== 'FS' || link.lag_working_days !== 0));
    expect(anchorOf(template, lagged)).toEqual({ kind: 'advanced' });
    expect(advancedNotes(template, lagged).filter((note) => note.kind === 'link').length).toBe(must(template.tasks[lagged]).predecessors.length);
  });

  it('"when a step with several tasks is done" waits for every task of it, and is read back as that step', () => {
    const template = readTemplate((builtIn as Record<string, Params>).PUBLIC_REPAIR);
    const multi = must(linesOf(template).find((line) => line.kind === 'step' && line.taskIndexes.length > 1));
    const other = must(linesOf(template).find((line) => line.kind === 'step' && line.taskIndex !== null && line.key !== multi.key));
    const at = must(other.taskIndex ?? undefined);
    const set = setAnchor(template, at, multi.key);
    expect(must(set.tasks[at]).predecessors).toEqual(multi.taskIndexes.map((index) => ({ task: must(template.tasks[index]).code, kind: 'FS', lag_working_days: 0 })));
    expect(anchorOf(set, at)).toEqual({ kind: 'after', key: multi.key });
    expect(anchorOf(setAnchor(set, at, 'start'), at)).toEqual({ kind: 'start' });
    expect(anchorTargets(template, at).some((line) => line.key === other.key)).toBe(false);
  });

  it('an untouched anchor leaves the links of an old template exactly as stored', () => {
    const params = (builtIn as Record<string, Params>).PUBLIC_INVESTMENT;
    const template = readTemplate(params);
    const plain = template.tasks.findIndex((task) => anchorOf(template, template.tasks.indexOf(task)).kind === 'after');
    const same = setAnchor(template, plain, must(anchorOf(template, plain) as { key?: string }).key ?? 'start');
    expect(paramsOfTemplate(same)).toEqual(params);
  });
});

describe('the limit, the three colours and the extension', () => {
  const one = (): { template: Template; at: number } => {
    const made = row(started(), 'CHUAN_BI', 'Thẩm định');
    return { template: made.template, at: 0 };
  };

  it('in working days the limit is the old field alone; in days and months the old field is the nominal value', () => {
    const { template, at } = one();
    const working = setLimit(template, at, { value: 4 });
    expect(must(working.tasks[at])).toMatchObject({ duration_working_days: 4 });
    expect('duration' in must(working.tasks[at])).toBe(false);
    const days = setLimit(working, at, { unit: 'CALENDAR_DAY', value: 20 });
    expect(must(days.tasks[at])).toMatchObject({ duration_working_days: 15, duration: { value: 20, unit: 'CALENDAR_DAY', roll_to_working_day: true } });
    const month = setLimit(days, at, { unit: 'MONTH', value: 1, roll_to_working_day: false });
    expect(must(month.tasks[at])).toMatchObject({ duration_working_days: 22, duration: { value: 1, unit: 'MONTH', roll_to_working_day: false } });
    expect(limitOf(must(month.tasks[at]))).toEqual({ value: 1, unit: 'MONTH', roll_to_working_day: false });
    expect(nominalWorkingDays(1, 'CALENDAR_DAY')).toBe(1);
    expect(nominalWorkingDays(7, 'CALENDAR_DAY')).toBe(5);
    expect(localProblems(month)).toEqual([]);
    const back = setLimit(month, at, { unit: 'WORKING_DAY', value: 3 });
    expect('duration' in must(back.tasks[at])).toBe(false);
  });

  it('the unit of the extension follows the unit of the limit; a refusal carries no cap', () => {
    const { template, at } = one();
    const allowed = setExtension(template, at, 'allowed', { max_times: 2, max_value: 10 });
    expect(must(allowed.tasks[at]).extension).toEqual({ allowed: true, max_times: 2, max_value: 10, unit: 'WORKING_DAY' });
    const month = setLimit(allowed, at, { unit: 'MONTH', value: 2 });
    expect(must(month.tasks[at]).extension?.unit).toBe('MONTH');
    expect(localProblems(month)).toEqual([]);
    const denied = setExtension(month, at, 'denied');
    expect(must(denied.tasks[at]).extension).toEqual({ allowed: false, unit: 'MONTH' });
    expect(extensionChoice(must(denied.tasks[at]))).toBe('denied');
    const unset = setExtension(denied, at, 'unset');
    expect('extension' in must(unset.tasks[at])).toBe(false);
    expect(extensionChoice(must(unset.tasks[at]))).toBe('unset');
    expect(must(setExtension(allowed, at, 'allowed', { max_times: undefined }).tasks[at]).extension).toEqual({ allowed: true, max_value: 10, unit: 'WORKING_DAY' });
  });

  it('a ladder with no line left is no ladder; a ladder half typed and a ladder out of order are told at the cell', () => {
    const { template, at } = one();
    const red = setBand(template, at, 'red_days', 2);
    expect(localProblems(red)).toEqual([{ path: 'tasks[0].bands.yellow_days', problem: 'required' }]);
    const wrong = setBand(red, at, 'yellow_days', 1);
    expect(localProblems(wrong)).toEqual([{ path: 'tasks[0].bands', problem: 'bandOrder' }]);
    const right = setBand(setBand(wrong, at, 'yellow_days', 5), at, 'green_days', 10);
    expect(localProblems(right)).toEqual([]);
    expect(localProblems(setBand(right, at, 'green_days', 5))).toEqual([{ path: 'tasks[0].bands', problem: 'bandOrder' }]);
    const cleared = setBand(setBand(setBand(right, at, 'green_days', undefined), at, 'yellow_days', undefined), at, 'red_days', undefined);
    expect('bands' in must(cleared.tasks[at])).toBe(false);
  });

  it('tells a limit and a nominal value that do not agree, a limit on a milestone and an extension in another unit', () => {
    const { template, at } = one();
    const drift: Template = { ...template, tasks: template.tasks.map((task) => ({ ...task, duration: { value: 20, unit: 'CALENDAR_DAY' as const, roll_to_working_day: true }, duration_working_days: 20, extension: { allowed: false, max_times: 1, unit: 'WORKING_DAY' as const } })) };
    expect(localProblems(drift).map((problem) => `${problem.path}:${problem.problem}`)).toEqual(['tasks[0].duration_working_days:nominal', 'tasks[0].extension.unit:extensionUnit', 'tasks[0].extension:capsNotAllowed']);
    const milestone: Template = { ...template, tasks: template.tasks.map((task) => ({ ...task, kind: 'MILESTONE' as const, duration_working_days: 0, duration: { value: 1, unit: 'MONTH' as const, roll_to_working_day: true } })) };
    expect(localProblems(milestone).map((problem) => problem.problem)).toEqual(['milestoneLimit']);
    expect(toggleOverall(toggleOverall(template, 'THAM_DINH'), 'THAM_DINH')).toEqual(template);
    expect(localProblems({ ...template, overall_deadline_task: 'GONE' })).toEqual([{ path: 'overall_deadline_task', problem: 'unknownRef' }]);
    void at;
  });
});

describe('who receives the step (R61)', () => {
  it('the role of the lead unit is the role that answers for the task: one truth, set together', () => {
    const made = row(started(), 'CHUAN_BI', 'Thẩm định');
    let template = setRole(made.template, 0, 'DPI_APPRAISER');
    expect('responsible_units' in must(template.tasks[0])).toBe(false);
    template = setLeadUnit(template, 0, 'PROJECT_PARTY:INVESTOR');
    expect(leadOf(must(template.tasks[0]))).toEqual({ unit_ref: 'PROJECT_PARTY:INVESTOR', role: 'DPI_APPRAISER', part: 'LEAD' });
    template = setRole(template, 0, 'PMB_PLANNER');
    expect(must(template.tasks[0])).toMatchObject({ responsible_role: 'PMB_PLANNER', responsible_units: [{ unit_ref: 'PROJECT_PARTY:INVESTOR', role: 'PMB_PLANNER', part: 'LEAD' }] });
    template = addSupport(template, 0, 'PROJECT_OWNER', 'SITE_ENGINEER');
    template = updateSupport(template, 0, 0, { role: 'SUPERVISOR' });
    expect(must(template.tasks[0]).responsible_units).toEqual([
      { unit_ref: 'PROJECT_PARTY:INVESTOR', role: 'PMB_PLANNER', part: 'LEAD' },
      { unit_ref: 'PROJECT_OWNER', role: 'SUPERVISOR', part: 'SUPPORT' },
    ]);
    expect(localProblems(template)).toEqual([]);
    // Taking the lead unit away with a supporting unit left is told; taking both away leaves the task as a template written before the table.
    const noLead = setLeadUnit(template, 0, '');
    expect(localProblems(noLead)).toEqual([{ path: 'tasks[0].responsible_units', problem: 'oneLead' }]);
    const none = updateSupport(noLead, 0, 0, null);
    expect('responsible_units' in must(none.tasks[0])).toBe(false);
  });

  it('a party the template names gets its code from its name and must be declared; a role too', () => {
    const made = row(started(), 'CHUAN_BI', 'Thẩm định');
    const withRole = addRole(made.template, 'Chuyên viên thẩm định giá');
    expect(withRole.code).toBe('CHUYEN_VIEN_THAM_DINH_GIA');
    const party = addParty(setRole(withRole.template, 0, withRole.code), 'Sở Tài chính');
    expect(party.code).toBe('SO_TAI_CHINH');
    const used = setLeadUnit(party.template, 0, `PROJECT_PARTY:${party.code}`);
    expect(localProblems(used)).toEqual([]);
    expect(paramsOfTemplate(used)).toMatchObject({ parties: [{ code: 'SO_TAI_CHINH', name: 'Sở Tài chính' }], roles: [{ code: 'CHUYEN_VIEN_THAM_DINH_GIA', name: 'Chuyên viên thẩm định giá' }] });
    const undeclared: Template = { ...used, parties: [] };
    expect(localProblems(undeclared)).toEqual([{ path: 'tasks[0].responsible_units[0].unit_ref', problem: 'unknownRef' }]);
    const unused = dropUnusedParties(setLeadUnit(used, 0, 'PROJECT_OWNER'));
    expect('parties' in unused).toBe(false);
    expect(dropUnusedParties(used)).toBe(used);
    const wrongRole: Template = { ...used, tasks: used.tasks.map((task) => ({ ...task, responsible_role: 'OTHER' })) };
    expect(localProblems(wrongRole)).toEqual([{ path: 'tasks[0].responsible_units', problem: 'leadRole' }]);
  });
});

describe('legal grounds: the stamp is the server\'s (R75)', () => {
  const stamped: LegalBasisInput = { document: 'LAW_58_2024_QH15', article: 'Điều 5', verification: 'VERIFIED', verified_by: '00000000-0000-4000-8000-000000000001', verified_at: '2026-11-16T03:00:00.000Z' };

  it('editing the document, the article or the note of a line makes it unverified and drops its stamp; an edit that changes nothing keeps it', () => {
    expect(basisState(stamped)).toBe('stamped');
    expect(editBasis([stamped], 0, { article: 'Điều 5' })).toEqual([stamped]);
    for (const change of [{ article: 'Điều 6' }, { document: 'DECREE_85_2025_ND_CP' }, { note: 'ghi chú' }]) {
      const [edited] = editBasis([stamped], 0, change);
      expect(edited?.verification).toBe('UNVERIFIED');
      expect('verified_by' in must(edited)).toBe(false);
      expect('verified_at' in must(edited)).toBe(false);
    }
  });

  it('"Đã đối chiếu" marks the line verified WITHOUT a stamp (the server stamps it when the draft is saved), and never invents one', () => {
    const [marked] = markBasis([{ document: 'LAW_58_2024_QH15', verification: 'UNVERIFIED' }], 0, true);
    expect(marked).toEqual({ document: 'LAW_58_2024_QH15', verification: 'VERIFIED' });
    expect(basisState(must(marked))).toBe('claimed');
    expect(markBasis([stamped], 0, true)).toEqual([stamped]);
    expect(markBasis([stamped], 0, false)).toEqual([{ document: 'LAW_58_2024_QH15', article: 'Điều 5', verification: 'UNVERIFIED' }]);
    const template = readTemplate({ name: 'X', project_type: null, phases: [{ code: 'P1', name: 'Một', gates: [] }], tasks: [{ code: 'T1', name: 'A', phase: 'P1', kind: 'TASK', duration_working_days: 1, required: true, responsible_role: 'PM', priority: 'NORMAL', predecessors: [], legal_basis: [stamped] }] });
    // An untouched stamped line is written as stored; a line marked by the person goes out with no stamp field at all.
    expect((paramsOfTemplate(template).tasks[0] as { legal_basis: unknown[] }).legal_basis).toEqual([stamped]);
    const claimed: Template = { ...template, tasks: template.tasks.map((task) => ({ ...task, legal_basis: markBasis(editBasis(task.legal_basis ?? [], 0, { article: 'Điều 7' }), 0, true) })) };
    expect((paramsOfTemplate(claimed).tasks[0] as { legal_basis: unknown[] }).legal_basis).toEqual([{ document: 'LAW_58_2024_QH15', article: 'Điều 7', verification: 'VERIFIED' }]);
  });

  it('counts the rows that cite a ground nobody checked, a task under a step with its step', () => {
    const template = readTemplate((builtIn as Record<string, Params>).PUBLIC_REPAIR);
    const steps = (template.steps ?? []).filter((step) => (step.legal_basis ?? []).some((one) => one.verification !== 'VERIFIED')).length;
    expect(unverifiedRows(template)).toBeGreaterThanOrEqual(steps);
    expect(unverifiedRows(template)).toBeLessThanOrEqual(rowCount(template));
    const verified: Template = { ...template, steps: template.steps?.map((step) => ({ ...step, legal_basis: (step.legal_basis ?? []).map((one) => ({ ...one, verification: 'VERIFIED' as const })) })), tasks: template.tasks.map((task) => ({ ...task, legal_basis: (task.legal_basis ?? []).map((one) => ({ ...one, verification: 'VERIFIED' as const })) })) };
    expect(unverifiedRows(verified)).toBe(0);
  });
});

describe('what a row holds besides its cells', () => {
  it('counts the papers of a row and says every advanced field in a note', () => {
    const template = readTemplate((builtIn as Record<string, Params>).PUBLIC_INVESTMENT);
    const line = must(linesOf(template).find((one) => one.kind === 'step' && one.taskIndexes.length > 1));
    const expected = line.taskIndexes.reduce((sum, index) => sum + must(template.tasks[index]).legal_doc_types.length + must(template.tasks[index]).form_templates.length + must(template.tasks[index]).checklist.length, 0);
    expect(dossierCount(template, line)).toBe(expected);
    const kinds = new Set(template.tasks.flatMap((_, index) => advancedNotes(template, index).map((note) => note.kind)));
    for (const kind of ['link', 'conditions', 'approver', 'milestone', 'priority']) expect(kinds.has(kind as never), kind).toBe(true);
    const odd: Template = { ...template, tasks: template.tasks.map((task, at) => (at === 0 ? { ...task, required: false, constraint: { kind: 'SNET' as const, offset_working_days: 3 }, kpi_codes: ['PWF_X'], form_templates: ['F_01'], form_policies: [{ form: 'F_01', policy: 'PINNED' as const, revision: 2 }] } : task)) };
    expect(advancedNotes(odd, 0).map((note) => note.kind)).toEqual(expect.arrayContaining(['constraint', 'pinnedForms', 'kpi', 'optional']));
    expect(advancedNotes(template, 9999)).toEqual([]);
  });

  it('finds the row a problem belongs to', () => {
    const template = readTemplate((builtIn as Record<string, Params>).PUBLIC_REPAIR);
    const child = must(linesOf(template).find((line) => line.child));
    expect(lineOfProblem(template, `tasks[${child.taskIndex}].name`)?.key).toBe(child.key);
    expect(lineOfProblem(template, 'steps[0].name')?.key).toBe(`step:${template.steps?.[0]?.code}`);
    expect(lineOfProblem(template, 'name')).toBeUndefined();
  });
});
