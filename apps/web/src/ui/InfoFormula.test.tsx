import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { InfoFormula } from './InfoFormula';
import type { InfoFormulaLabels } from './InfoFormula';

const labels: InfoFormulaLabels = {
  open: 'Công thức và nguồn của Tỷ lệ giải ngân',
  close: 'Đóng',
  formula: 'Công thức',
  numerator: 'Tử số',
  denominator: 'Mẫu số',
  exclusions: 'Không tính',
  source: 'Nguồn',
  asOf: 'Số liệu đến ngày',
  owner: 'Đơn vị chịu trách nhiệm',
  version: 'Phiên bản',
  unverified: 'Số trong định nghĩa là giá trị khởi điểm chưa được xác nhận.',
};
const props = {
  name: 'Tỷ lệ giải ngân',
  formula: 'Số Kho bạc đã chi chia kế hoạch Thủ tướng giao, nhân 100',
  numerator: 'Số Kho bạc đã chi lũy kế',
  denominator: 'Kế hoạch vốn Thủ tướng giao',
  exclusions: ['Vốn chuyển tiếp', 'Dự án chưa có số Kho bạc'],
  source: 'Phân hệ giải ngân (DIS)',
  asOf: '12/10/2027',
  owner: 'Cán bộ kế hoạch vốn',
  version: 'Phiên bản 0 (mặc định)',
  labels,
};

describe('InfoFormula', () => {
  it('is a button named for the figure, closed at first', () => {
    render(<InfoFormula {...props} />);
    const button = screen.getByRole('button', { name: labels.open });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on a click with the formula, the source, the day, the owner and the version, and what is left out', async () => {
    render(<InfoFormula {...props} />);
    await userEvent.click(screen.getByRole('button', { name: labels.open }));
    const panel = screen.getByRole('dialog', { name: 'Tỷ lệ giải ngân' });
    for (const text of [props.formula, props.numerator, props.denominator, props.source, props.asOf, props.owner, props.version, 'Vốn chuyển tiếp', 'Dự án chưa có số Kho bạc']) expect(within(panel).getByText(text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels.open })).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getByText('Không tính')).toBeInTheDocument();
  });

  it('leaves out the rows a definition does not have, and says so when the numbers were never confirmed', async () => {
    render(<InfoFormula {...props} numerator={null} denominator={undefined} exclusions={[]} unverified />);
    await userEvent.click(screen.getByRole('button', { name: labels.open }));
    const panel = screen.getByRole('dialog');
    expect(within(panel).queryByText('Tử số')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Mẫu số')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Không tính')).not.toBeInTheDocument();
    expect(within(panel).getByText(labels.unverified as string)).toBeInTheDocument();
  });

  it('does not say the numbers are unconfirmed when they are', async () => {
    render(<InfoFormula {...props} />);
    await userEvent.click(screen.getByRole('button', { name: labels.open }));
    expect(screen.queryByText(labels.unverified as string)).not.toBeInTheDocument();
  });

  it('closes with Escape and gives the focus back to the button', async () => {
    render(<InfoFormula {...props} />);
    const button = screen.getByRole('button', { name: labels.open });
    await userEvent.click(button);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes with its own button and with a click outside', async () => {
    render(
      <div>
        <InfoFormula {...props} />
        <p>elsewhere</p>
      </div>,
    );
    const button = screen.getByRole('button', { name: labels.open });
    await userEvent.click(button);
    await userEvent.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(button);
    await userEvent.click(screen.getByText('elsewhere'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens from the keyboard', async () => {
    render(<InfoFormula {...props} />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: labels.open })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('has no serious accessibility violation, closed or open', async () => {
    const { container } = render(<InfoFormula {...props} />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: labels.open }));
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
