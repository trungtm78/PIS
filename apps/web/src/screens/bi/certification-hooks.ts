import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toCertLog, toCertifications, transitionBody } from './certification-model';
import type { CertLine, CertSubject, Certifications, TransitionInput } from './certification-model';
import { toKpiRegister } from './kpi-register-model';
import type { KpiRegister } from './kpi-register-model';
import { biRoot } from './hooks';

/** The register and the certifications change rarely: a screen that only decorates a number with them asks again after five minutes, not on every tile. */
export const FIGURE_META_STALE_MS = 5 * 60_000;

/** The certification state of the KPIs, datasets and metrics of BI (G3-1). A failure after a good answer keeps the last answer (the caller says it is old). */
export function useCertifications(options: { enabled?: boolean; staleMs?: number; quiet?: boolean } = {}) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Certifications>({
    queryKey: [...biRoot(tenant?.id), 'certifications', tenant?.membershipId],
    queryFn: async () => {
      const answer = toCertifications(await client.read('listAnalyticsCertifications'));
      if (answer === undefined) throw new Error('the certifications could not be read');
      return answer;
    },
    enabled: tenant !== undefined && (options.enabled ?? true),
    staleTime: options.staleMs ?? 0,
    // A number that is only decorated does not ask again for every tile that mounts after a failure: one failed read is enough for the page.
    retryOnMount: options.quiet !== true,
    retry: false,
  });
}

/** The KPI register (G0-4), read once and kept: the "i" of every number asks it, and every tile shares the one answer. */
export function useKpiRegister(options: { enabled?: boolean; quiet?: boolean } = {}) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<KpiRegister>({
    queryKey: [...biRoot(tenant?.id), 'kpi-register', tenant?.membershipId],
    queryFn: async () => {
      const answer = toKpiRegister(await client.read('getKpiRegister'));
      if (answer === undefined) throw new Error('the KPI register could not be read');
      return answer;
    },
    enabled: tenant !== undefined && (options.enabled ?? true),
    staleTime: FIGURE_META_STALE_MS,
    retryOnMount: options.quiet !== true,
    retry: false,
  });
}

/** The append-only log of one KPI or dataset, read when its detail is opened. */
export function useCertificationLog(subject: CertSubject | undefined, key: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<{ lines: CertLine[]; skipped: number }>({
    queryKey: [...biRoot(tenant?.id), 'certification-log', tenant?.membershipId, subject, key],
    queryFn: async () => {
      const answer = toCertLog(await client.read('getAnalyticsCertificationLog', { path: { subject: subject as CertSubject, key: key as string } }));
      if (answer === undefined) throw new Error('the certification log could not be read');
      return answer;
    },
    enabled: tenant !== undefined && subject !== undefined && key !== undefined,
    retry: false,
  });
}

/** Moves a KPI or a dataset one step: one idempotency attempt for each intention (a retry after a lost answer reuses it), every BI read asked again on success so the server stays the truth. */
export function useTransitionCertification() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: TransitionInput) => {
      const body = transitionBody(input);
      return client.command('transitionAnalyticsCertification', { body, attempt: attempts.current.forPayload(body) });
    },
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
