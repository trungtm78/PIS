import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayProjectSettlementStore, TenantDatabase, projectScope } from '@machvon/db';
import type { SettlementChange } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { reaches, refsOf } from '../ctr/contract.controller';
import { settlementActionsOf, settlementView } from './project-settlement-view';
import type { SettlementPermissions } from './project-settlement-view';
import { PAY_METRICS } from './tokens';

const RESOURCE_TYPE = 'settlement_revision';
const CLASSIFICATION = 'CONFIDENTIAL';
const OPENED_EVENT = 'pay.settlement.opened.v1';
const SUBMITTED_EVENT = 'pay.settlement.submitted.v1';
const VERIFIED_EVENT = 'pay.settlement.verified.v1';
const RETURNED_EVENT = 'pay.settlement.returned.v1';
const CLOSED_EVENT = 'pay.settlement.closed.v1';

const READ_PERMISSION = PERMISSIONS.get_resources_settlement_revision;
const PERMISSIONS_OF_ACTIONS: SettlementPermissions = {
  open: PERMISSIONS.openSettlement,
  submit: PERMISSIONS.submitSettlement,
  verify: PERMISSIONS.recordSettlementVerification,
  exception: PERMISSIONS.approveSettlementException,
  close: PERMISSIONS.post_settlements_id_close,
  findings: 'aud.read',
};

/** The facts of a settlement every event and audit row carries: ids, the scope and the figures, never the words of a person. */
function factsOf(change: SettlementChange): Record<string, unknown> {
  const { view } = change;
  return {
    project_id: view.projectId,
    contract_id: view.contractId,
    settlement_scope: view.scope,
    fiscal_year: view.fiscalYear,
    revision: view.revision,
    from_status: change.fromStatus,
    to_status: view.status,
    settled_amount_vnd: view.settledAmountVnd,
    outstanding_vnd: view.outstandingVnd,
    unrecovered_advance_vnd: view.unrecoveredAdvanceVnd,
  };
}

async function record(scope: CommandScope, change: SettlementChange, action: string, now: Date, extra: { event?: string; reason?: string; facts?: Record<string, unknown> } = {}): Promise<CommandResult> {
  const { view } = change;
  const facts = { ...factsOf(change), ...(extra.facts ?? {}) };
  await scope.audit({ action, resourceType: RESOURCE_TYPE, resourceId: view.id, classification: CLASSIFICATION, ...(extra.reason === undefined ? {} : { reason: extra.reason }), diff: facts });
  if (extra.event !== undefined) {
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: view.id,
      aggregateVersion: view.version,
      type: extra.event,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, settlement_id: view.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${view.id}:${view.version}`,
    });
  }
  return commandResult(scope, view.status, view.version, view.id);
}

/**
 * The settlement of a project, of a year or of a contract (ST-PAY-009, PAY 3.5): opened with the figures of the ledgers, read again while it is a draft, sent with the verification deadline of the group of
 * the project, taken up and verified by someone other than who sent it, and closed by someone other than who prepared it; with something still owed it closes only on an exception that another person
 * approved, and the figures stay as they are (UAT-AC66). Each command acts inside the scope of its own permission over the project.
 */
@Controller()
export class ProjectSettlementController {
  private readonly store: PayProjectSettlementStore;

  constructor(@Optional() @Inject(PAY_METRICS) metrics?: MetricsSink) {
    this.store = new PayProjectSettlementStore(metrics ?? NOOP_METRICS);
  }

  @Post('settlements')
  @HttpCode(200)
  @OperationId('openSettlement')
  @Command({ operation: 'openSettlement' })
  async open(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PayOpenSettlement']): Promise<CommandResult> {
    const now = new Date();
    const change = await this.store.open(
      scope.tx,
      { projectId: body.project_id, contractId: body.contract_id, scope: body.settlement_scope, fiscalYear: body.fiscal_year },
      scope.tenant.membershipId,
      projectScope(access, PERMISSIONS.openSettlement, now),
    );
    return record(scope, change, 'settlement_revision.opened', now, { event: OPENED_EVENT });
  }

  @Post('settlements/:id/refresh')
  @HttpCode(200)
  @OperationId('refreshSettlementFigures')
  @Command({ operation: 'refreshSettlementFigures', versioned: true })
  async refresh(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PayRefreshSettlementFigures'],
  ): Promise<CommandResult> {
    const now = new Date();
    const change = await this.store.refresh(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.note, scope.tenant.membershipId, projectScope(access, PERMISSIONS.refreshSettlementFigures, now));
    return record(scope, change, 'settlement_revision.figures_refreshed', now, { ...(body.note === undefined ? {} : { reason: body.note.trim() }) });
  }

  @Post('settlements/:id/submit')
  @HttpCode(200)
  @OperationId('submitSettlement')
  @Command({ operation: 'submitSettlement', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PaySubmitSettlement']): Promise<CommandResult> {
    const now = new Date();
    const change = await this.store.submit(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { submittedOn: body.submitted_on }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.submitSettlement, now), now);
    const { view, deadline } = change;
    const facts = {
      project_group: view.projectGroup,
      submitted_on: view.submittedOn,
      verification_due_on: view.verificationDueOn,
      deadline_days: deadline?.days ?? view.deadlineDays,
      deadline_rule_version_id: view.deadlineRuleVersionId,
      deadline_rule_awaiting_confirmation: view.deadlineRuleAwaitingConfirmation,
    };
    return record(scope, change, 'settlement_revision.submitted', now, { event: SUBMITTED_EVENT, facts });
  }

  @Post('settlements/:id/verification')
  @HttpCode(200)
  @OperationId('recordSettlementVerification')
  @Command({ operation: 'recordSettlementVerification', versioned: true })
  async verify(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PayRecordSettlementVerification'],
  ): Promise<CommandResult> {
    const now = new Date();
    const change = await this.store.verify(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { outcome: body.outcome, findings: body.findings, auditFindingRefs: body.audit_finding_refs },
      scope.tenant.membershipId,
      projectScope(access, PERMISSIONS.recordSettlementVerification, now),
      now,
    );
    const { view } = change;
    // The words of the verifier stay in the audit row; the events carry identifiers and figures. Taking the file up is a step of the work, not an event for the other modules.
    const event = view.status === 'VERIFIED' ? VERIFIED_EVENT : view.status === 'RETURNED' ? RETURNED_EVENT : undefined;
    const facts = { outcome: view.status, verified_on: view.verifiedOn, verification_due_on: view.verificationDueOn, audit_finding_count: view.auditFindingRefs.length };
    return record(scope, change, `settlement_revision.verification_${view.status.toLowerCase()}`, now, { ...(event === undefined ? {} : { event }), reason: body.findings.trim(), facts });
  }

  @Post('settlements/:id/exception-approval')
  @HttpCode(200)
  @OperationId('approveSettlementException')
  @Command({ operation: 'approveSettlementException', versioned: true })
  async approveException(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PayApproveSettlementException'],
  ): Promise<CommandResult> {
    const now = new Date();
    const change = await this.store.approveException(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { reason: body.reason, approvalDocumentVersionId: body.approval_document_version_id },
      scope.tenant.membershipId,
      projectScope(access, PERMISSIONS.approveSettlementException, now),
      now,
    );
    return record(scope, change, 'settlement_revision.exception_approved', now, {
      reason: body.reason.trim(),
      facts: { exception_approval_document_version_id: change.view.exceptionApprovalDocumentVersionId },
    });
  }

  @Post('settlements/:id/close')
  @HttpCode(200)
  @OperationId('post_settlements_id_close')
  @Command({ operation: 'post_settlements_id_close', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PaySettlementClose']): Promise<CommandResult> {
    const now = new Date();
    const change = await this.store.close(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { decision: body.decision, reason: body.reason, evidenceIds: body.evidence_ids, decisionDocumentVersionId: body.decision_document_version_id },
      scope.tenant.membershipId,
      projectScope(access, PERMISSIONS.post_settlements_id_close, now),
      now,
    );
    const { view } = change;
    const facts = {
      decision_document_version_id: view.decisionDocumentVersionId,
      with_exception: view.exceptionApprovedAt !== null,
      exception_approved_by: view.exceptionApprovedBy,
      evidence_count: view.closeEvidenceIds.length,
    };
    return record(scope, change, 'settlement_revision.closed', now, { event: CLOSED_EVENT, reason: body.reason.trim(), facts });
  }
}

const idFilter = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** The settlements in the scope of the caller (the right to read them is `settlement_revision.read`). */
@Controller('resources/settlement_revision')
export class ProjectSettlementReadsController {
  private readonly store = new PayProjectSettlementStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_settlement_revision')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('status') status?: unknown,
    @Query('project_id') projectId?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const project = idFilter(projectId, 'project_id');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.store.list(tx, projectScope(access, READ_PERMISSION, now), { status, projectId: project, limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => settlementView(row, settlementActionsOf(row, access, now, PERMISSIONS_OF_ACTIONS, tenant.membershipId), reaches(access, PERMISSIONS_OF_ACTIONS.findings, refsOf(row.reach, row.reach.projectId), now))),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_settlement_revision_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.store.find(tx, projectScope(access, READ_PERMISSION, now), id));
    // A settlement in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return settlementView(found, settlementActionsOf(found, access, now, PERMISSIONS_OF_ACTIONS, tenant.membershipId), reaches(access, PERMISSIONS_OF_ACTIONS.findings, refsOf(found.reach, found.reach.projectId), now));
  }
}
