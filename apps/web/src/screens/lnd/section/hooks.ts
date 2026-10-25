import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toContractOption } from '../model';
import type { ContractOption } from '../model';
import { toSectionLine } from './model';
import type { HandoverBody, SectionLine } from './model';

/** The sections of a project in the scope of the caller, by code. */
export function useSectionLines(projectId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<SectionLine[]>({
    queryKey: [...key, 'section-lines', projectId ?? ''],
    queryFn: async () => (await client.readAll('listLandSections', { query: { project_id: projectId ?? '' } })).flatMap((raw) => toSectionLine(raw) ?? []),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The contracts the caller can read: what names the contract that receives a section, and what a new section can name. A caller who reads no contract sees none, and the screen falls back on the identifier. */
export function useContracts(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ContractOption[]>({
    queryKey: [...key, 'contracts'],
    queryFn: async () => (await client.readAll('get_resources_contract')).flatMap(toContractOption),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export interface HandoverInput {
  id: string;
  version: number;
  body: HandoverBody;
}

/** Hands land over to the contract of a section, under the version of the section the screen showed; every cached read of the land screens is refreshed on success. */
export function useRecordHandover() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: HandoverInput) => client.command('recordSectionHandover', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
