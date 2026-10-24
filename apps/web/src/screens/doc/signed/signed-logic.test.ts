import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { chainLabel, fileProblemMessage, findingLabel, overallLabel, overallMark, problemMessage, roleLabel } from './labels';
import { describeProblem } from './problems';
import type { SignedReason } from './problems';
import { EMPTY_REGISTRATION, attachable, fileProblem, isWholeNumber, recipientNames, registersFor, registrationBody, registrationProblems } from './rules';
import { CHAINS, OVERALL, ROLES, toAttachResult, toFileCheck } from './types';
import type { FileCheck } from './types';
import type { Register } from '../registers/types';

const problem = (code: string, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', detail, extensions });

const check = (overrides: Partial<FileCheck> = {}): FileCheck => ({
  fileObjectKey: 'tenants/t/document/1',
  fileSha256: 'a'.repeat(64),
  sizeBytes: 2048,
  pageCount: 2,
  overall: 'VALID',
  signatures: [{ role: 'LEADER', status: 'VALID', chainStatus: 'TRUSTED', signedAt: '2026-10-22T03:00:00.000Z', timestampProven: true, findings: [] }],
  ...overrides,
});

const register = (overrides: Partial<Register> = {}): Register => ({
  id: 'r1',
  registerCode: 'OUT',
  name: 'Outgoing',
  direction: 'OUTGOING',
  organizationUnitId: 'u1',
  year: 2026,
  mode: 'MANAGED',
  lastNumber: 4,
  nextNumber: 5,
  status: 'OPEN',
  scopeDocTypes: ['QD'],
  version: 1,
  ...overrides,
});

describe('the rules of DOC-09 (ST-DOC-009)', () => {
  it('judges the file before it is sent: required, empty, not a PDF, too large', () => {
    expect(fileProblem(undefined)).toBe('REQUIRED');
    expect(fileProblem({ name: 'a.pdf', size: 0, type: 'application/pdf' })).toBe('EMPTY');
    expect(fileProblem({ name: 'a.txt', size: 5, type: 'text/plain' })).toBe('NOT_PDF');
    expect(fileProblem({ name: 'a.pdf', size: 11 * 1024 * 1024, type: 'application/pdf' })).toBe('TOO_LARGE');
    expect(fileProblem({ name: 'A.PDF', size: 5, type: '' })).toBeUndefined();
    expect(fileProblem({ name: 'x', size: 5, type: 'application/pdf' })).toBeUndefined();
  });

  it('reads recipients one per line, trimmed and once', () => {
    expect(recipientNames('  Finance \n\nfinance\nAudit Office\n')).toEqual(['Finance', 'Audit Office']);
    expect(recipientNames('')).toEqual([]);
  });

  it('wants a positive whole number', () => {
    expect(['1', ' 128 ', '999999999'].map(isWholeNumber)).toEqual([true, true, true]);
    expect(['0', '-1', '1.5', 'x', '', '1234567890'].map(isWholeNumber)).toEqual([false, false, false, false, false, false]);
  });

  it('names every field of the registration that is wrong', () => {
    expect(registrationProblems(EMPTY_REGISTRATION).map((entry) => `${entry.field}:${entry.code}`)).toEqual([
      'docTypeCode:REQUIRED',
      'title:REQUIRED',
      'unitId:REQUIRED',
      'registerId:REQUIRED',
      'number:REQUIRED',
      'symbol:REQUIRED',
      'issuedOn:REQUIRED',
    ]);
    const form = { ...EMPTY_REGISTRATION, docTypeCode: 'QD', title: 'ab', unitId: 'u', registerId: 'r', number: '0', symbol: 'x'.repeat(201), issuedOn: '22/10/2026' };
    expect(registrationProblems(form).map((entry) => `${entry.field}:${entry.code}`)).toEqual(['title:TOO_SHORT', 'number:INVALID', 'symbol:TOO_LONG', 'issuedOn:INVALID']);
    expect(registrationProblems({ ...form, title: 'x'.repeat(501), number: '5', symbol: '5/QD', issuedOn: '2026-10-22', recipients: Array.from({ length: 501 }, (_, index) => `n${index}`).join('\n') }).map((entry) => `${entry.field}:${entry.code}`)).toEqual([
      'title:TOO_LONG',
      'recipients:TOO_LONG',
    ]);
    expect(registrationProblems({ ...form, title: 'A decision', number: '5', symbol: '5/QD', issuedOn: '2026-10-22' })).toEqual([]);
  });

  it('offers the open outgoing registers of the year of the date, for the type', () => {
    const registers = [register(), register({ id: 'r2', year: 2025 }), register({ id: 'r3', status: 'CLOSED' }), register({ id: 'r4', direction: 'INCOMING' }), register({ id: 'r5', scopeDocTypes: ['CV'] }), register({ id: 'r6', scopeDocTypes: [] })];
    expect(registersFor(registers, { issuedOn: '2026-10-22', docTypeCode: 'QD' }).map((entry) => entry.id)).toEqual(['r1', 'r6']);
    expect(registersFor(registers, { issuedOn: '', docTypeCode: '' }).map((entry) => entry.id)).toEqual(['r1', 'r2', 'r5', 'r6']);
  });

  it('builds the body of the registration from the form and the file that was read', () => {
    const form = { ...EMPTY_REGISTRATION, docTypeCode: 'QD', title: ' A decision ', unitId: 'u', registerId: 'r', number: ' 128 ', symbol: ' 128/QD-UBND ', issuedOn: '2026-10-22', recipients: 'Finance\nAudit' };
    expect(registrationBody(form, check())).toEqual({
      doc_type_code: 'QD',
      title: 'A decision',
      file_object_key: 'tenants/t/document/1',
      file_sha256: 'a'.repeat(64),
      declared_number: 128,
      declared_symbol: '128/QD-UBND',
      declared_issued_on: '2026-10-22',
      register_id: 'r',
      drafting_unit_id: 'u',
      recipients: [{ name: 'Finance' }, { name: 'Audit' }],
    });
  });

  it('lets a file be attached only when it has signatures and every one holds', () => {
    expect(attachable(check())).toBe(true);
    expect(attachable(check({ overall: 'INDETERMINATE' }))).toBe(false);
    expect(attachable(check({ overall: 'INVALID' }))).toBe(false);
    expect(attachable(check({ signatures: [] }))).toBe(false);
    expect(attachable(undefined)).toBe(false);
  });
});

describe('what the server answers', () => {
  it('reads the answer of the upload, and refuses one that names no file', () => {
    expect(
      toFileCheck({
        file_object_key: 'k',
        file_sha256: 'b'.repeat(64),
        size_bytes: 10,
        page_count: 3,
        overall: 'VALID',
        signatures: [{ role: 'ORGANIZATION', status: 'VALID', chain_status: 'TRUSTED', signed_at: '2026-10-22T03:00:00.000Z', timestamp_proven: true, findings: ['X', 7] }, 'junk'],
      }),
    ).toEqual({
      fileObjectKey: 'k',
      fileSha256: 'b'.repeat(64),
      sizeBytes: 10,
      pageCount: 3,
      overall: 'VALID',
      signatures: [{ role: 'ORGANIZATION', status: 'VALID', chainStatus: 'TRUSTED', signedAt: '2026-10-22T03:00:00.000Z', timestampProven: true, findings: ['X'] }],
    });
    expect(toFileCheck({ file_sha256: 'x' })).toBeUndefined();
    expect(toFileCheck(null)).toBeUndefined();
    expect(toFileCheck({ file_object_key: 'k', file_sha256: 's', overall: 'weird', signatures: [{ role: 'x', status: 'y', chain_status: 'z' }] })).toMatchObject({
      overall: 'INDETERMINATE',
      sizeBytes: 0,
      signatures: [{ role: 'EXTERNAL', status: 'INDETERMINATE', chainStatus: 'NOT_CHECKED', signedAt: null, timestampProven: false, findings: [] }],
    });
  });

  it('reads the answer of the commands', () => {
    expect(toAttachResult({ resource_id: 'd', status: 'ISSUED', symbol: '5/QD', number: 5 })).toEqual({ id: 'd', status: 'ISSUED', symbol: '5/QD', number: 5 });
    expect(toAttachResult(undefined)).toEqual({ id: '', status: '', symbol: null, number: null });
  });

  it('maps the failures to what the screen says, with the findings and the reason of the signer', () => {
    expect(describeProblem(new Error('x')).reason).toBe('general');
    expect(describeProblem(problem('SIGNING_TIME_UNPROVEN', { findings: ['SIGNING_TIME_UNPROVEN', 3] }))).toMatchObject({ reason: 'timeUnproven', findings: ['SIGNING_TIME_UNPROVEN'] });
    expect(describeProblem(problem('SIGNER_NOT_AUTHORIZED', { reason: 'SIGNER_IDENTITY_MISMATCH' }))).toMatchObject({ reason: 'notAuthorised', authority: 'SIGNER_IDENTITY_MISMATCH' });
    expect(describeProblem(problem('VALIDATION_FAILED', {}, 'declared_number'))).toMatchObject({ reason: 'invalid', field: 'declared_number', findings: [] });
    const codes: Array<[string, string]> = [
      ['SIGNATURE_INVALID', 'signatureInvalid'],
      ['CERTIFICATE_CHAIN_UNTRUSTED', 'chainUntrusted'],
      ['SIGNED_CONTENT_MISMATCH', 'contentMismatch'],
      ['NUMBER_ALREADY_REGISTERED', 'numberTaken'],
      ['REGISTER_MODE_MISMATCH', 'modeMismatch'],
      ['REGISTER_NOT_OPEN', 'registerClosed'],
      ['REGISTER_YEAR_MISMATCH', 'yearMismatch'],
      ['SYMBOL_FORMAT_INVALID', 'symbolFormat'],
      ['UPLOAD_NOT_PDF', 'notPdf'],
      ['FILE_TYPE_NOT_ALLOWED', 'notPdf'],
      ['SCAN_PENDING', 'scanPending'],
      ['FILE_NOT_CLEAN', 'notClean'],
      ['PAYLOAD_TOO_LARGE', 'tooLarge'],
      ['SELF_APPROVAL_DENIED', 'selfUpload'],
      ['VERSION_CONFLICT', 'conflict'],
      ['DOCUMENT_STATE_INVALID', 'state'],
      ['INVALID_REQUEST', 'invalid'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['ENTITLEMENT_DENIED', 'denied'],
      ['SESSION_EXPIRED', 'session'],
      ['IDEMPOTENCY_CONFLICT', 'duplicate'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, reason] of codes) expect(describeProblem(problem(code)).reason).toBe(reason);
  });
});

describe('the words of the screen', () => {
  const t = ((key: string, values?: Record<string, unknown>) => (values === undefined ? key : key + JSON.stringify(values))) as never;
  const REASONS: SignedReason[] = ['signatureInvalid', 'chainUntrusted', 'timeUnproven', 'contentMismatch', 'numberTaken', 'modeMismatch', 'registerClosed', 'yearMismatch', 'symbolFormat', 'notPdf', 'scanPending', 'notClean', 'tooLarge', 'selfUpload', 'notAuthorised', 'conflict', 'state', 'invalid', 'notFound', 'denied', 'session', 'duplicate', 'general'];

  it('has a distinct key for every verdict, role, chain, finding, file problem and reason', () => {
    const keys = [
      ...OVERALL.map((overall) => overallLabel(t, overall)),
      ...ROLES.map((role) => roleLabel(t, role)),
      ...CHAINS.map((chain) => chainLabel(t, chain)),
      ...['SIGNING_TIME_UNPROVEN', 'CHAIN_UNTRUSTED', 'LEADER_FIELD_REQUIRED', 'ONE_SIGNATURE_EXPECTED', 'SEAL_DOES_NOT_COVER_FILE'].map((code) => findingLabel(t, code)),
      ...(['REQUIRED', 'EMPTY', 'NOT_PDF', 'TOO_LARGE'] as const).map((problem) => fileProblemMessage(t, problem)),
      ...REASONS.map((reason) => problemMessage(t, { reason, field: undefined, findings: [], authority: undefined })),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(findingLabel(t, 'ANYTHING')).toContain('doc.signed.finding.other');
    expect(problemMessage(t, { reason: 'notAuthorised', field: undefined, findings: [], authority: 'SIGNER_IDENTITY_MISMATCH' })).toBe('doc.signed.problem.signerMismatch');
    expect(OVERALL.map(overallMark)).toEqual(['✓', '✖', '?']);
  });
});
