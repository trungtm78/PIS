import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PLAN_READER, PROJECT, client, household, mount, paymentRecord, planRecord, routeOf, world } from '../test-support';
import { todayInVietnam } from '../model';
import PaymentScreen from './PaymentScreen';

const ROUTE = routeOf('LND-07', 'FR-LND-07');
const PATH = `/lnd/lnd-07?project=${PROJECT}`;
const OK = { operation_id: 'o', status: 'PAID', resource_version: 2, resource_id: paymentRecord(1, planRecord(2).id).id };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const PAYER = ['land.payment.write', 'land.read'];
const DOCUMENT = '00000000-0000-4000-8000-000000000b01';
const TODAY = todayInVietnam();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const APPROVED = { approved_on: '2020-01-31', payment_due_on: '2020-03-01', decision_document_version_id: DOCUMENT };
const worldOf = () =>
  world({
    households: [household(1), household(2, { household_code: 'HH-000002' })],
    plans: [
      planRecord(1, { status: 'APPROVED', ...APPROVED, total_support_vnd: '870000000', grand_total_vnd: '870000000', version: 5 }),
      planRecord(2, { status: 'PAYING', ...APPROVED, total_support_vnd: '870000000', grand_total_vnd: '870000000', version: 6 }),
      planRecord(3, { status: 'COMPLETED', ...APPROVED, plan_code: 'PA-0003', version: 8 }),
      planRecord(4, { status: 'POSTING', plan_code: 'PA-0004' }),
      planRecord(5, { status: 'DRAFT', plan_code: 'PA-0005' }),
    ],
    payments: [
      paymentRecord(1, planRecord(2).id, { bank_account_masked: '******6789', due_on: '2020-03-01' }),
      paymentRecord(2, planRecord(2).id, { household_id: household(2).id, household_code: 'HH-000002', amount_vnd: '300000000', status: 'PAID', paid_on: '2020-02-28', method: 'TREASURY', voucher_document_version_id: DOCUMENT, advance_id: '00000000-0000-4000-8000-000000000c01', due_on: '2020-03-01', version: 2 }),
      paymentRecord(3, planRecord(2).id, { household_id: household(2).id, household_code: 'HH-000002', payment_no: 2, amount_vnd: '120000000', status: 'PAID', paid_on: '2020-03-02', method: 'BANK_TRANSFER', voucher_document_version_id: DOCUMENT, late_reason: 'Kho bạc nghỉ ngày đến hạn', due_on: '2020-03-01', version: 2 }),
      paymentRecord(4, planRecord(2).id, { payment_no: 3, amount_vnd: '50000000', status: 'DEPOSITED', paid_on: '2020-03-01', method: 'DEPOSITED', voucher_document_version_id: DOCUMENT, deposit_reason: 'Hộ không nhận tiền', due_on: '2020-03-01', version: 2 }),
      paymentRecord(5, planRecord(2).id, { payment_no: 4, amount_vnd: '7000000', status: 'CANCELLED', due_on: '2020-03-01', version: 2 }),
    ],
  });
const rowOf = (n: number): HTMLElement => document.querySelector(`[data-plan-id="${planRecord(n).id}"]`) as HTMLElement;
const paymentOf = (n: number): HTMLElement => document.querySelector(`[data-payment-id="${paymentRecord(n, planRecord(2).id).id}"]`) as HTMLElement;
const ready = () => screen.findByTestId('plans');
const label = (key: string, code: string, revision = 1) => vi_[key as keyof typeof vi_].replace('{code}', code).replace('{revision}', String(revision));
const open = async (n = 2) => {
  await ready();
  fireEvent.click(within(rowOf(n)).getByRole('button', { name: label('lnd.payments.open.aria', planRecord(n).plan_code) }));
  await screen.findByTestId('payment-detail');
  await waitFor(() => expect(document.querySelector('[data-payment-id]')).not.toBeNull());
};

describe('PaymentScreen (LND-07): the payments of an approved plan to its households', () => {
  it('UI-LND-07: asks for a project first and lists the plans that were approved, are being paid or were paid in full', async () => {
    mount(<PaymentScreen route={ROUTE} />, client(worldOf()), { permissions: PAYER, path: '/lnd/lnd-07' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(vi_['lnd.payments.project.notice']);
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.payments.project.label']), { target: { value: PROJECT } });
    await ready();
    expect(Array.from(document.querySelectorAll('[data-plan-id]')).map((row) => row.getAttribute('data-plan-id'))).toEqual([1, 2, 3].map((n) => planRecord(n).id));
    expect(within(rowOf(1)).getByTestId('approved').textContent).toBe('2020-01-31');
    expect(within(rowOf(1)).getByTestId('due').textContent).toBe('2020-03-01');
    expect(within(rowOf(2)).getByTestId('status').textContent).toBe(vi_['lnd.planStatus.paying.label']);
    expect(within(rowOf(1)).getByRole('button', { name: label('lnd.payments.schedule.aria', 'PA-0001') })).toBeTruthy();
    expect(within(rowOf(2)).getByRole('button', { name: label('lnd.payments.schedule.aria', 'PA-0002') })).toBeTruthy();
    expect(within(rowOf(3)).queryByRole('button', { name: label('lnd.payments.schedule.aria', 'PA-0003') })).toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['lnd.payments.project.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-project')).toBeTruthy();
  });

  it('says so when the project has no approved plan', async () => {
    mount(<PaymentScreen route={ROUTE} />, client(world({ plans: [planRecord(1, { status: 'DRAFT' })] })), { permissions: PAYER, path: PATH });
    expect((await screen.findByTestId('no-plans')).textContent).toBe(vi_['lnd.payments.empty.notice']);
  });

  it('UI-LND-07, UAT-AC378: shows each payment with the day it is due and how late it is, the day it was paid and how, its voucher and the advance it settled, the reason of a late one and of a deposit, and the account only masked', async () => {
    mount(<PaymentScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    await open();
    expect(screen.getByTestId('tile-plan').textContent).toContain('870.000.000');
    expect(screen.getByTestId('tile-scheduled').textContent).toContain('920.000.000');
    expect(screen.getByTestId('tile-settled').textContent).toContain('470.000.000');
    expect(screen.getByTestId('tile-pending').textContent).toContain('450.000.000');
    const waiting = paymentOf(1);
    expect(within(waiting).getByTestId('amount').textContent).toBe('450.000.000');
    expect(within(waiting).getByTestId('left').textContent).toMatch(/^Quá hạn \d+ ngày$/);
    expect(within(waiting).getByTestId('account').textContent).toBe('******6789');
    expect(within(waiting).getByTestId('payment-status').textContent).toBe(vi_['lnd.paymentStatus.pending.label']);
    expect(within(waiting).queryByRole('button')).toBeNull();
    const paid = paymentOf(2);
    expect(within(paid).getByTestId('paid').textContent).toBe('2020-02-28');
    expect(within(paid).getByTestId('method').textContent).toBe(vi_['lnd.paymentMethod.treasury.label']);
    expect(within(paid).getByTestId('voucher').textContent).toBe(DOCUMENT);
    expect(within(paid).getByTestId('advance').textContent).toBe('00000000-0000-4000-8000-000000000c01');
    expect(within(paid).queryByTestId('left')).toBeNull();
    expect(within(paymentOf(3)).getByTestId('late-reason').textContent).toBe(vi_['lnd.payments.paymentRow.late'].replace('{reason}', 'Kho bạc nghỉ ngày đến hạn'));
    expect(within(paymentOf(4)).getByTestId('deposit-reason').textContent).toBe('Hộ không nhận tiền');
    expect(within(paymentOf(4)).getByTestId('method').textContent).toBe(vi_['lnd.paymentMethod.deposited.label']);
    expect(within(paymentOf(5)).getByTestId('payment-status').textContent).toBe(vi_['lnd.paymentStatus.cancelled.label']);
    expect(within(paymentOf(1)).getByTestId('paid').textContent).toBe(vi_['lnd.payments.value.none']);
    expect(screen.getByTestId('payments').textContent).not.toContain('0123456789');
  });

  it('shows the days left to a payment that is not yet due', async () => {
    const future = worldOf();
    future.payments = [paymentRecord(1, planRecord(2).id, { due_on: '2999-01-31' })];
    mount(<PaymentScreen route={ROUTE} />, client(future), { permissions: PLAN_READER, path: PATH });
    await open();
    expect(within(paymentOf(1)).getByTestId('left').textContent).toMatch(/^Còn \d+ ngày$/);
  });

  it('UI-LND-07: says so when the payments cannot be read, are none in the unit, or are being read', async () => {
    const failing = worldOf();
    failing.failing.add('listCompensationPayments');
    mount(<PaymentScreen route={ROUTE} />, client(failing), { permissions: PLAN_READER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: label('lnd.payments.open.aria', 'PA-0002') }));
    expect((await screen.findByTestId('payments-failed')).textContent).toBe(vi_['lnd.payments.list.failed']);
    cleanup();
    const empty = worldOf();
    empty.payments = [];
    mount(<PaymentScreen route={ROUTE} />, client(empty), { permissions: PLAN_READER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: label('lnd.payments.open.aria', 'PA-0002') }));
    const detail = await screen.findByTestId('payment-detail');
    expect(within(detail).getByRole('status').textContent).toBe(vi_['lnd.payments.list.loading']);
    expect((await screen.findByTestId('payments-empty')).textContent).toBe(vi_['lnd.payments.list.empty']);
  });

  it('AC-ST-LND-007-1, UI-LND-07: schedules a payment for a household with a whole amount, a due day inside the days of the plan and an account, under the version of the plan', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'PAYING' }));
    mount(<PaymentScreen route={ROUTE} />, h, { permissions: PAYER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: label('lnd.payments.schedule.aria', 'PA-0001') }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: 'HH-000001' });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.required.error']).length).toBe(2);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.household.label']), { target: { value: household(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.amount.label']), { target: { value: '0' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.due.label']), { target: { value: '2020-01-31' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.account.label']), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.invalid.error']).length).toBe(2);
    expect(within(dialog).getByText(vi_['lnd.payments.field.early.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.due.label']), { target: { value: '2020-03-02' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.account.label']), { target: { value: 'x'.repeat(41) } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.amount.label']), { target: { value: '450000000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.payments.field.future.error'])).toBeTruthy();
    expect(within(dialog).getByText(vi_['lnd.field.tooLong.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.due.label']), { target: { value: '2020-02-20' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.account.label']), { target: { value: '0123456789' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'scheduleCompensationPayments',
      expect.objectContaining({ path: { id: planRecord(1).id }, ifMatchVersion: 5, body: { payments: [{ household_id: household(1).id, amount_vnd: '450000000', due_on: '2020-02-20', bank_account: '0123456789' }] } }),
    );
  });

  it('sends only what was filled in when a payment is scheduled', async () => {
    const h = client(worldOf(), () => OK);
    mount(<PaymentScreen route={ROUTE} />, h, { permissions: PAYER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: label('lnd.payments.schedule.aria', 'PA-0002') }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: 'HH-000002' });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.household.label']), { target: { value: household(2).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.scheduleDialog.amount.label']), { target: { value: ' 300000000 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('scheduleCompensationPayments', expect.objectContaining({ body: { payments: [{ household_id: household(2).id, amount_vnd: '300000000' }] }, ifMatchVersion: 6 }));
  });

  it('AC-ST-LND-007-1, UAT-AC378, UI-LND-07: confirms a payment with its method and voucher; the reason of lateness is asked for only when the day is after the day it is due', async () => {
    const h = client(worldOf(), () => OK);
    mount(<PaymentScreen route={ROUTE} />, h, { permissions: PAYER, path: PATH });
    await open();
    fireEvent.click(within(paymentOf(1)).getByRole('button', { name: vi_['lnd.payments.confirm.aria'].replace('{household}', 'HH-000001').replace('{number}', '1') }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.date.label']) as HTMLInputElement).value).toBe(TODAY);
    // Today is after the day the payment was due (2020-03-01), so the reason is asked for.
    expect(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.late.label'])).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.required.error']).length).toBe(3);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.date.label']), { target: { value: '2999-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.voucher.label']), { target: { value: 'nope' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.treasury.label']), { target: { value: 'nope' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.advance.label']), { target: { value: 'nope' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.payments.field.future.error'])).toBeTruthy();
    expect(within(dialog).getAllByText(vi_['lnd.field.invalid.error']).length).toBe(3);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.date.label']), { target: { value: '2020-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.payments.field.early.error'])).toBeTruthy();
    // On the day it is due the reason goes away.
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.date.label']), { target: { value: '2020-03-01' } });
    expect(within(dialog).queryByLabelText(vi_['lnd.payments.confirmDialog.late.label'])).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.method.label']), { target: { value: 'BANK_TRANSFER' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.voucher.label']), { target: { value: ` ${DOCUMENT.toUpperCase()} ` } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.treasury.label']), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.advance.label']), { target: { value: '' } });
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('confirmCompensationPayment', expect.objectContaining({ path: { id: paymentRecord(1, planRecord(2).id).id }, ifMatchVersion: 1, body: { paid_on: '2020-03-01', method: 'BANK_TRANSFER', voucher_document_version_id: DOCUMENT } }));
  });

  it('AC-ST-LND-007-2, UAT-AC383, UI-LND-07: sends the late reason and the advance and the treasury transaction a payment settles', async () => {
    const h = client(worldOf(), () => OK);
    mount(<PaymentScreen route={ROUTE} />, h, { permissions: PAYER, path: PATH });
    await open();
    fireEvent.click(within(paymentOf(1)).getByRole('button', { name: vi_['lnd.payments.confirm.aria'].replace('{household}', 'HH-000001').replace('{number}', '1') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.date.label']), { target: { value: '2020-03-02' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.method.label']), { target: { value: 'TREASURY' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.voucher.label']), { target: { value: DOCUMENT } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.treasury.label']), { target: { value: '00000000-0000-4000-8000-000000000d01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.advance.label']), { target: { value: '00000000-0000-4000-8000-000000000C01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.late.label']), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.tooLong.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.late.label']), { target: { value: 'a\u0007b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.confirmDialog.late.label']), { target: { value: '  Kho bạc nghỉ ngày đến hạn  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'confirmCompensationPayment',
      expect.objectContaining({
        body: {
          paid_on: '2020-03-02',
          method: 'TREASURY',
          voucher_document_version_id: DOCUMENT,
          treasury_transaction_id: '00000000-0000-4000-8000-000000000d01',
          advance_id: '00000000-0000-4000-8000-000000000c01',
          late_reason: 'Kho bạc nghỉ ngày đến hạn',
        },
      }),
    );
  });

  it('UAT-AC378, UI-LND-07: deposits the money of a household that did not take it, with the reason and the record of the deposit, and the plan may be asked of the paid ones no more', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'DEPOSITED' }));
    mount(<PaymentScreen route={ROUTE} />, h, { permissions: PAYER, path: PATH });
    await open();
    expect(within(paymentOf(2)).queryByRole('button')).toBeNull();
    expect(within(paymentOf(4)).queryByRole('button')).toBeNull();
    fireEvent.click(within(paymentOf(1)).getByRole('button', { name: vi_['lnd.payments.deposit.aria'].replace('{household}', 'HH-000001').replace('{number}', '1') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.required.error']).length).toBe(2);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.date.label']), { target: { value: '2999-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.reason.label']), { target: { value: 'a\u0007b' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.voucher.label']), { target: { value: 'nope' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.payments.field.future.error'])).toBeTruthy();
    expect(within(dialog).getAllByText(vi_['lnd.field.invalid.error']).length).toBe(2);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.date.label']), { target: { value: '2020-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.payments.field.early.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.date.label']), { target: { value: '2020-03-05' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.reason.label']), { target: { value: ' Hộ không nhận tiền ' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.voucher.label']), { target: { value: DOCUMENT } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'depositCompensationPayment',
      expect.objectContaining({ path: { id: paymentRecord(1, planRecord(2).id).id }, ifMatchVersion: 1, body: { paid_on: '2020-03-05', deposit_reason: 'Hộ không nhận tiền', voucher_document_version_id: DOCUMENT } }),
    );
  });

  it('offers nothing to write to a reader, to a session that only reads, or on a plan that is no longer being paid', async () => {
    mount(<PaymentScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    await open();
    expect(screen.queryByRole('button', { name: label('lnd.payments.schedule.aria', 'PA-0002') })).toBeNull();
    expect(within(paymentOf(1)).queryByRole('button')).toBeNull();
    cleanup();
    mount(<PaymentScreen route={ROUTE} />, client(worldOf()), { permissions: PAYER, mode: 'READ_ONLY', path: PATH });
    await open();
    expect(within(paymentOf(1)).queryByRole('button')).toBeNull();
    cleanup();
    const done = worldOf();
    done.payments = [paymentRecord(1, planRecord(3).id, { status: 'PENDING' })];
    mount(<PaymentScreen route={ROUTE} />, client(done), { permissions: undefined, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(3)).getByRole('button', { name: label('lnd.payments.open.aria', 'PA-0003') }));
    await screen.findByTestId('payment-detail');
    await waitFor(() => expect(document.querySelector('[data-payment-id]')).not.toBeNull());
    expect(screen.getByTestId('payments').querySelector('button')).toBeNull();
    expect(within(rowOf(1)).getByRole('button', { name: label('lnd.payments.schedule.aria', 'PA-0001') })).toBeTruthy();
  });

  it('says why the server refused each command', async () => {
    const cases: Array<[string, number, Record<string, unknown>, string]> = [
      ['PAYMENT_EXCEEDS_PLAN', 422, { scope: 'HOUSEHOLD' }, 'lnd.payments.problem.exceedsHousehold.error'],
      ['PAYMENT_EXCEEDS_PLAN', 422, { scope: 'PLAN' }, 'lnd.payments.problem.exceedsPlan.error'],
      ['PLAN_STATE_INVALID', 409, {}, 'lnd.payments.problem.planState.error'],
      ['PAYMENT_STATE_INVALID', 409, {}, 'lnd.payments.problem.paymentState.error'],
      ['PAYMENT_LATE_REASON_REQUIRED', 422, {}, 'lnd.payments.problem.lateReason.error'],
      ['ADVANCE_RECOVERY_EXCEEDED', 422, {}, 'lnd.payments.problem.advanceExceeded.error'],
      ['ADVANCE_STATE_INVALID', 409, {}, 'lnd.payments.problem.advanceState.error'],
      ['DOCUMENT_NOT_CLEAN', 422, {}, 'lnd.payments.problem.documentNotClean.error'],
      ['TIMER_RULE_UNCONFIRMED', 422, {}, 'lnd.payments.problem.ruleUnconfirmed.error'],
      ['VERSION_CONFLICT', 409, {}, 'lnd.problem.versionConflict.error'],
      ['SCOPE_DENIED', 403, {}, 'lnd.payments.problem.scopeDenied.error'],
      ['VALIDATION_FAILED', 422, {}, 'lnd.problem.validation.error'],
      ['RESOURCE_NOT_FOUND', 404, {}, 'lnd.problem.notFound.error'],
    ];
    for (const [code, status, extensions, key] of cases) {
      const h = client(worldOf(), () => problem(code, status, extensions));
      mount(<PaymentScreen route={ROUTE} />, h, { permissions: PAYER, path: PATH });
      await open();
      fireEvent.click(within(paymentOf(1)).getByRole('button', { name: vi_['lnd.payments.deposit.aria'].replace('{household}', 'HH-000001').replace('{number}', '1') }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.reason.label']), { target: { value: 'Hộ không nhận tiền' } });
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.voucher.label']), { target: { value: DOCUMENT } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
      cleanup();
    }
    const unknown = client(worldOf(), () => new Error('boom'));
    mount(<PaymentScreen route={ROUTE} />, unknown, { permissions: PAYER, path: PATH });
    await open();
    fireEvent.click(within(paymentOf(1)).getByRole('button', { name: vi_['lnd.payments.deposit.aria'].replace('{household}', 'HH-000001').replace('{number}', '1') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.reason.label']), { target: { value: 'Hộ không nhận tiền' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.payments.depositDialog.voucher.label']), { target: { value: DOCUMENT } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_['lnd.problem.general.error']);
  });

  it('shows the plans a failing read could not give as the error of the screen', async () => {
    const failing = worldOf();
    failing.failing.add('listCompensationPlans');
    mount(<PaymentScreen route={ROUTE} />, client(failing), { permissions: PLAN_READER, path: PATH });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('plans')).toBeNull();
  });
});
