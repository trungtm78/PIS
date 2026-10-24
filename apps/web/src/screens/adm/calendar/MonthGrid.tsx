import { memo } from 'react';
import { useTranslation } from '../../../i18n';
import { dayKindLabel } from './labels';
import { monthWeeks } from './model';
import type { DayRules } from './model';

const REFERENCE_MONDAY = Date.UTC(2024, 0, 1);
const DAY_MS = 86_400_000;
const WEEKDAY_COUNT = 7;

// A formatter is expensive to build and a year shows twelve months: one per locale and style is kept.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(locale: string, field: 'weekday' | 'month', style: 'short' | 'long'): Intl.DateTimeFormat {
  const key = `${locale}/${field}/${style}`;
  let format = formatters.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, { [field]: style, timeZone: 'UTC' });
    formatters.set(key, format);
  }
  return format;
}

/** The weekday names in the language of the screen, Monday first. */
export function weekdayNames(locale: string, style: 'short' | 'long'): string[] {
  const format = formatterFor(locale, 'weekday', style);
  return Array.from({ length: WEEKDAY_COUNT }, (_, index) => format.format(new Date(REFERENCE_MONDAY + index * DAY_MS)));
}

export interface MonthGridProps {
  rules: DayRules;
  year: number;
  /** Zero-based month. */
  month: number;
  /** When given, a day is a button that marks or clears the day; otherwise the month is only shown. */
  onToggle?: (date: string) => void;
}

/**
 * One month of a working calendar, Monday first: a worked day, a day off, a holiday and a compensated working day each look
 * different and each says what it is to a screen reader, so the colour is never the only sign (ADM-07). It is memoised: typing
 * in the form does not draw the twelve months again.
 */
export const MonthGrid = memo(function MonthGrid({ rules, year, month, onToggle }: MonthGridProps) {
  const { t, locale } = useTranslation();
  const monthName = formatterFor(locale, 'month', 'long').format(new Date(Date.UTC(year, month, 1)));
  const heads = weekdayNames(locale, 'short');
  return (
    <table className="cal-month" data-month={month + 1}>
      <caption>{monthName}</caption>
      <thead>
        <tr>
          {heads.map((head, index) => (
            <th key={index} scope="col">
              {head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {monthWeeks(rules, year, month).map((week, row) => (
          <tr key={row}>
            {week.map((cell, column) => (
              <td key={column}>
                {cell === null ? null : onToggle === undefined ? (
                  <span className={`cal-day ${cell.kind}`} data-date={cell.date} data-kind={cell.kind}>
                    {cell.day}
                    <span className="sr-only">{`, ${dayKindLabel(t, cell.kind)}`}</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`cal-day ${cell.kind}`}
                    data-date={cell.date}
                    data-kind={cell.kind}
                    aria-pressed={cell.kind === 'holiday' || cell.kind === 'compensated'}
                    aria-label={`${cell.date}, ${dayKindLabel(t, cell.kind)}`}
                    onClick={() => onToggle(cell.date)}
                  >
                    {cell.day}
                  </button>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
});
