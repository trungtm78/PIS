import { formatPercent } from '../i18n/format';

/**
 * The figure of a percent for a catalogue sentence that already writes the sign ("từ {pct}% trở lên"): the text of `formatPercent` (the same rounding, the same marks) without its "%". No figure is
 * the dash of `formatPercent` and a text that is not a number comes back as it came.
 */
export function percentFigure(value: string | number | null | undefined, digits = 2): string {
  const text = formatPercent(value, digits);
  return text.endsWith('%') ? text.slice(0, -1) : text;
}
