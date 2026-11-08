import { assertPeriodAllowedForDays } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import type { DisPeriodStore, TenantTx } from '@machvon/db';

/**
 * A role grant or a delegation can be limited to report periods (IAM-2): the commands that handle a report ask this before they write. The period is read by its id; nothing is checked for a caller whose grants carry no
 * period limit, which is every caller of a tenant that configured none (403 `PERIOD_SCOPE_DENIED` otherwise). A period that is not there is left to the command's own 404.
 */
export async function assertPeriodReach(tx: TenantTx, periods: DisPeriodStore, periodId: string, access: EffectiveAccess, permission: string, now: Date): Promise<void> {
  if (!access.grants.some((grant) => grant.periodCodes !== undefined && grant.periodCodes !== null)) return;
  const period = await periods.find(tx, periodId);
  if (period === undefined) return;
  assertPeriodAllowedForDays(access, now, permission, period.startDate, period.endDate);
}
