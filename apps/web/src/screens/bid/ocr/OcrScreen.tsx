import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useTrackedPackages } from '../procurement/hooks';
import { useProposals } from '../proposal/hooks';
import { useOcrPages, useReviewPage } from './hooks';
import { statusLabel } from './labels';
import { NO_FILTER, OCR_STATUSES, biddingPackages, canRead, canReview, draftOf, hasFilter, statusFromParam, thresholdText, withDraft, withoutDraft } from './model';
import type { Decision, Draft, Drafts, OcrPage, PageFilter } from './model';
import { PageCard } from './PageCard';
import '../bid.css';

/**
 * BID-06: the OCR of the pages of a proposal (ST-BID-008, BID 3 F3, BR-BID-03/06). Each page the engine read is shown side by side with a place for the reviewer; a page below the confidence
 * threshold, or with a table whose total is not the sum of its lines, waits for a member of the evaluation team to confirm it as read or to correct it, and the financial analysis of the proposal does
 * not run while a page waits. The server decides who sees a proposal in full and so its pages; this screen offers the proposals that are open to the caller and says whether the analysis may go on.
 */
export default function OcrScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The packages, the proposals, the pages and the drafts belong to one membership: a switch of tenant or of membership starts the screen over.
  return <OcrContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OcrContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const packages = useTrackedPackages();
  const open = useMemo(() => biddingPackages(packages.data ?? []), [packages.data]);
  const wantedPackage = search.get('package') ?? '';
  const packageId = open.some((pack) => pack.id === wantedPackage) ? wantedPackage : '';
  const proposals = useProposals(packageId);
  // Only a proposal the caller has in full has pages for them; the others are not offered.
  const readable = useMemo(() => (proposals.data ?? []).filter((proposal) => proposal.access === 'FULL' && proposal.status === 'RECEIVED'), [proposals.data]);
  const wantedProposal = search.get('proposal') ?? '';
  const proposalId = readable.some((proposal) => proposal.id === wantedProposal) ? wantedProposal : '';
  const filter: PageFilter = { status: statusFromParam(search.get('status')), documentVersionId: search.get('file') ?? '' };
  const pages = useOcrPages(proposalId, filter);
  const review = useReviewPage();
  const [drafts, setDrafts] = useState<Drafts>({});
  const allowed = canReview(permissions, mode);

  const state = useScreenState({
    isLoading: packages.isLoading,
    error: packages.error,
    data: packages.data,
    isEmpty: (data) => biddingPackages(data as typeof open).length === 0,
  });
  // A proposal with no page recorded, or a filter that matches none, is not an empty screen: the filters stay where they are.
  const pagesState = useScreenState({ isLoading: pages.isLoading, error: pages.error, data: pages.data, isEmpty: () => false });
  const listings = pages.data?.pages ?? [];
  const first = listings[0];
  const list = listings.flatMap((listing) => listing.pages);
  const documents = first?.documents ?? [];
  // With no page recorded yet there is nothing the analysis could wait for, and nothing to say about it.
  const gate = first === undefined ? 'none' : !first.financialReady ? 'blocked' : list.length === 0 && !hasFilter(filter) ? 'none' : 'ready';
  const titleOf = (page: OcrPage): string => documents.find((document) => document.documentVersionId === page.documentVersionId)?.title ?? '';

  const choose = (change: Record<string, string>): void => {
    const next = new URLSearchParams(search);
    for (const [name, value] of Object.entries(change)) {
      if (value === '') next.delete(name);
      else next.set(name, value);
    }
    setSearch(next);
  };
  const chooseProposal = (id: string): void => {
    review.reset();
    choose({ proposal: id, status: '', file: '' });
  };
  const send = (page: OcrPage, draft: Draft, decision: Decision): void =>
    review.mutate({ pageId: page.id, decision, draft }, { onSuccess: () => setDrafts((current) => withoutDraft(current, page.id)) });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.ocr.page.title')}</h1>
          <p>{t('bid.ocr.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={canRead(permissions) ? state : 'denied'} onRetry={() => void packages.refetch()}>
        <div className="card">
          <div className="field">
            <label htmlFor="ocr-package">{t('bid.ocr.package.label')}</label>
            <select id="ocr-package" value={packageId} onChange={(event) => choose({ package: event.target.value, proposal: '', status: '', file: '' })}>
              <option value="">{t('bid.ocr.package.choose')}</option>
              {open.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title === null ? candidate.code : `${candidate.code} · ${candidate.title}`}
                </option>
              ))}
            </select>
          </div>
          {packageId === '' ? (
            <p className="sub" data-testid="choose-package">
              {t('bid.ocr.package.hint')}
            </p>
          ) : proposals.isLoading ? (
            <p role="status">{t('bid.ocr.loading.text')}</p>
          ) : proposals.isError ? (
            <p className="callout warning" role="alert" data-testid="proposals-error">
              {t('bid.ocr.proposals.error')}{' '}
              <button type="button" onClick={() => void proposals.refetch()}>
                {t('bid.ocr.retry.action')}
              </button>
            </p>
          ) : readable.length === 0 ? (
            <p className="callout" role="status" data-testid="no-proposals">
              {t('bid.ocr.proposals.none')}
            </p>
          ) : (
            <div className="field">
              <label htmlFor="ocr-proposal">{t('bid.ocr.proposal.label')}</label>
              <select id="ocr-proposal" value={proposalId} onChange={(event) => chooseProposal(event.target.value)}>
                <option value="">{t('bid.ocr.proposal.choose')}</option>
                {readable.map((proposal) => (
                  <option key={proposal.id} value={proposal.id}>
                    {t('bid.ocr.proposal.option', { name: proposal.contractorName, revision: proposal.revision })}
                  </option>
                ))}
              </select>
            </div>
          )}
          {proposalId === '' ? null : (
            <div className="bid-filters">
              <div className="field">
                <label htmlFor="ocr-status">{t('bid.ocr.filter.status.label')}</label>
                <select id="ocr-status" value={filter.status} onChange={(event) => choose({ status: event.target.value })}>
                  <option value="">{t('bid.ocr.filter.status.all')}</option>
                  {OCR_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(t, status)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ocr-file">{t('bid.ocr.filter.file.label')}</label>
                <select id="ocr-file" value={filter.documentVersionId} onChange={(event) => choose({ file: event.target.value })}>
                  <option value="">{t('bid.ocr.filter.file.all')}</option>
                  {documents.map((document) => (
                    <option key={document.documentVersionId} value={document.documentVersionId}>
                      {t('bid.ocr.filter.file.option', { title: document.title, pages: document.pageCount })}
                    </option>
                  ))}
                </select>
              </div>
              {hasFilter(filter) ? (
                <button type="button" onClick={() => choose({ status: NO_FILTER.status, file: NO_FILTER.documentVersionId })}>
                  {t('bid.ocr.filter.clear')}
                </button>
              ) : null}
            </div>
          )}
        </div>
        {proposalId === '' ? null : (
          <StateBoundary state={pagesState} onRetry={() => void pages.refetch()}>
            {gate === 'ready' ? (
              <p className="callout" role="status" data-testid="gate-ready">
                {t('bid.ocr.gate.ready')}
              </p>
            ) : null}
            {first !== undefined && gate === 'blocked' ? (
              <p className="callout warning" role="status" data-testid="gate-blocked">
                {t('bid.ocr.gate.blocked', { count: first.blockedPages, threshold: thresholdText(first.threshold) })}
              </p>
            ) : null}
            {list.length === 0 ? (
              <p className="callout" role="status" data-testid="no-pages">
                {hasFilter(filter) ? t('bid.ocr.none.filtered') : t('bid.ocr.none.notice')}
              </p>
            ) : (
              <div data-testid="pages">
                {list.map((page) => (
                  <PageCard
                    key={page.id}
                    page={page}
                    fileTitle={titleOf(page)}
                    draft={draftOf(page, drafts)}
                    allowed={allowed}
                    pending={review.isPending && review.variables?.pageId === page.id}
                    busy={review.isPending && review.variables?.pageId !== page.id}
                    refusal={review.isError && review.variables?.pageId === page.id ? review.error : undefined}
                    onDraft={(change) => setDrafts((current) => withDraft(current, page, change))}
                    onReview={(decision) => send(page, draftOf(page, drafts), decision)}
                  />
                ))}
              </div>
            )}
            {pages.hasNextPage ? (
              <div className="formfooter">
                <button type="button" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                  {t('bid.ocr.loadMore.action')}
                </button>
              </div>
            ) : null}
          </StateBoundary>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bid.ocr.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
