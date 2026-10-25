import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import type { ContractLine } from '../../ctr/model';
import { CommandFrame } from '../CommandFrame';
import { useAssignCorrectiveAction, useAssignees, useCloseNonconformance, useRaiseNonconformance, useReopenNonconformance, useSubmitCorrectiveEvidence, useVerifyCorrectiveAction } from './hooks';
import { formProblemMessage, problemMessage, severityLabel, sourceLabel, verificationLabel } from './labels';
import {
  EMPTY_EVIDENCE,
  EMPTY_VERIFY,
  SEVERITIES,
  SOURCE_KINDS,
  VERIFICATIONS,
  assignBody,
  describeProblem,
  emptyAssign,
  emptyRaise,
  evidenceBody,
  raiseBody,
  validateAssign,
  validateEvidence,
  validateNote,
  validateRaise,
  validateVerify,
  vietnamToday,
} from './model';
import type { ActionLine, AssignForm, EvidenceForm, FormProblem, NcrLine, RaiseForm, VerifyForm } from './model';

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
  const words = { close: t('qms.ncr.dialog.close'), cancel: t('qms.ncr.dialog.cancel'), pending: t('qms.ncr.dialog.pending') };
  return (
    <CommandFrame
      title={title}
      refusal={hasError ? problemMessage(t, describeProblem(error)) : undefined}
      pending={pending}
      submitLabel={submitLabel}
      words={words}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      {children}
    </CommandFrame>
  );
}

/** The members who can carry a non-conformance or an action: the select of a person, and the notice when the list of members cannot be read. */
function PersonField({ id, label, value, onChange, error }: { id: string; label: string; value: string; onChange(next: string): void; error: string | undefined }) {
  const { t } = useTranslation();
  const people = useAssignees(true);
  return (
    <>
      {people.isError ? (
        <p className="callout warning" role="status" data-testid="members-failed">
          {t('qms.ncr.field.person.failed')}
        </p>
      ) : null}
      <Field id={id} label={label} error={error}>
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('qms.ncr.field.person.choose')}</option>
          {(people.data ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

/**
 * Raising a non-conformance against a contract that is being performed: how serious it is, where it came from, what it says and who is responsible for putting it right by which day.
 * A critical one holds back the quality acceptance until it is closed.
 */
export function RaiseDialog({ contracts, initialContractId, onClose }: { contracts: readonly ContractLine[]; initialContractId: string; onClose(): void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const raise = useRaiseNonconformance();
  const [form, setForm] = useState<RaiseForm>(emptyRaise(today, contracts.some((contract) => contract.id === initialContractId) ? initialContractId : ''));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRaise(form, today);
  const shown = (field: keyof RaiseForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<RaiseForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (raise.isPending || Object.keys(problems).length > 0) return;
    raise.mutate(raiseBody(form), { onSuccess: onClose });
  };
  return (
    <Frame title={t('qms.ncr.raise.title')} error={raise.error} hasError={raise.isError} pending={raise.isPending} submitLabel={t('qms.ncr.raise.submit')} onSubmit={send} onClose={onClose}>
      <Field id="ncr-contract" label={t('qms.ncr.field.contract')} error={shown('contractId')}>
        <select id="ncr-contract" value={form.contractId} onChange={(event) => set({ contractId: event.target.value })}>
          <option value="">{t('qms.ncr.field.contract.choose')}</option>
          {contracts.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="ncr-severity" label={t('qms.ncr.field.severity')} error={shown('severity')} hint={t('qms.ncr.field.severity.hint')}>
        <select id="ncr-severity" value={form.severity} onChange={(event) => set({ severity: SEVERITIES.find((severity) => severity === event.target.value) ?? '' })}>
          <option value="">{t('qms.ncr.field.severity.choose')}</option>
          {SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {severityLabel(t, severity)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="ncr-source" label={t('qms.ncr.field.source')} error={shown('sourceKind')}>
        <select id="ncr-source" value={form.sourceKind} onChange={(event) => set({ sourceKind: SOURCE_KINDS.find((source) => source === event.target.value) ?? '' })}>
          <option value="">{t('qms.ncr.field.source.choose')}</option>
          {SOURCE_KINDS.map((source) => (
            <option key={source} value={source}>
              {sourceLabel(t, source)}
            </option>
          ))}
        </select>
      </Field>
      {form.sourceKind === 'INSPECTION' ? (
        <Field id="ncr-inspection" label={t('qms.ncr.field.inspection')} error={shown('inspectionId')} hint={t('qms.ncr.field.reference.hint')}>
          <input id="ncr-inspection" autoComplete="off" value={form.inspectionId} onChange={(event) => set({ inspectionId: event.target.value })} />
        </Field>
      ) : null}
      {form.sourceKind === 'MATERIAL_TEST' ? (
        <Field id="ncr-test" label={t('qms.ncr.field.test')} error={shown('materialTestId')} hint={t('qms.ncr.field.reference.hint')}>
          <input id="ncr-test" autoComplete="off" value={form.materialTestId} onChange={(event) => set({ materialTestId: event.target.value })} />
        </Field>
      ) : null}
      <Field id="ncr-title" label={t('qms.ncr.field.title')} error={shown('title')}>
        <input id="ncr-title" autoComplete="off" value={form.title} onChange={(event) => set({ title: event.target.value })} />
      </Field>
      <Field id="ncr-description" label={t('qms.ncr.field.description')} error={shown('description')}>
        <textarea id="ncr-description" rows={3} value={form.description} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <Field id="ncr-diary" label={t('qms.ncr.field.diary')} error={shown('siteDiaryId')} hint={t('qms.ncr.field.reference.hint')}>
        <input id="ncr-diary" autoComplete="off" value={form.siteDiaryId} onChange={(event) => set({ siteDiaryId: event.target.value })} />
      </Field>
      <PersonField id="ncr-owner" label={t('qms.ncr.field.owner')} value={form.actionOwnerId} onChange={(actionOwnerId) => set({ actionOwnerId })} error={shown('actionOwnerId')} />
      <Field id="ncr-due" label={t('qms.ncr.field.due')} error={shown('dueOn')} hint={t('qms.ncr.field.due.hint')}>
        <input id="ncr-due" type="date" value={form.dueOn} onChange={(event) => set({ dueOn: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Assigning a corrective action: what is to be done, who does it and by which day. */
export function AssignDialog({ line, onClose }: { line: NcrLine; onClose(): void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const assign = useAssignCorrectiveAction();
  const [form, setForm] = useState<AssignForm>(emptyAssign(today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateAssign(form, today);
  const shown = (field: keyof AssignForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (assign.isPending || Object.keys(problems).length > 0) return;
    assign.mutate({ id: line.id, version: line.version, body: assignBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('qms.ncr.assign.title', { no: line.ncrNo })}
      error={assign.error}
      hasError={assign.isError}
      pending={assign.isPending}
      submitLabel={t('qms.ncr.assign.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="ncr-action-description" label={t('qms.ncr.field.actionDescription')} error={shown('description')}>
        <textarea id="ncr-action-description" rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </Field>
      <PersonField id="ncr-action-owner" label={t('qms.ncr.field.actionOwner')} value={form.ownerId} onChange={(ownerId) => setForm({ ...form, ownerId })} error={shown('ownerId')} />
      <Field id="ncr-action-due" label={t('qms.ncr.field.due')} error={shown('dueOn')} hint={t('qms.ncr.field.due.hint')}>
        <input id="ncr-action-due" type="date" value={form.dueOn} onChange={(event) => setForm({ ...form, dueOn: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Answering an action with its evidence: a clean document or a photo of the contract, and a note of what was done. */
export function EvidenceDialog({ line, action, onClose }: { line: NcrLine; action: ActionLine; onClose(): void }) {
  const { t } = useTranslation();
  const submit = useSubmitCorrectiveEvidence();
  const [form, setForm] = useState<EvidenceForm>(EMPTY_EVIDENCE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateEvidence(form);
  const shown = (field: keyof EvidenceForm): string | undefined => {
    const problem: FormProblem | undefined = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (submit.isPending || Object.keys(problems).length > 0) return;
    submit.mutate({ id: action.id, body: evidenceBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('qms.ncr.evidence.title', { no: line.ncrNo })}
      error={submit.error}
      hasError={submit.isError}
      pending={submit.isPending}
      submitLabel={t('qms.ncr.evidence.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub" data-testid="evidence-action">
        {action.description}
      </p>
      <Field id="ncr-evidence-document" label={t('qms.ncr.field.evidenceDocument')} error={shown('documentVersionId')} hint={t('qms.ncr.field.evidenceDocument.hint')}>
        <input id="ncr-evidence-document" autoComplete="off" value={form.documentVersionId} onChange={(event) => setForm({ ...form, documentVersionId: event.target.value })} />
      </Field>
      <Field id="ncr-evidence-photo" label={t('qms.ncr.field.evidencePhoto')} error={shown('photoId')} hint={t('qms.ncr.field.evidencePhoto.hint')}>
        <input id="ncr-evidence-photo" autoComplete="off" value={form.photoId} onChange={(event) => setForm({ ...form, photoId: event.target.value })} />
      </Field>
      <Field id="ncr-evidence-note" label={t('qms.ncr.field.evidenceNote')} error={shown('note')}>
        <textarea id="ncr-evidence-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Verifying an action that was answered, or giving it back: the evidence it was answered with is shown above the verdict. */
export function VerifyDialog({ line, action, onClose }: { line: NcrLine; action: ActionLine; onClose(): void }) {
  const { t } = useTranslation();
  const verify = useVerifyCorrectiveAction();
  const [form, setForm] = useState<VerifyForm>(EMPTY_VERIFY);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateVerify(form);
  const shown = (field: keyof VerifyForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    const outcome = form.outcome;
    if (verify.isPending || outcome === '' || Object.keys(problems).length > 0) return;
    verify.mutate({ id: action.id, body: { outcome, verification_note: form.note.trim() } }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('qms.ncr.verify.title', { no: line.ncrNo })}
      error={verify.error}
      hasError={verify.isError}
      pending={verify.isPending}
      submitLabel={t('qms.ncr.verify.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub" data-testid="verify-action">
        {action.description}
      </p>
      {action.evidenceNote === null ? null : (
        <p className="callout" data-testid="verify-evidence">
          {t('qms.ncr.verify.evidence', { note: action.evidenceNote })}
        </p>
      )}
      <Field id="ncr-verify-outcome" label={t('qms.ncr.field.outcome')} error={shown('outcome')}>
        <select id="ncr-verify-outcome" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: VERIFICATIONS.find((outcome) => outcome === event.target.value) ?? '' })}>
          <option value="">{t('qms.ncr.field.outcome.choose')}</option>
          {VERIFICATIONS.map((outcome) => (
            <option key={outcome} value={outcome}>
              {verificationLabel(t, outcome)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="ncr-verify-note" label={t('qms.ncr.field.verificationNote')} error={shown('note')}>
        <textarea id="ncr-verify-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Closing a verified non-conformance: a note that says why nothing is left to do, kept with it. */
export function CloseDialog({ line, onClose }: { line: NcrLine; onClose(): void }) {
  const { t } = useTranslation();
  const close = useCloseNonconformance();
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateNote(note);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (close.isPending || problem !== undefined) return;
    close.mutate({ id: line.id, version: line.version, body: { closure_note: note.trim() } }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('qms.ncr.close.title', { no: line.ncrNo })}
      error={close.error}
      hasError={close.isError}
      pending={close.isPending}
      submitLabel={t('qms.ncr.close.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field
        id="ncr-closure-note"
        label={t('qms.ncr.field.closureNote')}
        error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined}
        hint={t('qms.ncr.field.closureNote.hint')}
      >
        <textarea id="ncr-closure-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
    </Frame>
  );
}

/** Reopening a closed non-conformance that came back: a reason, kept with it. */
export function ReopenDialog({ line, onClose }: { line: NcrLine; onClose(): void }) {
  const { t } = useTranslation();
  const reopen = useReopenNonconformance();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateNote(reason);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (reopen.isPending || problem !== undefined) return;
    reopen.mutate({ id: line.id, version: line.version, body: { reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('qms.ncr.reopen.title', { no: line.ncrNo })}
      error={reopen.error}
      hasError={reopen.isError}
      pending={reopen.isPending}
      submitLabel={t('qms.ncr.reopen.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field
        id="ncr-reopen-reason"
        label={t('qms.ncr.field.reopenReason')}
        error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined}
        hint={t('qms.ncr.field.reopenReason.hint')}
      >
        <textarea id="ncr-reopen-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Frame>
  );
}
