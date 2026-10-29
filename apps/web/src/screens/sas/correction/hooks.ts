import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import type { CorrectionKind } from './model';

export interface CorrectInput {
  kind: CorrectionKind;
  invoiceId: string;
  body: Record<string, unknown>;
}

/** Makes the correction of an issued invoice as a Draft (`createAdjustmentInvoice` or `createReplacementInvoice`); the invoices of the tenant are read again after it. */
export function useCreateCorrection() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: CorrectInput) => client.command(input.kind === 'ADJUSTMENT' ? 'createAdjustmentInvoice' : 'createReplacementInvoice', { path: { invoiceId: input.invoiceId }, body: input.body as never, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['sas', 'invoices', tenant?.id] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
