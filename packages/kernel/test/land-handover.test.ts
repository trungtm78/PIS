import { HANDOVER_CATEGORIES, HANDOVER_READY_PARCEL_STATUSES, handedRatio, receivesSite, sectionStatusFor } from '../src/index.ts';

describe('the status of a section from what has been handed over', () => {
  it('AC-ST-LND-009-1, UAT-AC386: is NOT_READY with nothing handed over, PARTIAL in between and HANDED_OVER when all of it is', () => {
    expect(sectionStatusFor('0.00', '30000.00')).toBe('NOT_READY');
    expect(sectionStatusFor('0', '30000.00')).toBe('NOT_READY');
    expect(sectionStatusFor('18000.00', '30000.00')).toBe('PARTIAL');
    expect(sectionStatusFor('29999.99', '30000.00')).toBe('PARTIAL');
    expect(sectionStatusFor('30000.00', '30000.00')).toBe('HANDED_OVER');
    expect(sectionStatusFor('30000', '30000.00')).toBe('HANDED_OVER');
  });
});

describe('the contracts that receive a site', () => {
  it('are the contracts that build: construction and EPC', () => {
    expect(HANDOVER_CATEGORIES).toEqual(['CONSTRUCTION', 'EPC']);
    expect(receivesSite('CONSTRUCTION')).toBe(true);
    expect(receivesSite('EPC')).toBe(true);
    for (const other of ['EQUIPMENT', 'CONSULTING', 'LAND_CLEARANCE', 'OTHER', '']) expect(receivesSite(other)).toBe(false);
  });

  it('hand over a parcel whose compensation is paid, and one that was handed over already', () => {
    expect(HANDOVER_READY_PARCEL_STATUSES).toEqual(['PAID', 'HANDED_OVER']);
  });
});

describe('handedRatio (BR-LND-06)', () => {
  it('AC-ST-LND-009-1, UAT-AC386: computes the share of the project that was handed over, to two decimals, on exact figures', () => {
    expect(handedRatio('30000.00', '58000.00')).toBe('51.72');
    expect(handedRatio('0.00', '58000.00')).toBe('0.00');
    expect(handedRatio('58000.00', '58000.00')).toBe('100.00');
    expect(handedRatio('1.00', '3.00')).toBe('33.33');
    expect(handedRatio('2.00', '3.00')).toBe('66.67');
  });

  it('rounds half up and takes whole numbers and short fractions', () => {
    expect(handedRatio('1', '8')).toBe('12.50');
    expect(handedRatio('1.5', '8')).toBe('18.75');
    expect(handedRatio('1.00', '16.00')).toBe('6.25');
    expect(handedRatio('0.01', '16.00')).toBe('0.06');
  });

  it('is zero when nothing is required', () => {
    expect(handedRatio('0.00', '0.00')).toBe('0.00');
    expect(handedRatio('0', '0')).toBe('0.00');
  });

  it('handles the widest area a column holds without losing a digit', () => {
    expect(handedRatio('999999999999.99', '999999999999.99')).toBe('100.00');
    expect(handedRatio('499999999999.99', '999999999999.99')).toBe('50.00');
  });
});
