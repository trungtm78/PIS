import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Tabs, useTabParam } from './Tabs';

const TABS = [
  { id: 'overview', label: 'Tổng quan', panel: <p>Nội dung tổng quan</p> },
  { id: 'tasks', label: 'Công việc', count: 3, panel: <p>Nội dung công việc</p> },
  { id: 'schedule', label: 'Lịch', panel: <p>Nội dung lịch</p> },
] as const;

describe('Tabs', () => {
  it('shows one panel, names it by its tab, and keeps only the chosen tab in the Tab order', () => {
    render(<Tabs tabs={TABS} value="tasks" onChange={() => undefined} label="Các phần của màn" testId="t" />);
    const list = screen.getByRole('tablist', { name: 'Các phần của màn' });
    expect(list).toBeInTheDocument();
    const chosen = screen.getByRole('tab', { name: /Công việc/ });
    expect(chosen).toHaveAttribute('aria-selected', 'true');
    expect(chosen).toHaveAttribute('tabindex', '0');
    expect(chosen.textContent).toContain('3');
    expect(screen.getByRole('tab', { name: 'Tổng quan' })).toHaveAttribute('tabindex', '-1');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', chosen.id);
    expect(panel.textContent).toBe('Nội dung công việc');
    // The other panels stay in the page, hidden: what a person typed in one is not lost.
    expect(screen.getByTestId('t-panel-overview')).toHaveAttribute('hidden');
    expect(screen.getByTestId('t-panel-overview').textContent).toBe('Nội dung tổng quan');
  });

  it('moves with the arrow keys, Home and End, and with a click', () => {
    const onChange = vi.fn();
    render(<Tabs tabs={TABS} value="overview" onChange={onChange} label="Các phần" />);
    const first = screen.getByRole('tab', { name: 'Tổng quan' });
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('tasks');
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('schedule');
    fireEvent.keyDown(first, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('schedule');
    fireEvent.keyDown(first, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('overview');
    fireEvent.keyDown(first, { key: 'a' });
    expect(onChange).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole('tab', { name: 'Lịch' }));
    expect(onChange).toHaveBeenLastCalledWith('schedule');
  });

  it('falls back to the first tab for a value no tab has, and shows nothing without tabs', () => {
    const { container, unmount } = render(<Tabs tabs={TABS} value="nothing" onChange={() => undefined} label="Các phần" />);
    expect(screen.getByRole('tab', { name: 'Tổng quan' })).toHaveAttribute('aria-selected', 'true');
    unmount();
    render(<Tabs tabs={[]} value="" onChange={() => undefined} label="Các phần" />);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
});

describe('useTabParam', () => {
  function Probe() {
    const [view, setView] = useTabParam('view', ['overview', 'tasks'] as const);
    const location = useLocation();
    return (
      <>
        <output data-testid="view">{view}</output>
        <output data-testid="where">{location.search}</output>
        <button type="button" onClick={() => setView('tasks')}>
          tasks
        </button>
        <button type="button" onClick={() => setView('overview')}>
          overview
        </button>
      </>
    );
  }

  it('reads the tab from the address, keeps the other parameters, and leaves the address clean for the first tab', () => {
    render(
      <MemoryRouter initialEntries={['/x?id=7&view=nothing']}>
        <Probe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('view').textContent).toBe('overview');
    fireEvent.click(screen.getByRole('button', { name: 'tasks' }));
    expect(screen.getByTestId('view').textContent).toBe('tasks');
    expect(screen.getByTestId('where').textContent).toBe('?id=7&view=tasks');
    fireEvent.click(screen.getByRole('button', { name: 'overview' }));
    expect(screen.getByTestId('where').textContent).toBe('?id=7');
  });
});
