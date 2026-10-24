import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import { attemptsOf, useAttemptPages, useReplayNotification } from './delivery/hooks';
import { channelLabel, failureClassLabel, problemMessage, statusLabel, statusPill } from './delivery/labels';
import { journeyPathOf } from './delivery/paths';
import { MAX_ATTEMPTS, READ_PERMISSION, REPLAY_PERMISSION, describeProblem, mayReplay, risksDoubleSend } from './delivery/model';
import type { AttemptView } from './delivery/model';
import { ReasonPanel } from './delivery/ReasonPanel';
import './delivery/delivery.css';

const DEAD_LETTER = { deadLetter: true } as const;

/**
 * NOT-13: the failed queue. The notifications that no channel could deliver, with the last send of each channel: the error code, whether the failure can be
 * retried, how many of the five sends were used, when the next one is due, and, for a send whose result was lost, that it must be reconciled before a replay
 * (BR-NOT-04). An Unknown send whose day of reconciliation is over can be replayed, and the screen says that the message may then be sent twice.
 */
export default function FailedQueueScreen({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const canReplay = (permissions === undefined || permissions.includes(REPLAY_PERMISSION)) && mode !== 'READ_ONLY';
  const pages = useAttemptPages(DEAD_LETTER, canRead);
  const replay = useReplayNotification();
  const [target, setTarget] = useState<AttemptView | undefined>(undefined);
  const items = useMemo(() => attemptsOf(pages.data), [pages.data]);
  const queryState = useScreenState({ isLoading: pages.isLoading, error: items === undefined ? pages.error : undefined, data: items });
  const state = canRead ? queryState : 'denied';

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-failed">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.failed.page.title')}</h1>
          <p>{t('not.failed.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <StateBoundary state={state} onRetry={() => void pages.refetch()}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('not.failed.col.notification')}</th>
                  <th>{t('not.failed.col.channel')}</th>
                  <th>{t('not.failed.col.status')}</th>
                  <th>{t('not.failed.col.error')}</th>
                  <th>{t('not.failed.col.retryable')}</th>
                  <th>{t('not.failed.col.attempts')}</th>
                  <th>{t('not.failed.col.next')}</th>
                  <th>{t('not.failed.col.reconcile')}</th>
                  <th>
                    <span className="sr-only">{t('not.failed.col.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(items ?? []).map((attempt) => (
                  <tr key={attempt.id} data-attempt-id={attempt.id} data-status={attempt.status}>
                    <td>
                      <Link to={journeyPathOf(attempt.id)}>
                        <code>{attempt.notificationId.slice(0, 8)}</code>
                      </Link>
                    </td>
                    <td>{channelLabel(t, attempt.channel)}</td>
                    <td>
                      <span className={statusPill(attempt.status)}>{statusLabel(t, attempt.status)}</span>
                    </td>
                    <td>{attempt.errorCode ?? ''}</td>
                    <td>{failureClassLabel(t, attempt.failureClass)}</td>
                    <td>{t('not.queue.row.attempt.text', { no: attempt.attemptNo, max: MAX_ATTEMPTS })}</td>
                    <td>{attempt.nextRetryAt === null ? t('not.failed.row.next.none') : instantText(locale, attempt.nextRetryAt)}</td>
                    <td>
                      {attempt.needsReconcile ? (
                        <span className="pill warn" data-testid="needs-reconcile">
                          {t('not.failed.row.reconcile.until', { time: instantText(locale, attempt.reconcileDueAt) })}
                        </span>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="row-actions">
                      {canReplay && mayReplay(attempt) ? (
                        <button type="button" onClick={() => (replay.reset(), setTarget(attempt))}>
                          {t('not.failed.replay.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="inbox-list-footer">
            <span>{t('not.failed.footer.count', { count: (items ?? []).length })}</span>
            {pages.isFetchNextPageError ? (
              <span className="callout warning" role="alert">
                {t('not.failed.footer.pageError')}
              </span>
            ) : null}
            {pages.hasNextPage ? (
              <button type="button" className="inbox-more" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                {t('not.failed.footer.more.action')}
              </button>
            ) : null}
          </footer>
        </StateBoundary>
        {target === undefined ? null : (
          <ReasonPanel
            key={target.id}
            testId="replay-panel"
            title={t('not.failed.replay.title')}
            hint={t('not.failed.replay.hint')}
            risk={risksDoubleSend(target) ? t('not.failed.replay.risk') : undefined}
            reasonLabel={t('not.failed.replay.reason.label')}
            reasonError={t('not.failed.replay.reason.error')}
            confirmLabel={t('not.failed.replay.confirm.action')}
            dismissLabel={t('not.failed.replay.dismiss.action')}
            pending={replay.isPending}
            problem={replay.isError ? problemMessage(t, describeProblem(replay.error)) : undefined}
            onConfirm={(reason) => replay.mutate({ notificationId: target.notificationId, version: target.notificationVersion, reason }, { onSuccess: () => setTarget(undefined) })}
            onDismiss={() => setTarget(undefined)}
          />
        )}
      </div>
      <p className="prototype-note">{t('not.failed.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
