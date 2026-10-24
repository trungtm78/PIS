import { useTranslation } from '../../i18n';
import { isCalendarDate } from './model';
import { calendarOf, periodsFrom } from './reporting-calendar';
import type { ReportingPeriod } from './reporting-calendar';

export const PREVIEW_PERIODS = 8;

/** The columns of a list of periods: the same for the preview of a form and for the screen of the calendar. */
export function PeriodTable({ periods, now }: { periods: readonly ReportingPeriod[]; now: number | undefined }) {
  const { t } = useTranslation();
  return (
    <table className="table" data-testid="periods">
      <thead>
        <tr>
          <th>{t('mdm.calendar.year.column')}</th>
          <th>{t('mdm.calendar.period.column')}</th>
          <th>{t('mdm.calendar.startsOn.column')}</th>
          <th>{t('mdm.calendar.endsOn.column')}</th>
          <th>{t('mdm.calendar.deadline.column')}</th>
          {now === undefined ? null : <th>{t('mdm.calendar.locked.column')}</th>}
        </tr>
      </thead>
      <tbody>
        {periods.map((period) => (
          <tr key={period.code} data-period={period.code}>
            <td>{period.year}</td>
            <td>
              <code>{period.code}</code>
            </td>
            <td>{period.startsOn}</td>
            <td>{period.endsOn}</td>
            <td>
              <time dateTime={period.deadlineAt}>{t('mdm.calendar.deadline.text', { when: period.deadlineAt.replace('T', ' ').slice(0, 16) })}</time>
            </td>
            {now === undefined ? null : <td>{now > Date.parse(period.deadlineAt) ? t('mdm.calendar.locked.pill') : t('mdm.calendar.open.pill')}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * What a calendar that is being written would produce first, from its effective date: the first eight periods with their deadlines, so a
 * steward sees the effect of a week start or a deadline before the request goes to review (ST-MDM-004).
 */
export function CalendarPreview({ attributes, from }: { attributes: Record<string, unknown>; from: string }) {
  const { t } = useTranslation();
  const calendar = calendarOf(attributes);
  return (
    <section className="card" aria-label={t('mdm.calendar.preview.title')} data-testid="calendar-preview">
      <h3>{t('mdm.calendar.preview.title')}</h3>
      {calendar === undefined || !isCalendarDate(from) ? <p className="muted">{t('mdm.calendar.preview.incomplete')}</p> : <PeriodTable periods={periodsFrom(calendar, from, PREVIEW_PERIODS)} now={undefined} />}
    </section>
  );
}
