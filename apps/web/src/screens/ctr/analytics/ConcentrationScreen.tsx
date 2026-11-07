import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { AnalyticsFilters, ExportBar, Info, ReportContext } from './components';
import { useConcentration } from './hooks';
import { dimensionLabel, figureText, levelLabel, reportLead, reportTitle } from './labels';
import { DEFAULT_QUERY, EMPTY_ANALYTICS_FILTER, REPORT_PERMISSION, bytesOfBase64, filterCount, levelTone, moneyText, percentText } from './model';
import type { AnalyticsFilter, ContractorLoadView, Definition, DimensionView } from './model';
import './analytics.css';

/**
 * CTR-31: the concentration and load of the contractors (R14). For the investor, the unit, the fund source and the contractor: the share of the largest groups and the HHI of the value of the contracts in force (a joint
 * venture counted by the shares of its parties), the single-bidder rate, and for each contractor its active value and what was awarded and not yet contracted. The thresholds are the ones of the rule
 * `CONTRACT_CONCENTRATION` (unverified configuration, said on the screen); below the minimum number of contracts the level is "not enough data", never green.
 */
export default function ConcentrationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ConcentrationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

const definitionOf = (definitions: readonly Definition[], code: string): Definition | undefined => definitions.find((definition) => definition.code === code);

function ConcentrationContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const allowed = permissions === undefined || permissions.includes(REPORT_PERMISSION);
  const [filter, setFilter] = useState<AnalyticsFilter>(EMPTY_ANALYTICS_FILTER);
  const query = { ...DEFAULT_QUERY, filter };
  const read = useConcentration(query, allowed);
  const view = read.data;
  const state = useScreenState({ isLoading: read.isLoading, error: read.error, data: view, isEmpty: () => false });
  const shown = !allowed ? 'denied' : state;
  const asOf = view?.context.asOf ?? '';
  const params = view?.rule.params ?? {};

  const dimensionCard = (dimension: DimensionView) => (
    <SectionCard key={dimension.dimension} title={dimensionLabel(t, dimension.dimension)}>
      <div className="ca1-dimension" data-testid={`dimension-${dimension.dimension}`} data-level={dimension.level}>
        <p className="ca1-dimension__head">
          <StatusPill tone={levelTone(dimension.level)}>{levelLabel(t, dimension.level)}</StatusPill>
          {dimension.level === 'NOT_ENOUGH_DATA' ? <span className="sub">{t('ca1.concentration.minimum', { min: String(params.min_contracts ?? '') })}</span> : null}
        </p>
        <KpiStrip label={dimensionLabel(t, dimension.dimension)}>
          <KpiTile
            label={t('ca1.concentration.top', { n: dimension.topN })}
            value={figureText(t, dimension.topShare, 'percent', locale)}
            sub={<Info definition={definitionOf(view?.definitions ?? [], 'TOP_N_SHARE')} asOf={asOf} />}
          />
          <KpiTile label={t('ca1.concentration.hhi')} value={figureText(t, dimension.hhi, 'index', locale)} sub={<Info definition={definitionOf(view?.definitions ?? [], 'HHI')} asOf={asOf} />} />
          <KpiTile label={t('ca1.concentration.total')} value={moneyText(dimension.totalVnd, locale)} unit={t('w2pay.ctx.unit')} />
        </KpiStrip>
        {dimension.shareAnomalies.length > 0 ? (
          <p className="callout warning ca1-notice" role="status" data-testid="share-anomalies">
            {t('ca1.concentration.anomalies', { count: dimension.shareAnomalies.length })}
          </p>
        ) : null}
        <ul className="ca1-bars" aria-label={t('ca1.concentration.groups', { dimension: dimensionLabel(t, dimension.dimension) })}>
          {dimension.groups.slice(0, 10).map((group) => (
            <li key={group.key} className="ca1-bars__row">
              <span className="ca1-bars__label">{group.name ?? (group.key === '(none)' ? t('ca1.concentration.unclassified') : group.key)}</span>
              <span className="ca1-bars__track" aria-hidden="true">
                <span className="ca1-bars__bar" style={{ width: `${Math.min(100, Math.round(Number(group.sharePct)))}%` }} />
              </span>
              <span className="ca1-bars__value">
                {percentText(group.sharePct, locale)} · {moneyText(group.valueVnd, locale)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );

  const columns: DataTableColumn<ContractorLoadView>[] = [
    { key: 'name', header: t('ca1.load.contractor'), pinned: true, render: (load) => load.name ?? load.contractorId },
    { key: 'count', header: t('ca1.load.contracts'), align: 'right', render: (load) => String(load.activeContracts) },
    { key: 'value', header: t('ca1.load.value'), align: 'right', render: (load) => moneyText(load.activeValueVnd, locale) },
    { key: 'share', header: t('ca1.load.share'), align: 'right', render: (load) => percentText(load.sharePct, locale) },
    { key: 'pending', header: t('ca1.load.pending'), align: 'right', render: (load) => moneyText(load.pendingAwardVnd, locale) },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{reportTitle(t, 'contractor-concentration')}</h1>
          <p>{reportLead(t, 'contractor-concentration')}</p>
        </div>
        <Link className="ui-button ui-button--outline" to="/ctr/ctr-28">
          {t('ca1.hub.back')}
        </Link>
      </div>
      {view === undefined ? null : <ReportContext context={view.context} updatedAt={read.dataUpdatedAt} onUseLatest={(period) => setFilter({ ...filter, period, asOf: '' })} />}
      <StateBoundary state={shown} onRetry={() => void read.refetch()}>
        <AnalyticsFilters
          value={filter}
          onChange={setFilter}
          sort="code"
          direction="asc"
          sortKeys={[]}
          onSort={() => undefined}
          showSort={false}
          actions={view === undefined ? undefined : <ExportBar code="contractor-concentration" query={query} decode={bytesOfBase64} />}
        />
        {view === undefined ? null : (
          <>
            <p className="callout ca1-notice" role="note" data-testid="rule-note">
              {t('ca1.rule.note', {
                version: view.rule.version,
                source: view.rule.source === 'RULE' ? t('ca1.rule.source.rule') : t('ca1.rule.source.default'),
                amber: String(params.top_share_amber_pct ?? ''),
                red: String(params.top_share_red_pct ?? ''),
                hhiAmber: String(params.hhi_amber ?? ''),
                hhiRed: String(params.hhi_red ?? ''),
                min: String(params.min_contracts ?? ''),
              })}
            </p>
            <KpiStrip label={t('ca1.kpi.label')}>
              <KpiTile label={t('ca1.concentration.active')} value={String(view.activeContracts)} />
              <KpiTile label={t('ca1.concentration.activeValue')} value={moneyText(view.activeValueVnd, locale)} unit={t('w2pay.ctx.unit')} />
              <KpiTile
                label={t('ca1.concentration.single')}
                value={figureText(t, view.singleBidder, 'percent', locale)}
                sub={
                  <span className="ca1-kpi-sub">
                    <StatusPill tone={levelTone(view.singleBidder.level)}>{levelLabel(t, view.singleBidder.level)}</StatusPill>
                    <Info definition={definitionOf(view.definitions, 'SINGLE_BIDDER_RATE')} asOf={asOf} />
                  </span>
                }
              />
            </KpiStrip>
            {view.activeContracts === 0 && view.contractors.length === 0 ? (
              <div className="ctr-row-actions" data-testid={filterCount(filter) > 0 ? 'no-match' : 'no-contracts'}>
                <p className="callout" role="status">
                  {filterCount(filter) > 0 ? t('ca1.empty.filtered') : t('ca1.empty.none')}
                </p>
                {filterCount(filter) > 0 ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setFilter(EMPTY_ANALYTICS_FILTER)}>
                    {t('ui.dataTable.clearFilters')}
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                {view.dimensions.map(dimensionCard)}
                <SectionCard title={t('ca1.load.title')}>
                  <div data-testid="load-table">
                    <DataTable caption={t('ca1.load.title')} columns={columns} rows={view.contractors} rowKey={(load) => load.contractorId} />
                  </div>
                </SectionCard>
              </>
            )}
            <p className="sub" data-testid="trend-note">
              {t('ca1.trend.note')} <Link to="/bi/bi-09">{t('ca1.trend.link')}</Link>
            </p>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('ctr.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
