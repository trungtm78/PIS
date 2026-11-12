import { useTranslation } from '../../../i18n';
import { FilterPanel } from '../../../ui';
import { bandWord, statusWord } from '../labels';
import { BAND_FILTERS, STATUS_FILTERS, appliedCount } from './model';
import type { Filters, Option } from './model';

export interface FilterBarProps {
  filters: Filters;
  onChange: (change: Partial<Filters>) => void;
  onClear: () => void;
  phases: readonly string[];
  people: readonly Option[];
  units: readonly Option[];
  /** When the read of the board says how old it is, the filter panel shows it. */
  updatedAt?: string | undefined;
}

/** The choices of a filter with the value in use added when the register does not hold it (an address that names a person or a unit the list does not know keeps working). */
function withCurrent(options: readonly Option[], current: string): Option[] {
  return current === '' || options.some((option) => option.id === current) ? [...options] : [...options, { id: current, label: current }];
}

function Select({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <label className="pwf-field">
      <span>{label}</span>
      <select data-testid={`filter-${id}`} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('pwf.board.filter.any.option')}</option>
        {children}
      </select>
    </label>
  );
}

/** The filters of the board: colour, phase, person, unit, status and the days the deadline falls between. They are kept in the address by the screen. */
export function FilterBar({ filters, onChange, onClear, phases, people, units, updatedAt }: FilterBarProps) {
  const { t } = useTranslation();
  const phaseOptions = withCurrent(
    phases.map((phase) => ({ id: phase, label: phase })),
    filters.phase,
  );
  return (
    <FilterPanel applied={appliedCount(filters)} {...(updatedAt === undefined ? {} : { updatedAt })}>
      <div className="pwf-filters">
        <Select id="band" label={t('pwf.board.filter.band.label')} value={filters.band} onChange={(band) => onChange({ band })}>
          {BAND_FILTERS.map((band) => (
            <option key={band} value={band}>
              {bandWord(t, band)}
            </option>
          ))}
        </Select>
        <Select id="phase" label={t('pwf.board.filter.phase.label')} value={filters.phase} onChange={(phase) => onChange({ phase })}>
          {phaseOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
        <Select id="assignee" label={t('pwf.board.filter.person.label')} value={filters.assignee} onChange={(assignee) => onChange({ assignee })}>
          {withCurrent(people, filters.assignee).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
        {units.length > 0 ? (
          <Select id="unit" label={t('pwf.board.filter.unit.label')} value={filters.unit} onChange={(unit) => onChange({ unit })}>
            {withCurrent(units, filters.unit).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        ) : (
          <label className="pwf-field">
            <span>{t('pwf.board.filter.unitId.label')}</span>
            <input type="text" data-testid="filter-unit" value={filters.unit} onChange={(event) => onChange({ unit: event.target.value.trim() })} />
          </label>
        )}
        <Select id="status" label={t('pwf.board.filter.status.label')} value={filters.status} onChange={(status) => onChange({ status })}>
          {STATUS_FILTERS.map((status) => (
            <option key={status} value={status}>
              {statusWord(t, status)}
            </option>
          ))}
        </Select>
        <label className="pwf-field">
          <span>{t('pwf.board.filter.from.label')}</span>
          <input type="date" data-testid="filter-from" value={filters.dueFrom} max={filters.dueTo === '' ? undefined : filters.dueTo} onChange={(event) => onChange({ dueFrom: event.target.value })} />
        </label>
        <label className="pwf-field">
          <span>{t('pwf.board.filter.to.label')}</span>
          <input type="date" data-testid="filter-to" value={filters.dueTo} min={filters.dueFrom === '' ? undefined : filters.dueFrom} onChange={(event) => onChange({ dueTo: event.target.value })} />
        </label>
      </div>
      <div className="pwf-actions">
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="filter-clear" disabled={appliedCount(filters) === 0} onClick={onClear}>
          {t('pwf.board.filter.clear.action')}
        </button>
      </div>
    </FilterPanel>
  );
}
