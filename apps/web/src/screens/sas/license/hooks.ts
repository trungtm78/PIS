import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { entitlementsKey, tenantsKey } from '../tenants/hooks';
import { renewBody } from './renew';
import type { RenewValues } from './renew';
import { issueBody } from './rules';
import type { IssueValues, LicenseAction } from './rules';
import { toLicense, toLicensePage } from './types';
import type { License, LicensePage } from './types';

export const LICENSE_PAGE_SIZE = 50;

export const licenseKey = (sessionTenantId: string | undefined, licenseId: string) => ['sas', 'license', sessionTenantId, licenseId] as const;
export const tenantLicensesKey = (sessionTenantId: string | undefined, tenantId: string) => ['sas', 'tenant-licenses', sessionTenantId, tenantId] as const;

/** One revision of any tenant (`getSystemLicense`): the signature is checked by the server on every read. */
export function useLicense(licenseId: string, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<License>({
    queryKey: licenseKey(tenant?.id, licenseId),
    queryFn: async () => toLicense(await client.read('getSystemLicense', { path: { id: licenseId } })),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The revisions of one tenant, page by page (keyset cursor); the next page is loaded on request. */
export function useTenantLicenses(tenantId: string, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<LicensePage, Error, { pages: LicensePage[] }, ReturnType<typeof tenantLicensesKey>, string | undefined>({
    queryKey: tenantLicensesKey(tenant?.id, tenantId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toLicensePage(await client.read('listSystemTenantLicenses', { path: { tenantId }, query: { limit: LICENSE_PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** What a command on a license answers (`CommandResult`). */
export interface LicenseCommandResult {
  status: string;
  resource_id?: string;
  resource_version: number;
}

// The license, the licenses of its tenant, the entitlements and the registry all show the state: a change refreshes them, so no screen keeps the old state.
function useRefreshLicenses() {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  return async (tenantId: string, licenseId: string | undefined): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: tenantLicensesKey(tenant?.id, tenantId) });
    if (licenseId !== undefined) await queryClient.invalidateQueries({ queryKey: licenseKey(tenant?.id, licenseId) });
    await queryClient.invalidateQueries({ queryKey: entitlementsKey(tenant?.id, tenantId) });
    await queryClient.invalidateQueries({ queryKey: tenantsKey(tenant?.id) });
  };
}

export interface IssueInput {
  values: IssueValues;
  entitlementVersionId: string;
}

/** Issues revision 1 of a license; one idempotency attempt per payload, so a double click or a retry issues it once. */
export function useIssueLicense() {
  const client = useApiClient();
  const refresh = useRefreshLicenses();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: IssueInput) => {
      const body = issueBody(input.values, input.entitlementVersionId);
      return (await client.command('post_licenses', { body, attempt: attempts.current.forPayload(body) })) as LicenseCommandResult;
    },
    onSuccess: async (result, input) => {
      attempts.current.done();
      await refresh(input.values.tenant_id, result.resource_id);
    },
    // A final refusal (LICENSE_RANGE_INVALID...) is replayed by the server for the same key: it ends the attempt.
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ActionInput {
  action: LicenseAction;
  license: License;
  reason: string;
}

const COMMAND_OF: Readonly<Record<LicenseAction, 'suspendLicense' | 'reinstateLicense' | 'post_licenses_id_revoke'>> = {
  suspend: 'suspendLicense',
  reinstate: 'reinstateLicense',
  revoke: 'post_licenses_id_revoke',
};

/** Suspends, reinstates or revokes a license with the version the screen showed (`If-Match`); one idempotency attempt per intention. */
export function useLicenseAction() {
  const client = useApiClient();
  const refresh = useRefreshLicenses();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: ActionInput) =>
      (await client.command(COMMAND_OF[input.action], {
        path: { id: input.license.id },
        body: { reason: input.reason },
        ifMatchVersion: input.license.version,
        attempt: attempts.current.forPayload({ action: input.action, id: input.license.id, version: input.license.version, reason: input.reason }),
      })) as LicenseCommandResult,
    onSuccess: async (_result, input) => {
      attempts.current.done();
      await refresh(input.license.tenantId, input.license.id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RenewInput {
  license: License;
  values: RenewValues;
  reason: string;
}

/**
 * Renews a license with the version the screen showed (`If-Match`): the answer names the new revision. One idempotency attempt per intention, so a double click or a retry renews once;
 * the revision, the revisions of its tenant, the entitlements and the registry are read again on success.
 */
export function useRenewLicense() {
  const client = useApiClient();
  const refresh = useRefreshLicenses();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: RenewInput) => {
      const body = renewBody(input.values, input.reason);
      return (await client.command('renewLicense', {
        path: { id: input.license.id },
        body,
        ifMatchVersion: input.license.version,
        attempt: attempts.current.forPayload({ id: input.license.id, version: input.license.version, body }),
      })) as LicenseCommandResult;
    },
    onSuccess: async (result, input) => {
      attempts.current.done();
      await refresh(input.license.tenantId, input.license.id);
      if (result.resource_id !== undefined) await refresh(input.license.tenantId, result.resource_id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}
