import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STICKY_ACTIONS_NARROW_QUERY, StickyActions } from './StickyActions';

const original = window.matchMedia;

/** Answers the narrow query only. */
function setNarrow(narrow: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query === STICKY_ACTIONS_NARROW_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const bar = (
  <StickyActions
    primary={<button type="button">Gửi</button>}
    secondary={[<button type="button" key="s">Lưu nháp</button>, <button type="button" key="b">Quay lại</button>]}
    overflow={[<button type="button" key="o">Xóa nháp</button>]}
  />
);

beforeEach(() => setNarrow(false));
afterEach(() => {
  window.matchMedia = original;
});

describe('StickyActions', () => {
  it('on a wide screen shows primary and secondary actions, with the overflow in a menu', async () => {
    render(bar);
    const group = screen.getByRole('group', { name: 'Thao tác' });
    expect(within(group).getByRole('button', { name: 'Gửi' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Lưu nháp' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Quay lại' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Xóa nháp' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thêm thao tác' }));
    expect(screen.getByRole('button', { name: 'Xóa nháp' })).toBeInTheDocument();
  });

  it('at 360 px only the primary action stays on the bar and the rest go in the menu', async () => {
    setNarrow(true);
    render(bar);
    expect(screen.getByRole('button', { name: 'Gửi' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lưu nháp' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quay lại' })).not.toBeInTheDocument();
    const more = screen.getByRole('button', { name: 'Thêm thao tác' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('group', { name: 'Thêm thao tác' });
    expect(within(menu).getAllByRole('button').map((button) => button.textContent)).toEqual(['Lưu nháp', 'Quay lại', 'Xóa nháp']);
  });

  it('Escape closes the menu and returns focus to its button', async () => {
    setNarrow(true);
    render(bar);
    const more = screen.getByRole('button', { name: 'Thêm thao tác' });
    await userEvent.click(more);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Lưu nháp' })).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it('has no menu button when there is nothing to put in it', () => {
    render(<StickyActions primary={<button type="button">Gửi</button>} secondary={[<button type="button" key="s">Lưu</button>]} />);
    expect(screen.queryByRole('button', { name: 'Thêm thao tác' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lưu' })).toBeInTheDocument();
  });

  it('works where matchMedia does not exist', () => {
    Reflect.deleteProperty(window, 'matchMedia');
    render(<StickyActions primary={<button type="button">Gửi</button>} />);
    expect(screen.getByRole('button', { name: 'Gửi' })).toBeInTheDocument();
  });
});
