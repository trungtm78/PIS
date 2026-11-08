import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import { ALL, CONTRACTOR, OTHER, READER, client, mount, policy, routeOf, uuid } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';
import { PERMISSION } from '../security/security-model';
import SubcontractScreen from './SubcontractScreen';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const route = routeOf('VND-10', 'FR-VND-10');
const CONTRACT = uuid('0070', 1);
const SUB = uuid('0080', 1);
const REQUEST = uuid('0090', 1);
const WRITER = [...ALL, PERMISSION.subcontractWrite, PERMISSION.subcontractApprove, PERMISSION.subcontractPay];
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const payment = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0095', n),
  payment_request_id: REQUEST,
  paid_amount: 1_500_000,
  paid_on: '2026-11-02',
  reference: 'UNC-001',
  recorded_by: uuid('0050', 1),
  recorded_at: '2026-11-03T02:00:00.000Z',
  confirmed_by_subcontractor: false,
  subcontractor_confirmed_at: null,
  clock: 'MET',
  ...over,
});

const sub = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0080', n),
  contract_id: CONTRACT,
  contract_code: 'HD-001',
  subcontractor_id: OTHER,
  subcontractor_name: `Thầu phụ ${n}`,
  scope: 'Thi công phần móng khu A',
  value: 2_000_000,
  share_pct: 20,
  declared_in_bid: true,
  state: 'PROPOSED',
  proposed_by: uuid('0050', 1),
  proposed_at: '2026-11-02T02:00:00.000Z',
  approved_by: null,
  approved_at: null,
  exception_reason: null,
  exception_approved: false,
  findings: [],
  rule_version: null,
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  payments: [],
  paid_total: 0,
  over_paid: 0,
  may_approve: true,
  version: 1,
  ...over,
});

const declaration = (over: Record<string, unknown> = {}) => ({ id: uuid('0085', 1), package_id: uuid('0030', 1), contractor_id: CONTRACTOR, declared_share_pct: 30, subcontractor_ids: [OTHER], document_id: null, declared_by: uuid('0050', 1), declared_at: '2026-10-01T02:00:00.000Z', ...over });

const listing = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  contract_id: CONTRACT,
  contract_code: 'HD-001',
  contract_value: 10_000_000,
  prime_contractor_id: CONTRACTOR,
  items,
  total_share_pct: 20,
  prime_share_pct: 80,
  prime_min_share_pct: 51,
  declaration: declaration(),
  pending: [],
  policy: policy('VENDOR_SUBCONTRACT', { params: { prime_min_share_pct: 51 } }),
  as_of: '2026-11-08T03:00:00.000Z',
  ...over,
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
  failing?: World['failing'];
}

function open(items: Array<Record<string, unknown>> = [sub(1)], options: Options = {}, over: Record<string, unknown> = {}) {
  const world: World = { answers: { listVendorSubcontracts: listing(items, over) }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<SubcontractScreen route={route} />, h, { permissions: options.permissions ?? WRITER, path: options.path ?? `/vnd/vnd-10?contract=${CONTRACT}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-subcontract-id]'));
const loaded = async (): Promise<void> => {
  await screen.findAllByText('Thầu phụ 1');
};
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(new RegExp(escaped(label))), { target: { value } });
};
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });
const reason = (scope: HTMLElement, value: string): void => {
  fireEvent.change(scope.querySelector('textarea') as HTMLTextAreaElement, { target: { value } });
};

describe('SubcontractScreen (VND-10): the subcontracts of a contract', () => {
  it('asks for a contract first and reads only when one is named', async () => {
    const world: World = { answers: { listVendorSubcontracts: listing([sub(1)]) } };
    const h = client(world);
    mount(<SubcontractScreen route={route} />, h, { permissions: WRITER, path: '/vnd/vnd-10' });
    expect(await screen.findByTestId('choose-contract')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    const load = screen.getByTestId('load-contract') as HTMLButtonElement;
    expect(load.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(word('vnd.subcontract.filter.contract.label')), { target: { value: CONTRACT } });
    fireEvent.click(load);
    await loaded();
    expect(h.read).toHaveBeenCalledWith('listVendorSubcontracts', { query: { contract_id: CONTRACT } });
  });

  it('sets the total of the approved shares beside the share the bid named and the floor of the prime', async () => {
    open([sub(1, { state: 'APPROVED', may_approve: false })], {}, { total_share_pct: 35, prime_share_pct: 65 });
    await loaded();
    expect(screen.getByTestId('declared-share').textContent).toBe('30%');
    const total = screen.getByTestId('total-share');
    expect(total.getAttribute('data-over')).toBe('true');
    expect(total.textContent).toContain('35%');
    expect(total.textContent).toContain(word('vnd.subcontract.summary.over.badge'));
    expect(screen.getByTestId('prime-share').textContent).toContain('65% / 51%');
    expect(screen.getByTestId('prime-share').getAttribute('data-below')).toBe('false');
  });

  it('flags a prime below its floor and a contract without a declaration', async () => {
    open([sub(1, { state: 'APPROVED', may_approve: false })], {}, { total_share_pct: 60, prime_share_pct: 40, declaration: null });
    await loaded();
    expect(screen.getByTestId('declared-share').textContent).toBe(word('vnd.subcontract.summary.noDeclaration.text'));
    expect(screen.getByTestId('prime-share').getAttribute('data-below')).toBe('true');
    expect(screen.getByTestId('prime-share').textContent).toContain(word('vnd.subcontract.summary.floor.badge'));
  });

  it('says the rule with its "i" and the unverified flag', async () => {
    open();
    await loaded();
    const rule = screen.getByTestId('subcontract-rule');
    fireEvent.click(within(rule).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.subcontract.figure.rule.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('vnd.subcontract.figure.rule.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe('Formula of VENDOR_SUBCONTRACT');
    expect(panel.querySelector('[data-field=unverified]')).toBeTruthy();
  });

  it('shows each subcontract with its scope, value and share, whether the bid named it, its findings, the exception and what was paid', async () => {
    open([
      sub(1, { state: 'APPROVED', may_approve: false, declared_in_bid: false, findings: ['NOT_NAMED_IN_BID', 'OVER_DECLARED_SHARE'], exception_approved: true, exception_reason: 'Chủ đầu tư đồng ý bằng văn bản', paid_total: 2_100_000, over_paid: 100_000, payments: [payment(1), payment(2, { payment_request_id: null, paid_amount: 600_000, confirmed_by_subcontractor: true })] }),
    ]);
    await loaded();
    const [row] = rows();
    expect(row?.textContent).toContain('Thi công phần móng khu A');
    expect(row?.textContent).toContain('2.000.000');
    expect(row?.textContent).toContain('20%');
    expect(row?.textContent).toContain(word('vnd.subcontract.bid.notNamed.name'));
    expect(row?.textContent).toContain(word('vnd.subcontract.finding.notNamedInBid.name'));
    expect(row?.textContent).toContain(word('vnd.subcontract.finding.overDeclaredShare.name'));
    expect(row?.textContent).toContain(word('vnd.subcontract.exception.badge'));
    expect(row?.textContent).toContain('Chủ đầu tư đồng ý bằng văn bản');
    expect(row?.textContent).toContain(text('vnd.subcontract.overPaid.text', { amount: '100.000' }));
    expect(within(row as HTMLElement).getAllByTestId('payment-line')).toHaveLength(2);
    expect(row?.textContent).toContain(word('vnd.subcontract.payment.confirmed.badge'));
  });

  it('lists the payments that were paid and not recorded, each with its clock, and records one with its payment request', async () => {
    const pending = [{ subcontract_id: SUB, contract_id: CONTRACT, contract_code: 'HD-001', subcontractor_id: OTHER, subcontractor_name: 'Thầu phụ 1', payment_request_id: REQUEST, paid_on: '2026-10-20', clock: 'OVERDUE' }];
    const { h } = open([sub(1, { state: 'APPROVED', may_approve: false })], {}, { pending });
    await loaded();
    const list = screen.getByTestId('pending-list');
    expect(list.querySelector('li')?.getAttribute('data-clock')).toBe('OVERDUE');
    expect(list.textContent).toContain(text('vnd.subcontract.pending.line.text', { name: 'Thầu phụ 1', day: '20/10/2026' }));
    fireEvent.click(within(list).getByTestId('record-pending'));
    const form = dialog(word('vnd.subcontract.payment.title'));
    expect((within(form).getByLabelText(new RegExp(escaped(word('vnd.subcontract.field.request.label')))) as HTMLInputElement).value).toBe(REQUEST);
    type(form, word('vnd.subcontract.field.paid.label'), '1500000');
    type(form, word('vnd.subcontract.field.paidOn.label'), '2026-11-02');
    type(form, word('vnd.subcontract.field.reference.label'), 'UNC-777');
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.subcontract.payment.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordVendorSubcontractPayment', { ...{ path: { id: SUB }, body: { payment_request_id: REQUEST, paid_amount: 1_500_000, paid_on: '2026-11-02', reference: 'UNC-777' } }, attempt: { key: expect.any(String) } }));
  });

  it('says that nothing is waiting when every payment is recorded', async () => {
    open();
    await loaded();
    expect(screen.getByTestId('pending-empty').textContent).toBe(word('vnd.subcontract.pending.empty.text'));
  });

  describe('moves', () => {
    it('proposes a subcontractor for the contract', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('propose-subcontract'));
      const form = dialog(word('vnd.subcontract.propose.title'));
      const send = within(form).getByRole('button', { name: word('vnd.subcontract.propose.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      type(form, word('vnd.subcontract.field.subcontractor.label'), OTHER);
      type(form, word('vnd.subcontract.field.scope.label'), 'Thi công phần mái khu B');
      type(form, word('vnd.subcontract.field.value.label'), '1000000');
      type(form, word('vnd.subcontract.field.share.label'), '10');
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('proposeVendorSubcontract', { ...{ body: { contract_id: CONTRACT, subcontractor_id: OTHER, scope: 'Thi công phần mái khu B', value: 1_000_000, share_pct: '10' } }, attempt: { key: expect.any(String) } }));
      expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.subcontract.propose.title'));
    });

    it('refuses a share that is not a number of the contract before sending', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('propose-subcontract'));
      const form = dialog(word('vnd.subcontract.propose.title'));
      type(form, word('vnd.subcontract.field.subcontractor.label'), OTHER);
      type(form, word('vnd.subcontract.field.scope.label'), 'Thi công phần mái khu B');
      type(form, word('vnd.subcontract.field.value.label'), '1000000');
      type(form, word('vnd.subcontract.field.share.label'), '12,5%');
      expect((within(form).getByRole('button', { name: word('vnd.subcontract.propose.confirm') }) as HTMLButtonElement).disabled).toBe(true);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('approves under the version it saw, with a reasoned exception when the row passes the declaration', async () => {
      const { h } = open([sub(1, { declared_in_bid: false }), sub(2, { may_approve: false })]);
      await loaded();
      expect(screen.getAllByTestId('approve-subcontract')).toHaveLength(1);
      fireEvent.click(screen.getByTestId('approve-subcontract'));
      const form = dialog(word('vnd.subcontract.approve.title'));
      expect(form.textContent).toContain(word('vnd.subcontract.approve.exception.note'));
      type(form, word('vnd.subcontract.field.exception.label'), 'Chủ đầu tư đồng ý bằng văn bản ngày 05/11');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.subcontract.approve.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('approveVendorSubcontract', { ...{ path: { id: SUB }, ifMatchVersion: 1, body: { exception_reason: 'Chủ đầu tư đồng ý bằng văn bản ngày 05/11' } }, attempt: { key: expect.any(String) } }));
    });

    it('approves a clean proposal with an empty body', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('approve-subcontract'));
      const form = dialog(word('vnd.subcontract.approve.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.subcontract.approve.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('approveVendorSubcontract', { ...{ path: { id: SUB }, ifMatchVersion: 1, body: {} }, attempt: { key: expect.any(String) } }));
    });

    it('rejects and terminates with a reason', async () => {
      const { h } = open([sub(1), sub(2, { state: 'APPROVED', may_approve: false, version: 2 })]);
      await screen.findAllByText('Thầu phụ 1');
      fireEvent.click(screen.getByTestId('reject-subcontract'));
      let form = dialog(word('vnd.subcontract.reject.title'));
      reason(form, 'Vượt phần mà hồ sơ đã nêu');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.subcontract.reject.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('rejectVendorSubcontract', { ...{ path: { id: SUB }, ifMatchVersion: 1, body: { reason: 'Vượt phần mà hồ sơ đã nêu' } }, attempt: { key: expect.any(String) } }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(screen.getByTestId('terminate-subcontract'));
      form = dialog(word('vnd.subcontract.terminate.title'));
      reason(form, 'Hết khối lượng công việc');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.subcontract.terminate.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('terminateVendorSubcontract', { ...{ path: { id: uuid('0080', 2) }, ifMatchVersion: 2, body: { reason: 'Hết khối lượng công việc' } }, attempt: { key: expect.any(String) } }));
    });

    it('records the declaration of the bid with the subcontractors it named', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('declare-bid'));
      const form = dialog(word('vnd.subcontract.declare.title'));
      expect((within(form).getByLabelText(new RegExp(escaped(word('vnd.subcontract.field.prime.label')))) as HTMLInputElement).value).toBe(CONTRACTOR);
      type(form, word('vnd.subcontract.field.package.label'), uuid('0030', 1));
      type(form, word('vnd.subcontract.field.declaredShare.label'), '30');
      type(form, word('vnd.subcontract.field.subcontractors.label'), `${OTHER}, ${SUB}`);
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.subcontract.declare.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('declareVendorBidSubcontracting', { ...{ body: { package_id: uuid('0030', 1), contractor_id: CONTRACTOR, declared_share_pct: '30', subcontractor_ids: [OTHER, SUB] } }, attempt: { key: expect.any(String) } }));
    });
  });

  it('says a failing read with a retry and offers no command to a reader or in a read-only workspace', async () => {
    open([sub(1, { may_approve: false })], { permissions: READER });
    await loaded();
    for (const id of ['propose-subcontract', 'approve-subcontract', 'declare-bid', 'record-payment']) expect(screen.queryByTestId(id)).toBeNull();
    cleanup();
    open([sub(1, { may_approve: false })], { mode: 'READ_ONLY' });
    await loaded();
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    expect(screen.queryByTestId('approve-subcontract')).toBeNull();
    cleanup();
    const failing = open([sub(1)], { failing: { listVendorSubcontracts: { error: new Error('down'), times: 1 } } });
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await loaded();
    expect(failing.h.read).toHaveBeenCalledTimes(2);
  });
});
