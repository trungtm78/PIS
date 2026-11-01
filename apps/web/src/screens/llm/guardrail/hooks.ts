import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { llmRoot } from '../hooks';
import { toGuardProfile } from './model';
import type { GuardProfile } from './model';

/** The profiles in force, with the tools they may call and the days they keep. */
export function useGuardProfiles() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<GuardProfile[]>({
    queryKey: [...llmRoot(tenant?.id), 'guard-profiles', tenant?.membershipId],
    queryFn: async () => (await client.readAll('get_resources_model_profile_version')).flatMap((raw) => toGuardProfile(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}
