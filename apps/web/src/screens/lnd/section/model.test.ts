import { describe, expect, it } from 'vitest';
import { canHandOver, canHandover, emptyHandover, handoverBody, ratioText, remainingText, toSectionLine, totalsOf, validateHandover } from './model';
import type { SectionLine } from './model';

const raw = (overrides: Record<string, unknown> = {}) => ({
  id: 'a',
  project_id: 'p',
  contract_id: 'c',
  code: 'SEC-01',
  name: 'Km 0 to 3',
  from_km: '0.00',
  to_km: '3.00',
  required_area_m2: '30000.00',
  handed_area_m2: '0.00',
  target_date: '2026-12-31',
  handed_over_on: null,
  status: 'NOT_READY',
  version: 1,
  ...overrides,
});
const line = (overrides: Record<string, unknown> = {}): SectionLine => toSectionLine(raw(overrides)) as SectionLine;
const UUID = '00000000-0000-4000-8000-0000000000a1';
const TODAY = '2026-10-25';

describe('toSectionLine', () => {
  it('reads a section with the areas as exact text', () => {
    expect(toSectionLine(raw({ handed_area_m2: '18000.00', handed_over_on: '2026-10-20', status: 'PARTIAL', version: 3 }))).toEqual({
      id: 'a',
      projectId: 'p',
      contractId: 'c',
      code: 'SEC-01',
      name: 'Km 0 to 3',
      fromKm: '0.00',
      toKm: '3.00',
      requiredAreaM2: '30000.00',
      handedAreaM2: '18000.00',
      targetDate: '2026-12-31',
      handedOverOn: '2026-10-20',
      status: 'PARTIAL',
      version: 3,
    });
  });

  it('leaves a missing name, contract and km empty, and refuses what is not a section', () => {
    expect(toSectionLine(raw({ name: undefined, contract_id: null, from_km: undefined, to_km: null, target_date: undefined }))).toMatchObject({ name: '', contractId: null, fromKm: null, toKm: null, targetDate: null });
    for (const broken of [{ id: undefined }, { project_id: 1 }, { code: undefined }, { required_area_m2: 3 }, { handed_area_m2: undefined }, { status: 'WEIRD' }, { version: '1' }, { version: 1.5 }]) {
      expect(toSectionLine(raw(broken))).toBeUndefined();
    }
    expect(toSectionLine(null)).toBeUndefined();
    expect(toSectionLine('x')).toBeUndefined();
    expect(toSectionLine([])).toBeUndefined();
  });
});

describe('who may hand over what', () => {
  it('asks for the permission unless the permissions are not known yet, and for a session that can write', () => {
    expect(canHandover(['land.handover'], 'FULL')).toBe(true);
    expect(canHandover(['land.handover'], undefined)).toBe(true);
    expect(canHandover(undefined, undefined)).toBe(true);
    expect(canHandover(['land.read'], 'FULL')).toBe(false);
    expect(canHandover(['land.handover'], 'READ_ONLY')).toBe(false);
  });

  it('hands over a section that has a contract and area left', () => {
    expect(canHandOver(line())).toBe(true);
    expect(canHandOver(line({ status: 'PARTIAL', handed_area_m2: '1.00' }))).toBe(true);
    expect(canHandOver(line({ contract_id: null }))).toBe(false);
    expect(canHandOver(line({ status: 'HANDED_OVER', handed_area_m2: '30000.00' }))).toBe(false);
  });
});

describe('exact areas (BR-LND-06)', () => {
  it('AC-ST-LND-009-1, UAT-AC386: computes a share to two decimals, rounded half up, without floating point', () => {
    expect(ratioText('30000.00', '58000.00')).toBe('51.72');
    expect(ratioText('0.00', '58000.00')).toBe('0.00');
    expect(ratioText('58000', '58000')).toBe('100.00');
    expect(ratioText('1', '8')).toBe('12.50');
    expect(ratioText('2.00', '3.00')).toBe('66.67');
    expect(ratioText('0', '0')).toBe('0.00');
    expect(ratioText('999999999999.99', '999999999999.99')).toBe('100.00');
  });

  it('adds the areas of the sections, and does not average their shares', () => {
    const totals = totalsOf([line({ handed_area_m2: '30000.00', status: 'HANDED_OVER', handed_over_on: '2026-10-20' }), line({ id: 'b', code: 'SEC-02', required_area_m2: '28000.00' })]);
    expect(totals).toEqual({ count: 2, handedOver: 1, requiredAreaM2: '58000.00', handedAreaM2: '30000.00', ratio: '51.72' });
    expect(totalsOf([])).toEqual({ count: 0, handedOver: 0, requiredAreaM2: '0.00', handedAreaM2: '0.00', ratio: '0.00' });
  });

  it('says how much is left to hand over', () => {
    expect(remainingText(line({ handed_area_m2: '18000.00' }))).toBe('12000.00');
    expect(remainingText(line({ handed_area_m2: '29999.99' }))).toBe('0.01');
    expect(remainingText(line())).toBe('30000.00');
  });
});

describe('validateHandover', () => {
  const form = (overrides: Partial<ReturnType<typeof emptyHandover>> = {}) => ({ ...emptyHandover(TODAY), handedAreaM2: '18000', documentVersionId: UUID, ...overrides });

  it('starts today, and asks for the area and the document', () => {
    expect(emptyHandover(TODAY)).toEqual({ handedAreaM2: '', handedOverOn: TODAY, documentVersionId: '' });
    expect(validateHandover(emptyHandover(TODAY), line(), TODAY)).toEqual({ handedAreaM2: 'required', documentVersionId: 'required' });
    expect(validateHandover(form(), line(), TODAY)).toEqual({});
  });

  it('refuses an area that is not an area, one that passes what the section needs, and one that does not grow', () => {
    expect(validateHandover(form({ handedAreaM2: '10.123' }), line(), TODAY)).toEqual({ handedAreaM2: 'invalid' });
    expect(validateHandover(form({ handedAreaM2: 'abc' }), line(), TODAY)).toEqual({ handedAreaM2: 'invalid' });
    expect(validateHandover(form({ handedAreaM2: '30000.01' }), line(), TODAY)).toEqual({ handedAreaM2: 'exceeds' });
    expect(validateHandover(form({ handedAreaM2: '30000' }), line(), TODAY)).toEqual({});
    expect(validateHandover(form({ handedAreaM2: '0' }), line(), TODAY)).toEqual({ handedAreaM2: 'notIncreasing' });
    expect(validateHandover(form({ handedAreaM2: '18000' }), line({ handed_area_m2: '18000.00', handed_over_on: '2026-10-20' }), TODAY)).toEqual({ handedAreaM2: 'notIncreasing' });
  });

  it('refuses a day that does not exist, that has not come, or that is before the last handover', () => {
    expect(validateHandover(form({ handedOverOn: '' }), line(), TODAY)).toEqual({ handedOverOn: 'required' });
    expect(validateHandover(form({ handedOverOn: '2026-02-30' }), line(), TODAY)).toEqual({ handedOverOn: 'invalid' });
    expect(validateHandover(form({ handedOverOn: '2026-10-26' }), line(), TODAY)).toEqual({ handedOverOn: 'future' });
    expect(validateHandover(form({ handedOverOn: '2026-10-19' }), line({ handed_area_m2: '1.00', handed_over_on: '2026-10-20', status: 'PARTIAL' }), TODAY)).toEqual({ handedOverOn: 'beforeLast' });
    expect(validateHandover(form({ handedOverOn: '2026-10-20' }), line({ handed_area_m2: '1.00', handed_over_on: '2026-10-20', status: 'PARTIAL' }), TODAY)).toEqual({});
  });

  it('refuses a document that is not an identifier', () => {
    expect(validateHandover(form({ documentVersionId: 'nope' }), line(), TODAY)).toEqual({ documentVersionId: 'invalid' });
  });
});

describe('handoverBody', () => {
  it('builds the body trimmed and with the document in lower case', () => {
    expect(handoverBody({ handedAreaM2: ' 30000 ', handedOverOn: ' 2026-10-22 ', documentVersionId: ` ${UUID.toUpperCase()} ` })).toEqual({ handed_area_m2: '30000', handed_over_on: '2026-10-22', handover_document_version_id: UUID });
  });
});
