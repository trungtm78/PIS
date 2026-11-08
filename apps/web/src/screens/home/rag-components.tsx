import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { StatusPill } from '../../ui';
import { Field } from '../mne/components';
import { RagBandBadge, bandLabel } from './gov-components';
import { OVERRIDE_BANDS, checkOverrideTarget, overrideWindow, scoreDelta } from './gov-model';
import type { OverrideBand, RagFactor, RagUnit, RagWeek } from './gov-model';
import { dayText } from './overview-model';

type T = Translator['t'];

/** A number as the screen writes it: at most two decimals, the decimal sign of the language. */
export function numberText(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { maximumFractionDigits: 2 }).format(value);
}

export function factorName(t: T, code: string): string {
  switch (code) {
    case 'EWS_RATE_VS_PACE':
      return t('govc.home.rag.factor.ratePace');
    case 'EWS_CRITICAL_WARNINGS':
      return t('govc.home.rag.factor.critical');
    case 'EWS_OVERDUE_EXPLANATIONS':
      return t('govc.home.rag.factor.overdue');
    case 'EWS_NO_DATA_SHARE':
      return t('govc.home.rag.factor.noDataShare');
    default:
      // A factor the screen has no name for is shown by its code, not hidden.
      return code;
  }
}

const withUnit = (code: string, text: string): string => (code === 'EWS_NO_DATA_SHARE' ? `${text}%` : text);

/** The value of a factor against its line, in words: "reaches 0.55 (green from 0.9, amber from 0.6)". A factor with no value says so. */
export function factorLine(t: T, locale: string, factor: RagFactor): string {
  if (factor.value === null) return t('govc.home.rag.factor.noValue');
  const params = { value: withUnit(factor.code, numberText(factor.value, locale)), green: withUnit(factor.code, numberText(factor.green, locale)), amber: withUnit(factor.code, numberText(factor.amber, locale)) };
  return factor.direction === 'HIGHER_IS_BETTER' ? t('govc.home.rag.line.higher', params) : t('govc.home.rag.line.lower', params);
}

const WIDTH = 160;
const HEIGHT = 44;
const PAD = 5;

/** The weeks of the trend as a small line of scores (the higher the worse), with every week written in a table that opens under it: the picture is never the only way to read the numbers. */
export function Trend({ weeks, unitName }: { weeks: readonly RagWeek[]; unitName: string }) {
  const { t, locale } = useTranslation();
  const tableId = useId();
  const scored = weeks.filter((week) => week.score !== null);
  const step = weeks.length > 1 ? (WIDTH - 2 * PAD) / (weeks.length - 1) : 0;
  const at = (index: number, score: number): { x: number; y: number } => ({ x: PAD + index * step, y: HEIGHT - PAD - (Math.max(0, Math.min(100, score)) / 100) * (HEIGHT - 2 * PAD) });
  // A week with no score breaks the line (it is not drawn as 0).
  let path = '';
  let open = false;
  weeks.forEach((week, index) => {
    if (week.score === null) {
      open = false;
      return;
    }
    const point = at(index, week.score);
    path += `${open ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
    open = true;
  });
  const first = scored[0];
  const last = scored[scored.length - 1];
  const summary = first === undefined || last === undefined ? t('govc.home.rag.trend.none') : t('govc.home.rag.trend.aria', { name: unitName, count: weeks.length, from: numberText(first.score ?? 0, locale), to: numberText(last.score ?? 0, locale) });
  return (
    <div className="home-trend" data-testid="rag-trend">
      {scored.length === 0 ? (
        <p className="sub">{t('govc.home.rag.trend.none')}</p>
      ) : (
        <svg className="home-trend__svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={summary} aria-describedby={tableId}>
          <path className="home-trend__line" d={path.trim()} />
          {weeks.map((week, index) => (week.score === null ? null : <circle key={week.weekStart} className="home-trend__dot" cx={at(index, week.score).x} cy={at(index, week.score).y} r="2.5" />))}
        </svg>
      )}
      <details className="home-trend__table">
        <summary>{t('govc.home.rag.trend.table')}</summary>
        <table id={tableId}>
          <caption className="ui-sr-only">{t('govc.home.rag.trend.caption', { name: unitName })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('govc.home.rag.trend.week')}</th>
              <th scope="col">{t('govc.home.rag.col.score')}</th>
              <th scope="col">{t('govc.home.rag.col.band')}</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week.weekStart}>
                <td>{dayText(week.weekStart)}</td>
                <td>{week.score === null ? t('govc.home.rag.score.none') : numberText(week.score, locale)}</td>
                <td>{bandLabel(t, week.band)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export interface UnitCardProps {
  unit: RagUnit;
  today: string;
  minCoverage: number | null;
  /** Whether this person may put a colour over the rules' (the permission, and not a frozen workspace). */
  canOverride: boolean;
  onOverride: (unit: RagUnit, band: OverrideBand, until: string) => void;
  onWithdraw: (unit: RagUnit) => void;
}

/** One unit: the colour as text and a shape, the score, the share of the data there, why (one to three factors), the week before, the trend, and the override beside the colour of the rules. */
export function RagUnitCard({ unit, today, minCoverage, canOverride, onOverride, onWithdraw }: UnitCardProps) {
  const { t, locale } = useTranslation();
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const choices = OVERRIDE_BANDS.filter((band) => band !== unit.ruleBand);
  const [band, setBand] = useState<OverrideBand | ''>('');
  const [until, setUntil] = useState('');
  const [tried, setTried] = useState(false);
  const window = overrideWindow(today);
  const problems = checkOverrideTarget({ band, until }, unit.ruleBand, today);
  const delta = scoreDelta(unit);
  const label = unit.code === '' ? unit.name : `${unit.code} ${unit.name}`.trim();
  const noData = unit.band === 'NO_DATA';
  const partial = !noData && unit.coveragePct !== null && unit.coveragePct < 100;
  const reset = (): void => {
    setEditing(false);
    setBand('');
    setUntil('');
    setTried(false);
  };
  return (
    <article className="home-rag-card" data-testid={`rag-unit-${unit.unitId}`} data-band={unit.band} aria-labelledby={headingId}>
      <header className="home-rag-card__head">
        <h3 id={headingId}>{label}</h3>
        <span className="home-badges">
          <RagBandBadge band={unit.band} />
          {unit.overridden ? <StatusPill tone="info">{t('govc.home.rag.overridden')}</StatusPill> : null}
          {partial ? <StatusPill tone="warning">{t('govc.home.rag.partial')}</StatusPill> : null}
        </span>
      </header>
      {unit.overridden && unit.override !== null ? (
        <div className="home-rag-override" data-testid={`rag-override-${unit.unitId}`}>
          <p>
            <strong>{t('govc.home.rag.override.rules')}</strong> <RagBandBadge band={unit.ruleBand} /> <span aria-hidden="true">→</span> <strong>{t('govc.home.rag.override.shown')}</strong> <RagBandBadge band={unit.override.band} />
          </p>
          <dl className="aud-facts">
            <dt>{t('govc.home.rag.override.reason')}</dt>
            <dd>{unit.override.reason}</dd>
            <dt>{t('govc.home.rag.override.until')}</dt>
            <dd>{dayText(unit.override.until)}</dd>
            <dt>{t('govc.home.rag.override.by')}</dt>
            <dd>{unit.override.by === '' ? '—' : unit.override.by}</dd>
          </dl>
          {canOverride ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onWithdraw(unit)}>
              {t('govc.home.rag.override.withdraw')}
            </button>
          ) : null}
        </div>
      ) : null}
      <dl className="aud-facts">
        <dt>{t('govc.home.rag.col.score')}</dt>
        <dd data-testid={`rag-score-${unit.unitId}`}>
          {unit.score === null ? t('govc.home.rag.score.none') : t('govc.home.rag.score.value', { score: numberText(unit.score, locale) })}
          {delta === null || delta === 0 ? null : <> · {delta > 0 ? t('govc.home.rag.delta.worse', { delta: numberText(delta, locale) }) : t('govc.home.rag.delta.better', { delta: numberText(Math.abs(delta), locale) })}</>}
        </dd>
        <dt>{t('govc.home.rag.col.coverage')}</dt>
        <dd data-testid={`rag-coverage-${unit.unitId}`}>{unit.coveragePct === null ? '—' : `${numberText(unit.coveragePct, locale)}%`}</dd>
        <dt>{t('govc.home.rag.col.previous')}</dt>
        <dd data-testid={`rag-previous-${unit.unitId}`}>
          {unit.previous === null ? (
            t('govc.home.rag.previous.none')
          ) : (
            <>
              {bandLabel(t, unit.previous.band)}
              {unit.previous.score === null ? null : ` · ${t('govc.home.rag.score.value', { score: numberText(unit.previous.score, locale) })}`} ({dayText(unit.previous.weekStart)})
            </>
          )}
        </dd>
      </dl>
      {noData ? (
        <p role="status" data-testid={`rag-nodata-${unit.unitId}`}>
          {minCoverage === null || unit.coveragePct === null ? t('govc.home.rag.noData.body') : t('govc.home.rag.noData.coverage', { coverage: numberText(unit.coveragePct, locale), min: numberText(minCoverage, locale) })}
        </p>
      ) : unit.reasons.length === 0 ? (
        <p className="sub">{t('govc.home.rag.reasons.none')}</p>
      ) : (
        <div data-testid={`rag-reasons-${unit.unitId}`}>
          <h4>{t('govc.home.rag.reasons.title')}</h4>
          <ol className="home-lines">
            {unit.reasons.map((factor) => (
              <li key={factor.code} data-factor={factor.code}>
                <strong>{factorName(t, factor.code)}</strong>: {factorLine(t, locale, factor)} · {t('govc.home.rag.points', { points: numberText(factor.points, locale) })}
              </li>
            ))}
          </ol>
        </div>
      )}
      <Trend weeks={unit.trend} unitName={label} />
      {canOverride && !unit.overridden && !editing ? (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setEditing(true)} aria-label={t('govc.home.rag.override.open', { name: label })}>
          {t('govc.home.rag.override.action')}
        </button>
      ) : null}
      {canOverride && !unit.overridden && editing ? (
        <form
          className="home-rag-form"
          data-testid={`rag-form-${unit.unitId}`}
          onSubmit={(event) => {
            event.preventDefault();
            setTried(true);
            if (problems.length === 0 && band !== '') onOverride(unit, band, until);
          }}
        >
          <Field id={`${headingId}-band`} label={t('govc.home.rag.form.band')} error={tried && problems.includes('band') ? t('govc.home.rag.form.bandError', { rules: bandLabel(t, unit.ruleBand) }) : undefined}>
            <select id={`${headingId}-band`} value={band} onChange={(event) => setBand(event.target.value as OverrideBand | '')}>
              <option value="">{t('govc.home.rag.form.bandChoose')}</option>
              {choices.map((choice) => (
                <option key={choice} value={choice}>
                  {bandLabel(t, choice)}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${headingId}-until`} label={t('govc.home.rag.form.until')} hint={t('govc.home.rag.form.untilHint', { max: dayText(window.max) })} error={tried && problems.includes('until') ? t('govc.home.rag.form.untilError', { max: dayText(window.max) }) : undefined}>
            <input id={`${headingId}-until`} type="date" min={window.min} max={window.max} value={until} onChange={(event) => setUntil(event.target.value)} />
          </Field>
          <div className="home-actions">
            <button type="submit" className="ui-button ui-button--primary ui-button--small">
              {t('govc.home.rag.form.next')}
            </button>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={reset}>
              {t('govc.home.rag.form.cancel')}
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}
