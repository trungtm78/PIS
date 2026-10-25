import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { useLineChoices } from '../../bid/plan-hooks';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useAttachDocument, useCancelPayment, useRevisePayment } from './hooks';
import { docKindLabel, formProblemMessage, problemMessage } from './labels';
import { DOC_KINDS, EMPTY_ATTACH, EMPTY_CANCEL, attachBody, cancelBody, describeProblem, reviseBody, reviseFormOf, validateAttach, validateCancel, validateRevise } from './model';
import type { AttachForm, CancelForm, PaymentAnswer, PaymentRequest, ReviseForm } from './model';

export interface PaymentDialogProps {
  request: PaymentRequest;
  onDone(answer: PaymentAnswer | undefined): void;
  onClose(): void;
}

/** The words of the frame the commands are asked in. */
function useFrameWords() {
  const { t } = useTranslation();
  return { close: t('pay.payment.dialog.close'), cancel: t('pay.payment.dialog.cancel'), pending: t('pay.payment.dialog.pending') };
}

/**
 * Revising a draft: the number, the line of capital, the tax adjustment with its basis and the extra recovery are the client's to decide; the money is computed again by the server and shown
 * when the draft is read back. A returned request becomes a draft by being revised.
 */
export function ReviseDialog({ request, onDone, onClose }: PaymentDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const revise = useRevisePayment();
  const lines = useLineChoices();
  const [form, setForm] = useState<ReviseForm>(reviseFormOf(request));
  const [sent, setSent] = useState(false);
  const problems = validateRevise(form);
  const shown = (field: keyof ReviseForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const choices = (lines.data ?? []).filter((line) => line.projectId === request.projectId);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (revise.isPending || Object.keys(problems).length > 0) return;
    revise.mutate({ id: request.id, version: request.version, body: reviseBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.payment.revise.title', { no: request.requestNo ?? '' })}
      refusal={revise.isError ? problemMessage(t, describeProblem(revise.error)) : undefined}
      pending={revise.isPending}
      submitLabel={t('pay.payment.revise.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="revise-no" label={t('pay.payment.field.requestNo')} error={shown('requestNo')}>
        <input id="revise-no" autoComplete="off" value={form.requestNo} onChange={(event) => setForm({ ...form, requestNo: event.target.value })} />
      </Field>
      <Field id="revise-line" label={t('pay.payment.field.line')} error={shown('allocationLineId')}>
        <select id="revise-line" value={form.allocationLineId} onChange={(event) => setForm({ ...form, allocationLineId: event.target.value })}>
          <option value="">{t('pay.payment.field.choose')}</option>
          {choices.map((line) => (
            <option key={line.id} value={line.id}>
              {line.label}
            </option>
          ))}
          {request.allocationLineId !== null && !choices.some((line) => line.id === request.allocationLineId) ? <option value={request.allocationLineId}>{request.allocationLineId}</option> : null}
        </select>
      </Field>
      <Field id="revise-tax" label={t('pay.payment.field.tax')} error={shown('taxAdjustment')} hint={t('pay.payment.field.tax.hint')}>
        <input id="revise-tax" inputMode="numeric" autoComplete="off" value={form.taxAdjustment} onChange={(event) => setForm({ ...form, taxAdjustment: event.target.value })} />
      </Field>
      <Field id="revise-tax-basis" label={t('pay.payment.field.taxBasis')} error={shown('taxBasis')}>
        <input id="revise-tax-basis" autoComplete="off" value={form.taxBasis} onChange={(event) => setForm({ ...form, taxBasis: event.target.value })} />
      </Field>
      <Field id="revise-extra" label={t('pay.payment.field.extra')} error={shown('extraRecovery')} hint={t('pay.payment.field.extra.hint')}>
        <input id="revise-extra" inputMode="numeric" autoComplete="off" value={form.extraRecovery} onChange={(event) => setForm({ ...form, extraRecovery: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

/**
 * Attaching a document to a draft: a clean version of a file, typed by identifier (there is no document picker yet). An invoice names its number and date; a number used before in the same
 * contract is refused, and a person the contract trusts with exceptions, who did not draw the request up, gives the reason that lets it through.
 */
export function AttachDialog({ request, onDone, onClose }: PaymentDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const attach = useAttachDocument();
  const [form, setForm] = useState<AttachForm>(EMPTY_ATTACH);
  const [sent, setSent] = useState(false);
  const problems = validateAttach(form);
  const shown = (field: keyof AttachForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (attach.isPending || Object.keys(problems).length > 0) return;
    attach.mutate({ id: request.id, body: attachBody(form) }, { onSuccess: onDone });
  };
  const invoice = form.docKind === 'INVOICE';
  return (
    <CommandFrame
      title={t('pay.payment.attach.title', { no: request.requestNo ?? '' })}
      refusal={attach.isError ? problemMessage(t, describeProblem(attach.error)) : undefined}
      pending={attach.isPending}
      submitLabel={t('pay.payment.attach.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="attach-kind" label={t('pay.payment.field.docKind')} error={shown('docKind')}>
        <select id="attach-kind" value={form.docKind} onChange={(event) => setForm({ ...form, docKind: DOC_KINDS.find((kind) => kind === event.target.value) ?? '' })}>
          <option value="">{t('pay.payment.field.choose')}</option>
          {DOC_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {docKindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="attach-document" label={t('pay.payment.field.document')} error={shown('documentId')} hint={t('pay.payment.field.document.hint')}>
        <input id="attach-document" autoComplete="off" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />
      </Field>
      {invoice ? (
        <>
          <Field id="attach-invoice-no" label={t('pay.payment.field.invoiceNo')} error={shown('invoiceNo')}>
            <input id="attach-invoice-no" autoComplete="off" value={form.invoiceNo} onChange={(event) => setForm({ ...form, invoiceNo: event.target.value })} />
          </Field>
          <Field id="attach-invoice-date" label={t('pay.payment.field.invoiceDate')} error={shown('invoiceDate')} hint={t('pay.payment.field.invoiceDate.hint')}>
            <input id="attach-invoice-date" autoComplete="off" placeholder="2026-07-01" value={form.invoiceDate} onChange={(event) => setForm({ ...form, invoiceDate: event.target.value })} />
          </Field>
          {request.actions.overrideDuplicate ? (
            <Field id="attach-override" label={t('pay.payment.field.override')} error={shown('overrideReason')} hint={t('pay.payment.field.override.hint')}>
              <textarea id="attach-override" rows={2} value={form.overrideReason} onChange={(event) => setForm({ ...form, overrideReason: event.target.value })} />
            </Field>
          ) : null}
        </>
      ) : null}
      <label className="checkbox">
        <input type="checkbox" data-field="attach-signed" checked={form.signed} onChange={(event) => setForm({ ...form, signed: event.target.checked })} /> {t('pay.payment.field.signed')}
      </label>
    </CommandFrame>
  );
}

/** Cancelling a draft, with the reason; a request that holds the claim on its acceptance is returned, not cancelled (the server refuses). */
export function CancelDialog({ request, onDone, onClose }: PaymentDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const cancel = useCancelPayment();
  const [form, setForm] = useState<CancelForm>(EMPTY_CANCEL);
  const [sent, setSent] = useState(false);
  const problems = validateCancel(form);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (cancel.isPending || Object.keys(problems).length > 0) return;
    cancel.mutate({ id: request.id, version: request.version, body: cancelBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.payment.cancel.title', { no: request.requestNo ?? '' })}
      refusal={cancel.isError ? problemMessage(t, describeProblem(cancel.error)) : undefined}
      pending={cancel.isPending}
      submitLabel={t('pay.payment.cancel.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="cancel-reason" label={t('pay.payment.field.cancelReason')} error={sent && problems.reason !== undefined ? formProblemMessage(t, problems.reason) : undefined}>
        <textarea id="cancel-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
