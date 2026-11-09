import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase } from '@machvon/db';
import { DomainError, ORG_PACK_ENTITY, ORG_PACK_MAPPING_VERSION, checkRoleDefinition, directoryMappings, fileSha256, orgPackCsv, orgPackDigest, orgPackRows, seatReports, verifyOrgPack } from '@machvon/kernel';
import type { EffectiveAccess, OrgPack, OrgPackState, TenantContext } from '@machvon/kernel';
import { ORG_PACK_RESOURCE, OrgPackStore, PVFCCO_PACK_LABEL, pvfccoTemplatePack } from '@machvon/edition-enterprise/src/server.ts';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { assertVerdict } from '../../iam-dto';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const CLASSIFICATION = 'INTERNAL';
const TEMPLATE_FILE = 'pvfcco-template.csv';
/** Everything a load writes or proposes is checked against the caller before it is written: the permission of the operation is the approval of the batch, these are the rights of what the batch turns into. */
const LOAD_PERMISSIONS = ['iam.unit.manage', 'adm.governance.manage', 'adm.doa.manage', 'master.propose'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Dto = Schemas['EntOrgPack'];

/** The pack and the state of the tenant as the screen reads them: nothing is written, nothing is hidden (the pack has no person in it). */
function viewOf(pack: OrgPack, state: OrgPackState, extra: { source: 'TEMPLATE' | 'BATCH'; batchId: string | null; defects: Dto['defects']; withFile: boolean; rowCount: number }): Dto {
  const report = verifyOrgPack(pack, state);
  const seats = seatReports(pack, state);
  const csv = orgPackCsv(pack);
  const groups = new Map(directoryMappings(pack).map((one) => [`${one.tenantRole}@${one.unit}`, one.adGroup]));
  return {
    label: pack.label,
    digest: orgPackDigest(pack),
    source: extra.source,
    batch_id: extra.batchId,
    directory_prefix: pack.directoryPrefix,
    loader: { target_entity: ORG_PACK_ENTITY, mapping_version: ORG_PACK_MAPPING_VERSION, source_system: pack.label, file_name: TEMPLATE_FILE, file_sha256: fileSha256(new TextEncoder().encode(csv)), row_count: extra.rowCount },
    file_csv: extra.withFile ? csv : null,
    units: pack.units.map((unit) => ({ code: unit.code, name: unit.name, parent_code: unit.parentCode, unit_function: unit.function, placeholder: unit.placeholder, present: state.units.has(unit.code) })),
    roles: pack.roles.map((role) => ({ code: role.code, name: role.name, kind: role.kind, rank: role.rank, permissions: [...role.permissions], present: state.roles.has(role.code) })),
    seats: seats.map((seat) => ({
      key: seat.key,
      ad_group: groups.get(`${seat.roleCode}@${seat.unitCode}`) ?? seat.adGroup,
      role_code: seat.roleCode,
      unit_code: seat.unitCode,
      scope_kind: seat.scope,
      min_holders: seat.min,
      max_holders: seat.max,
      holders: seat.holders,
      state: seat.state,
    })),
    steps: pack.steps.map((step) => ({ id: step.id, kind: step.kind, name: step.name, assignee: step.assignee, role_code: step.roleCode ?? null, unit_code: step.unitCode ?? null, sla_working_hours: step.slaWorkingHours, on_timeout: step.onTimeout })),
    delegation: { delegable_roles: [...pack.delegation.delegableRoles], max_days: pack.delegation.maxDays, standing_review_days: pack.delegation.standingReviewDays },
    absence: pack.absence,
    doa: { document_type: pack.doa.documentType, unit_code: pack.doa.unitCode, role_code: pack.doa.roleCode, approval_levels: pack.doa.approvalLevels },
    catalogue: pack.entries.map((entry) => ({ master_type: entry.masterType, key: entry.key, label: entry.label, parent_key: entry.parentKey })),
    plan: report.items.map((item) => ({ section: item.section, key: item.key, action: item.action, detail: item.detail })),
    counts: report.counts,
    seat_counts: report.seatCounts,
    stray_grants: report.strayGrants,
    structure_complete: report.structureComplete,
    defects: extra.defects,
    as_of: new Date().toISOString(),
  };
}

/**
 * The organisation and the roles of the enterprise edition (ENT-3d, HT.02, HT.03, MD.03, QT.01): the PVFCCo template pack or the pack of an applied batch, with the plan against the tenant and the verification report. The load itself goes
 * through the batch import of ADM (register, dry run, apply by somebody other than who registered it); the one command here turns an applied batch into the units and roles of the tenant and proposes the rules and catalogue entries
 * for approval by somebody else. Both exist in the enterprise edition only.
 */
@Controller()
export class OrgPackController {
  private readonly store = new OrgPackStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('enterprise/org-pack')
  @OperationId('getEnterpriseOrgPack')
  async overview(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('batch_id') batchId?: string): Promise<Dto> {
    // The organisation is the whole tenant's: a grant on a subtree does not read it.
    if (!holdsOnWholeTenant(access, PERMISSIONS.getEnterpriseOrgPack)) throw new DomainError('SCOPE_DENIED', 403);
    if (batchId !== undefined && !UUID.test(batchId)) throw new DomainError('VALIDATION_FAILED', 422, 'batch_id');
    return this.database.withTenant(tenant, async (tx) => {
      if (batchId === undefined) {
        const pack = pvfccoTemplatePack();
        return viewOf(pack, await this.store.readState(tx, pack), { source: 'TEMPLATE', batchId: null, defects: [], withFile: true, rowCount: orgPackRows(pack).length });
      }
      const loaded = await this.store.packOfBatch(tx, batchId);
      return viewOf(loaded.pack, await this.store.readState(tx, loaded.pack), { source: 'BATCH', batchId, defects: loaded.defects, withFile: false, rowCount: loaded.rows.length });
    });
  }

  @Post('enterprise/org-pack/materialisations')
  @HttpCode(200)
  @OperationId('materialiseEnterpriseOrgPack')
  @Command({ operation: 'materialiseEnterpriseOrgPack' })
  async materialise(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EntOrgPackMaterialiseRequest']): Promise<Schemas['EntOrgPackMaterialisation']> {
    // A load writes units, roles, rules, the matrix of authority and catalogue entries for the whole tenant: the caller holds the rights of all of them over the whole tenant.
    for (const permission of [PERMISSIONS.materialiseEnterpriseOrgPack, ...LOAD_PERMISSIONS]) if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403, permission);
    const loaded = await this.store.packOfBatch(scope.tx, body.batch_id);
    if (loaded.defects.length > 0) throw new DomainError('ORG_PACK_INVALID', 422, loaded.defects[0]?.key);
    const now = new Date();
    const report = await this.store.materialise(scope.tx, loaded.pack, {
      actor: scope.tenant.membershipId,
      batchId: body.batch_id,
      // Nobody creates a role with more rank or more permissions than they hold (BR-IAM-05, BR-IAM-06).
      guardRole: (role) => assertVerdict(checkRoleDefinition({ grantor: access, permissions: role.permissions, rank: role.rank, scope: { kind: 'TENANT' }, now })),
    });
    await scope.audit({
      action: 'ent.org_pack.materialised',
      resourceType: ORG_PACK_RESOURCE,
      resourceId: body.batch_id,
      classification: CLASSIFICATION,
      diff: { label: report.label, digest: report.digest, counts: report.counts, items: report.items.map((item) => ({ key: item.key, result: item.result })) },
    });
    await scope.emit({
      aggregateType: ORG_PACK_RESOURCE,
      aggregateId: body.batch_id,
      aggregateVersion: 1,
      type: 'ent.org_pack.materialised.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, batch_id: body.batch_id, label: report.label, digest: report.digest, counts: report.counts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${ORG_PACK_RESOURCE}:${body.batch_id}:${report.digest}:${report.counts.CREATED}`,
    });
    return {
      label: report.label,
      digest: report.digest,
      batch_id: body.batch_id,
      items: report.items.map((item) => ({ section: item.section, key: item.key, result: item.result, detail: item.detail, id: item.id ?? null })),
      counts: report.counts,
      seat_counts: report.verification.seatCounts,
      stray_grants: report.verification.strayGrants,
      structure_complete: report.verification.structureComplete,
    };
  }
}

/** The label of the template, for the tests and the screen to name. */
export const TEMPLATE_LABEL = PVFCCO_PACK_LABEL;
