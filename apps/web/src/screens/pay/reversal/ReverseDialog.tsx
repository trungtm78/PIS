import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { instantText } from '../model';
import type { PaymentRequest } from '../payment/model';
import type { Transaction } from '../recon/model';
import { vndText } from '../recon/model';
import { useReverse } from './hooks';
import { problemMessage, refusalMessage } from './labels';
import { EMPTY_REVERSE, describeProblem, reverseBody, validateReverse } from './model';
import type { Reversal, ReverseForm } from './model';

export interface ReverseDialogProps {
  request: PaymentRequest;
  refunds: readonly Transaction[];
  onDone(reversal: Reversal | undefined): void;
  onClose(): void;
}

/**
 * Reversing a payment that was settled (PAY 3.4): against one of the refunds the Treasury confirmed for this very payment, with the reason and the document that approves it. The server judges all
 * three again, and refuses the person who matched the payment. Every effect is undone by new entries; nothing is changed or deleted.
 */
export function ReverseDialog({ request, refunds, onDone, onClose }: ReverseDialogProps) {
  const { t, locale } = useTranslation();
  const reverse = useReverse();
  const [form, setForm] = useState<ReverseForm>(EMPTY_REVERSE);
  const [sent, setSent] = useState(false);
  const problems = validateReverse(form);
  const shown = (field: keyof ReverseForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? problemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (reverse.isPending || Object.keys(problems).length > 0) return;
    reverse.mutate({ id: request.id, version: request.version, body: reverseBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.reversal.dialog.title', { no: request.requestNo ?? '' })}
      refusal={reverse.isError ? refusalMessage(t, describeProblem(reverse.error)) : undefined}
      pending={reverse.isPending}
      submitLabel={t('pay.reversal.dialog.submit')}
      words={{ close: t('pay.reversal.dialog.close'), cancel: t('pay.reversal.dialog.cancel'), pending: t('pay.reversal.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{t('pay.reversal.dialog.intro', { amount: vndText(request.netVnd, locale) })}</p>
      <Field id="reverse-refund" label={t('pay.reversal.field.refund')} error={shown('refundId')} hint={refunds.length === 0 ? t('pay.reversal.field.refund.empty') : t('pay.reversal.field.refund.hint')}>
        <select id="reverse-refund" value={form.refundId} onChange={(event) => setForm({ ...form, refundId: event.target.value })}>
          <option value="">{t('pay.reversal.field.refund.choose')}</option>
          {refunds.map((refund) => (
            <option key={refund.id} value={refund.id}>
              {t('pay.reversal.field.refund.option', { voucher: refund.documentNo ?? refund.id, amount: vndText(refund.amountVnd, locale), day: instantText(refund.confirmedAt, locale) })}
            </option>
          ))}
        </select>
      </Field>
      <Field id="reverse-reason" label={t('pay.reversal.field.reason')} error={shown('reason')} hint={t('pay.reversal.field.reason.hint')}>
        <textarea id="reverse-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
      <Field id="reverse-approval" label={t('pay.reversal.field.approval')} error={shown('approvalDocumentVersionId')} hint={t('pay.reversal.field.approval.hint')}>
        <input id="reverse-approval" autoComplete="off" value={form.approvalDocumentVersionId} onChange={(event) => setForm({ ...form, approvalDocumentVersionId: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
