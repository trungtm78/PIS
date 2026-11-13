import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useCatalogue } from '../../adm/governance/hooks';
import { SCORE_PATHS } from '../score/model';

const KPI_DEFINITION = 'KPI_DEFINITION';

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
 * The KPIs of a task are picked from the register (`KPI_DEFINITION`), never typed: the template only points at the register (R37), and a code that is not in it is said so next to the choice. When the register cannot
 * be read the list of codes above stays the way to write them and this stays out of the way.
 */
export function KpiCodePicker({ value, onChange, disabled, taskCode, enabled }: KpiCodePickerProps) {
  const { t } = useTranslation();
  const catalogue = useCatalogue(enabled);
  const entry = catalogue.data?.find((one) => one.ruleType === KPI_DEFINITION);
  if (entry === undefined) return null;
  const codes = entry.codes.map((code) => code.code);
  const unknown = value.filter((code) => !codes.includes(code));
  return (
    <fieldset className="pwf-tpl-sub" data-testid={`kpi-picker-${taskCode}`}>
      <legend>{t('pwfs.picker.legend.text')}</legend>
      <p className="adm-kit-sub">
        {t('pwfs.picker.hint.text')} <Link to={SCORE_PATHS.kpiSet}>{t('pwfs.picker.set.link')}</Link>
      </p>
      <ul className="pwf-tpl-rows">
        {codes.map((code) => (
          <li key={code}>
            <label>
              <input
                type="checkbox"
                checked={value.includes(code)}
                disabled={disabled}
                data-testid={`kpi-pick-${taskCode}-${code}`}
                onChange={(event) => onChange(event.target.checked ? [...value, code] : value.filter((one) => one !== code))}
              />{' '}
              {code}
            </label>
          </li>
        ))}
      </ul>
      {unknown.length === 0 ? null : (
        <p className="callout warning" role="status" data-testid={`kpi-unknown-${taskCode}`}>
          <span aria-hidden="true">⚠ </span>
          {t('pwfs.picker.unknown.note', { codes: unknown.join(', ') })}
        </p>
      )}
    </fieldset>
  );
}
