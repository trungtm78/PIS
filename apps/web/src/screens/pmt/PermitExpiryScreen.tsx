import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DEFAULT_WINDOW, WINDOWS, renewLink, summaryOf, urgencyOf, windowOf } from './expiry-model';
import type { ExpiringPermitView } from './expiry-model';
import { useExpiringPermits } from './hooks';
import './pmt.css';
import { Pill } from './components';
import { FilterPanel } from '../../ui';

// A board with nothing on it is a good answer, not the "empty" state of the screen.
const NEVER_EMPTY = (): boolean => false;

/**
 * PMT-05: the permits that need attention. The job `permit-expiry` warns the person in charge at 60, 30, 15 and 0 days and marks a permit EXPIRED the day
 * after its last day (opening one issue); this board lists the permits within the window and the expired ones that no renewal has replaced, the ones that
 * ran out first. Nothing here renews anything: a renewal is a new permit, made on the screen of the permit.
 */
export default function PermitExpiryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The permits belong to one membership (the units and projects it reaches): a switch starts the screen over.
  return <PermitExpiryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PermitExpiryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const days = windowOf(params.get('days'));
  const permits = useExpiringPermits(days);
  const state = useScreenState({ isLoading: permits.isLoading, error: permits.error, data: permits.data, isEmpty: NEVER_EMPTY });
  const rows = useMemo(() => permits.data ?? [], [permits.data]);
  const summary = useMemo(() => summaryOf(rows), [rows]);
  const choose = (value: number): void => {
    const next = new URLSearchParams(params);
    if (value === DEFAULT_WINDOW) next.delete('days');
    else next.set('days', String(value));
    setParams(next, { replace: true });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pmt.expiry.page.title')}</h1>
          <p>{t('pmt.expiry.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void permits.refetch()}>
        <div className="stack">
          <FilterPanel applied={days === DEFAULT_WINDOW ? 0 : 1}>
            <div className="cap-filters">
            <div className="field" data-field="expiry-window">
              <label htmlFor="expiry-window">{t('pmt.expiry.window.label')}</label>
              <select id="expiry-window" value={days} onChange={(event) => choose(Number(event.target.value))}>
                {WINDOWS.map((value) => (
                  <option key={value} value={value}>
                    {t('pmt.expiry.window.option', { days: value })}
                  </option>
                ))}
              </select>
            </div>
            <p data-testid="summary">{t('pmt.expiry.summary.text', { expiring: summary.expiring, expired: summary.expired })}</p>
            </div>
          </FilterPanel>
          <p className="callout" role="note" data-testid="no-renewal">
            {t('pmt.expiry.note.noRenewal')}
          </p>
          {rows.length === 0 ? (
            <p className="sub" data-testid="nothing">
              {t('pmt.expiry.empty.text', { days })}
            </p>
          ) : (
            <Board rows={rows} />
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('pmt.expiry.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Board({ rows }: { rows: readonly ExpiringPermitView[] }) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <table className="table" aria-label={t('pmt.expiry.table.aria')}>
        <caption className="sr-only">{t('pmt.expiry.table.caption', { count: rows.length })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('pmt.expiry.column.permit')}</th>
            <th scope="col">{t('pmt.expiry.column.project')}</th>
            <th scope="col">{t('pmt.expiry.column.until')}</th>
            <th scope="col">{t('pmt.expiry.column.left')}</th>
            <th scope="col">{t('pmt.expiry.column.level')}</th>
            <th scope="col">{t('pmt.expiry.column.owner')}</th>
            <th scope="col">
              <span className="sr-only">{t('pmt.expiry.column.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((permit) => {
            const urgency = urgencyOf(permit);
            return (
              <tr key={permit.id} data-permit-id={permit.id} data-urgency={urgency} data-status={permit.status}>
                <th scope="row">
                  {permit.permitTypeName} {permit.permitNo === null ? null : <code>{permit.permitNo}</code>}
                  {permit.permitTypeCode === null ? null : <small className="sub"> {permit.permitTypeCode}</small>}
                </th>
                <td>
                  {permit.project.code} <small className="sub">{permit.project.name}</small>
                </td>
                <td>{permit.validUntil}</td>
                <td data-testid="left" data-days={permit.daysLeft}>
                  {urgency === 'EXPIRED' ? t('pmt.expiry.left.expired', { days: Math.abs(permit.daysLeft) }) : permit.daysLeft}
                </td>
                <td data-testid="level" data-level={permit.alertLevel}>
                  <Pill tone={urgency === 'AHEAD' ? 'neutral' : 'warning'}>{levelText(t, permit)}</Pill>
                </td>
                <td>{permit.responsible === null ? t('pmt.expiry.owner.none') : permit.responsible.displayName}</td>
                <td className="row-actions">
                  <Link to={renewLink(permit.id)} data-testid="open-permit">
                    {urgency === 'EXPIRED' ? t('pmt.expiry.renew.action') : t('pmt.expiry.open.action')}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The level of alert in words: the threshold the permit has reached, or that it has already run out. */
function levelText(t: ReturnType<typeof useTranslation>['t'], permit: ExpiringPermitView): string {
  if (urgencyOf(permit) === 'EXPIRED') return t('pmt.expiry.level.expired');
  if (permit.thresholdDays === 0) return t('pmt.expiry.level.lastDay');
  return permit.thresholdDays === null ? t('pmt.expiry.level.none') : t('pmt.expiry.level.days', { days: permit.thresholdDays });
}
