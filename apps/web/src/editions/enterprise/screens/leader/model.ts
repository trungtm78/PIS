import { formatPercent } from '../../../../i18n/format';
/** A percent text with four places (`35.7143`) shown with two at most by the shared `formatPercent`, in the number format of the language; the text is the server's and is never turned into a float. */
export function percentText(value: string, locale: string): string {
  return formatPercent(value, 2, locale === 'en' ? 'en' : 'vi');
}

/** A change in percentage points, with its sign written out (`+20,00`, `-10,00`): a change of zero has none. */
export function deltaText(value: string, locale: string): string {
  const number = Number(value);
  const text = Math.abs(number).toLocaleString(locale === 'en' ? 'en-US' : 'vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return number > 0 ? `+${text}` : number < 0 ? `-${text}` : text;
}
