import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../sas/test-support';
import DeadlineBoardScreen from '../board/DeadlineBoardScreen';
import { calendarBody, milestoneBody, row, workloadBody } from '../board/test/fixtures';
import { ALL_PERMISSIONS, band, deadlineBoard, routeOf, serve, text, uuid } from '../test/fixtures';
import { myTasks, savedBody } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * R40 (BR-PWF-23): the screens that several people read never show the colour of a person's own setting. The person here has set 7/3/1, and the task that is green by the official ladder would be yellow for them:
 * the board must still say green, must say nothing about "as you set it", and must not even read the personal setting or the personal list.
 */
describe('PWF-07 shows the official colour only, whatever a person has set for themselves', () => {
  it('shows the official band of a task that is yellow for the person, with no personal label, and never reads the personal setting', async () => {
    const h = serve({
      getDeadlineBoard: deadlineBoard({ items: [row(1, { band: band('GREEN', { remaining_days: 3 }) })], total: 1, shown: 1, counts_by_band: { NONE: 0, GREEN: 1, YELLOW: 0, RED: 0, UNKNOWN: 0 } }),
      getDeadlineCalendar: calendarBody(),
      getUpcomingMilestones: milestoneBody(),
      getProjectWorkload: workloadBody(),
      // Served on purpose: if the board asked for the personal setting or the personal list, it would find them.
      getDeadlinePreference: savedBody(),
      getMyTasks: myTasks(),
    });
    (h.client as { readAll: unknown }).readAll = vi.fn(async () => []);
    const { container } = mount(<DeadlineBoardScreen route={routeOf('PWF-07')} />, h, ALL_PERMISSIONS, '/pwf/pwf-07');
    const list = await screen.findByTestId('board-list');
    const line = list.querySelector(`[data-task-id="${uuid(1001)}"]`) as HTMLElement;
    expect(within(line).getByText(text('pwf.band.green.word'))).toBeTruthy();
    expect(within(line).queryByText(text('pwf.band.yellow.word'))).toBeNull();
    expect(screen.getByTestId('official-notice').textContent).toBe(text('pwf.board.official.notice'));
    expect(container.textContent).not.toContain(text('pwf.pref.personal.label'));
    const operations = new Set(h.read.mock.calls.map((call) => call[0]));
    expect(operations.has('getDeadlinePreference')).toBe(false);
    expect(operations.has('getMyTasks')).toBe(false);
  });
});
