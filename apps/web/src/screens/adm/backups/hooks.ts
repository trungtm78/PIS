import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toBackupPage } from './model';
import type { BackupKind, BackupPageView } from './model';

const root = (tenantId: string | undefined) => ['adm', 'backups', tenantId] as const;

/** The requests and the state of the backups as the server reads it from its state port. */
export function useBackupPage(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<BackupPageView>({
    queryKey: [...root(tenant?.id), 'page'],
    queryFn: async () => toBackupPage(await (client as unknown as { read: (operation: string, input?: unknown) => Promise<unknown> }).read('listBackupRequests', { query: { limit: 50 } })),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

function useBackupCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

interface Versioned {
  id: string;
  version: number;
}

export function useRequestBackup() {
  const client = useApiClient();
  return useBackupCommand<{ kind: BackupKind; repository: number; reason: string }>((input, attempt) => client.command('requestBackup', { body: input as never, attempt }));
}

export function useDecideBackup() {
  const client = useApiClient();
  return useBackupCommand<Versioned & { decision: 'approve' | 'reject'; reason: string }>((input, attempt) =>
    client.command('decideBackupRequest', { path: { id: input.id }, body: { decision: input.decision, ...(input.reason === '' ? {} : { reason: input.reason }) } as never, ifMatchVersion: input.version, attempt }),
  );
}

export function useCancelBackup() {
  const client = useApiClient();
  return useBackupCommand<Versioned & { reason: string }>((input, attempt) => client.command('cancelBackupRequest', { path: { id: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}

export function useRecordBackup() {
  const client = useApiClient();
  return useBackupCommand<Versioned & { outcome: 'completed' | 'failed'; label: string; note: string }>((input, attempt) =>
    client.command('recordBackupOutcome', {
      path: { id: input.id },
      body: { outcome: input.outcome, ...(input.label === '' ? {} : { backup_label: input.label }), ...(input.note === '' ? {} : { note: input.note }) } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}
