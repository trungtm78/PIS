import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayReconciliationStore, PayTreasuryTracking, TenantDatabase, projectScope } from '@machvon/db';
import type { ReconciliationChange } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { reconciliationItemView, trackingView } from './reconciliation-view';
import { PAY_METRICS } from './tokens';

const RESOURCE_TYPE = 'reconciliation_item';
const CLASSIFICATION = 'CONFIDENTIAL';
const ASSIGNED_EVENT = 'pay.reconciliation.assigned.v1';
const RESOLVED_EVENT = 'pay.reconciliation.resolved.v1';

type CommandAnswer = Schemas['PayReconciliationCommandResult'];

function answer(scope: CommandScope, change: ReconciliationChange): CommandAnswer {
  const { view } = change;
  return { ...commandResult(scope, view.status, view.version, view.id), resource_id: view.id, owner_membership_id: view.ownerMembershipId, due_at: view.dueAt, difference_vnd: view.differenceVnd };
}

/**
 * The work on an item of difference (ST-PAY-007, PAY 3.3 step 5): giving it to an owner with the day it is due, and explaining it, resolving it or writing it off. The two figures an item was opened with
 * are never touched; a write-off asks for the document that approves it and for someone other than the owner.
 */
@Controller()
export class ReconciliationController {
  private readonly store: PayReconciliationStore;

  constructor(@Optional() @Inject(PAY_METRICS) metrics?: MetricsSink) {
    this.store = new PayReconciliationStore(metrics ?? NOOP_METRICS);
  }

  @Post('reconciliation-items/:id/assign')
  @HttpCode(200)
  @OperationId('assignReconciliationItem')
  @Command({ operation: 'assignReconciliationItem', versioned: true })
  async assign(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PayAssignReconciliationItem'],
  ): Promise<CommandAnswer> {
    const now = new Date();
    const change = await this.store.assign(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { ownerMembershipId: body.owner_membership_id, dueAt: body.due_at },
      scope.tenant.membershipId,
      projectScope(access, PERMISSIONS.assignReconciliationItem, now),
      now,
    );
    const { view } = change;
    const facts = { project_id: view.projectId, kind: view.kind, status: view.status, owner_membership_id: view.ownerMembershipId, due_at: view.dueAt, difference_vnd: view.differenceVnd };
    await scope.audit({ action: 'reconciliation_item.assigned', resourceType: RESOURCE_TYPE, resourceId: view.id, classification: CLASSIFICATION, diff: { ...facts, from_owner_membership_id: change.fromOwnerMembershipId } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: view.id,
      aggregateVersion: view.version,
      type: ASSIGNED_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, reconciliation_item_id: view.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${view.id}:${view.version}`,
    });
    return answer(scope, change);
  }

  @Post('reconciliation-items/:id/resolve')
  @HttpCode(200)
  @OperationId('resolveReconciliationItem')
  @Command({ operation: 'resolveReconciliationItem', versioned: true })
  async resolve(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PayResolveReconciliationItem'],
  ): Promise<CommandAnswer> {
    const now = new Date();
    const change = await this.store.resolve(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { resolution: body.resolution, note: body.note, approvalDocumentVersionId: body.approval_document_version_id },
      scope.tenant.membershipId,
      projectScope(access, PERMISSIONS.resolveReconciliationItem, now),
      now,
    );
    const { view } = change;
    const facts = {
      project_id: view.projectId,
      kind: view.kind,
      from_status: change.fromStatus,
      to_status: view.status,
      resolution: body.resolution,
      owner_membership_id: view.ownerMembershipId,
      internal_amount_vnd: view.internalAmountVnd,
      confirmed_amount_vnd: view.confirmedAmountVnd,
      difference_vnd: view.differenceVnd,
      approval_document_version_id: view.approvalDocumentVersionId,
    };
    // The words of the person stay in the audit row; the event carries identifiers and figures.
    await scope.audit({ action: 'reconciliation_item.resolved', resourceType: RESOURCE_TYPE, resourceId: view.id, classification: CLASSIFICATION, reason: view.resolutionNote ?? undefined, diff: facts });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: view.id,
      aggregateVersion: view.version,
      type: RESOLVED_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, reconciliation_item_id: view.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${view.id}:${view.version}`,
    });
    return answer(scope, change);
  }
}

const idFilter = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** The items of difference (`reconciliation.read`) and where each project stands with the Treasury (`treasury_transaction.read`). */
@Controller()
export class ReconciliationReadsController {
  private readonly store = new PayReconciliationStore();
  private readonly tracking = new PayTreasuryTracking();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('reconciliation-items')
  @OperationId('listReconciliationItems')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('status') status?: unknown,
    @Query('owner_membership_id') owner?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string; summary: Record<string, unknown> }> {
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const ownerId = idFilter(owner, 'owner_membership_id');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const scope = projectScope(access, PERMISSIONS.listReconciliationItems, now);
    const { rows, summary } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.store.list(tx, scope, { status, ownerMembershipId: ownerId, limit: request.limit + 1, after: request.after }, now),
      summary: await this.store.summary(tx, scope, now),
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(reconciliationItemView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.dueAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
      summary: { waiting: summary.waiting, overdue: summary.overdue, waiting_difference_vnd: summary.waitingDifferenceVnd },
    };
  }

  @Get('reconciliation-items/:id')
  @OperationId('getReconciliationItem')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.store.find(tx, projectScope(access, PERMISSIONS.getReconciliationItem, now), id, now));
    // An item in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return reconciliationItemView(found);
  }

  @Get('treasury-tracking')
  @OperationId('getTreasuryTracking')
  async track(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.tracking.list(tx, projectScope(access, PERMISSIONS.getTreasuryTracking, now), { limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(trackingView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.projectCode, id: last.projectId }) : null,
      as_of: now.toISOString(),
    };
  }
}
