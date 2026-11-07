import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionCard } from './SectionCard';

describe('SectionCard', () => {
  it('is a region named by its title with the unit chip, status, actions and content', () => {
    render(
      <SectionCard title="Nguồn vốn" unit="Triệu đồng" status={<span>Đã chốt</span>} actions={<button type="button">Xuất Excel</button>}>
        <p>Nội dung</p>
      </SectionCard>,
    );
    const region = screen.getByRole('region', { name: 'Nguồn vốn' });
    expect(within(region).getByRole('heading', { level: 2, name: 'Nguồn vốn' })).toBeInTheDocument();
    expect(within(region).getByText('ĐVT: Triệu đồng')).toBeInTheDocument();
    expect(within(region).getByText('Đã chốt')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Xuất Excel' })).toBeInTheDocument();
    expect(within(region).getByText('Nội dung')).toBeInTheDocument();
  });

  it('omits the unit chip when there is no unit', () => {
    render(
      <SectionCard title="Ghi chú">
        <p>x</p>
      </SectionCard>,
    );
    expect(screen.queryByText(/ĐVT/)).not.toBeInTheDocument();
  });
});
