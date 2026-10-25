import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { toMeasurement } from '../measurement/model';
import {
  EMPTY_DECIDE,
  EMPTY_DRAFT,
  EMPTY_REVOKE,
  EMPTY_SUBMIT,
  acceptable,
  acceptanceLink,
  canCreate,
  decideBody,
  describeProblem,
  draftBody,
  evidenceIds,
  remainingVnd,
  revokeBody,
  signerNames,
  submitBody,
  toAcceptance,
  validateDecide,
  validateDraft,
  validateRevoke,
  validateSubmit,
} from './model';
import { UUID_A, UUID_B, acceptance, approvedMeasurement, contractId, measurement, measurementId } from './test-support';

const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const measured = (raw: Record<string, unknown>) => {
  const read = toMeasurement(raw);
  if (read === undefined) throw new Error('not a measurement');
  return read;
};

describe('toAcceptance', () => {
  it('reads an acceptance with its lines, the minutes of quality, the figures of the contract and what the caller may do', () => {
    const read = toAcceptance(
      acceptance(1, { status: 'SUBMITTED', quality_acceptance: { id: UUID_A, record_no: 'QA-W-001', status: 'APPROVED' }, open_critical_ncr: 2, signer_refs: [{ name: 'A' }, { name: 'B' }], actions: { submit: false, decide: true, revoke: false }, decision_reason: 'Ok' }),
    );
    expect(read).toMatchObject({
      acceptanceNo: 'NT-001',
      contract: { code: 'HD-A-001', requiresQualityAcceptance: true, contractValueVnd: '10200000000', acceptedTotalVnd: '0' },
      period: { code: '2026-01' },
      acceptedOn: '2026-07-25',
      status: 'SUBMITTED',
      amountVnd: '400000000',
      quality: { id: UUID_A, recordNo: 'QA-W-001', status: 'APPROVED' },
      openCriticalNcr: 2,
      signerCount: 2,
      decisionReason: 'Ok',
      canSubmit: false,
      canDecide: true,
      canRevoke: false,
      version: 1,
    });
    expect(read?.lines).toEqual([
      { id: expect.any(String), measurementId: measurementId(1), businessKey: 'B02', description: 'Hạng mục 2', unitCode: 'M3', quantity: '200.000000', unitPrice: '2000000.000000', amountVnd: '400000000', active: false, referenceNo: 'NK-001' },
    ]);
  });

  it('tolerates the optional parts being absent and refuses a row that is not an acceptance', () => {
    const bare = toAcceptance({ id: 'a', contract: { id: 'c' }, status: 'REVOKED', version: 3, revoke_reason: 'Sai', lines: [{ id: 'l' }, null] });
    expect(bare).toMatchObject({ acceptanceNo: '', quality: null, lines: [], signerCount: 0, canSubmit: false, revokeReason: 'Sai', contract: { requiresQualityAcceptance: false, contractValueVnd: '0' } });
    expect(toAcceptance(null)).toBeUndefined();
    expect(toAcceptance({ ...acceptance(1), status: 'UNKNOWN' })).toBeUndefined();
    expect(toAcceptance({ ...acceptance(1), version: 'x' })).toBeUndefined();
  });
});

describe('who may draft, and from what', () => {
  it('needs the permission unless it is not yet known, and a session that is not read-only', () => {
    expect(canCreate(['acceptance.create'], 'FULL')).toBe(true);
    expect(canCreate(undefined, undefined)).toBe(true);
    expect(canCreate(['acceptance.read'], 'FULL')).toBe(false);
    expect(canCreate(['acceptance.create'], 'READ_ONLY')).toBe(false);
  });

  it('takes the approved measurements that no approved acceptance holds', () => {
    const approved = measured(approvedMeasurement(1));
    const held = measured(approvedMeasurement(2));
    const waiting = measured(measurement(3, { status: 'SUBMITTED' }));
    const inDraft = measured(approvedMeasurement(4));
    const acceptances = [
      toAcceptance(acceptance(1, { status: 'APPROVED', lines: [{ ...(acceptance(1).lines[0] as object), measurement_id: held.id }] })),
      toAcceptance(acceptance(2, { status: 'DRAFT', lines: [{ ...(acceptance(2).lines[0] as object), measurement_id: inDraft.id }] })),
    ].flatMap((line) => line ?? []);
    expect(acceptable([approved, held, waiting, inDraft], acceptances).map((entry) => entry.id)).toEqual([approved.id, inDraft.id]);
  });

  it('counts what the contract can still accept, never below zero', () => {
    expect(remainingVnd({ contractValueVnd: '10200000000', acceptedTotalVnd: '400000000' })).toBe('9800000000');
    expect(remainingVnd({ contractValueVnd: '100', acceptedTotalVnd: '100' })).toBe('0');
    expect(remainingVnd({ contractValueVnd: '100', acceptedTotalVnd: '101' })).toBe('0');
  });

  it('links to the acceptances of a contract', () => {
    expect(acceptanceLink(contractId(1))).toBe(`/ctr/ctr-12?contract=${contractId(1)}`);
  });
});

describe('the draft', () => {
  it('asks for a period, a measurement and the paper, and for an identifier where one is typed', () => {
    expect(validateDraft(EMPTY_DRAFT)).toEqual({ periodId: 'required', measurementIds: 'required', documentId: 'required' });
    expect(validateDraft({ periodId: 'p', measurementIds: ['m'], documentId: 'nope', qualityId: 'nope' })).toEqual({ documentId: 'uuid', qualityId: 'uuid' });
    expect(validateDraft({ periodId: 'p', measurementIds: ['m'], documentId: UUID_A, qualityId: '' })).toEqual({});
  });

  it('sends the measurements, the period and the paper, and the minutes only when named', () => {
    expect(draftBody({ periodId: 'p', measurementIds: ['m1', 'm2'], documentId: ` ${UUID_A.toUpperCase()} `, qualityId: '' })).toEqual({ measurement_ids: ['m1', 'm2'], period_id: 'p', document_version_id: UUID_A });
    expect(draftBody({ periodId: 'p', measurementIds: ['m'], documentId: UUID_A, qualityId: ` ${UUID_B} ` })).toMatchObject({ quality_acceptance_id: UUID_B });
  });
});

describe('sending', () => {
  it('asks for the people who sign, one on each line, within the limits', () => {
    expect(signerNames(' An \n\n  Bình  \n')).toEqual(['An', 'Bình']);
    expect(validateSubmit(EMPTY_SUBMIT)).toEqual({ signers: 'required' });
    expect(validateSubmit({ signers: Array.from({ length: 21 }, (_, n) => `P${n}`).join('\n') })).toEqual({ signers: 'tooMany' });
    expect(validateSubmit({ signers: 'x'.repeat(201) })).toEqual({ signers: 'tooLong' });
    expect(validateSubmit({ signers: 'An' })).toEqual({});
    expect(submitBody({ signers: 'An\nBình' })).toEqual({ signer_refs: [{ name: 'An' }, { name: 'Bình' }] });
  });
});

describe('the decision and the revocation', () => {
  it('asks for a decision and a reason, and for identifiers where documents are named', () => {
    expect(evidenceIds(`${UUID_A.toUpperCase()}, ${UUID_B}\n`)).toEqual([UUID_A, UUID_B]);
    expect(validateDecide(EMPTY_DECIDE)).toEqual({ decision: 'required', reason: 'required' });
    expect(validateDecide({ decision: 'approve', reason: 'x'.repeat(2001), evidence: 'nope' })).toEqual({ reason: 'tooLong', evidence: 'uuid' });
    expect(validateDecide({ decision: 'approve', reason: 'Ok', evidence: Array.from({ length: 51 }, () => UUID_A).join(',') })).toEqual({ evidence: 'tooMany' });
    expect(validateDecide({ decision: 'reject', reason: 'Sai', evidence: UUID_A })).toEqual({});
    expect(decideBody({ decision: 'approve', reason: ' Đã xem ', evidence: UUID_A })).toEqual({ decision: 'approve', reason: 'Đã xem', evidence_ids: [UUID_A] });
    expect(decideBody(EMPTY_DECIDE).decision).toBe('return');
  });

  it('asks for the reason and the paper that approves the revocation', () => {
    expect(validateRevoke(EMPTY_REVOKE)).toEqual({ reason: 'required', documentId: 'required' });
    expect(validateRevoke({ reason: 'x'.repeat(2001), documentId: 'nope' })).toEqual({ reason: 'tooLong', documentId: 'uuid' });
    expect(validateRevoke({ reason: 'Sai', documentId: UUID_A })).toEqual({});
    expect(revokeBody({ reason: ' Sai ', documentId: ` ${UUID_A.toUpperCase()} ` })).toEqual({ reason: 'Sai', approval_document_version_id: UUID_A });
  });
});

describe('describeProblem', () => {
  it('words each refusal of the server, and says how much the contract can still accept', () => {
    const view = (error: unknown) => describeProblem(error).problem;
    expect(view(problem('MEASUREMENT_NOT_APPROVED'))).toBe('measurementNotApproved');
    expect(view(problem('MEASUREMENT_ALREADY_ACCEPTED', 409))).toBe('measurementAccepted');
    expect(view(problem('QUALITY_ACCEPTANCE_REQUIRED'))).toBe('qualityRequired');
    expect(view(problem('OPEN_CRITICAL_NCR'))).toBe('openNcr');
    expect(describeProblem(problem('ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', 422, { remaining_vnd: '100000000' }))).toEqual({ problem: 'exceedsContract', remainingVnd: '100000000' });
    expect(describeProblem(problem('ACCEPTANCE_VALUE_EXCEEDS_CONTRACT'))).toEqual({ problem: 'exceedsContract', remainingVnd: undefined });
    expect(view(problem('REVISION_NOT_EFFECTIVE'))).toBe('revisionNotEffective');
    expect(view(problem('ACCEPTANCE_ALREADY_CLAIMED', 409))).toBe('claimed');
    expect(view(problem('SELF_APPROVAL_DENIED', 403))).toBe('selfApproval');
    expect(view(problem('CONTRACT_STATE_INVALID', 409))).toBe('contractState');
    expect(view(problem('ACCEPTANCE_STATE_INVALID', 409))).toBe('acceptanceState');
    expect(view(problem('VERSION_CONFLICT', 409))).toBe('versionConflict');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(view(problem(code))).toBe('validation');
    expect(view(problem('RESOURCE_NOT_FOUND', 404))).toBe('notFound');
    for (const code of ['SCOPE_DENIED', 'ENTITLEMENT_DENIED']) expect(view(problem(code, 403))).toBe('denied');
    expect(view(problem('SESSION_EXPIRED', 401))).toBe('session');
    expect(view(problem('SOMETHING_ELSE', 500))).toBe('general');
    expect(view(new Error('x'))).toBe('general');
  });
});
