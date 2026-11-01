import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { channelLabel } from '../conversation/labels';
import { READ_PERMISSION } from '../conversation/model';
import { useStatConversations } from './hooks';
import { PERIODS, TENANT_QUEUE, statisticsOf } from './model';
import type { Figures, Group, Period, Statistics } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

function periodLabel(t: Translator['t'], period: Period): string {
  switch (period) {
    case 'last7':
      return t('omni.stats.period.last7');
    case 'last30':
      return t('omni.stats.period.last30');
    case 'month':
      return t('omni.stats.period.month');
  }
}

/**
 * OMNI-10: statistics of the interactions (ST-OMNI-008, BR-OMNI-09, UI-OMNI-10, UAT-AC199). The rate of first replies within the deadline always comes with its denominator and its period; with no conversation that had a deadline in the
 * period it is not a rate at all, and the screen says there is no basis to compute it. Counts only: no message, contact or person is read for it.
 */
export default function StatsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is counted belongs to the queues of one member of one tenant: a switch starts the screen over.
  return <StatsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function StatsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const allowed = holds(permissions, READ_PERMISSION);
  const conversations = useStatConversations(allowed);
  const period = PERIODS.find((candidate) => candidate === params.get('period')) ?? 'last30';
  // Never empty: with nothing to count the screen still answers, that there is no basis to compute a rate.
  const state = useScreenState({ isLoading: conversations.isLoading, error: conversations.error, data: conversations.data, isEmpty: () => false });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.stats.page.title')}</h1>
          <p>{t('omni.stats.page.subtitle')}</p>
        </div>
      </div>
      {allowed ? (
        <>
          <div className="card">
            <div className="field" data-field="stats-period">
              <label htmlFor="stats-period">{t('omni.stats.period.label')}</label>
              <select id="stats-period" value={period} onChange={(event) => setParams({ period: event.target.value }, { replace: true })}>
                {PERIODS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {periodLabel(t, candidate)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <StateBoundary state={state} onRetry={() => void conversations.refetch()}>
            {conversations.data === undefined ? null : <StatisticsView stats={statisticsOf(conversations.data, period, conversations.dataUpdatedAt)} />}
          </StateBoundary>
        </>
      ) : (
        <div data-testid="stats-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('omni.stats.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function rateText(t: Translator['t'], figures: Figures): string {
  switch (figures.basis) {
    case 'computed':
      return t('omni.stats.rate.value', { rate: figures.rate ?? '' });
    case 'noBasis':
      return t('omni.stats.rate.noBasis');
    case 'unreported':
      return t('omni.stats.rate.unreported');
  }
}

function StatisticsView({ stats }: { stats: Statistics }) {
  const { t } = useTranslation();
  return (
    <>
      <section className="card" aria-label={t('omni.stats.sla.title')} data-testid="stats-sla" data-basis={stats.basis}>
        <h2>{t('omni.stats.sla.title')}</h2>
        <div className="grid">
          <div className="card metric" data-testid="stats-rate">
            <span className="sub">{t('omni.stats.rate.label')}</span>
            <div className="value">{rateText(t, stats)}</div>
            {stats.answeredInTime === null ? null : <span className="change">{t('omni.stats.rate.of', { answered: stats.answeredInTime, total: stats.denominator })}</span>}
          </div>
          <div className="card metric" data-testid="stats-denominator">
            <span className="sub">{t('omni.stats.denominator.label')}</span>
            <div className="value">{stats.denominator}</div>
          </div>
          <div className="card metric" data-testid="stats-period-range">
            <span className="sub">{t('omni.stats.range.label')}</span>
            <div className="value">{t('omni.stats.range.value', { from: stats.range.startDay, to: stats.range.endDay })}</div>
          </div>
        </div>
        <p className="sub">{t('omni.stats.formula.note')}</p>
        <p className="sub" data-testid="stats-response-pending">
          {t('omni.stats.response.pending')}
        </p>
      </section>
      <Breakdown title={t('omni.stats.channel.title')} first={t('omni.stats.column.channel')} groups={stats.byChannel} name={(key) => channelLabel(t, key)} testId="stats-by-channel" />
      <Breakdown
        title={t('omni.stats.unit.title')}
        first={t('omni.stats.column.unit')}
        groups={stats.byUnit}
        name={(key) => (key === TENANT_QUEUE ? t('omni.stats.unit.tenant') : key)}
        testId="stats-by-unit"
      />
    </>
  );
}

function Breakdown({ title, first, groups, name, testId }: { title: string; first: string; groups: Group[]; name: (key: string) => string; testId: string }) {
  const { t } = useTranslation();
  return (
    <section className="card" aria-label={title} data-testid={testId}>
      <h2>{title}</h2>
      {groups.length === 0 ? (
        <p className="sub">{t('omni.stats.none.notice')}</p>
      ) : (
        <div className="tablewrap">
          <table className="table" aria-label={title}>
            <thead>
              <tr>
                <th scope="col">{first}</th>
                <th scope="col">{t('omni.stats.column.opened')}</th>
                <th scope="col">{t('omni.stats.column.denominator')}</th>
                <th scope="col">{t('omni.stats.column.answered')}</th>
                <th scope="col">{t('omni.stats.column.rate')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.key} data-group={group.key}>
                  <th scope="row">{name(group.key)}</th>
                  <td>{group.opened}</td>
                  <td>{group.denominator}</td>
                  <td>{group.answeredInTime ?? '—'}</td>
                  <td>{group.basis === 'noBasis' ? t('omni.stats.rate.noBasis') : group.rate === null ? '—' : t('omni.stats.rate.value', { rate: group.rate })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
