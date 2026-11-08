import { useId } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { AlertCard, EmptyReason, GoLink, LastYearText, OutlookText, RagPill, ReasonList, useWords } from './components';
import { DASHBOARD_ATTENTION, DIMENSIONS, PATH, dayText, directivePath, rowsOf } from './model';
import type { Attention, Dimension, Row, Tracker, Unit, Workspace } from './model';

/** The province in one card: the plan, what was disbursed, the same period of last year, the curve the year is expected to follow and the gap to it, and the band the year is expected to close in. */
export function ProvinceCard({ row }: { row: Row }) {
  const { t } = useTranslation();
  const words = useWords();
  return (
    <SectionCard title={t('ban.dash.province.title')} unit={t('ban.dash.unit.vnd')} status={<RagPill rag={row.rag} />}>
      <dl className="ban-facts" data-testid="province">
        <div>
          <dt>{t('ban.dash.fact.plan')}</dt>
          <dd data-testid="province-plan">{words.vnd(row.plan_vnd)}</dd>
        </div>
        <div>
          <dt>{t('ban.dash.fact.disbursed')}</dt>
          <dd data-testid="province-disbursed">{words.vnd(row.disbursed_vnd)}</dd>
        </div>
        <div>
          <dt>{t('ban.dash.fact.rate')}</dt>
          <dd data-testid="province-rate">{words.pct(row.rate_pct)}</dd>
        </div>
        <div>
          <dt>{t('ban.dash.fact.expected')}</dt>
          <dd data-testid="province-expected">{words.pct(row.expected_pct)}</dd>
        </div>
        <div>
          <dt>{t('ban.dash.fact.gap')}</dt>
          <dd data-testid="province-gap">{row.gap_points === null ? words.none : t('ban.dash.fact.gapPoints', { points: words.points(row.gap_points) })}</dd>
        </div>
        <div>
          <dt>{t('ban.dash.fact.lastYear')}</dt>
          <dd data-testid="province-last-year">
            <LastYearText row={row} />
          </dd>
        </div>
        <div>
          <dt>{t('ban.dash.fact.change')}</dt>
          <dd data-testid="province-change">{words.vnd(row.change_vs_last_year_vnd)}</dd>
        </div>
        <div>
          <dt>{t('ban.dash.fact.outlook')}</dt>
          <dd data-testid="province-outlook">
            <OutlookText outlook={row.outlook} />
          </dd>
        </div>
        <div>
          <dt>{t('ban.dash.fact.attention')}</dt>
          <dd data-testid="province-attention">{row.attention_projects}</dd>
        </div>
      </dl>
      {row.unknown_lines > 0 ? (
        <p className="callout warning" role="status" data-testid="province-unknown">
          {t('ban.dash.unknownLines.text', { count: row.unknown_lines })}
        </p>
      ) : null}
    </SectionCard>
  );
}

const TAB_ORDER: readonly Dimension[] = DIMENSIONS;

/** The four cuts of the province, one table at a time: a row never shows a colour alone, an unknown amount is "no data", and last year says how many lines have it when only some do. */
export function DimensionTabs({ workspace, dimension, filtered, onChoose }: { workspace: Pick<Workspace, 'by_sector' | 'by_district' | 'by_investor' | 'by_fund_source'>; dimension: Dimension; filtered: boolean; onChoose: (dimension: Dimension) => void }) {
  const { t } = useTranslation();
  const words = useWords();
  const panel = useId();
  const rows = rowsOf(workspace, dimension);
  const label = (one: Dimension): string => (one === 'sector' ? t('ban.dash.tab.sector') : one === 'district' ? t('ban.dash.tab.district') : one === 'investor' ? t('ban.dash.tab.investor') : t('ban.dash.tab.fundSource'));
  const heading = dimension === 'sector' ? t('ban.dash.col.sector') : dimension === 'district' ? t('ban.dash.col.district') : dimension === 'investor' ? t('ban.dash.col.investor') : t('ban.dash.col.fundSource');
  const columns: DataTableColumn<Row>[] = [
    { key: 'label', header: heading, pinned: true, render: (row) => <strong>{row.label}</strong> },
    { key: 'projects', header: t('ban.dash.col.projects'), align: 'right', render: (row) => row.projects },
    { key: 'plan', header: t('ban.dash.col.plan'), align: 'right', render: (row) => words.vnd(row.plan_vnd) },
    { key: 'disbursed', header: t('ban.dash.col.disbursed'), align: 'right', render: (row) => words.vnd(row.disbursed_vnd) },
    { key: 'rate', header: t('ban.dash.col.rate'), align: 'right', render: (row) => words.pct(row.rate_pct) },
    { key: 'expected', header: t('ban.dash.col.expected'), align: 'right', render: (row) => words.pct(row.expected_pct) },
    { key: 'gap', header: t('ban.dash.col.gap'), align: 'right', render: (row) => (row.gap_points === null ? words.none : words.points(row.gap_points)) },
    { key: 'rag', header: t('ban.dash.col.status'), render: (row) => <RagPill rag={row.rag} /> },
    { key: 'lastYear', header: t('ban.dash.col.lastYear'), align: 'right', render: (row) => <LastYearText row={row} /> },
    { key: 'outlook', header: t('ban.dash.col.outlook'), render: (row) => <OutlookText outlook={row.outlook} /> },
    { key: 'attention', header: t('ban.dash.col.attention'), align: 'right', render: (row) => row.attention_projects },
    { key: 'unknown', header: t('ban.dash.col.unknown'), align: 'right', render: (row) => row.unknown_lines },
  ];
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const target = TAB_ORDER[(next + TAB_ORDER.length) % TAB_ORDER.length];
    if (target !== undefined) onChoose(target);
  };
  return (
    <SectionCard title={t('ban.dash.cuts.title')} unit={t('ban.dash.unit.vnd')}>
      <div className="ban-tabs" role="tablist" aria-label={t('ban.dash.cuts.aria')}>
        {TAB_ORDER.map((one, index) => (
          <button
            key={one}
            type="button"
            role="tab"
            id={`${panel}-${one}`}
            className="ui-button ui-button--outline ban-tab"
            aria-selected={one === dimension}
            aria-controls={panel}
            tabIndex={one === dimension ? 0 : -1}
            data-tab={one}
            onClick={() => onChoose(one)}
            onKeyDown={(event) => onKey(event, index)}
          >
            {label(one)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panel} aria-labelledby={`${panel}-${dimension}`} data-testid="cut-panel" data-dimension={dimension}>
        {rows.length === 0 ? (
          <EmptyReason text={filtered ? t('ban.dash.cuts.emptyFiltered.text') : t('ban.dash.cuts.empty.text')} testId="cut-empty" />
        ) : (
          <DataTable caption={t('ban.dash.cuts.caption', { cut: label(dimension) })} columns={columns} rows={rows} rowKey={(row) => `${row.dimension}:${row.key}`} />
        )}
      </div>
    </SectionCard>
  );
}

/** The few projects at the top of the list the head needs to look at, each with its reasons, and the way on to the whole list. */
export function AttentionTop({ items, total, noData }: { items: readonly Attention[]; total: number; noData: boolean }) {
  const { t } = useTranslation();
  const words = useWords();
  const shown = items.slice(0, DASHBOARD_ATTENTION);
  const columns: DataTableColumn<Attention>[] = [
    { key: 'rank', header: t('ban.att.col.rank'), align: 'right', render: (item) => item.rank },
    {
      key: 'project',
      header: t('ban.att.col.project'),
      pinned: true,
      render: (item) => (
        <span>
          <strong>{item.code}</strong> {item.name}
        </span>
      ),
    },
    { key: 'reasons', header: t('ban.att.col.reasons'), render: (item) => <ReasonList signals={item.signals} /> },
    { key: 'exposure', header: t('ban.att.col.exposure'), align: 'right', render: (item) => words.vnd(item.exposure_vnd) },
    { key: 'score', header: t('ban.att.col.score'), align: 'right', render: (item) => words.num(item.score) },
  ];
  return (
    <SectionCard title={t('ban.dash.attention.title')} status={<StatusPill tone={total > 0 ? 'warning' : 'success'}>{t('ban.dash.attention.count', { count: total })}</StatusPill>} actions={<GoLink to={PATH.attention} label={t('ban.dash.attention.all')} testId="go-attention" />}>
      {shown.length === 0 ? (
        <EmptyReason text={noData ? t('ban.dash.attention.noData.text') : t('ban.dash.attention.none.text')} testId="attention-empty" />
      ) : (
        <DataTable caption={t('ban.dash.attention.caption')} columns={columns} rows={[...shown]} rowKey={(item) => item.project_id} />
      )}
    </SectionCard>
  );
}

/** The units that have not reported, and why; when every unit reports the card says so, and when there are no units in the data it says that instead. */
export function UnitsBlock({ units }: { units: readonly Unit[] }) {
  const { t } = useTranslation();
  const words = useWords();
  const late = units.filter((unit) => unit.not_reporting);
  const reasonText = (unit: Unit): string => (unit.reason === 'NEVER_REPORTED' ? t('ban.unit.reason.never') : unit.reason === 'STALE' ? t('ban.unit.reason.stale') : unit.reason === 'LOW_RATE' ? t('ban.unit.reason.lowRate') : t('ban.unit.reason.none'));
  const columns: DataTableColumn<Unit>[] = [
    { key: 'unit', header: t('ban.unit.col.unit'), pinned: true, render: (unit) => <strong>{unit.unit_name}</strong> },
    { key: 'received', header: t('ban.unit.col.received'), align: 'right', render: (unit) => t('ban.unit.received.text', { received: unit.received, expected: unit.expected }) },
    { key: 'rate', header: t('ban.unit.col.rate'), align: 'right', render: (unit) => words.pct(unit.reporting_rate_pct) },
    { key: 'last', header: t('ban.unit.col.last'), render: (unit) => (unit.last_reported_on === null ? t('ban.unit.last.never') : t('ban.unit.last.text', { day: dayText(unit.last_reported_on), days: unit.days_since_report ?? 0 })) },
    { key: 'why', header: t('ban.unit.col.why'), render: (unit) => <StatusPill tone="warning" icon="○">{reasonText(unit)}</StatusPill> },
  ];
  return (
    <SectionCard title={t('ban.dash.units.title')} status={<StatusPill tone={late.length > 0 ? 'warning' : 'success'}>{t('ban.dash.units.count', { count: late.length })}</StatusPill>}>
      {late.length === 0 ? (
        <EmptyReason text={units.length === 0 ? t('ban.dash.units.noUnits.text') : t('ban.dash.units.allReporting.text', { count: units.length })} testId="units-empty" />
      ) : (
        <DataTable caption={t('ban.dash.units.caption')} columns={columns} rows={late} rowKey={(unit) => unit.unit_id} />
      )}
    </SectionCard>
  );
}

/** The alerts that are live, read only here; they are acknowledged on their own screen. */
export function AlertsBlock({ alerts }: { alerts: Workspace['alerts'] }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('ban.dash.alerts.title')} status={<StatusPill tone={alerts.length > 0 ? 'warning' : 'success'}>{t('ban.dash.alerts.count', { count: alerts.length })}</StatusPill>} actions={<GoLink to={PATH.alerts} label={t('ban.dash.alerts.all')} testId="go-alerts" />}>
      {alerts.length === 0 ? (
        <EmptyReason text={t('ban.dash.alerts.none.text')} testId="alerts-empty" />
      ) : (
        <div className="ban-alerts" data-testid="alerts-live">
          {alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

/** The directives the committee gave: how many are open, overdue and escalated, the units with the oldest overdue, and the way on to the tracker. */
export function DirectiveSummary({ tracker }: { tracker: Tracker }) {
  const { t } = useTranslation();
  const worst = tracker.units.filter((unit) => unit.overdue > 0).slice(0, 3);
  return (
    <SectionCard title={t('ban.dash.directives.title')} actions={<GoLink to={PATH.tracker} label={t('ban.dash.directives.all')} testId="go-tracker" />}>
      <div className="ban-summary" data-testid="directive-summary">
        <div className="ban-summary__item">
          <span>{t('ban.trk.total.open')}</span>
          <strong>{tracker.totals.open}</strong>
        </div>
        <div className="ban-summary__item">
          <span>{t('ban.trk.total.overdue')}</span>
          <strong>{tracker.totals.overdue}</strong>
        </div>
        <div className="ban-summary__item">
          <span>{t('ban.trk.total.escalated')}</span>
          <strong>{tracker.totals.escalated}</strong>
        </div>
      </div>
      {tracker.totals.open === 0 ? (
        <EmptyReason text={t('ban.dash.directives.none.text')} testId="directives-empty" />
      ) : worst.length === 0 ? (
        <p role="status">{t('ban.dash.directives.onTime.text')}</p>
      ) : (
        <ul className="ban-sections" data-testid="directive-worst">
          {worst.map((unit) => (
            <li key={unit.unit_id}>{t('ban.dash.directives.unit.text', { unit: unit.unit_name, overdue: unit.overdue, days: unit.oldest_overdue_days ?? 0 })}</li>
          ))}
        </ul>
      )}
      {tracker.directives.length === 0 ? null : (
        <p className="ban-muted">
          {t('ban.dash.directives.oldest.text')}{' '}
          <Link to={directivePath(tracker.directives[0]?.id ?? '')}>{tracker.directives[0]?.code}</Link>
        </p>
      )}
    </SectionCard>
  );
}
