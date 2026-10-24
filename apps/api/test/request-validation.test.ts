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

  it('returns undefined when there is no issue', () => {
    expect(problemOf([], 'createCustomRole')).toBeUndefined();
  });
});

describe('assertValidBody', () => {
  const role = { code: 'UNIT_CLERK', name: 'Clerk', permissions: ['iam.unit.manage'], rank: 35 };

  it('passes a body that satisfies the schema of its operation', () => {
    expect(() => assertValidBody('createCustomRole', role)).not.toThrow();
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
