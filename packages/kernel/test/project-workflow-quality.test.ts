import { LONG_TASK_WORKING_DAYS, QUALITY_FLAG_CODES, templateQualityFlags } from '../src/project-workflow-quality.ts';
import { builtInDefault } from '../src/governance-rules.ts';
import { PROJECT_WORKFLOW_RULE_TYPE, parseProjectWorkflowTemplate } from '../src/project-workflow.ts';
import type { ProjectWorkflowTemplate, TemplateTask } from '../src/project-workflow.ts';

const task = (code: string, over: Partial<TemplateTask> = {}): TemplateTask => ({
  code,
  name: code,
  phase: 'P1',
  kind: 'TASK',
  durationWorkingDays: 3,
  required: true,
  responsibleRole: 'PMB_PLANNER',
  approverRole: null,
  priority: 'NORMAL',
  predecessors: [],
  constraint: null,
  legalDocTypes: [],
  formTemplates: [],
  checklist: [],
  kpiCodes: [],
  when: [],
  ...over,
});

const templateOf = (tasks: TemplateTask[]): ProjectWorkflowTemplate => ({ name: 'T', projectType: null, phases: [{ code: 'P1', name: 'P', order: 1, gates: [] }], tasks });
const fs = (task_: string, lag = 0) => ({ task: task_, kind: 'FS' as const, lagWorkingDays: lag });

describe('the quality flags of a template (BR-PWF-19)', () => {
  it('flags nothing on a clean chain: the first task needs no predecessor and the last no successor', () => {
    const chain = templateOf([task('A'), task('B', { predecessors: [fs('A')] }), task('C', { predecessors: [fs('B')] })]);
    expect(templateQualityFlags(chain)).toEqual([]);
  });

  it('flags a task in the middle that has no predecessor, and one that nothing follows', () => {
    const template = templateOf([task('A'), task('B', { predecessors: [fs('A')] }), task('LOOSE'), task('C', { predecessors: [fs('B')] })]);
    expect(templateQualityFlags(template)).toEqual([
      { code: 'MISSING_PREDECESSOR', task: 'LOOSE', detail: null },
      { code: 'MISSING_SUCCESSOR', task: 'LOOSE', detail: null },
    ]);
  });

  it('flags a lead, a hard constraint and a task longer than 44 working days', () => {
    const template = templateOf([
      task('A', { durationWorkingDays: LONG_TASK_WORKING_DAYS + 1 }),
      task('B', { predecessors: [fs('A', -2)], constraint: { kind: 'MSO', offsetWorkingDays: 5 } }),
      task('C', { predecessors: [fs('B')], constraint: { kind: 'SNET', offsetWorkingDays: 1 } }),
    ]);
    expect(templateQualityFlags(template).map((flag) => [flag.code, flag.task, flag.detail])).toEqual([
      ['LONG_TASK', 'A', String(LONG_TASK_WORKING_DAYS + 1)],
      ['LEAD', 'B', 'A'],
      ['HARD_CONSTRAINT', 'B', 'MSO'],
    ]);
  });

  it('knows the flag codes, including the one the caller adds from a schedule', () => {
    expect(QUALITY_FLAG_CODES).toContain('NEGATIVE_FLOAT');
  });

  it('reports on the built-in templates without throwing, and every flag names a task of the template', () => {
    for (const code of ['PUBLIC_INVESTMENT', 'PUBLIC_PROCUREMENT', 'PUBLIC_REPAIR']) {
      const template = parseProjectWorkflowTemplate(builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, code)?.params);
      const codes = new Set(template.tasks.map((one) => one.code));
      for (const flag of templateQualityFlags(template)) expect(flag.task === null || codes.has(flag.task)).toBe(true);
    }
  });
});
