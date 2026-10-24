import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { MAX_EVIDENCE, businessMomentToIso, extensionProblem, parseEvidence, reopenDeadline } from './closure-model';
import type { EvidenceProblem, ExtensionProblem } from './closure-model';
import { Problem, tooLong } from './IssueActions';
import { useAssignIssue, useAssignees, useCloseIssue, useExtendIssue, useReopenIssue, useRequestVerification } from './hooks';
import { useMoment } from './issue-components';
import type { IssueView } from './issue-model';

interface FormProps {
  issue: IssueView;
  onReload: () => void;
  /** Tells the screen what was done: the form goes away with the state it acted on, so the notice belongs to the screen. */
  onDone: (notice: string) => void;
}

/**
 * Sends a command and tells the screen when it was accepted. The form goes away with the state it acted on, and a callback of the mutation
 * would die with it, so the screen is told through the promise; a refusal stays on the mutation, where the form shows it.
 */
export function send<Input>(mutation: { mutateAsync: (input: Input) => Promise<unknown> }, input: Input, done: () => void): void {
  mutation.mutateAsync(input).then(done, () => undefined);
}

const noteProblem = (value: string): 'required' | 'tooLong' | undefined => (value.trim() === '' ? 'required' : tooLong(value) ? 'tooLong' : undefined);

function useProblemText() {
  const { t } = useTranslation();
  return (problem: 'required' | 'tooLong' | undefined): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('iss.field.required.error') : t('iss.field.tooLong.error'));
}

function evidenceMessage(t: ReturnType<typeof useTranslation>['t'], problem: EvidenceProblem): string {
  switch (problem) {
    case 'invalid':
      return t('iss.verification.evidenceInvalid.error');
    case 'tooMany':
      return t('iss.verification.evidenceTooMany.error', { max: MAX_EVIDENCE });
    case 'required':
      return t('iss.verification.evidenceRequired.error');
  }
}

/** The handler declares the work done with the result and the documents that show it (requestIssueVerification); the policy of the issue says whether evidence is required. */
export function RequestVerificationForm({ issue, onReload, onDone }: FormProps) {
  const { t } = useTranslation();
  const text = useProblemText();
  const request = useRequestVerification();
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const [checked, setChecked] = useState(false);
  const required = issue.sla?.requireEvidence ?? true;
  const parsed = parseEvidence(evidence, required);
  const noteError = noteProblem(note);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (request.isPending) return;
    if (noteError !== undefined || parsed.problem !== undefined) {
      setChecked(true);
      return;
    }
    send(request, { id: issue.id, version: issue.version, resultNote: note.trim(), evidenceDocumentVersionIds: parsed.ids }, () => onDone(t('iss.verification.request.done')));
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('iss.verification.request.title')}>
      <h2>{t('iss.verification.request.title')}</h2>
      <p className="sub">{t('iss.verification.request.text')}</p>
      {request.isError ? <Problem error={request.error} onReload={onReload} reset={request.reset} /> : null}
      <Field id="request-note" label={t('iss.verification.request.note.label')} error={checked ? text(noteError) : undefined}>
        <textarea id="request-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <Field
        id="request-evidence"
        label={required ? t('iss.verification.request.evidence.label') : t('iss.verification.request.evidenceOptional.label')}
        hint={t('iss.verification.request.evidence.hint')}
        error={checked && parsed.problem !== undefined ? evidenceMessage(t, parsed.problem) : undefined}
      >
        <textarea id="request-evidence" rows={3} value={evidence} onChange={(event) => setEvidence(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={request.isPending}>
          {request.isPending ? t('iss.verification.request.pending') : t('iss.verification.request.action')}
        </button>
      </div>
    </form>
  );
}

/** A person other than the handler confirms the result and closes the issue (closeIssue). The handler sees why they cannot, before the server says so. */
export function CloseForm({ issue, onReload, onDone }: FormProps) {
  const { t } = useTranslation();
  const text = useProblemText();
  const close = useCloseIssue();
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  const noteError = noteProblem(note);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (close.isPending) return;
    if (noteError !== undefined) {
      setChecked(true);
      return;
    }
    send(close, { id: issue.id, version: issue.version, verificationNote: note.trim() }, () => onDone(t('iss.verification.close.done')));
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('iss.verification.close.title')}>
      <h2>{t('iss.verification.close.title')}</h2>
      <p className="sub">{t('iss.verification.close.text')}</p>
      {close.isError ? <Problem error={close.error} onReload={onReload} reset={close.reset} /> : null}
      <Field id="close-note" label={t('iss.verification.close.note.label')} error={checked ? text(noteError) : undefined}>
        <textarea id="close-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={close.isPending}>
          {close.isPending ? t('iss.verification.close.pending') : t('iss.verification.close.action')}
        </button>
      </div>
    </form>
  );
}

/** The verifier refuses the result: the issue goes back to its handler (assignIssue) with the reason, and the claim of being done is withdrawn. */
export function RefuseForm({ issue, onReload, onDone }: FormProps) {
  const { t } = useTranslation();
  const text = useProblemText();
  const members = useAssignees(issue.id);
  const assign = useAssignIssue();
  const [assigneeId, setAssigneeId] = useState(issue.assignee?.id ?? '');
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  const noteError = noteProblem(note);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (assign.isPending) return;
    if (noteError !== undefined || assigneeId === '') {
      setChecked(true);
      return;
    }
    send(assign, { id: issue.id, version: issue.version, assigneeId, note: note.trim() }, () => onDone(t('iss.verification.refuse.done')));
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('iss.verification.refuse.title')}>
      <h2>{t('iss.verification.refuse.title')}</h2>
      <p className="sub">{t('iss.verification.refuse.text')}</p>
      {members.isError ? (
        <p className="callout warning" role="status" data-testid="members-unavailable">
          {t('iss.workspace.assign.members.error')}
        </p>
      ) : null}
      {assign.isError ? <Problem error={assign.error} onReload={onReload} reset={assign.reset} /> : null}
      <Field id="refuse-assignee" label={t('iss.verification.refuse.assignee.label')} error={checked && assigneeId === '' ? t('iss.field.required.error') : undefined}>
        <select id="refuse-assignee" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
          <option value="">{t('iss.create.choose.option')}</option>
          {(members.data ?? []).map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="refuse-note" label={t('iss.verification.refuse.note.label')} error={checked ? text(noteError) : undefined}>
        <textarea id="refuse-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button" disabled={assign.isPending}>
          {assign.isPending ? t('iss.verification.refuse.pending') : t('iss.verification.refuse.action')}
        </button>
      </div>
    </form>
  );
}

/** Opens a closed issue again with the reason, while the window lasts (reopenIssue). */
export function ReopenForm({ issue, onReload, onDone }: FormProps) {
  const { t } = useTranslation();
  const moment = useMoment();
  const text = useProblemText();
  const reopen = useReopenIssue();
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const reasonError = noteProblem(reason);
  const until = reopenDeadline(issue);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (reopen.isPending) return;
    if (reasonError !== undefined) {
      setChecked(true);
      return;
    }
    send(reopen, { id: issue.id, version: issue.version, reason: reason.trim() }, () => onDone(t('iss.verification.reopen.done')));
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('iss.verification.reopen.title')}>
      <h2>{t('iss.verification.reopen.title')}</h2>
      {until === null ? null : (
        <p className="sub" data-testid="reopen-window">
          {t('iss.verification.reopen.window.text', { until: moment(until) })}
        </p>
      )}
      {reopen.isError ? <Problem error={reopen.error} onReload={onReload} reset={reopen.reset} /> : null}
      <Field id="reopen-reason" label={t('iss.verification.reopen.reason.label')} error={checked ? text(reasonError) : undefined}>
        <textarea id="reopen-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button" disabled={reopen.isPending}>
          {reopen.isPending ? t('iss.verification.reopen.pending') : t('iss.verification.reopen.action')}
        </button>
      </div>
    </form>
  );
}

function extensionMessage(t: ReturnType<typeof useTranslation>['t'], problem: ExtensionProblem): string {
  switch (problem) {
    case 'required':
      return t('iss.field.required.error');
    case 'invalid':
      return t('iss.extension.dueAtInvalid.error');
    case 'notLater':
      return t('iss.extension.dueAtNotLater.error');
    case 'inThePast':
      return t('iss.extension.dueAtInThePast.error');
  }
}

/** Extends the deadline (extendIssueDeadline): by a person other than the handler, a bounded number of times, never hiding the days overdue. */
export function ExtendForm({ issue, onReload, onDone }: FormProps) {
  const { t } = useTranslation();
  const moment = useMoment();
  const text = useProblemText();
  const extend = useExtendIssue();
  const [dueAt, setDueAt] = useState('');
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const { used, limit } = issue.extensions;
  const exhausted = used >= limit;
  const dueProblem = extensionProblem(dueAt, issue.dueAt, new Date());
  const reasonError = noteProblem(reason);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (extend.isPending || exhausted) return;
    const iso = businessMomentToIso(dueAt);
    if (dueProblem !== undefined || reasonError !== undefined || iso === undefined) {
      setChecked(true);
      return;
    }
    send(extend, { id: issue.id, version: issue.version, newDueAt: iso, reason: reason.trim() }, () => onDone(t('iss.extension.extend.done')));
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('iss.extension.extend.title')}>
      <h2>{t('iss.extension.extend.title')}</h2>
      <p className="sub" data-testid="extension-count">
        {t('iss.extension.extend.count.text', { used, limit })}
      </p>
      <p className="sub">{t('iss.extension.extend.current.text', { dueAt: moment(issue.dueAt) })}</p>
      {exhausted ? (
        <p className="callout warning" role="status" data-testid="extension-exhausted">
          {t('iss.extension.extend.exhausted.notice')}
        </p>
      ) : null}
      {extend.isError ? <Problem error={extend.error} onReload={onReload} reset={extend.reset} /> : null}
      <Field id="extend-due" label={t('iss.extension.extend.dueAt.label')} hint={t('iss.extension.extend.dueAt.hint')} error={checked && dueProblem !== undefined ? extensionMessage(t, dueProblem) : undefined}>
        <input id="extend-due" type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} disabled={exhausted} />
      </Field>
      <Field id="extend-reason" label={t('iss.extension.extend.reason.label')} error={checked ? text(reasonError) : undefined}>
        <textarea id="extend-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} disabled={exhausted} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={extend.isPending || exhausted}>
          {extend.isPending ? t('iss.extension.extend.pending') : t('iss.extension.extend.action')}
        </button>
      </div>
    </form>
  );
}
