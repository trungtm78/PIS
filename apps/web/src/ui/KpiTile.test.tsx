import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { KpiTile } from './KpiTile';

describe('KpiTile', () => {
  it('shows the label, the number, the unit and the sub line', () => {
    render(<KpiTile icon="₫" label="Kế hoạch vốn" value="34.629,94" unit="tỷ đồng" sub="Kéo dài 34.529" />);
    expect(screen.getByText('Kế hoạch vốn')).toBeInTheDocument();
    expect(screen.getByText('34.629,94')).toBeInTheDocument();
    expect(screen.getByText('tỷ đồng')).toBeInTheDocument();
    expect(screen.getByText('Kéo dài 34.529')).toBeInTheDocument();
  });

  it('makes the label a link when href is given', () => {
    render(<KpiTile label="Chưa gửi" value="3" href="/home/2" />);
    expect(screen.getByRole('link', { name: 'Chưa gửi' })).toHaveAttribute('href', '/home/2');
  });

  it('applies the tone as a class', () => {
    const { container } = render(<KpiTile label="Quá hạn" value="2" tone="danger" />);
    expect(container.firstElementChild).toHaveClass('ui-tone-danger');
  });

  it('loading shows a skeleton, announces it and never the number', () => {
    render(<KpiTile label="Đã giải ngân" value="0" state="loading" />);
    expect(screen.getByRole('status', { name: 'Đang tải chỉ số Đã giải ngân' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('error names the failing indicator and retries in place', async () => {
    const onRetry = vi.fn();
    render(<KpiTile label="Đã giải ngân" value="1" state="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Không tải được chỉ số Đã giải ngân');
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('error without a retry handler has no retry button', () => {
    render(<KpiTile label="X" value="1" state="error" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has no serious accessibility violation', async () => {
    const { container } = render(<KpiTile icon="₫" label="Kế hoạch" value="10" unit="tỷ" href="/a" />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
