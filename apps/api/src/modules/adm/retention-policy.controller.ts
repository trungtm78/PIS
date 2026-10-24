import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { RetentionPolicyStore } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, RetentionPolicyContent } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { ADM_CLOCK } from './tokens';
import { holdsOnWholeTenant } from './tenant-authority';

const MANAGE_PERMISSION = PERMISSIONS.createRetentionPolicyVersion;
const APPROVE_PERMISSION = PERMISSIONS.publishRetentionPolicy;
const RESOURCE_TYPE = 'data_retention_policy';

/** Retention rules are tenant administration (ADM 3.12): a grant on the whole tenant reaches them, a grant on a subtree does not. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/**
 * Retention policy versions (ST-ADM-017, ADM 3.12, BR-ADM-11). A draft changes nothing; publishing it, by someone other than its author,
 * makes it the rule the nightly retention job reads for its record class and supersedes the version it replaces. A rule that would let a
 * job delete a business record is refused (422 RETENTION_POLICY_INVALID): business records are reviewed by people, technical data is purged.
 */
@Controller('retention-policies')
export class RetentionPoliciesController {
  private readonly store = new RetentionPolicyStore();
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(ADM_CLOCK) clock?: () => Date) {
    this.clock = clock ?? (() => new Date());
  }

  @Post()
  @OperationId('createRetentionPolicyVersion')
  @Command({ operation: 'createRetentionPolicyVersion' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RetentionPolicyDraft']): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const content: RetentionPolicyContent = {
      record_class: body.record_class,
      retention_years: body.retention_years,
      retention_basis: body.retention_basis,
      legal_basis_ref: body.legal_basis_ref,
      end_action: body.end_action,
      effective_from: body.effective_from,
    };
    const created = await this.store.createDraft(scope.tx, content, scope.tenant.membershipId);
    await scope.audit({
      action: 'retention.draft_created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.row.id,
      classification: 'PUBLIC',
      diff: {
        record_class: created.row.recordClass,
        revision: created.row.revision,
        retention_years: created.row.retentionYears,
        retention_basis: created.row.retentionBasis,
        end_action: created.row.endAction,
        legal_basis_ref: created.row.legalBasisRef,
        effective_from: created.row.effectiveFrom,
        replaced_draft_id: created.replacedDraftId ?? null,
      },
    });
    return commandResult(scope, 'DRAFTED', created.row.version, created.row.id);
  }

  @Post(':policyId/publish')
  @HttpCode(200)
  @OperationId('publishRetentionPolicy')
  @Command({ operation: 'publishRetentionPolicy', versioned: true })
  async publish(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body() body: Schemas['ReasonOnly'],
  ): Promise<CommandResult> {
    assertHolds(access, APPROVE_PERMISSION);
    const draft = await this.store.lockDraft(scope.tx, policyId, scope.expectedVersion ?? 0);
    const { version, supersededId } = await this.store.publish(scope.tx, draft, scope.tenant.membershipId, vietnamDateOf(this.clock()));
    await scope.audit({
      action: 'retention.published',
      resourceType: RESOURCE_TYPE,
      resourceId: policyId,
      reason: body.reason,
      classification: 'PUBLIC',
      diff: { record_class: draft.recordClass, revision: draft.revision, end_action: draft.endAction, retention_basis: draft.retentionBasis, retention_years: draft.retentionYears, superseded_id: supersededId ?? null },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: policyId,
      aggregateVersion: version,
      type: 'adm.retention_policy.published.v1',
      schemaVersion: 1,
      payload: { id: policyId, record_class: draft.recordClass, revision: draft.revision, superseded_id: supersededId ?? null },
      eventKey: `${RESOURCE_TYPE}:${policyId}:${version}`,
    });
    return commandResult(scope, 'PUBLISHED', version, policyId);
  }
}
