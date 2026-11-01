import { useTranslation } from '../../../i18n';
import { problemMessage } from '../diary/labels';
import '../qms.css';
import type { OfflineQueue } from './hooks';
import { isPending } from './model';

/** The diaries waiting on this device, with the state of the connection and what the last send did. */
export function QueuePanel({ queue }: { queue: OfflineQueue }) {
  const { t, locale } = useTranslation();
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
  const waiting = queue.items.filter(isPending).length;
  return (
    <section className="card" aria-label={t('qms.offline.queue.title')} data-testid="queue">
      <h2>{t('qms.offline.queue.title')}</h2>
      <p className={queue.online ? 'qms-badge ok' : 'qms-badge warning'} role="status" data-testid="connection">
        {queue.online ? t('qms.offline.connection.online') : t('qms.offline.connection.offline')}
      </p>
      {queue.wiped === 0 ? null : (
        <p className="callout warning" role="status" data-testid="wiped">
          {t('qms.offline.wiped.notice', { count: queue.wiped })}
        </p>
      )}
      {queue.unsaved ? (
        <p className="callout warning" role="alert" data-testid="unsaved">
          {t('qms.offline.queue.unsaved')}
        </p>
      ) : null}
      {queue.items.length === 0 ? (
        <p className="sub" data-testid="queue-empty">
          {t('qms.offline.queue.empty')}
        </p>
      ) : (
        <ul className="qms-actions" data-testid="queue-items">
          {queue.items.map((item) => (
            <li key={item.clientOperationId} data-operation={item.clientOperationId} data-state={item.state}>
              <strong>{item.recordDate}</strong> · {item.contractCode} · {t('qms.offline.queue.queued', { when: moment(item.queuedAt) })}{' '}
              <span className={item.state === 'PENDING' ? 'qms-badge' : 'qms-badge danger'}>{item.state === 'PENDING' ? t('qms.offline.queue.pending') : t('qms.offline.queue.rejected')}</span>
              {item.reason === null ? null : (
                <small role="alert" className="field-error" data-testid="reason">
                  {problemMessage(t, item.reason)}
                </small>
              )}{' '}
              <button type="button" data-remove={item.clientOperationId} disabled={queue.sending && item.state === 'PENDING'} onClick={() => queue.remove(item.clientOperationId)}>
                {t('qms.offline.queue.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p>
        <button type="button" className="primary" disabled={!queue.canSend || queue.sending || waiting === 0} onClick={() => void queue.flush()}>
          {queue.sending ? t('qms.offline.queue.sending') : t('qms.offline.queue.send')}
        </button>
      </p>
      {queue.outcome === undefined ? null : (
        <p className="sub" role="status" data-testid="outcome">
          {t('qms.offline.outcome.text', { sent: queue.outcome.sent, conflicts: queue.outcome.conflicts, rejected: queue.outcome.rejected })}
        </p>
      )}
      <p className="sub">{t('qms.offline.queue.note')}</p>
    </section>
  );
}
