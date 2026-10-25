import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { useProjectOptions } from '../../ctr/hooks';
import { CommandFrame } from '../../qms/CommandFrame';
import { useApproveException, useCloseSettlement, useOpenSettlement, useRefreshSettlement, useSubmitSettlement, useVerifySettlement } from './hooks';
import { outcomeLabel, problemMessage, refusalMessage, scopeLabel } from './labels';
import {
  EMPTY_CLOSE,
  EMPTY_EXCEPTION,
  EMPTY_OPEN,
  EMPTY_VERIFY,
  SCOPES,
  closeBody,
  describeProblem,
  exceptionBody,
  openBody,
  refreshBody,
  submitBody,
  validateClose,
  validateException,
  validateOpen,
  validateRefresh,
  validateSubmit,
  validateVerify,
  verifyBody,
} from './model';
import type { Answer, CloseForm, ExceptionForm, OpenForm, Outcome, RefreshForm, Scope, Settlement, SubmitForm, VerifyForm } from './model';

/** The words of the frame the commands are asked in. */
function useFrameWords() {
  const { t } = useTranslation();
  return { close: t('pay.settlement.dialog.close'), cancel: t('pay.settlement.dialog.cancel'), pending: t('pay.settlement.dialog.pending') };
}

interface DialogProps {
  onDone(answer: Answer | undefined): void;
  onClose(): void;
}

/**
 * Opening a settlement (PAY 3.5 step 1): the project and the scope, and for the scope what it needs, a contract of the project or a fiscal year. The figures are not typed: they are read from the
 * ledgers by the server. Only one settlement is worked on for the same project, scope, contract and year.
 */
export function OpenDialog({ onDone, onClose }: DialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const open = useOpenSettlement();
  const projects = useProjectOptions();
  const [form, setForm] = useState<OpenForm>(EMPTY_OPEN);
  const [sent, setSent] = useState(false);
  const problems = validateOpen(form);
  const shown = (field: keyof OpenForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? problemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (open.isPending || Object.keys(problems).length > 0) return;
    open.mutate({ body: openBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.settlement.open.title')}
      refusal={open.isError ? refusalMessage(t, describeProblem(open.error)) : undefined}
      pending={open.isPending}
      submitLabel={t('pay.settlement.open.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{t('pay.settlement.open.intro')}</p>
      <Field id="open-project" label={t('pay.settlement.open.field.project')} error={shown('projectId')}>
        {(projects.data ?? []).length > 0 ? (
          <select id="open-project" value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
            <option value="">{t('pay.settlement.open.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.label}
              </option>
            ))}
          </select>
        ) : (
          <input id="open-project" autoComplete="off" value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })} />
        )}
      </Field>
      <Field id="open-scope" label={t('pay.settlement.open.field.scope')} error={undefined}>
        <select id="open-scope" value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value as Scope })}>
          {SCOPES.map((scope) => (
            <option key={scope} value={scope}>
              {scopeLabel(t, scope)}
            </option>
          ))}
        </select>
      </Field>
      {form.scope === 'CONTRACT' ? (
        <Field id="open-contract" label={t('pay.settlement.open.field.contract')} error={shown('contractId')}>
          <input id="open-contract" autoComplete="off" value={form.contractId} onChange={(event) => setForm({ ...form, contractId: event.target.value })} />
        </Field>
      ) : null}
      {form.scope === 'ANNUAL' ? (
        <Field id="open-year" label={t('pay.settlement.open.field.year')} error={shown('fiscalYear')}>
          <input id="open-year" inputMode="numeric" autoComplete="off" value={form.fiscalYear} onChange={(event) => setForm({ ...form, fiscalYear: event.target.value })} />
        </Field>
      ) : null}
    </CommandFrame>
  );
}

export interface SettlementDialogProps extends DialogProps {
  settlement: Settlement;
}

/** Reading the figures from the ledgers again, while the settlement is a draft or has been returned (a returned one becomes a draft again). */
export function RefreshDialog({ settlement, onDone, onClose }: SettlementDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const refresh = useRefreshSettlement();
  const [form, setForm] = useState<RefreshForm>({ note: '' });
  const problems = validateRefresh(form);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (refresh.isPending || Object.keys(problems).length > 0) return;
    refresh.mutate({ id: settlement.id, version: settlement.version, body: refreshBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.settlement.refresh.title')}
      refusal={refresh.isError ? refusalMessage(t, describeProblem(refresh.error)) : undefined}
      pending={refresh.isPending}
      submitLabel={t('pay.settlement.refresh.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{settlement.status === 'RETURNED' ? t('pay.settlement.refresh.returned') : t('pay.settlement.refresh.intro')}</p>
      <Field id="refresh-note" label={t('pay.settlement.refresh.field.note')} error={problems.note === undefined ? undefined : problemMessage(t, problems.note)}>
        <textarea id="refresh-note" rows={2} value={form.note} onChange={(event) => setForm({ note: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

export interface SubmitDialogProps extends SettlementDialogProps {
  /** The day in Vietnam, which the day of the submission may not pass. */
  today: string;
}

/** Sending the settlement: the day of the submission fixes the group of the project and the verification deadline, which the server computes from the rule in force that day. */
export function SubmitDialog({ settlement, today, onDone, onClose }: SubmitDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const submit = useSubmitSettlement();
  const [form, setForm] = useState<SubmitForm>({ submittedOn: today });
  const [sent, setSent] = useState(false);
  const problems = validateSubmit(form, today);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (submit.isPending || Object.keys(problems).length > 0) return;
    submit.mutate({ id: settlement.id, version: settlement.version, body: submitBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.settlement.submit.title')}
      refusal={submit.isError ? refusalMessage(t, describeProblem(submit.error)) : undefined}
      pending={submit.isPending}
      submitLabel={t('pay.settlement.submit.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{t('pay.settlement.submit.intro')}</p>
      <Field
        id="submit-day"
        label={t('pay.settlement.submit.field.day')}
        error={sent && problems.submittedOn !== undefined ? problemMessage(t, problems.submittedOn) : undefined}
        hint={t('pay.settlement.submit.day.hint')}
      >
        <input id="submit-day" type="date" max={today} value={form.submittedOn} onChange={(event) => setForm({ submittedOn: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

export interface VerifyDialogProps extends SettlementDialogProps {
  outcome: Outcome;
  /** Whether the caller may read the conclusions of AUD, which the references point to. */
  mayCiteFindings: boolean;
}

/** Taking the file up, verifying it or giving it back (PAY 3.5 step 4): the findings are always needed, and the references to the conclusions of AUD when the caller may read them. */
export function VerifyDialog({ settlement, outcome, mayCiteFindings, onDone, onClose }: VerifyDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const verify = useVerifySettlement();
  const [form, setForm] = useState<VerifyForm>(EMPTY_VERIFY);
  const [sent, setSent] = useState(false);
  const problems = validateVerify(form);
  const shown = (field: keyof VerifyForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? problemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (verify.isPending || Object.keys(problems).length > 0) return;
    verify.mutate({ id: settlement.id, version: settlement.version, body: verifyBody(form, outcome) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.settlement.verify.title', { outcome: outcomeLabel(t, outcome) })}
      refusal={verify.isError ? refusalMessage(t, describeProblem(verify.error)) : undefined}
      pending={verify.isPending}
      submitLabel={outcomeLabel(t, outcome)}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{t('pay.settlement.verify.intro')}</p>
      <Field id="verify-findings" label={t('pay.settlement.verify.field.findings')} error={shown('findings')}>
        <textarea id="verify-findings" rows={3} value={form.findings} onChange={(event) => setForm({ ...form, findings: event.target.value })} />
      </Field>
      {mayCiteFindings ? (
        <Field id="verify-refs" label={t('pay.settlement.verify.field.refs')} error={shown('refs')} hint={t('pay.settlement.verify.refs.hint')}>
          <textarea id="verify-refs" rows={2} value={form.refs} onChange={(event) => setForm({ ...form, refs: event.target.value })} />
        </Field>
      ) : null}
    </CommandFrame>
  );
}

/** The exception that lets a settlement close while something is still owed: its reason and the document that approves it, by someone other than who prepared the settlement. */
export function ExceptionDialog({ settlement, onDone, onClose }: SettlementDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const approve = useApproveException();
  const [form, setForm] = useState<ExceptionForm>(EMPTY_EXCEPTION);
  const [sent, setSent] = useState(false);
  const problems = validateException(form);
  const shown = (field: keyof ExceptionForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? problemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (approve.isPending || Object.keys(problems).length > 0) return;
    approve.mutate({ id: settlement.id, version: settlement.version, body: exceptionBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.settlement.exception.title')}
      refusal={approve.isError ? refusalMessage(t, describeProblem(approve.error)) : undefined}
      pending={approve.isPending}
      submitLabel={t('pay.settlement.exception.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{t('pay.settlement.exception.intro')}</p>
      <Field id="exception-reason" label={t('pay.settlement.exception.field.reason')} error={shown('reason')}>
        <textarea id="exception-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
      <Field id="exception-document" label={t('pay.settlement.exception.field.document')} error={shown('approvalDocumentVersionId')} hint={t('pay.settlement.exception.document.hint')}>
        <input id="exception-document" autoComplete="off" value={form.approvalDocumentVersionId} onChange={(event) => setForm({ ...form, approvalDocumentVersionId: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

/** Closing a verified settlement on the decision that approves it. The figures stay as they are; with something still owed, the exception is what lets it close. */
export function CloseDialog({ settlement, onDone, onClose }: SettlementDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const close = useCloseSettlement();
  const [form, setForm] = useState<CloseForm>(EMPTY_CLOSE);
  const [sent, setSent] = useState(false);
  const problems = validateClose(form);
  const shown = (field: keyof CloseForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? problemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (close.isPending || Object.keys(problems).length > 0) return;
    close.mutate({ id: settlement.id, version: settlement.version, body: closeBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.settlement.close.title')}
      refusal={close.isError ? refusalMessage(t, describeProblem(close.error)) : undefined}
      pending={close.isPending}
      submitLabel={t('pay.settlement.close.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{t('pay.settlement.close.intro')}</p>
      <Field id="close-reason" label={t('pay.settlement.close.field.reason')} error={shown('reason')}>
        <textarea id="close-reason" rows={2} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
      <Field id="close-decision" label={t('pay.settlement.close.field.decision')} error={shown('decisionDocumentVersionId')} hint={t('pay.settlement.close.decision.hint')}>
        <input id="close-decision" autoComplete="off" value={form.decisionDocumentVersionId} onChange={(event) => setForm({ ...form, decisionDocumentVersionId: event.target.value })} />
      </Field>
      <Field id="close-evidence" label={t('pay.settlement.close.field.evidence')} error={shown('evidence')} hint={t('pay.settlement.close.evidence.hint')}>
        <textarea id="close-evidence" rows={2} value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
