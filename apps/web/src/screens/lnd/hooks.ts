import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import type { NoticeBody, ParcelBody, SectionBody } from './model';

// What the screen shows depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
export function useScopeKey(): readonly ['lnd', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['lnd', tenant?.id, tenant?.membershipId];
}

/** The declaration of a parcel: one idempotency attempt per intention, every cached read of the land screens refreshed on success. */
export function useCreateParcel() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: ParcelBody) => client.command('createLandParcel', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The creation of a section of a project. */
export function useCreateSection() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: SectionBody) => client.command('createLandSection', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RecordNoticeInput {
  id: string;
  version: number;
  body: NoticeBody;
}

/** The notice of recovery of a parcel, under the version of the parcel the caller saw. */
export function useRecordNotice() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RecordNoticeInput) =>
      client.command('recordRecoveryNotice', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
