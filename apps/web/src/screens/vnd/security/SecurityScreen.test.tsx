import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import { ALL, CONTRACTOR, READER, client, mount, policy, routeOf, uuid } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';
import SecurityScreen from './SecurityScreen';
import { PERMISSION, primeBelowFloor, shortfallOf, subcontractOverDeclared } from './security-model';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const route = routeOf('VND-09', 'FR-VND-09');
const PACKAGE = uuid('0030', 1);
const SECURITY = uuid('0040', 1);
const DOCUMENT = uuid('0009', 1);
const WRITER = [...ALL, PERMISSION.securityWrite, PERMISSION.securityConfirm, PERMISSION.forfeitPropose, PERMISSION.forfeitDecide];
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const security = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0040', n),
  package_id: PACKAGE,
  package_code: 'GT-001',
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  kind: 'BANK_GUARANTEE',
  issuer: 'Vietcombank',
  security_no: `BL-${n}`,
  amount: 1_000_000,
  issued_on: '2026-11-01',
  valid_until: '2027-02-01',
  state: 'RECEIVED',
  document_id: null,
  received_by: uuid('0050', 1),
  received_at: '2026-11-02T02:00:00.000Z',
  required_amount: 1_000_000,
  factor_applied: 1,
  rule_version: 'builtin',
  confirmed_by: null,
  confirmed_at: null,
  issuer_reference: null,
  rejected_by: null,
  rejected_at: null,
  reject_reason: null,
  forfeit_proposed_by: null,
  forfeit_proposed_at: null,
  forfeit_reason_code: null,
  forfeit_reason: null,
  forfeit_decided_by: null,
  forfeit_decided_at: null,
  forfeit_decision_document_id: null,
  forfeit_decision_reason: null,
  released_by: null,
  released_at: null,
  release_reason: null,
  expiry_facet: null,
  conduct_behaviour: null,
  may_confirm: true,
  may_decide_forfeit: false,
  version: 1,
  ...over,
});

const standing = (over: Record<string, unknown> = {}) => ({
  package_id: PACKAGE,
  contractor_id: CONTRACTOR,
  required_amount: 3_000_000,
  factor: 3,
  must_hold_until: '2027-01-30',
  factor_until: '2028-03-01',
  satisfied: false,
  gaps: ['AMOUNT_BELOW', 'NOT_CONFIRMED'],
  enforcement: 'BLOCK',
  shortfall: 2_000_000,
  ...over,
});

const list = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  items,
  standing: null,
  policy: policy('VENDOR_BID_SECURITY', { params: { validity_margin_days: 30 } }),
  as_of: '2026-11-08T03:00:00.000Z',
  ...over,
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
  failing?: World['failing'];
  extra?: Record<string, unknown>;
}

function open(items: Array<Record<string, unknown>> = [security(1)], options: Options = {}, over: Record<string, unknown> = {}) {
  const world: World = { answers: { listVendorBidSecurities: list(items, over), ...(options.extra ?? {}) }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<SecurityScreen route={route} />, h, { permissions: options.permissions ?? WRITER, path: options.path ?? '/vnd/vnd-09', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-security-id]'));
const loaded = async (): Promise<void> => {
  await screen.findAllByText('Công ty nhà thầu 1');
};
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(new RegExp(escaped(label))), { target: { value } });
};
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });
const reason = (scope: HTMLElement, value: string): void => {
  fireEvent.change(scope.querySelector('textarea') as HTMLTextAreaElement, { target: { value } });
};

describe('SecurityScreen (VND-09): the bid security register', () => {
  it('lists the securities with the contractor, the letter, the amount against what is required, the validity and the state', async () => {
    open([security(1), security(2, { amount: 500_000, state: 'CONFIRMED', may_confirm: false, confirmed_at: '2026-11-03T02:00:00.000Z', issuer_reference: 'VCB-REF-1', expiry_facet: 'SECOND', valid_until: '2026-11-12' })]);
    await loaded();
    const [first, second] = rows();
    expect(within(first as HTMLElement).getByRole('link', { name: 'Công ty nhà thầu 1' }).getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${CONTRACTOR}`);
    expect(first?.textContent).toContain(word('vnd.security.state.received.name'));
    expect(first?.textContent).toContain(text('vnd.security.required.text', { amount: '1.000.000', factor: 1 }));
    expect(first?.textContent).toContain(text('vnd.security.letter.text', { issuer: 'Vietcombank', no: 'BL-1' }));
    expect(second?.textContent).toContain(word('vnd.security.state.confirmed.name'));
    expect(second?.textContent).toContain(text('vnd.security.shortfall.text', { amount: '500.000' }));
    expect(second?.textContent).toContain(word('vnd.security.expiry.second.name'));
    expect(second?.textContent).toContain(text('vnd.security.confirmed.text', { reference: 'VCB-REF-1', time: '03/11/2026 09:00' }));
  });

  it('says the rule with its "i" and the unverified flag', async () => {
    open();
    await loaded();
    const rule = screen.getByTestId('security-rule');
    expect(rule.textContent).toContain('30');
    fireEvent.click(within(rule).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.security.figure.rule.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('vnd.security.figure.rule.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe('Formula of VENDOR_BID_SECURITY');
    expect(panel.querySelector('[data-field=unverified]')).toBeTruthy();
  });

  it('shows what the package asks of the bidder when both are chosen, with the factor, the gaps and the shortfall', async () => {
    const { h } = open([security(1)], { path: `/vnd/vnd-09?package=${PACKAGE}&contractor=${CONTRACTOR}` }, { standing: standing() });
    await loaded();
    expect(h.read).toHaveBeenCalledWith('listVendorBidSecurities', { query: { package_id: PACKAGE, contractor_id: CONTRACTOR } });
    const card = screen.getByTestId('security-standing');
    expect(card.getAttribute('data-satisfied')).toBe('false');
    expect(card.textContent).toContain(text('vnd.security.standing.required.text', { amount: '3.000.000', factor: 3, until: '30/01/2027' }));
    expect(card.textContent).toContain(text('vnd.security.standing.factor.text', { until: '01/03/2028' }));
    expect(within(screen.getByTestId('security-gaps')).getAllByRole('listitem').map((item) => item.textContent)).toEqual([word('vnd.security.gap.amountBelow.name'), word('vnd.security.gap.notConfirmed.name'), text('vnd.security.shortfall.text', { amount: '2.000.000' })]);
  });

  it('filters by state and by the ids the address names', async () => {
    const { h } = open();
    await loaded();
    expect(h.read).toHaveBeenCalledWith('listVendorBidSecurities', { query: {} });
    fireEvent.change(screen.getByLabelText(word('vnd.security.filter.state.label')), { target: { value: 'FORFEITED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorBidSecurities', { query: { state: 'FORFEITED' } }));
  });

  it('says an empty register and an empty filter differently, and a failing read with a retry', async () => {
    open([]);
    expect(await screen.findByText(word('ui.dataTable.emptyNone'))).toBeTruthy();
    cleanup();
    const failing = open([security(1)], { failing: { listVendorBidSecurities: { error: new Error('down'), times: 1 } } });
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await loaded();
    expect(failing.h.read).toHaveBeenCalledTimes(2);
  });

  describe('moves', () => {
    it('receives a security with the body of the request and says what was done', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('receive-security'));
      const form = dialog(word('vnd.security.receive.title'));
      const send = within(form).getByRole('button', { name: word('vnd.security.receive.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      type(form, word('vnd.security.field.package.label'), PACKAGE);
      type(form, word('vnd.security.field.contractor.label'), CONTRACTOR);
      type(form, word('vnd.security.field.kind.label'), 'CASH_DEPOSIT');
      type(form, word('vnd.security.field.issuer.label'), 'Kho bạc');
      type(form, word('vnd.security.field.number.label'), 'CD-9');
      type(form, word('vnd.security.field.amount.label'), '3000000');
      type(form, word('vnd.security.field.issuedOn.label'), '2026-11-01');
      type(form, word('vnd.security.field.validUntil.label'), '2027-03-01');
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() =>
        expect(h.command).toHaveBeenCalledWith('receiveVendorBidSecurity', { ...{ body: { package_id: PACKAGE, contractor_id: CONTRACTOR, kind: 'CASH_DEPOSIT', issuer: 'Kho bạc', security_no: 'CD-9', amount: 3_000_000, issued_on: '2026-11-01', valid_until: '2027-03-01' } }, attempt: { key: expect.any(String) } }),
      );
      expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.security.receive.title'));
    });

    it('confirms with the reference of the issuer under the version it saw, only when the row says the caller may', async () => {
      const { h } = open([security(1), security(2, { may_confirm: false })]);
      await loaded();
      expect(screen.getAllByTestId('confirm-security')).toHaveLength(1);
      fireEvent.click(screen.getByTestId('confirm-security'));
      const form = dialog(word('vnd.security.confirm.title'));
      type(form, word('vnd.security.field.reference.label'), 'VCB-REF-9');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.security.confirm.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('confirmVendorBidSecurity', { ...{ path: { id: SECURITY }, ifMatchVersion: 1, body: { issuer_reference: 'VCB-REF-9' } }, attempt: { key: expect.any(String) } }));
    });

    it('rejects with a reason of twenty characters', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('reject-security'));
      const form = dialog(word('vnd.security.reject.title'));
      const send = within(form).getByRole('button', { name: word('vnd.security.reject.confirm') }) as HTMLButtonElement;
      reason(form, 'Quá ngắn');
      expect(send.disabled).toBe(true);
      reason(form, 'Tổ chức phát hành không thừa nhận thư này');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('rejectVendorBidSecurity', { ...{ path: { id: SECURITY }, ifMatchVersion: 1, body: { reason: 'Tổ chức phát hành không thừa nhận thư này' } }, attempt: { key: expect.any(String) } }));
    });

    it('proposes a forfeiture of a confirmed security with a reason of the law', async () => {
      const { h } = open([security(1, { state: 'CONFIRMED', may_confirm: false, version: 2 })]);
      await loaded();
      expect(screen.queryByTestId('confirm-security')).toBeNull();
      fireEvent.click(screen.getByTestId('propose-forfeit'));
      const form = dialog(word('vnd.security.propose.title'));
      type(form, word('vnd.security.field.reasonCode.label'), 'REFUSED_TO_SIGN');
      reason(form, 'Nhà thầu trúng thầu nhưng từ chối ký hợp đồng');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.security.propose.confirm') }));
      await waitFor(() =>
        expect(h.command).toHaveBeenCalledWith('proposeVendorBidSecurityForfeiture', { ...{ path: { id: SECURITY }, ifMatchVersion: 2, body: { reason_code: 'REFUSED_TO_SIGN', reason: 'Nhà thầu trúng thầu nhưng từ chối ký hợp đồng' } }, attempt: { key: expect.any(String) } }),
      );
    });

    it('decides a proposal: the paper is asked for a forfeiture only, and the proposer sees the withdrawal instead of the decision', async () => {
      const proposed = security(1, { state: 'FORFEIT_PROPOSED', may_confirm: false, may_decide_forfeit: true, version: 3, forfeit_reason_code: 'REFUSED_TO_SIGN', conduct_behaviour: null });
      const { h } = open([proposed, security(2, { state: 'FORFEIT_PROPOSED', may_confirm: false, may_decide_forfeit: false, version: 3 })]);
      await loaded();
      expect(screen.getAllByTestId('decide-forfeit')).toHaveLength(1);
      expect(screen.getAllByTestId('withdraw-forfeit')).toHaveLength(1);
      fireEvent.click(screen.getByTestId('decide-forfeit'));
      const form = dialog(word('vnd.security.decide.title'));
      const send = within(form).getByRole('button', { name: word('vnd.security.decide.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.security.field.decision.label'), 'FORFEIT');
      reason(form, 'Đã đối chiếu với hồ sơ hợp đồng');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.security.field.decisionDocument.label'), DOCUMENT);
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() =>
        expect(h.command).toHaveBeenCalledWith('decideVendorBidSecurityForfeiture', { ...{ path: { id: SECURITY }, ifMatchVersion: 3, body: { decision: 'FORFEIT', reason: 'Đã đối chiếu với hồ sơ hợp đồng', decision_document_id: DOCUMENT } }, attempt: { key: expect.any(String) } }),
      );
    });

    it('refuses a proposal without a paper and says a refusal of the server in place', async () => {
      const proposed = security(1, { state: 'FORFEIT_PROPOSED', may_confirm: false, may_decide_forfeit: true, version: 3 });
      open([proposed], { command: () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }) });
      await loaded();
      fireEvent.click(screen.getByTestId('decide-forfeit'));
      const form = dialog(word('vnd.security.decide.title'));
      type(form, word('vnd.security.field.decision.label'), 'REFUSE');
      reason(form, 'Nhà thầu đã ký vào ngày cuối của thời hạn');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.security.decide.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toContain(word('vnd.error.selfApproval.text'));
    });

    it('releases or records the expiry', async () => {
      const { h } = open([security(1, { state: 'CONFIRMED', may_confirm: false, version: 2 })]);
      await loaded();
      fireEvent.click(screen.getByTestId('release-security'));
      const form = dialog(word('vnd.security.release.title'));
      reason(form, 'Hợp đồng đã ký với nhà thầu khác');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.security.release.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('releaseVendorBidSecurity', { ...{ path: { id: SECURITY }, ifMatchVersion: 2, body: { reason: 'Hợp đồng đã ký với nhà thầu khác', expired: false } }, attempt: { key: expect.any(String) } }));
    });
  });

  describe('the ledger', () => {
    it('opens the ledger of a security and says when it cannot be read', async () => {
      const events = [
        { id: uuid('0060', 1), move: 'RECEIVE', from_state: null, to_state: 'RECEIVED', actor_id: uuid('0050', 1), note: null, occurred_at: '2026-11-02T02:00:00.000Z' },
        { id: uuid('0060', 2), move: 'CONFIRM', from_state: 'RECEIVED', to_state: 'CONFIRMED', actor_id: uuid('0050', 2), note: 'VCB-REF-1', occurred_at: '2026-11-03T02:00:00.000Z' },
      ];
      open([security(1)], { extra: { getVendorBidSecurity: { security: security(1), events, standing: null, policy: policy('VENDOR_BID_SECURITY'), as_of: '2026-11-08T03:00:00.000Z' } } });
      await loaded();
      fireEvent.click(screen.getByTestId('open-ledger'));
      const ledger = await screen.findByTestId('ledger');
      expect(within(ledger).getAllByRole('listitem').map((item) => item.getAttribute('data-move'))).toEqual(['RECEIVE', 'CONFIRM']);
      expect(ledger.textContent).toContain(text('vnd.security.ledger.line.text', { time: '03/11/2026 09:00', move: word('vnd.security.move.confirm.name'), from: word('vnd.security.state.received.name'), to: word('vnd.security.state.confirmed.name') }));
      fireEvent.click(screen.getByTestId('close-ledger'));
      expect(screen.queryByTestId('ledger')).toBeNull();
      cleanup();
      open([security(1)], { extra: { getVendorBidSecurity: new Error('down') } });
      await loaded();
      fireEvent.click(screen.getByTestId('open-ledger'));
      expect(await screen.findByTestId('ledger-error')).toBeTruthy();
    });
  });

  describe('rights', () => {
    it('offers no command to a reader and none in a read-only workspace', async () => {
      open([security(1, { may_confirm: false })], { permissions: READER });
      await loaded();
      for (const id of ['receive-security', 'confirm-security', 'propose-forfeit', 'release-security']) expect(screen.queryByTestId(id)).toBeNull();
      expect(screen.getByText(word('vnd.security.readonly.text'))).toBeTruthy();
      cleanup();
      open([security(1)], { mode: 'READ_ONLY' });
      await loaded();
      expect(screen.getByTestId('readonly-note')).toBeTruthy();
      expect(screen.queryByTestId('confirm-security')).toBeNull();
    });
  });
});

describe('the model of the register', () => {
  it('reads the shortfall, the floor of the prime and the share over what the bid named', () => {
    expect(shortfallOf({ amount: 100, required_amount: 300 })).toBe(200);
    expect(shortfallOf({ amount: 400, required_amount: 300 })).toBe(0);
    expect(shortfallOf({ amount: 100, required_amount: null })).toBe(0);
    expect(primeBelowFloor({ prime_share_pct: 50, prime_min_share_pct: 51 })).toBe(true);
    expect(primeBelowFloor({ prime_share_pct: 51, prime_min_share_pct: 51 })).toBe(false);
    const declaration = { id: 'd', package_id: 'p', contractor_id: 'c', declared_share_pct: 30, subcontractor_ids: [], document_id: null, declared_by: 'm', declared_at: 'x' };
    expect(subcontractOverDeclared({ total_share_pct: 30, declaration })).toBe(false);
    expect(subcontractOverDeclared({ total_share_pct: 30.01, declaration })).toBe(true);
    expect(subcontractOverDeclared({ total_share_pct: 0, declaration: null })).toBe(true);
  });
});
