import { Link, useParams } from 'react-router-dom';
import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { useTranslation } from '../../i18n';
import { eventLabel } from '../../screens/dir/labels';
import { useDirectiveDetail } from '../../screens/dir/hooks';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import type { ScreenState } from '../../states/StateBoundary';
import { DeadlineCountdown, StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { clockAndDay, todayOf } from '../../ui/alerts/format';
import { PwaBackLink } from './PwaBackLink';
import './pwa.css';

const LIST_PATH = '/m/directives';
const TONES: Readonly<Record<string, Tone>> = { OPEN: 'info', IN_PROGRESS: 'info', DONE: 'success', OVERDUE: 'danger', CANCELLED: 'neutral' };

function failureState(error: unknown): ScreenState {
  if (error instanceof ApiError) {
    if (error.code === 'SESSION_EXPIRED') return 'signedOut';
    if (error.status === 403) return 'denied';
    if (error.code === NETWORK_ERROR_CODE) return 'offline';
  }
  return 'error';
}

/**
 * One directive of the tracking view (PWA-04, YCK.01), read only: what was ordered, by which steering meeting, who must do it and by when, how far it stands (the latest progress that was reported, else "not
 * reported", never 0%), and the timeline of what happened to it. The manager application is for following and deciding, not for entering, so nothing here writes; a directive outside the scope of the reader, or in
 * another tenant, is the same as one that does not exist.
 */
export default function DirectiveDetailScreen() {
  const { tenant } = useSession();
  const { id } = useParams();
  return <DirectiveDetailContent key={`${tenant?.id ?? 'none'}:${id ?? ''}`} id={id} />;
}

function DirectiveDetailContent({ id }: { id: string | undefined }) {
  const { t } = useTranslation();
  const detail = useDirectiveDetail(id);
  const today = todayOf();
  const state: ScreenState = detail.isPending ? 'loading' : detail.isError ? failureState(detail.error) : 'default';
  const found = detail.data ?? undefined;
  const line = found?.directive;
  const progress = found === undefined ? null : ([...found.timeline].reverse().find((event) => event.progressPct !== null)?.progressPct ?? null);

  return (
    <section className="pwa-screen" data-screen-id="PWA-04" aria-labelledby="screen-title">
      <PwaBackLink to={LIST_PATH} />
      <div className="heading">
        <h1 id="screen-title">{t('pwa.directives.detail.title')}</h1>
      </div>
      <StateBoundary state={state} onRetry={detail.isError ? () => void detail.refetch() : undefined}>
        {detail.data === null || line === undefined ? (
          <div className="card statecard pwa-empty" role="status" data-testid="not-found">
            <h2>{t('pwa.directives.detail.notFound.title')}</h2>
            <p className="muted">{t('pwa.directives.detail.notFound.body')}</p>
            <Link to={LIST_PATH} className="ui-button ui-button--outline pwa-touch">
              {t('pwa.directives.detail.notFound.back')}
            </Link>
          </div>
        ) : (
          <article className="pwa-card" data-directive={line.id} data-status={line.status}>
            <div className="pwa-card-head">
              <h2>{line.text}</h2>
              <StatusPill tone={TONES[line.status] ?? 'neutral'}>{t(`pwa.directives.status.${statusKey(line.status)}`)}</StatusPill>
            </div>
            <dl className="pwa-facts">
              <dt>{t('pwa.directives.field.issuedBy')}</dt>
              <dd>{`${line.meeting.code} · ${line.meeting.title}`}</dd>
              <dt>{t('pwa.directives.field.unit')}</dt>
              <dd>{line.assigneeUnit.name}</dd>
              <dt>{t('pwa.directives.field.due')}</dt>
              <dd>
                <DeadlineCountdown dueOn={line.dueOn} today={today} daysLate={line.overdueDays ?? 0} />
              </dd>
              <dt>{t('pwa.directives.field.progress')}</dt>
              <dd>
                {progress === null ? (
                  <span data-testid="progress-none">{t('pwa.directives.progress.none')}</span>
                ) : (
                  <span className="pwa-progress">
                    <progress value={progress} max={100} aria-label={t('pwa.directives.progress.aria', { percent: progress })} />
                    <span>{t('pwa.directives.progress.value', { percent: progress })}</span>
                  </span>
                )}
              </dd>
              {line.extensionCount === 0 ? null : (
                <>
                  <dt>{t('pwa.directives.detail.extensions')}</dt>
                  <dd>{t('pwa.directives.detail.extensions.value', { count: line.extensionCount, original: line.originalDueOn })}</dd>
                </>
              )}
            </dl>
            <h3>{t('pwa.directives.detail.timeline')}</h3>
            <ol className="pwa-timeline" aria-label={t('pwa.directives.detail.timeline')}>
              {found?.timeline.map((event) => (
                <li key={event.id} data-event={event.type}>
                  <strong>{eventLabel(t, event.type)}</strong> <span className="muted">{clockAndDay(event.occurredAt)}</span>
                  {event.progressPct === null ? null : <span> · {t('pwa.directives.progress.value', { percent: event.progressPct })}</span>}
                  {event.note === null ? null : <p>{event.note}</p>}
                </li>
              ))}
            </ol>
          </article>
        )}
      </StateBoundary>
    </section>
  );
}

function statusKey(status: string): 'open' | 'inProgress' | 'done' | 'overdue' | 'cancelled' {
  switch (status) {
    case 'IN_PROGRESS':
      return 'inProgress';
    case 'DONE':
      return 'done';
    case 'OVERDUE':
      return 'overdue';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'open';
  }
}
