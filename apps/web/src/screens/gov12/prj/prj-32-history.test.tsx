import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MonitoringDetailScreen from './MonitoringDetailScreen';
import { AS_OF, FILE_ID, MANAGER, READER, detail, feedback, harness, mount, never, problem, routeOf, word } from './test/support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PRJ-32', 'FR-PRJ-32');
const PATH = `/prj/prj-32?file=${FILE_ID}`;
const FEEDBACK_ID = feedback(1).id;
const event = (n: number, over: Record<string, unknown> = {}) => ({ id: `e${n}`, move: 'RECEIVED', from_status: null, to_status: 'RECEIVED', actor_id: '00000000-0000-4000-8000-000000000001', reason: null, at: '2027-03-01T03:00:00.000Z', ...over });
const historyRead = (events: unknown[]) => ({ ...feedback(1), as_of: AS_OF, history: events });
const open = (answer: (operation: string) => unknown, permissions: readonly string[] = READER) => {
  const h = harness((operation) => answer(operation));
  mount(<MonitoringDetailScreen route={route} />, h, { permissions, path: PATH });
  return h;
};

describe('PRJ-32 the history of one feedback (getMonitoringFeedback)', () => {
  it('reads nothing until the person opens it, then lists the moves oldest first with the reason', async () => {
    const h = open((operation) => (operation === 'getMonitoringFeedback' ? historyRead([event(1), event(2, { move: 'DECLINE', from_status: 'RECEIVED', to_status: 'OUT_OF_SCOPE', reason: 'Not about this project' })]) : detail()));
    const toggle = await screen.findByTestId(`history-toggle-${FEEDBACK_ID}`);
    expect(h.read).not.toHaveBeenCalledWith('getMonitoringFeedback', expect.anything());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const panel = await screen.findByTestId(`history-${FEEDBACK_ID}`);
    expect(h.read).toHaveBeenCalledWith('getMonitoringFeedback', { path: { id: FEEDBACK_ID } });
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    expect(within(panel).getByTestId('event-e2').textContent).toContain('Not about this project');
    expect(within(panel).getByTestId('event-e2').textContent).toContain('01/03/2027');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe(word('prj.monDetail.history.hide'));
    fireEvent.click(toggle);
    expect(screen.queryByTestId(`history-${FEEDBACK_ID}`)).toBeNull();
  });

  it('shows a loading note while it reads, an error with a retry when it fails, and an empty note for no moves', async () => {
    let attempt = 0;
    const h = open((operation) => {
      if (operation !== 'getMonitoringFeedback') return detail();
      attempt += 1;
      if (attempt === 1) return never();
      return historyRead([]);
    });
    fireEvent.click(await screen.findByTestId(`history-toggle-${FEEDBACK_ID}`));
    expect(await screen.findByTestId(`history-loading-${FEEDBACK_ID}`)).toBeTruthy();
    expect(h.read).toHaveBeenCalledTimes(2);
    cleanup();
    let calls = 0;
    open((operation) => (operation !== 'getMonitoringFeedback' ? detail() : calls++ === 0 ? problem('INTERNAL', 500) : historyRead([])));
    fireEvent.click(await screen.findByTestId(`history-toggle-${FEEDBACK_ID}`));
    const error = await screen.findByTestId(`history-error-${FEEDBACK_ID}`);
    fireEvent.click(within(error).getByRole('button', { name: word('prj.monDetail.history.retry') }));
    expect(await screen.findByTestId(`history-empty-${FEEDBACK_ID}`)).toBeTruthy();
  });

  it('is offered to a person who can only read, next to the actions of one who can respond', async () => {
    open(() => detail(), MANAGER);
    expect(await screen.findByTestId(`history-toggle-${FEEDBACK_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`move-take-${FEEDBACK_ID}`)).toBeTruthy();
  });
});
