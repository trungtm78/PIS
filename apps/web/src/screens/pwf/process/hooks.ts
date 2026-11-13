import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { usePwfKey } from '../hooks';
import type { Suggestion } from './model';

/**
 * What the rule suggests for the facts held, the templates the tenant has and the preview of the schedule (`suggestProjectWorkflow`). The answer of the previous question stays on the screen while the next one is read, so the section
 * does not jump while the person types.
 */
export function useWorkflowSuggestion(query: Readonly<Record<string, string>>, enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<Suggestion>({
    queryKey: [...key, 'suggestion', query],
    queryFn: () => client.read('suggestProjectWorkflow', { query }),
    enabled: enabled && key[1] !== undefined,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
