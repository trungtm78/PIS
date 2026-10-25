import { useApiClient } from '../../../api/ApiClientContext';
import { useCommand } from '../hooks';
import type { DecisionBody } from './model';

export interface DecideInput {
  id: string;
  version: number;
  body: DecisionBody;
}

/** Decides a change order under the version the screen showed: approve, give back or reject; the board and the revisions of the contract are read again when it is done. */
export function useDecideChange() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) => client.command('post_contract_changes_id_decision', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
