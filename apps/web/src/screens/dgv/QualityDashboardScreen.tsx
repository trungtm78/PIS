import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field, QualityPill } from './components';
import { freshnessLabel } from './labels';
import type { DatasetView } from './model';
import { NO_DASHBOARD_FILTER, useQualityDashboard } from './quality-hooks';
import type { DashboardFilter } from './quality-hooks';
import { durationLabel } from './quality-labels';
import { ageSecondsOf } from './quality-model';
import type { QualitySummary } from './quality-model';

const NEVER_EMPTY = (): boolean => false;
const SCORE_PATH = '/dgv/dgv-07';

/**
 * DGV-01: the control dashboard of data quality. Every dataset the caller may see with its badge, score, freshness and incidents, and the
 * average of the scores. A dataset that was never assessed shows "not assessed" with no score and stays out of the average; a run older than
 * the freshness SLO shows how old it is; a hard fail shows as one however high the score (ST-DGV-002, BR-DGV-01, BR-DGV-03, BR-DGV-04).
 */
export default function QualityDashboardScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filter belongs to one tenant: a switch starts the screen over.
  return <DashboardContent key={tenantId ?? 'none'} route={route} />;
}

function DashboardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DashboardFilter>(NO_DASHBOARD_FILTER);
  const [applied, setApplied] = useState<DashboardFilter>(NO_DASHBOARD_FILTER);
  const dashboard = useQualityDashboard(applied);
  const state = useScreenState({ isLoading: dashboard.isLoading, error: dashboard.error, data: dashboard.data, isEmpty: NEVER_EMPTY });
  const rows = dashboard.data?.datasets ?? [];
  const summary = dashboard.data?.summary;
  const filtering = applied.domain.trim() !== '';
  const now = Date.now();

  const apply = (event: FormEvent): void => {
    event.preventDefault();
    setApplied(draft);
  };
  const clear = (): void => {
    setDraft(NO_DASHBOARD_FILTER);
    setApplied(NO_DASHBOARD_FILTER);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.dashboard.page.title')}</h1>
          <p>{t('dgv.dashboard.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void dashboard.refetch()}>
        {summary === undefined ? null : <Tiles summary={summary} />}
        <div className="card">
          <form className="dgv-filters" role="search" onSubmit={apply} aria-label={t('dgv.dashboard.filter.title')}>
            <Field id="dashboard-domain" label={t('dgv.dashboard.filter.domain.label')} error={undefined}>
              <input id="dashboard-domain" value={draft.domain} onChange={(event) => setDraft({ domain: event.target.value })} />
            </Field>
            <div className="formfooter">
              <button type="button" onClick={clear}>
                {t('dgv.dashboard.filter.clear.action')}
              </button>
              <button type="submit" className="primary">
                {t('dgv.dashboard.filter.apply.action')}
              </button>
            </div>
          </form>
          {rows.length === 0 ? (
            <p className="muted" data-testid="empty-dashboard">
              {filtering ? t('dgv.dashboard.noMatch.text') : t('dgv.dashboard.empty.text')}
            </p>
          ) : (
            <table className="table" aria-label={t('dgv.dashboard.table.aria')}>
              <thead>
                <tr>
                  <th>{t('dgv.dashboard.dataset.column')}</th>
                  <th>{t('dgv.dashboard.domain.column')}</th>
                  <th>{t('dgv.dashboard.quality.column')}</th>
                  <th>{t('dgv.dashboard.freshness.column')}</th>
                  <th>{t('dgv.dashboard.incidents.column')}</th>
                  <th>{t('dgv.dashboard.badge.column')}</th>
                  <th>
                    <span className="sr-only">{t('dgv.dashboard.actions.column')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DatasetLine key={row.id} row={row} now={now} />
                ))}
              </tbody>
            </table>
          )}
          <p className="sub" data-testid="count">
            {t('dgv.dashboard.count.text', { count: rows.length })}
          </p>
          <p className="sub">{t('dgv.dashboard.visibility.note')}</p>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('dgv.dashboard.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The picture of the datasets: the average (which leaves out what was never assessed), the badges, the hard fails and the incidents. */
function Tiles({ summary }: { summary: QualitySummary }) {
  const { t } = useTranslation();
  const tile = (testId: string, label: string, value: string, note?: string) => (
    <div className="dgv-tile" data-testid={testId}>
      <span className="sub">{label}</span>
      <strong>{value}</strong>
      {note === undefined ? null : <span className="sub">{note}</span>}
    </div>
  );
  return (
    <div className="dgv-tiles" role="group" aria-label={t('dgv.dashboard.tiles.aria')}>
      {tile(
        'tile-average',
        t('dgv.dashboard.tile.average.label'),
        summary.averageScore ?? t('dgv.dashboard.tile.average.none'),
        summary.notAssessed === 0 ? undefined : t('dgv.dashboard.tile.average.note', { count: summary.notAssessed }),
      )}
      {tile('tile-not-assessed', t('dgv.badge.notAssessed.text'), String(summary.notAssessed))}
      {tile('tile-passed', t('dgv.badge.passed.text'), String(summary.passed))}
      {tile('tile-warning', t('dgv.badge.warning.text'), String(summary.warning))}
      {tile('tile-failed', t('dgv.badge.failed.text'), String(summary.failed), summary.hardFail === 0 ? undefined : t('dgv.dashboard.tile.hardFail.note', { count: summary.hardFail }))}
      {tile('tile-stale', t('dgv.badge.stale.text'), String(summary.stale))}
      {tile('tile-incidents', t('dgv.dashboard.tile.incidents.label'), String(summary.openIncidents), t('dgv.dashboard.tile.overdue.note', { count: summary.overdueIncidents }))}
    </div>
  );
}

function DatasetLine({ row, now }: { row: DatasetView; now: number }) {
  const { t } = useTranslation();
  const age = ageSecondsOf(row.qualityRunAt, now);
  const slo = freshnessLabel(t, row.freshnessSloSeconds);
  let freshness = t('dgv.dashboard.freshness.none.text', { slo });
  if (age !== null) freshness = row.qualityBadge === 'STALE' ? t('dgv.dashboard.freshness.stale.text', { age: durationLabel(t, age), slo }) : t('dgv.dashboard.freshness.fresh.text', { age: durationLabel(t, age), slo });
  return (
    <tr data-dataset-id={row.id} data-dataset-code={row.datasetCode} data-badge={row.qualityBadge}>
      <td>
        {row.title}
        <code className="dgv-code">{row.datasetCode}</code>
      </td>
      <td>{row.domain}</td>
      <td data-testid="score">{row.qualityScore === null ? t('dgv.dashboard.score.none') : row.qualityScore}</td>
      <td>{freshness}</td>
      <td>{t('dgv.dashboard.incidents.text', { open: row.openIncidents, overdue: row.overdueIncidents })}</td>
      <td>
        <QualityPill badge={row.qualityBadge} />
        {row.qualityHardFail === true ? <span className="pill red">{t('dgv.dashboard.hardFail.pill')}</span> : null}
      </td>
      <td className="row-actions">
        <Link to={`${SCORE_PATH}?dataset=${row.id}`}>{t('dgv.dashboard.detail.link')}</Link>
      </td>
    </tr>
  );
}
