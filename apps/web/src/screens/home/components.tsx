import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { formatVnd } from '../dis/report/money';
import '../dis/dis.css';
import { FORMULA_REFERENCE, SNAPSHOT_SCREEN_PATH, drillPathOf } from './model';
import type { HomeProblem, QualityBadge, Tile } from './model';

type T = Translator['t'];

/** Why a figure is missing, in the words of the screen: a figure that cannot be given is never shown as 0. */
function nullReasonLabel(t: T, reason: string | null): string {
  switch (reason) {
    case 'NO_DATA':
      return t('home.tile.nullReason.noData');
    case 'ZERO_DENOMINATOR':
      return t('home.tile.nullReason.zeroDenominator');
    case 'TREASURY_COVERAGE_NONE':
      return t('home.tile.nullReason.treasuryNone');
    default:
      return t('home.tile.nullReason.other');
  }
}

/** The value of a tile as it is read: the percent with its four decimals, whole dong with a dot between the thousands, or why there is none. */
export function tileValue(t: T, tile: Tile): string {
  if (tile.value === null) return nullReasonLabel(t, tile.nullReason);
  return tile.unit === 'PERCENT' ? t('home.tile.value.percent', { value: tile.value }) : t('home.tile.value.vnd', { value: formatVnd(tile.value) });
}

function metricLabel(t: T, code: string): string {
  switch (code) {
    case 'DISBURSEMENT_RATE_PM':
      return t('dis.rates.col.ratePm');
    case 'DISBURSEMENT_RATE_TOTAL':
      return t('dis.rates.col.rateTotal');
    case 'DISBURSED_TREASURY':
      return t('home.tile.metric.disbursed');
    case 'PLAN_PM_ASSIGNED':
      return t('home.tile.metric.planPm');
    case 'PLAN_TOTAL':
      return t('home.tile.metric.planTotal');
    default:
      return code;
  }
}

/** Where a tile comes from: its numerator and denominator when it has them, its unit of measure, its formula and the state of the definition, and the way to the source. */
export function MetricTile({ tile, rate }: { tile: Tile; rate?: 'pm' | 'total' }) {
  const { t } = useTranslation();
  const label = metricLabel(t, tile.metricCode);
  const showSums = tile.numerator !== null && tile.denominator !== null;
  return (
    <div className="dis-rate-tile" data-metric={tile.metricCode} {...(rate === undefined ? {} : { 'data-rate': rate })} title={t('home.tile.formula.title', { formula: tile.formula, ref: FORMULA_REFERENCE })}>
      <span className="sub">{label}</span>
      <strong data-testid={`tile-value-${tile.metricCode}`}>{tileValue(t, tile)}</strong>
      {showSums ? (
        <small data-testid={`tile-sums-${tile.metricCode}`}>
          {t('home.tile.numerator', { value: formatVnd(tile.numerator ?? '0') })} · {t('home.tile.denominator', { value: formatVnd(tile.denominator ?? '0') })}
        </small>
      ) : null}
      <small data-testid={`tile-measure-${tile.metricCode}`}>{tile.unit === 'PERCENT' ? t('home.tile.measure.percent') : t('home.tile.measure.vnd')}</small>
      <small data-testid={`tile-formula-${tile.metricCode}`}>{t('home.tile.formula', { formula: tile.formula })}</small>
      <small className={tile.definitionStatus === 'SIGNED' ? undefined : 'pill warn'} data-testid={`tile-definition-${tile.metricCode}`}>
        {tile.definitionStatus === 'SIGNED' ? t('home.tile.definition.signed') : t('home.tile.definition.pending', { ref: FORMULA_REFERENCE })}
      </small>
      <Link to={drillPathOf(tile)} aria-label={t('home.tile.drill', { label })}>
        {t('home.tile.drill.link')}
      </Link>
    </div>
  );
}

export function QualityBadgeLabel({ badge }: { badge: QualityBadge }) {
  const { t } = useTranslation();
  switch (badge) {
    case 'OK':
      return <span className="pill green">{t('home.quality.ok')}</span>;
    case 'WARN':
      return <span className="pill warn">{t('home.quality.warn')}</span>;
    case 'FAIL':
      return <span className="pill warn">{t('home.quality.fail')}</span>;
    case 'NOT_ASSESSED':
      return <span className="pill">{t('home.quality.notAssessed')}</span>;
  }
}

/** A newer snapshot was frozen while the leader reads this one: the banner offers it, and the figures on the page stay as they are until the leader takes it. */
export function NewDataBanner({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="card" data-testid="new-data-banner">
      <p>{t('home.banner.new')}</p>
      <button type="button" className="primary" onClick={onRefresh}>
        {t('home.banner.refresh')}
      </button>
    </div>
  );
}

/** The page of a failure that is not the standard state: nothing frozen yet, a snapshot that is not frozen, a unit that is not the reader's, a figure that cannot be given. */
export function ProblemCard({ problem }: { problem: HomeProblem }) {
  const { t } = useTranslation();
  switch (problem) {
    case 'noSnapshot':
      return (
        <div className="card statecard" role="status" data-testid="home-empty">
          <h2>{t('home.empty.title')}</h2>
          <p className="muted">{t('home.empty.body')}</p>
          <Link to={SNAPSHOT_SCREEN_PATH}>{t('home.empty.link')}</Link>
        </div>
      );
    case 'notFrozen':
      return (
        <div className="card statecard" role="alert">
          <p>{t('home.problem.notFrozen')}</p>
        </div>
      );
    case 'unitDenied':
      return (
        <div className="card statecard" role="alert">
          <p>{t('home.problem.unitDenied')}</p>
        </div>
      );
    case 'unavailable':
      return (
        <div className="card statecard" role="alert">
          <p>{t('home.problem.unavailable')}</p>
        </div>
      );
    case 'validation':
      return (
        <div className="card statecard" role="alert">
          <p>{t('home.problem.validation')}</p>
        </div>
      );
    case 'general':
      return null;
  }
}
