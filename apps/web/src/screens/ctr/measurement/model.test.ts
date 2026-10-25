import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { toBoqLine } from '../boq-model';
import {
  EMPTY_DECIDE,
  correctBody,
  decideBody,
  describeMeasurementProblem,
  emptyCorrect,
  emptyRecord,
  evidenceIds,
  itemRows,
  mayRecord,
  measurementLink,
  micros,
  quantityText,
  recordBody,
  toMeasurement,
  validateCorrect,
  validateDecide,
  validateRecord,
} from './model';
import { UUID_A, UUID_B, lines, measurement } from './test-support';

const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

describe('the quantities of work (ST-CTR-008)', () => {
  it('counts a quantity as an exact number of millionths and refuses what is not one', () => {
    expect(micros('1')).toBe(1_000_000n);
    expect(micros(' 3500.5 ')).toBe(3_500_500_000n);
    expect(micros('-0.000001')).toBe(-1n);
    expect(micros('8000.000000')).toBe(8_000_000_000n);
    for (const bad of ['', 'x', '1.0000001', '01', '1e3', '1.', '.5', '--1', '1234567890123456789']) expect(micros(bad)).toBeUndefined();
  });

  it('writes a quantity the way the language does, with the digits that matter and no float', () => {
    expect(quantityText('8000.000000', 'vi-VN')).toBe('8.000');
    expect(quantityText('3500.500000', 'vi-VN')).toBe('3.500,5');
    expect(quantityText('0.000001', 'en-US')).toBe('0.000001');
    expect(quantityText('1234.5', 'en-US')).toBe('1,234.5');
    expect(quantityText('-2', 'en-US')).toBe('-2');
    expect(quantityText(2_000_000n, 'en-US')).toBe('2');
    expect(quantityText('not a number', 'en-US')).toBe('not a number');
    expect(quantityText(5_000_000_000_000_000_000n, 'en-US')).toBe('5,000,000,000,000');
  });

  it('links the measurements of a contract', () => {
    expect(measurementLink('c-1')).toBe('/ctr/ctr-10?contract=c-1');
  });

  it('lets a caller record when the permission is held or not yet known, and not in a read-only session', () => {
    expect(mayRecord(['measurement.record'], 'FULL')).toBe(true);
    expect(mayRecord(undefined, undefined)).toBe(true);
    expect(mayRecord(['measurement.read'], 'FULL')).toBe(false);
    expect(mayRecord(['measurement.record'], 'READ_ONLY')).toBe(false);
  });
});

describe('what the server answers', () => {
  it('reads a measurement with its item, period, evidence and what the caller may do', () => {
    expect(toMeasurement(measurement(1, { actions: { submit: true, decide: false, correct: true } }))).toMatchObject({
      id: expect.any(String),
      contract: { code: 'HD-A-001', status: 'ACTIVE' },
      contractRevisionNo: 1,
      boqItem: { businessKey: 'B01', unitCode: 'M3' },
      remainingQuantity: '4500.000000',
      period: { code: '2026-01' },
      quantityPeriod: '3500.000000',
      status: 'APPROVED',
      evidenceIds: [UUID_A],
      referenceNo: 'NK-001',
      correctionOfId: null,
      actions: { submit: true, decide: false, correct: true },
      version: 3,
    });
  });

  it('fills what is missing and refuses an answer that is not a measurement', () => {
    expect(toMeasurement({ id: 'x', version: 1, status: 'DRAFT', contract: { id: 'c' }, boq_item: { id: 'i' }, period: { id: 'p' } })).toMatchObject({
      contract: { code: '', status: '' },
      boqItem: { businessKey: '', description: '', unitCode: '' },
      quantityPeriod: '0',
      revision: 1,
      evidenceIds: [],
      referenceNo: null,
      actions: { submit: false, decide: false, correct: false },
    });
    expect(toMeasurement({ ...measurement(1), status: 'FINISHED' })).toBeUndefined();
    expect(toMeasurement({ ...measurement(1), version: 'one' })).toBeUndefined();
    expect(toMeasurement({ ...measurement(1), period: {} })).toBeUndefined();
    expect(toMeasurement({ ...measurement(1), evidence_refs: [{}, 'x', { document_version_id: UUID_B }] })?.evidenceIds).toEqual([UUID_B]);
    expect(toMeasurement({ ...measurement(1), evidence_refs: 'x' })?.evidenceIds).toEqual([]);
    expect(toMeasurement('measurement')).toBeUndefined();
    expect(toMeasurement([])).toBeUndefined();
  });
});

describe('the entry grid', () => {
  const effective = lines().flatMap((raw) => toBoqLine(raw) ?? []);

  it('has a row for each item with what was approved and what is left, and all the quantity left for an item with nothing recorded', () => {
    const recorded = [
      measurement(1, { status: 'APPROVED', quantity_period: '3500.000000', remaining_quantity: '4400.5' }),
      measurement(2, { status: 'SUBMITTED', quantity_period: '99.500000', remaining_quantity: '4400.5' }),
      measurement(3, { status: 'APPROVED', quantity_period: '0.5', remaining_quantity: '4400.5' }),
    ].flatMap((raw) => toMeasurement(raw) ?? []);
    const rows = itemRows(effective, recorded);
    expect(rows.map((row) => [row.line.businessKey, row.approved, row.remaining, row.itemId])).toEqual([
      ['B01', 3_500_500_000n, '4400.5', expect.any(String)],
      ['B02', 0n, '500', expect.any(String)],
    ]);
  });
});

describe('the forms', () => {
  it('splits the evidence at lines, commas and semicolons and lowers the case', () => {
    expect(evidenceIds(` ${UUID_A.toUpperCase()}\n${UUID_B}, ;x`)).toEqual([UUID_A, UUID_B, 'x']);
    expect(evidenceIds('  ')).toEqual([]);
  });

  it('judges the record: every field, the quantity above zero with six decimals at most, the evidence as identifiers', () => {
    expect(validateRecord(emptyRecord(''))).toEqual({ boqItemId: 'required', periodId: 'required', quantity: 'required', referenceNo: 'required' });
    const ok = { ...emptyRecord(UUID_A), periodId: UUID_B, quantity: '3500.5', referenceNo: 'NK-1' };
    expect(validateRecord(ok)).toEqual({});
    expect(validateRecord({ ...ok, periodId: 'x' }).periodId).toBe('uuid');
    expect(validateRecord({ ...ok, quantity: 'x' }).quantity).toBe('quantity');
    expect(validateRecord({ ...ok, quantity: '0' }).quantity).toBe('positive');
    expect(validateRecord({ ...ok, quantity: '-1' }).quantity).toBe('positive');
    expect(validateRecord({ ...ok, referenceNo: 'x'.repeat(2001) }).referenceNo).toBe('tooLong');
    expect(validateRecord({ ...ok, overrideReason: 'x'.repeat(2001) }).overrideReason).toBe('tooLong');
    expect(validateRecord({ ...ok, evidence: 'nope' }).evidence).toBe('uuid');
    expect(validateRecord({ ...ok, evidence: Array.from({ length: 51 }, () => UUID_A).join('\n') }).evidence).toBe('tooMany');
    expect(validateRecord({ ...ok, evidence: UUID_A })).toEqual({});
  });

  it('builds the body of the record from the form, with the reason only when it was given', () => {
    const form = { ...emptyRecord(UUID_A.toUpperCase()), periodId: UUID_B.toUpperCase(), quantity: ' 3500.5 ', referenceNo: ' NK-1 ', evidence: `${UUID_A}\n${UUID_B}` };
    expect(recordBody(form, 'revision-1')).toEqual({
      contract_revision_id: 'revision-1',
      boq_item_id: UUID_A,
      period_id: UUID_B,
      quantity_period: '3500.5',
      reference_no: 'NK-1',
      evidence_refs: [{ document_version_id: UUID_A }, { document_version_id: UUID_B }],
    });
    expect(recordBody({ ...form, overrideReason: ' same form ' }, 'revision-1')).toMatchObject({ duplicate_override_reason: 'same form' });
  });

  it('judges the correction: a quantity of zero or more, a reason, and the evidence that is always required', () => {
    expect(validateCorrect(emptyCorrect(''))).toEqual({ quantity: 'required', reason: 'required', evidence: 'required' });
    const ok = { quantity: '0', reason: 'Re-measured.', evidence: UUID_A };
    expect(validateCorrect(ok)).toEqual({});
    expect(validateCorrect({ ...ok, quantity: '-1' }).quantity).toBe('quantity');
    expect(validateCorrect({ ...ok, quantity: 'x' }).quantity).toBe('quantity');
    expect(validateCorrect({ ...ok, evidence: 'nope' }).evidence).toBe('uuid');
    expect(emptyCorrect('3500.000000').quantity).toBe('3500.000000');
    expect(correctBody({ quantity: ' 3000 ', reason: ' why ', evidence: UUID_A })).toEqual({ quantity_period: '3000', correction_reason: 'why', evidence_refs: [{ document_version_id: UUID_A }] });
  });

  it('judges the decision: one is chosen, the reason is given, the evidence is optional', () => {
    expect(validateDecide(EMPTY_DECIDE)).toEqual({ decision: 'choose', reason: 'required' });
    expect(validateDecide({ decision: 'approve', reason: 'ok', evidence: '' })).toEqual({});
    expect(validateDecide({ decision: 'approve', reason: 'ok', evidence: 'nope' }).evidence).toBe('uuid');
    expect(decideBody({ decision: 'approve', reason: ' ok ', evidence: UUID_A }, 'approve')).toEqual({ decision: 'approve', reason: 'ok', evidence_ids: [UUID_A] });
  });
});

describe('the refusals', () => {
  it('names the codes of this story and what is left of the item', () => {
    expect(describeMeasurementProblem(problem('QUANTITY_EXCEEDS_BOQ', { remaining_quantity: '0.000000' }))).toEqual({ problem: 'exceeds', remaining: '0.000000' });
    expect(describeMeasurementProblem(problem('QUANTITY_EXCEEDS_BOQ'))).toEqual({ problem: 'exceeds', remaining: undefined });
    expect(describeMeasurementProblem(problem('CUMULATIVE_DECREASE_WITHOUT_CORRECTION')).problem).toBe('decrease');
    expect(describeMeasurementProblem(problem('MEASUREMENT_REFERENCE_DUPLICATE')).problem).toBe('duplicateReference');
    expect(describeMeasurementProblem(problem('REVISION_NOT_EFFECTIVE')).problem).toBe('revisionNotEffective');
    expect(describeMeasurementProblem(problem('PERMIT_GATE_BLOCKED')).problem).toBe('permitGate');
    expect(describeMeasurementProblem(problem('MEASUREMENT_IN_ACTIVE_ACCEPTANCE')).problem).toBe('inAcceptance');
    expect(describeMeasurementProblem(problem('EVIDENCE_REQUIRED')).problem).toBe('evidenceRequired');
    expect(describeMeasurementProblem(problem('MEASUREMENT_STATE_INVALID', { reason: 'PERIOD_ALREADY_MEASURED' })).problem).toBe('periodTaken');
    expect(describeMeasurementProblem(problem('MEASUREMENT_STATE_INVALID')).problem).toBe('measurementState');
  });

  it('leaves the other codes to the words of the chain of changes, and an unknown failure is general', () => {
    expect(describeMeasurementProblem(problem('SELF_APPROVAL_DENIED')).problem).toBe('selfApproval');
    expect(describeMeasurementProblem(problem('CONTRACT_STATE_INVALID')).problem).toBe('contractState');
    expect(describeMeasurementProblem(problem('VERSION_CONFLICT')).problem).toBe('versionConflict');
    expect(describeMeasurementProblem(new Error('offline')).problem).toBe('general');
  });
});
