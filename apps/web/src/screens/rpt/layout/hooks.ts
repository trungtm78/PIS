import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import type { components } from '@machvon/contracts';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';

export type LayoutPreview = components['schemas']['RptLayoutPreview'];

export interface PreviewInput {
  params: Record<string, unknown>;
}

/**
 * The preview of the layout being edited: the server judges the params with the schema of the rule, compiles them and fills the form with labelled illustrative data. Nothing is stored; a refused layout comes back as
 * `valid: false` with the first field, which the editor shows beside the field.
 */
export function usePreviewLayout() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: PreviewInput) => client.command('previewReportLayout' as never, { body: { params: input.params }, attempt: attempts.current.forPayload(input) } as never) as Promise<LayoutPreview>,
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}
