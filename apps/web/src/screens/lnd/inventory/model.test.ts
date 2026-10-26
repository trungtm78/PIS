import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { inventoryRecord } from '../test-support';
import {
  EMPTY_ANSWER_FORM,
  EMPTY_RECORD_FORM,
  amountOf,
  answerBody,
  canAnswer,
  canCount,
  confirmedTotal,
  describeProblem,
  formatVnd,
  recordBody,
  recordsOf,
  toInventoryLine,
  validateAnswer,
  validateRecord,
} from './model';
import type { AnswerForm, InventoryLine, RecordForm } from './model';

const TODAY = '2026-10-26';
const PARCEL = '00000000-0000-4000-8000-000000100001';
const problem = (code: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions: {} });
const line = (overrides: Record<string, unknown> = {}): InventoryLine => toInventoryLine(inventoryRecord(1, overrides)) as InventoryLine;

const filled = (overrides: Partial<RecordForm> = {}): RecordForm => ({
  parcelId: PARCEL,
  itemKind: 'HOUSE',
  description: 'Nhà cấp 4',
  quantity: '80',
  unitCode: 'M2',
  unitPriceVnd: '4500000',
  priceDecisionRef: 'QD-GIA-2024',
  surveyedOn: '2026-06-20',
  documentVersionId: '',
  ...overrides,
});

describe('toInventoryLine', () => {
  it('reads a record of the list', () => {
    expect(line()).toMatchObject({
      parcelCode: 'TB-1/10',
      itemKind: 'HOUSE',
      quantity: '80.000000',
      unitPriceVnd: '4500000',
      amountVnd: '360000000',
      priceDecisionRef: 'QD-GIA-2024',
      priceDecisionRevision: 1,
      surveyedOn: '2026-06-20',
      householdConfirmedOn: null,
      confirmedBy: null,
      note: null,
      status: 'DRAFT',
      version: 1,
    });
  });

  it('keeps what is not there as nothing and drops a row it cannot read', () => {
    expect(line({ price_decision_revision: undefined, household_confirmed_on: 3, note: 7 })).toMatchObject({ priceDecisionRevision: null, householdConfirmedOn: null, note: null });
    expect(toInventoryLine(null)).toBeUndefined();
    for (const field of ['id', 'household_id', 'parcel_id', 'parcel_code', 'description', 'quantity', 'unit_code', 'unit_price_vnd', 'amount_vnd', 'price_decision_ref', 'surveyed_on', 'surveyed_by', 'version']) {
      expect(toInventoryLine(inventoryRecord(1, { [field]: undefined }))).toBeUndefined();
    }
    expect(toInventoryLine(inventoryRecord(1, { item_kind: 'SPACESHIP' }))).toBeUndefined();
    expect(toInventoryLine(inventoryRecord(1, { status: 'GONE' }))).toBeUndefined();
  });
});

describe('who may count and who may answer', () => {
  it('lets whoever holds land.process count, unless the session is read-only', () => {
    expect(canCount(['land.process'], 'FULL')).toBe(true);
    expect(canCount(undefined, undefined)).toBe(true);
    expect(canCount(['land.process'], 'READ_ONLY')).toBe(false);
    expect(canCount(['land.household.read'], 'FULL')).toBe(false);
  });

  it('lets someone other than the person who counted answer for the household, once, on a draft', () => {
    const draft = line({ surveyed_by: 'AAAA0000-0000-4000-8000-000000000001' });
    expect(canAnswer(draft, '00000000-0000-4000-8000-000000000002', ['land.process'], 'FULL')).toBe(true);
    expect(canAnswer(draft, 'aaaa0000-0000-4000-8000-000000000001', ['land.process'], 'FULL')).toBe(false);
    expect(canAnswer(draft, undefined, ['land.process'], 'FULL')).toBe(true);
    expect(canAnswer(draft, '00000000-0000-4000-8000-000000000002', ['land.household.read'], 'FULL')).toBe(false);
    expect(canAnswer(draft, '00000000-0000-4000-8000-000000000002', ['land.process'], 'READ_ONLY')).toBe(false);
    for (const status of ['CONFIRMED', 'DISPUTED', 'SUPERSEDED']) expect(canAnswer(line({ status }), '00000000-0000-4000-8000-000000000002', ['land.process'], 'FULL')).toBe(false);
  });
});

describe('amountOf', () => {
  it('multiplies the quantity by the price and rounds half up to the dong', () => {
    expect(amountOf('80', '4500000')).toBe('360000000');
    expect(amountOf(' 1.000005 ', ' 100000 ')).toBe('100001');
    expect(amountOf('0.4999', '1')).toBe('0');
    expect(amountOf('2.5', '1')).toBe('3');
    expect(amountOf('3', '0')).toBe('0');
    expect(amountOf('999999999999999999.999999', '99999999999999999999999')).toBe('99999999999999999999998900000000000000000');
  });

  it('says nothing while the two are not figures', () => {
    for (const [quantity, price] of [['', '1'], ['1', ''], ['0', '1'], ['0.000', '1'], ['-1', '1'], ['1.1234567', '1'], ['1', '1.5'], ['1', '-1'], ['a', '1'], ['01', '1']] as Array<[string, string]>) expect(amountOf(quantity, price)).toBeUndefined();
  });
});

describe('formatVnd, recordsOf and confirmedTotal', () => {
  it('writes the dots of the thousands', () => {
    expect(formatVnd('0')).toBe('0');
    expect(formatVnd('999')).toBe('999');
    expect(formatVnd('1000')).toBe('1.000');
    expect(formatVnd('360000000')).toBe('360.000.000');
  });

  const records = [line({ id: 'a', status: 'DRAFT', amount_vnd: '5' }), line({ id: 'b', status: 'CONFIRMED', amount_vnd: '7' }), line({ id: 'c', status: 'CONFIRMED', amount_vnd: '11' }), line({ id: 'd', status: 'DISPUTED', amount_vnd: '13' })];

  it('keeps the records of a status, in the order of the read, or all of them', () => {
    expect(recordsOf(records, '').map((record) => record.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(recordsOf(records, 'CONFIRMED').map((record) => record.id)).toEqual(['b', 'c']);
    expect(recordsOf(records, 'SUPERSEDED')).toEqual([]);
  });

  it('adds up the confirmed records only, exactly', () => {
    expect(confirmedTotal(records)).toBe('18');
    expect(confirmedTotal([])).toBe('0');
    expect(confirmedTotal([line({ status: 'CONFIRMED', amount_vnd: '99999999999999999999999' }), line({ status: 'CONFIRMED', amount_vnd: '1' })])).toBe('100000000000000000000000');
  });
});

describe('validateRecord and recordBody', () => {
  it('asks for everything but the minutes', () => {
    expect(validateRecord(EMPTY_RECORD_FORM, TODAY)).toEqual({
      parcelId: 'required',
      itemKind: 'required',
      description: 'required',
      quantity: 'required',
      unitCode: 'required',
      unitPriceVnd: 'required',
      priceDecisionRef: 'required',
      surveyedOn: 'required',
    });
    expect(validateRecord(filled(), TODAY)).toEqual({});
  });

  it('refuses a quantity that is not above zero with at most six decimals, and a price that is not whole dong', () => {
    for (const quantity of ['0', '0.0', '-1', '1.1234567', '01', 'x']) expect(validateRecord(filled({ quantity }), TODAY).quantity).toBe('invalid');
    for (const quantity of ['1', '0.000001', '12.5']) expect(validateRecord(filled({ quantity }), TODAY).quantity).toBeUndefined();
    for (const unitPriceVnd of ['4.5', '-1', '01', 'x']) expect(validateRecord(filled({ unitPriceVnd }), TODAY).unitPriceVnd).toBe('invalid');
    expect(validateRecord(filled({ unitPriceVnd: '0' }), TODAY).unitPriceVnd).toBeUndefined();
  });

  it('refuses text that is too long or is not text', () => {
    expect(validateRecord(filled({ description: 'x'.repeat(2001) }), TODAY).description).toBe('tooLong');
    expect(validateRecord(filled({ description: 'a\u0007b' }), TODAY).description).toBe('invalid');
    expect(validateRecord(filled({ unitCode: 'x'.repeat(51) }), TODAY).unitCode).toBe('tooLong');
    expect(validateRecord(filled({ unitCode: 'a\u0001' }), TODAY).unitCode).toBe('invalid');
    expect(validateRecord(filled({ priceDecisionRef: 'x'.repeat(101) }), TODAY).priceDecisionRef).toBe('tooLong');
    expect(validateRecord(filled({ priceDecisionRef: 'a\u0001' }), TODAY).priceDecisionRef).toBe('invalid');
  });

  it('wants a day that exists and is not to come, and minutes that are an identifier', () => {
    expect(validateRecord(filled({ surveyedOn: '2026-10-27' }), TODAY).surveyedOn).toBe('future');
    expect(validateRecord(filled({ surveyedOn: TODAY }), TODAY).surveyedOn).toBeUndefined();
    expect(validateRecord(filled({ surveyedOn: '2026-02-30' }), TODAY).surveyedOn).toBe('invalid');
    expect(validateRecord(filled({ documentVersionId: 'x' }), TODAY).documentVersionId).toBe('invalid');
    expect(validateRecord(filled({ documentVersionId: '00000000-0000-4000-8000-000000000004' }), TODAY).documentVersionId).toBeUndefined();
  });

  it('sends the figures as they were written without their spaces, and the minutes only when given', () => {
    expect(recordBody('h', filled({ description: ' Nhà ', quantity: ' 80 ', unitCode: ' M2 ', unitPriceVnd: ' 4500000 ', priceDecisionRef: ' QD-GIA-2024 ', surveyedOn: ' 2026-06-20 ' }))).toEqual({
      household_id: 'h',
      parcel_id: PARCEL,
      item_kind: 'HOUSE',
      description: 'Nhà',
      quantity: '80',
      unit_code: 'M2',
      unit_price_vnd: '4500000',
      price_decision_ref: 'QD-GIA-2024',
      surveyed_on: '2026-06-20',
    });
    expect(recordBody('h', filled({ documentVersionId: ' 00000000-0000-4000-8000-00000000000A ' })).document_version_id).toBe('00000000-0000-4000-8000-00000000000a');
  });
});

describe('validateAnswer and answerBody', () => {
  const record = line();
  const answer = (overrides: Partial<AnswerForm> = {}): AnswerForm => ({ outcome: 'CONFIRMED', answeredOn: '2026-07-01', note: '', ...overrides });

  it('asks for the outcome and the day', () => {
    expect(validateAnswer(EMPTY_ANSWER_FORM, record, TODAY)).toEqual({ outcome: 'required', answeredOn: 'required' });
    expect(validateAnswer(answer(), record, TODAY)).toEqual({});
  });

  it('wants a day that exists, is not to come and is not before the survey', () => {
    expect(validateAnswer(answer({ answeredOn: '2026-10-27' }), record, TODAY).answeredOn).toBe('future');
    expect(validateAnswer(answer({ answeredOn: '2026-06-19' }), record, TODAY).answeredOn).toBe('beforeSurvey');
    expect(validateAnswer(answer({ answeredOn: '2026-06-20' }), record, TODAY).answeredOn).toBeUndefined();
    expect(validateAnswer(answer({ answeredOn: '2026-02-30' }), record, TODAY).answeredOn).toBe('invalid');
  });

  it('wants the note of an objection, and a note that is text of a fit length', () => {
    expect(validateAnswer(answer({ outcome: 'DISPUTED' }), record, TODAY).note).toBe('required');
    expect(validateAnswer(answer({ outcome: 'DISPUTED', note: '   ' }), record, TODAY).note).toBe('required');
    expect(validateAnswer(answer({ outcome: 'DISPUTED', note: 'The area is wrong' }), record, TODAY)).toEqual({});
    expect(validateAnswer(answer({ note: 'x'.repeat(2001) }), record, TODAY).note).toBe('tooLong');
    expect(validateAnswer(answer({ note: 'a\u0007b' }), record, TODAY).note).toBe('invalid');
  });

  it('sends the note only when there is one', () => {
    expect(answerBody(answer())).toEqual({ outcome: 'CONFIRMED', household_confirmed_on: '2026-07-01' });
    expect(answerBody(answer({ outcome: 'DISPUTED', answeredOn: ' 2026-07-02 ', note: ' Wrong area ' }))).toEqual({ outcome: 'DISPUTED', household_confirmed_on: '2026-07-02', note: 'Wrong area' });
  });
});

describe('describeProblem', () => {
  it('names the refusals that have their own sentence', () => {
    expect(describeProblem(problem('PRICE_DECISION_NOT_EFFECTIVE'))).toBe('priceDecision');
    expect(describeProblem(problem('HOUSEHOLD_PARCEL_NOT_LINKED'))).toBe('parcelNotLinked');
    expect(describeProblem(problem('SELF_APPROVAL_DENIED'))).toBe('selfApproval');
    expect(describeProblem(problem('INVENTORY_STATE_INVALID'))).toBe('stateInvalid');
    expect(describeProblem(problem('VERSION_CONFLICT'))).toBe('versionConflict');
    expect(describeProblem(problem('DOCUMENT_NOT_CLEAN'))).toBe('documentNotClean');
    expect(describeProblem(problem('VALIDATION_FAILED'))).toBe('validation');
    expect(describeProblem(problem('FIELD_NOT_ALLOWED'))).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND'))).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED'))).toBe('denied');
  });

  it('says the general sentence for anything else', () => {
    expect(describeProblem(problem('SOMETHING_ELSE'))).toBe('general');
    expect(describeProblem(new Error('x'))).toBe('general');
  });
});
