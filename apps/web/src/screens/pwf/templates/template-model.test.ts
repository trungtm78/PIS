import { describe, expect, it } from 'vitest';
import { templateParams } from '../test/fixtures';
import {
  MAX_TASKS,
  addPhase,
  addPredecessor,
  addTask,
  blankTemplate,
  compareTemplates,
  groupByPhase,
  joinCodes,
  localProblems,
  paramsOfTemplate,
  readTemplate,
  removePhase,
  removeTask,
  renamePhase,
  renameTask,
  splitCodes,
  summaryOf,
  templateFigures,
  templateRoleName,
  updateTask,
  usedRoleCodes,
} from './template-model';

describe('template model: the figures of the outline (PWF-02)', () => {
  it('counts the phases and gates, the tasks and their days, the links by kind and lag, the branches, the documents, the checklist and the KPI codes', () => {
    const template = readTemplate(
      templateParams({
        phases: [
          { code: 'P1', name: 'Một', gates: ['submitProjectForAppraisal', 'closeProject'] },
          { code: 'P2', name: 'Hai', gates: [] },
        ],
        tasks: [
          { code: 'T1', name: 'A', phase: 'P1', kind: 'TASK', duration_working_days: 20, required: true, responsible_role: 'PM', approver_role: 'APPROVER', priority: 'NORMAL', predecessors: [], legal_doc_types: ['QD', 'TT'], form_templates: ['F1'], checklist: [{ code: 'C1', name: 'x', required: true, evidence_kinds: [] }], kpi_codes: ['K1'], when: [{ field: 'project_group', in: ['A'] }] },
          { code: 'T2', name: 'B', phase: 'P1', kind: 'TASK', duration_working_days: 5, required: false, responsible_role: 'PM', approver_role: null, priority: 'NORMAL', predecessors: [{ task: 'T1', kind: 'FS', lag_working_days: 2 }, { task: 'T1', kind: 'SS', lag_working_days: 0 }], legal_doc_types: ['QD'], form_templates: ['F1', 'F2'] },
          { code: 'T3', name: 'C', phase: 'P2', kind: 'MILESTONE', duration_working_days: 0, required: true, responsible_role: '', approver_role: null, priority: 'NORMAL', predecessors: [{ task: 'T2', kind: 'FF', lag_working_days: -1 }] },
        ],
      }),
    );
    expect(templateFigures(template)).toEqual({
      phases: 2,
      gates: 2,
      tasks: 3,
      workingDays: 25,
      required: 2,
      withResponsible: 2,
      withApprover: 1,
      links: { FS: 1, SS: 1, FF: 1, SF: 0 },
      lagged: 2,
      branched: 1,
      legalDocTypes: 2,
      forms: 2,
      checklistItems: 1,
      withKpi: 1,
    });
  });

  it('is all zeros for a blank template', () => {
    expect(templateFigures(blankTemplate())).toMatchObject({ phases: 0, gates: 0, tasks: 0, workingDays: 0, links: { FS: 0, SS: 0, FF: 0, SF: 0 }, checklistItems: 0 });
  });
});

describe('template model: reading a rule', () => {
  it('reads the params of a rule into a template with every optional part present', () => {
    const read = readTemplate({ name: 'A', project_type: null, phases: [{ code: 'P1', name: 'Giai đoạn', gates: ['closeProject'] }], tasks: [{ code: 'T1', name: 'Việc', phase: 'P1', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'R', approver_role: null, priority: 'LOW', predecessors: [] }] });
    expect(read.tasks[0]).toMatchObject({ legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [], constraint: null });
    expect(read.phases[0]?.gates).toEqual(['closeProject']);
  });

  it('survives params that are not a template at all', () => {
    expect(readTemplate({})).toEqual(blankTemplate());
    expect(readTemplate({ phases: 'x', tasks: [1, null], name: 4 })).toMatchObject({ name: '', phases: [], tasks: [] });
  });

  it('counts the phases and tasks of the params of a rule and names the template', () => {
    expect(summaryOf({ name: 'Mẫu', project_type: 'XD', phases: [{}, {}], tasks: [{}, {}, {}] })).toEqual({ name: 'Mẫu', projectType: 'XD', phases: 2, tasks: 3 });
    expect(summaryOf({})).toEqual({ name: '', projectType: null, phases: 0, tasks: 0 });
  });

  it('writes the params back the way the rule store keeps them (no empty constraint, no empty approver)', () => {
    const written = paramsOfTemplate(readTemplate(templateParams()));
    expect(written.project_type).toBe('CONSTRUCTION');
    const first = (written.tasks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect('constraint' in first).toBe(false);
    expect(first.approver_role).toBe('APPROVER');
    expect(((written.tasks as Record<string, unknown>[])[1] as Record<string, unknown>).approver_role).toBeNull();
    expect(paramsOfTemplate({ ...blankTemplate(), project_type: '' }).project_type).toBeNull();
  });
});

describe('template model: editing', () => {
  const base = readTemplate(templateParams());

  it('adds a phase up to the limit of twelve and removes one together with its tasks', () => {
    let draft = base;
    for (let i = 0; i < 20; i += 1) draft = addPhase(draft);
    expect(draft.phases).toHaveLength(12);
    const removed = removePhase(base, 0);
    expect(removed.phases).toHaveLength(0);
    expect(removed.tasks).toHaveLength(0);
  });

  it('adds a task to a phase, up to the limit of 400', () => {
    const added = addTask(base, 'PREPARATION');
    expect(added.tasks).toHaveLength(3);
    expect(added.tasks[2]).toMatchObject({ phase: 'PREPARATION', kind: 'TASK', required: true });
    let many = base;
    for (let i = 0; i < MAX_TASKS + 5; i += 1) many = addTask(many, 'PREPARATION');
    expect(many.tasks).toHaveLength(MAX_TASKS);
  });

  it('updates one task and leaves the others', () => {
    const next = updateTask(base, 0, { name: 'Đổi tên', duration_working_days: 7 });
    expect(next.tasks[0]).toMatchObject({ name: 'Đổi tên', duration_working_days: 7 });
    expect(next.tasks[1]).toBe(base.tasks[1]);
  });

  it('renames a task code in every link that points at it, and a phase code in every task of it', () => {
    const renamed = renameTask(base, 0, 'T1X');
    expect(renamed.tasks[0]?.code).toBe('T1X');
    expect(renamed.tasks[1]?.predecessors[0]?.task).toBe('T1X');
    const phase = renamePhase(base, 0, 'PREP');
    expect(phase.phases[0]?.code).toBe('PREP');
    expect(phase.tasks.every((task) => task.phase === 'PREP')).toBe(true);
  });

  it('removes a task and the links that pointed at it', () => {
    const removed = removeTask(base, 0);
    expect(removed.tasks).toHaveLength(1);
    expect(removed.tasks[0]?.predecessors).toEqual([]);
  });

  it('adds a predecessor up to twenty and never the same (task, kind) twice', () => {
    const once = addPredecessor(base, 1, { task: 'T1', kind: 'SS', lag_working_days: 0 });
    expect(once.tasks[1]?.predecessors).toHaveLength(2);
    const twice = addPredecessor(once, 1, { task: 'T1', kind: 'SS', lag_working_days: 2 });
    expect(twice.tasks[1]?.predecessors).toHaveLength(2);
    let draft = base;
    for (let i = 0; i < 30; i += 1) draft = addPredecessor(draft, 1, { task: `X${i}`, kind: 'FS', lag_working_days: 0 });
    expect(draft.tasks[1]?.predecessors).toHaveLength(20);
  });

  it('groups the tasks under their phase and keeps the tasks of an unknown phase apart', () => {
    const groups = groupByPhase({ ...base, tasks: [...base.tasks, { ...base.tasks[0]!, code: 'T9', phase: 'GONE' }] });
    expect(groups.map((group) => [group.phase?.code ?? null, group.tasks.map((item) => item.task.code)])).toEqual([
      ['PREPARATION', ['T1', 'T2']],
      [null, ['T9']],
    ]);
    expect(groups[0]?.tasks[1]?.index).toBe(1);
  });
});

describe('template model: codes', () => {
  it('splits a list of codes typed with commas, spaces or lines and joins it back', () => {
    expect(splitCodes('A_1, B_2\nC_3  ,, ')).toEqual(['A_1', 'B_2', 'C_3']);
    expect(splitCodes('')).toEqual([]);
    expect(joinCodes(['A', 'B'])).toBe('A, B');
  });
});

describe('template model: the checks made before anything is sent', () => {
  const base = readTemplate(templateParams());

  it('finds nothing wrong with a good template', () => {
    expect(localProblems(base)).toEqual([]);
  });

  it('asks for a name, a code in the right form and a unique code for phases and tasks', () => {
    const bad = {
      ...base,
      name: ' ',
      phases: [...base.phases, { code: 'preparation', name: '', gates: [] }, { code: 'PREPARATION', name: 'Lặp', gates: [] }],
      tasks: [...base.tasks, { ...base.tasks[0]!, code: 'T1' }],
    };
    const paths = localProblems(bad).map((problem) => `${problem.path}:${problem.problem}`);
    expect(paths).toEqual(expect.arrayContaining(['name:required', 'phases[1].code:pattern', 'phases[1].name:required', 'phases[2].code:duplicate', 'tasks[2].code:duplicate']));
  });

  it('checks the task: phase exists, duration, role, links and constraint', () => {
    const task = { ...base.tasks[1]!, phase: 'NOPE', duration_working_days: Number.NaN, responsible_role: '', predecessors: [{ task: 'T2', kind: 'FS' as const, lag_working_days: 400 }, { task: 'ZZ', kind: 'FS' as const, lag_working_days: 0 }, { task: 'T1', kind: 'FS' as const, lag_working_days: 0 }, { task: 'T1', kind: 'FS' as const, lag_working_days: 1 }], constraint: { kind: 'SNET' as const, offset_working_days: -1 } };
    const paths = localProblems({ ...base, tasks: [base.tasks[0]!, task] }).map((problem) => `${problem.path}:${problem.problem}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'tasks[1].phase:unknownRef',
        'tasks[1].duration_working_days:range',
        'tasks[1].responsible_role:required',
        'tasks[1].predecessors[0].task:selfLink',
        'tasks[1].predecessors[0].lag_working_days:range',
        'tasks[1].predecessors[1].task:unknownRef',
        'tasks[1].predecessors[3].kind:duplicate',
        'tasks[1].constraint.offset_working_days:range',
      ]),
    );
  });

  it('checks the checklist, the branches and the code lists', () => {
    const task = {
      ...base.tasks[0]!,
      checklist: [{ code: 'c', name: '', required: true, evidence_kinds: ['ok_1', 'bad kind'] }],
      when: [{ field: 'project_group' as const, in: [] }],
      legal_doc_types: ['x'],
      kpi_codes: ['KPI_1'],
    };
    const paths = localProblems({ ...base, tasks: [task, base.tasks[1]!] }).map((problem) => `${problem.path}:${problem.problem}`);
    expect(paths).toEqual(expect.arrayContaining(['tasks[0].checklist[0].code:pattern', 'tasks[0].checklist[0].name:required', 'tasks[0].checklist[0].evidence_kinds:pattern', 'tasks[0].when[0].in:required', 'tasks[0].legal_doc_types:pattern']));
  });

  it('A4: takes the code of a form the way the document store writes it (hyphens and dots), and refuses what is not such a code', () => {
    const withForms = (forms: string[]) => localProblems({ ...base, tasks: [{ ...base.tasks[0]!, form_templates: forms }, base.tasks[1]!] }).map((problem) => `${problem.path}:${problem.problem}`);
    expect(withForms(['DOC-QD-PHE-DUYET-DU-AN', 'PAY.C2-02A_NS', '01-BM'])).toEqual([]);
    expect(withForms(['doc-qd'])).toContain('tasks[0].form_templates:pattern');
    expect(withForms(['AB'])).toContain('tasks[0].form_templates:pattern');
    expect(splitCodes('DOC-QD-PHE-DUYET-DU-AN, PAY.C2-02A_NS')).toEqual(['DOC-QD-PHE-DUYET-DU-AN', 'PAY.C2-02A_NS']);
  });

  it('asks for at least one phase and one task', () => {
    expect(localProblems(blankTemplate()).map((problem) => problem.path)).toEqual(expect.arrayContaining(['name', 'phases', 'tasks']));
  });
});

describe('template model: comparing two versions', () => {
  const a = readTemplate(templateParams());

  it('lists the tasks and phases added, removed and changed, with the fields that changed', () => {
    const b = {
      ...a,
      phases: [{ ...a.phases[0]!, name: 'Tên khác' }, { code: 'EXEC', name: 'Thực hiện', gates: [] }],
      tasks: [{ ...a.tasks[0]!, duration_working_days: 25, name: 'Đổi' }, { code: 'T3', name: 'Mới', phase: 'EXEC', kind: 'TASK' as const, duration_working_days: 1, required: false, responsible_role: 'R', approver_role: null, priority: 'LOW' as const, predecessors: [], legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [], constraint: null }],
    };
    const changes = compareTemplates(a, b);
    expect(changes).toEqual(
      expect.arrayContaining([
        { scope: 'phase', code: 'PREPARATION', kind: 'changed', fields: ['name'] },
        { scope: 'phase', code: 'EXEC', kind: 'added', fields: [] },
        { scope: 'task', code: 'T1', kind: 'changed', fields: ['name', 'duration_working_days'] },
        { scope: 'task', code: 'T2', kind: 'removed', fields: [] },
        { scope: 'task', code: 'T3', kind: 'added', fields: [] },
      ]),
    );
    expect(changes).toHaveLength(5);
  });

  it('reports a change of the name or the project type of the template and nothing for equal templates', () => {
    expect(compareTemplates(a, a)).toEqual([]);
    expect(compareTemplates(a, { ...a, name: 'Khác', project_type: null })).toEqual([{ scope: 'template', code: '', kind: 'changed', fields: ['name', 'project_type'] }]);
  });

  it('reports a phase removed', () => {
    expect(compareTemplates(a, { ...a, phases: [] }).filter((change) => change.scope === 'phase')).toEqual([{ scope: 'phase', code: 'PREPARATION', kind: 'removed', fields: [] }]);
  });
});

describe('template model: the names of the roles a tenant made up itself', () => {
  const base = { name: 'A', project_type: null, phases: [{ code: 'P1', name: 'Giai đoạn', gates: [] }], tasks: [] };

  it('reads the roles a template names and writes them back, leaving them out of a template that names none', () => {
    const read = readTemplate({ ...base, roles: [{ code: 'PROVINCE_CLERK', name: 'Văn thư của tỉnh' }] });
    expect(read.roles).toEqual([{ code: 'PROVINCE_CLERK', name: 'Văn thư của tỉnh' }]);
    expect(paramsOfTemplate({ ...read, roles: [{ code: 'PROVINCE_CLERK', name: '  Văn thư của tỉnh ' }] }).roles).toEqual([{ code: 'PROVINCE_CLERK', name: 'Văn thư của tỉnh' }]);
    expect('roles' in paramsOfTemplate(readTemplate(base))).toBe(false);
    expect('roles' in paramsOfTemplate({ ...read, roles: [] })).toBe(false);
  });

  it('finds a role without a code or a name, a code that is not a code and a role named twice', () => {
    const problems = (roles: Array<{ code: string; name: string }>) => localProblems({ ...readTemplate(base), roles }).filter((one) => one.path.startsWith('roles')).map((one) => [one.path, one.problem]);
    expect(problems([{ code: 'LEAD', name: 'Trưởng nhóm' }])).toEqual([]);
    expect(problems([{ code: '', name: '' }])).toEqual([['roles[0].code', 'required'], ['roles[0].name', 'required']]);
    expect(problems([{ code: 'lead', name: 'Trưởng nhóm' }])).toEqual([['roles[0].code', 'pattern']]);
    expect(problems([{ code: 'LEAD', name: 'Một' }, { code: 'LEAD', name: 'Hai' }])).toEqual([['roles[1].code', 'duplicate']]);
  });

  it('lists every role code the steps and tasks use, and answers the name the template gives a code', () => {
    const template = readTemplate(templateParams());
    const used = usedRoleCodes({ ...template, steps: [{ code: 'S1', name: 'Bước', phase: template.phases[0]?.code ?? '', responsible_role: 'STEP_LEAD' }] });
    expect(used).toContain('STEP_LEAD');
    expect(used).toContain(template.tasks[0]?.responsible_role);
    expect(new Set(used).size).toBe(used.length);
    expect(templateRoleName({ ...template, roles: [{ code: 'STEP_LEAD', name: 'Trưởng bước' }] }, 'STEP_LEAD')).toBe('Trưởng bước');
    expect(templateRoleName(template, 'STEP_LEAD')).toBeUndefined();
  });
});
