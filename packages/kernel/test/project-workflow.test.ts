import { DomainError } from '../src/errors.ts';
import { builtInCodes, builtInDefault, ruleTypeOf, validateRuleParams } from '../src/governance-rules.ts';
import {
  CONDITION_FIELDS,
  CONSTRAINT_KINDS,
  DEPENDENCY_KINDS,
  MAX_TEMPLATE_TASKS,
  PROJECT_WORKFLOW_RULE_TYPE,
  WORKFLOW_GATE_TARGETS,
  activeTasks,
  assessTaskCompletion,
  checkTemplateReferences,
  dependencyDepth,
  findDependencyCycle,
  gateFor,
  gateStanding,
  openPhaseOf,
  legalDocTypeResolvers,
  parseProjectWorkflowTemplate,
  registerLegalDocTypeResolver,
  resolveLegalDocType,
  templateDefect,
  templateHash,
  templateParamsOf,
  topologicalOrder,
} from '../src/project-workflow.ts';
import type { CompletionState, ProjectWorkflowTemplate, TaskGateState } from '../src/project-workflow.ts';

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

const template = (tasks: Params[], phases: Params[] = [{ code: 'P1', name: 'Phase one', gates: [] }]): Params => ({ name: 'Test', phases, tasks });
const after = (task: string, kind = 'FS', lag = 0): Params => ({ task, kind, lag_working_days: lag });

describe('PROJECT_WORKFLOW_TEMPLATE: the rule type and its built-in templates', () => {
  it('is registered with the three templates of public investment, each passing its own schema', () => {
    expect(ruleTypeOf(PROJECT_WORKFLOW_RULE_TYPE).ownerModule).toBe('PWF');
    expect(builtInCodes(PROJECT_WORKFLOW_RULE_TYPE)).toEqual(['PUBLIC_INVESTMENT', 'PUBLIC_PROCUREMENT', 'PUBLIC_REPAIR']);
    for (const code of builtInCodes(PROJECT_WORKFLOW_RULE_TYPE)) {
      const found = builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, code);
      expect(found?.legalStatus).toBe('UNVERIFIED');
      expect(found?.unverified).toBe(true);
      expect(found?.source.length).toBeGreaterThan(10);
      expect(() => validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, found?.params)).not.toThrow();
    }
  });

  it('gives the public investment template six phases, no cycle, and a gate on the legal commands', () => {
    const params = builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, 'PUBLIC_INVESTMENT')?.params as Params;
    const parsed = parseProjectWorkflowTemplate(params);
    expect(parsed.phases.map((phase) => phase.code)).toEqual(['PREPARATION', 'FEASIBILITY', 'APPROVAL', 'IMPLEMENTATION', 'ACCEPTANCE', 'SETTLEMENT']);
    expect(findDependencyCycle(parsed.tasks)).toBeNull();
    const gated = parsed.phases.flatMap((phase) => phase.gates);
    expect(gated).toEqual(expect.arrayContaining(['startProjectImplementation', 'completeProject', 'closeProject']));
    // All four kinds of link are exercised by the neutral default (a template author sees an example of SS and FF).
    const kinds = new Set(parsed.tasks.flatMap((one) => one.predecessors.map((link) => link.kind)));
    expect(kinds).toEqual(new Set(['FS', 'SS', 'FF']));
    // The roles are those of a provincial agency, never one customer's.
    const roles = new Set(parsed.tasks.map((one) => one.responsibleRole));
    expect([...roles]).toEqual(expect.arrayContaining(['INVESTOR_REP', 'PMB_MANAGER', 'DPI_APPRAISER', 'FINANCE_APPRAISER', 'PMB_ACCOUNTANT']));
    expect(parsed.tasks.some((one) => one.approverRole === 'TREASURY_OFFICER')).toBe(true);
  });

  it('keeps every built-in task inside the size limits and refers only to registered evidence and document classes', () => {
    for (const code of builtInCodes(PROJECT_WORKFLOW_RULE_TYPE)) {
      const parsed = parseProjectWorkflowTemplate(builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, code)?.params);
      expect(parsed.tasks.length).toBeLessThanOrEqual(MAX_TEMPLATE_TASKS);
      const findings = checkTemplateReferences(parsed, {});
      expect(findings).toEqual([]);
    }
  });

  it('exposes the closed lists a template draws from', () => {
    expect(DEPENDENCY_KINDS).toEqual(['FS', 'SS', 'FF', 'SF']);
    expect(CONSTRAINT_KINDS).toEqual(['SNET', 'SNLT', 'FNET', 'FNLT', 'MSO', 'MFO']);
    expect(CONDITION_FIELDS).toEqual(['project_group', 'funding_source', 'project_type']);
    expect(WORKFLOW_GATE_TARGETS).toContain('startProjectImplementation');
  });

  it('round-trips the params and hashes the same template to the same value whatever the key order', () => {
    const params = builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, 'PUBLIC_INVESTMENT')?.params as Params;
    const parsed = parseProjectWorkflowTemplate(params);
    const back = templateParamsOf(parsed);
    expect(parseProjectWorkflowTemplate(back)).toEqual(parsed);
    expect(templateHash(parsed)).toBe(templateHash(parseProjectWorkflowTemplate(back)));
    expect(templateHash(parsed)).toMatch(/^[0-9a-f]{64}$/);
    const other = { ...parsed, name: 'Another' };
    expect(templateHash(other)).not.toBe(templateHash(parsed));
  });
});

describe('templateDefect: what the closed schema cannot say', () => {
  it('accepts a small valid template', () => {
    expect(templateDefect(template([task('A'), task('B', { predecessors: [after('A')] })]))).toBeUndefined();
  });

  it('refuses duplicate codes, an unknown phase and a phase without a task', () => {
    expect(templateDefect(template([task('A'), task('A')]))).toBe('tasks[1].code');
    expect(templateDefect(template([task('A', { phase: 'NOPE' })]))).toBe('tasks[0].phase');
    expect(templateDefect(template([task('A')], [{ code: 'P1', name: 'x', gates: [] }, { code: 'P1', name: 'y', gates: [] }]))).toBe('phases[1].code');
    expect(templateDefect(template([task('A')], [{ code: 'P1', name: 'x', gates: [] }, { code: 'P2', name: 'y', gates: [] }]))).toBe('phases[1].code');
  });

  it('refuses a predecessor that is unknown, is the task itself or is listed twice with the same kind', () => {
    expect(templateDefect(template([task('A', { predecessors: [after('Z')] })]))).toBe('tasks[0].predecessors[0].task');
    expect(templateDefect(template([task('A', { predecessors: [after('A')] })]))).toBe('tasks[0].predecessors[0].task');
    expect(templateDefect(template([task('A'), task('B', { predecessors: [after('A'), after('A', 'FS', 3)] })]))).toBe('tasks[1].predecessors[1].task');
    // The same two tasks may be tied by different kinds (the start and the finish of a supervision task follow the work).
    expect(templateDefect(template([task('A'), task('B', { predecessors: [after('A', 'SS'), after('A', 'FF', 2)] })]))).toBeUndefined();
  });

  it('refuses a loop of dependencies and names the task in it', () => {
    const loop = template([task('A', { predecessors: [after('C')] }), task('B', { predecessors: [after('A')] }), task('C', { predecessors: [after('B')] })]);
    expect(templateDefect(loop)).toMatch(/^tasks\[\d\]\.predecessors$/);
    expect(findDependencyCycle([{ code: 'A', predecessors: [{ task: 'C' }] }, { code: 'B', predecessors: [{ task: 'A' }] }, { code: 'C', predecessors: [{ task: 'B' }] }])?.sort()).toEqual(['A', 'B', 'C']);
  });

  it('keeps a milestone at zero duration and a task above zero', () => {
    expect(templateDefect(template([task('A', { kind: 'MILESTONE', duration_working_days: 3 })]))).toBe('tasks[0].duration_working_days');
    expect(templateDefect(template([task('A', { kind: 'TASK', duration_working_days: 0 })]))).toBe('tasks[0].duration_working_days');
    expect(templateDefect(template([task('A', { kind: 'MILESTONE', duration_working_days: 0 })]))).toBeUndefined();
  });

  it('refuses a checklist code twice, an unknown evidence kind and a condition that names a value twice', () => {
    const item = (code: string, evidence: string[] = []): Params => ({ code, name: 'Item', required: true, evidence_kinds: evidence });
    expect(templateDefect(template([task('A', { checklist: [item('X'), item('X')] })]))).toBe('tasks[0].checklist[1].code');
    expect(templateDefect(template([task('A', { checklist: [item('X', ['NO_SUCH_KIND'])] })]))).toBe('tasks[0].checklist[0].evidence_kinds[0]');
    expect(templateDefect(template([task('A', { when: [{ field: 'project_group', in: ['A', 'A'] }] })]))).toBe('tasks[0].when[0].in');
    expect(templateDefect(template([task('A', { when: [{ field: 'project_group', in: ['A'] }, { field: 'project_group', in: ['B'] }] })]))).toBe('tasks[0].when[1].field');
  });

  it('refuses a gate listed twice in a phase and the same legal document or form twice in a task', () => {
    expect(templateDefect(template([task('A')], [{ code: 'P1', name: 'x', gates: ['closeProject', 'closeProject'] }]))).toBe('phases[0].gates[1]');
    expect(templateDefect(template([task('A', { legal_doc_types: ['CONTRACT', 'CONTRACT'] })]))).toBe('tasks[0].legal_doc_types[1]');
    expect(templateDefect(template([task('A', { form_templates: ['F1', 'F1'] })]))).toBe('tasks[0].form_templates[1]');
  });

  it('refuses a graph whose longest chain is too deep', () => {
    const tasks: Params[] = [];
    for (let index = 0; index < 130; index += 1) tasks.push(task(`T${index}`, index === 0 ? {} : { predecessors: [after(`T${index - 1}`)] }));
    expect(templateDefect(template(tasks))).toBe('tasks');
  });

  it('is what the governance store runs: the registry refuses a defective template with the field', () => {
    const defective = template([task('AA', { predecessors: [after('ZZ')] })]);
    expect(() => validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, defective)).toThrow(DomainError);
    try {
      validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, defective);
    } catch (failure) {
      expect((failure as DomainError).code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
      expect((failure as DomainError).detail).toBe('tasks[0].predecessors[0].task');
    }
  });

  it('refuses params that are not a template when parsed directly', () => {
    expect(() => parseProjectWorkflowTemplate(null)).toThrow(DomainError);
    expect(() => parseProjectWorkflowTemplate({ name: 'x' })).toThrow(DomainError);
    expect(() => parseProjectWorkflowTemplate(template([task('A', { predecessors: [after('Z')] })]))).toThrow(DomainError);
  });
});

describe('the dependency graph', () => {
  const parse = (tasks: Params[]): ProjectWorkflowTemplate => parseProjectWorkflowTemplate(template(tasks));

  it('orders tasks so that every predecessor comes first, and is stable', () => {
    const graph = parse([task('C', { predecessors: [after('A'), after('B')] }), task('B', { predecessors: [after('A')] }), task('A')]);
    expect(topologicalOrder(graph.tasks)).toEqual(['A', 'B', 'C']);
    expect(topologicalOrder(graph.tasks)).toEqual(topologicalOrder(graph.tasks));
  });

  it('finds no cycle in a diamond and measures the depth of the longest chain', () => {
    const graph = parse([task('A'), task('B', { predecessors: [after('A')] }), task('C', { predecessors: [after('A')] }), task('D', { predecessors: [after('B'), after('C')] })]);
    expect(findDependencyCycle(graph.tasks)).toBeNull();
    expect(dependencyDepth(graph.tasks)).toBe(3);
  });

  it('refuses to order a graph with a loop', () => {
    const loop = [{ code: 'A', predecessors: [{ task: 'B' }] }, { code: 'B', predecessors: [{ task: 'A' }] }];
    expect(() => topologicalOrder(loop)).toThrow(DomainError);
    expect(findDependencyCycle(loop)).not.toBeNull();
  });
});

describe('conditional branches by project group, source of capital and type', () => {
  const branching = parseProjectWorkflowTemplate(
    template([
      task('A'),
      task('B', { predecessors: [after('A')], when: [{ field: 'project_group', in: ['QTQG', 'A'] }] }),
      task('C', { predecessors: [after('B')], when: [{ field: 'project_group', in: ['QTQG', 'A', 'B'] }, { field: 'funding_source', in: ['ODA'] }] }),
      task('D', { predecessors: [after('C')] }),
    ]),
  );

  it('keeps a task whose every condition holds and lists the others as excluded, with the link through them kept in the schedule', () => {
    const groupA = activeTasks(branching, { project_group: 'A', funding_source: 'ODA' });
    expect(groupA.active.map((one) => one.code)).toEqual(['A', 'B', 'C', 'D']);
    expect(groupA.excluded).toEqual([]);
    const groupC = activeTasks(branching, { project_group: 'C', funding_source: 'BUDGET' });
    expect(groupC.active.map((one) => one.code)).toEqual(['A', 'D']);
    expect(groupC.excluded).toEqual(['B', 'C']);
  });

  it('treats a fact that is not known as a condition that does not hold, never as one that does', () => {
    expect(activeTasks(branching, {}).excluded).toEqual(['B', 'C']);
    expect(activeTasks(branching, { project_group: 'A' }).excluded).toEqual(['C']);
  });

  it('applies to the built-in public investment template: group B skips the pre-feasibility study, group C also the policy decision, group A with foreign capital skips nothing', () => {
    const publicInvestment = parseProjectWorkflowTemplate(builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, 'PUBLIC_INVESTMENT')?.params);
    expect(activeTasks(publicInvestment, { project_group: 'B' }).excluded).toEqual(['PREP_PRE_FEASIBILITY', 'FEAS_ODA_AGREEMENT']);
    expect(activeTasks(publicInvestment, { project_group: 'C' }).excluded).toEqual(['PREP_PRE_FEASIBILITY', 'PREP_POLICY_APPRAISAL', 'PREP_POLICY_DECISION', 'FEAS_ODA_AGREEMENT', 'SET_AUDIT']);
    expect(activeTasks(publicInvestment, { project_group: 'A', funding_source: 'ODA' }).excluded).toEqual([]);
  });
});

describe('references of a template: legal documents by edition, forms, evidence, KPI codes and roles', () => {
  const parsed = parseProjectWorkflowTemplate(
    template([
      task('A', {
        legal_doc_types: ['CONTRACT', 'MISSING_TYPE'],
        form_templates: ['FORM_ONE'],
        kpi_codes: ['PWF_ON_TIME_RATE', 'NO_SUCH_KPI'],
        responsible_role: 'PLANNER',
        approver_role: 'BOSS',
        checklist: [{ code: 'X', name: 'Item', required: true, evidence_kinds: ['DOCUMENT'] }],
      }),
    ]),
  );

  it('resolves legal document types through the registered editions and reports the ones nobody knows', () => {
    const findings = checkTemplateReferences(parsed, {});
    expect(findings.map((one) => `${one.field}:${one.code}`)).toEqual(['tasks[0].legal_doc_types[1]:LEGAL_DOC_TYPE_UNKNOWN']);
  });

  it('checks forms, KPI codes and roles only when the caller can answer, and says which one is unknown', () => {
    const findings = checkTemplateReferences(parsed, {
      formTemplate: (code) => code === 'OTHER',
      kpiCode: (code) => code === 'PWF_ON_TIME_RATE',
      role: (code) => code === 'PLANNER',
    });
    expect(findings.map((one) => `${one.field}:${one.code}`)).toEqual([
      'tasks[0].legal_doc_types[1]:LEGAL_DOC_TYPE_UNKNOWN',
      'tasks[0].form_templates[0]:FORM_TEMPLATE_UNKNOWN',
      'tasks[0].kpi_codes[1]:KPI_CODE_UNKNOWN',
      'tasks[0].approver_role:ROLE_UNKNOWN',
    ]);
  });

  it('lets an edition register its own catalogue of legal document types without the shared code knowing it', () => {
    registerLegalDocTypeResolver({
      edition: 'test-edition',
      resolve: (code) => (code === 'MISSING_TYPE' ? { code, label: 'Missing type', documentClass: 'OTHER' } : undefined),
      list: () => [{ code: 'MISSING_TYPE', label: 'Missing type', documentClass: 'OTHER' }],
    });
    expect(resolveLegalDocType('MISSING_TYPE')?.documentClass).toBe('OTHER');
    expect(resolveLegalDocType('CONTRACT')?.documentClass).toBe('CONTRACT');
    expect(resolveLegalDocType('INVESTMENT_POLICY_DECISION')).toMatchObject({ documentClass: 'INVESTMENT_DECISION', label: expect.stringContaining('chủ trương') });
    expect(resolveLegalDocType('TREASURY_CONTROL')?.documentClass).toBe('PAYMENT');
    expect(resolveLegalDocType('NOPE')).toBeUndefined();
    expect(legalDocTypeResolvers().map((one) => one.edition)).toEqual(expect.arrayContaining(['public', 'test-edition']));
    expect(checkTemplateReferences(parsed, {})).toEqual([]);
    expect(() => registerLegalDocTypeResolver({ edition: 'test-edition', resolve: () => undefined, list: () => [] })).toThrow();
  });

  it('UAT-PWF-BND-12: a task that leaves out the five lists the contract makes optional is the same template as one that gives them empty: it is valid, and its hash is the hash of the full form', () => {
    const full = template([task('TA', { legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [] }), task('TB', { legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [] })]);
    const bare = { ...full, tasks: (full.tasks as Params[]).map(({ legal_doc_types: _legal, form_templates: _forms, checklist: _checklist, kpi_codes: _kpis, when: _when, ...rest }) => rest) };
    for (const field of ['legal_doc_types', 'form_templates', 'checklist', 'kpi_codes', 'when']) expect((bare.tasks as Params[])[0]).not.toHaveProperty(field);
    expect(() => validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, bare)).not.toThrow();
    expect(templateHash(parseProjectWorkflowTemplate(bare))).toBe(templateHash(parseProjectWorkflowTemplate(full)));
    // A list that is given must still be a list of the right things.
    expect(() => validateRuleParams(PROJECT_WORKFLOW_RULE_TYPE, { ...bare, tasks: [{ ...(bare.tasks as Params[])[0], checklist: 'none' }, (bare.tasks as Params[])[1]] })).toThrow(DomainError);
  });

  it('UAT-PWF-EDN-01: the public edition resolves the codes of the public investment catalogue and knows no other code; another edition adds its types through the registry, and the catalogue of the public edition is not touched by it', () => {
    const publicEdition = legalDocTypeResolvers().find((one) => one.edition === 'public');
    const before = publicEdition?.list().map((one) => one.code) ?? [];
    expect(before).toEqual(expect.arrayContaining(['INVESTMENT_POLICY_DECISION', 'CONTRACT', 'TREASURY_CONTROL']));
    expect(resolveLegalDocType('XYZ_UNKNOWN')).toBeUndefined();
    const drafted = parseProjectWorkflowTemplate(template([task('A', { legal_doc_types: ['CONTRACT', 'XYZ_UNKNOWN'] })]));
    expect(checkTemplateReferences(drafted, {}).map((one) => `${one.field}:${one.code}`)).toEqual(['tasks[0].legal_doc_types[1]:LEGAL_DOC_TYPE_UNKNOWN']);
    registerLegalDocTypeResolver({
      edition: 'uat-other-edition',
      resolve: (code) => (code === 'XYZ_UNKNOWN' ? { code, label: 'Loại chứng từ của bản khác', documentClass: 'OTHER' } : undefined),
      list: () => [{ code: 'XYZ_UNKNOWN', label: 'Loại chứng từ của bản khác', documentClass: 'OTHER' }],
    });
    expect(resolveLegalDocType('XYZ_UNKNOWN')?.documentClass).toBe('OTHER');
    expect(checkTemplateReferences(drafted, {})).toEqual([]);
    expect(publicEdition?.list().map((one) => one.code)).toEqual(before);
    expect(publicEdition?.resolve('XYZ_UNKNOWN')).toBeUndefined();
  });
});

describe('assessTaskCompletion: a task is done only with its checklist, evidence, documents, forms and a different approver', () => {
  const definition = parseProjectWorkflowTemplate(
    template([
      task('A', {
        approver_role: 'OWNER',
        legal_doc_types: ['CONTRACT'],
        form_templates: ['FORM_ONE'],
        checklist: [
          { code: 'I1', name: 'One', required: true, evidence_kinds: ['DOCUMENT'] },
          { code: 'I2', name: 'Two', required: false, evidence_kinds: [] },
        ],
      }),
      task('B'),
    ]),
  ).tasks;
  const [withEverything, plain] = definition;
  const complete: CompletionState = {
    performer: 'ann',
    approver: 'bob',
    makers: ['ann'],
    checklist: [{ code: 'I1', done: true, evidenceKinds: ['DOCUMENT'] }],
    legalDocTypes: ['CONTRACT'],
    formTemplates: ['FORM_ONE'],
    exceptionApproved: false,
  };

  it('is complete when everything asked is there', () => {
    expect(assessTaskCompletion(withEverything as never, complete)).toEqual({ ok: true, blockers: [], coverable: [] });
    expect(assessTaskCompletion(plain as never, { ...complete, approver: null, checklist: [], legalDocTypes: [], formTemplates: [] }).ok).toBe(true);
  });

  it('names every blocker with its subject', () => {
    const result = assessTaskCompletion(withEverything as never, { ...complete, checklist: [], legalDocTypes: [], formTemplates: [], approver: null });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((one) => `${one.code}:${one.subject}`)).toEqual(['CHECKLIST_ITEM_OPEN:I1', 'LEGAL_DOC_MISSING:CONTRACT', 'FORM_MISSING:FORM_ONE', 'APPROVER_REQUIRED:OWNER']);
  });

  it('wants evidence of the listed kinds on an item that is done', () => {
    const result = assessTaskCompletion(withEverything as never, { ...complete, checklist: [{ code: 'I1', done: true, evidenceKinds: ['ATTESTATION'] }] });
    expect(result.blockers).toEqual([{ code: 'EVIDENCE_MISSING', subject: 'I1' }]);
  });

  it('never lets the person who did the work approve it, even under an approved exception', () => {
    const result = assessTaskCompletion(withEverything as never, { ...complete, approver: 'ann', exceptionApproved: true });
    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual([{ code: 'MAKER_IS_APPROVER', subject: 'ann' }]);
    expect(result.coverable).toEqual([]);
  });

  it('lets an approved exception cover the missing items, evidence, documents and forms, and says what it covered', () => {
    const missing: CompletionState = { ...complete, checklist: [], legalDocTypes: [], formTemplates: [], exceptionApproved: true };
    const result = assessTaskCompletion(withEverything as never, missing);
    expect(result.ok).toBe(true);
    expect(result.coverable.map((one) => one.code)).toEqual(['CHECKLIST_ITEM_OPEN', 'LEGAL_DOC_MISSING', 'FORM_MISSING']);
    expect(assessTaskCompletion(withEverything as never, { ...missing, exceptionApproved: false }).coverable.length).toBe(3);
  });
});

describe('gateFor: a legal command of the project is open only when the required tasks of its phases are done', () => {
  const graph = parseProjectWorkflowTemplate(
    template(
      [
        task('A', { phase: 'P1' }),
        task('B', { phase: 'P1', approver_role: 'OWNER' }),
        task('C', { phase: 'P1', required: false }),
        task('D', { phase: 'P1', when: [{ field: 'project_group', in: ['A'] }] }),
        task('E', { phase: 'P2' }),
      ],
      [
        { code: 'P1', name: 'One', gates: ['startProjectImplementation'] },
        { code: 'P2', name: 'Two', gates: [] },
      ],
    ),
  );
  const state = (code: string, extra: Partial<TaskGateState> = {}): TaskGateState => ({ code, status: 'DONE', completionApproved: true, waived: false, cancelApproved: false, ...extra });

  it('is open and not gated for a command no phase lists', () => {
    expect(gateFor(graph, 'closeProject', {}, [])).toEqual({ gated: false, open: true, missing: [] });
  });

  it('is closed with the list of what is missing, per reason', () => {
    const result = gateFor(graph, 'startProjectImplementation', { project_group: 'B' }, [state('A', { status: 'IN_PROGRESS' }), state('B', { completionApproved: false })]);
    expect(result.gated).toBe(true);
    expect(result.open).toBe(false);
    expect(result.missing).toEqual([
      { task: 'A', phase: 'P1', reason: 'NOT_DONE' },
      { task: 'B', phase: 'P1', reason: 'COMPLETION_NOT_APPROVED' },
    ]);
  });

  it('counts a task with no state at all as missing, and leaves out optional tasks, excluded branches and other phases', () => {
    const result = gateFor(graph, 'startProjectImplementation', { project_group: 'B' }, []);
    expect(result.missing.map((one) => `${one.task}:${one.reason}`)).toEqual(['A:NO_STATE', 'B:NO_STATE']);
    const withBranch = gateFor(graph, 'startProjectImplementation', { project_group: 'A' }, [state('A'), state('B')]);
    expect(withBranch.missing).toEqual([{ task: 'D', phase: 'P1', reason: 'NO_STATE' }]);
  });

  it('B15: a closed gate of a phase the project has not reached is NOT_DUE, never CLOSED; the phase it is in and the ones behind it are judged', () => {
    const three = parseProjectWorkflowTemplate(
      template(
        [task('A', { phase: 'P1' }), task('E', { phase: 'P2' }), task('F', { phase: 'P3' }), task('G', { phase: 'P3', required: false })],
        [
          { code: 'P1', name: 'One', gates: ['startProjectImplementation'] },
          { code: 'P2', name: 'Two', gates: ['completeProject'] },
          { code: 'P3', name: 'Three', gates: ['closeProject', 'completeProject'] },
        ],
      ),
    );
    const rows = (done: string[]): Array<{ phase: string; required: boolean; excluded: boolean; tracked: boolean; status: string }> =>
      three.tasks.map((one) => ({ phase: one.phase, required: one.required, excluded: false, tracked: true, status: done.includes(one.code) ? 'DONE' : 'NOT_STARTED' }));
    const standing = (target: string, done: string[]): string => {
      const verdict = gateFor(three, target, {}, done.map((code) => state(code)));
      return gateStanding(three, target, verdict, openPhaseOf(three, rows(done))).standing;
    };
    expect(openPhaseOf(three, rows([]))).toBe('P1');
    expect(openPhaseOf(three, rows(['A']))).toBe('P2');
    expect(openPhaseOf(three, rows(['A', 'E', 'F']))).toBeNull();
    // In phase one: its own gate is judged, the gates of the phases ahead are not due yet.
    expect(standing('startProjectImplementation', [])).toBe('CLOSED');
    expect(standing('completeProject', [])).toBe('NOT_DUE');
    expect(standing('closeProject', [])).toBe('NOT_DUE');
    expect(standing('suspendProject', [])).toBe('UNGATED');
    // In phase two: the gate behind is open, the one of this phase is judged (it is listed by this phase too), the one ahead waits.
    expect(standing('startProjectImplementation', ['A'])).toBe('OPEN');
    expect(standing('completeProject', ['A'])).toBe('CLOSED');
    expect(standing('closeProject', ['A'])).toBe('NOT_DUE');
    // A phase that was passed with a task of an earlier phase reopened is judged again; everything done is open.
    expect(standing('closeProject', ['A', 'E'])).toBe('CLOSED');
    expect(standing('closeProject', ['A', 'E', 'F'])).toBe('OPEN');
    expect(gateStanding(three, 'closeProject', gateFor(three, 'closeProject', {}, []), 'P1').phases).toEqual(['P3']);
    // A task left out of the project or not tracked holds no phase open.
    expect(openPhaseOf(three, rows([]).map((one) => (one.phase === 'P1' ? { ...one, tracked: false } : one)))).toBe('P2');
  });

  it('opens when every required task is done and approved, waived by an approved exception, or cancelled with approval', () => {
    const open = gateFor(graph, 'startProjectImplementation', { project_group: 'A' }, [state('A'), state('B', { status: 'IN_PROGRESS', waived: true }), state('D', { status: 'CANCELLED', cancelApproved: true })]);
    expect(open).toEqual({ gated: true, open: true, missing: [] });
    const unapprovedCancel = gateFor(graph, 'startProjectImplementation', { project_group: 'A' }, [state('A'), state('B'), state('D', { status: 'CANCELLED', cancelApproved: false })]);
    expect(unapprovedCancel.open).toBe(false);
    expect(unapprovedCancel.missing).toEqual([{ task: 'D', phase: 'P1', reason: 'CANCELLED_WITHOUT_APPROVAL' }]);
  });

  it('is the only thing that keeps a command from running: a phase that lists the event of the system gates it too', () => {
    const eventGated = parseProjectWorkflowTemplate(template([task('A')], [{ code: 'P1', name: 'One', gates: ['settlement.closed.v1'] }]));
    expect(gateFor(eventGated, 'settlement.closed.v1', {}, []).open).toBe(false);
    expect(gateFor(eventGated, 'settlement.closed.v1', {}, [state('A')]).open).toBe(true);
  });
});
