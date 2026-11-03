import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { isBusy, toDetail, toMigrationPage, toPlacements } from './model';
import type { DetailView, MigrationPage, PlacementView } from './model';

/** How often a migration that is moving is read, and the pace of one that waits for a person or is over (the worker moves them on the server). */
export const BUSY_REFRESH_MS = 5_000;
export const IDLE_REFRESH_MS = 30_000;
/** How often the countdown of the freeze is drawn. */
export const CLOCK_MS = 1_000;

export const migrationsKey = (sessionTenantId: string | undefined, tenantId: string | undefined) => ['sas', 'promotion', 'list', sessionTenantId, tenantId ?? 'none'] as const;
export const detailKey = (sessionTenantId: string | undefined, migrationId: string | undefined) => ['sas', 'promotion', 'detail', sessionTenantId, migrationId ?? 'none'] as const;
export const placementsKey = (sessionTenantId: string | undefined) => ['sas', 'promotion', 'placements', sessionTenantId] as const;

/** The promotions of a tenant, the newest first (`listPlacementMigrations`). */
export function useMigrations(tenantId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<MigrationPage, Error, { pages: MigrationPage[] }, ReturnType<typeof migrationsKey>, string | undefined>({
    queryKey: migrationsKey(tenant?.id, tenantId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toMigrationPage(await client.read('listPlacementMigrations', { path: { tenantId: tenantId as string }, query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined && tenantId !== undefined,
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page.items.some((item) => isBusy(item.status))) === true ? BUSY_REFRESH_MS : IDLE_REFRESH_MS),
    retry: false,
  });
}

/** One promotion with its comparison table by table (`getPlacementMigration`). */
export function useMigrationDetail(migrationId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DetailView | undefined>({
    queryKey: detailKey(tenant?.id, migrationId),
    queryFn: async () => toDetail(await client.read('getPlacementMigration', { path: { migrationId: migrationId as string } })),
    enabled: tenant !== undefined && migrationId !== undefined,
    refetchInterval: (query) => (query.state.data !== undefined && isBusy(query.state.data.migration.status) ? BUSY_REFRESH_MS : IDLE_REFRESH_MS),
    retry: false,
  });
}

/** The placements a tenant can be moved to, and how many tenants are on each (`listPlacements`). */
export function usePlacements(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PlacementView[]>({
    queryKey: placementsKey(tenant?.id),
    queryFn: async () => toPlacements(await client.read('listPlacements', {})),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The time, drawn again every second while `active`: the countdown of a freeze is a deadline, not a number that was true when it was read. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface StartInput {
  tenantId: string;
  toPlacementId: string;
  writeFreezeMaxMinutes: number;
  plannedWindowStart: string;
  reason: string;
}

export interface MigrationActionInput {
  tenantId: string;
  migrationId: string;
  version: number;
  reason: string;
}

function usePromotionMutation<I extends { tenantId: string }, R>(run: (client: ReturnType<typeof useApiClient>, input: I, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<R>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  const refresh = async (input: I): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: migrationsKey(tenant?.id, input.tenantId) });
    await queryClient.invalidateQueries({ queryKey: ['sas', 'promotion', 'detail'] });
    await queryClient.invalidateQueries({ queryKey: placementsKey(tenant?.id) });
  };
  return useMutation<R, Error, I>({
    mutationFn: (input) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async (_result, input) => {
      attempts.current.done();
      await refresh(input);
    },
    // A refused command may still have changed what the screen shows (a version moved on): everything is read again, and the form keeps what was typed.
    onError: async (error, input) => {
      attempts.current.ended(error);
      await refresh(input);
    },
  });
}

/** Plans the promotion of a tenant (`startSiloPromotion`); the worker begins the copy at the planned window. */
export function useStartPromotion() {
  return usePromotionMutation<StartInput, unknown>((client, input, attempt) =>
    client.command('startSiloPromotion', {
      path: { tenantId: input.tenantId },
      body: { to_placement_id: input.toPlacementId, write_freeze_max_minutes: input.writeFreezeMaxMinutes, planned_window_start: input.plannedWindowStart, reason: input.reason } as never,
      attempt,
    }),
  );
}

/** Approves the cutover (`approvePlacementCutover`): the platform refuses the one who started it and a copy that differs. */
export function useApproveCutover() {
  return usePromotionMutation<MigrationActionInput, unknown>((client, input, attempt) =>
    client.command('approvePlacementCutover', { path: { migrationId: input.migrationId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }),
  );
}

/** Aborts a promotion that is not over (`abortPlacementMigration`); before the cutover it is Aborted, after it is RolledBack. */
export function useAbortPromotion() {
  return usePromotionMutation<MigrationActionInput, unknown>((client, input, attempt) =>
    client.command('abortPlacementMigration', { path: { migrationId: input.migrationId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }),
  );
}
