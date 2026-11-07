import type { ReactNode, TableHTMLAttributes } from 'react';
import '../../ui';
import './kit-table.css';

type DataAttributes = { [K in `data-${string}`]?: string | boolean };

export type KitTableProps = Omit<TableHTMLAttributes<HTMLTableElement>, 'children'> &
  DataAttributes & {
    /** The name of the table, read by screen readers and shown as the name of its scroll region. */
    caption: string;
    /** The accessible name of the table itself when it differs from the caption. */
    label?: string;
    testId?: string;
    children: ReactNode;
  };

/**
 * The look of the kit's DataTable for a table whose rows carry attributes or cells the kit's column model cannot hold (data attributes on the row, inputs in the cells):
 * the same wrapper, sticky head, row height and scroll region (the page never scrolls sideways), with the markup of the rows left to the screen.
 */
export function KitTable({ caption, label, testId, className, children, ...rest }: KitTableProps) {
  return (
    <div className="ui-table-wrap">
      <div className="ui-table-scroll" role="region" aria-label={caption} tabIndex={0}>
        <table {...rest} className={['ui-table', 'adm-kit-table', className].filter(Boolean).join(' ')} aria-label={label ?? rest['aria-label']} data-testid={testId ?? rest['data-testid']}>
          <caption className="ui-sr-only">{caption}</caption>
          {children}
        </table>
      </div>
    </div>
  );
}
