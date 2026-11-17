import type { ReactNode } from 'react';

/**
 * The small charts of the mockups of the advisory group (ADV-01 to ADV-05). They draw example figures only: nothing is read from the server. Each chart is one svg with a name and a sentence that says
 * what it shows (`alt`), and a legend in words beside it, so nothing is told by colour alone: the lines differ by their dashes, the areas by their outline, the bubbles by their number.
 */

const round = (value: number): number => Math.round(value * 10) / 10;

export interface ScenarioLine {
  id: string;
  /** The words of the legend: the name of the scenario and where it ends. */
  label: string;
  /** One value per month, from the month the scenarios start at to the last month. */
  values: readonly number[];
}

export interface ScenarioChartProps {
  alt: string;
  /** The names of the months under the axis, one per month. */
  months: readonly string[];
  /** What happened so far, from the first month. */
  actual: readonly number[];
  actualLabel: string;
  scenarios: readonly ScenarioLine[];
  /** The words under the chart that say what the vertical axis counts. */
  unit: string;
}

const DASHES = ['0', '7 5', '2 5'] as const;

/** A line chart of what happened and of up to three scenarios that start where it ends; the vertical axis runs from 0 to 100. */
export function ScenarioChart({ alt, months, actual, actualLabel, scenarios, unit }: ScenarioChartProps) {
  const width = 420;
  const height = 230;
  const left = 34;
  const right = 12;
  const top = 12;
  const bottom = 26;
  const x = (index: number): number => round(left + (index * (width - left - right)) / Math.max(1, months.length - 1));
  const y = (value: number): number => round(top + ((100 - value) * (height - top - bottom)) / 100);
  const path = (values: readonly number[], from: number): string => values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(from + index)} ${y(value)}`).join(' ');
  const start = actual.length - 1;
  return (
    <figure className="adv-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={alt} className="adv-chart__svg">
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line className="adv-chart__grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} />
            <text className="adv-chart__tick" x={left - 6} y={y(tick) + 4} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}
        {months.map((month, index) => (
          <text key={month} className="adv-chart__tick" x={x(index)} y={height - 8} textAnchor="middle">
            {month}
          </text>
        ))}
        {scenarios.map((line, index) => (
          <g key={line.id}>
            <path className={`adv-chart__line adv-chart__line--s${index + 1}`} d={path(line.values, start)} strokeDasharray={DASHES[index % DASHES.length]} />
            <circle className={`adv-chart__dot adv-chart__dot--s${index + 1}`} cx={x(start + line.values.length - 1)} cy={y(line.values.at(-1) ?? 0)} r="4" />
          </g>
        ))}
        <path className="adv-chart__line adv-chart__line--actual" d={path(actual, 0)} />
        <circle className="adv-chart__dot adv-chart__dot--actual" cx={x(start)} cy={y(actual.at(-1) ?? 0)} r="4.5" />
      </svg>
      <figcaption className="adv-legend">
        <span className="adv-legend__item">
          <svg viewBox="0 0 28 8" aria-hidden="true" className="adv-legend__swatch">
            <path className="adv-chart__line adv-chart__line--actual" d="M1 4H27" />
          </svg>
          {actualLabel}
        </span>
        {scenarios.map((line, index) => (
          <span className="adv-legend__item" key={line.id}>
            <svg viewBox="0 0 28 8" aria-hidden="true" className="adv-legend__swatch">
              <path className={`adv-chart__line adv-chart__line--s${index + 1}`} d="M1 4H27" strokeDasharray={DASHES[index % DASHES.length]} />
            </svg>
            {line.label}
          </span>
        ))}
        <span className="adv-legend__unit">{unit}</span>
      </figcaption>
    </figure>
  );
}

export interface Bubble {
  id: string;
  /** 0 to 100 along each axis. */
  x: number;
  y: number;
  /** 1 (small) to 3 (large). */
  size: number;
  label: string;
  note: string;
}

export interface BubbleChartProps {
  alt: string;
  xLabel: string;
  yLabel: string;
  low: string;
  high: string;
  bubbles: readonly Bubble[];
  /** What the size of a bubble means, in words. */
  sizeNote: string;
}

/** A matrix of options: each bubble carries its number, and the list beside the chart says which option the number is. */
export function BubbleChart({ alt, xLabel, yLabel, low, high, bubbles, sizeNote }: BubbleChartProps) {
  const width = 400;
  const height = 280;
  const left = 30;
  const right = 10;
  const top = 10;
  const bottom = 34;
  const x = (value: number): number => round(left + (value * (width - left - right)) / 100);
  const y = (value: number): number => round(top + ((100 - value) * (height - top - bottom)) / 100);
  return (
    <figure className="adv-chart adv-chart--split">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={alt} className="adv-chart__svg">
        <rect className="adv-chart__zone" x={x(50)} y={y(100)} width={x(100) - x(50)} height={y(50) - y(100)} rx="6" />
        <rect className="adv-chart__frame" x={x(0)} y={y(100)} width={x(100) - x(0)} height={y(0) - y(100)} rx="6" />
        <line className="adv-chart__grid" x1={x(50)} x2={x(50)} y1={y(0)} y2={y(100)} />
        <line className="adv-chart__grid" x1={x(0)} x2={x(100)} y1={y(50)} y2={y(50)} />
        <text className="adv-chart__tick" x={x(0)} y={height - 18} textAnchor="start">
          {low}
        </text>
        <text className="adv-chart__axis" x={x(50)} y={height - 4} textAnchor="middle">
          {xLabel}
        </text>
        <text className="adv-chart__tick" x={x(100)} y={height - 18} textAnchor="end">
          {high}
        </text>
        <text className="adv-chart__axis" x={12} y={y(50)} textAnchor="middle" transform={`rotate(-90 12 ${y(50)})`}>
          {yLabel}
        </text>
        {bubbles.map((bubble, index) => (
          <g key={bubble.id}>
            <circle className="adv-chart__bubble" cx={x(bubble.x)} cy={y(bubble.y)} r={10 + bubble.size * 6} />
            <text className="adv-chart__bubble-text" x={x(bubble.x)} y={y(bubble.y) + 5} textAnchor="middle">
              {index + 1}
            </text>
          </g>
        ))}
      </svg>
      <figcaption>
        <ol className="adv-ranked">
          {bubbles.map((bubble) => (
            <li key={bubble.id}>
              <strong>{bubble.label}</strong>
              <span>{bubble.note}</span>
            </li>
          ))}
        </ol>
        <p className="adv-legend__unit">{sizeNote}</p>
      </figcaption>
    </figure>
  );
}

export interface RadarChartProps {
  alt: string;
  /** The names of the spokes, clockwise from the top. */
  axes: readonly string[];
  /** 0 to `max` per spoke. */
  before: readonly number[];
  after: readonly number[];
  max: number;
  beforeLabel: string;
  afterLabel: string;
  scaleNote: string;
}

/** Two shapes on the same spokes: before as a dashed outline, after as a filled one. */
export function RadarChart({ alt, axes, before, after, max, beforeLabel, afterLabel, scaleNote }: RadarChartProps) {
  const width = 380;
  const height = 290;
  const cx = width / 2;
  const cy = 150;
  const radius = 100;
  const point = (index: number, value: number): [number, number] => {
    const angle = (Math.PI * 2 * index) / axes.length - Math.PI / 2;
    return [round(cx + Math.cos(angle) * radius * (value / max)), round(cy + Math.sin(angle) * radius * (value / max))];
  };
  const shape = (values: readonly number[]): string => values.map((value, index) => point(index, value).join(',')).join(' ');
  const rings = [0.25, 0.5, 0.75, 1].map((part) => axes.map((_, index) => point(index, max * part).join(',')).join(' '));
  return (
    <figure className="adv-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={alt} className="adv-chart__svg adv-chart__svg--radar">
        {rings.map((ring) => (
          <polygon key={ring} className="adv-chart__ring" points={ring} />
        ))}
        {axes.map((axis, index) => {
          const [x, y] = point(index, max * 1.18);
          const [ex, ey] = point(index, max);
          return (
            <g key={axis}>
              <line className="adv-chart__grid" x1={cx} y1={cy} x2={ex} y2={ey} />
              <text className="adv-chart__tick" x={x} y={y + 4} textAnchor={Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end'}>
                {axis}
              </text>
            </g>
          );
        })}
        <polygon className="adv-chart__area adv-chart__area--before" points={shape(before)} />
        <polygon className="adv-chart__area adv-chart__area--after" points={shape(after)} />
      </svg>
      <figcaption className="adv-legend">
        <span className="adv-legend__item">
          <svg viewBox="0 0 28 8" aria-hidden="true" className="adv-legend__swatch">
            <path className="adv-chart__line adv-chart__line--s2" d="M1 4H27" strokeDasharray="5 4" />
          </svg>
          {beforeLabel}
        </span>
        <span className="adv-legend__item">
          <svg viewBox="0 0 28 8" aria-hidden="true" className="adv-legend__swatch">
            <path className="adv-chart__line adv-chart__line--s3" d="M1 4H27" />
          </svg>
          {afterLabel}
        </span>
        <span className="adv-legend__unit">{scaleNote}</span>
      </figcaption>
    </figure>
  );
}

export interface BarRow {
  id: string;
  label: string;
  /** The length of the bar against `max`. */
  value: number;
  /** The words at the end of the bar. */
  text: string;
}

/** Horizontal bars with their label and their value in words; the list is the text of the chart. */
export function BarList({ label, rows, max }: { label: string; rows: readonly BarRow[]; max: number }) {
  return (
    <ul className="adv-bars" aria-label={label}>
      {rows.map((row) => (
        <li key={row.id}>
          <span className="adv-bars__label">{row.label}</span>
          <span className="adv-bars__track" aria-hidden="true">
            <span className="adv-bars__fill" style={{ width: `${Math.min(100, round((row.value * 100) / max))}%` }} />
          </span>
          <span className="adv-bars__value">{row.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A thin bar under a line of words (how sure a recommendation is, how far a unit has come); the words say the value, the bar repeats it. */
export function Meter({ percent, children }: { percent: number; children: ReactNode }) {
  return (
    <span className="adv-meter">
      <span className="adv-meter__text">{children}</span>
      <span className="adv-meter__track" aria-hidden="true">
        <span className="adv-meter__fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </span>
    </span>
  );
}

/** The mark of a block a plan does not hold; the word beside it says so. */
export function LockMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="adv-mark">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** The mark of a block a plan holds. */
export function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="adv-mark">
      <path d="m5 12 5 5 9-10" />
    </svg>
  );
}

export interface MockTableProps {
  /** The name of the table, also the name of the region that scrolls. */
  label: string;
  columns: readonly string[];
  /** One array of cells per row; the first cell is the header of the row. */
  rows: readonly (readonly ReactNode[])[];
}

/** A short table that scrolls inside its own region (reachable by keyboard), so the page never scrolls sideways. */
export function MockTable({ label, columns, rows }: MockTableProps) {
  return (
    <div className="adv-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="adv-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, at) => (
            <tr key={at}>
              {cells.map((cell, index) =>
                index === 0 ? (
                  <th key={index} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={index}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
