import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndParcelStore, LndSectionStore, PARCEL_STATUSES, TenantDatabase, parcelScope, projectScope } from '@machvon/db';
import type { LandSectionRow, ParcelRow, ParcelStatus } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.listLandParcels;

/** A parcel as the screen reads it: an allowlist of what a parcel is. There is no owner, no user and no household anywhere in it, and no outline (only whether there is one). */
export function parcelLineView(row: ParcelRow): Record<string, unknown> {
  const deadline = row.deadline;
  return {
    id: row.id,
    project_id: row.projectId,
    section_id: row.sectionId,
    section_code: row.sectionCode,
    owner_unit_id: row.ownerUnitId,
    owner_unit_name: row.ownerUnitName,
    parcel_code: row.parcelCode,
    address_text: row.addressText,
    land_use_group: row.landUseGroup,
    area_total_m2: row.areaTotalM2,
    area_affected_m2: row.areaAffectedM2,
    has_boundary: row.hasBoundary,
    status: row.status,
    recovery_notice_on: row.recoveryNoticeOn,
    notice_days_applied: row.noticeDaysApplied,
    recovery_decision_on: row.recoveryDecisionOn,
    deadline:
      deadline === null
        ? null
        : {
            id: deadline.id,
            timer_code: deadline.timerCode,
            days_applied: deadline.daysApplied,
            started_on: deadline.startedOn,
            due_on: deadline.dueOn,
            satisfied_on: deadline.satisfiedOn,
            status: deadline.status,
            legal_basis: deadline.legalBasis,
            awaiting_confirmation: deadline.awaitingConfirmation,
            cxn: deadline.cxn,
          },
    version: row.version,
  };
}

export function sectionLineView(row: LandSectionRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.projectId,
    contract_id: row.contractId,
    code: row.code,
    name: row.name,
    from_km: row.fromKm,
    to_km: row.toKm,
    required_area_m2: row.requiredAreaM2,
    handed_area_m2: row.handedAreaM2,
    target_date: row.targetDate,
    handed_over_on: row.handedOverOn,
    status: row.status,
    version: row.version,
  };
}

const projectOf = (value: unknown): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
  return id.toLowerCase();
};

/** The parcels and the sections of a project in the scope of the caller (LND-02). A parcel or a project outside the scope is not in the list, as if it did not exist. */
@Controller()
export class LandReadsController {
  private readonly parcels = new LndParcelStore();
  private readonly sections = new LndSectionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('land-parcels')
  @OperationId('listLandParcels')
  async listParcels(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('section_id') section?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = projectOf(project);
    const sectionId = section === undefined ? undefined : projectOf(section);
    if (status !== undefined && !(PARCEL_STATUSES as readonly unknown[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.parcels.list(tx, parcelScope(access, READ_PERMISSION, now), { projectId, sectionId, status: status as ParcelStatus | undefined }, { limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(parcelLineView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.parcelCode, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get('land-sections')
  @OperationId('listLandSections')
  async listSections(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = projectOf(project);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.sections.listOfProject(tx, projectId, projectScope(access, READ_PERMISSION, now)));
    return { items: rows.map(sectionLineView), next_cursor: null, as_of: now.toISOString() };
  }
}
