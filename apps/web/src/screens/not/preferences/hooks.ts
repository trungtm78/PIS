import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toPreferenceView } from './model';
import type { PreferenceBody, PreferenceView } from './model';

export const preferencesKey = (tenantId: string | undefined) => ['not', 'preferences', tenantId] as const;

/** The preferences of the member, with the version a save is made under; keyed by tenant so a switch never shows another tenant's choices. */
export function usePreferences() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PreferenceView>({
    queryKey: preferencesKey(tenant?.id),
    queryFn: async () => {
      const view = toPreferenceView(await client.read('getMyNotificationPreferences', {}));
      if (view === undefined) throw new Error('the preferences answer is not readable');
      return view;
    },
    enabled: tenant !== undefined,
    retry: false,
  });
}

export interface SaveInput {
  version: number;
  body: PreferenceBody;
}

/** Saves the whole set under the version the member saw; one idempotency attempt per intention. */
export function useSavePreferences() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: SaveInput) => client.command('updateMyNotificationPreferences', { body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: preferencesKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
