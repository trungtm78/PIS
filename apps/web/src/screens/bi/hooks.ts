import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { metricBody, toMetric } from './bi-model';
import type { Metric, MetricValues } from './bi-model';

/** Every read and every mutation of the BI screens lives under this key of the tenant, so one command refreshes them all. */
export const biRoot = (tenantId: string | undefined) => ['bi', tenantId] as const;

/** The registry of the tenant, every revision of it, by code. */
export function useMetrics() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Metric[]>({
    queryKey: [...biRoot(tenant?.id), 'metrics', tenant?.membershipId],
    queryFn: async () => (await client.readAll('get_resources_metric_definition')).flatMap((raw) => toMetric(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One revision of a metric. */
export function useMetric(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Metric>({
    queryKey: [...biRoot(tenant?.id), 'metric', tenant?.membershipId, id],
    queryFn: async () => {
      const metric = toMetric(await client.read('get_resources_metric_definition_id', { path: { id: id as string } }));
      if (metric === undefined) throw new Error('the metric could not be read');
      return metric;
    },
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

/** Drafts a metric of the tenant: one idempotency attempt per intention, the cached reads refreshed on success. */
export function useCreateMetric() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (values: MetricValues) => client.command('createTenantMetricDefinition', { body: metricBody(values), attempt: attempts.current.forPayload(values) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
