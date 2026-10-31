import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CtrContractStore, QmsDiaryCoverageReads, TenantDatabase, contractScope } from '@machvon/db';
import { COVERAGE_CALENDAR, DomainError, WORKING_TIME_ZONE, coverageRange } from '@machvon/kernel';
import type { Coverage, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.getDiaryCoverage;

const dayOf = (now: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: WORKING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

function dayParam(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

/** The coverage as the contract exposes it: an allowlist. */
export function coverageView(coverage: Coverage): { totals: Record<string, number>; days: Array<Record<string, unknown>>; missing_dates: string[] } {
  const { totals } = coverage;
  return {
    totals: { working_days: totals.workingDays, with_diary: totals.withDiary, signed: totals.signed, draft: totals.draft, missing: totals.missing, late: totals.late, conflict: totals.conflict },
    days: coverage.days.map((day) => ({
      date: day.date,
      state: day.state,
      diary_id: day.diaryId,
      status: day.status,
      conflict: day.conflict,
      signed_on: day.signedOn,
      working_days_to_sign: day.workingDaysToSign,
      late_days: day.lateDays,
    })),
    missing_dates: coverage.days.filter((day) => day.state === 'MISSING').map((day) => day.date),
  };
}

/**
 * The coverage of the site diary of a contract by working day (ST-QMS-008, QMS 3.1, BR-QMS-08, QMS-11, UAT-AC364): for each working day of the calendar `WORKDAY_VN` in the range, up to today, whether there is a
 * main diary, whether it is signed or still a draft, whether a copy of a device waits to be settled, and for a diary the contractor signed late the working days it was late. A contract outside the scope of the caller does
 * not exist for them (404).
 */
@Controller()
export class DiaryCoverageController {
  private readonly contracts = new CtrContractStore();
  private readonly coverage = new QmsDiaryCoverageReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('contracts/:id/site-diaries/coverage')
  @OperationId('getDiaryCoverage')
  async read(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const range = coverageRange(dayParam('from', from), dayParam('to', to), dayOf(now));
    const found = await this.database.withSnapshot(tenant, async (tx) => {
      const contract = await this.contracts.find(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now));
      if (contract === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return { contract, coverage: await this.coverage.coverage(tx, contract.id, range) };
    });
    return {
      contract_id: found.contract.id,
      contract_code: found.contract.code,
      calendar_code: COVERAGE_CALENDAR,
      from: range.from,
      to: range.to,
      through: range.through ?? null,
      as_of: now.toISOString(),
      ...coverageView(found.coverage),
    };
  }
}
