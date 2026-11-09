import { useTranslation } from '../i18n';
import type { UiState } from './types';

export interface FlowSeries {
  label: string;
  style: 'actual' | 'plan';
  points: { x: string; y: number }[];
}

export interface FlowChartProps {
  series: FlowSeries[];
  unit: string;
  caption: string;
  state?: UiState;
  onRetry?: () => void;
}

const WIDTH = 640;
const HEIGHT = 280;
const PAD = { left: 64, right: 16, top: 16, bottom: 36 };
const TICKS = 4;

const number = (value: number): string => value.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/** A round axis maximum (1, 2, 2.5, 5 or 10 times a power of ten) so the ticks read well. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const unit = value / power;
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return step * power;
}

/** A line chart in SVG: the actual line is solid, the plan is dashed and labelled in the legend; the same figures sit in a table for screen readers. */
export function FlowChart({ series, unit, caption, state = 'ready', onRetry }: FlowChartProps) {
  const { t } = useTranslation();
  if (state === 'loading') {
    return (
      <div className="ui-flow ui-flow--loading" role="status" aria-busy="true" aria-label={t('ui.flowChart.loading')}>
        <span className="ui-skeleton ui-skeleton--chart" />
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="ui-flow ui-flow--message" role="alert">
        <span>{t('ui.flowChart.error')}</span>
        {onRetry !== undefined && (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
            {t('ui.common.retry')}
          </button>
        )}
      </div>
    );
  }
  const labels: string[] = [];
  series.forEach((line) => line.points.forEach((point) => (labels.includes(point.x) ? undefined : labels.push(point.x))));
  if (state === 'empty' || labels.length === 0) {
    return (
      <div className="ui-flow ui-flow--message" role="status">
        <span>{t('ui.flowChart.empty')}</span>
      </div>
    );
  }
  const max = niceMax(Math.max(...series.flatMap((line) => line.points.map((point) => point.y))));
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const xOf = (label: string): number => PAD.left + (labels.length === 1 ? plotW / 2 : (labels.indexOf(label) / (labels.length - 1)) * plotW);
  const yOf = (value: number): number => PAD.top + plotH - (value / max) * plotH;
  const ticks = Array.from({ length: TICKS + 1 }, (_, index) => (max / TICKS) * index);
  let actualIndex = 0;
  const lines = series.map((line) => {
    const variant = line.style === 'plan' ? 'plan' : `actual-${actualIndex++ % 3}`;
    return { line, variant };
  });
  const valueAt = (line: FlowSeries, label: string): number | undefined => line.points.find((point) => point.x === label)?.y;

  return (
    <figure className="ui-flow">
      <svg className="ui-flow__svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={caption} preserveAspectRatio="xMidYMid meet">
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="ui-flow__grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={yOf(tick)} y2={yOf(tick)} />
            <text className="ui-flow__tick" x={PAD.left - 8} y={yOf(tick) + 4} textAnchor="end">
              {number(tick)}
            </text>
          </g>
        ))}
        {labels.map((label) => (
          <text className="ui-flow__tick" key={label} x={xOf(label)} y={HEIGHT - 12} textAnchor="middle">
            {label}
          </text>
        ))}
        {lines.map(({ line, variant }) => (
          <g key={`${line.style}:${line.label}`} className={`ui-flow__series ui-flow__series--${variant}`}>
            <polyline className="ui-flow__line" fill="none" points={line.points.map((point) => `${xOf(point.x)},${yOf(point.y)}`).join(' ')} />
            {line.style === 'actual' && line.points.map((point) => <circle className="ui-flow__dot" key={point.x} cx={xOf(point.x)} cy={yOf(point.y)} r={3.5} />)}
          </g>
        ))}
      </svg>
      <figcaption className="ui-flow__legend">
        <span className="ui-flow__unit">{t('ui.flowChart.unit', { unit })}</span>
        {lines.map(({ line, variant }) => (
          <span className="ui-flow__legend-item" key={`${line.style}:${line.label}`}>
            <svg className={`ui-flow__swatch ui-flow__series--${variant}`} width="28" height="8" viewBox="0 0 28 8" aria-hidden="true">
              <line className="ui-flow__line" x1="0" x2="28" y1="4" y2="4" />
            </svg>
            {line.label} ({line.style === 'plan' ? t('ui.flowChart.stylePlan') : t('ui.flowChart.styleActual')})
          </span>
        ))}
      </figcaption>
      {/* Wrapped: a table keeps the width of its content whatever `width` says, so as the screen-reader-only element itself it stretched the page sideways on a phone. */}
      <div className="ui-sr-only">
        <table>
          <caption>{`${caption} (${unit})`}</caption>
          <thead>
            <tr>
              <th scope="col">{t('ui.flowChart.tableX')}</th>
              {series.map((line) => (
                <th scope="col" key={`${line.style}:${line.label}`}>
                  {line.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {series.map((line) => {
                  const value = valueAt(line, label);
                  return <td key={`${line.style}:${line.label}`}>{value === undefined ? '' : number(value)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
