import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, FlowChart, SectionCard, StatusPill } from '../../ui';
import type { FlowSeries } from '../../ui';
import { AnaFigureInfo, NaNote, UnverifiedNote } from './components';
import { commaText, dayText, vndText } from './common';
import { useOutlook } from './forecast-hooks';
import { COMMAND_CENTER_PATH, chartLines } from './forecast-model';
import type { ChartLine, FundOutlook, OutlookReading, OutlookView } from './forecast-model';

type T = Translator['t'];

/** Why a figure of the outlook is missing, in words: never 0 and never a guess. */
export function outlookReason(t: T, reason: string): string {
  switch (reason) {
    case 'NO_PLAN':
      return t('ana.forecast.na.noPlan');
    case 'NO_TREASURY_DATA':
      return t('ana.forecast.na.noTreasury');
    case 'TOO_FEW_WEEKS':
      return t('ana.forecast.na.tooFewWeeks');
    case 'ALL_WINDOWS_UNUSABLE':
      return t('ana.forecast.na.unusable');
    case 'YEAR_ENDED':
      return t('ana.forecast.na.yearEnded');
    case 'NO_SNAPSHOT':
      return t('ana.forecast.na.noSnapshot');
    case 'NO_PRIOR_YEAR':
      return t('ana.forecast.na.noPriorYear');
    case 'PRIOR_YEAR_TOO_SHORT':
      return t('ana.forecast.na.priorShort');
    case 'PRIOR_WINDOW_ZERO':
      return t('ana.forecast.na.priorZero');
    case 'SEASONALITY_OFF':
      return t('ana.forecast.na.seasonOff');
    case 'ZERO_SPEED':
      return t('ana.forecast.na.zeroSpeed');
    case 'NO_SPEED':
      return t('ana.forecast.na.noSpeed');
    case 'NOT_CERTIFIED':
      return t('ana.forecast.na.notCertified');
    default:
      return t('ana.forecast.na.other');
  }
}

function lineLabel(t: T, key: ChartLine['key']): string {
  switch (key) {
    case 'actual':
      return t('ana.forecast.chart.actual');
    case 'low':
      return t('ana.forecast.chart.low');
    case 'central':
      return t('ana.forecast.chart.central');
    case 'high':
      return t('ana.forecast.chart.high');
    case 'seasonal':
      return t('ana.forecast.chart.seasonal');
    case 'plan':
      return t('ana.forecast.chart.plan');
  }
}

/** The lines of the chart for the kit: the actual and the three projections are drawn as actual lines, the plan as the dashed line. */
export const flowSeriesOf = (t: T, lines: readonly ChartLine[]): FlowSeries[] => lines.map((line) => ({ label: lineLabel(t, line.key), style: line.key === 'plan' ? 'plan' : 'actual', points: line.points }));

function Tile({ id, label, value, note, info }: { id: string; label: string; value: string; note?: string | undefined; info?: React.ReactNode }) {
  return (
    <li className="ana-tile">
      <span className="ana-tile__label">
        {label}
        {info}
      </span>
      <strong className="ana-tile__value" data-testid={`ana-tile-${id}`}>
        {value}
      </strong>
      {note === undefined ? null : <span className="ana-tile__note">{note}</span>}
    </li>
  );
}

function OutlookTiles({ reading, view }: { reading: OutlookReading; view: OutlookView }) {
  const { t } = useTranslation();
  const info = reading.info;
  const unitVnd = t('ana.forecast.unit.vnd');
  const projected = view.linear;
  const ratio = view.linearRatioPct;
  const needed = view.needed;
  return (
    <ul className="ana-tiles" data-testid="outlook-tiles">
      <Tile id="cumulative" label={t('ana.forecast.tile.cumulative')} value={view.cumulativeVnd === null ? t('ana.common.na') : `${vndText(view.cumulativeVnd)} ${unitVnd}`} note={t('ana.forecast.tile.asOf', { day: dayText(view.asOfDate) })} info={<AnaFigureInfo name={t('ana.forecast.tile.cumulative')} info={info} asOf={view.asOfDate} />} />
      <Tile id="plan" label={t('ana.forecast.tile.plan')} value={view.planTotalVnd === null ? t('ana.common.na') : `${vndText(view.planTotalVnd)} ${unitVnd}`} note={reading.planBasis === 'PM' ? t('ana.forecast.basis.pm') : t('ana.forecast.basis.total')} info={<AnaFigureInfo name={t('ana.forecast.tile.plan')} info={info} />} />
      <Tile
        id="projection"
        label={t('ana.forecast.tile.projection')}
        value={projected === null ? t('ana.common.na') : `${vndText(projected.centralVnd)} ${unitVnd}`}
        note={projected === null ? undefined : t('ana.forecast.tile.band', { low: vndText(projected.lowVnd), high: vndText(projected.highVnd), ratio: commaText(ratio?.central ?? null) })}
        info={<AnaFigureInfo name={t('ana.forecast.tile.projection')} info={info} />}
      />
      <Tile
        id="needed"
        label={t('ana.forecast.tile.needed')}
        value={needed.perWeekVnd === null ? t('ana.common.na') : `${vndText(needed.perWeekVnd)} ${unitVnd}`}
        note={needed.status === 'REACHED' ? t('ana.forecast.tile.reached') : needed.multiple === null ? (needed.multipleNullReason === null ? undefined : outlookReason(t, needed.multipleNullReason)) : t('ana.forecast.tile.multiple', { multiple: commaText(needed.multiple), speed: vndText(needed.speedVnd) })}
        info={<AnaFigureInfo name={t('ana.forecast.tile.needed')} info={info} />}
      />
      <Tile
        id="gap"
        label={t('ana.forecast.tile.gap')}
        value={view.gapVnd === null ? t('ana.common.na') : `${vndText(view.gapVnd)} ${unitVnd}`}
        note={view.attention === null ? undefined : view.attention ? t('ana.forecast.tile.attention', { pct: reading.model.attentionBelowPct }) : t('ana.forecast.tile.onTrack')}
        info={<AnaFigureInfo name={t('ana.forecast.tile.gap')} info={info} />}
      />
    </ul>
  );
}

function WindowsTable({ view }: { view: OutlookView }) {
  const { t } = useTranslation();
  if (view.windows.length === 0) return null;
  return (
    <div className="tablewrap">
      <table className="ana-table" aria-label={t('ana.forecast.windows.aria')} data-testid="outlook-windows">
        <caption className="sr-only">{t('ana.forecast.windows.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('ana.forecast.windows.weeks')}</th>
            <th scope="col">{t('ana.forecast.windows.from')}</th>
            <th scope="col" className="num">
              {t('ana.forecast.windows.speed')}
            </th>
            <th scope="col" className="num">
              {t('ana.forecast.windows.linear')}
            </th>
            <th scope="col" className="num">
              {t('ana.forecast.windows.seasonal')}
            </th>
          </tr>
        </thead>
        <tbody>
          {view.windows.map((window) => (
            <tr key={window.weeks}>
              <th scope="row">{t('ana.forecast.windows.weeksValue', { weeks: window.weeks })}</th>
              <td>{dayText(window.startDate)}</td>
              <td className="num">{vndText(window.weeklySpeedVnd)}</td>
              <td className="num">{vndText(window.linearYearEndVnd)}</td>
              <td className="num">{window.seasonalYearEndVnd === null ? (window.seasonalNullReason === null ? '—' : t('ana.common.na')) : vndText(window.seasonalYearEndVnd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FundsTable({ funds }: { funds: readonly FundOutlook[] }) {
  const { t } = useTranslation();
  return (
    <div className="tablewrap">
      <table className="ana-table" aria-label={t('ana.forecast.funds.aria')} data-testid="outlook-funds">
        <caption className="sr-only">{t('ana.forecast.funds.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('ana.forecast.funds.fund')}</th>
            <th scope="col" className="num">
              {t('ana.forecast.funds.cumulative')}
            </th>
            <th scope="col" className="num">
              {t('ana.forecast.funds.plan')}
            </th>
            <th scope="col" className="num">
              {t('ana.forecast.funds.projection')}
            </th>
            <th scope="col" className="num">
              {t('ana.forecast.funds.ratio')}
            </th>
            <th scope="col" className="num">
              {t('ana.forecast.funds.needed')}
            </th>
          </tr>
        </thead>
        <tbody>
          {funds.map((fund) => (
            <tr key={fund.fundSourceVersionId ?? 'none'} data-testid="outlook-fund-row">
              <th scope="row">{fund.code === null ? t('ana.forecast.funds.none') : `${fund.code} ${fund.label ?? ''}`.trim()}</th>
              <td className="num">{vndText(fund.outlook.cumulativeVnd)}</td>
              <td className="num">{vndText(fund.outlook.planTotalVnd)}</td>
              {fund.outlook.linear === null ? (
                <td className="num" colSpan={2}>
                  {fund.outlook.nullReason === null ? t('ana.common.na') : outlookReason(t, fund.outlook.nullReason)}
                </td>
              ) : (
                <>
                  <td className="num">{vndText(fund.outlook.linear.centralVnd)}</td>
                  <td className="num">{commaText(fund.outlook.linearRatioPct?.central ?? null)}</td>
                </>
              )}
              <td className="num">{vndText(fund.outlook.needed.perWeekVnd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The year-end outlook of the disbursement (G3-5, G3-11): the cumulative of the year with the band of the projections from the speed of the last 4 to 8 weeks, the seasonal reading when the year before has a complete series, "how much a
 * week is needed" and the same per fund source. Every figure has its "i" (formula, source, day, rule version) and says so when the rule is a starting value nobody confirmed; a figure that cannot be computed says why.
 */
export default function OutlookScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <OutlookContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OutlookContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const unitId = params.get('unit') ?? '';
  const [planBasis, setPlanBasis] = useState<'PM' | 'TOTAL'>('PM');
  const [byFund, setByFund] = useState(true);
  const query = useOutlook({ unitId, planBasis, byFund });
  const reading = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: reading === undefined ? query.error : undefined, data: reading, isEmpty: (data) => (data as OutlookReading).whole === null && (data as OutlookReading).nullReason === 'NO_SNAPSHOT' });
  const lines = reading === undefined ? [] : chartLines(reading);
  const whole = reading?.whole ?? null;
  const gated = reading?.certificationGate !== null && reading?.certificationGate !== undefined;
  const contextItems = [
    { label: t('ana.forecast.context.year'), value: reading?.year === null || reading === undefined ? '—' : String(reading.year) },
    { label: t('ana.forecast.context.asOf'), value: dayText(reading?.asOfDate ?? null) },
    { label: t('ana.forecast.context.basis'), value: planBasis === 'PM' ? t('ana.forecast.basis.pm') : t('ana.forecast.basis.total') },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.forecast.page.title')}</h1>
          <p>{t('ana.forecast.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={contextItems} unit={t('ana.forecast.context.unit')} />
      <div className="ana-controls" role="group" aria-label={t('ana.forecast.controls.aria')}>
        <label>
          {t('ana.forecast.controls.basis')}
          <select value={planBasis} onChange={(event) => setPlanBasis(event.target.value === 'TOTAL' ? 'TOTAL' : 'PM')} data-testid="outlook-basis">
            <option value="PM">{t('ana.forecast.basis.pm')}</option>
            <option value="TOTAL">{t('ana.forecast.basis.total')}</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={byFund} onChange={(event) => setByFund(event.target.checked)} data-testid="outlook-by-fund" /> {t('ana.forecast.controls.byFund')}
        </label>
      </div>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {reading === undefined ? null : (
          <div className="ana-stack">
            {query.isError ? (
              <p role="alert" data-testid="outlook-stale">
                {t('ana.common.stale')}
              </p>
            ) : null}
            <UnverifiedNote unverified={reading.info?.unverified ?? false} />
            {gated ? (
              <div className="card statecard" role="status" data-testid="outlook-gated">
                <h2>{t('ana.forecast.gated.title')}</h2>
                <p className="muted">{reading.certificationGate === 'OBSOLETE' ? t('ana.forecast.gated.obsolete') : t('ana.forecast.gated.notCertified')}</p>
              </div>
            ) : null}
            {reading.nullReason !== null && !gated ? (
              <div className="card statecard" role="status" data-testid="outlook-empty">
                <h2>{t('ana.forecast.empty.title')}</h2>
                <NaNote reason={reading.nullReason} label={(reason) => outlookReason(t, reason)} />
              </div>
            ) : null}
            {whole === null ? null : (
              <>
                <OutlookTiles reading={reading} view={whole} />
                {whole.nullReason === null ? null : <NaNote reason={whole.nullReason} label={(reason) => outlookReason(t, reason)} />}
                {whole.seasonal === null && whole.nullReason === null && whole.seasonalNullReason !== null ? <NaNote reason={whole.seasonalNullReason} label={(reason) => outlookReason(t, reason)} /> : null}
                <SectionCard title={t('ana.forecast.chart.title')} unit={t('ana.forecast.unit.billion')} status={whole.attention === true ? <StatusPill tone="warning">{t('ana.forecast.chart.attention')}</StatusPill> : undefined}>
                  <FlowChart series={flowSeriesOf(t, lines)} unit={t('ana.forecast.unit.billion')} caption={t('ana.forecast.chart.caption')} state={lines.length === 0 ? 'empty' : 'ready'} />
                  <p className="ana-caveat">{t('ana.forecast.chart.caveat', { min: reading.model.windowMinWeeks, max: reading.model.windowMaxWeeks })}</p>
                </SectionCard>
                <SectionCard title={t('ana.forecast.windows.title')} unit={t('ana.forecast.unit.vnd')}>
                  <WindowsTable view={whole} />
                  {whole.skipped.length === 0 ? null : (
                    <p className="ana-caveat" data-testid="outlook-skipped">
                      {t('ana.forecast.windows.skipped', { weeks: whole.skipped.map((one) => one.weeks).join(', ') })}
                    </p>
                  )}
                </SectionCard>
              </>
            )}
            {reading.funds.length === 0 ? null : (
              <SectionCard title={t('ana.forecast.funds.title')} unit={t('ana.forecast.unit.vnd')}>
                <FundsTable funds={reading.funds} />
              </SectionCard>
            )}
            <p className="ana-links">
              <Link to={COMMAND_CENTER_PATH}>{t('ana.forecast.back')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
