import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { LockDialog, SignDialog } from './DiaryDialogs';
import { DiaryContent, DiaryTitle, LegalNote, SignatureChain } from './DiaryParts';
import { useDiaries, useDiary } from './hooks';
import { statusLabel } from './labels';
import { NO_FILTER, canAct, catalogueLink, composeLink, reviewLink } from './model';
import type { DiaryLine } from './model';
import '../qms.css';

/**
 * QMS-03: the remark of the supervisor and the confirmation of the owner (ST-QMS-001, QMS 3.1, BR-QMS-01, BR-QMS-03). The supervisor remarks on a diary the contractor signed; the owner confirms what the
 * supervisor remarked on; either may then lock it. Each signs as the role the server finds them in standing to sign as, and an in-app signature is shown as an internal record, never as a digital one.
 * Without a diary named, the screen lists the diaries that wait for someone.
 */
export default function DiaryReviewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The diary and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ReviewContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'supervise' } | { kind: 'owner' } | { kind: 'lock' };

function ReviewContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [search] = useSearchParams();
  const wanted = search.get('diary') ?? undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.diary.review.title')}</h1>
          <p>{t('qms.diary.review.subtitle')}</p>
        </div>
        <div className="actions">
          <Link className="button" to={catalogueLink()}>
            {t('qms.diary.back.action')}
          </Link>
        </div>
      </div>
      {wanted === undefined ? <Queue /> : <Review key={wanted} id={wanted} />}
      <p className="prototype-note">{t('qms.diary.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

const waits = (line: DiaryLine): boolean => line.actions.supervise || line.actions.ownerConfirm || line.actions.lock;

/** The diaries that wait for the caller: the ones the contractor signed, the ones the supervisor remarked on and the ones the owner confirmed. */
function Queue() {
  const { t } = useTranslation();
  const signed = useDiaries({ ...NO_FILTER, status: 'CONTRACTOR_SIGNED' });
  const supervised = useDiaries({ ...NO_FILTER, status: 'SUPERVISED' });
  const confirmed = useDiaries({ ...NO_FILTER, status: 'OWNER_CONFIRMED' });
  const queries = [signed, supervised, confirmed];
  const lines = queries
    .flatMap((query) => (query.data?.pages ?? []).flatMap((page) => page.lines))
    .filter(waits)
    .sort((left, right) => left.recordDate.localeCompare(right.recordDate) || left.diaryNo.localeCompare(right.diaryNo));
  const failed = queries.find((query) => query.error !== null && query.error !== undefined);
  const state = useScreenState({
    isLoading: queries.some((query) => query.isLoading),
    error: failed?.error ?? undefined,
    data: queries.every((query) => query.data !== undefined) ? lines : undefined,
    // Pages that remain may hold what waits for the caller: the button to read them is not hidden with an empty state.
    isEmpty: () => lines.length === 0 && queries.every((query) => !query.hasNextPage),
  });
  const more = queries.find((query) => query.hasNextPage);
  return (
    <StateBoundary
      state={state}
      onRetry={() => {
        for (const query of queries) void query.refetch();
      }}
    >
      <div className="card">
        <h2>{t('qms.diary.queue.title')}</h2>
        {lines.length === 0 ? (
          <p className="callout" role="status" data-testid="queue-empty">
            {t('qms.diary.queue.none')}
          </p>
        ) : null}
        <ul className="qms-actions" data-testid="queue">
          {lines.map((line) => (
            <li key={line.id} data-diary={line.id} data-status={line.status}>
              <Link to={reviewLink(line.id)}>
                {line.diaryNo} · {line.contract.code} · {line.recordDate}
              </Link>{' '}
              <span className="qms-badge">{statusLabel(t, line.status)}</span>
            </li>
          ))}
        </ul>
        {more === undefined ? null : (
          <button type="button" disabled={more.isFetchingNextPage} onClick={() => void more.fetchNextPage()}>
            {t('qms.diary.more.action')}
          </button>
        )}
      </div>
    </StateBoundary>
  );
}

function Review({ id }: { id: string }) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const diary = useDiary(id);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: diary.isLoading, error: diary.error, data: diary.data, isEmpty: (data) => data === null });
  const line = diary.data ?? undefined;
  const writable = canAct(mode);
  return (
    <>
      <StateBoundary state={state} onRetry={() => void diary.refetch()}>
        {line === undefined ? (
          <p className="callout warning" role="alert" data-testid="diary-missing">
            {t('qms.diary.error.notFound')}
          </p>
        ) : (
          <div className="card">
            <DiaryTitle line={line} />
            <LegalNote line={line} />
            <DiaryContent line={line} />
            <h2>{t('qms.diary.signatures.title')}</h2>
            <SignatureChain line={line} />
            {writable ? (
              <div className="actions">
                {line.actions.supervise ? (
                  <button type="button" className="primary" data-action="supervise" onClick={() => setDialog({ kind: 'supervise' })}>
                    {t('qms.diary.sign.supervisor.action')}
                  </button>
                ) : null}
                {line.actions.ownerConfirm ? (
                  <button type="button" className="primary" data-action="owner" onClick={() => setDialog({ kind: 'owner' })}>
                    {t('qms.diary.sign.owner.action')}
                  </button>
                ) : null}
                {line.actions.lock ? (
                  <button type="button" data-action="lock" onClick={() => setDialog({ kind: 'lock' })}>
                    {t('qms.diary.lock.action')}
                  </button>
                ) : null}
              </div>
            ) : null}
            <Link className="button" to={composeLink(line.id)} data-testid="to-compose">
              {t('qms.diary.open.action')}
            </Link>
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'supervise' && line !== undefined ? <SignDialog line={line} kind="supervisor" onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'owner' && line !== undefined ? <SignDialog line={line} kind="owner" onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'lock' && line !== undefined ? <LockDialog line={line} onClose={() => setDialog(undefined)} /> : null}
    </>
  );
}
