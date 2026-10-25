import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { formProblemMessage } from '../payment/labels';
import { useCancelAdvance, useRecordRecovery } from './hooks';
import { basisLabel, problemMessage } from './labels';
import { BASES, EMPTY_CANCEL, EMPTY_RECOVERY, cancelBody, describeProblem, recoveryBody, signedAmountText, validateCancel, validateRecovery } from './model';
import type { Advance, AdvanceAnswer, CancelForm, RecoveryForm } from './model';

export interface AdvanceDialogProps {
  advance: Advance;
  onDone(answer: AdvanceAnswer | undefined): void;
  onClose(): void;
}

/** The words of the frame the commands are asked in. */
function useFrameWords() {
  const { t } = useTranslation();
  return { close: t('pay.advance.dialog.close'), cancel: t('pay.advance.dialog.cancel'), pending: t('pay.advance.dialog.pending') };
}

/**
 * Recording a recovery that no payment makes (PAY 3.2 step 3): a compensation paid to the one who owes the advance, a refund of money, anything else with its evidence. The most that may be
 * recovered is what is still owed; the server says so if the figure is above it and the screen shows what is owed before it is asked.
 */
export function RecoveryDialog({ advance, onDone, onClose }: AdvanceDialogProps) {
  const { t, locale } = useTranslation();
  const words = useFrameWords();
  const record = useRecordRecovery();
  const [form, setForm] = useState<RecoveryForm>(EMPTY_RECOVERY);
  const [sent, setSent] = useState(false);
  const problems = validateRecovery(form);
  const shown = (field: keyof RecoveryForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ id: advance.id, version: advance.version, body: recoveryBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.advance.recovery.title', { contract: advance.contract.code, tranche: advance.trancheNo })}
      refusal={record.isError ? problemMessage(t, describeProblem(record.error)) : undefined}
      pending={record.isPending}
      submitLabel={t('pay.advance.recovery.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p data-testid="owed">{t('pay.advance.recovery.owed', { amount: signedAmountText(advance.outstandingVnd, locale) ?? advance.outstandingVnd })}</p>
      <Field id="recovery-amount" label={t('pay.advance.field.amount')} error={shown('amount')} hint={t('pay.advance.field.amount.hint')}>
        <input id="recovery-amount" inputMode="numeric" autoComplete="off" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
      </Field>
      <Field id="recovery-basis" label={t('pay.advance.field.basis')} error={shown('basis')}>
        <select id="recovery-basis" value={form.basis} onChange={(event) => setForm({ ...form, basis: BASES.find((basis) => basis === event.target.value) ?? '' })}>
          <option value="">{t('pay.advance.field.choose')}</option>
          {BASES.map((basis) => (
            <option key={basis} value={basis}>
              {basisLabel(t, basis)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="recovery-source" label={t('pay.advance.field.source')} error={shown('sourceRef')} hint={t('pay.advance.field.source.hint')}>
        <input id="recovery-source" autoComplete="off" value={form.sourceRef} onChange={(event) => setForm({ ...form, sourceRef: event.target.value })} />
      </Field>
      <Field id="recovery-evidence" label={t('pay.advance.field.evidence')} error={shown('evidenceId')} hint={t('pay.advance.field.evidence.hint')}>
        <input id="recovery-evidence" autoComplete="off" value={form.evidenceId} onChange={(event) => setForm({ ...form, evidenceId: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

/** Cancelling an advance that is only planned or asked for, with the reason; one a payment request still stands on is returned or cancelled first (the server says so). */
export function CancelDialog({ advance, onDone, onClose }: AdvanceDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const cancel = useCancelAdvance();
  const [form, setForm] = useState<CancelForm>(EMPTY_CANCEL);
  const [sent, setSent] = useState(false);
  const problems = validateCancel(form);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (cancel.isPending || Object.keys(problems).length > 0) return;
    cancel.mutate({ id: advance.id, version: advance.version, body: cancelBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.advance.cancel.title', { contract: advance.contract.code, tranche: advance.trancheNo })}
      refusal={cancel.isError ? problemMessage(t, describeProblem(cancel.error)) : undefined}
      pending={cancel.isPending}
      submitLabel={t('pay.advance.cancel.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="cancel-reason" label={t('pay.advance.field.reason')} error={sent && problems.reason !== undefined ? formProblemMessage(t, problems.reason) : undefined}>
        <textarea id="cancel-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
