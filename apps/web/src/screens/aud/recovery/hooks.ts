import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../hooks';
import { useAudCommand } from '../recommendation/hooks';
import type { Versioned } from '../recommendation/hooks';
import { toOverview, toRecoveryLine, toRecoverySummary } from './model';
import type { LinkBody, Overview, RecoveryLine, RecoverySummary } from './model';

/** The money of an engagement and its two rates, each with its numerator and its denominator, the recommendations and the exceptions that are open. */
export function useRecoverySummary(engagementId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RecoverySummary | undefined>({
    queryKey: [...key, 'recovery-summary', engagementId ?? ''],
    queryFn: async () => toRecoverySummary(await client.read('getAuditRecoverySummary', { path: { id: engagementId ?? '' } })),
    enabled: key[1] !== undefined && engagementId !== undefined,
    retry: false,
  });
}

/** The lines of the ledger of an engagement, oldest first. */
export function useRecoveryLines(engagementId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RecoveryLine[]>({
    queryKey: [...key, 'recovery-lines', engagementId ?? ''],
    queryFn: async () => {
      const items: unknown[] = await client.readAll('listAuditRecoveryLinks', { path: { id: engagementId ?? '' } });
      return items.flatMap((raw) => toRecoveryLine(raw) ?? []);
    },
    enabled: key[1] !== undefined && engagementId !== undefined,
    retry: false,
  });
}

/** The figures of the overview over the engagements in the scope of the caller. */
export function useOverview() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Overview | undefined>({
    queryKey: [...key, 'overview'],
    queryFn: async () => toOverview(await client.read('getAuditOverview', {})),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** A line entered by hand, under the version of the recommendation the screen showed. */
export const useLinkRecovery = () =>
  useAudCommand((client, input: Versioned<LinkBody>, attempt) => client.command('linkAuditRecovery', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));

/** The reversal of a line, with the reason in words: a line of the opposite sign, nothing deleted. */
export const useReverseRecovery = () =>
  useAudCommand((client, input: { id: string; reason: string }, attempt) => client.command('reverseAuditRecovery', { path: { id: input.id }, body: { reason: input.reason }, attempt }));
