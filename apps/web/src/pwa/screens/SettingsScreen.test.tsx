import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import { describeViolations, seriousViolations } from '../../test/axe';
import SettingsScreen from './SettingsScreen';
import { mountPwa, pwaClient, taskId, word } from './test-support';

const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

const session = (n: number, current: boolean) => ({ id: taskId(10 + n), current, assurance_level: current ? 'aal2' : 'aal1', user_agent_summary: current ? 'Chrome trên Android' : 'Safari trên iPhone', created_at: '2026-11-01T01:00:00.000Z', last_seen_at: '2026-11-08T02:30:00.000Z', device: { platform: current ? 'web' : 'ios' } });
const device = (n: number, status = 'ACTIVE') => ({ id: taskId(20 + n), platform: n === 1 ? 'web' : 'android', device_public_id: `dev-${n}`, last_seen_at: '2026-11-08T02:30:00.000Z', status });
const PROFILE = { id: taskId(1), display_name: 'Lãnh đạo', email_masked: 'l***@x.vn', phone_masked: null, locale: 'vi-VN', time_zone: 'Asia/Ho_Chi_Minh', version: 4 };
const DEADLINE = { green_days: 7, yellow_days: 3, red_days: 1, reminder_days: [7, 3, 1], official: { green_days: 5, yellow_days: 2, red_days: 0 }, clamped: [], version: 3, as_of: '2026-11-12T03:00:00.000Z' };
const PREFS = { version: 3, is_default: false, quiet_start: '22:00', quiet_end: '06:30', time_zone: 'Asia/Ho_Chi_Minh', items: [{ event_category: 'report', channel: 'PUSH', enabled: false, digest_mode: 'DAILY' }], locked: [{ event_category: 'approval', channel: 'IN_APP' }] };

interface World {
  sessions?: unknown;
  devices?: unknown;
  profile?: unknown;
  prefs?: unknown;
  deadline?: unknown;
  command?: (operation: string, input: unknown) => unknown;
}

function open(world: World = {}, mode?: 'READ_ONLY') {
  const h = pwaClient({
    read: (operation) => {
      if (operation === 'listMySessions') return world.sessions ?? { items: [session(1, true), session(2, false)] };
      if (operation === 'listMyDevices') return world.devices ?? { items: [device(1), device(2), device(3, 'REVOKED')] };
      if (operation === 'getMyProfile') return world.profile ?? PROFILE;
      if (operation === 'getMyNotificationPreferences') return world.prefs ?? PREFS;
      if (operation === 'getDeadlinePreference') return world.deadline ?? DEADLINE;
      return new Error(`unexpected read ${operation}`);
    },
    command: world.command,
  });
  mountPwa(<SettingsScreen />, h, { path: '/m/settings', ...(mode === undefined ? {} : { mode }) });
  return h;
}

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

describe('SettingsScreen (PWA-07)', () => {
  it('UAT-PWA-04: lists the sessions and the devices from the real operations, marking the current session', async () => {
    const h = open();
    const sessions = await screen.findByTestId('sessions');
    expect(within(sessions).getAllByRole('listitem')).toHaveLength(2);
    expect(sessions.querySelector('[data-current="yes"]')?.textContent).toContain(word('iam.sessions.current'));
    expect(sessions.querySelector('[data-current="yes"] [data-action="revoke-session"]')).toBeNull();
    const devices = await screen.findByTestId('devices');
    expect(within(devices).getAllByRole('listitem')).toHaveLength(3);
    expect(devices.querySelector('[data-revoked="yes"] [data-action="revoke-device"]')).toBeNull();
    expect(h.read).toHaveBeenCalledWith('listMySessions', {});
    expect(h.read).toHaveBeenCalledWith('listMyDevices', {});
  });

  it('UAT-PWA-04 / AC-ST-PWA-004-1: asks for the reason before ending another session and sends it once', async () => {
    const h = open();
    const sessions = await screen.findByTestId('sessions');
    fireEvent.click(sessions.querySelector('[data-action="revoke-session"]') as HTMLElement);
    const sheet = screen.getByRole('dialog', { name: word('pwa2.settings.revoke.session.title') });
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'ngắn' } });
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa2.settings.revoke.submit') }));
    expect((await within(sheet).findByTestId('decision-problem')).textContent).toContain('10');
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Máy đã mất, cần thu hồi phiên' } });
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa2.settings.revoke.submit') }));
    expect((await screen.findByTestId('revoked')).textContent).toContain(word('pwa2.settings.revoke.sessionDone'));
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command.mock.calls[0]?.[0]).toBe('revokeMySession');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { sessionId: taskId(12) }, body: { reason: 'Máy đã mất, cần thu hồi phiên' } });
  });

  it('UAT-PWA-04: removes a device with a reason, and shows the refusal in place', async () => {
    const h = open({ command: (operation) => (operation === 'revokeMyDevice' ? failure(403, 'PERMISSION_DENIED') : undefined) });
    const devices = await screen.findByTestId('devices');
    fireEvent.click(devices.querySelector('[data-device="' + taskId(22) + '"] [data-action="revoke-device"]') as HTMLElement);
    const sheet = screen.getByRole('dialog', { name: word('pwa2.settings.revoke.device.title') });
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Không còn dùng thiết bị này' } });
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa2.settings.revoke.submit') }));
    expect((await within(sheet).findByTestId('decision-problem')).textContent).toContain(word('iam.self.error.denied'));
    expect(h.command.mock.calls[0]?.[0]).toBe('revokeMyDevice');
  });

  it('UAT-PWA-04: changes the language at once and saves it to the profile under its version', async () => {
    const h = open();
    await screen.findByTestId('sessions');
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getMyProfile', {}));
    await waitFor(() => expect(h.read.mock.results.length).toBeGreaterThan(3));
    fireEvent.change(screen.getByLabelText(word('pwa2.settings.language.label')), { target: { value: 'en-US' } });
    expect(translator.getLocale()).toBe('en');
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('updateMyProfile');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { locale: 'en-US' }, ifMatchVersion: 4 });
  });

  it('UAT-PWA-04 / AC-ST-PWA-004-2: shows the preferences per category with the mandatory inbox locked, and saves the whole set under its version', async () => {
    const h = open();
    const form = await screen.findByTestId('preferences-form');
    const report = form.querySelector('[data-category="report"]') as HTMLElement;
    expect(within(report).getByRole('checkbox', { name: /Đẩy|Push|push/i })).not.toBeChecked();
    expect((within(report).getByRole('combobox') as HTMLSelectElement).value).toBe('DAILY');
    const approval = form.querySelector('[data-category="approval"]') as HTMLElement;
    const inbox = within(approval).getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(inbox.disabled).toBe(true);
    expect(inbox.checked).toBe(true);
    expect((screen.getByLabelText(word('pwa2.settings.notifications.quietFrom')) as HTMLInputElement).value).toBe('22:00');
    fireEvent.click(within(report).getAllByRole('checkbox')[2] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: word('pwa2.settings.notifications.save') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('updateMyNotificationPreferences');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 3, body: { quiet_start: '22:00', quiet_end: '06:30' } });
    expect(await screen.findByTestId('save-done')).toBeInTheDocument();
  });

  it('UAT-PWA-04: refuses equal quiet hours without sending', async () => {
    const h = open();
    await screen.findByTestId('preferences-form');
    fireEvent.change(screen.getByLabelText(word('pwa2.settings.notifications.quietTo')), { target: { value: '22:00' } });
    fireEvent.click(screen.getByRole('button', { name: word('pwa2.settings.notifications.save') }));
    expect((await screen.findByTestId('quiet-problem')).textContent).toContain(word('pwa2.settings.notifications.quietEmpty'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('keeps each card on its own: one failure does not hide the others and offers a retry', async () => {
    open({ sessions: failure(500, 'INTERNAL') });
    expect(await screen.findByText(word('pwa2.settings.sessions.failed'))).toBeInTheDocument();
    expect(await screen.findByTestId('devices')).toBeInTheDocument();
    expect(await screen.findByTestId('preferences-form')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: word('states.retry.action') }).length).toBeGreaterThan(0);
  });

  it('offers no ending of a session or device in a read-only session', async () => {
    open({}, 'READ_ONLY');
    await screen.findByTestId('sessions');
    await screen.findByTestId('devices');
    expect(document.querySelector('[data-action^="revoke"]')).toBeNull();
    expect((screen.getByRole('button', { name: word('pwa2.settings.notifications.save') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no serious accessibility violation and the controls are touch targets', async () => {
    open();
    await screen.findByTestId('preferences-form');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    for (const control of document.querySelectorAll('[data-action^="revoke"], [data-testid="pwa-back"], button[type="submit"]')) expect(control.className).toContain('pwa-touch');
  });
});

describe('SettingsScreen (PWA-07): the personal deadline reminders (MOB-82, PWF-15)', () => {
  it('shows the card after the notifications with the levels of the person, the official ones beside them and the owner sentence', async () => {
    const h = open();
    const form = await screen.findByTestId('deadline-form');
    expect(within(form).getByTestId('field-green_days')).toHaveValue('7');
    expect(within(form).getByTestId('hint-green_days').textContent).toBe(word('pwf.pref.official.text', { value: 5 }));
    expect(within(form).getByTestId('sentence-personal').textContent).toBe('Còn 7 ngày làm việc: xanh, còn 3 ngày làm việc: vàng, dưới 2 ngày làm việc: đỏ');
    expect(h.read).toHaveBeenCalledWith('getDeadlinePreference', {});
    const cards = [...document.querySelectorAll('section.ui-section')].map((card) => card.querySelector('h2')?.textContent);
    expect(cards.indexOf(word('pwf.pref.card.title'))).toBe(cards.indexOf(word('pwa2.settings.notifications.title')) + 1);
    expect(screen.queryByTestId('link-full')).toBeNull();
  });

  it('saves a new level under the version it read and says so', async () => {
    const h = open();
    const field = await screen.findByTestId('field-yellow_days');
    fireEvent.change(field, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: word('pwf.pref.save.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('setDeadlinePreference');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 3, body: { green_days: 7, yellow_days: 4, red_days: 1, reminder_days: [7, 3, 1] } });
    expect((await screen.findByTestId('notice')).textContent).toBe(word('pwf.pref.saved.text'));
  });

  it('keeps its touch targets, is read-only in a read-only session, and does not hide the other cards when it fails', async () => {
    open({}, 'READ_ONLY');
    await screen.findByTestId('field-green_days');
    expect(screen.getByRole('button', { name: word('pwf.pref.save.action') }).className).toContain('pwa-touch');
    expect(screen.getByRole('button', { name: word('pwf.pref.clear.action') })).toBeDisabled();
    cleanup();
    open({ deadline: failure(500, 'INTERNAL') });
    expect(await screen.findByTestId('card-failed')).toBeInTheDocument();
    expect(await screen.findByTestId('sessions')).toBeInTheDocument();
  });

  it('has nothing of the card for a person who may not set reminders of their own', async () => {
    const h = pwaClient({ read: (operation) => (operation === 'getDeadlinePreference' ? DEADLINE : operation === 'getMyNotificationPreferences' ? PREFS : operation === 'getMyProfile' ? PROFILE : { items: [] }) });
    mountPwa(<SettingsScreen />, h, { path: '/m/settings', permissions: ['notification.self'] });
    await screen.findByTestId('preferences-form');
    expect(screen.queryByText(word('pwf.pref.card.title'))).toBeNull();
    expect(h.read).not.toHaveBeenCalledWith('getDeadlinePreference', {});
  });

  it('has no serious accessibility violation with the card set, with a problem and failed', async () => {
    open();
    const field = await screen.findByTestId('field-yellow_days');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    fireEvent.change(field, { target: { value: '1' } });
    expect(await screen.findByTestId('error-yellow_days')).toBeInTheDocument();
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    cleanup();
    open({ deadline: failure(500, 'INTERNAL') });
    await screen.findByTestId('card-failed');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
