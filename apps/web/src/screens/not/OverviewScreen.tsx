import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import { channelLabel, statusLabel } from '../omni/channel/labels';
import type { AccountStatus } from '../omni/channel/model';
import './delivery/delivery.css';
import { useOverview } from './limits/hooks';
import { PERIODS, READ_PERMISSION, isSpentUp, periodRange, utilisation } from './limits/model';
import type { Overview, Period } from './limits/model';
import { StatusPill } from '../../ui';

const money = (locale: string, value: string): string => `${new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US').format(Number(value))} ₫`;

/**
 * NOT-04: the operations overview of the delivery of messages. For each channel the attempts of the period that ended, and the delivery rate by the formula of BR-NOT-14 — delivered and read over what ended minus what was
 * suppressed, the unknown kept in the denominator and shown apart for the operator to reconcile — with the cutoff (the end of the period) and the time it was computed. Under it, the use of the cap and of the budget of
 * each channel account. The figures move: the screen reads them again every minute.
 */
export default function OverviewScreen(props: ScreenProps) {
  // What is open belongs to one tenant: a switch starts the screen over, with a new period that ends at the new time.
  return <OverviewContent key={useSession().tenant?.id ?? 'none'} {...props} />;
}

function OverviewContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const [period, setPeriod] = useState<Period>('week');
  // The period ends when the screen is opened, so that the figures do not slide from one read to the next; changing the period starts it again.
  const range = useMemo(() => periodRange(period, new Date()), [period]);
  const overview = useOverview(range, canRead);
  const queryState = useScreenState({ isLoading: overview.isLoading, error: overview.error, data: overview.data, isEmpty: (data: unknown) => (data as Overview).channels.length === 0 && (data as Overview).accounts.length === 0 });
  const state = canRead ? queryState : 'denied';
  const day = (value: string): string => instantText(locale, value);
  const queuePath = routeById('NOT-11')?.path ?? '/not/not-11';
  const limitsPath = routeById('NOT-15')?.path ?? '/not/not-15';
  const periodLabel = (name: Period): string => (name === 'day' ? t('not.overview.period.day') : name === 'week' ? t('not.overview.period.week') : t('not.overview.period.month'));
  const data = overview.data;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.overview.page.title')}</h1>
          <p>{t('not.overview.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <div className="filters">
          <div>
            <label htmlFor="overview-period">{t('not.overview.period.label')}</label>
            <select id="overview-period" value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
              {PERIODS.map((name) => (
                <option key={name} value={name}>
                  {periodLabel(name)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <StateBoundary state={state} onRetry={() => void overview.refetch()}>
          {data === undefined ? null : (
            <>
              <p className="sub" data-formula>
                {t('not.overview.formula')}
              </p>
              <p className="sub" data-cutoff>
                {t('not.overview.cutoff', { cutoff: day(data.to), asOf: day(data.asOf) })}
              </p>
              {data.channels.length === 0 ? (
                <p className="sub" role="status">
                  {t('not.overview.channels.none')}
                </p>
              ) : (
                <div className="tablewrap">
                  <table data-channels>
                    <thead>
                      <tr>
                        <th>{t('not.overview.col.channel')}</th>
                        <th>{t('not.overview.col.delivered')}</th>
                        <th>{t('not.overview.col.read')}</th>
                        <th>{t('not.overview.col.failed')}</th>
                        <th>{t('not.overview.col.suppressed')}</th>
                        <th>{t('not.overview.col.unknown')}</th>
                        <th>{t('not.overview.col.denominator')}</th>
                        <th>{t('not.overview.col.rate')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.channels.map((row) => (
                        <tr key={row.channel} data-channel={row.channel}>
                          <td>{channelLabel(t, row.channel)}</td>
                          <td>{row.delivered}</td>
                          <td>{row.read}</td>
                          <td>{row.failed}</td>
                          <td>{row.suppressed}</td>
                          <td data-unknown>
                            {row.unknown}
                            {row.unknown > 0 ? (
                              <>
                                {' '}
                                <Link to={queuePath}>{t('not.overview.unknown.reconcile')}</Link>
                              </>
                            ) : null}
                          </td>
                          <td data-denominator>{row.denominator}</td>
                          <td data-rate>{row.rate === undefined ? t('not.overview.rate.none') : `${row.rate.toFixed(2)}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <h2>{t('not.overview.accounts.title')}</h2>
              {data.accounts.length === 0 ? (
                <p className="sub" role="status">
                  {t('not.overview.accounts.none')}
                </p>
              ) : (
                <ul data-accounts>
                  {data.accounts.map((account) => {
                    const dayShare = utilisation(account.sentToday, account.dailySendCap);
                    const monthShare = utilisation(account.spentMonthVnd, account.monthlyBudgetVnd);
                    return (
                      <li key={account.id} data-account-id={account.id} data-spent-up={isSpentUp(account) ? 'true' : 'false'}>
                        <strong>{account.displayName}</strong> · {channelLabel(t, account.channel)} · {statusLabel(t, account.status as AccountStatus)}
                        <br />
                        <span data-day-use>{account.dailySendCap === undefined ? t('not.overview.use.noCap', { sent: account.sentToday }) : t('not.overview.use.cap', { sent: account.sentToday, cap: account.dailySendCap, share: Math.floor(dayShare ?? 0) })}</span>
                        {' · '}
                        <span data-month-use>
                          {account.monthlyBudgetVnd === undefined
                            ? t('not.overview.use.noBudget', { spent: money(locale, account.spentMonthVnd) })
                            : t('not.overview.use.budget', { spent: money(locale, account.spentMonthVnd), budget: money(locale, account.monthlyBudgetVnd), share: Math.floor(monthShare ?? 0) })}
                        </span>
                        {account.heldByLimit > 0 ? (
                          <span data-held>
                            {' '}
                            <StatusPill tone="warning">{t('not.overview.use.held', { count: account.heldByLimit })}</StatusPill>
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p>
                <Link to={limitsPath}>{t('not.overview.limits.link')}</Link>
              </p>
            </>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}
