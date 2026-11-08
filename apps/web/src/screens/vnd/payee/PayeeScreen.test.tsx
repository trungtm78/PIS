import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import PayeeScreen from './PayeeScreen';
import { ALL, CONTRACTOR, DOCUMENT, READER, account, bankEvent, change, client, mount, profileView, routeOf, uuid, verdict } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });
const route = routeOf('VND-04', 'FR-VND-04');
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const labelOf = (label: string): RegExp => new RegExp(escaped(label));
const PATH = `/vnd/vnd-04?contractor=${CONTRACTOR}`;
const CHANGE = uuid('0004', 1);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
  failing?: World['failing'];
}

const waiting = () =>
  profileView({
    accounts: [account(1)],
    payee_verdict: verdict({ allowed: false, reason: 'IN_WAITING_PERIOD', warnings: ['PAYEE_CHANGE_PENDING'] }),
    payee_changes: [change(1)],
    bank_events: [bankEvent(1), bankEvent(2, { action: 'CONTRACT_MATCHED', actor_name: 'Phạm Quốc Bảo', note: 'Khớp hợp đồng số 12', occurred_at: '2026-11-07T03:00:00.000Z' })],
  });

function open(view: Record<string, unknown> = waiting(), options: Options = {}) {
  const world: World = { answers: { getVendorContractor: view }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<PayeeScreen route={route} />, h, { permissions: options.permissions ?? ALL, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const loaded = async (): Promise<void> => {
  await screen.findByTestId('active-account');
};

describe('PayeeScreen (VND-04): the accounts of one contractor', () => {
  it('shows a red block banner with the reasons in words when payments are not allowed', async () => {
    open();
    await loaded();
    const block = screen.getByTestId('payee-block');
    expect(block.getAttribute('role')).toBe('alert');
    expect(block.textContent).toContain(word('vnd.payee.block.title'));
    expect(screen.getByTestId('payee-block-reasons').textContent).toContain(word('vnd.payeeReason.inWaitingPeriod.text'));
    expect(screen.getByTestId('payee-block-reasons').textContent).toContain(word('vnd.warning.payeeChangePending.name'));
    expect(within(block).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.payee.figure.verdict.name') }) })).toBeTruthy();
    expect(within(block).getByText(word('vnd.flag.unverified.badge'))).toBeTruthy();
    expect(screen.queryByTestId('payee-allowed')).toBeNull();
  });

  it('shows a plain note, not the banner, when payments are allowed', async () => {
    open(profileView({ accounts: [account(1, { effective_after: '2026-10-01T03:00:00.000Z' })], payee_verdict: verdict({ allowed: true }), payee_changes: [] }));
    await loaded();
    expect(screen.queryByTestId('payee-block')).toBeNull();
    expect(screen.getByTestId('payee-allowed').textContent).toContain(word('vnd.payee.allowed.title'));
    expect(screen.getByTestId('payee-allowed').textContent).toContain(text('vnd.payee.allowed.since.text', { day: '01/10/2026' }));
  });

  it('shows the account in force with a masked number, who it is held by, and counts the waiting period down from the moment of the answer', async () => {
    open();
    await loaded();
    const facts = screen.getByTestId('active-account');
    expect(facts.textContent).toContain('Ngân hàng Công Thương');
    expect(screen.getByTestId('account-number').querySelector('dd')?.textContent).toBe('••••6789');
    expect(screen.getByTestId('account-holder').textContent).toContain(word('vnd.payee.holder.matches'));
    expect(screen.getByTestId('account-waiting').textContent).toContain(text('vnd.payee.account.countdown.text', { days: 4, hours: 0 }));
    expect(screen.getByTestId('account-waiting').textContent).toContain(text('vnd.payee.account.until.text', { time: '12/11/2026 10:00' }));
  });

  it('says the account is in force once the waiting period is over', async () => {
    open(profileView({ accounts: [account(1, { effective_after: '2026-11-01T03:00:00.000Z' })], payee_verdict: verdict(), payee_changes: [] }));
    await loaded();
    expect(screen.getByTestId('account-waiting').textContent).toContain(text('vnd.payee.account.inForce.text', { time: '01/11/2026 10:00' }));
    expect(screen.getByTestId('account-waiting').textContent).not.toContain('Còn');
  });

  it('NEVER shows a whole account number: a number the server forgot to mask is cut to its last four digits', async () => {
    open(profileView({ accounts: [account(1, { account_no_masked: '0011223344556677' })], payee_changes: [change(1, { account_no_masked: '9988776655' })], bank_events: [] }));
    await loaded();
    expect(screen.getByTestId('account-number').querySelector('dd')?.textContent).toBe('••••6677');
    expect(screen.getByTestId('change-number').textContent).toBe('••••6655');
    expect(document.body.textContent).not.toContain('0011223344556677');
    expect(document.body.textContent).not.toContain('9988776655');
  });

  it('lists an account that was replaced or closed under the one in force', async () => {
    open(profileView({ accounts: [account(1), account(2, { state: 'SUPERSEDED', superseded_at: '2026-10-01T03:00:00.000Z', account_no_masked: '••••1111' }), account(3, { state: 'CLOSED', closed_reason: 'Ngân hàng đóng', account_no_masked: '••••2222' })] }));
    await loaded();
    expect(document.body.textContent).toContain(text('vnd.payee.account.superseded.text', { day: '01/10/2026' }));
    expect(document.body.textContent).toContain(text('vnd.payee.account.closed.text', { reason: 'Ngân hàng đóng' }));
    expect(document.body.textContent).toContain('••••1111');
  });

  it('says there is no account', async () => {
    open(profileView({ accounts: [], payee_verdict: verdict({ allowed: false, reason: 'NO_ACCOUNT_REGISTERED' }), payee_changes: [] }));
    await screen.findByTestId('account-none');
    expect(screen.getByTestId('payee-block-reasons').textContent).toContain(word('vnd.payeeReason.noAccountRegistered.text'));
  });

  describe('a change request', () => {
    it('shows the request with who asked, the evidence and the three steps waiting', async () => {
      open();
      await loaded();
      const card = screen.getByTestId('change');
      expect(card.getAttribute('data-status')).toBe('REQUESTED');
      expect(within(card).getByTestId('change-number').textContent).toBe('••••4321');
      expect(within(card).getByTestId('change-requested').textContent).toContain(text('vnd.payee.change.requestedAt.text', { name: 'Lê Thị Hoa', time: '06/11/2026 09:00' }));
      expect(within(card).getByTestId('change-evidence').textContent).toContain(DOCUMENT);
      const steps = within(card).getAllByRole('listitem');
      expect(steps.map((step) => step.getAttribute('data-step'))).toEqual(['CONTRACT_MATCH', 'ACCOUNT_MATCH', 'CALLBACK']);
      for (const step of steps) expect(step.textContent).toContain(word('vnd.payee.step.waiting.text'));
    });

    it('shows who did each step that is done, the outcome of the call-back and only the last four digits of the number called', async () => {
      open(
        profileView({
          payee_changes: [
            change(1, {
              contract_match_by_name: 'Nguyễn Văn An',
              contract_match_at: '2026-11-07T02:00:00.000Z',
              contract_match_note: 'Khớp hợp đồng số 12',
              account_match_by_name: 'Phạm Quốc Bảo',
              account_match_at: '2026-11-07T03:00:00.000Z',
              callback_by_name: 'Trần Thị Mai',
              callback_at: '2026-11-07T04:00:00.000Z',
              callback_outcome: 'CONFIRMED',
              callback_number_last4: '4567',
              remaining: [],
              may_approve_contract_match: false,
              may_approve_account_match: false,
              may_callback: false,
            }),
          ],
        }),
      );
      await loaded();
      const card = screen.getByTestId('change');
      const [contract, accountStep, callback] = within(card).getAllByRole('listitem');
      expect(contract?.textContent).toContain(text('vnd.payee.step.by.text', { name: 'Nguyễn Văn An', time: '07/11/2026 09:00' }));
      expect(contract?.textContent).toContain('Khớp hợp đồng số 12');
      expect(accountStep?.textContent).toContain('Phạm Quốc Bảo');
      expect(callback?.textContent).toContain(word('vnd.callbackOutcome.confirmed.name'));
      expect(callback?.textContent).toContain(text('vnd.payee.callback.last4.text', { last4: '4567' }));
      expect(within(card).queryByTestId('approve-contract')).toBeNull();
    });

    it('offers each step only to the person the answer says may do it', async () => {
      open(profileView({ payee_changes: [change(1, { may_approve_contract_match: true, may_approve_account_match: false, may_callback: false, may_reject: false })] }));
      await loaded();
      expect(screen.getByTestId('approve-contract')).toBeTruthy();
      expect(screen.queryByTestId('approve-account')).toBeNull();
      expect(screen.queryByTestId('record-callback')).toBeNull();
      expect(screen.queryByTestId('reject-change')).toBeNull();
      expect(screen.queryByTestId('cancel-change')).toBeNull();
    });

    it('approves the contract match under the version of the request, with an optional note', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('approve-contract'));
      const form = dialog(word('vnd.payee.approve.contract.title'));
      expect(form.textContent).toContain('••••4321');
      type(form, word('vnd.payee.field.note.label'), 'Khớp hợp đồng số 12');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.changeStep.contractMatch.name') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('approveVendorPayeeChange', { path: { id: CHANGE }, ifMatchVersion: 3, body: { role: 'CONTRACT_MATCH', note: 'Khớp hợp đồng số 12' }, attempt: { key: expect.any(String) } }));
      expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.payee.approve.contract.title'));
    });

    it('approves the account match without a note', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('approve-account'));
      const form = dialog(word('vnd.payee.approve.account.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.changeStep.accountMatch.name') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('approveVendorPayeeChange', expect.objectContaining({ body: { role: 'ACCOUNT_MATCH' } })));
    });

    it('says in the dialog that the requester or the same approver may not approve again (403 SELF_APPROVAL_DENIED)', async () => {
      open(waiting(), { command: () => Promise.reject(problem(403, 'SELF_APPROVAL_DENIED')) });
      await loaded();
      fireEvent.click(screen.getByTestId('approve-contract'));
      const form = dialog(word('vnd.payee.approve.contract.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.changeStep.contractMatch.name') }));
      const alert = await within(form).findByRole('alert');
      expect(alert.textContent).toBe(word('vnd.error.selfApproval.text'));
      expect(alert.getAttribute('data-code')).toBe('SELF_APPROVAL_DENIED');
    });

    it('records the call-back with the outcome, the number called and whether it was the number on file', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('record-callback'));
      const form = dialog(word('vnd.payee.callback.title'));
      const send = within(form).getByRole('button', { name: word('vnd.payee.callback.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      type(form, word('vnd.payee.field.outcome.label'), 'CONFIRMED');
      type(form, word('vnd.payee.field.called.label'), '0901 23');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.payee.field.called.label'), '0901234567');
      fireEvent.click(within(form).getByLabelText(labelOf(word('vnd.payee.field.onFile.label'))));
      type(form, word('vnd.payee.field.note.label'), 'Nhà thầu xác nhận qua điện thoại');
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordVendorPayeeCallback', { path: { id: CHANGE }, ifMatchVersion: 3, body: { outcome: 'CONFIRMED', called_number: '0901234567', used_number_on_file: true, note: 'Nhà thầu xác nhận qua điện thoại' }, attempt: { key: expect.any(String) } }));
      await waitFor(() => expect(document.body.textContent).not.toContain('0901234567'));
    });

    it('sends false when the person did not tick that they called the number on file, and says the call-back is invalid when the server refuses it', async () => {
      const { h } = open(waiting(), { command: () => Promise.reject(problem(422, 'BANK_CHANGE_CALLBACK_INVALID')) });
      await loaded();
      fireEvent.click(screen.getByTestId('record-callback'));
      const form = dialog(word('vnd.payee.callback.title'));
      type(form, word('vnd.payee.field.outcome.label'), 'NOT_CONFIRMED');
      type(form, word('vnd.payee.field.called.label'), '0901234567');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.payee.callback.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.callbackInvalid.text'));
      expect(h.command).toHaveBeenCalledWith('recordVendorPayeeCallback', expect.objectContaining({ body: { outcome: 'NOT_CONFIRMED', called_number: '0901234567', used_number_on_file: false } }));
    });

    it('withdraws a request (the requester) and rejects one (an approver), each with a reason of at least five characters', async () => {
      const { h } = open(profileView({ payee_changes: [change(1, { may_cancel: true, may_reject: true })] }));
      await loaded();
      fireEvent.click(screen.getByTestId('cancel-change'));
      let form = dialog(word('vnd.payee.cancel.title'));
      const send = within(form).getByRole('button', { name: word('vnd.payee.cancel.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.field.reason.label'), 'abc');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.field.reason.label'), 'Gửi nhầm số tài khoản');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('cancelVendorPayeeChange', { path: { id: CHANGE }, ifMatchVersion: 3, body: { reason: 'Gửi nhầm số tài khoản' }, attempt: { key: expect.any(String) } }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(screen.getByTestId('reject-change'));
      form = dialog(word('vnd.payee.reject.title'));
      type(form, word('vnd.field.reason.label'), 'Tên chủ tài khoản không khớp');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.payee.reject.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('rejectVendorPayeeChange', expect.objectContaining({ body: { reason: 'Tên chủ tài khoản không khớp' } })));
    });

    it('says a changed version of the request and offers to read it again', async () => {
      open(waiting(), { command: () => Promise.reject(problem(409, 'VERSION_CONFLICT')) });
      await loaded();
      fireEvent.click(screen.getByTestId('approve-account'));
      const form = dialog(word('vnd.payee.approve.account.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.changeStep.accountMatch.name') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.conflict.text'));
      expect(within(form).getByRole('button', { name: word('vnd.dialog.reload.action') })).toBeTruthy();
    });

    it('marks the request the address names', async () => {
      open(waiting(), { path: `${PATH}&change=${CHANGE}` });
      await loaded();
      expect(screen.getByTestId('change').getAttribute('data-focus')).toBe('true');
    });

    it('puts the open requests before the closed ones', async () => {
      open(profileView({ payee_changes: [change(2, { status: 'REJECTED', requested_at: '2026-11-07T02:00:00.000Z', closed_at: '2026-11-07T05:00:00.000Z', closed_reason: 'Không khớp' }), change(1)] }));
      await loaded();
      const cards = screen.getAllByTestId('change');
      expect(cards.map((card) => card.getAttribute('data-status'))).toEqual(['REQUESTED', 'REJECTED']);
      expect(cards[1]?.textContent).toContain(text('vnd.payee.change.closedAt.text', { time: '07/11/2026 12:00', reason: 'Không khớp' }));
    });

    it('says there is no request', async () => {
      open(profileView({ payee_changes: [] }));
      await loaded();
      expect(screen.getByTestId('changes-empty').textContent).toBe(word('vnd.payee.changes.empty.text'));
    });
  });

  describe('requesting a change', () => {
    const fillAll = (form: HTMLElement): void => {
      type(form, word('vnd.payee.field.bank.label'), 'Ngân hàng Ngoại Thương');
      type(form, word('vnd.payee.field.holder.label'), 'CÔNG TY NHÀ THẦU 1');
      type(form, word('vnd.payee.field.number.label'), '0123456789012');
      type(form, word('vnd.payee.field.reason.label'), 'Đổi sang tài khoản mới theo thư');
      type(form, word('vnd.payee.field.evidence.label'), DOCUMENT);
    };

    it('asks the number in a plain text field the browser does not remember, sends the body of the request and clears the number', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('request-change'));
      const form = dialog(word('vnd.payee.request.title'));
      const number = within(form).getByLabelText(labelOf(word('vnd.payee.field.number.label'))) as HTMLInputElement;
      expect(number.type).toBe('text');
      expect(number.getAttribute('autocomplete')).toBe('off');
      const send = within(form).getByRole('button', { name: word('vnd.payee.request.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      fillAll(form);
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('requestVendorPayeeChange', {
        path: { id: CONTRACTOR },
        body: { bank_name: 'Ngân hàng Ngoại Thương', account_holder: 'CÔNG TY NHÀ THẦU 1', account_number: '0123456789012', reason: 'Đổi sang tài khoản mới theo thư', evidence_document_id: DOCUMENT },
        attempt: { key: expect.any(String) },
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.body.textContent).not.toContain('0123456789012');
      expect(document.querySelector('input[value="0123456789012"]')).toBeNull();
    });

    it('keeps the lengths of the request: a number of five digits, a reason of nine characters and a letter that is not an identifier are not accepted', async () => {
      open();
      await loaded();
      fireEvent.click(screen.getByTestId('request-change'));
      const form = dialog(word('vnd.payee.request.title'));
      fillAll(form);
      const send = within(form).getByRole('button', { name: word('vnd.payee.request.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.payee.field.number.label'), '12345');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.payee.field.number.label'), '123456');
      expect(send.disabled).toBe(false);
      type(form, word('vnd.payee.field.reason.label'), 'dưới mười');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.payee.field.reason.label'), 'mười ký tự ');
      type(form, word('vnd.payee.field.evidence.label'), 'thu-nha-thau');
      expect(send.disabled).toBe(true);
    });

    it('says that the holder does not match the legal name when the server refuses it, and shows the field detail of a 422', async () => {
      let attempt = 0;
      open(waiting(), { command: () => Promise.reject(++attempt === 1 ? problem(422, 'PAYEE_ACCOUNT_NAME_MISMATCH') : problem(422, 'VALIDATION_FAILED', 'account_number: wrong length')) });
      await loaded();
      fireEvent.click(screen.getByTestId('request-change'));
      const form = dialog(word('vnd.payee.request.title'));
      fillAll(form);
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.payee.request.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.nameMismatch.text'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.payee.request.confirm') }));
      await waitFor(() => expect(within(form).getByRole('alert').textContent).toContain('account_number: wrong length'));
    });

    it('is offered only when the answer says the caller may request', async () => {
      open(profileView({ actions: { ...(profileView().actions as object), request_payee_change: false } }));
      await loaded();
      expect(screen.queryByTestId('request-change')).toBeNull();
    });
  });

  describe('closing the account', () => {
    it('closes the account in force with a reason, under the version of the account', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('close-account'));
      const form = dialog(word('vnd.payee.close.title'));
      expect(form.textContent).toContain('••••6789');
      type(form, word('vnd.field.reason.label'), 'Ngân hàng đóng tài khoản');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.payee.close.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('closeVendorPayeeAccount', { path: { id: uuid('0003', 1) }, ifMatchVersion: 2, body: { reason: 'Ngân hàng đóng tài khoản' }, attempt: { key: expect.any(String) } }));
    });

    it('is offered only to a person who may approve', async () => {
      open(waiting(), { permissions: READER });
      await loaded();
      expect(screen.queryByTestId('close-account')).toBeNull();
    });
  });

  describe('the chain log', () => {
    it('lists every event with when, what, who and the note', async () => {
      open();
      await loaded();
      const rows = Array.from(document.querySelectorAll('tr[data-event-id]'));
      expect(rows).toHaveLength(2);
      expect(rows[1]?.textContent).toContain('CONTRACT_MATCHED');
      expect(rows[1]?.textContent).toContain('Phạm Quốc Bảo');
      expect(rows[1]?.textContent).toContain('Khớp hợp đồng số 12');
      expect(rows[1]?.textContent).toContain('07/11/2026 10:00');
    });

    it('says a system step as such and an empty log as empty', async () => {
      open(profileView({ bank_events: [bankEvent(1, { actor_name: null })] }));
      await loaded();
      expect(document.querySelector('tr[data-event-id]')?.textContent).toContain(word('vnd.payee.log.system.text'));
      cleanup();
      open(profileView({ bank_events: [] }));
      await loaded();
      expect(screen.getByTestId('log-empty')).toBeTruthy();
    });
  });

  describe('read-only and states', () => {
    it('offers no command in a read-only workspace', async () => {
      open(waiting(), { mode: 'READ_ONLY' });
      await loaded();
      expect(screen.getByTestId('readonly-note')).toBeTruthy();
      for (const id of ['request-change', 'approve-contract', 'approve-account', 'record-callback', 'close-account']) expect(screen.queryByTestId(id)).toBeNull();
    });

    it('LOADING, ERROR with retry, FORBIDDEN, EMPTY for a contractor that is not there', async () => {
      const pending = client({ answers: {} });
      pending.read.mockImplementation(() => new Promise(() => undefined));
      mount(<PayeeScreen route={route} />, pending, { permissions: ALL, path: PATH });
      expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
      cleanup();
      open(waiting(), { failing: { getVendorContractor: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await loaded();
      cleanup();
      open(waiting(), { failing: { getVendorContractor: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
      cleanup();
      open(waiting(), { failing: { getVendorContractor: { error: problem(404, 'RESOURCE_NOT_FOUND'), times: 9 } } });
      expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    });

    it('STALE: keeps the last reading when a refresh fails', async () => {
      let calls = 0;
      const world: World = { answers: { getVendorContractor: () => (++calls === 1 ? waiting() : problem(500, 'INTERNAL_ERROR')) } };
      const mounted = mount(<PayeeScreen route={route} />, client(world), { permissions: ALL, path: PATH });
      await loaded();
      await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
      expect(await screen.findByTestId('stale-notice')).toBeTruthy();
      expect(screen.getByTestId('active-account')).toBeTruthy();
    });
  });
});

describe('PayeeScreen (VND-04): the queue across contractors', () => {
  const queue = (items: Array<Record<string, unknown>> = [change(1), change(2, { contractor_id: uuid('0001', 2), contractor_name: 'Công ty nhà thầu 2', may_approve_contract_match: false })], options: Options = {}) => {
    const world: World = { answers: { listVendorPayeeChanges: { items, policy: { code: 'VENDOR_PAYEE_ACCOUNT', version: 'D-1', unverified: true, formula: 'F', source: 'S', as_of: '2026-11-01', params: {} }, as_of: '2026-11-08T03:00:00.000Z' } }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
    const h = client(world, options.command);
    mount(<PayeeScreen route={route} />, h, { permissions: options.permissions ?? ALL, path: '/vnd/vnd-04', ...(options.mode === undefined ? {} : { mode: options.mode }) });
    return { h, world };
  };

  it('reads the requests of every contractor still in progress, with a link to each contractor', async () => {
    const { h } = queue();
    await screen.findAllByTestId('change');
    expect(h.read).toHaveBeenCalledWith('listVendorPayeeChanges', { query: { status: 'REQUESTED' } });
    expect(screen.getAllByTestId('change')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Công ty nhà thầu 2' }).getAttribute('href')).toBe(`/vnd/vnd-04?contractor=${uuid('0001', 2)}`);
    expect(screen.getAllByTestId('change-number').every((node) => /^••••\d{4}$/.test(node.textContent ?? ''))).toBe(true);
    expect(screen.queryByTestId('request-change')).toBeNull();
  });

  it('filters by the status of the request', async () => {
    const { h } = queue();
    await screen.findAllByTestId('change');
    fireEvent.change(screen.getByLabelText(word('vnd.payee.queue.status.label')), { target: { value: '' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorPayeeChanges', { query: {} }));
    fireEvent.change(screen.getByLabelText(word('vnd.payee.queue.status.label')), { target: { value: 'REJECTED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorPayeeChanges', { query: { status: 'REJECTED' } }));
  });

  it('acts on a request from the queue, under the version of that request', async () => {
    const { h } = queue();
    await screen.findAllByTestId('change');
    fireEvent.click(screen.getAllByTestId('approve-contract')[0] as HTMLElement);
    const form = dialog(word('vnd.payee.approve.contract.title'));
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.changeStep.contractMatch.name') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('approveVendorPayeeChange', expect.objectContaining({ path: { id: CHANGE }, ifMatchVersion: 3, body: { role: 'CONTRACT_MATCH' } })));
  });

  it('EMPTY: says there is no request, and no request in a status that was filtered', async () => {
    queue([]);
    expect((await screen.findByTestId('queue-empty')).textContent).toBe(word('vnd.payee.queue.emptyFiltered.text'));
    fireEvent.change(screen.getByLabelText(word('vnd.payee.queue.status.label')), { target: { value: '' } });
    await waitFor(() => expect(screen.getByTestId('queue-empty').textContent).toBe(word('vnd.payee.queue.empty.text')));
  });

  it('LOADING, ERROR with retry, FORBIDDEN', async () => {
    const pending = client({ answers: {} });
    pending.read.mockImplementation(() => new Promise(() => undefined));
    mount(<PayeeScreen route={route} />, pending, { permissions: ALL, path: '/vnd/vnd-04' });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    queue(undefined, { failing: { listVendorPayeeChanges: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findAllByTestId('change');
    cleanup();
    queue(undefined, { failing: { listVendorPayeeChanges: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
  });
});
