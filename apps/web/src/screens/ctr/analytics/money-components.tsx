import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { FlowChart, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { FlowSeries } from '../../../ui';
import { Info, definitionOf, indicatorText } from './components';
import type { useScheduleCurve } from './hooks';
import { groupLabel, levelLabel, reasonText, ruleLabel } from './labels';
import { billionsOf, dateText, healthTone, moneyText, percentText } from './model';
import type { EvmView, IndicatorValue, LadderStep, ReportView, RuleUsed, TierSplitView } from './model';
import './analytics.css';

/** The plan, the earned value and the cost in the picture are drawn at most this many times: the table of the file keeps every point. */
const CURVE_POINTS = 60;

function thin<T extends { day: string }>(points: readonly T[], asOf: string): T[] {
  if (points.length <= CURVE_POINTS) return [...points];
  const step = (points.length - 1) / (CURVE_POINTS - 1);
  const keep = new Set<number>([0, points.length - 1]);
  const today = points.findIndex((point) => point.day === asOf);
  if (today >= 0) keep.add(today);
  for (let index = 0; index < CURVE_POINTS; index += 1) keep.add(Math.round(index * step));
  return [...keep].sort((a, b) => a - b).flatMap((index) => points[index] ?? []);
}

// ---- the rules a report was judged by ------------------------------------------------------------------------------------------------------------------------

/** The governance rules behind the colours and statuses of the report: which rule, which version, where it came from, and whether anybody confirmed its numbers. */
export function RulesNote({ rules }: { rules: readonly RuleUsed[] }) {
  const { t } = useTranslation();
  if (rules.length === 0) return null;
  return (
    <SectionCard title={t('ca2.rules.title')}>
      <ul className="ca1-defs" data-testid="rules-used">
        {rules.map((rule) => (
          <li key={rule.type} data-rule={rule.type}>
            <strong>{ruleLabel(t, rule.type)}</strong> <span className="sub">{t('ca2.rules.line', { version: rule.version, source: rule.source === 'RULE' ? t('ca2.rules.source.rule') : t('ca2.rules.source.default') })}</span>{' '}
            {rule.unverified ? <StatusPill tone="warning">{t('ca1.info.unverified')}</StatusPill> : null}
            <span className="sub ca2-params">{Object.entries(rule.params).map(([key, value]) => `${key} = ${String(value)}`).join(' · ')}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ---- earned value and the S-curve (R3) -------------------------------------------------------------------------------------------------------------------------

function indexTile(t: ReturnType<typeof useTranslation>['t'], locale: string, view: ReportView, value: IndicatorValue | null, rag: string | null, testId: string): ReactNode {
  if (value === null) return null;
  const definition = definitionOf(view.definitions, value.code);
  return (
    <KpiTile
      key={value.code}
      label={t(`ca1.indicator.${value.code === 'SPI' ? 'spi' : 'cpi'}.name`)}
      value={value.value === null ? '—' : indicatorText(t, locale, definition, value)}
      sub={
        <span className="ca1-kpi-sub" data-testid={testId}>
          {value.value === null && value.reason !== null ? <span>{reasonText(t, value.reason)}</span> : null}
          {rag === null ? null : <StatusPill tone={healthTone(rag)}>{levelLabel(t, rag)}</StatusPill>}
          <Info definition={definition} asOf={view.context.asOf} />
        </span>
      }
    />
  );
}

export function EvmFigures({ view, evm }: { view: ReportView; evm: EvmView }) {
  const { t, locale } = useTranslation();
  if (evm.status === 'UNAVAILABLE' || evm.figures === null || evm.coverage === null) {
    return (
      <p className="callout ca1-notice" role="status" data-testid="evm-unavailable">
        {t('ca2.evm.unavailable', { reason: evm.reason === null ? t('ca1.na.noRows') : reasonText(t, evm.reason) })}
      </p>
    );
  }
  const figures = evm.figures;
  const money = (label: string, value: string | null): ReactNode => (
    <KpiTile label={label} value={value === null ? '—' : moneyText(value, locale)} {...(value === null ? {} : { unit: t('w2pay.ctx.unit') })} />
  );
  const missing = Object.entries(evm.coverage.missing);
  return (
    <>
      <KpiStrip label={t('ca2.evm.label')}>
        {money(t('ca2.evm.bac'), figures.bacVnd)}
        {money(t('ca2.evm.pv'), figures.pvVnd)}
        {money(t('ca2.evm.ev'), figures.evVnd)}
        {money(t('ca2.evm.ac'), figures.acVnd)}
        {money(t('ca2.evm.sv'), figures.svVnd)}
        {indexTile(t, locale, view, figures.spi, figures.ragSpi, 'spi-tile')}
        {indexTile(t, locale, view, figures.cpi, figures.ragCpi, 'cpi-tile')}
      </KpiStrip>
      <p className="sub" data-testid="evm-coverage">
        {t('ca2.evm.coverage', { covered: evm.coverage.covered, contracts: evm.coverage.contracts })}
        {missing.map(([reason, count]) => (
          <span key={reason} data-testid="evm-missing">
            {' · '}
            {t('ca2.evm.missing', { count, reason: reasonText(t, reason) })}
          </span>
        ))}
      </p>
    </>
  );
}

/** The earned value of the selection and its S-curve: the figures of the contracts that have them, how many those are and why the others have none, the plan by version 0 and by the baseline in force, the earned value and the cost up to the day. */
export function EvmPanel({ view, curve }: { view: ReportView; curve: ReturnType<typeof useScheduleCurve> }) {
  const { t } = useTranslation();
  const evm = view.evm;
  if (evm === null) return null;
  const data = curve.data;
  const series = (): FlowSeries[] => {
    if (data === undefined) return [];
    const points = thin(data.points, data.asOf);
    const line = (pick: (point: (typeof points)[number]) => string | null): Array<{ x: string; y: number }> =>
      points.flatMap((point) => {
        const y = billionsOf(pick(point));
        return y === null ? [] : [{ x: dateText(point.day), y }];
      });
    const result: FlowSeries[] = [];
    const earned = line((point) => point.evVnd);
    const cost = line((point) => point.acVnd);
    if (earned.length > 0) result.push({ label: t('ca2.curve.series.ev'), style: 'actual', points: earned });
    if (cost.length > 0) result.push({ label: t('ca2.curve.series.ac'), style: 'actual', points: cost });
    result.push({ label: t('ca2.curve.series.pvCurrent'), style: 'plan', points: line((point) => point.pvCurrentVnd) });
    const original = line((point) => point.pvV0Vnd);
    if (original.length > 0) result.push({ label: t('ca2.curve.series.pvV0'), style: 'plan', points: original });
    return result;
  };
  const state = curve.isLoading ? 'loading' : curve.isError && data === undefined ? 'error' : data === undefined || data.points.length === 0 ? 'empty' : 'ready';
  return (
    <SectionCard title={t('ca2.evm.title')}>
      <EvmFigures view={view} evm={evm} />
      {evm.status === 'UNAVAILABLE' && evm.reason === 'NOT_IN_SNAPSHOT' ? null : (
        <div data-testid="s-curve">
          <FlowChart series={series()} unit={t('ca2.curve.unit')} caption={t('ca2.curve.caption')} state={state} onRetry={() => void curve.refetch()} />
          {data !== undefined && data.points.length > 0 && !data.v0Complete ? (
            <p className="sub" role="status" data-testid="v0-partial">
              {t('ca2.curve.v0Partial')}
            </p>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

// ---- growth by tier (R7) ------------------------------------------------------------------------------------------------------------------------------------------

/** The growth through changes cut by the tier of each change: the tiers add up to the growth of the selection because they share one denominator, the original value of all its contracts. */
export function TierSplitPanel({ view }: { view: ReportView }) {
  const { t, locale } = useTranslation();
  const split: TierSplitView | null = view.tierSplit;
  if (split === null) return null;
  if (split.status === 'UNAVAILABLE') {
    return (
      <p className="callout ca1-notice" role="status" data-testid="tier-unavailable">
        {t('ca2.tier.unavailable', { reason: split.reason === null ? t('ca1.na.noRows') : reasonText(t, split.reason) })}
      </p>
    );
  }
  const definition = definitionOf(view.definitions, 'CHANGE_TIER_GROWTH');
  return (
    <SectionCard title={t('ca2.tier.title')}>
      <table className="ui-table ca2-tier" data-testid="tier-split">
        <caption className="ui-sr-only">{t('ca2.tier.caption', { original: moneyText(split.originalValueVnd, locale) })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('ca2.tier.col.tier')}</th>
            <th scope="col">{t('ca2.tier.col.count')}</th>
            <th scope="col">{t('ca2.tier.col.delta')}</th>
            <th scope="col">
              {t('ca2.tier.col.growth')} <Info definition={definition} asOf={view.context.asOf} />
            </th>
            <th scope="col">{t('ca2.tier.col.share')}</th>
            <th scope="col">{t('ca2.tier.col.max')}</th>
          </tr>
        </thead>
        <tbody>
          {split.groups.map((group) => (
            <tr key={group.key} data-tier={group.key}>
              <th scope="row">{groupLabel(t, 'change_tier', group.key)}</th>
              <td>{group.count}</td>
              <td>{group.deltaVnd === null ? <span className="ca1-na">{reasonText(t, group.growth?.reason ?? 'NO_CHANGE')}</span> : moneyText(group.deltaVnd, locale)}</td>
              <td>{group.growth === null || group.growth.value === null ? '—' : percentText(group.growth.value, locale)}</td>
              <td>{group.shareOfGrowthPct === null ? '—' : percentText(group.shareOfGrowthPct, locale)}</td>
              <td>{group.maxCumulativePct === null ? '—' : percentText(group.maxCumulativePct, locale)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{t('ca1.table.totals')}</th>
            <td>{split.totalCount}</td>
            <td>{moneyText(split.totalDeltaVnd, locale)}</td>
            <td>{view.totals.cells.change_growth_pct === undefined || view.totals.cells.change_growth_pct === null ? '—' : percentText(String(view.totals.cells.change_growth_pct), locale)}</td>
            <td />
            <td />
          </tr>
        </tfoot>
      </table>
    </SectionCard>
  );
}

// ---- what falls due (R6) ------------------------------------------------------------------------------------------------------------------------------------------

function Ladder({ title, steps, testId }: { title: string; steps: readonly LadderStep[]; testId: string }) {
  const { t, locale } = useTranslation();
  return (
    <div data-testid={testId}>
      <h3>{title}</h3>
      <table className="ui-table ca2-ladder">
        <thead>
          <tr>
            <th scope="col">{t('ca2.ladder.col.step')}</th>
            <th scope="col">{t('ca2.ladder.col.count')}</th>
            <th scope="col">{t('ca2.ladder.col.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <tr key={step.key} data-step={step.key}>
              <th scope="row">{groupLabel(t, 'ladder', step.key)}</th>
              <td>{step.count}</td>
              <td>{moneyText(step.amountVnd, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The retention held cut by the day it may be released and the guarantees on the register cut by the day they lapse: what comes due and when, for all the contracts the filter selects. */
export function LadderPanel({ view }: { view: ReportView }) {
  const { t } = useTranslation();
  const ladders = view.ladders;
  if (ladders === null) return null;
  if (ladders.status === 'UNAVAILABLE') {
    return (
      <p className="callout ca1-notice" role="status" data-testid="ladder-unavailable">
        {t('ca2.ladder.unavailable', { reason: ladders.reason === null ? t('ca1.na.noRows') : reasonText(t, ladders.reason) })}
      </p>
    );
  }
  return (
    <SectionCard title={t('ca2.ladder.title')}>
      <div className="ca2-ladders">
        <Ladder title={t('ca2.ladder.retention')} steps={ladders.retention} testId="ladder-retention" />
        <Ladder title={t('ca2.ladder.guarantee')} steps={ladders.guarantee} testId="ladder-guarantee" />
      </div>
    </SectionCard>
  );
}
