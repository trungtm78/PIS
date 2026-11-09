import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import type { ScreenState } from '../../states/StateBoundary';
import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { DeadlineCountdown, StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { clockAndDay, todayOf } from '../../ui/alerts/format';
import { DIRECTIVE_STATUSES, useDirectives } from './directives-source';
import type { DirectiveItem, DirectiveStatus } from './directives-source';
import { useSummary, useUnitOptions } from '../../screens/dir/hooks';
import { SummaryTiles } from './DirectiveSummaryTiles';
import { PwaBackLink } from './PwaBackLink';
import './pwa.css';

const START_PATH = '/m';
const DIRECTIVE_PATH = '/m/directives';

type T = Translator['t'];

const TONES: Readonly<Record<DirectiveStatus, Tone>> = { OPEN: 'info', IN_PROGRESS: 'info', DONE: 'success', OVERDUE: 'danger', CANCELLED: 'neutral' };

function statusLabel(t: T, status: DirectiveStatus): string {
  switch (status) {
    case 'OPEN':
      return t('pwa.directives.status.open');
    case 'IN_PROGRESS':
      return t('pwa.directives.status.inProgress');
    case 'DONE':
      return t('pwa.directives.status.done');
    case 'OVERDUE':
      return t('pwa.directives.status.overdue');
    case 'CANCELLED':
      return t('pwa.directives.status.cancelled');
  }
}

/** The failure of a reading as one of the standard states: a lapsed session, a refusal of scope, no network, or any other failure. */
function failureState(error: unknown): ScreenState {
  if (error instanceof ApiError) {
    if (error.code === 'SESSION_EXPIRED') return 'signedOut';
    if (error.status === 403) return 'denied';
    if (error.code === NETWORK_ERROR_CODE) return 'offline';
  }
  return 'error';
}

/**
 * The directive tracking view (PWA-04, YCK.01): the directives given to the leader's scope with who issued them, the unit that carries them out, the deadline
 * and the progress reported. The directive entity belongs to another lane, so the screen is written against the typed hook of `directives-source.ts` and shows
 * its own empty state while the hook says `notBuilt`; it shows no invented directive. Loading is a skeleton (never a count of 0), empty has two kinds (none,
 * and the filter found nothing), an error names itself and retries in place, stale says when the list was read, and a source the server could not read is named.
 */
export default function DirectivesScreen() {
  const { tenant } = useSession();
  return <DirectivesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} />;
}

function DirectivesContent() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DirectiveStatus | 'ALL'>('ALL');
  const [overdue, setOverdue] = useState(false);
  const [unitId, setUnitId] = useState('');
  const reading = useDirectives({ status, overdue, unitId });
  const units = useUnitOptions();
  const summary = useSummary({ unitId, projectId: '', meetingId: '' });
  const today = todayOf();
  const items = reading.state === 'ready' ? reading.items : [];
  const narrowed = status !== 'ALL' || overdue || unitId !== '';
  const shown = status === 'ALL' ? items : items.filter((item) => item.status === status);
  const screenState: ScreenState = reading.state === 'loading' ? 'loading' : reading.state === 'error' ? failureState(reading.error) : 'default';

  return (
    <section className="pwa-screen" data-screen-id="PWA-04" aria-labelledby="screen-title">
      <PwaBackLink to={START_PATH} />
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwa.directives.page.title')}</h1>
          <p>{t('pwa.directives.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={screenState} onRetry={reading.state === 'error' ? reading.retry : undefined}>
        {reading.state === 'notBuilt' ? (
          <div className="card statecard pwa-empty" role="status" data-testid="empty" data-kind="notBuilt">
            <h2>{t('pwa.directives.empty.notBuilt.title')}</h2>
            <p className="muted">{t('pwa.directives.empty.notBuilt.body')}</p>
          </div>
        ) : reading.state === 'ready' ? (
          <>
            {reading.stale ? (
              <p className="callout warning" role="status" data-testid="stale">
                {t('pwa.directives.stale.note', { time: clockAndDay(reading.asOf) })}{' '}
                <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={reading.retry}>
                  {t('states.retry.action')}
                </button>
              </p>
            ) : null}
            {reading.unavailableSources.length === 0 ? null : (
              <p className="callout warning" role="alert" data-testid="unavailable">
                {t('pwa.directives.unavailable.note', { sources: reading.unavailableSources.join(', ') })}
              </p>
            )}
            <SummaryTiles summary={summary.data ?? null} failed={summary.isError || (summary.isSuccess && summary.data === null)} retry={() => void summary.refetch()} />
            <div className="pwa-filters">
              <div className="field">
                <label htmlFor="pwa-directives-status">{t('pwa.directives.filter.status')}</label>
                <select id="pwa-directives-status" value={status} onChange={(event) => setStatus(event.target.value as DirectiveStatus | 'ALL')}>
                  <option value="ALL">{t('pwa.directives.filter.all')}</option>
                  {DIRECTIVE_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {statusLabel(t, value)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pwa-directives-unit">{t('pwa2.directives.filter.unit')}</label>
                <select id="pwa-directives-unit" value={unitId} onChange={(event) => setUnitId(event.target.value)}>
                  <option value="">{t('pwa2.directives.filter.unitAll')}</option>
                  {(units.data ?? []).map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="pwa-check" htmlFor="pwa-directives-late">
                <input type="checkbox" id="pwa-directives-late" checked={overdue} onChange={(event) => setOverdue(event.target.checked)} />
                <span>{t('pwa2.directives.filter.overdue')}</span>
              </label>
            </div>
            <p className="sub" data-testid="counts">
              {t('pwa.directives.counts.line', { shown: shown.length, total: items.length })}
              {' · '}
              {t('pwa.directives.counts.updated', { time: clockAndDay(reading.asOf) })}
            </p>
            {shown.length === 0 ? (
              <div className="card statecard pwa-empty" role="status" data-testid="empty" data-kind={narrowed ? 'filtered' : 'none'}>
                <h2>{narrowed ? t('pwa.directives.empty.filtered.title') : t('pwa.directives.empty.none.title')}</h2>
                <p className="muted">{narrowed ? t('pwa.directives.empty.filtered.body') : t('pwa.directives.empty.none.body')}</p>
                {narrowed ? (
                  <button
                    type="button"
                    className="ui-button ui-button--outline pwa-touch"
                    onClick={() => {
                      setStatus('ALL');
                      setOverdue(false);
                      setUnitId('');
                    }}
                  >
                    {t('pwa.directives.empty.filtered.clear')}
                  </button>
                ) : null}
              </div>
            ) : (
              <ul className="pwa-cards" aria-label={t('pwa.directives.list.aria')}>
                {shown.map((item) => (
                  <DirectiveCard key={item.id} item={item} today={today} />
                ))}
              </ul>
            )}
            {reading.hasMore === true && reading.loadMore !== undefined ? (
              <button type="button" className="ui-button ui-button--outline pwa-touch" data-testid="more" disabled={reading.loadingMore === true} onClick={reading.loadMore}>
                {t('pwa.directives.more.action')}
              </button>
            ) : null}
          </>
        ) : null}
      </StateBoundary>
    </section>
  );
}

function DirectiveCard({ item, today }: { item: DirectiveItem; today: string }) {
  const { t } = useTranslation();
  return (
    <li className="pwa-card" data-directive={item.id} data-status={item.status}>
      <div className="pwa-card-head">
        <h2>{item.title}</h2>
        <StatusPill tone={TONES[item.status]}>{statusLabel(t, item.status)}</StatusPill>
      </div>
      <dl className="pwa-facts">
        <dt>{t('pwa.directives.field.issuedBy')}</dt>
        <dd>{item.issuedBy}</dd>
        <dt>{t('pwa.directives.field.unit')}</dt>
        <dd>{item.assigneeUnit ?? '—'}</dd>
        <dt>{t('pwa.directives.field.due')}</dt>
        <dd>
          <DeadlineCountdown dueOn={item.dueOn} today={today} daysLate={item.overdueDays} />
        </dd>
        <dt>{t('pwa.directives.field.progress')}</dt>
        <dd>
          {item.progressKnown === false ? (
            <span data-testid="progress-detail">{t('pwa.directives.progress.inDetail')}</span>
          ) : item.progressPercent === null ? (
            <span data-testid="progress-none">{t('pwa.directives.progress.none')}</span>
          ) : (
            <span className="pwa-progress">
              <progress value={item.progressPercent} max={100} aria-label={t('pwa.directives.progress.aria', { percent: item.progressPercent })} />
              <span>{t('pwa.directives.progress.value', { percent: item.progressPercent })}</span>
            </span>
          )}
        </dd>
        {item.lastUpdateAt === null ? null : (
          <>
            <dt>{t('pwa.directives.field.updated')}</dt>
            <dd>{clockAndDay(item.lastUpdateAt)}</dd>
          </>
        )}
      </dl>
      <Link to={`${DIRECTIVE_PATH}/${item.id}`} className="ui-button ui-button--outline pwa-touch" data-testid="open-detail">
        {t('pwa.directives.detail.open')}
      </Link>
    </li>
  );
}
