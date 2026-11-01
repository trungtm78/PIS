import { TENANT_STATUSES } from '../tenants/types';
import type { TenantSummary } from '../tenants/types';

/** SAS-18: the health of the platform for the people who run it (ST-SAS-021, FR-SAS-18). Only what the control plane registry says about the lifecycle, placement and licence of each tenant, by tenant code: never a name, a user or any business data of a tenant. */
export interface Count {
  key: string;
  count: number;
}

export interface HealthRow {
  id: string;
  code: string;
  status: string;
  isolationMode: string | undefined;
  planCode: string | undefined;
  licenseStatus: string | undefined;
}

export interface PlatformHealth {
  tenants: number;
  byStatus: Count[];
  byPlacement: Count[];
  byLicense: Count[];
  rows: HealthRow[];
  /** Tenants whose saga failed or whose licence is not in force: the ones an operator looks at first. */
  attention: number;
}

const ATTENTION_LICENSES: readonly string[] = ['EXPIRED', 'SUSPENDED', 'REVOKED'];
const NONE = '';

/** The counts of the values given, in the order of `order` first and then in the order they were met; the value that is missing is counted under the empty key. */
function tally(values: ReadonlyArray<string | undefined>, order: readonly string[]): Count[] {
  const counts = new Map<string, number>(order.map((key) => [key, 0]));
  for (const value of values) counts.set(value ?? NONE, (counts.get(value ?? NONE) ?? 0) + 1);
  return [...counts].filter(([key, count]) => count > 0 || order.includes(key)).map(([key, count]) => ({ key, count }));
}

export function healthOf(summaries: readonly TenantSummary[]): PlatformHealth {
  const rows = summaries
    .map<HealthRow>((summary) => ({
      id: summary.id,
      code: summary.code,
      status: summary.status,
      isolationMode: summary.isolationMode,
      planCode: summary.planCode,
      licenseStatus: summary.licenseStatus,
    }))
    .sort((left, right) => left.code.localeCompare(right.code));
  return {
    tenants: rows.length,
    byStatus: tally(
      rows.map((row) => row.status),
      TENANT_STATUSES,
    ),
    byPlacement: tally(
      rows.map((row) => row.isolationMode),
      ['POOL', 'SILO'],
    ),
    byLicense: tally(
      rows.map((row) => row.licenseStatus),
      [],
    ),
    rows,
    attention: rows.filter((row) => row.status === 'Failed' || (row.licenseStatus !== undefined && ATTENTION_LICENSES.includes(row.licenseStatus))).length,
  };
}

/** The indicators the screen is named for that the API does not report yet; the screen says so instead of showing a number it does not have. */
export const PENDING_INDICATORS = ['slo', 'incidents', 'licenseLag', 'outboxAge', 'failedInbox'] as const;
export type PendingIndicator = (typeof PENDING_INDICATORS)[number];
