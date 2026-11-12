import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { ALL_PERMISSIONS, PROJECT_ID, READ_ONLY, band, refusal, routeOf, serve, text } from '../test/fixtures';
import type { Answer } from '../test/fixtures';
import { mountAs } from '../templates/test/mount';
import DeadlinePreferenceScreen from './DeadlinePreferenceScreen';
import { myTask, myTasks, personalPreview, preferenceBody, savedBody, uuid } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-15');

interface Setup {
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  preference?: Answer;
  preview?: Answer;
  tasks?: Answer;
  commands?: Record<string, Answer>;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getDeadlinePreference: setup.preference ?? preferenceBody(),
      previewDeadlineBand: setup.preview ?? personalPreview(),
      getMyTasks: setup.tasks ?? myTasks(),
    },
    { setDeadlinePreference: { operation_id: 'op', status: 'Updated', resource_version: 4 }, ...setup.commands },
  );
  const view = mountAs(<DeadlinePreferenceScreen route={route} />, h, { permissions: setup.permissions ?? ALL_PERMISSIONS, ...(setup.mode === undefined ? {} : { mode: setup.mode }), path: '/pwf/pwf-15' });
  return { h, view };
};

const field = (path: string) => screen.getByTestId(`field-${path}`) as HTMLInputElement;
const change = (path: string, value: string) => fireEvent.change(field(path), { target: { value } });
const ready = async () => screen.findByTestId('deadline-form');
const previewCalls = (h: ReturnType<typeof open>['h']) => h.read.mock.calls.filter((call) => call[0] === 'previewDeadlineBand').map((call) => (call[1] as { query: Record<string, unknown> }).query);
const rowOf = (days: number) => document.querySelector(`[data-testid="preview-table"] tr[data-days="${days}"]`) as HTMLElement;
const PERSONAL_SENTENCE = 'Còn 7 ngày làm việc: xanh, còn 3 ngày làm việc: vàng, dưới 2 ngày làm việc: đỏ';

describe('PWF-15: reading the setting', () => {
  it('shows the three levels and the reminder days of the person with the official level written beside each, and the owner sentence for both ladders', async () => {
    open({ preference: savedBody() });
    await ready();
    expect(field('green_days').value).toBe('7');
    expect(field('yellow_days').value).toBe('3');
    expect(field('red_days').value).toBe('1');
    expect(field('reminder_days').value).toBe('7, 3, 1');
    expect(screen.getByTestId('hint-green_days').textContent).toBe(text('pwf.pref.official.text', { value: 5 }));
    expect(screen.getByTestId('hint-yellow_days').textContent).toBe('chính thức: 2');
    expect(screen.getByTestId('hint-red_days').textContent).toBe('chính thức: 0');
    expect(screen.getByTestId('hint-reminder_days').textContent).toContain('(0)');
    expect(screen.getByTestId('sentence-official').textContent).toBe('Còn 5 ngày làm việc: xanh, còn 2 ngày làm việc: vàng, dưới 1 ngày làm việc: đỏ');
    expect(screen.getByTestId('sentence-personal').textContent).toBe(PERSONAL_SENTENCE);
    expect(screen.queryByTestId('no-setting')).toBeNull();
    expect(screen.getByTestId('footer').textContent).toBe('Màn PWF-15 · Yêu cầu FR-PWF-15');
  });

  it('says so when no level is set: the official levels apply, nothing to clear and nothing to ask the server', async () => {
    const { h } = open();
    await ready();
    expect(screen.getByTestId('no-setting')).toBeTruthy();
    expect(field('green_days').value).toBe('');
    expect(screen.getByTestId('sentence-personal').textContent).toBe(text('pwf.pref.sentence.same.text'));
    expect((screen.getByRole('button', { name: text('pwf.pref.clear.action') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: text('pwf.pref.save.action') }) as HTMLButtonElement).disabled).toBe(true);
    expect(rowOf(6).dataset.official).toBe('NONE');
    expect(rowOf(6).dataset.personal).toBe('NONE');
    expect(screen.queryByTestId('server-check')).toBeNull();
    expect(previewCalls(h)).toEqual([]);
  });

  it('says that a level the official policy does not set (no green line) has no official number', async () => {
    open({ preference: preferenceBody({ official: { green_days: null, yellow_days: 2, red_days: 0 } }) });
    await ready();
    expect(screen.getByTestId('hint-green_days').textContent).toBe(text('pwf.pref.officialNone.text'));
  });

  it('warns that a level was raised to the official level, naming the levels', async () => {
    open({ preference: savedBody({ yellow_days: 2, clamped: ['yellow_days', 'red_days'] }) });
    await ready();
    expect(screen.getByTestId('clamped').textContent).toContain('vàng, đỏ');
    expect(screen.getByTestId('clamped').getAttribute('role')).toBe('status');
  });
});

describe('PWF-15: the live preview', () => {
  it('computes the colours at once as the numbers are typed, with the word and the glyph, side by side with the official colours', async () => {
    open();
    await ready();
    change('green_days', '7');
    change('yellow_days', '3');
    change('red_days', '1');
    expect(screen.getByTestId('sentence-personal').textContent).toBe(PERSONAL_SENTENCE);
    expect(rowOf(6).dataset).toMatchObject({ official: 'NONE', personal: 'GREEN' });
    expect(rowOf(3).dataset).toMatchObject({ official: 'GREEN', personal: 'YELLOW' });
    expect(rowOf(1).dataset).toMatchObject({ official: 'YELLOW', personal: 'RED' });
    const row = within(rowOf(1));
    expect(row.getByText(text('pwf.band.yellow.word'))).toBeTruthy();
    expect(row.getByText('⚠')).toBeTruthy();
    expect(row.getByText(text('pwf.band.red.word'))).toBeTruthy();
    expect(row.getByText('⛔')).toBeTruthy();
    expect(rowOf(0).textContent).toContain(text('pwf.band.today.text'));
    expect(rowOf(-1).textContent).toContain(text('pwf.band.overdue.text', { days: 1, unit: text('pwf.unit.working.word') }));
  });

  it('confirms with the server the ladder it computed, and says so', async () => {
    const { h } = open();
    await ready();
    change('green_days', '7');
    change('yellow_days', '3');
    change('red_days', '1');
    const check = await screen.findByText(text('pwf.pref.check.agrees.text'));
    expect(check).toBeTruthy();
    expect(screen.getByTestId('server-check').dataset.state).toBe('agrees');
    expect(previewCalls(h).at(-1)).toEqual({ yellow_days: 3, red_days: 1, green_days: 7, unit: 'WORKING' });
  });

  it('says so when the server colours a number of days left differently', async () => {
    open({ preview: personalPreview({ examples: [{ remaining_days: 1, band: 'YELLOW' }, { remaining_days: 8, band: 'NONE' }] }) });
    await ready();
    change('green_days', '7');
    change('yellow_days', '3');
    change('red_days', '1');
    await waitFor(() => expect(screen.getByTestId('server-check').dataset.state).toBe('differs'));
    expect(screen.getByTestId('server-check').textContent).toContain('1');
  });

  it('says the table is the reading of the device when the server cannot be asked, and keeps the table', async () => {
    open({ preview: refusal('SCOPE_DENIED', 403) });
    await ready();
    change('yellow_days', '3');
    await waitFor(() => expect(screen.getByTestId('server-check').dataset.state).toBe('unavailable'));
    expect(rowOf(3).dataset.personal).toBe('YELLOW');
  });

  it('shows the checking line while the server has not answered', async () => {
    open({ preview: () => new Promise(() => undefined) });
    await ready();
    change('yellow_days', '3');
    await waitFor(() => expect(screen.getByTestId('server-check').dataset.state).toBe('pending'));
  });
});

describe('PWF-15: the checks before saving', () => {
  it('refuses a level later than the official one, next to the field, with the official number, sends nothing and has no preview', async () => {
    const { h } = open();
    await ready();
    change('yellow_days', '1');
    expect(screen.getByTestId('error-yellow_days').textContent).toContain(text('pwf.pref.problem.notEarlier.error', { official: 2 }));
    expect(field('yellow_days').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('preview-blocked')).toBeTruthy();
    expect(screen.getByTestId('sentence-personal').textContent).toBe(text('pwf.pref.sentence.blocked.text'));
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    expect(h.command).not.toHaveBeenCalled();
    expect(previewCalls(h)).toEqual([]);
  });

  it('names the level that breaks the order', async () => {
    open();
    await ready();
    change('yellow_days', '6');
    expect(screen.getByTestId('error-green_days').textContent).toContain(text('pwf.pref.problem.orderGreen.error'));
  });

  it('refuses a reminder day below the official red level and one that is not decreasing', async () => {
    open();
    await ready();
    change('reminder_days', '3, 0, -1');
    expect(screen.getByTestId('error-reminder_days').textContent).toContain(text('pwf.pref.problem.reminderNotEarlier.error', { official: 0 }));
    change('reminder_days', '3, 3');
    expect(screen.getByTestId('error-reminder_days').textContent).toContain(text('pwf.pref.problem.reminderOrder.error'));
    change('reminder_days', 'x');
    expect(screen.getByTestId('error-reminder_days').textContent).toContain(text('pwf.pref.problem.integer.error'));
  });
});

describe('PWF-15: saving and clearing', () => {
  it('saves the levels and the reminders under the version it read, with the owner sentence as the result, then reads the new version', async () => {
    let current = preferenceBody({ version: 0 });
    const { h } = open({
      preference: () => current,
      commands: {
        setDeadlinePreference: (input: Record<string, unknown>) => {
          current = savedBody({ version: 1, ...(input as { body: object }).body });
          return { operation_id: 'op', status: 'Updated', resource_version: 1 };
        },
      },
    });
    await ready();
    change('green_days', '7');
    change('yellow_days', '3');
    change('red_days', '1');
    change('reminder_days', '7, 3, 1');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('setDeadlinePreference');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 0, body: { green_days: 7, yellow_days: 3, red_days: 1, reminder_days: [7, 3, 1] } });
    expect((await screen.findByTestId('notice')).dataset.notice).toBe('saved');
    expect(screen.getByTestId('notice').textContent).toBe(text('pwf.pref.saved.text'));
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getDeadlinePreference').length).toBeGreaterThan(1));
    expect(field('green_days').value).toBe('7');
    expect(screen.getByTestId('sentence-personal').textContent).toBe(PERSONAL_SENTENCE);
  });

  it('clears the personal setting at once: all levels null and no reminder, and says it follows the official levels again', async () => {
    let current = savedBody();
    const { h } = open({
      preference: () => current,
      commands: {
        setDeadlinePreference: () => {
          current = preferenceBody({ version: 4 });
          return { operation_id: 'op', status: 'Updated', resource_version: 4 };
        },
      },
    });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.clear.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 3, body: { green_days: null, yellow_days: null, red_days: null, reminder_days: [] } });
    expect((await screen.findByTestId('notice')).dataset.notice).toBe('cleared');
    await waitFor(() => expect(field('green_days').value).toBe(''));
  });

  it('shows the refusal of the server for a level later than the official one on that level', async () => {
    open({ commands: { setDeadlinePreference: refusal('DEADLINE_PERSONAL_NOT_EARLIER', 422, {}, 'yellow_days') } });
    await ready();
    change('yellow_days', '4');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    const banner = await screen.findByTestId('refusal');
    expect(banner.dataset.kind).toBe('notEarlier');
    expect(banner.textContent).toContain(text('pwf.pref.refusal.notEarlier.error'));
    await waitFor(() => expect(field('yellow_days').getAttribute('aria-invalid')).toBe('true'));
  });

  it('says the order is wrong when the server says so, and a general failure in general words', async () => {
    open({ commands: { setDeadlinePreference: refusal('DEADLINE_BAND_THRESHOLDS_INVALID', 422, {}, 'green_days') } });
    await ready();
    change('yellow_days', '4');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    expect((await screen.findByTestId('refusal')).dataset.kind).toBe('order');
    cleanup();
    open({ commands: { setDeadlinePreference: new Error('down') } });
    await ready();
    change('yellow_days', '4');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    expect((await screen.findByTestId('refusal')).dataset.kind).toBe('general');
  });

  it('conflict: says somebody changed it first, offers the newer version and reads it again', async () => {
    let current = savedBody({ version: 3 });
    const { h } = open({ preference: () => current, commands: { setDeadlinePreference: refusal('VERSION_CONFLICT', 409) } });
    await ready();
    change('green_days', '8');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    const banner = await screen.findByTestId('refusal');
    expect(banner.dataset.kind).toBe('conflict');
    expect(banner.textContent).toContain(text('pwf.pref.refusal.conflict.error'));
    current = savedBody({ version: 4, green_days: 9 });
    const before = h.read.mock.calls.filter((call) => call[0] === 'getDeadlinePreference').length;
    fireEvent.click(within(banner).getByRole('button', { name: text('pwf.pref.reload.action') }));
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getDeadlinePreference').length).toBeGreaterThan(before));
    await waitFor(() => expect(field('green_days').value).toBe('9'));
    expect(screen.queryByTestId('refusal')).toBeNull();
  });
});

describe('PWF-15: the states of the screen', () => {
  it('shows the loading state, then the form', async () => {
    open();
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
    await ready();
  });

  it('shows the error state with a retry that reads again', async () => {
    let calls = 0;
    const { h } = open({ preference: () => (calls++ === 0 ? refusal('INTERNAL_ERROR', 500) : preferenceBody()) });
    expect(await screen.findByText(text('states.error.title'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    await ready();
    expect(h.read.mock.calls.filter((call) => call[0] === 'getDeadlinePreference')).toHaveLength(2);
  });

  it('is denied without the permission to set reminders, and reads nothing', () => {
    const { h } = open({ permissions: READ_ONLY });
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('is denied when the server refuses the read for the scope', async () => {
    open({ preference: refusal('SCOPE_DENIED', 403) });
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('shows the setting but changes nothing when the session is read-only', async () => {
    open({ mode: 'READ_ONLY', preference: savedBody() });
    await ready();
    expect(screen.getByTestId('read-only')).toBeTruthy();
    for (const path of ['green_days', 'yellow_days', 'red_days', 'reminder_days']) expect(field(path).disabled).toBe(true);
    expect((screen.getByRole('button', { name: text('pwf.pref.save.action') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: text('pwf.pref.clear.action') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('links to the notification preferences', async () => {
    open();
    await ready();
    expect(screen.getByTestId('link-notifications').getAttribute('href')).toBe('/not/not-03');
  });
});

describe('PWF-15: my coming tasks (R40)', () => {
  it('shows each task with the project code, the name, the real due date and the official colour, and the personal colour with its label only when it differs', async () => {
    open();
    const table = await screen.findByTestId('my-tasks');
    const rows = [...table.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('DA-001')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Công việc của tôi 1' }).getAttribute('href')).toBe(`/pwf/pwf-04?id=${uuid(1001)}&project=${PROJECT_ID}`);
    expect(within(rows[0] as HTMLElement).getByTestId('due').textContent).toBe('10/12/2026');
    const first = within(rows[0] as HTMLElement).getByTestId('official-band');
    expect(first.textContent).toContain(text('pwf.band.green.word'));
    expect(within(rows[0] as HTMLElement).queryByTestId('personal-band')).toBeNull();
    const second = within(rows[1] as HTMLElement);
    expect(second.getByTestId('official-band').textContent).toContain(text('pwf.band.green.word'));
    const personal = second.getByTestId('personal-band');
    expect(personal.textContent).toContain(text('pwf.pref.personal.label'));
    expect(personal.textContent).toContain(text('pwf.band.yellow.word'));
    expect(personal.textContent).toContain('⚠');
    expect(personal.dataset.band).toBe('YELLOW');
    expect(screen.getByTestId('tasks-count').textContent).toBe('Đang hiện 2 trên 2');
  });

  it('keeps the official colour first and shows no personal colour for a task whose personal colour is the same', async () => {
    open({ tasks: myTasks([myTask(1, { official_band: band('YELLOW'), personal_band: band('YELLOW') })]) });
    await screen.findByTestId('my-tasks');
    expect(screen.queryByTestId('personal-band')).toBeNull();
    expect(screen.getByTestId('official-band').textContent).toContain(text('pwf.band.yellow.word'));
  });

  it('says there is no due date or that it cannot be counted, never a guessed date or a green', async () => {
    open({ tasks: myTasks([myTask(1, { due_date: null, official_band: band('UNKNOWN', { reason: 'CALENDAR_UNAVAILABLE' }) })]) });
    await screen.findByTestId('my-tasks');
    expect(screen.getByTestId('due').textContent).toBe(text('pwf.common.noDue.text'));
    expect(screen.getByTestId('official-band').textContent).toContain(text('pwf.band.unknown.word'));
  });

  it('marks a critical task and shows the more button for the next page, reading it with the cursor', async () => {
    const { h } = open({
      tasks: (input: Record<string, unknown>) => {
        const query = input.query as { cursor?: string };
        return query.cursor === undefined ? myTasks([myTask(1, { critical: true })], { next_cursor: 'c2', total: 2 }) : myTasks([myTask(2)], { total: 2 });
      },
    });
    await screen.findByTestId('my-tasks');
    expect(screen.getByText(text('pwf.pref.tasks.critical.word'))).toBeTruthy();
    expect(screen.getByTestId('tasks-count').textContent).toBe('Đang hiện 1 trên 2');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.tasks.more.action') }));
    await waitFor(() => expect(screen.getByTestId('tasks-count').textContent).toBe('Đang hiện 2 trên 2'));
    expect(h.read.mock.calls.filter((call) => call[0] === 'getMyTasks').map((call) => (call[1] as { query: Record<string, unknown> }).query)).toEqual([{ limit: 20 }, { limit: 20, cursor: 'c2' }]);
    expect(screen.queryByRole('button', { name: text('pwf.pref.tasks.more.action') })).toBeNull();
  });

  it('shows the empty state for a person with no task, and an error state that does not hide the form', async () => {
    open({ tasks: myTasks([]) });
    await ready();
    expect(await screen.findByText(text('states.empty.title'))).toBeTruthy();
    cleanup();
    open({ tasks: refusal('INTERNAL_ERROR', 500) });
    await ready();
    expect(await screen.findByText(text('states.error.title'))).toBeTruthy();
    expect(screen.getByTestId('deadline-form')).toBeTruthy();
  });

  it('leaves the tasks out for a person who does not work on tasks', async () => {
    const { h } = open({ permissions: [...ALL_PERMISSIONS].filter((permission) => permission !== 'pwf.task.work') });
    await ready();
    expect(screen.queryByTestId('my-tasks')).toBeNull();
    expect(h.read.mock.calls.some((call) => call[0] === 'getMyTasks')).toBe(false);
  });
});

describe('PWF-15: accessibility (WCAG 2.2 AA)', () => {
  it('has no serious violation with a setting, with tasks, and with the personal colour shown', async () => {
    const { view } = open({ preference: savedBody() });
    await screen.findByTestId('my-tasks');
    const found = await seriousViolations(view.container);
    expect(describeViolations(found)).toEqual([]);
  });

  it('has no serious violation with nothing set, a blocked preview and a refusal', async () => {
    const { view } = open({ commands: { setDeadlinePreference: refusal('DEADLINE_PERSONAL_NOT_EARLIER', 422, {}, 'yellow_days') } });
    await ready();
    expect(describeViolations(await seriousViolations(view.container))).toEqual([]);
    change('yellow_days', '1');
    expect(describeViolations(await seriousViolations(view.container))).toEqual([]);
    change('yellow_days', '4');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    await screen.findByTestId('refusal');
    expect(describeViolations(await seriousViolations(view.container))).toEqual([]);
  });

  it('has no serious violation in the clamped, read-only, denied and error states', async () => {
    const clamped = open({ mode: 'READ_ONLY', preference: savedBody({ clamped: ['red_days'] }) });
    await ready();
    expect(describeViolations(await seriousViolations(clamped.view.container))).toEqual([]);
    cleanup();
    const denied = open({ permissions: READ_ONLY });
    expect(describeViolations(await seriousViolations(denied.view.container))).toEqual([]);
    cleanup();
    const failed = open({ preference: refusal('INTERNAL_ERROR', 500) });
    await screen.findByText(text('states.error.title'));
    expect(describeViolations(await seriousViolations(failed.view.container))).toEqual([]);
  });
});
