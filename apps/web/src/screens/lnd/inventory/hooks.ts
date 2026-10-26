import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toInventoryLine } from './model';
import type { AnswerBody, InventoryLine, RecordBody } from './model';

/** The records of one household, by parcel. */
export function useInventory(householdId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<InventoryLine[]>({
    queryKey: [...key, 'inventory', householdId ?? ''],
    queryFn: async () => (await client.readAll('listInventoryRecords', { query: { household_id: householdId ?? '' } })).flatMap((raw) => toInventoryLine(raw) ?? []),
    enabled: key[1] !== undefined && householdId !== undefined,
    retry: false,
  });
}

/** The counting of an asset: one idempotency attempt per intention, every cached read of the land screens refreshed on success. */
export function useRecordInventory() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: RecordBody) => client.command('recordInventory', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface AnswerInput {
  id: string;
  version: number;
  body: AnswerBody;
}

/** The answer of the household to a record, under the version of the record the caller saw. */
export function useAnswerInventory() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: AnswerInput) => client.command('confirmInventory', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
