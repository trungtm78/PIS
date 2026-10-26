import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field } from '../components';
import type { HouseholdLine } from '../household/model';
import type { PlanLine } from '../plan/model';
import { useConfirmPayment, useDepositPayment, useSchedulePayments } from './hooks';
import { commandProblemMessage, formProblemMessage, paymentMethodLabel } from './labels';
import {
  EMPTY_CONFIRM_FORM,
  EMPTY_DEPOSIT_FORM,
  EMPTY_SCHEDULE_FORM,
  PAYMENT_METHODS,
  confirmBody,
  depositBody,
  describeProblem,
  isLateOn,
  scheduleBody,
  validateConfirm,
  validateDeposit,
  validateSchedule,
} from './model';
import type { ConfirmForm, DepositForm, PaymentLine, ScheduleForm } from './model';

/** One payment scheduled on a plan that is approved or being paid: the household, the amount, the day it is due if it is not the last day of the plan, and the account it is paid to if there is one. */
export function ScheduleDialog({ plan, households, onClose }: { plan: PlanLine; households: readonly HouseholdLine[]; onClose(): void }) {
  const { t } = useTranslation();
  const schedule = useSchedulePayments();
  const [form, setForm] = useState<ScheduleForm>(EMPTY_SCHEDULE_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateSchedule(form, plan);
  const error = (field: keyof ScheduleForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (schedule.isPending || Object.keys(problems).length > 0) return;
    schedule.mutate({ id: plan.id, version: plan.version, payments: [scheduleBody(form)] }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.payments.scheduleDialog.title.text', { code: plan.planCode, revision: plan.revision })}
      onClose={onClose}
      refusal={schedule.isError ? commandProblemMessage(t, describeProblem(schedule.error)) : undefined}
      pending={schedule.isPending}
      onSubmit={submit}
    >
      <Field id="payment-household" label={t('lnd.payments.scheduleDialog.household.label')} error={error('householdId')}>
        <select id="payment-household" value={form.householdId} onChange={(event) => setForm({ ...form, householdId: event.target.value })}>
          <option value="">{t('lnd.payments.scheduleDialog.household.choose')}</option>
          {households.map((household) => (
            <option key={household.id} value={household.id}>
              {household.householdCode}
            </option>
          ))}
        </select>
      </Field>
      <Field id="payment-amount" label={t('lnd.payments.scheduleDialog.amount.label')} error={error('amountVnd')} hint={t('lnd.payments.scheduleDialog.amount.help')}>
        <input id="payment-amount" inputMode="numeric" value={form.amountVnd} onChange={(event) => setForm({ ...form, amountVnd: event.target.value })} />
      </Field>
      <Field id="payment-due" label={t('lnd.payments.scheduleDialog.due.label')} error={error('dueOn')} hint={t('lnd.payments.scheduleDialog.due.help', { date: plan.paymentDueOn ?? '' })}>
        <input id="payment-due" type="date" value={form.dueOn} onChange={(event) => setForm({ ...form, dueOn: event.target.value })} />
      </Field>
      <Field id="payment-account" label={t('lnd.payments.scheduleDialog.account.label')} error={error('bankAccount')} hint={t('lnd.payments.scheduleDialog.account.help')}>
        <input id="payment-account" autoComplete="off" value={form.bankAccount} onChange={(event) => setForm({ ...form, bankAccount: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/**
 * The confirmation of a payment with its voucher: the day it was paid, how, and the treasury transaction and the GPMB advance it settles if there are any. A payment made after the day it was due says why;
 * the field of the reason appears when the day chosen is after it. An advance is recovered by the payment through PAY, and the payment stays unpaid when more would be recovered than is owed.
 */
export function ConfirmDialog({ plan, payment, today, onClose }: { plan: PlanLine; payment: PaymentLine; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const confirm = useConfirmPayment();
  const [form, setForm] = useState<ConfirmForm>({ ...EMPTY_CONFIRM_FORM, paidOn: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateConfirm(form, payment, plan, today);
  const late = form.paidOn.trim() !== '' && isLateOn(payment, form.paidOn.trim());
  const error = (field: keyof ConfirmForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (confirm.isPending || Object.keys(problems).length > 0) return;
    confirm.mutate({ id: payment.id, version: payment.version, body: confirmBody(form, payment) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.payments.confirmDialog.title.text', { household: payment.householdCode, number: payment.paymentNo })}
      onClose={onClose}
      refusal={confirm.isError ? commandProblemMessage(t, describeProblem(confirm.error)) : undefined}
      pending={confirm.isPending}
      onSubmit={submit}
    >
      <Field id="confirm-paid-on" label={t('lnd.payments.confirmDialog.date.label')} error={error('paidOn')} hint={t('lnd.payments.confirmDialog.date.help', { date: payment.dueOn })}>
        <input id="confirm-paid-on" type="date" value={form.paidOn} max={today} onChange={(event) => setForm({ ...form, paidOn: event.target.value })} />
      </Field>
      <Field id="confirm-method" label={t('lnd.payments.confirmDialog.method.label')} error={error('method')}>
        <select id="confirm-method" value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value as ConfirmForm['method'] })}>
          <option value="">{t('lnd.payments.confirmDialog.method.choose')}</option>
          {PAYMENT_METHODS.map((method) => (
            <option key={method} value={method}>
              {paymentMethodLabel(t, method)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="confirm-voucher" label={t('lnd.payments.confirmDialog.voucher.label')} error={error('voucherDocumentVersionId')} hint={t('lnd.payments.confirmDialog.voucher.help')}>
        <input id="confirm-voucher" value={form.voucherDocumentVersionId} onChange={(event) => setForm({ ...form, voucherDocumentVersionId: event.target.value })} />
      </Field>
      <Field id="confirm-treasury" label={t('lnd.payments.confirmDialog.treasury.label')} error={error('treasuryTransactionId')} hint={t('lnd.payments.confirmDialog.treasury.help')}>
        <input id="confirm-treasury" value={form.treasuryTransactionId} onChange={(event) => setForm({ ...form, treasuryTransactionId: event.target.value })} />
      </Field>
      <Field id="confirm-advance" label={t('lnd.payments.confirmDialog.advance.label')} error={error('advanceId')} hint={t('lnd.payments.confirmDialog.advance.help')}>
        <input id="confirm-advance" value={form.advanceId} onChange={(event) => setForm({ ...form, advanceId: event.target.value })} />
      </Field>
      {late ? (
        <Field id="confirm-late" label={t('lnd.payments.confirmDialog.late.label')} error={error('lateReason')} hint={t('lnd.payments.confirmDialog.late.help', { date: payment.dueOn })}>
          <textarea id="confirm-late" rows={3} value={form.lateReason} onChange={(event) => setForm({ ...form, lateReason: event.target.value })} />
        </Field>
      ) : null}
    </DialogFrame>
  );
}

/** The deposit of the money of a payment that the household did not take: the day, the reason, and the record of the deposit. */
export function DepositDialog({ plan, payment, today, onClose }: { plan: PlanLine; payment: PaymentLine; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const deposit = useDepositPayment();
  const [form, setForm] = useState<DepositForm>({ ...EMPTY_DEPOSIT_FORM, paidOn: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDeposit(form, plan, today);
  const error = (field: keyof DepositForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (deposit.isPending || Object.keys(problems).length > 0) return;
    deposit.mutate({ id: payment.id, version: payment.version, body: depositBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.payments.depositDialog.title.text', { household: payment.householdCode, number: payment.paymentNo })}
      onClose={onClose}
      refusal={deposit.isError ? commandProblemMessage(t, describeProblem(deposit.error)) : undefined}
      pending={deposit.isPending}
      onSubmit={submit}
    >
      <Field id="deposit-paid-on" label={t('lnd.payments.depositDialog.date.label')} error={error('paidOn')}>
        <input id="deposit-paid-on" type="date" value={form.paidOn} max={today} onChange={(event) => setForm({ ...form, paidOn: event.target.value })} />
      </Field>
      <Field id="deposit-reason" label={t('lnd.payments.depositDialog.reason.label')} error={error('depositReason')} hint={t('lnd.payments.depositDialog.reason.help')}>
        <textarea id="deposit-reason" rows={3} value={form.depositReason} onChange={(event) => setForm({ ...form, depositReason: event.target.value })} />
      </Field>
      <Field id="deposit-voucher" label={t('lnd.payments.depositDialog.voucher.label')} error={error('voucherDocumentVersionId')} hint={t('lnd.payments.depositDialog.voucher.help')}>
        <input id="deposit-voucher" value={form.voucherDocumentVersionId} onChange={(event) => setForm({ ...form, voucherDocumentVersionId: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}
