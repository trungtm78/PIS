import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndLandSource, LndParcelStore } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { parcelRef, reaches } from './reach';

const CREATE_PERMISSION = PERMISSIONS.createLandParcel;
const NOTICE_PERMISSION = PERMISSIONS.recordRecoveryNotice;
/** The rights that let a caller see a parcel at all: whoever reads, manages or processes parcels of a place knows they exist; without one of them a parcel does not exist for the caller. */
const SEEING_PERMISSIONS: readonly string[] = ['land.read', PERMISSIONS.createLandParcel, NOTICE_PERMISSION];
const RESOURCE_TYPE = 'land_parcel';
const CLASSIFICATION = 'INTERNAL';

/**
 * The parcels of a project (ST-LND-001, LND 3.1 steps 1 and 2, LND-02). A parcel is a piece of land and nothing more: the body names no owner, no
 * user and no household, and the allowlist of the contract has no field for one. A command acts on a parcel inside the place of the parcel (the
 * unit tree of the unit that answers for it, or a grant on its project): a parcel the caller cannot see does not exist for them.
 */
@Controller()
export class LandParcelController {
  private readonly source = new LndLandSource();
  private readonly parcels = new LndParcelStore(this.source);

  @Post('land-parcels')
  @HttpCode(200)
  @OperationId('createLandParcel')
  @Command({ operation: 'createLandParcel' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndCreateLandParcel']): Promise<CommandResult> {
    const now = new Date();
    // Identifiers travel on as the lower-case text the database writes: the audit row and the event are matched against ids as strings.
    const projectId = body.project_id.toLowerCase();
    const ownerUnitId = body.owner_unit_id.toLowerCase();
    const project = await this.source.projectRef(scope.tx, projectId);
    const unit = await this.source.unitRef(scope.tx, ownerUnitId);
    // A project or a unit of another tenant is indistinguishable from one that does not exist.
    if (project === undefined || unit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, CREATE_PERMISSION, [parcelRef({ projectId, ownerUnit: unit })], now)) throw new DomainError('SCOPE_DENIED', 403);
    const created = await this.parcels.create(
      scope.tx,
      {
        projectId,
        sectionId: body.section_id,
        ownerUnitId,
        parcelCode: body.parcel_code,
        addressText: body.address_text,
        wardMasterVersionId: body.ward_master_version_id,
        landUseGroup: body.land_use_group,
        areaTotalM2: body.area_total_m2,
        areaAffectedM2: body.area_affected_m2,
        boundaryGeojson: body.boundary_geojson,
      },
      scope.tenant.membershipId,
      vietnamDateOf(now),
    );
    // The trail and the event carry the code, the ids, the land use and the areas: not the address and not the outline.
    await scope.audit({
      action: 'land.parcel_created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: CLASSIFICATION,
      diff: {
        parcel_code: created.parcelCode,
        project_id: created.projectId,
        section_id: created.sectionId,
        owner_unit_id: created.ownerUnitId,
        land_use_group: created.landUseGroup,
        area_total_m2: created.areaTotalM2,
        area_affected_m2: created.areaAffectedM2,
        status: created.status,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'lnd.parcel.created.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        parcel_id: created.id,
        project_id: created.projectId,
        section_id: created.sectionId,
        owner_unit_id: created.ownerUnitId,
        parcel_code: created.parcelCode,
        land_use_group: created.landUseGroup,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('land-parcels/:id/recovery-notice')
  @HttpCode(200)
  @OperationId('recordRecoveryNotice')
  @Command({ operation: 'recordRecoveryNotice', versioned: true })
  async recordNotice(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndRecordRecoveryNotice'],
  ): Promise<CommandResult> {
    const now = new Date();
    const parcelId = id.toLowerCase();
    const place = await this.parcels.place(scope.tx, parcelId);
    const ref = place === undefined ? undefined : parcelRef(place);
    // A parcel that does not exist and one the caller may not see are the same answer; one they may see and not act on is a refusal.
    if (place === undefined || ref === undefined || !SEEING_PERMISSIONS.some((permission) => reaches(access, permission, [ref], now))) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, NOTICE_PERMISSION, [ref], now)) throw new DomainError('SCOPE_DENIED', 403);
    const done = await this.parcels.recordNotice(
      scope.tx,
      { parcelId, expectedVersion: scope.expectedVersion ?? 0, noticeOn: body.notice_on, noticeDocumentVersionId: body.notice_document_version_id },
      scope.tenant.membershipId,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'land.recovery_notice_recorded',
      resourceType: RESOURCE_TYPE,
      resourceId: parcelId,
      classification: CLASSIFICATION,
      diff: {
        project_id: done.projectId,
        timer_code: done.timerCode,
        notice_on: done.noticeOn,
        days_applied: done.daysApplied,
        due_on: done.dueOn,
        rule_version_id: done.ruleVersionId,
        rule_revision: done.ruleRevision,
        notice_document_version_id: done.noticeDocumentVersionId,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: parcelId,
      aggregateVersion: done.version,
      type: 'lnd.parcel.notice_recorded.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        parcel_id: parcelId,
        project_id: done.projectId,
        deadline_id: done.deadlineId,
        timer_code: done.timerCode,
        notice_on: done.noticeOn,
        days_applied: done.daysApplied,
        due_on: done.dueOn,
        rule_version_id: done.ruleVersionId,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${parcelId}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, parcelId);
  }
}
