import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness } from '../../sas/test-support';
import { PROJECT, handover, handoverId, mount, routeOf } from '../handover/test-support';
import EvaluationScreen from './EvaluationScreen';

const ROUTE = routeOf('AST-07', 'FR-AST-07');
const OFFICE = ['evaluation.trigger.manage'];
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000999';
const EVALUATION = '00000000-0000-4000-8000-0000000000e1';
const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

const trigger = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000a0${String(n).padStart(2, '0')}`,
  project: { id: PROJECT, code: 'DA-001', name: 'Cầu qua sông' },
  trigger_kind: 'POST_HANDOVER_12M',
  handover: { id: handoverId(1), handover_no: 'BG-001', accepted_on: '2027-01-15' },
  due_on: '2028-01-15',
  status: 'SCHEDULED',
  fired_at: null,
  evaluation: null,
  created_at: `2026-10-25T01:00:0${n}.000000Z`,
  version: 1,
  ...overrides,
});
const accepted = (n: number, overrides: Record<string, unknown> = {}) => handover(n, { status: 'ACCEPTED', accepted_at: '2027-01-15T03:00:00.000000Z', ...overrides });

afterEach(cleanup);

interface World {
  triggers?: unknown[];
  handovers?: unknown[];
  failing?: Set<string>;
  command?: (operation: string, input: unknown) => unknown;
}

function open(world: World = {}, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; query?: string } = {}) {
  const state = { triggers: world.triggers ?? [], handovers: world.handovers ?? [accepted(1)] };
  const h = harness((operation) => {
    if (world.failing?.has(operation)) return new Error('down');
    return new Error(`unexpected read ${operation}`);
  }, world.command ?? (() => ({ operation_id: 'o', status: 'SCHEDULED', resource_version: 1, resource_id: 'new' })));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (world.failing?.has(operation)) return Promise.reject(new Error('down'));
    if (operation === 'get_resources_project') return Promise.resolve([{ id: PROJECT, code: 'DA-001', name: 'Cầu qua sông' }, { id: OTHER_PROJECT, code: 'DA-002', name: 'Đường tỉnh' }]);
    if (operation === 'listEvaluationTriggers') return Promise.resolve(state.triggers);
    if (operation === 'get_resources_handover') return Promise.resolve(state.handovers);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  mount(<EvaluationScreen route={ROUTE} />, h, { permissions: options.permissions ?? OFFICE, path: `/ast/ast-07${options.query ?? `?project=${PROJECT}`}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, state };
}
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const scheduled = (h: ReturnType<typeof open>['h']) => h.command.mock.calls.filter((call) => call[0] === 'scheduleEvaluationTrigger').map((call) => call[1] as { path: { id: string }; body: Record<string, unknown> });
const acknowledged = (h: ReturnType<typeof open>['h']) => h.command.mock.calls.filter((call) => call[0] === 'acknowledgeEvaluationTrigger').map((call) => call[1] as { path: { id: string }; body: Record<string, unknown> });
const readsOf = (h: ReturnType<typeof open>['h'], operation: string): number => (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === operation).length;
const formReady = async (): Promise<HTMLElement> => {
  const form = await screen.findByTestId('schedule-form');
  await waitFor(() => expect((document.getElementById('evaluation-handover') as HTMLSelectElement).options.length).toBeGreaterThan(1));
  return form;
};

describe('EvaluationScreen (AST-07): the trigger of the evaluation after the investment', () => {
  it('UI-AST-07: asks for a project first and offers the projects of the register', async () => {
    open({}, { query: '' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(text('ast.evaluation.project.notice'));
    await waitFor(() => expect((document.getElementById('evaluation-project') as HTMLSelectElement).options.length).toBe(3));
    expect(screen.getByTestId('scope-note').textContent).toBe(text('ast.evaluation.scope.note'));
    expect(document.querySelector('[data-testid="schedule-form"]')).toBeNull();
  });

  it('UI-AST-07: lists the triggers of the project with the kind, the handover, the day, the status and the evaluation', async () => {
    const { h } = open({
      triggers: [
        trigger(1, { status: 'ACKNOWLEDGED', fired_at: '2028-01-15T02:00:00.000000Z', evaluation: { id: EVALUATION, evaluation_kind: 'FINAL', status: 'PLANNED' }, version: 3 }),
        trigger(2, { trigger_kind: 'MANUAL', handover: null, due_on: '2999-01-01', status: 'FIRED' }),
        trigger(3, { trigger_kind: 'SETTLEMENT_CLOSED', handover: null, due_on: '2999-02-01' }),
      ],
    });
    const table = await screen.findByTestId('triggers');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute('data-status')).toBe('ACKNOWLEDGED');
    expect(within(rows[0] as HTMLElement).getByText(text('ast.evaluation.kind.twelve'))).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('BG-001')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('2028-01-15')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(text('ast.evaluation.status.acknowledged'))).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(EVALUATION)).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(text('ast.evaluation.kind.manual'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(text('ast.evaluation.status.fired')).className).toBe('pill warn');
    expect(within(rows[2] as HTMLElement).getByText(text('ast.evaluation.kind.settlement'))).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(text('ast.evaluation.status.scheduled')).className).toBe('pill gray');
    expect(h.client.readAll).toHaveBeenCalledWith('listEvaluationTriggers', { query: { project_id: PROJECT } });
  });

  it('says when the project has no trigger yet', async () => {
    open({ triggers: [] });
    expect((await screen.findByTestId('empty')).textContent).toBe(text('ast.evaluation.empty.notice'));
  });

  it('UAT-AC394: offers only the accepted handovers of the project, proposes the day 12 months after the acceptance and sets the trigger', async () => {
    const { h } = open({ handovers: [accepted(1), handover(2, { status: 'DRAFT' }), accepted(3, { project_id: OTHER_PROJECT })] });
    const form = await formReady();
    const options = Array.from((document.getElementById('evaluation-handover') as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual(['—', 'BG-001 · 2027-01-15']);
    pick('evaluation-kind', 'POST_HANDOVER_12M');
    pick('evaluation-handover', handoverId(1));
    expect((document.getElementById('evaluation-due') as HTMLInputElement).value).toBe('2028-01-15');
    expect(screen.getByText(text('ast.evaluation.field.due.earliest', { day: '2028-01-15' }))).toBeTruthy();
    pick('evaluation-kind', 'POST_HANDOVER_24M');
    expect((document.getElementById('evaluation-due') as HTMLInputElement).value).toBe('2029-01-15');
    pick('evaluation-due', '2029-03-01');
    pick('evaluation-kind', 'POST_HANDOVER_12M');
    // A day the person typed is kept when the kind changes.
    expect((document.getElementById('evaluation-due') as HTMLInputElement).value).toBe('2029-03-01');
    fireEvent.submit(form);
    await waitFor(() => expect(scheduled(h)).toHaveLength(1));
    expect(scheduled(h)[0]).toEqual({ path: { id: PROJECT }, body: { trigger_kind: 'POST_HANDOVER_12M', due_on: '2029-03-01', source_handover_id: handoverId(1) }, attempt: expect.anything() });
    expect((await screen.findByTestId('schedule-saved')).textContent).toBe(text('ast.evaluation.form.saved'));
    expect((document.getElementById('evaluation-kind') as HTMLSelectElement).value).toBe('');
    await waitFor(() => expect(readsOf(h, 'listEvaluationTriggers')).toBeGreaterThan(1));
  });

  it('starts the forms over when another project is chosen: a draft or a refusal of one project is not sent for the next', async () => {
    const { h } = open({ command: () => problem('PROJECT_STAGE_INVALID') });
    const form = await formReady();
    pick('evaluation-kind', 'MANUAL');
    pick('evaluation-due', '2999-01-01');
    fireEvent.submit(form);
    await screen.findByTestId('schedule-refusal');
    pick('evaluation-project', OTHER_PROJECT);
    await waitFor(() => expect((document.getElementById('evaluation-kind') as HTMLSelectElement).value).toBe(''));
    expect((document.getElementById('evaluation-due') as HTMLInputElement).value).toBe('');
    expect(document.querySelector('[data-testid="schedule-refusal"]')).toBeNull();
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('sets a trigger by hand with no handover and sends no handover', async () => {
    const { h } = open();
    const form = await formReady();
    pick('evaluation-kind', 'MANUAL');
    expect(screen.getByText(text('ast.evaluation.field.handover.optional'))).toBeTruthy();
    pick('evaluation-due', ' 2999-01-01 ');
    fireEvent.submit(form);
    await waitFor(() => expect(scheduled(h)).toHaveLength(1));
    expect(scheduled(h)[0]?.body).toEqual({ trigger_kind: 'MANUAL', due_on: '2999-01-01' });
  });

  it('names what is wrong before sending: no kind, no handover for a trigger after one, a day that is not real or is before the earliest', async () => {
    const { h } = open();
    const form = await formReady();
    fireEvent.submit(form);
    expect(await screen.findAllByText(text('ast.evaluation.field.required.error'))).toHaveLength(2);
    pick('evaluation-kind', 'POST_HANDOVER_12M');
    expect(screen.getByText(text('ast.evaluation.field.handover.required'))).toBeTruthy();
    pick('evaluation-due', '2027-02-30');
    fireEvent.submit(form);
    expect(await screen.findByText(text('ast.evaluation.field.invalid.error'))).toBeTruthy();
    expect(screen.getByText(text('ast.evaluation.field.required.error'))).toBeTruthy();
    pick('evaluation-handover', handoverId(1));
    pick('evaluation-due', '2028-01-14');
    fireEvent.submit(form);
    expect(await screen.findByText(text('ast.evaluation.field.early.error', { day: '2028-01-15' }))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says in words why the server refused', async () => {
    for (const [error, expected] of [
      [problem('TRIGGER_DUPLICATE', {}, 409), text('ast.evaluation.problem.duplicate')],
      [problem('PROJECT_STAGE_INVALID'), text('ast.evaluation.problem.stage')],
      [problem('HANDOVER_NOT_ACCEPTED'), text('ast.evaluation.problem.notAccepted')],
      [problem('VALIDATION_FAILED', { reason: 'BEFORE_EARLIEST', earliest_due_on: '2028-01-15' }), text('ast.evaluation.problem.early', { day: '2028-01-15' })],
      [problem('VALIDATION_FAILED', { reason: 'BEFORE_EARLIEST' }), text('ast.evaluation.problem.earlyUnknown')],
      [problem('VALIDATION_FAILED', { reason: 'IN_THE_PAST' }), text('ast.evaluation.problem.past')],
      [problem('VALIDATION_FAILED', { reason: 'NOT_A_HANDOVER_OF_THE_PROJECT' }), text('ast.evaluation.problem.otherProject')],
      [problem('SCOPE_DENIED', {}, 403), text('ast.evaluation.problem.scopeDenied')],
      [problem('RESOURCE_NOT_FOUND', {}, 404), text('ast.evaluation.problem.notFound')],
      [problem('VALIDATION_FAILED'), text('ast.evaluation.problem.validation')],
      [problem('INTERNAL_ERROR', {}, 500), text('ast.evaluation.problem.general')],
    ] as const) {
      open({ command: () => error });
      const form = await formReady();
      pick('evaluation-kind', 'MANUAL');
      pick('evaluation-due', '2999-01-01');
      fireEvent.submit(form);
      expect((await screen.findByTestId('schedule-refusal')).textContent).toBe(expected);
      cleanup();
    }
  });

  it('UAT-AC394: acknowledges a fired trigger with the evaluation of MNE, and offers no such form while nothing has fired', async () => {
    const fired = trigger(2, { trigger_kind: 'MANUAL', handover: null, due_on: '2020-01-01', status: 'FIRED', fired_at: '2026-10-25T01:00:00.000000Z', version: 2 });
    const { h } = open({ triggers: [trigger(1), fired] });
    const form = await screen.findByTestId('acknowledge-form');
    pick('evaluation-ack-trigger', fired.id);
    pick('evaluation-ack-evaluation', `  ${EVALUATION}  `);
    fireEvent.submit(form);
    await waitFor(() => expect(acknowledged(h)).toHaveLength(1));
    expect(acknowledged(h)[0]).toEqual({ path: { id: fired.id }, body: { mne_evaluation_id: EVALUATION }, attempt: expect.anything() });
    expect((await screen.findByTestId('acknowledge-saved')).textContent).toBe(text('ast.evaluation.ack.saved'));
    expect((document.getElementById('evaluation-ack-evaluation') as HTMLInputElement).value).toBe('');
    cleanup();
    open({ triggers: [trigger(1)] });
    await screen.findByTestId('triggers');
    expect(document.querySelector('[data-testid="acknowledge-form"]')).toBeNull();
  });

  it('names what is wrong before acknowledging, and says in words why the server refused', async () => {
    const fired = trigger(2, { status: 'FIRED', fired_at: '2026-10-25T01:00:00.000000Z', version: 2 });
    const { h } = open({ triggers: [fired] });
    const form = await screen.findByTestId('acknowledge-form');
    fireEvent.submit(form);
    expect(await screen.findAllByText(text('ast.evaluation.field.required.error'))).toHaveLength(2);
    pick('evaluation-ack-trigger', fired.id);
    pick('evaluation-ack-evaluation', 'not an id');
    fireEvent.submit(form);
    expect(await screen.findByText(text('ast.evaluation.field.invalid.error'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    cleanup();
    for (const [error, expected] of [
      [problem('TRIGGER_STATE_INVALID', {}, 409), text('ast.evaluation.problem.state')],
      [problem('VALIDATION_FAILED', { reason: 'NOT_FOUND' }), text('ast.evaluation.problem.evaluationMissing')],
      [problem('VALIDATION_FAILED', { reason: 'NOT_AN_EVALUATION_OF_THE_PROJECT' }), text('ast.evaluation.problem.evaluationOther')],
    ] as const) {
      open({ triggers: [fired], command: () => error });
      const again = await screen.findByTestId('acknowledge-form');
      pick('evaluation-ack-trigger', fired.id);
      pick('evaluation-ack-evaluation', EVALUATION);
      fireEvent.submit(again);
      expect((await screen.findByTestId('acknowledge-refusal')).textContent).toBe(expected);
      cleanup();
    }
  });

  it('offers no form to one who may not set triggers or while the tenant is read-only, and shows the list in the second case', async () => {
    open({ triggers: [trigger(2, { status: 'FIRED' })] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('triggers');
    expect(document.querySelector('[data-testid="schedule-form"]')).toBeNull();
    expect(document.querySelector('[data-testid="acknowledge-form"]')).toBeNull();
    cleanup();
    const { h } = open({}, { permissions: ['project.read'] });
    expect((await screen.findByTestId('no-right')).textContent).toBe(text('ast.evaluation.noRight.notice'));
    expect(readsOf(h, 'listEvaluationTriggers')).toBe(0);
    expect(document.querySelector('[data-testid="schedule-form"]')).toBeNull();
  });

  it('says the accepted handovers could not be loaded, keeps the form and loads them again', async () => {
    const { h } = open({ failing: new Set(['get_resources_handover']) });
    expect(await screen.findByTestId('handovers-failed')).toBeTruthy();
    expect(screen.getByTestId('schedule-form')).toBeTruthy();
    expect(screen.queryByText(text('ast.evaluation.field.handover.none'))).toBeNull();
    const before = readsOf(h, 'get_resources_handover');
    fireEvent.click(screen.getByRole('button', { name: text('ast.evaluation.handovers.retry.action') }));
    await waitFor(() => expect(readsOf(h, 'get_resources_handover')).toBeGreaterThan(before));
  });

  it('says so when the project has no accepted handover', async () => {
    open({ handovers: [handover(2, { status: 'DRAFT' })] });
    expect(await screen.findByText(text('ast.evaluation.field.handover.none'))).toBeTruthy();
  });

  it('offers a retry when the triggers could not be read', async () => {
    const { h } = open({ failing: new Set(['listEvaluationTriggers']) });
    fireEvent.click(await screen.findByRole('button', { name: text('states.retry.action') }));
    await waitFor(() => expect(readsOf(h, 'listEvaluationTriggers')).toBeGreaterThanOrEqual(2));
    expect(document.querySelector('[data-testid="triggers"]')).toBeNull();
  });
});
