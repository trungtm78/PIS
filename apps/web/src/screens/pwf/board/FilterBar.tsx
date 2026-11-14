import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { phaseName } from '../codes';
import { statusWord } from '../labels';
import { STATUS_FILTERS, appliedCount } from './model';
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

function Select({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
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

/**
 * The filters of the board in one compact panel: the status as a row of chips (the colour is chosen on the strip of counts above), then the phase, the person, the unit and the days the deadline falls between on one
 * line that wraps. They are kept in the address by the screen.
 */
export function FilterBar({ filters, onChange, onClear, phases, people, units, updatedAt }: FilterBarProps) {
  const { t } = useTranslation();
  const phaseOptions = withCurrent(
    phases.map((phase) => ({ id: phase, label: phaseName(t, phase) })),
    filters.phase,
  );
  const applied = appliedCount(filters);
  return (
    <section className="pwf-filterbar" aria-label={t('pwf6.board.filter.title')} data-testid="filter-bar">
      <div className="pwf-chips" role="group" aria-label={t('pwf.board.filter.status.label')}>
        <span className="pwf-chips__label">{t('pwf.board.filter.status.label')}</span>
        <button type="button" className="pwf-chip" aria-pressed={filters.status === ''} data-testid="filter-status-any" onClick={() => onChange({ status: '' })}>
          {t('pwf.board.filter.any.option')}
        </button>
        {STATUS_FILTERS.map((status) => (
          <button key={status} type="button" className="pwf-chip" aria-pressed={filters.status === status} data-testid={`filter-status-${status}`} onClick={() => onChange({ status: filters.status === status ? '' : status })}>
            {statusWord(t, status)}
          </button>
        ))}
      </div>
      <div className="pwf-filterbar__fields">
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
        <label className="pwf-field">
          <span>{t('pwf.board.filter.from.label')}</span>
          <input type="date" data-testid="filter-from" value={filters.dueFrom} max={filters.dueTo === '' ? undefined : filters.dueTo} onChange={(event) => onChange({ dueFrom: event.target.value })} />
        </label>
        <label className="pwf-field">
          <span>{t('pwf.board.filter.to.label')}</span>
          <input type="date" data-testid="filter-to" value={filters.dueTo} min={filters.dueFrom === '' ? undefined : filters.dueFrom} onChange={(event) => onChange({ dueTo: event.target.value })} />
        </label>
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="filter-clear" disabled={applied === 0} onClick={onClear}>
          {applied === 0 ? t('pwf.board.filter.clear.action') : t('pwf6.board.filter.clear.count', { count: applied })}
        </button>
      </div>
      {updatedAt === undefined ? null : (
        <p className="pwf-hint pwf-filterbar__stamp" data-testid="filter-updated">
          {t('pwf6.board.updated.text', { at: updatedAt })}
        </p>
      )}
    </section>
  );
}
