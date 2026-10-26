import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../hooks';
import { useAudCommand } from '../recommendation/hooks';
import type { Versioned } from '../recommendation/hooks';
import { toReport } from './model';
import type { CloseBody, ReportLine, RequestBody } from './model';

/** The reports of an engagement, the newest day and revision first, with their frozen figures, their hash and where DOC has got to. */
export function useReports(engagementId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ReportLine[]>({
    queryKey: [...key, 'follow-up-reports', engagementId ?? ''],
    queryFn: async () => {
      const items: unknown[] = await client.readAll('listAuditFollowUpReports', { path: { id: engagementId ?? '' } });
      return items.flatMap((raw) => toReport(raw) ?? []);
    },
    enabled: key[1] !== undefined && engagementId !== undefined,
    retry: false,
  });
}

/** The request to DOC to issue a report, under the version of the engagement the screen showed. */
export const useRequestReport = () =>
  useAudCommand((client, input: Versioned<RequestBody>, attempt) => client.command('requestAuditFollowUpReport', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));

/** The closure of an engagement that is followed up, under the version the screen showed. */
export const useCloseEngagement = () =>
  useAudCommand((client, input: Versioned<CloseBody>, attempt) => client.command('closeAuditEngagement', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
