import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../sas/test-support';
import { suggestion } from '../process/test/fixtures';
import { ALL_PERMISSIONS, PROJECT_ID, routeOf, serve, text } from '../test/fixtures';
import StartWorkflowScreen from './StartWorkflowScreen';
import { catalogueBody, effectiveBody, projectBody } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-05');
const open = (answer: unknown = suggestion({ suggested_template_code: 'PUBLIC_REPAIR', basis: 'RULE', line: 'REPAIR', rule: { rule_id: null, version: 4, unit_id: null, unverified: false } })) => {
  const h = serve(
    {
      get_resources_project_id: projectBody(),
      getGovernanceRuleCatalog: catalogueBody(),
      getEffectiveGovernanceRule: (input: Record<string, unknown>) => effectiveBody(((input.query as Record<string, string>) ?? {}).code ?? 'PUBLIC_INVESTMENT'),
      suggestProjectWorkflow: answer,
    },
    { startProjectWorkflow: { resource_id: 'w1', status: 'ACTIVE', resource_version: 1 } },
  );
  mount(<StartWorkflowScreen route={route} />, h, ALL_PERMISSIONS, `/pwf/pwf-05?id=${PROJECT_ID}`);
  return h;
};
const change = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const startBody = (h: ReturnType<typeof open>): Record<string, unknown> => (h.command.mock.calls.find((call) => call[0] === 'startProjectWorkflow') as [string, { body: Record<string, unknown> }])[1].body;

describe('PWF-05: the rule suggests the kind of workflow of the project (R47)', () => {
  it('asks the rule for the project, says what it suggests and why, and takes the suggestion on request', async () => {
    const h = open();
    const panel = await screen.findByTestId('suggestion');
    expect(panel.textContent).toContain('PUBLIC_REPAIR');
    expect(panel.textContent).toContain(text('pwf.process.basis.rule.text', { line: 'REPAIR' }));
    expect(panel.textContent).toContain(text('pwf.process.kind.ruleVersion.text', { version: 4 }));
    const asked = (h.read.mock.calls.find((call) => call[0] === 'suggestProjectWorkflow') as [string, { query: Record<string, string> }])[1].query;
    expect(asked.project_id).toBe(PROJECT_ID);
    await waitFor(() => expect(within(screen.getByTestId('template')).getAllByRole('option').length).toBeGreaterThan(1));
    fireEvent.click(screen.getByTestId('use-suggestion'));
    expect((screen.getByTestId('template') as HTMLSelectElement).value).toBe('PUBLIC_REPAIR');
    expect(screen.queryByTestId('use-suggestion')).toBeNull();
    expect(screen.queryByTestId('selection-reason')).toBeNull();
    change('planned-start', '2026-12-01');
    fireEvent.click(screen.getByTestId('submit-start'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect('selection_reason' in startBody(h)).toBe(false);
  });

  it('asks for a reason when another template than the suggested one is chosen, and sends the reason with the start', async () => {
    const h = open();
    await screen.findByTestId('suggestion');
    await waitFor(() => expect(within(screen.getByTestId('template')).getAllByRole('option').length).toBeGreaterThan(1));
    change('template', 'PUBLIC_INVESTMENT');
    change('planned-start', '2026-12-01');
    fireEvent.click(screen.getByTestId('submit-start'));
    expect((await screen.findByTestId('error-selectionReason')).textContent).toBe(text('pwf.process.problem.reasonRequired.text'));
    expect(h.command).not.toHaveBeenCalled();
    change('selection-reason', 'Dự án xây dựng mới theo quyết định đầu tư');
    fireEvent.click(screen.getByTestId('submit-start'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(startBody(h)).toMatchObject({ template_code: 'PUBLIC_INVESTMENT', planned_start_date: '2026-12-01', selection_reason: 'Dự án xây dựng mới theo quyết định đầu tư' });
  });

  it('says that the rule suggests nothing, and then asks for no reason', async () => {
    const h = open(suggestion({ suggested_template_code: null, basis: 'NONE', preview: null }));
    expect((await screen.findByTestId('suggestion')).textContent).toBe(text('pwf.process.basis.none.text'));
    await waitFor(() => expect(within(screen.getByTestId('template')).getAllByRole('option').length).toBeGreaterThan(1));
    change('template', 'PUBLIC_INVESTMENT');
    change('planned-start', '2026-12-01');
    expect(screen.queryByTestId('selection-reason')).toBeNull();
    fireEvent.click(screen.getByTestId('submit-start'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
  });

  it('works as it always did when the suggestion cannot be read', async () => {
    const h = open(new Error('suggestion unavailable'));
    await screen.findByTestId('start-form');
    await waitFor(() => expect(within(screen.getByTestId('template')).getAllByRole('option').length).toBeGreaterThan(1));
    expect(screen.queryByTestId('suggestion')).toBeNull();
    change('template', 'PUBLIC_INVESTMENT');
    change('planned-start', '2026-12-01');
    fireEvent.click(screen.getByTestId('submit-start'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(startBody(h)).toEqual({ template_code: 'PUBLIC_INVESTMENT', planned_start_date: '2026-12-01', facts: expect.any(Object) });
  });
});
