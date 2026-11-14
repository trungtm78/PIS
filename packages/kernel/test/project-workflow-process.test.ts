import { builtInCodes, builtInDefault, defaultGovernanceRule, registerProjectWorkflowModuleRules, validateRuleParams } from '../src/governance-rules.ts';
import { LEGAL_BASIS_ALERT_CODE, LEGAL_DOCUMENT_RULE_TYPE, isLapsed, legalDocumentOf, legalDocumentState } from '../src/legal-document.ts';
import {
  WORKFLOW_ASSIGNMENT_CODE,
  WORKFLOW_ASSIGNMENT_RULE_TYPE,
  parseWorkflowAssignment,
  selectionModeOf,
  suggestWorkflowTemplate,
} from '../src/project-workflow-assignment.ts';
import { PUBLIC_INVESTMENT_TEMPLATE, PUBLIC_PROCUREMENT_TEMPLATE, PUBLIC_REPAIR_TEMPLATE } from '../src/project-workflow-defaults.ts';
import {
  PROJECT_WORKFLOW_RULE_TYPE,
  checkTemplateReferences,
  citedLegalDocuments,
  formPolicyOf,
  parseProjectWorkflowTemplate,
  stepCodeOf,
  stepSpans,
  stepsOf,
  templateDefect,
  templateHash,
  templateParamsOf,
} from '../src/project-workflow.ts';
import { scheduleProject, standardTimes, tasksFromTemplate } from '../src/project-schedule.ts';
import type { PinnedCalendar } from '../src/project-schedule.ts';

type Params = Record<string, unknown>;

const task = (code: string, extra: Params = {}): Params => ({
  code,
  name: `Task ${code}`,
  phase: 'P1',
  kind: 'TASK',
  duration_working_days: 2,
  required: true,
  responsible_role: 'PLANNER',
  priority: 'NORMAL',
  predecessors: [],
  legal_doc_types: [],
  form_templates: [],
  checklist: [],
  kpi_codes: [],
  when: [],
  ...extra,
});
const after = (code: string): Params => ({ task: code, kind: 'FS', lag_working_days: 0 });
const PHASES: Params[] = [
  { code: 'P1', name: 'Phase one', gates: [] },
  { code: 'P2', name: 'Phase two', gates: [] },
];
const cite = (document: string, article?: string): Params => ({ document, ...(article === undefined ? {} : { article }), verification: 'UNVERIFIED' });

/** Two phases, three steps: P1 has S1 (A, B) and S2 (C); P2 has S3 (D). */
const stepped = (over: Params = {}): Params => ({
  name: 'Stepped',
  phases: PHASES,
  steps: [
    { code: 'S1', name: 'Step one', phase: 'P1', responsible_role: 'LEAD', legal_basis: [cite('LAW_58_2024_QH15')] },
    { code: 'S2', name: 'Step two', phase: 'P1' },
    { code: 'S3', name: 'Step three', phase: 'P2' },
  ],
  tasks: [
    task('TA', { step: 'S1', legal_basis: [cite('DECREE_85_2025_ND_CP', 'Article 22')] }),
    task('TB', { step: 'S1', predecessors: [after('TA')], form_templates: ['FORM_ONE', 'FORM_TWO'], form_policies: [{ form: 'FORM_ONE', policy: 'PINNED', revision: 3 }] }),
    task('TC', { step: 'S2', predecessors: [after('TB')] }),
    task('TD', { phase: 'P2', step: 'S3', predecessors: [after('TC')], when: [{ field: 'project_group', in: ['A'] }] }),
  ],
  ...over,
});
const legacy = (): Params => ({ name: 'Legacy', phases: PHASES, tasks: [task('A'), task('B', { phase: 'P2', predecessors: [after('A')] })] });

const calendar = (year: number): PinnedCalendar => ({ year, version: 1, content: { calendar_code: 'VN-STD', year, working_days: [1, 2, 3, 4, 5], holidays: [], compensated_workdays: [], legal_basis_ref: 'test calendar' } as never });

beforeAll(() => registerProjectWorkflowModuleRules());

describe('phase -> step -> task (R44)', () => {
  it('reads the steps a template names, in the order of the phases, with the position of each in its phase', () => {
    const template = parseProjectWorkflowTemplate(stepped());
    expect(stepsOf(template).map((step) => `${step.phase}/${step.code}#${step.order}`)).toEqual(['P1/S1#1', 'P1/S2#2', 'P2/S3#1']);
    expect(stepsOf(template)[0]).toMatchObject({ responsibleRole: 'LEAD', implicit: false, legalBasis: [{ document: 'LAW_58_2024_QH15', article: null, verification: 'UNVERIFIED' }] });
    expect(template.tasks.map((one) => stepCodeOf(template, one))).toEqual(['S1', 'S1', 'S2', 'S3']);
  });

  it('gives a template written before steps one step per phase, and leaves its params and its hash as they were', () => {
    const template = parseProjectWorkflowTemplate(legacy());
    expect(stepsOf(template)).toEqual([
      { code: 'P1', name: 'Phase one', phase: 'P1', order: 1, responsibleRole: null, legalBasis: [], implicit: true },
      { code: 'P2', name: 'Phase two', phase: 'P2', order: 1, responsibleRole: null, legalBasis: [], implicit: true },
    ]);
    expect(template.tasks.map((one) => stepCodeOf(template, one))).toEqual(['P1', 'P2']);
    const params = templateParamsOf(template);
    expect(Object.keys(params)).toEqual(['name', 'phases', 'tasks']);
    for (const one of params.tasks as Params[]) expect(Object.keys(one)).toEqual(expect.not.arrayContaining(['step', 'legal_basis', 'form_policies']));
  });

  it('keeps the hash of the three templates as they were before steps (a running project froze those hashes)', () => {
    // The hashes of the shipped templates on the commit before PWF-4: a project that froze one must find the same value when its frozen copy is read back.
    const before: Record<string, string> = {
      INVESTMENT: templateHash(parseProjectWorkflowTemplate(JSON.parse(JSON.stringify(PUBLIC_INVESTMENT_TEMPLATE)))),
      PROCUREMENT: templateHash(parseProjectWorkflowTemplate(JSON.parse(JSON.stringify(PUBLIC_PROCUREMENT_TEMPLATE)))),
      REPAIR: templateHash(parseProjectWorkflowTemplate(JSON.parse(JSON.stringify(PUBLIC_REPAIR_TEMPLATE)))),
    };
    expect(before).toEqual({
      INVESTMENT: LEGACY_HASHES.INVESTMENT,
      PROCUREMENT: LEGACY_HASHES.PROCUREMENT,
      REPAIR: LEGACY_HASHES.REPAIR,
    });
  });

  it('round-trips a template with steps, legal grounds and form policies, and the hash follows what was added', () => {
    const template = parseProjectWorkflowTemplate(stepped());
    const again = parseProjectWorkflowTemplate(templateParamsOf(template));
    expect(again).toEqual(template);
    expect(templateHash(again)).toBe(templateHash(template));
    expect(templateHash(parseProjectWorkflowTemplate(stepped({ name: 'Stepped' })))).toBe(templateHash(template));
    const other = stepped();
    ((other.steps as Params[])[0] as Params).legal_basis = [cite('LAW_22_2023_QH15')];
    expect(templateHash(parseProjectWorkflowTemplate(other))).not.toBe(templateHash(template));
  });

  it('refuses a step twice, a step in an unknown phase, a step with no task, and a task outside the steps of its phase', () => {
    const steps = (list: Params[]): Params => stepped({ steps: list });
    expect(templateDefect(steps([{ code: 'S1', name: 'x', phase: 'P1' }, { code: 'S1', name: 'y', phase: 'P1' }, { code: 'S2', name: 'z', phase: 'P1' }, { code: 'S3', name: 'w', phase: 'P2' }]))).toBe('steps[1].code');
    expect(templateDefect(steps([{ code: 'S1', name: 'x', phase: 'P9' }]))).toBe('steps[0].phase');
    expect(templateDefect(stepped({ steps: [...(stepped().steps as Params[]), { code: 'S4', name: 'Idle', phase: 'P2' }] }))).toBe('steps[3].code');
    const wrongPhase = stepped();
    ((wrongPhase.tasks as Params[])[2] as Params).step = 'S3';
    expect(templateDefect(wrongPhase)).toBe('tasks[2].step');
    const noStep = stepped();
    delete ((noStep.tasks as Params[])[0] as Params).step;
    expect(templateDefect(noStep)).toBe('tasks[0].step');
    const stepWithoutSteps = legacy();
    ((stepWithoutSteps.tasks as Params[])[0] as Params).step = 'S1';
    expect(templateDefect(stepWithoutSteps)).toBe('tasks[0].step');
  });


  it('A4: a form of a task is named by the code the document store gives it (document_template.template_code: capitals, digits, dot, underscore and hyphen, 3 to 80 characters), and nothing else', () => {
    const withForms = (forms: unknown[], policies?: unknown[]): Params => {
      const made = stepped();
      const second = (made.tasks as Params[])[1] as Params;
      second.form_templates = forms;
      if (policies === undefined) delete second.form_policies;
      else second.form_policies = policies;
      return made;
    };
    const stored = withForms(['DOC-QD-PHE-DUYET-DU-AN', 'PAY.C2-02A_NS', '01-BM'], [{ form: 'DOC-QD-PHE-DUYET-DU-AN', policy: 'PINNED', revision: 2 }]);
    expect(() => validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, stored)).not.toThrow();
    const parsed = parseProjectWorkflowTemplate(stored);
    expect(parsed.tasks[1]?.formTemplates).toEqual(['DOC-QD-PHE-DUYET-DU-AN', 'PAY.C2-02A_NS', '01-BM']);
    expect(formPolicyOf(parsed.tasks[1] ?? {}, 'DOC-QD-PHE-DUYET-DU-AN')).toEqual({ form: 'DOC-QD-PHE-DUYET-DU-AN', policy: 'PINNED', revision: 2 });
    expect((templateParamsOf(parsed).tasks as Params[])[1]?.form_templates).toEqual(['DOC-QD-PHE-DUYET-DU-AN', 'PAY.C2-02A_NS', '01-BM']);
    for (const bad of ['doc-qd', 'AB', '-DOC', 'DOC QD', 'DOC/QD', `D${'X'.repeat(80)}`]) expect(() => validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, withForms([bad]))).toThrow();
    expect(() => validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, withForms(['DOC-QD'], [{ form: 'doc-qd', policy: 'LATEST_APPROVED' }]))).toThrow();
  });
  it('refuses the same document and article cited twice, and a form policy that names no form of the task or pins no revision', () => {
    const twice = stepped();
    ((twice.steps as Params[])[0] as Params).legal_basis = [cite('LAW_58_2024_QH15'), cite('LAW_58_2024_QH15')];
    expect(templateDefect(twice)).toBe('steps[0].legal_basis[1].document');
    const articles = stepped();
    ((articles.steps as Params[])[0] as Params).legal_basis = [cite('LAW_58_2024_QH15', 'Article 1'), cite('LAW_58_2024_QH15', 'Article 2')];
    expect(templateDefect(articles)).toBeUndefined();
    const policy = (value: Params[]): Params => {
      const made = stepped();
      ((made.tasks as Params[])[1] as Params).form_policies = value;
      return made;
    };
    expect(templateDefect(policy([{ form: 'FORM_NINE', policy: 'LATEST_APPROVED' }]))).toBe('tasks[1].form_policies[0].form');
    expect(templateDefect(policy([{ form: 'FORM_ONE', policy: 'PINNED' }]))).toBe('tasks[1].form_policies[0].revision');
    expect(templateDefect(policy([{ form: 'FORM_ONE', policy: 'LATEST_APPROVED', revision: 2 }]))).toBe('tasks[1].form_policies[0].revision');
    expect(templateDefect(policy([{ form: 'FORM_ONE', policy: 'PINNED', revision: 1 }, { form: 'FORM_ONE', policy: 'LATEST_APPROVED' }]))).toBe('tasks[1].form_policies[1].form');
  });

  it('is what the governance store runs: the registry accepts the stepped template and refuses a field it does not know', () => {
    expect(() => validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, stepped())).not.toThrow();
    const unknown = stepped();
    ((unknown.steps as Params[])[0] as Params).duration_working_days = 5;
    expect(() => validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, unknown)).toThrow();
  });

  it('gives a form the newest approved revision unless the template pins one', () => {
    const template = parseProjectWorkflowTemplate(stepped());
    const b = template.tasks[1] as (typeof template.tasks)[number];
    expect(formPolicyOf(b, 'FORM_ONE')).toEqual({ form: 'FORM_ONE', policy: 'PINNED', revision: 3 });
    expect(formPolicyOf(b, 'FORM_TWO')).toEqual({ form: 'FORM_TWO', policy: 'LATEST_APPROVED', revision: null });
  });

  it('lists every document cited once, and reports a document the catalogue does not have and a pinned revision that does not exist', () => {
    const template = parseProjectWorkflowTemplate(stepped());
    expect(citedLegalDocuments(template)).toEqual(['LAW_58_2024_QH15', 'DECREE_85_2025_ND_CP']);
    const found = checkTemplateReferences(template, { legalDocument: (code) => code === 'LAW_58_2024_QH15', formRevision: () => false, role: (code) => code !== 'LEAD' });
    expect(found.map((one) => `${one.field}:${one.code}`)).toEqual(['steps[0].responsible_role:ROLE_UNKNOWN', 'tasks[0].legal_basis[0].document:LEGAL_DOCUMENT_UNKNOWN', 'tasks[1].form_policies[0].revision:FORM_REVISION_UNKNOWN']);
    expect(checkTemplateReferences(template, {})).toEqual([]);
  });

  it('reads the standard time of a step from the schedule of its tasks, and counts no task left out of the project', () => {
    const template = parseProjectWorkflowTemplate(stepped());
    const run = (facts: Record<string, string>) => {
      const result = scheduleProject({ tasks: tasksFromTemplate(template, facts), plannedStart: '2026-01-05', calendars: [calendar(2026)] });
      return stepSpans(template, result.tasks.map((one) => ({ code: one.code, start: one.start, finish: one.finish, startSlot: one.startSlot, endSlot: one.endSlot, passThrough: one.state === 'PASS_THROUGH' })));
    };
    // A and B follow each other (2 + 2 working days), C takes two more; D is in the project only for group A.
    expect(run({ project_group: 'A' })).toEqual([
      { step: 'S1', phase: 'P1', start: '2026-01-05', finish: '2026-01-08', durationWorkingDays: 4, taskCount: 2 },
      { step: 'S2', phase: 'P1', start: '2026-01-09', finish: '2026-01-12', durationWorkingDays: 2, taskCount: 1 },
      { step: 'S3', phase: 'P2', start: '2026-01-13', finish: '2026-01-14', durationWorkingDays: 2, taskCount: 1 },
    ]);
    expect(run({ project_group: 'C' })[2]).toEqual({ step: 'S3', phase: 'P2', start: null, finish: null, durationWorkingDays: 0, taskCount: 0 });
  });

  it('gives the standard time of a template and of its steps on plain working weeks, whatever the calendar of a year', () => {
    const template = parseProjectWorkflowTemplate(stepped());
    expect(standardTimes(template, { project_group: 'A' })).toEqual({
      totalWorkingDays: 8,
      steps: [
        { step: 'S1', phase: 'P1', durationWorkingDays: 4, taskCount: 2 },
        { step: 'S2', phase: 'P1', durationWorkingDays: 2, taskCount: 1 },
        { step: 'S3', phase: 'P2', durationWorkingDays: 2, taskCount: 1 },
      ],
    });
    expect(standardTimes(template, {}).totalWorkingDays).toBe(6);
    const shipped = parseProjectWorkflowTemplate(builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, 'PUBLIC_INVESTMENT')?.params);
    const times = standardTimes(shipped, { project_group: 'C', funding_source: 'BUDGET' });
    expect(times.steps).toHaveLength(13);
    expect(times.totalWorkingDays).toBeGreaterThan(300);
    expect(times.steps.every((step) => step.taskCount > 0)).toBe(true);
  });

  it('ships the three templates in three tiers: every task in a step of its phase, every step with a legal ground of the catalogue, all of them unverified', () => {
    const documents = new Set(builtInCodes(LEGAL_DOCUMENT_RULE_TYPE));
    for (const code of ['PUBLIC_INVESTMENT', 'PUBLIC_PROCUREMENT', 'PUBLIC_REPAIR']) {
      const template = parseProjectWorkflowTemplate(builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, code)?.params);
      const steps = stepsOf(template);
      expect(steps.length).toBeGreaterThan(template.phases.length);
      expect(steps.every((step) => !step.implicit && step.legalBasis.length > 0 && step.responsibleRole !== null)).toBe(true);
      for (const one of template.tasks) expect(steps.find((step) => step.code === stepCodeOf(template, one))?.phase).toBe(one.phase);
      expect(checkTemplateReferences(template, { legalDocument: (document) => documents.has(document) })).toEqual([]);
      const basis = [...steps.flatMap((step) => step.legalBasis), ...template.tasks.flatMap((one) => one.legalBasis ?? [])];
      expect(basis.every((one) => one.verification === 'UNVERIFIED')).toBe(true);
    }
    expect(builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, 'PUBLIC_INVESTMENT')?.unverified).toBe(true);
  });

  it('adds only optional items to the checklists of the shipped templates: what a task needed before is what it needs now', () => {
    const pairs: Array<[string, Params]> = [['PUBLIC_INVESTMENT', PUBLIC_INVESTMENT_TEMPLATE], ['PUBLIC_PROCUREMENT', PUBLIC_PROCUREMENT_TEMPLATE], ['PUBLIC_REPAIR', PUBLIC_REPAIR_TEMPLATE]];
    for (const [code, base] of pairs) {
      const before = parseProjectWorkflowTemplate(JSON.parse(JSON.stringify(base)));
      const now = parseProjectWorkflowTemplate(builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, code)?.params);
      expect(now.tasks.map((one) => one.code)).toEqual(before.tasks.map((one) => one.code));
      for (const [index, one] of now.tasks.entries()) {
        const was = before.tasks[index] as (typeof before.tasks)[number];
        expect(one.checklist.filter((item) => item.required)).toEqual(was.checklist);
        expect({ ...one, checklist: [], step: null, legalBasis: [] }).toEqual({ ...was, checklist: [], step: null, legalBasis: [] });
      }
    }
  });
});

// Taken on main before PWF-4 with `templateHash(parseProjectWorkflowTemplate(<built-in default>))`.
const LEGACY_HASHES = {
  INVESTMENT: '624b45bc834ff2e0920fc0185aa79d2eb870418845fd1d0755fc23173a2e6acf',
  PROCUREMENT: '2ef647e476503586565474bd16e195ccc74164615b2765f875387bef574c91e0',
  REPAIR: 'f7d5768a7b7751c773ce10c25a30af67579c66e3dbbc109e93c3eedb55576d68',
};

describe('LEGAL_DOCUMENT: the shared catalogue of legal documents (R45)', () => {
  it('registers the documents the shipped templates cite, every one unverified', () => {
    const codes = builtInCodes(LEGAL_DOCUMENT_RULE_TYPE);
    expect(codes).toEqual(expect.arrayContaining(['LAW_58_2024_QH15', 'DECREE_85_2025_ND_CP', 'LAW_22_2023_QH15', 'DECREE_214_2025_ND_CP']));
    for (const code of codes) {
      const rule = builtInDefault(LEGAL_DOCUMENT_RULE_TYPE, code);
      expect(rule?.unverified).toBe(true);
      expect(legalDocumentOf(code, rule?.params ?? {}).verification).toBe('UNVERIFIED');
    }
  });

  it('refuses a document that ends on or before the day it starts, a code that is not a code and a link that is not https', () => {
    const valid = { doc_kind: 'DECREE', number: '1/2026/ND-CP', title: 'A decree', issuer: 'Government', effective_from: '2026-01-01', verification: 'VERIFIED' };
    expect(() => validateRuleParams(LEGAL_DOCUMENT_RULE_TYPE, valid)).not.toThrow();
    expect(() => validateRuleParams(LEGAL_DOCUMENT_RULE_TYPE, { ...valid, effective_to: '2026-01-01' })).toThrow();
    expect(() => validateRuleParams(LEGAL_DOCUMENT_RULE_TYPE, { ...valid, superseded_by: 'not a code' })).toThrow();
    expect(() => validateRuleParams(LEGAL_DOCUMENT_RULE_TYPE, { ...valid, url: 'http://example.test/x' })).toThrow();
    expect(() => validateRuleParams(LEGAL_DOCUMENT_RULE_TYPE, { ...valid, url: 'https://example.test/x', document_id: '0b1c0877-9aa3-4841-92e9-158bbc5f01c7' })).not.toThrow();
  });

  it('says whether a document may be cited on a day', () => {
    const document = (to: string | null, supersededBy: string | null) => ({ effectiveFrom: '2024-02-27', effectiveTo: to, supersededBy });
    expect(legalDocumentState(document(null, null), '2024-02-26')).toBe('NOT_YET_IN_FORCE');
    expect(legalDocumentState(document(null, null), '2024-02-27')).toBe('IN_FORCE');
    expect(legalDocumentState(document('2025-08-04', null), '2025-08-03')).toBe('IN_FORCE');
    expect(legalDocumentState(document('2025-08-04', null), '2025-08-04')).toBe('EXPIRED');
    expect(legalDocumentState(document('2025-08-04', 'NEW_ONE'), '2025-08-03')).toBe('IN_FORCE');
    expect(legalDocumentState(document('2025-08-04', 'NEW_ONE'), '2025-08-04')).toBe('SUPERSEDED');
    expect(legalDocumentState(document(null, 'NEW_ONE'), '2025-01-01')).toBe('SUPERSEDED');
    expect([isLapsed('IN_FORCE'), isLapsed('NOT_YET_IN_FORCE'), isLapsed('EXPIRED'), isLapsed('SUPERSEDED')]).toEqual([false, false, true, true]);
  });

  it('ships the replaced bidding decree as replaced, so that the warning has something to show from the first day', () => {
    const old = legalDocumentOf('DECREE_24_2024_ND_CP', builtInDefault(LEGAL_DOCUMENT_RULE_TYPE, 'DECREE_24_2024_ND_CP')?.params ?? {});
    expect(old.supersededBy).toBe('DECREE_214_2025_ND_CP');
    expect(legalDocumentState(old, '2026-11-14')).toBe('SUPERSEDED');
  });

  it('has an alert type with an owner, an action and a consequence for a legal ground that lapsed', () => {
    const alert = defaultGovernanceRule('ALERT_TYPE', LEGAL_BASIS_ALERT_CODE);
    expect(alert?.params).toMatchObject({ source: 'PROJECT_TASK', owner: 'PROJECT_MANAGER', default_severity: 'WATCH', enabled: true });
    expect(String(alert?.params.expected_action).length).toBeGreaterThan(20);
    expect(String(alert?.params.consequence).length).toBeGreaterThan(20);
  });
});

describe('PROJECT_WORKFLOW_ASSIGNMENT: which kind of workflow a project takes (R47)', () => {
  const TEMPLATES = [
    { code: 'PUBLIC_INVESTMENT', projectType: 'PUBLIC_INVESTMENT' },
    { code: 'PUBLIC_PROCUREMENT', projectType: 'PUBLIC_PROCUREMENT' },
    { code: 'PUBLIC_REPAIR', projectType: 'PUBLIC_REPAIR' },
    { code: 'ODA_GROUP_A', projectType: null },
  ];
  const rule = (lines: Params[], fallback?: string): Params => ({ lines, ...(fallback === undefined ? {} : { default_template_code: fallback }) });
  const line = (code: string, priority: number, template: string, when: Params[]): Params => ({ code, priority, template_code: template, when });
  const parse = (params: Params) => parseWorkflowAssignment(validateRuleParams(WORKFLOW_ASSIGNMENT_RULE_TYPE, params));

  it('registers one built-in rule that sends everything but purchases and repairs to the construction workflow', () => {
    expect(builtInCodes(WORKFLOW_ASSIGNMENT_RULE_TYPE)).toEqual([WORKFLOW_ASSIGNMENT_CODE]);
    const shipped = parseWorkflowAssignment(builtInDefault(WORKFLOW_ASSIGNMENT_RULE_TYPE, WORKFLOW_ASSIGNMENT_CODE)?.params ?? {});
    expect(suggestWorkflowTemplate(shipped, {}, TEMPLATES)).toMatchObject({ templateCode: 'PUBLIC_INVESTMENT', basis: 'DEFAULT', line: null });
    expect(suggestWorkflowTemplate(shipped, { project_type: 'REPAIR' }, TEMPLATES)).toMatchObject({ templateCode: 'PUBLIC_REPAIR', basis: 'RULE', line: 'REPAIR' });
    expect(suggestWorkflowTemplate(shipped, { project_type: 'PUBLIC_PROCUREMENT' }, TEMPLATES)).toMatchObject({ templateCode: 'PUBLIC_PROCUREMENT', basis: 'RULE', line: 'PROCUREMENT' });
    expect(builtInDefault(WORKFLOW_ASSIGNMENT_RULE_TYPE, WORKFLOW_ASSIGNMENT_CODE)?.unverified).toBe(true);
  });

  it('reads the lines by priority whatever their order in the list, the first whose every condition holds wins', () => {
    const assignment = parse(
      rule(
        [
          line('GENERAL', 50, 'PUBLIC_INVESTMENT', [{ field: 'project_group', in: ['A', 'B', 'C'] }]),
          line('ODA_A', 10, 'ODA_GROUP_A', [{ field: 'project_group', in: ['A', 'QTQG'] }, { field: 'funding_source', in: ['ODA'] }]),
        ],
        'PUBLIC_REPAIR',
      ),
    );
    expect(assignment.lines.map((one) => one.code)).toEqual(['ODA_A', 'GENERAL']);
    const oda = suggestWorkflowTemplate(assignment, { project_group: 'A', funding_source: 'ODA' }, TEMPLATES);
    expect(oda).toMatchObject({ templateCode: 'ODA_GROUP_A', basis: 'RULE', line: 'ODA_A' });
    expect(oda.candidates.map((one) => `${one.templateCode}:${one.basis}`)).toEqual(['ODA_GROUP_A:RULE', 'PUBLIC_INVESTMENT:RULE', 'PUBLIC_REPAIR:DEFAULT']);
    expect(suggestWorkflowTemplate(assignment, { project_group: 'A', funding_source: 'BUDGET' }, TEMPLATES)).toMatchObject({ templateCode: 'PUBLIC_INVESTMENT', line: 'GENERAL' });
  });

  it('never lets a fact that is not known make a condition hold', () => {
    const assignment = parse(rule([line('ODA_A', 10, 'ODA_GROUP_A', [{ field: 'funding_source', in: ['ODA'] }])]));
    expect(suggestWorkflowTemplate(assignment, { project_group: 'A' }, TEMPLATES)).toEqual({ templateCode: null, basis: 'NONE', line: null, candidates: [], unknownTemplates: [] });
  });

  it('falls back on the template of the type of the project before the default, only when exactly one template has that type', () => {
    const assignment = parse(rule([], 'PUBLIC_INVESTMENT'));
    expect(suggestWorkflowTemplate(assignment, { project_type: 'PUBLIC_REPAIR' }, TEMPLATES)).toMatchObject({ templateCode: 'PUBLIC_REPAIR', basis: 'PROJECT_TYPE' });
    const two = [...TEMPLATES, { code: 'REPAIR_SMALL', projectType: 'PUBLIC_REPAIR' }];
    expect(suggestWorkflowTemplate(assignment, { project_type: 'PUBLIC_REPAIR' }, two)).toMatchObject({ templateCode: 'PUBLIC_INVESTMENT', basis: 'DEFAULT' });
  });

  it('skips a line that names a template the tenant does not have, and says so', () => {
    const assignment = parse(rule([line('GONE', 10, 'RETIRED_ONE', [{ field: 'project_group', in: ['A'] }])], 'PUBLIC_INVESTMENT'));
    expect(suggestWorkflowTemplate(assignment, { project_group: 'A' }, TEMPLATES)).toMatchObject({ templateCode: 'PUBLIC_INVESTMENT', basis: 'DEFAULT', unknownTemplates: ['RETIRED_ONE'] });
  });

  it('refuses a line code or a priority used twice, a field named twice in a line, a value twice and a line with no condition', () => {
    const when = [{ field: 'project_group', in: ['A'] }];
    const refused = (params: Params): boolean => {
      try {
        validateRuleParams(WORKFLOW_ASSIGNMENT_RULE_TYPE, params);
        return false;
      } catch {
        return true;
      }
    };
    expect(refused(rule([line('ONE', 10, 'PUBLIC_INVESTMENT', when), line('ONE', 20, 'PUBLIC_REPAIR', when)]))).toBe(true);
    expect(refused(rule([line('ONE', 10, 'PUBLIC_INVESTMENT', when), line('TWO', 10, 'PUBLIC_REPAIR', when)]))).toBe(true);
    expect(refused(rule([line('ONE', 10, 'PUBLIC_INVESTMENT', [...when, ...when])]))).toBe(true);
    expect(refused(rule([line('ONE', 10, 'PUBLIC_INVESTMENT', [{ field: 'project_group', in: ['A', 'A'] }])]))).toBe(true);
    expect(refused(rule([line('ONE', 10, 'PUBLIC_INVESTMENT', [])]))).toBe(true);
    expect(refused(rule([line('ONE', 10, 'PUBLIC_INVESTMENT', when), line('TWO', 20, 'PUBLIC_REPAIR', when)]))).toBe(false);
  });

  it('names how a template was chosen', () => {
    expect(selectionModeOf('PUBLIC_INVESTMENT', undefined)).toBe('AUTO');
    expect(selectionModeOf('PUBLIC_INVESTMENT', 'PUBLIC_INVESTMENT')).toBe('CONFIRMED');
    expect(selectionModeOf('PUBLIC_INVESTMENT', 'PUBLIC_REPAIR')).toBe('OVERRIDE');
    expect(selectionModeOf(null, 'PUBLIC_REPAIR')).toBe('MANUAL');
  });
});
