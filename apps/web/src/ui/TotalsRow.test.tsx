import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TotalsRow } from './TotalsRow';

const COLUMNS = [
  { key: 'name', pinned: true },
  { key: 'plan', align: 'right' as const },
  { key: 'done', align: 'right' as const },
];

describe('TotalsRow', () => {
  it('puts the label in the first column and the totals under their columns', () => {
    render(
      <table>
        <tbody>
          <TotalsRow columns={COLUMNS} totals={{ plan: '350', done: '200' }} label="Tổng cộng" />
        </tbody>
      </table>,
    );
    const row = screen.getByRole('row');
    expect(within(row).getByRole('rowheader', { name: 'Tổng cộng' })).toHaveClass('ui-table__cell--pinned');
    expect(within(row).getByRole('cell', { name: '350' })).toHaveClass('ui-table__cell--right');
    expect(within(row).getByRole('cell', { name: '200' })).toBeInTheDocument();
  });

  it('leaves a column without a total empty', () => {
    render(
      <table>
        <tbody>
          <TotalsRow columns={COLUMNS} totals={{ plan: '350' }} label="Tổng" />
        </tbody>
      </table>,
    );
    expect(screen.getAllByRole('cell')[1]).toBeEmptyDOMElement();
  });
});
