import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toEntry, toEntryPage, toRegisterPage } from './types';
import type { Direction, EntryPage, RegisterPage } from './types';
import type { RegisterBody, TypeBody } from './rules';

export const PAGE_SIZE = 50;

export interface RegisterFilter {
  year: string;
  direction: Direction | '';
}

export const registersKey = (tenantId: string | undefined, filter: RegisterFilter) => ['doc', 'registers', tenantId, filter.year, filter.direction] as const;
export const registersRoot = (tenantId: string | undefined) => ['doc', 'registers', tenantId] as const;
export const entriesRoot = (tenantId: string | undefined) => ['doc', 'entries', tenantId] as const;
export const entriesKey = (tenantId: string | undefined, registerId: string | undefined) => ['doc', 'entries', tenantId, registerId ?? ''] as const;
export const unitsKey = (tenantId: string | undefined) => ['doc', 'units', tenantId] as const;

/** The registers of the filter, page by page, with the document types of the tenant that the first page carries. */
export function useRegisters(filter: RegisterFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<RegisterPage, Error, { pages: RegisterPage[] }, ReturnType<typeof registersKey>, string | undefined>({
    queryKey: registersKey(tenant?.id, filter),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toRegisterPage(
        await client.read('listDocumentNumberRegisters', {
          query: {
            limit: PAGE_SIZE,
            ...(filter.year === '' ? {} : { year: filter.year }),
            ...(filter.direction === '' ? {} : { direction: filter.direction }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The log of one register in number order; only asked for while a register is open on the screen. */
export function useRegisterEntries(registerId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<EntryPage, Error, { pages: EntryPage[] }, ReturnType<typeof entriesKey>, string | undefined>({
    queryKey: entriesKey(tenant?.id, registerId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toEntryPage(await client.read('listDocumentRegisterEntries', { path: { id: registerId ?? '' }, query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined && registerId !== undefined,
    retry: false,
  });
}

/** Every number of a register, read page after page: what the exported ledger holds. */
export function useLedgerRead() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (registerId: string) => {
      const items: unknown[] = await client.readAll('listDocumentRegisterEntries', { path: { id: registerId }, query: { limit: PAGE_SIZE } });
      return items.map(toEntry);
    },
  });
}

export interface OrgUnitOption {
  id: string;
  code: string;
  name: string;
}

/** The units a register can belong to: every unit of the tenant the caller may read. */
export function useUnitOptions() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<OrgUnitOption[]>({
    queryKey: unitsKey(tenant?.id),
    queryFn: async () =>
      (await client.readAll('get_resources_organization_unit')).flatMap((raw) => {
        const row = raw as Record<string, unknown>;
        return typeof row.id === 'string' ? [{ id: row.id, code: typeof row.code === 'string' ? row.code : '', name: typeof row.name === 'string' ? row.name : '' }] : [];
      }),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export interface CloseInput {
  registerId: string;
  version: number;
  reason: string;
}

/** Closes a register (versioned: the server answers 409 for a stale version); one idempotency attempt per intention. */
export function useCloseRegister() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: CloseInput) =>
      client.command('closeDocumentNumberRegister', {
        path: { id: input.registerId },
        body: { reason: input.reason },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: registersRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useOpenRegister() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: RegisterBody) => client.command('openDocumentNumberRegister', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: registersRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useDefineDocType() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: TypeBody) => client.command('defineDocumentType', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: registersRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
