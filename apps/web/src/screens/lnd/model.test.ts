import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  EMPTY_PARCEL_FORM,
  EMPTY_SECTION_FORM,
  canManage,
  canRecordNotice,
  daysBetween,
  describeProblem,
  filterParcels,
  noticeBody,
  noticeState,
  noticeTimerOf,
  parcelBody,
  sectionBody,
  todayInVietnam,
  toParcelLine,
  toSectionOption,
  toUnitOption,
  validateNotice,
  validateParcel,
  validateSection,
} from './model';
import type { ParcelForm, SectionForm } from './model';
import { deadline, parcel } from './test-support';

const line = (n: number, overrides: Record<string, unknown> = {}) => toParcelLine(parcel(n, overrides));
const problem = (code: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions: {} });

describe('toParcelLine (a parcel is land and nothing more)', () => {
  it('reads a parcel with its timer, its unit and its areas, and has no field for a person', () => {
    const read = line(1, { deadline: deadline(), recovery_notice_on: '2026-07-01', notice_days_applied: 90, section_id: 'S1', section_code: 'KM-0-3', has_boundary: true });
    expect(read).toMatchObject({
      parcelCode: 'TB-1/10',
      ownerUnitName: 'UBND xã An Phú',
      landUseGroup: 'AGRICULTURAL',
      areaTotalM2: '1200.50',
      status: 'SURVEYED',
      recoveryNoticeOn: '2026-07-01',
      noticeDaysApplied: 90,
      sectionCode: 'KM-0-3',
      hasBoundary: true,
      version: 1,
      deadline: { timerCode: 'NOTICE_AGRICULTURAL_90', daysApplied: 90, dueOn: '2026-09-29', status: 'RUNNING', awaitingConfirmation: true, cxn: 'CXN-12' },
    });
    expect(Object.keys(read ?? {}).filter((key) => /owner(?!Unit)|household|holder|nationalId|phone|person|user/i.test(key))).toEqual([]);
  });

  it('drops a row it cannot read and a timer it cannot read', () => {
    expect(toParcelLine(null)).toBeUndefined();
    expect(toParcelLine('x')).toBeUndefined();
    expect(line(1, { land_use_group: 'FOREST' })).toBeUndefined();
    expect(line(1, { status: 'GONE' })).toBeUndefined();
    expect(line(1, { version: '1' })).toBeUndefined();
    expect(line(1, { area_total_m2: 5 })).toBeUndefined();
    expect(line(1, { id: undefined })).toBeUndefined();
    expect(line(1, { deadline: { id: 'x' } })?.deadline).toBeNull();
    expect(line(1, { deadline: deadline({ timer_code: 'OTHER' }) })?.deadline).toBeNull();
    expect(line(1, { owner_unit_name: undefined, address_text: undefined })).toMatchObject({ ownerUnitName: '', addressText: null });
  });

  it('reads a section and a unit, and drops what has no code or no name', () => {
    expect(toSectionOption({ id: 's', code: 'KM-1', name: 'Km 1' })).toEqual([{ id: 's', code: 'KM-1', name: 'Km 1' }]);
    expect(toSectionOption({ id: 's', code: 'KM-1' })).toEqual([{ id: 's', code: 'KM-1', name: '' }]);
    expect(toSectionOption({ id: 's' })).toEqual([]);
    expect(toSectionOption(null)).toEqual([]);
    expect(toUnitOption({ id: 'u', code: 'U1', name: 'Unit' })).toEqual([{ id: 'u', code: 'U1', name: 'Unit' }]);
    expect(toUnitOption({ id: 'u', code: 'U1' })).toEqual([]);
  });
});

describe('the days of a notice (BR-LND-01)', () => {
  it('counts the days between two calendar dates, over a month end and a year end', () => {
    expect(daysBetween('2026-07-01', '2026-09-29')).toBe(90);
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(daysBetween('2026-09-29', '2026-09-28')).toBe(-1);
    expect(daysBetween('2026-09-29', '2026-09-29')).toBe(0);
  });

  it('says what the notice of a parcel is on a day: none, running with the days left, over, or ended', () => {
    const running = line(1, { deadline: deadline() }) as NonNullable<ReturnType<typeof line>>;
    expect(noticeState(line(1) as NonNullable<ReturnType<typeof line>>, '2026-07-01')).toEqual({ kind: 'NONE' });
    expect(noticeState(running, '2026-07-01')).toEqual({ kind: 'RUNNING', daysLeft: 90 });
    expect(noticeState(running, '2026-09-28')).toEqual({ kind: 'RUNNING', daysLeft: 1 });
    expect(noticeState(running, '2026-09-29')).toEqual({ kind: 'ELAPSED' });
    expect(noticeState(running, '2026-10-24')).toEqual({ kind: 'ELAPSED' });
    for (const status of ['SATISFIED', 'BREACHED', 'CANCELLED'] as const) {
      expect(noticeState(line(1, { deadline: deadline({ status }) }) as NonNullable<ReturnType<typeof line>>, '2026-10-24')).toEqual({ kind: status });
    }
  });

  it('gives agricultural land the short notice and every other land use the long one', () => {
    expect(noticeTimerOf('AGRICULTURAL')).toBe('NOTICE_AGRICULTURAL_90');
    expect(noticeTimerOf('PUBLIC')).toBe('NOTICE_NON_AGRICULTURAL_180');
    expect(noticeTimerOf('NON_AGRICULTURAL_RESIDENTIAL')).toBe('NOTICE_NON_AGRICULTURAL_180');
  });

  it('judges the day in Vietnam, seven hours ahead of UTC', () => {
    expect(todayInVietnam(new Date('2026-10-24T16:59:00Z'))).toBe('2026-10-24');
    expect(todayInVietnam(new Date('2026-10-24T17:00:00Z'))).toBe('2026-10-25');
    expect(todayInVietnam()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('what the caller may do', () => {
  const surveyed = line(1) as NonNullable<ReturnType<typeof line>>;
  it('offers the notice to a caller who may process, for a parcel that has none and is before payment', () => {
    expect(canRecordNotice(surveyed, ['land.process'], 'FULL')).toBe(true);
    expect(canRecordNotice(surveyed, undefined, undefined)).toBe(true);
    expect(canRecordNotice(surveyed, ['land.read'], 'FULL')).toBe(false);
    expect(canRecordNotice(surveyed, ['land.process'], 'READ_ONLY')).toBe(false);
    expect(canRecordNotice(line(1, { recovery_notice_on: '2026-07-01' }) as NonNullable<ReturnType<typeof line>>, ['land.process'], 'FULL')).toBe(false);
    for (const status of ['PAID', 'HANDED_OVER', 'ENFORCEMENT']) expect(canRecordNotice(line(1, { status }) as NonNullable<ReturnType<typeof line>>, ['land.process'], 'FULL')).toBe(false);
    expect(canRecordNotice(line(1, { status: 'DISPUTED' }) as NonNullable<ReturnType<typeof line>>, ['land.process'], 'FULL')).toBe(true);
  });

  it('offers the creation to a caller who may manage and is not read-only', () => {
    expect(canManage(['land.manage'], 'FULL')).toBe(true);
    expect(canManage(undefined, undefined)).toBe(true);
    expect(canManage(['land.read'], 'FULL')).toBe(false);
    expect(canManage(['land.manage'], 'READ_ONLY')).toBe(false);
  });
});

describe('filterParcels', () => {
  const parcels = [line(1), line(2, { status: 'DISPUTED', section_id: 'S1', owner_unit_name: 'Quỹ đất', address_text: null })].flatMap((item) => (item === undefined ? [] : [item]));
  it('keeps the order of the read and filters by status, section and a word of the code, the address or the unit, ignoring capitals', () => {
    expect(filterParcels(parcels, EMPTY_FILTER).map((item) => item.parcelCode)).toEqual(['TB-1/10', 'TB-2/10']);
    expect(filterParcels(parcels, { ...EMPTY_FILTER, status: 'DISPUTED' }).map((item) => item.parcelCode)).toEqual(['TB-2/10']);
    expect(filterParcels(parcels, { ...EMPTY_FILTER, sectionId: 'S1' }).map((item) => item.parcelCode)).toEqual(['TB-2/10']);
    expect(filterParcels(parcels, { ...EMPTY_FILTER, query: ' tb-1 ' }).map((item) => item.parcelCode)).toEqual(['TB-1/10']);
    expect(filterParcels(parcels, { ...EMPTY_FILTER, query: 'thôn 1' }).map((item) => item.parcelCode)).toEqual(['TB-1/10']);
    expect(filterParcels(parcels, { ...EMPTY_FILTER, query: 'QUỸ' }).map((item) => item.parcelCode)).toEqual(['TB-2/10']);
    expect(filterParcels(parcels, { ...EMPTY_FILTER, query: 'nothing' })).toEqual([]);
  });
});

describe('the form of a parcel', () => {
  const good: ParcelForm = { parcelCode: ' tb-12/345 ', ownerUnitId: 'u1', landUseGroup: 'AGRICULTURAL', areaTotalM2: '1200.5', areaAffectedM2: '800', addressText: ' Thôn 3 ', sectionId: '' };

  it('accepts a good form and sends it trimmed, with the code in capitals and the optional fields only when they are there', () => {
    expect(validateParcel(good)).toEqual({});
    expect(parcelBody('p1', good)).toEqual({ project_id: 'p1', owner_unit_id: 'u1', parcel_code: 'TB-12/345', land_use_group: 'AGRICULTURAL', area_total_m2: '1200.5', area_affected_m2: '800', address_text: 'Thôn 3' });
    expect(parcelBody('p1', { ...good, addressText: '  ', sectionId: 's1' })).toEqual({
      project_id: 'p1',
      owner_unit_id: 'u1',
      parcel_code: 'TB-12/345',
      land_use_group: 'AGRICULTURAL',
      area_total_m2: '1200.5',
      area_affected_m2: '800',
      section_id: 's1',
    });
  });

  it('says what is missing, too long, not a code, not an area, or not allowed in the address', () => {
    expect(validateParcel(EMPTY_PARCEL_FORM)).toEqual({ parcelCode: 'required', ownerUnitId: 'required', landUseGroup: 'required', areaTotalM2: 'required', areaAffectedM2: 'required' });
    expect(validateParcel({ ...good, parcelCode: 'x'.repeat(51) }).parcelCode).toBe('tooLong');
    expect(validateParcel({ ...good, parcelCode: 'has space' }).parcelCode).toBe('invalid');
    expect(validateParcel({ ...good, areaTotalM2: '0' }).areaTotalM2).toBe('invalid');
    expect(validateParcel({ ...good, areaTotalM2: '1.234' }).areaTotalM2).toBe('invalid');
    expect(validateParcel({ ...good, areaTotalM2: '1000000000000' }).areaTotalM2).toBe('invalid');
    expect(validateParcel({ ...good, areaAffectedM2: '900000' }).areaAffectedM2).toBe('invalid');
    expect(validateParcel({ ...good, areaAffectedM2: '-1' }).areaAffectedM2).toBe('invalid');
    expect(validateParcel({ ...good, areaAffectedM2: '0' })).toEqual({});
    expect(validateParcel({ ...good, areaTotalM2: 'x', areaAffectedM2: '5' })).toEqual({ areaTotalM2: 'invalid' });
    expect(validateParcel({ ...good, addressText: 'x'.repeat(501) }).addressText).toBe('tooLong');
    expect(validateParcel({ ...good, addressText: 'a\u0007b' }).addressText).toBe('invalid');
  });
});

describe('the form of a section', () => {
  const good: SectionForm = { code: 'KM-0-3', name: 'Km 0 to km 3', fromKm: '0', toKm: '3.5', requiredAreaM2: '30000', targetDate: '2027-03-01', contractId: '' };

  it('accepts a good form and sends only the fields that are filled', () => {
    expect(validateSection(good)).toEqual({});
    expect(sectionBody('p1', good)).toEqual({ project_id: 'p1', code: 'KM-0-3', name: 'Km 0 to km 3', required_area_m2: '30000', from_km: '0', to_km: '3.5', target_date: '2027-03-01' });
    expect(sectionBody('p1', { ...good, fromKm: '', toKm: '', targetDate: '' })).toEqual({ project_id: 'p1', code: 'KM-0-3', name: 'Km 0 to km 3', required_area_m2: '30000' });
    expect(sectionBody('p1', { ...good, contractId: 'c1' })).toMatchObject({ contract_id: 'c1' });
  });

  it('says what is missing, too long, or not valid', () => {
    expect(validateSection(EMPTY_SECTION_FORM)).toEqual({ code: 'required', name: 'required', requiredAreaM2: 'required' });
    expect(validateSection({ ...good, code: 'x'.repeat(51) }).code).toBe('tooLong');
    expect(validateSection({ ...good, code: 'a\u0007' }).code).toBe('invalid');
    expect(validateSection({ ...good, name: 'x'.repeat(301) }).name).toBe('tooLong');
    expect(validateSection({ ...good, name: 'a\u0007' }).name).toBe('invalid');
    expect(validateSection({ ...good, requiredAreaM2: 'many' }).requiredAreaM2).toBe('invalid');
    expect(validateSection({ ...good, fromKm: 'x' }).fromKm).toBe('invalid');
    expect(validateSection({ ...good, toKm: 'x' }).toKm).toBe('invalid');
    expect(validateSection({ ...good, fromKm: '5', toKm: '3' }).toKm).toBe('invalid');
    expect(validateSection({ ...good, targetDate: '2027-13-40' }).targetDate).toBe('invalid');
    expect(validateSection({ ...good, targetDate: 'tomorrow' }).targetDate).toBe('invalid');
  });
});

describe('the form of the notice', () => {
  const document = '00000000-0000-4000-8000-0000000000AB';

  it('accepts a real date that has come and a document id, and sends the id in lower case', () => {
    expect(validateNotice({ noticeOn: '2026-07-01', documentVersionId: document }, '2026-10-24')).toEqual({});
    expect(validateNotice({ noticeOn: '2026-10-24', documentVersionId: document }, '2026-10-24')).toEqual({});
    expect(noticeBody({ noticeOn: ' 2026-07-01 ', documentVersionId: ` ${document} ` })).toEqual({ notice_on: '2026-07-01', notice_document_version_id: document.toLowerCase() });
  });

  it('says what is missing, not a date, in the future, or not an id', () => {
    expect(validateNotice({ noticeOn: '', documentVersionId: '' }, '2026-10-24')).toEqual({ noticeOn: 'required', documentVersionId: 'required' });
    expect(validateNotice({ noticeOn: '2026-02-30', documentVersionId: document }, '2026-10-24').noticeOn).toBe('invalid');
    expect(validateNotice({ noticeOn: '01/07/2026', documentVersionId: document }, '2026-10-24').noticeOn).toBe('invalid');
    expect(validateNotice({ noticeOn: '2026-10-25', documentVersionId: document }, '2026-10-24').noticeOn).toBe('future');
    expect(validateNotice({ noticeOn: '2026-07-01', documentVersionId: 'not-an-id' }, '2026-10-24').documentVersionId).toBe('invalid');
  });
});

describe('describeProblem', () => {
  it('maps the codes of the server to what a dialog says, and an unknown failure to the general one', () => {
    const expected: Record<string, string> = {
      PARCEL_CODE_DUPLICATE: 'codeDuplicate',
      SECTION_CODE_DUPLICATE: 'codeDuplicate',
      AREA_INVALID: 'areaInvalid',
      TIMER_RULE_UNCONFIRMED: 'ruleUnconfirmed',
      PARCEL_STATE_INVALID: 'stateInvalid',
      DOCUMENT_NOT_CLEAN: 'documentNotClean',
      MASTER_NOT_EFFECTIVE: 'masterNotEffective',
      VERSION_CONFLICT: 'versionConflict',
      VALIDATION_FAILED: 'validation',
      INVALID_REQUEST: 'validation',
      RESOURCE_NOT_FOUND: 'notFound',
      SCOPE_DENIED: 'denied',
    };
    for (const [code, reason] of Object.entries(expected)) expect(describeProblem(problem(code))).toBe(reason);
    expect(describeProblem(problem('SOMETHING_NEW'))).toBe('general');
    expect(describeProblem(new Error('network'))).toBe('general');
  });
});
