import { describe, expect, it } from 'vitest';
import { assignment, uuid } from '../test/fixtures';
import { EMPTY_FORM, assignmentBody, checkLedger, validateForm } from './model';
import type { AssignmentForm } from './model';

const form = (over: Partial<AssignmentForm> = {}): AssignmentForm => ({ membershipId: uuid(5), role: 'RESPONSIBLE', validFrom: '2026-12-01', validTo: '', sharePct: '50', reason: 'Giao theo vai của dự án', ...over });

describe('PWF-16 form checks', () => {
  it('accepts a complete form and names no problem', () => {
    expect(validateForm(form())).toEqual({});
  });

  it('asks for every field of an empty form', () => {
    expect(Object.keys(validateForm(EMPTY_FORM)).sort()).toEqual(['membershipId', 'reason', 'sharePct', 'validFrom']);
  });

  it('wants a person id that is a uuid, a share from 1 to 100, days that are days and an end that is not before the start', () => {
    expect(validateForm(form({ membershipId: 'abc' })).membershipId).toBe('pickOne');
    expect(validateForm(form({ sharePct: '0' })).sharePct).toBe('invalidNumber');
    expect(validateForm(form({ sharePct: '101' })).sharePct).toBe('invalidNumber');
    expect(validateForm(form({ sharePct: '12.5' })).sharePct).toBe('invalidNumber');
    expect(validateForm(form({ validFrom: '2026-13-01' })).validFrom).toBe('invalidDay');
    expect(validateForm(form({ validTo: 'x' })).validTo).toBe('invalidDay');
    expect(validateForm(form({ validTo: '2026-11-30' })).validTo).toBe('invalidDay');
    expect(validateForm(form({ validTo: '2026-12-01' })).validTo).toBeUndefined();
    expect(validateForm(form({ reason: '  ' })).reason).toBe('required');
  });
});

describe('PWF-16 request body', () => {
  it('sends the trimmed fields, the share as a number and an open end as null', () => {
    expect(assignmentBody(form({ reason: ' Giao theo vai của dự án ' }))).toEqual({ membership_id: uuid(5), role: 'RESPONSIBLE', valid_from: '2026-12-01', valid_to: null, share_pct: 50, reason: 'Giao theo vai của dự án' });
    expect(assignmentBody(form({ validTo: '2026-12-31' })).valid_to).toBe('2026-12-31');
  });
});

describe('PWF-16 overlap and share check against the ledger (the server stays the authority)', () => {
  const ledger = [assignment(1, { membership_id: uuid(5), valid_from: '2026-12-01', valid_to: '2026-12-31', share_pct: 60 }), assignment(2, { membership_id: uuid(6), valid_from: '2027-01-01', valid_to: null, share_pct: 70 })];

  it('finds no problem for another role, or a period that touches nothing', () => {
    expect(checkLedger(ledger, form({ role: 'CONSULTED', membershipId: uuid(5) }))).toEqual({ overlap: false, overShare: false });
    expect(checkLedger([], form())).toEqual({ overlap: false, overShare: false });
  });

  it('finds a person who has the same role over an overlapping period', () => {
    expect(checkLedger(ledger, form({ membershipId: uuid(5), sharePct: '10', validFrom: '2026-12-15', validTo: '2027-01-15' })).overlap).toBe(true);
    expect(checkLedger(ledger, form({ membershipId: uuid(5), sharePct: '10', validFrom: '2027-01-01', validTo: '2027-01-15' })).overlap).toBe(false);
    expect(checkLedger(ledger, form({ membershipId: uuid(5), validFrom: '2026-11-01', validTo: '' })).overlap).toBe(true);
  });

  it('finds a share that adds up to more than 100 on a day of the new period', () => {
    expect(checkLedger(ledger, form({ membershipId: uuid(9), sharePct: '50', validFrom: '2026-12-10', validTo: '2026-12-20' }))).toEqual({ overlap: false, overShare: true });
    expect(checkLedger(ledger, form({ membershipId: uuid(9), sharePct: '40', validFrom: '2026-12-10', validTo: '2026-12-20' })).overShare).toBe(false);
  });

  it('counts a share that begins inside the new period, not only the one in force at its start', () => {
    const second = form({ membershipId: uuid(9), sharePct: '40', validFrom: '2026-12-20', validTo: '2027-01-10' });
    expect(checkLedger(ledger, second).overShare).toBe(true);
    expect(checkLedger(ledger, form({ membershipId: uuid(9), sharePct: '30', validFrom: '2026-12-20', validTo: '2027-01-10' })).overShare).toBe(false);
  });

  it('does not judge a form that is not a form yet', () => {
    expect(checkLedger(ledger, form({ validFrom: 'x' }))).toEqual({ overlap: false, overShare: false });
    expect(checkLedger(ledger, form({ sharePct: 'x' }))).toEqual({ overlap: false, overShare: false });
  });
});
