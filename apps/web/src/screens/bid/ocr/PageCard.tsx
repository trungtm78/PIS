import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { draftProblemMessage, problemMessage, statusLabel, textStateMessage } from './labels';
import { describeProblem, isEdited, isReviewable, percentOf, validateDraft } from './model';
import type { Decision, Draft, DraftProblem, OcrPage } from './model';
import './ocr.css';
import '../bid.css';

export interface PageCardProps {
  page: OcrPage;
  fileTitle: string;
  draft: Draft;
  /** The caller holds the right to review and the session is not read-only. */
  allowed: boolean;
  /** The review of this page is being sent: what was typed is what is sent, so the fields do not change meanwhile. */
  pending: boolean;
  /** The review of another page is being sent: one review goes at a time, so its answer and its refusal are never taken for another page's. */
  busy: boolean;
  /** The refusal of the last attempt on this page, when there was one. */
  refusal: unknown;
  onDraft(change: Partial<Draft>): void;
  onReview(decision: Decision): void;
}

/** The result of the review of a page: what was decided, when, and the words of the reviewer. */
function Outcome({ page }: { page: OcrPage }) {
  const { t, locale } = useTranslation();
  const when = page.reviewedAt === null ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(page.reviewedAt));
  if (page.status === 'AUTO_ACCEPTED') {
    return (
      <p className="sub" data-testid="accepted">
        {t('bid.ocr.accepted.text')}
      </p>
    );
  }
  return (
    <div data-testid="outcome">
      <p className="sub">{page.status === 'CORRECTED' ? t('bid.ocr.reviewed.corrected', { date: when }) : t('bid.ocr.reviewed.confirmed', { date: when })}</p>
      {page.status === 'CORRECTED' && page.correctedText !== null ? (
        <pre className="bid-ocr-text" tabIndex={0} data-testid="corrected-text">
          {page.correctedText}
        </pre>
      ) : null}
      {page.note === null ? null : (
        <p data-testid="review-note">
          <strong>{t('bid.ocr.note.label')}</strong> {page.note}
        </p>
      )}
    </div>
  );
}

/**
 * One page of a proposal, side by side (BID-06): what the engine recognised on the left, and on the right either the form of the reviewer (a page that waits for a person) or the outcome. What the
 * reviewer types lives in the draft the screen keeps, so a refusal, a refresh or a change of filter never loses it. The text is shown and never logged.
 */
export function PageCard({ page, fileTitle, draft, allowed, pending, busy, refusal, onDraft, onReview }: PageCardProps) {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<DraftProblem | undefined>(undefined);
  const edited = isEdited(page, draft);
  const readable = page.textState === 'READABLE';
  const number = page.pageIndex + 1;
  const textId = `ocr-text-${page.id}`;
  const noteId = `ocr-note-${page.id}`;
  const send = (decision: Decision): void => {
    const found = validateDraft(page, draft, decision);
    setProblem(found);
    if (found === undefined && !pending && !busy) onReview(decision);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    send(edited ? 'CORRECTED' : 'CONFIRMED');
  };
  return (
    <article className="card bid-ocr-page" data-page={page.id} data-status={page.status} aria-label={t('bid.ocr.page.aria', { page: number, file: fileTitle })}>
      <header className="bid-ocr-head">
        <h3>{t('bid.ocr.page.heading', { page: number, file: fileTitle })}</h3>
        <span className={page.status === 'NEEDS_REVIEW' ? 'bid-badge warning' : 'bid-badge ok'} data-testid="status">
          {statusLabel(t, page.status)}
        </span>
        <span data-testid="confidence">{t('bid.ocr.confidence.text', { value: percentOf(page.confidence) })}</span>
        {page.tableMismatch ? (
          <span className="bid-badge danger" data-testid="mismatch">
            {t('bid.ocr.mismatch.badge')}
          </span>
        ) : null}
      </header>
      <div className="bid-ocr-sides">
        <section aria-label={t('bid.ocr.engine.heading')}>
          <h4>{t('bid.ocr.engine.heading')}</h4>
          {page.textState === 'READABLE' ? (
            <pre className="bid-ocr-text" tabIndex={0} data-testid="engine-text">
              {page.text}
            </pre>
          ) : (
            <p className="callout warning" role="alert" data-testid="text-state">
              {textStateMessage(t, page.textState)}
            </p>
          )}
        </section>
        <section aria-label={t('bid.ocr.reviewer.heading')}>
          <h4>{t('bid.ocr.reviewer.heading')}</h4>
          {isReviewable(page, allowed) ? (
            <form onSubmit={submit} noValidate data-testid="review-form">
              {refusal === undefined ? null : (
                <p className="callout warning" role="alert" data-testid="refusal">
                  {problemMessage(t, describeProblem(refusal))}
                </p>
              )}
              <div className="field">
                <label htmlFor={textId}>{t('bid.ocr.reviewer.label', { page: number })}</label>
                <textarea id={textId} rows={10} readOnly={pending} value={draft.text} onChange={(event) => onDraft({ text: event.target.value })} />
                {problem === 'required' || problem === 'unchanged' || problem === 'tooLong' ? (
                  <small role="alert" className="field-error">
                    {draftProblemMessage(t, problem)}
                  </small>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor={noteId}>{t('bid.ocr.note.label')}</label>
                <input id={noteId} autoComplete="off" readOnly={pending} value={draft.note} onChange={(event) => onDraft({ note: event.target.value })} />
                <small className="sub">{t('bid.ocr.note.hint')}</small>
                {problem === 'noteTooLong' ? (
                  <small role="alert" className="field-error">
                    {draftProblemMessage(t, problem)}
                  </small>
                ) : null}
              </div>
              {readable ? null : (
                <small className="sub" data-testid="confirm-unreadable">
                  {t('bid.ocr.confirm.unreadable')}
                </small>
              )}
              {edited && readable ? (
                <small className="sub" data-testid="edited-hint">
                  {t('bid.ocr.edited.hint')}
                </small>
              ) : null}
              <div className="formfooter">
                <button type="button" disabled={pending || busy || edited || !readable} onClick={() => send('CONFIRMED')}>
                  {t('bid.ocr.confirm.action')}
                </button>
                <button type="submit" className="primary" disabled={pending || busy || !edited}>
                  {pending ? t('bid.ocr.pending.text') : t('bid.ocr.correct.action')}
                </button>
              </div>
            </form>
          ) : page.status === 'NEEDS_REVIEW' ? (
            <p className="sub" data-testid="waiting">
              {t('bid.ocr.waiting.text')}
            </p>
          ) : (
            <Outcome page={page} />
          )}
        </section>
      </div>
    </article>
  );
}
