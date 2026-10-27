import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useApiClient } from '../../api/ApiClientContext';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import '../dis/dis.css';
import { homeRoot } from './hooks';
import { BUCKETS, WORK_KINDS, inBucket, pathOf, toWorkPage } from './work-model';
import type { Bucket, WorkItem, WorkKind, WorkPage } from './work-model';

type T = Translator['t'];
const PAGE_SIZE = 50;

function kindLabel(t: T, kind: WorkKind): string {
  switch (kind) {
    case 'APPROVAL':
      return t('home.work.kind.approval');
    case 'EXPLANATION':
      return t('home.work.kind.explanation');
    case 'REPORT_RETURNED':
      return t('home.work.kind.reportReturned');
    case 'REPORT_DRAFT_OVERDUE':
      return t('home.work.kind.reportDraft');
    case 'EXPLANATION_REVIEW':
      return t('home.work.kind.explanationReview');
    case 'MNE_OBLIGATION':
      return t('home.work.kind.mne');
  }
}

function bucketLabel(t: T, bucket: Bucket): string {
  switch (bucket) {
    case 'OVERDUE':
      return t('home.work.bucket.overdue');
    case 'NEAR':
      return t('home.work.bucket.near');
    case 'LATER':
      return t('home.work.bucket.later');
  }
}

function useMyWork() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<WorkPage, Error, { pages: WorkPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...homeRoot(tenant?.id), 'work', tenant?.membershipId],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toWorkPage(await client.read('getMyWork', { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/**
 * HOME-02: my work (ST-HOME-004, HOME 3 F5): what is asked of the person who opens it, in every module, in one place: the approvals that wait for them, the explanations they owe and the ones they must conclude, the reports
 * of theirs that came back or are drafts past their period, and the monitoring reports of their unit near their day. Three columns, late first, near its day, and the rest, each card with the day it is due on (and the day
 * it was first asked for when that is another) and the way to open it. The counts at the top are of the whole list. Read-only: each task is done in the screen of its module.
 */
export default function MyWorkScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <MyWorkContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MyWorkContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const query = useMyWork();
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const counts = query.data?.pages[0]?.counts ?? {};
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data === undefined ? undefined : items });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.work.page.title')}</h1>
          <p>{t('home.work.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        <section className="card" aria-labelledby="work-summary-title" data-testid="work-summary">
          <h2 id="work-summary-title">{t('home.work.summary.title', { total: counts.total ?? items.length, overdue: counts.overdue ?? 0 })}</h2>
          {query.data?.pages[0]?.truncated === true ? (
            <p role="status" className="pill warn" data-testid="work-truncated">
              {t('home.work.truncated')}
            </p>
          ) : null}
          <ul className="mne-lines">
            {WORK_KINDS.filter((kind) => (counts[kind] ?? 0) > 0).map((kind) => (
              <li key={kind} data-kind={kind}>
                {kindLabel(t, kind)}: <strong>{counts[kind]}</strong>
              </li>
            ))}
          </ul>
        </section>
        <div className="dis-rate-pair" data-testid="work-board">
          {BUCKETS.map((bucket) => (
            <section key={bucket} className="card" aria-labelledby={`work-${bucket}-title`} data-bucket={bucket}>
              <h2 id={`work-${bucket}-title`}>
                {bucketLabel(t, bucket)} ({inBucket(items, bucket).length})
              </h2>
              <ul className="mne-lines">
                {inBucket(items, bucket).map((item) => (
                  <WorkCard key={`${item.kind}:${item.id}`} item={item} />
                ))}
              </ul>
            </section>
          ))}
        </div>
        {query.hasNextPage ? (
          <div className="mne-actions">
            <button type="button" className="btn" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {t('home.work.more')}
            </button>
          </div>
        ) : null}
      </StateBoundary>
    </section>
  );
}

function WorkCard({ item }: { item: WorkItem }) {
  const { t } = useTranslation();
  const path = pathOf(item);
  const changed = item.originalDueOn !== null && item.originalDueOn !== item.dueOn;
  return (
    <li data-item-id={item.id} data-kind={item.kind}>
      <span className="pill">{kindLabel(t, item.kind)}</span> <strong>{item.title}</strong>
      {item.subtitle === null ? null : <span className="sub"> {item.subtitle}</span>}
      <div className="sub" data-testid={`due-${item.id}`}>
        {item.dueOn === null ? t('home.work.due.none') : t('home.work.due.on', { date: item.dueOn })}
        {item.bucket === 'OVERDUE' ? `, ${t('home.work.due.late', { days: item.daysLate })}` : ''}
        {changed ? `, ${t('home.work.due.original', { date: item.originalDueOn ?? '' })}` : ''}
      </div>
      {path === undefined ? null : (
        <Link to={path} aria-label={t('home.work.open.aria', { title: item.title })}>
          {t('home.work.open')}
        </Link>
      )}
    </li>
  );
}
