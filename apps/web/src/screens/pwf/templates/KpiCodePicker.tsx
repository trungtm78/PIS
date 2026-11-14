import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useCatalogue } from '../../adm/governance/hooks';
import { kpiName } from '../codes';
import { SCORE_PATHS } from '../score/model';

const KPI_DEFINITION = 'KPI_DEFINITION';
/** The KPI of the project workflow in the register: the register holds the KPI of every module, a workflow template points at its own only. */
export const isWorkflowKpi = (code: string): boolean => code.startsWith('PWF_');

export interface KpiCodePickerProps {
  /** The KPI codes the task holds now. */
  value: readonly string[];
  onChange: (codes: string[]) => void;
  disabled: boolean;
  /** The id of the task, so that the checkboxes of two tasks never share a name. */
  taskCode: string;
  /** Whether the register may be read at all (the permission to read the rule store). */
  enabled: boolean;
}

/**
 * The KPIs of a task are picked from the register (`KPI_DEFINITION`), never typed: the template only points at the register (R37), and a code that is not in it is said so next to the choice. Only the KPI of the workflow are
 * offered (and whatever the task already holds), by name with the code as a note, with a search; the KPI of the other modules are not listed. When the register cannot be read the list of codes above stays the way to write
 * them and this stays out of the way.
 */
export function KpiCodePicker({ value, onChange, disabled, taskCode, enabled }: KpiCodePickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const catalogue = useCatalogue(enabled);
  const entry = catalogue.data?.find((one) => one.ruleType === KPI_DEFINITION);
  if (entry === undefined) return null;
  const codes = entry.codes.map((code) => code.code);
  const unknown = value.filter((code) => !codes.includes(code));
  const offered = codes.filter((code) => isWorkflowKpi(code) || value.includes(code));
  const needle = query.trim().toLowerCase();
  const shown = offered.filter((code) => value.includes(code) || needle === '' || code.toLowerCase().includes(needle) || kpiName(t, code).toLowerCase().includes(needle));
  const searchId = `kpi-search-${taskCode}`;
  return (
    <fieldset className="pwf-tpl-sub pwf-picker" data-testid={`kpi-picker-${taskCode}`}>
      <legend>{t('pwfs.picker.legend.text')}</legend>
      <p className="adm-kit-sub">
        {t('pwf6.editor.kpi.hint', { count: offered.length })} <Link to={SCORE_PATHS.kpiSet}>{t('pwfs.picker.set.link')}</Link>
      </p>
      {offered.length > 6 ? (
        <div className="pwf-field pwf-picker__search">
          <label htmlFor={searchId}>{t('pwf6.editor.kpi.search')}</label>
          <input id={searchId} type="search" autoComplete="off" value={query} data-testid={`kpi-search-${taskCode}`} onChange={(event) => setQuery(event.target.value)} />
        </div>
      ) : null}
      <ul className="pwf-picker__list">
        {shown.map((code) => (
          <li key={code}>
            <label>
              <input
                type="checkbox"
                checked={value.includes(code)}
                disabled={disabled}
                data-testid={`kpi-pick-${taskCode}-${code}`}
                onChange={(event) => onChange(event.target.checked ? [...value, code] : value.filter((one) => one !== code))}
              />{' '}
              <span>{kpiName(t, code)}</span>
              {kpiName(t, code) === code ? null : <span className="pwf-code"> {code}</span>}
            </label>
          </li>
        ))}
      </ul>
      {shown.length === 0 ? <p className="pwf-hint">{t('pwf6.editor.picker.none')}</p> : null}
      {unknown.length === 0 ? null : (
        <p className="callout warning" role="status" data-testid={`kpi-unknown-${taskCode}`}>
          <span aria-hidden="true">⚠ </span>
          {t('pwfs.picker.unknown.note', { codes: unknown.join(', ') })}
        </p>
      )}
    </fieldset>
  );
}
