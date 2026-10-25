import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ChainScreen from './ChainScreen';
import { PROJECT, UUID_A, chain, client, config, contractId, guestRequest, mount, request, requestId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-19', 'FR-CTR-19');
const PATH = `/ctr/ctr-19?project=${PROJECT}`;
const PERMISSIONS = ['change.read'];
const OK = { operation_id: 'o', status: 'SUBMITTED', resource_version: 1, resource_id: requestId(9) };
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<ChainScreen route={ROUTE} />, h, { permissions: PERMISSIONS, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const press = (id: string, command: string): void => {
  fireEvent.click(document.querySelector(`[data-request="${id}"] [data-command="${command}"]`) as HTMLElement);
};
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const submitDialog = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const columns = (): string[] => Array.from(document.querySelectorAll('[data-stage]')).map((column) => column.getAttribute('data-stage') as string);
const commandsOf = (id: string): string[] => Array.from(document.querySelectorAll(`[data-request="${id}"] [data-command]`)).map((button) => button.getAttribute('data-command') as string);

const threeTiers = (requests: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => chain({ requests, ...extra });

describe('ChainScreen (CTR-19): the chain of changes of a project', () => {
  it('asks for a project when the address names none, and reads its chain once one is chosen', async () => {
    const h = open(world(), { path: '/ctr/ctr-19' });
    expect((await screen.findByRole('heading', { level: 2, name: vi_['ctr.change.pick.project.title'] })).textContent).toBe(vi_['ctr.change.pick.project.title']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.change.board.title']);
    const options = Array.from(document.querySelectorAll('#change-project option')).map((option) => option.textContent);
    expect(options).toEqual([vi_['ctr.change.pick.project.choose'], 'DA-2026-001 · Dự án cầu', 'DA-2026-002 · Dự án đường']);
    fireEvent.change(document.getElementById('change-project') as HTMLElement, { target: { value: '' } });
    expect(h.read).not.toHaveBeenCalled();
    fireEvent.change(document.getElementById('change-project') as HTMLElement, { target: { value: PROJECT } });
    await screen.findByTestId('tiers');
    expect(h.read).toHaveBeenCalledWith('getChangeChain', { path: { id: PROJECT } });
  });

  it('UI-CTR-19: shows a column for each tier of the project with the requests in it, their figures and the tiers fixed by the first request', async () => {
    const state = world({
      chain: threeTiers(
        [
          request(1, { status: 'PROMOTED', actions: { promote: false, evaluate: false, withdraw: false }, status_reason: 'The event is a change.' }),
          request(2, { stage: 'PCO', code: 'PCO-001', parent_id: requestId(1), status: 'EVALUATED', evaluated_delta_vnd: '-3000000', actions: { promote: true, evaluate: true, withdraw: true } }),
        ],
        { config: config({ locked: true, locked_at: '2026-10-24T01:00:00.000Z', locked_by_change: { id: requestId(1), code: 'CE-001' } }) },
      ),
    });
    open(state);
    await screen.findByTestId('board');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.change.board.title']);
    expect(columns()).toEqual(['EVENT', 'PCO', 'CO']);
    expect(screen.getByTestId('tier-chain').textContent).toContain(`${text('ctr.change.tiers.count', { count: 3 })}: ${vi_['ctr.change.stage.event']} → PCO → CO`);
    expect(screen.getByTestId('locked').textContent).toBe(vi_['ctr.change.tiers.locked.badge']);
    expect(screen.getByTestId('locked-by').textContent).toBe(text('ctr.change.tiers.locked.by', { code: 'CE-001' }));
    const event = document.querySelector(`[data-request="${requestId(1)}"]`) as HTMLElement;
    expect(within(event).getByTestId('request-code').textContent).toBe('CE-001');
    expect(within(event).getByTestId('change-status').textContent).toBe(vi_['ctr.change.status.promoted']);
    expect(within(event).getByTestId('request-contract').textContent).toBe('HD-A-001');
    expect(within(event).getByTestId('request-reason').textContent).toBe('The owner instructed a wider footpath.');
    expect(within(event).getByTestId('request-status-reason').textContent).toBe('The event is a change.');
    expect(within(event).getByTestId('estimated').textContent).toBe(text('ctr.value.amount', { amount: '400.000.000' }));
    expect(within(event).getByTestId('evaluated').textContent).toBe(vi_['ctr.change.none.text']);
    expect(within(event).getByTestId('days').textContent).toBe(text('ctr.change.days.value', { days: 10 }));
    const pco = document.querySelector(`[data-request="${requestId(2)}"]`) as HTMLElement;
    expect(within(pco).getByTestId('evaluated').textContent).toBe(text('ctr.value.amount', { amount: '-3.000.000' }));
    expect(commandsOf(requestId(1))).toEqual([]);
    expect(commandsOf(requestId(2))).toEqual(['promote', 'evaluate', 'withdraw']);
    expect(screen.getByText(text('ctr.change.board.footer', { id: 'CTR-19', req: 'FR-CTR-19' }))).toBeTruthy();
  });

  it('links to the policy of the tiers and to the form for someone who may configure and raise, and to neither for someone who may not', async () => {
    open(world({ chain: threeTiers([request(1)]) }), { path: `${PATH}&contract=${contractId(1)}` });
    await screen.findByTestId('board');
    expect(screen.getByTestId('tiers-link').getAttribute('href')).toBe(`/ctr/ctr-20?project=${PROJECT}`);
    expect(screen.getByTestId('open-link').getAttribute('href')).toBe(`/ctr/ctr-07?contract=${contractId(1)}`);
    cleanup();
    open(world({ chain: threeTiers([request(1)], { actions: { configure: false, open: false } }) }));
    await screen.findByTestId('board');
    expect(screen.queryByTestId('tiers-link')).toBeNull();
    expect(screen.queryByTestId('open-link')).toBeNull();
    cleanup();
    open(world({ chain: threeTiers([request(1)]) }));
    await screen.findByTestId('board');
    expect(screen.getByTestId('open-link').getAttribute('href')).toBe('/ctr/ctr-07');
  });

  it('links a CO to the comparison with the contract, with the words of a decision for the one who may take it, and a request that is no CO to nothing', async () => {
    const co = (n: number, decide: boolean) => request(n, { stage: 'CO', code: `CO-00${n}`, status: 'EVALUATED', actions: { promote: false, evaluate: true, withdraw: true, decide } });
    open(world({ chain: threeTiers([request(1), co(2, true), co(3, false)]) }));
    await screen.findByTestId('board');
    const link = (id: string) => within(document.querySelector(`[data-request="${id}"]`) as HTMLElement).queryByTestId('decision-link');
    expect(link(requestId(1))).toBeNull();
    expect(link(requestId(2))?.textContent).toBe(vi_['ctr.change.action.decide']);
    expect(link(requestId(2))?.getAttribute('href')).toBe(`/ctr/ctr-08?project=${PROJECT}&request=${requestId(2)}`);
    expect(link(requestId(3))?.textContent).toBe(vi_['ctr.change.action.compare']);
    cleanup();
    open(world({ chain: chain({ config: undefined, requests: [guestRequest(1, { stage: 'CO' })], actions: { configure: false, open: false } }) }));
    await screen.findByTestId('board');
    expect(screen.queryByTestId('decision-link')).toBeNull();
  });

  it('says the tiers are not set when the project has none, to the owner and to a reader alike but in their own words', async () => {
    open(world({ chain: chain({ config: undefined }) }));
    expect((await screen.findByTestId('not-configured')).textContent).toBe(vi_['ctr.change.tiers.none.staff']);
    expect(screen.getByTestId('no-requests').textContent).toBe(vi_['ctr.change.board.empty']);
    expect(screen.queryByTestId('open-link')).toBeNull();
    cleanup();
    open(world({ chain: chain({ config: undefined, actions: { configure: false, open: false } }) }));
    expect((await screen.findByTestId('not-configured')).textContent).toBe(vi_['ctr.change.tiers.none.reader']);
  });

  it('shows a guest contractor the tier and the status of its requests and nothing of the assessment', async () => {
    open(world({ chain: chain({ config: undefined, requests: [guestRequest(1), guestRequest(2, { stage: 'PCO', code: 'PCO-001' })], actions: { configure: false, open: false } }) }));
    await screen.findByTestId('board');
    expect(columns()).toEqual(['EVENT', 'PCO']);
    expect(screen.queryByTestId('request-reason')).toBeNull();
    expect(screen.queryByTestId('figures')).toBeNull();
    expect(screen.queryByTestId('request-actions')).toBeNull();
    expect(screen.queryByTestId('tier-chain')).toBeNull();
    expect(screen.getAllByTestId('change-status').map((badge) => badge.textContent)).toEqual([vi_['ctr.change.status.submitted'], vi_['ctr.change.status.submitted']]);
  });

  it('offers no command in a read-only session', async () => {
    open(world({ chain: threeTiers([request(1)]) }), { mode: 'READ_ONLY' });
    await screen.findByTestId('board');
    expect(screen.queryByTestId('request-actions')).toBeNull();
    expect(screen.queryByTestId('open-link')).toBeNull();
  });

  it('names a request by its id when it has no code yet, and marks a withdrawn one as a warning', async () => {
    open(world({ chain: threeTiers([request(1, { code: null, status: 'WITHDRAWN', actions: { promote: false, evaluate: false, withdraw: false } })]) }));
    await screen.findByTestId('board');
    expect(screen.getByTestId('request-code').textContent).toBe(requestId(1));
    expect(screen.getByTestId('change-status').className).toContain('warning');
  });

  describe('the states', () => {
    it('answers a failed read with the error state and reads again when retried', async () => {
      const state = world({ failing: new Set(['getChangeChain']) });
      const h = open(state);
      const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
      state.failing.clear();
      fireEvent.click(retry);
      await screen.findByTestId('tiers');
      expect(h.read.mock.calls.filter(([operation]) => operation === 'getChangeChain')).toHaveLength(2);
    });

    it('answers a project the caller does not reach with the denied state', async () => {
      open(world({ chain: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }) }));
      expect((await screen.findByText(vi_['states.denied.title'])).textContent).toBe(vi_['states.denied.title']);
    });

    it('answers a chain that is not one with the empty state', async () => {
      open(world({ chain: {} }));
      expect((await screen.findByText(vi_['states.empty.title'])).textContent).toBe(vi_['states.empty.title']);
    });
  });

  describe('promoting a request', () => {
    it('AC-ST-CTR-006-2, UAT-AC308: asks for the reason, then promotes under the version the board showed and reads the chain again', async () => {
      const h = open(world({ chain: threeTiers([request(1, { version: 4 })]) }));
      await screen.findByTestId('board');
      press(requestId(1), 'promote');
      expect(screen.getByRole('dialog', { name: text('ctr.change.promote.title', { code: 'CE-001' }) })).toBeTruthy();
      submitDialog(vi_['ctr.change.promote.submit']);
      expect(within(dialog()).getByText(vi_['ctr.change.problem.required'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      type('change-reason', 'x'.repeat(2001));
      submitDialog(vi_['ctr.change.promote.submit']);
      expect(within(dialog()).getByText(vi_['ctr.change.problem.tooLong'])).toBeTruthy();
      type('change-reason', ' The event is a change that has to be priced. ');
      submitDialog(vi_['ctr.change.promote.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('promoteChangeRequest', expect.objectContaining({ path: { id: requestId(1) }, ifMatchVersion: 4, body: { reason: 'The event is a change that has to be priced.' } }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getChangeChain').length).toBeGreaterThan(1));
    });

    it('keeps the dialog open with the refusal of the server in words', async () => {
      for (const [error, expected] of [
        [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { reason: 'LAST_TIER' }), vi_['ctr.change.error.lastTier']],
        [problem('CHANGE_STATE_INVALID', 409), vi_['ctr.change.error.stateInvalid']],
        [problem('CONTRACT_STATE_INVALID', 409), vi_['ctr.change.error.contractState']],
        [problem('VERSION_CONFLICT', 409), vi_['ctr.change.error.versionConflict']],
        [problem('SCOPE_DENIED', 403), vi_['ctr.change.error.denied']],
      ] as const) {
        open(world({ chain: threeTiers([request(1)]) }), { command: () => error });
        await screen.findByTestId('board');
        press(requestId(1), 'promote');
        type('change-reason', 'Agreed.');
        submitDialog(vi_['ctr.change.promote.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.change.dialog.cancel'] }));
        expect(screen.queryByRole('dialog')).toBeNull();
        cleanup();
      }
    });

    it('closes without sending when the person cancels or closes the dialog', async () => {
      const h = open(world({ chain: threeTiers([request(1)]) }));
      await screen.findByTestId('board');
      press(requestId(1), 'promote');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.change.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('withdrawing a request', () => {
    it('asks for the reason and withdraws under the version the board showed', async () => {
      const h = open(world({ chain: threeTiers([request(1, { version: 2 })]) }));
      await screen.findByTestId('board');
      press(requestId(1), 'withdraw');
      submitDialog(vi_['ctr.change.withdraw.submit']);
      expect(within(dialog()).getByText(vi_['ctr.change.problem.required'])).toBeTruthy();
      type('change-reason', 'The owner changed their mind.');
      submitDialog(vi_['ctr.change.withdraw.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('withdrawChangeRequest', expect.objectContaining({ path: { id: requestId(1) }, ifMatchVersion: 2, body: { reason: 'The owner changed their mind.' } })));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });

  describe('assessing a request', () => {
    const pcoChain = (overrides: Record<string, unknown> = {}) =>
      world({ chain: threeTiers([request(2, { stage: 'PCO', code: 'PCO-001', version: 3, actions: { promote: true, evaluate: true, withdraw: true }, ...overrides })]) });

    it('AC-ST-CTR-006-2, UAT-AC308: starts from the estimate, asks for the cost, the schedule and the funding, and for the line of capital of an increase', async () => {
      const h = open(pcoChain());
      await screen.findByTestId('board');
      press(requestId(2), 'evaluate');
      expect((document.getElementById('change-evaluated') as HTMLInputElement).value).toBe('400000000');
      expect((document.getElementById('change-days') as HTMLInputElement).value).toBe('10');
      expect(within(dialog()).getByText(vi_['ctr.change.evaluate.line.required'])).toBeTruthy();
      type('change-evaluated', '');
      type('change-days', '');
      submitDialog(vi_['ctr.change.evaluate.submit']);
      expect(within(dialog()).getAllByText(vi_['ctr.change.problem.required'])).toHaveLength(3);
      type('change-evaluated', '5e8');
      type('change-days', '1.5');
      type('change-funding', 'x'.repeat(2001));
      type('change-scope', 'x'.repeat(2001));
      type('change-line', 'not-an-id');
      submitDialog(vi_['ctr.change.evaluate.submit']);
      expect(within(dialog()).getByText(vi_['ctr.change.problem.amount'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['ctr.change.problem.days'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['ctr.change.problem.uuid'])).toBeTruthy();
      expect(within(dialog()).getAllByText(vi_['ctr.change.problem.tooLong'])).toHaveLength(2);
      expect(h.command).not.toHaveBeenCalled();
      type('change-evaluated', '500000000');
      type('change-days', '20');
      type('change-funding', 'Paid from the line of the plan.');
      type('change-scope', 'Wider footpath along km 2.');
      type('change-line', UUID_A.toUpperCase());
      submitDialog(vi_['ctr.change.evaluate.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'evaluateChangeRequest',
        expect.objectContaining({
          path: { id: requestId(2) },
          ifMatchVersion: 3,
          body: { evaluated_delta_vnd: '500000000', schedule_impact_days: 20, funding_impact_note: 'Paid from the line of the plan.', scope_impact_note: 'Wider footpath along km 2.', allocation_line_id: UUID_A },
        }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('needs no line for a decrease, and says so', async () => {
      const h = open(pcoChain({ estimated_delta_vnd: '-3000000' }));
      await screen.findByTestId('board');
      press(requestId(2), 'evaluate');
      expect(within(dialog()).getByText(vi_['ctr.change.evaluate.line.optional'])).toBeTruthy();
      type('change-funding', 'Saved on the contract.');
      submitDialog(vi_['ctr.change.evaluate.submit']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('evaluateChangeRequest', expect.objectContaining({ body: { evaluated_delta_vnd: '-3000000', schedule_impact_days: 10, funding_impact_note: 'Saved on the contract.' } }));
    });

    it('starts again from the last assessment when the request is assessed a second time', async () => {
      open(pcoChain({ status: 'EVALUATED', evaluated_delta_vnd: '450000000', funding_impact_note: 'Revised.', scope_impact_note: 'Km 3.', allocation_line_id: UUID_A, schedule_impact_days: 12 }));
      await screen.findByTestId('board');
      press(requestId(2), 'evaluate');
      expect((document.getElementById('change-evaluated') as HTMLInputElement).value).toBe('450000000');
      expect((document.getElementById('change-funding') as HTMLTextAreaElement).value).toBe('Revised.');
      expect((document.getElementById('change-scope') as HTMLTextAreaElement).value).toBe('Km 3.');
      expect((document.getElementById('change-line') as HTMLInputElement).value).toBe(UUID_A);
    });

    it('shows the refusal of the capital when the line cannot take the increase', async () => {
      for (const [error, expected] of [
        [problem('ALLOCATION_UNAVAILABLE', 422, { reason: 'ABOVE_BLOCK' }), vi_['ctr.change.error.allocation']],
        [problem('ALLOCATION_UNAVAILABLE', 422, { reason: 'ALLOCATION_LINE_REQUIRED' }), vi_['ctr.change.error.lineRequired']],
        [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { reason: 'STAGE_NOT_EVALUATED' }), vi_['ctr.change.error.notEvaluated']],
        [new ApiError({ status: 0, code: 'NETWORK_ERROR', correlationId: 'c', extensions: {} }), vi_['ctr.change.error.general']],
      ] as const) {
        open(pcoChain(), { command: () => error });
        await screen.findByTestId('board');
        press(requestId(2), 'evaluate');
        type('change-funding', 'Paid from the plan.');
        type('change-line', UUID_A);
        submitDialog(vi_['ctr.change.evaluate.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        expect(screen.getByRole('dialog')).toBeTruthy();
        cleanup();
      }
    });
  });

  it('starts a dialog over when the request moves under it', async () => {
    const state = world({ chain: threeTiers([request(1, { version: 1 })]) });
    const h = open(state);
    await screen.findByTestId('board');
    press(requestId(1), 'withdraw');
    type('change-reason', 'First words');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.change.dialog.cancel'] }));
    state.chain = threeTiers([request(1, { version: 2 })]);
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    press(requestId(1), 'withdraw');
    expect((document.getElementById('change-reason') as HTMLTextAreaElement).value).toBe('');
  });
});
