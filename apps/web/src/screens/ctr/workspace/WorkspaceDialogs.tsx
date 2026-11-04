import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { errorIdOf, wireControl } from '../../field-wiring';
import { useCancelContract } from '../hooks';
import { useActivateContract, useCloseContract, useCompleteContract, useReturnDraft, useSignContract, useSubmitReview } from './hooks';
import { formProblemMessage, problemMessage } from './labels';
import {
  EMPTY_NOTE,
  MAX_TEXT,
  activateBody,
  closeBody,
  completeBody,
  describeProblem,
  emptyActivate,
  emptyClose,
  emptyComplete,
  emptySign,
  signBody,
  validateActivate,
  validateClose,
  validateComplete,
  validateNote,
  validateSign,
} from './model';
import type { ActivateForm, CloseForm, CompleteForm, FormProblem, NoteForm, SignForm, Summary } from './model';
import '../ctr.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '\u00d7';

interface FrameProps {
  title: string;
  error: unknown;
  hasError: boolean;
  pending: boolean;
  submitLabel: string;
  pendingLabel: string;
  onSubmit(): void;
  onClose(): void;
  children: ReactNode;
}

/** The frame every command of the workspace is asked in: a title, the refusal of the server in words, the fields, and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, pendingLabel, onSubmit, onClose, children }: FrameProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={t('ctr.workspace.dialog.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="ctr-dialog-body">
          <form onSubmit={submit} noValidate>
            {hasError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(error))}
              </p>
            ) : null}
            {children}
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('ctr.workspace.dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={pending}>
                {pending ? pendingLabel : submitLabel}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}

export interface FieldProps {
  id: string;
  label: string;
  problem: FormProblem | undefined;
  hint?: string;
  children: ReactNode;
}

export function Field({ id, label, problem, hint, children }: FieldProps) {
  const { t } = useTranslation();
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {problem === undefined ? null : (
        <small role="alert" className="field-error" id={errorIdOf(id)}>
          {formProblemMessage(t, problem)}
        </small>
      )}
    </div>
  );
}

export interface DialogProps {
  summary: Summary;
  today: string;
  onClose(): void;
}

type NoteKind = 'submit' | 'return' | 'cancel';

function wordsOf(t: ReturnType<typeof useTranslation>['t'], kind: NoteKind, code: string): { title: string; submit: string; field: string } {
  switch (kind) {
    case 'submit':
      return { title: t('ctr.workspace.submit.title', { code }), submit: t('ctr.workspace.submit.submit'), field: t('ctr.workspace.submit.field') };
    case 'return':
      return { title: t('ctr.workspace.return.title', { code }), submit: t('ctr.workspace.return.submit'), field: t('ctr.workspace.return.field') };
    case 'cancel':
      return { title: t('ctr.workspace.cancel.title', { code }), submit: t('ctr.workspace.cancel.submit'), field: t('ctr.workspace.cancel.field') };
  }
}

/** A reason in words: optional when the contract is sent to review, required to give it back or to cancel the draft. */
export function NoteDialog({ kind, summary, onClose }: Omit<DialogProps, 'today'> & { kind: NoteKind }) {
  const { t } = useTranslation();
  const submitReview = useSubmitReview();
  const giveBack = useReturnDraft();
  const cancel = useCancelContract();
  const [form, setForm] = useState<NoteForm>(EMPTY_NOTE);
  const [submitted, setSubmitted] = useState(false);
  const required = kind !== 'submit';
  const problems = validateNote(form, required);
  const command = kind === 'submit' ? submitReview : kind === 'return' ? giveBack : cancel;
  const send = (): void => {
    setSubmitted(true);
    if (command.isPending || Object.keys(problems).length > 0) return;
    const input = { id: summary.contract.id, version: summary.contract.version };
    if (kind === 'cancel') cancel.mutate({ ...input, reason: form.text.trim() }, { onSuccess: onClose });
    else if (kind === 'return') giveBack.mutate({ ...input, text: form.text }, { onSuccess: onClose });
    else submitReview.mutate({ ...input, text: form.text }, { onSuccess: onClose });
  };
  const words = wordsOf(t, kind, summary.contract.code);
  return (
    <Frame
      title={words.title}
      error={command.error}
      hasError={command.isError}
      pending={command.isPending}
      submitLabel={words.submit}
      pendingLabel={t('ctr.workspace.dialog.pending')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="workspace-note" label={words.field} problem={submitted ? problems.text : undefined}>
        {wireControl(<textarea id="workspace-note" rows={4} maxLength={MAX_TEXT} value={form.text} onChange={(event) => setForm({ text: event.target.value })} />, 'workspace-note', {
          hint: false,
          error: submitted && problems.text !== undefined,
        })}
      </Field>
    </Frame>
  );
}

/** The signature of the contract: the day, the signed document and, when the one who reviewed was in conflict, the decision that dealt with it. */
export function SignDialog({ summary, today, onClose }: DialogProps) {
  const { t } = useTranslation();
  const sign = useSignContract();
  const [form, setForm] = useState<SignForm>(emptySign(today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateSign(form, today);
  const shown = (field: keyof SignForm): FormProblem | undefined => (submitted ? problems[field] : undefined);
  const send = (): void => {
    setSubmitted(true);
    if (sign.isPending || Object.keys(problems).length > 0) return;
    sign.mutate({ id: summary.contract.id, version: summary.contract.version, body: signBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ctr.workspace.sign.title', { code: summary.contract.code })}
      error={sign.error}
      hasError={sign.isError}
      pending={sign.isPending}
      submitLabel={t('ctr.workspace.sign.submit')}
      pendingLabel={t('ctr.workspace.dialog.pending')}
      onSubmit={send}
      onClose={onClose}
    >
      <div className="formgrid">
        <Field id="workspace-signed-on" label={t('ctr.workspace.sign.signedOn')} problem={shown('signedOn')}>
          {wireControl(<input id="workspace-signed-on" type="date" value={form.signedOn} onChange={(event) => setForm({ ...form, signedOn: event.target.value })} />, 'workspace-signed-on', {
            hint: false,
            error: shown('signedOn') !== undefined,
          })}
        </Field>
        <Field id="workspace-signed-document" label={t('ctr.workspace.sign.document')} problem={shown('documentVersionId')} hint={t('ctr.workspace.sign.document.hint')}>
          {wireControl(
            <input id="workspace-signed-document" autoComplete="off" value={form.documentVersionId} onChange={(event) => setForm({ ...form, documentVersionId: event.target.value })} />,
            'workspace-signed-document',
            { hint: false, error: shown('documentVersionId') !== undefined },
          )}
        </Field>
        <Field id="workspace-decision-ref" label={t('ctr.workspace.sign.decisionRef')} problem={shown('decisionRef')} hint={t('ctr.workspace.sign.decisionRef.hint')}>
          {wireControl(
            <input id="workspace-decision-ref" autoComplete="off" maxLength={MAX_TEXT} value={form.decisionRef} onChange={(event) => setForm({ ...form, decisionRef: event.target.value })} />,
            'workspace-decision-ref',
            { hint: false, error: shown('decisionRef') !== undefined },
          )}
        </Field>
      </div>
    </Frame>
  );
}

/** The activation of the contract: the day it takes effect, the reasons, and the documents that show the conditions are met. */
export function ActivateDialog({ summary, today, onClose }: DialogProps) {
  const { t } = useTranslation();
  const activate = useActivateContract();
  const [form, setForm] = useState<ActivateForm>(emptyActivate(today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateActivate(form, summary.signedOn);
  const shown = (field: keyof ActivateForm): FormProblem | undefined => (submitted ? problems[field] : undefined);
  const send = (): void => {
    setSubmitted(true);
    if (activate.isPending || Object.keys(problems).length > 0) return;
    activate.mutate({ id: summary.contract.id, version: summary.contract.version, body: activateBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ctr.workspace.activate.title', { code: summary.contract.code })}
      error={activate.error}
      hasError={activate.isError}
      pending={activate.isPending}
      submitLabel={t('ctr.workspace.activate.submit')}
      pendingLabel={t('ctr.workspace.dialog.pending')}
      onSubmit={send}
      onClose={onClose}
    >
      <div className="formgrid">
        <Field id="workspace-effective-from" label={t('ctr.workspace.activate.effectiveFrom')} problem={shown('effectiveFrom')}>
          {wireControl(
            <input id="workspace-effective-from" type="date" value={form.effectiveFrom} onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })} />,
            'workspace-effective-from',
            { hint: false, error: shown('effectiveFrom') !== undefined },
          )}
        </Field>
        <Field id="workspace-activate-reason" label={t('ctr.workspace.activate.reason')} problem={shown('reason')}>
          {wireControl(
            <textarea id="workspace-activate-reason" rows={3} maxLength={MAX_TEXT} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />,
            'workspace-activate-reason',
            { hint: false, error: shown('reason') !== undefined },
          )}
        </Field>
        <Field id="workspace-evidence" label={t('ctr.workspace.activate.evidence')} problem={shown('evidence')} hint={t('ctr.workspace.activate.evidence.hint')}>
          {wireControl(<textarea id="workspace-evidence" rows={3} value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value })} />, 'workspace-evidence', {
            hint: false,
            error: shown('evidence') !== undefined,
          })}
        </Field>
      </div>
      <p className="sub">{t('ctr.workspace.activate.note')}</p>
    </Frame>
  );
}

/** The closure of the contract: the settlement it rests on and a note. The server judges the settlement, the advance still owed and the retention again, and answers with the first guard that is not met. */
export function CloseDialog({ summary, onClose }: Omit<DialogProps, 'today'>) {
  const { t } = useTranslation();
  const close = useCloseContract();
  const [form, setForm] = useState<CloseForm>(emptyClose(summary.closure));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateClose(form);
  const shown = (field: keyof CloseForm): FormProblem | undefined => (submitted ? problems[field] : undefined);
  const send = (): void => {
    setSubmitted(true);
    if (close.isPending || Object.keys(problems).length > 0) return;
    close.mutate({ id: summary.contract.id, version: summary.contract.version, body: closeBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ctr.workspace.close.title', { code: summary.contract.code })}
      error={close.error}
      hasError={close.isError}
      pending={close.isPending}
      submitLabel={t('ctr.workspace.close.submit')}
      pendingLabel={t('ctr.workspace.dialog.pending')}
      onSubmit={send}
      onClose={onClose}
    >
      <div className="formgrid">
        <Field id="workspace-closure-settlement" label={t('ctr.workspace.close.settlement')} problem={shown('settlementId')} hint={t('ctr.workspace.close.settlement.hint')}>
          {wireControl(
            <select id="workspace-closure-settlement" value={form.settlementId} onChange={(event) => setForm({ ...form, settlementId: event.target.value })}>
              <option value="">{t('ctr.workspace.close.settlement.choose')}</option>
              {(summary.closure?.settlements ?? []).map((settlement) => {
                const scope = settlement.scope === 'PROJECT' ? t('ctr.workspace.close.scope.project') : t('ctr.workspace.close.scope.contract');
                return (
                  <option key={settlement.id} value={settlement.id}>
                    {settlement.excepted
                      ? t('ctr.workspace.close.settlement.excepted', { scope, revision: settlement.revision })
                      : t('ctr.workspace.close.settlement.option', { scope, revision: settlement.revision })}
                  </option>
                );
              })}
            </select>,
            'workspace-closure-settlement',
            { hint: false, error: shown('settlementId') !== undefined },
          )}
        </Field>
        <Field id="workspace-closure-note" label={t('ctr.workspace.close.note')} problem={shown('note')}>
          {wireControl(<textarea id="workspace-closure-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />, 'workspace-closure-note', {
            hint: false,
            error: shown('note') !== undefined,
          })}
        </Field>
      </div>
      <p className="sub">{t('ctr.workspace.close.explain')}</p>
    </Frame>
  );
}

/** The completion of the contract: the approved completion minutes it rests on and the day it was completed. The server judges the open non-conformances and the measurements to be decided. */
export function CompleteDialog({ summary, today, onClose }: DialogProps) {
  const { t } = useTranslation();
  const complete = useCompleteContract();
  const [form, setForm] = useState<CompleteForm>(emptyComplete(today, summary.completion));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateComplete(form, today);
  const shown = (field: keyof CompleteForm): FormProblem | undefined => (submitted ? problems[field] : undefined);
  const send = (): void => {
    setSubmitted(true);
    if (complete.isPending || Object.keys(problems).length > 0) return;
    complete.mutate({ id: summary.contract.id, version: summary.contract.version, body: completeBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ctr.workspace.complete.title', { code: summary.contract.code })}
      error={complete.error}
      hasError={complete.isError}
      pending={complete.isPending}
      submitLabel={t('ctr.workspace.complete.submit')}
      pendingLabel={t('ctr.workspace.dialog.pending')}
      onSubmit={send}
      onClose={onClose}
    >
      <div className="formgrid">
        <Field id="workspace-completion-acceptance" label={t('ctr.workspace.complete.acceptance')} problem={shown('acceptanceId')} hint={t('ctr.workspace.complete.acceptance.hint')}>
          {wireControl(
            <select id="workspace-completion-acceptance" value={form.acceptanceId} onChange={(event) => setForm({ ...form, acceptanceId: event.target.value })}>
              <option value="">{t('ctr.workspace.complete.acceptance.choose')}</option>
              {(summary.completion?.acceptances ?? []).map((minutes) => (
                <option key={minutes.id} value={minutes.id}>
                  {t('ctr.workspace.complete.acceptance.option', { recordNo: minutes.recordNo, day: minutes.approvedOn })}
                </option>
              ))}
            </select>,
            'workspace-completion-acceptance',
            { hint: false, error: shown('acceptanceId') !== undefined },
          )}
        </Field>
        <Field id="workspace-completed-on" label={t('ctr.workspace.complete.completedOn')} problem={shown('completedOn')}>
          {wireControl(
            <input id="workspace-completed-on" type="date" value={form.completedOn} onChange={(event) => setForm({ ...form, completedOn: event.target.value })} />,
            'workspace-completed-on',
            { hint: false, error: shown('completedOn') !== undefined },
          )}
        </Field>
      </div>
      <p className="sub">{t('ctr.workspace.complete.note')}</p>
    </Frame>
  );
}
