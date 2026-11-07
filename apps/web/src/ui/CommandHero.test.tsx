import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { CommandHero } from './CommandHero';

describe('CommandHero', () => {
  it('shows the label, the big number with its unit, the caption, chips and actions', () => {
    render(
      <CommandHero
        label="Tổng vốn đầu tư công"
        value="11.490.578,922"
        unit="triệu đồng"
        caption="Tính đến 31/10/2026"
        chips={[{ label: 'Đã giải ngân', value: '35%' }]}
        actions={<button type="button">Xuất</button>}
      />,
    );
    const region = screen.getByRole('region', { name: 'Tổng vốn đầu tư công' });
    expect(region).toHaveTextContent('11.490.578,922');
    expect(region).toHaveTextContent('triệu đồng');
    expect(screen.getByText('Tính đến 31/10/2026')).toBeInTheDocument();
    expect(screen.getByText('Đã giải ngân')).toBeInTheDocument();
    expect(screen.getByText('35%', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xuất' })).toBeInTheDocument();
  });

  it('draws the ring with a text alternative and the label', () => {
    render(<CommandHero label="Vốn" value="1" unit="tỷ" ratio={{ percent: 41.6, label: 'Giải ngân' }} />);
    expect(screen.getByRole('img', { name: 'Giải ngân: 42%' })).toBeInTheDocument();
    expect(screen.getByText('Giải ngân')).toBeInTheDocument();
  });

  it('an unknown ratio says there is no data and draws no arc', () => {
    const { container } = render(<CommandHero label="Vốn" value="1" unit="tỷ" ratio={{ percent: null, label: 'Giải ngân' }} />);
    expect(screen.getByRole('img', { name: 'Giải ngân: chưa có số liệu' })).toBeInTheDocument();
    expect(container.querySelector('.ui-hero__ring-fill')).toBeNull();
  });

  it('loading shows a skeleton and never the number', () => {
    render(<CommandHero label="Vốn" value="0" unit="tỷ" state="loading" />);
    expect(screen.getByRole('status', { name: 'Đang tải Vốn' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('error retries in place', async () => {
    const onRetry = vi.fn();
    render(<CommandHero label="Vốn" value="1" unit="tỷ" state="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Không tải được Vốn');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('has no serious accessibility violation', async () => {
    const { container } = render(<CommandHero label="Vốn" value="1" unit="tỷ" ratio={{ percent: 10, label: 'Giải ngân' }} />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
