import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeriodProgress } from './PeriodProgress';

describe('PeriodProgress', () => {
  it('shows the percent, a progressbar with its value, the sent count and the due label', () => {
    render(<PeriodProgress title="Tiến độ báo cáo tuần 39" percent={62.4} sent={5} total={8} dueLabel="Hạn 10/11" />);
    const bar = screen.getByRole('progressbar', { name: 'Tiến độ báo cáo tuần 39' });
    expect(bar).toHaveAttribute('aria-valuenow', '62');
    expect(bar).toHaveAttribute('aria-valuetext', '62%');
    expect(screen.getByText('62%')).toBeInTheDocument();
    expect(screen.getByText('Đã gửi 5/8')).toBeInTheDocument();
    expect(screen.getByText('Hạn 10/11')).toBeInTheDocument();
  });

  it('keeps the percent between 0 and 100', () => {
    render(<PeriodProgress title="Quá" percent={140} sent={9} total={8} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('an unknown percent shows a dash and no value, never 0%', () => {
    render(<PeriodProgress title="Chưa có" percent={null} sent={0} total={0} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-valuetext', 'Chưa có số liệu');
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('loading shows a skeleton and never the number 0', () => {
    render(<PeriodProgress title="Tiến độ" percent={0} sent={0} total={0} state="loading" />);
    expect(screen.getByRole('status', { name: 'Đang tải tiến độ Tiến độ' })).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('error retries in place', async () => {
    const onRetry = vi.fn();
    render(<PeriodProgress title="Tiến độ" percent={1} sent={1} total={2} state="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Không tải được tiến độ Tiến độ');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
