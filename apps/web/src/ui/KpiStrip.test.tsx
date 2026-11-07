import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KpiStrip } from './KpiStrip';
import { KpiTile } from './KpiTile';
import { PeriodProgress } from './PeriodProgress';

describe('KpiStrip', () => {
  it('holds its tiles and names the group when a label is given', () => {
    render(
      <KpiStrip label="Chỉ số kỳ">
        <KpiTile label="A" value="1" />
        <PeriodProgress title="Tiến độ" percent={50} sent={1} total={2} />
      </KpiStrip>,
    );
    const group = screen.getByRole('group', { name: 'Chỉ số kỳ' });
    expect(group).toHaveClass('ui-kpi-strip');
    expect(group).toContainElement(screen.getByText('A'));
    expect(group).toContainElement(screen.getByRole('progressbar'));
  });

  it('is a plain grid without a role when there is no label', () => {
    render(
      <KpiStrip>
        <KpiTile label="A" value="1" />
      </KpiStrip>,
    );
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
});
