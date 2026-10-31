import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  acknowledgeBody,
  canFile,
  describeProblem,
  emptyAcknowledge,
  emptyFile,
  emptyFix,
  emptyVerify,
  fileBody,
  fixBody,
  isDay,
  laneOf,
  toClaim,
  toObligationOption,
  validateAcknowledge,
  validateFile,
  validateFix,
  validateVerify,
  verifyBody,
  vietnamToday,
} from './model';
import type { ClaimLine, ObligationOption, Status } from './model';

const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const UUID = '00000000-0000-4000-8000-000000000001';
const OBLIGATION: ObligationOption = { id: UUID, contractCode: 'HD-001', handoverNo: 'BG-001', scope: 'Pump house', startsOn: '2026-09-01', endsOn: '2027-09-01', contractor: { id: '00000000-0000-4000-8000-0000000000c1', name: 'An Phat' } };
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  claim_no: 'WC-001',
  obligation: { id: UUID, ends_on: '2027-09-01', status: 'ACTIVE' },
  contract: { id: 'k-1', code: 'HD-001' },
  handover: { id: 'h-1', handover_no: 'BG-001' },
  severity: 'MAJOR',
  defect_description: 'Crack',
  location_text: null,
  responder: { id: 'r-1', name: 'An Phat' },
  reported_on: '2027-01-10',
  response_due_on: '2027-01-17',
  committed_fix_on: null,
  fixed_on: null,
  cost_borne_by: 'UNDETERMINED',
  status: 'OPEN',
  overdue: true,
  issue: { id: 'i-1', code: 'ISS-001' },
  allowed: { acknowledge: true, fix: false, verify: false },
  version: 1,
  ...overrides,
});
const claim = (overrides: Partial<ClaimLine> = {}): ClaimLine => ({ ...(toClaim(raw()) as ClaimLine), ...overrides });

describe('the claims against a warranty (AST-05, ST-AST-004)', () => {
  it('reads a claim with its contractor, its issue and what the caller may do, and drops what is not one', () => {
    expect(toClaim(raw())).toMatchObject({
      id: 'c-1',
      claimNo: 'WC-001',
      severity: 'MAJOR',
      status: 'OPEN',
      overdue: true,
      responder: { id: 'r-1', name: 'An Phat' },
      issue: { id: 'i-1', code: 'ISS-001' },
      allowed: { acknowledge: true, fix: false, verify: false },
      version: 1,
      handoverNo: 'BG-001',
    });
    expect(toClaim(raw({ responder: null, issue: null, allowed: undefined, version: 'x', cost_borne_by: 'NOPE', overdue: false, location_text: 'North wall' }))).toMatchObject({
      responder: null,
      issue: null,
      allowed: { acknowledge: false, fix: false, verify: false },
      version: 0,
      costBorneBy: 'UNDETERMINED',
      overdue: false,
      location: 'North wall',
    });
    expect(toClaim(raw({ responder: { id: 'r-2' }, issue: { id: 'i-2' } }))).toMatchObject({ responder: { name: '' }, issue: { code: '' } });
    expect(toClaim(raw())).toMatchObject({ evidence: { documentId: null, photoId: null }, fixEvidence: { documentId: null, photoId: null }, fixNote: null, verificationNote: null });
    expect(toClaim(raw({ evidence_document_version_id: 'd-1', evidence_photo_id: 'p-1', fix_evidence_document_version_id: 'd-2', fix_evidence_photo_id: 'p-2', fix_note: 'Repaired', verification_note: 'Still cracked' }))).toMatchObject({
      evidence: { documentId: 'd-1', photoId: 'p-1' },
      fixEvidence: { documentId: 'd-2', photoId: 'p-2' },
      fixNote: 'Repaired',
      verificationNote: 'Still cracked',
    });
    for (const bad of [null, 'x', [], raw({ id: 1 }), raw({ claim_no: undefined }), raw({ obligation: null }), raw({ severity: 'HUGE' }), raw({ status: 'NOPE' }), raw({ reported_on: undefined }), raw({ response_due_on: undefined })]) expect(toClaim(bad)).toBeUndefined();
  });

  it('puts each status in a column of the board', () => {
    const lanes: Array<[Status, string]> = [
      ['OPEN', 'OPEN'],
      ['ACKNOWLEDGED', 'IN_PROGRESS'],
      ['REPAIRING', 'IN_PROGRESS'],
      ['FIXED', 'FIXED'],
      ['DISPUTED', 'DISPUTED'],
      ['VERIFIED', 'VERIFIED'],
      ['CLOSED', 'VERIFIED'],
    ];
    expect(lanes.map(([status]) => laneOf(status))).toEqual(lanes.map(([, lane]) => lane));
  });

  it('offers only the obligations still running, with the contractor of the contract', () => {
    const row = { id: UUID, contract: { code: 'HD-001' }, handover: { handover_no: 'BG-001' }, scope_description: 'Pump house', starts_on: '2026-09-01', ends_on: '2027-09-01', contractor: { id: 'c-1', name: 'An Phat' }, status: 'ACTIVE' };
    expect(toObligationOption(row)).toEqual([{ id: UUID, contractCode: 'HD-001', handoverNo: 'BG-001', scope: 'Pump house', startsOn: '2026-09-01', endsOn: '2027-09-01', contractor: { id: 'c-1', name: 'An Phat' } }]);
    expect(toObligationOption({ ...row, contractor: null, contract: undefined, handover: undefined, scope_description: undefined })).toMatchObject([{ contractor: null, contractCode: '', handoverNo: null, scope: '' }]);
    expect(toObligationOption({ ...row, contractor: { id: 'c-2' } })).toMatchObject([{ contractor: { name: '' } }]);
    for (const bad of [{ ...row, status: 'EXPIRED' }, { ...row, status: 'CLOSED' }, { ...row, id: undefined }, { ...row, starts_on: undefined }, { ...row, ends_on: undefined }, null, 'x']) expect(toObligationOption(bad)).toEqual([]);
  });

  it('is for the holders of the right, and not while the tenant is read-only', () => {
    expect([canFile(['warranty.claim'], 'FULL'), canFile(undefined, undefined), canFile(['warranty.claim'], 'READ_ONLY'), canFile(['warranty.read'], 'FULL')]).toEqual([true, true, false, false]);
    expect(vietnamToday(new Date('2027-01-14T17:30:00Z'))).toBe('2027-01-15');
    expect([isDay('2028-02-29'), isDay('2027-02-29'), isDay('2027-1-1'), isDay('')]).toEqual([true, false, false, false]);
  });

  it('asks for an obligation, a number, a day inside the warranty, a severity and the defect, and the evidence only if it is a code', () => {
    const empty = emptyFile('', '2027-01-10');
    expect(validateFile(empty, [OBLIGATION])).toEqual({ obligationId: 'required', claimNo: 'required', severity: 'required', defect: 'required' });
    const form = { ...empty, obligationId: UUID, claimNo: 'WC-1', severity: 'MAJOR', defect: 'Crack' };
    expect(validateFile(form, [OBLIGATION])).toEqual({});
    expect(validateFile({ ...form, obligationId: 'other' }, [OBLIGATION])).toEqual({ obligationId: 'invalid' });
    expect(validateFile({ ...form, reportedOn: '2026-08-31' }, [OBLIGATION])).toEqual({ reportedOn: 'outside' });
    expect(validateFile({ ...form, reportedOn: '2027-09-01' }, [OBLIGATION])).toEqual({ reportedOn: 'outside' });
    expect(validateFile({ ...form, reportedOn: '2027-08-31' }, [OBLIGATION])).toEqual({});
    expect(validateFile({ ...form, reportedOn: '' }, [OBLIGATION])).toEqual({ reportedOn: 'required' });
    expect(validateFile({ ...form, reportedOn: '2027-02-30' }, [OBLIGATION])).toEqual({ reportedOn: 'invalid' });
    expect(validateFile({ ...form, severity: 'HUGE', claimNo: 'x'.repeat(2001), location: 'y'.repeat(2001), evidenceDocumentId: 'nope' }, [OBLIGATION])).toEqual({ severity: 'invalid', claimNo: 'tooLong', location: 'tooLong', evidenceDocumentId: 'invalid' });
  });

  it('sends the claim to the contractor of the contract, the words without the spaces and the optional ones only when given', () => {
    const form = { ...emptyFile(UUID, '2027-01-10'), claimNo: ' WC-1 ', severity: 'MAJOR', defect: ' Crack ' };
    expect(fileBody(form, [OBLIGATION])).toEqual({ claim_no: 'WC-1', reported_on: '2027-01-10', defect_description: 'Crack', severity: 'MAJOR', responder_contractor_id: '00000000-0000-4000-8000-0000000000c1' });
    expect(fileBody({ ...form, location: ' North wall ', evidenceDocumentId: ` ${UUID} ` }, [OBLIGATION])).toMatchObject({ location_text: 'North wall', evidence_document_version_id: UUID });
    expect(fileBody(form, [])).toMatchObject({ responder_contractor_id: '' });
  });

  it('asks the contractor for a day not before the report, and sends the note only when given', () => {
    expect(validateAcknowledge(emptyAcknowledge(), claim())).toEqual({ committedOn: 'required' });
    expect(validateAcknowledge({ committedOn: '2027-01-09', note: '' }, claim())).toEqual({ committedOn: 'outside' });
    expect(validateAcknowledge({ committedOn: '2027-02-30', note: '' }, claim())).toEqual({ committedOn: 'invalid' });
    expect(validateAcknowledge({ committedOn: '2027-01-10', note: 'z'.repeat(2001) }, claim())).toEqual({ note: 'tooLong' });
    expect(validateAcknowledge({ committedOn: '2027-01-25', note: '' }, claim())).toEqual({});
    expect(acknowledgeBody({ committedOn: ' 2027-01-25 ', note: '' })).toEqual({ committed_fix_on: '2027-01-25' });
    expect(acknowledgeBody({ committedOn: '2027-01-25', note: ' Monday ' })).toEqual({ committed_fix_on: '2027-01-25', note: 'Monday' });
  });

  it('asks for the day, what was done and at least one piece of evidence that is a code', () => {
    expect(validateFix({ ...emptyFix(''), fixedOn: '' }, claim())).toEqual({ fixedOn: 'required', note: 'required', documentId: 'evidence' });
    const form = { fixedOn: '2027-01-24', note: 'Repaired', documentId: UUID, photoId: '' };
    expect(validateFix(form, claim())).toEqual({});
    expect(validateFix({ ...form, documentId: '', photoId: UUID }, claim())).toEqual({});
    expect(validateFix({ ...form, fixedOn: '2027-01-09' }, claim())).toEqual({ fixedOn: 'outside' });
    expect(validateFix({ ...form, fixedOn: '2027-13-01' }, claim())).toEqual({ fixedOn: 'invalid' });
    expect(validateFix({ ...form, documentId: 'nope', photoId: 'nope' }, claim())).toEqual({ documentId: 'invalid', photoId: 'invalid' });
    expect(fixBody({ ...form, documentId: ` ${UUID} `, photoId: UUID })).toEqual({ fixed_on: '2027-01-24', note: 'Repaired', evidence_document_version_id: UUID, evidence_photo_id: UUID });
    expect(fixBody({ ...form, documentId: '', photoId: UUID })).toEqual({ fixed_on: '2027-01-24', note: 'Repaired', evidence_photo_id: UUID });
  });

  it('asks for an outcome, who bears the cost and a note', () => {
    expect(validateVerify(emptyVerify())).toEqual({ outcome: 'required', bearer: 'required', note: 'required' });
    expect(validateVerify({ outcome: 'MAYBE', bearer: 'EVERYONE', note: 'ok' })).toEqual({ outcome: 'invalid', bearer: 'invalid' });
    expect(validateVerify({ outcome: 'VERIFIED', bearer: 'OWNER', note: 'Checked' })).toEqual({});
    expect(verifyBody({ outcome: 'DISPUTED', bearer: 'CONTRACTOR', note: ' Still cracked ' })).toEqual({ outcome: 'DISPUTED', cost_borne_by: 'CONTRACTOR', note: 'Still cracked' });
  });

  it('names the refusals of the server and the reason of a refused datum', () => {
    const cases: Array<[unknown, string]> = [
      [problem('WARRANTY_EXPIRED'), 'expired'],
      [problem('CLAIM_NO_DUPLICATE', {}, 409), 'duplicate'],
      [problem('WARRANTY_STATE_INVALID', {}, 409), 'closed'],
      [problem('EVIDENCE_REQUIRED'), 'evidenceRequired'],
      [problem('DOCUMENT_NOT_CLEAN'), 'notClean'],
      [problem('FILE_NOT_CLEAN'), 'notClean'],
      [problem('CLAIM_STATE_INVALID', {}, 409), 'state'],
      [problem('VERSION_CONFLICT', {}, 409), 'conflict'],
      [problem('SELF_APPROVAL_DENIED', {}, 403), 'self'],
      [problem('SCOPE_DENIED', {}, 403), 'denied'],
      [problem('RESOURCE_NOT_FOUND', {}, 404), 'notFound'],
      [problem('VALIDATION_FAILED'), 'validation'],
      [problem('VALIDATION_FAILED', { reason: 'BEFORE_START' }), 'beforeStart'],
      [problem('VALIDATION_FAILED', { reason: 'NOT_A_PARTY' }), 'notParty'],
      [problem('VALIDATION_FAILED', { reason: 'BEFORE_REPORT' }), 'beforeReport'],
      [problem('VALIDATION_FAILED', { reason: 'NOT_IN_CONTRACT' }), 'evidenceInvalid'],
      [problem('VALIDATION_FAILED', { reason: 'NOT_FOUND' }), 'evidenceInvalid'],
      [problem('VALIDATION_FAILED', { reason: 'SOMETHING' }), 'validation'],
      [problem('INTERNAL_ERROR', {}, 500), 'general'],
      [new Error('down'), 'general'],
    ];
    expect(cases.map(([error]) => describeProblem(error))).toEqual(cases.map(([, expected]) => expected));
  });
});
