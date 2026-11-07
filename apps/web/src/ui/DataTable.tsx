import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { TablePager } from './TablePager';
import { TotalsRow } from './TotalsRow';
import type { Severity, UiState } from './types';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  group?: string;
  align?: 'left' | 'right';
  pinned?: boolean;
  render: (row: T) => ReactNode;
}

export interface DataTablePage {
  from: number;
  to: number;
  total: number;
  size: number;
  index: number;
  onPage: (index: number) => void;
  onSize: (size: number) => void;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  totals?: Record<string, ReactNode>;
  totalsLabel?: string;
  severity?: (row: T) => Severity | null;
  page?: DataTablePage;
  state?: UiState;
  emptyKind?: 'none' | 'filtered' | 'noPeriod';
  onClearFilters?: () => void;
  onRetry?: () => void;
  caption: string;
}

const SKELETON_ROWS = 5;

const cellClass = (column: { align?: 'left' | 'right'; pinned?: boolean }, base: string): string =>
  [base, column.align === 'right' ? `${base}--right` : '', column.pinned === true ? `${base}--pinned` : ''].filter(Boolean).join(' ');

interface HeadCell {
  key: string;
  label: string;
  span: number;
  rows: number;
  pinned: boolean;
  right: boolean;
  group: boolean;
}

/** The two head rows: a group cell spans its columns; a column without a group spans both rows. */
function headRows<T>(columns: DataTableColumn<T>[]): { top: HeadCell[]; bottom: HeadCell[]; grouped: boolean } {
  const grouped = columns.some((column) => column.group !== undefined);
  const top: HeadCell[] = [];
  const bottom: HeadCell[] = [];
  columns.forEach((column, position) => {
    const cell: HeadCell = { key: column.key, label: column.header, span: 1, rows: 1, pinned: column.pinned === true, right: column.align === 'right', group: false };
    if (!grouped) {
      top.push(cell);
    } else if (column.group === undefined) {
      top.push({ ...cell, rows: 2 });
    } else {
      bottom.push(cell);
      const previous = columns[position - 1];
      const last = top[top.length - 1];
      if (previous !== undefined && previous.group === column.group && last !== undefined && last.group) last.span += 1;
      else top.push({ key: `group:${position}:${column.group}`, label: column.group, span: 1, rows: 1, pinned: false, right: false, group: true });
    }
  });
  return { top, bottom, grouped };
}

/** The table of every list: two-tier sticky head, right-aligned numbers, a pinned first column, a totals row, a severity stripe and the pager. */
export function DataTable<T>({ columns, rows, rowKey, totals, totalsLabel, severity, page, state = 'ready', emptyKind = 'none', onClearFilters, onRetry, caption }: DataTableProps<T>) {
  const { t } = useTranslation();
  const { top, bottom } = headRows(columns);
  const count = columns.length;
  const severityLabel = (level: Severity): string => (level === 'URGENT' ? t('ui.dataTable.severity.URGENT') : level === 'ACTION' ? t('ui.dataTable.severity.ACTION') : t('ui.dataTable.severity.WATCH'));
  const empty = state === 'empty' || (state === 'ready' && rows.length === 0);
  const emptyText =
    emptyKind === 'filtered' ? t('ui.dataTable.emptyFiltered') : emptyKind === 'noPeriod' ? t('ui.dataTable.emptyNoPeriod') : t('ui.dataTable.emptyNone');
  const headCell = (cell: HeadCell, rowPosition: 'top' | 'bottom') => (
    <th
      key={cell.key}
      scope={cell.group ? (cell.span > 1 ? 'colgroup' : 'col') : 'col'}
      colSpan={cell.span > 1 ? cell.span : undefined}
      rowSpan={cell.rows > 1 ? cell.rows : undefined}
      className={['ui-table__head', cell.group ? 'ui-table__head--group' : '', rowPosition === 'bottom' ? 'ui-table__head--sub' : '', cell.right ? 'ui-table__head--right' : '', cell.pinned ? 'ui-table__head--pinned' : ''].filter(Boolean).join(' ')}
    >
      {cell.label}
    </th>
  );
  return (
    <div className="ui-table-wrap">
      <div className="ui-table-scroll" role="region" aria-label={caption} tabIndex={0}>
        <table className="ui-table" aria-busy={state === 'loading' ? true : undefined}>
          <caption className="ui-sr-only">{caption}</caption>
          <thead>
            <tr>{top.map((cell) => headCell(cell, 'top'))}</tr>
            {bottom.length > 0 && <tr>{bottom.map((cell) => headCell(cell, 'bottom'))}</tr>}
          </thead>
          <tbody>
            {state === 'loading' &&
              Array.from({ length: SKELETON_ROWS }, (_, row) => (
                <tr className="ui-table__row" key={row}>
                  {columns.map((column) => (
                    <td className={cellClass(column, 'ui-table__cell')} key={column.key}>
                      <span className="ui-skeleton ui-skeleton--line" aria-hidden="true" />
                    </td>
                  ))}
                </tr>
              ))}
            {state === 'error' && (
              <tr className="ui-table__row ui-table__row--message">
                <td colSpan={count} className="ui-table__cell">
                  <div role="alert" className="ui-table__message">
                    <span>{t('ui.dataTable.error')}</span>
                    {onRetry !== undefined && (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
                        {t('ui.common.retry')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {empty && (
              <tr className="ui-table__row ui-table__row--message">
                <td colSpan={count} className="ui-table__cell">
                  <div role="status" className="ui-table__message">
                    <span>{emptyText}</span>
                    {emptyKind === 'filtered' && onClearFilters !== undefined && (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClearFilters}>
                        {t('ui.dataTable.clearFilters')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {state === 'ready' &&
              rows.map((row) => {
                const level = severity?.(row) ?? null;
                return (
                  <tr className="ui-table__row" key={rowKey(row)} data-severity={level ?? undefined}>
                    {columns.map((column, position) => (
                      <td className={cellClass(column, 'ui-table__cell')} key={column.key}>
                        {position === 0 && level !== null && <span className="ui-sr-only">{t('ui.dataTable.severityPrefix', { label: severityLabel(level) })}. </span>}
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
          </tbody>
          {state === 'ready' && rows.length > 0 && totals !== undefined && (
            <tfoot>
              <TotalsRow columns={columns} totals={totals} label={totalsLabel ?? t('ui.dataTable.totals')} />
            </tfoot>
          )}
        </table>
      </div>
      {page !== undefined && state === 'ready' && rows.length > 0 && <TablePager {...page} />}
    </div>
  );
}
