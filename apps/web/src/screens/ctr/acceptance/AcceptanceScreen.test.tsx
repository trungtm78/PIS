import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import AcceptanceScreen from './AcceptanceScreen';
import { APPROVER, DRAFTER, MINUTES, PAPER, PERIOD_1, PERIOD_2, READER, REVOKER, UUID_A, acceptance, acceptanceId, approvedMeasurement, client, contractId, measurement, measurementId, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-12', 'FR-CTR-12');
const PATH = `/ctr/ctr-12?contract=${contractId(1)}`;
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 2, resource_id: acceptanceId(9) };
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string; permissions?: readonly string[] } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<AcceptanceScreen route={ROUTE} />, h, { permissions: options.permissions ?? DRAFTER, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const rowOf = (id: string): HTMLElement => document.querySelector(`tr[data-acceptance="${id}"]`) as HTMLElement;
const commandsOf = (h: ReturnType<typeof client>, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });

describe('AcceptanceScreen (CTR-12): the acceptance of work', () => {
  it('asks for a contract when the address names none', async () => {
    open(world(), { path: '/ctr/ctr-12' });
    expect((await screen.findByTestId('no-contract')).textContent).toBe(vi_['ctr.acceptance.none.notice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.acceptance.title']);
    expect(screen.getByText(text('ctr.acceptance.footer', { id: 'CTR-12', req: 'FR-CTR-12' }))).toBeTruthy();
  });

  it('UI-CTR-12: shows the contract in figures, and each acceptance with its lines priced as at the day it was drawn up', async () => {
    open(world({ acceptances: [acceptance(1), acceptance(2, { status: 'APPROVED', contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE', requires_quality_acceptance: true, contract_value_vnd: '10200000000', accepted_total_vnd: '400000000' } })] }));
    await screen.findByTestId('acceptances');
    expect(screen.getByTestId('contract-code').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('contract-value').textContent).toBe('10.200.000.000');
    expect(screen.getByTestId('contract-accepted').textContent).toBe('0');
    expect(screen.getByTestId('contract-remaining').textContent).toBe('10.200.000.000');
    expect(screen.getByTestId('quality-required').textContent).toBe(vi_['ctr.acceptance.contract.qualityRequired']);
    const first = rowOf(acceptanceId(1));
    expect(within(first).getByTestId('no').textContent).toBe('NT-001');
    expect(within(first).getByTestId('period').textContent).toBe('2026-01');
    expect(within(first).getByTestId('lines').textContent).toBe('B02 · 200 M3 × 2.000.000 = 400.000.000');
    expect(within(first).getByTestId('amount').textContent).toBe('400.000.000');
    expect(within(first).getByTestId('status').textContent).toBe(vi_['ctr.acceptance.status.draft']);
    expect(within(first).getByTestId('quality').textContent).toBe(vi_['ctr.acceptance.quality.missing']);
    expect(within(rowOf(acceptanceId(2))).getByTestId('status').textContent).toBe(vi_['ctr.acceptance.status.approved']);
  });

  it('says whether the minutes of quality are linked, and warns of the serious non-conformances that stand in the way until the acceptance is decided', async () => {
    open(
      world({
        acceptances: [
          acceptance(1, { status: 'SUBMITTED', open_critical_ncr: 2, quality_acceptance: { id: MINUTES, record_no: 'QA-W-060', status: 'APPROVED' } }),
          acceptance(2, { status: 'APPROVED', open_critical_ncr: 1, decision_reason: 'Đã đối chiếu' }),
          acceptance(3, { status: 'REVOKED', revoke_reason: 'Đo lại', decision_reason: 'Đã đối chiếu' }),
          acceptance(4, { status: 'REJECTED' }),
        ],
        details: [{ ...world().details[0], requires_quality_acceptance: false }],
      }),
    );
    await screen.findByTestId('acceptances');
    const first = rowOf(acceptanceId(1));
    expect(within(first).getByTestId('quality').textContent).toBe(text('ctr.acceptance.quality.linked', { record: 'QA-W-060', status: 'APPROVED' }));
    expect(within(first).getByTestId('ncr-open').textContent).toBe(text('ctr.acceptance.ncr.open', { count: 2 }));
    expect(within(rowOf(acceptanceId(2))).queryByTestId('ncr-open')).toBeNull();
    expect(within(rowOf(acceptanceId(2))).getByTestId('decision-reason').textContent).toBe('Đã đối chiếu');
    expect(within(rowOf(acceptanceId(3))).getByTestId('revoke-reason').textContent).toBe(text('ctr.acceptance.revoked.reason', { reason: 'Đo lại' }));
    expect(within(rowOf(acceptanceId(3))).getByTestId('status').className).toContain('warning');
    expect(within(rowOf(acceptanceId(4))).getByTestId('status').className).toContain('warning');
    expect(screen.queryByTestId('quality-required')).toBeNull();
    expect(within(rowOf(acceptanceId(4))).getByTestId('quality').textContent).toBe(vi_['ctr.acceptance.quality.notAsked']);
  });

  it('says when there is no acceptance, and shows a read that failed', async () => {
    open(world());
    expect((await screen.findByTestId('no-acceptances')).textContent).toBe(vi_['ctr.acceptance.list.empty']);
    cleanup();
    const state = world({ failing: new Set(['get_resources_acceptance']) });
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-acceptances');
    expect((h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === 'get_resources_acceptance').length).toBeGreaterThan(1);
  });

  it('offers a button only for what the acceptance and the caller allow, and none in a read-only session', async () => {
    const state = world({
      acceptances: [
        acceptance(1, { actions: { submit: true, decide: false, revoke: false } }),
        acceptance(2, { status: 'SUBMITTED', actions: { submit: false, decide: true, revoke: false } }),
        acceptance(3, { status: 'APPROVED', actions: { submit: false, decide: false, revoke: true } }),
        acceptance(4, { status: 'REJECTED', actions: { submit: false, decide: false, revoke: false } }),
      ],
    });
    open(state, { permissions: [...DRAFTER, ...APPROVER, ...REVOKER] });
    await screen.findByTestId('acceptances');
    const names = (id: string): string[] => within(rowOf(id)).queryAllByRole('button').map((button) => button.textContent ?? '');
    expect(names(acceptanceId(1))).toEqual([vi_['ctr.acceptance.submit.action']]);
    expect(names(acceptanceId(2))).toEqual([vi_['ctr.acceptance.decide.action']]);
    expect(names(acceptanceId(3))).toEqual([vi_['ctr.acceptance.revoke.action']]);
    expect(names(acceptanceId(4))).toEqual([]);
    cleanup();
    open(state, { permissions: [...DRAFTER, ...APPROVER, ...REVOKER], mode: 'READ_ONLY' });
    await screen.findByTestId('acceptances');
    expect(names(acceptanceId(1))).toEqual([]);
  });

  describe('drafting', () => {
    const withMeasurements = () =>
      world({
        measurements: [
          approvedMeasurement(1),
          approvedMeasurement(2, { period: { id: PERIOD_2, code: '2026-02' }, quantity_period: '3.500000', boq_item: { id: 'i', business_key: 'B01', description: 'Hạng mục 1', unit_code: 'M3' } }),
          measurement(3, { status: 'SUBMITTED' }),
          approvedMeasurement(4),
        ],
        acceptances: [acceptance(4, { status: 'APPROVED', lines: [{ ...(acceptance(4).lines[0] as object), measurement_id: measurementId(4) }] })],
      });

    it('offers the approved measurements that no approved acceptance holds, by period', async () => {
      open(withMeasurements());
      fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.draft.action'] }));
      expect(Array.from((document.getElementById('acceptance-period') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([vi_['ctr.acceptance.field.period.choose'], '2026-01', '2026-02']);
      type('acceptance-period', PERIOD_1);
      expect(Array.from(document.querySelectorAll('[data-measurement]')).map((box) => box.getAttribute('data-measurement'))).toEqual([measurementId(1)]);
      type('acceptance-period', PERIOD_2);
      expect(within(dialog()).getByText(text('ctr.acceptance.field.measurement', { item: 'B01', quantity: '3,5', unit: 'M3', reference: 'NK-001' }))).toBeTruthy();
    });

    it('offers no drafting to a caller who may not draft, in a read-only session, without measurements to take, or on a contract not being performed', async () => {
      open(withMeasurements(), { permissions: READER });
      await screen.findByTestId('acceptances');
      expect(screen.queryByRole('button', { name: vi_['ctr.acceptance.draft.action'] })).toBeNull();
      cleanup();
      open(withMeasurements(), { mode: 'READ_ONLY' });
      await screen.findByTestId('acceptances');
      expect(screen.queryByRole('button', { name: vi_['ctr.acceptance.draft.action'] })).toBeNull();
      cleanup();
      open(world());
      await screen.findByTestId('no-acceptances');
      expect(screen.queryByRole('button', { name: vi_['ctr.acceptance.draft.action'] })).toBeNull();
      cleanup();
      open(world({ measurements: [approvedMeasurement(1)], details: [{ ...world().details[0], status: 'SUSPENDED' }] }));
      await screen.findByTestId('no-acceptances');
      expect(screen.queryByRole('button', { name: vi_['ctr.acceptance.draft.action'] })).toBeNull();
      cleanup();
      // Whoever may not read the measurements still reads the acceptances.
      open(world({ acceptances: [acceptance(1)], failing: new Set(['get_resources_measurement']) }));
      await screen.findByTestId('acceptances');
      expect(screen.queryByRole('button', { name: vi_['ctr.acceptance.draft.action'] })).toBeNull();
    });

    it('asks for the period, a measurement and the paper before it sends anything', async () => {
      const h = open(withMeasurements());
      fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.draft.action'] }));
      press(vi_['ctr.acceptance.draft.submit']);
      expect(within(dialog()).getAllByText(vi_['ctr.acceptance.problem.required'])).toHaveLength(3);
      type('acceptance-period', PERIOD_1);
      type('acceptance-document', 'not-an-id');
      type('acceptance-quality', 'not-an-id');
      press(vi_['ctr.acceptance.draft.submit']);
      expect(within(dialog()).getAllByText(vi_['ctr.acceptance.problem.uuid'])).toHaveLength(2);
      expect(commandsOf(h, 'createAcceptance')).toHaveLength(0);
    });

    it('AC-ST-CTR-009-1, UAT-AC63: sends the measurements chosen, the period and the paper under the contract, once, and says what to do next', async () => {
      const h = open(withMeasurements());
      fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.draft.action'] }));
      type('acceptance-period', PERIOD_1);
      fireEvent.click(document.querySelector(`[data-measurement="${measurementId(1)}"]`) as HTMLElement);
      fireEvent.click(document.querySelector(`[data-measurement="${measurementId(1)}"]`) as HTMLElement);
      fireEvent.click(document.querySelector(`[data-measurement="${measurementId(1)}"]`) as HTMLElement);
      type('acceptance-document', PAPER);
      type('acceptance-quality', MINUTES);
      press(vi_['ctr.acceptance.draft.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'createAcceptance')).toEqual([
        { path: { id: contractId(1) }, body: { measurement_ids: [measurementId(1)], period_id: PERIOD_1, document_version_id: PAPER, quality_acceptance_id: MINUTES }, attempt: expect.anything() },
      ]);
      expect(screen.getByTestId('done').textContent).toBe(vi_['ctr.acceptance.done.drafted']);
    });

    it('forgets the measurements chosen when the period changes, and says in words what the server refused', async () => {
      const cases: Array<[Error, string]> = [
        [refusal('MEASUREMENT_NOT_APPROVED'), 'ctr.acceptance.error.measurementNotApproved'],
        [refusal('MEASUREMENT_ALREADY_ACCEPTED', 409), 'ctr.acceptance.error.measurementAccepted'],
        [refusal('QUALITY_ACCEPTANCE_REQUIRED'), 'ctr.acceptance.error.qualityRequired'],
        [refusal('REVISION_NOT_EFFECTIVE'), 'ctr.acceptance.error.revisionNotEffective'],
        [refusal('CONTRACT_STATE_INVALID', 409), 'ctr.acceptance.error.contractState'],
      ];
      for (const [error, key] of cases) {
        const h = open(withMeasurements(), { command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.draft.action'] }));
        type('acceptance-period', PERIOD_2);
        fireEvent.click(document.querySelector(`[data-measurement="${measurementId(2)}"]`) as HTMLElement);
        type('acceptance-period', PERIOD_1);
        press(vi_['ctr.acceptance.draft.submit']);
        expect(commandsOf(h, 'createAcceptance')).toHaveLength(0);
        fireEvent.click(document.querySelector(`[data-measurement="${measurementId(1)}"]`) as HTMLElement);
        type('acceptance-document', PAPER);
        press(vi_['ctr.acceptance.draft.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
        cleanup();
      }
    });
  });

  describe('sending', () => {
    it('asks for the people who sign, then sends under the version shown', async () => {
      const h = open(world({ acceptances: [acceptance(1, { version: 4 })] }));
      fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.submit.action'] }));
      press(vi_['ctr.acceptance.submit.submit']);
      expect(within(dialog()).getByText(vi_['ctr.acceptance.problem.required'])).toBeTruthy();
      expect(commandsOf(h, 'submitAcceptance')).toHaveLength(0);
      type('acceptance-signers', ' Đại diện chủ đầu tư \n\n Giám sát ');
      press(vi_['ctr.acceptance.submit.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'submitAcceptance')).toEqual([{ path: { id: acceptanceId(1) }, body: { signer_refs: [{ name: 'Đại diện chủ đầu tư' }, { name: 'Giám sát' }] }, ifMatchVersion: 4, attempt: expect.anything() }]);
      expect(screen.getByTestId('done').textContent).toBe(vi_['ctr.acceptance.done.submitted']);
    });

    it('says what the server refused in words', async () => {
      open(world({ acceptances: [acceptance(1)] }), { command: () => Promise.reject(refusal('MEASUREMENT_NOT_APPROVED')) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.submit.action'] }));
      type('acceptance-signers', 'Giám sát');
      press(vi_['ctr.acceptance.submit.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['ctr.acceptance.error.measurementNotApproved']);
    });
  });

  describe('deciding', () => {
    const waiting = () => world({ acceptances: [acceptance(1, { status: 'SUBMITTED', version: 3, actions: { submit: false, decide: true, revoke: false } })] });

    it('asks for a decision and a reason, then sends the decision under the version shown', async () => {
      const h = open(waiting(), { permissions: APPROVER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.decide.action'] }));
      press(vi_['ctr.acceptance.decide.submit']);
      expect(within(dialog()).getAllByText(vi_['ctr.acceptance.problem.required'])).toHaveLength(2);
      fireEvent.click(within(dialog()).getByLabelText(vi_['ctr.acceptance.decision.approve']));
      type('acceptance-reason', ' Đã đối chiếu ');
      type('acceptance-evidence', `${UUID_A}, nope`);
      press(vi_['ctr.acceptance.decide.submit']);
      expect(within(dialog()).getByText(vi_['ctr.acceptance.problem.uuid'])).toBeTruthy();
      type('acceptance-evidence', UUID_A);
      press(vi_['ctr.acceptance.decide.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'post_acceptances_id_decision')).toEqual([{ path: { id: acceptanceId(1) }, body: { decision: 'approve', reason: 'Đã đối chiếu', evidence_ids: [UUID_A] }, ifMatchVersion: 3, attempt: expect.anything() }]);
      expect(screen.getByTestId('done').textContent).toBe(vi_['ctr.acceptance.done.decided']);
    });

    it('offers to give back or to reject as well', async () => {
      const h = open(waiting(), { permissions: APPROVER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.decide.action'] }));
      expect(within(dialog()).getByLabelText(vi_['ctr.acceptance.decision.return'])).toBeTruthy();
      fireEvent.click(within(dialog()).getByLabelText(vi_['ctr.acceptance.decision.reject']));
      type('acceptance-reason', 'Giấy tờ sai');
      press(vi_['ctr.acceptance.decide.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'post_acceptances_id_decision')[0]?.body).toMatchObject({ decision: 'reject', reason: 'Giấy tờ sai' });
    });

    it('AC-ST-CTR-009-2, UAT-AC313: says in words what stands in the way of the approval, with how much the contract can still accept', async () => {
      const cases: Array<[Error, string]> = [
        [refusal('QUALITY_ACCEPTANCE_REQUIRED'), vi_['ctr.acceptance.error.qualityRequired']],
        [refusal('OPEN_CRITICAL_NCR'), vi_['ctr.acceptance.error.openNcr']],
        [refusal('ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', 422, { remaining_vnd: '100000000' }), text('ctr.acceptance.error.exceedsContractLeft', { remaining: '100.000.000' })],
        [refusal('SELF_APPROVAL_DENIED', 403), vi_['ctr.acceptance.error.selfApproval']],
        [refusal('MEASUREMENT_ALREADY_ACCEPTED', 409), vi_['ctr.acceptance.error.measurementAccepted']],
        [refusal('VERSION_CONFLICT', 409), vi_['ctr.acceptance.error.versionConflict']],
      ];
      for (const [error, message] of cases) {
        open(waiting(), { permissions: APPROVER, command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.decide.action'] }));
        fireEvent.click(within(dialog()).getByLabelText(vi_['ctr.acceptance.decision.approve']));
        type('acceptance-reason', 'Duyệt');
        press(vi_['ctr.acceptance.decide.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(message);
        cleanup();
      }
    });
  });

  describe('revoking', () => {
    const approved = () => world({ acceptances: [acceptance(1, { status: 'APPROVED', version: 5, actions: { submit: false, decide: false, revoke: true } })] });

    it('asks for the reason and the paper, then sends them under the version shown', async () => {
      const h = open(approved(), { permissions: REVOKER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.revoke.action'] }));
      press(vi_['ctr.acceptance.revoke.submit']);
      expect(within(dialog()).getAllByText(vi_['ctr.acceptance.problem.required'])).toHaveLength(2);
      type('acceptance-revoke-reason', ' Đo lại khối lượng ');
      type('acceptance-revoke-document', 'nope');
      press(vi_['ctr.acceptance.revoke.submit']);
      expect(within(dialog()).getByText(vi_['ctr.acceptance.problem.uuid'])).toBeTruthy();
      type('acceptance-revoke-document', PAPER);
      press(vi_['ctr.acceptance.revoke.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'revokeAcceptance')).toEqual([{ path: { id: acceptanceId(1) }, body: { reason: 'Đo lại khối lượng', approval_document_version_id: PAPER }, ifMatchVersion: 5, attempt: expect.anything() }]);
      expect(screen.getByTestId('done').textContent).toBe(vi_['ctr.acceptance.done.revoked']);
    });

    it('says in words that a payment request holds the acceptance, and closes without sending from the cross and the cancel button', async () => {
      const h = open(approved(), { permissions: REVOKER, command: () => Promise.reject(refusal('ACCEPTANCE_ALREADY_CLAIMED', 409)) });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ctr.acceptance.revoke.action'] }));
      type('acceptance-revoke-reason', 'Sai');
      type('acceptance-revoke-document', PAPER);
      press(vi_['ctr.acceptance.revoke.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['ctr.acceptance.error.claimed']);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.acceptance.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.acceptance.revoke.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.acceptance.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(commandsOf(h, 'revokeAcceptance')).toHaveLength(1);
    });
  });
});
