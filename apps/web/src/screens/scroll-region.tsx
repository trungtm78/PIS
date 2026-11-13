import type { ReactNode } from 'react';

/**
 * A wide table of a screen that is not built on the kit's DataTable: it scrolls sideways inside its own named, focusable region (the kit's `.ui-table-scroll`), so that on a
 * phone the table and never the page scrolls, and a keyboard can reach and scroll it (axe scrollable-region-focusable).
 */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
