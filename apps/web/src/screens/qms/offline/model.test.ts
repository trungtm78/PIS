import { describe, expect, it } from 'vitest';
import { toDiaryLine } from '../diary/model';
import type { DiaryForm, DiaryLine } from '../diary/model';
import { diary } from '../diary/test-support';
import { placeProblemMessage } from './labels';
import { NO_PLACE, draftOver, holds, isPending, newDraft, placeOf, queueItem, queuedContent, toSaveBody, validatePlace, withConsent } from './model';
import type { Place } from './model';

const FORM: DiaryForm = { contractId: '00000000-0000-4000-8000-001000000002', recordDate: '2026-10-24', summary: ' Đổ bê tông ', weatherCode: 'RAIN', workforceCount: '9', notes: '' };
const GIVEN: Place = { consent: true, lat: ' 10.8 ', lng: '106.7', accuracy: '' };
const line = (overrides: Record<string, unknown> = {}): DiaryLine => toDiaryLine(diary(1, overrides)) as DiaryLine;

describe('QMS-09 model', () => {
  it('asks for the consent before any position, the pair of coordinates and sound numbers', () => {
    expect(validatePlace(NO_PLACE)).toEqual({});
    expect(validatePlace(GIVEN)).toEqual({});
    expect(validatePlace({ consent: false, lat: '10', lng: '106', accuracy: '' })).toEqual({ consent: 'consentRequired' });
    expect(validatePlace({ consent: true, lat: '', lng: '106', accuracy: '' })).toEqual({ lat: 'pairRequired' });
    expect(validatePlace({ consent: true, lat: '10', lng: '', accuracy: '' })).toEqual({ lng: 'pairRequired' });
    expect(validatePlace({ consent: true, lat: '91', lng: '181', accuracy: '-1' })).toEqual({ lat: 'invalidLatitude', lng: 'invalidLongitude', accuracy: 'invalidAccuracy' });
    expect(validatePlace({ consent: true, lat: 'north', lng: 'east', accuracy: 'x' })).toEqual({ lat: 'invalidLatitude', lng: 'invalidLongitude', accuracy: 'invalidAccuracy' });
    expect(validatePlace({ consent: true, lat: '-10.123456', lng: '-106.7', accuracy: '12.5' })).toEqual({});
  });

  it('takes the position away with the consent', () => {
    expect(withConsent({ ...GIVEN, accuracy: '5' }, false)).toEqual(NO_PLACE);
    expect(withConsent(NO_PLACE, true)).toEqual({ ...NO_PLACE, consent: true });
  });

  it('shows the place a diary holds only when it holds the consent to it', () => {
    expect(placeOf({ geo_consent: true, location: { lat: 10.8, lng: 106.7, accuracy_m: 4 } })).toEqual({ consent: true, lat: '10.8', lng: '106.7', accuracy: '4' });
    expect(placeOf({ geo_consent: true, location: { lat: 10.8, lng: 106.7 } })).toEqual({ consent: true, lat: '10.8', lng: '106.7', accuracy: '' });
    expect(placeOf({ location: { lat: 10.8, lng: 106.7 } })).toEqual(NO_PLACE);
    expect(placeOf({ geo_consent: true })).toEqual(NO_PLACE);
    expect(placeOf({ geo_consent: true, location: { lat: '10.8', lng: 106.7 } })).toEqual(NO_PLACE);
    expect(placeOf({ geo_consent: true, location: [1, 2] })).toEqual(NO_PLACE);
  });

  it('puts the place in the content only with the consent and both coordinates, over what the diary already held', () => {
    expect(queuedContent(FORM, {}, NO_PLACE)).toEqual({ summary: 'Đổ bê tông', weather_code: 'RAIN', workforce_count: 9 });
    expect(queuedContent(FORM, {}, { ...GIVEN, consent: false })).not.toHaveProperty('location');
    expect(queuedContent(FORM, {}, { ...GIVEN, lng: '' })).not.toHaveProperty('geo_consent');
    expect(queuedContent(FORM, {}, GIVEN)).toMatchObject({ geo_consent: true, location: { lat: 10.8, lng: 106.7 } });
    expect(queuedContent(FORM, {}, { ...GIVEN, accuracy: '12' })).toMatchObject({ location: { lat: 10.8, lng: 106.7, accuracy_m: 12 } });
    // A place the diary held goes when the consent is taken back; what another client wrote is kept.
    const held = { summary: 'cũ', equipment: ['xe'], geo_consent: true, location: { lat: 1, lng: 2 } };
    expect(queuedContent(FORM, held, NO_PLACE)).toEqual({ summary: 'Đổ bê tông', equipment: ['xe'], weather_code: 'RAIN', workforce_count: 9 });
  });

  it('makes the item of the queue with its own operation id and sends the version it was written over', () => {
    const item = queueItem({ form: FORM, contractCode: 'HD-A-002', base: {}, baseServerVersion: null, place: NO_PLACE, clientOperationId: 'op-1', now: new Date('2026-10-24T01:00:00.000Z') });
    expect(item).toMatchObject({
      clientOperationId: 'op-1',
      contractId: FORM.contractId,
      contractCode: 'HD-A-002',
      recordDate: '2026-10-24',
      baseServerVersion: null,
      queuedAt: '2026-10-24T01:00:00.000Z',
      state: 'PENDING',
      reason: null,
    });
    expect(isPending(item)).toBe(true);
    expect(isPending({ ...item, state: 'REJECTED' })).toBe(false);
    expect(toSaveBody(item)).toEqual({ contract_id: FORM.contractId, record_date: '2026-10-24', client_operation_id: 'op-1', content: item.content });
    expect(toSaveBody({ ...item, baseServerVersion: 3 })).toMatchObject({ base_server_version: 3 });
  });

  it('starts from a new day, or from the diary on the server with the version that was read', () => {
    expect(newDraft('2026-10-24')).toEqual({
      form: { contractId: '', recordDate: '2026-10-24', summary: '', weatherCode: '', workforceCount: '', notes: '' },
      place: NO_PLACE,
      base: {},
      baseServerVersion: null,
    });
    const over = draftOver(line({ version: 5, content: { summary: 'x', geo_consent: true, location: { lat: 1, lng: 2 } } }));
    expect(over).toMatchObject({ baseServerVersion: 5, form: { summary: 'x', recordDate: '2026-10-21' }, place: { consent: true, lat: '1', lng: '2' } });
  });

  it('holds a permission, or is not told the permissions yet', () => {
    expect(holds(undefined, 'x')).toBe(true);
    expect(holds(['x'], 'x')).toBe(true);
    expect(holds([], 'x')).toBe(false);
  });

  it('words every problem of the place', () => {
    const t = (key: string): string => key;
    expect((['consentRequired', 'pairRequired', 'invalidLatitude', 'invalidLongitude', 'invalidAccuracy'] as const).map((problem) => placeProblemMessage(t, problem))).toEqual([
      'qms.offline.place.consentRequired',
      'qms.offline.place.pairRequired',
      'qms.offline.place.invalidLatitude',
      'qms.offline.place.invalidLongitude',
      'qms.offline.place.invalidAccuracy',
    ]);
  });
});
