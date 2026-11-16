import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { templateParams } from '../test/fixtures';
import { addStep, addTask, compareTemplates, disableSteps, enableSteps, formPolicyOf, groupSteps, hasSteps, localProblems, paramsOfTemplate, readTemplate, removePhase, removeStep, renamePhase, renameStep, setFormPolicy, stepsOf, summaryOf, updateStep, updateTask } from './template-model';
import type { Template } from './template-model';

afterEach(cleanup);

const cite = (document: string, article?: string) => ({ document, ...(article === undefined ? {} : { article }), verification: 'UNVERIFIED' as const });
const base = (): Template => readTemplate(templateParams());
/** The fixture template (one phase, two tasks) with its phase split into two steps, one task each. */
const stepped = (): Template => {
  const first = enableSteps(base());
  const second = addStep(first, 'PREPARATION');
  return updateTask(updateStep(second, 1, { name: 'Thẩm định' }), 1, { step: stepsOf(second)[1]?.code ?? '' });
};
const problemsOf = (template: Template): string[] => localProblems(template).map((one) => `${one.path}:${one.problem}`);

describe('template model: steps, legal grounds and form policies (R44, R45, R46)', () => {
  it('reads and writes a template without steps exactly as before: nothing is added to its params', () => {
    const written = paramsOfTemplate(base());
    expect(Object.keys(written)).toEqual(['name', 'project_type', 'phases', 'tasks']);
    for (const task of written.tasks) expect(Object.keys(task)).toEqual(expect.not.arrayContaining(['step', 'legal_basis', 'form_policies']));
    expect(hasSteps(base())).toBe(false);
    expect(summaryOf(written)).toEqual({ name: 'Đầu tư công: xây dựng', projectType: 'CONSTRUCTION', phases: 1, tasks: 2 });
  });

  it('keeps the steps, the legal grounds and the form policies of a rule through the editor (nothing is lost on save)', () => {
    const params = {
      ...templateParams(),
      steps: [{ code: 'S_ONE', name: 'Lập hồ sơ', phase: 'PREPARATION', responsible_role: 'PMB_PLANNER', legal_basis: [cite('LAW_58_2024_QH15')] }],
      tasks: templateParams().tasks.map((task, index) => ({ ...task, step: 'S_ONE', ...(index === 0 ? { form_templates: ['BM_01', 'BM_02'], form_policies: [{ form: 'BM_01', policy: 'PINNED' as const, revision: 2 }], legal_basis: [cite('DECREE_85_2025_ND_CP', 'Điều 22')] } : {}) })),
    };
    const written = paramsOfTemplate(readTemplate(params));
    expect(written.steps).toEqual(params.steps);
    expect(written.tasks[0]).toMatchObject({ step: 'S_ONE', form_policies: [{ form: 'BM_01', policy: 'PINNED', revision: 2 }], legal_basis: [cite('DECREE_85_2025_ND_CP', 'Điều 22')] });
    expect(written.tasks[1]).toMatchObject({ step: 'S_ONE' });
    expect('legal_basis' in (written.tasks[1] as object)).toBe(false);
    expect(summaryOf(written)).toMatchObject({ steps: 1 });
    expect(problemsOf(readTemplate(params))).toEqual([]);
  });

  it('gives a template one step per phase with every task in it, and takes the steps away again', () => {
    const on = enableSteps(base());
    expect(stepsOf(on)).toEqual([{ code: 'S_PREPARATION', name: 'Chuẩn bị đầu tư', phase: 'PREPARATION' }]);
    expect(on.tasks.map((task) => task.step)).toEqual(['S_PREPARATION', 'S_PREPARATION']);
    expect(problemsOf(on)).toEqual([]);
    expect(enableSteps(on)).toBe(on);
    const off = disableSteps(on);
    expect(paramsOfTemplate(off)).toEqual(paramsOfTemplate(base()));
  });

  it('follows a renamed step and a renamed phase in the tasks, puts a new task in the first step of its phase, and hands the tasks of a removed step to another step of the phase', () => {
    const two = stepped();
    expect(groupSteps(two).map((group) => [group.phase?.code, group.steps.map((item) => `${item.step.code}:${item.tasks}`)])).toEqual([['PREPARATION', ['S_PREPARATION:1', 'S2:1']]]);
    const renamed = renameStep(two, 1, 'S_REVIEW');
    expect(renamed.tasks[1]?.step).toBe('S_REVIEW');
    expect(renamePhase(two, 0, 'PREP').steps?.map((step) => step.phase)).toEqual(['PREP', 'PREP']);
    expect(addTask(two, 'PREPARATION').tasks[2]?.step).toBe('S_PREPARATION');
    const removed = removeStep(two, 1);
    expect(stepsOf(removed)).toHaveLength(1);
    expect(removed.tasks.map((task) => task.step)).toEqual(['S_PREPARATION', 'S_PREPARATION']);
    expect(hasSteps(removeStep(removed, 0))).toBe(false);
    expect(stepsOf(removePhase(two, 0))).toEqual([]);
  });

  it('names a step without a task, a task without a step or in a step of another phase, and a step code used twice', () => {
    const two = stepped();
    expect(problemsOf(addStep(two, 'PREPARATION'))).toEqual(['steps[2].name:required', 'steps[2].tasks:required']);
    expect(problemsOf(updateTask(two, 0, { step: null }))).toEqual(['steps[0].tasks:required', 'tasks[0].step:required']);
    expect(problemsOf(updateStep(two, 1, { phase: 'ELSEWHERE' }))).toEqual(['steps[1].phase:unknownRef', 'tasks[1].step:unknownRef']);
    expect(problemsOf(renameStep(two, 1, 'S_PREPARATION'))).toContain('steps[1].code:duplicate');
    expect(problemsOf(updateStep(two, 0, { responsible_role: 'not a role' }))).toEqual(['steps[0].responsible_role:pattern']);
  });

  it('names a legal ground without a document, with a code that is not one, or cited twice for the same article', () => {
    const two = stepped();
    const withBasis = (basis: ReturnType<typeof cite>[]) => problemsOf(updateStep(two, 0, { legal_basis: basis }));
    expect(withBasis([{ document: '', verification: 'UNVERIFIED' }])).toEqual(['steps[0].legal_basis[0].document:required']);
    expect(withBasis([cite('luật 58')])).toEqual(['steps[0].legal_basis[0].document:pattern']);
    expect(withBasis([cite('LAW_58_2024_QH15'), cite('LAW_58_2024_QH15')])).toEqual(['steps[0].legal_basis[1].document:duplicate']);
    expect(withBasis([cite('LAW_58_2024_QH15', 'Điều 1'), cite('LAW_58_2024_QH15', 'Điều 2')])).toEqual([]);
    expect(withBasis([cite('LAW_58_2024_QH15', 'x'.repeat(161))])).toEqual(['steps[0].legal_basis[0].article:length']);
    expect(problemsOf(updateTask(two, 0, { legal_basis: [cite('bad code')] }))).toEqual(['tasks[0].legal_basis[0].document:pattern']);
    // An empty article is left out of what is written, never sent as empty text.
    expect(paramsOfTemplate(updateStep(two, 0, { legal_basis: [{ document: 'LAW_58_2024_QH15', article: '  ', note: '', verification: 'VERIFIED' }] })).steps?.[0]?.legal_basis).toEqual([{ document: 'LAW_58_2024_QH15', verification: 'VERIFIED' }]);
  });

  it('pins a form to a revision or lets it follow the newest approved one, and drops the policy of a form the task no longer has', () => {
    const task = { ...base().tasks[0], form_templates: ['BM_01', 'BM_02'] } as Template['tasks'][number];
    expect(formPolicyOf(task, 'BM_01')).toEqual({ form: 'BM_01', policy: 'LATEST_APPROVED' });
    const pinned = { ...task, form_policies: setFormPolicy(task, 'BM_01', 'PINNED', 3) };
    expect(pinned.form_policies).toEqual([{ form: 'BM_01', policy: 'PINNED', revision: 3 }]);
    expect(setFormPolicy(pinned, 'BM_01', 'LATEST_APPROVED', null)).toEqual([]);
    const template = { ...base(), tasks: [{ ...pinned, form_policies: [{ form: 'BM_01', policy: 'PINNED' as const }] }, ...base().tasks.slice(1)] };
    expect(problemsOf(template)).toEqual(['tasks[0].form_policies[0].revision:range']);
    const gone = { ...base(), tasks: [{ ...pinned, form_templates: ['BM_02'] }, ...base().tasks.slice(1)] };
    expect('form_policies' in (paramsOfTemplate(gone).tasks[0] as object)).toBe(false);
  });

  it('tells a step that was added, changed or removed between two versions, and a task that moved to another step', () => {
    const before = stepped();
    const after = updateTask(updateStep(addStep(before, 'PREPARATION'), 0, { legal_basis: [cite('LAW_58_2024_QH15')] }), 1, { step: 'S_PREPARATION' });
    expect(compareTemplates(before, after)).toEqual([
      { scope: 'step', code: 'S_PREPARATION', kind: 'changed', fields: ['legal_basis'] },
      { scope: 'step', code: 'S3', kind: 'added', fields: [] },
      { scope: 'task', code: 'T2', kind: 'changed', fields: ['step'] },
    ]);
    expect(compareTemplates(before, disableSteps(before)).filter((change) => change.scope === 'step').map((change) => change.kind)).toEqual(['removed', 'removed']);
  });
});
