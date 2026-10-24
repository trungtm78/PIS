import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IssSlaPolicyStore } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const POLICY_RESOURCE = 'issue_sla_policy';
const MANAGE_PERMISSION = PERMISSIONS.upsertIssueSlaPolicy;

/** ISS 2 gives issue.sla.manage to the SLA administrator on the whole tenant: a policy decides the deadlines of every unit, so a grant on a subtree does not reach it. */
function assertHolds(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, MANAGE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
}

/**
 * The SLA policies of the issue module (ST-ISS-001, ISS 3.1, BR-ISS-02). A policy is written for a category, a severity and optionally a
 * unit, and a change is a new revision that takes over from a date: the revision an issue was created under is never edited, so the
 * deadline stored with the issue stays what it was when it was set.
 */
@Controller()
export class IssSlaPolicyController {
  private readonly policies = new IssSlaPolicyStore();

  @Post('issue-sla-policies')
  @HttpCode(200)
  @OperationId('upsertIssueSlaPolicy')
  @Command({ operation: 'upsertIssueSlaPolicy' })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['IssUpsertIssueSlaPolicy']): Promise<CommandResult> {
    assertHolds(access);
    const published = await this.policies.publish(
      scope.tx,
      {
        code: body.code,
        categoryVersionId: body.category_version_id,
        severity: body.severity,
        ownerUnitId: body.owner_unit_id,
        calendarCode: body.calendar_code,
        responseHours: body.response_hours,
        resolveHours: body.resolve_hours,
        escalateL2Pct: body.escalate_l2_pct,
        escalateL3Pct: body.escalate_l3_pct,
        requireIndependentVerifier: body.require_independent_verifier,
        requireEvidence: body.require_evidence,
        validFrom: body.valid_from,
      },
      scope.tenant.membershipId,
    );
    const row = await this.policies.find(scope.tx, published.id);
    await scope.audit({
      action: 'iss.sla_policy_published',
      resourceType: POLICY_RESOURCE,
      resourceId: published.id,
      diff: {
        code: row?.code,
        revision: published.revision,
        category_version_id: body.category_version_id,
        severity: body.severity,
        owner_unit_id: body.owner_unit_id ?? null,
        calendar_code: row?.calendarCode,
        response_hours: row?.responseHours,
        resolve_hours: row?.resolveHours,
        valid_from: row?.validFrom,
        superseded_policy_id: published.supersededId,
      },
    });
    await scope.emit({
      aggregateType: POLICY_RESOURCE,
      aggregateId: published.id,
      aggregateVersion: published.version,
      type: 'iss.sla_policy.published.v1',
      schemaVersion: 1,
      payload: { policy_id: published.id, code: row?.code, revision: published.revision, severity: body.severity, valid_from: row?.validFrom, superseded_policy_id: published.supersededId },
      eventKey: `${POLICY_RESOURCE}:${published.id}:${published.version}`,
    });
    return commandResult(scope, 'ACTIVE', published.version, published.id);
  }

  @Post('issue-sla-policies/:id/retire')
  @HttpCode(200)
  @OperationId('retireIssueSlaPolicy')
  @Command({ operation: 'retireIssueSlaPolicy' })
  async retire(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['IssRetireIssueSlaPolicy'],
  ): Promise<CommandResult> {
    assertHolds(access);
    const retired = await this.policies.retire(scope.tx, id, body.valid_until, scope.tenant.membershipId);
    await scope.audit({
      action: 'iss.sla_policy_retired',
      resourceType: POLICY_RESOURCE,
      resourceId: id,
      diff: { code: retired.row.code, revision: retired.row.revision, valid_until: body.valid_until },
    });
    await scope.emit({
      aggregateType: POLICY_RESOURCE,
      aggregateId: id,
      aggregateVersion: retired.version,
      type: 'iss.sla_policy.retired.v1',
      schemaVersion: 1,
      payload: { policy_id: id, code: retired.row.code, revision: retired.row.revision, valid_until: body.valid_until },
      eventKey: `${POLICY_RESOURCE}:${id}:${retired.version}`,
    });
    return commandResult(scope, 'RETIRED', retired.version, id);
  }
}
