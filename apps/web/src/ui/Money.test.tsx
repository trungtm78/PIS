import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Money } from './Money';

describe('Money', () => {
  it('shows the short form and keeps the exact amount in the tooltip and for a screen reader', () => {
    render(<Money value="1234567890" data-testid="m" />);
    const money = screen.getByTestId('m');
    expect(screen.getByText('1,23 tỷ đồng')).toBe(money);
    expect(money).toHaveAttribute('title', '1.234.567.890 đồng');
    expect(money).toHaveTextContent('1,23 tỷ đồng (1.234.567.890 đồng)');
  });

  it('adds no second reading to an amount below one million, which is written whole', () => {
    render(<Money value="950000" data-testid="m" />);
    expect(screen.getByTestId('m').textContent).toBe('950.000 đồng');
    expect(screen.getByTestId('m')).toHaveAttribute('title', '950.000 đồng');
  });

  it('writes the figure alone under a declared unit', () => {
    render(<Money value="214705000000" unit="billion" bare fixed data-testid="m" />);
    expect(screen.getByText('214,71')).toBe(screen.getByTestId('m'));
    expect(screen.getByTestId('m')).toHaveAttribute('title', '214.705.000.000 đồng');
  });

  it('shows a dash, or the words of the caller, for no amount, with no tooltip', () => {
    render(
      <>
        <Money value={null} data-testid="a" />
        <Money value={undefined} none="Chưa có số liệu" data-testid="b" />
      </>,
    );
    expect(screen.getByTestId('a').textContent).toBe('—');
    expect(screen.getByTestId('a')).not.toHaveAttribute('title');
    expect(screen.getByTestId('b').textContent).toBe('Chưa có số liệu');
  });

  it('keeps the plus of a rise in the tooltip and in what a screen reader hears', () => {
    render(<Money value="50000000" signed data-testid="m" />);
    expect(screen.getByTestId('m')).toHaveAttribute('title', '+50.000.000 đồng');
    expect(screen.getByTestId('m').textContent).toBe('+50 triệu đồng (+50.000.000 đồng)');
  });
});
