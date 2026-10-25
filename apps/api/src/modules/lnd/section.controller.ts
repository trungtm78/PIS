import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndLandSource, LndSectionStore } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { projectRefs, reaches } from './reach';

const CREATE_PERMISSION = PERMISSIONS.createLandSection;
const HANDOVER_PERMISSION = PERMISSIONS.recordSectionHandover;
const RESOURCE_TYPE = 'land_handover_section';
const CLASSIFICATION = 'INTERNAL';

/**
 * The sections of a project that land is handed over in (ST-LND-001, LND 3.4 step 1, LND-10). A section is created NOT_READY, by kilometre or by
 * area, for the land office of a project: the caller needs `land.manage` over the project (a grant on the unit trees of its owner or investor, on
 * the project or on the tenant). Status, handed area and tenant have no write path here; handing the land over is another command.
 */
@Controller()
export class LandSectionController {
  private readonly source = new LndLandSource();
  private readonly sections = new LndSectionStore(this.source);

  @Post('land-sections')
  @HttpCode(200)
  @OperationId('createLandSection')
  @Command({ operation: 'createLandSection' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndCreateLandSection']): Promise<CommandResult> {
    const now = new Date();
    const projectId = body.project_id.toLowerCase();
    const project = await this.source.projectRef(scope.tx, projectId);
    // A project of another tenant is indistinguishable from one that does not exist.
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, CREATE_PERMISSION, projectRefs(project), now)) throw new DomainError('SCOPE_DENIED', 403);
    const created = await this.sections.create(
      scope.tx,
      {
        projectId,
        contractId: body.contract_id,
        code: body.code,
        name: body.name,
        fromKm: body.from_km,
        toKm: body.to_km,
        requiredAreaM2: body.required_area_m2,
        targetDate: body.target_date,
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'land.section_created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: CLASSIFICATION,
      diff: { code: created.code, project_id: created.projectId, contract_id: created.contractId, required_area_m2: created.requiredAreaM2, status: created.status },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'lnd.section.created.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        section_id: created.id,
        project_id: created.projectId,
        contract_id: created.contractId,
        handed_area_m2: '0.00',
        required_area_m2: created.requiredAreaM2,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  /**
   * Hands land over to the construction contract of a section (ST-LND-009, LND 3.4 step 3). The caller needs `land.handover` over the project of the section; the section answers 404
   * to a caller who cannot see it. The area handed over is the whole of it so far and never passes the area the section needs; only an ACTIVE contract that builds receives it; the
   * last of the area hands the parcels over with it. Every handover is audited and tells the contracts and the quality module that the site is ready.
   */
  @Post('land-sections/:id/handover')
  @HttpCode(200)
  @OperationId('recordSectionHandover')
  @Command({ operation: 'recordSectionHandover', versioned: true })
  async handover(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['LndRecordSectionHandover']): Promise<CommandResult> {
    const now = new Date();
    const sectionId = id.toLowerCase();
    const found = await this.source.sectionRef(scope.tx, sectionId);
    // A section of another tenant is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await this.source.projectRef(scope.tx, found.projectId);
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, HANDOVER_PERMISSION, projectRefs(project), now)) throw new DomainError('SCOPE_DENIED', 403);
    const done = await this.sections.recordHandover(
      scope.tx,
      sectionId,
      scope.expectedVersion ?? 0,
      { handedAreaM2: body.handed_area_m2, handedOverOn: body.handed_over_on, handoverDocumentVersionId: body.handover_document_version_id },
      scope.tenant.membershipId,
      vietnamDateOf(now),
    );
    const facts = {
      code: done.code,
      project_id: done.projectId,
      contract_id: done.contractId,
      from_status: done.fromStatus,
      status: done.status,
      required_area_m2: done.requiredAreaM2,
      previous_handed_area_m2: done.previousHandedAreaM2,
      handed_area_m2: done.handedAreaM2,
      handed_over_on: done.handedOverOn,
      handover_document_version_id: done.handoverDocumentVersionId,
      parcels_handed_over: done.parcelsHandedOver,
    };
    await scope.audit({ action: 'land.section_handed_over', resourceType: RESOURCE_TYPE, resourceId: done.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'lnd.section.handed_over.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, section_id: done.id, ...facts, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }
}
