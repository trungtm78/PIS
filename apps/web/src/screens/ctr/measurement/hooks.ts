import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useCommand, useScopeKey } from '../hooks';
import { toMeasurement } from './model';
import type { CorrectBody, DecideBody, Measurement, RecordBody } from './model';

/** The measurements of a contract the caller may see, oldest first; a draft is seen only by whoever recorded it. */
export function useMeasurements(contractId: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Measurement[]>({
    queryKey: [...key, 'measurements', contractId ?? ''],
    queryFn: async () => (await client.readAll('get_resources_measurement', { query: { contract_id: contractId ?? '' } })).flatMap((raw) => toMeasurement(raw) ?? []),
    enabled: key[1] !== undefined && typeof contractId === 'string',
    retry: false,
  });
}

export interface RecordInput {
  contractId: string;
  body: RecordBody;
}

/** Records the quantity of an item in a period as a draft; the server judges the total against the quantity of the item. */
export function useRecordMeasurement() {
  const client = useApiClient();
  return useCommand<RecordInput>((input, attempt) => client.command('recordMeasurement', { path: { id: input.contractId }, body: input.body, attempt }));
}

export interface SubmitInput {
  id: string;
  version: number;
}

export function useSubmitMeasurement() {
  const client = useApiClient();
  return useCommand<SubmitInput>((input, attempt) => client.command('submitMeasurement', { path: { id: input.id }, body: {}, ifMatchVersion: input.version, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  body: DecideBody;
}

export function useDecideMeasurement() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) => client.command('post_measurements_id_decision', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface CorrectInput {
  id: string;
  version: number;
  body: CorrectBody;
}

export function useCorrectMeasurement() {
  const client = useApiClient();
  return useCommand<CorrectInput>((input, attempt) => client.command('correctMeasurement', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
