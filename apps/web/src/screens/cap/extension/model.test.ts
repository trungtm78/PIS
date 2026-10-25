import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_DECISION, EMPTY_FORM, describeProblem, formatVnd, mayDecide, openRequestsOf, requestBody, toAvailability, toExtension, undisbursedOf, validateDecision, validateForm, windowOf } from './model';
import type { ExtensionEntry, ExtensionForm } from './model';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-0000000000f1';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';

const entry = (extra: Partial<ExtensionEntry> = {}): ExtensionEntry => ({
  id: 'e1',
  allocationLineId: 'l1',
  projectId: 'p1',
  fromPlanYear: 2025,
  extendedTo: '2026-01-31',
  amountVnd: '1000',
  reasonCode: 'GPMB_CHAM',
  justification: undefined,
  approvingDocumentId: undefined,
  status: 'REQUESTED',
  newAllocationLineId: undefined,
  newAppropriationId: undefined,
  requestedBy: OTHER,
  decidedBy: undefined,
  decidedAt: undefined,
  decisionReason: undefined,
  version: 1,
  ...extra,
});

const valid: ExtensionForm = { planId: 'plan', lineId: 'l1', amountVnd: '3000000000', extendedTo: '2026-01-31', reasonCode: 'GPMB_CHAM', justification: '' };
const context = { year: 2025, undisbursedVnd: '3000000000' };

describe('CAP-20 model (ST-CAP-007)', () => {
  it('reads a request and drops what has no id', () => {
    const row = toExtension({ id: 'a', allocation_line_id: 'l', project_id: 'p', from_plan_year: 2025, extended_to: '2026-03-31', amount_vnd: '5', reason_code: 'KHAC', justification: 'x', status: 'APPLIED', requested_by: 'u', decided_by: 'v', version: 2, new_allocation_line_id: 'n' });
    expect(row).toMatchObject({ id: 'a', allocationLineId: 'l', fromPlanYear: 2025, amountVnd: '5', reasonCode: 'KHAC', status: 'APPLIED', decidedBy: 'v', newAllocationLineId: 'n', version: 2 });
    expect(toExtension({ amount_vnd: '5' })).toBeUndefined();
    expect(toExtension({ id: 'b', status: 'weird', reason_code: 'weird' })).toMatchObject({ status: 'REQUESTED', reasonCode: 'KHAC', amountVnd: '0', version: 0 });
    expect(toExtension(undefined)).toBeUndefined();
  });

  it('works out what is left on a line: allocated less committed, disbursed and the other open requests, never below zero', () => {
    const figures = toAvailability({ allocated_vnd: '10000', committed_vnd: '3000', disbursed_vnd: '4000' });
    expect(figures).toEqual({ allocatedVnd: '10000', committedVnd: '3000', disbursedVnd: '4000' });
    expect(undisbursedOf(figures, '0')).toBe('3000');
    expect(undisbursedOf(figures, '1000')).toBe('2000');
    expect(undisbursedOf(figures, '9000')).toBe('0');
    expect(undisbursedOf(toAvailability(undefined), '0')).toBe('0');
    expect(undisbursedOf({ allocatedVnd: 'x', committedVnd: '1', disbursedVnd: '1' }, '0')).toBe('0');
  });

  it('adds up the requests of a line that still wait, and only those', () => {
    const entries = [entry({ amountVnd: '100' }), entry({ id: 'e2', amountVnd: '200', status: 'APPROVED' }), entry({ id: 'e3', amountVnd: '400', status: 'APPLIED' }), entry({ id: 'e4', amountVnd: '800', allocationLineId: 'other' })];
    expect(openRequestsOf(entries, 'l1')).toBe('300');
    expect(openRequestsOf([], 'l1')).toBe('0');
  });

  it('writes whole VND with the separators of the language and leaves anything else as it came', () => {
    expect(formatVnd('3000000000', 'en')).toBe('3,000,000,000');
    expect(formatVnd('3000000000', 'vi')).toBe(BigInt('3000000000').toLocaleString('vi'));
    expect(formatVnd('oops', 'en')).toBe('oops');
  });

  it('knows the window of the last day: the year after the plan year', () => {
    expect(windowOf(2025)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('accepts a request the server accepts and builds its body', () => {
    expect(validateForm(valid, context)).toEqual({});
    expect(requestBody(valid)).toEqual({ amount_vnd: '3000000000', extended_to: '2026-01-31', reason_code: 'GPMB_CHAM' });
    expect(requestBody({ ...valid, justification: '  Mặt bằng chưa bàn giao do vướng hộ dân  ' })).toMatchObject({ justification: 'Mặt bằng chưa bàn giao do vướng hộ dân' });
  });

  it('names every problem of the form, as the server does (UAT-PLAN-61)', () => {
    expect(validateForm(EMPTY_FORM, { year: undefined, undisbursedVnd: undefined })).toEqual({ lineId: 'required', amountVnd: 'required', extendedTo: 'required', reasonCode: 'required' });
    expect(validateForm({ ...valid, amountVnd: '1.5' }, context).amountVnd).toBe('notWhole');
    expect(validateForm({ ...valid, amountVnd: '0' }, context).amountVnd).toBe('notWhole');
    expect(validateForm({ ...valid, amountVnd: '3000000001' }, context).amountVnd).toBe('exceeds');
    expect(validateForm({ ...valid, amountVnd: '3000000001' }, { year: 2025, undisbursedVnd: undefined }).amountVnd).toBeUndefined();
    expect(validateForm({ ...valid, extendedTo: '2026-02-30' }, context).extendedTo).toBe('notDate');
    expect(validateForm({ ...valid, extendedTo: '2025-12-31' }, context).extendedTo).toBe('tooEarly');
    expect(validateForm({ ...valid, extendedTo: '2027-01-01' }, context).extendedTo).toBe('tooLate');
    expect(validateForm({ ...valid, reasonCode: 'KHAC' }, context).justification).toBe('justificationRequired');
    expect(validateForm({ ...valid, justification: 'short' }, context).justification).toBe('justificationLength');
    expect(validateForm({ ...valid, reasonCode: 'KHAC', justification: 'Đề nghị kéo dài do thay đổi thiết kế' }, context)).toEqual({});
  });

  it('asks the approver for the document and a reason, and the rejecter for a reason only', () => {
    expect(validateDecision('approve', EMPTY_DECISION)).toEqual({ documentId: 'required', reason: 'reasonLength' });
    expect(validateDecision('approve', { documentId: 'nope', reason: 'Đã đủ căn cứ' })).toEqual({ documentId: 'invalidId' });
    expect(validateDecision('approve', { documentId: DOCUMENT.toUpperCase(), reason: 'Đã đủ căn cứ' })).toEqual({});
    expect(validateDecision('reject', { documentId: '', reason: 'Chưa đủ căn cứ' })).toEqual({});
    expect(validateDecision('reject', { documentId: '', reason: 'no' })).toEqual({ reason: 'reasonLength' });
  });

  it('offers a decision only on a request that waits and that the person did not make (UAT-AC158 style four eyes)', () => {
    expect(mayDecide(entry(), ME)).toBe(true);
    expect(mayDecide(entry({ requestedBy: ME }), ME)).toBe(false);
    expect(mayDecide(entry({ requestedBy: ME.toUpperCase() }), ME)).toBe(false);
    expect(mayDecide(entry({ status: 'APPLIED' }), ME)).toBe(false);
    expect(mayDecide(entry(), undefined)).toBe(false);
  });

  it('sorts a refusal of the server by its code and keeps what it says about the amount and the reason', () => {
    const refusal = (code: string, detail?: string, extensions: Record<string, unknown> = {}) => describeProblem(new ApiError({ status: 422, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions }));
    expect(refusal('AMOUNT_EXCEEDS_UNDISBURSED', 'amount_vnd', { undisbursed_vnd: '1500' })).toMatchObject({ reason: 'amountExceeds', undisbursedVnd: '1500' });
    expect(refusal('EXTENSION_NOT_ALLOWED', 'allocation_line_id', { reason: 'ALREADY_EXTENDED' })).toMatchObject({ reason: 'notAllowed', why: 'ALREADY_EXTENDED' });
    expect(refusal('EXTENSION_DOCUMENT_REQUIRED').reason).toBe('documentRequired');
    expect(refusal('SELF_APPROVAL_DENIED').reason).toBe('selfApproval');
    expect(refusal('VERSION_CONFLICT').reason).toBe('conflict');
    expect(refusal('STAGE_TRANSITION_DENIED').reason).toBe('stageDenied');
    expect(refusal('FISCAL_YEAR_LOCKED').reason).toBe('yearLocked');
    expect(refusal('APPROPRIATION_DUPLICATE').reason).toBe('duplicate');
    expect(refusal('VALIDATION_FAILED', 'extended_to')).toMatchObject({ reason: 'invalid', field: 'extended_to' });
    expect(refusal('SCOPE_DENIED').reason).toBe('denied');
    expect(refusal('RESOURCE_NOT_FOUND').reason).toBe('notFound');
    expect(refusal('SESSION_EXPIRED').reason).toBe('session');
    expect(refusal('SOMETHING_ELSE').reason).toBe('general');
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined, undisbursedVnd: undefined, why: undefined });
  });
});
