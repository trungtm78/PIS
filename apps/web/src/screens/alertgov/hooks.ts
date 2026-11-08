import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { profileBody, toAbsences, toCoverage, toDigest, toEscalations, toHealth, toProfile } from './model';
import type { ProfileInput } from './model';

/** What these screens show depends on who is signed in (the units they read, the person they stand in for): the tenant and the membership are in every key. */
export function useScopeKey(): readonly ['alertgov', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['alertgov', tenant?.id, tenant?.membershipId];
}

const REFRESH_MS = 60_000;
const read = (value: Record<string, string | undefined>): never => value as never;

/** The fourteen indicators of the alert system for a window of days and, when asked, one unit (HOME-13). The page is read again a minute after the last read and when the window is focused again. */
export function useAlertHealth(days: number, unitId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'health', days, unitId ?? ''],
    queryFn: async () => {
      const parsed = toHealth(await client.read('getAlertHealth' as never, { query: read({ days: String(days), ...(unitId === undefined ? {} : { unit_id: unitId }) }) } as never));
      if (parsed === undefined) throw new Error('HEALTH_UNUSABLE');
      return parsed;
    },
    enabled: enabled && key[1] !== undefined,
    refetchInterval: REFRESH_MS,
    retry: false,
  });
}

/** The levels that were sent up, open ones or all (NOT-19). */
export function useEscalations(status: 'open' | 'all', enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'escalations', status],
    queryFn: async () => {
      const parsed = toEscalations(await client.read('listAlertEscalations' as never, { query: read({ status, limit: '100' }) } as never));
      if (parsed === undefined) throw new Error('ESCALATIONS_UNUSABLE');
      return parsed;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export function useMyProfile(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'profile'],
    queryFn: async () => {
      const parsed = toProfile(await client.read('getMyAlertProfile' as never, {} as never));
      if (parsed === undefined) throw new Error('PROFILE_UNUSABLE');
      return parsed;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** What the morning card would hold now. */
export function useMyDigest(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'digest'],
    queryFn: async () => {
      const parsed = toDigest(await client.read('getMyAlertDigest' as never, {} as never));
      if (parsed === undefined) throw new Error('DIGEST_UNUSABLE');
      return parsed;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The absences of the person (mine) or of the people they manage (ADM-25). */
export function useAbsences(mine: boolean, state: 'current' | 'all', enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'absences', mine, state],
    queryFn: async () => {
      const parsed = toAbsences(await client.read('listAlertAbsences' as never, { query: read({ mine: String(mine), state }) } as never));
      if (parsed === undefined) throw new Error('ABSENCES_UNUSABLE');
      return parsed;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The coverage of the positions of leadership and the gaps in the receivers of alerts. */
export function useCoverageReport(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'coverage'],
    queryFn: async () => {
      const parsed = toCoverage(await client.read('getAlertCoverageReport' as never, {} as never));
      if (parsed === undefined) throw new Error('COVERAGE_UNUSABLE');
      return parsed;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, every cached read of these screens (and the alert centre) refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, Error, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useAcknowledgeEscalation() {
  const client = useApiClient();
  return useCommand<{ id: string }>((input, attempt) => client.command('acknowledgeAlertEscalation' as never, { path: { id: input.id }, body: {}, attempt } as never));
}

export function useSaveProfile() {
  const client = useApiClient();
  return useCommand<{ profile: ProfileInput; version: number }>((input, attempt) => client.command('updateMyAlertProfile' as never, { body: profileBody(input.profile), ifMatchVersion: input.version, attempt } as never));
}

export interface DeclareInput {
  membershipId: string | undefined;
  kind: string;
  validFrom: string;
  validUntil: string;
  reason: string | undefined;
}

export function useDeclareAbsence() {
  const client = useApiClient();
  return useCommand<DeclareInput>((input, attempt) =>
    client.command('declareAlertAbsence' as never, {
      body: { ...(input.membershipId === undefined ? {} : { membership_id: input.membershipId }), kind: input.kind, valid_from: input.validFrom, valid_until: input.validUntil, ...(input.reason === undefined ? {} : { reason: input.reason }) },
      attempt,
    } as never),
  );
}

export function useEndAbsence() {
  const client = useApiClient();
  return useCommand<{ id: string; version: number; status: 'ENDED' | 'CANCELLED'; reason: string }>((input, attempt) =>
    client.command('endAlertAbsence' as never, { path: { id: input.id }, body: { status: input.status, reason: input.reason }, ifMatchVersion: input.version, attempt } as never),
  );
}

export interface ProposeInput {
  absenceId: string;
  deputyId: string;
  validFrom: string;
  validUntil: string;
  scopeKind: 'ALL' | 'SOURCES';
  sources: string[];
}

export function useProposeCover() {
  const client = useApiClient();
  return useCommand<ProposeInput>((input, attempt) =>
    client.command('proposeAlertCover' as never, {
      path: { id: input.absenceId },
      body: { deputy_id: input.deputyId, valid_from: input.validFrom, valid_until: input.validUntil, scope_kind: input.scopeKind, sources: input.sources },
      attempt,
    } as never),
  );
}

export function useDecideCover() {
  const client = useApiClient();
  return useCommand<{ id: string; version: number; decision: 'APPROVE' | 'REJECT'; note: string | undefined }>((input, attempt) =>
    client.command('decideAlertCover' as never, { path: { id: input.id }, body: { decision: input.decision, ...(input.note === undefined ? {} : { note: input.note }) }, ifMatchVersion: input.version, attempt } as never),
  );
}

export function useRevokeCover() {
  const client = useApiClient();
  return useCommand<{ id: string; version: number; reason: string }>((input, attempt) => client.command('revokeAlertCover' as never, { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt } as never));
}
