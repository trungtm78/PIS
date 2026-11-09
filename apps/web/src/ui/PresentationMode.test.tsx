import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { PresentButton, PresentationMode } from './PresentationMode';

const BOARDS = [
  { id: 'rates', title: 'Tỷ lệ giải ngân', content: <p>Nội dung bảng một</p> },
  { id: 'tiles', title: 'Việc cần chú ý', content: <p>Nội dung bảng hai</p> },
  { id: 'units', title: 'Các đơn vị', content: <p>Nội dung bảng ba</p> },
];

function mount(extra: Partial<React.ComponentProps<typeof PresentationMode>> = {}) {
  const onExit = vi.fn();
  const view = render(<PresentationMode title="Bảng điều hành" boards={BOARDS} onExit={onExit} {...extra} />);
  return { onExit, ...view };
}

const status = (): string => screen.getByTestId('presentation-status').textContent ?? '';

describe('PresentationMode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset.presenting;
  });

  it('opens as a modal dialog over the page with the first board and the position', () => {
    mount();
    const dialog = screen.getByRole('dialog', { name: 'Bảng điều hành' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { level: 2, name: 'Tỷ lệ giải ngân' })).toBeInTheDocument();
    expect(screen.getByText('Nội dung bảng một')).toBeInTheDocument();
    expect(status()).toContain('Bảng 1 trên 3');
    expect(document.documentElement.dataset.presenting).toBe('true');
    expect(dialog).toHaveFocus();
  });

  it('turns the boards by itself after the interval and starts over after the last one', () => {
    mount({ intervalSeconds: 10 });
    expect(status()).toContain('Chuyển bảng sau 10 giây');
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('heading', { level: 2, name: 'Việc cần chú ý' })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('heading', { level: 2, name: 'Các đơn vị' })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('heading', { level: 2, name: 'Tỷ lệ giải ngân' })).toBeInTheDocument();
  });

  it('announces a turn politely and says nothing for the first board', () => {
    mount({ intervalSeconds: 10 });
    expect(screen.getByTestId('presentation-live')).toHaveTextContent('');
    expect(screen.getByTestId('presentation-live')).toHaveAttribute('aria-live', 'polite');
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByTestId('presentation-live')).toHaveTextContent('Bảng 2 trên 3: Việc cần chú ý');
  });

  it('pauses with Space and with the button, and does not turn while paused', () => {
    mount({ intervalSeconds: 10 });
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: ' ' });
    expect(status()).toContain('Đã tạm dừng');
    expect(screen.getByRole('button', { name: 'Chạy tiếp' })).toHaveAttribute('aria-pressed', 'true');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('heading', { level: 2, name: 'Tỷ lệ giải ngân' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chạy tiếp' }));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('heading', { level: 2, name: 'Việc cần chú ý' })).toBeInTheDocument();
  });

  it('keeps the meaning of Space on a button instead of pausing', () => {
    mount({ intervalSeconds: 10 });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Bảng sau' }), { key: ' ' });
    expect(status()).not.toContain('Đã tạm dừng');
  });

  it('is moved by the keyboard: arrows, page keys, Home, End and digits', () => {
    mount({ intervalSeconds: 60 });
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(status()).toContain('Bảng 2 trên 3');
    fireEvent.keyDown(dialog, { key: 'PageDown' });
    expect(status()).toContain('Bảng 3 trên 3');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(status()).toContain('Bảng 1 trên 3');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(status()).toContain('Bảng 3 trên 3');
    fireEvent.keyDown(dialog, { key: 'Home' });
    expect(status()).toContain('Bảng 1 trên 3');
    fireEvent.keyDown(dialog, { key: 'End' });
    expect(status()).toContain('Bảng 3 trên 3');
    fireEvent.keyDown(dialog, { key: '2' });
    expect(status()).toContain('Bảng 2 trên 3');
    fireEvent.keyDown(dialog, { key: '9' });
    expect(status()).toContain('Bảng 2 trên 3');
  });

  it('a manual turn starts the count again', () => {
    mount({ intervalSeconds: 10 });
    act(() => void vi.advanceTimersByTime(8_000));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(status()).toContain('Chuyển bảng sau 10 giây');
    act(() => void vi.advanceTimersByTime(8_000));
    expect(screen.getByRole('heading', { level: 2, name: 'Việc cần chú ý' })).toBeInTheDocument();
  });

  it('changes the interval from the list', async () => {
    vi.useRealTimers();
    mount({ intervalSeconds: 10 });
    await userEvent.selectOptions(screen.getByLabelText('Tự chuyển sau'), '30');
    expect(status()).toContain('Chuyển bảng sau 30 giây');
  });

  it('grows and shrinks the text in steps and stops at the ends', () => {
    mount();
    const dialog = screen.getByRole('dialog');
    expect(dialog.style.getPropertyValue('--ui-present-scale')).toBe('1.25');
    fireEvent.keyDown(dialog, { key: '+' });
    expect(dialog.style.getPropertyValue('--ui-present-scale')).toBe('1.5');
    fireEvent.keyDown(dialog, { key: '+' });
    fireEvent.keyDown(dialog, { key: '+' });
    expect(dialog.style.getPropertyValue('--ui-present-scale')).toBe('2');
    expect(screen.getByRole('button', { name: 'Chữ lớn hơn' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: '-' });
    expect(dialog.style.getPropertyValue('--ui-present-scale')).toBe('1.5');
  });

  it('leaves with Escape and with the button, and gives the page back', () => {
    const { onExit, unmount } = mount();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Thoát trình chiếu' }));
    expect(onExit).toHaveBeenCalledTimes(2);
    unmount();
    expect(document.documentElement.dataset.presenting).toBeUndefined();
  });

  it('starts paused for a person who asked for reduced motion (WCAG 2.2.2)', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) });
    mount({ intervalSeconds: 10 });
    expect(status()).toContain('Đã tạm dừng');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('heading', { level: 2, name: 'Tỷ lệ giải ngân' })).toBeInTheDocument();
  });

  it('does not turn a hidden tab', () => {
    mount({ intervalSeconds: 10 });
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => void vi.advanceTimersByTime(60_000));
    spy.mockRestore();
    expect(screen.getByRole('heading', { level: 2, name: 'Tỷ lệ giải ngân' })).toBeInTheDocument();
  });

  it('a single board has nothing to turn and its controls are off', () => {
    mount({ boards: [BOARDS[0] as (typeof BOARDS)[number]] });
    expect(screen.getByRole('button', { name: 'Bảng sau' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Tạm dừng' })).toBeDisabled();
    act(() => void vi.advanceTimersByTime(120_000));
    expect(screen.getByText('Nội dung bảng một')).toBeInTheDocument();
  });

  it('says so when there is no board, and the keys do not break', () => {
    mount({ boards: [] });
    expect(screen.getByText('Chưa có bảng nào để trình chiếu.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(screen.getByText('Chưa có bảng nào để trình chiếu.')).toBeInTheDocument();
  });

  it('shows no edit control of the page behind, only its own controls and the board', () => {
    render(
      <div>
        <button type="button">Sửa bố cục</button>
        <PresentationMode title="Bảng điều hành" boards={BOARDS} onExit={() => undefined} />
      </div>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toContainElement(screen.getByRole('button', { name: 'Sửa bố cục' }));
    expect(dialog.closest('[data-testid="presentation"]')).toBe(dialog);
    expect(dialog.parentElement).toBe(document.body);
  });

  it('goes to a board from its dot and marks the current one', async () => {
    vi.useRealTimers();
    mount({ intervalSeconds: 60 });
    await userEvent.click(screen.getByRole('button', { name: 'Mở bảng 3: Các đơn vị' }));
    expect(screen.getByRole('button', { name: 'Mở bảng 3: Các đơn vị' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Nội dung bảng ba')).toBeInTheDocument();
  });

  it('has no serious accessibility violation', async () => {
    vi.useRealTimers();
    mount();
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});

describe('PresentButton', () => {
  it('opens the presentation through the callback', async () => {
    const onOpen = vi.fn();
    render(<PresentButton onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Trình chiếu' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
