import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { Field } from '../components';
import { usePeriods } from '../hooks';
import { formatVnd } from '../report/money';
import type { SnapshotView } from '../snapshot/model';
import '../dis.css';
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
    <span className="pill green" data-testid="definition-signed">
      {t('dis.rates.definition.signed')}
    </span>
  ) : (
    <span className="pill warn" data-testid="definition-pending" title={t('dis.rates.definition.pending.title', { ref: FORMULA_REFERENCE })}>
      {t('dis.rates.definition.pending')}
    </span>
  );
}

/** The two rates of a scope, together and never one alone: the same numerator over the plan of the Prime Minister and over the whole plan. */
export function RatePair({ figures, definition, cutoff, basis }: { figures: RateFigures; definition: Definition; cutoff: string; basis: Basis }) {
  const { t } = useTranslation();
  return (
    <section className="card" aria-labelledby="rate-pair-title" data-testid="rate-pair">
      <div className="heading">
        <h2 id="rate-pair-title">{basis === 'CURRENT_YEAR' ? t('dis.rates.pair.title.year') : t('dis.rates.pair.title.carryover')}</h2>
        <DefinitionBadge definition={definition} />
      </div>
      <div className="dis-rate-pair" role="group" aria-label={t('dis.rates.pair.aria')}>
        <div className="dis-rate-tile" data-rate="pm" title={t('dis.rates.formula.pm', { ref: FORMULA_REFERENCE })}>
          <span className="sub">{t('dis.rates.pair.pm.label')}</span>
          <strong data-testid="rate-pm">{rateText(t, figures.ratePmPct, figures.nullReason)}</strong>
          {passesWhole(figures.ratePmPct) ? <small data-testid="rate-pm-over">{t('dis.rates.pair.over.note')}</small> : null}
        </div>
        <div className="dis-rate-tile" data-rate="total" title={t('dis.rates.formula.total', { ref: FORMULA_REFERENCE })}>
          <span className="sub">{t('dis.rates.pair.total.label')}</span>
          <strong data-testid="rate-total">{rateText(t, figures.rateTotalPct, figures.nullReason)}</strong>
        </div>
      </div>
      <dl className="aud-facts" data-testid="rate-facts">
        <dt>{t('dis.rates.fact.numerator')}</dt>
        <dd data-testid="fact-numerator">{money(figures.numeratorVnd)}</dd>
        <dt>{t('dis.rates.fact.planPm')}</dt>
        <dd data-testid="fact-plan-pm">{money(figures.planPmVnd)}</dd>
        <dt>{t('dis.rates.fact.planTotal')}</dt>
        <dd data-testid="fact-plan-total">{money(figures.planTotalVnd)}</dd>
        <dt>{t('dis.rates.fact.cutoff')}</dt>
        <dd data-testid="fact-cutoff">{cutoff}</dd>
        <dt>{t('dis.rates.fact.coverage')}</dt>
        <dd data-testid="fact-coverage">{coverageLabel(t, figures.coverage)}</dd>
      </dl>
      <details>
        <summary>{t('dis.rates.formula.summary')}</summary>
        <p className="sub">{t('dis.rates.formula.body', { ref: FORMULA_REFERENCE })}</p>
      </details>
    </section>
  );
}

/** The two cells of a table row that hold the rates: they always come as a pair. */
export function RateCells({ figures }: { figures: RateFigures }) {
  const { t } = useTranslation();
  return (
    <>
      <td className="num" data-rate="pm" title={figures.ratePmPct === null ? reasonLabel(t, figures.nullReason) : undefined}>
        {rateText(t, figures.ratePmPct, figures.nullReason)}
      </td>
      <td className="num" data-rate="total" title={figures.rateTotalPct === null ? reasonLabel(t, figures.nullReason) : undefined}>
        {rateText(t, figures.rateTotalPct, figures.nullReason)}
      </td>
    </>
  );
}

/** The headers of the two rate columns, with the formula in the title (CXN-03). */
export function RateHeaders() {
  const { t } = useTranslation();
  return (
    <>
      <th scope="col" className="num" title={t('dis.rates.formula.pm', { ref: FORMULA_REFERENCE })}>
        {t('dis.rates.col.ratePm')}
      </th>
      <th scope="col" className="num" title={t('dis.rates.formula.total', { ref: FORMULA_REFERENCE })}>
        {t('dis.rates.col.rateTotal')}
      </th>
    </>
  );
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
