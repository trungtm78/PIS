import { ApiError } from '@machvon/api-client';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { ContextBar, DataTable, FilterPanel, InfoFormula, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { useUnits } from '../../adm/members/hooks';
import { useContractorOptions, useProjectOptions } from '../hooks';
import { momentText } from '../kit';
import { statusLabel, typeLabel } from '../labels';
import { CONTRACT_STATUSES, CONTRACT_TYPES } from '../model';
import type { ContractStatus, ContractType } from '../model';
import { useExportReport, useFactSnapshots } from './hooks';
import type { ExportFormat } from './hooks';
import { columnLabel, definitionText, groupLabel, indicatorName, infoLabels, levelLabel, reasonText } from './labels';
import { barLength, breakdownPoints, camel, chartColumn, dateText, decimalText, filterCount, healthTone, moneyText, percentText } from './model';
import type { AnalyticsContext, AnalyticsFilter, AnalyticsQuery, Cell, ColumnView, Definition, IndicatorValue, ReportCode, ReportFile, ReportView, RowView } from './model';
import './analytics.css';

type Translate = ReturnType<typeof useTranslation>['t'];

// ---- the context of a number --------------------------------------------------------------------------------------------------------------------------------

export interface ReportContextProps {
  context: AnalyticsContext;
  updatedAt?: number;
  /** Read the newest revision of the period of a stale snapshot. */
  onUseLatest?: (periodCode: string) => void;
}

/** The ContextBar of every number of the portfolio: scope, period or day, cut-off day, unit, freshness; a stale snapshot says which revision it is and which is the newest. */
export function ReportContext({ context, updatedAt, onUseLatest }: ReportContextProps) {
  const { t } = useTranslation();
  const { snapshot } = context.freshness;
  const stale = context.freshness.stale;
  const period = snapshot === null ? t('ca1.ctx.period.live', { date: dateText(context.asOf) }) : t('ca1.ctx.period.snapshot', { period: snapshot.periodCode, revision: snapshot.revision });
  const freshness = snapshot === null ? t('ca1.ctx.fresh.live') : stale ? t('ca1.ctx.fresh.stale') : t('ca1.ctx.fresh.latest');
  const partial = context.rows !== null && context.ledgerRows !== null && context.ledgerRows < context.rows;
  return (
    <>
      <ContextBar
        items={[
          { label: t('ca1.ctx.scope'), value: context.scope === 'PROVINCE' ? t('ca1.ctx.scope.province') : t('ca1.ctx.scope.granted') },
          { label: t('ca1.ctx.period'), value: period },
          { label: t('ca1.ctx.cutoff'), value: context.cutoffDate === null ? t('ca1.ctx.cutoff.none') : dateText(context.cutoffDate) },
          { label: t('ca1.ctx.freshness'), value: freshness },
        ]}
        unit={t('w2pay.ctx.unit')}
        stale={stale}
        {...(updatedAt === undefined || updatedAt <= 0 ? {} : { asOf: momentText(updatedAt) })}
      />
      {stale && snapshot !== null ? (
        <p className="callout warning ca1-notice" role="status" data-testid="stale-notice">
          {t('ca1.stale.notice', { period: snapshot.periodCode, revision: snapshot.revision, latest: snapshot.latestRevision })}{' '}
          {onUseLatest === undefined ? null : (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onUseLatest(snapshot.periodCode)}>
              {t('ca1.stale.useLatest')}
            </button>
          )}
        </p>
      ) : null}
      {partial ? (
        <p className="callout ca1-notice" role="status" data-testid="partial-notice">
          {t('ca1.partial.notice', { ledger: context.ledgerRows ?? 0, rows: context.rows ?? 0 })}
        </p>
      ) : null}
    </>
  );
}

// ---- the "i" of a figure --------------------------------------------------------------------------------------------------------------------------------------

/** The "i" of a figure: the definition the server sent (and its Vietnamese words when the screen has them), opened in the control of the kit. */
export function Info({ definition, asOf }: { definition: Definition | undefined; asOf: string }) {
  const { t } = useTranslation();
  if (definition === undefined) return null;
  const name = indicatorName(t, definition);
  return (
    <InfoFormula
      name={name}
      formula={definitionText(t, definition, 'formula') ?? definition.formula}
      numerator={definitionText(t, definition, 'numerator')}
      denominator={definitionText(t, definition, 'denominator')}
      exclusions={definition.nullPolicy === '' ? undefined : [definitionText(t, definition, 'nullPolicy') ?? definition.nullPolicy]}
      source={definition.sourceTables.join(', ')}
      asOf={asOf}
      owner={t('ca1.info.owner.value')}
      version={t('ca1.info.version.value')}
      unverified={definition.code === 'HHI' || definition.code === 'TOP_N_SHARE' || definition.code === 'SINGLE_BIDDER_RATE'}
      labels={infoLabels(t, name)}
    />
  );
}

export const definitionOf = (definitions: readonly Definition[], code: string | null): Definition | undefined => (code === null ? undefined : definitions.find((definition) => definition.code === code));

// ---- figures ---------------------------------------------------------------------------------------------------------------------------------------------

/** The unit word of a figure of an indicator, for a KPI tile. */
export function indicatorText(t: Translate, locale: string, definition: Definition | undefined, value: IndicatorValue): string {
  if (value.value === null) return '—';
  switch (definition?.unit) {
    case 'PERCENT':
      return percentText(value.value, locale);
    case 'VND':
      return moneyText(value.value, locale);
    case 'DAYS':
      return t('ca1.unit.days', { count: value.value });
    default:
      return locale === 'vi' ? value.value.replace('.', ',') : value.value;
  }
}

function lockOr(t: Translate, reason: string | undefined): ReactNode {
  if (reason === 'LEDGER_DENIED') {
    return (
      <span className="ca1-denied" data-testid="ledger-denied">
        <span aria-hidden="true">{'🔒'}</span> {reasonText(t, reason)}
      </span>
    );
  }
  return (
    <span className="ca1-na" data-testid="not-applicable">
      {reason === undefined ? '—' : reasonText(t, reason)}
    </span>
  );
}

/** A cell of a report by the kind of its column: a figure as the language writes it, or why there is none (never zero). */
export function cellNode(t: Translate, locale: string, column: ColumnView, value: Cell, reason: string | undefined): ReactNode {
  if (value === null) return lockOr(t, reason);
  switch (column.kind) {
    case 'MONEY':
      return moneyText(String(value), locale);
    case 'PERCENT':
      return percentText(String(value), locale);
    case 'DAYS':
      return t('ca1.unit.days', { count: String(value) });
    case 'DATE':
      return dateText(String(value));
    case 'FLAG':
      return value === 1 || value === '1' ? t('ca1.flag.yes') : t('ca1.flag.no');
    case 'RAG':
      return <StatusPill tone={healthTone(String(value))}>{levelLabel(t, String(value))}</StatusPill>;
    case 'COUNT':
      return String(value);
    case 'INDEX':
      return decimalText(String(value), locale);
    default:
      if (column.key === 'contract_status') return statusLabelOf(t, String(value));
      if (column.key === 'match_status' || column.key === 'recovery_status') return groupLabel(t, column.key, String(value));
      if (column.key === 'payment_clock') return t(`ca1.clock.${camel(String(value))}`);
      if (column.key === 'age_bucket') return groupLabel(t, 'age_bucket', String(value));
      return String(value);
  }
}

const statusLabelOf = (t: Translate, status: string): string => ((CONTRACT_STATUSES as readonly string[]).includes(status) ? statusLabel(t, status as ContractStatus) : status);

// ---- the table ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface ReportTableProps {
  view: ReportView;
  /** What makes the first column a link, when the screen has somewhere to go. */
  linkOf?: (row: RowView) => ReactNode;
  page: { from: number; to: number; total: number; size: number; index: number; onPage: (index: number) => void; onSize: (size: number) => void };
  caption: string;
}

/** The table of a report, with the totals row the server made (never added up here): the ratio columns of the total carry the "i" of their indicator. */
export function ReportTable({ view, linkOf, page, caption }: ReportTableProps) {
  const { t, locale } = useTranslation();
  const asOf = view.context.freshness.snapshot === null ? view.context.asOf : (view.context.freshness.snapshot.asOfDate || view.context.asOf);
  const columns: DataTableColumn<RowView>[] = view.columns.map((column, position) => ({
    key: column.key,
    header: columnLabel(t, column.key),
    align: ['MONEY', 'PERCENT', 'DAYS', 'COUNT', 'INDEX'].includes(column.kind) ? 'right' : 'left',
    pinned: position === 0,
    render: (row) => (position === 0 && linkOf !== undefined ? linkOf(row) : cellNode(t, locale, column, row.cells[column.key] ?? null, row.na[column.key])),
  }));
  const totals: Record<string, ReactNode> = {};
  for (const column of view.columns) {
    if (column.total === null) continue;
    const value = view.totals.cells[column.key] ?? null;
    const definition = definitionOf(view.definitions, column.indicator);
    totals[column.key] = (
      <span className="ca1-total">
        {cellNode(t, locale, column, value, view.totals.na[column.key])}
        {column.total === 'RATIO' ? <Info definition={definition} asOf={asOf} /> : null}
      </span>
    );
  }
  return <DataTable caption={caption} columns={columns} rows={view.items} rowKey={(row) => row.contractId} rowAttrs={(row) => ({ 'data-contract-id': row.contractId })} totalsLabel={t('ca1.table.totals')} totals={totals} page={page} />;
}

// ---- the figures above the table -----------------------------------------------------------------------------------------------------------------------

/** The tiles of a report: how many contracts, the first total in money, and the indicators the server judged for the whole of them (each with its "i"). */
export function ReportKpis({ view }: { view: ReportView }) {
  const { t, locale } = useTranslation();
  const asOf = view.context.asOf;
  const money = view.columns.find((column) => column.kind === 'MONEY' && column.total === 'SUM');
  const moneyValue = money === undefined ? null : (view.totals.cells[money.key] ?? null);
  return (
    <KpiStrip label={t('ca1.kpi.label')}>
      <KpiTile label={t('ca1.kpi.contracts')} value={String(view.totals.rows)} />
      {money === undefined ? null : (
        <KpiTile
          label={columnLabel(t, money.key)}
          value={moneyValue === null ? '—' : moneyText(String(moneyValue), locale)}
          unit={moneyValue === null ? undefined : t('w2pay.ctx.unit')}
          sub={moneyValue === null ? lockOr(t, view.totals.na[money.key]) : undefined}
        />
      )}
      {view.totals.indicators.map((indicator) => {
        const definition = definitionOf(view.definitions, indicator.code);
        return (
          <KpiTile
            key={indicator.code}
            label={definition === undefined ? indicator.code : indicatorName(t, definition)}
            value={indicatorText(t, locale, definition, indicator)}
            sub={
              <span className="ca1-kpi-sub">
                {indicator.value === null && indicator.reason !== null ? <span data-testid="kpi-reason">{reasonText(t, indicator.reason)}</span> : null}
                <Info definition={definition} asOf={asOf} />
              </span>
            }
          />
        );
      })}
    </KpiStrip>
  );
}

/** The groups of every breakdown of a report as bars: the bar is the total of the column of the group, written beside it as text (a bar alone says nothing). A group with no figure is not drawn as zero. */
export function BreakdownBars({ view }: { view: ReportView }) {
  const breakdowns = view.breakdowns.length > 0 ? view.breakdowns : view.breakdown === null ? [] : [view.breakdown];
  return (
    <>
      {breakdowns.map((breakdown, index) => (
        <BreakdownChart key={breakdown.dimension} view={view} dimension={breakdown.dimension} testId={index === 0 ? 'breakdown' : `breakdown-${breakdown.dimension}`} />
      ))}
    </>
  );
}

function BreakdownChart({ view, dimension, testId }: { view: ReportView; dimension: string; testId: string }) {
  const { t, locale } = useTranslation();
  const column = chartColumn(view, dimension);
  const titleId = useId();
  if (column === undefined) return null;
  const points = breakdownPoints(view, column.key, dimension);
  if (points.length === 0) return null;
  const largest = Math.max(1, ...points.map((point) => Math.abs(barLength(String(point.text)))));
  return (
    <SectionCard title={t('ca1.chart.title', { column: columnLabel(t, column.key) })}>
      <ul className="ca1-bars" aria-labelledby={titleId} data-testid={testId}>
        <li id={titleId} className="ui-sr-only">
          {t('ca1.chart.caption', { dimension: t(`ca1.dimension.${camel(dimension)}`) })}
        </li>
        {points.map((point) => (
          <li key={point.key} className="ca1-bars__row">
            <span className="ca1-bars__label">{groupLabel(t, dimension, point.key)}</span>
            <span className="ca1-bars__track" aria-hidden="true">
              <span className="ca1-bars__bar" style={{ width: `${Math.round((Math.abs(point.value) / largest) * 100)}%` }} />
            </span>
            <span className="ca1-bars__value">{moneyText(String(point.text), locale)}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/** The definitions of the figures of a report, each with its "i": the formula the number is made by is one tap away from the number. */
export function DefinitionsList({ definitions, asOf }: { definitions: readonly Definition[]; asOf: string }) {
  const { t } = useTranslation();
  if (definitions.length === 0) return null;
  return (
    <SectionCard title={t('ca1.definitions.title')}>
      <ul className="ca1-defs" data-testid="definitions">
        {definitions.map((definition) => (
          <li key={definition.code}>
            <strong>{indicatorName(t, definition)}</strong>
            <Info definition={definition} asOf={asOf} />
            <span className="sub">{definitionText(t, definition, 'formula')}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ---- the filters -------------------------------------------------------------------------------------------------------------------------------------------------

export interface FiltersProps {
  value: AnalyticsFilter;
  onChange: (next: AnalyticsFilter) => void;
  sort: string;
  direction: 'asc' | 'desc';
  sortKeys: readonly string[];
  onSort: (sort: string, direction: 'asc' | 'desc') => void;
  /** The periods that have a frozen fact (a live reading when none is chosen). */
  showPeriod?: boolean;
  showSort?: boolean;
  updatedAt?: string;
  actions?: ReactNode;
}

/** The filters of the portfolio and the reports: every one is sent to the server, none is applied to the rows in the browser. */
export function AnalyticsFilters({ value, onChange, sort, direction, sortKeys, onSort, showPeriod = true, showSort = true, updatedAt, actions }: FiltersProps) {
  const { t } = useTranslation();
  const units = useUnits(true);
  const projects = useProjectOptions(true);
  const contractors = useContractorOptions(true);
  const snapshots = useFactSnapshots(showPeriod);
  const periods = [...new Set((snapshots.data ?? []).map((snapshot) => snapshot.periodCode))];
  const set = (patch: Partial<AnalyticsFilter>): void => onChange({ ...value, ...patch });
  const id = useId();
  return (
    <FilterPanel applied={filterCount(value)} unitLabel={t('w2pay.ctx.unit')} {...(updatedAt === undefined ? {} : { updatedAt })} {...(actions === undefined ? {} : { actions })}>
      <form className="ca1-filters" role="search" aria-label={t('ctr.list.filters.title')} onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label htmlFor={`${id}-q`}>{t('ctr.list.query.label')}</label>
          <input id={`${id}-q`} value={value.q} onChange={(event) => set({ q: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-unit`}>{t('ca1.filter.unit')}</label>
          <select id={`${id}-unit`} value={value.unit} onChange={(event) => set({ unit: event.target.value })}>
            <option value="">{t('ca1.filter.all')}</option>
            {(units.data ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.code} · {unit.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-project`}>{t('ca1.filter.project')}</label>
          <select id={`${id}-project`} value={value.project} onChange={(event) => set({ project: event.target.value })}>
            <option value="">{t('ca1.filter.all')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-contractor`}>{t('ca1.filter.contractor')}</label>
          <select id={`${id}-contractor`} value={value.contractor} onChange={(event) => set({ contractor: event.target.value })}>
            <option value="">{t('ca1.filter.all')}</option>
            {(contractors.data ?? []).map((contractor) => (
              <option key={contractor.id} value={contractor.id}>
                {contractor.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-status`}>{t('ctr.list.status.label')}</label>
          <select id={`${id}-status`} value={value.status} onChange={(event) => set({ status: event.target.value })}>
            <option value="">{t('ctr.list.status.all')}</option>
            {CONTRACT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(t, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-type`}>{t('ca1.filter.type')}</label>
          <select id={`${id}-type`} value={value.type} onChange={(event) => set({ type: event.target.value })}>
            <option value="">{t('ca1.filter.all')}</option>
            {CONTRACT_TYPES.map((type) => (
              <option key={type} value={type}>
                {typeLabel(t, type as ContractType)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-fund`}>{t('ca1.filter.fund')}</label>
          <input id={`${id}-fund`} value={value.fund} placeholder="00000000-0000-0000-0000-000000000000" onChange={(event) => set({ fund: event.target.value.trim() })} />
        </div>
        {showPeriod ? (
          <>
            <div className="field">
              <label htmlFor={`${id}-period`}>{t('ca1.filter.period')}</label>
              <select id={`${id}-period`} value={value.period} onChange={(event) => set({ period: event.target.value, asOf: event.target.value === '' ? value.asOf : '' })}>
                <option value="">{t('ca1.filter.period.live')}</option>
                {periods.map((period) => (
                  <option key={period} value={period}>
                    {period}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-asof`}>{t('ca1.filter.asOf')}</label>
              <input id={`${id}-asof`} type="date" value={value.asOf} disabled={value.period !== ''} onChange={(event) => set({ asOf: event.target.value })} />
            </div>
          </>
        ) : null}
        {showSort ? (
          <>
            <div className="field">
              <label htmlFor={`${id}-sort`}>{t('ca1.filter.sort')}</label>
              <select id={`${id}-sort`} value={sort} onChange={(event) => onSort(event.target.value, direction)}>
                {sortKeys.map((key) => (
                  <option key={key} value={key}>
                    {columnLabel(t, key)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-dir`}>{t('ca1.filter.direction')}</label>
              <select id={`${id}-dir`} value={direction} onChange={(event) => onSort(sort, event.target.value === 'desc' ? 'desc' : 'asc')}>
                <option value="asc">{t('ca1.filter.direction.asc')}</option>
                <option value="desc">{t('ca1.filter.direction.desc')}</option>
              </select>
            </div>
          </>
        ) : null}
      </form>
    </FilterPanel>
  );
}

// ---- the export -----------------------------------------------------------------------------------------------------------------------------------------------

/** Gives the browser the file the server made. Where the browser has no object URLs the file is not offered, and the screen says it was made. */
export function offerFile(file: ReportFile, decode: (content: string) => Uint8Array): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const bytes = decode(file.contentBase64);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mediaType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const FORMATS: ReadonlyArray<ExportFormat> = ['xlsx', 'csv', 'pdf'];

export function ExportBar({ code, query, decode }: { code: ReportCode; query: AnalyticsQuery; decode: (content: string) => Uint8Array }) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const exporter = useExportReport(code);
  const error = exporter.error;
  const message =
    error === null || error === undefined
      ? null
      : error instanceof ApiError && error.code === 'EXPORT_ROW_CAP_EXCEEDED'
        ? t('ca1.export.tooLarge')
        : error instanceof ApiError && error.status === 403
          ? t('ca1.export.denied')
          : t('ca1.export.failed');
  return (
    <div className="ca1-export" role="group" aria-label={t('ca1.export.label')}>
      {FORMATS.map((format) => (
        <button
          key={format}
          type="button"
          className="ui-button ui-button--outline ui-button--small"
          disabled={exporter.isPending || mode === 'READ_ONLY'}
          onClick={() =>
            exporter.mutate(
              { format, query },
              { onSuccess: (file) => void offerFile(file, decode) },
            )
          }
        >
          {t(`ca1.export.${format}`)}
        </button>
      ))}
      {exporter.isPending ? (
        <span role="status" className="sub">
          {t('ca1.export.working')}
        </span>
      ) : null}
      {exporter.isSuccess ? (
        <span role="status" className="sub" data-testid="export-done">
          {t('ca1.export.done', { name: exporter.data.fileName, rows: exporter.data.rowCount })}
          {exporter.data.stale ? (
            <>
              {' '}
              <StatusPill tone="warning">{t('ca1.export.stale')}</StatusPill>
            </>
          ) : null}
        </span>
      ) : null}
      {message === null ? null : (
        <span role="alert" className="field-error" data-testid="export-error">
          {message}
        </span>
      )}
    </div>
  );
}
