import { useTranslation } from '../../../i18n';
import { decimalText } from './model';
import type { TornadoBar } from './model';

export interface TornadoChartProps {
  bars: readonly TornadoBar[];
  baseNpv: string | null;
  /** The name of a parameter and of a swing, already translated. */
  parameterLabel: (parameter: string) => string;
  deltaLabel: (parameter: string, delta: string) => string;
  caption: string;
  unit: string;
}

const WIDTH = 640;
const LEFT = 150;
const RIGHT = 24;
const ROW = 34;
const TOP = 30;

/**
 * The tornado of an appraisal: for each parameter the NPV at its low and at its high value against the NPV of the base case, the parameter that moves the result most at the top. Drawn in SVG with tokens only;
 * the values are written at the ends of the bars (the direction is never told by colour alone) and the same figures sit in a table for screen readers. The scale is a drawing: no figure is computed from it.
 */
export function TornadoChart({ bars, baseNpv, parameterLabel, deltaLabel, caption, unit }: TornadoChartProps) {
  const { t, locale } = useTranslation();
  const base = baseNpv === null ? Number.NaN : Number(baseNpv);
  const drawn = bars.filter((bar) => bar.low.npv !== null && bar.high.npv !== null && Number.isFinite(base));
  if (drawn.length === 0) {
    return (
      <p className="callout" role="status" data-testid="tornado-none">
        {t('fin1.tornado.none')}
      </p>
    );
  }
  const values = drawn.flatMap((bar) => [Number(bar.low.npv), Number(bar.high.npv)]).concat(base);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min === 0 ? 1 : max - min;
  const x = (value: number): number => LEFT + ((value - min) / span) * (WIDTH - LEFT - RIGHT);
  const height = TOP + drawn.length * ROW + 12;
  return (
    <figure className="fin1-tornado" data-testid="tornado">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={caption} className="fin1-tornado__svg">
        <line x1={x(base)} x2={x(base)} y1={TOP - 12} y2={height - 8} className="fin1-tornado__base" />
        <text x={x(base)} y={TOP - 16} textAnchor="middle" className="fin1-tornado__label">
          {t('fin1.tornado.base', { value: decimalText(baseNpv, locale) })}
        </text>
        {drawn.map((bar, index) => {
          const y = TOP + index * ROW;
          const low = Number(bar.low.npv);
          const high = Number(bar.high.npv);
          return (
            <g key={bar.parameter} data-parameter={bar.parameter}>
              <text x={LEFT - 8} y={y + 16} textAnchor="end" className="fin1-tornado__label">
                {parameterLabel(bar.parameter)}
              </text>
              <rect x={Math.min(x(low), x(base))} y={y + 4} width={Math.abs(x(low) - x(base))} height={ROW - 14} className="fin1-tornado__low" />
              <rect x={Math.min(x(high), x(base))} y={y + 4} width={Math.abs(x(high) - x(base))} height={ROW - 14} className="fin1-tornado__high" />
              <text x={x(low) <= x(base) ? x(low) - 4 : x(low) + 4} y={y + 16} textAnchor={x(low) <= x(base) ? 'end' : 'start'} className="fin1-tornado__value">
                {deltaLabel(bar.parameter, bar.low.delta)}
              </text>
              <text x={x(high) >= x(base) ? x(high) + 4 : x(high) - 4} y={y + 16} textAnchor={x(high) >= x(base) ? 'start' : 'end'} className="fin1-tornado__value">
                {deltaLabel(bar.parameter, bar.high.delta)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="muted">
        {caption} · {unit}
      </figcaption>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('fin1.tornado.parameter')}</th>
            <th scope="col">{t('fin1.tornado.low')}</th>
            <th scope="col">{t('fin1.tornado.high')}</th>
            <th scope="col">{t('fin1.tornado.swing')}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.parameter}>
              <th scope="row">{parameterLabel(bar.parameter)}</th>
              <td>{`${deltaLabel(bar.parameter, bar.low.delta)}: ${decimalText(bar.low.npv, locale)}`}</td>
              <td>{`${deltaLabel(bar.parameter, bar.high.delta)}: ${decimalText(bar.high.npv, locale)}`}</td>
              <td>{decimalText(bar.swing, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
