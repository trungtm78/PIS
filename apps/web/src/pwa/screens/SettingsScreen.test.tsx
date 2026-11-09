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
const PREFS = { version: 3, is_default: false, quiet_start: '22:00', quiet_end: '06:30', time_zone: 'Asia/Ho_Chi_Minh', items: [{ event_category: 'report', channel: 'PUSH', enabled: false, digest_mode: 'DAILY' }], locked: [{ event_category: 'approval', channel: 'IN_APP' }] };

interface World {
  sessions?: unknown;
  devices?: unknown;
  profile?: unknown;
  prefs?: unknown;
  command?: (operation: string, input: unknown) => unknown;
}

function open(world: World = {}, mode?: 'READ_ONLY') {
  const h = pwaClient({
    read: (operation) => {
      if (operation === 'listMySessions') return world.sessions ?? { items: [session(1, true), session(2, false)] };
      if (operation === 'listMyDevices') return world.devices ?? { items: [device(1), device(2), device(3, 'REVOKED')] };
      if (operation === 'getMyProfile') return world.profile ?? PROFILE;
      if (operation === 'getMyNotificationPreferences') return world.prefs ?? PREFS;
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
  it('lists the sessions and the devices from the real operations, marking the current session', async () => {
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

  it('asks for the reason before ending another session and sends it once (AC-ST-PWA-004-1)', async () => {
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

  it('removes a device with a reason, and shows the refusal in place', async () => {
    const h = open({ command: (operation) => (operation === 'revokeMyDevice' ? failure(403, 'PERMISSION_DENIED') : undefined) });
    const devices = await screen.findByTestId('devices');
    fireEvent.click(devices.querySelector('[data-device="' + taskId(22) + '"] [data-action="revoke-device"]') as HTMLElement);
    const sheet = screen.getByRole('dialog', { name: word('pwa2.settings.revoke.device.title') });
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Không còn dùng thiết bị này' } });
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa2.settings.revoke.submit') }));
    expect((await within(sheet).findByTestId('decision-problem')).textContent).toContain(word('iam.self.error.denied'));
    expect(h.command.mock.calls[0]?.[0]).toBe('revokeMyDevice');
  });

  it('changes the language at once and saves it to the profile under its version', async () => {
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

  it('shows the preferences per category with the mandatory inbox locked, and saves the whole set under its version (AC-ST-PWA-004-2)', async () => {
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

  it('refuses equal quiet hours without sending', async () => {
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
