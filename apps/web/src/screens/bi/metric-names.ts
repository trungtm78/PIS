import { hasMessage } from '../../i18n';
import type { Translator } from '../../i18n';

/** `ctr_top5_share` is `ctrTop5Share` (the lint wants lower-camel segments in a catalogue key: `bi.metric.ctrTop5Share.name`). */
const camel = (code: string): string => code.toLowerCase().replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

/** The name people read for a metric: the translated name of the catalogue, else the code itself (a metric a company defined has none). The code stays the identity everywhere it is traced. */
export function metricName(t: Translator['t'], code: string): string {
  return hasMessage(`bi.metric.${camel(code)}.name`) ? t(`bi.metric.${camel(code)}.name`) : code;
}

/** For a picker or a table cell: the name with the code beside it, so the code that is traced is never lost. */
export function metricLabel(t: Translator['t'], code: string): string {
  const name = metricName(t, code);
  return name === code ? code : `${name} (${code})`;
}
