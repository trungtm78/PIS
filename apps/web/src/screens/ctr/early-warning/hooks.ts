import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import type { components } from '@machvon/contracts';
import { useRegisterCommand, useRegisterKey } from '../claims/hooks';
import type { VersionedInput } from '../claims/hooks';
import { queryOf } from './model';
import type { Register, Warning, WarningFilter, WarningLine, WarningPage } from './model';

type Schemas = components['schemas'];

export interface MemberOption {
  id: string;
  label: string;
}

/** The register of early warnings, a page after another: the summary is that of the whole filter, whatever page was read. */
export function useWarnings(filter: WarningFilter) {
  const client = useApiClient();
  const key = useRegisterKey();
  return useInfiniteQuery<WarningPage, Error, { pages: WarningPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'warnings', filter],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => client.read('listContractEarlyWarnings', { query: queryOf(filter, pageParam) }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Every warning of a contract that is open, all pages: a meeting reviews each of them, so none may be missing. */
export function useOpenWarnings(contractId: string | null) {
  const client = useApiClient();
  const key = useRegisterKey();
  return useQuery<WarningLine[]>({
    queryKey: [...key, 'open-warnings', contractId ?? ''],
    queryFn: async () => {
      const lines: WarningLine[] = [];
      let cursor: string | undefined;
      do {
        const page: WarningPage = await client.read('listContractEarlyWarnings', { query: queryOf({ contractId: contractId ?? '', status: '', category: '', party: '', open: true, mine: false }, cursor) });
        lines.push(...page.items);
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return lines;
    },
    enabled: key[1] !== undefined && contractId !== null,
    retry: false,
  });
}

/** One warning with its actions, its reviews and what the caller may do. */
export function useWarning(id: string | null) {
  const client = useApiClient();
  const key = useRegisterKey();
  return useQuery<Warning>({
    queryKey: [...key, 'warning', id ?? ''],
    queryFn: () => client.read('getContractEarlyWarning', { path: { id: id ?? '' } }),
    enabled: key[1] !== undefined && id !== null,
    retry: false,
  });
}

/** The register of one contract: the three clocks of its rhythm, its meetings, its issues and the summary of its warnings. */
export function useRegister(contractId: string | null) {
  const client = useApiClient();
  const key = useRegisterKey();
  return useQuery<Register>({
    queryKey: [...key, 'register', contractId ?? ''],
    queryFn: () => client.read('getContractEarlyWarningRegister', { path: { id: contractId ?? '' } }),
    enabled: key[1] !== undefined && contractId !== null,
    retry: false,
  });
}

/** The members a warning or an action can be given to. */
export function useMemberOptions(enabled = true) {
  const client = useApiClient();
  const key = useRegisterKey();
  return useQuery<MemberOption[]>({
    queryKey: [...key, 'members'],
    queryFn: async () =>
      (await client.readAll('get_resources_membership')).flatMap((raw) => {
        const row = raw as unknown as Record<string, unknown>;
        const name = typeof row.display_name === 'string' && row.display_name !== '' ? row.display_name : typeof row.email === 'string' ? row.email : undefined;
        return typeof row.id === 'string' ? [{ id: row.id, label: name ?? row.id }] : [];
      }),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export function useRaiseWarning() {
  const client = useApiClient();
  return useRegisterCommand<{ contractId: string; body: Schemas['CtrEarlyWarningRaise'] }>((input, attempt) => client.command('raiseContractEarlyWarning', { path: { id: input.contractId }, body: input.body, attempt }));
}
export function useAssessWarning() {
  const client = useApiClient();
  return useRegisterCommand<VersionedInput<Schemas['CtrEarlyWarningAssess']>>((input, attempt) => client.command('assessContractEarlyWarning', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
export function useAddAction() {
  const client = useApiClient();
  return useRegisterCommand<{ id: string; body: Schemas['CtrEarlyWarningActionCreate'] }>((input, attempt) => client.command('addContractEarlyWarningAction', { path: { id: input.id }, body: input.body, attempt }));
}
export function useCompleteAction() {
  const client = useApiClient();
  return useRegisterCommand<VersionedInput<Schemas['CtrEarlyWarningActionComplete']>>((input, attempt) =>
    client.command('completeContractEarlyWarningAction', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}
export function useCloseWarning() {
  const client = useApiClient();
  return useRegisterCommand<VersionedInput<Schemas['CtrEarlyWarningClose']>>((input, attempt) => client.command('closeContractEarlyWarning', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
export function useRecordMeeting() {
  const client = useApiClient();
  return useRegisterCommand<{ contractId: string; body: Schemas['CtrEarlyWarningMeetingRecord'] }>((input, attempt) =>
    client.command('recordContractEarlyWarningMeeting', { path: { id: input.contractId }, body: input.body, attempt }),
  );
}
export function useIssueRegister() {
  const client = useApiClient();
  return useRegisterCommand<{ contractId: string; body: Schemas['CtrEarlyWarningIssueRecord'] }>((input, attempt) =>
    client.command('issueContractEarlyWarningRegister', { path: { id: input.contractId }, body: input.body, attempt }),
  );
}
