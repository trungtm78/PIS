import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PmtDossierStore, PmtPermitStore } from '@machvon/db';
import type { DossierPlace, PermitChange, PermitProjectPlace, UnitPlace } from '@machvon/db';
import { DomainError, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';

const MANAGE_PERMISSION = PERMISSIONS.createPermitDossier;
const RECORD_PERMISSION = PERMISSIONS.recordPermitDecision;
const DOSSIER_RESOURCE = 'permit_dossier';
const PERMIT_RESOURCE = 'permit';
const CLASSIFICATION = 'INTERNAL';

interface Place {
  projectId: string;
  ownerUnit: UnitPlace;
  investorUnit: UnitPlace | null;
  dossierUnit?: UnitPlace;
}

/** The places a dossier lies in for the permission test: the units that own and invest in its project and the unit that keeps it, each with the project. */
function refsOf(place: Place): ResourceRef[] {
  const units = [place.ownerUnit, ...(place.investorUnit === null ? [] : [place.investorUnit]), ...(place.dossierUnit === undefined ? [] : [place.dossierUnit])];
  return units.map((unit) => ({ ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId: place.projectId }));
}

/** Whether a grant that carries the permission has a scope that contains the project of the dossier, or one of its units. */
function reaches(access: EffectiveAccess, permission: string, place: Place, now: Date): boolean {
  return refsOf(place).some((ref) => holdsPermission(effectivePermissions(access, now, ref), permission));
}

const placeOfProject = (project: PermitProjectPlace): Place => ({ projectId: project.projectId, ownerUnit: project.ownerUnit, investorUnit: project.investorUnit });

/** What every event of a permit carries: the facts of the document (PMT 9) and the version of the permit after the command. */
function permitPayload(scope: CommandScope, projectId: string, change: PermitChange, now: Date): Record<string, unknown> {
  return {
    tenant_id: scope.tenant.tenantId,
    permit_id: change.id,
    dossier_id: change.dossierId,
    project_id: projectId,
    permit_type_id: change.permitTypeId,
    permit_type_code: change.permitTypeCode,
    permit_type_revision: change.permitTypeRevision,
    status: change.status,
    valid_until: change.validUntil,
    version: change.version,
    actor_id: scope.tenant.membershipId,
    occurred_at: now.toISOString(),
  };
}

/**
 * The project permit dossier, its permits and milestones (ST-PMT-002, PMT 3.1 and 4). A command acts on a dossier inside the scope of its
 * permission: the dossier of another tenant does not exist (404) and a dossier of the tenant that lies outside the units and projects of
 * the grant is 403. Status, type version, permit numbers and dates have no write path here other than the command that owns them; the
 * state machine, the one current permit per type and the one number per type are enforced by the store and, last, by the database.
 */
@Controller()
export class PermitDossierController {
  private readonly dossiers = new PmtDossierStore();
  private readonly permits = new PmtPermitStore(this.dossiers);

  @Post('projects/:id/permit-dossiers')
  @HttpCode(200)
  @OperationId('createPermitDossier')
  @Command({ operation: 'createPermitDossier' })
  async open(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: Schemas['PmtCreatePermitDossier'],
  ): Promise<CommandResult> {
    const now = new Date();
    const project = await this.dossiers.projectPlace(scope.tx, projectId.toLowerCase());
    // A project of another tenant is indistinguishable from one that does not exist.
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, MANAGE_PERMISSION, placeOfProject(project), now)) throw new DomainError('SCOPE_DENIED', 403);
    const opened = await this.dossiers.open(
      scope.tx,
      project,
      { projectComponentId: body.project_component_id, ownerUnitId: body.owner_unit_id, ownerMembershipId: body.owner_membership_id },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'pmt.dossier_opened',
      resourceType: DOSSIER_RESOURCE,
      resourceId: opened.id,
      classification: CLASSIFICATION,
      diff: {
        project_id: opened.projectId,
        project_component_id: opened.projectComponentId,
        owner_unit_id: opened.ownerUnitId,
        as_of: opened.asOf,
        planned: opened.planned.map((permit) => ({ permit_id: permit.permitId, permit_type_code: permit.permitTypeCode, permit_type_revision: permit.permitTypeRevision, awaiting_confirmation: permit.awaitingConfirmation })),
      },
    });
    await scope.emit({
      aggregateType: DOSSIER_RESOURCE,
      aggregateId: opened.id,
      aggregateVersion: opened.version,
      type: 'pmt.dossier.opened.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        dossier_id: opened.id,
        project_id: opened.projectId,
        project_component_id: opened.projectComponentId,
        owner_unit_id: opened.ownerUnitId,
        planned_permit_ids: opened.planned.map((permit) => permit.permitId),
        version: opened.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${DOSSIER_RESOURCE}:${opened.id}:${opened.version}`,
    });
    for (const permit of opened.planned) {
      await scope.emit({
        aggregateType: PERMIT_RESOURCE,
        aggregateId: permit.permitId,
        aggregateVersion: 1,
        type: 'pmt.permit.planned.v1',
        schemaVersion: 1,
        payload: {
          tenant_id: scope.tenant.tenantId,
          permit_id: permit.permitId,
          dossier_id: opened.id,
          project_id: opened.projectId,
          permit_type_id: permit.permitTypeId,
          permit_type_code: permit.permitTypeCode,
          permit_type_revision: permit.permitTypeRevision,
          status: 'PLANNED',
          valid_until: null,
          version: 1,
          actor_id: scope.tenant.membershipId,
          occurred_at: now.toISOString(),
        },
        eventKey: `${PERMIT_RESOURCE}:${permit.permitId}:1`,
      });
    }
    return commandResult(scope, opened.status, opened.version, opened.id);
  }

  @Post('permit-dossiers/:id/permits')
  @HttpCode(200)
  @OperationId('addPermit')
  @Command({ operation: 'addPermit' })
  async add(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) dossierId: string,
    @Body() body: Schemas['PmtAddPermit'],
  ): Promise<CommandResult> {
    const now = new Date();
    const place = await this.dossierPlace(scope, access, dossierId.toLowerCase(), MANAGE_PERMISSION, now);
    const added = await this.permits.add(
      scope.tx,
      place.dossierId,
      { permitTypeId: body.permit_type_id, authorityName: body.authority_name, expectedDecisionOn: body.expected_decision_on, responsibleMembershipId: body.responsible_membership_id },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'pmt.permit_planned',
      resourceType: PERMIT_RESOURCE,
      resourceId: added.id,
      classification: CLASSIFICATION,
      diff: { dossier_id: place.dossierId, project_id: place.projectId, permit_type_id: added.permitTypeId, permit_type_code: added.permitTypeCode, permit_type_revision: added.permitTypeRevision },
    });
    await scope.emit({
      aggregateType: PERMIT_RESOURCE,
      aggregateId: added.id,
      aggregateVersion: added.version,
      type: 'pmt.permit.planned.v1',
      schemaVersion: 1,
      payload: permitPayload(scope, place.projectId, added, now),
      eventKey: `${PERMIT_RESOURCE}:${added.id}:${added.version}`,
    });
    return commandResult(scope, added.status, added.version, added.id);
  }

  @Post('permits/:id/milestones')
  @HttpCode(200)
  @OperationId('recordPermitMilestone')
  @Command({ operation: 'recordPermitMilestone', versioned: true })
  async recordMilestone(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) permitId: string,
    @Body() body: Schemas['PmtRecordPermitMilestone'],
  ): Promise<CommandResult> {
    const now = new Date();
    const place = await this.permitPlace(scope, access, permitId.toLowerCase(), MANAGE_PERMISSION, now);
    const done = await this.permits.recordMilestone(
      scope.tx,
      permitId.toLowerCase(),
      scope.expectedVersion ?? 0,
      { stepCode: body.step_code, plannedOn: body.planned_on, actualOn: body.actual_on, note: body.note, documentVersionId: body.document_version_id },
      scope.tenant.membershipId,
    );
    // The note is free text: the audit row says that there is one, not what it says.
    await scope.audit({
      action: 'pmt.permit_milestone_recorded',
      resourceType: PERMIT_RESOURCE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: {
        milestone_id: done.milestoneId,
        step_code: done.stepCode,
        planned_on: done.plannedOn,
        actual_on: done.actualOn,
        has_note: done.note !== null,
        document_version_id: done.documentVersionId,
        from_status: done.fromStatus,
        to_status: done.status,
        expected_decision_on: done.expectedDecisionOn,
      },
    });
    await scope.emit({
      aggregateType: PERMIT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'pmt.permit.milestone_recorded.v1',
      schemaVersion: 1,
      payload: { ...permitPayload(scope, place.projectId, done, now), step_code: done.stepCode, milestone_id: done.milestoneId, actual_on: done.actualOn },
      eventKey: `${PERMIT_RESOURCE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('permits/:id/decision')
  @HttpCode(200)
  @OperationId('recordPermitDecision')
  @Command({ operation: 'recordPermitDecision', versioned: true })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) permitId: string,
    @Body() body: Schemas['PmtRecordPermitDecision'],
  ): Promise<CommandResult> {
    const now = new Date();
    const place = await this.permitPlace(scope, access, permitId.toLowerCase(), RECORD_PERMISSION, now);
    const done = await this.permits.decide(
      scope.tx,
      permitId.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        outcome: body.outcome,
        permitNo: body.permit_no,
        issuedOn: body.issued_on,
        validFrom: body.valid_from,
        validUntil: body.valid_until,
        noExpiry: body.no_expiry,
        documentVersionId: body.document_version_id,
        reason: body.reason,
      },
      scope.tenant.membershipId,
    );
    const issued = done.outcome === 'ISSUED';
    await scope.audit({
      action: issued ? 'pmt.permit_issued' : 'pmt.permit_rejected',
      resourceType: PERMIT_RESOURCE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: {
        dossier_id: done.dossierId,
        permit_type_code: done.permitTypeCode,
        permit_type_revision: done.permitTypeRevision,
        from_status: done.fromStatus,
        to_status: done.status,
        permit_no: done.permitNo,
        issued_on: done.issuedOn,
        valid_from: done.validFrom,
        valid_until: done.validUntil,
        no_expiry: done.noExpiry,
        document_version_id: done.documentVersionId,
        readiness_pct: done.readiness?.readinessPct ?? null,
      },
    });
    await scope.emit({
      aggregateType: PERMIT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: issued ? 'pmt.permit.issued.v1' : 'pmt.permit.rejected.v1',
      schemaVersion: 1,
      payload: { ...permitPayload(scope, place.projectId, done, now), permit_no: done.permitNo },
      eventKey: `${PERMIT_RESOURCE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('permits/:id/renew')
  @HttpCode(200)
  @OperationId('renewPermit')
  @Command({ operation: 'renewPermit', versioned: true })
  async renew(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) permitId: string,
    @Body() body: Schemas['PmtRenewPermit'],
  ): Promise<CommandResult> {
    const now = new Date();
    const place = await this.permitPlace(scope, access, permitId.toLowerCase(), RECORD_PERMISSION, now);
    const done = await this.permits.renew(
      scope.tx,
      permitId.toLowerCase(),
      scope.expectedVersion ?? 0,
      { newPermitNo: body.new_permit_no, newValidUntil: body.new_valid_until, documentVersionId: body.document_version_id },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'pmt.permit_renewed',
      resourceType: PERMIT_RESOURCE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: {
        dossier_id: done.dossierId,
        superseded_permit_id: done.supersededId,
        permit_type_code: done.permitTypeCode,
        permit_type_revision: done.permitTypeRevision,
        permit_no: done.permitNo,
        issued_on: done.issuedOn,
        valid_from: done.validFrom,
        valid_until: done.validUntil,
        document_version_id: done.documentVersionId,
        readiness_pct: done.readiness?.readinessPct ?? null,
      },
    });
    await scope.emit({
      aggregateType: PERMIT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'pmt.permit.renewed.v1',
      schemaVersion: 1,
      payload: { ...permitPayload(scope, place.projectId, done, now), permit_no: done.permitNo, superseded_permit_id: done.supersededId },
      eventKey: `${PERMIT_RESOURCE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('permits/:id/revoke')
  @HttpCode(200)
  @OperationId('revokePermit')
  @Command({ operation: 'revokePermit', versioned: true })
  async revoke(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) permitId: string,
    @Body() body: Schemas['PmtRevokePermit'],
  ): Promise<CommandResult> {
    const now = new Date();
    const place = await this.permitPlace(scope, access, permitId.toLowerCase(), RECORD_PERMISSION, now);
    const done = await this.permits.revoke(
      scope.tx,
      permitId.toLowerCase(),
      scope.expectedVersion ?? 0,
      { reason: body.reason, decisionDocumentVersionId: body.decision_document_version_id },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'pmt.permit_revoked',
      resourceType: PERMIT_RESOURCE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: {
        dossier_id: done.dossierId,
        permit_type_code: done.permitTypeCode,
        permit_type_revision: done.permitTypeRevision,
        permit_no: done.permitNo,
        from_status: done.fromStatus,
        to_status: done.status,
        reason: done.reason,
        decision_document_version_id: done.revocationDocumentVersionId,
        readiness_pct: done.readiness?.readinessPct ?? null,
      },
    });
    await scope.emit({
      aggregateType: PERMIT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'pmt.permit.revoked.v1',
      schemaVersion: 1,
      payload: permitPayload(scope, place.projectId, done, now),
      eventKey: `${PERMIT_RESOURCE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The dossier a command acts on: absent in the tenant is 404, outside the scope of the grant is 403. */
  private async dossierPlace(scope: CommandScope, access: EffectiveAccess, dossierId: string, permission: string, now: Date): Promise<DossierPlace> {
    const place = await this.dossiers.dossierPlace(scope.tx, dossierId);
    if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, permission, place, now)) throw new DomainError('SCOPE_DENIED', 403);
    return place;
  }

  private async permitPlace(scope: CommandScope, access: EffectiveAccess, permitId: string, permission: string, now: Date): Promise<DossierPlace> {
    const place = await this.dossiers.permitPlace(scope.tx, permitId);
    if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, permission, place, now)) throw new DomainError('SCOPE_DENIED', 403);
    return place;
  }
}
