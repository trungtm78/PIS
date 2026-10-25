import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { formProblemMessage } from '../payment/labels';
import type { PaymentRequest } from '../payment/model';
import { useGenerateForms, useSendToTreasury } from './hooks';
import { formName, refusalMessage } from './labels';
import { EMPTY_GENERATE, EMPTY_SEND, describeProblem, generateBody, sendBody, validateGenerate, validateSend } from './model';
import type { FormCode, GenerateForm, PaymentForm, SendForm } from './model';

/** The words of the frame the commands are asked in. */
function useFrameWords() {
  const { t } = useTranslation();
  return { close: t('pay.forms.dialog.close'), cancel: t('pay.forms.dialog.cancel'), pending: t('pay.forms.dialog.pending') };
}

export interface GenerateDialogProps {
  request: PaymentRequest;
  codes: readonly FormCode[];
  onDone(): void;
  onClose(): void;
}

/**
 * Drawing the forms of a request that has been checked: the figures that fill them are the server's, the place of the place-and-date line is the accountant's. The forms asked for are all drawn
 * or none is; a refusal names the form whose template waits for its legal confirmation or is not in force.
 */
export function GenerateDialog({ request, codes, onDone, onClose }: GenerateDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const generate = useGenerateForms();
  const [form, setForm] = useState<GenerateForm>(EMPTY_GENERATE);
  const [sent, setSent] = useState(false);
  const problems = validateGenerate(form);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (generate.isPending || Object.keys(problems).length > 0) return;
    generate.mutate({ id: request.id, body: generateBody(codes, form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.forms.generate.title', { no: request.requestNo ?? '' })}
      refusal={generate.isError ? refusalMessage(t, describeProblem(generate.error)) : undefined}
      pending={generate.isPending}
      submitLabel={t('pay.forms.generate.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p data-testid="generate-forms">{codes.map((code) => formName(t, code)).join(' · ')}</p>
      <Field id="generate-place" label={t('pay.forms.field.place')} error={sent && problems.place !== undefined ? formProblemMessage(t, problems.place) : undefined} hint={t('pay.forms.field.place.hint')}>
        <input id="generate-place" autoComplete="off" value={form.place} onChange={(event) => setForm({ ...form, place: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

export interface SendDialogProps {
  request: PaymentRequest;
  forms: readonly PaymentForm[];
  today: string;
  onDone(): void;
  onClose(): void;
}

/**
 * Recording that the file went to the Treasury: the day it was sent and the number the Treasury gave it are entered by hand, and the forms that stand go with the request. The platform calls
 * nothing: the file is taken to the Treasury by the accountant.
 */
export function SendDialog({ request, forms, today, onDone, onClose }: SendDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const record = useSendToTreasury();
  const [form, setForm] = useState<SendForm>(EMPTY_SEND);
  const [sent, setSent] = useState(false);
  const problems = validateSend(form, today);
  const shown = (field: keyof SendForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ id: request.id, version: request.version, body: sendBody(form, forms) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.forms.send.title', { no: request.requestNo ?? '' })}
      refusal={record.isError ? refusalMessage(t, describeProblem(record.error)) : undefined}
      pending={record.isPending}
      submitLabel={t('pay.forms.send.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{t('pay.forms.send.intro')}</p>
      <Field id="send-day" label={t('pay.forms.field.sentOn')} error={shown('sentOn')} hint={t('pay.forms.field.sentOn.hint')}>
        <input id="send-day" autoComplete="off" placeholder="2026-07-24" value={form.sentOn} onChange={(event) => setForm({ ...form, sentOn: event.target.value })} />
      </Field>
      <Field id="send-ref" label={t('pay.forms.field.ref')} error={shown('treasuryRef')} hint={t('pay.forms.field.ref.hint')}>
        <input id="send-ref" autoComplete="off" value={form.treasuryRef} onChange={(event) => setForm({ ...form, treasuryRef: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
