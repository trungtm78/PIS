import { Controller, Get, Inject, Query } from '@nestjs/common';
import { DEFAULT_WITHIN_DAYS, MAX_WITHIN_DAYS, PmtExpiringPermits, TenantDatabase, dossierScope, thresholdOfLevel } from '@machvon/db';
import type { ExpiringPermitRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = 'permit.read';
const WHOLE_DAYS = /^\d{1,3}$/;

/** A permit of the board of expiring permits (PMT-05) as the contract exposes it: an allowlist, so a column added to the table is not shown until it is listed here. */
export function expiringPermitView(row: ExpiringPermitRow): Record<string, unknown> {
  return {
    id: row.id,
    dossier_id: row.dossierId,
    permit_type_code: row.permitTypeCode,
    permit_type_name: row.permitTypeName,
    permit_no: row.permitNo,
    status: row.status,
    valid_until: row.validUntil,
    days_left: row.daysLeft,
    alert_level: row.alertLevel,
    alert_threshold_days: thresholdOfLevel(row.alertLevel),
    project: { id: row.project.id, code: row.project.code, name: row.project.name },
    responsible: row.responsible === null ? null : { membership_id: row.responsible.membershipId, display_name: row.responsible.displayName },
    version: row.version,
  };
}

function withinDaysOf(value: unknown): number {
  if (value === undefined) return DEFAULT_WITHIN_DAYS;
  if (typeof value !== 'string' || !WHOLE_DAYS.test(value) || Number(value) > MAX_WITHIN_DAYS) throw new DomainError('VALIDATION_FAILED', 422, 'within_days');
  return Number(value);
}

/**
 * The permits that need attention (PMT-05, ST-PMT-006): the issued ones whose last day is within the window, and the expired ones that no renewal has
 * replaced. The reminders themselves are sent by the job `permit-expiry`; this read is the board the person in charge works from. Only the permits of
 * the dossiers in the scope of the caller are shown.
 */
@Controller('permits')
export class ExpiringPermitsController {
  private readonly reads = new PmtExpiringPermits();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('expiring')
  @OperationId('listExpiringPermits')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('within_days') withinDays?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const window = withinDaysOf(withinDays);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.reads.list(tx, dossierScope(access, READ_PERMISSION, now), { withinDays: window }, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(expiringPermitView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.validUntil, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
