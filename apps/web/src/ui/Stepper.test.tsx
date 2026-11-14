import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { Stepper } from './Stepper';
import type { StepperStep } from './Stepper';

afterEach(cleanup);

const STEPS: StepperStep[] = [
  { code: 'A', label: 'Lập hồ sơ', status: 'done', plannedDays: 5, actualDays: 4 },
  { code: 'B', label: 'Thẩm định', status: 'skipped', note: 'Có ngoại lệ được duyệt' },
  { code: 'C', label: 'Đánh giá hồ sơ', status: 'late', current: true, plannedDays: 5, actualDays: 9, lateDays: 4 },
  { code: 'D', label: 'Phê duyệt', status: 'upcoming', plannedDays: 3 },
  { code: 'E', label: 'Ký hợp đồng', status: 'hold' },
];

describe('Stepper', () => {
  it('is an ordered list named for screen readers with every step', () => {
    render(<Stepper steps={STEPS} label="Các bước của gói thầu" />);
    const list = screen.getByRole('list', { name: 'Các bước của gói thầu' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });

  it('says "started" of a step with work in parallel, and never marks it as the step the thing is at', () => {
    render(<Stepper steps={[{ code: 'A', label: 'Chuẩn bị', status: 'current' }, { code: 'B', label: 'Thực hiện', status: 'started' }, { code: 'C', label: 'Kết thúc', status: 'upcoming' }]} label="c" />);
    const item = (code: string): HTMLElement => document.querySelector(`[data-step="${code}"]`) as HTMLElement;
    expect(within(item('B')).getByText('Đã bắt đầu')).toBeInTheDocument();
    expect(item('B').getAttribute('aria-current')).toBeNull();
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(item('B').className).toContain('ui-stepper__step--started');
  });

  it('says every status with a word as well as an icon, and the days of the standard against the days it took', () => {
    render(<Stepper steps={STEPS} label="c" />);
    const item = (code: string): HTMLElement => document.querySelector(`[data-step="${code}"]`) as HTMLElement;
    expect(within(item('A')).getByText('Xong')).toBeInTheDocument();
    expect(within(item('A')).getByText('chuẩn 5 · thực 4')).toBeInTheDocument();
    expect(within(item('B')).getByText('Bỏ qua')).toBeInTheDocument();
    expect(within(item('B')).getByText('Có ngoại lệ được duyệt')).toBeInTheDocument();
    expect(within(item('C')).getByText('Trễ 4 ngày')).toBeInTheDocument();
    expect(within(item('D')).getByText('Sắp tới')).toBeInTheDocument();
    expect(within(item('E')).getByText('Tạm dừng')).toBeInTheDocument();
  });

  it('strikes through a skipped step and numbers an upcoming one', () => {
    render(<Stepper steps={STEPS} label="c" />);
    expect(screen.getByText('Thẩm định')).toHaveClass('is-skipped');
    expect((document.querySelector('[data-step="D"] .ui-stepper__circle') as HTMLElement).textContent).toBe('4');
  });

  it('marks the step the thing is at, also when it is late, and only that one', () => {
    render(<Stepper steps={STEPS} label="c" />);
    const current = document.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute('data-step')).toBe('C');
    cleanup();
    render(<Stepper steps={[{ code: 'A', label: 'Một', status: 'current' }, { code: 'B', label: 'Hai', status: 'upcoming' }]} label="c" />);
    expect(document.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('A');
  });

  it('shows a late step without a count of days as late', () => {
    render(<Stepper steps={[{ code: 'A', label: 'Một', status: 'late' }]} label="c" />);
    expect(screen.getByText('Trễ')).toBeInTheDocument();
  });

  it('has no serious accessibility violation', async () => {
    const { container } = render(<Stepper steps={STEPS} label="Các bước" />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
