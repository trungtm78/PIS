import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { acceptance, acceptanceId } from '../acceptance/test-support';
import { PROJECT, UUID_A, active, chain, client, contractId, mount, request, requestId, routeOf, world } from '../change/test-support';
import type { Harness, World } from '../change/test-support';
import RetroactiveScreen from './RetroactiveScreen';

const ROUTE = routeOf('CTR-14', 'FR-CTR-14');
const PATH = `/ctr/ctr-14?id=${contractId(1)}`;
const OK = { operation_id: 'o', status: 'APPROVED', resource_version: 5, resource_id: requestId(1) };
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const MAY = { promote: false, evaluate: true, withdraw: true, decide: true, adjust: true };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A CO that was assessed (+100,000,000, 20 days) that the caller may approve retroactively. */
const evaluated = (n = 1, overrides: Record<string, unknown> = {}) => request(n, { stage: 'CO', code: `CO-00${n}`, status: 'EVALUATED', version: 4, evaluated_delta_vnd: '100000000', schedule_impact_days: 20, actions: MAY, ...overrides });
/** The approved acceptances of the contract, dated 25 July and 2 August. */
const acceptances = () => [
  acceptance(1, { status: 'APPROVED', accepted_on: '2026-07-25', accepted_amount_vnd: '1000000000' }),
  acceptance(2, { status: 'APPROVED', accepted_on: '2026-08-02', accepted_amount_vnd: '210000000' }),
  acceptance(3, { status: 'DRAFT', accepted_on: '2026-08-03' }),
  acceptance(4, { status: 'APPROVED', accepted_on: '2026-05-01', accepted_amount_vnd: '5000' }),
];
const stateOf = (overrides: Partial<World> = {}): World => world({ chain: chain({ requests: [evaluated()] }), details: [active({ completion_due: '2026-12-25' })], ...overrides });

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string; rows?: Array<Record<string, unknown>>; permissions?: string[] } = {}): Harness {
  const h = client(state, options.command ?? (() => OK));
  const base = (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll;
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: unknown) => (operation === 'get_resources_acceptance' ? Promise.resolve(options.rows ?? acceptances()) : base(operation, input)));
  mount(<RetroactiveScreen route={ROUTE} />, h, { permissions: options.permissions ?? ['contract.read', 'change.retroactive.approve'], path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['ctr.retro.submit'] }));
};
const tick = (id: string): void => {
  fireEvent.click(document.querySelector(`input[data-acceptance="${id}"]`) as HTMLElement);
};
const fill = (): void => {
  type('retro-day', '2026-06-01');
  type('retro-document', UUID_A);
  type('retro-basis', 'The owner agreed the new price from 1 June.');
  type('retro-lines', '[{"business_key":"B02","description":"Item","unit_code":"M3","quantity":"500","unit_price":"2100000"}]');
};

describe('RetroactiveScreen (CTR-14): the delays of a contract and the retroactive adjustment of its change orders', () => {
  it('asks for a contract when the address names none, and opens the one that is chosen', async () => {
    open(stateOf(), { path: '/ctr/ctr-14' });
    await screen.findByRole('heading', { level: 2, name: vi_['ctr.retro.pick.title'] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.retro.title']);
    expect(document.querySelectorAll('#retro-contract option')).toHaveLength(5);
    fireEvent.change(document.getElementById('retro-contract') as HTMLElement, { target: { value: '' } });
    expect(screen.queryByTestId('delay-facts')).toBeNull();
    fireEvent.change(document.getElementById('retro-contract') as HTMLElement, { target: { value: contractId(1) } });
    await screen.findByTestId('delay-facts');
  });

  it('UI-CTR-14: summarizes the delays: the completion day of the contract, the days of the approved COs, the day it moves to, and the days of the ones that wait', async () => {
    open(
      stateOf({
        chain: chain({
          requests: [
            evaluated(1),
            evaluated(2, { status: 'APPROVED', schedule_impact_days: 15, retroactive: true, effective_on: '2026-06-01', actions: { ...MAY, adjust: false } }),
            evaluated(3, { status: 'APPROVED', schedule_impact_days: -5, actions: { ...MAY, adjust: false } }),
          ],
        }),
      }),
    );
    await screen.findByTestId('delay-facts');
    expect(screen.getByTestId('contract-code').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('planned-due').textContent).toBe('2026-12-25');
    expect(screen.getByTestId('approved-days').textContent).toBe(text('ctr.retro.days.value', { days: '+10' }));
    expect(screen.getByTestId('forecast-due').textContent).toBe('2027-01-04');
    expect(screen.getByTestId('waiting-days').textContent).toBe(text('ctr.retro.days.value', { days: '+20' }));
    const lines = within(screen.getByTestId('delay-lines')).getAllByRole('listitem');
    expect(lines.map((item) => item.textContent)).toEqual([
      text('ctr.retro.delay.line.waiting', { code: 'CO-001', days: text('ctr.retro.days.value', { days: '+20' }) }),
      `${text('ctr.retro.delay.line.approved', { code: 'CO-002', days: text('ctr.retro.days.value', { days: '+15' }) })} · ${vi_['ctr.retro.delay.line.retroactive']}`,
      text('ctr.retro.delay.line.approved', { code: 'CO-003', days: text('ctr.retro.days.value', { days: '-5' }) }),
    ]);
    expect(screen.getByTestId('board-link').getAttribute('href')).toBe(`/ctr/ctr-19?project=${PROJECT}&contract=${contractId(1)}`);
    expect(screen.getByText(vi_['ctr.retro.delay.note'])).toBeTruthy();
    expect(screen.getByText(text('ctr.retro.footer', { id: 'CTR-14', req: 'FR-CTR-14' }))).toBeTruthy();
  });

  it('says so when no change order moves the schedule, and when the contract has no completion day', async () => {
    open(stateOf({ chain: chain({ requests: [] }), details: [active({ completion_due: null })] }));
    await screen.findByTestId('delay-facts');
    expect(screen.getByTestId('delay-none').textContent).toBe(vi_['ctr.retro.delay.none']);
    expect(screen.getByTestId('planned-due').textContent).toBe(vi_['ctr.retro.none.text']);
    expect(screen.getByTestId('forecast-due').textContent).toBe(vi_['ctr.retro.none.text']);
    expect(screen.getByTestId('no-command').textContent).toBe(vi_['ctr.retro.none.notice']);
  });

  describe('approving retroactively', () => {
    it('AC-ST-CTR-016-1, UAT-AC58: asks for everything the server asks for, then approves under the version it showed and tells it', async () => {
      const h = open(stateOf());
      await screen.findByTestId('request-code');
      expect(screen.getByTestId('request-code').textContent).toBe('CO-001');
      expect(screen.getByTestId('request-delta').textContent).toBe(` · ${text('ctr.value.amount', { amount: '100.000.000' })}`);
      expect((document.getElementById('retro-delta') as HTMLInputElement).value).toBe('100000000');
      expect(screen.getByTestId('affected-none').textContent).toBe(vi_['ctr.retro.field.affected.none']);
      submit();
      expect(screen.getAllByText(vi_['ctr.change.problem.required'])).toHaveLength(3);
      expect(h.command).not.toHaveBeenCalled();
      type('retro-day', '2999-01-01');
      type('retro-document', 'nope');
      type('retro-delta', '1e8');
      type('retro-lines', '{');
      type('retro-basis', 'Words.');
      submit();
      expect(screen.getByText(vi_['ctr.retro.problem.notPast'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.change.problem.uuid'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.change.problem.amount'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.retro.problem.json'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();

      type('retro-delta', '100000000');
      fill();
      // Only the approved acceptances from the day on are offered: 25 July and 2 August, not the draft and not the one of 1 May.
      const choices = within(screen.getByTestId('affected-choices')).getAllByRole('listitem');
      expect(choices.map((item) => item.textContent?.trim())).toEqual([
        text('ctr.retro.field.affected.option', { no: 'NT-001', day: '2026-07-25', amount: '1.000.000.000' }),
        text('ctr.retro.field.affected.option', { no: 'NT-002', day: '2026-08-02', amount: '210.000.000' }),
      ]);
      tick(acceptanceId(1));
      tick(acceptanceId(2));
      tick(acceptanceId(2));
      submit();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'approveRetroactiveAdjustment',
        expect.objectContaining({
          path: { id: requestId(1) },
          ifMatchVersion: 4,
          body: {
            adjustment_basis: 'The owner agreed the new price from 1 June.',
            decision_document_version_id: UUID_A,
            affected_acceptance_ids: [acceptanceId(1)],
            effective_on: '2026-06-01',
            approved_delta_vnd: '100000000',
            boq_lines: [{ business_key: 'B02', description: 'Item', unit_code: 'M3', quantity: '500', unit_price: '2100000' }],
          },
        }),
      );
      expect((await screen.findByTestId('done')).textContent).toContain(text('ctr.retro.done.notice', { code: 'CO-001' }));
      expect(screen.getByTestId('versions-link').getAttribute('href')).toBe(`/ctr/ctr-26?id=${contractId(1)}`);
    });

    it('keeps the form and says why when the server refuses, in the words of the refusal', async () => {
      const refusals: Array<[Error, string]> = [
        [problem('SETTLEMENT_ALREADY_APPROVED', 409, { settlement_id: 's' }), 'ctr.change.error.settlementApproved'],
        [problem('VALUE_EXCEEDED', 409, { rule: 'REQUESTED_LE_ACCEPTED' }), 'ctr.change.error.valueExceeded'],
        [problem('ACCEPTANCE_STATE_INVALID', 409, { reason: 'NOT_ON_LEDGER' }), 'ctr.change.error.notOnLedger'],
        [problem('SELF_APPROVAL_DENIED', 403), 'ctr.change.error.selfApproval'],
        [problem('VERSION_CONFLICT'), 'ctr.change.error.versionConflict'],
      ];
      for (const [error, key] of refusals) {
        const h = open(stateOf(), { command: () => error });
        await screen.findByTestId('request-code');
        fill();
        submit();
        await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
        expect((await screen.findByTestId('refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
        expect((document.getElementById('retro-basis') as HTMLTextAreaElement).value).toBe('The owner agreed the new price from 1 June.');
        expect(screen.queryByTestId('done')).toBeNull();
        cleanup();
      }
    });

    it('says which acceptances the list left out and which it named in vain, and puts the list right on request', async () => {
      const mismatch = problem('VALIDATION_FAILED', 422, { reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [acceptanceId(2)], unexpected_acceptance_ids: [acceptanceId(1), UUID_A] });
      const h = open(stateOf(), { command: () => mismatch });
      await screen.findByTestId('request-code');
      fill();
      tick(acceptanceId(1));
      submit();
      await screen.findByTestId('mismatch');
      expect(screen.getByTestId('refusal').textContent).toBe(vi_['ctr.change.error.affectedMismatch']);
      expect(screen.getByTestId('mismatch-missing').textContent).toBe(text('ctr.retro.mismatch.missing', { list: 'NT-002' }));
      expect(screen.getByTestId('mismatch-unexpected').textContent).toBe(text('ctr.retro.mismatch.unexpected', { list: `NT-001, ${UUID_A}` }));
      fireEvent.click(screen.getByTestId('mismatch-apply'));
      expect((document.querySelector(`input[data-acceptance="${acceptanceId(1)}"]`) as HTMLInputElement).checked).toBe(false);
      expect((document.querySelector(`input[data-acceptance="${acceptanceId(2)}"]`) as HTMLInputElement).checked).toBe(true);
      expect(h.command).toHaveBeenCalledTimes(1);
    });

    it('shows only the half of the mismatch the server found', async () => {
      open(stateOf(), { command: () => problem('VALIDATION_FAILED', 422, { reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [acceptanceId(1)], unexpected_acceptance_ids: [] }) });
      await screen.findByTestId('request-code');
      fill();
      submit();
      await screen.findByTestId('mismatch');
      expect(screen.getByTestId('mismatch-missing')).toBeTruthy();
      expect(screen.queryByTestId('mismatch-unexpected')).toBeNull();
    });

    it('reads the lost answer again with the same attempt: the idempotency key and the version of the first request are kept', async () => {
      const calls: Array<{ attempt: unknown; ifMatchVersion: unknown }> = [];
      let n = 0;
      const h = open(stateOf(), {
        command: (_operation, input) => {
          const { attempt, ifMatchVersion } = input as { attempt: unknown; ifMatchVersion: unknown };
          calls.push({ attempt, ifMatchVersion });
          n += 1;
          return n === 1 ? new Error('network') : OK;
        },
      });
      await screen.findByTestId('request-code');
      fill();
      submit();
      await screen.findByTestId('refusal');
      submit();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(calls[1]?.ifMatchVersion).toBe(calls[0]?.ifMatchVersion);
      expect(calls[1]?.attempt).toEqual(calls[0]?.attempt);
    });

    it('is read-only while the approval is on its way: the button says so, is off, and a second click sends nothing', async () => {
      const h = open(stateOf(), { command: () => new Promise(() => undefined) });
      await screen.findByTestId('request-code');
      fill();
      submit();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const button = await screen.findByRole('button', { name: vi_['ctr.change.dialog.pending'] });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(button.closest('form') as HTMLElement);
      expect(h.command).toHaveBeenCalledTimes(1);
    });

    it('offers each assessed CO to choose from when there are several, and approves the one chosen', async () => {
      const h = open(stateOf({ chain: chain({ requests: [evaluated(1), evaluated(2, { version: 7 })] }) }));
      await screen.findByTestId('request-code');
      expect(screen.getByTestId('request-code').textContent).toBe('CO-001');
      expect(document.querySelectorAll('#retro-request option')).toHaveLength(2);
      fireEvent.change(document.getElementById('retro-request') as HTMLElement, { target: { value: requestId(2) } });
      await waitFor(() => expect(screen.getByTestId('request-code').textContent).toBe('CO-002'));
      fill();
      submit();
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('approveRetroactiveAdjustment', expect.objectContaining({ path: { id: requestId(2) }, ifMatchVersion: 7 })));
    });

    it('starts at the CO the address names', async () => {
      open(stateOf({ chain: chain({ requests: [evaluated(1), evaluated(2)] }) }), { path: `${PATH}&request=${requestId(2)}` });
      await screen.findByTestId('request-code');
      expect(screen.getByTestId('request-code').textContent).toBe('CO-002');
    });

    it('offers no form to a caller who may not, to a read-only session, or to a contract without an assessed CO, and says why', async () => {
      open(stateOf({ chain: chain({ requests: [evaluated(1, { actions: { ...MAY, adjust: false } })] }) }));
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.retro.none.notice']);
      expect(document.getElementById('retro-day')).toBeNull();
      cleanup();
      open(stateOf(), { mode: 'READ_ONLY' });
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.retro.readOnly.notice']);
      expect(document.getElementById('retro-day')).toBeNull();
      cleanup();
      open(stateOf({ chain: chain({ requests: [] }) }), { mode: 'READ_ONLY' });
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.retro.readOnly.notice']);
    });
  });

  describe('the adjustments made', () => {
    const adjustment = (overrides: Record<string, unknown> = {}) => ({
      id: 'adj-1',
      change_request_id: requestId(2),
      change_request_code: 'CO-002',
      revision_id: 'rev-2',
      effective_on: '2026-06-01',
      approved_on: '2026-08-10',
      basis: 'The owner agreed the new price from 1 June.',
      decision_document_version_id: UUID_A,
      total_delta_vnd: '49999000',
      affected: [
        { id: 'l1', acceptance_id: acceptanceId(1), acceptance_no: 'NT-001', boq_item_key: 'B02', party_id: null, quantity: '500.000000', old_amount_vnd: '1000000000', new_unit_price: '2100000.000000', new_amount_vnd: '1050000000', delta_vnd: '50000000' },
        { id: 'l2', acceptance_id: acceptanceId(2), acceptance_no: 'NT-002', boq_item_key: 'B05', party_id: null, quantity: '10.000000', old_amount_vnd: '10000', new_unit_price: '900.000000', new_amount_vnd: '9000', delta_vnd: '-1000' },
      ],
      ...overrides,
    });

    it('UI-CTR-14: lists, for each adjustment, the day, the basis, the total and the balances it moved with the sign of each difference', async () => {
      open(stateOf({ chain: chain({ requests: [] }), details: [active({ retroactive_adjustments: [adjustment(), adjustment({ id: 'adj-2', change_request_code: null, affected: [], total_delta_vnd: '0' })] })] }));
      const history = await screen.findByTestId('history');
      const [first, second] = Array.from(history.querySelectorAll('[data-adjustment-item]')) as HTMLElement[];
      expect(within(first!).getByTestId('adjustment-effective').textContent).toBe('2026-06-01');
      expect(within(first!).getByTestId('adjustment-basis').textContent).toBe('The owner agreed the new price from 1 June.');
      expect(within(first!).getByTestId('adjustment-total').textContent).toBe(text('ctr.value.amount', { amount: '+49.999.000' }));
      expect(within(first!).getAllByTestId('line-delta').map((cell) => cell.textContent)).toEqual(['+50.000.000', '-1.000']);
      expect(within(first!).getByText('NT-001')).toBeTruthy();
      expect(within(second!).getByTestId('adjustment-none').textContent).toBe(vi_['ctr.retro.history.none']);
      expect(within(second!).getByRole('heading', { level: 3 }).textContent).toBe(requestId(2));
    });

    it('shows no history to a reader whose answer has none', async () => {
      open(stateOf());
      await screen.findByTestId('delay-facts');
      expect(screen.queryByTestId('history')).toBeNull();
    });

  });

  it('shows the failure of a read and reads again on request', async () => {
    const state = stateOf();
    state.failing.add('getChangeChain');
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /./ });
    state.failing.delete('getChangeChain');
    fireEvent.click(retry);
    await screen.findByTestId('delay-facts');
    expect(h.read).toHaveBeenCalledWith('getChangeChain', expect.anything());
  });

  it('shows nothing of a contract the caller cannot read', async () => {
    open(stateOf({ details: [] }), { path: `/ctr/ctr-14?id=${contractId(9)}` });
    await waitFor(() => expect(screen.queryByTestId('delay-facts')).toBeNull());
  });
});
