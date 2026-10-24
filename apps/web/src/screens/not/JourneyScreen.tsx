import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import { useAttemptDetail } from './delivery/hooks';
import { channelLabel, failureClassLabel, milestoneLabel, offsetLabel, statusLabel, statusPill } from './delivery/labels';
import { MAX_ATTEMPTS, READ_PERMISSION, milestonesOf } from './delivery/model';
import type { AttemptView } from './delivery/model';
import './delivery/delivery.css';
import './inbox/inbox.css';

const QUEUE_ROUTE = 'NOT-11';
const ARROW = '←';

/**
 * NOT-12: the journey of one send. The five sends of its channel as milestones (the first and the retries after 30 seconds, 2, 10 and 30 minutes),
 * the moments of the message (queued, accepted by the provider, delivered, read by the provider, acknowledged by the person), and every attempt of the
 * notification with its provider reference and the reason it was left out. The status never goes back: a read is not an acknowledgement (BR-NOT-05, BR-NOT-06).
 */
export default function JourneyScreen({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const [params] = useSearchParams();
  const id = params.get('id') ?? undefined;
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const detail = useAttemptDetail(id, canRead);
  const queueRoute = routeById(QUEUE_ROUTE);
  const queryState = useScreenState({ isLoading: detail.isLoading, error: detail.error ?? undefined, data: detail.data, isEmpty: () => false });
  const state = canRead ? queryState : 'denied';
  const when = (instant: string | null): string => (instant === null ? t('not.journey.timeline.notYet') : instantText(locale, instant));
  const current: AttemptView | undefined = detail.data;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-journey">
      <p className="back-link">
        <Link to={queueRoute?.path ?? '/not/not-11'}>
          {ARROW} {t('not.journey.back.action')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.journey.page.title')}</h1>
          <p>{t('not.journey.page.subtitle')}</p>
        </div>
      </div>
      {id === undefined ? (
        <div className="card" data-testid="journey-select">
          <strong>{t('not.journey.select.title')}</strong>
          <p>{t('not.journey.select.body')}</p>
        </div>
      ) : (
        <StateBoundary state={state} onRetry={() => void detail.refetch()}>
          {current === undefined || detail.data === undefined ? null : (
            <>
              <div className="card" data-testid="journey-summary">
                <h2>{channelLabel(t, current.channel)}</h2>
                <dl>
                  <dt>{t('not.journey.summary.status')}</dt>
                  <dd>
                    <span className={statusPill(current.status)}>{statusLabel(t, current.status)}</span>
                  </dd>
                  <dt>{t('not.journey.summary.attempt')}</dt>
                  <dd>{t('not.queue.row.attempt.text', { no: current.attemptNo, max: MAX_ATTEMPTS })}</dd>
                  <dt>{t('not.journey.summary.provider')}</dt>
                  <dd>{current.providerMessageId ?? t('not.journey.summary.none')}</dd>
                  <dt>{t('not.journey.summary.error')}</dt>
                  <dd>
                    {current.errorCode === null ? t('not.journey.summary.none') : current.errorCode} ({failureClassLabel(t, current.failureClass)})
                  </dd>
                  <dt>{t('not.journey.summary.expires')}</dt>
                  <dd>{instantText(locale, current.expiresAt)}</dd>
                </dl>
              </div>

              <div className="card" data-testid="journey-milestones">
                <h2>{t('not.journey.milestones.title')}</h2>
                <p className="sub">{t('not.journey.milestones.hint')}</p>
                <ol className="milestones">
                  {milestonesOf(detail.data.journey, current.channel).map((milestone) => (
                    <li key={milestone.attemptNo} data-attempt-no={milestone.attemptNo} data-state={milestone.state}>
                      <strong>{t('not.journey.milestone.attempt', { no: milestone.attemptNo })}</strong>
                      <span className="sub">{offsetLabel(t, milestone.offsetSeconds)}</span>
                      <span>{milestoneLabel(t, milestone.state)}</span>
                      {milestone.at === null ? null : <span className="sub">{instantText(locale, milestone.at)}</span>}
                    </li>
                  ))}
                </ol>
              </div>

              <div className="card" data-testid="journey-timeline">
                <h2>{t('not.journey.timeline.title')}</h2>
                <ol className="timeline">
                  <li>
                    <span>{t('not.journey.timeline.queued')}</span>
                    <span>{when(current.queuedAt)}</span>
                  </li>
                  <li>
                    <span>{t('not.journey.timeline.accepted')}</span>
                    <span>{when(current.acceptedAt)}</span>
                  </li>
                  <li>
                    <span>{t('not.journey.timeline.delivered')}</span>
                    <span>{when(current.deliveredAt)}</span>
                  </li>
                  <li>
                    <span>{t('not.journey.timeline.read')}</span>
                    <span>{when(current.readAt)}</span>
                  </li>
                  <li>
                    <span>{t('not.journey.timeline.acknowledged')}</span>
                    <span>{current.ackRequired ? when(current.acknowledgedAt) : t('not.journey.timeline.notRequired')}</span>
                  </li>
                </ol>
              </div>

              <div className="card" data-testid="journey-attempts">
                <h2>{t('not.journey.attempts.title')}</h2>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('not.journey.attempts.col.channel')}</th>
                        <th>{t('not.journey.attempts.col.attempt')}</th>
                        <th>{t('not.journey.attempts.col.status')}</th>
                        <th>{t('not.journey.attempts.col.provider')}</th>
                        <th>{t('not.journey.attempts.col.reason')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.journey.map((attempt) => (
                        <tr key={attempt.id} data-attempt-id={attempt.id} data-current={attempt.id === current.id}>
                          <td>{channelLabel(t, attempt.channel)}</td>
                          <td>{t('not.queue.row.attempt.text', { no: attempt.attemptNo, max: MAX_ATTEMPTS })}</td>
                          <td>
                            <span className={statusPill(attempt.status)}>{statusLabel(t, attempt.status)}</span>
                          </td>
                          <td>{attempt.providerMessageId ?? ''}</td>
                          <td>{attempt.errorCode ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('not.journey.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
