import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, FilterPanel, PresentButton, PresentationMode } from '../../ui';
import type { PresentationBoard } from '../../ui';
import { useEdition } from '../../editions/EditionContext';
import { clockText } from '../home/overview-model';
import { AlertsBlock, AttentionTop, DimensionTabs, DirectiveSummary, ProvinceCard, UnitsBlock } from './dashboard-parts';
import { ChangesBlock, FeedNotice, FigureTile, PolicyNotice, Guarded } from './components';
import { useWorkspace } from './hooks';
import { FILTER_KEYS, NO_FILTERS, PERMISSION, appliedCount, dayText, dimensionOf, filtersFrom, optionsOf, toFigures } from './model';
import type { Dimension, FilterKey, Filters, Row, Workspace } from './model';

/** The rows the options of the filters are made from: those of the last answer that was not narrowed, so choosing one value does not hide the others. */
function useOptionRows(data: Workspace | undefined, filters: Filters): Pick<Workspace, 'by_sector' | 'by_district' | 'by_investor' | 'by_fund_source'> {
  const kept = useRef<Pick<Workspace, 'by_sector' | 'by_district' | 'by_investor' | 'by_fund_source'>>({ by_sector: [], by_district: [], by_investor: [], by_fund_source: [] });
  if (data !== undefined && appliedCount(filters) === 0) kept.current = { by_sector: data.by_sector, by_district: data.by_district, by_investor: data.by_investor, by_fund_source: data.by_fund_source };
  return kept.current;
}

function FilterSelect({ id, label, value, rows, allLabel, onChange }: { id: string; label: string; value: string; rows: readonly Row[]; allLabel: string; onChange: (value: string) => void }) {
  return (
    <label htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allLabel}</option>
        {optionsOf(rows, value).map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * BAN-01, the workspace of the head of the committee: the headline figures with their "i", the province against its plan, against the same period of last year and against the curve the year is expected to follow, the year-end
 * band, the cuts by sector, district, investor and funding source, what changed since last week, the projects that need the head, the units that do not report, the alerts and the directives. Every figure is the text the API wrote;
 * what is not known is said so and is never 0; the filters are in the address, and the view is written to the audit of views by the server, once for each time the screen is opened or narrowed.
 */
export default function DashboardScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <Guarded route={route} permission={PERMISSION.read} title={t('ban.dash.page.title')} subtitle={t('ban.dash.page.subtitle')}>
      <DashboardContent />
    </Guarded>
  );
}

function DashboardContent() {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const filters = filtersFrom(params);
  const dimension = dimensionOf(params.get('view'));
  const query = useWorkspace(filters);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const optionRows = useOptionRows(data, filters);
  const applied = appliedCount(filters);

  const change = (next: Filters, view: Dimension = dimension): void => {
    const target = new URLSearchParams();
    for (const key of FILTER_KEYS) if (next[key] !== '') target.set(key, next[key]);
    if (view !== 'sector') target.set('view', view);
    setParams(target);
  };
  const setFilter = (key: FilterKey, value: string): void => change({ ...filters, [key]: value });
  const [presenting, setPresenting] = useState(false);
  const LeaderPanel = useEdition().slots?.leaderPanel;
  // The boards of the presentation at a meeting: the figures only, the filters and the buttons of the page stay behind.
  const boards: PresentationBoard[] =
    data === undefined
      ? []
      : [
          {
            id: 'figures',
            title: t('ban.present.figures.title'),
            content: (
              <>
                <section className="ban-figures" aria-label={t('ban.dash.figures.aria')}>
                  {toFigures(data.figures).map((tile) => (
                    <FigureTile key={tile.metricCode} tile={tile} />
                  ))}
                </section>
                <ProvinceCard row={data.province} />
              </>
            ),
          },
          { id: 'dimension', title: t('ban.present.dimension.title'), content: <DimensionTabs workspace={data} dimension={dimension} filtered={applied > 0} onChoose={() => undefined} /> },
          {
            id: 'attention',
            title: t('ban.present.attention.title'),
            content: (
              <>
                <ChangesBlock changes={data.changes} />
                <AttentionTop items={data.attention} total={data.attention_total} noData={data.feed.empty} />
              </>
            ),
          },
          {
            id: 'watch',
            title: t('ban.present.watch.title'),
            content: (
              <>
                <UnitsBlock units={data.units} />
                <AlertsBlock alerts={data.alerts} />
                <DirectiveSummary tracker={data.directives} />
              </>
            ),
          },
          ...(LeaderPanel === undefined
            ? []
            : [
                { id: 'leader-rates', title: t('home.present.leaderRates.title'), content: <LeaderPanel part="rates" /> },
                { id: 'leader-tiles', title: t('home.present.leaderTiles.title'), content: <LeaderPanel part="tiles" /> },
              ]),
        ];

  return (
    <>
      <ContextBar
        items={[
          { label: t('ban.dash.context.scope'), value: tenant?.name ?? '–' },
          { label: t('ban.dash.context.year'), value: data === undefined ? '–' : String(data.fiscal_year) },
          { label: t('ban.dash.context.asOf'), value: data === undefined ? '–' : dayText(data.as_of) },
        ]}
        unit={t('ban.dash.unit.vnd')}
        {...(query.dataUpdatedAt > 0 ? { asOf: clockText(query.dataUpdatedAt) } : {})}
        stale={query.isError && data !== undefined}
      />
      {data === undefined ? null : (
        <>
          <PolicyNotice policy={data.policy} />
          <FeedNotice feed={data.feed} />
        </>
      )}
      <div className="ban-actions">
        <PresentButton onOpen={() => setPresenting(true)} disabled={data === undefined} />
      </div>
      {presenting && boards.length > 0 ? <PresentationMode title={t('ban.present.page.title')} boards={boards} onExit={() => setPresenting(false)} /> : null}
      {data === undefined || LeaderPanel === undefined ? null : <LeaderPanel part="all" />}
      <FilterPanel
        applied={applied}
        actions={
          applied === 0 ? undefined : (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="filters-clear" onClick={() => change(NO_FILTERS)}>
              {t('ban.dash.filter.clear')}
            </button>
          )
        }
      >
        <div className="ban-filters">
          <FilterSelect id="ban-filter-sector" label={t('ban.dash.filter.sector')} value={filters.sector_code} rows={optionRows.by_sector} allLabel={t('ban.dash.filter.all')} onChange={(value) => setFilter('sector_code', value)} />
          <FilterSelect id="ban-filter-district" label={t('ban.dash.filter.district')} value={filters.district_code} rows={optionRows.by_district} allLabel={t('ban.dash.filter.all')} onChange={(value) => setFilter('district_code', value)} />
          <FilterSelect id="ban-filter-investor" label={t('ban.dash.filter.investor')} value={filters.investor_unit_id} rows={optionRows.by_investor} allLabel={t('ban.dash.filter.all')} onChange={(value) => setFilter('investor_unit_id', value)} />
          <FilterSelect id="ban-filter-fund" label={t('ban.dash.filter.fundSource')} value={filters.fund_source_code} rows={optionRows.by_fund_source} allLabel={t('ban.dash.filter.all')} onChange={(value) => setFilter('fund_source_code', value)} />
        </div>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data === undefined ? null : (
          <>
            <section className="ban-figures" aria-label={t('ban.dash.figures.aria')} data-testid="figures">
              {toFigures(data.figures).map((tile) => (
                <FigureTile key={tile.metricCode} tile={tile} />
              ))}
            </section>
            <ProvinceCard row={data.province} />
            <DimensionTabs workspace={data} dimension={dimension} filtered={applied > 0} onChoose={(view) => change(filters, view)} />
            <ChangesBlock changes={data.changes} />
            <AttentionTop items={data.attention} total={data.attention_total} noData={data.feed.empty} />
            <UnitsBlock units={data.units} />
            <AlertsBlock alerts={data.alerts} />
            <DirectiveSummary tracker={data.directives} />
          </>
        )}
      </StateBoundary>
    </>
  );
}
