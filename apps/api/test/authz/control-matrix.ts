import { PERMISSIONS } from '@machvon/contracts';
import { CONTROL_ROLES, holdsPermission } from '@machvon/kernel';
import type { ControlRole } from '@machvon/kernel';

/** A control-plane operation of the matrix: its permission comes from the generated table, never from this file. */
export interface ControlOperation {
  operationId: string;
  permission: string;
  method: 'GET' | 'POST' | 'PUT';
  /** Path with `{tenantId}` for the tenant the request names, or `{id}` for the license a license command names. */
  path: string;
}

export interface ControlCase {
  id: string;
  operationId: string;
  role: ControlRole;
  /** What the realm role must get: the operation is allowed only to a role whose permissions cover the permission. */
  expected: 'allow' | 'deny';
}

export const CONTROL_ROLE_NAMES = Object.keys(CONTROL_ROLES) as ControlRole[];

/**
 * One case per control-plane operation and realm role. A role allowed by its permissions must pass the guard, any other
 * must get 403 SCOPE_DENIED (and, for a command, a DENIED audit row on the platform tenant). The expectation is
 * derived from CONTROL_ROLES and the permission of the operation, so adding a role or an operation extends the matrix.
 */
export function controlCasesFor(operations: readonly ControlOperation[]): ControlCase[] {
  return operations.flatMap((operation) =>
    CONTROL_ROLE_NAMES.map((role) => ({
      id: `${operation.operationId}:${role}`,
      operationId: operation.operationId,
      role,
      expected: holdsPermission(new Set(CONTROL_ROLES[role]), operation.permission) ? ('allow' as const) : ('deny' as const),
    })),
  );
}

/** The control-plane operations of the registry: the commands of the matrix file and the two reads. */
export const CONTROL_OPERATIONS: readonly ControlOperation[] = [
  { operationId: 'requestTenantProvisioning', permission: PERMISSIONS.requestTenantProvisioning, method: 'POST', path: '/system/tenants' },
  { operationId: 'retryTenantProvisioning', permission: PERMISSIONS.retryTenantProvisioning, method: 'POST', path: '/system/tenants/{tenantId}/provisioning/retry' },
  { operationId: 'suspendTenant', permission: PERMISSIONS.suspendTenant, method: 'POST', path: '/system/tenants/{tenantId}/suspend' },
  { operationId: 'resumeTenant', permission: PERMISSIONS.resumeTenant, method: 'POST', path: '/system/tenants/{tenantId}/resume' },
  { operationId: 'assignTenantOwner', permission: PERMISSIONS.assignTenantOwner, method: 'POST', path: '/system/tenants/{tenantId}/owners' },
  { operationId: 'post_licenses', permission: PERMISSIONS.post_licenses, method: 'POST', path: '/licenses' },
  { operationId: 'post_licenses_id_revoke', permission: PERMISSIONS.post_licenses_id_revoke, method: 'POST', path: '/licenses/{id}/revoke' },
  { operationId: 'renewLicense', permission: PERMISSIONS.renewLicense, method: 'POST', path: '/licenses/{id}/renew' },
  { operationId: 'suspendLicense', permission: PERMISSIONS.suspendLicense, method: 'POST', path: '/licenses/{id}/suspend' },
  { operationId: 'reinstateLicense', permission: PERMISSIONS.reinstateLicense, method: 'POST', path: '/licenses/{id}/reinstate' },
  { operationId: 'getSystemLicense', permission: PERMISSIONS.getSystemLicense, method: 'GET', path: '/system/licenses/{id}' },
  { operationId: 'listSystemTenantLicenses', permission: PERMISSIONS.listSystemTenantLicenses, method: 'GET', path: '/system/tenants/{tenantId}/licenses' },
  { operationId: 'getSystemTenantThemeDraft', permission: PERMISSIONS.getSystemTenantThemeDraft, method: 'GET', path: '/system/tenants/{tenantId}/theme/draft' },
  { operationId: 'putSystemTenantThemeDraft', permission: PERMISSIONS.putSystemTenantThemeDraft, method: 'PUT', path: '/system/tenants/{tenantId}/theme/draft' },
  { operationId: 'listSystemTenantThemeVersions', permission: PERMISSIONS.listSystemTenantThemeVersions, method: 'GET', path: '/system/tenants/{tenantId}/theme/versions' },
  { operationId: 'reviewSystemTenantTheme', permission: PERMISSIONS.reviewSystemTenantTheme, method: 'POST', path: '/system/tenants/{tenantId}/theme/reviews' },
  { operationId: 'publishSystemTenantTheme', permission: PERMISSIONS.publishSystemTenantTheme, method: 'POST', path: '/system/tenants/{tenantId}/theme/publish' },
  { operationId: 'uploadSystemTenantThemeAsset', permission: PERMISSIONS.uploadSystemTenantThemeAsset, method: 'POST', path: '/system/tenants/{tenantId}/theme/assets' },
  { operationId: 'listSystemTenants', permission: PERMISSIONS.listSystemTenants, method: 'GET', path: '/system/tenants' },
  { operationId: 'getSystemTenant', permission: PERMISSIONS.getSystemTenant, method: 'GET', path: '/system/tenants/{tenantId}' },
  { operationId: 'listPlanVersions', permission: PERMISSIONS.listPlanVersions, method: 'GET', path: '/system/plans' },
  { operationId: 'createPlanVersion', permission: PERMISSIONS.createPlanVersion, method: 'POST', path: '/system/plans' },
  { operationId: 'publishPlanVersion', permission: PERMISSIONS.publishPlanVersion, method: 'POST', path: '/system/plans/{planVersionId}/publish' },
  { operationId: 'getTenantUsage', permission: PERMISSIONS.getTenantUsage, method: 'GET', path: '/system/tenants/{tenantId}/usage' },
  { operationId: 'createSubscription', permission: PERMISSIONS.createSubscription, method: 'POST', path: '/system/tenants/{tenantId}/subscriptions' },
  { operationId: 'previewPlanChange', permission: PERMISSIONS.previewPlanChange, method: 'POST', path: '/system/subscriptions/{subscriptionId}/plan-change-previews' },
  { operationId: 'changeSubscriptionPlan', permission: PERMISSIONS.changeSubscriptionPlan, method: 'POST', path: '/system/subscriptions/{subscriptionId}/plan-change' },
  { operationId: 'cancelSubscription', permission: PERMISSIONS.cancelSubscription, method: 'POST', path: '/system/subscriptions/{subscriptionId}/cancel' },
  { operationId: 'getTenantSubscription', permission: PERMISSIONS.getTenantSubscription, method: 'GET', path: '/system/tenants/{tenantId}/subscription' },
  { operationId: 'requestEntitlementOverride', permission: PERMISSIONS.requestEntitlementOverride, method: 'POST', path: '/system/tenants/{tenantId}/entitlement-overrides' },
  { operationId: 'decideEntitlementOverride', permission: PERMISSIONS.decideEntitlementOverride, method: 'POST', path: '/system/entitlement-overrides/{overrideId}/decision' },
  { operationId: 'revokeEntitlementOverride', permission: PERMISSIONS.revokeEntitlementOverride, method: 'POST', path: '/system/entitlement-overrides/{overrideId}/revoke' },
  { operationId: 'listTenantEntitlementOverrides', permission: PERMISSIONS.listTenantEntitlementOverrides, method: 'GET', path: '/system/tenants/{tenantId}/entitlement-overrides' },
  { operationId: 'runBillingCycle', permission: PERMISSIONS.runBillingCycle, method: 'POST', path: '/system/billing-runs' },
  { operationId: 'issueEInvoice', permission: PERMISSIONS.issueEInvoice, method: 'POST', path: '/system/invoices/{invoiceId}/issue' },
  { operationId: 'listTenantInvoices', permission: PERMISSIONS.listTenantInvoices, method: 'GET', path: '/system/tenants/{tenantId}/invoices' },
  { operationId: 'createAdjustmentInvoice', permission: PERMISSIONS.createAdjustmentInvoice, method: 'POST', path: '/system/invoices/{invoiceId}/adjustments' },
  { operationId: 'createReplacementInvoice', permission: PERMISSIONS.createReplacementInvoice, method: 'POST', path: '/system/invoices/{invoiceId}/replacements' },
  { operationId: 'listBillingPayments', permission: PERMISSIONS.listBillingPayments, method: 'GET', path: '/system/payments' },
  { operationId: 'matchBillingPayment', permission: PERMISSIONS.matchBillingPayment, method: 'POST', path: '/system/payments/{paymentId}/match' },
  { operationId: 'requestSupportAccess', permission: PERMISSIONS.requestSupportAccess, method: 'POST', path: '/support-access' },
  { operationId: 'startTenantOffboarding', permission: PERMISSIONS.startTenantOffboarding, method: 'POST', path: '/system/tenants/{tenantId}/offboard' },
  { operationId: 'archiveTenant', permission: PERMISSIONS.archiveTenant, method: 'POST', path: '/system/tenants/{tenantId}/archive' },
  { operationId: 'listSystemTenantExports', permission: PERMISSIONS.listSystemTenantExports, method: 'GET', path: '/system/tenants/{tenantId}/exports' },
  { operationId: 'listTenantDomains', permission: PERMISSIONS.listTenantDomains, method: 'GET', path: '/system/tenants/{tenantId}/domains' },
  { operationId: 'addTenantDomain', permission: PERMISSIONS.addTenantDomain, method: 'POST', path: '/system/tenants/{tenantId}/domains' },
  { operationId: 'verifyTenantDomain', permission: PERMISSIONS.verifyTenantDomain, method: 'POST', path: '/system/tenant-domains/{domainId}/verify' },
  { operationId: 'removeTenantDomain', permission: PERMISSIONS.removeTenantDomain, method: 'POST', path: '/system/tenant-domains/{domainId}/remove' },
  { operationId: 'issueSupportAccessToken', permission: PERMISSIONS.issueSupportAccessToken, method: 'POST', path: '/support-access/{id}/token' },
];

