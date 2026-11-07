import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { AlertRow, sourceLabel } from './AlertRow';
import { clock, todayOf } from './format';
import { SeverityIcon } from './SeverityBadge';
import { SEVERITIES, severityRankOf } from './types';
import type { AlertCounts, AlertItem, Severity } from './types';
import './alerts.css';

const HOME_QUEUE = '/home/home-02';

export interface AlertBandProps {
  items: AlertItem[];
  counts: AlertCounts;
  /** How many rows the band shows; default 5. */
  max?: number;
  state?: 'ready' | 'loading' | 'error' | 'empty';
  /** The sources that could not be read: they are named, never shown as "no work". */
  unavailable?: string[];
  onRetry?: () => void;
  /** When the figures were checked (ISO); the one-line "no urgent work" says it. */
  asOf?: string | null;
  /** The figures are old: the last good answer is shown with this notice. */
  stale?: boolean;
}

const countOf = (counts: AlertCounts, severity: Severity): number => (severity === 'URGENT' ? counts.urgent : severity === 'ACTION' ? counts.action : counts.watch);

/** The band at the top of HOME-01: how many items wait by level and the first five, or one line when nothing is urgent. */
export function AlertBand({ items, counts, max = 5, state = 'ready', unavailable = [], onRetry, asOf = null, stale = false }: AlertBandProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const today = todayOf();
  const sources = unavailable.map((source) => sourceLabel(t, source)).join(', ');

  let body;
  if (state === 'loading') {
    body = (
      <div className="mv-alert-skeleton" role="status" aria-busy="true" aria-label={t('alerts.band.loading')}>
        <span className="mv-alert-skeleton__row" />
        <span className="mv-alert-skeleton__row" />
      </div>
    );
  } else if (state === 'error') {
    body = (
      <div className="mv-alert-banner" data-tone="danger" role="alert">
        <span>{sources === '' ? t('alerts.band.error') : t('alerts.unavailable', { sources })}</span>
        {onRetry === undefined ? null : (
          <>
            {' '}
            <button type="button" className="mv-alert-link" onClick={onRetry}>
              {t('alerts.error.retry')}
            </button>
          </>
        )}
      </div>
    );
  } else {
    const ordered = items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => severityRankOf(a.item.severity) - severityRankOf(b.item.severity) || a.index - b.index)
      .map((entry) => entry.item);
    const rows = ordered.slice(0, Math.max(max, 0));
    const calm = state === 'empty' || counts.urgent === 0;
    body = (
      <>
        {stale ? (
          <p className="mv-alert-banner" data-tone="warning" role="status">
            {t('alerts.stale', { time: asOf === null ? '' : clock(asOf) })}
            {onRetry === undefined ? null : (
              <>
                {' '}
                <button type="button" className="mv-alert-link" onClick={onRetry}>
                  {t('alerts.error.retry')}
                </button>
              </>
            )}
          </p>
        ) : null}
        {unavailable.length > 0 ? (
          <p className="mv-alert-banner" data-tone="warning" role="status" data-testid="alert-band-unavailable">
            {t('alerts.unavailable', { sources })}
            {onRetry === undefined ? null : (
              <>
                {' '}
                <button type="button" className="mv-alert-link" onClick={onRetry}>
                  {t('alerts.error.retry')}
                </button>
              </>
            )}
          </p>
        ) : null}
        <ul className="mv-alert-band__counts" aria-label={t('alerts.band.counts')}>
          {SEVERITIES.map((severity) => (
            <li key={severity} className="mv-alert-chip" data-severity={severity} data-readonly="true">
              <SeverityIcon severity={severity} />
              <span>{t('alerts.band.countLabel', { label: t(`alerts.severity.${severity}`), count: countOf(counts, severity) })}</span>
            </li>
          ))}
        </ul>
        {calm ? (
          <p className="mv-alert-band__calm" data-testid="alert-band-calm">
            {asOf === null ? t('alerts.band.noneNoTime') : t('alerts.band.none', { time: clock(asOf) })}
          </p>
        ) : (
          <ul className="mv-alert-list">
            {rows.map((item) => (
              <AlertRow key={item.id} item={item} today={today} />
            ))}
          </ul>
        )}
        {!calm && counts.total > rows.length ? <p className="mv-alert-muted">{t('alerts.band.more', { count: counts.total - rows.length })}</p> : null}
      </>
    );
  }
  return (
    <section className="mv-alert-band" aria-labelledby={titleId} data-state={state} data-urgent={state === 'ready' && counts.urgent > 0 ? 'true' : 'false'}>
      <header className="mv-alert-band__head">
        <h2 id={titleId}>{t('alerts.band.title')}</h2>
        <Link to={HOME_QUEUE} className="mv-alert-link">
          {t('alerts.band.viewAll')}
        </Link>
      </header>
      {body}
    </section>
  );
}
