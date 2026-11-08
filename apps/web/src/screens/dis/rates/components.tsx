import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { ContextBar, KpiStrip, KpiTile, ReadonlyStat, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Field } from '../components';
import { usePeriods } from '../hooks';
import { formatVnd } from '../report/money';
import type { SnapshotView } from '../snapshot/model';
import '../dis.css';
import './rates.css';
import { useFrozenSnapshots } from './hooks';
import { FORMULA_REFERENCE, passesWhole } from './model';
import type { Basis, Coverage, Definition, NullReason, RateFigures, RatesProblem } from './model';

type T = Translator['t'];
export const NONE = '—';

export const money = (value: string | null): string => (value === null ? NONE : formatVnd(value));

/** A change with its sign: a fall is negative and a rise is shown with a plus, so that none of them is read as zero. */
export const signedVnd = (amount: string): string => (amount.startsWith('-') ? formatVnd(amount) : amount === '0' ? '0' : `+${formatVnd(amount)}`);

export function problemMessage(t: T, problem: RatesProblem): string {
  switch (problem) {
    case 'notFound':
      return t('dis.rates.problem.notFound');
    case 'validation':
      return t('dis.rates.problem.validation');
    case 'scopeDenied':
      return t('dis.rates.problem.scopeDenied');
    case 'general':
      return t('dis.rates.problem.general');
  }
}

/** Why a rate is missing, in the words of the screen: a rate that cannot be given is never shown as 0%. */
export function reasonLabel(t: T, reason: NullReason | null): string {
  switch (reason) {
    case 'ZERO_DENOMINATOR':
      return t('dis.rates.reason.zeroDenominator');
    case 'TREASURY_COVERAGE_NONE':
      return t('dis.rates.reason.noTreasury');
    case 'NO_DATA':
      return t('dis.rates.reason.noData');
    default:
      return NONE;
  }
}

export function coverageLabel(t: T, coverage: Coverage): string {
  return coverage === 'COMPLETE' ? t('dis.rates.coverage.complete') : coverage === 'PARTIAL' ? t('dis.rates.coverage.partial') : t('dis.rates.coverage.none');
}

const percent = (t: T, value: string): string => t('dis.rates.value.text', { value });

/** The sentence a rate is shown as: the percent with its four decimals, or why there is none. */
export const rateText = (t: T, rate: string | null, reason: NullReason | null): string => (rate === null ? reasonLabel(t, reason) : percent(t, rate));

/** The label that says the formulas are proposals until the business owner signs them (D03). */
export function DefinitionBadge({ definition }: { definition: Definition }) {
  const { t } = useTranslation();
  return definition === 'SIGNED' ? (
    <span data-testid="definition-signed">
      <StatusPill tone="success">{t('dis.rates.definition.signed')}</StatusPill>
    </span>
  ) : (
    <span data-testid="definition-pending" title={t('dis.rates.definition.pending.title', { ref: FORMULA_REFERENCE })}>
      <StatusPill tone="warning">{t('dis.rates.definition.pending')}</StatusPill>
    </span>
  );
}

/** Coverage of the Treasury figures as a word on a pill: complete is success, partial a warning, none neutral; never colour alone. */
export function CoveragePill({ coverage }: { coverage: Coverage }) {
  const { t } = useTranslation();
  return <StatusPill tone={coverage === 'COMPLETE' ? 'success' : coverage === 'PARTIAL' ? 'warning' : 'neutral'}>{coverageLabel(t, coverage)}</StatusPill>;
}

/** The value of a rate tile: the percent, "Not applicable" when the denominator is zero, or the reason there is none (a rate that cannot be given is never 0%). */
function tileValue(t: T, rate: string | null, reason: NullReason | null): string {
  if (rate !== null) return percent(t, rate);
  return reason === 'ZERO_DENOMINATOR' ? t('w2dis.rates.tile.na') : reasonLabel(t, reason);
}

/** The scope line of the screens of the rates: scope, period of the snapshot, the day the Treasury figures are cut off, the unit of the money. */
export function RatesContext({ snapshotId, cutoff }: { snapshotId: string | undefined; cutoff: string | undefined }) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const frozen = useFrozenSnapshots();
  const periods = usePeriods();
  const snapshot = (frozen.data ?? []).find((candidate) => candidate.id === snapshotId);
  const period = snapshot === undefined ? undefined : (periods.data ?? []).find((candidate) => candidate.id === snapshot.periodId);
  return (
    <ContextBar
      items={[
        { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
        { label: t('dis.wr.ctx.period'), value: period?.code ?? NONE },
        { label: t('dis.rates.fact.cutoff'), value: cutoff ?? NONE },
      ]}
      unit={t('dis.wr.unit')}
    />
  );
}

/** The two rates of a scope, together and never one alone: the same numerator over the plan of the Prime Minister and over the whole plan, each tile with its denominator and its formula. */
export function RatePair({ figures, definition, cutoff, basis }: { figures: RateFigures; definition: Definition; cutoff: string; basis: Basis }) {
  const { t } = useTranslation();
  const noBasis = figures.nullReason === 'ZERO_DENOMINATOR';
  return (
    <div data-testid="rate-pair">
      <SectionCard title={basis === 'CURRENT_YEAR' ? t('dis.rates.pair.title.year') : t('dis.rates.pair.title.carryover')} unit={t('dis.wr.unit')} status={<DefinitionBadge definition={definition} />}>
        <div className="w2dis-stack">
          <div className="w2dis-pair">
            <KpiStrip label={t('dis.rates.pair.aria')}>
              <KpiTile
                label={t('dis.rates.pair.pm.label')}
                value={tileValue(t, figures.ratePmPct, figures.nullReason)}
                tone="info"
                sub={
                  <span className="w2dis-tile-sub">
                    <span>{t('w2dis.rates.tile.sub', { numerator: money(figures.numeratorVnd), denominator: money(figures.planPmVnd) })}</span>
                    {figures.ratePmPct === null && noBasis ? <small>{reasonLabel(t, figures.nullReason)}</small> : null}
                    <small>{t('dis.rates.formula.pm', { ref: FORMULA_REFERENCE })}</small>
                    {passesWhole(figures.ratePmPct) ? <small data-testid="rate-pm-over">{t('dis.rates.pair.over.note')}</small> : null}
                  </span>
                }
              />
              <KpiTile
                label={t('dis.rates.pair.total.label')}
                value={tileValue(t, figures.rateTotalPct, figures.nullReason)}
                sub={
                  <span className="w2dis-tile-sub">
                    <span>{t('w2dis.rates.tile.sub', { numerator: money(figures.numeratorVnd), denominator: money(figures.planTotalVnd) })}</span>
                    {figures.rateTotalPct === null && noBasis ? <small>{reasonLabel(t, figures.nullReason)}</small> : null}
                    <small>{t('dis.rates.formula.total', { ref: FORMULA_REFERENCE })}</small>
                  </span>
                }
              />
            </KpiStrip>
          </div>
          <div className="w2dis-facts">
            <ReadonlyStat label={t('dis.rates.fact.numerator')} value={money(figures.numeratorVnd)} />
            <ReadonlyStat label={t('dis.rates.fact.planPm')} value={money(figures.planPmVnd)} />
            <ReadonlyStat label={t('dis.rates.fact.planTotal')} value={money(figures.planTotalVnd)} />
            <ReadonlyStat label={t('dis.rates.fact.cutoff')} value={cutoff} />
            <ReadonlyStat label={t('dis.rates.fact.coverage')} value={coverageLabel(t, figures.coverage)} />
          </div>
          <details>
            <summary>{t('dis.rates.formula.summary')}</summary>
            <p className="w2dis-note">{t('dis.rates.formula.body', { ref: FORMULA_REFERENCE })}</p>
          </details>
        </div>
      </SectionCard>
    </div>
  );
}

/** The cell of a rate in a table row: the percent, or why there is none; the reason is also the tooltip. */
export function RateCell({ rate, reason, kind }: { rate: string | null; reason: NullReason | null; kind: 'pm' | 'total' }) {
  const { t } = useTranslation();
  return (
    <span data-rate={kind} title={rate === null ? reasonLabel(t, reason) : undefined}>
      {rateText(t, rate, reason)}
    </span>
  );
}

/** The two columns that hold the rates, under one group head: they always come as a pair. */
export function rateColumns<Row>(t: T, pick: (row: Row) => { ratePmPct: string | null; rateTotalPct: string | null; reason: NullReason | null }): DataTableColumn<Row>[] {
  const group = t('w2dis.rates.group.rates');
  return [
    { key: 'ratePm', header: t('dis.rates.col.ratePm'), group, align: 'right', render: (row) => <RateCell kind="pm" rate={pick(row).ratePmPct} reason={pick(row).reason} /> },
    { key: 'rateTotal', header: t('dis.rates.col.rateTotal'), group, align: 'right', render: (row) => <RateCell kind="total" rate={pick(row).rateTotalPct} reason={pick(row).reason} /> },
  ];
}

/** What is chosen to read: the most recent frozen snapshot, or one named by its period, its kind and its cutoff. */
export function SnapshotPicker({ value, onChange, snapshots, id }: { value: string; onChange(next: string): void; snapshots: readonly SnapshotView[]; id: string }) {
  const { t } = useTranslation();
  const periods = usePeriods();
  const codes = new Map((periods.data ?? []).map((period) => [period.id, period.code]));
  return (
    <Field id={id} label={t('dis.rates.snapshot.label')} hint={t('dis.rates.snapshot.hint')} error={undefined}>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('dis.rates.snapshot.latest.option')}</option>
        {snapshots.map((snapshot) => (
          <option key={snapshot.id} value={snapshot.id}>
            {t('dis.rates.snapshot.option', { period: codes.get(snapshot.periodId) ?? snapshot.periodId.slice(0, 8), cutoff: snapshot.cutoffDate })}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A link that leads to another of the screens of the rates over the same snapshot. */
export function ScreenLink({ to, children }: { to: string; children: string }) {
  return <Link to={to}>{children}</Link>;
}
