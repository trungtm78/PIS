import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { BandBadge } from '../components';
import { bandIcon, dayText, taskLink, todayInVietnam, workflowLink } from '../model';
import type { Band, DeadlineCalendar } from '../model';
import { bandWord } from '../labels';
import { weekdayWord } from './labels';
import { bareBand, calendarGrid } from './model';
import type { CalendarTask, GridCell } from './model';
import { TaskName } from '../codes';

export interface CalendarViewProps {
  month: string;
  calendar: DeadlineCalendar;
}

/** The colours a day counts, the ones that call for action first; none ("not yet in range") is not shown on a day. */
const DAY_BANDS: readonly Band[] = ['RED', 'YELLOW', 'GREEN', 'UNKNOWN'];

function DayCell({ cell, selected, today, onSelect }: { cell: GridCell; selected: boolean; today: boolean; onSelect: (date: string) => void }) {
  const { t } = useTranslation();
  const number = Number(cell.date.slice(8, 10));
  const numberNode = (
    <span className="pwf-day__number" data-today={today} aria-hidden={cell.day === undefined ? undefined : true}>
      {number}
    </span>
  );
  // Every day of the month is one kind of cell: the number in the corner, the counts under it. A day with tasks is a button that lists them; a day without is the same cell with nothing under the number.
  if (cell.day === undefined) return <span className="pwf-day pwf-day--plain">{numberNode}</span>;
  const { day } = cell;
  return (
    <button type="button" className="pwf-day" data-testid={`day-${cell.date}`} aria-pressed={selected} onClick={() => onSelect(cell.date)}>
      <span className="ui-sr-only">{t('pwf.board.calendar.day.label', { date: dayText(cell.date), total: day.total })}</span>
      {numberNode}
      <span className="pwf-day__counts">
        {DAY_BANDS.filter((band) => day.counts_by_band[band] > 0).map((band) => (
          <span key={band} className="pwf-day__count" data-band={band}>
            {`${bandIcon(band)} ${bandWord(t, band)} ${day.counts_by_band[band]}`}
          </span>
        ))}
      </span>
    </button>
  );
}

/** The month as a grid of weeks, Monday first: each day with tasks is a button that lists them; the counts of a day are the server's even when the list of tasks is cut. */
export function CalendarView({ month, calendar }: CalendarViewProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const weeks = calendarGrid(month, calendar.days);
  const chosen = calendar.days.find((day) => day.date === selected);
  const today = todayInVietnam();
  const columns: DataTableColumn<CalendarTask>[] = [
    {
      key: 'task',
      header: t('pwf.board.col.task.header'),
      render: (task) => (
        <TaskName name={task.name} code={task.task_code}>
          <Link to={taskLink(task.task_id, task.project_id)}>{task.name}</Link>
        </TaskName>
      ),
    },
    { key: 'project', header: t('pwf.board.col.project.header'), render: (task) => <Link to={workflowLink(task.project_id)}>{task.project_code}</Link> },
    { key: 'band', header: t('pwf.board.col.band.header'), render: (task) => <BandBadge band={bareBand(task.band)} showDays={false} /> },
  ];
  return (
    <div>
      <p data-testid="calendar-range" role="status">
        {t('pwf.board.calendar.range.text', { shown: calendar.shown, total: calendar.total })}
      </p>
      {calendar.truncated ? (
        <p className="callout warning pwf-notice" data-testid="calendar-truncated" role="status">
          <span aria-hidden="true">⚠ </span>
          {t('pwf.board.calendar.truncated.notice', { total: calendar.total })}
        </p>
      ) : null}
      {calendar.days.length === 0 ? (
        <p className="callout" role="status">
          {t('pwf.board.calendar.empty.text')}
        </p>
      ) : (
        <p className="pwf-hint">{t('pwf.board.calendar.pick.hint')}</p>
      )}
      <div className="ui-table-scroll pwf-calendar__region" role="region" aria-label={t('pwf.board.calendar.caption', { month })} tabIndex={0}>
      <table className="pwf-calendar" data-testid="calendar-grid">
        <caption>{t('pwf.board.calendar.caption', { month })}</caption>
        <thead>
          <tr>
            {Array.from({ length: 7 }, (_, index) => (
              <th key={index} scope="col">
                {weekdayWord(t, index)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]?.date}>
              {week.map((cell) => (
                <td key={cell.date} className={cell.inMonth ? 'pwf-calendar__in' : 'pwf-calendar__out'}>
                  {cell.inMonth ? <DayCell cell={cell} selected={selected === cell.date} today={cell.date === today} onSelect={setSelected} /> : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {chosen === undefined ? null : (
        <section data-testid="selected-day" aria-label={t('pwf.board.calendar.selected.title', { date: dayText(chosen.date) })}>
          <h3>{t('pwf.board.calendar.selected.title', { date: dayText(chosen.date) })}</h3>
          <div className="pwf-free">
          <DataTable columns={columns} rows={[...chosen.tasks]} rowKey={(task) => task.task_id} caption={t('pwf.board.calendar.selected.title', { date: dayText(chosen.date) })} state="ready" />
          </div>
        </section>
      )}
    </div>
  );
}

/** The month in words with the buttons that move to the month before and after; they stay on the screen while the month is read. */
export function MonthNav({ month, onMonth }: { month: string; onMonth: (delta: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="pwf-monthnav">
      <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="calendar-prev" onClick={() => onMonth(-1)}>
        {t('pwf.board.calendar.prev.action')}
      </button>
      <strong data-testid="calendar-month">{t('pwf.board.calendar.month.text', { month: Number(month.slice(5, 7)), year: month.slice(0, 4) })}</strong>
      <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="calendar-next" onClick={() => onMonth(1)}>
        {t('pwf.board.calendar.next.action')}
      </button>
    </div>
  );
}
