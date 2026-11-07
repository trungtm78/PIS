import type { ReactNode } from 'react';

export interface KpiStripProps {
  children: ReactNode;
  label?: string;
}

/** A responsive grid of KpiTile / PeriodProgress: four columns, then two, then one. */
export function KpiStrip({ children, label }: KpiStripProps) {
  return (
    <div className="ui-kpi-strip" role={label === undefined ? undefined : 'group'} aria-label={label}>
      {children}
    </div>
  );
}
