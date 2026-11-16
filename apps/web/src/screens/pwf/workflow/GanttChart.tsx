import type { CSSProperties } from 'react';
import { useTranslation } from '../../../i18n';
import { dayText } from '../model';
import type { WorkflowPhase } from '../model';
import { ganttAt, ganttDayWidth, ganttGroups, ganttScale } from './model';
import type { GanttRow, GanttScale } from './model';
import { TaskName } from '../codes';

interface Props {
  rows: readonly GanttRow[];
  phases: readonly Pick<WorkflowPhase, 'code' | 'name' | 'order'>[];
  /** Null: the chart has no "today" (the sample dates of a template). */
  today: string | null;
  /** The deadline of the whole file: a line across every row at the end of the day the marked row finishes. */
  overall?: { day: string; label: string } | undefined;
  /** The chart of a template: the bars carry the zones of the three colours, and the legend says those instead of baseline, delay and critical path. */
  variant?: 'workflow' | 'template';
}

const span = (scale: GanttScale, from: string, to: string): CSSProperties | null => {
  const left = ganttAt(scale, from);
  const right = ganttAt(scale, to, true);
  return left === null || right === null ? null : { left: `${left}%`, width: `${Math.max(right - left, 0.15)}%` };
};

const dayBefore = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const later = (a: string, b: string): string => (a > b ? a : b);

/**
 * The zones of the three colours inside the bar of a row: grey until the deadline turns green, then green, yellow and red up to the finish. The days come from the server (the working days counted back from the
 * finish on the calendars it used); a zone that begins before the row does is cut at its start.
 */
export function ganttZones(row: Pick<GanttRow, 'actual' | 'zones'>): { zone: 'idle' | 'green' | 'yellow' | 'red'; from: string; to: string }[] {
  if (row.actual === null || row.zones === null || row.zones === undefined) return [];
  const { from, to } = row.actual;
  const { green, yellow, red } = row.zones;
  const greenFrom = green === null ? from : later(green, from);
  const yellowFrom = later(later(yellow, from), greenFrom);
  const redFrom = later(later(red, from), yellowFrom);
  const parts: { zone: 'idle' | 'green' | 'yellow' | 'red'; from: string; to: string }[] = [];
  const push = (zone: 'idle' | 'green' | 'yellow' | 'red', start: string, next: string): void => {
    const end = dayBefore(next) > to ? to : dayBefore(next);
    if (start <= to && end >= start) parts.push({ zone, from: start, to: end });
  };
  push('idle', from, greenFrom);
  push('green', greenFrom, yellowFrom);
  push('yellow', yellowFrom, redFrom);
  if (redFrom <= to) parts.push({ zone: 'red', from: redFrom, to });
  return parts;
}

function Zones({ row, scale }: { row: GanttRow; scale: GanttScale }) {
  return (
    <>
      {ganttZones(row).map((part) => {
        const style = span(scale, part.from, part.to);
        return style === null ? null : <span key={part.zone} className="pwf-gantt__zone" data-zone={part.zone} style={style} />;
      })}
    </>
  );
}

function Bars({ row, scale }: { row: GanttRow; scale: GanttScale }) {
  const { t } = useTranslation();
  if (row.actual === null) return <span className="pwf-gantt__nodate">{row.undated ?? t('pwf.flow.gantt.noDate.mark')}</span>;
  const actual = span(scale, row.actual.from, row.actual.to);
  const baseline = row.baseline === null ? null : span(scale, row.baseline.from, row.baseline.to);
  // What the current bar runs past the baseline finish is the delay: it is hatched and said in days next to the bar.
  const lateFrom = row.baseline !== null && row.actual.to > row.baseline.to ? (row.baseline.to < row.actual.from ? row.actual.from : nextDay(row.baseline.to)) : null;
  const late = lateFrom === null ? null : span(scale, lateFrom, row.actual.to);
  const end = ganttAt(scale, row.actual.to, true);
  return (
    <>
      {baseline === null ? null : <span className="pwf-gantt__baseline" style={baseline} />}
      {actual === null ? null : row.milestone ? <span className="pwf-gantt__milestone" style={{ left: actual.left }} data-critical={row.critical} /> : <span className="pwf-gantt__bar" style={actual} data-critical={row.critical} data-done={row.done} data-zoned={row.zones !== null && row.zones !== undefined} />}
      {row.milestone ? null : <Zones row={row} scale={scale} />}
      {row.due === undefined || end === null ? null : (
        <span className="pwf-gantt__due" style={{ left: `${end}%` }}>
          {row.due}
        </span>
      )}
      {late === null || row.milestone ? null : <span className="pwf-gantt__late" style={late} />}
      {row.variance !== null && row.variance > 0 && end !== null ? (
        <span className="pwf-gantt__variance" style={{ left: `${end}%` }}>
          {t('pwf6.gantt.variance.text', { days: row.variance })}
        </span>
      ) : null}
    </>
  );
}

const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * The schedule on a time axis: months and weeks across the top, the name of each task fixed on the left while the bars scroll, a line for today, the first baseline dashed behind the current bar, the delay against it hatched
 * and counted in days, the critical path outlined. Colour is never the only cue: every mark has its word in the legend, and the same facts are a table one click away.
 */
export function GanttChart({ rows, phases, today, overall, variant = 'workflow' }: Props) {
  const { t } = useTranslation();
  const scale = ganttScale(rows);
  if (scale === null) return null;
  const dayWidth = ganttDayWidth(scale.days);
  const width = Math.round(scale.days * dayWidth);
  const weekLabels = dayWidth * 7 >= 46;
  const todayAt = today === null ? null : ganttAt(scale, today);
  const overallAt = overall === undefined ? null : ganttAt(scale, overall.day, true);
  const template = variant === 'template';
  const groups = ganttGroups(rows, phases);
  const track: CSSProperties = { width: `${width}px` };
  return (
    <div className="pwf-gantt" data-testid="gantt">
      <ul className="pwf-gantt__legend" aria-label={t('pwf6.gantt.legend.label')}>
        {template ? (
          <>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--idle" aria-hidden="true" /> {t('pwfx.gantt.legend.idle')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--green" aria-hidden="true" /> {t('pwfx.gantt.legend.green')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--yellow" aria-hidden="true" /> {t('pwfx.gantt.legend.yellow')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--red" aria-hidden="true" /> {t('pwfx.gantt.legend.red')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--milestone" aria-hidden="true" /> {t('pwf6.gantt.legend.milestone')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--overall" aria-hidden="true" /> {t('pwfx.gantt.legend.overall')}
            </li>
          </>
        ) : (
          <>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--bar" aria-hidden="true" /> {t('pwf6.gantt.legend.current')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--done" aria-hidden="true" /> {t('pwf6.gantt.legend.done')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--baseline" aria-hidden="true" /> {t('pwf6.gantt.legend.baseline')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--late" aria-hidden="true" /> {t('pwf6.gantt.legend.late')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--critical" aria-hidden="true" /> {t('pwf6.gantt.legend.critical')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--milestone" aria-hidden="true" /> {t('pwf6.gantt.legend.milestone')}
            </li>
            <li>
              <span className="pwf-gantt__swatch pwf-gantt__swatch--today" aria-hidden="true" /> {t('pwf6.gantt.legend.today', { day: dayText(today) })}
            </li>
          </>
        )}
      </ul>
      <div className="pwf-gantt__scroll" role="region" aria-label={t('pwf6.gantt.region.label')} tabIndex={0}>
        <div className="pwf-gantt__grid">
          <div className="pwf-gantt__corner">{t('pwf6.gantt.col.task')}</div>
          <div className="pwf-gantt__axis" style={track} aria-hidden="true">
            <div className="pwf-gantt__months">
              {scale.months.map((month) => (
                <span key={month.key} className="pwf-gantt__month" style={{ width: `${(month.days / scale.days) * 100}%` }}>
                  {month.days * dayWidth >= 116 ? t('pwf6.gantt.month.text', { month: String(month.month).padStart(2, '0'), year: month.year }) : month.days * dayWidth >= 64 ? `${String(month.month).padStart(2, '0')}/${month.year}` : month.days * dayWidth >= 28 ? String(month.month).padStart(2, '0') : ''}
                </span>
              ))}
            </div>
            <div className="pwf-gantt__weeks">
              {scale.weeks.map((week) => (
                <span key={week.day} className="pwf-gantt__week" style={{ left: `${(week.offset / scale.days) * 100}%` }}>
                  {weekLabels ? `${week.day.slice(8, 10)}/${week.day.slice(5, 7)}` : ''}
                </span>
              ))}
              {todayAt === null ? null : (
                <span className="pwf-gantt__todaymark" style={{ left: `${todayAt}%` }}>
                  {t('pwf6.gantt.today.word')}
                </span>
              )}
              {overallAt === null || overall === undefined ? null : (
                <span className="pwf-gantt__overallmark" style={{ left: `${overallAt}%` }} data-testid="gantt-overall">
                  {overall.label}
                </span>
              )}
            </div>
          </div>
          {groups.map((group) => [
            <div key={`${group.code}:label`} className="pwf-gantt__phase pwf-gantt__label">
              {group.name}
            </div>,
            <div key={`${group.code}:track`} className="pwf-gantt__phase" style={track} />,
            ...group.rows.flatMap((row) => [
              <div key={`${row.code}:label`} className="pwf-gantt__label" data-row={row.code}>
                <span className="pwf-gantt__name">{row.name}</span>
                <span className="pwf-code">
                  {row.caption ?? row.code}
                  {row.overall === true ? ` · ${t('pwfx.gantt.overall.mark')}` : ''}
                  {row.critical && !template ? ` · ${t('pwf6.flow.critical.mark')}` : ''}
                </span>
              </div>,
              <div key={`${row.code}:track`} className="pwf-gantt__track" style={track} aria-hidden="true">
                {scale.months.map((month) => (
                  <span key={month.key} className="pwf-gantt__gridline" style={{ left: `${(month.offset / scale.days) * 100}%` }} />
                ))}
                {todayAt === null ? null : <span className="pwf-gantt__today" style={{ left: `${todayAt}%` }} />}
                {overallAt === null ? null : <span className="pwf-gantt__overall" style={{ left: `${overallAt}%` }} />}
                <Bars row={row} scale={scale} />
              </div>,
            ]),
          ])}
        </div>
      </div>
      <details className="pwf-gantt__table" data-variant={variant}>
        <summary>{t('pwf6.gantt.table.summary')}</summary>
        <div className="ui-table-scroll" role="region" aria-label={t('pwf6.gantt.table.caption')} tabIndex={0}>
          <table className="pwf-steps-table">
            <caption>{t('pwf6.gantt.table.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('pwf6.gantt.col.task')}</th>
                <th scope="col">{t('pwf6.gantt.col.start')}</th>
                <th scope="col">{t('pwf6.gantt.col.finish')}</th>
                {template ? (
                  <th scope="col">{t('pwfx.gantt.col.note')}</th>
                ) : (
                  <>
                    <th scope="col">{t('pwf6.gantt.col.baseline')}</th>
                    <th scope="col" className="pwf-num">
                      {t('pwf6.gantt.col.variance')}
                    </th>
                    <th scope="col">{t('pwf6.gantt.col.critical')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.code}>
                  <th scope="row">{template ? `${row.caption ?? ''} ${row.name}`.trim() : <TaskName name={row.name} code={row.code} />}</th>
                  <td>{row.actual === null ? (row.undated ?? t('pwf.flow.gantt.noDate.mark')) : dayText(row.actual.from)}</td>
                  <td>{row.actual === null ? (row.undated ?? t('pwf.flow.gantt.noDate.mark')) : dayText(row.actual.to)}</td>
                  {template ? (
                    <td>{[row.due, row.overall === true ? t('pwfx.gantt.overall.mark') : undefined].filter((part) => part !== undefined).join(' · ')}</td>
                  ) : (
                    <>
                      <td>{row.baseline === null ? '' : dayText(row.baseline.to)}</td>
                      <td className="pwf-num">{row.variance === null ? '' : t('pwf6.gantt.days.text', { days: row.variance })}</td>
                      <td>{row.critical ? t('pwf6.gantt.critical.yes') : ''}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
