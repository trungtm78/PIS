import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndLandSource, LndSectionStore } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
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
}
