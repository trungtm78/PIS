import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Banner, FigureInfo, RuleNote, momentText } from './components';
import { useAlertHealth } from './hooks';
import { kpiName, kpiNote, kpiStatusText, partText, positionText } from './labels';
import { DEFAULT_WINDOW, HEALTH_PERMISSION, STATUS_TONE, WINDOWS, figureOf, isUuid } from './model';
import type { Health, Kpi, KpiPart, PositionRow, StaleUnit, TopType } from './model';

type T = Translator['t'];

/** HOME-13: the figure of an indicator with its unit, or a dash that says why there is none. */
function Figure({ kpi, value, t }: { kpi: Pick<Kpi, 'unit'>; value: number | null; t: T }) {
  const figure = figureOf(value, kpi.unit);
  if (figure === null) return <p className="alertgov-figure"><span className="alertgov-figure__none" data-testid="figure-none">—</span></p>;
  return (
    <p className="alertgov-figure">
      <span className="alertgov-figure__value" data-testid="figure-value">{figure.number}</span>
      {figure.unit === 'HOURS' ? <span className="alertgov-figure__unit">{t('alertgov.unit.hours.text')}</span> : null}
      {figure.unit === 'PERCENT' ? <span className="alertgov-figure__unit">%</span> : null}
    </p>
  );
}

function targetText(t: T, kpi: Kpi): string | null {
  if (kpi.target === null) return t('alertgov.health.target.none');
  const value = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(kpi.target);
  const unit = kpi.unit === 'HOURS' ? ` ${t('alertgov.unit.hours.text')}` : kpi.unit === 'PERCENT' ? '%' : '';
  return kpi.direction === 'MIN' ? t('alertgov.health.target.min', { value: `${value}${unit}` }) : t('alertgov.health.target.max', { value: `${value}${unit}` });
}

function PartLine({ part, t }: { part: KpiPart; t: T }) {
  const figure = figureOf(part.value, 'COUNT');
  return (
    <li data-testid={`part-${part.key}`}>
      <span>{partText(t, part.key)}</span>
      <span>
        {figure === null ? '—' : figure.number} ({t('alertgov.health.sample.text', { count: part.sample })}) · {kpiStatusText(t, part.status)}
      </span>
    </li>
  );
}

function KpiCard({ kpi, health }: { kpi: Kpi; health: Health }) {
  const { t } = useTranslation();
  const name = kpiName(t, kpi.code);
  return (
    <div data-testid={`kpi-${kpi.code}`} data-status={kpi.status}>
      <SectionCard
        title={name}
        status={<StatusPill tone={STATUS_TONE[kpi.status]}>{kpiStatusText(t, kpi.status)}</StatusPill>}
        actions={<FigureInfo name={name} formula={kpi.formula} source={kpi.source} asOf={health.asOf} rule={health.rule} />}
      >
        <Figure kpi={kpi} value={kpi.value} t={t} />
        <ul className="alertgov-meta">
          <li>{targetText(t, kpi)}</li>
          <li>{t('alertgov.health.sample.text', { count: kpi.sample })}</li>
          {kpi.lowSample ? <li data-testid="low-sample">{t('alertgov.health.lowSample.text')}</li> : null}
          {kpi.note === null ? null : <li data-testid="kpi-note">{kpiNote(t, kpi.note)}</li>}
        </ul>
        {kpi.parts.length === 0 ? null : (
          <ul className="alertgov-parts" aria-label={t('alertgov.health.parts.label', { name })}>
            {kpi.parts.map((part) => (
              <PartLine key={part.key} part={part} t={t} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

const percent = (value: number | null): string => (value === null ? '—' : `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(value)}%`);

function HealthTables({ health }: { health: Health }) {
  const { t } = useTranslation();
  const typeColumns: DataTableColumn<TopType>[] = [
    { key: 'type', header: t('alertgov.health.types.type'), render: (row) => row.typeCode },
    { key: 'count', header: t('alertgov.health.types.count'), align: 'right', render: (row) => row.count },
    { key: 'share', header: t('alertgov.health.types.share'), align: 'right', render: (row) => percent(row.sharePct) },
    { key: 'snoozed', header: t('alertgov.health.types.snoozed'), align: 'right', render: (row) => row.snoozed },
    { key: 'rate', header: t('alertgov.health.types.rate'), align: 'right', render: (row) => (row.snoozeRatePct === null ? t('alertgov.health.types.lowSample') : percent(row.snoozeRatePct)) },
  ];
  const staleColumns: DataTableColumn<StaleUnit>[] = [
    { key: 'unit', header: t('alertgov.health.stale.unit'), render: (row) => row.unitName ?? row.unitId ?? '—' },
    { key: 'count', header: t('alertgov.health.stale.count'), align: 'right', render: (row) => row.count },
  ];
  const positionColumns: DataTableColumn<PositionRow>[] = [
    { key: 'role', header: t('alertgov.health.positions.role'), render: (row) => row.roleCode },
    { key: 'unit', header: t('alertgov.health.positions.unit'), render: (row) => row.unitName ?? row.unitId },
    { key: 'holders', header: t('alertgov.health.positions.holders'), align: 'right', render: (row) => `${row.present}/${row.holders}` },
    { key: 'state', header: t('alertgov.health.positions.state'), render: (row) => <StatusPill tone={row.state === 'UNCOVERED' ? 'danger' : row.state === 'SINGLE_POINT' ? 'warning' : 'success'}>{positionText(t, row.state)}</StatusPill> },
  ];
  return (
    <div className="alertgov-pair">
      <SectionCard title={t('alertgov.health.types.title')}>
        <DataTable<TopType> caption={t('alertgov.health.types.caption')} columns={typeColumns} rows={health.topTypes} rowKey={(row) => row.typeCode} state={health.topTypes.length === 0 ? 'empty' : 'ready'} emptyKind="none" />
      </SectionCard>
      <SectionCard title={t('alertgov.health.stale.title')}>
        <DataTable<StaleUnit> caption={t('alertgov.health.stale.caption')} columns={staleColumns} rows={health.staleByUnit} rowKey={(row) => row.unitId ?? 'none'} state={health.staleByUnit.length === 0 ? 'empty' : 'ready'} emptyKind="none" />
      </SectionCard>
      <SectionCard title={t('alertgov.health.positions.title')}>
        <DataTable<PositionRow> caption={t('alertgov.health.positions.caption')} columns={positionColumns} rows={health.positions} rowKey={(row) => row.key} state={health.positions.length === 0 ? 'empty' : 'ready'} emptyKind="none" />
      </SectionCard>
    </div>
  );
}

/**
 * HOME-13: the health of the alert system (G2-10). Fourteen indicators, each with its figure, its target, its status and its sample, and the "i" with its formula, its source, the moment it is as of and the version of the rule whose targets it is judged by
 * (starting values nobody confirmed say so). A figure that cannot be computed shows why, never zero. The page says when the job that records the items is older than two passes. The window and the unit are chosen here; the server
 * answers for the units the reader may read.
 */
export default function HealthScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <HealthContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HealthContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const [days, setDays] = useState<number>(DEFAULT_WINDOW);
  const [unit, setUnit] = useState('');
  const mayRead = permissions === undefined || permissions.includes(HEALTH_PERMISSION);
  const unitId = isUuid(unit) ? unit : undefined;
  const health = useAlertHealth(days, unitId, mayRead);
  const queryState = useScreenState({ isLoading: health.isLoading, error: health.data === undefined ? health.error : undefined, data: health.data, isEmpty: () => false });
  const state = mayRead ? queryState : 'denied';
  const data = health.data;
  const units = new Map<string, string>();
  for (const row of data?.positions ?? []) units.set(row.unitId, row.unitName ?? row.unitId);
  for (const row of data?.staleByUnit ?? []) if (row.unitId !== null) units.set(row.unitId, row.unitName ?? row.unitId);
  if (unitId !== undefined && !units.has(unitId)) units.set(unitId, unitId);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('alertgov.health.title')}</h1>
          <p>{t('alertgov.health.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('alertgov.ctx.scope'), value: tenant?.name ?? t('alertgov.ctx.scopeAll') },
          { label: t('alertgov.ctx.window'), value: t('alertgov.health.window.option', { days }) },
          ...(unitId === undefined ? [] : [{ label: t('alertgov.ctx.unit'), value: units.get(unitId) ?? unitId }]),
        ]}
        {...(data === undefined ? {} : { asOf: momentText(data.asOf), stale: data.stale })}
      />
      <FilterPanel>
        <div className="field">
          <label htmlFor="alertgov-window">{t('alertgov.health.window.label')}</label>
          <select id="alertgov-window" value={days} onChange={(event) => setDays(Number(event.target.value))} data-testid="window">
            {WINDOWS.map((one) => (
              <option key={one} value={one}>
                {t('alertgov.health.window.option', { days: one })}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="alertgov-unit">{t('alertgov.health.unit.label')}</label>
          <select id="alertgov-unit" value={unit} onChange={(event) => setUnit(event.target.value)} data-testid="unit">
            <option value="">{t('alertgov.health.unit.all')}</option>
            {[...units.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void health.refetch()}>
        {data === undefined ? null : (
          <>
            {data.stale ? (
              <Banner tone="warning" testId="stale-banner">
                <strong>{t('alertgov.health.stale.banner')}</strong>
                <span>{data.lastPassAt === null ? t('alertgov.health.stale.never') : t('alertgov.health.stale.since', { time: momentText(data.lastPassAt) })}</span>
              </Banner>
            ) : null}
            {health.isError ? (
              <Banner tone="danger" role="alert" testId="refresh-failed">
                <span>{t('alertgov.health.refresh.failed')}</span>
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void health.refetch()}>
                  {t('alertgov.common.retry.action')}
                </button>
              </Banner>
            ) : null}
            <RuleNote rule={data.rule} />
            <p className="alertgov-sub" data-testid="items-summary">
              {t('alertgov.health.items.summary', { window: data.items.inWindow, open: data.items.open })}
            </p>
            <div className="alertgov-grid" role="list" aria-label={t('alertgov.health.kpis.label')}>
              {data.kpis.map((kpi) => (
                <div role="listitem" key={kpi.code}>
                  <KpiCard kpi={kpi} health={data} />
                </div>
              ))}
            </div>
            <HealthTables health={data} />
          </>
        )}
      </StateBoundary>
    </section>
  );
}
