import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import type { ScreenState } from '../../states/StateBoundary';
import { StatusPill } from '../../ui';
import { clockAndDay } from '../../ui/alerts/format';
import { clockText } from '../../screens/dir/labels';
import { useUnitOptions } from '../../screens/dir/hooks';
import { STATUSES, dayText, phaseTone, statusTone } from '../../screens/dir/model';
import type { DirectiveLine, DirectiveStatus, Summary } from '../../screens/dir/model';
import { ALL_DIRECTIVES, useDirectives } from './directives-source';
import type { DirectivesQuery } from './directives-source';
import { PwaBackLink } from './PwaBackLink';
import './pwa.css';

const START_PATH = '/m';
export const directivePwaPath = (id: string): string => `/m/directives/${id}`;

type T = Translator['t'];

export function statusLabel(t: T, status: DirectiveStatus): string {
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
export function failureState(error: unknown): ScreenState {
  if (error instanceof ApiError) {
    if (error.code === 'SESSION_EXPIRED') return 'signedOut';
    if (error.status === 403) return 'denied';
    if (error.code === NETWORK_ERROR_CODE) return 'offline';
  }
  return 'error';
}

/**
 * The directive tracking view (PWA-04, YCK.01): the directives given to the leader's scope with the unit that carries them out, the deadline as the server
 * counts it, and the counts of the scope on top. It reads `listDirectives` and `getDirectiveSummary` (the operations DIR-03 and the phone application use),
 * filtered by status, by overdue and by unit, and each card opens the detail with its timeline (PWA-06). Loading is a skeleton (never a count of 0), empty
 * has two kinds (none, and the filter found nothing), an error names itself and retries in place, stale says when the list was read, and counts that could
 * not be read are said so and never shown as 0.
 */
export default function DirectivesScreen() {
  const { tenant } = useSession();
  return <DirectivesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} />;
}

function DirectivesContent() {
  const { t } = useTranslation();
  const [query, setQuery] = useState<DirectivesQuery>(ALL_DIRECTIVES);
  const reading = useDirectives(query);
  const units = useUnitOptions();
  const filtered = query.status !== '' || query.overdue || query.unitId !== '';
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
      {screenState === 'loading' || screenState === 'default' ? (
        <div className="pwa-filters">
          <div className="field">
            <label htmlFor="pwa-directives-status">{t('pwa.directives.filter.status')}</label>
            <select id="pwa-directives-status" value={query.status} onChange={(event) => setQuery({ ...query, status: event.target.value as DirectiveStatus | '' })}>
              <option value="">{t('pwa.directives.filter.all')}</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(t, value)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pwa-directives-unit">{t('pwa2.directives.filter.unit')}</label>
            <select id="pwa-directives-unit" value={query.unitId} onChange={(event) => setQuery({ ...query, unitId: event.target.value })}>
              <option value="">{t('pwa2.directives.filter.unitAll')}</option>
              {(units.data ?? []).map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.label}
                </option>
              ))}
            </select>
          </div>
          <label className="pwa-check" htmlFor="pwa-directives-late">
            <input type="checkbox" id="pwa-directives-late" checked={query.overdue} onChange={(event) => setQuery({ ...query, overdue: event.target.checked })} />
            <span>{t('pwa2.directives.filter.overdue')}</span>
          </label>
        </div>
      ) : null}
      <StateBoundary state={screenState} onRetry={reading.state === 'error' ? reading.retry : undefined}>
        {reading.state !== 'ready' ? null : (
          <>
            {reading.stale ? (
              <p className="callout warning" role="status" data-testid="stale">
                {t('pwa.directives.stale.note', { time: clockAndDay(reading.asOf) })}{' '}
                <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={reading.retry}>
                  {t('states.retry.action')}
                </button>
              </p>
            ) : null}
            <Tiles summary={reading.summary} failed={reading.summaryFailed} retry={reading.retry} />
            <p className="sub" data-testid="counts">
              {t('pwa2.directives.counts.shown', { shown: reading.items.length })}
              {reading.hasMore ? ` ${t('pwa2.directives.counts.more')}` : ''}
              {' · '}
              {t('pwa.directives.counts.updated', { time: clockAndDay(reading.asOf) })}
            </p>
            {reading.items.length === 0 ? (
              <div className="card statecard pwa-empty" role="status" data-testid="empty" data-kind={filtered ? 'filtered' : 'none'}>
                <h2>{filtered ? t('pwa.directives.empty.filtered.title') : t('pwa.directives.empty.none.title')}</h2>
                <p className="muted">{filtered ? t('pwa.directives.empty.filtered.body') : t('pwa.directives.empty.none.body')}</p>
                {filtered ? (
                  <button type="button" className="ui-button ui-button--outline pwa-touch" onClick={() => setQuery(ALL_DIRECTIVES)}>
                    {t('pwa.directives.empty.filtered.clear')}
                  </button>
                ) : null}
              </div>
            ) : (
              <ul className="pwa-cards" aria-label={t('pwa.directives.list.aria')}>
                {reading.items.map((item) => (
                  <DirectiveCard key={item.id} item={item} />
                ))}
              </ul>
            )}
            {reading.hasMore ? (
              <button type="button" className="ui-button ui-button--outline pwa-touch pwa-more" data-action="more" disabled={reading.loadingMore} onClick={reading.loadMore}>
                {reading.loadingMore ? t('pwa2.directives.more.loading') : t('pwa2.directives.more.action')}
              </button>
            ) : null}
          </>
        )}
      </StateBoundary>
    </section>
  );
}

/** The counts of the scope with how each is made: a missing reading says so and shows no number. */
function Tiles({ summary, failed, retry }: { summary: Summary | null; failed: boolean; retry: () => void }) {
  const { t } = useTranslation();
  if (summary === null) {
    return failed ? (
      <p className="callout warning" role="alert" data-testid="summary-failed">
        {t('pwa2.directives.summary.failed')}{' '}
        <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={retry}>
          {t('states.retry.action')}
        </button>
      </p>
    ) : (
      <div role="status" aria-busy="true" aria-label={t('states.loading.label')}>
        <span className="ui-skeleton ui-skeleton--line" />
      </div>
    );
  }
  const tiles: Array<{ key: string; label: string; value: number; tone?: 'danger' }> = [
    { key: 'overdue', label: t('pwa2.directives.summary.overdue'), value: summary.byStatus.OVERDUE, tone: 'danger' },
    { key: 'dueSoon', label: t('pwa2.directives.summary.dueSoon'), value: summary.dueSoon },
    { key: 'escalated', label: t('pwa2.directives.summary.escalated'), value: summary.escalated },
    { key: 'open', label: t('pwa2.directives.summary.open'), value: summary.byStatus.OPEN + summary.byStatus.IN_PROGRESS },
  ];
  const definitions = Object.entries(summary.definitions);
  return (
    <section aria-label={t('pwa2.directives.summary.aria')} data-testid="summary">
      <ul className="pwa-tiles">
        {tiles.map((tile) => (
          <li key={tile.key} className="pwa-tile" data-tile={tile.key} {...(tile.tone === undefined || tile.value === 0 ? {} : { 'data-tone': tile.tone })}>
            <span>{tile.label}</span>
            <strong>{tile.value}</strong>
          </li>
        ))}
      </ul>
      <p className="sub">
        {t('pwa2.directives.summary.total', { total: summary.total })}
        {summary.truncated ? ` ${t('pwa2.directives.summary.truncated')}` : ''}
      </p>
      {summary.policy.unverified ? (
        <p className="callout" role="status" data-testid="policy-unverified">
          {t('pwa2.directives.summary.unverified')}
        </p>
      ) : null}
      {definitions.length === 0 ? null : (
        <details className="pwa-details">
          <summary className="pwa-touch">{t('pwa2.directives.summary.how')}</summary>
          <ul className="pwa-lines">
            {definitions.map(([name, text]) => (
              <li key={name}>{text}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function DirectiveCard({ item }: { item: DirectiveLine }) {
  const { t } = useTranslation();
  const clock = clockText(t, item);
  return (
    <li className="pwa-card" data-directive={item.id} data-status={item.status} data-overdue={item.status === 'OVERDUE' ? 'yes' : 'no'}>
      <div className="pwa-card-head">
        <h2>
          <Link to={directivePwaPath(item.id)} className="pwa-touch pwa-link-title" data-action="open">
            {item.code}
          </Link>
        </h2>
        <StatusPill tone={statusTone(item.status)}>{statusLabel(t, item.status)}</StatusPill>
      </div>
      <p className="pwa-clamp">{item.text}</p>
      <dl className="pwa-facts">
        <dt>{t('pwa.directives.field.unit')}</dt>
        <dd>{item.assigneeUnit.name === '' ? '—' : item.assigneeUnit.name}</dd>
        {item.assignee === null ? null : (
          <>
            <dt>{t('pwa2.directives.field.assignee')}</dt>
            <dd>{item.assignee.displayName}</dd>
          </>
        )}
        {item.project === null ? null : (
          <>
            <dt>{t('pwa2.directives.field.project')}</dt>
            <dd>{item.project.name}</dd>
          </>
        )}
        <dt>{t('pwa.directives.field.due')}</dt>
        <dd>
          {dayText(item.dueOn)}
          {clock === '' ? null : (
            <>
              {' '}
              <StatusPill tone={phaseTone(item.phase)}>{clock}</StatusPill>
            </>
          )}
        </dd>
        {item.openExtension === null ? null : (
          <>
            <dt>{t('pwa2.directives.field.extension')}</dt>
            <dd>{t('pwa2.directives.extension.pending', { day: dayText(item.openExtension.proposedDueOn) })}</dd>
          </>
        )}
      </dl>
    </li>
  );
}
