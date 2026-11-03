import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { routeOf } from '../../dgv/test-support';
import ProfileScreen from './ProfileScreen';
import SessionsScreen from './SessionsScreen';
import * as labels from './labels';
import { describeProblem, differences, formOf, profileBody, toDevice, toProfile, toSession, validateProfile } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
const PERMISSIONS = ['profile.self', 'session.self'];

const profile = (overrides: Record<string, unknown> = {}) => ({ id: uuid('0001', 1), display_name: 'Nguyen Van An', email_masked: 'a***@example.vn', phone_masked: '*********567', locale: 'vi-VN', time_zone: 'Asia/Ho_Chi_Minh', version: 4, ...overrides });
const session = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0010', n),
  current: false,
  assurance_level: 'aal1',
  user_agent_summary: `Firefox ${n} on Linux`,
  created_at: `2026-10-2${n}T01:00:00.000000Z`,
  last_seen_at: `2026-10-2${n}T02:00:00.000000Z`,
  device: null,
  ...overrides,
});
const device = (n: number, overrides: Record<string, unknown> = {}) => ({ id: uuid('0020', n), platform: 'android', device_public_id: `device-${n}`, last_seen_at: '2026-10-28T02:00:00.000000Z', revoked_at: null, status: 'ACTIVE', ...overrides });

interface World {
  profile: Record<string, unknown>;
  sessions: Array<Record<string, unknown>>;
  devices: Array<Record<string, unknown>>;
  failing: Set<string>;
}

function client(state: Partial<World> = {}, command: (operation: string, input: unknown) => unknown = () => ({ resource_id: uuid('0010', 1), resource_version: 1 })): Harness & { world: World } {
  const world: World = { profile: profile(), sessions: [], devices: [], failing: new Set(), ...state };
  const h = baseHarness((operation) => {
    if (world.failing.has(operation)) return new Error(`${operation} failed`);
    switch (operation) {
      case 'getMyProfile':
        return world.profile;
      case 'listMySessions':
        return { items: world.sessions, as_of: '2026-10-28T04:00:00.000Z' };
      case 'listMyDevices':
        return { items: world.devices, as_of: '2026-10-28T04:00:00.000Z' };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  return { ...h, world };
}

function open(element: JSX.Element, state: Partial<World> = {}, options: { mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mountInSession(element, h, { permissions: PERMISSIONS, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/iam');
  return h;
}

const commandsOf = (h: Harness, operation: string): Array<{ path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};

afterEach(() => cleanup());

describe('ProfileScreen (IAM-05): my profile', () => {
  const route = routeOf('IAM-05', 'FR-IAM-05');

  it('UI-IAM-05 / AC-ST-IAM-006-5: shows my profile with the email and the phone masked, and saves only what I changed at the version I read', async () => {
    const h = open(<ProfileScreen route={route} />);
    await screen.findByTestId('profile-form');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('iam.profile.title'));
    expect((document.getElementById('profile-name') as HTMLInputElement).value).toBe('Nguyen Van An');
    expect((document.getElementById('profile-email') as HTMLInputElement).value).toBe('a***@example.vn');
    expect(screen.getByText(word('iam.profile.phone.current').replace('{phone}', '*********567'))).toBeTruthy();
    // Nothing changed: nothing is sent.
    fireEvent.click(screen.getByRole('button', { name: word('iam.profile.save') }));
    expect(commandsOf(h, 'updateMyProfile')).toHaveLength(0);
    type('profile-name', 'Nguyễn Văn An');
    type('profile-locale', 'en-US');
    h.world.profile = profile({ display_name: 'Nguyễn Văn An', locale: 'en-US', version: 5 });
    fireEvent.click(screen.getByRole('button', { name: word('iam.profile.save') }));
    await screen.findByTestId('saved');
    expect(commandsOf(h, 'updateMyProfile')).toEqual([{ body: { display_name: 'Nguyễn Văn An', locale: 'en-US' }, ifMatchVersion: 4, attempt: expect.anything() }]);
    expect((document.getElementById('profile-name') as HTMLInputElement).value).toBe('Nguyễn Văn An');
  });

  it('refuses a name that is too short and a phone number that is not E.164 before anything is sent', async () => {
    const h = open(<ProfileScreen route={route} />);
    await screen.findByTestId('profile-form');
    type('profile-name', 'A');
    type('profile-phone', '0901234567');
    fireEvent.click(screen.getByRole('button', { name: word('iam.profile.save') }));
    expect(screen.getByText(word('iam.profile.problem.tooShort'))).toBeTruthy();
    expect(screen.getByText(word('iam.profile.problem.invalidPhone'))).toBeTruthy();
    expect(commandsOf(h, 'updateMyProfile')).toHaveLength(0);
    type('profile-name', '');
    fireEvent.click(screen.getByRole('button', { name: word('iam.profile.save') }));
    expect(screen.getByText(word('iam.profile.problem.required'))).toBeTruthy();
  });

  it('AC-ST-IAM-006-2, UAT-AC122: on a conflict keeps what I entered, shows it beside what the profile says now, and lets me keep mine at the new version', async () => {
    let refuse = true;
    const h = open(<ProfileScreen route={route} />, {}, { command: () => (refuse ? problem('VERSION_CONFLICT') : { resource_id: uuid('0001', 1), resource_version: 6 }) });
    await screen.findByTestId('profile-form');
    type('profile-name', 'Tên tôi nhập');
    // Meanwhile somewhere else the name was changed too.
    h.world.profile = profile({ display_name: 'Tên đổi ở nơi khác', version: 5 });
    fireEvent.click(screen.getByRole('button', { name: word('iam.profile.save') }));
    const conflict = await screen.findByTestId('conflict');
    expect(within(conflict).getByTestId('entered').textContent).toBe('Tên tôi nhập');
    expect(within(conflict).getByTestId('current').textContent).toBe('Tên đổi ở nơi khác');
    expect(screen.getByTestId('refusal').textContent).toBe(word('iam.self.error.versionConflict'));
    // What I entered is still in the form.
    expect((document.getElementById('profile-name') as HTMLInputElement).value).toBe('Tên tôi nhập');
    refuse = false;
    h.world.profile = profile({ display_name: 'Tên tôi nhập', version: 6 });
    fireEvent.click(within(conflict).getByRole('button', { name: word('iam.profile.conflict.keepMine') }));
    await screen.findByTestId('saved');
    expect(commandsOf(h, 'updateMyProfile').map((call) => call.ifMatchVersion)).toEqual([4, 5]);
  });

  it('lets me take the current values instead after a conflict', async () => {
    const h = open(<ProfileScreen route={route} />, {}, { command: () => problem('VERSION_CONFLICT') });
    await screen.findByTestId('profile-form');
    type('profile-name', 'Tên tôi nhập');
    h.world.profile = profile({ display_name: 'Tên đổi ở nơi khác', version: 5 });
    fireEvent.click(screen.getByRole('button', { name: word('iam.profile.save') }));
    const conflict = await screen.findByTestId('conflict');
    fireEvent.click(within(conflict).getByRole('button', { name: word('iam.profile.conflict.useCurrent') }));
    await waitFor(() => expect(screen.queryByTestId('conflict')).toBeNull());
    expect((document.getElementById('profile-name') as HTMLInputElement).value).toBe('Tên đổi ở nơi khác');
    // The form is started over on the current profile: the next change is made at the version that is current now, against what the profile says now.
    type('profile-locale', 'en-US');
    fireEvent.click(screen.getByRole('button', { name: word('iam.profile.save') }));
    await waitFor(() => expect(commandsOf(h, 'updateMyProfile')).toHaveLength(2));
    expect(commandsOf(h, 'updateMyProfile')[1]).toMatchObject({ body: { locale: 'en-US' }, ifMatchVersion: 5 });
  });

  it('AC-ST-IAM-006-5: UI-IAM-05 shows no way to save while the tenant is read-only, and a read that failed with a way to read again', async () => {
    open(<ProfileScreen route={route} />, {}, { mode: 'READ_ONLY' });
    await screen.findByTestId('profile-form');
    expect(screen.queryByRole('button', { name: word('iam.profile.save') })).toBeNull();
    cleanup();
    const failing = client({ failing: new Set(['getMyProfile']) });
    mountInSession(<ProfileScreen route={route} />, failing, { permissions: PERMISSIONS }, '/iam');
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    failing.world.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('profile-form');
  });
});

describe('SessionsScreen (IAM-06): my sessions and devices', () => {
  const route = routeOf('IAM-06', 'FR-IAM-06');
  const rows = (selector: string): string[] => Array.from(document.querySelectorAll(selector)).map((row) => row.getAttribute(selector.replace(/^\[|\]$/g, '')) as string);

  it('UI-IAM-06 / AC-ST-IAM-006-4: lists my sessions and devices, marks the current session and offers no revoke for it', async () => {
    open(<SessionsScreen route={route} />, { sessions: [session(2, { current: true, assurance_level: 'aal2' }), session(1, { device: { id: uuid('0020', 1), platform: 'android' } })], devices: [device(1), device(2, { status: 'REVOKED', revoked_at: '2026-10-27T00:00:00.000000Z' })] });
    await screen.findByTestId('sessions');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('iam.sessions.title'));
    expect(rows('[data-session]')).toEqual([uuid('0010', 2), uuid('0010', 1)]);
    const current = document.querySelector(`[data-session="${uuid('0010', 2)}"]`) as HTMLElement;
    expect(within(current).getByTestId('current').textContent).toBe(word('iam.sessions.current'));
    expect(within(current).queryByRole('button')).toBeNull();
    expect(current.textContent).toContain(word('iam.sessions.assurance.aal2'));
    const other = document.querySelector(`[data-session="${uuid('0010', 1)}"]`) as HTMLElement;
    expect(within(other).getByRole('button', { name: word('iam.sessions.revoke.action') })).toBeTruthy();
    expect(document.querySelectorAll('[data-action="revoke-session"]')).toHaveLength(1);
    const live = document.querySelector(`[data-device="${uuid('0020', 1)}"]`) as HTMLElement;
    expect(within(live).getByTestId('device-state').textContent).toBe(word('iam.sessions.device.active'));
    expect(within(live).getByRole('button', { name: word('iam.sessions.device.revoke.action') })).toBeTruthy();
    const gone = document.querySelector(`[data-device="${uuid('0020', 2)}"]`) as HTMLElement;
    expect(within(gone).getByTestId('device-state').textContent).toBe(word('iam.sessions.device.revoked'));
    expect(within(gone).queryByRole('button')).toBeNull();
    expect(screen.getByText(word('iam.self.footer.reference').replace('{id}', 'IAM-06').replace('{req}', 'FR-IAM-06'))).toBeTruthy();
  });

  it('AC-ST-IAM-006-1: signs out another session with a reason, after asking', async () => {
    const h = open(<SessionsScreen route={route} />, { sessions: [session(2, { current: true }), session(1)] });
    await screen.findByTestId('sessions');
    fireEvent.click(document.querySelector('[data-action="revoke-session"]') as HTMLElement);
    const dialog = screen.getByRole('dialog');
    // A reason is offered; one that is too short is not sent.
    expect((document.getElementById('revoke-reason') as HTMLTextAreaElement).value).toBe(word('iam.sessions.revoke.reason.default'));
    type('revoke-reason', 'short');
    fireEvent.click(within(dialog).getByRole('button', { name: word('iam.sessions.revoke.submit') }));
    expect(within(dialog).getByText(word('iam.sessions.problem.reasonShort'))).toBeTruthy();
    expect(commandsOf(h, 'revokeMySession')).toHaveLength(0);
    type('revoke-reason', 'Phiên này không phải của tôi.');
    h.world.sessions = [session(2, { current: true })];
    fireEvent.click(within(dialog).getByRole('button', { name: word('iam.sessions.revoke.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'revokeMySession')).toEqual([{ path: { sessionId: uuid('0010', 1) }, body: { reason: 'Phiên này không phải của tôi.' }, attempt: expect.anything() }]);
    await waitFor(() => expect(rows('[data-session]')).toEqual([uuid('0010', 2)]));
  });

  it('AC-ST-IAM-006-3: removes a device, and says why when the server refuses', async () => {
    let refusal: unknown = problem('RESOURCE_NOT_FOUND', 404);
    const h = open(<SessionsScreen route={route} />, { sessions: [session(1, { current: true })], devices: [device(1)] }, { command: () => refusal });
    await screen.findByTestId('devices');
    fireEvent.click(document.querySelector('[data-action="revoke-device"]') as HTMLElement);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: word('iam.sessions.device.revoke.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('iam.self.error.notFound'));
    refusal = { resource_id: uuid('0020', 1), resource_version: 1 };
    h.world.devices = [device(1, { status: 'REVOKED', revoked_at: '2026-10-28T00:00:00.000000Z' })];
    fireEvent.click(within(dialog).getByRole('button', { name: word('iam.sessions.device.revoke.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'revokeMyDevice').map((call) => call.path)).toEqual([{ deviceId: uuid('0020', 1) }, { deviceId: uuid('0020', 1) }]);
    await waitFor(() => expect(within(document.querySelector(`[data-device="${uuid('0020', 1)}"]`) as HTMLElement).getByTestId('device-state').textContent).toBe(word('iam.sessions.device.revoked')));
  });

  it('says so when there is nothing to show, offers no button while read-only, and reads again after a failure', async () => {
    open(<SessionsScreen route={route} />);
    expect((await screen.findByTestId('no-sessions')).textContent).toBe(word('iam.sessions.sessions.none'));
    expect(screen.getByTestId('no-devices').textContent).toBe(word('iam.sessions.devices.none'));
    cleanup();
    open(<SessionsScreen route={route} />, { sessions: [session(2, { current: true }), session(1)], devices: [device(1)] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('sessions');
    expect(document.querySelectorAll('[data-action]')).toHaveLength(0);
    cleanup();
    const failing = client({ failing: new Set(['listMyDevices']), sessions: [session(1, { current: true })] });
    mountInSession(<SessionsScreen route={route} />, failing, { permissions: PERMISSIONS }, '/iam');
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    failing.world.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('sessions');
  });
});

describe('the model of the self-service screens', () => {
  it('reads rows and leaves out the ones that are not', () => {
    expect(toProfile(profile())).toMatchObject({ displayName: 'Nguyen Van An', phoneMasked: '*********567', version: 4 });
    expect(toProfile(profile({ phone_masked: null }))?.phoneMasked).toBeNull();
    expect(toSession(session(1, { current: true, assurance_level: 'aal2', device: { id: 'd', platform: 'ios' } }))).toMatchObject({ current: true, assurance: 'aal2', devicePlatform: 'ios' });
    expect(toDevice(device(1, { status: 'REVOKED' }))?.revoked).toBe(true);
    for (const broken of [null, {}, 'x', [], profile({ version: '4' }), profile({ id: 7 })]) expect(toProfile(broken)).toBeUndefined();
    for (const broken of [null, {}, session(1, { current: 'yes' }), session(1, { id: 7 })]) expect(toSession(broken)).toBeUndefined();
    for (const broken of [null, {}, device(1, { platform: 7 })]) expect(toDevice(broken)).toBeUndefined();
  });

  it('sends only what changed, the phone only when a new one is typed, and finds what a conflict is about', () => {
    const original = toProfile(profile()) as NonNullable<ReturnType<typeof toProfile>>;
    const form = formOf(original);
    expect(profileBody(form, original)).toEqual({});
    expect(profileBody({ ...form, displayName: ' Tên mới ', locale: 'en-US', timeZone: 'UTC', phone: ' +84912345678 ' }, original)).toEqual({ display_name: 'Tên mới', locale: 'en-US', time_zone: 'UTC', phone_e164: '+84912345678' });
    expect(validateProfile({ ...form, displayName: 'x'.repeat(121) })).toEqual({ displayName: 'tooLong' });
    const current = toProfile(profile({ display_name: 'Đã đổi', locale: 'en-US', version: 5 })) as NonNullable<ReturnType<typeof toProfile>>;
    // Entered a name that differs from both: a conflict to show. Entered what the profile already says: none. Untouched: none.
    expect(differences({ ...form, displayName: 'Tôi nhập', locale: 'en-US' }, original, current)).toEqual([{ field: 'displayName', entered: 'Tôi nhập', current: 'Đã đổi' }]);
    expect(differences(form, original, current)).toEqual([]);
  });

  it('names each refusal of the server, and has words for every one', () => {
    const cases: Array<[unknown, ReturnType<typeof describeProblem>]> = [
      [problem('VERSION_CONFLICT'), 'versionConflict'],
      [problem('SESSION_CURRENT', 422), 'currentSession'],
      [problem('VALIDATION_FAILED', 422), 'validation'],
      [problem('INVALID_REQUEST', 400), 'validation'],
      [problem('RESOURCE_NOT_FOUND', 404), 'notFound'],
      [problem('SCOPE_DENIED', 403), 'denied'],
      [problem('PERMISSION_DENIED', 403), 'denied'],
      [problem('OTHER', 500), 'general'],
      [new Error('network'), 'general'],
    ];
    for (const [error, expected] of cases) expect(describeProblem(error)).toBe(expected);
    const t = ((key: string) => word(key)) as Parameters<typeof labels.problemMessage>[0];
    for (const name of ['versionConflict', 'currentSession', 'validation', 'notFound', 'denied', 'general'] as const) expect(labels.problemMessage(t, name).startsWith('iam.')).toBe(false);
    for (const name of ['required', 'tooShort', 'tooLong', 'invalidPhone'] as const) expect(labels.formProblemMessage(t, name).startsWith('iam.')).toBe(false);
    expect([labels.localeLabel(t, 'vi-VN'), labels.localeLabel(t, 'en-US'), labels.localeLabel(t, 'fr-FR')]).toEqual([word('iam.profile.locale.vi'), word('iam.profile.locale.en'), 'fr-FR']);
    expect(['ios', 'android', 'web', null, 'tv'].map((platform) => labels.platformLabel(t, platform))).toEqual([word('iam.sessions.platform.ios'), word('iam.sessions.platform.android'), word('iam.sessions.platform.web'), word('iam.sessions.platform.none'), 'tv']);
    expect(['displayName', 'locale', 'timeZone'].map((field) => labels.fieldLabel(t, field as 'displayName'))).toEqual([word('iam.profile.field.name'), word('iam.profile.field.locale'), word('iam.profile.field.timeZone')]);
    expect([labels.assuranceLabel(t, 'aal1'), labels.assuranceLabel(t, 'aal2')]).toEqual([word('iam.sessions.assurance.aal1'), word('iam.sessions.assurance.aal2')]);
  });
});
