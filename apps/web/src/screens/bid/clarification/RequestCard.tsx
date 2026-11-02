import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { useMoment } from '../analysis/hooks';
import { formProblemMessage, problemMessage, statusLabel, statusTone } from './labels';
import { describeProblem, statusAt, validateAnswer } from './model';
import type { Clarification } from './model';
import '../analysis/analysis.css';
import './clarification.css';
import '../bid.css';

export interface RequestCardProps {
  line: Clarification;
  now: Date;
  /** The caller is offered the answer: the request waits, its time is not up, the right is held and the session is not read-only. */
  answerable: boolean;
  /** The document typed for this request. */
  document: string;
  /** The answer to this request is being sent: what was typed is what is sent, so the field does not change meanwhile. */
  pending: boolean;
  /** The answer to another request is being sent: one answer goes at a time, so its refusal is never taken for another request's. */
  busy: boolean;
  /** The refusal of the last attempt on this request, when there was one. */
  refusal: unknown;
  onDocument(value: string): void;
  onAnswer(): void;
}

/**
 * One request of BID-11 as a short conversation: the question with what it rests on, who it is for and by when, and the answer that came, or the form that records it. A contractor sees what asks them and not who
 * on the evaluation team asked or which finding it rests on (the server sends neither).
 */
export function RequestCard({ line, now, answerable, document: typed, pending, busy, refusal, onDocument, onAnswer }: RequestCardProps) {
  const { t } = useTranslation();
  const moment = useMoment();
  const fieldId = useId();
  const [submitted, setSubmitted] = useState(false);
  const status = statusAt(line, now);
  const problem = validateAnswer(typed);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (pending || busy || problem !== undefined) return;
    onAnswer();
  };
  return (
    <article className="card bid-clarification" data-request={line.id} data-status={status} aria-label={t('bid.clarifications.request.aria', { contractor: line.contractor.legalName })}>
      <header className="bid-clarification-head">
        <strong data-testid="contractor">{line.contractor.legalName}</strong>
        <span className={`bid-badge ${statusTone(status)}`} data-testid="status">
          {statusLabel(t, status)}
        </span>
      </header>
      <p className="sub" data-testid="due">
        {t('bid.clarifications.due.text', { due: moment(line.dueAt) })}
        {status === 'EXPIRED' ? (
          <span className="bid-badge danger" data-testid="expired">
            {t('bid.clarifications.due.expired')}
          </span>
        ) : null}
      </p>
      <blockquote className="bid-quote" data-testid="question">
        {line.question}
      </blockquote>
      <p className="sub" data-testid="basis">
        {line.basis === null ? t('bid.clarifications.basis.none') : t('bid.clarifications.basis.criterion', { criterion: line.basis.criterionCode })}
      </p>
      {line.askedBy === null ? null : (
        <p className="sub" data-testid="asked-by">
          {t('bid.clarifications.askedBy.text', { name: line.askedBy.displayName, at: moment(line.createdAt) })}
        </p>
      )}
      {line.answerDocumentId === null ? (
        <p className="sub" data-testid="no-answer">
          {t('bid.clarifications.answer.none')}
        </p>
      ) : (
        <div data-testid="answer">
          <p>
            {t('bid.clarifications.answer.document')} <code data-testid="answer-document">{line.answerDocumentId}</code>
          </p>
          <p className="sub" data-testid="answered-by">
            {line.answeredAsGuest === true
              ? t('bid.clarifications.answer.byContractor', { at: moment(line.answeredAt) })
              : t('bid.clarifications.answer.byStaff', { name: line.answeredBy?.displayName ?? '', at: moment(line.answeredAt) })}
          </p>
        </div>
      )}
      {/* A refusal can be the very reason the form is gone (the time is up, another caller answered), so it is not part of the form. */}
      {refusal === undefined || refusal === null ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(refusal))}
        </p>
      )}
      {!answerable ? null : (
        <form onSubmit={submit} noValidate data-testid="answer-form">
          <div className="field">
            <label htmlFor={fieldId}>{t('bid.clarifications.answer.label', { contractor: line.contractor.legalName })}</label>
            <input id={fieldId} autoComplete="off" readOnly={pending} disabled={busy} value={typed} onChange={(event) => onDocument(event.target.value)} />
            <small className="sub">{t('bid.clarifications.answer.hint')}</small>
            {submitted && problem !== undefined ? (
              <small role="alert" className="field-error">
                {formProblemMessage(t, problem)}
              </small>
            ) : null}
          </div>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={pending || busy}>
              {pending ? t('bid.clarifications.answer.pending') : t('bid.clarifications.answer.submit')}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
