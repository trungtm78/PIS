import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toDevice, toProfile, toSession } from './model';
import type { DeviceView, ProfileView, SessionView } from './model';

// What the screens show is the membership's own, so the membership is part of every key.
const rootKey = (tenantId: string | undefined, membershipId: string | undefined) => ['iam', 'self', tenantId, membershipId] as const;

const items = (raw: unknown): unknown[] => {
  const list = typeof raw === 'object' && raw !== null ? (raw as { items?: unknown }).items : undefined;
  return Array.isArray(list) ? list : [];
};

export function useProfile() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ProfileView | null>({
    queryKey: [...rootKey(tenant?.id, tenant?.membershipId), 'profile'],
    queryFn: async () => toProfile(await client.read('getMyProfile', {})) ?? null,
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useSessions() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<SessionView[]>({
    queryKey: [...rootKey(tenant?.id, tenant?.membershipId), 'sessions'],
    queryFn: async () => items(await client.read('listMySessions', {})).flatMap((raw) => toSession(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useDevices() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DeviceView[]>({
    queryKey: [...rootKey(tenant?.id, tenant?.membershipId), 'devices'],
    queryFn: async () => items(await client.read('listMyDevices', {})).flatMap((raw) => toDevice(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** A command of these screens: one idempotency attempt per payload, and everything of the membership read again once it succeeded. */
function useSelfCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: rootKey(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useUpdateProfile() {
  const client = useApiClient();
  return useSelfCommand<{ version: number; body: Record<string, string> }>((input, attempt) => client.command('updateMyProfile', { body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useRevokeSession() {
  const client = useApiClient();
  return useSelfCommand<{ id: string; reason: string }>((input, attempt) => client.command('revokeMySession', { path: { sessionId: input.id }, body: { reason: input.reason }, attempt }));
}

export function useRevokeDevice() {
  const client = useApiClient();
  return useSelfCommand<{ id: string; reason: string }>((input, attempt) => client.command('revokeMyDevice', { path: { deviceId: input.id }, body: { reason: input.reason }, attempt }));
}
