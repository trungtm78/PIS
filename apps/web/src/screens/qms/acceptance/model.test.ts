import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DECIDE,
  EMPTY_DRAFT,
  canDraft,
  decideBody,
  describeProblem,
  draftBody,
  draftable,
  emptySign,
  isLive,
  legalEffectOf,
  scopeOf,
  signBody,
  toAcceptanceLine,
  toAcceptanceList,
  validateDecide,
  validateDraft,
  validateReason,
  validateSign,
} from './model';
import { toInspectionLine } from '../inspection/model';
import { acceptance, inspection, passed, signature } from './test-support';

const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });
const lineOf = (raw: unknown) => {
  const line = toInspectionLine(raw);
  if (line === undefined) throw new Error('not an inspection');
  return line;
};

describe('toAcceptanceLine', () => {
  it('reads minutes with their signatures, missing roles, regime and what the caller may do', () => {
    const line = toAcceptanceLine(acceptance(1, { actions: { sign: true, approve: true, reject: true, revoke: false }, signable_roles: ['SUPERVISOR', 'OWNER'], open_critical_ncr: 2, signatures: [signature('CONTRACTOR', 'Nhà thầu', { method: 'DIGITAL_CERT', legal_effect: 'LEGAL_E_SIGNATURE', cert_serial: 'SN-1', valid: false })] }));
    expect(line).toMatchObject({
      recordNo: 'QA-W-001',
      contract: { code: 'HD-A-002' },
      inspection: { inspectionNo: 'KT-001', inspectionType: 'CONCEALED_WORK' },
      boqItemKey: 'B01',
      acceptanceScope: 'WORK_ITEM',
      status: 'SIGNING',
      requiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
      missingRoles: ['SUPERVISOR', 'OWNER'],
      openCriticalNcr: 2,
      regime: { awaitingConfirmation: true, cxn: 'CXN-07', label: 'Nghị định 06/2021/NĐ-CP' },
      createdBy: 'Giám sát Bình',
      signableRoles: ['SUPERVISOR', 'OWNER'],
      canSign: true,
      canApprove: true,
      canReject: true,
      canRevoke: false,
      version: 2,
    });
    expect(line?.signatures).toEqual([{ role: 'CONTRACTOR', signerName: 'Nhà thầu', method: 'DIGITAL_CERT', legalEffect: 'LEGAL_E_SIGNATURE', certSerial: 'SN-1', signedAt: '2026-10-25T02:30:00.000Z', valid: false }]);
  });

  it('tolerates the optional parts being absent and refuses a row that is not minutes', () => {
    const bare = toAcceptanceLine({ id: 'a', contract: { id: 'c' }, inspection: { id: 'i', inspection_type: 'SAFETY' }, acceptance_scope: 'STAGE', status: 'REVOKED', version: 4, revoke_reason: 'Sai', approved_by: { display_name: 'Chủ đầu tư' }, signatures: [{ nope: 1 }], required_roles: ['OWNER', 'NOBODY'] });
    expect(bare).toMatchObject({ recordNo: '', boqItemKey: null, signatures: [], requiredRoles: ['OWNER'], missingRoles: [], openCriticalNcr: 0, revokeReason: 'Sai', approvedBy: 'Chủ đầu tư', canSign: false, regime: { awaitingConfirmation: false }, createdBy: '' });
    expect(toAcceptanceLine(null)).toBeUndefined();
    expect(toAcceptanceLine({ ...acceptance(1), status: 'UNKNOWN' })).toBeUndefined();
    expect(toAcceptanceLine({ ...acceptance(1), acceptance_scope: 'ROOM' })).toBeUndefined();
    expect(toAcceptanceList({ items: [acceptance(1), { nope: true }] })).toHaveLength(1);
    expect(toAcceptanceList(undefined)).toEqual([]);
  });

  it('counts minutes that are drafted, being signed or approved as live', () => {
    expect(['DRAFT', 'SIGNING', 'APPROVED'].every((status) => isLive(status as 'DRAFT'))).toBe(true);
    expect(['REJECTED', 'REVOKED'].some((status) => isLive(status as 'REJECTED'))).toBe(false);
  });
});

describe('who may draft, and from which inspection', () => {
  it('needs the permission unless it is not yet known, and a session that is not read-only', () => {
    expect(canDraft(['qacceptance.manage'], 'FULL')).toBe(true);
    expect(canDraft(undefined, undefined)).toBe(true);
    expect(canDraft(['qacceptance.read'], 'FULL')).toBe(false);
    expect(canDraft(['qacceptance.manage'], 'READ_ONLY')).toBe(false);
  });

  it('gives the scope the kind of inspection leads to', () => {
    expect(scopeOf('CONCEALED_WORK')).toBe('WORK_ITEM');
    expect(scopeOf('MATERIAL_ENTRY')).toBe('WORK_ITEM');
    expect(scopeOf('SAFETY')).toBe('WORK_ITEM');
    expect(scopeOf('OTHER')).toBe('WORK_ITEM');
    expect(scopeOf('CONSTRUCTION_STAGE')).toBe('STAGE');
    expect(scopeOf('PART_ACCEPTANCE')).toBe('PART');
    expect(scopeOf('COMPLETION')).toBe('COMPLETION');
  });

  it('offers the inspections that passed and have no live minutes', () => {
    const inspections = [
      lineOf(passed(1)),
      lineOf(passed(2, { result: 'CONDITIONAL' })),
      lineOf(passed(3, { result: 'FAIL' })),
      lineOf(inspection(4)),
      lineOf(passed(5)),
      lineOf(passed(6)),
    ];
    const minutes = [toAcceptanceLine(acceptance(5, { status: 'APPROVED' })), toAcceptanceLine(acceptance(6, { status: 'REVOKED' }))].flatMap((line) => line ?? []);
    expect(draftable(inspections, minutes).map((line) => line.inspectionNo)).toEqual(['KT-001', 'KT-002', 'KT-006']);
  });
});

describe('the draft', () => {
  it('asks for the inspection, the number and the paper, which is an identifier', () => {
    expect(validateDraft(EMPTY_DRAFT)).toEqual({ inspectionId: 'required', recordNo: 'required', documentId: 'required' });
    expect(validateDraft({ inspectionId: 'i', recordNo: 'x'.repeat(2001), documentId: 'nope' })).toEqual({ recordNo: 'tooLong', documentId: 'uuid' });
    expect(validateDraft({ inspectionId: 'i', recordNo: 'QA-1', documentId: '00000000-0000-4000-8000-0000000000AB' })).toEqual({});
  });

  it('sends the scope of the kind of inspection with the number and the paper, trimmed', () => {
    expect(draftBody({ inspectionId: 'i', recordNo: ' QA-1 ', documentId: ' 00000000-0000-4000-8000-0000000000AB ' }, 'COMPLETION')).toEqual({ acceptance_scope: 'COMPLETION', record_no: 'QA-1', document_version_id: '00000000-0000-4000-8000-0000000000ab' });
  });
});

describe('the signature', () => {
  it('starts with the only role the signer may sign as, or none chosen', () => {
    expect(emptySign(['OWNER'], 'op')).toEqual({ role: 'OWNER', method: 'IN_APP_OTP', certSerial: '', clientOperationId: 'op' });
    expect(emptySign(['SUPERVISOR', 'OWNER'], 'op').role).toBe('');
    expect(emptySign([], 'op').role).toBe('');
  });

  it('asks for a role, and for the serial of a certificate and only then', () => {
    expect(validateSign(emptySign(['SUPERVISOR', 'OWNER'], 'op'))).toEqual({ role: 'required' });
    expect(validateSign({ ...emptySign(['OWNER'], 'op'), method: 'DIGITAL_CERT' })).toEqual({ certSerial: 'certSerial' });
    expect(validateSign({ ...emptySign(['OWNER'], 'op'), method: 'DIGITAL_CERT', certSerial: 'x'.repeat(2001) })).toEqual({ certSerial: 'tooLong' });
    expect(validateSign({ ...emptySign(['OWNER'], 'op'), method: 'DIGITAL_CERT', certSerial: 'SN-1' })).toEqual({});
    expect(validateSign(emptySign(['OWNER'], 'op'))).toEqual({});
  });

  it('sends the serial only with a certificate, and gives each method its worth', () => {
    expect(signBody({ ...emptySign(['OWNER'], 'op'), method: 'DIGITAL_CERT', certSerial: ' SN-1 ' })).toEqual({ signer_role: 'OWNER', signature_method: 'DIGITAL_CERT', client_operation_id: 'op', cert_serial: 'SN-1' });
    expect(signBody({ ...emptySign(['OWNER'], 'op'), certSerial: 'SN-1' })).toEqual({ signer_role: 'OWNER', signature_method: 'IN_APP_OTP', client_operation_id: 'op' });
    expect(legalEffectOf('IN_APP_OTP')).toBe('INTERNAL_RECORD');
    expect(legalEffectOf('IN_APP_WEBAUTHN')).toBe('INTERNAL_RECORD');
    expect(legalEffectOf('DIGITAL_CERT')).toBe('LEGAL_E_SIGNATURE');
  });
});

describe('the decision and the reason to revoke', () => {
  it('asks for a decision and a reason', () => {
    expect(validateDecide(EMPTY_DECIDE)).toEqual({ decision: 'required', reason: 'required' });
    expect(validateDecide({ decision: 'approve', reason: 'x'.repeat(2001) })).toEqual({ reason: 'tooLong' });
    expect(validateDecide({ decision: 'reject', reason: 'Sai giấy' })).toEqual({});
    expect(decideBody({ decision: 'approve', reason: ' Đã xem ' })).toEqual({ decision: 'approve', reason: 'Đã xem' });
    expect(decideBody(EMPTY_DECIDE).decision).toBe('reject');
    expect(validateReason(' ')).toBe('required');
    expect(validateReason('Nhầm')).toBeUndefined();
  });
});

describe('describeProblem', () => {
  it('words each refusal of the server, and names the roles that have not signed', () => {
    const view = (error: unknown) => describeProblem(error).problem;
    expect(view(problem('INSPECTION_NOT_PASSED'))).toBe('inspectionNotPassed');
    expect(view(problem('OPEN_CRITICAL_NCR'))).toBe('openCriticalNcr');
    expect(view(problem('CONTRACT_STATE_INVALID', 409))).toBe('contractState');
    expect(view(problem('QUALITY_ACCEPTANCE_STATE_INVALID', 409, { reason: 'ALREADY_DRAFTED' }))).toBe('alreadyDrafted');
    expect(view(problem('QUALITY_ACCEPTANCE_STATE_INVALID', 409, { reason: 'RECORD_NO_USED' }))).toBe('recordNoUsed');
    expect(view(problem('QUALITY_ACCEPTANCE_STATE_INVALID', 409, { reason: 'CONTENT_CHANGED' }))).toBe('contentChanged');
    expect(view(problem('QUALITY_ACCEPTANCE_STATE_INVALID', 409, { acceptance_status: 'APPROVED' }))).toBe('acceptanceState');
    expect(view(problem('ROLE_NOT_REQUIRED'))).toBe('roleNotRequired');
    expect(view(problem('ALREADY_SIGNED', 409))).toBe('alreadySigned');
    expect(view(problem('SIGNATURE_METHOD_NOT_ACCEPTED'))).toBe('methodNotAccepted');
    expect(describeProblem(problem('SIGNATURES_INCOMPLETE', 422, { missing_roles: ['OWNER', 'NOBODY'] }))).toEqual({ problem: 'signaturesIncomplete', missingRoles: ['OWNER'] });
    expect(view(problem('SELF_APPROVAL_DENIED', 403))).toBe('selfApproval');
    expect(view(problem('ACCEPTANCE_ALREADY_USED', 409))).toBe('alreadyUsed');
    expect(view(problem('VERSION_CONFLICT', 409))).toBe('versionConflict');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(view(problem(code))).toBe('validation');
    expect(view(problem('RESOURCE_NOT_FOUND', 404))).toBe('notFound');
    expect(view(problem('SCOPE_DENIED', 403, {}, 'signer_role'))).toBe('notYourRole');
    expect(view(problem('SCOPE_DENIED', 403))).toBe('denied');
    expect(view(problem('ENTITLEMENT_DENIED', 403))).toBe('denied');
    expect(view(problem('SESSION_EXPIRED', 401))).toBe('session');
    expect(view(problem('SOMETHING_ELSE', 500))).toBe('general');
    expect(view(new Error('x'))).toBe('general');
  });
});
