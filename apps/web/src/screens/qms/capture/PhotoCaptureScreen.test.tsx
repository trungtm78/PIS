import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT } from '../../ctr/test-support';
import { FAILURES } from '../../prj/closeout/test-support';
import { slowDevice } from '../offline/locate-support';
import { CONTRACT, ENGINEER, KEY, PHOTO, choosePhoto, fileOf, fill, fillPhoto, hashOf, known, lost, open, problem, register, sent, type, word } from './test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const flags = (): string[] => Array.from(document.querySelectorAll('[data-testid="preflight-flags"] li')).map((item) => item.getAttribute('data-flag') as string);

/** Makes the read of one file wait until the test lets it go (or fail), while the others are read at once. */
function holdRead(held: File) {
  const original = FileReader.prototype.readAsArrayBuffer;
  let release: () => void = () => undefined;
  let fail: () => void = () => undefined;
  vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (this: FileReader, blob: Blob) {
    if (blob !== held) return original.call(this, blob);
    release = () => original.call(this, blob);
    fail = () => this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
    return undefined;
  });
  return { release: () => release(), fail: () => fail() };
}

describe('PhotoCaptureScreen (QMS-10): registering a site photo', () => {
  it('UI-QMS-10: shows the form of the photo, the place that needs the consent and the flags before the send', async () => {
    open();
    await choosePhoto();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('qms.capture.page.title'));
    expect(screen.getByTestId('preflight').textContent).toContain(word('qms.capture.preflight.note'));
    expect(flags()).toEqual(['PLACE_NOT_KEPT']);
    expect((screen.getByLabelText(word('qms.capture.place.lat')) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(word('qms.capture.field.file')) as HTMLInputElement).getAttribute('capture')).toBe('environment');
  });

  it('AC-ST-QMS-003-1: works out the hash of the file, sends the photo with its contract and project, and shows the flags the server raised as flags to review', async () => {
    const sha = await hashOf();
    const h = open({
      checks: {
        photo_id: PHOTO,
        checks: { time: 'SKEW', geofence: 'OUTSIDE', duplicate: 'UNIQUE', exif: 'STRIPPED', summary: 'WARN' },
        flags: ['TIME_SKEW', 'GEOFENCE_OUTSIDE', 'EXIF_STRIPPED'],
        received_at: '2026-10-25T03:00:00.000Z',
        taken_at_exif: null,
        geo_consent: false,
        place: null,
      },
    });
    await fillPhoto();
    expect(screen.getByTestId('file-facts').textContent).toBe(fill(word('qms.capture.file.facts'), { name: 'cau.jpg', size: 8, hash: sha.slice(0, 12) }));
    type(word('qms.capture.field.caption'), ' Cọc số 4 ');
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    const [body] = sent(h);
    expect(body).toEqual({ client_operation_id: body?.client_operation_id, project_id: PROJECT, contract_id: CONTRACT, object_key: KEY, file_sha256: sha, caption: 'Cọc số 4' });
    expect(body?.client_operation_id).toMatch(UUID);
    const registered = await screen.findByTestId('registered');
    expect(registered.getAttribute('data-photo')).toBe(PHOTO);
    const list = await within(registered).findByTestId('flags');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-flag')),
    ).toEqual(['TIME_SKEW', 'GEOFENCE_OUTSIDE', 'EXIF_STRIPPED']);
    expect(within(registered).getByText(word('qms.photo.summary.warn'))).toBeTruthy();
    expect(registered.textContent).toContain(word('qms.photo.note'));
    expect(document.body.textContent).not.toMatch(/authentic|genuine|forged|giả mạo|xác thực là thật/i);
    // The form is ready for the next photo.
    expect((screen.getByLabelText(word('qms.capture.field.key')) as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('file-facts')).toBeNull();
  });

  it('says there is no flag when the server raised none, and that the flags could not be read when they could not', async () => {
    open({
      checks: {
        photo_id: PHOTO,
        checks: { time: 'OK', geofence: 'INSIDE', duplicate: 'UNIQUE', exif: 'CONSISTENT', summary: 'PASS' },
        flags: [],
        received_at: '2026-10-25T03:00:00.000Z',
        geo_consent: false,
        place: null,
      },
    });
    await fillPhoto();
    register();
    expect((await screen.findByTestId('no-flags')).textContent).toBe(word('qms.photo.flags.none'));
    cleanup();
    open({ checks: problem(500, 'INTERNAL_ERROR') });
    await fillPhoto();
    register();
    expect((await screen.findByText(word('qms.capture.done.checksFailed'))).tagName).toBe('P');
  });

  it('registers without reading the flags when the caller may not read photos', async () => {
    const h = open({}, { permissions: ['photo.upload', 'contract.read'] });
    await fillPhoto();
    register();
    expect(await screen.findByTestId('registered')).toBeTruthy();
    expect(screen.queryByTestId('server-checks')).toBeNull();
    expect(h.read.mock.calls.some(([name]) => name === 'getSitePhotoChecks' || name === 'get_resources_site_photo')).toBe(false);
    expect(flags()).toEqual(['PLACE_NOT_KEPT']);
  });

  it('tells the person, before the send, that the same file is already registered for the contract', async () => {
    const sha = await hashOf();
    open({ known: [known(sha), known('b'.repeat(64))] });
    await fillPhoto();
    await waitFor(() => expect(flags()).toEqual(['DUPLICATE_SAME_SITE', 'PLACE_NOT_KEPT']));
    await choosePhoto(fileOf('khac.jpg', 'image/jpeg', new Uint8Array([9, 9, 9])));
    await waitFor(() => expect(flags()).toEqual(['PLACE_NOT_KEPT']));
  });

  it('AC-ST-QMS-003-2: UAT-AC367 sends no coordinates without the consent, whatever was typed before it was taken back', async () => {
    const h = open();
    await fillPhoto();
    fireEvent.click(screen.getByLabelText(word('qms.capture.place.consent')));
    type(word('qms.capture.place.lat'), '10.8');
    type(word('qms.capture.place.lng'), '106.7');
    expect(flags()).toEqual([]);
    fireEvent.click(screen.getByLabelText(word('qms.capture.place.consent')));
    expect((screen.getByLabelText(word('qms.capture.place.lat')) as HTMLInputElement).value).toBe('');
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    const [body] = sent(h);
    for (const key of ['geo_consent', 'device_gps_lat', 'device_gps_lng', 'device_gps_accuracy_m']) expect(body).not.toHaveProperty(key);
  });

  it('sends the place as the device gave it when the person consented, and the consent alone when there is no place', async () => {
    const h = open();
    await fillPhoto();
    fireEvent.click(screen.getByLabelText(word('qms.capture.place.consent')));
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    expect(sent(h)[0]).toMatchObject({ geo_consent: true });
    expect(sent(h)[0]).not.toHaveProperty('device_gps_lat');
    await fillPhoto();
    fireEvent.click(screen.getByLabelText(word('qms.capture.place.consent')));
    type(word('qms.capture.place.lat'), '10.8');
    type(word('qms.capture.place.lng'), '106.7');
    type(word('qms.capture.place.accuracy'), '12');
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(2));
    expect(sent(h)[1]).toMatchObject({ geo_consent: true, device_gps_lat: '10.8', device_gps_lng: '106.7', device_gps_accuracy_m: '12' });
  });

  it('fills the place from the device only after the consent, and says when the device cannot give it', async () => {
    const getCurrentPosition = vi.fn((success: (position: unknown) => void) => success({ coords: { latitude: 10.8123456, longitude: 106.7123456, accuracy: 12.345 } }));
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    open();
    await choosePhoto();
    const locate = screen.getByRole('button', { name: word('qms.capture.place.locate') }) as HTMLButtonElement;
    expect(locate.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(word('qms.capture.place.consent')));
    fireEvent.click(locate);
    await waitFor(() => expect((screen.getByLabelText(word('qms.capture.place.lat')) as HTMLInputElement).value).toBe('10.812346'));
    expect((screen.getByLabelText(word('qms.capture.place.accuracy')) as HTMLInputElement).value).toBe('12.35');
    getCurrentPosition.mockImplementation((_success: unknown, failure?: () => void) => failure?.());
    fireEvent.click(locate);
    expect((await screen.findByTestId('locate-failed')).textContent).toBe(word('qms.capture.place.unavailable'));
    vi.stubGlobal('navigator', {});
    fireEvent.click(locate);
    expect(screen.getByTestId('locate-failed')).toBeTruthy();
  });

  it('UAT-AC367: drops a position that arrives after the consent was taken back, and sends no place', async () => {
    const device = slowDevice();
    const h = open();
    await fillPhoto();
    const consent = screen.getByLabelText(word('qms.capture.place.consent')) as HTMLInputElement;
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: word('qms.capture.place.locate') }));
    fireEvent.click(consent);
    device.arrive();
    expect(consent.checked).toBe(false);
    expect((screen.getByLabelText(word('qms.capture.place.lat')) as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: word('qms.capture.place.locate') }) as HTMLButtonElement).disabled).toBe(true);
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    for (const key of ['geo_consent', 'device_gps_lat', 'device_gps_lng', 'device_gps_accuracy_m']) expect(sent(h)[0]).not.toHaveProperty(key);
  });

  it('UAT-AC367: the failure of a request in flight when the consent was taken back and given again does not show, and a new request still fills the place', async () => {
    const device = slowDevice();
    open();
    await fillPhoto();
    const consent = screen.getByLabelText(word('qms.capture.place.consent'));
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: word('qms.capture.place.locate') }));
    fireEvent.click(consent);
    fireEvent.click(consent);
    expect((screen.getByRole('button', { name: word('qms.capture.place.locate') }) as HTMLButtonElement).disabled).toBe(false);
    device.fail();
    expect(screen.queryByTestId('locate-failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: word('qms.capture.place.locate') }));
    device.arrive();
    expect((screen.getByLabelText(word('qms.capture.place.lat')) as HTMLInputElement).value).toBe('10.812346');
  });

  it('puts a position that arrives while the consent holds into the place and keeps what was typed meanwhile', async () => {
    const device = slowDevice();
    const h = open();
    await fillPhoto();
    fireEvent.click(screen.getByLabelText(word('qms.capture.place.consent')));
    fireEvent.click(screen.getByRole('button', { name: word('qms.capture.place.locate') }));
    type(word('qms.capture.field.caption'), 'Sau khi bấm');
    device.arrive();
    expect((screen.getByLabelText(word('qms.capture.place.lat')) as HTMLInputElement).value).toBe('10.812346');
    expect((screen.getByLabelText(word('qms.capture.field.caption')) as HTMLTextAreaElement).value).toBe('Sau khi bấm');
    expect((screen.getByLabelText(word('qms.capture.place.consent')) as HTMLInputElement).checked).toBe(true);
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    expect(sent(h)[0]).toMatchObject({ caption: 'Sau khi bấm', geo_consent: true, device_gps_lat: '10.812346', device_gps_lng: '106.712346', device_gps_accuracy_m: '12.35' });
  });

  it('keeps the photo chosen last when the read of an earlier one ends after it, and registers the hash of that one', async () => {
    const slow = fileOf('cham.jpg', 'image/jpeg', new Uint8Array([1, 1, 1, 1]));
    const fast = fileOf('nhanh.jpg', 'image/jpeg', new Uint8Array([2, 2, 2, 2, 2]));
    const held = holdRead(slow);
    const h = open();
    await screen.findByRole('option', { name: /^HD-A-002$/ });
    const input = screen.getByLabelText(word('qms.capture.field.file'));
    fireEvent.change(input, { target: { files: [slow] } });
    fireEvent.change(input, { target: { files: [fast] } });
    const wanted = await hashOf(new Uint8Array([2, 2, 2, 2, 2]));
    await waitFor(() => expect(screen.getByTestId('file-facts').textContent).toBe(fill(word('qms.capture.file.facts'), { name: 'nhanh.jpg', size: 5, hash: wanted.slice(0, 12) })));
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('file-facts').textContent).toContain('nhanh.jpg');
    type(word('qms.capture.field.contract'), CONTRACT);
    type(word('qms.capture.field.key'), KEY);
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    expect(sent(h)[0]).toMatchObject({ file_sha256: wanted });
  });

  it('waits for the read of the photo chosen last, and drops the failure of an earlier one', async () => {
    const slow = fileOf('cham.jpg', 'image/jpeg', new Uint8Array([1, 1, 1, 1]));
    const fast = fileOf('nhanh.jpg', 'image/jpeg', new Uint8Array([2, 2, 2, 2, 2]));
    const held = holdRead(slow);
    open();
    await screen.findByRole('option', { name: /^HD-A-002$/ });
    const input = screen.getByLabelText(word('qms.capture.field.file'));
    fireEvent.change(input, { target: { files: [fast] } });
    await screen.findByTestId('file-facts');
    fireEvent.change(input, { target: { files: [slow] } });
    expect((screen.getByRole('button', { name: word('qms.capture.submit.action') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { files: [fast] } });
    await waitFor(() => expect((screen.getByRole('button', { name: word('qms.capture.submit.action') }) as HTMLButtonElement).disabled).toBe(false));
    held.fail();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('file-facts').textContent).toContain('nhanh.jpg');
  });

  it('drops a read that ends after the choice was cleared', async () => {
    const slow = fileOf('cham.jpg', 'image/jpeg', new Uint8Array([1, 1, 1, 1]));
    const held = holdRead(slow);
    const view = open();
    await screen.findByRole('option', { name: /^HD-A-002$/ });
    const input = screen.getByLabelText(word('qms.capture.field.file'));
    fireEvent.change(input, { target: { files: [slow] } });
    fireEvent.change(input, { target: { files: [] } });
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('file-facts')).toBeNull();
    expect((screen.getByRole('button', { name: word('qms.capture.submit.action') }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.command).not.toHaveBeenCalled();
  });

  it('keeps what the person changed while the photo is being registered, and does not send the photo again', async () => {
    let answer: () => void = () => undefined;
    const h = open({}, { command: () => new Promise((resolve) => (answer = () => resolve({ resource_id: PHOTO }))) });
    await fillPhoto();
    type(word('qms.capture.field.caption'), 'Ảnh thứ nhất');
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    const next = fileOf('khac.jpg', 'image/jpeg', new Uint8Array([7, 7, 7]));
    type(word('qms.capture.field.caption'), 'Ảnh thứ hai');
    fireEvent.change(screen.getByLabelText(word('qms.capture.field.file')), { target: { files: [next] } });
    const wanted = await hashOf(new Uint8Array([7, 7, 7]));
    await waitFor(() => expect(screen.getByTestId('file-facts').textContent).toBe(fill(word('qms.capture.file.facts'), { name: 'khac.jpg', size: 3, hash: wanted.slice(0, 12) })));
    await act(async () => answer());
    expect(await screen.findByTestId('registered')).toBeTruthy();
    expect((screen.getByLabelText(word('qms.capture.field.caption')) as HTMLTextAreaElement).value).toBe('Ảnh thứ hai');
    expect((screen.getByLabelText(word('qms.capture.field.key')) as HTMLInputElement).value).toBe(KEY);
    expect(screen.getByTestId('file-facts').textContent).toContain('khac.jpg');
    expect(sent(h)).toHaveLength(1);
    expect(sent(h)[0]).toMatchObject({ caption: 'Ảnh thứ nhất' });
  });

  it('links the photo to a diary of the contract when the caller may read diaries', async () => {
    const h = open();
    await fillPhoto();
    const choice = await screen.findByLabelText(word('qms.capture.field.diary'));
    await within(choice).findByRole('option', { name: /NK-HD-A-002/ });
    fireEvent.change(choice, { target: { value: '00000000-0000-4000-8000-00d000000001' } });
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    expect(sent(h)[0]).toMatchObject({ site_diary_id: '00000000-0000-4000-8000-00d000000001' });
    cleanup();
    open({}, { permissions: ['photo.upload', 'contract.read'] });
    await fillPhoto();
    expect(screen.queryByLabelText(word('qms.capture.field.diary'))).toBeNull();
  });

  it('names what is missing and sends nothing: the file, the contract, the reference, and an image that is not one', async () => {
    const h = open();
    await screen.findByRole('option', { name: /^HD-A-002$/ });
    register();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([word('qms.capture.error.required')]));
    expect(h.command).not.toHaveBeenCalled();
    await choosePhoto(fileOf('ghi-chu.pdf', 'application/pdf'));
    await screen.findByTestId('file-facts');
    register();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(word('qms.capture.error.notImage'));
    const huge = fileOf('lon.jpg');
    Object.defineProperty(huge, 'size', { value: 16 * 1024 * 1024 });
    await choosePhoto(huge);
    await waitFor(() => expect(screen.getByTestId('file-facts').textContent).toContain('16777216'));
    register();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(word('qms.capture.error.tooLarge'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('forgets a file that is taken back or cannot be read', async () => {
    open();
    await fillPhoto();
    fireEvent.change(screen.getByLabelText(word('qms.capture.field.file')), { target: { files: [] } });
    expect(screen.queryByTestId('file-facts')).toBeNull();
    const broken = fileOf();
    class BrokenReader {
      onerror: ((event: unknown) => void) | null = null;
      readAsArrayBuffer(): void {
        this.onerror?.(new Event('error'));
      }
    }
    vi.stubGlobal('FileReader', BrokenReader);
    fireEvent.change(screen.getByLabelText(word('qms.capture.field.file')), { target: { files: [broken] } });
    await waitFor(() => expect(screen.queryByTestId('file-facts')).toBeNull());
  });

  it('keeps the operation of the photo when the answer is lost, and takes another when the photo changes', async () => {
    const h = open({}, { command: () => lost() });
    await fillPhoto();
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole('button', { name: word('qms.capture.submit.action') }) as HTMLButtonElement).disabled).toBe(false));
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(2));
    expect(sent(h)[1]?.client_operation_id).toBe(sent(h)[0]?.client_operation_id);
    expect(screen.getByTestId('refusal').textContent).toBe(word('qms.capture.refusal.general'));
    type(word('qms.capture.field.caption'), 'Đổi lời chú thích');
    expect(screen.queryByTestId('refusal')).toBeNull();
    register();
    await waitFor(() => expect(sent(h)).toHaveLength(3));
    expect(sent(h)[2]?.client_operation_id).not.toBe(sent(h)[0]?.client_operation_id);
  });

  it.each([
    ['GEO_CONSENT_REQUIRED', 'qms.capture.refusal.consentRequired'],
    ['FILE_NOT_CLEAN', 'qms.capture.refusal.fileNotClean'],
    ['HASH_MISMATCH', 'qms.capture.refusal.hashMismatch'],
    ['RESOURCE_NOT_FOUND', 'qms.capture.refusal.notFound'],
    ['VALIDATION_FAILED', 'qms.capture.refusal.validation'],
    ['SCOPE_DENIED', 'qms.capture.refusal.denied'],
    ['SESSION_EXPIRED', 'qms.capture.refusal.session'],
    ['INTERNAL_ERROR', 'qms.capture.refusal.general'],
  ])('words the refusal %s of the server', async (code, key) => {
    open({}, { command: () => problem(422, code) });
    await fillPhoto();
    register();
    expect((await screen.findByTestId('refusal')).textContent).toBe(word(key));
  });

  it('is read-only for a suspended tenant: no form and no read of contracts', async () => {
    const h = open({}, { mode: 'READ_ONLY' });
    expect((await screen.findByTestId('frozen')).textContent).toBe(word('qms.capture.frozen.notice'));
    expect(screen.queryByTestId('capture')).toBeNull();
    expect((h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls).toEqual([]);
  });

  it('shows the denied state and reads nothing without the right to register photos or to read contracts', async () => {
    const h = open({}, { permissions: ['photo.read', 'contract.read'] });
    expect((await screen.findByText(word('states.denied.title'))).tagName).toBe('H1');
    cleanup();
    const g = open({}, { permissions: ['photo.upload'] });
    expect((await screen.findByText(word('states.denied.title'))).tagName).toBe('H1');
    for (const harness of [h, g]) expect((harness.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls).toEqual([]);
  });

  it('reads while the permissions are not known yet', async () => {
    open({}, { permissions: undefined });
    await choosePhoto();
    expect(screen.getByTestId('capture')).toBeTruthy();
  });

  it('shows the empty state when the caller has no contract to take photos for', async () => {
    open({}, { contracts: [] });
    expect((await screen.findByText(word('states.empty.title'))).tagName).toBe('H1');
  });

  it('shows the loading state while the contracts are on their way', () => {
    open({}, { pending: true, permissions: ENGINEER });
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });

  it.each(FAILURES)('shows the %s state when the contracts cannot be read, and reads again on retry', async (_name, failure, title) => {
    const h = open({}, { contracts: failure });
    expect((await screen.findByText(title)).tagName).toBe('H1');
    const before = (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect((h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThan(before));
  });
});
