import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { CommandFrame } from '../../qms/CommandFrame';
import { Field } from '../components';
import type { Measurement } from '../measurement/model';
import { quantityText } from '../measurement/model';
import { useDecideAcceptance, useDraftAcceptance, useRevokeAcceptance, useSubmitAcceptance } from './hooks';
import { decisionLabel, formProblemMessage, problemMessage } from './labels';
import { DECISIONS, EMPTY_DECIDE, EMPTY_DRAFT, EMPTY_REVOKE, EMPTY_SUBMIT, decideBody, describeProblem, draftBody, revokeBody, submitBody, validateDecide, validateDraft, validateRevoke, validateSubmit } from './model';
import type { Acceptance, DecideForm, DraftForm, RevokeForm, SubmitForm } from './model';
import '../ctr.css';

interface FrameProps {
  title: string;
  error: unknown;
  hasError: boolean;
  pending: boolean;
  submitLabel: string;
  onSubmit(event: FormEvent): void;
  onClose(): void;
  children: ReactNode;
}

/** The frame the four commands are asked in: the title, the refusal of the server in words, the fields and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t, locale } = useTranslation();
  const words = { close: t('ctr.acceptance.dialog.close'), cancel: t('ctr.acceptance.dialog.cancel'), pending: t('ctr.acceptance.dialog.pending') };
  return (
    <CommandFrame title={title} refusal={hasError ? problemMessage(t, describeProblem(error), locale) : undefined} pending={pending} submitLabel={submitLabel} words={words} onSubmit={onSubmit} onClose={onClose}>
      {children}
    </CommandFrame>
  );
}

export interface DraftDialogProps {
  contractId: string;
  /** The approved measurements that no approved acceptance holds. */
  measurements: readonly Measurement[];
  onDone(): void;
  onClose(): void;
}

/**
 * Drafting an acceptance from approved measurements of one period. The price of each line is not asked for: the server takes it from the revision of the contract in force on the day the
 * acceptance is drawn up and keeps it, and the screen shows it once the acceptance is drafted. The paper and the minutes of quality are typed by identifier (there is no document picker yet).
 */
export function DraftDialog({ contractId, measurements, onDone, onClose }: DraftDialogProps) {
  const { t, locale } = useTranslation();
  const draft = useDraftAcceptance();
  const [form, setForm] = useState<DraftForm>(EMPTY_DRAFT);
  const [submitted, setSubmitted] = useState(false);
  const periods = useMemo(() => [...new Map(measurements.map((measurement) => [measurement.period.id, measurement.period.code])).entries()], [measurements]);
  const ofPeriod = measurements.filter((measurement) => measurement.period.id === form.periodId);
  const problems = validateDraft(form);
  const shown = (field: keyof DraftForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const toggle = (id: string): void => setForm({ ...form, measurementIds: form.measurementIds.includes(id) ? form.measurementIds.filter((chosen) => chosen !== id) : [...form.measurementIds, id] });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (draft.isPending || Object.keys(problems).length > 0) return;
    draft.mutate({ contractId, body: draftBody(form) }, { onSuccess: onDone });
  };
  return (
    <Frame title={t('ctr.acceptance.draft.title')} error={draft.error} hasError={draft.isError} pending={draft.isPending} submitLabel={t('ctr.acceptance.draft.submit')} onSubmit={send} onClose={onClose}>
      <Field id="acceptance-period" label={t('ctr.acceptance.field.period')} error={shown('periodId')}>
        <select id="acceptance-period" value={form.periodId} onChange={(event) => setForm({ ...form, periodId: event.target.value, measurementIds: [] })}>
          <option value="">{t('ctr.acceptance.field.period.choose')}</option>
          {periods.map(([id, code]) => (
            <option key={id} value={id}>
              {code}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="field" data-field="acceptance-measurements">
        <legend>{t('ctr.acceptance.field.measurements')}</legend>
        {ofPeriod.map((measurement) => (
          <label key={measurement.id} className="checkbox">
            <input type="checkbox" data-measurement={measurement.id} checked={form.measurementIds.includes(measurement.id)} onChange={() => toggle(measurement.id)} />{' '}
            {t('ctr.acceptance.field.measurement', { item: measurement.boqItem.businessKey, quantity: quantityText(measurement.quantityPeriod, locale), unit: measurement.boqItem.unitCode, reference: measurement.referenceNo ?? '' })}
          </label>
        ))}
        {shown('measurementIds') === undefined ? null : (
          <small role="alert" className="field-error">
            {shown('measurementIds')}
          </small>
        )}
      </fieldset>
      <Field id="acceptance-document" label={t('ctr.acceptance.field.document')} error={shown('documentId')} hint={t('ctr.acceptance.field.document.hint')}>
        <input id="acceptance-document" autoComplete="off" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />
      </Field>
      <Field id="acceptance-quality" label={t('ctr.acceptance.field.quality')} error={shown('qualityId')} hint={t('ctr.acceptance.field.quality.hint')}>
        <input id="acceptance-quality" autoComplete="off" value={form.qualityId} onChange={(event) => setForm({ ...form, qualityId: event.target.value })} />
      </Field>
    </Frame>
  );
}

export interface AcceptanceDialogProps {
  acceptance: Acceptance;
  onDone(): void;
  onClose(): void;
}

/** Sending a draft for decision, with the people who sign the paper, one name on each line. */
export function SubmitDialog({ acceptance, onDone, onClose }: AcceptanceDialogProps) {
  const { t } = useTranslation();
  const submit = useSubmitAcceptance();
  const [form, setForm] = useState<SubmitForm>(EMPTY_SUBMIT);
  const [sent, setSent] = useState(false);
  const problems = validateSubmit(form);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (submit.isPending || Object.keys(problems).length > 0) return;
    submit.mutate({ id: acceptance.id, version: acceptance.version, body: submitBody(form) }, { onSuccess: onDone });
  };
  return (
    <Frame title={t('ctr.acceptance.submit.title', { no: acceptance.acceptanceNo })} error={submit.error} hasError={submit.isError} pending={submit.isPending} submitLabel={t('ctr.acceptance.submit.submit')} onSubmit={send} onClose={onClose}>
      <Field id="acceptance-signers" label={t('ctr.acceptance.field.signers')} error={sent && problems.signers !== undefined ? formProblemMessage(t, problems.signers) : undefined} hint={t('ctr.acceptance.field.signers.hint')}>
        <textarea id="acceptance-signers" rows={4} value={form.signers} onChange={(event) => setForm({ ...form, signers: event.target.value })} />
      </Field>
    </Frame>
  );
}

/**
 * The decision on an acceptance that was sent. Not by whoever drafted or sent it (the list does not offer it to them; the server refuses them anyway). Approving also needs approved quality
 * acceptance minutes where the contract asks for them, no serious non-conformance open on the work, and room in the value of the contract.
 */
export function DecideDialog({ acceptance, onDone, onClose }: AcceptanceDialogProps) {
  const { t } = useTranslation();
  const decide = useDecideAcceptance();
  const [form, setForm] = useState<DecideForm>(EMPTY_DECIDE);
  const [sent, setSent] = useState(false);
  const problems = validateDecide(form);
  const shown = (field: keyof DecideForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (decide.isPending || Object.keys(problems).length > 0) return;
    decide.mutate({ id: acceptance.id, version: acceptance.version, body: decideBody(form) }, { onSuccess: onDone });
  };
  return (
    <Frame title={t('ctr.acceptance.decide.title', { no: acceptance.acceptanceNo })} error={decide.error} hasError={decide.isError} pending={decide.isPending} submitLabel={t('ctr.acceptance.decide.submit')} onSubmit={send} onClose={onClose}>
      <fieldset className="field" data-field="acceptance-decision">
        <legend>{t('ctr.acceptance.field.decision')}</legend>
        {DECISIONS.map((decision) => (
          <label key={decision} className="radio">
            <input type="radio" name="acceptance-decision" value={decision} data-decision={decision} checked={form.decision === decision} onChange={() => setForm({ ...form, decision })} /> {decisionLabel(t, decision)}
          </label>
        ))}
        {shown('decision') === undefined ? null : (
          <small role="alert" className="field-error">
            {shown('decision')}
          </small>
        )}
      </fieldset>
      <Field id="acceptance-reason" label={t('ctr.acceptance.field.reason')} error={shown('reason')}>
        <textarea id="acceptance-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
      <Field id="acceptance-evidence" label={t('ctr.acceptance.field.evidence')} error={shown('evidence')} hint={t('ctr.acceptance.field.evidence.hint')}>
        <textarea id="acceptance-evidence" rows={2} value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Withdrawing an approved acceptance with the reason and the paper that approves the withdrawal; the server refuses it while a payment request holds the acceptance. */
export function RevokeDialog({ acceptance, onDone, onClose }: AcceptanceDialogProps) {
  const { t } = useTranslation();
  const revoke = useRevokeAcceptance();
  const [form, setForm] = useState<RevokeForm>(EMPTY_REVOKE);
  const [sent, setSent] = useState(false);
  const problems = validateRevoke(form);
  const shown = (field: keyof RevokeForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (revoke.isPending || Object.keys(problems).length > 0) return;
    revoke.mutate({ id: acceptance.id, version: acceptance.version, body: revokeBody(form) }, { onSuccess: onDone });
  };
  return (
    <Frame title={t('ctr.acceptance.revoke.title', { no: acceptance.acceptanceNo })} error={revoke.error} hasError={revoke.isError} pending={revoke.isPending} submitLabel={t('ctr.acceptance.revoke.submit')} onSubmit={send} onClose={onClose}>
      <Field id="acceptance-revoke-reason" label={t('ctr.acceptance.field.revokeReason')} error={shown('reason')}>
        <textarea id="acceptance-revoke-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
      <Field id="acceptance-revoke-document" label={t('ctr.acceptance.field.revokeDocument')} error={shown('documentId')} hint={t('ctr.acceptance.field.revokeDocument.hint')}>
        <input id="acceptance-revoke-document" autoComplete="off" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />
      </Field>
    </Frame>
  );
}
