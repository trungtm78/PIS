import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import { journeyPathOf } from './delivery/paths';
import { attemptsOf, useAttemptPages, useCancelNotification } from './delivery/hooks';
import { channelLabel, problemMessage, statusLabel, statusPill } from './delivery/labels';
import { ATTEMPT_STATUSES, MAX_ATTEMPTS, OPERATE_PERMISSION, READ_PERMISSION, describeProblem, mayCancel } from './delivery/model';
import type { AttemptStatus, AttemptView } from './delivery/model';
import { ReasonPanel } from './delivery/ReasonPanel';
import './delivery/delivery.css';

/**
 * NOT-11: the queue of sends. Every attempt of the tenant, newest first, with its channel, its status, the number of the send out of five, the channel that
 * takes over when this one is exhausted and when the message expires. The operator can cancel a send that has not gone out, with a reason; the journey of an
 * attempt opens on NOT-12.
 */
export default function QueueScreen({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const canOperate = (permissions === undefined || permissions.includes(OPERATE_PERMISSION)) && mode !== 'READ_ONLY';
  const [status, setStatus] = useState<'' | AttemptStatus>('');
  const pages = useAttemptPages(status === '' ? {} : { statuses: [status] }, canRead);
  const cancel = useCancelNotification();
  const [target, setTarget] = useState<AttemptView | undefined>(undefined);
  const items = useMemo(() => attemptsOf(pages.data), [pages.data]);
  const queryState = useScreenState({ isLoading: pages.isLoading, error: items === undefined ? pages.error : undefined, data: items });
  // Without delivery_attempt.read nothing is requested and the screen is denied, not empty.
  const state = canRead ? queryState : 'denied';

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.queue.page.title')}</h1>
          <p>{t('not.queue.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <p className="sub">{t('not.queue.rule.text', { max: MAX_ATTEMPTS })}</p>
        <div className="filters">
          <div>
            <label htmlFor="queue-status">{t('not.queue.filter.status.label')}</label>
            <select id="queue-status" value={status} onChange={(event) => setStatus(event.target.value as '' | AttemptStatus)}>
              <option value="">{t('not.queue.filter.status.all')}</option>
              {ATTEMPT_STATUSES.map((name) => (
                <option key={name} value={name}>
                  {statusLabel(t, name)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <StateBoundary state={state} onRetry={() => void pages.refetch()}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('not.queue.col.notification')}</th>
                  <th>{t('not.queue.col.channel')}</th>
                  <th>{t('not.queue.col.status')}</th>
                  <th>{t('not.queue.col.attempt')}</th>
                  <th>{t('not.queue.col.fallback')}</th>
                  <th>{t('not.queue.col.expires')}</th>
                  <th>
                    <span className="sr-only">{t('not.queue.col.actions')}</span>
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
                      {attempt.nextRetryAt === null ? null : <div className="sub">{t('not.queue.row.next.text', { time: instantText(locale, attempt.nextRetryAt) })}</div>}
                    </td>
                    <td>{t('not.queue.row.attempt.text', { no: attempt.attemptNo, max: MAX_ATTEMPTS })}</td>
                    <td>{attempt.fallbackChannel === null ? t('not.queue.row.fallback.none') : channelLabel(t, attempt.fallbackChannel)}</td>
                    <td>{instantText(locale, attempt.expiresAt)}</td>
                    <td className="row-actions">
                      {canOperate && mayCancel(attempt) ? (
                        <button type="button" onClick={() => (cancel.reset(), setTarget(attempt))}>
                          {t('not.queue.cancel.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="inbox-list-footer">
            <span>{t('not.queue.footer.count', { count: (items ?? []).length })}</span>
            {pages.isFetchNextPageError ? (
              <span className="callout warning" role="alert">
                {t('not.queue.footer.pageError')}
              </span>
            ) : null}
            {pages.hasNextPage ? (
              <button type="button" className="inbox-more" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                {t('not.queue.footer.more.action')}
              </button>
            ) : null}
          </footer>
        </StateBoundary>
        {target === undefined ? null : (
          <ReasonPanel
            key={target.id}
            testId="cancel-panel"
            title={t('not.queue.cancel.title')}
            hint={t('not.queue.cancel.hint')}
            reasonLabel={t('not.queue.cancel.reason.label')}
            reasonError={t('not.queue.cancel.reason.error')}
            confirmLabel={t('not.queue.cancel.confirm.action')}
            dismissLabel={t('not.queue.cancel.dismiss.action')}
            pending={cancel.isPending}
            problem={cancel.isError ? problemMessage(t, describeProblem(cancel.error)) : undefined}
            onConfirm={(reason) => cancel.mutate({ notificationId: target.notificationId, version: target.notificationVersion, reason }, { onSuccess: () => setTarget(undefined) })}
            onDismiss={() => setTarget(undefined)}
          />
        )}
      </div>
      <p className="prototype-note">{t('not.queue.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
