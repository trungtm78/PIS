import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { GATE_CODES, PmtGateWaiverStore, TenantDatabase, WAIVER_STATUSES, projectScope } from '@machvon/db';
import type { GateCode, WaiverRow, WaiverStatus } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const WAIVE_PERMISSION = PERMISSIONS.grantPermitGateWaiver;
const READ_PERMISSION = PERMISSIONS.get_resources_permit_gate_waiver;
const RESOURCE_TYPE = 'permit_gate_waiver';

/** A waiver as the screens read it: an explicit allowlist, so a column added to the table reaches no screen until it is named here; who asked and who approved are in the audit trail. */
function waiverView(row: WaiverRow): Record<string, unknown> {
  return {
    id: row.id,
    project: { id: row.project.id, code: row.project.code, name: row.project.name },
    gate_code: row.gateCode,
    permit_type_id: row.permitTypeId,
    permit_type_code: row.permitTypeCode,
    permit_type_name: row.permitTypeName,
    reason: row.reason,
    decision_document_version_id: row.decisionDocumentVersionId,
    valid_until: row.validUntil,
    granted_on: row.grantedOn,
    status: row.status,
    revoked_on: row.revokedOn,
    revoked_reason: row.revokedReason,
    version: row.version,
  };
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

function optionalOneOf<Value extends string>(list: readonly Value[], value: unknown, field: string): Value | undefined {
  if (value === undefined) return undefined;
  const found = list.find((candidate) => candidate === value);
  if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return found;
}

/**
 * The waivers of the permit gates (ST-PMT-005, PMT 3.2 step 4, BR-PMT-05): the leader in charge of a project of their scope lets a gate pass without a
 * permit of one type until a last day within the longest a waiver may last, on a decision document and for a reason, and not when they are one of the
 * people who asked for it. A waiver is never extended or edited; it ends by its last day (the job `gate-waiver-expiry`) or by a revocation.
 */
@Controller()
export class PermitGateWaiverController {
  private readonly waivers = new PmtGateWaiverStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('permit-gate-waivers')
  @HttpCode(200)
  @OperationId('grantPermitGateWaiver')
  @Command({ operation: 'grantPermitGateWaiver' })
  async grant(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PmtGrantPermitGateWaiver']): Promise<CommandResult> {
    const granted = await this.waivers.grant(
      scope.tx,
      {
        projectId: body.project_id,
        gateCode: body.gate_code,
        permitTypeId: body.permit_type_id,
        reason: body.reason,
        decisionDocumentVersionId: body.decision_document_version_id,
        validUntil: body.valid_until,
      },
      scope.tenant.membershipId,
      projectScope(access, WAIVE_PERMISSION, new Date()),
    );
    await scope.audit({
      action: 'pmt.gate_waiver_granted',
      resourceType: RESOURCE_TYPE,
      resourceId: granted.id,
      reason: body.reason.trim(),
      diff: {
        project_id: granted.projectId,
        gate_code: granted.gateCode,
        permit_type_code: granted.permitTypeCode,
        decision_document_version_id: granted.decisionDocumentVersionId,
        valid_until: granted.validUntil,
        days: granted.days,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: granted.id,
      aggregateVersion: granted.version,
      type: 'pmt.gate_waiver.granted.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        gate_waiver_id: granted.id,
        project_id: granted.projectId,
        gate_code: granted.gateCode,
        permit_type_code: granted.permitTypeCode,
        valid_until: granted.validUntil,
        occurred_at: new Date().toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${granted.id}:${granted.version}`,
    });
    return commandResult(scope, granted.status, granted.version, granted.id);
  }

  @Post('permit-gate-waivers/:id/revoke')
  @HttpCode(200)
  @OperationId('revokePermitGateWaiver')
  @Command({ operation: 'revokePermitGateWaiver' })
  async revoke(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PmtRevokePermitGateWaiver'],
  ): Promise<CommandResult> {
    const revoked = await this.waivers.revoke(scope.tx, id.toLowerCase(), body.reason, scope.tenant.membershipId, projectScope(access, WAIVE_PERMISSION, new Date()));
    await scope.audit({
      action: 'pmt.gate_waiver_revoked',
      resourceType: RESOURCE_TYPE,
      resourceId: revoked.id,
      reason: body.reason.trim(),
      diff: { project_id: revoked.projectId, gate_code: revoked.gateCode, permit_type_code: revoked.permitTypeCode, from_status: 'ACTIVE', to_status: 'REVOKED', valid_until: revoked.validUntil },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: revoked.id,
      aggregateVersion: revoked.version,
      type: 'pmt.gate_waiver.revoked.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        gate_waiver_id: revoked.id,
        project_id: revoked.projectId,
        gate_code: revoked.gateCode,
        permit_type_code: revoked.permitTypeCode,
        occurred_at: new Date().toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${revoked.id}:${revoked.version}`,
    });
    return commandResult(scope, revoked.status, revoked.version, revoked.id);
  }

  /**
   * The waivers of the projects in the scope of the caller (PMT-06), the newest first, by project, gate and status. A waiver of a project outside the
   * scope, or of another tenant, is not there for them.
   */
  @Get('resources/permit_gate_waiver')
  @OperationId('get_resources_permit_gate_waiver')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') projectId?: unknown,
    @Query('gate_code') gateCode?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const filter = {
      projectId: optionalUuid(projectId, 'project_id'),
      gateCode: optionalOneOf<GateCode>(GATE_CODES, gateCode, 'gate_code'),
      status: optionalOneOf<WaiverStatus>(WAIVER_STATUSES, status, 'status'),
    };
    const scope = projectScope(access, READ_PERMISSION, new Date());
    const rows = await this.database.withTenant(tenant, (tx) => this.waivers.list(tx, scope, filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(waiverView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }
}
