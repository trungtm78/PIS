import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { isPending, toExportPage, toLink, toManifest, toTenantExit } from './model';
import type { ExportPage, ExportScope, LinkView, ManifestView, TenantExitView } from './model';

/** How often the list is read while an export is being made, and the pace of the one that is not (a link ends, a delivery happens elsewhere). */
export const WAITING_REFRESH_MS = 5_000;
export const IDLE_REFRESH_MS = 60_000;

export const exportsKey = (sessionTenantId: string | undefined) => ['sas', 'exports', sessionTenantId] as const;
export const exitKey = (sessionTenantId: string | undefined, tenantId: string | undefined) => ['sas', 'exit', sessionTenantId, tenantId] as const;

/** The exports of the tenant of the session, the newest first (`listTenantExports`); read again quickly while one is being made. */
export function useTenantExports(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<ExportPage, Error, { pages: ExportPage[] }, ReturnType<typeof exportsKey>, string | undefined>({
    queryKey: exportsKey(tenant?.id),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toExportPage(await client.read('listTenantExports', { path: { id: tenant?.id as string }, query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page.items.some(isPending)) === true ? WAITING_REFRESH_MS : IDLE_REFRESH_MS),
    retry: false,
  });
}

export interface RequestExportInput {
  scope: ExportScope;
  publicKeyPem: string | undefined;
  reason: string;
  /** The number of exports the caller saw (`exports_version`): the If-Match. */
  version: number;
}

export function useRequestExport() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RequestExportInput) =>
      client.command('post_tenants_id_export', {
        path: { id: tenant?.id as string },
        body: { scope: input.scope, reason: input.reason, ...(input.publicKeyPem === undefined ? {} : { encryption_public_key_pem: input.publicKeyPem }) } as never,
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: exportsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The manifest of an export that is Ready or Delivered (`getTenantExportManifest`), read when the owner opens it. */
export function useManifest(exportId: string | undefined) {
  const client = useApiClient();
  return useQuery<ManifestView | undefined>({
    queryKey: ['sas', 'export-manifest', exportId],
    queryFn: async () => toManifest(await client.read('getTenantExportManifest', { path: { id: exportId as string } })),
    enabled: exportId !== undefined,
    retry: false,
  });
}

/** The link to one file, asked for again every time: the right, the state and the 72 hours are judged on each ask (`downloadTenantExportFile`). */
export function useFileLink() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  return useMutation<LinkView | undefined, Error, { exportId: string; path: string }>({
    mutationFn: async (input) => toLink(await client.read('downloadTenantExportFile', { path: { id: input.exportId }, query: { path: input.path } })),
    // A file counts as downloaded when the link is redeemed: the list is read again soon after.
    onSuccess: () => void window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: exportsKey(tenant?.id) }), WAITING_REFRESH_MS / 2),
  });
}

/** What the System Admin sees of a tenant that leaves: the window, whether an export was delivered, the legal holds in force and the exports (`listSystemTenantExports`). */
export function useTenantExit(tenantId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<TenantExitView | undefined>({
    queryKey: exitKey(tenant?.id, tenantId),
    queryFn: async () => toTenantExit(await client.read('listSystemTenantExports', { path: { tenantId: tenantId as string } })),
    enabled: enabled && tenantId !== undefined,
    retry: false,
  });
}

export interface OffboardInput {
  tenantId: string;
  version: number;
  contractEndDate: string;
  windowDays: number;
  reason: string;
}

export interface ArchiveInput {
  tenantId: string;
  version: number;
  reason: string;
}

function useExitCommand<I extends { tenantId: string }>(run: (client: ReturnType<typeof useApiClient>, input: I, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: I) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async (_result, input) => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: exitKey(tenant?.id, input.tenantId) });
      // The registry screens show the new state too.
      await queryClient.invalidateQueries({ queryKey: ['sas', 'tenants'] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Starts the offboarding of a tenant (`startTenantOffboarding`). */
export function useOffboard() {
  return useExitCommand<OffboardInput>((client, input, attempt) =>
    client.command('startTenantOffboarding', {
      path: { tenantId: input.tenantId },
      body: { contract_end_date: input.contractEndDate, export_window_days: input.windowDays, reason: input.reason } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}

/** Archives an Offboarding tenant (`archiveTenant`). */
export function useArchive() {
  return useExitCommand<ArchiveInput>((client, input, attempt) => client.command('archiveTenant', { path: { tenantId: input.tenantId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}

/** Brings an Offboarding tenant back to Active inside its window: the contract was renewed (`resumeTenant`). */
export function useRenew() {
  return useExitCommand<ArchiveInput>((client, input, attempt) => client.command('resumeTenant', { path: { tenantId: input.tenantId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}
