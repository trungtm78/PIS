import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { SodStore, TenantDatabase } from '@machvon/db';
import type { SodApprovalRow, SodExceptionRow, SodMatrixReading, SodUseRow } from '@machvon/db';
import { DomainError, SOD_ACTIONS, SOD_EXPIRING_WITHIN_DAYS, asUuid, isSodScope, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, SodExceptionView, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from './tenant-authority';

const READ_PERMISSION = PERMISSIONS.getSodMatrix;
const REQUEST_PERMISSION = PERMISSIONS.requestSodException;
const APPROVE_PERMISSION = PERMISSIONS.approveSodException;
const REVOKE_PERMISSION = PERMISSIONS.revokeSodException;
const AUDIT_PERMISSION = PERMISSIONS.listSodAuditExceptions;
const RESOURCE_TYPE = 'sod_exception';

/** The matrix and its exceptions belong to the whole tenant (no organisation unit owns the duties of a person), so only a grant on the whole tenant reaches them. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

const STATUSES: readonly string[] = ['REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED'];
const OUTCOMES: readonly string[] = ['EXCEPTION_USED', 'WARNED', 'BLOCKED'];

function statusOf(value: unknown): SodExceptionView | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !STATUSES.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  return value as SodExceptionView;
}

function outcomeOf(value: unknown): SodUseRow['outcome'] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !OUTCOMES.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'outcome');
  return value as SodUseRow['outcome'];
}

function uuidOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
}

const exceptionView = (row: SodExceptionRow): Record<string, unknown> => ({
  id: row.id,
  action_a: row.actionA,
  action_b: row.actionB,
  scope: row.scope,
  subject_id: row.subjectId,
  member_id: row.memberId,
  member_name: row.memberName,
  requested_by: row.requestedBy,
  requested_by_name: row.requestedByName,
  reason: row.reason,
  valid_from: row.validFrom,
  valid_to: row.validTo,
  rule_version: row.ruleVersion,
  approvers_needed: row.approversNeeded,
  approvals: row.approvals,
  status: row.view,
  stored_status: row.status,
  decided_at: row.decidedAt,
  revoked_by: row.revokedBy,
  revoked_at: row.revokedAt,
  revoke_reason: row.revokeReason,
  uses: row.uses,
  created_at: row.createdAt,
  version: row.version,
});

const approvalView = (row: SodApprovalRow): Record<string, unknown> => ({ approver_id: row.approverId, approver_name: row.approverName, decision: row.decision, comment: row.comment, decided_at: row.decidedAt });

const useView = (row: SodUseRow): Record<string, unknown> => ({
  id: row.id,
  outcome: row.outcome,
  exception_id: row.exceptionId,
  action_a: row.actionA,
  action_b: row.actionB,
  scope: row.scope,
  subject_id: row.subjectId,
  member_id: row.memberId,
  member_name: row.memberName,
  taking: row.taking,
  command: row.command,
  record_id: row.recordId,
  rule_version: row.ruleVersion,
  used_at: row.usedAt,
});

function matrixView(reading: SodMatrixReading, today: string): Record<string, unknown> {
  return {
    as_of: today,
    rule_version: reading.version,
    source: reading.source,
    unverified: reading.unverified,
    exception_approvers: reading.approversNeeded,
    formula: reading.formula,
    source_text: reading.sourceText,
    rule_as_of: reading.asOf,
    actions: SOD_ACTIONS.map((action) => ({ code: action.code, module: action.module, label: action.label })),
    conflicts: reading.matrix.conflicts.map((conflict) => ({ ...conflict })),
  };
}

/**
 * Exceptions to the separation of duties (G4-1, ADM 3.6). A person asks to hold both duties of a pair of the matrix on one record, project, contract or package for a few days, with a reason; two other people (neither the one who asked
 * nor the one it covers, and the matrix may ask for a third) approve it, and it then excuses the commands of that person for that pair until its last day. Every approval, rejection and revocation is audited and sent as an event.
 */
@Controller()
export class SodExceptionsController {
  private readonly store = new SodStore();

  @Post('sod-exceptions')
  @HttpCode(200)
  @OperationId('requestSodException')
  @Command({ operation: 'requestSodException' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['SodExceptionRequest']): Promise<CommandResult> {
    assertHolds(access, REQUEST_PERMISSION);
    if (!isSodScope(body.scope)) throw new DomainError('VALIDATION_FAILED', 422, 'scope');
    const now = new Date();
    const today = vietnamDateOf(now);
    const made = await this.store.request(
      scope.tx,
      { actionA: body.action_a, actionB: body.action_b, scope: body.scope, subjectId: body.subject_id.toLowerCase(), memberId: body.member_id.toLowerCase(), reason: body.reason, validFrom: body.valid_from, validTo: body.valid_to },
      scope.tenant.membershipId,
      today,
    );
    const facts = { action_a: body.action_a, action_b: body.action_b, scope: body.scope, subject_id: body.subject_id, member_id: body.member_id, valid_from: body.valid_from, valid_to: body.valid_to };
    await scope.audit({ action: 'sod_exception.requested', resourceType: RESOURCE_TYPE, resourceId: made.id, reason: body.reason.trim(), classification: 'INTERNAL', diff: facts });
    await this.emit(scope, made.id, made.version, 'requested', { ...facts, requested_by: scope.tenant.membershipId }, now);
    return commandResult(scope, 'REQUESTED', made.version, made.id);
  }

  @Post('sod-exceptions/:id/approve')
  @HttpCode(200)
  @OperationId('approveSodException')
  @Command({ operation: 'approveSodException', versioned: true })
  async approve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['SodExceptionApprove']): Promise<CommandResult> {
    assertHolds(access, APPROVE_PERMISSION);
    const now = new Date();
    const done = await this.store.approve(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, body.comment?.trim(), vietnamDateOf(now));
    await scope.audit({ action: 'sod_exception.approved', resourceType: RESOURCE_TYPE, resourceId: id.toLowerCase(), classification: 'INTERNAL', diff: { status: done.status, approvals: done.approvals, member_id: done.memberId }, ...(body.comment === undefined ? {} : { reason: body.comment.trim() }) });
    await this.emit(scope, id.toLowerCase(), done.version, done.status === 'APPROVED' ? 'approved' : 'approval_recorded', { status: done.status, approvals: done.approvals, member_id: done.memberId, approved_by: scope.tenant.membershipId }, now);
    return commandResult(scope, done.status, done.version, id.toLowerCase());
  }

  @Post('sod-exceptions/:id/reject')
  @HttpCode(200)
  @OperationId('rejectSodException')
  @Command({ operation: 'rejectSodException', versioned: true })
  async reject(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['SodExceptionReject']): Promise<CommandResult> {
    assertHolds(access, APPROVE_PERMISSION);
    const now = new Date();
    const done = await this.store.reject(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, body.reason.trim());
    await scope.audit({ action: 'sod_exception.rejected', resourceType: RESOURCE_TYPE, resourceId: id.toLowerCase(), reason: body.reason.trim(), classification: 'INTERNAL', diff: { member_id: done.memberId } });
    await this.emit(scope, id.toLowerCase(), done.version, 'rejected', { member_id: done.memberId, rejected_by: scope.tenant.membershipId }, now);
    return commandResult(scope, 'REJECTED', done.version, id.toLowerCase());
  }

  @Post('sod-exceptions/:id/revoke')
  @HttpCode(200)
  @OperationId('revokeSodException')
  @Command({ operation: 'revokeSodException', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['SodExceptionRevoke']): Promise<CommandResult> {
    assertHolds(access, REVOKE_PERMISSION);
    const now = new Date();
    const done = await this.store.revoke(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, body.reason);
    await scope.audit({ action: 'sod_exception.revoked', resourceType: RESOURCE_TYPE, resourceId: id.toLowerCase(), reason: body.reason.trim(), classification: 'INTERNAL', diff: { member_id: done.memberId } });
    await this.emit(scope, id.toLowerCase(), done.version, 'revoked', { member_id: done.memberId, revoked_by: scope.tenant.membershipId }, now);
    return commandResult(scope, 'REVOKED', done.version, id.toLowerCase());
  }

  private async emit(scope: CommandScope, id: string, version: number, what: string, facts: Record<string, unknown>, now: Date): Promise<void> {
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: version,
      type: `adm.sod_exception.${what}.v1`,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, exception_id: id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${id}:${version}`,
    });
  }
}

/** The matrix in force and the register of its exceptions (ADM). */
@Controller()
export class SodReadsController {
  private readonly store = new SodStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('sod-matrix')
  @OperationId('getSodMatrix')
  async matrix(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertHolds(access, READ_PERMISSION);
    const today = vietnamDateOf(new Date());
    const reading = await this.database.withTenant(tenant, (tx) => this.store.matrix(tx, today));
    const live = await this.database.withTenant(tenant, (tx) => this.store.expiring(tx, today, SOD_EXPIRING_WITHIN_DAYS));
    return { ...matrixView(reading, today), expiring_exceptions: live.length };
  }

  @Get('sod-exceptions')
  @OperationId('listSodExceptions')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('member_id') memberId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { status: statusOf(status), memberId: uuidOf(memberId, 'member_id') };
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) return { items: [], next_cursor: null, as_of: today };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { ...filter, limit: request.limit + 1, after: request.after }, today));
    return page(rows, request.limit, exceptionView, (row) => row.key, today);
  }

  @Get('sod-exceptions/:id')
  @OperationId('getSodException')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const today = vietnamDateOf(new Date());
    const found = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id.toLowerCase(), today));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...exceptionView(found.exception), decisions: found.approvals.map(approvalView), as_of: today };
  }
}

/** What the auditor reads: the exceptions with the number of times each was used, and every use, warning and refusal (AUD). */
@Controller()
export class SodAuditReadsController {
  private readonly store = new SodStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('audit-sod/exceptions')
  @OperationId('listSodAuditExceptions')
  async exceptions(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('member_id') memberId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { status: statusOf(status), memberId: uuidOf(memberId, 'member_id') };
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, AUDIT_PERMISSION)) return { items: [], next_cursor: null, as_of: today };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { ...filter, limit: request.limit + 1, after: request.after }, today));
    return page(rows, request.limit, exceptionView, (row) => row.key, today);
  }

  @Get('audit-sod/uses')
  @OperationId('listSodAuditUses')
  async uses(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('outcome') outcome?: unknown,
    @Query('member_id') memberId?: unknown,
    @Query('exception_id') exceptionId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { outcome: outcomeOf(outcome), memberId: uuidOf(memberId, 'member_id'), exceptionId: uuidOf(exceptionId, 'exception_id') };
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, AUDIT_PERMISSION)) return { items: [], next_cursor: null, as_of: today };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listUses(tx, { ...filter, limit: request.limit + 1, after: request.after }));
    return page(rows, request.limit, useView, (row) => row.key, today);
  }
}

function page<T extends { id: string }>(rows: T[], limit: number, view: (row: T) => Record<string, unknown>, keyOf: (row: T) => string, today: string): { items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string } {
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { items: shown.map(view), next_cursor: rows.length > limit && last !== undefined ? encodeCursor({ code: keyOf(last), id: last.id }) : null, as_of: today };
}
