import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PROJECT, UUID_A, active, chain, client, contractId, mount, request, requestId, routeOf, world } from '../change/test-support';
import type { World } from '../change/test-support';
import { boqLine, revision } from '../test-support';
import DecisionScreen from './DecisionScreen';

const ROUTE = routeOf('CTR-08', 'FR-CTR-08');
const PATH = `/ctr/ctr-08?project=${PROJECT}&request=${requestId(1)}`;
const OK = { operation_id: 'o', status: 'APPROVED', resource_version: 3, resource_id: requestId(1) };
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A CO that was assessed (+500,000,000, 20 days) that the caller may decide. */
const evaluated = (overrides: Record<string, unknown> = {}) =>
  request(1, { stage: 'CO', code: 'CO-001', status: 'EVALUATED', version: 4, evaluated_delta_vnd: '500000000', schedule_impact_days: 20, funding_impact_note: 'Paid from the plan.', scope_impact_note: 'Km 2.', actions: { promote: false, evaluate: true, withdraw: true, decide: true }, ...overrides });
const stateOf = (overrides: Partial<World> = {}): World => world({ chain: chain({ requests: [evaluated()] }), ...overrides });

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<DecisionScreen route={ROUTE} />, h, { permissions: ['contract.change.approve'], path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const choose = (decision: string): void => {
  fireEvent.click(document.querySelector(`input[data-decision="${decision}"]`) as HTMLElement);
};
const submit = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};

describe('DecisionScreen (CTR-08): compare a change order with the contract and decide it', () => {
  it('asks for a change order when the address names none', async () => {
    open(stateOf(), { path: '/ctr/ctr-08' });
    expect((await screen.findByTestId('no-request')).textContent).toBe(vi_['ctr.revision.decision.none.notice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.revision.decision.title']);
  });

  it('UI-CTR-08: sets the change beside the contract in force: the value, the change in value, the schedule and the notes', async () => {
    open(stateOf());
    await screen.findByTestId('compare');
    expect(screen.getByTestId('request-code').textContent).toBe('CO-001');
    expect(screen.getByTestId('request-reason').textContent).toBe('The owner instructed a wider footpath.');
    const value = document.querySelector('[data-row="value"]') as HTMLElement;
    expect(within(value).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([text('ctr.value.amount', { amount: '10.200.000.000' }), text('ctr.value.amount', { amount: '10.700.000.000' })]);
    expect(screen.getByTestId('delta').textContent).toBe(text('ctr.value.amount', { amount: '500.000.000' }));
    expect(screen.getByTestId('days').textContent).toBe(text('ctr.change.days.value', { days: 20 }));
    expect(screen.getByTestId('effective').textContent).toBe(vi_['ctr.revision.none.text']);
    expect(screen.getByTestId('funding-note').textContent).toBe('Paid from the plan.');
    expect(screen.getByTestId('scope-note').textContent).toBe('Km 2.');
    expect(screen.queryByTestId('lines')).toBeNull();
    expect(screen.getByText(text('ctr.revision.decision.footer', { id: 'CTR-08', req: 'FR-CTR-08' }))).toBeTruthy();
  });

  it('shows a decrease with its sign, and a change that has no assessment yet by its estimate', async () => {
    open(stateOf({ chain: chain({ requests: [evaluated({ evaluated_delta_vnd: null, estimated_delta_vnd: '-3000000' })] }) }));
    await screen.findByTestId('compare');
    expect(screen.getByTestId('delta').textContent).toBe(text('ctr.value.amount', { amount: '-3.000.000' }));
    expect(screen.getByTestId('after-value').textContent).toBe(text('ctr.value.amount', { amount: '10.197.000.000' }));
  });

  describe('approving', () => {
    it('AC-ST-CTR-007-1, UAT-AC308: asks for the reason, the document, the amount and the day, and decides under the version it showed', async () => {
      const h = open(stateOf());
      await screen.findByTestId('compare');
      expect(document.getElementById('decision-reason')).toBeNull();
      choose('approve');
      expect((document.getElementById('decision-delta') as HTMLInputElement).value).toBe('500000000');
      type('decision-delta', '');
      type('decision-day', '');
      submit(vi_['ctr.revision.submit.approve']);
      expect(screen.getAllByText(vi_['ctr.change.problem.required'])).toHaveLength(4);
      expect(h.command).not.toHaveBeenCalled();
      type('decision-reason', ' Within the plan. ');
      type('decision-evidence', 'nope');
      type('decision-document', 'nope');
      type('decision-delta', '5e8');
      type('decision-day', '2020-01-01');
      type('decision-lines', '{');
      submit(vi_['ctr.revision.submit.approve']);
      expect(screen.getByText(vi_['ctr.revision.problem.evidence'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.change.problem.uuid'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.change.problem.amount'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.revision.problem.past'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.revision.problem.json'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      type('decision-evidence', `${UUID_A}\n${UUID_A.toUpperCase()}`);
      type('decision-document', UUID_A.toUpperCase());
      type('decision-delta', '500000000');
      type('decision-day', '2999-08-01');
      type('decision-lines', '[{"business_key":"B01","description":"Item","unit_code":"M3","quantity":"1","unit_price":"1"}]');
      submit(vi_['ctr.revision.submit.approve']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'post_contract_changes_id_decision',
        expect.objectContaining({
          path: { id: requestId(1) },
          ifMatchVersion: 4,
          body: {
            decision: 'approve',
            reason: 'Within the plan.',
            evidence_ids: [UUID_A],
            approved_delta_vnd: '500000000',
            effective_on: '2999-08-01',
            decision_document_version_id: UUID_A,
            boq_lines: [{ business_key: 'B01', description: 'Item', unit_code: 'M3', quantity: '1', unit_price: '1' }],
          },
        }),
      );
      expect((await screen.findByTestId('done')).textContent).toBe(text('ctr.revision.done.notice', { decision: vi_['ctr.revision.decision.approve'] }));
    });

    it('keeps the form and says why when the server refuses', async () => {
      for (const [error, expected] of [
        [problem('SELF_APPROVAL_DENIED', 403), vi_['ctr.change.error.selfApproval']],
        [problem('RETROACTIVE_NOT_ALLOWED', 422, { effective_on: '2026-06-01' }), vi_['ctr.change.error.retroactive']],
        [problem('ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', 422, { floor_vnd: '3000000000' }), vi_['ctr.change.error.floor']],
        [problem('DECISION_DOCUMENT_REQUIRED', 422), vi_['ctr.change.error.decisionDocument']],
        [problem('BOQ_TOTAL_MISMATCH', 422), vi_['ctr.change.error.boqMismatch']],
        [problem('SCOPE_DENIED', 403, { approver_role_id: UUID_A }), vi_['ctr.change.error.delegation']],
        [problem('SCOPE_DENIED', 403), vi_['ctr.change.error.denied']],
        [problem('ALLOCATION_UNAVAILABLE', 422, { reason: 'ABOVE_BLOCK' }), vi_['ctr.change.error.allocation']],
        [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { reason: 'ONLY_CO_DECIDED' }), vi_['ctr.change.error.onlyCo']],
        [problem('CONTRACT_STATE_INVALID', 409), vi_['ctr.change.error.contractState']],
        [problem('VERSION_CONFLICT', 409), vi_['ctr.change.error.versionConflict']],
        [problem('CHANGE_STATE_INVALID', 409), vi_['ctr.change.error.stateInvalid']],
      ] as const) {
        open(stateOf(), { command: () => error });
        await screen.findByTestId('compare');
        choose('approve');
        type('decision-reason', 'Within the plan.');
        type('decision-document', UUID_A);
        type('decision-day', '2999-08-01');
        submit(vi_['ctr.revision.submit.approve']);
        expect((await screen.findByTestId('refusal')).textContent).toBe(expected);
        expect((document.getElementById('decision-reason') as HTMLTextAreaElement).value).toBe('Within the plan.');
        expect(screen.queryByTestId('done')).toBeNull();
        cleanup();
      }
    });
  });

  describe('giving back and rejecting', () => {
    it('asks for the reason alone and sends it, with the evidence, under the version it showed', async () => {
      for (const [decision, label] of [
        ['return', vi_['ctr.revision.submit.return']],
        ['reject', vi_['ctr.revision.submit.reject']],
      ] as const) {
        const h = open(stateOf(), { command: () => ({ ...OK, status: decision === 'return' ? 'SUBMITTED' : 'REJECTED' }) });
        await screen.findByTestId('compare');
        choose(decision);
        expect(document.getElementById('decision-document')).toBeNull();
        expect(document.getElementById('decision-delta')).toBeNull();
        submit(label);
        expect(screen.getByText(vi_['ctr.change.problem.required'])).toBeTruthy();
        type('decision-reason', 'The funding note is thin.');
        submit(label);
        await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
        expect(h.command).toHaveBeenCalledWith('post_contract_changes_id_decision', expect.objectContaining({ path: { id: requestId(1) }, ifMatchVersion: 4, body: { decision, reason: 'The funding note is thin.', evidence_ids: [] } }));
        await screen.findByTestId('done');
        cleanup();
      }
    });

    it('asks for a decision before anything else', async () => {
      const h = open(stateOf());
      await screen.findByTestId('compare');
      choose('return');
      choose('approve');
      expect(document.getElementById('decision-document')).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('when the decision is not offered', () => {
    it('says so to someone who may not decide it, to a read-only session, and when the change is not waiting', async () => {
      open(stateOf({ chain: chain({ requests: [evaluated({ actions: { promote: false, evaluate: false, withdraw: false, decide: false } })] }) }));
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.revision.noCommand.notice']);
      expect(document.querySelector('input[name="decision"]')).toBeNull();
      cleanup();
      open(stateOf(), { mode: 'READ_ONLY' });
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.revision.readOnly.notice']);
      cleanup();
      open(stateOf({ chain: chain({ requests: [evaluated({ status: 'SUBMITTED', actions: { promote: false, evaluate: true, withdraw: true, decide: false } })] }) }));
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.revision.notEvaluated.notice']);
    });

    it('shows a request without the assessment (a guest) with the value in force and no figures', async () => {
      open(stateOf({ chain: chain({ requests: [{ ...evaluated(), reason: undefined, baseline_revision_id: undefined, actions: undefined }] }) }));
      await screen.findByTestId('compare');
      expect(screen.queryByTestId('request-reason')).toBeNull();
      expect(screen.getByTestId('delta').textContent).toBe(vi_['ctr.revision.none.text']);
      expect(screen.getByTestId('days').textContent).toBe(vi_['ctr.revision.none.text']);
      expect(screen.getByTestId('after-value').textContent).toBe(vi_['ctr.revision.none.text']);
    });
  });

  describe('after the approval', () => {
    const afterApproval = () => {
      const made = revision(1, { id: UUID_A, revision: 2, kind: 'CHANGE_ORDER', status: 'PENDING_EFFECTIVE', amount_vnd: '10700000000', valid_from: '2999-08-01', supersedes_id: revision(1).id, change_request_id: requestId(1), change_request_code: 'CO-001' });
      const before = revision(1, { status: 'EFFECTIVE', revision: 1 });
      return stateOf({
        chain: chain({ requests: [evaluated({ status: 'APPROVED', approved_delta_vnd: '500000000', effective_on: '2999-08-01', resulting_revision_id: UUID_A, actions: { promote: false, evaluate: false, withdraw: false, decide: false } })] }),
        details: [active({ revisions: [before, made] })],
        boqLines: [
          boqLine(1, { id: '00000000-0000-4000-8000-001300000001', business_key: 'B01', description: 'Earthwork', contract_revision_id: before.id, revision: 1, quantity: '1', unit_price: '9000000000', amount_vnd: '9000000000' }),
          boqLine(2, { id: '00000000-0000-4000-8000-001300000002', business_key: 'B02', description: 'Concrete', contract_revision_id: before.id, revision: 1, quantity: '500', unit_price: '2000000', amount_vnd: '1000000000' }),
          boqLine(1, { id: '00000000-0000-4000-8000-001300000003', business_key: 'B01', description: 'Earthwork', contract_revision_id: UUID_A, revision: 2, quantity: '1', unit_price: '9000000000', amount_vnd: '9000000000' }),
          boqLine(2, { id: '00000000-0000-4000-8000-001300000004', business_key: 'B02', description: 'Concrete', contract_revision_id: UUID_A, revision: 2, quantity: '500', unit_price: '2100000', amount_vnd: '1050000000' }),
        ],
      });
    };

    it('AC-ST-CTR-007-2, UAT-AC58: shows the approved value and day and the BOQ of the new revision against the one it follows, with the links to put it right', async () => {
      open(afterApproval());
      await screen.findByTestId('lines');
      expect(screen.getByTestId('effective').textContent).toBe('2999-08-01');
      expect(screen.getByTestId('delta').textContent).toBe(text('ctr.value.amount', { amount: '500.000.000' }));
      const rows = Array.from(document.querySelectorAll('[data-line]')).map((row) => [row.getAttribute('data-line'), row.getAttribute('data-change')]);
      expect(rows).toEqual([
        ['B01', 'SAME'],
        ['B02', 'CHANGED'],
      ]);
      const changed = document.querySelector('[data-line="B02"]') as HTMLElement;
      expect(within(changed).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['500 → 500', '2.000.000 → 2.100.000', '1.000.000.000 → 1.050.000.000', vi_['ctr.revision.line.changed']]);
      expect(screen.getByTestId('boq-link').getAttribute('href')).toBe(`/ctr/ctr-04?id=${contractId(1)}&revision=${UUID_A}`);
      expect(screen.getByTestId('versions-link').getAttribute('href')).toBe(`/ctr/ctr-26?id=${contractId(1)}`);
      expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.revision.notEvaluated.notice']);
    });

    it('answers a failed read of the lines with the error state of its own', async () => {
      open({ ...afterApproval(), failing: new Set(['get_resources_boq_line']) });
      await screen.findByTestId('compare');
      expect(await screen.findAllByRole('button', { name: vi_['states.retry.action'] })).toHaveLength(1);
    });
  });

  describe('the states', () => {
    it('answers a failed read with the error state and reads again when retried', async () => {
      const state = stateOf({ failing: new Set(['getChangeChain']) });
      const h = open(state);
      const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
      state.failing.clear();
      fireEvent.click(retry);
      await screen.findByTestId('compare');
      expect(h.read.mock.calls.filter(([operation]) => operation === 'getChangeChain')).toHaveLength(2);
    });

    it('answers a change order that is not in the project with the empty state', async () => {
      open(stateOf(), { path: `/ctr/ctr-08?project=${PROJECT}&request=${requestId(7)}` });
      expect((await screen.findByText(vi_['states.empty.title'])).textContent).toBe(vi_['states.empty.title']);
    });
  });
});
