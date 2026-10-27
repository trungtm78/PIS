import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PrjTransferStore, TenantDatabase, projectScope, transferAppliedRecord, transferDecidedRecord, transferRequestedRecord } from '@machvon/db';
import type { TransferImpact, TransferRow } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
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
import { SHARED_PIPELINE_CACHE } from './pipeline-cache';
import type { PipelineCache } from './pipeline-cache';
import { PRJ_PIPELINE_CACHE } from './tokens';

const READ_PERMISSION = PERMISSIONS.listProjectTransfers;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function queryText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw invalid(name);
  return value;
}

function queryId(value: unknown, name: string): string | undefined {
  const text = queryText(value, name);
  if (text === undefined) return undefined;
  const id = asUuid(text);
  if (id === undefined) throw invalid(name);
  return id;
}

/** The request as the contract exposes it (an allowlist). */
export function transferView(row: TransferRow): Record<string, unknown> {
  return {
    id: row.id,
    project: { id: row.projectId, code: row.projectCode, name: row.projectName },
    transfer_scope: row.scope,
    from_unit: { id: row.fromUnitId, name: row.fromUnitName },
    to_unit: { id: row.toUnitId, name: row.toUnitName },
    effective_date: row.effectiveDate,
    decision_document_id: row.decisionDocumentId,
    reason: row.reason,
    status: row.status,
    approved_by: row.approvedBy,
    decision_reason: row.decisionReason,
    decided_at: row.decidedAt,
    applied_at: row.appliedAt,
    created_at: row.createdAt,
    created_by: row.createdBy,
    version: row.version,
  };
}

export function impactView(impact: TransferImpact): Record<string, unknown> {
  return {
    project_id: impact.projectId,
    transfer_scope: impact.scope,
    from_unit: impact.fromUnit,
    to_unit: impact.toUnit,
    reports: impact.reports,
    snapshot_lines: impact.snapshotLines,
    plan_lines: impact.planLines,
    users_gaining: impact.usersGaining,
    users_losing: impact.usersLosing,
    members_checked: impact.membersChecked,
    partial: impact.partial,
  };
}

/**
 * The transfer of a project between units (ST-PRJ-007, PRJ 3.1 F10, PRJ-20): the investor asks that a unit of the same tenant become the owner unit or the investor unit of a project from a day; someone else decides;
 * the change is made on the day (at once when the day has come) by the decision or by the job `prj-transfer-apply`. The reports and the snapshots before the day keep the old unit. What a transfer would change is
 * counted before it is asked for.
 */
@Controller()
export class TransferController {
  private readonly store = new PrjTransferStore();
  private readonly cache: PipelineCache;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(PRJ_PIPELINE_CACHE) cache?: PipelineCache,
  ) {
    this.cache = cache ?? SHARED_PIPELINE_CACHE;
  }

  @Get('project-transfers')
  @OperationId('listProjectTransfers')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') projectId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (request.after !== undefined && (!TIMESTAMP.test(request.after.code) || Number.isNaN(Date.parse(request.after.code)))) throw invalid('cursor');
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.store.list(tx, { projectId: queryId(projectId, 'project_id'), status: queryText(status, 'status') }, projectScope(access, READ_PERMISSION, now), {
        limit: request.limit,
        after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id },
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(transferView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null, as_of: vietnamDateOf(now) };
  }

  @Get('projects/:id/transfer-impact')
  @OperationId('getProjectTransferImpact')
  async impact(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('to_unit_id') toUnitId?: unknown,
    @Query('transfer_scope') transferScope?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const target = queryId(toUnitId, 'to_unit_id');
    const scopeName = queryText(transferScope, 'transfer_scope');
    if (target === undefined) throw invalid('to_unit_id');
    if (scopeName === undefined) throw invalid('transfer_scope');
    const impact = await this.database.withTenant(tenant, (tx) =>
      this.store.impact(tx, {
        projectId: id.toLowerCase(),
        toUnitId: target,
        scope: scopeName,
        scopes: { act: projectScope(access, PERMISSIONS.requestProjectTransfer, now), read: projectScope(access, READ_PERMISSION, now) },
        now,
      }),
    );
    return { ...impactView(impact), as_of: vietnamDateOf(now) };
  }

  @Post('projects/:id/transfers')
  @HttpCode(200)
  @OperationId('requestProjectTransfer')
  @Command({ operation: 'requestProjectTransfer', versioned: true })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjTransferRequest']): Promise<CommandResult> {
    const now = new Date();
    const made = await this.store.request(scope.tx, {
      projectId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      toUnitId: body.to_unit_id,
      scope: body.transfer_scope,
      effectiveDate: body.effective_date,
      reason: body.reason,
      decisionDocumentId: body.decision_document_id,
      actor: scope.tenant.membershipId,
      today: vietnamDateOf(now),
      scopes: { act: projectScope(access, PERMISSIONS.requestProjectTransfer, now), read: projectScope(access, READ_PERMISSION, now) },
    });
    await scope.audit(transferRequestedRecord(made));
    return commandResult(scope, made.row.status, made.row.version, made.row.id);
  }

  @Post('project-transfers/:id/decision')
  @HttpCode(200)
  @OperationId('decideProjectTransfer')
  @Command({ operation: 'decideProjectTransfer', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MdmDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.decide(scope.tx, {
      id: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      decision: body.decision,
      reason: body.reason,
      actor: scope.tenant.membershipId,
      now,
      scopes: { act: projectScope(access, PERMISSIONS.decideProjectTransfer, now), read: projectScope(access, READ_PERMISSION, now) },
    });
    await scope.audit(transferDecidedRecord(done));
    if (done.applied) {
      const record = transferAppliedRecord(done, scope.tenant.tenantId, scope.tenant.membershipId, now);
      await scope.audit(record.audit);
      await scope.emit(record.event);
    }
    // A project that changed unit is listed under its new unit: the pages of the project bank are read again.
    if (done.applied) scope.afterCommit(() => this.cache.invalidate(scope.tenant.tenantId));
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }
}
