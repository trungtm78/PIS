import { useApiClient } from '../../../api/ApiClientContext';
import { useCommand } from '../hooks';
import type { AdjustBody } from './model';

export interface AdjustInput {
  id: string;
  version: number;
  body: AdjustBody;
}

/** Approves an assessed change order from a day before today, under the version the screen showed; the board, the acceptances and the revisions of the contract are read again when it is done. */
export function useAdjustChange() {
  const client = useApiClient();
  return useCommand<AdjustInput>((input, attempt) => client.command('approveRetroactiveAdjustment', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
