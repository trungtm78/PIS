import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import { suggestion } from '../process/test/fixtures';
import { ALL_PERMISSIONS, PROJECT_ID, READ_ONLY, refusal, routeOf, serve, text } from '../test/fixtures';
import type { Answer } from '../test/fixtures';
import StartWorkflowScreen from './StartWorkflowScreen';
import { adoptResult, catalogueBody, effectiveBody, projectBody } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-05');

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

const UNIT_ROWS = [
  { id: 'u-so', code: 'SO', name: 'Sở Xây dựng', parent_id: null },
  { id: 'u-pb', code: 'PB', name: 'Phòng Thẩm định', parent_id: 'u-so' },
];
const withUnits = (over: Record<string, unknown> = {}) => ({
  refs: [
    { unit_ref: 'PROJECT_OWNER', unit_id: 'u-1', unit_name: 'Sở Giao thông', source: 'PROJECT' as const, party_name: null },
    { unit_ref: 'PROJECT_PARTY:APPRAISER', unit_id: null, unit_name: null, source: 'NONE' as const, party_name: 'Đơn vị thẩm định' },
  ],
  unresolved: ['PROJECT_PARTY:APPRAISER'],
  ...over,
});

interface Setup {
  path?: string;
  permissions?: readonly string[];
  project?: Answer;
  commands?: Record<string, Answer>;
  /** The answer of the rule; an Error is a rule that cannot be read. */
  rule?: Answer;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      get_resources_project_id: setup.project ?? projectBody(),
      getGovernanceRuleCatalog: catalogueBody(),
      getEffectiveGovernanceRule: (input: Record<string, unknown>) => effectiveBody(((input.query as Record<string, string>) ?? {}).code ?? 'PUBLIC_INVESTMENT'),
      suggestProjectWorkflow: setup.rule ?? (() => suggestion()),
    },
    setup.commands ?? { startProjectWorkflow: { resource_id: 'w1', status: 'ACTIVE', resource_version: 1 } },
  );
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.resolve(UNIT_ROWS));
  mount(
    <>
      <StartWorkflowScreen route={route} />
      <Where />
    </>,
    h,
    setup.permissions ?? ALL_PERMISSIONS,
    setup.path ?? `/pwf/pwf-05?id=${PROJECT_ID}`,
  );
  return h;
};

const change = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const ready = async () => screen.findByTestId('start-form');
const goTo = (step: 1 | 2 | 3) => fireEvent.click(document.querySelector(`.pwfc-steps__button[data-step="${step}"]`) as HTMLElement);
const templates = async () => {
  await waitFor(() => expect(within(screen.getByTestId('kind-template')).getAllByRole('option').length).toBeGreaterThan(1));
};
const sent = (h: ReturnType<typeof open>, operation = 'startProjectWorkflow'): { path: unknown; body: Record<string, unknown> } => (h.command.mock.calls.find((call) => call[0] === operation) as [string, { path: unknown; body: Record<string, unknown> }])[1];

describe('PWF-05: choose the process and start the workflow of a project', () => {
  it('names the project, offers the processes of the rule and prefills the facts the project holds', async () => {
    open();
    await ready();
    expect(screen.getByText(/DA-2026-001/)).toBeTruthy();
    await templates();
    expect(within(screen.getByTestId('kind-template')).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', 'PUBLIC_INVESTMENT', 'PUBLIC_REPAIR']);
    expect((screen.getByTestId('kind-group') as HTMLSelectElement).value).toBe('B');
    expect((screen.getByTestId('kind-type') as HTMLSelectElement).value).toBe('CONSTRUCTION');
    expect((screen.getByTestId('kind-funding') as HTMLSelectElement).value).toBe('');
    expect(screen.getByRole('heading', { name: text('pwfp.choose.title') })).toBeTruthy();
  });

  it('asks the rule for the project and the facts, says what it suggests and why, and takes the suggestion on request', async () => {
    const h = open({ rule: () => suggestion({ suggested_template_code: 'PUBLIC_REPAIR', basis: 'RULE', line: 'REPAIR', rule: { rule_id: null, version: 4, unit_id: null, unverified: false } }) });
    const box = await screen.findByTestId('kind-suggestion');
    await waitFor(() => expect(box.textContent).toContain('PUBLIC_REPAIR'));
    expect(box.textContent).toContain(text('pwf.process.basis.rule.text', { line: 'REPAIR' }));
    const asked = (h.read.mock.calls.find((call) => call[0] === 'suggestProjectWorkflow') as [string, { query: Record<string, string> }])[1].query;
    expect(asked).toMatchObject({ project_id: PROJECT_ID, project_group: 'B', project_type: 'CONSTRUCTION' });
    await templates();
    change('kind-template', 'PUBLIC_INVESTMENT');
    fireEvent.click(await screen.findByTestId('use-suggestion'));
    expect((screen.getByTestId('kind-template') as HTMLSelectElement).value).toBe('PUBLIC_REPAIR');
    expect(screen.queryByTestId('use-suggestion')).toBeNull();
    expect(screen.queryByTestId('kind-reason')).toBeNull();
  });

  it('asks for a reason when another process than the suggested one is chosen, and sends it with the start', async () => {
    const h = open();
    await templates();
    change('kind-template', 'PUBLIC_REPAIR');
    goTo(2);
    change('kind-start', '2026-12-01');
    goTo(3);
    fireEvent.click(screen.getByTestId('submit-start'));
    expect(within(await screen.findByTestId('kind-problems')).getByRole('listitem').getAttribute('data-problem')).toBe('reasonRequired');
    expect(h.command).not.toHaveBeenCalled();
    change('kind-reason', 'Dự án sửa chữa theo quyết định của chủ đầu tư');
    goTo(3);
    fireEvent.click(screen.getByTestId('submit-start'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(sent(h).body).toMatchObject({ template_code: 'PUBLIC_REPAIR', planned_start_date: '2026-12-01', selection_reason: 'Dự án sửa chữa theo quyết định của chủ đầu tư' });
  });

  it('refuses a form with a problem, opens the step that holds it, says what, and sends nothing', async () => {
    const h = open();
    await ready();
    await templates();
    goTo(3);
    fireEvent.click(screen.getByTestId('submit-start'));
    const problems = await screen.findByTestId('kind-problems');
    expect(problems.getAttribute('data-step')).toBe('2');
    expect(within(problems).getByRole('listitem').textContent).toBe(text('pwf.process.problem.startRequired.text'));
    expect(screen.getByTestId('kind-start').getAttribute('aria-invalid')).toBe('true');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('starts the workflow with the facts that are not empty and goes to the workflow tab of the project', async () => {
    const h = open();
    await templates();
    change('kind-template', 'PUBLIC_INVESTMENT');
    change('kind-funding', 'STATE_BUDGET');
    goTo(2);
    change('kind-start', '2026-12-01');
    goTo(3);
    fireEvent.click(screen.getByTestId('submit-start'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h).path).toEqual({ project_id: PROJECT_ID });
    expect(sent(h).body).toEqual({ template_code: 'PUBLIC_INVESTMENT', planned_start_date: '2026-12-01', facts: { project_group: 'B', funding_source: 'STATE_BUDGET', project_type: 'CONSTRUCTION' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/prj/prj-03?id=${PROJECT_ID}&tab=workflow`));
  });

  it('starts with the process of the catalogue when the rule cannot be read, as it always did', async () => {
    const h = open({ rule: new Error('suggestion unavailable') });
    await ready();
    await templates();
    expect(screen.queryByTestId('kind-suggestion')?.textContent).not.toContain('PUBLIC_REPAIR');
    change('kind-template', 'PUBLIC_REPAIR');
    goTo(2);
    change('kind-start', '2026-12-01');
    goTo(3);
    fireEvent.click(screen.getByTestId('submit-start'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(sent(h).body).toMatchObject({ template_code: 'PUBLIC_REPAIR', planned_start_date: '2026-12-01' });
  });

  it('shows the schedule the choice gives, from the planned start, in the last step', async () => {
    open({ rule: () => suggestion({ preview: { units: withUnits({ unresolved: [] }) } }) });
    await templates();
    goTo(2);
    change('kind-start', '2026-12-01');
    goTo(3);
    expect((await screen.findByTestId('preview-finish')).textContent).toBe('15/03/2028');
  });

  it.each([
    ['PWF_FACTS_REQUIRED', 'pwf.problem.factsRequired.error'],
    ['PWF_WORKFLOW_EXISTS', 'pwf.problem.workflowExists.error'],
    ['PWF_TEMPLATE_NOT_FOUND', 'pwf.problem.templateNotFound.error'],
    ['SCOPE_DENIED', 'pwf.problem.denied.error'],
  ])('says in words that the server refused with %s and stays on the form', async (code, key) => {
    open({ commands: { startProjectWorkflow: refusal(code, code === 'SCOPE_DENIED' ? 403 : 422) } });
    await ready();
    await templates();
    change('kind-template', 'PUBLIC_INVESTMENT');
    goTo(2);
    change('kind-start', '2026-12-01');
    goTo(3);
    fireEvent.click(screen.getByTestId('submit-start'));
    expect((await screen.findByTestId('problem')).textContent).toContain(text(key));
    expect(screen.getByTestId('where').textContent).toBe(`/pwf/pwf-05?id=${PROJECT_ID}`);
  });
});

describe('PWF-05: the units of the process (R61)', () => {
  const unresolved = () => suggestion({ preview: { units: withUnits() } });

  it('does not start while a party has no unit: it opens the step of the units, names the party and sends nothing', async () => {
    const h = open({ rule: unresolved });
    await templates();
    change('kind-template', 'PUBLIC_INVESTMENT');
    goTo(2);
    change('kind-start', '2026-12-01');
    goTo(3);
    fireEvent.click(screen.getByTestId('submit-start'));
    const problems = await screen.findByTestId('kind-problems');
    expect(problems.getAttribute('data-step')).toBe('2');
    expect(within(problems).getByRole('listitem').textContent).toBe(text('pwfp.choose.problem.unitsRequired.text', { units: 'Đơn vị thẩm định' }));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('offers the unit tree of the tenant, never picks one for the person, and sends the unit chosen for exactly the party that was open', async () => {
    const h = open({ rule: unresolved });
    await templates();
    change('kind-template', 'PUBLIC_INVESTMENT');
    goTo(2);
    change('kind-start', '2026-12-01');
    const select = await screen.findByTestId('unit-PROJECT-PARTY-APPRAISER');
    expect((select as HTMLSelectElement).value).toBe('');
    await waitFor(() => expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([text('pwfp.choose.units.choose.option'), 'SO · Sở Xây dựng', '– PB · Phòng Thẩm định']));
    // What the project already answers is kept and not offered again.
    expect(screen.getByTestId('resolved-PROJECT_OWNER').textContent).toContain('Sở Giao thông');
    change('unit-PROJECT-PARTY-APPRAISER', 'u-pb');
    goTo(3);
    fireEvent.click(screen.getByTestId('submit-start'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(sent(h).body).toMatchObject({ planned_start_date: '2026-12-01', units: { 'PROJECT_PARTY:APPRAISER': 'u-pb' } });
  });

  it.each([
    ['PWF_UNIT_UNRESOLVED', 'pwfp.problem.unitUnresolved.error'],
    ['PWF_UNIT_OVERRIDE_DENIED', 'pwfp.problem.unitOverride.error'],
    ['PWF_UNIT_UNKNOWN', 'pwfp.problem.unitUnknown.error'],
  ])('says the refusal %s at the cell of the unit and in the banner', async (code, key) => {
    open({ rule: unresolved, commands: { startProjectWorkflow: refusal(code, 422, { unit_refs: ['PROJECT_PARTY:APPRAISER'] }) } });
    await templates();
    change('kind-template', 'PUBLIC_INVESTMENT');
    goTo(2);
    change('kind-start', '2026-12-01');
    await screen.findByTestId('unit-PROJECT-PARTY-APPRAISER');
    change('unit-PROJECT-PARTY-APPRAISER', 'u-so');
    goTo(3);
    fireEvent.click(screen.getByTestId('submit-start'));
    expect((await screen.findByTestId('problem')).textContent).toContain(text(key, { refs: 'PROJECT_PARTY:APPRAISER' }));
    goTo(2);
    expect(screen.getByTestId('unit-error-PROJECT_PARTY:APPRAISER').textContent).toBe(text(key, { refs: 'PROJECT_PARTY:APPRAISER' }));
  });

  it('says the tree of units could not be read, and still asks for a unit', async () => {
    const h = open({ rule: unresolved });
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.reject(new Error('units down')));
    await templates();
    goTo(2);
    change('kind-start', '2026-12-01');
    expect(await screen.findByTestId('units-failed')).toBeTruthy();
  });
});

describe('PWF-05: who sees what', () => {
  it('shows the form to a person who may start a workflow and nothing to a person who may do neither', async () => {
    const { unmount } = (() => {
      open({ permissions: ['pwf.read', 'pwf.workflow.manage'] });
      return { unmount: cleanup };
    })();
    await ready();
    expect(screen.queryByLabelText(text('pwf.start.mode.adopt.label'))).toBeNull();
    unmount();
    open({ permissions: READ_ONLY });
    expect((await screen.findByTestId('no-permission')).textContent).toBe(text('pwf.start.noPermission.notice'));
    expect(screen.queryByTestId('start-form')).toBeNull();
  });

  it('asks for a project when none is named and says so when the project is not found', async () => {
    open({ path: '/pwf/pwf-05' });
    expect((await screen.findByTestId('no-project')).textContent).toBe(text('pwf.start.noProject.notice'));
    cleanup();
    open({ project: refusal('RESOURCE_NOT_FOUND', 404) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('has no serious accessibility violation on the three steps', async () => {
    open({ rule: () => suggestion({ preview: { units: withUnits() } }) });
    const form = await ready();
    await templates();
    for (const step of [1, 2, 3] as const) {
      goTo(step);
      expect(describeViolations(await seriousViolations(form.closest('section') as HTMLElement))).toEqual([]);
    }
  });
});

describe('PWF-05: adopt the workflow of a running project', () => {
  const adopt = (over: Partial<Setup> = {}, dry: Answer = adoptResult()) =>
    open({ commands: { adoptProjectWorkflow: (input: Record<string, unknown>) => ((input.body as { dry_run: boolean }).dry_run ? dry : { ...adoptResult(), dry_run: false, applied: true, workflow_id: 'w1' }) }, ...over });
  const prepare = async () => {
    await ready();
    fireEvent.click(screen.getByLabelText(text('pwf.start.mode.adopt.label')));
    await templates();
    change('kind-template', 'PUBLIC_INVESTMENT');
    goTo(2);
    change('kind-start', '2026-01-05');
    change('effective-date', '2026-11-01');
    goTo(3);
  };
  const dryRun = async () => {
    fireEvent.click(screen.getByTestId('dry-run'));
    return screen.findByTestId('result');
  };

  it('asks for the effective date in the step of the day, and a dry run that is incomplete sends nothing', async () => {
    const h = adopt();
    await ready();
    fireEvent.click(screen.getByLabelText(text('pwf.start.mode.adopt.label')));
    goTo(2);
    expect(screen.getByTestId('effective-date')).toBeTruthy();
    goTo(3);
    fireEvent.click(screen.getByTestId('dry-run'));
    const problems = await screen.findByTestId('kind-problems');
    expect([...problems.querySelectorAll('li')].map((item) => item.getAttribute('data-problem'))).toContain('effectiveRequired');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('runs the dry run first, shows each task with its treatment, the schedule and the findings, and keeps the apply button off while a task waits for a decision', async () => {
    const h = adopt();
    await prepare();
    const result = await dryRun();
    expect(h.command.mock.calls[0]?.[0]).toBe('adoptProjectWorkflow');
    expect((h.command.mock.calls[0]?.[1] as { body: { dry_run: boolean } }).body.dry_run).toBe(true);
    expect(within(result).getByTestId('row-T1').textContent).toContain('Lập báo cáo nghiên cứu khả thi');
    expect(within(result).getByTestId('row-T3').textContent).toContain(text('pwf.start.treatment.excluded.word'));
    expect(within(result).getByTestId('findings').textContent).toContain('ACTUAL_DATES_MISSING');
    expect(screen.getByTestId('calendar-missing').textContent).toContain('2028');
    expect(screen.getByTestId('readiness').textContent).toBe(text('pwf.start.ready.pending.notice', { count: 1 }));
    expect((screen.getByTestId('apply') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('treatment-T1').querySelectorAll('option').length).toBe(3);
    expect(Array.from(screen.getByTestId('treatment-T2').querySelectorAll('option')).map((option) => option.getAttribute('value'))).toEqual(['TRACKED', 'IN_PROGRESS']);
  });

  it('marks a past task "not tracked", runs the dry run again, and then applies in one command with dry_run false', async () => {
    const h = adopt();
    await prepare();
    await dryRun();
    change('treatment-T1', 'NOT_TRACKED');
    expect(screen.getByTestId('readiness').textContent).toBe(text('pwf.start.ready.stale.notice'));
    fireEvent.click(screen.getByTestId('dry-run'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect((h.command.mock.calls[1]?.[1] as { body: { past_tasks: unknown } }).body.past_tasks).toEqual([{ task_code: 'T1', treatment: 'NOT_TRACKED' }]);
    await waitFor(() => expect(screen.getByTestId('readiness').textContent).toBe(text('pwf.start.ready.ready.notice')));
    fireEvent.click(screen.getByTestId('apply'));
    fireEvent.click(await screen.findByRole('button', { name: text('pwf.start.apply.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
    expect((h.command.mock.calls[2]?.[1] as { body: { dry_run: boolean } }).body.dry_run).toBe(false);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/prj/prj-03?id=${PROJECT_ID}&tab=workflow`));
  });

  it('asks a task that is done for its finish day and evidence, and says what is missing before it runs', async () => {
    const h = adopt();
    await prepare();
    await dryRun();
    change('treatment-T1', 'DONE');
    fireEvent.click(screen.getByTestId('dry-run'));
    expect((await screen.findByTestId('T1-actual-finish-error')).textContent).toBe(text('pwf.form.required.error'));
    expect(screen.getByTestId('T1-evidence-required').textContent).toBe(text('pwf.start.evidence.required.error'));
    expect(h.command).toHaveBeenCalledTimes(1);
    change('T1-actual-finish', '2026-06-30');
    fireEvent.click(document.querySelector('[data-action="add-T1-evidence"]') as HTMLElement);
    fireEvent.click(screen.getByTestId('dry-run'));
    expect((await screen.findByTestId('T1-evidence-0-kind-error')).textContent).toBe(text('pwf.form.required.error'));
    change('T1-evidence-0-kind', 'DOCUMENT');
    expect(screen.getByTestId('T1-evidence-0-external-error').textContent).toBe(text('pwf.start.evidence.pointer.error'));
    change('T1-evidence-0-document', '00000000-0000-4000-8000-000000000001');
    fireEvent.click(screen.getByTestId('dry-run'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect((h.command.mock.calls[1]?.[1] as { body: { past_tasks: unknown } }).body.past_tasks).toEqual([
      { task_code: 'T1', treatment: 'DONE', actual_finish: '2026-06-30', evidence: [{ evidence_kind: 'DOCUMENT', document_id: '00000000-0000-4000-8000-000000000001' }] },
    ]);
    fireEvent.click(document.querySelector('[data-action="remove-T1-evidence-0"]') as HTMLElement);
    expect(screen.queryByTestId('T1-evidence-0')).toBeNull();
  });

  it('takes the start and what remains of a task in progress', async () => {
    const h = adopt();
    await prepare();
    await dryRun();
    change('treatment-T2', 'IN_PROGRESS');
    fireEvent.click(screen.getByTestId('dry-run'));
    expect((await screen.findByTestId('T2-actual-start-error')).textContent).toBe(text('pwf.form.required.error'));
    expect(screen.getByTestId('T2-remaining-error').textContent).toBe(text('pwf.form.required.error'));
    change('T2-actual-start', '2026-10-05');
    change('T2-remaining', '4');
    change('T2-percent', '60');
    fireEvent.click(screen.getByTestId('dry-run'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect((h.command.mock.calls[1]?.[1] as { body: { in_progress_tasks: unknown } }).body.in_progress_tasks).toEqual([{ task_code: 'T2', actual_start: '2026-10-05', remaining_working_days: 4, percent_complete: 60 }]);
    change('treatment-T2', 'TRACKED');
    expect(screen.queryByTestId('T2-remaining')).toBeNull();
  });

  it('shows a refusal of the dry run in words', async () => {
    const h = open({ commands: { adoptProjectWorkflow: refusal('PWF_ADOPT_INVALID') } });
    await prepare();
    fireEvent.click(screen.getByTestId('dry-run'));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwf.problem.adoptInvalid.error'));
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal of the apply inside the confirmation', async () => {
    let calls = 0;
    const h = adopt({}, adoptResult({ tasks: [{ task_code: 'T2', name: 'Thẩm định', treatment: 'TRACKED', planned_start: null, planned_finish: null, needs_decision: false }] }));
    h.command.mockImplementation((_operation: string, input: unknown) => {
      calls += 1;
      return (input as { body: { dry_run: boolean } }).body.dry_run ? Promise.resolve(adoptResult({ tasks: [] })) : Promise.reject(refusal('PWF_WORKFLOW_EXISTS'));
    });
    await prepare();
    await dryRun();
    fireEvent.click(screen.getByTestId('apply'));
    fireEvent.click(await screen.findByRole('button', { name: text('pwf.start.apply.confirm.action') }));
    expect((await screen.findAllByTestId('problem'))[0]?.textContent).toContain(text('pwf.problem.workflowExists.error'));
    expect(calls).toBe(2);
  });

  it('has no serious accessibility violation with a dry run on the screen', async () => {
    adopt();
    await prepare();
    const result = await dryRun();
    change('treatment-T1', 'DONE');
    fireEvent.click(document.querySelector('[data-action="add-T1-evidence"]') as HTMLElement);
    expect(describeViolations(await seriousViolations(result.closest('section') as HTMLElement))).toEqual([]);
  });
});
