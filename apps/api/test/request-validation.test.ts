import { DomainError } from '@machvon/kernel';
import { assertValidBody, problemOf } from '../src/request-validation';

const issue = (kind: 'unknown_field' | 'missing' | 'type' | 'constraint', path: string) => ({ kind, path });

function thrown(action: () => void): DomainError {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('problemOf', () => {
  it('answers 400 FIELD_NOT_ALLOWED naming every unknown field, ahead of any other issue', () => {
    const problem = problemOf([issue('missing', 'name'), issue('unknown_field', 'tenant_id'), issue('unknown_field', 'role'), issue('constraint', 'code')], 'createOrganizationUnit');
    expect(problem).toMatchObject({ code: 'FIELD_NOT_ALLOWED', status: 400, detail: 'tenant_id, role' });
  });

  it('answers 400 INVALID_REQUEST for a missing field or a wrong type, naming the first one', () => {
    expect(problemOf([issue('constraint', 'code'), issue('type', 'name'), issue('missing', 'parent_id')], 'createOrganizationUnit')).toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
      detail: 'name',
    });
    expect(problemOf([issue('missing', 'parent_id')], 'createOrganizationUnit')).toMatchObject({ code: 'INVALID_REQUEST', status: 400, detail: 'parent_id' });
  });

  it('answers 422 VALIDATION_FAILED for a broken rule of a well typed value', () => {
    expect(problemOf([issue('constraint', 'code'), issue('constraint', 'name')], 'createOrganizationUnit')).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'code',
    });
  });

  it.each(['createCustomRole', 'updateCustomRole', 'grantRole', 'revokeRoleGrant'])(
    'answers a broken rule of %s as 400 INVALID_REQUEST, as the role administration acceptance criteria require',
    (operationId) => {
      expect(problemOf([issue('constraint', 'rank')], operationId)).toMatchObject({ code: 'INVALID_REQUEST', status: 400, detail: 'rank' });
    },
  );

  it('answers a missing field of resetIntegrationCursor as 422 VALIDATION_FAILED naming it, and a wrong type as 400 (ST-MDM-007 AC-2)', () => {
    expect(problemOf([issue('missing', 'reason')], 'resetIntegrationCursor')).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
    expect(problemOf([issue('type', 'cursor_json'), issue('missing', 'reason')], 'resetIntegrationCursor')).toMatchObject({ code: 'INVALID_REQUEST', status: 400, detail: 'cursor_json' });
  });

  it('answers a missing or empty reference of a legal confirmation, and a missing legal basis of a template, with the code of their own, 422 (ST-DOC-006 AC-ST-DOC-006-1)', () => {
    expect(problemOf([issue('constraint', 'legal_confirmation_ref')], 'confirmDocumentTemplateLegalBasis')).toMatchObject({ code: 'CONFIRMATION_REF_REQUIRED', status: 422, detail: 'legal_confirmation_ref' });
    expect(problemOf([issue('missing', 'legal_confirmation_ref'), issue('missing', 'evidence_document_id')], 'confirmDocumentTemplateLegalBasis')).toMatchObject({ code: 'CONFIRMATION_REF_REQUIRED', status: 422 });
    expect(problemOf([issue('missing', 'legal_basis')], 'createDocumentTemplateRevision')).toMatchObject({ code: 'LEGAL_BASIS_REQUIRED', status: 422, detail: 'legal_basis' });
    // A wrong type, another field and another operation keep the general classes.
    expect(problemOf([issue('type', 'legal_confirmation_ref')], 'confirmDocumentTemplateLegalBasis')).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(problemOf([issue('missing', 'evidence_document_id')], 'confirmDocumentTemplateLegalBasis')).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(problemOf([issue('constraint', 'legal_confirmation_ref')], 'createOrganizationUnit')).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(problemOf([issue('unknown_field', 'other'), issue('missing', 'legal_basis')], 'createDocumentTemplateRevision')).toMatchObject({ code: 'FIELD_NOT_ALLOWED', status: 400 });
  });

  it('answers a missing or empty legal basis of a permit type with LEGAL_BASIS_REQUIRED, 422, and a wrong type with the general class (AC-ST-PMT-001-1)', () => {
    expect(problemOf([issue('missing', 'legal_basis')], 'publishPermitType')).toMatchObject({ code: 'LEGAL_BASIS_REQUIRED', status: 422, detail: 'legal_basis' });
    expect(problemOf([issue('constraint', 'legal_basis')], 'publishPermitType')).toMatchObject({ code: 'LEGAL_BASIS_REQUIRED', status: 422, detail: 'legal_basis' });
    expect(problemOf([issue('type', 'legal_basis')], 'publishPermitType')).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(problemOf([issue('missing', 'name')], 'publishPermitType')).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('answers a missing or empty legal basis of a report form or an obligation rule with LEGAL_BASIS_REQUIRED, 422 (BR-MNE-01)', () => {
    for (const operation of ['createMneFormVersion', 'createMneObligationRule']) {
      expect(problemOf([issue('missing', 'legal_basis')], operation)).toMatchObject({ code: 'LEGAL_BASIS_REQUIRED', status: 422, detail: 'legal_basis' });
      expect(problemOf([issue('constraint', 'legal_basis')], operation)).toMatchObject({ code: 'LEGAL_BASIS_REQUIRED', status: 422, detail: 'legal_basis' });
      expect(problemOf([issue('type', 'legal_basis')], operation)).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    }
  });

  it('answers a missing decision document of an appropriation with DECISION_REQUIRED, 422, and any other missing field with the general class (ST-CAP-001)', () => {
    expect(problemOf([issue('missing', 'decision_document_id')], 'registerAppropriation')).toMatchObject({ code: 'DECISION_REQUIRED', status: 422, detail: 'decision_document_id' });
    expect(problemOf([issue('type', 'decision_document_id')], 'registerAppropriation')).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(problemOf([issue('missing', 'amount_vnd')], 'registerAppropriation')).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('answers a missing decision document of the suspension, the resumption and the termination of a contract with DECISION_DOCUMENT_REQUIRED, 422 (ST-CTR-005 AC-1)', () => {
    for (const operation of ['suspendContract', 'resumeContract', 'terminateContract']) {
      expect(problemOf([issue('missing', 'decision_document_version_id')], operation)).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422, detail: 'decision_document_version_id' });
      expect(problemOf([issue('type', 'decision_document_version_id')], operation)).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
      expect(problemOf([issue('missing', 'reason')], operation)).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    }
  });

  it('returns undefined when there is no issue', () => {
    expect(problemOf([], 'createCustomRole')).toBeUndefined();
  });
});

describe('assertValidBody', () => {
  const role = { code: 'UNIT_CLERK', name: 'Clerk', permissions: ['iam.unit.manage'], rank: 35 };

  it('passes a body that satisfies the schema of its operation', () => {
    expect(() => assertValidBody('createCustomRole', role)).not.toThrow();
  });

  it('takes an empty lines array that comes with the lines to remove, and still refuses an unknown field or a missing array (CR-CAP-01)', () => {
    const lineId = '00000000-0000-4000-8000-0000000000aa';
    expect(() => assertValidBody('draftCapitalAllocation', { lines: [], remove_line_ids: [lineId] })).not.toThrow();
    expect(() => assertValidBody('draftCapitalAllocation', { lines: [] })).not.toThrow();
    expect(thrown(() => assertValidBody('draftCapitalAllocation', { remove_line_ids: [lineId] }))).toMatchObject({ code: 'INVALID_REQUEST', status: 400, detail: 'lines' });
    expect(thrown(() => assertValidBody('draftCapitalAllocation', { lines: [], allocated_total_vnd: '1' }))).toMatchObject({ code: 'FIELD_NOT_ALLOWED', detail: 'allocated_total_vnd' });
  });

  it('throws the problem of the first failing class for the real schemas', () => {
    expect(thrown(() => assertValidBody('createCustomRole', { ...role, is_system: true }))).toMatchObject({ code: 'FIELD_NOT_ALLOWED', detail: 'is_system' });
    expect(thrown(() => assertValidBody('createCustomRole', { ...role, rank: 95 }))).toMatchObject({ code: 'INVALID_REQUEST', status: 400, detail: 'rank' });
    expect(thrown(() => assertValidBody('createOrganizationUnit', { code: 'lower', name: 'Unit', parent_id: '00000000-0000-4000-8000-00000000000a', unit_type: 'DEPARTMENT', valid_from: '2026-02-01' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'code',
    });
    expect(thrown(() => assertValidBody('createOrganizationUnit', {}))).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('never echoes a value of the body in the problem', () => {
    const problem = thrown(() => assertValidBody('createCustomRole', { ...role, name: 12345678, secret_field: 'hunter-two-seven' }));
    expect(JSON.stringify([problem.code, problem.detail])).not.toContain('hunter-two-seven');
    expect(JSON.stringify([problem.code, problem.detail])).not.toContain('12345678');
  });

  it('treats a body that is not an object as 400 INVALID_REQUEST on body', () => {
    expect(thrown(() => assertValidBody('createCustomRole', 'text'))).toMatchObject({ code: 'INVALID_REQUEST', status: 400, detail: 'body' });
    expect(thrown(() => assertValidBody('createCustomRole', null))).toMatchObject({ code: 'INVALID_REQUEST', status: 400, detail: 'body' });
  });

  it('skips an operation that has no request schema: unknown ids, no id, and operations without a body', () => {
    expect(() => assertValidBody('test_create_widget', { anything: true })).not.toThrow();
    expect(() => assertValidBody(undefined, { anything: true })).not.toThrow();
    expect(() => assertValidBody('get_resources_organization_unit', { anything: true })).not.toThrow();
  });
});
