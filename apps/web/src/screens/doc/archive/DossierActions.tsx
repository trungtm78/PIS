import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { useDecide, useHandover, usePropose } from './hooks';
import { fieldMessage, problemMessage } from './labels';
import { EMPTY_DECISION, EMPTY_HANDOVER, decisionBody, decisionHasProblems, describeProblem, handoverBody, handoverHasProblems, proposalBody, validateDecision, validateHandover, validateProposal } from './rules';
import type { DecisionForm, HandoverForm } from './rules';
import type { Dossier } from './types';

interface ActionProps {
  dossier: Dossier;
  onClose: () => void;
}

function Refusal({ error }: { error: unknown }) {
  const { t } = useTranslation();
  return (
    <p className="callout warning" role="alert" data-testid="refusal">
      {problemMessage(t, describeProblem(error))}
    </p>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  return message === undefined ? null : <small role="alert">{message}</small>;
}

/** Hands a closed dossier over to the archive of the agency: the reference the archive gave and the moment of the handover. */
export function HandoverAction({ dossier, onClose }: ActionProps) {
  const { t } = useTranslation();
  const handover = useHandover();
  const [form, setForm] = useState<HandoverForm>(EMPTY_HANDOVER);
  const [attempted, setAttempted] = useState(false);
  const problems = attempted ? validateHandover(form) : {};
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (handover.isPending || handoverHasProblems(validateHandover(form))) return;
    handover.mutate({ id: dossier.id, version: dossier.version, body: handoverBody(form) }, { onSuccess: onClose });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('doc.archive.handover.title', { code: dossier.dossierCode })} data-testid="handover-form">
      <h2>{t('doc.archive.handover.title', { code: dossier.dossierCode })}</h2>
      <p className="sub">{t('doc.archive.handover.help')}</p>
      {handover.isError ? <Refusal error={handover.error} /> : null}
      <div className="field">
        <label htmlFor="handover-ref">{t('doc.archive.handover.ref.label')}</label>
        <input id="handover-ref" value={form.archiveRef} aria-invalid={problems.archiveRef !== undefined} onChange={(event) => setForm({ ...form, archiveRef: event.target.value })} />
        <FieldError message={fieldMessage(t, problems.archiveRef)} />
      </div>
      <div className="field">
        <label htmlFor="handover-at">{t('doc.archive.handover.at.label')}</label>
        <input id="handover-at" type="datetime-local" value={form.handedOverAt} aria-invalid={problems.handedOverAt !== undefined} onChange={(event) => setForm({ ...form, handedOverAt: event.target.value })} />
        <FieldError message={fieldMessage(t, problems.handedOverAt)} />
      </div>
      <div className="formfooter">
        <button type="button" onClick={onClose}>
          {t('doc.archive.action.cancel')}
        </button>
        <button type="submit" className="primary" disabled={handover.isPending}>
          {t('doc.archive.handover.submit')}
        </button>
      </div>
    </form>
  );
}

/** Proposes the disposal of a dossier whose retention is over: the reason, for the council that decides it. */
export function ProposeAction({ dossier, onClose }: ActionProps) {
  const { t } = useTranslation();
  const propose = usePropose();
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const problems = attempted ? validateProposal(reason) : {};
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (propose.isPending || validateProposal(reason).reason !== undefined) return;
    propose.mutate({ id: dossier.id, version: dossier.version, body: proposalBody(reason) }, { onSuccess: onClose });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('doc.archive.propose.title', { code: dossier.dossierCode })} data-testid="propose-form">
      <h2>{t('doc.archive.propose.title', { code: dossier.dossierCode })}</h2>
      <p className="sub">{t('doc.archive.propose.help')}</p>
      {propose.isError ? <Refusal error={propose.error} /> : null}
      <div className="field">
        <label htmlFor="propose-reason">{t('doc.archive.propose.reason.label')}</label>
        <textarea id="propose-reason" rows={3} value={reason} aria-invalid={problems.reason !== undefined} onChange={(event) => setReason(event.target.value)} />
        <FieldError message={fieldMessage(t, problems.reason)} />
      </div>
      <div className="formfooter">
        <button type="button" onClick={onClose}>
          {t('doc.archive.action.cancel')}
        </button>
        <button type="submit" className="primary" disabled={propose.isPending}>
          {t('doc.archive.propose.submit')}
        </button>
      </div>
    </form>
  );
}

/** The decision of the council on a proposal: an approval names the document of the decision, a rejection sends the dossier back. */
export function DecideAction({ dossier, onClose }: ActionProps) {
  const { t } = useTranslation();
  const decide = useDecide();
  const [form, setForm] = useState<DecisionForm>(EMPTY_DECISION);
  const [attempted, setAttempted] = useState(false);
  const problems = attempted ? validateDecision(form) : {};
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (decide.isPending || decisionHasProblems(validateDecision(form))) return;
    decide.mutate({ id: dossier.id, version: dossier.version, body: decisionBody(form) }, { onSuccess: onClose });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('doc.archive.decide.title', { code: dossier.dossierCode })} data-testid="decide-form">
      <h2>{t('doc.archive.decide.title', { code: dossier.dossierCode })}</h2>
      <p className="sub">{t('doc.archive.decide.help')}</p>
      {dossier.disposal === null ? null : (
        <p data-testid="proposal-reason">{t('doc.archive.decide.proposal', { reason: dossier.disposal.reason })}</p>
      )}
      {decide.isError ? <Refusal error={decide.error} /> : null}
      <fieldset>
        <legend>{t('doc.archive.decide.decision.label')}</legend>
        <label>
          <input type="radio" name="decision" checked={form.decision === 'APPROVE'} onChange={() => setForm({ ...form, decision: 'APPROVE' })} />
          {t('doc.archive.decide.approve')}
        </label>
        <label>
          <input type="radio" name="decision" checked={form.decision === 'REJECT'} onChange={() => setForm({ ...form, decision: 'REJECT' })} />
          {t('doc.archive.decide.reject')}
        </label>
      </fieldset>
      {form.decision === 'APPROVE' ? (
        <div className="field">
          <label htmlFor="decide-document">{t('doc.archive.decide.document.label')}</label>
          <input id="decide-document" value={form.councilDecisionDocumentId} aria-invalid={problems.councilDecisionDocumentId !== undefined} onChange={(event) => setForm({ ...form, councilDecisionDocumentId: event.target.value })} />
          <small>{t('doc.archive.decide.document.hint')}</small>
          <FieldError message={fieldMessage(t, problems.councilDecisionDocumentId)} />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="decide-comment">{t('doc.archive.decide.comment.label')}</label>
        <textarea id="decide-comment" rows={2} value={form.comment} aria-invalid={problems.comment !== undefined} onChange={(event) => setForm({ ...form, comment: event.target.value })} />
        <FieldError message={fieldMessage(t, problems.comment)} />
      </div>
      <div className="formfooter">
        <button type="button" onClick={onClose}>
          {t('doc.archive.action.cancel')}
        </button>
        <button type="submit" className="primary" disabled={decide.isPending}>
          {t('doc.archive.decide.submit')}
        </button>
      </div>
    </form>
  );
}
