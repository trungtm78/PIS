import { useId } from 'react';
import type { ReactNode } from 'react';
import { UnitChip } from './FilterPanel';

export interface SectionCardProps {
  title: string;
  unit?: string;
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** A card with an uppercase section title, the unit chip "Unit: …", a status and actions in the head. */
export function SectionCard({ title, unit, status, actions, children }: SectionCardProps) {
  const titleId = useId();
  return (
    <section className="ui-section" aria-labelledby={titleId}>
      <header className="ui-section__head">
        <h2 className="ui-section__title" id={titleId}>
          {title}
        </h2>
        {unit !== undefined && <UnitChip unit={unit} />}
        {status !== undefined && <span className="ui-section__status">{status}</span>}
        {actions !== undefined && <div className="ui-section__actions">{actions}</div>}
      </header>
      <div className="ui-section__body">{children}</div>
    </section>
  );
}
