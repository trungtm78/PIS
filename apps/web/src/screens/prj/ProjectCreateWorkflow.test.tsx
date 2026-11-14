import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t as translate } from '../../i18n';
import vi_ from '../../i18n/vi.json';
import { suggestion } from '../pwf/process/test/fixtures';
import type { Suggestion } from '../pwf/process/model';
import ProjectCreateScreen from './ProjectCreateScreen';
import { AREA, MAKER, UNIT_DEPARTMENT, client, detail, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('PRJ-02', 'FR-PRJ-02');
const CREATED = detail(7, { code: 'DA-NEW' });
const WITH_WORKFLOWS = [...MAKER, 'pwf.read', 'pwf.workflow.manage'];
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);

afterEach(cleanup);

/** PRJ-02 over a client that also answers `suggestProjectWorkflow`; the queries it was asked are kept. */
function open(answer: (query: Record<string, string>) => Suggestion | Error = () => suggestion(), permissions: readonly string[] | null = WITH_WORKFLOWS, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'CONCEPT', resource_version: 1, resource_id: CREATED.id })) {
  const h = client(world({ details: [CREATED] }), command);
  const asked: Record<string, string>[] = [];
  const base = h.read.getMockImplementation() as (operation: string, input?: unknown) => Promise<unknown>;
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation !== 'suggestProjectWorkflow') return base(operation, input);
    const query = (input as { query: Record<string, string> }).query;
    asked.push(query);
    const reply = answer(query);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  // `null` stands for a session that lists no permissions at all (the development session of a demo build): unknown, the server decides.
  mount(<ProjectCreateScreen route={ROUTE} />, h, { permissions: permissions ?? undefined });
  return { h, asked };
}

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const ready = () => waitFor(() => expect(within(screen.getByLabelText(vi_['prj.form.owner.label'])).getAllByRole('option').length).toBeGreaterThan(1));
async function fill(): Promise<void> {
  await ready();
  set(vi_['prj.form.code.label'], 'DA-NEW');
  set(vi_['prj.form.name.label'], 'Cầu mới qua sông');
  set(vi_['prj.form.owner.label'], UNIT_DEPARTMENT);
  set(vi_['prj.form.area.label'], AREA);
  set(vi_['prj.form.total.label'], '500000000000');
}
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.create.submit.action'] }));
};
const bodyOf = (h: ReturnType<typeof open>['h']): Record<string, unknown> => (h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body;

describe('PRJ-02: the kind of workflow is chosen when the project is registered (R47)', () => {
  it('waits for the owner unit, then asks the rule for that unit and shows what it suggests', async () => {
    const { asked } = open();
    await ready();
    expect(screen.getByTestId('kind-suggestion').textContent).toBe(text('pwf.process.kind.waiting.text'));
    expect(asked).toEqual([]);
    set(vi_['prj.form.owner.label'], UNIT_DEPARTMENT);
    await waitFor(() => expect(screen.getByTestId('kind-suggestion').textContent).toContain('PUBLIC_INVESTMENT'));
    expect(asked[0]).toEqual({ owner_unit_id: UNIT_DEPARTMENT });
  });

  it('registers the project with the workflow the rule suggests: the planned start and the facts are sent, the template is left to the rule', async () => {
    const { h, asked } = open();
    await fill();
    await screen.findByTestId('kind-preview');
    fireEvent.change(screen.getByTestId('kind-start'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByTestId('kind-group'), { target: { value: 'B' } });
    fireEvent.change(screen.getByTestId('kind-funding'), { target: { value: 'STATE_BUDGET' } });
    await waitFor(() => expect(asked[asked.length - 1]).toEqual({ owner_unit_id: UNIT_DEPARTMENT, project_group: 'B', funding_source: 'STATE_BUDGET', planned_start_date: '2026-12-01' }));
    submit();
    await screen.findByTestId('created');
    expect(bodyOf(h).workflow).toEqual({ planned_start_date: '2026-12-01', facts: { project_group: 'B', funding_source: 'STATE_BUDGET' } });
    expect(screen.getByTestId('created-workflow').textContent).toBe(`${text('pwf6.kind.created.text')} ${text('pwf6.kind.created.open')}`);
    expect(within(screen.getByTestId('created-workflow')).getByRole('link').getAttribute('href')).toContain('tab=workflow');
  });

  it('asks for a reason before another template than the suggested one is sent, and sends it with the choice', async () => {
    const { h } = open();
    await fill();
    await screen.findByTestId('kind-preview');
    fireEvent.change(screen.getByTestId('kind-start'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByTestId('kind-template'), { target: { value: 'PUBLIC_REPAIR' } });
    submit();
    expect(within(await screen.findByTestId('kind-problems')).getByRole('listitem').textContent).toBe(text('pwf.process.problem.reasonRequired.text'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('kind-reason'), { target: { value: 'Dự án sửa chữa theo quyết định của chủ đầu tư' } });
    submit();
    await screen.findByTestId('created');
    expect(bodyOf(h).workflow).toEqual({ planned_start_date: '2026-12-01', template_code: 'PUBLIC_REPAIR', selection_reason: 'Dự án sửa chữa theo quyết định của chủ đầu tư' });
  });

  it('registers the project without a workflow when no planned start is given, and says where the workflow starts later', async () => {
    const { h } = open();
    await fill();
    await screen.findByTestId('kind-preview');
    submit();
    await screen.findByTestId('created');
    expect('workflow' in bodyOf(h)).toBe(false);
    expect(screen.getByTestId('created-workflow').textContent).toBe(text('pwf.process.kind.created.later'));
  });

  it('does not send a workflow that cannot start: a fact a branch reads is missing, and it says which', async () => {
    const { h } = open(() => suggestion({ preview: { missing_facts: ['funding_source'], project_finish: null, total_working_days: null } }));
    await fill();
    await screen.findByTestId('kind-preview');
    fireEvent.change(screen.getByTestId('kind-start'), { target: { value: '2026-12-01' } });
    submit();
    expect(within(await screen.findByTestId('kind-problems')).getByRole('listitem').textContent).toBe(text('pwf.process.problem.factsRequired.text', { facts: text('pwf.process.fact.funding.label') }));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('still registers the project when the caller may not start a workflow or the suggestion cannot be read', async () => {
    const denied = open(() => suggestion({ can_start: false }));
    await fill();
    await screen.findByTestId('kind-denied');
    expect((screen.getByTestId('kind-start') as HTMLInputElement).disabled).toBe(true);
    submit();
    await screen.findByTestId('created');
    expect('workflow' in bodyOf(denied.h)).toBe(false);
    cleanup();
    const failed = open(() => new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId: 'c', extensions: {} }));
    await fill();
    await screen.findByTestId('kind-failed');
    submit();
    await screen.findByTestId('created');
    expect('workflow' in bodyOf(failed.h)).toBe(false);
  });

  it('does not register the project without the workflow that was asked for: a planned start given while the suggestion cannot be read stops the save and says why', async () => {
    const { h } = open(() => new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId: 'c', extensions: {} }));
    await fill();
    await screen.findByTestId('kind-failed');
    fireEvent.change(screen.getByTestId('kind-start'), { target: { value: '2026-12-01' } });
    submit();
    expect(within(await screen.findByTestId('kind-problems')).getByRole('listitem').textContent).toBe(text('pwf.process.problem.suggestionUnavailable.text'));
    expect(h.command).not.toHaveBeenCalled();
    // Without the planned start the project is registered, as the notice of the section says.
    fireEvent.change(screen.getByTestId('kind-start'), { target: { value: '' } });
    submit();
    await screen.findByTestId('created');
    expect('workflow' in bodyOf(h)).toBe(false);
  });

  it('holds the form still while the rule is asked once more for the save: what is sent is what the answer was for', async () => {
    const { h } = open();
    await fill();
    await screen.findByTestId('kind-preview');
    fireEvent.change(screen.getByTestId('kind-start'), { target: { value: '2026-12-01' } });
    await waitFor(() => expect(screen.getByTestId('kind-preview')).toBeTruthy());
    // From now on the rule takes its time to answer.
    let answer: (value: unknown) => void = () => undefined;
    const base = h.read.getMockImplementation() as (operation: string, input?: unknown) => Promise<unknown>;
    h.read.mockImplementation((operation: string, input?: unknown) => (operation === 'suggestProjectWorkflow' ? new Promise((resolve) => (answer = resolve)) : base(operation, input)));
    submit();
    await waitFor(() => expect((screen.getByLabelText(vi_['prj.form.owner.label']) as HTMLSelectElement).disabled).toBe(true));
    expect((screen.getByTestId('kind-start') as HTMLInputElement).disabled).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
    answer(suggestion());
    await screen.findByTestId('created');
    expect(bodyOf(h)).toMatchObject({ owner_unit_id: UNIT_DEPARTMENT, workflow: { planned_start_date: '2026-12-01' } });
  });

  it('shows no section and asks nothing for a person who cannot read workflows (the screen is what it was)', async () => {
    const { asked } = open(() => suggestion(), MAKER);
    await fill();
    expect(screen.queryByTestId('process-kind')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('shows the section to a session that lists no permissions (unknown is not none): the read of the suggestion, which the server judges, decides', async () => {
    const { asked } = open(() => suggestion(), null);
    await fill();
    expect(await screen.findByTestId('process-kind')).toBeTruthy();
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked[0]).toMatchObject({ owner_unit_id: UNIT_DEPARTMENT });
  });

  it('says what the server refused when the workflow could not start with the registration', async () => {
    open(
      () => suggestion(),
      WITH_WORKFLOWS,
      () => new ApiError({ status: 422, code: 'PWF_FACTS_REQUIRED', correlationId: 'c', extensions: { fields: ['funding_source'] } }),
    );
    await fill();
    await screen.findByTestId('kind-preview');
    fireEvent.change(screen.getByTestId('kind-start'), { target: { value: '2026-12-01' } });
    submit();
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('created')).toBeNull();
  });
});
