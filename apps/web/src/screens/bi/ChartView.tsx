import { useTranslation } from '../../i18n';
import { kindLabel } from './dashboard-labels';
import type { WidgetKind } from './dashboard-model';
import { formatFigure } from './query-model';
import './bi.css';
import type { Group, QueryResult } from './query-model';

const WIDTH = 480;
const HEIGHT = 240;
const PAD = 32;
const TAU = Math.PI * 2;
const SERIES = 8;
/** The class of the series of a point: its colour is a token (bi.css), the same eight in the same order for bars and slices. */
const seriesClass = (index: number): string => `bi-series-${index % SERIES}`;

export interface Point {
  label: string;
  value: number;
  text: string;
}

/** The points a chart draws: the groups that have a figure. A group with no figure ("no data") is not drawn as zero; it is left out and the table says so. */
export function pointsOf(result: QueryResult, locale: string, words: { noData: string; notApplicable: string; unclassified: string }): Point[] {
  const unit = result.aggregationType === 'ratio' ? 'percent' : result.unit;
  return result.children.flatMap((group: Group) => {
    const value = group.value === null ? Number.NaN : Number(group.value);
    return Number.isFinite(value) ? [{ label: group.unclassified ? words.unclassified : group.label, value, text: formatFigure(group, unit, locale, words) }] : [];
  });
}

const scale = (points: readonly Point[]): { min: number; max: number } => {
  const values = points.map((point) => point.value);
  return { min: Math.min(0, ...values), max: Math.max(0, ...values) };
};

function Bars({ points }: { points: readonly Point[] }) {
  const { min, max } = scale(points);
  const span = max - min === 0 ? 1 : max - min;
  const band = (WIDTH - PAD * 2) / Math.max(points.length, 1);
  const y = (value: number): number => PAD + ((max - value) / span) * (HEIGHT - PAD * 2);
  return (
    <>
      {points.map((point, index) => (
        <rect key={point.label} data-point={point.label} x={PAD + index * band + band * 0.1} y={Math.min(y(point.value), y(0))} width={band * 0.8} height={Math.abs(y(point.value) - y(0))} className={seriesClass(index)}>
          <title>{`${point.label}: ${point.text}`}</title>
        </rect>
      ))}
    </>
  );
}

function Line({ points, area }: { points: readonly Point[]; area: boolean }) {
  const { min, max } = scale(points);
  const span = max - min === 0 ? 1 : max - min;
  const step = points.length > 1 ? (WIDTH - PAD * 2) / (points.length - 1) : 0;
  const coordinates = points.map((point, index) => [PAD + index * step, PAD + ((max - point.value) / span) * (HEIGHT - PAD * 2)] as const);
  const path = coordinates.map(([x, y]) => `${x},${y}`).join(' ');
  const base = PAD + (max / span) * (HEIGHT - PAD * 2);
  return (
    <>
      {area && coordinates.length > 1 ? <polygon data-area="true" points={`${PAD},${base} ${path} ${PAD + (coordinates.length - 1) * step},${base}`} className="bi-area" /> : null}
      <polyline points={path} className="bi-line" />
      {coordinates.map(([x, y], index) => (
        <circle key={(points[index] as Point).label} data-point={(points[index] as Point).label} cx={x} cy={y} r={3} className="bi-dot">
          <title>{`${(points[index] as Point).label}: ${(points[index] as Point).text}`}</title>
        </circle>
      ))}
    </>
  );
}

function Pie({ points }: { points: readonly Point[] }) {
  // A pie shows shares of a whole: only values above zero have a slice.
  const slices = points.filter((point) => point.value > 0);
  const total = slices.reduce((sum, point) => sum + point.value, 0);
  const radius = Math.min(WIDTH, HEIGHT) / 2 - PAD / 2;
  let angle = -Math.PI / 2;
  return (
    <g transform={`translate(${WIDTH / 2} ${HEIGHT / 2})`}>
      {slices.map((point, index) => {
        const sweep = (point.value / total) * TAU;
        const from = angle;
        angle += sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const d = slices.length === 1 ? `M ${radius} 0 A ${radius} ${radius} 0 1 1 ${-radius} 0 A ${radius} ${radius} 0 1 1 ${radius} 0 Z` : `M 0 0 L ${radius * Math.cos(from)} ${radius * Math.sin(from)} A ${radius} ${radius} 0 ${large} 1 ${radius * Math.cos(angle)} ${radius * Math.sin(angle)} Z`;
        return (
          <path key={point.label} data-point={point.label} d={d} className={seriesClass(index)}>
            <title>{`${point.label}: ${point.text}`}</title>
          </path>
        );
      })}
    </g>
  );
}

/**
 * The drawing of an answer of the query (ST-BI-005, BI-04): bars, a line, an area, a pie or the figure of a KPI, from the groups of the answer and nothing else. It is an image of the table under it, which stays
 * on the screen as the alternative (the chart has a text description and its points are named); the labels of the answer (period, snapshot) are shown by the caller next to it.
 */
export function ChartView({ kind, result }: { kind: Exclude<WidgetKind, 'TABLE'>; result: QueryResult }) {
  const { t, locale } = useTranslation();
  const words = { noData: t('bi.query.noData'), notApplicable: t('bi.query.notApplicable'), unclassified: t('bi.query.unclassified') };
  if (kind === 'KPI') {
    return (
      <p>
        <strong className="bi-kpi-value" data-testid="kpi-value">{formatFigure(result.total, result.aggregationType === 'ratio' ? 'percent' : result.unit, locale, words)}</strong>
      </p>
    );
  }
  const points = pointsOf(result, locale, words);
  const summary = t('bi.chart.summary', { kind: kindLabel(t, kind), count: points.length, period: result.asOfPeriod });
  // A pie shows shares of a whole: the groups of an answer that was cut are not the whole, so no slice is drawn for them (the table and its warning are).
  if (kind === 'PIE' && result.truncated) {
    return (
      <p className="sub" data-testid="chart-partial">
        {t('bi.chart.partial')}
      </p>
    );
  }
  if (points.length === 0) {
    return (
      <p className="sub" data-testid="chart-empty">
        {t('bi.chart.empty')}
      </p>
    );
  }
  return (
    <svg role="img" aria-label={summary} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" className="bi-chart" data-testid="chart" data-kind={kind}>
      <title>{summary}</title>
      {kind === 'BAR' ? <Bars points={points} /> : kind === 'PIE' ? <Pie points={points} /> : <Line points={points} area={kind === 'AREA'} />}
    </svg>
  );
}
