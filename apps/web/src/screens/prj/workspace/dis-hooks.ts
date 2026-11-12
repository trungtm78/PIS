import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { useSnapshot } from '../../dis/enterprise/hooks';
import type { SnapshotDetail } from '../../dis/enterprise/model';
import { useScheduleLines } from '../../cap/forecast/hooks';
import { planRows } from '../../cap/forecast/model';
import type { PlanRow } from '../../cap/forecast/model';
import { usePayments } from '../../pay/payment/hooks';
import type { PaymentRequest } from '../../pay/payment/model';

type LeaderRates = components['schemas']['LeaderRates'];
type LeaderRateRow = components['schemas']['LeaderRateRow'];

/** The measure the leader read and HOME-09 draw their figures from; DIS-33 opens on another one (EXECUTED), so the detail is asked for this one. */
export const DISBURSED_MEASURE = 'DISBURSED';

const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/** The figures the enterprise snapshot holds for one project: the headline of the leader read and the detail by source of the same snapshot. */
export interface ProjectFigures {
  snapshotId: string;
  asOfDate: string;
  revision: number | null;
  planYear: number | null;
  /** The line of the project in the leader read (the very figures HOME-09 sums); undefined when the snapshot holds no line for it. */
  headline: LeaderRateRow | undefined;
  /** The detail of the same snapshot (DIS-33); undefined while it is read or when it cannot be read. */
  detail: SnapshotDetail | undefined;
  /** True when the detail could not be read: the headline is still drawn, the sources are not. */
  detailMissing: boolean;
}

/**
 * The plan in force against the disbursed to date of one project, from the latest frozen enterprise snapshot: the same read as the leader panel and HOME-09 (`getLeaderRates`),
 * and the by-source detail of that snapshot (the read of DIS-33). Nothing is recomputed. `data` is null when nothing is frozen yet.
 */
export function useProjectFigures(projectId: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  // The same key as the leader panel, so that both read the answer once.
  const rates = useQuery<LeaderRates | null>({
    queryKey: ['leader', tenant?.id, tenant?.membershipId, 'rates'],
    queryFn: async () => {
      try {
        const raw = await client.read('getLeaderRates');
        // Nothing frozen yet is a 200 with `snapshot: null` (the shape the leader panel caches under this same key): a state, never rates.
        return typeof raw === 'object' && raw !== null && 'snapshot' in raw && (raw as { snapshot: unknown }).snapshot === null ? null : (raw as LeaderRates);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    enabled: tenant?.id !== undefined,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const snapshotId = rates.data?.snapshot_id;
  const detail = useSnapshot(snapshotId, DISBURSED_MEASURE);
  const isLoading = rates.isLoading || (snapshotId !== undefined && detail.isLoading);
  let data: ProjectFigures | null | undefined;
  if (rates.data === null) data = null;
  else if (rates.data !== undefined && !detail.isLoading) {
    data = {
      snapshotId: rates.data.snapshot_id,
      asOfDate: rates.data.as_of_date,
      revision: rates.data.revision ?? null,
      planYear: detail.data?.period.plan_year ?? null,
      headline: rates.data.projects.find((row) => row.id === projectId),
      detail: detail.data,
      detailMissing: detail.data === undefined,
    };
  }
  return {
    isLoading,
    error: rates.error ?? undefined,
    data,
    refetch: () => {
      void rates.refetch();
      void detail.refetch();
    },
  };
}

/** The monthly estimates and registrations of the project in a year (CAP-12), by month, only the months that hold a figure. */
export function useProjectMonths(projectId: string, year: number | undefined) {
  const lines = useScheduleLines(projectId, year, true);
  return {
    isLoading: lines.isLoading,
    error: lines.error ?? undefined,
    data: lines.data === undefined ? undefined : planRows(lines.data).filter((row) => row.forecastVnd !== null || row.registeredVnd !== null),
    refetch: () => void lines.refetch(),
  };
}

export type MonthRow = PlanRow;

/** The payment requests of the contracts of the project, newest first (the register is read once and narrowed to the project). */
export function useProjectPayments(projectId: string) {
  const payments = usePayments();
  return {
    isLoading: payments.isLoading,
    error: payments.error ?? undefined,
    data: payments.data === undefined ? undefined : payments.data.filter((request) => request.projectId === projectId),
    refetch: () => void payments.refetch(),
  };
}

export type ProjectPayment = PaymentRequest;
