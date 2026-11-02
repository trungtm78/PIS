import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { FindingCard } from '../analysis/FindingCard';
import { classificationLabel, findingStatusLabel, runStatusLabel, runTone } from '../analysis/labels';
import { workbenchPath } from '../analysis/model';
import { useReviewFinding, useReviewFindings } from './hooks';
import { FINDING_STATUSES, FINDINGS_PERMISSION, NO_FINDING_FILTER, canReview, comparePath, draftOf, findingStatusFromParam, hasFindingFilter, holds, isReviewable, missingFromParam, readFailure, withDraft, withoutDraft } from './model';
import type { Drafts, FindingFilter, ReviewedFinding } from './model';
import { ReviewPanel } from './ReviewPanel';
import '../bid.css';

/**
 * BID-12: the verification of the findings of an analysis by the experts (ST-BID-010, BID 3 F6, BR-BID-03/09). Each finding is shown as the AI proposal it is, and apart from it what a person decided about it: the status
 * that stands, and the history of the decisions with who made each and why. A member of the evaluation team with the full view of the proposal, with no conflict standing, decides one finding at a time and always gives a
 * reason; nothing accepts a finding on its own and nothing accepts them all. The award is not decided here.
 */
export default function ReviewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The findings, what was typed and the decisions belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ReviewContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReviewContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const runId = search.get('run') ?? '';
  const allowed = holds(permissions, FINDINGS_PERMISSION);
  const filter: FindingFilter = { status: findingStatusFromParam(search.get('status')), missingSource: missingFromParam(search.get('missing')) };
  const read = useReviewFindings(runId, filter, allowed);
  const review = useReviewFinding();
  const [drafts, setDrafts] = useState<Drafts>({});
  const failure = readFailure(read.error);
  // A filter that matches no finding is not an empty screen: the filters stay where they are, outside the boundary.
  const state = useScreenState({
    isLoading: read.isLoading,
    error: failure === undefined ? read.error : undefined,
    data: read.data,
    isEmpty: (data) => (data as { pages: Array<{ findings: unknown[] }> }).pages.every((page) => page.findings.length === 0),
  });
  const pages = read.data?.pages ?? [];
  const run = pages[0]?.run;
  const findings = pages.flatMap((page) => page.findings);
  const reviewable = isReviewable(run);
  const mayReview = canReview(permissions, mode) && reviewable;
  const recordedOf = (finding: ReviewedFinding) => (review.isSuccess && review.data?.findingId === finding.id ? review.data : undefined);

  const choose = (change: Record<string, string>): void => {
    const next = new URLSearchParams(search);
    for (const [name, value] of Object.entries(change)) {
      if (value === '') next.delete(name);
      else next.set(name, value);
    }
    setSearch(next);
  };
  const send = (finding: ReviewedFinding): void =>
    review.mutate({ finding, draft: draftOf(finding, drafts) }, { onSuccess: () => setDrafts((current) => withoutDraft(current, finding.id)) });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.review.page.title')}</h1>
          <p>{t('bid.review.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={allowed ? 'default' : 'denied'}>
        <p className="callout" role="note" data-testid="ai-notice">
          {t('bid.review.page.aiNotice')}
        </p>
        {runId === '' ? (
          <p className="callout" role="status" data-testid="no-run">
            {t('bid.review.run.none')}
          </p>
        ) : failure !== undefined ? (
          <p className="callout warning" role="alert" data-testid={failure === 'notFound' ? 'run-not-found' : 'run-undeclared'}>
            {failure === 'notFound' ? t('bid.review.run.notFound') : t('bid.review.run.undeclared')}
          </p>
        ) : (
          <>
            {run === undefined ? null : (
              <div className="card" data-run={run.id} data-status={run.status}>
                <header className="heading">
                  <h2>{t('bid.review.run.heading', { package: run.packageCode, contractor: run.contractorName })}</h2>
                  <span className={`bid-badge ${runTone(run.status)}`} data-testid="run-status">
                    {runStatusLabel(t, run.status)}
                  </span>
                </header>
                <p className="sub" data-testid="run-facts">
                  {t('bid.review.run.facts', { classification: classificationLabel(t, run.dataClassification), count: run.findingCount, reviewed: run.reviewedCount })}
                </p>
                {reviewable ? null : (
                  <p className="callout warning" role="status" data-testid="run-not-reviewable">
                    {t('bid.review.run.notReviewable')}
                  </p>
                )}
                <p>
                  <Link to={workbenchPath(run.id)} data-testid="link-workbench">
                    {t('bid.review.link.workbench')}
                  </Link>
                  {' · '}
                  <Link to={comparePath(run.packageId, run.criteriaVersionId)} data-testid="link-compare">
                    {t('bid.review.link.compare')}
                  </Link>
                </p>
                <p className="sub" data-testid="award-notice">
                  {t('bid.review.page.awardNotice')}
                </p>
              </div>
            )}
            <div className="card bid-filters">
              <div className="field">
                <label htmlFor="review-finding-status">{t('bid.review.filter.status.label')}</label>
                <select id="review-finding-status" value={filter.status} onChange={(event) => choose({ status: event.target.value })}>
                  <option value="">{t('bid.review.filter.status.all')}</option>
                  {FINDING_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {findingStatusLabel(t, status)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="review-finding-missing">{t('bid.review.filter.missing.label')}</label>
                <select id="review-finding-missing" value={filter.missingSource} onChange={(event) => choose({ missing: event.target.value })}>
                  <option value="">{t('bid.review.filter.missing.all')}</option>
                  <option value="true">{t('bid.review.filter.missing.only')}</option>
                  <option value="false">{t('bid.review.filter.missing.without')}</option>
                </select>
              </div>
              {hasFindingFilter(filter) ? (
                <button type="button" onClick={() => choose({ status: NO_FINDING_FILTER.status, missing: NO_FINDING_FILTER.missingSource })}>
                  {t('bid.review.filter.clear')}
                </button>
              ) : null}
            </div>
            <StateBoundary state={state} onRetry={() => void read.refetch()}>
              <div data-testid="findings">
                {findings.map((finding) => (
                  <div key={finding.id} data-block={finding.id}>
                    <FindingCard finding={finding} />
                    <ReviewPanel
                      finding={finding}
                      draft={draftOf(finding, drafts)}
                      allowed={mayReview}
                      pending={review.isPending && review.variables?.finding.id === finding.id}
                      busy={review.isPending && review.variables?.finding.id !== finding.id}
                      refusal={review.isError && review.variables?.finding.id === finding.id ? review.error : undefined}
                      recorded={recordedOf(finding)}
                      onDraft={(change) => setDrafts((current) => withDraft(current, finding.id, change))}
                      onReview={() => send(finding)}
                    />
                  </div>
                ))}
              </div>
              {read.hasNextPage ? (
                <div className="formfooter">
                  <button type="button" disabled={read.isFetchingNextPage} onClick={() => void read.fetchNextPage()}>
                    {t('bid.review.loadMore.action')}
                  </button>
                </div>
              ) : null}
            </StateBoundary>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bid.review.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
