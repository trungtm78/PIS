import type { ReactNode } from 'react';

export interface TotalsRowProps {
  columns: { key: string; align?: 'left' | 'right'; pinned?: boolean }[];
  totals: Record<string, ReactNode>;
  label: string;
}

/** The tinted total row of a table: the label in the first column, the totals under the columns that have one. The caller sums the rows that are shown, never the whole set. */
export function TotalsRow({ columns, totals, label }: TotalsRowProps) {
  return (
    <tr className="ui-table__totals">
      {columns.map((column, position) => {
        const classes = ['ui-table__cell', column.align === 'right' ? 'ui-table__cell--right' : '', column.pinned === true ? 'ui-table__cell--pinned' : ''].filter(Boolean).join(' ');
        if (position === 0) {
          return (
            <th scope="row" className={classes} key={column.key}>
              {label}
            </th>
          );
        }
        return (
          <td className={classes} key={column.key}>
            {totals[column.key]}
          </td>
        );
      })}
    </tr>
  );
}
