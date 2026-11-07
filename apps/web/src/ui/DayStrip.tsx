import { useId, useState } from 'react';
import { useTranslation } from '../i18n';
import type { UiState } from './types';

export interface DayStripBar {
  code: string;
  label: string;
  /** The window the standard gives the step and the window it really took; days are `YYYY-MM-DD`. A plan that cannot be counted (no working calendar) is null. */
  planned: { from: string; to: string } | null;
  actual: { from: string; to: string; open?: boolean } | null;
}

export interface DayStripProps {
  from: string;
  to: string;
  /** The days something changed. */
  changes: readonly string[];
  /** The days a step falls due. */
  deadlines: readonly string[];
  today: string;
  selectedDay?: string | undefined;
  onSelectDay: (day: string) => void;
  bars?: readonly DayStripBar[] | undefined;
  state?: UiState | undefined;
  onRetry?: (() => void) | undefined;
}

const DAY_MS = 86_400_000;
const CAP = 366;
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const dayText = (value: number): string => new Date(value * DAY_MS).toISOString().slice(0, 10);
/** Monday is 0. */
const weekdayOf = (value: number): number => (new Date(value * DAY_MS).getUTCDay() + 6) % 7;

const BAR_WIDTH = 640;
const BAR_ROW = 26;
const BAR_PAD_LEFT = 150;

/**
 * The calendar strip above a timeline (docs/process-tree-design.md section 7.2): one cell for each day from the start to today in rows of a week, filled when something changed, hatched on a weekend, flagged on a day a step
 * fell due, outlined on today; selecting a day hands it to the timeline. Under it the bars of each step, the standard dashed and what happened solid, with the overrun hatched and labelled; the same figures are a table.
 */
export function DayStrip({ from, to, changes, deadlines, today, selectedDay, onSelectDay, bars = [], state = 'ready', onRetry }: DayStripProps) {
  const { t, locale } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  const pattern = useId();
  if (state === 'loading') {
    return (
      <div className="ui-day-strip ui-day-strip--loading" role="status" aria-busy="true" aria-label={t('ui.dayStrip.loading.label')}>
        <span className="ui-skeleton ui-day-strip__skeleton" />
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="ui-day-strip ui-day-strip--message" role="alert">
        <span>{t('ui.dayStrip.error.message')}</span>
        {onRetry !== undefined && (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
            {t('ui.common.retry')}
          </button>
        )}
      </div>
    );
  }
  const first = dayNumber(from);
  const last = dayNumber(to);
  if (state === 'empty' || Number.isNaN(first) || Number.isNaN(last) || last < first) {
    return (
      <div className="ui-day-strip ui-day-strip--message" role="status">
        <span>{t('ui.dayStrip.empty.message')}</span>
      </div>
    );
  }
  const total = Math.min(CAP, last - first + 1);
  const start = last - total + 1;
  const changed = new Set(changes);
  const due = new Set(deadlines);
  const lead = weekdayOf(start);
  const cells: Array<number | null> = [...Array.from({ length: lead }, () => null), ...Array.from({ length: total }, (_, offset) => start + offset)];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<number | null>> = [];
  for (let at = 0; at < cells.length; at += 7) weeks.push(cells.slice(at, at + 7));
  const label = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
  const long = (day: string): string => new Intl.DateTimeFormat(locale, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));

  const barsStart = Math.min(start, ...bars.flatMap((bar) => [bar.planned?.from, bar.actual?.from].filter((day): day is string => day !== undefined).map(dayNumber)));
  const barsEnd = Math.max(last, ...bars.flatMap((bar) => [bar.planned?.to, bar.actual?.to].filter((day): day is string => day !== undefined).map(dayNumber)));
  const span = Math.max(1, barsEnd - barsStart + 1);
  const plot = BAR_WIDTH - BAR_PAD_LEFT - 12;
  const xOf = (day: string): number => BAR_PAD_LEFT + ((dayNumber(day) - barsStart) / span) * plot;
  const wOf = (a: string, b: string): number => Math.max(3, ((dayNumber(b) - dayNumber(a) + 1) / span) * plot);
  const overrunOf = (bar: DayStripBar): number => (bar.planned !== null && bar.actual !== null ? Math.max(0, dayNumber(bar.actual.to) - dayNumber(bar.planned.to)) : 0);

  return (
    <div className="ui-day-strip">
      <div className="ui-day-strip__head">
        <ul className="ui-day-strip__legend" aria-label={t('ui.dayStrip.legend.label')}>
          <li>
            <span className="ui-day-strip__swatch ui-day-strip__swatch--changed" aria-hidden="true" />
            {t('ui.dayStrip.legend.changed')}
          </li>
          <li>
            <span className="ui-day-strip__swatch ui-day-strip__swatch--weekend" aria-hidden="true" />
            {t('ui.dayStrip.legend.weekend')}
          </li>
          <li>
            <span aria-hidden="true">⚑</span> {t('ui.dayStrip.legend.deadline')}
          </li>
        </ul>
        {bars.length > 0 && (
          <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
            {asTable ? t('ui.dayStrip.table.hide') : t('ui.dayStrip.table.show')}
          </button>
        )}
      </div>
      <div className="ui-day-strip__weeks ui-table-scroll" role="group" aria-label={t('ui.dayStrip.grid.label')} tabIndex={0}>
        {weeks.map((week, row) => (
          <div className="ui-day-strip__week" key={row}>
            {week.map((value, column) => {
              if (value === null) return <span className="ui-day-strip__cell ui-day-strip__cell--pad" key={column} aria-hidden="true" />;
              const day = dayText(value);
              const isChanged = changed.has(day);
              const isDue = due.has(day);
              const isToday = day === today;
              const weekend = weekdayOf(value) >= 5;
              const classes = ['ui-day-strip__cell', isChanged ? 'is-changed' : '', weekend ? 'is-weekend' : '', isToday ? 'is-today' : '', selectedDay === day ? 'is-selected' : ''].filter(Boolean).join(' ');
              const words = [long(day), isChanged ? t('ui.dayStrip.cell.changed') : t('ui.dayStrip.cell.quiet'), isDue ? t('ui.dayStrip.cell.deadline') : '', isToday ? t('ui.dayStrip.cell.today') : ''].filter(Boolean).join(', ');
              return (
                <button key={day} type="button" className={classes} aria-label={words} aria-pressed={selectedDay === day} data-day={day} onClick={() => onSelectDay(day)}>
                  <span className="ui-day-strip__num">{label(day)}</span>
                  {isChanged && <span className="ui-day-strip__dot" aria-hidden="true" />}
                  {isDue && (
                    <span className="ui-day-strip__flag" aria-hidden="true">
                      ⚑
                    </span>
                  )}
                  {isToday && <span className="ui-day-strip__today">{t('ui.dayStrip.cell.todayShort')}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {bars.length > 0 && !asTable && (
        <svg className="ui-day-strip__bars" viewBox={`0 0 ${BAR_WIDTH} ${bars.length * BAR_ROW + 8}`} role="img" aria-label={t('ui.dayStrip.bars.label')} preserveAspectRatio="xMinYMin meet">
          <defs>
            <pattern id={pattern} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" className="ui-day-strip__hatch" strokeWidth="3" />
            </pattern>
          </defs>
          {bars.map((bar, row) => {
            const y = 4 + row * BAR_ROW;
            const over = overrunOf(bar);
            return (
              <g key={bar.code}>
                <text x={BAR_PAD_LEFT - 8} y={y + 14} textAnchor="end" className="ui-day-strip__bar-label">
                  {bar.label}
                </text>
                {bar.planned !== null && <rect x={xOf(bar.planned.from)} y={y} width={wOf(bar.planned.from, bar.planned.to)} height={18} rx={4} className="ui-day-strip__bar ui-day-strip__bar--plan" />}
                {bar.actual !== null && <rect x={xOf(bar.actual.from)} y={y + 4} width={wOf(bar.actual.from, bar.actual.to)} height={10} rx={3} className="ui-day-strip__bar ui-day-strip__bar--actual" />}
                {over > 0 && bar.planned !== null && bar.actual !== null && (
                  <>
                    <rect x={xOf(bar.planned.to) + plot / span} y={y + 4} width={Math.max(3, (over * plot) / span)} height={10} rx={3} fill={`url(#${pattern})`} className="ui-day-strip__bar ui-day-strip__bar--over" />
                    <text x={xOf(bar.actual.to) + plot / span + 4} y={y + 13} className="ui-day-strip__bar-over">
                      {t('ui.dayStrip.bars.over', { days: over })}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {bars.length > 0 && asTable && (
        <div className="ui-table-scroll" role="region" aria-label={t('ui.dayStrip.bars.label')} tabIndex={0}>
          <table className="ui-day-strip__table">
            <caption>{t('ui.dayStrip.bars.label')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('ui.dayStrip.table.step')}</th>
                <th scope="col">{t('ui.dayStrip.table.planned')}</th>
                <th scope="col">{t('ui.dayStrip.table.actual')}</th>
                <th scope="col">{t('ui.dayStrip.table.over')}</th>
              </tr>
            </thead>
            <tbody>
              {bars.map((bar) => (
                <tr key={bar.code}>
                  <th scope="row">{bar.label}</th>
                  <td>{bar.planned === null ? t('ui.dayStrip.table.noPlan') : t('ui.dayStrip.table.window', { from: label(bar.planned.from), to: label(bar.planned.to) })}</td>
                  <td>{bar.actual === null ? t('ui.dayStrip.table.notReached') : t('ui.dayStrip.table.window', { from: label(bar.actual.from), to: label(bar.actual.to) })}</td>
                  <td>{overrunOf(bar) > 0 ? t('ui.dayStrip.bars.over', { days: overrunOf(bar) }) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
