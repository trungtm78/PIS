import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AVC_CONTROL_OBJECTS, AVC_STATUSES, CapAvcPolicyStore, TenantDatabase } from '@machvon/db';
import type { AvcControlObject, AvcPolicyFilter, AvcPolicyRecord, AvcPolicyStatus, AvcPreview } from '@machvon/db';
import { DomainError, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const RESOURCE_TYPE = 'avc_policy';
const STATUS_VALUES: readonly string[] = AVC_STATUSES;
const OBJECT_VALUES: readonly string[] = AVC_CONTROL_OBJECTS;
const POLICY_PUBLISHED_EVENT = 'capital.avc_policy_published.v1';

/** A policy as the screens read it: the thresholds as written, the scope, the object it controls, its period and who stands behind it. */
export function avcPolicyView(row: AvcPolicyRecord): Record<string, unknown> {
  return {
    id: row.id,
    policy_code: row.policyCode,
    revision: row.revision,
    scope_kind: row.scopeKind,
    scope_ref_id: row.scopeRefId,
    scope_value: row.scopeValue,
    control_object: row.controlObject,
    warn_pct: row.warnPct,
    block_pct: row.blockPct,
    include_reservations: row.includeReservations,
    legal_basis: row.legalBasis,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    status: row.status,
    approved_by: row.approvedBy,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    version: row.version,
  };
}

function previewView(preview: AvcPreview): Record<string, unknown> {
  return { policy_id: preview.policyId, control_object: preview.controlObject, total: preview.total, ok: preview.ok, warn: preview.warn, block: preview.block, as_of: preview.asOf };
}

function filterOf(status: unknown, controlObject: unknown): AvcPolicyFilter {
  if (status !== undefined && (typeof status !== 'string' || !STATUS_VALUES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  if (controlObject !== undefined && (typeof controlObject !== 'string' || !OBJECT_VALUES.includes(controlObject))) throw new DomainError('VALIDATION_FAILED', 422, 'control_object');
  return {
    ...(status === undefined ? {} : { status: status as AvcPolicyStatus }),
    ...(controlObject === undefined ? {} : { controlObject: controlObject as AvcControlObject }),
  };
}

/** The availability control policy is a rule of the whole tenant: a grant on one unit or one project does not write it, publish it or preview it. */
function assertTenantAuthority(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/**
 * The availability control policy (ST-CAP-005, CAP 3.1 F4, BR-CAP-06): a policy administrator drafts the thresholds (warn at most block, block at most 100) for a scope and
 * an object under a legal basis, another person publishes it, and every spending command is judged by the most specific policy in force. What a policy says never changes;
 * a change is the next revision, and the earlier one ends the day before.
 */
@Controller('avc-policies')
export class AvcPolicyController {
  private readonly policies = new CapAvcPolicyStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post()
  @HttpCode(200)
  @OperationId('createAvcPolicyVersion')
  @Command({ operation: 'createAvcPolicyVersion', versioned: false })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CapAvcPolicy']): Promise<CommandResult & Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.createAvcPolicyVersion);
    const created = await this.policies.create(
      scope.tx,
      {
        policyCode: body.policy_code,
        scopeKind: body.scope_kind,
        scopeRefId: body.scope_ref_id,
        scopeValue: body.scope_value,
        controlObject: body.control_object,
        warnPct: body.warn_pct,
        blockPct: body.block_pct,
        includeReservations: body.include_reservations,
        legalBasis: body.legal_basis,
        effectiveFrom: body.effective_from,
        effectiveUntil: body.effective_until,
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'capital.avc_policy_created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: {
        policy_code: created.policyCode,
        revision: created.revision,
        scope_kind: created.scopeKind,
        scope_ref_id: created.scopeRefId,
        scope_value: created.scopeValue,
        control_object: created.controlObject,
        warn_pct: created.warnPct,
        block_pct: created.blockPct,
        include_reservations: created.includeReservations,
        effective_from: created.effectiveFrom,
        effective_until: created.effectiveUntil,
      },
    });
    return { ...commandResult(scope, created.status, created.version, created.id), policy_code: created.policyCode, revision: created.revision };
  }

  @Post(':id/publish')
  @HttpCode(200)
  @OperationId('publishAvcPolicy')
  @Command({ operation: 'publishAvcPolicy', versioned: true })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult & Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.publishAvcPolicy);
    if (scope.expectedVersion === null) throw versionConflict(0);
    const now = new Date();
    const { policy, endedPolicyIds } = await this.policies.publish(scope.tx, id, scope.expectedVersion, scope.tenant.membershipId);
    await scope.audit({
      action: 'capital.avc_policy_published',
      resourceType: RESOURCE_TYPE,
      resourceId: policy.id,
      diff: { policy_code: policy.policyCode, revision: policy.revision, scope_kind: policy.scopeKind, control_object: policy.controlObject, warn_pct: policy.warnPct, block_pct: policy.blockPct, effective_from: policy.effectiveFrom, ended_policy_ids: endedPolicyIds },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: policy.id,
      aggregateVersion: policy.version,
      type: POLICY_PUBLISHED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        policy_id: policy.id,
        version: policy.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        policy_code: policy.policyCode,
        revision: policy.revision,
        scope_kind: policy.scopeKind,
        scope_ref_id: policy.scopeRefId,
        scope_value: policy.scopeValue,
        control_object: policy.controlObject,
        warn_pct: policy.warnPct,
        block_pct: policy.blockPct,
        include_reservations: policy.includeReservations,
        effective_from: policy.effectiveFrom,
        effective_until: policy.effectiveUntil,
        ended_policy_ids: endedPolicyIds,
      },
      eventKey: `${RESOURCE_TYPE}:${policy.id}:published`,
    });
    return { ...commandResult(scope, policy.status, policy.version, policy.id), ended_policy_ids: endedPolicyIds };
  }

  @Get()
  @OperationId('listAvcPolicies')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('status') status?: unknown,
    @Query('control_object') controlObject?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const filter = filterOf(status, controlObject);
    const rows = await this.database.withTenant(tenant, (tx) => this.policies.list(tx, filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(avcPolicyView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }

  @Get(':id/preview')
  @OperationId('previewAvcPolicy')
  async preview(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.previewAvcPolicy);
    const preview = await this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policies.find(tx, id);
      return policy === undefined ? undefined : this.policies.preview(tx, policy);
    });
    if (preview === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return previewView(preview);
  }
}
