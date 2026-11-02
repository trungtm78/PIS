import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { useMoment } from '../analysis/hooks';
import { findingStatusLabel } from '../analysis/labels';
import { decisionLabel, draftProblemMessage, problemMessage } from './labels';
import { FINDING_STATUSES, MIN_REVIEW_REASON, describeProblem, isDecided, validateDraft } from './model';
import type { Draft, DraftProblem, Recorded, Review, ReviewedFinding } from './model';
import './review.css';
import '../bid.css';

export interface ReviewPanelProps {
  finding: ReviewedFinding;
  draft: Draft;
  /** The caller holds the right to review, the session is not read-only and the run waits for the experts or has them all decided. */
  allowed: boolean;
  /** The review of this finding is being sent: what was typed is what is sent, so the fields do not change meanwhile. */
  pending: boolean;
  /** The review of another finding is being sent: one review goes at a time, so its answer and its refusal are never taken for another finding's. */
  busy: boolean;
  /** The refusal of the last attempt on this finding, when there was one. */
  refusal: unknown;
  /** The decision that was recorded for this finding by the last attempt, when it was. */
  recorded: Recorded | undefined;
  onDraft(change: Partial<Draft>): void;
  onReview(): void;
}

/** One decision of the history of a finding: who decided, from what to what, with which score and why. The record of the decision of a person about the answer of the AI is named by its identity. */
function HistoryEntry({ review }: { review: Review }) {
  const { t } = useTranslation();
  const moment = useMoment();
  return (
    <li className="bid-review-entry" data-review-entry={review.id} data-decision={review.decision}>
      <p className="bid-review-entry-head">
        <strong data-testid="reviewer">{review.reviewerName ?? t('bid.review.history.unknownReviewer')}</strong>
        <span data-testid="decided-at">{moment(review.decidedAt)}</span>
        <span className="bid-badge" data-testid="entry-decision">
          {decisionLabel(t, review.decision)}
        </span>
      </p>
      <p data-testid="entry-change">{t('bid.review.history.change', { from: findingStatusLabel(t, review.fromStatus), to: findingStatusLabel(t, review.toStatus) })}</p>
      {review.scoreAfter === null && review.scoreBefore === null ? null : (
        <p data-testid="entry-score">{t('bid.review.history.score', { before: review.scoreBefore ?? t('bid.review.history.noScore'), after: review.scoreAfter ?? t('bid.review.history.noScore') })}</p>
      )}
      <blockquote className="bid-quote" data-testid="entry-reason">
        {review.reason}
      </blockquote>
      <small className="sub" data-testid="entry-record">
        {t('bid.review.history.record', { id: review.aiDecisionRecordId.slice(0, 8) })}
      </small>
    </li>
  );
}

/**
 * What a person decided about a finding of the AI (BID-12), apart from what the model said: the status that stands now, the history of the decisions, and the form of the expert. A change needs a reason of at
 * least 20 characters; nothing here accepts a finding without that reason and nothing accepts them together.
 */
export function ReviewPanel({ finding, draft, allowed, pending, busy, refusal, recorded, onDraft, onReview }: ReviewPanelProps) {
  const { t } = useTranslation();
  const moment = useMoment();
  const [problem, setProblem] = useState<DraftProblem | undefined>(undefined);
  const statusId = `review-status-${finding.id}`;
  const scoreId = `review-score-${finding.id}`;
  const reasonId = `review-reason-${finding.id}`;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateDraft(draft);
    setProblem(found);
    if (found === undefined && !pending && !busy) onReview();
  };
  const reasonProblem = problem === 'reasonTooShort' || problem === 'reasonTooLong';
  return (
    <section className="card bid-review" data-review={finding.id} data-decided={isDecided(finding) ? 'true' : 'false'} aria-label={t('bid.review.panel.aria', { criterion: finding.criterionId })}>
      <h4>{t('bid.review.panel.heading')}</h4>
      {isDecided(finding) && finding.finalStatus !== null ? (
        <p data-testid="standing">
          <span className="bid-badge ok" data-testid="final-status">
            {findingStatusLabel(t, finding.finalStatus)}
          </span>{' '}
          {finding.finalScore === null ? null : <span data-testid="final-score">{t('bid.review.standing.score', { score: finding.finalScore })} </span>}
          <small className="sub" data-testid="reviewed-at">
            {t('bid.review.standing.at', { date: moment(finding.reviewedAt) })}
          </small>
        </p>
      ) : (
        <p className="sub" data-testid="undecided">
          {t('bid.review.standing.none')}
        </p>
      )}
      {finding.reviews.length === 0 ? null : (
        <ol className="bid-review-history" aria-label={t('bid.review.history.aria', { criterion: finding.criterionId })} data-testid="history">
          {finding.reviews.map((review) => (
            <HistoryEntry key={review.id} review={review} />
          ))}
        </ol>
      )}
      {recorded === undefined ? null : (
        <p className="callout" role="status" data-testid="recorded">
          {t('bid.review.recorded.text', { decision: decisionLabel(t, recorded.decision), record: recorded.aiDecisionRecordId.slice(0, 8) })}
        </p>
      )}
      {!allowed ? null : (
        <form onSubmit={submit} noValidate data-testid="review-form">
          {refusal === undefined || refusal === null ? null : (
            <p className="callout warning" role="alert" data-testid="refusal">
              {problemMessage(t, describeProblem(refusal))}
            </p>
          )}
          <div className="bid-review-fields">
            <div className="field">
              <label htmlFor={statusId}>{t('bid.review.status.label', { criterion: finding.criterionId })}</label>
              <select id={statusId} value={draft.status} disabled={pending || busy} onChange={(event) => onDraft({ status: FINDING_STATUSES.find((status) => status === event.target.value) ?? draft.status })}>
                {FINDING_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {findingStatusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={scoreId}>{t('bid.review.score.label', { criterion: finding.criterionId })}</label>
              <input id={scoreId} inputMode="decimal" autoComplete="off" readOnly={pending} disabled={busy} value={draft.score} onChange={(event) => onDraft({ score: event.target.value })} />
              <small className="sub">{t('bid.review.score.hint')}</small>
              {problem === 'scoreInvalid' ? (
                <small role="alert" className="field-error">
                  {draftProblemMessage(t, problem)}
                </small>
              ) : null}
            </div>
          </div>
          <div className="field">
            <label htmlFor={reasonId}>{t('bid.review.reason.label', { criterion: finding.criterionId })}</label>
            <textarea id={reasonId} rows={3} readOnly={pending} disabled={busy} value={draft.reason} onChange={(event) => onDraft({ reason: event.target.value })} />
            <small className="sub" data-testid="reason-count">
              {t('bid.review.reason.count', { count: draft.reason.trim().length, min: MIN_REVIEW_REASON })}
            </small>
            {reasonProblem && problem !== undefined ? (
              <small role="alert" className="field-error">
                {draftProblemMessage(t, problem)}
              </small>
            ) : null}
          </div>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={pending || busy}>
              {pending ? t('bid.review.submit.pending') : t('bid.review.submit.action')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
