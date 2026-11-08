import { ApiError } from '@machvon/api-client';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, FlowChart, SectionCard, StatusPill } from '../../ui';
import type { FlowSeries } from '../../ui';
import { commaText, dayText } from './common';
import { AnaFigureInfo, NaNote, UnverifiedNote } from './components';
import { useBacktest, useTrend } from './insight-hooks';
import { HEAT_PATH } from './insight-model';
import type { Backtest, Candidate, Trend, TrendUnit } from './insight-model';

type T = Translator['t'];
const RULES_PATH = '/adm/adm-19';

/** Why a figure of the back-test is missing, in words. */
export function backtestReason(t: T, reason: string): string {
  switch (reason) {
    case 'TOO_FEW_PAIRS':
      return t('ana.back.na.tooFew');
    case 'NO_POSITIVE_PREDICTION':
      return t('ana.back.na.noPositive');
    case 'NO_OUTCOME':
      return t('ana.back.na.noOutcome');
    case 'NO_SNAPSHOT':
      return t('ana.back.na.noSnapshot');
    case 'NO_SCORE_NOW':
      return t('ana.back.na.noScoreNow');
    case 'NO_SCORE_BEFORE':
      return t('ana.back.na.noScoreBefore');
    default:
      return t('ana.back.na.other');
  }
}

/** The lines of the chart: precision and recall of the candidates that warn from the line where amber begins, by threshold (the points of the score), in the order of the thresholds. */
export function chartSeries(t: T, candidates: readonly Candidate[]): FlowSeries[] {
  const amber = candidates.filter((one) => one.line === 'AMBER').sort((left, right) => left.threshold - right.threshold);
  const points = (pick: (one: Candidate) => string | null): Array<{ x: string; y: number }> => amber.flatMap((one) => (pick(one) === null ? [] : [{ x: String(one.threshold), y: Number(pick(one)) }]));
  return [
    { label: t('ana.back.chart.precision'), style: 'actual', points: points((one) => one.precisionPct) },
    { label: t('ana.back.chart.recall'), style: 'actual', points: points((one) => one.recallPct) },
  ];
}

function Sparkline({ series, label }: { series: ReadonlyArray<number | null>; label: string }) {
  const values = series.filter((value): value is number => value !== null);
  if (values.length < 2) return <span className="ana-caveat">{'—'}</span>;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low === 0 ? 1 : high - low;
  const step = 80 / (series.length - 1);
  const points = series.flatMap((value, index) => (value === null ? [] : [`${(index * step).toFixed(1)},${(18 - ((value - low) / span) * 16).toFixed(1)}`])).join(' ');
  return (
    <svg role="img" aria-label={label} viewBox="0 0 80 20" width="80" height="20">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function TrendTable({ rows, title }: { rows: readonly TrendUnit[]; title: string }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <p className="muted">{t('ana.back.trend.none')}</p>;
  return (
    <div className="tablewrap">
      <table className="ana-table" aria-label={title} data-testid="trend-table">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th scope="col" className="num">
              {t('ana.back.trend.rank')}
            </th>
            <th scope="col">{t('ana.back.trend.unit')}</th>
            <th scope="col" className="num">
              {t('ana.back.trend.before')}
            </th>
            <th scope="col" className="num">
              {t('ana.back.trend.now')}
            </th>
            <th scope="col" className="num">
              {t('ana.back.trend.delta')}
            </th>
            <th scope="col">{t('ana.back.trend.line')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.unitId} data-testid="trend-row" data-unit={row.unitId}>
              <td className="num">{row.rank ?? t('ana.common.na')}</td>
              <th scope="row">{row.code === '' ? row.name : `${row.code} ${row.name}`}</th>
              <td className="num">{row.scoreBefore === null ? t('ana.common.na') : commaText(String(row.scoreBefore))}</td>
              <td className="num">{row.scoreNow === null ? t('ana.common.na') : commaText(String(row.scoreNow))}</td>
              <td className="num" data-testid="trend-delta">
                {row.delta === null ? (
                  <>
                    {t('ana.common.na')} <span className="ana-caveat">{row.nullReason === null ? '' : backtestReason(t, row.nullReason)}</span>
                  </>
                ) : (
                  commaText(String(row.delta))
                )}
              </td>
              <td>
                <Sparkline series={row.series} label={t('ana.back.trend.sparkline', { unit: row.code })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * BI-30: the back-test of the early-warning thresholds and the ranking by trend (G3-11). The back-test replays the stored weeks against what happened in the weeks after, for each candidate threshold: warnings that were
 * right and wrong, what was missed, precision, recall and how many weeks ahead a unit was warned. It is a replay of the past, not a promise, and it changes no threshold in force: a change goes through the governance rules.
 * The trend ranking orders the units by the change of their score, not by its level.
 */
export default function BacktestScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <BacktestContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BacktestContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const back = useBacktest();
  const trend = useTrend();
  const result: Backtest | undefined = back.data;
  const trendData: Trend | undefined = trend.data;
  const state = useScreenState({ isLoading: back.isLoading && trend.isLoading, error: result === undefined && trendData === undefined ? (back.error ?? trend.error) : undefined, data: result ?? trendData, isEmpty: (data) => (data as { nullReason: string | null }).nullReason === 'NO_SNAPSHOT' });
  const contextItems = [
    { label: t('ana.back.context.asOf'), value: dayText(result?.asOfDate ?? trendData?.asOfDate ?? null) },
    { label: t('ana.back.context.horizon'), value: result === undefined ? '—' : t('ana.back.weeks', { weeks: result.horizonWeeks }) },
    { label: t('ana.back.context.pairs'), value: result === undefined ? '—' : String(result.pairs) },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.back.page.title')}</h1>
          <p>{t('ana.back.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={contextItems} unit={t('ana.back.context.unit')} />
      <StateBoundary state={state} onRetry={() => void Promise.all([back.refetch(), trend.refetch()])}>
        <div className="ana-stack">
          <UnverifiedNote unverified={(result?.info?.unverified ?? false) || (trendData?.info?.unverified ?? false)} />
          {result === undefined ? (
            back.isError ? (
              <p role="alert" data-testid="back-error">
                {back.error instanceof ApiError && back.error.status === 403 ? t('ana.back.denied') : t('ana.back.error')}
              </p>
            ) : null
          ) : (
            <>
              <SectionCard title={t('ana.back.report.title')} status={<AnaFigureInfo name={t('ana.back.report.title')} info={result.info} asOf={result.asOfDate} />}>
                <p className="ana-caveat" data-testid="back-caveat">
                  {t('ana.back.caveat')}
                </p>
                <p data-testid="back-summary">
                  {t('ana.back.summary', { pairs: result.pairs, units: result.unitsEvaluated, weeks: result.weeksEvaluated, positives: result.positives, horizon: result.horizonWeeks })} {t('ana.back.lines', { amber: commaText(String(result.lines.amberFrom)), red: commaText(String(result.lines.redFrom)) })}
                </p>
                {result.nullReason === null ? null : <NaNote reason={result.nullReason} label={(reason) => backtestReason(t, reason)} />}
                <div className="tablewrap">
                  <table className="ana-table" aria-label={t('ana.back.table.aria')} data-testid="back-table">
                    <caption className="sr-only">{t('ana.back.table.caption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('ana.back.col.line')}</th>
                        <th scope="col" className="num">
                          {t('ana.back.col.threshold')}
                        </th>
                        <th scope="col" className="num">
                          {t('ana.back.col.tp')}
                        </th>
                        <th scope="col" className="num">
                          {t('ana.back.col.fp')}
                        </th>
                        <th scope="col" className="num">
                          {t('ana.back.col.fn')}
                        </th>
                        <th scope="col" className="num">
                          {t('ana.back.col.precision')}
                        </th>
                        <th scope="col" className="num">
                          {t('ana.back.col.recall')}
                        </th>
                        <th scope="col" className="num">
                          {t('ana.back.col.lead')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.candidates.map((one) => (
                        <tr key={`${one.line}-${one.threshold}`} data-testid="back-row" data-current={one.isCurrent ? 'yes' : 'no'}>
                          <th scope="row">
                            {one.line === 'AMBER' ? t('ana.back.line.amber') : t('ana.back.line.red')} {one.shift === 0 ? '' : t('ana.back.shift', { shift: one.shift > 0 ? `+${one.shift}` : String(one.shift) })}
                            {one.isCurrent ? (
                              <>
                                {' '}
                                <StatusPill tone="neutral">{t('ana.back.current')}</StatusPill>
                              </>
                            ) : null}
                          </th>
                          <td className="num">{commaText(String(one.threshold))}</td>
                          <td className="num">{one.tp}</td>
                          <td className="num">{one.fp}</td>
                          <td className="num">{one.fn}</td>
                          <td className="num">{one.precisionPct === null ? t('ana.common.na') : `${commaText(one.precisionPct)}%`}</td>
                          <td className="num">{one.recallPct === null ? t('ana.common.na') : `${commaText(one.recallPct)}%`}</td>
                          <td className="num">{one.meanLeadWeeks === null ? t('ana.common.na') : t('ana.back.weeks', { weeks: commaText(one.meanLeadWeeks) })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
              <SectionCard title={t('ana.back.chart.title')} unit={t('ana.back.chart.unit')}>
                <FlowChart series={chartSeries(t, result.candidates)} unit={t('ana.back.chart.unit')} caption={t('ana.back.chart.caption')} state={result.nullReason === null && result.candidates.some((one) => one.precisionPct !== null) ? 'ready' : 'empty'} />
                <p className="ana-caveat">
                  {t('ana.back.rules')} <Link to={RULES_PATH}>{t('ana.back.rules.link')}</Link>
                </p>
              </SectionCard>
            </>
          )}
          {trendData === undefined ? (
            trend.isError ? (
              <p role="alert" data-testid="trend-error">
                {t('ana.back.trend.error')}
              </p>
            ) : null
          ) : (
            <>
              <SectionCard title={t('ana.back.trend.improving', { weeks: trendData.trendWeeks })} status={<AnaFigureInfo name={t('ana.back.trend.title')} info={trendData.info} asOf={trendData.asOfDate} />}>
                <p className="ana-caveat">{t('ana.back.trend.caveat')}</p>
                <TrendTable rows={trendData.improving} title={t('ana.back.trend.improving', { weeks: trendData.trendWeeks })} />
              </SectionCard>
              <SectionCard title={t('ana.back.trend.worsening', { weeks: trendData.trendWeeks })}>
                <TrendTable rows={trendData.worsening} title={t('ana.back.trend.worsening', { weeks: trendData.trendWeeks })} />
              </SectionCard>
              {trendData.units.some((row) => row.rank === null) ? (
                <SectionCard title={t('ana.back.trend.unranked')}>
                  <TrendTable rows={trendData.units.filter((row) => row.rank === null)} title={t('ana.back.trend.unranked')} />
                </SectionCard>
              ) : null}
            </>
          )}
          <p className="ana-links">
            <Link to={HEAT_PATH}>{t('ana.back.link.heat')}</Link>
          </p>
        </div>
      </StateBoundary>
    </section>
  );
}
