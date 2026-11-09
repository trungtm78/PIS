import { useParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { StatusPill } from '../../ui';
import { clockAndDay } from '../../ui/alerts/format';
import { useDirectiveDetail } from '../../screens/dir/hooks';
import { clockText, eventLabel, extensionStatusLabel } from '../../screens/dir/labels';
import { dayText, phaseTone, statusTone } from '../../screens/dir/model';
import type { DirectiveDetail, TimelineEvent } from '../../screens/dir/model';
import { failureState, statusLabel } from './DirectivesScreen';
import { PwaBackLink } from './PwaBackLink';
import './pwa.css';

const LIST_PATH = '/m/directives';

/** The latest reported progress: the newest progress event that carries a percentage, or null when nothing was reported (never 0%). */
export function latestProgress(timeline: readonly TimelineEvent[]): { percent: number; at: string } | null {
  const reported = timeline.filter((event) => event.type === 'PROGRESS' && event.progressPct !== null).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const latest = reported[0];
  return latest === undefined || latest.progressPct === null ? null : { percent: latest.progressPct, at: latest.occurredAt };
}

/**
 * The detail of one directive on the phone (PWA-06, YCK.01): the text, who carries it out, the deadline as the server counts it, the progress last reported,
 * the timeline (nothing in it is edited), the requests to move the due day and the evidence. It reads `getDirective`, the operation DIR-04 and the phone
 * application use; the commands (progress, extension, closure) stay on DIR-04, because a leader on a phone reads and does not record.
 */
export default function DirectiveDetailScreen() {
  const { tenant } = useSession();
  const { id = '' } = useParams();
  return <DetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${id}`} id={id} />;
}

function DetailContent({ id }: { id: string }) {
  const { t } = useTranslation();
  const query = useDirectiveDetail(id);
  const detail = query.data ?? undefined;
  const state = query.isLoading ? 'loading' : query.error !== null && query.data === undefined ? failureState(query.error) : 'default';
  return (
    <section className="pwa-screen" data-screen-id="PWA-06" aria-labelledby="screen-title">
      <PwaBackLink to={LIST_PATH} label={t('pwa2.directiveDetail.back.link')} />
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwa2.directiveDetail.page.title')}</h1>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {query.isSuccess && query.data === null ? (
          <div className="card statecard pwa-empty" role="alert" data-testid="not-found">
            <h2>{t('pwa2.directiveDetail.notFound.title')}</h2>
            <p className="muted">{t('pwa2.directiveDetail.notFound.body')}</p>
          </div>
        ) : detail === undefined ? null : (
          <Body detail={detail} stale={query.isError} />
        )}
      </StateBoundary>
    </section>
  );
}

function Body({ detail, stale }: { detail: DirectiveDetail; stale: boolean }) {
  const { t } = useTranslation();
  const line = detail.directive;
  const clock = clockText(t, line);
  const progress = latestProgress(detail.timeline);
  const events = [...detail.timeline].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  return (
    <>
      {stale ? (
        <p className="callout warning" role="status" data-testid="stale">
          {t('pwa.directives.stale.note', { time: clockAndDay(detail.asOf) })}
        </p>
      ) : null}
      <section className="ui-section" aria-labelledby="directive-summary" data-testid="directive-summary">
        <header className="ui-section__head">
          <h2 className="ui-section__title" id="directive-summary">
            {line.code}
          </h2>
          <span className="ui-section__status">
            <StatusPill tone={statusTone(line.status)}>{statusLabel(t, line.status)}</StatusPill>
          </span>
        </header>
        <div className="ui-section__body">
          <p>{line.text}</p>
          <dl className="pwa-facts">
            <dt>{t('pwa.directives.field.unit')}</dt>
            <dd>{line.assigneeUnit.name === '' ? '—' : line.assigneeUnit.name}</dd>
            {line.assignee === null ? null : (
              <>
                <dt>{t('pwa2.directives.field.assignee')}</dt>
                <dd>{line.assignee.displayName}</dd>
              </>
            )}
            {line.project === null ? null : (
              <>
                <dt>{t('pwa2.directives.field.project')}</dt>
                <dd>{line.project.name}</dd>
              </>
            )}
            <dt>{t('pwa2.directiveDetail.field.meeting')}</dt>
            <dd>
              {line.meeting.code} {line.meeting.title === '' ? '' : `· ${line.meeting.title}`}
            </dd>
            <dt>{t('pwa2.directiveDetail.field.originalDue')}</dt>
            <dd>{dayText(line.originalDueOn)}</dd>
            <dt>{t('pwa.directives.field.due')}</dt>
            <dd data-testid="due">
              {dayText(line.dueOn)}
              {clock === '' ? null : (
                <>
                  {' '}
                  <StatusPill tone={phaseTone(line.phase)}>{clock}</StatusPill>
                </>
              )}
            </dd>
            <dt>{t('pwa.directives.field.progress')}</dt>
            <dd>
              {progress === null ? (
                <span data-testid="progress-none">{t('pwa.directives.progress.none')}</span>
              ) : (
                <span className="pwa-progress" data-testid="progress">
                  <progress value={progress.percent} max={100} aria-label={t('pwa.directives.progress.aria', { percent: progress.percent })} />
                  <span>{t('pwa.directives.progress.value', { percent: progress.percent })}</span>
                </span>
              )}
            </dd>
            {progress === null ? null : (
              <>
                <dt>{t('pwa.directives.field.updated')}</dt>
                <dd>{clockAndDay(progress.at)}</dd>
              </>
            )}
          </dl>
        </div>
      </section>
      <section className="ui-section" aria-labelledby="directive-timeline">
        <header className="ui-section__head">
          <h2 className="ui-section__title" id="directive-timeline">
            {t('pwa2.directiveDetail.timeline.title')}
          </h2>
        </header>
        <div className="ui-section__body">
          {events.length === 0 ? (
            <p role="status">{t('pwa2.directiveDetail.timeline.none')}</p>
          ) : (
            <ol className="pwa-lines" aria-label={t('pwa2.directiveDetail.timeline.aria')} data-testid="timeline">
              {events.map((event) => (
                <li key={event.id} data-event={event.type}>
                  <strong>{eventLabel(t, event.type)}</strong>
                  <br />
                  <span className="sub">
                    {event.actor.displayName === '' ? '' : `${event.actor.displayName} · `}
                    {clockAndDay(event.occurredAt)}
                  </span>
                  {event.progressPct === null ? null : (
                    <>
                      <br />
                      {t('pwa.directives.progress.value', { percent: event.progressPct })}
                    </>
                  )}
                  {event.toDueOn === null ? null : (
                    <>
                      <br />
                      {t('pwa2.directiveDetail.timeline.due', { from: dayText(event.fromDueOn), to: dayText(event.toDueOn) })}
                    </>
                  )}
                  {event.toAssigneeUnit === null ? null : (
                    <>
                      <br />
                      {t('pwa2.directiveDetail.timeline.unit', { unit: event.toAssigneeUnit.name })}
                    </>
                  )}
                  {event.note === null ? null : (
                    <>
                      <br />
                      <span>{event.note}</span>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
      {detail.extensions.length === 0 ? null : (
        <section className="ui-section" aria-labelledby="directive-extensions">
          <header className="ui-section__head">
            <h2 className="ui-section__title" id="directive-extensions">
              {t('pwa2.directiveDetail.extensions.title')}
            </h2>
          </header>
          <div className="ui-section__body">
            <ul className="pwa-lines" data-testid="extensions">
              {detail.extensions.map((extension) => (
                <li key={extension.id}>
                  <strong>{extensionStatusLabel(t, extension.status)}</strong>
                  <br />
                  {t('pwa2.directiveDetail.extensions.move', { from: dayText(extension.fromDueOn), to: dayText(extension.proposedDueOn) })}
                  <br />
                  <span className="sub">{extension.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      <section className="ui-section" aria-labelledby="directive-evidence">
        <header className="ui-section__head">
          <h2 className="ui-section__title" id="directive-evidence">
            {t('pwa2.directiveDetail.evidence.title')}
          </h2>
        </header>
        <div className="ui-section__body">
          {detail.evidence.length === 0 ? (
            <p role="status">{t('pwa2.directiveDetail.evidence.none')}</p>
          ) : (
            <ul className="pwa-lines" data-testid="evidence">
              {detail.evidence.map((item) => (
                <li key={item.id}>
                  <strong>{item.title ?? t('pwa2.directiveDetail.evidence.untitled')}</strong>
                  <br />
                  <span className="sub">
                    {item.addedBy.displayName} · {clockAndDay(item.addedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
