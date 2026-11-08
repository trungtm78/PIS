import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard } from '../../ui';
import { commaText, dayText, vndText } from './common';
import { AnaFigureInfo, NaNote, UnverifiedNote } from './components';
import { useHeatmap } from './insight-hooks';
import { BACKTEST_PATH, HEAT_VIEWS } from './insight-model';
import type { Band, Cell, Heatmap, HeatView, Label } from './insight-model';

type T = Translator['t'];
const BAND_MARK: Record<Band, string> = { GREEN: '●', AMBER: '▲', RED: '■' };

function viewLabel(t: T, view: HeatView): string {
  switch (view) {
    case 'UNIT_FUND':
      return t('ana.heat.view.unitFund');
    case 'CONTRACTOR_UNIT':
      return t('ana.heat.view.contractorUnit');
    case 'CONTRACTOR_FUND':
      return t('ana.heat.view.contractorFund');
  }
}

function bandLabel(t: T, band: Band): string {
  switch (band) {
    case 'GREEN':
      return t('ana.heat.band.green');
    case 'AMBER':
      return t('ana.heat.band.amber');
    case 'RED':
      return t('ana.heat.band.red');
  }
}

/** Why a cell has no rate, in words (never 0 and never green). */
export function cellReason(t: T, reason: string): string {
  switch (reason) {
    case 'SMALL_CELL':
      return t('ana.heat.na.small');
    case 'NO_FIGURE':
      return t('ana.heat.na.noFigure');
    case 'NO_PLAN':
      return t('ana.heat.na.noPlan');
    case 'NO_DENOMINATOR':
      return t('ana.heat.na.noDenominator');
    case 'NO_SNAPSHOT':
      return t('ana.heat.na.noSnapshot');
    case 'NOT_CERTIFIED':
      return t('ana.heat.na.notCertified');
    default:
      return t('ana.heat.na.other');
  }
}

const labelText = (t: T, label: Label | undefined, key: string): string => (label === undefined ? key : label.none ? t('ana.heat.col.none') : label.code === null || label.code === '' ? label.label : `${label.code} ${label.label}`.trim());

function CellView({ cell, view }: { cell: Cell | undefined; view: HeatView }) {
  const { t } = useTranslation();
  if (cell === undefined) return <td className="ana-heat__cell" data-band="NA" data-testid="heat-cell" />;
  if (cell.nullReason !== null) {
    return (
      <td className="ana-heat__cell" data-band="NA" data-testid="heat-cell" data-reason={cell.nullReason}>
        {t('ana.common.na')}
        <br />
        <span className="ana-caveat">{cellReason(t, cell.nullReason)}</span>
      </td>
    );
  }
  return (
    <td className="ana-heat__cell" data-band={cell.band ?? 'NA'} data-testid="heat-cell">
      <strong>{commaText(cell.ratePct)}%</strong>
      {cell.band === null ? null : (
        <span>
          {' '}
          <span aria-hidden="true">{BAND_MARK[cell.band]}</span> {bandLabel(t, cell.band)}
        </span>
      )}
      <br />
      <span className="ana-caveat">
        {view === 'UNIT_FUND' ? t('ana.heat.count.projects', { count: cell.count ?? 0 }) : t('ana.heat.count.contracts', { count: cell.count ?? 0 })} {vndText(cell.numeratorVnd)} / {vndText(cell.denominatorVnd)}
      </span>
    </td>
  );
}

/**
 * BI-29: the heat-map (G3-10): units against fund sources, and contractors against units or fund sources. Every cell says its rate as a number and as a word and mark (never colour alone) and what it is made of; a cell
 * with fewer projects or contracts than the minimum shows nothing (N/A, too few), and the totals leave such cells out and count them. The colours are lines of a governance rule, unverified until the tenant approves them.
 */
export default function HeatmapScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <HeatmapContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HeatmapContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<HeatView>('UNIT_FUND');
  const query = useHeatmap(view);
  const map: Heatmap | undefined = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: map === undefined ? query.error : undefined, data: map, isEmpty: (data) => (data as Heatmap).nullReason === 'NO_SNAPSHOT' });
  const rows = new Map((map?.rows ?? []).map((label) => [label.key, label]));
  const byPair = new Map((map?.cells ?? []).map((cell) => [`${cell.rowKey}|${cell.colKey}`, cell]));
  const contextItems = [
    { label: t('ana.heat.context.asOf'), value: dayText(map?.asOfDate ?? null) },
    { label: t('ana.heat.context.pace'), value: map?.pacePct === null || map === undefined ? '—' : `${commaText(map.pacePct.toFixed(1))}%` },
    { label: t('ana.heat.context.hidden'), value: map === undefined ? '—' : String(map.hiddenCells) },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.heat.page.title')}</h1>
          <p>{t('ana.heat.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={contextItems} unit={t('ana.heat.context.unit')} />
      <div className="ana-controls" role="group" aria-label={t('ana.heat.view.aria')}>
        <label>
          {t('ana.heat.view.label')}
          <select value={view} onChange={(event) => setView(HEAT_VIEWS.find((one) => one === event.target.value) ?? 'UNIT_FUND')} data-testid="heat-view">
            {HEAT_VIEWS.map((one) => (
              <option key={one} value={one}>
                {viewLabel(t, one)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {map === undefined ? null : (
          <div className="ana-stack">
            <UnverifiedNote unverified={map.info?.unverified ?? false} />
            {map.nullReason !== null ? (
              <div className="card statecard" role="status" data-testid="heat-gated">
                <NaNote reason={map.nullReason} label={(reason) => cellReason(t, reason)} />
              </div>
            ) : (
              <SectionCard title={viewLabel(t, view)} status={<AnaFigureInfo name={t('ana.heat.page.title')} info={map.info} asOf={map.asOfDate} />}>
                <p className="ana-caveat" data-testid="heat-legend">
                  {view === 'UNIT_FUND' ? t('ana.heat.legend.unit', { green: commaText(String(map.params.greenRatio)), amber: commaText(String(map.params.amberRatio)) }) : t('ana.heat.legend.contractor', { green: map.params.ctrGreenPct, amber: map.params.ctrAmberPct })} {t('ana.heat.legend.min', { count: map.params.minCellCount })}
                </p>
                {map.hiddenCells === 0 ? null : (
                  <p className="ana-caveat" data-testid="heat-hidden">
                    {t('ana.heat.hidden', { count: map.hiddenCells })}
                  </p>
                )}
                <div className="tablewrap">
                  <table className="ana-table" aria-label={t('ana.heat.table.aria')} data-testid="heat-table">
                    <caption className="sr-only">{t('ana.heat.table.caption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('ana.heat.corner')}</th>
                        {map.cols.map((col) => (
                          <th key={col.key} scope="col">
                            {labelText(t, col, col.key)}
                          </th>
                        ))}
                        <th scope="col" className="num">
                          {t('ana.heat.total')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {map.rows.map((row) => {
                        const total = map.rowTotals.find((one) => one.key === row.key);
                        return (
                          <tr key={row.key} data-testid="heat-row" data-row={row.key}>
                            <th scope="row">{labelText(t, rows.get(row.key), row.key)}</th>
                            {map.cols.map((col) => (
                              <CellView key={col.key} cell={byPair.get(`${row.key}|${col.key}`)} view={view} />
                            ))}
                            <td className="num" data-testid="heat-row-total">
                              {total === undefined || total.ratePct === null ? t('ana.common.na') : `${commaText(total.ratePct)}%`}
                              {total === undefined || total.hidden === 0 ? null : <span className="ana-caveat"> {t('ana.heat.total.hidden', { count: total.hidden })}</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">{t('ana.heat.total')}</th>
                        {map.cols.map((col) => {
                          const total = map.colTotals.find((one) => one.key === col.key);
                          return (
                            <td key={col.key} className="num" data-testid="heat-col-total" data-col={col.key}>
                              {total === undefined || total.ratePct === null ? t('ana.common.na') : `${commaText(total.ratePct)}%`}
                            </td>
                          );
                        })}
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="ana-caveat">{t('ana.heat.total.note')}</p>
              </SectionCard>
            )}
            <p className="ana-links">
              <Link to={BACKTEST_PATH}>{t('ana.heat.link.backtest')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
