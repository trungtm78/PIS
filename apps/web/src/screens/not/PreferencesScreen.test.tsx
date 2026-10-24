import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { failure, harness, mount, routeOf } from './delivery/test-support';
import PreferencesScreen from './PreferencesScreen';
import { bodyOf, draftOf, quietProblem, toPreferenceView } from './preferences/model';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('NOT-03', 'FR-NOT-03');
const MEMBER = ['notification.self'];

const VIEW = {
  version: 3,
  is_default: false,
  quiet_start: '22:00',
  quiet_end: '06:30',
  time_zone: 'Asia/Tokyo',
  items: [
    { event_category: 'report', channel: 'SMS', enabled: false, digest_mode: 'DAILY' },
    { event_category: '*', channel: 'EMAIL', enabled: true, digest_mode: 'IMMEDIATE' },
  ],
  locked: [{ event_category: 'approval', channel: 'IN_APP' }],
};

afterEach(cleanup);

function reads(view: unknown = VIEW) {
  return harness((operation) => (operation === 'getMyNotificationPreferences' ? view : new Error(`unexpected read ${operation}`)), () => ({ operation_id: 'op', status: 'Updated', resource_version: 4, resource_id: 'm-1' }));
}

const rowOf = (category: string): HTMLElement => document.querySelector(`[data-category="${category}"]`) as HTMLElement;

describe('NOT-03 preferences (ST-NOT-003)', () => {
  it('shows the matrix of kinds of events against channels, the digest mode, the quiet hours and the time zone the server holds', async () => {
    mount(<PreferencesScreen route={ROUTE} />, reads(), { permissions: MEMBER });
    await waitFor(() => expect(rowOf('report')).not.toBeNull());
    expect(within(rowOf('report')).getByRole('checkbox', { name: 'report - Tin nhắn SMS' })).not.toBeChecked();
    expect(within(rowOf('report')).getByRole('checkbox', { name: 'report - Thư điện tử' })).toBeChecked();
    expect(within(rowOf('report')).getByRole('combobox')).toHaveValue('DAILY');
    expect(screen.getByLabelText(vi_['not.pref.quiet.start.label'])).toHaveValue('22:00');
    expect(screen.getByLabelText(vi_['not.pref.quiet.end.label'])).toHaveValue('06:30');
    expect(screen.getByLabelText(vi_['not.pref.zone.label'])).toHaveValue('Asia/Tokyo');
  });

  it('locks the inbox of a category that holds an urgent event, with the reason, and leaves the other channels free', async () => {
    mount(<PreferencesScreen route={ROUTE} />, reads(), { permissions: MEMBER });
    await waitFor(() => expect(rowOf('approval')).not.toBeNull());
    const inbox = within(rowOf('approval')).getByRole('checkbox', { name: 'approval - Hộp thư trong ứng dụng' });
    expect(inbox).toBeChecked();
    expect(inbox).toBeDisabled();
    expect(inbox).toHaveAttribute('title', vi_['not.pref.locked.hint']);
    expect(within(rowOf('approval')).getByRole('checkbox', { name: 'approval - Tin nhắn SMS' })).toBeEnabled();
    // Every category is locked too, because one category holds an urgent event.
    expect(within(rowOf('*')).getByRole('checkbox', { name: `${vi_['not.pref.category.all']} - Hộp thư trong ứng dụng` })).toBeDisabled();
    // A category without an urgent event can switch its inbox off.
    expect(within(rowOf('report')).getByRole('checkbox', { name: 'report - Hộp thư trong ứng dụng' })).toBeEnabled();
  });

  it('saves the whole set under the version it read, sending only the cells that differ from the default', async () => {
    const user = userEvent.setup();
    const h = reads();
    mount(<PreferencesScreen route={ROUTE} />, h, { permissions: MEMBER });
    await waitFor(() => expect(rowOf('report')).not.toBeNull());
    await user.click(within(rowOf('report')).getByRole('checkbox', { name: 'report - Thư điện tử' }));
    await user.click(screen.getByRole('button', { name: vi_['not.pref.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'updateMyNotificationPreferences',
      expect.objectContaining({
        ifMatchVersion: 3,
        body: {
          items: [
            { event_category: 'report', channel: 'IN_APP', enabled: true, digest_mode: 'DAILY' },
            { event_category: 'report', channel: 'EMAIL', enabled: false, digest_mode: 'DAILY' },
            { event_category: 'report', channel: 'PUSH', enabled: true, digest_mode: 'DAILY' },
            { event_category: 'report', channel: 'SMS', enabled: false, digest_mode: 'DAILY' },
            { event_category: 'report', channel: 'ZALO', enabled: true, digest_mode: 'DAILY' },
            { event_category: 'report', channel: 'WHATSAPP', enabled: true, digest_mode: 'DAILY' },
          ],
          quiet_start: '22:00',
          quiet_end: '06:30',
          time_zone: 'Asia/Tokyo',
        },
      }),
    );
    expect(await screen.findByTestId('save-done')).toBeTruthy();
  });

  it('keeps the notice of a saved set although the version changed and the form was built again', async () => {
    const user = userEvent.setup();
    let version = 3;
    const h = harness(
      (operation) => (operation === 'getMyNotificationPreferences' ? { ...VIEW, version } : new Error(`unexpected read ${operation}`)),
      () => {
        version = 4;
        return { operation_id: 'op', status: 'Updated', resource_version: 4, resource_id: 'm-1' };
      },
    );
    mount(<PreferencesScreen route={ROUTE} />, h, { permissions: MEMBER });
    await waitFor(() => expect(rowOf('report')).not.toBeNull());
    await user.click(screen.getByRole('button', { name: vi_['not.pref.save.action'] }));
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByTestId('save-done')).toBeTruthy();
    // The next save is made under the version that was read after the first.
    await user.click(screen.getByRole('button', { name: vi_['not.pref.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command.mock.calls[1]?.[1]).toMatchObject({ ifMatchVersion: 4 });
  });

  it('adds a category and refuses a name that is not one', async () => {
    const user = userEvent.setup();
    mount(<PreferencesScreen route={ROUTE} />, reads(), { permissions: MEMBER });
    await waitFor(() => expect(rowOf('report')).not.toBeNull());
    await user.type(screen.getByLabelText(vi_['not.pref.category.add.label']), 'Not A Name');
    await user.click(screen.getByRole('button', { name: vi_['not.pref.category.add.action'] }));
    expect(await screen.findByText(vi_['not.pref.category.add.error'])).toBeTruthy();
    await user.clear(screen.getByLabelText(vi_['not.pref.category.add.label']));
    await user.type(screen.getByLabelText(vi_['not.pref.category.add.label']), 'plan');
    await user.click(screen.getByRole('button', { name: vi_['not.pref.category.add.action'] }));
    await waitFor(() => expect(rowOf('plan')).not.toBeNull());
  });

  it('turns the quiet hours off, and sends no hours then', async () => {
    const user = userEvent.setup();
    const h = reads();
    mount(<PreferencesScreen route={ROUTE} />, h, { permissions: MEMBER });
    await waitFor(() => expect(rowOf('report')).not.toBeNull());
    await user.click(screen.getByLabelText(vi_['not.pref.quiet.on.label']));
    expect(screen.getByLabelText(vi_['not.pref.quiet.start.label'])).toBeDisabled();
    await user.click(screen.getByRole('button', { name: vi_['not.pref.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const body = (h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty('quiet_start');
    expect(body).not.toHaveProperty('quiet_end');
  });

  it('refuses hours that are empty before anything is sent', async () => {
    const user = userEvent.setup();
    const h = reads();
    mount(<PreferencesScreen route={ROUTE} />, h, { permissions: MEMBER });
    await waitFor(() => expect(rowOf('report')).not.toBeNull());
    await user.clear(screen.getByLabelText(vi_['not.pref.quiet.end.label']));
    await user.type(screen.getByLabelText(vi_['not.pref.quiet.end.label']), '22:00');
    await user.click(screen.getByRole('button', { name: vi_['not.pref.save.action'] }));
    expect(await screen.findByText(vi_['not.pref.quiet.empty.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it.each([
    ['the inbox is locked on the server', failure(422, 'MANDATORY_CHANNEL_LOCKED'), vi_['not.pref.problem.locked']],
    ['another save came first', failure(409, 'VERSION_CONFLICT'), vi_['not.pref.problem.stale']],
    ['the server fails', failure(500, 'INTERNAL_ERROR'), vi_['not.pref.problem.general']],
  ])('says why the save failed when %s', async (_label, error, message) => {
    const user = userEvent.setup();
    const h = reads();
    h.command.mockRejectedValueOnce(error);
    mount(<PreferencesScreen route={ROUTE} />, h, { permissions: MEMBER });
    await waitFor(() => expect(rowOf('report')).not.toBeNull());
    await user.click(screen.getByRole('button', { name: vi_['not.pref.save.action'] }));
    expect(await screen.findByTestId('save-problem')).toHaveTextContent(message);
  });

  it('tells a person who never saved that the hours are the default ones, and is read-only in read-only mode', async () => {
    mount(<PreferencesScreen route={ROUTE} />, reads({ ...VIEW, version: 0, is_default: true, items: [], locked: [], quiet_start: '21:00', quiet_end: '07:00', time_zone: 'Asia/Ho_Chi_Minh' }), { permissions: MEMBER, mode: 'READ_ONLY' });
    expect(await screen.findByText(vi_['not.pref.default.message'])).toBeTruthy();
    expect(screen.getByText(vi_['not.pref.readOnly.message'])).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['not.pref.save.action'] })).toBeDisabled();
    expect(within(rowOf('*')).getByRole('checkbox', { name: `${vi_['not.pref.category.all']} - Thư điện tử` })).toBeDisabled();
  });
});

describe('NOT-03 preferences: the seven states', () => {
  it('shows the loading state', async () => {
    const h = reads();
    h.read.mockImplementation(() => new Promise(() => undefined));
    mount(<PreferencesScreen route={ROUTE} />, h, { permissions: MEMBER });
    expect(await screen.findByRole('status', { name: 'Đang tải' })).toHaveAttribute('aria-busy', 'true');
  });

  it.each([
    ['an error', failure(500, 'INTERNAL_ERROR'), /Chưa thể tải dữ liệu/],
    ['a refusal', failure(403, 'SCOPE_DENIED'), /Bạn chưa có quyền truy cập/],
    ['a lapsed session', failure(401, 'SESSION_EXPIRED'), /Phiên làm việc đã hết hạn/],
    ['a failed network', failure(0, NETWORK_ERROR_CODE), /Bạn đang ngoại tuyến/],
    ['an answer that cannot be read', { version: 'x' }, /Chưa thể tải dữ liệu/],
  ])('shows its own state for %s', async (_label, answer, wording) => {
    mount(<PreferencesScreen route={ROUTE} />, harness(() => answer), { permissions: MEMBER });
    expect(await screen.findByText(wording)).toBeInTheDocument();
    expect(screen.queryByTestId('preferences-form')).toBeNull();
  });
});

describe('the model of the preferences', () => {
  it('reads an answer defensively and refuses one with a cell it cannot read', () => {
    expect(toPreferenceView(null)).toBeUndefined();
    expect(toPreferenceView({ ...VIEW, items: [{ event_category: 'report', channel: 'FAX', enabled: true }] })).toBeUndefined();
    expect(toPreferenceView({ ...VIEW, items: [null] })).toBeUndefined();
    const read = toPreferenceView({ ...VIEW, locked: [{ event_category: 'x', channel: 'IN_APP' }, { nonsense: true }, null], quiet_start: null, quiet_end: null });
    expect(read?.locked).toEqual([{ eventCategory: 'x', channel: 'IN_APP' }]);
    expect(read?.quietStart).toBeUndefined();
    expect(toPreferenceView({ ...VIEW, locked: 'none' })?.locked).toEqual([]);
  });

  it('turns a draft into the body of a save and back', () => {
    const view = toPreferenceView(VIEW);
    if (view === undefined) throw new Error('view');
    const draft = draftOf(view);
    expect(draft.categories).toEqual(['approval', 'report']);
    expect(bodyOf(draft).items).toEqual([
      { event_category: 'report', channel: 'IN_APP', enabled: true, digest_mode: 'DAILY' },
      { event_category: 'report', channel: 'EMAIL', enabled: true, digest_mode: 'DAILY' },
      { event_category: 'report', channel: 'PUSH', enabled: true, digest_mode: 'DAILY' },
      { event_category: 'report', channel: 'SMS', enabled: false, digest_mode: 'DAILY' },
      { event_category: 'report', channel: 'ZALO', enabled: true, digest_mode: 'DAILY' },
      { event_category: 'report', channel: 'WHATSAPP', enabled: true, digest_mode: 'DAILY' },
    ]);
    expect(quietProblem({ ...draft, quietStart: '25:00' })).toBe('clock');
    expect(quietProblem({ ...draft, quietOn: false, quietStart: '25:00' })).toBeUndefined();
  });
});
