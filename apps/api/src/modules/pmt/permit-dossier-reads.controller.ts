import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PmtDossierStore, TenantDatabase, dossierScope } from '@machvon/db';
import type { DossierDetail, DossierLine, PermitDetail, PermitLine } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = 'permit.read';

const memberView = (member: { membershipId: string; displayName: string } | null): Record<string, unknown> | null =>
  member === null ? null : { membership_id: member.membershipId, display_name: member.displayName };

/**
 * The line of the dossier list (PMT-01) as the contract exposes it: an allowlist, so a column added to the table later is not shown until it
 * is listed here. The readiness is the cache the commands keep; the counts are taken on the day of the read.
 */
export function dossierLineView(row: DossierLine): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.projectId,
    project_code: row.projectCode,
    project_name: row.projectName,
    project_component_id: row.projectComponentId,
    project_component_code: row.projectComponentCode,
    owner_unit_id: row.ownerUnitId,
    owner_unit_name: row.ownerUnitName,
    owner_membership: memberView(row.ownerMembership),
    status: row.status,
    readiness_pct: row.readinessPct,
    required_count: row.requiredCount,
    satisfied_count: row.satisfiedCount,
    issued_count: row.issuedCount,
    expiring_count: row.expiringCount,
    unconfirmed_count: row.unconfirmedCount,
    version: row.version,
  };
}

/** A permit of a dossier with the permit type version it was written under (the code and the revision, never an internal key). */
export function permitLineView(row: PermitLine): Record<string, unknown> {
  return {
    id: row.id,
    permit_type_id: row.permitTypeId,
    permit_type_code: row.permitTypeCode,
    permit_type_revision: row.permitTypeRevision,
    permit_type_name: row.permitTypeName,
    cxn_ref: row.cxnRef,
    exemption_allowed: row.exemptionAllowed,
    is_required: row.isRequired,
    status: row.status,
    permit_no: row.permitNo,
    authority_name: row.authorityName,
    submitted_on: row.submittedOn,
    expected_decision_on: row.expectedDecisionOn,
    issued_on: row.issuedOn,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    no_expiry: row.noExpiry,
    supersedes_id: row.supersedesId,
    responsible_membership: memberView(row.responsibleMembership),
    version: row.version,
  };
}

export function dossierDetailView(row: DossierDetail): Record<string, unknown> {
  return { ...dossierLineView(row), permits: row.permits.map(permitLineView) };
}

/** One permit with its milestones in the order they were recorded (PMT-02). */
export function permitDetailView(row: PermitDetail): Record<string, unknown> {
  return {
    ...permitLineView(row),
    dossier_id: row.dossierId,
    project_id: row.projectId,
    project_code: row.projectCode,
    project_name: row.projectName,
    document_version_id: row.documentVersionId,
    exemption_basis: row.exemptionBasis,
    exemption_decision_document_version_id: row.exemptionDecisionDocumentVersionId,
    revoke_reason: row.revokeReason,
    revocation_document_version_id: row.revocationDocumentVersionId,
    milestones: row.milestones.map((milestone) => ({
      id: milestone.id,
      step_code: milestone.stepCode,
      planned_on: milestone.plannedOn,
      actual_on: milestone.actualOn,
      note: milestone.note,
      document_version_id: milestone.documentVersionId,
      created_at: milestone.createdAt,
    })),
  };
}

function projectFilterOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const found = asUuid(value);
  if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
  return found;
}

/**
 * The reads of the permit dossier (PMT-01): the dossiers in the scope of the caller and one dossier with its permits. A dossier of another
 * tenant, or outside the units and projects of the grant, does not exist for the caller (404).
 */
@Controller('resources/permit_dossier')
export class PermitDossierReadsController {
  private readonly dossiers = new PmtDossierStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_permit_dossier')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') projectId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { projectId: projectFilterOf(projectId) };
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.dossiers.list(tx, dossierScope(access, READ_PERMISSION, now), filter, { limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(dossierLineView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.projectCode, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_permit_dossier_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.dossiers.find(tx, id.toLowerCase(), dossierScope(access, READ_PERMISSION, new Date())));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return dossierDetailView(found);
  }
}

/** The read of one permit with the timeline of its milestones (PMT-02). */
@Controller('resources/permit')
export class PermitReadsController {
  private readonly dossiers = new PmtDossierStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get(':id')
  @OperationId('get_resources_permit_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.dossiers.findPermit(tx, id.toLowerCase(), dossierScope(access, READ_PERMISSION, new Date())));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return permitDetailView(found);
  }
}
