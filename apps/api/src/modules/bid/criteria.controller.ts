import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidCriteriaReads, BidCriteriaStore, CRITERIA_STATUSES, TenantDatabase, criteriaReadScope, projectScope } from '@machvon/db';
import type { BidApprovedCriteria, BidCreatedCriteria, CriteriaStatus } from '@machvon/db';
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
import { criteriaView } from './criteria-view';

const RESOURCE_TYPE = 'criteria_version';
const MANAGE_PERMISSION = PERMISSIONS.createCriteriaVersion;
const APPROVE_PERMISSION = PERMISSIONS.approveCriteriaVersion;
const LIST_PERMISSION = PERMISSIONS.get_resources_criteria_version;
const DETAIL_PERMISSION = PERMISSIONS.get_resources_criteria_version_id;
const STATUS_VALUES: readonly string[] = CRITERIA_STATUSES;

/**
 * The evaluation criteria of a package (ST-BID-003, BID 3 F4): a planner of the scope of the project of the package drafts a version (criteria with
 * weights that add up to 100, thresholds and the evidence they ask for, under a legal basis; criteria nobody may ask for are refused with their
 * legal basis), an authority of the scope who is not the maker approves and locks it. Status, approver and version are written by no body.
 */
@Controller('criteria-versions')
export class CriteriaVersionController {
  private readonly store = new BidCriteriaStore();

  @Post()
  @HttpCode(200)
  @OperationId('createCriteriaVersion')
  @Command({ operation: 'createCriteriaVersion', ttl: 'extended' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BidCriteriaDraft']): Promise<CommandResult> {
    const now = new Date();
    const created = await this.store.create(
      scope.tx,
      { packageId: body.package_id, criteriaJson: body.criteria_json, legalBasis: body.legal_basis },
      scope.tenant.membershipId,
      projectScope(access, MANAGE_PERMISSION, now),
    );
    await scope.audit({
      action: 'criteria_version.drafted',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: {
        package_id: created.packageId,
        revision: created.revision,
        weights_sum: created.weightsSum,
        criteria_count: created.criteriaCount,
        supersedes_id: created.supersedesId,
        replaced_draft_id: created.replacedDraftId,
      },
    });
    await this.emitDrafted(scope, created, now);
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post(':id/approval')
  @HttpCode(200)
  @OperationId('approveCriteriaVersion')
  @Command({ operation: 'approveCriteriaVersion', versioned: true })
  async approve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const expected = scope.expectedVersion ?? 0;
    const approved = await this.store.approve(scope.tx, id.toLowerCase(), expected, scope.tenant.membershipId, projectScope(access, APPROVE_PERMISSION, now));
    await scope.audit({
      action: 'criteria_version.approved',
      resourceType: RESOURCE_TYPE,
      resourceId: approved.id,
      diff: {
        package_id: approved.packageId,
        revision: approved.revision,
        criteria_version_before: expected,
        criteria_version_after: approved.version,
        weights_sum: approved.weightsSum,
        criteria_count: approved.criteriaCount,
        superseded_id: approved.supersededId,
      },
    });
    await this.emitApproved(scope, approved, now);
    return commandResult(scope, approved.status, approved.version, approved.id);
  }

  private async emitDrafted(scope: CommandScope, created: BidCreatedCriteria, now: Date): Promise<void> {
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'bid.criteria.drafted.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        criteria_version_id: created.id,
        package_id: created.packageId,
        revision: created.revision,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        weights_sum: created.weightsSum,
        criteria_count: created.criteriaCount,
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
  }

  private async emitApproved(scope: CommandScope, approved: BidApprovedCriteria, now: Date): Promise<void> {
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: approved.id,
      aggregateVersion: approved.version,
      type: 'bid.criteria.approved.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        criteria_version_id: approved.id,
        package_id: approved.packageId,
        revision: approved.revision,
        version: approved.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        weights_sum: approved.weightsSum,
        criteria_count: approved.criteriaCount,
        superseded_id: approved.supersededId,
      },
      eventKey: `${RESOURCE_TYPE}:${approved.id}:${approved.version}`,
    });
  }
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

function optionalStatus(value: unknown): CriteriaStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !STATUS_VALUES.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  return value as CriteriaStatus;
}

/**
 * The criteria for reading (BID-04): the versions of the packages of the projects in the scope of the caller, the newest first. A draft is shown
 * to the people who draft and approve criteria only.
 */
@Controller('resources/criteria_version')
export class CriteriaVersionReadsController {
  private readonly reads = new BidCriteriaReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_criteria_version')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('package_id') packageId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { packageId: optionalUuid(packageId, 'package_id'), status: optionalStatus(status) };
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.reads.list(tx, criteriaReadScope(access, LIST_PERMISSION, now), filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(criteriaView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_criteria_version_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.reads.find(tx, id.toLowerCase(), criteriaReadScope(access, DETAIL_PERMISSION, new Date())));
    // A version of another tenant, outside the scope of the caller or a draft the caller does not see does not exist for them.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return criteriaView(found);
  }
}
