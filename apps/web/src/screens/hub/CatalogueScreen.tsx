import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, KpiStrip, KpiTile, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { AcceptanceBadge, KpiInfo, StatusBadge, OutcomePill, refusalText } from './components';
import { useCaptureSnapshot, useConnectors, useHealth } from './hooks';
import { STATUSES, ageParts, healthyLabel, vietnamDateTime, word } from './model';
import { RegistrySection } from './RegistrySection';
import type { Summary } from './model';
import './hub.css';

/**
 * HUB-01, the catalogue of every connection to an outside system with its health (HUB-1): one list for e-GP, the Treasury, the national codes and every connector that is registered later, with the direction, the
 * protocols, the status (healthy, stale, failing, disabled, waiting for the outside, never run), the age of the data and the last run. The figures of the hub (healthy share, oldest data, failed runs, differences and
 * mappings waiting) have the "i" of the KPI register. A connector that waits for the other side is shown as such and is not counted in the healthy share.
 */
export default function CatalogueScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <CatalogueContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CatalogueContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const list = useConnectors();
  const health = useHealth();
  const capture = useCaptureSnapshot();
  const data = list.data;
  const state = useScreenState({ isLoading: list.isLoading, error: data === undefined ? list.error : undefined, data, isEmpty: (value) => (value as { items: unknown[] }).items.length === 0 });
  const refreshFailed = list.isError && data !== undefined;
  const summary = data?.summary;
  const kpis = health.data?.kpis ?? [];
  const info = (code: string) => {
    const found = kpis.find((one) => one.code === code);
    return found === undefined ? null : <KpiInfo kpi={found} />;
  };
  const share = summary === undefined ? undefined : healthyLabel(summary);
  const age = ageParts(summary?.oldest_data_age_hours ?? null);

  const columns: DataTableColumn<Summary>[] = [
    {
      key: 'connector',
      header: t('scr2.hub.cat.col.connector'),
      pinned: true,
      render: (row) => (
        <>
          <Link to={`/hub/hub-02?code=${encodeURIComponent(row.code)}`} data-testid={`connector-${row.code}`}>
            <strong>{row.code}</strong>
          </Link>
          <div>{row.name}</div>
        </>
      ),
    },
    { key: 'direction', header: t('hub.cat.col.direction'), render: (row) => t(`hub.direction.${word(row.direction)}`) },
    { key: 'protocols', header: t('hub.cat.col.protocols'), render: (row) => row.protocols.join(', ') + (row.planned_protocols.length === 0 ? '' : ` (${t('hub.cat.planned')}: ${row.planned_protocols.join(', ')})`) },
    {
      key: 'status',
      header: t('scr2.hub.cat.col.health'),
      render: (row) => (
        <>
          <StatusBadge status={row.status} />
          {row.alert === null ? null : <div className="hub-muted">{t(`hub.alert.${word(row.alert.code)}`)}</div>}
        </>
      ),
    },
    { key: 'external', header: t('scr2.hub.cat.col.external'), render: (row) => <AcceptanceBadge acceptance={row.acceptance} /> },
    {
      key: 'age',
      header: t('hub.cat.col.age'),
      render: (row) => {
        const parts = ageParts(row.age_hours);
        return parts === null ? <span className="hub-muted">{t('hub.age.none')}</span> : t(`hub.age.${parts.unit}`, { value: parts.value });
      },
    },
    {
      key: 'last',
      header: t('hub.cat.col.lastRun'),
      render: (row) => (row.last_run_at === null ? <span className="hub-muted">{t('hub.run.never')}</span> : <>{vietnamDateTime(row.last_run_at)} {row.last_run_outcome === null ? null : <OutcomePill outcome={row.last_run_outcome} />}</>),
    },
    {
      key: 'problems',
      header: t('hub.cat.col.problems'),
      align: 'right',
      render: (row) => t('hub.cat.problems', { failed: row.failed_runs_7d, differences: row.discrepancy_backlog, mappings: row.pending_mappings }),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('hub.cat.page.title')}</h1>
          <p>{t('hub.cat.page.subtitle')}</p>
        </div>
        <button type="button" className="ui-button ui-button--outline" data-testid="capture-snapshot" disabled={capture.isPending} onClick={() => capture.mutate({})}>
          {t('hub.cat.capture')}
        </button>
      </div>
      <ContextBar items={[{ label: t('hub.cat.context.scope'), value: tenant?.name ?? '–' }]} {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })} stale={refreshFailed} />
      {capture.isSuccess ? (
        <p className="callout" role="status" data-testid="capture-receipt">
          {t('hub.cat.capture.done')}
        </p>
      ) : null}
      {capture.isError ? (
        <p className="callout" role="alert" data-testid="capture-error">
          {refusalText(t, capture.error)}
        </p>
      ) : null}
      <h2 className="hub-kpi-title">{t('scr2.hub.cat.kpi.title')}</h2>
      <KpiStrip label={t('hub.cat.kpi.label')}>
        <KpiTile
          label={t('hub.cat.kpi.healthy')}
          value={share?.value ?? '–'}
          {...(share?.value === '–' ? {} : { unit: '%' })}
          sub={
            <>
              {share === undefined ? null : t('hub.cat.kpi.healthy.sub', { of: share.of })} {info('HUB_CONNECTORS_HEALTHY_PCT')}
            </>
          }
          state={list.isLoading ? 'loading' : 'ready'}
        />
        <KpiTile
          label={t('hub.cat.kpi.oldest')}
          value={age === null ? '–' : age.value}
          {...(age === null ? {} : { unit: t(`hub.age.unit.${age.unit}`) })}
          sub={<>{summary?.oldest_data_connector ?? t('hub.age.none')} {info('HUB_OLDEST_DATA_AGE_DAYS')}</>}
          state={list.isLoading ? 'loading' : 'ready'}
        />
        <KpiTile
          label={t('hub.cat.kpi.failed')}
          value={String(summary?.failed_runs_7d ?? '–')}
          tone={(summary?.failed_runs_7d ?? 0) > 0 ? 'danger' : 'default'}
          sub={<>{t('hub.cat.kpi.failed.sub')} {info('HUB_FAILED_RUNS_7D')}</>}
          state={list.isLoading ? 'loading' : 'ready'}
        />
        <KpiTile
          label={t('hub.cat.kpi.backlog')}
          value={String(summary?.discrepancy_backlog ?? '–')}
          sub={<>{t('hub.cat.kpi.backlog.sub')} {info('HUB_DISCREPANCY_BACKLOG')}</>}
          state={list.isLoading ? 'loading' : 'ready'}
        />
        <KpiTile
          label={t('hub.cat.kpi.mappings')}
          value={String(summary?.pending_mappings ?? '–')}
          sub={<>{t('hub.cat.kpi.mappings.sub')} {info('HUB_PENDING_MAPPINGS')}</>}
          state={list.isLoading ? 'loading' : 'ready'}
        />
      </KpiStrip>
      {summary?.hub_alert === null || summary === undefined ? null : (
        <p className="callout" role="alert" data-testid="hub-alert">
          {t('hub.cat.hubAlert', { stale: summary.counts.STALE, monitored: summary.monitored })}
        </p>
      )}
      <SectionCard
        title={t('hub.cat.section.connectors')}
        status={summary === undefined ? undefined : <span className="hub-muted">{STATUSES.map((status) => `${t(`hub.status.${word(status)}`)}: ${summary.counts[status]}`).join(' · ')}</span>}
      >
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {data !== undefined && <DataTable caption={t('hub.cat.table.caption')} columns={columns} rows={data.items} rowKey={(row) => row.code} />}
        </StateBoundary>
      </SectionCard>
      {data === undefined ? null : <RegistrySection items={data.items} />}
      <p className="hub-links">
        <Link to="/hub/hub-03">{t('hub.cat.link.incidents')}</Link>
      </p>
      <p className="prototype-note">{t('hub.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
