import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useAcknowledgeClaim, useFileClaim, useRecordFix, useVerifyClaim } from './hooks';
import { bearerLabel, formProblemMessage, outcomeLabel, problemMessage, severityLabel } from './labels';
import {
  BEARERS,
  OUTCOMES,
  SEVERITIES,
  acknowledgeBody,
  describeProblem,
  emptyAcknowledge,
  emptyFile,
  emptyFix,
  emptyVerify,
  fileBody,
  fixBody,
  validateAcknowledge,
  validateFile,
  validateFix,
  validateVerify,
  verifyBody,
  vietnamToday,
} from './model';
import type { AcknowledgeForm, ClaimLine, FileForm, FixForm, FormProblem, ObligationOption, VerifyForm } from './model';

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

/** The frame the commands are asked in: the title, the refusal of the server in words, the fields and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t } = useTranslation();
  const words = { close: t('ast.claims.dialog.close'), cancel: t('ast.claims.dialog.cancel'), pending: t('ast.claims.dialog.pending') };
  return (
    <CommandFrame title={title} refusal={hasError ? problemMessage(t, describeProblem(error)) : undefined} pending={pending} submitLabel={submitLabel} words={words} onSubmit={onSubmit} onClose={onClose}>
      {children}
    </CommandFrame>
  );
}

function useShown<Form extends object>(problems: Partial<Record<keyof Form, FormProblem>>, submitted: boolean) {
  const { t } = useTranslation();
  return (field: keyof Form): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
}

/** Filing a claim on an obligation still running: the number, the day the defect was reported, how bad it is and what it is. It goes to the contractor of the contract, who has seven days to answer. */
export function FileDialog({ obligations, initialObligationId, onClose }: { obligations: readonly ObligationOption[]; initialObligationId: string; onClose(): void }) {
  const { t } = useTranslation();
  const file = useFileClaim();
  const [form, setForm] = useState<FileForm>(emptyFile(obligations.some((obligation) => obligation.id === initialObligationId) ? initialObligationId : '', vietnamToday()));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateFile(form, obligations);
  const shown = useShown<FileForm>(problems, submitted);
  const set = (patch: Partial<FileForm>): void => setForm({ ...form, ...patch });
  const chosen = obligations.find((obligation) => obligation.id === form.obligationId);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (file.isPending || Object.keys(problems).length > 0) return;
    file.mutate({ obligationId: form.obligationId, body: fileBody(form, obligations) }, { onSuccess: onClose });
  };
  return (
    <Frame title={t('ast.claims.file.title')} error={file.error} hasError={file.isError} pending={file.isPending} submitLabel={t('ast.claims.file.submit')} onSubmit={send} onClose={onClose}>
      <Field id="claim-obligation" label={t('ast.claims.field.obligation')} error={shown('obligationId')}>
        <select id="claim-obligation" value={form.obligationId} onChange={(event) => set({ obligationId: event.target.value })}>
          <option value="">{t('ast.claims.field.obligation.choose')}</option>
          {obligations.map((obligation) => (
            <option key={obligation.id} value={obligation.id}>
              {`${obligation.contractCode} · ${obligation.handoverNo ?? ''} · ${obligation.scope}`}
            </option>
          ))}
        </select>
      </Field>
      {chosen === undefined ? null : (
        <p className="callout" role="note" data-testid="file-addressee">
          {chosen.contractor === null ? t('ast.claims.file.addressee.none') : t('ast.claims.file.addressee', { name: chosen.contractor.name, end: chosen.endsOn })}
        </p>
      )}
      <Field id="claim-no" label={t('ast.claims.field.number')} error={shown('claimNo')}>
        <input id="claim-no" autoComplete="off" value={form.claimNo} onChange={(event) => set({ claimNo: event.target.value })} />
      </Field>
      <Field id="claim-reported" label={t('ast.claims.field.reported')} error={shown('reportedOn')} hint={t('ast.claims.field.reported.hint')}>
        <input id="claim-reported" type="date" value={form.reportedOn} onChange={(event) => set({ reportedOn: event.target.value })} />
      </Field>
      <Field id="claim-severity" label={t('ast.claims.field.severity')} error={shown('severity')}>
        <select id="claim-severity" value={form.severity} onChange={(event) => set({ severity: event.target.value })}>
          <option value="">{t('ast.claims.field.severity.choose')}</option>
          {SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {severityLabel(t, severity)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="claim-defect" label={t('ast.claims.field.defect')} error={shown('defect')}>
        <textarea id="claim-defect" rows={3} value={form.defect} onChange={(event) => set({ defect: event.target.value })} />
      </Field>
      <Field id="claim-location" label={t('ast.claims.field.location')} error={shown('location')}>
        <input id="claim-location" autoComplete="off" value={form.location} onChange={(event) => set({ location: event.target.value })} />
      </Field>
      <Field id="claim-evidence" label={t('ast.claims.field.evidence')} error={shown('evidenceDocumentId')} hint={t('ast.claims.field.evidence.hint')}>
        <input id="claim-evidence" autoComplete="off" value={form.evidenceDocumentId} onChange={(event) => set({ evidenceDocumentId: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** The contractor takes the claim on and commits to the day it will have put it right. */
export function AcknowledgeDialog({ claim, onClose }: { claim: ClaimLine; onClose(): void }) {
  const { t } = useTranslation();
  const acknowledge = useAcknowledgeClaim();
  const [form, setForm] = useState<AcknowledgeForm>(emptyAcknowledge());
  const [submitted, setSubmitted] = useState(false);
  const problems = validateAcknowledge(form, claim);
  const shown = useShown<AcknowledgeForm>(problems, submitted);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (acknowledge.isPending || Object.keys(problems).length > 0) return;
    acknowledge.mutate({ id: claim.id, version: claim.version, body: acknowledgeBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.claims.acknowledge.title', { number: claim.claimNo })}
      error={acknowledge.error}
      hasError={acknowledge.isError}
      pending={acknowledge.isPending}
      submitLabel={t('ast.claims.acknowledge.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="claim-committed" label={t('ast.claims.field.committed')} error={shown('committedOn')} hint={t('ast.claims.field.committed.hint', { day: claim.reportedOn })}>
        <input id="claim-committed" type="date" value={form.committedOn} onChange={(event) => setForm({ ...form, committedOn: event.target.value })} />
      </Field>
      <Field id="claim-ack-note" label={t('ast.claims.field.note.optional')} error={shown('note')}>
        <textarea id="claim-ack-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** The contractor says the defect is put right, with the day, what was done and evidence: a clean file or a clean photo of the contract. */
export function FixDialog({ claim, onClose }: { claim: ClaimLine; onClose(): void }) {
  const { t } = useTranslation();
  const fix = useRecordFix();
  const [form, setForm] = useState<FixForm>(emptyFix(vietnamToday()));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateFix(form, claim);
  const shown = useShown<FixForm>(problems, submitted);
  const set = (patch: Partial<FixForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (fix.isPending || Object.keys(problems).length > 0) return;
    fix.mutate({ id: claim.id, version: claim.version, body: fixBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame title={t('ast.claims.fix.title', { number: claim.claimNo })} error={fix.error} hasError={fix.isError} pending={fix.isPending} submitLabel={t('ast.claims.fix.submit')} onSubmit={send} onClose={onClose}>
      <Field id="claim-fixed" label={t('ast.claims.field.fixed')} error={shown('fixedOn')}>
        <input id="claim-fixed" type="date" value={form.fixedOn} onChange={(event) => set({ fixedOn: event.target.value })} />
      </Field>
      <Field id="claim-fix-note" label={t('ast.claims.field.note')} error={shown('note')}>
        <textarea id="claim-fix-note" rows={3} value={form.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      <Field id="claim-fix-document" label={t('ast.claims.field.fixDocument')} error={shown('documentId')} hint={t('ast.claims.field.fixDocument.hint')}>
        <input id="claim-fix-document" autoComplete="off" value={form.documentId} onChange={(event) => set({ documentId: event.target.value })} />
      </Field>
      <Field id="claim-fix-photo" label={t('ast.claims.field.fixPhoto')} error={shown('photoId')}>
        <input id="claim-fix-photo" autoComplete="off" value={form.photoId} onChange={(event) => set({ photoId: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Somebody who neither reported the defect nor said it was put right verifies the repair, saying who bears the cost, or disputes it so that it is put right again. */
export function VerifyDialog({ claim, onClose }: { claim: ClaimLine; onClose(): void }) {
  const { t } = useTranslation();
  const verify = useVerifyClaim();
  const [form, setForm] = useState<VerifyForm>(emptyVerify());
  const [submitted, setSubmitted] = useState(false);
  const problems = validateVerify(form);
  const shown = useShown<VerifyForm>(problems, submitted);
  const set = (patch: Partial<VerifyForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (verify.isPending || Object.keys(problems).length > 0) return;
    verify.mutate({ id: claim.id, version: claim.version, body: verifyBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.claims.verify.title', { number: claim.claimNo })}
      error={verify.error}
      hasError={verify.isError}
      pending={verify.isPending}
      submitLabel={t('ast.claims.verify.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="claim-outcome" label={t('ast.claims.field.outcome')} error={shown('outcome')}>
        <select id="claim-outcome" value={form.outcome} onChange={(event) => set({ outcome: event.target.value })}>
          <option value="">{t('ast.claims.field.outcome.choose')}</option>
          {OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {outcomeLabel(t, outcome)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="claim-bearer" label={t('ast.claims.field.bearer')} error={shown('bearer')}>
        <select id="claim-bearer" value={form.bearer} onChange={(event) => set({ bearer: event.target.value })}>
          <option value="">{t('ast.claims.field.bearer.choose')}</option>
          {BEARERS.map((bearer) => (
            <option key={bearer} value={bearer}>
              {bearerLabel(t, bearer)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="claim-verify-note" label={t('ast.claims.field.note')} error={shown('note')}>
        <textarea id="claim-verify-note" rows={3} value={form.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
    </Frame>
  );
}
