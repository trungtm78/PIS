import { onlineManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TENANT } from '../../ctr/test-support';
import { client } from '../diary/test-support';
import { FAILURES } from '../../prj/closeout/test-support';
import { slowDevice } from './locate-support';
import {
  actions,
  copy,
  diary,
  diaryId,
  fill,
  fillDiary,
  keep,
  lost,
  open,
  problem,
  sent,
  setOnline,
  signal,
  stored,
  type,
  word,
  world,
  CONTRACT,
  ENGINEER,
  OTHER_KEY,
  OWN_KEY,
  PENDING_ENTRY,
  ROUTE_WITHOUT_REQ,
  heldLocks,
  openChanging,
} from './test-support';

beforeEach(() => globalThis.localStorage.clear());
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.localStorage.clear();
  // The query client of the application follows the browser: a test that went offline must not leave the next one paused.
  onlineManager.setOnline(true);
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const queued = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="queue-items"] li'));
const conflicted = (overrides: Record<string, unknown> = {}) => diary(1, { version: 3, conflicts: [copy(1)], actions: actions({ revise: true, resolveConflict: true }), ...overrides });

describe('OfflineDiaryScreen (QMS-09): the site diary written with no connection', () => {
  it('UI-QMS-09: shows the form of a new diary, the empty queue, the state of the connection and the diaries on the server', async () => {
    open(world({ diaries: [diary(1)] }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('qms.offline.page.title'));
    expect(screen.getByTestId('connection').textContent).toBe(word('qms.offline.connection.online'));
    expect(screen.getByTestId('queue-empty').textContent).toBe(word('qms.offline.queue.empty'));
    expect((screen.getByRole('button', { name: word('qms.offline.queue.send') }) as HTMLButtonElement).disabled).toBe(true);
    const list = await screen.findByTestId('server-diaries');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByRole('button', { name: word('qms.offline.server.sign') })).toBeTruthy();
    expect(within(list).getByRole('button', { name: word('qms.offline.server.write') })).toBeTruthy();
  });

  it('UAT-AC358: keeps the diary on the device under its own operation id and, with a connection, sends it once', async () => {
    const h = open();
    await fillDiary();
    keep();
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    const [body] = sent(h, 'saveSiteDiaryDraft');
    expect(body).toMatchObject({ contract_id: CONTRACT, record_date: '2026-10-24', content: { summary: 'Đổ bê tông móng' } });
    expect(body?.client_operation_id).toMatch(UUID);
    expect(body).not.toHaveProperty('base_server_version');
    await waitFor(() => expect(screen.getByTestId('queue-empty')).toBeTruthy());
    expect(screen.getByTestId('outcome').textContent).toBe(fill(word('qms.offline.outcome.text'), { sent: 1, conflicts: 0, rejected: 0 }));
    expect(stored()).toEqual([]);
    // The form is ready for the next diary.
    expect((screen.getByLabelText(word('qms.diary.field.summary')) as HTMLTextAreaElement).value).toBe('');
  });

  it('holds the diary on the device while there is no connection and sends it when the device is back', async () => {
    setOnline(false);
    const h = open();
    await fillDiary();
    keep();
    await waitFor(() => expect(queued()).toHaveLength(1));
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getByTestId('connection').textContent).toBe(word('qms.offline.connection.offline'));
    expect((screen.getByRole('button', { name: word('qms.offline.queue.send') }) as HTMLButtonElement).disabled).toBe(true);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ recordDate: '2026-10-24', state: 'PENDING', contractCode: 'HD-A-002' });
    signal(true);
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    await waitFor(() => expect(stored()).toEqual([]));
    expect(screen.getByTestId('connection').textContent).toBe(word('qms.offline.connection.online'));
    signal(false);
    await waitFor(() => expect(screen.getByTestId('connection').textContent).toBe(word('qms.offline.connection.offline')));
  });

  it('UAT-AC358: delivered again after a lost answer, the diary goes under the same operation id', async () => {
    const h = open(world(), { command: () => lost() });
    await fillDiary();
    keep();
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole('button', { name: word('qms.offline.queue.send') }) as HTMLButtonElement).disabled).toBe(false));
    expect(queued()).toHaveLength(1);
    expect(queued()[0]?.getAttribute('data-state')).toBe('PENDING');
    h.command.mockImplementation(() => Promise.resolve({}));
    fireEvent.click(screen.getByRole('button', { name: word('qms.offline.queue.send') }));
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(2));
    const [first, second] = sent(h, 'saveSiteDiaryDraft');
    expect(second?.client_operation_id).toBe(first?.client_operation_id);
    expect((h.command.mock.calls[1]?.[1] as { attempt: unknown }).attempt).toBe((h.command.mock.calls[0]?.[1] as { attempt: unknown }).attempt);
    await waitFor(() => expect(stored()).toEqual([]));
  });

  it('UAT-AC62: a diary the server kept as a conflict leaves the queue, is shown beside the diary of the day, and a person settles it', async () => {
    const state = world({ diaries: [diary(1, { version: 3 })] });
    const h = open(state, {
      command: (operation) => {
        if (operation === 'saveSiteDiaryDraft') {
          state.diaries = [conflicted()];
          return problem(409, 'DIARY_SYNC_CONFLICT');
        }
        return {};
      },
    });
    const list = await screen.findByTestId('server-diaries');
    fireEvent.click(within(list).getByRole('button', { name: word('qms.offline.server.write') }));
    expect(screen.getByRole('heading', { name: word('qms.offline.compose.editTitle') })).toBeTruthy();
    expect((screen.getByLabelText(word('qms.diary.field.contract')) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(word('qms.diary.field.date')) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(word('qms.diary.field.summary')) as HTMLTextAreaElement).value).toBe('Đổ bê tông móng đợt 1');
    type(word('qms.diary.field.summary'), 'Đổ bê tông móng đợt 1, thêm ca đêm');
    keep();
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    expect(sent(h, 'saveSiteDiaryDraft')[0]).toMatchObject({ base_server_version: 3, record_date: '2026-10-21', content: { summary: 'Đổ bê tông móng đợt 1, thêm ca đêm', weather_code: 'SUNNY' } });
    await waitFor(() => expect(screen.getByTestId('outcome').textContent).toBe(fill(word('qms.offline.outcome.text'), { sent: 0, conflicts: 1, rejected: 0 })));
    expect(stored()).toEqual([]);
    const panel = await screen.findByTestId('conflicts');
    expect(within(panel).getByTestId('conflicts-waiting')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: word('qms.offline.server.resolve') }));
    fireEvent.change(screen.getByLabelText(word('qms.diary.resolve.resolution')), { target: { value: 'KEEP_PRIMARY' } });
    fireEvent.change(screen.getByLabelText(word('qms.diary.resolve.note')), { target: { value: 'Giữ bản chính' } });
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.resolve.submit') }));
    await waitFor(() => expect(sent(h, 'resolveDiaryConflict')).toHaveLength(1));
    expect(sent(h, 'resolveDiaryConflict')[0]).toEqual({ conflict_diary_id: copy(1).id, resolution: 'KEEP_PRIMARY', note: 'Giữ bản chính' });
    expect(h.command.mock.calls.at(-1)?.[1]).toMatchObject({ ifMatchVersion: 3, path: { id: diaryId(1) } });
  });

  it('keeps a diary the server refused, marked and with the reason, until the person removes it', async () => {
    const h = open(world(), { command: () => problem(409, 'DIARY_STATE_INVALID') });
    await fillDiary();
    keep();
    await waitFor(() => expect(screen.getByTestId('reason').textContent).toBe(word('qms.diary.error.diaryState')));
    expect(queued()[0]?.getAttribute('data-state')).toBe('REJECTED');
    expect(stored()[0]).toMatchObject({ state: 'REJECTED', reason: 'diaryState' });
    expect(screen.getByTestId('outcome').textContent).toBe(fill(word('qms.offline.outcome.text'), { sent: 0, conflicts: 0, rejected: 1 }));
    expect((screen.getByRole('button', { name: word('qms.offline.queue.send') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: word('qms.offline.queue.remove') }));
    await screen.findByTestId('queue-empty');
    expect(stored()).toEqual([]);
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('pauses the whole send when the session has run out, leaves every diary pending, and sends them once the session is made again', async () => {
    const second = { ...PENDING_ENTRY, clientOperationId: '00000000-0000-4000-8000-0000000000e2', recordDate: '2026-10-21' };
    globalThis.localStorage.setItem(OWN_KEY, JSON.stringify([PENDING_ENTRY, second]));
    let signedIn = false;
    const { h, change } = openChanging(world(), { permissions: ENGINEER, mode: 'FULL', status: 'active', tenantToken: { expiresAt: 1 } }, () => (signedIn ? {} : problem(401, 'SESSION_EXPIRED')));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: word('qms.offline.queue.send') }) as HTMLButtonElement).disabled).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual([PENDING_ENTRY, second]);
    expect(queued().map((item) => item.getAttribute('data-state'))).toEqual(['PENDING', 'PENDING']);
    expect(Object.keys(globalThis.localStorage).filter((key) => key.includes('.claim.'))).toEqual([]);
    change({ permissions: ENGINEER, mode: 'FULL', status: 'signedOut' });
    signedIn = true;
    change({ permissions: ENGINEER, mode: 'FULL', status: 'active', tenantToken: { expiresAt: 2 } });
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(3));
    await waitFor(() => expect(stored()).toEqual([]));
  });

  it('marks only the diary the server refused and goes on with the next one', async () => {
    const second = { ...PENDING_ENTRY, clientOperationId: '00000000-0000-4000-8000-0000000000e2', recordDate: '2026-10-21' };
    globalThis.localStorage.setItem(OWN_KEY, JSON.stringify([PENDING_ENTRY, second]));
    const h = open(world(), {
      command: (_operation, input) => ((input as { body: { client_operation_id: string } }).body.client_operation_id === PENDING_ENTRY.clientOperationId ? problem(409, 'DIARY_STATE_INVALID') : {}),
    });
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(2));
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]).toMatchObject({ clientOperationId: PENDING_ENTRY.clientOperationId, state: 'REJECTED', reason: 'diaryState' });
  });

  it('sends a diary queued while another is being sent, with no other trigger', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const h = open(world(), {
      command: () => {
        calls += 1;
        return calls === 1 ? new Promise((resolve) => (release = () => resolve({}))) : {};
      },
    });
    await fillDiary('Nhật ký A', '2026-10-23');
    keep();
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    await fillDiary('Nhật ký B', '2026-10-24');
    keep();
    await waitFor(() => expect(queued()).toHaveLength(2));
    expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1);
    await act(async () => release());
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(2));
    expect(sent(h, 'saveSiteDiaryDraft').map((body) => body.record_date)).toEqual(['2026-10-23', '2026-10-24']);
    await waitFor(() => expect(stored()).toEqual([]));
  });

  describe('a send in flight when the scope of the screen ends', () => {
    const second = { ...PENDING_ENTRY, clientOperationId: '00000000-0000-4000-8000-0000000000e2', recordDate: '2026-10-21' };
    const start = async () => {
      globalThis.localStorage.setItem(OWN_KEY, JSON.stringify([PENDING_ENTRY, second]));
      let answer: () => void = () => undefined;
      const view = openChanging(world(), { permissions: ENGINEER, mode: 'FULL' }, () => new Promise((resolve) => (answer = () => resolve({}))));
      await waitFor(() => expect(sent(view.h, 'saveSiteDiaryDraft')).toHaveLength(1));
      return { ...view, answer: () => act(async () => answer()) };
    };

    it('does not send the rest nor write the queue again once the screen is closed', async () => {
      const view = await start();
      view.unmount();
      await view.answer();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent(view.h, 'saveSiteDiaryDraft')).toHaveLength(1);
      expect(stored()).toEqual([PENDING_ENTRY, second]);
    });

    it('does not send the rest under the session of another tenant, nor bring back the queue that was wiped', async () => {
      const view = await start();
      view.change({ permissions: ENGINEER, mode: 'FULL', tenant: { ...TENANT, id: '00000000-0000-4000-8000-0000000000bb' } });
      await waitFor(() => expect(globalThis.localStorage.getItem(OWN_KEY)).toBeNull());
      await view.answer();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent(view.h, 'saveSiteDiaryDraft')).toHaveLength(1);
      expect(globalThis.localStorage.getItem(OWN_KEY)).toBeNull();
    });
  });

  it('stops the send at a lost answer and leaves the rest for the next one, in the order they were written', async () => {
    setOnline(false);
    const h = open(world(), { command: () => lost() });
    await fillDiary('Ngày hai mốt', '2026-10-21');
    keep();
    await fillDiary('Ngày hai hai', '2026-10-22');
    keep();
    await waitFor(() => expect(queued()).toHaveLength(2));
    signal(true);
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('outcome')).toBeTruthy());
    expect(queued()).toHaveLength(2);
    expect(sent(h, 'saveSiteDiaryDraft')[0]).toMatchObject({ record_date: '2026-10-21' });
  });

  it('UAT-AC367: keeps a place only with the consent, and takes it away when the consent is taken back', async () => {
    const h = open();
    await fillDiary('Có vị trí');
    const lat = screen.getByLabelText(word('qms.offline.place.lat')) as HTMLInputElement;
    expect(lat.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(word('qms.offline.place.consent')));
    type(word('qms.offline.place.lat'), '10.8');
    type(word('qms.offline.place.lng'), '106.7');
    fireEvent.click(screen.getByLabelText(word('qms.offline.place.consent')));
    expect(lat.value).toBe('');
    expect(lat.disabled).toBe(true);
    keep();
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    expect(sent(h, 'saveSiteDiaryDraft')[0]?.content).toEqual({ summary: 'Có vị trí' });
    await fillDiary('Có vị trí', '2026-10-23');
    fireEvent.click(screen.getByLabelText(word('qms.offline.place.consent')));
    type(word('qms.offline.place.lat'), '10.8');
    type(word('qms.offline.place.lng'), '106.7');
    type(word('qms.offline.place.accuracy'), '12');
    keep();
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(2));
    expect(sent(h, 'saveSiteDiaryDraft')[1]?.content).toEqual({ summary: 'Có vị trí', geo_consent: true, location: { lat: 10.8, lng: 106.7, accuracy_m: 12 } });
  });

  it('fills the place from the device only after the consent, and says when the device cannot give it', async () => {
    const getCurrentPosition = vi.fn((success: (position: unknown) => void) => success({ coords: { latitude: 10.8123456, longitude: 106.7123456, accuracy: 12.345 } }));
    vi.stubGlobal('navigator', { onLine: true, geolocation: { getCurrentPosition } });
    open();
    await fillDiary();
    const locate = screen.getByRole('button', { name: word('qms.offline.place.locate') }) as HTMLButtonElement;
    expect(locate.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(word('qms.offline.place.consent')));
    fireEvent.click(locate);
    await waitFor(() => expect((screen.getByLabelText(word('qms.offline.place.lat')) as HTMLInputElement).value).toBe('10.812346'));
    expect((screen.getByLabelText(word('qms.offline.place.accuracy')) as HTMLInputElement).value).toBe('12.35');
    getCurrentPosition.mockImplementation((_success: unknown, failure?: () => void) => failure?.());
    fireEvent.click(locate);
    expect((await screen.findByTestId('locate-failed')).textContent).toBe(word('qms.offline.place.unavailable'));
    vi.stubGlobal('navigator', { onLine: true });
    fireEvent.click(locate);
    expect(screen.getByTestId('locate-failed')).toBeTruthy();
  });

  it('UAT-AC367: drops a position that arrives after the consent was taken back, and queues the diary with no place', async () => {
    const device = slowDevice({ onLine: false });
    open();
    await fillDiary('Rút lại');
    const consent = screen.getByLabelText(word('qms.offline.place.consent')) as HTMLInputElement;
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: word('qms.offline.place.locate') }));
    fireEvent.click(consent);
    device.arrive();
    expect(consent.checked).toBe(false);
    expect((screen.getByLabelText(word('qms.offline.place.lat')) as HTMLInputElement).value).toBe('');
    keep();
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]?.content).toEqual({ summary: 'Rút lại' });
  });

  it('the failure of a request in flight when the consent was taken back does not show, and a new request still fills the place', async () => {
    const device = slowDevice({ onLine: true });
    open();
    await fillDiary();
    const consent = screen.getByLabelText(word('qms.offline.place.consent'));
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: word('qms.offline.place.locate') }));
    fireEvent.click(consent);
    fireEvent.click(consent);
    device.fail();
    expect(screen.queryByTestId('locate-failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: word('qms.offline.place.locate') }));
    device.arrive();
    expect((screen.getByLabelText(word('qms.offline.place.lat')) as HTMLInputElement).value).toBe('10.812346');
  });

  it('puts a position that arrives while the consent holds into the place and keeps what was typed meanwhile', async () => {
    const device = slowDevice({ onLine: false });
    open();
    await fillDiary('Trước');
    fireEvent.click(screen.getByLabelText(word('qms.offline.place.consent')));
    fireEvent.click(screen.getByRole('button', { name: word('qms.offline.place.locate') }));
    type(word('qms.diary.field.summary'), 'Sau khi bấm');
    device.arrive();
    expect((screen.getByLabelText(word('qms.offline.place.lat')) as HTMLInputElement).value).toBe('10.812346');
    expect((screen.getByLabelText(word('qms.diary.field.summary')) as HTMLTextAreaElement).value).toBe('Sau khi bấm');
    expect((screen.getByLabelText(word('qms.offline.place.consent')) as HTMLInputElement).checked).toBe(true);
    keep();
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]?.content).toEqual({ summary: 'Sau khi bấm', geo_consent: true, location: { lat: 10.812346, lng: 106.712346, accuracy_m: 12.35 } });
  });

  it.each([
    ['the session is read-only', ENGINEER, 'READ_ONLY' as const],
    ['the session lacks the permission to write diaries', ['site_diary.read', 'contract.read'], 'FULL' as const],
  ])('keeps a diary left on the device unsent and pending while %s, and sends it when writing is allowed again', async (_name, permissions, mode) => {
    globalThis.localStorage.setItem(OWN_KEY, JSON.stringify([PENDING_ENTRY]));
    const { h, change } = openChanging(world(), { permissions, mode });
    expect(await screen.findByTestId('cannot-write')).toBeTruthy();
    const send = screen.getByRole('button', { name: word('qms.offline.queue.send') }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    signal(false);
    signal(true);
    expect(h.command).not.toHaveBeenCalled();
    expect(stored()).toEqual([PENDING_ENTRY]);
    expect(queued()[0]?.getAttribute('data-state')).toBe('PENDING');
    change({ permissions: ENGINEER, mode: 'FULL' });
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    await waitFor(() => expect(stored()).toEqual([]));
  });

  it('names what is wrong with the diary and the place and keeps nothing', async () => {
    const h = open();
    await screen.findByRole('option', { name: /HD-A-002/ });
    keep();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(stored()).toEqual([]);
    expect(h.command).not.toHaveBeenCalled();
    await fillDiary();
    fireEvent.click(screen.getByLabelText(word('qms.offline.place.consent')));
    type(word('qms.offline.place.lat'), '95');
    type(word('qms.offline.place.lng'), '');
    keep();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([word('qms.offline.place.invalidLatitude'), word('qms.offline.place.pairRequired')]));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('UAT-AC367: removes what the device kept for another tenant when the screen opens, and says how many diaries went', async () => {
    const entry = {
      clientOperationId: '00000000-0000-4000-8000-0000000000e1',
      contractId: '00000000-0000-4000-8000-000000000002',
      contractCode: 'HD-X',
      recordDate: '2026-10-20',
      content: { summary: 'x' },
      baseServerVersion: null,
      queuedAt: '2026-10-20T01:00:00.000Z',
      state: 'PENDING',
      reason: null,
    };
    globalThis.localStorage.setItem(OTHER_KEY, JSON.stringify([entry, { ...entry, clientOperationId: '00000000-0000-4000-8000-0000000000e2' }]));
    globalThis.localStorage.setItem(OWN_KEY, JSON.stringify([{ ...entry, clientOperationId: '00000000-0000-4000-8000-0000000000e3', contractCode: 'HD-A-002' }]));
    setOnline(false);
    open();
    expect((await screen.findByTestId('wiped')).textContent).toBe(fill(word('qms.offline.wiped.notice'), { count: 2 }));
    expect(globalThis.localStorage.getItem(OTHER_KEY)).toBeNull();
    expect(queued()).toHaveLength(1);
    expect(queued()[0]?.textContent).toContain('HD-A-002');
  });

  it('sends a diary left on the device when the screen opens with a connection', async () => {
    const entry = {
      clientOperationId: '00000000-0000-4000-8000-0000000000e1',
      contractId: '00000000-0000-4000-8000-000000000002',
      contractCode: 'HD-A-002',
      recordDate: '2026-10-20',
      content: { summary: 'x' },
      baseServerVersion: 4,
      queuedAt: '2026-10-20T01:00:00.000Z',
      state: 'PENDING',
      reason: null,
    };
    globalThis.localStorage.setItem(OWN_KEY, JSON.stringify([entry]));
    const h = open();
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    expect(sent(h, 'saveSiteDiaryDraft')[0]).toEqual({
      contract_id: entry.contractId,
      record_date: '2026-10-20',
      client_operation_id: entry.clientOperationId,
      content: { summary: 'x' },
      base_server_version: 4,
    });
  });

  describe('the contracts a diary is written for, with no connection', () => {
    const CONTRACTS_KEY = `${OWN_KEY}.contracts`;
    const down = () => world({ failing: new Set(['get_resources_contract']) });

    it('keeps the id, code and name of the contracts read online, and offers them when they cannot be read and the cache of the visit is empty, so that a diary can still be queued', async () => {
      open();
      await screen.findByRole('option', { name: /HD-A-002/ });
      await waitFor(() => expect(JSON.parse(globalThis.localStorage.getItem(CONTRACTS_KEY) ?? 'null')).toEqual(expect.arrayContaining([{ id: CONTRACT, code: 'HD-A-002', title: null }])));
      for (const entry of JSON.parse(globalThis.localStorage.getItem(CONTRACTS_KEY) as string) as Array<Record<string, unknown>>) expect(Object.keys(entry).sort()).toEqual(['code', 'id', 'title']);
      cleanup();
      setOnline(false);
      const h = open(down());
      await fillDiary('Viết khi không có kết nối');
      keep();
      await waitFor(() => expect(queued()).toHaveLength(1));
      expect(stored()[0]).toMatchObject({ contractId: CONTRACT, contractCode: 'HD-A-002' });
      expect(h.command).not.toHaveBeenCalled();
    });

    it('offers nothing that was kept for another tenant or for another membership, and wipes it', async () => {
      globalThis.localStorage.setItem(`${OTHER_KEY}.contracts`, JSON.stringify([{ id: 'x1', code: 'HD-OTHER-TENANT', title: null }]));
      globalThis.localStorage.setItem(`${OWN_KEY.replace(/.[^.]+$/, '.00000000-0000-4000-8000-0000000000cc')}.contracts`, JSON.stringify([{ id: 'x2', code: 'HD-OTHER-MEMBER', title: null }]));
      globalThis.localStorage.setItem(CONTRACTS_KEY, JSON.stringify([{ id: CONTRACT, code: 'HD-A-002', title: null }]));
      setOnline(false);
      open(down());
      await screen.findByRole('option', { name: /HD-A-002/ });
      expect(screen.queryByRole('option', { name: /HD-OTHER/ })).toBeNull();
      await waitFor(() => expect(globalThis.localStorage.getItem(`${OTHER_KEY}.contracts`)).toBeNull());
      expect(Object.keys(globalThis.localStorage).filter((key) => key.endsWith('.contracts'))).toEqual([CONTRACTS_KEY]);
    });

    it('offers no contract when the caller may not read contracts, whatever the device kept', async () => {
      globalThis.localStorage.setItem(CONTRACTS_KEY, JSON.stringify([{ id: CONTRACT, code: 'HD-A-002', title: null }]));
      setOnline(false);
      open(down(), { permissions: ['site_diary.read', 'diary.write'] });
      await screen.findByLabelText(word('qms.diary.field.contract'));
      expect(screen.queryByRole('option', { name: /HD-A-002/ })).toBeNull();
    });
  });

  describe('what the person does while the device takes the diary in', () => {
    it('keeps what was edited in the form meanwhile, and queues the diary that was sent once', async () => {
      const locks = heldLocks();
      setOnline(false);
      const h = open(world({ diaries: [diary(1)] }));
      await fillDiary('Bản đã gửi');
      keep();
      type(word('qms.diary.field.summary'), 'Bản đang sửa tiếp');
      await locks.grant();
      await waitFor(() => expect(queued()).toHaveLength(1));
      expect(stored()).toHaveLength(1);
      expect(stored()[0]?.content).toEqual({ summary: 'Bản đã gửi' });
      expect((screen.getByLabelText(word('qms.diary.field.summary')) as HTMLTextAreaElement).value).toBe('Bản đang sửa tiếp');
      expect((screen.getByLabelText(word('qms.diary.field.contract')) as HTMLSelectElement).value).toBe(CONTRACT);
      expect(screen.queryByTestId('not-kept')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('keeps the diary of the server chosen to write over meanwhile, and queues the diary that was sent once', async () => {
      const locks = heldLocks();
      setOnline(false);
      open(world({ diaries: [diary(1)] }));
      await fillDiary('Bản đã gửi');
      keep();
      fireEvent.click(await screen.findByRole('button', { name: word('qms.offline.server.write') }));
      await locks.grant();
      await waitFor(() => expect(queued()).toHaveLength(1));
      expect(stored()).toHaveLength(1);
      expect(stored()[0]?.content).toEqual({ summary: 'Bản đã gửi' });
      expect(screen.getByRole('heading', { name: word('qms.offline.compose.editTitle') })).toBeTruthy();
    });

    it('starts the form over when nothing was changed meanwhile', async () => {
      const locks = heldLocks();
      setOnline(false);
      open();
      await fillDiary('Bản đã gửi');
      keep();
      await locks.grant();
      await waitFor(() => expect(queued()).toHaveLength(1));
      expect((screen.getByLabelText(word('qms.diary.field.summary')) as HTMLTextAreaElement).value).toBe('');
    });
  });

  describe('more diaries on the server than one page', () => {
    // The server answers two diaries to a page: three drafts and three diaries with a conflict (4 to 6) make two pages of each.
    const drafts = [diary(1), diary(2), diary(3)];
    const withConflict = [4, 5, 6].map((n) => diary(n, { status: 'CONTRACTOR_SIGNED', conflicts: [copy(n)], actions: actions({ resolveConflict: true }) }));
    const second = () => world({ diaries: [...drafts, ...withConflict], page: 2 });
    const rowOf = (n: number): HTMLElement | null => document.querySelector(`[data-diary="${diaryId(n)}"]`);

    it('reaches the second page of the drafts and of the diaries with a conflict, and signs, writes over and settles a diary from it', async () => {
      open(second());
      await screen.findByTestId('server-diaries');
      expect(rowOf(3)).toBeNull();
      expect(rowOf(6)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: word('qms.offline.server.moreDrafts.action') }));
      await waitFor(() => expect(rowOf(3)).not.toBeNull());
      fireEvent.click(within(rowOf(3) as HTMLElement).getByRole('button', { name: word('qms.offline.server.sign') }));
      expect(screen.getByRole('dialog')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: word('qms.diary.dialog.cancel') }));
      fireEvent.click(within(rowOf(3) as HTMLElement).getByRole('button', { name: word('qms.offline.server.write') }));
      expect(screen.getByRole('heading', { name: word('qms.offline.compose.editTitle') })).toBeTruthy();
      expect((screen.getByLabelText(word('qms.diary.field.summary')) as HTMLTextAreaElement).value).toBe('Đổ bê tông móng đợt 3');
      expect(screen.queryByRole('button', { name: word('qms.offline.server.moreDrafts.action') })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: word('qms.offline.server.moreConflicts.action') }));
      await waitFor(() => expect(rowOf(6)).not.toBeNull());
      fireEvent.click(within(rowOf(6) as HTMLElement).getByRole('button', { name: word('qms.offline.server.resolve') }));
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.queryByRole('button', { name: word('qms.offline.server.moreConflicts.action') })).toBeNull();
    });

    it('keeps the rows of the first page and offers to try again when the second page cannot be read', async () => {
      const state = second();
      let failing = true;
      const base = client(state).read.getMockImplementation() as (operation: string, input?: unknown) => Promise<unknown>;
      open(state, {
        reads: (operation, input) =>
          (input as { query?: { cursor?: string } } | undefined)?.query?.cursor !== undefined && failing ? Promise.reject(problem(500, 'INTERNAL_ERROR')) : base(operation, input),
      });
      await screen.findByTestId('server-diaries');
      fireEvent.click(screen.getByRole('button', { name: word('qms.offline.server.moreDrafts.action') }));
      const alert = await screen.findByTestId('more-failed-drafts');
      expect(alert.textContent).toContain(word('qms.offline.server.moreFailed.notice'));
      expect(screen.queryByText(word('states.error.title'))).toBeNull();
      expect(rowOf(1)).not.toBeNull();
      expect(rowOf(4)).not.toBeNull();
      expect(screen.queryByRole('button', { name: word('qms.offline.server.moreDrafts.action') })).toBeNull();
      failing = false;
      fireEvent.click(within(alert).getByRole('button', { name: word('qms.offline.server.moreRetry.action') }));
      await waitFor(() => expect(rowOf(3)).not.toBeNull());
      expect(screen.queryByTestId('more-failed-drafts')).toBeNull();
      failing = true;
      fireEvent.click(screen.getByRole('button', { name: word('qms.offline.server.moreConflicts.action') }));
      expect(await screen.findByTestId('more-failed-conflicts')).toBeTruthy();
      expect(rowOf(4)).not.toBeNull();
    });

    it('does not offer more pages with no connection', async () => {
      open(second());
      await screen.findByTestId('server-diaries');
      signal(false);
      await waitFor(() => expect((screen.getByRole('button', { name: word('qms.offline.server.moreDrafts.action') }) as HTMLButtonElement).disabled).toBe(true));
    });
  });

  it('names the screen in the footer even when its route names no requirement', () => {
    open(world(), { route: ROUTE_WITHOUT_REQ });
    expect(document.querySelector('.prototype-note')?.textContent).toBe(fill(word('qms.offline.footer.reference'), { id: 'QMS-09', req: '' }));
  });

  it('keeps the diary in the form and says so, and queues nothing, over a device that has no storage', async () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    setOnline(false);
    open();
    await fillDiary('Còn trong biểu mẫu');
    keep();
    expect((await screen.findByTestId('not-kept')).textContent).toBe(word('qms.offline.compose.notKept'));
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
    expect((screen.getByLabelText(word('qms.diary.field.summary')) as HTMLTextAreaElement).value).toBe('Còn trong biểu mẫu');
  });

  it('keeps the diary in the form, says so and claims no queue when the storage is full, and queues it once the device can keep it', async () => {
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const h = open();
    await fillDiary('Chưa lưu được');
    keep();
    expect((await screen.findByTestId('not-kept')).textContent).toBe(word('qms.offline.compose.notKept'));
    expect((screen.getByLabelText(word('qms.diary.field.summary')) as HTMLTextAreaElement).value).toBe('Chưa lưu được');
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
    expect(stored()).toEqual([]);
    expect(h.command).not.toHaveBeenCalled();
    full.mockRestore();
    keep();
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    expect(screen.queryByTestId('not-kept')).toBeNull();
    expect((screen.getByLabelText(word('qms.diary.field.summary')) as HTMLTextAreaElement).value).toBe('');
  });

  it('warns that a reload may bring back a diary that was sent when the device could not record the change', async () => {
    globalThis.localStorage.setItem(OWN_KEY, JSON.stringify([PENDING_ENTRY]));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const h = open();
    await waitFor(() => expect(sent(h, 'saveSiteDiaryDraft')).toHaveLength(1));
    expect((await screen.findByTestId('unsaved')).textContent).toBe(word('qms.offline.queue.unsaved'));
  });

  it('writes over a diary of the server without the right to read contracts, and drops the writing over when asked', async () => {
    setOnline(false);
    open(world({ diaries: [diary(1)] }), { permissions: ['site_diary.read', 'diary.write'] });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.offline.server.write') }));
    fireEvent.click(screen.getByRole('button', { name: word('qms.offline.compose.cancelEdit') }));
    expect(screen.queryByRole('button', { name: word('qms.offline.compose.cancelEdit') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: word('qms.offline.server.write') }));
    keep();
    await waitFor(() => expect(queued()).toHaveLength(1));
    expect(stored()[0]).toMatchObject({ contractCode: '', baseServerVersion: 2, recordDate: '2026-10-21' });
  });

  it('lets the contractor sign a draft that has no conflict, straight to the server', async () => {
    const h = open(world({ diaries: [diary(1)] }));
    fireEvent.click(await screen.findByRole('button', { name: word('qms.offline.server.sign') }));
    fireEvent.change(screen.getByLabelText(word('qms.diary.field.method')), { target: { value: 'IN_APP_OTP' } });
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.sign.submit') }));
    await waitFor(() => expect(sent(h, 'signSiteDiaryByContractor')).toHaveLength(1));
    expect(sent(h, 'signSiteDiaryByContractor')[0]).toMatchObject({ signature_method: 'IN_APP_OTP' });
    expect(stored()).toEqual([]);
  });

  it.each([
    ['signing', () => diary(1), 'qms.offline.server.sign', 'qms.diary.sign.submit', 'signSiteDiaryByContractor'],
    ['settling a conflict', () => conflicted(), 'qms.offline.server.resolve', 'qms.diary.resolve.submit', 'resolveDiaryConflict'],
  ])('closes the dialog of %s when the connection goes, offers it no more, and sends nothing then or when the connection returns', async (_name, line, action, submit, operation) => {
    const h = open(world({ diaries: [line()] }));
    fireEvent.click(await screen.findByRole('button', { name: word(action) }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    signal(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: word(action) })).toBeNull();
    expect(screen.queryByRole('button', { name: word(submit) })).toBeNull();
    signal(true);
    expect(await screen.findByRole('button', { name: word(action) })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent(h, operation)).toEqual([]);
  });

  it('offers the settling of a conflict and not the signature on a diary that has one, and offers neither without the right', async () => {
    open(world({ diaries: [conflicted()] }));
    const list = await screen.findByTestId('server-diaries');
    expect(within(list).getByRole('button', { name: word('qms.offline.server.resolve') })).toBeTruthy();
    expect(within(list).queryByRole('button', { name: word('qms.offline.server.sign') })).toBeNull();
    cleanup();
    open(world({ diaries: [diary(1)] }), { permissions: ['site_diary.read'] });
    const plain = await screen.findByTestId('server-diaries');
    expect(within(plain).queryByRole('button')).toBeNull();
  });

  it('shows the cannot-write notice without the right to write, and reads no contract', async () => {
    const h = open(world(), { permissions: ['site_diary.read', 'contract.read'] });
    expect((await screen.findByTestId('cannot-write')).textContent).toBe(word('qms.offline.denied.notice'));
    expect(screen.queryByTestId('compose')).toBeNull();
    expect((h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([name]) => name === 'get_resources_contract')).toBe(false);
  });

  it('is read-only for a suspended tenant', async () => {
    open(world({ diaries: [diary(1)] }), { mode: 'READ_ONLY' });
    expect((await screen.findByTestId('cannot-write')).textContent).toBe(word('qms.offline.frozen.notice'));
    const list = await screen.findByTestId('server-diaries');
    expect(within(list).queryByRole('button')).toBeNull();
  });

  it('reads no contract without the right to read contracts, and no diary without the right to read diaries', async () => {
    const h = open(world(), { permissions: ['diary.write'] });
    expect((await screen.findByText(word('states.denied.title'))).tagName).toBe('H1');
    expect(h.read).not.toHaveBeenCalled();
    expect((h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls).toEqual([]);
    expect(screen.getByTestId('compose')).toBeTruthy();
  });

  it('reads while the permissions are not known yet', async () => {
    const h = open(world({ diaries: [diary(1)] }), { permissions: undefined });
    await screen.findByTestId('server-diaries');
    expect(h.read).toHaveBeenCalled();
  });

  it('shows the empty state for the diaries on the server when there is none', async () => {
    open();
    expect((await screen.findByText(word('states.empty.title'))).tagName).toBe('H1');
  });

  it('shows the loading state while the diaries are on their way', async () => {
    open(world(), { reads: () => new Promise(() => undefined) });
    expect(await within(screen.getByTestId('server')).findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });

  it.each(FAILURES)('shows the %s state for the diaries on the server, and reads again on retry', async (_name, failure, title) => {
    const h = open(world(), { reads: () => Promise.reject(failure) });
    expect((await within(screen.getByTestId('server')).findByText(title)).tagName).toBe('H1');
    const before = h.read.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
  });
});
