import { useTranslation } from '../../i18n';
import { dayMonth, daysBetween } from './format';
import './alerts.css';

export interface DeadlineCountdownProps {
  /** The day the item is due on (YYYY-MM-DD), or null when it has none. */
  dueOn: string | null;
  /** The day it is today (YYYY-MM-DD) in Vietnam; the caller owns the clock so the component is a pure function of its props. */
  today: string;
  /** Days late as the API counts them (counted from the original day); wins over the difference of the two days when it is above 0. */
  daysLate?: number;
}

/** "Còn 2 ngày · 09/11", "Hôm nay", "Quá hạn 3 ngày". No seconds and no live region: a screen reader reads it where it is and is never re-announced. */
export function DeadlineCountdown({ dueOn, today, daysLate }: DeadlineCountdownProps) {
  const { t } = useTranslation();
  if (dueOn === null) {
    return (
      <span className="mv-alert-deadline" data-tone="neutral">
        {t('alerts.deadline.none')}
      </span>
    );
  }
  const difference = daysBetween(today, dueOn);
  const late = daysLate !== undefined && daysLate > 0 ? daysLate : difference < 0 ? -difference : 0;
  if (late > 0) {
    return (
      <time className="mv-alert-deadline" data-tone="danger" dateTime={dueOn}>
        {t('alerts.deadline.late', { days: late })}
      </time>
    );
  }
  if (difference === 0) {
    return (
      <time className="mv-alert-deadline" data-tone="warning" dateTime={dueOn}>
        {t('alerts.deadline.today')}
      </time>
    );
  }
  return (
    <time className="mv-alert-deadline" data-tone={difference <= 2 ? 'warning' : 'neutral'} dateTime={dueOn}>
      {t('alerts.deadline.left', { days: difference, date: dayMonth(dueOn) })}
    </time>
  );
}
