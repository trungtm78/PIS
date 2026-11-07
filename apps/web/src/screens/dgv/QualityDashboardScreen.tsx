import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn, Tone } from '../../ui';
import { Field, QualityPill } from './components';
import { freshnessLabel } from './labels';
import type { DatasetView } from './model';
import { NO_DASHBOARD_FILTER, useQualityDashboard } from './quality-hooks';
import type { DashboardFilter } from './quality-hooks';
import { durationLabel } from './quality-labels';
import { ageSecondsOf } from './quality-model';
import type { QualitySummary } from './quality-model';
import './dgv-kit.css';

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
  const tenant = useSession().tenant;
  const [draft, setDraft] = useState<DashboardFilter>(NO_DASHBOARD_FILTER);
  const [applied, setApplied] = useState<DashboardFilter>(NO_DASHBOARD_FILTER);
  const dashboard = useQualityDashboard(applied);
  const state = useScreenState({ isLoading: dashboard.isLoading, error: dashboard.error, data: dashboard.data, isEmpty: NEVER_EMPTY });
  const rows = dashboard.data?.datasets ?? [];
  const summary = dashboard.data?.summary;
  const filtering = applied.domain.trim() !== '';
  const now = Date.now();
  const columns = datasetColumns(t, now);

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
      <ContextBar
        items={[
          { label: t('dgv.dashboard.ctx.scope'), value: tenant?.name ?? t('dgv.dashboard.ctx.scope.all') },
          { label: t('dgv.dashboard.ctx.datasets'), value: String(rows.length) },
        ]}
        {...(dashboard.dataUpdatedAt > 0 ? { asOf: new Date(dashboard.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <StateBoundary state={state} onRetry={() => void dashboard.refetch()}>
        {summary === undefined ? null : <Tiles summary={summary} />}
        <FilterPanel applied={filtering ? 1 : 0}>
          <form className="dgv-filters" role="search" onSubmit={apply} aria-label={t('dgv.dashboard.filter.title')}>
            <Field id="dashboard-domain" label={t('dgv.dashboard.filter.domain.label')} error={undefined}>
              <input id="dashboard-domain" value={draft.domain} onChange={(event) => setDraft({ domain: event.target.value })} />
            </Field>
            <div className="formfooter">
              <button type="button" className="ui-button ui-button--outline" onClick={clear}>
                {t('dgv.dashboard.filter.clear.action')}
              </button>
              <button type="submit" className="ui-button ui-button--primary">
                {t('dgv.dashboard.filter.apply.action')}
              </button>
            </div>
          </form>
        </FilterPanel>
        <SectionCard title={t('dgv.dashboard.section.title')}>
          {rows.length === 0 ? (
            <p className="muted" data-testid="empty-dashboard">
              {filtering ? t('dgv.dashboard.noMatch.text') : t('dgv.dashboard.empty.text')}
            </p>
          ) : (
            <DataTable caption={t('dgv.dashboard.table.aria')} columns={columns} rows={rows} rowKey={(row) => row.id} />
          )}
          <p className="sub" data-testid="count">
            {t('dgv.dashboard.count.text', { count: rows.length })}
          </p>
          <p className="sub">{t('dgv.dashboard.visibility.note')}</p>
        </SectionCard>
      </StateBoundary>
      <p className="prototype-note">{t('dgv.dashboard.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The picture of the datasets: the average (which leaves out what was never assessed), the badges, the hard fails and the incidents. */
function Tiles({ summary }: { summary: QualitySummary }) {
  const { t } = useTranslation();
  const tile = (testId: string, label: string, value: string, tone: Tone, note?: string) => (
    <div data-testid={testId} className="dgv-tile-slot">
      <KpiTile label={label} value={value} tone={tone} {...(note === undefined ? {} : { sub: note })} />
    </div>
  );
  return (
    <KpiStrip label={t('dgv.dashboard.tiles.aria')}>
      {tile(
        'tile-average',
        t('dgv.dashboard.tile.average.label'),
        summary.averageScore ?? t('dgv.dashboard.tile.average.none'),
        'info',
        summary.notAssessed === 0 ? undefined : t('dgv.dashboard.tile.average.note', { count: summary.notAssessed }),
      )}
      {tile('tile-not-assessed', t('dgv.badge.notAssessed.text'), String(summary.notAssessed), 'neutral')}
      {tile('tile-passed', t('dgv.badge.passed.text'), String(summary.passed), 'success')}
      {tile('tile-warning', t('dgv.badge.warning.text'), String(summary.warning), 'warning')}
      {tile('tile-failed', t('dgv.badge.failed.text'), String(summary.failed), 'danger', summary.hardFail === 0 ? undefined : t('dgv.dashboard.tile.hardFail.note', { count: summary.hardFail }))}
      {tile('tile-stale', t('dgv.badge.stale.text'), String(summary.stale), 'warning')}
      {tile('tile-incidents', t('dgv.dashboard.tile.incidents.label'), String(summary.openIncidents), 'info', t('dgv.dashboard.tile.overdue.note', { count: summary.overdueIncidents }))}
    </KpiStrip>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** The columns of the table: the dataset (title and code) stays pinned; the badge is a pill with the hard fail beside it. */
function datasetColumns(t: Translate, now: number): DataTableColumn<DatasetView>[] {
  return [
    {
      key: 'dataset',
      header: t('dgv.dashboard.dataset.column'),
      pinned: true,
      render: (row) => (
        <>
          {row.title}
          <code className="dgv-code">{row.datasetCode}</code>
        </>
      ),
    },
    { key: 'domain', header: t('dgv.dashboard.domain.column'), render: (row) => row.domain },
    { key: 'quality', header: t('dgv.dashboard.quality.column'), align: 'right', render: (row) => (row.qualityScore === null ? t('dgv.dashboard.score.none') : row.qualityScore) },
    { key: 'freshness', header: t('dgv.dashboard.freshness.column'), render: (row) => freshnessText(t, row, now) },
    { key: 'incidents', header: t('dgv.dashboard.incidents.column'), render: (row) => t('dgv.dashboard.incidents.text', { open: row.openIncidents, overdue: row.overdueIncidents }) },
    {
      key: 'badge',
      header: t('dgv.dashboard.badge.column'),
      render: (row) => (
        <div className="dgv-badges">
          <QualityPill badge={row.qualityBadge} />
          {row.qualityHardFail === true ? <StatusPill tone="danger">{t('dgv.dashboard.hardFail.pill')}</StatusPill> : null}
        </div>
      ),
    },
    { key: 'actions', header: t('dgv.dashboard.actions.column'), render: (row) => <Link to={`${SCORE_PATH}?dataset=${row.id}`}>{t('dgv.dashboard.detail.link')}</Link> },
  ];
}

function freshnessText(t: Translate, row: DatasetView, now: number): string {
  const age = ageSecondsOf(row.qualityRunAt, now);
  const slo = freshnessLabel(t, row.freshnessSloSeconds);
  if (age === null) return t('dgv.dashboard.freshness.none.text', { slo });
  return row.qualityBadge === 'STALE' ? t('dgv.dashboard.freshness.stale.text', { age: durationLabel(t, age), slo }) : t('dgv.dashboard.freshness.fresh.text', { age: durationLabel(t, age), slo });
}
