import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useManualTreasuryConfirm } from './hooks';
import { problemMessage } from './labels';
import { describeManualRefusal, emptyManualConfirm, manualConfirmBody, validateManualConfirm } from './manual-confirm-model';
import type { ManualConfirmField, ManualConfirmForm, ManualConfirmProblem, ManualOutcome } from './manual-confirm-model';
import type { PaymentRequest } from './model';

interface Props {
  request: PaymentRequest;
  onDone(outcome: ManualOutcome): void;
  onClose(): void;
}

/**
 * Confirming a Treasury payment by hand (source manual-confirmed): used when the Treasury file did not bring the transaction. It needs the number and the day of the Treasury document, the amount paid and the evidence kept in
 * DOC. An amount that differs from the net amount of the request opens a difference to reconcile instead of settling the request, and the person who sent the request to the Treasury cannot confirm it.
 */
export function ManualConfirmDialog({ request, onDone, onClose }: Props) {
  const { t } = useTranslation();
  const confirm = useManualTreasuryConfirm();
  const [form, setForm] = useState<ManualConfirmForm>(emptyManualConfirm(request.netVnd.replace(/[^0-9]/g, '')));
  const [sent, setSent] = useState(false);
  const problems = validateManualConfirm(form, new Date());
  const shown = (field: ManualConfirmField): string | undefined => {
    const problem: ManualConfirmProblem | undefined = sent ? problems[field] : undefined;
    switch (problem) {
      case 'required':
        return t('pay.manual.error.required');
      case 'amount':
        return t('pay.manual.error.amount');
      case 'day':
        return t('pay.manual.error.day');
      case 'future':
        return t('pay.manual.error.future');
      case 'instant':
        return t('pay.manual.error.instant');
      case 'uuid':
        return t('pay.manual.error.uuid');
      case 'long':
        return t('pay.manual.error.long');
      default:
        return undefined;
    }
  };
  const refusal = confirm.isError ? describeManualRefusal(confirm.error) : undefined;
  const refusalText = refusal === undefined ? undefined : refusal === 'duplicate' ? t('pay.manual.refused.duplicate') : refusal === 'mismatch' ? t('pay.manual.refused.mismatch') : problemMessage(t, refusal.general);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (confirm.isPending || Object.keys(problems).length > 0) return;
    confirm.mutate({ body: manualConfirmBody(request.id, form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.manual.title', { no: request.requestNo ?? '' })}
      refusal={refusalText}
      pending={confirm.isPending}
      submitLabel={t('pay.manual.submit')}
      words={{ close: t('pay.payment.dialog.close'), cancel: t('pay.payment.dialog.cancel'), pending: t('pay.payment.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub">{t('pay.manual.help')}</p>
      <Field id="manual-document-no" label={t('pay.manual.documentNo')} error={shown('documentNo')}>
        <input id="manual-document-no" value={form.documentNo} onChange={(event) => setForm({ ...form, documentNo: event.target.value })} />
      </Field>
      <Field id="manual-document-date" label={t('pay.manual.documentDate')} error={shown('documentDate')}>
        <input id="manual-document-date" type="date" value={form.documentDate} onChange={(event) => setForm({ ...form, documentDate: event.target.value })} />
      </Field>
      <Field id="manual-amount" label={t('pay.manual.amount')} hint={t('pay.manual.amountHint')} error={shown('amountVnd')}>
        <input id="manual-amount" inputMode="numeric" value={form.amountVnd} onChange={(event) => setForm({ ...form, amountVnd: event.target.value.trim() })} />
      </Field>
      <Field id="manual-confirmed-at" label={t('pay.manual.confirmedAt')} error={shown('confirmedAt')}>
        <input id="manual-confirmed-at" type="datetime-local" value={form.confirmedAt} onChange={(event) => setForm({ ...form, confirmedAt: event.target.value })} />
      </Field>
      <Field id="manual-evidence" label={t('pay.manual.evidence')} hint={t('pay.manual.evidenceHint')} error={shown('evidenceVersionId')}>
        <input id="manual-evidence" value={form.evidenceVersionId} onChange={(event) => setForm({ ...form, evidenceVersionId: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
