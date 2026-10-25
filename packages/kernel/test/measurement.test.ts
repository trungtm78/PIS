import type { DomainError } from '../src/errors';
import {
  LIVE_MEASUREMENT_STATUSES,
  MEASUREMENT_COMMANDS,
  MEASUREMENT_STATUSES,
  assertMeasurementTransition,
  assertNotDecrease,
  assertWithinBoq,
  cumulativeQuantity,
  measurementTarget,
  quantityOf,
  remainingQuantity,
} from '../src/measurement';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

describe('the quantities of work (ST-CTR-008)', () => {
  it('writes a quantity with six digits after the point, and refuses what is not one', () => {
    expect(quantityOf('1', 'quantity_period')).toBe('1.000000');
    expect(quantityOf(' 0.000001 ', 'quantity_period')).toBe('0.000001');
    expect(quantityOf('-500', 'quantity_period')).toBe('-500.000000');
    expect(quantityOf('3500.5', 'quantity_period')).toBe('3500.500000');
    for (const bad of ['', 'x', '1.0000001', '01', '1e3', '--1', '1.', '.5', '1234567890123456789']) {
      expect(refusal(() => quantityOf(bad, 'quantity_period'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'quantity_period' });
    }
  });

  it('AC-ST-CTR-008-2, UAT-AC312: counts what is left of the quantity of an item, never below zero, with six digits', () => {
    expect(remainingQuantity('8000.000000', '7999.000000')).toBe('1.000000');
    expect(remainingQuantity('8000', '8000.000000')).toBe('0.000000');
    expect(remainingQuantity('8000', '8000.000001')).toBe('0.000000');
    expect(remainingQuantity('8100', '8000')).toBe('100.000000');
  });

  it('AC-ST-CTR-008-2, UAT-AC312: lets the total reach the quantity of the item exactly and refuses one millionth more', () => {
    expect(() => assertWithinBoq('8000.000000', '7999.000000', '1.000000')).not.toThrow();
    const error = refusal(() => assertWithinBoq('8000.000000', '8000.000000', '0.000001'));
    expect(error).toMatchObject({ code: 'QUANTITY_EXCEEDS_BOQ', status: 422, detail: 'quantity_period', extensions: { remaining_quantity: '0.000000', boq_quantity: '8000.000000', total_quantity: '8000.000001' } });
    expect(refusal(() => assertWithinBoq('8000', '7999', '2')).extensions).toMatchObject({ remaining_quantity: '1.000000' });
    // After a change order raises the quantity to 8,100 the same 2 m3 fits: 8,000 + 2.
    expect(() => assertWithinBoq('8100', '8000', '2')).not.toThrow();
  });

  it('AC-ST-CTR-008-1, UAT-AC311: refuses a period that takes quantity away', () => {
    expect(refusal(() => assertNotDecrease('-500.000000'))).toMatchObject({ code: 'CUMULATIVE_DECREASE_WITHOUT_CORRECTION', status: 422, detail: 'quantity_period' });
    expect(() => assertNotDecrease('0.000000')).not.toThrow();
    expect(() => assertNotDecrease('1')).not.toThrow();
  });

  it('adds the period to what was approved, exactly', () => {
    expect(cumulativeQuantity('7999.000000', '1')).toBe('8000.000000');
    expect(cumulativeQuantity('0', '3500')).toBe('3500.000000');
    expect(cumulativeQuantity('0.1', '0.2')).toBe('0.300000');
  });
});

describe('the life of a measurement', () => {
  it('moves along the edges and nowhere else', () => {
    expect(measurementTarget('submit', 'DRAFT')).toBe('SUBMITTED');
    expect(measurementTarget('approve', 'SUBMITTED')).toBe('APPROVED');
    expect(measurementTarget('reject', 'SUBMITTED')).toBe('REJECTED');
    expect(measurementTarget('return', 'SUBMITTED')).toBe('DRAFT');
    expect(measurementTarget('supersede', 'APPROVED')).toBe('SUPERSEDED');
    for (const command of MEASUREMENT_COMMANDS) {
      const taken = MEASUREMENT_STATUSES.filter((status) => measurementTarget(command, status) !== undefined);
      expect(taken).toHaveLength(1);
    }
    expect(measurementTarget('submit', 'SUBMITTED')).toBeUndefined();
    expect(measurementTarget('supersede', 'DRAFT')).toBeUndefined();
  });

  it('answers 409 MEASUREMENT_STATE_INVALID with the status for a command that does not apply', () => {
    expect(assertMeasurementTransition('approve', 'SUBMITTED')).toBe('APPROVED');
    expect(refusal(() => assertMeasurementTransition('approve', 'DRAFT'))).toMatchObject({ code: 'MEASUREMENT_STATE_INVALID', status: 409, extensions: { measurement_status: 'DRAFT' } });
    expect(refusal(() => assertMeasurementTransition('supersede', 'SUBMITTED', 'NOT_APPROVED')).extensions).toEqual({ measurement_status: 'SUBMITTED', reason: 'NOT_APPROVED' });
  });

  it('counts a draft, a submitted and an approved measurement against the item, and not a rejected or corrected one', () => {
    expect([...LIVE_MEASUREMENT_STATUSES]).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED']);
  });
});
