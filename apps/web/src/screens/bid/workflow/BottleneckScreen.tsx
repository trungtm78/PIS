import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FlowChart, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import { Figure, PATHS, WorkflowFilters } from './components';
import { useExportReport, useStatistics } from './hooks';
import { errorText, methodLabel } from './labels';
import { appliedCount, billions, filtersOf, fullDay, shortDay, vietnamDay, vietnamTime } from './model';
import type { Filters, StatisticsDto } from './model';
import './workflow.css';

/**
 * BID-30, "Bottleneck analysis and report" (PRC-1): for the steps that packages left in the period, the median days and the share that finished within the standard; the packages that have been in their step longest; and
 * the report of the period as a file. Days are working days where the calendar is published, and the table says when they are calendar days.
 */
export default function BottleneckScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <BottleneckContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function save(file: { file_name: string; content_type: string; content_base64: string }): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const bytes = Uint8Array.from(atob(file.content_base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.content_type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.file_name;
  link.click();
  URL.revokeObjectURL(url);
}

function BottleneckContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant } = useSession();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersOf(search), [search]);
  const stats = useStatistics(filters);
  const exporter = useExportReport();
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: stats.isLoading, error: stats.data === undefined ? stats.error : undefined, data: stats.data, isEmpty: (data) => (data as StatisticsDto).steps.length === 0 && (data as StatisticsDto).stuck.length === 0 });
  const data = stats.data;
  const asOfDay = data === undefined ? '' : fullDay(vietnamDay(data.as_of));
  const asOf = data === undefined ? undefined : `${asOfDay} ${vietnamTime(data.as_of)}`;
  const stale = stats.isError && data !== undefined;
  const loading = state === 'loading';

  const change = (next: Filters): void => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value !== undefined) params.set(key, String(value));
    setSearch(params);
  };
  const run = (format: 'xlsx' | 'csv'): void => {
    setReceipt(undefined);
    exporter.mutate({ filters, format }, { onSuccess: (file) => { save(file); setReceipt(t('prc1.analysis.export.done', { name: file.file_name })); } });
  };

  const rows = data?.steps ?? [];
  const series = [{ label: t('prc1.analysis.chart.median'), style: 'actual' as const, points: rows.filter((row) => row.median_days !== null).map((row) => ({ x: row.step_name ?? row.step_code, y: row.median_days ?? 0 })) }];
  const percent = (share: number | null): string => (share === null ? t('prc1.column.none.text') : `${(Math.round(share * 10_000) / 100).toLocaleString(locale, { maximumFractionDigits: 2 })}%`);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prc1.analysis.page.title')}</h1>
          <p>{t('prc1.analysis.page.subtitle')}</p>
        </div>
        <div className="actions prc1-actions">
          <button type="button" className="ui-button ui-button--outline" disabled={exporter.isPending} onClick={() => run('xlsx')}>
            {t('prc1.analysis.export.xlsx')}
          </button>
          <button type="button" className="ui-button ui-button--outline" disabled={exporter.isPending} onClick={() => run('csv')}>
            {t('prc1.analysis.export.csv')}
          </button>
        </div>
      </div>
      <p className="prc1-nav"><Link to={PATHS.tree}>{t('prc1.analysis.back.link')}</Link></p>
      <ContextBar items={[{ label: t('prc1.context.scope.label'), value: tenant?.name ?? t('prc1.column.none.text') }, { label: t('prc1.context.period.label'), value: data === undefined ? t('prc1.column.none.text') : `${shortDay(data.period.from)} – ${shortDay(data.period.to)}` }]} unit={t('prc1.unit.billion.name')} {...(asOf === undefined ? {} : { asOf })} stale={stale} />
      <WorkflowFilters filters={filters} onChange={change} period updatedAt={asOf} />
      {receipt !== undefined && <p className="callout prc1-receipt" role="status">{receipt}</p>}
      {exporter.isError && <p className="callout" role="alert">{errorText(t, exporter.error)}</p>}
      <KpiStrip label={t('prc1.kpi.group.label')}>
        <KpiTile state={loading ? 'loading' : 'ready'} label={t('prc1.kpi.onTime.label')} value={data === undefined ? '' : percent(data.kpis.on_time_share)} sub={<Figure kind="onTime" asOf={asOfDay} />} />
        <KpiTile state={loading ? 'loading' : 'ready'} label={t('prc1.kpi.median.label')} value={data === undefined || data.kpis.median_days === null ? t('prc1.column.none.text') : String(data.kpis.median_days)} unit={data === undefined || data.kpis.median_days === null ? undefined : t('prc1.kpi.days.unit')} sub={<><Figure kind="median" asOf={asOfDay} />{data !== undefined && data.kpis.basis === 'CALENDAR_DAYS' && <span className="sub"> {t('prc1.overview.calendar.text')}</span>}</>} />
        <KpiTile state={loading ? 'loading' : 'ready'} label={t('prc1.kpi.visits.label')} value={data === undefined ? '' : String(data.kpis.completed_visits)} />
      </KpiStrip>
      <StateBoundary state={state === 'denied' || state === 'signedOut' || state === 'offline' || state === 'error' ? state : state === 'empty' ? 'empty' : 'default'} onRetry={() => void stats.refetch()}>
        {data !== undefined && (
          <>
            {data.truncated && <p className="callout" role="status">{t('prc1.truncated.text')}</p>}
            <SectionCard title={t('prc1.analysis.steps.title')}>
              <FlowChart series={series} unit={t('prc1.kpi.days.unit')} caption={t('prc1.analysis.chart.caption')} state={series[0]?.points.length === 0 ? 'empty' : 'ready'} />
              <DataTable
                caption={t('prc1.analysis.table.caption')}
                columns={[
                  { key: 'method', header: t('prc1.filter.method.label'), render: (row) => methodLabel(t, row.method) },
                  { key: 'step', header: t('prc1.column.step.label'), render: (row) => row.step_name ?? row.step_code },
                  { key: 'visits', header: t('prc1.analysis.column.visits'), align: 'right', render: (row) => row.completed_visits },
                  { key: 'median', header: t('prc1.analysis.column.median'), align: 'right', render: (row) => (row.median_days === null ? t('prc1.column.none.text') : `${row.median_days}${row.basis === 'CALENDAR_DAYS' ? ` (${t('prc1.analysis.calendar.mark')})` : ''}`) },
                  { key: 'onTime', header: t('prc1.analysis.column.onTime'), align: 'right', render: (row) => percent(row.on_time_share) },
                  { key: 'open', header: t('prc1.analysis.column.open'), align: 'right', render: (row) => row.open_visits },
                  { key: 'over', header: t('prc1.analysis.column.over'), align: 'right', render: (row) => (row.over_standard > 0 ? <StatusPill tone="warning" icon="⚠">{row.over_standard}</StatusPill> : row.over_standard) },
                ]}
                rows={rows}
                rowKey={(row) => `${row.method}:${row.step_code}`}
                emptyKind={appliedCount(filters) > 0 ? 'filtered' : 'noPeriod'}
                onClearFilters={() => change({})}
              />
            </SectionCard>
            <SectionCard title={t('prc1.analysis.stuck.title')}>
              <DataTable
                caption={t('prc1.analysis.stuck.caption')}
                columns={[
                  { key: 'package', header: t('prc1.column.package.label'), pinned: true, render: (row) => <Link to={`${PATHS.package}?package=${row.package_id}`}>{row.package_code}</Link> },
                  { key: 'title', header: t('prc1.analysis.column.title'), render: (row) => row.title ?? '' },
                  { key: 'step', header: t('prc1.column.step.label'), render: (row) => row.step_name ?? row.step_code },
                  { key: 'days', header: t('prc1.analysis.column.days'), align: 'right', render: (row) => `${row.days}${row.basis === 'CALENDAR_DAYS' ? ` (${t('prc1.analysis.calendar.mark')})` : ''}` },
                  { key: 'value', header: t('prc1.column.value.label'), align: 'right', render: (row) => billions(row.value_vnd, locale) },
                  { key: 'owner', header: t('prc1.column.owner.label'), render: (row) => row.owner_name ?? t('prc1.column.noOwner.text') },
                  { key: 'late', header: t('prc1.analysis.column.late'), render: (row) => (row.late ? <StatusPill tone="danger" icon="⛔">{t('ui.processTree.health.late')}</StatusPill> : '') },
                ]}
                rows={data.stuck}
                rowKey={(row) => row.package_id}
                severity={(row) => (row.late ? 'ACTION' : null)}
                emptyKind="none"
              />
            </SectionCard>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('prc1.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

