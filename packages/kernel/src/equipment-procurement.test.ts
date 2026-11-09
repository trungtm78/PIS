import { disbursementPercent, equipmentDataGuide, equipmentStage, maskEquipmentFigures, planVariance } from './equipment-procurement.ts';
import type { EquipmentFacts } from './equipment-procurement.ts';

const facts = (overrides: Partial<EquipmentFacts> = {}): EquipmentFacts => ({ itemStatus: 'ACTIVE', packageId: null, result: null, contractId: null, contractValueVnd: null, paidVnd: '0', ...overrides });

describe('equipmentStage', () => {
  it('walks from the plan to the last payment', () => {
    expect(equipmentStage(facts())).toBe('PLANNED');
    expect(equipmentStage(facts({ packageId: 'p' }))).toBe('PACKAGED');
    expect(equipmentStage(facts({ packageId: 'p', result: { outcome: 'AWARDED', status: 'SUBMITTED' } }))).toBe('PACKAGED');
    expect(equipmentStage(facts({ packageId: 'p', result: { outcome: 'AWARDED', status: 'APPROVED' } }))).toBe('SELECTED');
    expect(equipmentStage(facts({ packageId: 'p', result: { outcome: 'NO_ACCEPTABLE_BID', status: 'APPROVED' } }))).toBe('NO_AWARD');
    expect(equipmentStage(facts({ packageId: 'p', result: { outcome: 'AWARDED', status: 'APPROVED' }, contractId: 'c', contractValueVnd: '1000' }))).toBe('CONTRACTED');
    expect(equipmentStage(facts({ packageId: 'p', contractId: 'c', contractValueVnd: '1000', paidVnd: '400' }))).toBe('DISBURSING');
    expect(equipmentStage(facts({ packageId: 'p', contractId: 'c', contractValueVnd: '1000', paidVnd: '1000' }))).toBe('DISBURSED');
  });
  it('lets a cancelled line stay cancelled whatever else it has', () => {
    expect(equipmentStage(facts({ itemStatus: 'CANCELLED', packageId: 'p', contractId: 'c', contractValueVnd: '10', paidVnd: '10' }))).toBe('CANCELLED');
  });
});

describe('figures', () => {
  it('computes the share paid with one decimal, half up, and refuses a zero contract', () => {
    expect(disbursementPercent('3000', '1000')).toBe('33.3');
    expect(disbursementPercent('3000', '2000')).toBe('66.7');
    expect(disbursementPercent('1000', '1000')).toBe('100.0');
    expect(disbursementPercent(null, '5')).toBeNull();
    expect(disbursementPercent('0', '5')).toBeNull();
  });
  it('reports a saving as negative and an overrun as positive', () => {
    expect(planVariance('1000', '900')).toBe('-100');
    expect(planVariance('1000', '1200')).toBe('200');
    expect(planVariance('1000', null)).toBeNull();
  });
});

describe('maskEquipmentFigures', () => {
  const all = { contractValueVnd: '1000', paidVnd: '400', disbursementPercent: '40.0', planVarianceVnd: '-100' };
  it('shows everything to a caller who may read contracts and payments', () => {
    expect(maskEquipmentFigures(all, { contract: true, payment: true })).toEqual({ figures: all, masked: [] });
  });
  it('hides what the caller may not read and names it, so the screen never shows zero for no access', () => {
    const out = maskEquipmentFigures(all, { contract: false, payment: true });
    expect(out.masked).toEqual(['CONTRACT']);
    expect(out.figures).toEqual({ contractValueVnd: null, planVarianceVnd: null, paidVnd: '400', disbursementPercent: null });
    const none = maskEquipmentFigures(all, { contract: false, payment: false });
    expect(none.masked).toEqual(['CONTRACT', 'PAYMENT']);
    expect(Object.values(none.figures).every((value) => value === null)).toBe(true);
  });
});

describe('equipmentDataGuide', () => {
  const health = (status: 'NEVER_IMPORTED' | 'FRESH' | 'AGING' | 'STALE') => ({ status, ageHours: status === 'NEVER_IMPORTED' ? null : 10, layoutVersion: 'WORKING-ASSUMPTION-2026.2', acceptance: 'PENDING_EXTERNAL' as const });
  it('gives all the steps and keeps the pending-external word until the data is fresh', () => {
    const guide = equipmentDataGuide(health('NEVER_IMPORTED'));
    expect(guide.steps).toEqual(['DOWNLOAD', 'UPLOAD', 'DRY_RUN', 'APPLY', 'LINK']);
    expect(guide.acceptance).toBe('PENDING_EXTERNAL');
    expect(equipmentDataGuide(health('STALE')).steps.length).toBe(5);
    expect(equipmentDataGuide(health('FRESH')).steps).toEqual(['LINK']);
    expect(equipmentDataGuide(health('FRESH')).acceptance).toBe('PENDING_EXTERNAL');
  });
});
