import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../CommandFrame';
import { roleLabel, typeLabel } from '../inspection/labels';
import type { InspectionLine } from '../inspection/model';
import { useDecideAcceptance, useDraftAcceptance, useRevokeAcceptance, useSignAcceptance } from './hooks';
import { decisionLabel, effectLabel, formProblemMessage, methodLabel, problemMessage, scopeLabel } from './labels';
import { DECISIONS, EMPTY_DECIDE, EMPTY_DRAFT, SIGNATURE_METHODS, decideBody, describeProblem, draftBody, emptySign, legalEffectOf, scopeOf, signBody, validateDecide, validateDraft, validateReason, validateSign } from './model';
import type { AcceptanceLine, DecideForm, DraftForm, SignForm } from './model';
import '../qms.css';

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
  const { t } = useTranslation();
  const words = { close: t('qms.acceptance.dialog.close'), cancel: t('qms.acceptance.dialog.cancel'), pending: t('qms.acceptance.dialog.pending') };
  return (
    <CommandFrame title={title} refusal={hasError ? problemMessage(t, describeProblem(error)) : undefined} pending={pending} submitLabel={submitLabel} words={words} onSubmit={onSubmit} onClose={onClose}>
      {children}
    </CommandFrame>
  );
}

/**
 * Drafting minutes from an inspection that passed. The scope follows the kind of inspection; the roles that sign are the ones the regime of the day required of the inspection, and the
 * screen shows them as soon as the inspection is chosen. The paper of the minutes is typed by identifier (there is no document picker yet).
 */
export function DraftDialog({ inspections, onClose }: { inspections: readonly InspectionLine[]; onClose(): void }) {
  const { t } = useTranslation();
  const draft = useDraftAcceptance();
  const [form, setForm] = useState<DraftForm>(EMPTY_DRAFT);
  const [submitted, setSubmitted] = useState(false);
  const chosen = inspections.find((inspection) => inspection.id === form.inspectionId);
  const problems = validateDraft(form);
  const shown = (field: keyof DraftForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (draft.isPending || chosen === undefined || Object.keys(problems).length > 0) return;
    draft.mutate({ inspectionId: chosen.id, body: draftBody(form, chosen.inspectionType) }, { onSuccess: onClose });
  };
  return (
    <Frame title={t('qms.acceptance.draft.title')} error={draft.error} hasError={draft.isError} pending={draft.isPending} submitLabel={t('qms.acceptance.draft.submit')} onSubmit={send} onClose={onClose}>
      <Field id="acceptance-inspection" label={t('qms.acceptance.field.inspection')} error={shown('inspectionId')}>
        <select id="acceptance-inspection" value={form.inspectionId} onChange={(event) => setForm({ ...form, inspectionId: event.target.value })}>
          <option value="">{t('qms.acceptance.field.inspection.choose')}</option>
          {inspections.map((inspection) => (
            <option key={inspection.id} value={inspection.id}>
              {`${inspection.inspectionNo} · ${inspection.contract.code} · ${inspection.title}`}
            </option>
          ))}
        </select>
      </Field>
      {chosen === undefined ? null : (
        <p className="sub" data-testid="draft-scope">
          {t('qms.acceptance.draft.scope', { kind: typeLabel(t, chosen.inspectionType), scope: scopeLabel(t, scopeOf(chosen.inspectionType)), roles: chosen.requiredRoles.map((role) => roleLabel(t, role)).join(', ') })}
        </p>
      )}
      <Field id="acceptance-record-no" label={t('qms.acceptance.field.recordNo')} error={shown('recordNo')}>
        <input id="acceptance-record-no" autoComplete="off" value={form.recordNo} onChange={(event) => setForm({ ...form, recordNo: event.target.value })} />
      </Field>
      <Field id="acceptance-document" label={t('qms.acceptance.field.document')} error={shown('documentId')} hint={t('qms.acceptance.field.document.hint')}>
        <input id="acceptance-document" autoComplete="off" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Signing as one of the roles the minutes require that the signer can sign as and has not signed; a certificate is a legal electronic signature and carries its serial. */
export function SignDialog({ line, onClose }: { line: AcceptanceLine; onClose(): void }) {
  const { t } = useTranslation();
  const sign = useSignAcceptance();
  // One signature, one identifier: a retry of this signature is this signature (the identifier is made when the dialog opens).
  const [form, setForm] = useState<SignForm>(() => emptySign(line.signableRoles, crypto.randomUUID()));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateSign(form);
  const shown = (field: keyof SignForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (sign.isPending || Object.keys(problems).length > 0) return;
    sign.mutate({ id: line.id, version: line.version, body: signBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame title={t('qms.acceptance.sign.title', { no: line.recordNo })} error={sign.error} hasError={sign.isError} pending={sign.isPending} submitLabel={t('qms.acceptance.sign.submit')} onSubmit={send} onClose={onClose}>
      <Field id="acceptance-role" label={t('qms.acceptance.field.role')} error={shown('role')}>
        <select id="acceptance-role" value={form.role} onChange={(event) => setForm({ ...form, role: line.signableRoles.find((role) => role === event.target.value) ?? '' })}>
          <option value="">{t('qms.acceptance.field.role.choose')}</option>
          {line.signableRoles.map((role) => (
            <option key={role} value={role}>
              {roleLabel(t, role)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="acceptance-method" label={t('qms.acceptance.field.method')} error={undefined} hint={effectLabel(t, legalEffectOf(form.method))}>
        <select id="acceptance-method" value={form.method} onChange={(event) => setForm({ ...form, method: SIGNATURE_METHODS.find((method) => method === event.target.value) ?? 'IN_APP_OTP' })}>
          {SIGNATURE_METHODS.map((method) => (
            <option key={method} value={method}>
              {methodLabel(t, method)}
            </option>
          ))}
        </select>
      </Field>
      {form.method === 'DIGITAL_CERT' ? (
        <Field id="acceptance-serial" label={t('qms.acceptance.field.serial')} error={shown('certSerial')}>
          <input id="acceptance-serial" autoComplete="off" value={form.certSerial} onChange={(event) => setForm({ ...form, certSerial: event.target.value })} />
        </Field>
      ) : null}
    </Frame>
  );
}

/**
 * The decision on minutes that are being signed. Approving needs every required role to have signed, no serious non-conformance open and someone other than whoever drafted the minutes;
 * the screen offers each decision only to the one who may take it and tells in words what the server refused.
 */
export function DecideDialog({ line, onClose }: { line: AcceptanceLine; onClose(): void }) {
  const { t } = useTranslation();
  const decide = useDecideAcceptance();
  const [form, setForm] = useState<DecideForm>(EMPTY_DECIDE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDecide(form);
  const options = useMemo(() => DECISIONS.filter((decision) => (decision === 'approve' ? line.canApprove : line.canReject)), [line.canApprove, line.canReject]);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || Object.keys(problems).length > 0) return;
    decide.mutate({ id: line.id, version: line.version, body: decideBody(form) }, { onSuccess: onClose });
  };
  const decisionError = submitted && problems.decision !== undefined ? formProblemMessage(t, problems.decision) : undefined;
  const reasonError = submitted && problems.reason !== undefined ? formProblemMessage(t, problems.reason) : undefined;
  return (
    <Frame title={t('qms.acceptance.decide.title', { no: line.recordNo })} error={decide.error} hasError={decide.isError} pending={decide.isPending} submitLabel={t('qms.acceptance.decide.submit')} onSubmit={send} onClose={onClose}>
      <fieldset className="field" data-field="acceptance-decision">
        <legend>{t('qms.acceptance.field.decision')}</legend>
        {options.map((decision) => (
          <label key={decision} className="radio">
            <input type="radio" name="acceptance-decision" value={decision} data-decision={decision} checked={form.decision === decision} onChange={() => setForm({ ...form, decision })} /> {decisionLabel(t, decision)}
          </label>
        ))}
        {decisionError === undefined ? null : (
          <small role="alert" className="field-error">
            {decisionError}
          </small>
        )}
      </fieldset>
      <Field id="acceptance-reason" label={t('qms.acceptance.field.reason')} error={reasonError}>
        <textarea id="acceptance-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Withdrawing approved minutes with a reason, kept with them; the server refuses it while an approved acceptance of work holds them. */
export function RevokeDialog({ line, onClose }: { line: AcceptanceLine; onClose(): void }) {
  const { t } = useTranslation();
  const revoke = useRevokeAcceptance();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateReason(reason);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (revoke.isPending || problem !== undefined) return;
    revoke.mutate({ id: line.id, version: line.version, body: { reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Frame title={t('qms.acceptance.revoke.title', { no: line.recordNo })} error={revoke.error} hasError={revoke.isError} pending={revoke.isPending} submitLabel={t('qms.acceptance.revoke.submit')} onSubmit={send} onClose={onClose}>
      <Field id="acceptance-revoke-reason" label={t('qms.acceptance.field.revokeReason')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined} hint={t('qms.acceptance.field.revokeReason.hint')}>
        <textarea id="acceptance-revoke-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Frame>
  );
}
