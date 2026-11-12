import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import { ALL_PERMISSIONS, PROJECT_ID, READ_ONLY, refusal, routeOf, schedulePreview, serve, text } from '../test/fixtures';
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

interface Setup {
  path?: string;
  permissions?: readonly string[];
  project?: Answer;
  commands?: Record<string, Answer>;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      get_resources_project_id: setup.project ?? projectBody(),
      getGovernanceRuleCatalog: catalogueBody(),
      getEffectiveGovernanceRule: (input: Record<string, unknown>) => effectiveBody(((input.query as Record<string, string>) ?? {}).code ?? 'PUBLIC_INVESTMENT'),
    },
    setup.commands ?? { startProjectWorkflow: { resource_id: 'w1', status: 'ACTIVE', resource_version: 1 } },
  );
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
const chooseTemplate = async (code = 'PUBLIC_INVESTMENT') => {
  await waitFor(() => expect(within(screen.getByTestId('template')).getAllByRole('option').length).toBeGreaterThan(1));
  change('template', code);
};

describe('PWF-05: start the workflow of a project', () => {
  it('names the project, offers only the templates in force and prefills the facts of the project', async () => {
    open();
    await ready();
    expect(screen.getByText(/DA-2026-001/)).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId('template')).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', 'PUBLIC_INVESTMENT', 'PUBLIC_REPAIR']));
    expect((screen.getByTestId('fact-project_group') as HTMLInputElement).value).toBe('B');
    expect((screen.getByTestId('fact-project_type') as HTMLInputElement).value).toBe('CONSTRUCTION');
    expect((screen.getByTestId('fact-funding_source') as HTMLInputElement).value).toBe('');
  });

  it('shows the template chosen with the label "default, not yet confirmed" when it is not confirmed, and its counts with an "i"', async () => {
    open();
    await ready();
    await chooseTemplate();
    const summary = await screen.findByTestId('template-summary');
    expect(within(summary).getByText(text('pwf.common.unverified.label'))).toBeTruthy();
    expect(summary.textContent).toContain('Mẫu PUBLIC_INVESTMENT');
    expect(within(summary).getByTestId('template-tasks').textContent).toContain('2');
    expect(within(summary).getAllByRole('button', { name: /govc|Công thức/ }).length).toBeGreaterThan(0);
    change('template', 'PUBLIC_REPAIR');
    await waitFor(() => expect(screen.queryByText(text('pwf.common.unverified.label'))).toBeNull());
  });

  it('refuses a form with a problem, says what and where, and sends nothing', async () => {
    const h = open();
    await ready();
    fireEvent.click(screen.getByTestId('submit-start'));
    expect((await screen.findByTestId('error-template')).textContent).toBe(text('pwf.form.pickOne.error'));
    expect(screen.getByTestId('error-plannedStart').textContent).toBe(text('pwf.form.required.error'));
    expect(screen.getByTestId('planned-start').getAttribute('aria-invalid')).toBe('true');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('starts the workflow with the facts that are not empty and goes to the workflow tab of the project', async () => {
    const h = open();
    await ready();
    await chooseTemplate('PUBLIC_REPAIR');
    change('planned-start', '2026-12-01');
    change('fact-funding_source', 'STATE_BUDGET');
    fireEvent.click(screen.getByTestId('submit-start'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('startProjectWorkflow');
    const input = h.command.mock.calls[0]?.[1] as { path: unknown; body: unknown };
    expect(input.path).toEqual({ project_id: PROJECT_ID });
    expect(input.body).toEqual({ template_code: 'PUBLIC_REPAIR', planned_start_date: '2026-12-01', facts: { project_group: 'B', funding_source: 'STATE_BUDGET', project_type: 'CONSTRUCTION' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/prj/prj-03?id=${PROJECT_ID}&tab=workflow`));
  });

  it.each([
    ['PWF_FACTS_REQUIRED', 'pwf.problem.factsRequired.error'],
    ['PWF_WORKFLOW_EXISTS', 'pwf.problem.workflowExists.error'],
    ['PWF_TEMPLATE_NOT_FOUND', 'pwf.problem.templateNotFound.error'],
    ['SCOPE_DENIED', 'pwf.problem.denied.error'],
  ])('says in words that the server refused with %s and stays on the form', async (code, key) => {
    open({ commands: { startProjectWorkflow: refusal(code, code === 'SCOPE_DENIED' ? 403 : 422) } });
    await ready();
    await chooseTemplate();
    change('planned-start', '2026-12-01');
    fireEvent.click(screen.getByTestId('submit-start'));
    expect((await screen.findByTestId('problem')).textContent).toContain(text(key));
    expect(screen.getByTestId('where').textContent).toBe(`/pwf/pwf-05?id=${PROJECT_ID}`);
  });

  it('previews the schedule of the template only for a person who may manage templates, and never guesses a date for a year without a calendar', async () => {
    const preview = schedulePreview({ project_finish: null, tasks: [{ ...schedulePreview().tasks[0]!, state: 'CALENDAR_UNAVAILABLE', missing_year: 2028, start: null, finish: null }] });
    const h = open({ commands: { previewProjectWorkflowTemplate: preview } });
    await ready();
    await chooseTemplate();
    change('planned-start', '2026-12-01');
    await screen.findByTestId('template-summary');
    fireEvent.click(screen.getByTestId('preview'));
    const result = await screen.findByTestId('preview-result');
    expect(h.command.mock.calls[0]?.[0]).toBe('previewProjectWorkflowTemplate');
    expect((h.command.mock.calls[0]?.[1] as { body: { planned_start_date: string } }).body.planned_start_date).toBe('2026-12-01');
    expect(result.textContent).toContain('01/12/2026');
    expect(screen.getByTestId('calendar-missing').textContent).toContain('2028');
  });

  it('hides the preview from a person who may not manage templates and the form from a person who may do neither', async () => {
    const { unmount } = (() => {
      open({ permissions: ['pwf.read', 'pwf.workflow.manage'] });
      return { unmount: cleanup };
    })();
    await ready();
    expect(screen.queryByTestId('preview')).toBeNull();
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

  it('has no serious accessibility violation', async () => {
    open();
    const form = await ready();
    fireEvent.click(screen.getByTestId('submit-start'));
    await screen.findByTestId('error-template');
    expect(describeViolations(await seriousViolations(form.closest('section') as HTMLElement))).toEqual([]);
  });
});

describe('PWF-05: adopt the workflow of a running project', () => {
  const adopt = (over: Partial<Setup> = {}, dry: Answer = adoptResult()) => {
    const h = open({ commands: { adoptProjectWorkflow: (input: Record<string, unknown>) => ((input.body as { dry_run: boolean }).dry_run ? dry : { ...adoptResult(), dry_run: false, applied: true, workflow_id: 'w1' }) }, ...over });
    return h;
  };
  const prepare = async () => {
    await ready();
    fireEvent.click(screen.getByLabelText(text('pwf.start.mode.adopt.label')));
    await chooseTemplate();
    change('planned-start', '2026-01-05');
    change('effective-date', '2026-11-01');
  };
  const dryRun = async () => {
    fireEvent.click(screen.getByTestId('dry-run'));
    return screen.findByTestId('result');
  };

  it('asks for the effective date, and a dry run that is incomplete sends nothing', async () => {
    const h = adopt();
    await ready();
    fireEvent.click(screen.getByLabelText(text('pwf.start.mode.adopt.label')));
    expect(screen.getByTestId('effective-date')).toBeTruthy();
    fireEvent.click(screen.getByTestId('dry-run'));
    expect((await screen.findByTestId('error-effectiveDate')).textContent).toBe(text('pwf.form.required.error'));
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

  it('shows a refusal of the dry run and of the apply in words', async () => {
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
