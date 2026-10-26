import { DomainError } from '../src/errors';
import { INVENTORY_ITEM_KINDS, INVENTORY_STATUSES, inventoryAmountVnd, normalizeQuantity, normalizeUnitPrice } from '../src/land-inventory';

const refusal = (work: () => unknown): { code: string; detail?: string } => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return { code: (error as DomainError).code, ...((error as DomainError).detail === undefined ? {} : { detail: (error as DomainError).detail }) };
  }
  throw new Error('expected a refusal');
};

describe('the inventory of the assets of a household (BR-LND-04)', () => {
  it('names the kinds of asset and the states of a record', () => {
    expect(INVENTORY_ITEM_KINDS).toEqual(['LAND', 'HOUSE', 'STRUCTURE', 'CROP', 'TREE', 'GRAVE', 'BUSINESS_LOSS', 'OTHER']);
    expect(INVENTORY_STATUSES).toEqual(['DRAFT', 'CONFIRMED', 'DISPUTED', 'SUPERSEDED']);
  });

  it('multiplies a quantity by a price in whole dong (80 m2 at 4.500.000 is 360.000.000)', () => {
    expect(inventoryAmountVnd('80', '4500000')).toBe('360000000');
    expect(inventoryAmountVnd('1200.5', '1000')).toBe('1200500');
    expect(inventoryAmountVnd('0.000001', '1000000')).toBe('1');
    expect(inventoryAmountVnd('3', '0')).toBe('0');
  });

  it('rounds half up to the dong, on whole numbers', () => {
    expect(inventoryAmountVnd('0.5', '3')).toBe('2');
    expect(inventoryAmountVnd('0.4999', '1')).toBe('0');
    expect(inventoryAmountVnd('2.5', '1')).toBe('3');
    expect(inventoryAmountVnd('1.000005', '100000')).toBe('100001');
    expect(inventoryAmountVnd('1.000000', '1000000')).toBe('1000000');
  });

  it('holds large amounts exactly', () => {
    expect(inventoryAmountVnd('999999999999999999.999999', '99999999999999999999999')).toBe('99999999999999999999998900000000000000000');
  });

  it('keeps a quantity of at most six decimals above zero, and a price in whole dong', () => {
    expect(normalizeQuantity(' 12.5 ')).toBe('12.5');
    for (const bad of ['0', '0.0', '0.000000', '-1', '1.1234567', '01', '1e3', '', 'a', '.5', '1.']) expect(refusal(() => normalizeQuantity(bad))).toEqual({ code: 'VALIDATION_FAILED', detail: 'quantity' });
    expect(normalizeUnitPrice(' 4500000 ')).toBe('4500000');
    expect(normalizeUnitPrice('0')).toBe('0');
    for (const bad of ['-1', '1.5', '01', '', 'x', '1e3']) expect(refusal(() => normalizeUnitPrice(bad))).toEqual({ code: 'VALIDATION_FAILED', detail: 'unit_price_vnd' });
  });
});
