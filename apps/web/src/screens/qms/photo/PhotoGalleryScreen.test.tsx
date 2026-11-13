import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { contractId, line as contractLine, mount } from '../../ctr/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { routeOf } from '../inspection/test-support';
import PhotoGalleryScreen from './PhotoGalleryScreen';
import * as labels from './labels';
import { describeProblem, filterQuery, toChecksView, toPhotoLine, toPhotoPage } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), word(key));
const ROUTE = routeOf('QMS-08', 'FR-QMS-08');
const photoId = (n: number): string => `00000000-0000-4000-8000-00f0${String(n).padStart(8, '0')}`;

const checksOf = (overrides: Record<string, unknown> = {}) => ({ time: 'OK', geofence: 'INSIDE', duplicate: 'UNIQUE', exif: 'CONSISTENT', summary: 'PASS', ...overrides });

/** A photo as the list answers it: all four flags in order, a place with the consent to keep it. */
const photo = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: photoId(n),
  project: { id: '00000000-0000-4000-8000-000000000001', code: 'PRJ-A-001' },
  contract: { id: contractId(2), code: 'HD-A-002' },
  site_diary_id: null,
  inspection_id: null,
  nonconformance_id: null,
  issue_id: null,
  file_sha256: 'a'.repeat(64),
  scan_status: 'CLEAN',
  taken_at_exif: '2026-10-25T01:15:00.000Z',
  received_at: `2026-10-25T03:0${n}:00.000Z`,
  geo_consent: true,
  place: { lat: 10.8002, lng: 106.7003, accuracy_m: 8, source: 'DEVICE_AT_CAPTURE' },
  device_id: null,
  device_model: 'Pixel 8',
  checks: checksOf(),
  flags: [],
  review_note: 'REVIEW_FLAGS_ONLY',
  caption: `Ảnh ${n}`,
  uploaded_by: { membership_id: '00000000-0000-4000-8000-00a000000001', display_name: 'Giám sát Bình' },
  created_at: `2026-10-25T03:0${n}:00.000Z`,
  ...overrides,
});

interface World {
  photos: Array<Record<string, unknown>>;
  failing: Set<string>;
  page: number;
}

function client(state: World): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_site_photo') {
      const query = (input as { query?: Record<string, string | number> } | undefined)?.query ?? {};
      const items = state.photos.filter((item) => (query.contract_id === undefined || (item.contract as { id: string } | null)?.id === query.contract_id) && (query.summary === undefined || (item.checks as { summary: string }).summary === query.summary));
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      return { items: items.slice(start, start + state.page), ...(start + state.page < items.length ? { next_cursor: String(start + state.page) } : {}), as_of: '2026-10-25T04:00:00.000Z' };
    }
    if (operation === 'getSitePhotoChecks') {
      const wanted = (input as { path: { id: string } }).path.id;
      const found = state.photos.find((item) => item.id === wanted);
      if (found === undefined) return Promise.reject(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }));
      return { photo_id: found.id, checks: found.checks, flags: found.flags, review_note: 'REVIEW_FLAGS_ONLY', taken_at_exif: found.taken_at_exif, received_at: found.received_at, geo_consent: found.geo_consent, place: found.place };
    }
    return new Error(`unexpected read ${operation}`);
  });
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => (operation === 'get_resources_contract' ? Promise.resolve([contractLine(1), contractLine(2, { status: 'ACTIVE', title: null })]) : Promise.reject(new Error(`unexpected readAll ${operation}`))));
  return h;
}

function open(state: Partial<World> = {}, query = '') {
  const h = client({ photos: [], failing: new Set(), page: 50, ...state });
  mount(<PhotoGalleryScreen route={ROUTE} />, h, { permissions: ['photo.read'], path: `/qms/qms-08${query}` });
  return h;
}

const rows = (): string[] => Array.from(document.querySelectorAll('[data-photo]')).map((row) => row.getAttribute('data-photo') as string);
const row = (id: string): HTMLElement => document.querySelector(`[data-photo="${id}"]`) as HTMLElement;
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const readsOf = (h: Harness): Array<{ query?: Record<string, unknown> }> => h.read.mock.calls.filter((call) => call[0] === 'get_resources_site_photo').map((call) => call[1] as { query?: Record<string, unknown> });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PhotoGalleryScreen (QMS-08): the site photos and their review flags', () => {
  it('UI-QMS-08: AC-ST-QMS-003-1 lists the photos with when they were taken and received, where, and the four flags, as flags to review and nothing else', async () => {
    open({
      photos: [
        photo(3, { checks: checksOf({ time: 'SKEW', summary: 'WARN' }), flags: ['TIME_SKEW'] }),
        photo(2, { checks: checksOf({ geofence: 'OUTSIDE', duplicate: 'DUPLICATE_SAME_SITE', exif: 'STRIPPED', summary: 'WARN' }), flags: ['GEOFENCE_OUTSIDE', 'DUPLICATE_SAME_SITE', 'EXIF_STRIPPED'] }),
        photo(1),
      ],
    });
    await screen.findByTestId('photos');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('qms.photo.title'));
    expect(screen.getByText(text('qms.photo.footer.reference', { id: 'QMS-08', req: 'FR-QMS-08' }))).toBeTruthy();
    expect(screen.getByTestId('review-note').textContent).toBe(word('qms.photo.note'));
    expect(rows()).toEqual([photoId(3), photoId(2), photoId(1)]);
    const first = row(photoId(1));
    expect(within(first).getByTestId('photo').textContent).toContain('Ảnh 1');
    expect(within(first).getByTestId('photo').textContent).toContain('PRJ-A-001 · HD-A-002 · Pixel 8');
    expect(within(first).getByTestId('place').textContent).toContain('10.800200, 106.700300');
    expect(within(first).getByTestId('place').textContent).toContain(word('qms.photo.source.device'));
    expect(within(first).getByTestId('accuracy').textContent).toBe(text('qms.photo.accuracy', { value: 8 }));
    expect(Array.from(first.querySelectorAll('[data-check]')).map((item) => item.textContent)).toEqual([word('qms.photo.time.ok'), word('qms.photo.geofence.inside'), word('qms.photo.duplicate.unique'), word('qms.photo.exif.consistent')]);
    expect(within(first).getByTestId('summary').textContent).toBe(word('qms.photo.summary.pass'));
    const second = row(photoId(2));
    expect(Array.from(second.querySelectorAll('[data-check]')).map((item) => item.textContent)).toEqual([word('qms.photo.time.ok'), word('qms.photo.geofence.outside'), word('qms.photo.duplicate.sameSite'), word('qms.photo.exif.stripped')]);
    expect(within(second).getByTestId('summary').textContent).toBe(word('qms.photo.summary.warn'));
    // The screen never calls a photo true or false.
    expect(document.body.textContent).not.toMatch(/authentic|genuine|forged|giả mạo|xác thực là thật/i);
  });

  it('AC-ST-QMS-003-2: UAT-AC367 shows no place for a photo whose person did not consent to keeping it, whatever the server sent', async () => {
    open({ photos: [photo(1, { geo_consent: false, place: { lat: 10.8002, lng: 106.7003, accuracy_m: 8, source: 'EXIF' }, checks: checksOf({ geofence: 'MISSING', summary: 'WARN' }), flags: ['GEOFENCE_MISSING'] })] });
    await screen.findByTestId('photos');
    expect(within(row(photoId(1))).getByTestId('place').textContent).toBe(word('qms.photo.place.noConsent'));
    expect(document.body.textContent).not.toContain('10.8002');
    fireEvent.click(within(row(photoId(1))).getByRole('button', { name: word('qms.photo.open.action') }));
    expect((await screen.findByTestId('details-place')).textContent).toBe(word('qms.photo.place.noConsent'));
    expect(document.body.textContent).not.toContain('10.8002');
  });

  it('says a place was consented to and none was in the file', async () => {
    open({ photos: [photo(1, { place: null })] });
    await screen.findByTestId('photos');
    expect(within(row(photoId(1))).getByTestId('place').textContent).toBe(word('qms.photo.place.none'));
  });

  it('opens the checks of a photo with what each flag asks a reviewer to look at, and says when there is none', async () => {
    const flagged = photo(2, { checks: checksOf({ time: 'MISSING', geofence: 'LOW_ACCURACY', exif: 'INCONSISTENT', duplicate: 'DUPLICATE_OTHER_SITE', summary: 'WARN' }), flags: ['TIME_MISSING', 'GEOFENCE_LOW_ACCURACY', 'DUPLICATE_OTHER_SITE', 'EXIF_INCONSISTENT', 'SOMETHING_NEW'] });
    const h = open({ photos: [flagged, photo(1)] });
    await screen.findByTestId('photos');
    fireEvent.click(within(row(photoId(2))).getByRole('button', { name: word('qms.photo.open.action') }));
    const flags = await screen.findByTestId('flags');
    expect(Array.from(flags.querySelectorAll('[data-flag]')).map((item) => item.textContent)).toEqual([word('qms.photo.flag.timeMissing'), word('qms.photo.flag.geofenceLowAccuracy'), word('qms.photo.flag.duplicateOtherSite'), word('qms.photo.flag.exifInconsistent'), 'SOMETHING_NEW']);
    expect(screen.getByTestId('details-note').textContent).toBe(word('qms.photo.note'));
    expect(h.read.mock.calls.filter((call) => call[0] === 'getSitePhotoChecks')).toHaveLength(1);
    fireEvent.click(within(row(photoId(1))).getByRole('button', { name: word('qms.photo.open.action') }));
    expect((await screen.findByTestId('no-flags')).textContent).toBe(word('qms.photo.flags.none'));
    fireEvent.click(screen.getByRole('button', { name: word('qms.photo.details.close') }));
    expect(screen.queryByTestId('photo-details')).toBeNull();
  });

  it('does not show checks for a photo that is not there, from a link to it', async () => {
    open({ photos: [photo(1)] }, `?photo=${photoId(9)}`);
    expect(await screen.findByRole('button', { name: /thử lại|retry/i })).toBeTruthy();
    expect(screen.queryByTestId('flags')).toBeNull();
  });

  it('narrows the list by contract and by the result of the checks, sending only what was chosen, and reads a page at a time', async () => {
    const h = open({
      page: 2,
      photos: [photo(3, { contract: { id: contractId(1), code: 'HD-A-001' } }), photo(2, { checks: checksOf({ time: 'SKEW', summary: 'WARN' }), flags: ['TIME_SKEW'] }), photo(1)],
    });
    await screen.findByTestId('photos');
    expect(readsOf(h)[0]?.query).toEqual({ limit: 50 });
    expect(rows()).toEqual([photoId(3), photoId(2)]);
    fireEvent.click(screen.getByRole('button', { name: word('qms.photo.more.action') }));
    await waitFor(() => expect(rows()).toEqual([photoId(3), photoId(2), photoId(1)]));
    expect(readsOf(h).at(-1)?.query).toMatchObject({ cursor: '2' });
    pick('photo-filter-contract', contractId(1));
    await waitFor(() => expect(rows()).toEqual([photoId(3)]));
    pick('photo-filter-contract', '');
    pick('photo-filter-summary', 'WARN');
    await waitFor(() => expect(rows()).toEqual([photoId(2)]));
    expect(readsOf(h).at(-1)?.query).toEqual({ limit: 50, summary: 'WARN' });
    expect(Array.from((document.getElementById('photo-filter-summary') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['', 'PASS', 'WARN']);
    pick('photo-filter-summary', 'PASS');
    await waitFor(() => expect(rows()).toEqual([photoId(3), photoId(1)]));
  });

  it('says when there is no photo, and shows a read that failed and reads again on retry', async () => {
    const state = { photos: [], failing: new Set(['get_resources_site_photo']), page: 50 };
    const h = client(state);
    mount(<PhotoGalleryScreen route={ROUTE} />, h, { permissions: ['photo.read'], path: '/qms/qms-08' });
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    expect((await screen.findByTestId('no-photos')).textContent).toBe(word('qms.photo.none.notice'));
    expect(readsOf(h).length).toBeGreaterThan(1);
  });
});

describe('the model and the words of QMS-08', () => {
  it('reads a photo, a page and the checks of a photo, ignoring what is not one', () => {
    const line = toPhotoLine(photo(1));
    expect(line).toMatchObject({ id: photoId(1), projectCode: 'PRJ-A-001', contract: { code: 'HD-A-002' }, caption: 'Ảnh 1', deviceModel: 'Pixel 8', uploadedBy: 'Giám sát Bình', place: { lat: 10.8002, accuracyM: 8, source: 'DEVICE_AT_CAPTURE' } });
    expect(toPhotoLine({ ...photo(1), checks: { time: 'OK' } })).toBeUndefined();
    expect(toPhotoLine({ ...photo(1), checks: checksOf({ time: 'LATE' }) })).toBeUndefined();
    expect(toPhotoLine(null)).toBeUndefined();
    expect(toPhotoLine({ ...photo(1), contract: null })?.contract).toBeNull();
    expect(toPhotoLine({ ...photo(1), flags: ['A', 5, 'B'] })?.flags).toEqual(['A', 'B']);
    expect(toPhotoPage({ items: [photo(1), { id: 3 }], next_cursor: 'abc' })).toMatchObject({ lines: [{ id: photoId(1) }], next: 'abc' });
    expect(toPhotoPage(undefined)).toEqual({ lines: [], next: undefined });
    const view = toChecksView({ photo_id: photoId(1), checks: checksOf(), flags: [], taken_at_exif: null, received_at: '2026-10-25T03:00:00.000Z', geo_consent: false, place: { lat: 1, lng: 2, accuracy_m: null, source: 'EXIF' } });
    expect(view).toMatchObject({ photoId: photoId(1), geoConsent: false, place: null });
    expect(toChecksView({})).toBeUndefined();
  });

  it('asks the server only for what was chosen and is well formed', () => {
    expect(filterQuery({ contractId: '', summary: '' })).toEqual({});
    expect(filterQuery({ contractId: contractId(1), summary: 'WARN' })).toEqual({ contract_id: contractId(1), summary: 'WARN' });
    expect(filterQuery({ contractId: 'x', summary: 'MAYBE' })).toEqual({});
  });

  it('words each refusal and has words for every check, source and flag, none missing in the language', () => {
    expect(describeProblem(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }))).toBe('notFound');
    expect(describeProblem(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }))).toBe('denied');
    expect(describeProblem(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c', extensions: {} }))).toBe('session');
    expect(describeProblem(new Error('x'))).toBe('general');
    const t = ((key: string) => (vi_ as Record<string, string>)[key] ?? `MISSING:${key}`) as never;
    const all = [
      ...(['OK', 'SKEW', 'MISSING'] as const).map((check) => labels.timeLabel(t, check)),
      ...(['INSIDE', 'OUTSIDE', 'LOW_ACCURACY', 'MISSING'] as const).map((check) => labels.geofenceLabel(t, check)),
      ...(['UNIQUE', 'DUPLICATE_SAME_SITE', 'DUPLICATE_OTHER_SITE'] as const).map((check) => labels.duplicateLabel(t, check)),
      ...(['CONSISTENT', 'STRIPPED', 'INCONSISTENT'] as const).map((check) => labels.exifLabel(t, check)),
      ...(['PASS', 'WARN', 'FAIL'] as const).map((check) => labels.summaryLabel(t, check)),
      ...(['EXIF', 'DEVICE_AT_CAPTURE', 'MANUAL'] as const).map((check) => labels.sourceLabel(t, check)),
      ...(['TIME_SKEW', 'TIME_MISSING', 'GEOFENCE_OUTSIDE', 'GEOFENCE_LOW_ACCURACY', 'GEOFENCE_MISSING', 'DUPLICATE_SAME_SITE', 'DUPLICATE_OTHER_SITE', 'EXIF_STRIPPED', 'EXIF_INCONSISTENT'] as const).map((flag) => labels.flagMessage(t, flag)),
      ...(['notFound', 'denied', 'session', 'general'] as const).map((problem) => labels.problemMessage(t, problem)),
    ];
    expect(all.filter((entry) => entry.startsWith('MISSING:'))).toEqual([]);
    expect(new Set(all).size).toBe(all.length);
    expect(labels.flagMessage(t, 'NEW_FLAG')).toBe('NEW_FLAG');
  });
});
