import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ActingStore, DelegationStore, TenantDatabase, loadAccessIn } from '@machvon/db';
import type { ActingRecord } from '@machvon/db';
import { DomainError, activeGrants, assertActingApprover, assertActingParties, assertValidActingRequest, normalisePeriodCodes, permissionCovered } from '@machvon/kernel';
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
import { holdsOnWholeTenant } from './tenant-authority';

const APPROVE_PERMISSION = 'iam.acting.approve';
const READ_PERMISSION = 'iam.acting.read';
const TYPE = 'acting_grant';
const STATUSES: readonly string[] = ['Pending', 'Approved', 'Rejected', 'Cancelled', 'Revoked'];
const ROLES: readonly string[] = ['requested', 'subject'];

function oneOf(list: readonly string[], value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !list.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

const party = (id: string | null, name: string | null): { id: string; name: string | null } | null => (id === null ? null : { id, name });

function view(row: ActingRecord, membershipId: string, mayRunAll: boolean): Record<string, unknown> {
  return {
    id: row.id,
    requester: party(row.requesterId, row.requesterName),
    subject: party(row.subjectId, row.subjectName),
    permissions: row.permissions,
    period_codes: row.periodCodes,
    hours: row.hours,
    reason: row.reason,
    status: row.status,
    phase: row.phase,
    requested_at: row.requestedAt,
    decided_by: party(row.decidedBy, row.decidedByName),
    decided_at: row.decidedAt,
    decision_reason: row.decisionReason,
    window_start: row.windowStart,
    window_end: row.windowEnd,
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
    version: row.version,
    // The server judges again: this only says whether the screen should offer it.
    actions: {
      decide: row.phase === 'PENDING' && mayRunAll && row.requesterId !== membershipId && row.subjectId !== membershipId,
      cancel: row.phase === 'PENDING' && row.requesterId === membershipId,
      revoke: row.phase === 'ACTIVE' && (row.requesterId === membershipId || mayRunAll),
    },
  };
}

/**
 * An administrator acting on behalf of a person (IAM-2, ADM-26). The administrator asks, naming the person, the few permissions of theirs they need (data entry only: never a decision, a signature or the administration of
 * access) and a reason; a second person, who is neither of the two (by the person, not the membership), approves; from the approval the request is a grant that works for the hours asked (at most 8), and ends by the
 * clock or when it is revoked. While it works the administrator sends its id in the header `X-Acting-As`; the door of the API then judges the request on the access of the person, narrowed to the listed permissions, and
 * every audit row of the request names both identities (the administrator is the actor, the person is `on_behalf_of_id`). The grant is read again on every request, so the end of the window or a revocation takes effect at once.
 */
@Controller()
export class ActingCommandsController {
  private readonly store = new ActingStore();
  private readonly delegations = new DelegationStore();

  @Post('acting-requests')
  @HttpCode(201)
  @OperationId('requestActing')
  @Command({ operation: 'requestActing' })
  async request(@Scope() scope: CommandScope, @Body() body: Schemas['ActingRequestCreate']): Promise<CommandResult> {
    const now = new Date();
    const requester = scope.tenant.membershipId;
    const subject = body.subject_membership_id.toLowerCase();
    const periodCodes = body.period_codes === undefined ? undefined : normalisePeriodCodes(body.period_codes);
    assertValidActingRequest({ permissions: body.permissions, hours: body.hours, reason: body.reason, periodCodes });
    // The subject is locked first, so that two requests for one person and a change of their membership serialise; a member of another tenant is not there (404).
    const state = await this.delegations.delegateState(scope.tx, subject, now);
    if (state === 'UNKNOWN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const users = await this.delegations.usersOf(scope.tx, [requester, subject]);
    assertActingParties({ requesterUser: users.get(requester) ?? requester, subjectUser: users.get(subject) ?? subject });
    if (state === 'GUEST') throw new DomainError('ACTING_INVALID', 422, 'subject_membership_id');
    if (state === 'INACTIVE') throw new DomainError('MEMBERSHIP_INACTIVE', 403);
    await this.assertSubjectHolds(scope, subject, body.permissions, now);
    const created = await this.store.insert(scope.tx, { requesterId: requester, subjectId: subject, permissions: body.permissions, periodCodes, hours: body.hours, reason: body.reason.trim() }, now);
    await scope.emit({
      aggregateType: TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'iam.acting.requested.v1',
      schemaVersion: 1,
      payload: { acting_id: created.id, requester_membership_id: requester, subject_membership_id: subject, hours: created.hours },
      eventKey: `${TYPE}:${created.id}:requested`,
    });
    await scope.audit({
      action: 'acting.requested',
      resourceType: TYPE,
      resourceId: created.id,
      reason: created.reason,
      classification: 'CONFIDENTIAL',
      diff: { subject_membership_id: subject, permissions: created.permissions, hours: created.hours, ...(created.periodCodes === null ? {} : { period_codes: created.periodCodes }) },
    });
    return commandResult(scope, 'PENDING', created.version, created.id);
  }

  @Post('acting-requests/:actingId/decision')
  @HttpCode(200)
  @OperationId('decideActingRequest')
  @Command({ operation: 'decideActingRequest', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('actingId', ParseUUIDPipe) actingId: string, @Body() body: Schemas['ActingDecision']): Promise<CommandResult> {
    const now = new Date();
    const approver = scope.tenant.membershipId;
    const found = await this.store.lockPending(scope.tx, actingId.toLowerCase(), scope.expectedVersion ?? 0, now);
    const users = await this.delegations.usersOf(scope.tx, [found.requesterId, found.subjectId, approver]);
    assertActingApprover({ requesterUser: users.get(found.requesterId) ?? found.requesterId, subjectUser: users.get(found.subjectId) ?? found.subjectId, approverUser: users.get(approver) ?? approver });
    if (body.decision === 'reject') {
      const reason = body.reason?.trim() ?? '';
      if (reason.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
      const rejected = await this.store.reject(scope.tx, found.id, approver, reason, now);
      await this.announce(scope, rejected, 'iam.acting.rejected.v1', 'rejected');
      await scope.audit({ action: 'acting.decided', resourceType: TYPE, resourceId: rejected.id, reason, classification: 'CONFIDENTIAL', diff: { decision: 'reject', requester_membership_id: rejected.requesterId, subject_membership_id: rejected.subjectId } });
      return commandResult(scope, 'REJECTED', rejected.version, rejected.id);
    }
    // The person must still be an active member who holds what the administrator asked to use: the request may have waited.
    const state = await this.delegations.delegateState(scope.tx, found.subjectId, now);
    if (state !== 'ACTIVE') throw new DomainError(state === 'UNKNOWN' ? 'RESOURCE_NOT_FOUND' : 'MEMBERSHIP_INACTIVE', state === 'UNKNOWN' ? 404 : 403);
    await this.assertSubjectHolds(scope, found.subjectId, found.permissions, now);
    const approved = await this.store.approve(scope.tx, found.id, approver, body.reason?.trim(), now);
    await this.announce(scope, approved, 'iam.acting.approved.v1', 'approved');
    await scope.audit({
      action: 'acting.decided',
      resourceType: TYPE,
      resourceId: approved.id,
      ...(body.reason === undefined ? {} : { reason: body.reason.trim() }),
      classification: 'CONFIDENTIAL',
      diff: { decision: 'approve', requester_membership_id: approved.requesterId, subject_membership_id: approved.subjectId, window_start: approved.windowStart, window_end: approved.windowEnd, permissions: approved.permissions },
    });
    return commandResult(scope, 'APPROVED', approved.version, approved.id);
  }

  @Post('acting-requests/:actingId/cancel')
  @HttpCode(200)
  @OperationId('cancelActingRequest')
  @Command({ operation: 'cancelActingRequest', versioned: true })
  async cancel(@Scope() scope: CommandScope, @Param('actingId', ParseUUIDPipe) actingId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const found = await this.store.lockPending(scope.tx, actingId.toLowerCase(), scope.expectedVersion ?? 0, new Date());
    // Only the administrator who asked takes the request back.
    if (found.requesterId !== scope.tenant.membershipId) throw new DomainError('SCOPE_DENIED', 403);
    const cancelled = await this.store.cancel(scope.tx, found.id, new Date());
    await scope.audit({ action: 'acting.cancelled', resourceType: TYPE, resourceId: cancelled.id, reason: body.reason.trim(), diff: { subject_membership_id: cancelled.subjectId } });
    return commandResult(scope, 'CANCELLED', cancelled.version, cancelled.id);
  }

  @Post('acting-requests/:actingId/revoke')
  @HttpCode(200)
  @OperationId('revokeActing')
  @Command({ operation: 'revokeActing', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('actingId', ParseUUIDPipe) actingId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const now = new Date();
    const id = actingId.toLowerCase();
    const found = await this.store.find(scope.tx, id, now);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The administrator ends their own session; the one who runs acting grants for the whole tenant can end any.
    if (found.requesterId !== scope.tenant.membershipId && !holdsOnWholeTenant(access, APPROVE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
    const { after } = await this.store.revoke(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, body.reason.trim(), now);
    await this.announce(scope, after, 'iam.acting.revoked.v1', 'revoked');
    await scope.audit({
      action: 'acting.revoked',
      resourceType: TYPE,
      resourceId: id,
      reason: body.reason.trim(),
      classification: 'CONFIDENTIAL',
      diff: { requester_membership_id: after.requesterId, subject_membership_id: after.subjectId, by_requester: after.requesterId === scope.tenant.membershipId },
    });
    return commandResult(scope, 'REVOKED', after.version, id);
  }

  /** The person holds, now, with their own grants, every permission the administrator asks to use: there is nothing to act on otherwise. */
  private async assertSubjectHolds(scope: CommandScope, subject: string, permissions: readonly string[], now: Date): Promise<void> {
    const access = await loadAccessIn(scope.tx, subject);
    const held = activeGrants(access, now).flatMap((grant) => [...grant.permissions]);
    const missing = permissions.findIndex((permission) => !permissionCovered(held, permission));
    if (missing >= 0) throw new DomainError('ACTING_INVALID', 422, `permissions[${missing}]`);
  }

  private async announce(scope: CommandScope, grant: ActingRecord, type: 'iam.acting.approved.v1' | 'iam.acting.rejected.v1' | 'iam.acting.revoked.v1', what: string): Promise<void> {
    await scope.emit({
      aggregateType: TYPE,
      aggregateId: grant.id,
      aggregateVersion: grant.version,
      type,
      schemaVersion: 1,
      payload: { acting_id: grant.id, requester_membership_id: grant.requesterId, subject_membership_id: grant.subjectId, window_end: grant.windowEnd },
      eventKey: `${TYPE}:${grant.id}:${what}`,
    });
  }
}

function pageOf(rows: ActingRecord[], limit: number, render: (row: ActingRecord) => Record<string, unknown>): { items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string } {
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { items: shown.map(render), next_cursor: rows.length > limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
}

/** The acting grants a person asked for, is the subject of, or decided, and for one who holds the right to read or to decide them on the whole tenant, all of them. */
@Controller('resources/acting_grant')
export class ActingReadsController {
  private readonly store = new ActingStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_acting_grant')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('role') role?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown) {
    const request = parsePageRequest(limit, cursor);
    const filters = { status: oneOf(STATUSES, status, 'status'), role: oneOf(ROLES, role, 'role') as 'requested' | 'subject' | undefined };
    const mayRunAll = holdsOnWholeTenant(access, APPROVE_PERMISSION);
    const all = mayRunAll || holdsOnWholeTenant(access, READ_PERMISSION);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { membershipId: tenant.membershipId, all }, filters, { limit: request.limit + 1, after: request.after }, now));
    return pageOf(rows, request.limit, (row) => view(row, tenant.membershipId, mayRunAll));
  }

  @Get(':id')
  @OperationId('get_resources_acting_grant_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const mayRunAll = holdsOnWholeTenant(access, APPROVE_PERMISSION);
    const all = mayRunAll || holdsOnWholeTenant(access, READ_PERMISSION);
    const [found] = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { membershipId: tenant.membershipId, all }, { id: id.toLowerCase() }, { limit: 1, after: undefined }, new Date()));
    // Another person's grant is not there for one who is not a party to it.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view(found, tenant.membershipId, mayRunAll);
  }
}
