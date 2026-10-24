import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { toGuarantee } from './guarantee-model';
import type { ExtendBody, Guarantee, RegisterBody, ReleaseBody, VerifyBody } from './guarantee-model';
import { useCommand, useScopeKey } from './hooks';

/** The guarantees in the scope of the caller, in the order of the read (by contract code and expiry). */
export function useGuarantees() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Guarantee[]>({
    queryKey: [...key, 'guarantees'],
    queryFn: async () => (await client.readAll('get_resources_guarantee')).flatMap((raw) => toGuarantee(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The ACTIVE guarantees that expire within `withinDays` calendar days, the soonest first, with the days left. */
export function useExpiringGuarantees(withinDays: number, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Guarantee[]>({
    queryKey: [...key, 'guarantees-expiring', withinDays],
    queryFn: async () => {
      const answer = (await client.read('listExpiringGuarantees', { query: { within_days: withinDays, limit: 200 } })) as { items?: unknown[] };
      return (answer.items ?? []).flatMap((raw) => toGuarantee(raw) ?? []);
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export interface RegisterInput {
  contractId: string;
  body: RegisterBody;
}

export function useRegisterGuarantee() {
  const client = useApiClient();
  return useCommand<RegisterInput>((input, attempt) => client.command('registerGuarantee', { path: { id: input.contractId }, body: input.body, attempt }));
}

export interface VerifyInput {
  id: string;
  version: number;
  body: VerifyBody;
}

export function useVerifyGuarantee() {
  const client = useApiClient();
  return useCommand<VerifyInput>((input, attempt) => client.command('verifyGuarantee', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface ExtendInput {
  id: string;
  version: number;
  body: ExtendBody;
}

export function useExtendGuarantee() {
  const client = useApiClient();
  return useCommand<ExtendInput>((input, attempt) => client.command('extendGuarantee', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface ReleaseInput {
  id: string;
  version: number;
  body: ReleaseBody;
}

export function useReleaseGuarantee() {
  const client = useApiClient();
  return useCommand<ReleaseInput>((input, attempt) => client.command('releaseGuarantee', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
