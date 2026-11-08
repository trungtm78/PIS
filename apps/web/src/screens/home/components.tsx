import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { recordLink } from '../ana/decision-model';
import { formatVnd } from '../dis/report/money';
import '../dis/dis.css';
import { FigureInfo, FlagPills, figureShown, noneText } from './figure-components';
import { FORMULA_REFERENCE, SNAPSHOT_SCREEN_PATH, drillPathOf, figureText } from './model';
import type { HomeProblem, QualityBadge, Tile } from './model';

type T = Translator['t'];

/** The value of a tile as one string: the text the server wrote for the figure and its unit, or why there is none (never 0, never a number made here). */
export const tileValue = (t: T, tile: Tile): string => figureShown(t, tile);

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
  const decide = useSession().permissions?.includes('home.decision.record') === true;
  return (
    <div className="dis-rate-tile" data-metric={tile.metricCode} {...(rate === undefined ? {} : { 'data-rate': rate })} title={t('home.tile.formula.title', { formula: tile.formula, ref: FORMULA_REFERENCE })}>
      <span className="sub">{label}</span>
      <span className="home-fig-row">
        <strong data-testid={`tile-value-${tile.metricCode}`}>
          {tile.displayValue === null ? (
            <span data-testid={`tile-none-${tile.metricCode}`}>{noneText(t, tile)}</span>
          ) : (
            <>
              <span data-testid={`tile-figure-${tile.metricCode}`}>{figureText(tile)}</span>
              {tile.unit === 'PERCENT' ? <span className="home-fig-unit">%</span> : tile.unit === 'VND' ? <span className="home-fig-unit"> {t('govc.home.unit.vnd')}</span> : null}
            </>
          )}
        </strong>
        <FigureInfo tile={tile} />
      </span>
      <FlagPills tile={tile} />
      {showSums ? (
        <small data-testid={`tile-sums-${tile.metricCode}`}>
          {t('home.tile.numerator', { value: formatVnd(tile.numerator ?? '0') })} · {t('home.tile.denominator', { value: formatVnd(tile.denominator ?? '0') })}
        </small>
      ) : null}
      <small data-testid={`tile-measure-${tile.metricCode}`}>{tile.unit === 'PERCENT' ? t('home.tile.measure.percent') : t('home.tile.measure.vnd')}</small>
      <small data-testid={`tile-formula-${tile.metricCode}`}>{t('home.tile.formula', { formula: tile.formula })}</small>
      <small data-testid={`tile-definition-${tile.metricCode}`}>
        {tile.definitionStatus === 'SIGNED' ? t('home.tile.definition.signed') : <StatusPill tone="warning">{t('home.tile.definition.pending', { ref: FORMULA_REFERENCE })}</StatusPill>}
      </small>
      <Link to={drillPathOf(tile)} aria-label={t('home.tile.drill', { label })}>
        {t('home.tile.drill.link')}
      </Link>
      {decide ? (
        <Link to={recordLink({ kind: 'KPI_TILE', metricCode: tile.metricCode })} data-testid={`tile-decide-${tile.metricCode}`}>
          {t('ana.decision.link.record')}
        </Link>
      ) : null}
    </div>
  );
}

export function QualityBadgeLabel({ badge }: { badge: QualityBadge }) {
  const { t } = useTranslation();
  switch (badge) {
    case 'OK':
      return <StatusPill tone="success">{t('home.quality.ok')}</StatusPill>;
    case 'WARN':
      return <StatusPill tone="warning">{t('home.quality.warn')}</StatusPill>;
    case 'FAIL':
      return <StatusPill tone="danger">{t('home.quality.fail')}</StatusPill>;
    case 'NOT_ASSESSED':
      return <StatusPill tone="neutral">{t('home.quality.notAssessed')}</StatusPill>;
  }
}

/** A newer snapshot was frozen while the leader reads this one: the banner offers it, and the figures on the page stay as they are until the leader takes it. */
export function NewDataBanner({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="home-queue-note" data-testid="new-data-banner">
      <p>{t('home.banner.new')}</p>
      <button type="button" className="ui-button ui-button--primary" onClick={onRefresh}>
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
