import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { toAcceptance } from '../acceptance/model';
import { acceptance } from '../acceptance/test-support';
import { toRequest } from '../change/model';
import type { ChangeRequest } from '../change/model';
import { request } from '../change/test-support';
import { toContractView } from '../model';
import { detail } from '../test-support';
import { ADJUST_PERMISSION, adjustBody, addDays, adjustable, delaySummary, emptyAdjustment, mismatchOf, reachable, reconciled, retroactiveLink, toggled, validateAdjustment } from './model';
import type { AdjustForm } from './model';

const UUID_A = '00000000-0000-4000-8000-0000000000a1';
const UUID_B = '00000000-0000-4000-8000-0000000000b2';
const TODAY = '2026-08-10';
const requests = (...rows: Array<Record<string, unknown>>): ChangeRequest[] => rows.flatMap(toRequest);
const co = (n: number, overrides: Record<string, unknown> = {}) => request(n, { stage: 'CO', code: `CO-00${n}`, status: 'EVALUATED', evaluated_delta_vnd: '100000000', ...overrides });
const form = (overrides: Partial<AdjustForm> = {}): AdjustForm => ({ ...emptyAdjustment('100000000'), basis: ' The owner agreed. ', documentVersionId: UUID_A, effectiveOn: '2026-06-01', affected: [UUID_B], ...overrides });
const failure = (extensions: Record<string, unknown>) => new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c', extensions });

describe('the address of the screen', () => {
  it('names the contract and, when it is known, the change order', () => {
    expect(ADJUST_PERMISSION).toBe('change.retroactive.approve');
    expect(retroactiveLink('c1')).toBe('/ctr/ctr-14?id=c1');
    expect(retroactiveLink('c1', 'r1')).toBe('/ctr/ctr-14?id=c1&request=r1');
  });
});

describe('the delay summary of a contract (ST-CTR-016)', () => {
  it('adds a day count to a day, in either direction, over the end of a month and a leap year; a text that is no day moves nowhere', () => {
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-25', 0)).toBe('2026-12-25');
    expect(addDays('soon', 1)).toBeNull();
  });

  it('UI-CTR-14: adds the days of the approved COs of the contract to its completion day and keeps apart the days of the ones that wait', () => {
    const rows = requests(
      co(1, { status: 'APPROVED', schedule_impact_days: 20, effective_on: '2026-06-01', retroactive: true }),
      co(2, { status: 'APPROVED', schedule_impact_days: -5 }),
      co(3, { status: 'EVALUATED', schedule_impact_days: 7 }),
      co(4, { status: 'SUBMITTED', schedule_impact_days: 99 }),
      co(5, { status: 'APPROVED', schedule_impact_days: 40, contract: { id: 'other', code: 'HD-Z', status: 'ACTIVE' } }),
      request(6, { stage: 'PCO', status: 'EVALUATED', schedule_impact_days: 50 }),
    );
    const summary = delaySummary(rows, request(1).contract.id, '2026-12-25');
    expect(summary).toMatchObject({ approvedDays: 15, waitingDays: 7, plannedDue: '2026-12-25', forecastDue: '2027-01-09' });
    expect(summary.lines.map((line) => [line.code, line.status, line.days, line.retroactive])).toEqual([
      ['CO-001', 'APPROVED', 20, true],
      ['CO-002', 'APPROVED', -5, false],
      ['CO-003', 'EVALUATED', 7, false],
    ]);
  });

  it('has no forecast for a contract without a completion day, and nothing to add for a guest contractor who reads no assessment', () => {
    const rows = requests(co(1, { status: 'APPROVED', schedule_impact_days: 20 }));
    expect(delaySummary(rows, request(1).contract.id, null)).toMatchObject({ approvedDays: 20, plannedDue: null, forecastDue: null });
    const guest = [{ ...rows[0]!, detail: undefined }];
    expect(delaySummary(guest, request(1).contract.id, '2026-12-25')).toMatchObject({ approvedDays: 0, waitingDays: 0, forecastDue: '2026-12-25', lines: [] });
    expect(delaySummary([], request(1).contract.id, '2026-12-25').lines).toEqual([]);
  });
});

describe('which change orders may be adjusted', () => {
  it('is the assessed COs of the contract that the server says the caller may adjust', () => {
    const contract = request(1).contract.id;
    const rows = requests(
      co(1, { actions: { promote: false, evaluate: true, withdraw: true, decide: true, adjust: true } }),
      co(2, { actions: { promote: false, evaluate: true, withdraw: true, decide: true, adjust: false } }),
      co(3, { status: 'APPROVED', actions: { promote: false, evaluate: false, withdraw: false, decide: false, adjust: true } }),
      request(4, { stage: 'PCO', status: 'EVALUATED', actions: { promote: false, evaluate: true, withdraw: true, decide: false, adjust: true } }),
      co(5, { contract: { id: 'other', code: 'HD-Z', status: 'ACTIVE' }, actions: { promote: false, evaluate: true, withdraw: true, decide: true, adjust: true } }),
      co(6),
    );
    expect(adjustable(rows, contract).map((each) => each.code)).toEqual(['CO-001']);
  });

  it('reads the right of the action and the retroactive flag from the answer of the board, and a missing flag as no', () => {
    const [adjustableCo, plain] = requests(co(1, { actions: { promote: false, evaluate: true, withdraw: true, decide: true, adjust: true }, retroactive: true }), co(2));
    expect(adjustableCo).toMatchObject({ actions: { adjust: true }, retroactive: true });
    expect(plain).toMatchObject({ actions: { adjust: false }, retroactive: false });
  });
});

describe('the form of the adjustment', () => {
  it('starts from the assessed amount, with the day and the paper still to be given', () => {
    expect(emptyAdjustment('250000000')).toEqual({ basis: '', documentVersionId: '', effectiveOn: '', approvedDeltaVnd: '250000000', boqLines: '', affected: [] });
    expect(emptyAdjustment(null).approvedDeltaVnd).toBe('');
  });

  it('AC-ST-CTR-016-1: accepts a form that names a past day, a document, an amount and the words of the basis', () => {
    expect(validateAdjustment(form(), TODAY)).toEqual({});
    expect(validateAdjustment(form({ boqLines: '[{"business_key":"B02"}]', approvedDeltaVnd: '-5' }), TODAY)).toEqual({});
  });

  it('asks for every field the server asks for, and says what is wrong with each', () => {
    expect(validateAdjustment(form({ basis: '  ', documentVersionId: '', effectiveOn: '', approvedDeltaVnd: '' }), TODAY)).toEqual({ basis: 'required', documentVersionId: 'required', effectiveOn: 'required', approvedDeltaVnd: 'required' });
    expect(validateAdjustment(form({ basis: 'x'.repeat(2001), documentVersionId: 'nope', effectiveOn: '2026-02-30', approvedDeltaVnd: '5e8', boqLines: '{' }), TODAY)).toEqual({
      basis: 'tooLong',
      documentVersionId: 'uuid',
      effectiveOn: 'date',
      approvedDeltaVnd: 'amount',
      boqLines: 'json',
    });
  });

  it('takes only a day before today: today and a later day go through the ordinary decision', () => {
    expect(validateAdjustment(form({ effectiveOn: '2026-08-09' }), TODAY).effectiveOn).toBeUndefined();
    expect(validateAdjustment(form({ effectiveOn: TODAY }), TODAY).effectiveOn).toBe('notPast');
    expect(validateAdjustment(form({ effectiveOn: '2999-01-01' }), TODAY).effectiveOn).toBe('notPast');
  });

  it('takes no more than five hundred acceptances', () => {
    expect(validateAdjustment(form({ affected: Array.from({ length: 500 }, (_, n) => `a${n}`) }), TODAY).affected).toBeUndefined();
    expect(validateAdjustment(form({ affected: Array.from({ length: 501 }, (_, n) => `a${n}`) }), TODAY).affected).toBe('tooMany');
  });

  it('builds the body the server takes: the words trimmed, the identifiers in small letters once and in order, the amount as written by the number, the lines when there are some', () => {
    expect(adjustBody(form({ documentVersionId: UUID_A.toUpperCase(), affected: [UUID_B.toUpperCase(), UUID_A, UUID_B], approvedDeltaVnd: ' -0050 ' }))).toEqual({
      adjustment_basis: 'The owner agreed.',
      decision_document_version_id: UUID_A,
      affected_acceptance_ids: [UUID_A, UUID_B],
      effective_on: '2026-06-01',
      approved_delta_vnd: '-50',
    });
    expect(adjustBody(form({ boqLines: '[{"business_key":"B02","unit_price":"2100000"}]' })).boq_lines).toEqual([{ business_key: 'B02', unit_price: '2100000' }]);
  });
});

describe('the acceptances the change may reach', () => {
  const rows = [
    toAcceptance(acceptance(1, { status: 'APPROVED', accepted_on: '2026-05-31' })),
    toAcceptance(acceptance(2, { status: 'APPROVED', accepted_on: '2026-06-01' })),
    toAcceptance(acceptance(3, { status: 'APPROVED', accepted_on: '2026-07-25' })),
    toAcceptance(acceptance(4, { status: 'SUBMITTED', accepted_on: '2026-07-25' })),
    toAcceptance(acceptance(5, { status: 'REVOKED', accepted_on: '2026-07-25' })),
  ].flatMap((each) => (each === undefined ? [] : [each]));

  it('is the approved ones accepted on the effective day or after', () => {
    expect(reachable(rows, '2026-06-01').map((each) => each.acceptanceNo)).toEqual(['NT-002', 'NT-003']);
    expect(reachable(rows, '2026-07-26')).toEqual([]);
  });

  it('is none until the day is a day', () => {
    expect(reachable(rows, '')).toEqual([]);
    expect(reachable(rows, '2026-13-01')).toEqual([]);
  });

  it('puts an acceptance on the list or takes it off', () => {
    expect(toggled([], 'a')).toEqual(['a']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('what the server says is wrong with the list', () => {
  it('reads the acceptances it left out and the ones it did not count', () => {
    expect(mismatchOf(failure({ reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [UUID_A], unexpected_acceptance_ids: [UUID_B] }))).toEqual({ missing: [UUID_A], unexpected: [UUID_B] });
    expect(mismatchOf(failure({ reason: 'AFFECTED_MISMATCH' }))).toEqual({ missing: [], unexpected: [] });
    expect(mismatchOf(failure({ reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [1, UUID_A, null] }))?.missing).toEqual([UUID_A]);
  });

  it('knows no other refusal as that one', () => {
    expect(mismatchOf(failure({ reason: 'NOT_RETROACTIVE' }))).toBeUndefined();
    expect(mismatchOf(new Error('boom'))).toBeUndefined();
    expect(mismatchOf(undefined)).toBeUndefined();
  });

  it('puts the list as the server found it: the ones left out added, the ones not affected taken out', () => {
    expect(reconciled([UUID_A, UUID_B], { missing: ['c', UUID_A], unexpected: [UUID_B] })).toEqual([UUID_A, 'c']);
    expect(reconciled([], { missing: [], unexpected: [] })).toEqual([]);
  });
});

describe('the contract as the register answers it with its adjustments', () => {
  const record = {
    id: 'adj1',
    change_request_id: 'req1',
    change_request_code: 'CO-002',
    revision_id: 'rev2',
    effective_on: '2026-06-01',
    approved_on: '2026-08-10',
    basis: 'The owner agreed.',
    decision_document_version_id: UUID_A,
    total_delta_vnd: '-1000',
    affected: [
      { id: 'l1', acceptance_id: UUID_B, acceptance_no: 'NT-001', boq_item_key: 'B02', party_id: null, quantity: '10.000000', old_amount_vnd: '10000', new_unit_price: '900.000000', new_amount_vnd: '9000', delta_vnd: '-1000' },
      { nope: true },
    ],
  };

  it('reads the day, the basis, the total and the balances that moved; a record that lacks its day or its total is left out', () => {
    const view = toContractView(detail(1, { retroactive_adjustments: [record, { ...record, id: 'adj2', effective_on: undefined }, { ...record, id: 'adj3', total_delta_vnd: undefined }, 'x'] }));
    expect(view?.retroactiveAdjustments).toHaveLength(1);
    expect(view?.retroactiveAdjustments[0]).toEqual({
      id: 'adj1',
      changeRequestId: 'req1',
      changeRequestCode: 'CO-002',
      revisionId: 'rev2',
      effectiveOn: '2026-06-01',
      approvedOn: '2026-08-10',
      basis: 'The owner agreed.',
      decisionDocumentVersionId: UUID_A,
      totalDeltaVnd: '-1000',
      affected: [{ id: 'l1', acceptanceId: UUID_B, acceptanceNo: 'NT-001', boqItemKey: 'B02', partyId: null, quantity: '10.000000', oldAmountVnd: '10000', newUnitPrice: '900.000000', newAmountVnd: '9000', deltaVnd: '-1000' }],
    });
  });

  it('has none for a reader without the right to the ledger, whose answer has none', () => {
    expect(toContractView(detail(1))?.retroactiveAdjustments).toEqual([]);
  });
});
