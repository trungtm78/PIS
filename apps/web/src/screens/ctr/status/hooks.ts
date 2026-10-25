import { useApiClient } from '../../../api/ApiClientContext';
import { useCommand } from '../hooks';
import type { HaltAction } from '../workspace/model';
import { OPERATIONS } from './model';
import type { HaltBody } from './model';

export interface HaltInput {
  action: HaltAction;
  id: string;
  version: number;
  body: HaltBody;
}

/** Suspends, resumes or terminates a contract under the version the screen showed; the summary of the contract is read again when it is done. */
export function useHalt() {
  const client = useApiClient();
  return useCommand<HaltInput>((input, attempt) => client.command(OPERATIONS[input.action], { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
