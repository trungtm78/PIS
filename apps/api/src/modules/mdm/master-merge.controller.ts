import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { MASTER_MERGE_RESOURCE, MasterMergeStore, SURVIVORSHIP_RULE_RESOURCE, TenantDatabase } from '@machvon/db';
import type { MasterMerge, SurvivorshipRule } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { textOf } from './inputs';

const RECORD_RESOURCE = 'master_record';
const MERGED_EVENT = 'master.merged.v1';
const UNMERGED_EVENT = 'master.unmerged.v1';
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'string' || !/^[0-9]{1,4}$/.test(value) || Number(value) < 1 || Number(value) > MAX_PAGE) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return Number(value);
}

/** A free object of the body that must be one: absent is empty, anything else that is not an object is 422 naming the field. */
function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value as Record<string, unknown>;
}

export function ruleView(rule: SurvivorshipRule): Record<string, unknown> {
  return {
    id: rule.id,
    master_type: rule.masterType,
    attribute_name: rule.attributeName,
    strategy: rule.strategy,
    source_priority: rule.sourcePriority,
    revision: rule.revision,
    status: rule.status,
    effective_from: rule.effectiveFrom,
    approved_by: rule.approvedBy,
    created_by: rule.createdBy,
    created_at: rule.createdAt,
    version: rule.version,
  };
}

export function mergeView(merge: MasterMerge): Record<string, unknown> {
  return {
    id: merge.id,
    survivor_record_id: merge.survivorRecordId,
    survivor_key: merge.survivorKey,
    merged_record_id: merge.mergedRecordId,
    merged_key: merge.mergedKey,
    master_type: merge.masterType,
    decisions: merge.survivorship.decisions.map((decision) => ({ attribute: decision.attribute, chosen: decision.chosen, by: decision.by, strategy: decision.strategy, source: decision.source })),
    aliases: { merged_key: merge.mergedKey, merged_label: merge.alias.merged?.label ?? null },
    repointed: merge.repointed.map((ref) => ({ table: ref.table, id: ref.id })),
    reason: merge.reason,
    status: merge.status,
    applied_at: merge.appliedAt,
    reverted_by: merge.revertedBy,
    reverted_at: merge.revertedAt,
    revert_reason: merge.revertReason,
    version: merge.version,
  };
}

/**
 * The merge of master records and its undoing, and the rules of survivorship (ST-MDM-010, MDM 3.1 F5, BR-MDM-05, UAT-AC274, UAT-AC275). A checker merges one entry into another by the published rule for each attribute
 * (a steward settles what no rule does), and may undo it; neither is done by the person who made either entry. A rule is drafted by one person and published by another.
 */
@Controller()
export class MasterMergeController {
  private readonly merges = new MasterMergeStore();

  @Post('master-records/:id/merge')
  @HttpCode(200)
  @OperationId('post_master_records_id_merge')
  @Command({ operation: 'post_master_records_id_merge', versioned: true })
  async merge(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MdmMergeRequest']): Promise<CommandResult & Record<string, unknown>> {
    const mergedId = asUuid(body.merged_record_id);
    if (mergedId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'merged_record_id');
    const done = await this.merges.merge(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { mergedRecordId: mergedId, reason: body.reason, overrides: objectOf(body.survivorship_overrides, 'survivorship_overrides') },
      scope.tenant.membershipId,
    );
    const { merge } = done;
    await scope.audit({
      action: 'master.merged',
      resourceType: RECORD_RESOURCE,
      resourceId: merge.survivorRecordId,
      reason: merge.reason,
      diff: {
        merge_id: merge.id,
        merged_record_id: merge.mergedRecordId,
        master_type: merge.masterType,
        decisions: merge.survivorship.decisions.map((decision) => ({ attribute: decision.attribute, chosen: decision.chosen, by: decision.by, strategy: decision.strategy })),
        repointed: merge.repointed.length,
      },
    });
    await scope.emit({
      aggregateType: RECORD_RESOURCE,
      aggregateId: merge.survivorRecordId,
      aggregateVersion: done.survivorVersion,
      type: MERGED_EVENT,
      schemaVersion: 1,
      payload: { merge_id: merge.id, survivor_record_id: merge.survivorRecordId, merged_record_id: merge.mergedRecordId, master_type: merge.masterType, version_id: done.survivorVersionId },
      eventKey: `${MASTER_MERGE_RESOURCE}:${merge.id}:merged`,
    });
    return { ...commandResult(scope, 'MERGED', done.survivorVersion, merge.survivorRecordId), merge_id: merge.id, merged_record_id: merge.mergedRecordId, repointed: merge.repointed.length };
  }

  @Post('master-merges/:id/unmerge')
  @HttpCode(200)
  @OperationId('unmergeMasterRecords')
  @Command({ operation: 'unmergeMasterRecords', versioned: true })
  async unmerge(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MdmUnmerge']): Promise<CommandResult & Record<string, unknown>> {
    const done = await this.merges.unmerge(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { reason: body.reason, stewardDecisions: objectOf(body.steward_decisions, 'steward_decisions') },
      scope.tenant.membershipId,
    );
    const { merge } = done;
    await scope.audit({
      action: 'master.unmerged',
      resourceType: MASTER_MERGE_RESOURCE,
      resourceId: merge.id,
      reason: merge.revertReason ?? '',
      diff: {
        survivor_record_id: merge.survivorRecordId,
        merged_record_id: merge.mergedRecordId,
        reverted: done.reverted,
        kept: done.kept,
        restored: done.restored.length,
        not_restored: done.notRestored.length,
        steward_decisions: Object.keys(objectOf(body.steward_decisions, 'steward_decisions')),
      },
    });
    await scope.emit({
      aggregateType: MASTER_MERGE_RESOURCE,
      aggregateId: merge.id,
      aggregateVersion: merge.version,
      type: UNMERGED_EVENT,
      schemaVersion: 1,
      payload: { merge_id: merge.id, survivor_record_id: merge.survivorRecordId, merged_record_id: merge.mergedRecordId, master_type: merge.masterType },
      eventKey: `${MASTER_MERGE_RESOURCE}:${merge.id}:unmerged`,
    });
    return {
      ...commandResult(scope, merge.status, merge.version, merge.id),
      reverted: done.reverted,
      kept: done.kept,
      restored: done.restored.length,
      not_restored: done.notRestored.map((ref) => ({ table: ref.table, id: ref.id })),
    };
  }

  @Post('survivorship-rules')
  @HttpCode(200)
  @OperationId('createSurvivorshipRuleVersion')
  @Command({ operation: 'createSurvivorshipRuleVersion' })
  async createRule(@Scope() scope: CommandScope, @Body() body: Schemas['MdmSurvivorshipRule']): Promise<CommandResult> {
    const rule = await this.merges.createRule(
      scope.tx,
      { masterType: body.master_type, attributeName: body.attribute_name, strategy: body.strategy, sourcePriority: body.source_priority, effectiveFrom: body.effective_from },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'master.survivorship_rule_drafted',
      resourceType: SURVIVORSHIP_RULE_RESOURCE,
      resourceId: rule.id,
      diff: {
        master_type: rule.masterType,
        attribute_name: rule.attributeName,
        strategy: rule.strategy,
        source_priority: rule.sourcePriority,
        revision: rule.revision,
        effective_from: rule.effectiveFrom,
      },
    });
    return commandResult(scope, rule.status, rule.version, rule.id);
  }

  @Post('survivorship-rules/:id/publish')
  @HttpCode(200)
  @OperationId('publishSurvivorshipRule')
  @Command({ operation: 'publishSurvivorshipRule', versioned: true })
  async publishRule(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const done = await this.merges.publishRule(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({
      action: 'master.survivorship_rule_published',
      resourceType: SURVIVORSHIP_RULE_RESOURCE,
      resourceId: done.rule.id,
      diff: { master_type: done.rule.masterType, attribute_name: done.rule.attributeName, revision: done.rule.revision, retired_ids: done.retiredIds },
    });
    return commandResult(scope, done.rule.status, done.rule.version, done.rule.id);
  }
}

/** What is read of the merges and the rules of survivorship (MDM-30, MDM-35, MDM-36). */
@Controller()
export class MasterMergeReadsController {
  private readonly merges = new MasterMergeStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('survivorship-rules')
  @OperationId('listSurvivorshipRules')
  async rules(
    @CurrentTenant() tenant: TenantContext,
    @Query('master_type') masterType?: unknown,
    @Query('status') status?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const page = await this.database.withTenant(tenant, (tx) =>
      this.merges.listRules(tx, { masterType: textOf(masterType, 'master_type'), status: textOf(status, 'status'), cursor: textOf(cursor, 'cursor'), limit: limitOf(limit) }),
    );
    return { items: page.items.map(ruleView), next_cursor: page.next };
  }

  @Get('master-merges')
  @OperationId('listMasterMerges')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('record_id') recordId?: unknown,
    @Query('status') status?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const record = recordId === undefined ? undefined : asUuid(recordId);
    if (recordId !== undefined && record === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'record_id');
    const page = await this.database.withTenant(tenant, (tx) =>
      this.merges.listMerges(tx, { recordId: record, status: textOf(status, 'status'), cursor: textOf(cursor, 'cursor'), limit: limitOf(limit) }),
    );
    return { items: page.items.map(mergeView), next_cursor: page.next };
  }
}
