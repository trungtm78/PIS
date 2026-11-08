import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';

export interface UnitChipProps {
  /** The unit, e.g. "Million dong"; the chip writes "Unit: …". */
  unit?: string;
  children?: ReactNode;
}

/** The unit chip "Unit: …" of every money block. */
export function UnitChip({ unit, children }: UnitChipProps) {
  const { t } = useTranslation();
  return <span className="ui-unit-chip">{unit === undefined ? children : t('ui.unitChip.label', { unit })}</span>;
}

export interface FilterPanelProps {
  children: ReactNode;
  unitLabel?: string;
  updatedAt?: string;
  actions?: ReactNode;
  /** The number of conditions that are applied; shown on the button that opens the panel under 980 px. */
  applied?: number;
}

/** The filter block of a list: the controls, the unit chip, the time of the data and the actions; under 980 px it collapses behind a button that counts the applied conditions. */
export function FilterPanel({ children, unitLabel, updatedAt, actions, applied }: FilterPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const toggleLabel = applied !== undefined && applied > 0 ? t('ui.filterPanel.toggleApplied', { count: applied }) : t('ui.filterPanel.toggle');
  return (
    <section className="ui-filter" aria-label={t('ui.filterPanel.title')} data-open={open ? 'true' : 'false'}>
      <button type="button" className="ui-filter__toggle ui-button ui-button--outline" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
        {toggleLabel}
      </button>
      <div className="ui-filter__body" id={bodyId}>
        <div className="ui-filter__controls">{children}</div>
        <div className="ui-filter__foot">
          {unitLabel !== undefined && <UnitChip unit={unitLabel} />}
          {updatedAt !== undefined && <span className="ui-filter__updated">{t('ui.filterPanel.updatedAt', { time: updatedAt })}</span>}
          {actions !== undefined && <div className="ui-filter__actions">{actions}</div>}
        </div>
      </div>
    </section>
  );
}
