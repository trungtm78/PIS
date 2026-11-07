import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { SectionCard, StatusPill } from '../../../ui';
import ConcentrationScreen from './ConcentrationScreen';
import { ReportPage } from './ReportPage';
import type { TableReport } from './ReportPage';
import { useFactSnapshots } from './hooks';
import { reportLead, reportTitle } from './labels';
import { REPORT_CODES, REPORT_PATHS, REPORT_PERMISSION, dateText, isReportCode } from './model';
import './analytics.css';

/**
 * CTR-28: the hub of the reports of the contract portfolio: every report of the catalogue (R1 to R7 and R14) with what it is for, and the frozen periods with the revision of each, its cut-off day and whether a newer
 * revision replaced it. A report named in the address (`?report=schedule-delay`) opens in place: the five reports that have no screen of their own are opened this way.
 */
export default function HubScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  const named = params.get('report');
  const key = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  if (isReportCode(named)) {
    return named === 'contractor-concentration' ? <ConcentrationScreen key={key} route={route} /> : <ReportPage key={key} route={route} code={named as TableReport} />;
  }
  return <HubContent key={key} route={route} />;
}

function HubContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const allowed = permissions === undefined || permissions.includes(REPORT_PERMISSION);
  const snapshots = useFactSnapshots(allowed);
  const listed = snapshots.data ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ca1.hub.title')}</h1>
          <p>{t('ca1.hub.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={allowed ? 'default' : 'denied'}>
        <ul className="ca1-hub" data-testid="report-list">
          {REPORT_CODES.map((code) => (
            <li key={code} className="ca1-hub__card" data-report={code}>
              <h2>{reportTitle(t, code)}</h2>
              <p className="sub">{reportLead(t, code)}</p>
              <Link className="ui-button ui-button--outline ui-button--small" to={REPORT_PATHS[code]} aria-label={t('ca1.hub.open', { name: reportTitle(t, code) })}>
                {t('ca1.hub.openShort')}
              </Link>
            </li>
          ))}
        </ul>
        <SectionCard title={t('ca1.hub.periods')}>
          {snapshots.isLoading ? (
            <p className="sub" role="status" aria-busy="true">
              {t('states.loading.label')}
            </p>
          ) : snapshots.isError ? (
            <p className="callout warning" role="alert" data-testid="periods-error">
              {t('ca1.hub.periods.error')}{' '}
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void snapshots.refetch()}>
                {t('ui.common.retry')}
              </button>
            </p>
          ) : listed.length === 0 ? (
            <p className="callout" role="status" data-testid="periods-empty">
              {t('ca1.hub.periods.empty')}
            </p>
          ) : (
            <ul className="ca1-periods" data-testid="periods">
              {listed.map((snapshot) => (
                <li key={snapshot.id} data-snapshot-id={snapshot.id}>
                  <strong>{snapshot.periodCode}</strong> · {t('ca1.hub.periods.revision', { revision: snapshot.revision })} · {t('ca1.ctx.cutoff')}: {dateText(snapshot.cutoffDate)}{' '}
                  {snapshot.stale ? (
                    <StatusPill tone="warning">{t('ca1.hub.periods.stale', { latest: snapshot.latestRevision })}</StatusPill>
                  ) : (
                    <StatusPill tone="success">{t('ca1.hub.periods.latest')}</StatusPill>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <p className="sub">
          {t('ca1.trend.note')} <Link to="/bi/bi-09">{t('ca1.trend.link')}</Link>
        </p>
      </StateBoundary>
      <p className="prototype-note">{t('ctr.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
