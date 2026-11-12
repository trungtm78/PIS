import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';

/** What the screens of the project workflow show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key. */
export function usePwfKey(): readonly ['pwf', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['pwf', tenant?.id, tenant?.membershipId];
}

/** The calendar of the day and the rules a screen reads change when a command succeeds, so every cached read of the module is read again then. */
export function usePwfCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = usePwfKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Reads the module again (after a refusal that says somebody changed it first). */
export function useReloadPwf(): () => Promise<void> {
  const queryClient = useQueryClient();
  const key = usePwfKey();
  return () => queryClient.invalidateQueries({ queryKey: key });
}

/** A command that carries the version the person saw (the `If-Match` of the call). */
export interface VersionedInput<Body = undefined> {
  id: string;
  version: number;
  body: Body;
}
