import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { describeProblem } from './problems';
import { EMPTY_PROVISION_VALUES, provisionBody, validateProvisionForm } from './rules';
import type { ProvisionValues } from './rules';
import { TENANT_STATUSES, canRetry, failedStepOf, isTenantStatus, showsRun, toTenantDetail, toTenantSummary } from './types';

const VALID: ProvisionValues = {
  ...EMPTY_PROVISION_VALUES,
  code: 'cao-bang',
  name: 'Ủy ban nhân dân tỉnh Cao Bằng',
  plan_version_id: '00000000-0000-4000-9000-000000000001',
  root_unit_name: 'Ủy ban nhân dân tỉnh',
  initial_owner_email: 'owner@example.org',
  platform_subdomain: 'cao-bang',
};

describe('validateProvisionForm', () => {
  it('accepts a complete form', () => {
    expect(validateProvisionForm(VALID)).toEqual({});
  });

  it('refuses the tenant code of BR-SAS-01 exactly: first a letter, then 2 to 30 of lower case, digits and hyphen', () => {
    const code = (value: string) => validateProvisionForm({ ...VALID, code: value }).code;
    expect(code('abc')).toBeUndefined();
    expect(code(`a${'b'.repeat(30)}`)).toBeUndefined();
    expect(code(`a${'b'.repeat(31)}`)).toBe('pattern');
    expect(code('ab')).toBe('pattern');
    expect(code('1abc')).toBe('pattern');
    expect(code('ABC')).toBe('pattern');
    expect(code('abc ')).toBe('pattern');
    expect(code('ab_c')).toBe('pattern');
    expect(code('')).toBe('required');
  });

  it('refuses a subdomain, an email, a plan id and short texts', () => {
    const errors = validateProvisionForm({
      ...VALID,
      platform_subdomain: 'ab',
      initial_owner_email: 'not-an-email',
      plan_version_id: 'plan-1',
      name: 'ab',
      root_unit_name: '  ',
      administrative_code: 'x'.repeat(21),
    });
    expect(errors).toEqual({
      platform_subdomain: 'pattern',
      initial_owner_email: 'email',
      plan_version_id: 'uuid',
      name: 'tooShort',
      root_unit_name: 'required',
      administrative_code: 'tooLong',
    });
  });

  it('refuses a choice outside the contract enumerations', () => {
    const errors = validateProvisionForm({ ...VALID, region: 'vn-east', isolation_mode: 'SHARED', governing_body_type: 'TOWN' });
    expect(errors).toEqual({ region: 'choice', isolation_mode: 'choice', governing_body_type: 'choice' });
  });
});

describe('provisionBody', () => {
  it('trims the text, keeps the code as typed and leaves the optional fields out when empty', () => {
    const body = provisionBody({ ...VALID, name: '  Cao Bằng  ', initial_owner_email: ' owner@example.org ' });
    expect(body).toEqual({
      code: 'cao-bang',
      name: 'Cao Bằng',
      governing_body_type: 'PROVINCE',
      region: 'vn-north',
      isolation_mode: 'POOL',
      plan_version_id: '00000000-0000-4000-9000-000000000001',
      root_unit_name: 'Ủy ban nhân dân tỉnh',
      initial_owner_email: 'owner@example.org',
      platform_subdomain: 'cao-bang',
    });
  });

  it('adds the optional fields when they are filled', () => {
    const body = provisionBody({ ...VALID, administrative_code: ' 04 ', procurement_contract_ref: 'HD-1' });
    expect(body).toMatchObject({ administrative_code: '04', procurement_contract_ref: 'HD-1' });
  });
});

describe('tenant types', () => {
  it('knows exactly the seven states, and retries only a Failed tenant', () => {
    expect(TENANT_STATUSES).toHaveLength(7);
    expect(TENANT_STATUSES.filter(canRetry)).toEqual(['Failed']);
    expect(isTenantStatus('Active')).toBe(true);
    expect(isTenantStatus('Deleted')).toBe(false);
    expect(TENANT_STATUSES.filter(showsRun)).toEqual(['Requested', 'Provisioning', 'Failed']);
  });

  it('reads a summary row and survives missing members', () => {
    expect(toTenantSummary({ id: 'a', code: 'x', name: 'X', status: 'Active', isolation_mode: 'POOL', plan_code: 'STANDARD', license_status: 'FULL' })).toEqual({
      id: 'a',
      code: 'x',
      name: 'X',
      status: 'Active',
      isolationMode: 'POOL',
      planCode: 'STANDARD',
      licenseStatus: 'FULL',
    });
    expect(toTenantSummary({ id: 'b', code: 'y' })).toMatchObject({ name: 'y', status: '', planCode: undefined });
    expect(toTenantSummary(undefined)).toMatchObject({ id: '', code: '' });
  });

  it('reads a detail with its run and finds the failed step', () => {
    const detail = toTenantDetail({
      id: 'a',
      code: 'x',
      status: 'Failed',
      version: 4,
      provisioning: {
        run_id: 'r1',
        attempt: 2,
        current_step: 'DNS_SUBDOMAIN',
        steps: [
          { step: 'IDP_ORG', status: 'DONE', attempts: 1 },
          { step: 'DNS_SUBDOMAIN', status: 'FAILED', attempts: 4, error_code: 'DOMAIN_TAKEN' },
        ],
      },
    });
    expect(detail.version).toBe(4);
    expect(detail.run?.currentStep).toBe('DNS_SUBDOMAIN');
    expect(failedStepOf(detail.run)).toEqual({ step: 'DNS_SUBDOMAIN', status: 'FAILED', attempts: 4, errorCode: 'DOMAIN_TAKEN' });
    expect(toTenantDetail({ id: 'b', code: 'z', status: 'Active', version: 1 }).run).toBeUndefined();
    expect(failedStepOf(undefined)).toBeUndefined();
    expect(toTenantDetail(undefined)).toMatchObject({ id: '', version: 0 });
  });
});

const problem = (code: string, init: { status?: number; detail?: string; extensions?: Record<string, unknown> } = {}): ApiError =>
  new ApiError({ status: init.status ?? 409, code, detail: init.detail, extensions: init.extensions, correlationId: 'corr-1' });

describe('describeProblem', () => {
  it('names the field a code is about, or the one the server names', () => {
    expect(describeProblem(problem('TENANT_CODE_TAKEN'))).toMatchObject({ reason: 'codeTaken', field: 'code' });
    expect(describeProblem(problem('DOMAIN_TAKEN'))).toMatchObject({ reason: 'domainTaken', field: 'platform_subdomain' });
    expect(describeProblem(problem('PLAN_NOT_PUBLISHED'))).toMatchObject({ reason: 'planNotPublished', field: 'plan_version_id' });
    expect(describeProblem(problem('PLACEMENT_UNAVAILABLE', { status: 422 }))).toMatchObject({ reason: 'placementUnavailable', field: 'region' });
    expect(describeProblem(problem('VALIDATION_FAILED', { status: 422, detail: 'initial_owner_email' }))).toMatchObject({ reason: 'invalid', field: 'initial_owner_email' });
    expect(describeProblem(problem('VALIDATION_FAILED', { status: 422, detail: 'nonsense' }))).toMatchObject({ reason: 'invalid', field: undefined });
  });

  it('maps the other failures without a field', () => {
    expect(describeProblem(problem('VERSION_CONFLICT', { extensions: { current_version: 7 } }))).toMatchObject({ reason: 'conflict', currentVersion: 7 });
    expect(describeProblem(problem('VERSION_CONFLICT'))).toMatchObject({ reason: 'conflict', currentVersion: undefined });
    expect(describeProblem(problem('MFA_REQUIRED', { status: 403 }))).toMatchObject({ reason: 'stepUp' });
    expect(describeProblem(problem('SESSION_EXPIRED', { status: 401 }))).toMatchObject({ reason: 'session' });
    expect(describeProblem(problem(NETWORK_ERROR_CODE, { status: 0 }))).toMatchObject({ reason: 'offline' });
    expect(describeProblem(problem('TENANT_STATE_INVALID'))).toMatchObject({ reason: 'stateInvalid', field: undefined });
    expect(describeProblem(problem('ENTITLEMENT_DENIED', { status: 403 }))).toMatchObject({ reason: 'denied' });
    expect(describeProblem(problem('SOMETHING_ELSE', { status: 500 }))).toMatchObject({ reason: 'general' });
    expect(describeProblem(new Error('network'))).toMatchObject({ reason: 'general', field: undefined });
  });
});
