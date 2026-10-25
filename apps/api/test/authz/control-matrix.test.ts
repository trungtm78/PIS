import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROL_OPERATIONS, CONTROL_ROLE_NAMES, controlCasesFor } from './control-matrix';

const CONTROL_COMMANDS: readonly string[] = (
  JSON.parse(readFileSync(join(__dirname, 'matrix-commands.json'), 'utf8')) as { controlCommands: string[] }
).controlCommands;

describe('control-plane authorization matrix generator', () => {
  it('lists every control command of matrix-commands.json and no command that is missing there', () => {
    const commands = CONTROL_OPERATIONS.filter((operation) => operation.method !== 'GET').map((operation) => operation.operationId);
    expect([...commands].sort()).toEqual([...CONTROL_COMMANDS].sort());
  });

  it('gives one case per operation and realm role, allowing exactly the roles whose permissions cover the operation', () => {
    const cases = controlCasesFor(CONTROL_OPERATIONS);
    expect(cases).toHaveLength(CONTROL_OPERATIONS.length * CONTROL_ROLE_NAMES.length);
    expect(new Set(cases.map((matrixCase) => matrixCase.id)).size).toBe(cases.length);
    const verdict = (operationId: string): Record<string, string> =>
      Object.fromEntries(cases.filter((matrixCase) => matrixCase.operationId === operationId).map((matrixCase) => [matrixCase.role, matrixCase.expected]));
    expect(verdict('requestTenantProvisioning')).toEqual({ SystemAdmin: 'allow', PlatformOperator: 'deny', BillingOperator: 'deny', SupportOperator: 'deny' });
    expect(verdict('retryTenantProvisioning')).toEqual(verdict('requestTenantProvisioning'));
    expect(verdict('suspendTenant')).toEqual(verdict('requestTenantProvisioning'));
    expect(verdict('resumeTenant')).toEqual(verdict('requestTenantProvisioning'));
    expect(verdict('assignTenantOwner')).toEqual(verdict('requestTenantProvisioning'));
    expect(verdict('post_licenses')).toEqual({ SystemAdmin: 'allow', PlatformOperator: 'deny', BillingOperator: 'deny', SupportOperator: 'deny' });
    expect(verdict('post_licenses_id_revoke')).toEqual(verdict('post_licenses'));
    for (const operationId of ['suspendLicense', 'reinstateLicense']) expect(verdict(operationId)).toEqual(verdict('post_licenses'));
    for (const operationId of ['getSystemLicense', 'listSystemTenantLicenses']) expect(verdict(operationId)).toEqual({ SystemAdmin: 'allow', PlatformOperator: 'allow', BillingOperator: 'allow', SupportOperator: 'deny' });
    expect(verdict('putSystemTenantThemeDraft')).toEqual(verdict('post_licenses'));
    expect(verdict('reviewSystemTenantTheme')).toEqual(verdict('post_licenses'));
    expect(verdict('publishSystemTenantTheme')).toEqual(verdict('post_licenses'));
    expect(verdict('uploadSystemTenantThemeAsset')).toEqual(verdict('post_licenses'));
    expect(verdict('getSystemTenantThemeDraft')).toEqual(verdict('post_licenses'));
    expect(verdict('listSystemTenantThemeVersions')).toEqual(verdict('post_licenses'));
    expect(verdict('listSystemTenants')).toEqual({ SystemAdmin: 'allow', PlatformOperator: 'allow', BillingOperator: 'allow', SupportOperator: 'deny' });
    expect(verdict('getSystemTenant')).toEqual(verdict('listSystemTenants'));
    expect(verdict('getTenantUsage')).toEqual(verdict('listSystemTenants'));
    expect(verdict('getTenantSubscription')).toEqual(verdict('listSystemTenants'));
    expect(verdict('listTenantEntitlementOverrides')).toEqual(verdict('listSystemTenants'));
    for (const operationId of ['createSubscription', 'previewPlanChange', 'changeSubscriptionPlan', 'cancelSubscription', 'requestEntitlementOverride', 'decideEntitlementOverride', 'revokeEntitlementOverride']) expect(verdict(operationId)).toEqual({ SystemAdmin: 'allow', PlatformOperator: 'deny', BillingOperator: 'allow', SupportOperator: 'deny' });
    for (const operationId of ['listPlanVersions', 'createPlanVersion', 'publishPlanVersion']) expect(verdict(operationId)).toEqual({ SystemAdmin: 'allow', PlatformOperator: 'deny', BillingOperator: 'allow', SupportOperator: 'deny' });
  });

  it('derives the permission from the generated table', () => {
    expect(CONTROL_OPERATIONS.map((operation) => operation.permission)).toEqual([...Array<string>(5).fill('system.tenant.manage'), ...Array<string>(4).fill('system.license.manage'), 'system.tenant.read', 'system.tenant.read', ...Array<string>(6).fill('system.theme.manage'), 'system.tenant.read', 'system.tenant.read', ...Array<string>(3).fill('system.billing.manage'), 'system.tenant.read', ...Array<string>(4).fill('system.billing.manage'), 'system.tenant.read', ...Array<string>(3).fill('system.billing.manage'), 'system.tenant.read']);
  });
});
