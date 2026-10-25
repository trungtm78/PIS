import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapAllocationExtensionStore, TenantDatabase } from '@machvon/db';
import type { ExtensionApplied, ExtensionFilter, ExtensionRow, ExtensionStatus } from '@machvon/db';
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
import { unitAuthorizer } from './plan-approval.service';

const RESOURCE_TYPE = 'allocation_extension';
export const ALLOCATION_EXTENDED_EVENT = 'capital.allocation_extended.v1';
const STATUSES: readonly string[] = ['REQUESTED', 'APPROVED', 'APPLIED', 'REJECTED', 'LAPSED'];

export function extensionView(row: ExtensionRow): Schemas['AllocationExtension'] {
  return {
    id: row.id,
    allocation_line_id: row.allocationLineId,
    project_id: row.projectId,
    from_plan_year: row.fromPlanYear,
    extended_to: row.extendedTo,
    amount_vnd: row.amountVnd,
    reason_code: row.reasonCode as Schemas['AllocationExtension']['reason_code'],
    ...(row.justification === null ? {} : { justification: row.justification }),
    ...(row.approvingDocumentId === null ? {} : { approving_document_id: row.approvingDocumentId }),
    status: row.status,
    ...(row.newAllocationLineId === null ? {} : { new_allocation_line_id: row.newAllocationLineId }),
    ...(row.newAppropriationId === null ? {} : { new_appropriation_id: row.newAppropriationId }),
    requested_by: row.createdBy,
    ...(row.decidedBy === null ? {} : { decided_by: row.decidedBy }),
    ...(row.decidedAt === null ? {} : { decided_at: row.decidedAt }),
    ...(row.decisionReason === null ? {} : { decision_reason: row.decisionReason }),
    version: row.version,
  };
}

/** The event that tells the other modules capital was carried over to the next year: the plans, the disbursement snapshots and the home screens read it. */
function extendedEvent(scope: CommandScope, row: ExtensionRow, applied: ExtensionApplied, occurredAt: Date) {
  return {
    aggregateType: RESOURCE_TYPE,
    aggregateId: row.id,
    aggregateVersion: row.version,
    type: ALLOCATION_EXTENDED_EVENT,
    schemaVersion: 1,
    payload: {
      tenant_id: scope.tenant.tenantId,
      extension_id: row.id,
      version: row.version,
      actor_id: scope.tenant.membershipId,
      occurred_at: occurredAt.toISOString(),
      project_id: row.projectId,
      allocation_line_id: row.allocationLineId,
      new_allocation_line_id: applied.newAllocationLineId,
      new_appropriation_id: applied.newAppropriationId,
      from_plan_year: row.fromPlanYear,
      to_plan_year: applied.toPlanYear,
      amount_vnd: row.amountVnd,
      extended_to: row.extendedTo,
      approving_document_id: row.approvingDocumentId,
    },
    eventKey: `${RESOURCE_TYPE}:${row.id}:applied`,
  };
}

/**
 * The extension of the disbursement of capital to the next year (ST-CAP-007, CAP 3.1 F6, CAP-20): a planner asks to carry the undisbursed part of a line of the plan over to the next
 * year, and an approver who is not that planner decides it with the document that allows it. Approving applies it in the same transaction: the line of the plan year gives up the
 * capital and a line of bucket CARRYOVER, `is_extended` and with the source year and the last day of disbursement, takes it in the plan of the next year, with two ledger entries of
 * one extension. Each command is judged for the unit of the plan the line belongs to, as the plan commands are.
 */
@Controller()
export class AllocationExtensionController {
  private readonly extensions = new CapAllocationExtensionStore();

  @Post('allocation-lines/:id/extensions')
  @HttpCode(200)
  @OperationId('requestAllocationExtension')
  @Command({ operation: 'requestAllocationExtension', ttl: 'extended' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CapExtensionRequest']): Promise<CommandResult> {
    const row = await this.extensions.request(
      scope.tx,
      { allocationLineId: id, amountVnd: body.amount_vnd, extendedTo: body.extended_to, reasonCode: body.reason_code, justification: body.justification, requestedBy: scope.tenant.membershipId },
      unitAuthorizer(access, PERMISSIONS.requestAllocationExtension, new Date()),
    );
    await scope.audit({
      action: 'capital.allocation_extension_requested',
      resourceType: RESOURCE_TYPE,
      resourceId: row.id,
      reason: row.justification ?? undefined,
      diff: { allocation_line_id: row.allocationLineId, project_id: row.projectId, from_plan_year: row.fromPlanYear, extended_to: row.extendedTo, amount_vnd: row.amountVnd, reason_code: row.reasonCode },
    });
    return commandResult(scope, row.status, row.version, row.id);
  }

  @Post('allocation-extensions/:id/decision')
  @HttpCode(200)
  @OperationId('decideAllocationExtension')
  @Command({ operation: 'decideAllocationExtension', versioned: true, ttl: 'extended' })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CapExtensionDecision']): Promise<CommandResult> {
    const now = new Date();
    const approvingDocumentId = body.approving_document_id === undefined ? undefined : (asUuid(body.approving_document_id) ?? body.approving_document_id);
    const { row, applied } = await this.extensions.decide(
      scope.tx,
      { extensionId: id, decision: body.decision, decidedBy: scope.tenant.membershipId, reason: body.reason, approvingDocumentId, expectedVersion: scope.expectedVersion ?? 0 },
      unitAuthorizer(access, PERMISSIONS.decideAllocationExtension, now),
    );
    await scope.audit({
      action: applied === undefined ? 'capital.allocation_extension_rejected' : 'capital.allocation_extension_applied',
      resourceType: RESOURCE_TYPE,
      resourceId: row.id,
      reason: body.reason,
      diff: {
        decision: body.decision,
        status: row.status,
        allocation_line_id: row.allocationLineId,
        project_id: row.projectId,
        amount_vnd: row.amountVnd,
        approving_document_id: row.approvingDocumentId,
        new_allocation_line_id: row.newAllocationLineId,
        new_appropriation_id: row.newAppropriationId,
        revised_appropriation: applied?.revisedAppropriation ?? false,
        ledger_entry_ids: applied === undefined ? [] : [applied.extendOutEntryId, applied.extendInEntryId],
      },
    });
    if (applied !== undefined) await scope.emit(extendedEvent(scope, row, applied, now));
    return commandResult(scope, row.status, row.version, row.id);
  }
}

function filterOf(status: unknown, allocationLineId: unknown): ExtensionFilter {
  if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  const line = allocationLineId === undefined ? undefined : typeof allocationLineId === 'string' ? asUuid(allocationLineId) : undefined;
  if (allocationLineId !== undefined && line === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'allocation_line_id');
  return { status: status as ExtensionStatus | undefined, allocationLineId: line };
}

/** The requests to carry capital over of the tenant, the latest first (CAP-20). */
@Controller()
export class AllocationExtensionReadsController {
  private readonly extensions = new CapAllocationExtensionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('allocation-extensions')
  @OperationId('listAllocationExtensions')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('status') status?: unknown,
    @Query('allocation_line_id') allocationLineId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Schemas['AllocationExtensionPage']> {
    const request = parsePageRequest(limit, cursor);
    const filter = filterOf(status, allocationLineId);
    const rows = await this.database.withTenant(tenant, (tx) => this.extensions.list(tx, filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(extensionView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null };
  }
}
