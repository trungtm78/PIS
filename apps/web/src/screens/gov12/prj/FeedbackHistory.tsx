import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { useMonitoringFeedback } from './prjHooks';
import { dayText, feedbackTone, word } from './prjModel';
import type { FeedbackEvent } from './prjModel';
import './prj.css';


const moveWord = (t: (key: string) => string, move: FeedbackEvent['move']): string => {
  switch (move) {
    case 'RECEIVED':
      return t('prj.monDetail.history.move.received');
    case 'TAKE':
      return t('prj.monDetail.history.move.take');
    case 'RESPOND':
      return t('prj.monDetail.history.move.respond');
    case 'CLOSE':
      return t('prj.monDetail.history.move.close');
    case 'REOPEN':
      return t('prj.monDetail.history.move.reopen');
    default:
      return t('prj.monDetail.history.move.decline');
  }
};

/** The time of a move as the Vietnam calendar reads it: `dd/mm/yyyy hh:mm`. */
export function eventTime(iso: string): string {
  if (Number.isNaN(Date.parse(iso))) return '–';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

/**
 * The record of what was done with one community feedback, oldest first: who took it, answered it, closed it or reopened it, and the reason given. The record is append-only; the page reads it once opened and says
 * when it could not (with a retry), and when it holds nothing.
 */
export function FeedbackHistory({ feedbackId }: { feedbackId: string }) {
  const { t } = useTranslation();
  const query = useMonitoringFeedback(feedbackId, true);
  if (query.isLoading) {
    return (
      <p role="status" aria-busy="true" data-testid={`history-loading-${feedbackId}`}>
        {t('prj.monDetail.history.loading')}
      </p>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <p role="alert" data-testid={`history-error-${feedbackId}`}>
        {t('prj.monDetail.history.error')}{' '}
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
          {t('prj.monDetail.history.retry')}
        </button>
      </p>
    );
  }
  const { history } = query.data;
  if (history.length === 0) {
    return (
      <p className="prj-muted" data-testid={`history-empty-${feedbackId}`}>
        {t('prj.monDetail.history.empty')}
      </p>
    );
  }
  return (
    <section aria-label={t('prj.monDetail.history.label', { reference: query.data.reference })} data-testid={`history-${feedbackId}`}>
      <ol className="prj-list">
        {history.map((event) => (
          <li key={event.id} className="prj-list__item" data-testid={`event-${event.id}`}>
            <span>
              <strong>{moveWord(t, event.move)}</strong>{' '}
              <StatusPill tone={feedbackTone(event.to_status as never)}>{t(`prj.mon.feedback.status.${word(event.to_status)}`)}</StatusPill>
            </span>
            <span className="prj-muted">
              {eventTime(event.at)} · {t('prj.monDetail.history.actor', { actor: event.actor_id.slice(0, 8) })}
            </span>
            {event.reason === null ? null : <span>{t('prj.monDetail.history.reason', { reason: event.reason })}</span>}
          </li>
        ))}
      </ol>
      <p className="prj-muted">{t('prj.monDetail.history.asOf', { day: dayText(query.data.as_of) })}</p>
    </section>
  );
}

