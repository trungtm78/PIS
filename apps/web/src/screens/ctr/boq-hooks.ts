import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { toBoqLine } from './boq-model';
import type { BoqLine, ImportBody } from './boq-model';
import { useCommand, useScopeKey } from './hooks';

/**
 * The lines of the BOQs in the scope of the caller that belong to one contract (CTR-04). The read lists every line the caller may see, so
 * the lines of the contract are picked out here, in the order of the revision and the line.
 */
export function useBoqLines(contractId: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<BoqLine[]>({
    queryKey: [...key, 'boq-lines', contractId ?? ''],
    queryFn: async () => (await client.readAll('get_resources_boq_line', { query: { contract_id: contractId ?? '' } })).flatMap((raw) => toBoqLine(raw) ?? []).filter((line) => line.contractId === contractId),
    enabled: key[1] !== undefined && typeof contractId === 'string',
    retry: false,
  });
}

export interface ImportInput {
  /** The revision the lines go into, and the version of it that the person saw. */
  revisionId: string;
  version: number;
  body: ImportBody;
}

/** The import of the lines of a BOQ; the answer carries the figures of the import (see `toImportResult`). */
export function useImportBoq() {
  const client = useApiClient();
  return useCommand<ImportInput>((input, attempt) => client.command('importBoqLines', { path: { id: input.revisionId }, body: input.body, ifMatchVersion: input.version, attempt }));
}
