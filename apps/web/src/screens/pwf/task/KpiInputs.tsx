import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { decimalText } from '../../../i18n/format';
import { priorityWord, statusWord } from '../labels';
import { dayText } from '../model';
import type { Priority, TaskStatus } from '../model';
import { kpiInputRows, kpiInputsJson } from './model';
import type { KpiInputRow } from './model';

type T = Translator['t'];

const DAY = /^\d{4}-\d{2}-\d{2}/;
const STATUSES: readonly string[] = ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'DONE', 'ON_HOLD', 'CANCELLED'];
const PRIORITIES: readonly string[] = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];

/** The value of one fact as a person reads it: a day as dd/mm/yyyy, a number with the decimal mark of the language, yes or no, a known code in words, "none" for a fact the task does not have. */
function valueText(t: T, row: KpiInputRow, locale: string): string {
  const value = row.value;
  if (value === null || value === undefined) return t('fix11.kpi.fact.none');
  if (typeof value === 'boolean') return value ? t('fix11.kpi.fact.yes') : t('fix11.kpi.fact.no');
  if (row.key === 'estimateVnd' || row.key === 'actualVnd') return typeof value === 'number' || typeof value === 'string' ? t('fix11.kpi.fact.vnd', { amount: new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'vi-VN').format(Number(value)) }) : t('fix11.kpi.fact.none');
  if (typeof value === 'number') return decimalText(value);
  if (row.key === 'calendars' && Array.isArray(value)) {
    return value
      .map((one: unknown) => (typeof one === 'object' && one !== null ? t('fix11.kpi.fact.calendar', { year: String((one as { year?: unknown }).year ?? ''), version: String((one as { version?: unknown }).version ?? '') }) : ''))
      .filter((part) => part !== '')
      .join('; ');
  }
  if (row.key === 'excusals' && Array.isArray(value)) {
    if (value.length === 0) return t('fix11.kpi.fact.none');
    return value
      .map((one: unknown) => {
        const span = (typeof one === 'object' && one !== null ? one : {}) as { from?: unknown; to?: unknown };
        return t('fix11.kpi.fact.span', { from: dayText(typeof span.from === 'string' ? span.from : null), to: dayText(typeof span.to === 'string' ? span.to : null) });
      })
      .join('; ');
  }
  if (typeof value !== 'string') return t('fix11.kpi.fact.none');
  if (row.key === 'status' && STATUSES.includes(value)) return statusWord(t, value as TaskStatus);
  if (row.key === 'priority' && PRIORITIES.includes(value)) return priorityWord(t, value as Priority);
  if (row.key === 'unit') return value === 'CALENDAR' ? t('fix11.kpi.unit.calendar') : t('fix11.kpi.unit.working');
  if (row.key === 'against') return value === 'FIRST_BASELINE' ? t('fix11.kpi.against.first') : t('fix11.kpi.against.current');
  return DAY.test(value) ? dayText(value.slice(0, 10)) : value;
}

/**
 * The facts a KPI result was computed from (PWF-04, PWF-11, PWF-13; lane fix11): each fact by its name with its value as a person reads it (days as dd/mm/yyyy), and the whole of the stored inputs as JSON only
 * behind a disclosure, for the reader who checks a recomputation. Raw JSON is never a cell of the table.
 */
export function KpiInputs({ inputs }: { inputs: Record<string, unknown> }) {
  const { t, locale } = useTranslation();
  const rows = kpiInputRows(inputs);
  const hasAny = Object.keys(inputs).length > 0;
  return (
    <div className="pwf-kpi-inputs" data-testid="kpi-inputs">
      {rows.length === 0 ? (
        <span className="pwf-hint">{t('fix11.kpi.inputs.none')}</span>
      ) : (
        <dl className="pwf-facts">
          {rows.map((row) => (
            <div key={row.key} className="pwf-input" data-fact={row.key}>
              <dt>{t(`fix11.kpiFact.${row.key}.label`)}</dt>
              <dd>{valueText(t, row, locale)}</dd>
            </div>
          ))}
        </dl>
      )}
      {hasAny ? (
        <details className="pwf-kpi-json">
          <summary>{t('fix11.kpi.inputs.full')}</summary>
          <pre data-testid="kpi-inputs-json">{kpiInputsJson(inputs)}</pre>
        </details>
      ) : null}
    </div>
  );
}
