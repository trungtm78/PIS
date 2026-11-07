import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toBaselineView, toComponentLinks, toDisbursementCheck, toEvmView, toExportFile, toSCurveView } from './model';
import type { Selection } from './model';

// What these screens show depends on the scope of the membership that is signed in, not only on the tenant: the membership is part of every key.
export function useScopeKey(): readonly ['gov3', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['gov3', tenant?.id, tenant?.membershipId];
}

/** A read that is null when the record is not there for the caller (another tenant, or outside the scope: a 404); any other failure is the failure of the read, never "nothing". */
function useRead<T>(name: string, id: string | undefined, operation: string, parse: (raw: unknown) => T | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<T | null>({
    queryKey: [...key, name, id ?? ''],
    queryFn: async () => {
      try {
        return parse(await client.read(operation as never, { path: { id: id ?? '' } } as never)) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

export const useBaseline = (id: string | undefined) => useRead('baseline', id, 'getProjectBaseline', toBaselineView);
export const useDisbursementCheck = (id: string | undefined) => useRead('disbursement', id, 'checkProjectDisbursement', toDisbursementCheck);

export interface EvmSelection {
  /** The day of the view; empty is today (the server's today). */
  asOf: string;
  scope: 'PROJECT' | 'COMPONENT' | 'CONTRACT';
  ref: string | undefined;
  baseline: Selection;
}

const queryOf = (selection: EvmSelection, withBaseline: boolean): Record<string, string> => ({
  ...(selection.asOf === '' ? {} : { as_of: selection.asOf }),
  scope: selection.scope,
  ...(selection.scope === 'PROJECT' || selection.ref === undefined ? {} : { ref: selection.ref }),
  ...(withBaseline ? { baseline: selection.baseline } : {}),
});

/** The earned value of the project on the day, in the scope and against the baseline that were chosen: each choice is part of the key, so a change of the day reads again. */
export function useEvm(id: string | undefined, selection: EvmSelection) {
  const client = useApiClient();
  const key = useScopeKey();
  const query = queryOf(selection, true);
  // A package or a contract needs the thing it is about; until it is chosen nothing is read.
  const ready = selection.scope === 'PROJECT' || selection.ref !== undefined;
  return useQuery({
    queryKey: [...key, 'evm', id ?? '', query],
    queryFn: async () => {
      try {
        return toEvmView(await client.read('getProjectEvm' as never, { path: { id: id ?? '' }, query } as never)) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && id !== undefined && ready,
    retry: false,
  });
}

/** The curve; a project without version 0 answers 422 BASELINE_MISSING, which is "no baseline yet" and not a failure of the read. */
export function useSCurve(id: string | undefined, selection: EvmSelection) {
  const client = useApiClient();
  const key = useScopeKey();
  const query = queryOf(selection, false);
  const ready = selection.scope === 'PROJECT' || selection.ref !== undefined;
  return useQuery({
    queryKey: [...key, 's-curve', id ?? '', query],
    queryFn: async () => {
      try {
        return toSCurveView(await client.read('getProjectSCurve' as never, { path: { id: id ?? '' }, query } as never)) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        if (error instanceof ApiError && error.code === 'BASELINE_MISSING') return 'NO_BASELINE' as const;
        throw error;
      }
    },
    enabled: key[1] !== undefined && id !== undefined && ready,
    retry: false,
  });
}

/** The contracts that carry the packages. A person who may not read earned value gets a refusal; the panel says so and the rest of the screen stays. */
export function useComponentContracts(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'links', id ?? ''],
    queryFn: async () => toComponentLinks(await client.read('listProjectComponentContracts' as never, { path: { id: id ?? '' } } as never)) ?? [],
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

/** The workbook of the curve: asked for when the person presses the button, never on its own. */
export function useExportSCurve() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (input: { projectId: string; selection: EvmSelection }) => {
      const file = toExportFile(await client.read('exportProjectSCurve' as never, { path: { id: input.projectId }, query: queryOf(input.selection, false) } as never));
      if (file === undefined) throw new Error('EXPORT_UNUSABLE');
      return file;
    },
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, Error, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCaptureBaseline() {
  const client = useApiClient();
  return useCommand<{ projectId: string }>((input, attempt) => client.command('captureProjectBaseline' as never, { path: { id: input.projectId }, body: {}, attempt } as never));
}

export interface ReappraisalInput {
  id: string;
  version: number;
  body: { decision: 'START' | 'WAIVE'; reason: string };
}

export function useDecideReappraisal() {
  const client = useApiClient();
  return useCommand<ReappraisalInput>((input, attempt) => client.command('decideReappraisalRequest' as never, { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt } as never));
}

export interface AcknowledgeInput {
  id: string;
  version: number;
  body: { note: string };
}

export function useAcknowledgeAlert() {
  const client = useApiClient();
  return useCommand<AcknowledgeInput>((input, attempt) => client.command('acknowledgeGovernanceAlert' as never, { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt } as never));
}

export interface LinkInput {
  projectId: string;
  body: { contract_id: string; component_id: string | null };
}

export function useLinkContract() {
  const client = useApiClient();
  return useCommand<LinkInput>((input, attempt) => client.command('linkContractComponent' as never, { path: { id: input.projectId }, body: input.body, attempt } as never));
}
