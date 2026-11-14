import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { useUnitOptions } from '../board/hooks';
import { PERMISSIONS, holds } from '../model';

/** The units of the organisation register by id, for a name where the score reads carry an id only. A unit the register does not hold (or a register the caller may not read) gives the short form of the id, never a guessed name. */
export function useUnitNames(): (id: string) => string {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const units = useUnitOptions(holds(permissions, PERMISSIONS.read));
  const byId = new Map((units.data ?? []).map((unit) => [unit.id, unit.label]));
  return (id) => byId.get(id) ?? t('pwf6.score.unit.unnamed', { id: id.slice(0, 8) });
}

/** The name of a unit, or the short form of its id when the register has no name for it. */
export function UnitName({ id }: { id: string }) {
  const name = useUnitNames();
  return <>{name(id)}</>;
}

export interface UnitSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The words of the empty choice. */
  anyLabel: string;
  testId: string;
  invalid?: boolean;
  describedBy?: string | undefined;
}

/**
 * The unit as a choice from the organisation register, by name. While the register is not read, or when the caller may not read it, the field falls back to the id typed by hand (the server takes an id either way), so the
 * screen keeps working for a person without the register.
 */
export function UnitSelect({ id, value, onChange, anyLabel, testId, invalid = false, describedBy }: UnitSelectProps) {
  const { permissions } = useSession();
  const units = useUnitOptions(holds(permissions, PERMISSIONS.read));
  const options = units.data ?? [];
  if (options.length === 0) {
    return <input id={id} type="text" autoComplete="off" value={value} aria-invalid={invalid} aria-describedby={describedBy} data-testid={testId} onChange={(event) => onChange(event.target.value)} />;
  }
  const known = value === '' || options.some((option) => option.id === value);
  return (
    <select id={id} value={value} aria-invalid={invalid} aria-describedby={describedBy} data-testid={testId} onChange={(event) => onChange(event.target.value)}>
      <option value="">{anyLabel}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
      {known ? null : <option value={value}>{value}</option>}
    </select>
  );
}
