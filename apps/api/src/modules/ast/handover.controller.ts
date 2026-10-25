import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AstHandoverStore, BidContractorStore, TenantDatabase, contractScope, handoverScope } from '@machvon/db';
import type { AstHandoverResult, ContractScopes, HandoverScopes } from '@machvon/db';
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
import { handoverAllowed, handoverView, punchAllowed, punchView, traceView } from './handover-view';
import type { CallerFacts, HandoverPermissions } from './handover-view';

const MANAGE_PERMISSION = PERMISSIONS.createHandover;
const RESPOND_PERMISSION = PERMISSIONS.markPunchItemFixed;
const VERIFY_PERMISSION = PERMISSIONS.verifyPunchItem;
const WAIVE_PERMISSION = PERMISSIONS.waivePunchItem;
const APPROVE_PERMISSION = PERMISSIONS.post_handovers_id_decision;
const READ_PERMISSION = PERMISSIONS.getHandoverTrace;
const RESOURCE_TYPE = 'handover';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: HandoverPermissions = { manage: MANAGE_PERMISSION, respond: RESPOND_PERMISSION, verify: VERIFY_PERMISSION, waive: WAIVE_PERMISSION, approve: APPROVE_PERMISSION };

const contractScopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({
  update: contractScope(access, permission, now),
  read: contractScope(access, READ_PERMISSION, now),
});
const scopesFor = (access: EffectiveAccess, permission: string, now: Date): HandoverScopes => ({ update: handoverScope(access, permission, now), read: handoverScope(access, READ_PERMISSION, now) });

/**
 * The handover of a work to the unit that receives it, and the punch list of what is still wrong with it (ST-AST-001, AST 3.1, BR-AST-01). The project office drafts the handover on the
 * approved completion minutes and puts the defects on a list with a severity, a day and the contractor that answers for each; the contractor says an item is put right with evidence; somebody
 * else verifies it or reopens it (403 `SELF_APPROVAL_DENIED`); an item that is not critical may be waived with a reason, a critical one never (422 `CRITICAL_CANNOT_BE_WAIVED`). The receiving
 * unit accepts the handover only when no critical item is open (422 `OPEN_CRITICAL_PUNCH`) and the as-built dossier is given (422 `AS_BUILT_REQUIRED`), and not when it drew the handover up.
 */
@Controller()
export class HandoverController {
  private readonly handovers = new AstHandoverStore();

  @Post('handovers')
  @HttpCode(200)
  @OperationId('createHandover')
  @Command({ operation: 'createHandover' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AstCreateHandover']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.handovers.create(
      scope.tx,
      {
        projectId: body.project_id,
        contractId: body.contract_id,
        recipientUnitId: body.recipient_unit_id,
        handoverKind: body.handover_kind,
        handoverNo: body.handover_no,
        qualityAcceptanceId: body.quality_acceptance_id,
        plannedOn: body.planned_on,
        documentVersionId: body.document_version_id,
      },
      scope.tenant.membershipId,
      contractScopesFor(access, MANAGE_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'handover.drafted', 'ast.handover.drafted.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('handovers/:id/punch-items')
  @HttpCode(200)
  @OperationId('addPunchItem')
  @Command({ operation: 'addPunchItem', versioned: true })
  async add(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstAddPunchItem']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.handovers.addItem(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        description: body.description,
        severity: body.severity,
        locationText: body.location_text,
        responsibleContractorId: body.responsible_contractor_id,
        dueOn: body.due_on,
        evidencePhotoId: body.evidence_photo_id,
      },
      scope.tenant.membershipId,
      scopesFor(access, MANAGE_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'punch_item.added', 'ast.punch_item.added.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('punch-items/:id/fixed')
  @HttpCode(200)
  @OperationId('markPunchItemFixed')
  @Command({ operation: 'markPunchItemFixed' })
  async fixed(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstMarkPunchItemFixed']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.handovers.markFixed(
      scope.tx,
      id.toLowerCase(),
      { evidencePhotoId: body.evidence_photo_id, evidenceDocumentVersionId: body.evidence_document_version_id, note: body.note },
      scope.tenant.membershipId,
      scopesFor(access, RESPOND_PERMISSION, now),
    );
    await this.written(scope, done, 'punch_item.fixed', 'ast.punch_item.fixed.v1', now);
    return this.itemResult(scope, done);
  }

  @Post('punch-items/:id/verify')
  @HttpCode(200)
  @OperationId('verifyPunchItem')
  @Command({ operation: 'verifyPunchItem' })
  async verify(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstVerifyPunchItem']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.handovers.verify(scope.tx, id.toLowerCase(), { outcome: body.outcome, note: body.note }, scope.tenant.membershipId, scopesFor(access, VERIFY_PERMISSION, now), now);
    await this.written(scope, done, 'punch_item.verified', 'ast.punch_item.verified.v1', now, body.note);
    return this.itemResult(scope, done);
  }

  @Post('punch-items/:id/waive')
  @HttpCode(200)
  @OperationId('waivePunchItem')
  @Command({ operation: 'waivePunchItem' })
  async waive(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstWaivePunchItem']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.handovers.waive(scope.tx, id.toLowerCase(), { waiverReason: body.waiver_reason }, scope.tenant.membershipId, scopesFor(access, WAIVE_PERMISSION, now));
    await this.written(scope, done, 'punch_item.waived', 'ast.punch_item.waived.v1', now, body.waiver_reason);
    return this.itemResult(scope, done);
  }

  @Post('handovers/:id/decision')
  @HttpCode(200)
  @OperationId('post_handovers_id_decision')
  @Command({ operation: 'post_handovers_id_decision', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstHandoverDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.handovers.decide(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        decision: body.decision,
        reason: body.reason,
        evidenceIds: body.evidence_ids,
        asBuiltDocumentVersionId: body.as_built_document_version_id,
        omManualDocumentVersionId: body.om_manual_document_version_id,
        warrantyCertificateDocumentVersionId: body.warranty_certificate_document_version_id,
      },
      scope.tenant.membershipId,
      scopesFor(access, APPROVE_PERMISSION, now),
      now,
    );
    // Only an acceptance is told to the other modules; a handover that is given back or rejected leaves its audit row.
    const action = done.decision === 'approve' ? 'handover.accepted' : done.decision === 'reject' ? 'handover.rejected' : 'handover.returned';
    await this.written(scope, done, action, done.decision === 'approve' ? 'ast.handover.accepted.v1' : undefined, now, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** What a command on an item answers: the item the command was about is the resource, the handover is in the audit row and the event. */
  private itemResult(scope: CommandScope, done: AstHandoverResult): CommandResult {
    if (done.item === null) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return commandResult(scope, done.item.status, done.version, done.item.id);
  }

  /** The audit row and the event of a command: ids, codes, statuses and counts, never the words of a note beyond the audit row that keeps the reason. */
  private async written(scope: CommandScope, done: AstHandoverResult, action: string, type: string | undefined, now: Date, reason?: string): Promise<void> {
    const facts = {
      handover_no: done.handoverNo,
      handover_kind: done.handoverKind,
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      recipient_unit_id: done.recipientUnitId,
      open_critical_punch_count: done.openCriticalPunchCount,
      punch_item_id: done.item?.id ?? null,
      punch_item_no: done.item?.itemNo ?? null,
      punch_item_severity: done.item?.severity ?? null,
      punch_item_status: done.item?.status ?? null,
      decision: done.decision,
    };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
    });
    if (type === undefined) return;
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        handover_id: done.id,
        ...facts,
        status: done.status,
        from_status: done.fromStatus,
        version: done.version,
        ...(done.decision === 'approve' ? { accepted_at: now.toISOString() } : {}),
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}

const idFilter = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** The handovers in the scope of the caller (the right to read them is `handover.read`; a guest contractor holds it over its own contract) and the trace of one. */
@Controller()
export class HandoverReadsController {
  private readonly handovers = new AstHandoverStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private async caller(tenant: TenantContext, tx: Parameters<BidContractorStore['callerOf']>[0]): Promise<CallerFacts> {
    const standing = await this.contractors.callerOf(tx, tenant.membershipId);
    return { membershipId: tenant.membershipId, contractorId: standing.guest ? standing.contractorId : undefined };
  }

  @Get('resources/handover')
  @OperationId('get_resources_handover')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('status') status?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const filter = { contractId: idFilter(contractId, 'contract_id'), status, limit: request.limit + 1, after: request.after };
    const now = new Date();
    const { rows, caller } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.handovers.list(tx, handoverScope(access, READ_PERMISSION, now), filter),
      caller: await this.caller(tenant, tx),
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => handoverView(line, handoverAllowed(line, access, now, caller, ACTION_PERMISSIONS))),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get('resources/handover/:id')
  @OperationId('get_resources_handover_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const { line, caller } = await this.database.withTenant(tenant, async (tx) => ({
      line: await this.handovers.find(tx, id.toLowerCase(), handoverScope(access, READ_PERMISSION, now)),
      caller: await this.caller(tenant, tx),
    }));
    // A handover in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return handoverView(line, handoverAllowed(line, access, now, caller, ACTION_PERMISSIONS));
  }

  @Get('handovers/:id/trace')
  @OperationId('getHandoverTrace')
  async trace(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const { found, caller } = await this.database.withTenant(tenant, async (tx) => ({
      found: await this.handovers.trace(tx, id.toLowerCase(), handoverScope(access, READ_PERMISSION, now)),
      caller: await this.caller(tenant, tx),
    }));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const items = found.items.map((item) => punchView(item, punchAllowed(found.handover, item, access, now, caller, ACTION_PERMISSIONS)));
    return traceView(found, handoverAllowed(found.handover, access, now, caller, ACTION_PERMISSIONS), items, now);
  }
}
