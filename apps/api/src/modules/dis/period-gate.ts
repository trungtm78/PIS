import { DomainError, accessForPeriod, assertPeriodAllowedForDays } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { projectScope } from '@machvon/db';
import type { DisPeriodStore, DisReportStore, TenantTx } from '@machvon/db';

const limited = (access: EffectiveAccess): boolean => access.grants.some((grant) => grant.periodCodes !== undefined && grant.periodCodes !== null);

/**
 * A role grant or a delegation can be limited to report periods (IAM-2). The access to act on a report of the period: the access without the grants whose period limit does not cover it, so that a check of the project scope
 * made on it is passed only by a grant that reaches the project and allows the period (never by one grant for the project and another for the period). 403 `PERIOD_SCOPE_DENIED` when no grant allows the period at all. A caller whose grants
 * carry no period limit (every caller of a tenant that configured none) gets their access back untouched.
 */
export async function periodAccess(tx: TenantTx, periods: DisPeriodStore, periodId: string, access: EffectiveAccess, permission: string, now: Date): Promise<EffectiveAccess> {
  if (!limited(access)) return access;
  const period = await periods.find(tx, periodId);
  if (period === undefined) return access;
  assertPeriodAllowedForDays(access, now, permission, period.startDate, period.endDate);
  return accessForPeriod(access, now, permission, period.startDate, period.endDate);
}

/** The project is reached, for the permission, by a grant that also allows the period of the report: otherwise 403 `PERIOD_SCOPE_DENIED` (or the 403 `SCOPE_DENIED` of the project itself when no grant reaches it). */
export async function assertPeriodReach(tx: TenantTx, reports: DisReportStore, periods: DisPeriodStore, projectId: string, periodId: string, access: EffectiveAccess, permission: string, now: Date): Promise<void> {
  const allowed = await periodAccess(tx, periods, periodId, access, permission, now);
  if (allowed === access) return;
  try {
    await reports.project(tx, projectId, () => ({ sql: 'true', params: [] }), projectScope(allowed, permission, now));
  } catch (error) {
    if (error instanceof DomainError && error.code === 'SCOPE_DENIED') throw new DomainError('PERIOD_SCOPE_DENIED', 403, 'period');
    throw error;
  }
}
