import { useTranslation } from '../../../i18n';
import { isWeek, shiftWeek } from './model';
import type { UnitRef } from './model';

/**
 * The week and the unit the matrix is read for: the week is typed as `2026-W42` or moved a week at a time, and a unit narrows the matrix to its issues. Both live in the address, so a link keeps them.
 * The units to choose from are those the caller reads issues of in that week (the matrix of the week without a unit), so no right to read the directory of units is needed.
 */
export function WeekControls({ week, unitId, units, onChange }: { week: string; unitId: string; units: readonly UnitRef[]; onChange(next: { week: string; unitId: string }): void }) {
  const { t } = useTranslation();
  const valid = isWeek(week);
  return (
    <form className="card" aria-label={t('iss.weekly.controls.aria')} onSubmit={(event) => event.preventDefault()} data-testid="controls">
      <button type="button" data-previous onClick={() => onChange({ week: shiftWeek(week, -1), unitId })} disabled={!valid}>
        {t('iss.weekly.week.previous')}
      </button>
      <div className="field">
        <label htmlFor="weekly-week">{t('iss.weekly.week.label')}</label>
        <input id="weekly-week" autoComplete="off" value={week} aria-invalid={!valid} onChange={(event) => onChange({ week: event.target.value.trim(), unitId })} />
        {valid ? null : (
          <small role="alert" className="field-error" data-testid="week-problem">
            {t('iss.weekly.week.invalid')}
          </small>
        )}
      </div>
      <button type="button" data-next onClick={() => onChange({ week: shiftWeek(week, 1), unitId })} disabled={!valid}>
        {t('iss.weekly.week.next')}
      </button>
      <div className="field">
        <label htmlFor="weekly-unit">{t('iss.weekly.unit.label')}</label>
        <select id="weekly-unit" value={unitId} onChange={(event) => onChange({ week, unitId: event.target.value })}>
          <option value="">{t('iss.weekly.unit.all')}</option>
          {unitId !== '' && !units.some((unit) => unit.id === unitId) ? <option value={unitId}>{unitId}</option> : null}
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </div>
    </form>
  );
}
