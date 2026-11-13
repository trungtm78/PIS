import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionValue } from '../../../session/SessionContext';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import { PLATFORM_TENANT } from '../../sas/test-support';
import { serve, templateParams, text } from '../test/fixtures';
import { problemMapOf } from './editor-fields';
import { StepsEditor, TaskProcessFields } from './editor-steps';
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

const session: SessionValue = { tenant: PLATFORM_TENANT, tenants: [PLATFORM_TENANT], user: { displayName: 'Admin', initials: 'AD' }, access: ALL_MODULES_VISIBLE, switchTenant: () => undefined, getSession: () => Promise.resolve({ token: 'token' }), permissions: [] };

/** The editor of the steps and of one task over a template held in state, with a catalogue that lists two legal documents. */
function Editor({ initial, show = false }: { initial: Template; show?: boolean }) {
  const [template, setTemplate] = useState(initial);
  const problems = problemMapOf(localProblems(template));
  const h = serve({
    getGovernanceRuleCatalog: {
      items: [{ rule_type: 'LEGAL_DOCUMENT', registered: true, owner_module: 'PWF', modules: [], formula: null, source: null, as_of: null, legal_status: 'UNVERIFIED', schema: undefined, codes: ['LAW_58_2024_QH15', 'DECREE_85_2025_ND_CP'].map((code) => ({ code, has_default: true, unverified: true, provenance: null, stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 })) }],
    },
  });
  return (
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApiClientProvider client={h.client}>
          <StepsEditor template={template} onChange={setTemplate} problems={problems} show={show} disabled={false} />
          <TaskProcessFields template={template} index={0} task={template.tasks[0] as Template['tasks'][number]} onPatch={(patch) => setTemplate(updateTask(template, 0, patch))} problems={problems} show={show} disabled={false} />
          <output data-testid="params">{JSON.stringify(paramsOfTemplate(template))}</output>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>
  );
}
const params = (): Record<string, unknown> => JSON.parse(screen.getByTestId('params').textContent ?? '{}') as Record<string, unknown>;
const click = (action: string): void => {
  fireEvent.click(document.querySelector(`[data-action="${action}"]`) as HTMLElement);
};

describe('PWF-02: the steps of the phases, the legal grounds and the form policies', () => {
  it('says that a template names no steps and declares one step per phase on request', () => {
    render(<Editor initial={base()} />);
    expect(screen.getByTestId('steps-off').textContent).toContain(text('pwf.templates.steps.off.text'));
    expect(screen.queryByTestId('field-tasks[0].step')).toBeNull();
    click('enable-steps');
    expect(screen.getByTestId('steps')).toBeTruthy();
    expect((screen.getByTestId('field-steps[0].name') as HTMLInputElement).value).toBe('Chuẩn bị đầu tư');
    expect(screen.getByTestId('step-tasks-0').textContent).toBe(text('pwf.templates.steps.tasks.text', { count: 2 }));
    expect((screen.getByTestId('field-tasks[0].step') as HTMLSelectElement).value).toBe('S_PREPARATION');
    expect((params().steps as unknown[]).length).toBe(1);
  });

  it('adds a step, names it, moves a task into it, and says that a step has no task once the person tried to save', () => {
    render(<Editor initial={enableSteps(base())} show />);
    click('add-step-PREPARATION');
    expect(screen.getByTestId('error-steps[1].tasks').textContent).toContain(text('pwf.templates.steps.noTasks.error'));
    fireEvent.change(screen.getByTestId('field-steps[1].name'), { target: { value: 'Thẩm định' } });
    fireEvent.change(screen.getByTestId('field-tasks[0].step'), { target: { value: 'S2' } });
    expect(screen.queryByTestId('error-steps[1].tasks')).toBeNull();
    expect((params().tasks as Array<{ step: string }>).map((task) => task.step)).toEqual(['S2', 'S_PREPARATION']);
    expect(within(screen.getByTestId('field-tasks[0].step')).getAllByRole('option').map((option) => option.textContent)).toEqual([text('pwf.templates.steps.pick.none'), 'S_PREPARATION · Chuẩn bị đầu tư', 'S2 · Thẩm định']);
  });

  it('cites a document of the catalogue by its code for a step and for a task, with the article and the verification, and says a code the catalogue does not have', async () => {
    render(<Editor initial={enableSteps(base())} />);
    click('add-basis-steps[0]');
    const pick = await screen.findByTestId('pick-steps[0].legal_basis[0].document');
    await within(pick).findByRole('option', { name: 'LAW_58_2024_QH15' });
    fireEvent.change(pick, { target: { value: 'LAW_58_2024_QH15' } });
    fireEvent.change(screen.getByTestId('field-steps[0].legal_basis[0].article'), { target: { value: 'Điều 40' } });
    fireEvent.change(screen.getByTestId('field-steps[0].legal_basis[0].verification'), { target: { value: 'VERIFIED' } });
    click('add-basis-tasks[0]');
    fireEvent.change(screen.getByTestId('field-tasks[0].legal_basis[0].document'), { target: { value: 'decree_x' } });
    expect(screen.getByTestId('unknown-tasks[0].legal_basis[0].document').textContent).toContain(text('pwf.templates.legal.unknown.text'));
    const written = params();
    expect((written.steps as Array<{ legal_basis: unknown[] }>)[0]?.legal_basis).toEqual([{ document: 'LAW_58_2024_QH15', article: 'Điều 40', verification: 'VERIFIED' }]);
    expect((written.tasks as Array<{ legal_basis?: unknown[] }>)[0]?.legal_basis).toEqual([{ document: 'DECREE_X', verification: 'UNVERIFIED' }]);
    click('remove-basis-tasks[0]-0');
    expect('legal_basis' in ((params().tasks as object[])[0] as object)).toBe(false);
  });

  it('pins a form of the task to a revision and lets it follow the newest approved revision again', () => {
    const template = base();
    render(<Editor initial={{ ...template, tasks: [{ ...(template.tasks[0] as Template['tasks'][number]), form_templates: ['BM_01'] }, ...template.tasks.slice(1)] }} />);
    const policy = screen.getByTestId('field-tasks[0].form_policies.BM_01.policy') as HTMLSelectElement;
    expect(policy.value).toBe('LATEST_APPROVED');
    fireEvent.change(policy, { target: { value: 'PINNED' } });
    fireEvent.change(screen.getByTestId('field-tasks[0].form_policies[0].revision'), { target: { value: '4' } });
    expect((params().tasks as Array<{ form_policies?: unknown[] }>)[0]?.form_policies).toEqual([{ form: 'BM_01', policy: 'PINNED', revision: 4 }]);
    fireEvent.change(screen.getByTestId('field-tasks[0].form_policies.BM_01.policy'), { target: { value: 'LATEST_APPROVED' } });
    expect('form_policies' in ((params().tasks as object[])[0] as object)).toBe(false);
  });
});
