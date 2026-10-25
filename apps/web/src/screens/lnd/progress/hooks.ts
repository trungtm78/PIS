import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toOverview } from './model';
import type { Overview, ReportBody } from './model';

/** The overview of a project, or of one of its sections, as the server counted it at the moment of the read (`getLandProgress`). */
export function useOverview(projectId: string | undefined, sectionId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Overview>({
    queryKey: [...key, 'progress', projectId ?? '', sectionId ?? ''],
    queryFn: async () => toOverview(await client.read('getLandProgress', { path: { id: projectId ?? '' }, ...(sectionId === undefined || sectionId === '' ? {} : { query: { section_id: sectionId } }) })),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The report of a stage: one idempotency attempt per intention, every cached read of the land screens refreshed on success (a report changes the overview). */
export function useReportStage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: ReportBody) => client.command('reportLandStageProgress', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
