import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { DelegationStore, RoleStore, StandingRequestStore, TenantDatabase, bumpScopeVersion } from '@machvon/db';
import type { DelegationGrantRecord, StandingRequestRecord } from '@machvon/db';
import { DomainError, assertNoDelegationCycle, assertValidReview, assertValidStandingDelegation, normalisePeriodCodes, permissionCovered } from '@machvon/kernel';
import type { EffectiveAccess, StandingDelegationRequest, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { delegatorStillHolds } from './delegation.controller';
import { holdsOnWholeTenant } from './tenant-authority';

const APPROVE_PERMISSION = 'iam.delegation.approve';
const READ_PERMISSION = 'iam.delegation.read';
const REQUEST_TYPE = 'standing_delegation_request';
const DELEGATION_TYPE = 'delegation_grant';
const STATUSES: readonly string[] = ['Pending', 'Approved', 'Rejected', 'Cancelled', 'Lapsed'];

function oneOf(list: readonly string[], value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !list.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

/** What the request asks, as the kernel judges it; the start is never earlier than now. */
function kernelRequestOf(record: Pick<StandingRequestRecord, 'permissions' | 'scopeKind' | 'scopeRefIds' | 'periodCodes' | 'startsAt' | 'reviewDueAt' | 'endConditionKind' | 'endConditionText' | 'endOn'>, now: Date): StandingDelegationRequest {
  const startsAt = new Date(record.startsAt);
  return {
    permissions: record.permissions,
    scopeKind: record.scopeKind,
    scopeRefIds: record.scopeRefIds,
    validFrom: startsAt.getTime() < now.getTime() ? now : startsAt,
    reviewDueAt: new Date(record.reviewDueAt),
    endConditionKind: record.endConditionKind,
    endConditionText: record.endConditionText,
    endOn: record.endOn === null ? null : new Date(record.endOn),
    ...(record.periodCodes === null ? {} : { periodCodes: record.periodCodes }),
  };
}

const party = (id: string | null, name: string | null): { id: string; name: string | null } | null => (id === null ? null : { id, name });

function view(row: StandingRequestRecord, membershipId: string, mayDecide: boolean): Record<string, unknown> {
  return {
    id: row.id,
    delegator: party(row.delegatorId, row.delegatorName),
    delegate: party(row.delegateId, row.delegateName),
    permissions: row.permissions,
    scope_kind: row.scopeKind,
    scope_ref_ids: row.scopeRefIds,
    period_codes: row.periodCodes,
    starts_at: row.startsAt,
    review_due_at: row.reviewDueAt,
    end_condition_kind: row.endConditionKind,
    end_condition_text: row.endConditionText,
    end_on: row.endOn,
    reason: row.reason,
    legal_basis_ref: row.legalBasisRef,
    status: row.status,
    expires_at: row.expiresAt,
    decided_by: party(row.decidedBy, row.decidedByName),
    decided_at: row.decidedAt,
    decision_reason: row.decisionReason,
    delegation_id: row.delegationId,
    created_at: row.createdAt,
    version: row.version,
    // The server judges again: this only says whether the screen should offer it.
    actions: { decide: row.status === 'Pending' && mayDecide && row.delegatorId !== membershipId && row.delegateId !== membershipId, cancel: row.status === 'Pending' && row.delegatorId === membershipId },
  };
}

/**
 * The permanent delegation (IAM-2, ADM-25): an ongoing handing over of business permissions that has an end condition in words and a review date at most a year ahead, as opposed to the time-boxed delegation of ST-ADM-014. The
 * delegator asks; a second person, who is neither the delegator nor the delegate (by the person, not the membership), approves; the approval makes the delegation (a `delegation_grant` of kind PERMANENT, so the approval engine, the door
 * of the decision and the signing authority honour it unchanged). It works until its review date: the delegator reviews it to move the date forward, and one that is not reviewed in time stops at that instant. A delegation that
 * would close a loop of delegations is refused, and the delegator must still hold what is passed on when the request is approved. The delegate's access changes with it, so their scope version is raised.
 */
@Controller()
export class StandingDelegationCommandsController {
  private readonly requests = new StandingRequestStore();
  private readonly delegations = new DelegationStore();
  private readonly roles = new RoleStore();

  @Post('standing-delegation-requests')
  @HttpCode(201)
  @OperationId('createStandingDelegationRequest')
  @Command({ operation: 'createStandingDelegationRequest' })
  async create(@Scope() scope: CommandScope, @Body() body: Schemas['StandingDelegationRequestCreate']): Promise<CommandResult> {
    const now = new Date();
    const delegator = scope.tenant.membershipId;
    const delegate = body.delegate_membership_id.toLowerCase();
    if (delegate === delegator) throw new DomainError('SELF_GRANT_DENIED', 403, 'delegate_membership_id');
    const periodCodes = body.period_codes === undefined ? undefined : normalisePeriodCodes(body.period_codes);
    const request: StandingDelegationRequest = {
      permissions: body.permissions,
      scopeKind: body.scope_kind,
      scopeRefIds: body.scope_ref_ids.map((id) => id.toLowerCase()),
      validFrom: new Date(body.valid_from),
      reviewDueAt: new Date(body.review_due_at),
      endConditionKind: body.end_condition_kind,
      endConditionText: body.end_condition_text,
      endOn: body.end_on === undefined ? null : new Date(body.end_on),
      ...(periodCodes === undefined ? {} : { periodCodes }),
    };
    assertValidStandingDelegation(request, now);
    // The delegate is locked first, so that two requests to one member and a change of their membership serialise; a member of another tenant is not there (404).
    const state = await this.delegations.delegateState(scope.tx, delegate, now);
    if (state === 'UNKNOWN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const resolved = await this.roles.resolveScope(scope.tx, body.scope_kind, request.scopeRefIds);
    if (resolved === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref_ids');
    if (state === 'GUEST') throw new DomainError('DELEGATION_INVALID', 422, 'delegate_membership_id');
    if (state === 'INACTIVE') throw new DomainError('MEMBERSHIP_INACTIVE', 403);
    await this.assertHolds(scope, delegator, { permissions: body.permissions, scopeKind: body.scope_kind, scopeRefIds: request.scopeRefIds }, now);
    await this.assertNoLoop(scope, delegator, delegate, body.permissions, now);
    const created = await this.requests.insert(scope.tx, {
      delegatorId: delegator,
      delegateId: delegate,
      permissions: body.permissions,
      scopeKind: body.scope_kind,
      scopeRefIds: request.scopeRefIds,
      periodCodes,
      startsAt: request.validFrom,
      reviewDueAt: request.reviewDueAt,
      endConditionKind: body.end_condition_kind,
      endConditionText: body.end_condition_text,
      endOn: request.endOn ?? undefined,
      reason: body.reason.trim(),
      legalBasisRef: body.legal_basis_ref,
    });
    await scope.emit({
      aggregateType: REQUEST_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'iam.delegation.requested.v1',
      schemaVersion: 1,
      payload: { request_id: created.id, delegator_membership_id: delegator, delegate_membership_id: delegate, review_due_at: created.reviewDueAt },
      eventKey: `${REQUEST_TYPE}:${created.id}:requested`,
    });
    await scope.audit({
      action: 'delegation.standing_requested',
      resourceType: REQUEST_TYPE,
      resourceId: created.id,
      reason: created.reason,
      diff: {
        delegate_membership_id: delegate,
        permissions: created.permissions,
        scope_kind: created.scopeKind,
        scope_ref_ids: created.scopeRefIds,
        review_due_at: created.reviewDueAt,
        end_condition_kind: created.endConditionKind,
        end_on: created.endOn,
        ...(created.periodCodes === null ? {} : { period_codes: created.periodCodes }),
      },
    });
    return commandResult(scope, 'PENDING', created.version, created.id);
  }

  @Post('standing-delegation-requests/:requestId/decision')
  @HttpCode(200)
  @OperationId('decideStandingDelegationRequest')
  @Command({ operation: 'decideStandingDelegationRequest', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('requestId', ParseUUIDPipe) requestId: string, @Body() body: Schemas['StandingDelegationDecision']): Promise<CommandResult> {
    const now = new Date();
    const approver = scope.tenant.membershipId;
    const found = await this.requests.lockPending(scope.tx, requestId.toLowerCase(), scope.expectedVersion ?? 0);
    // Maker is not checker, by the person: the one who decides is neither the delegator nor the delegate, whatever memberships they hold.
    const users = await this.delegations.usersOf(scope.tx, [found.delegatorId, found.delegateId, approver]);
    const approverUser = users.get(approver);
    if (approverUser === undefined || approverUser === users.get(found.delegatorId) || approverUser === users.get(found.delegateId)) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'approver');
    if (body.decision === 'reject') {
      const reason = body.reason?.trim() ?? '';
      if (reason.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
      const rejected = await this.requests.reject(scope.tx, found.id, approver, reason, now);
      await scope.emit({
        aggregateType: REQUEST_TYPE,
        aggregateId: rejected.id,
        aggregateVersion: rejected.version,
        type: 'iam.delegation.request_rejected.v1',
        schemaVersion: 1,
        payload: { request_id: rejected.id, delegator_membership_id: rejected.delegatorId, delegate_membership_id: rejected.delegateId },
        eventKey: `${REQUEST_TYPE}:${rejected.id}:rejected`,
      });
      await scope.audit({ action: 'delegation.standing_decided', resourceType: REQUEST_TYPE, resourceId: rejected.id, reason, diff: { decision: 'reject', delegator_membership_id: rejected.delegatorId, delegate_membership_id: rejected.delegateId } });
      return commandResult(scope, 'REJECTED', rejected.version, rejected.id);
    }
    // The request is judged again as it stands now: it may have waited for days, and what it asked is not what it is allowed to become by default.
    const request = kernelRequestOf(found, now);
    assertValidStandingDelegation(request, now);
    const state = await this.delegations.delegateState(scope.tx, found.delegateId, now);
    if (state === 'UNKNOWN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (state === 'GUEST') throw new DomainError('DELEGATION_INVALID', 422, 'delegate_membership_id');
    if (state === 'INACTIVE') throw new DomainError('MEMBERSHIP_INACTIVE', 403);
    await this.assertHolds(scope, found.delegatorId, found, now);
    await this.assertNoLoop(scope, found.delegatorId, found.delegateId, found.permissions, now);
    const delegation = await this.delegations.insertStanding(scope.tx, {
      delegatorId: found.delegatorId,
      delegateId: found.delegateId,
      permissions: found.permissions,
      scopeKind: found.scopeKind,
      scopeRefIds: found.scopeRefIds,
      validFrom: new Date(found.startsAt),
      reviewDueAt: new Date(found.reviewDueAt),
      reason: found.reason,
      legalBasisRef: found.legalBasisRef ?? undefined,
      periodCodes: found.periodCodes ?? undefined,
      endConditionKind: found.endConditionKind,
      endConditionText: found.endConditionText,
      endOn: found.endOn === null ? undefined : new Date(found.endOn),
      requestId: found.id,
      now,
    });
    const approved = await this.requests.approve(scope.tx, found.id, approver, delegation.id, body.reason?.trim(), now);
    await this.announce(scope, delegation);
    await scope.audit({
      action: 'delegation.created',
      resourceType: DELEGATION_TYPE,
      resourceId: delegation.id,
      reason: delegation.reason,
      diff: { kind: 'PERMANENT', delegate_membership_id: delegation.delegateId, permissions: delegation.permissions, scope_kind: delegation.scopeKind, scope_ref_ids: delegation.scopeRefIds, review_due_at: delegation.validUntil, request_id: found.id },
    });
    await scope.audit({
      action: 'delegation.standing_decided',
      resourceType: REQUEST_TYPE,
      resourceId: approved.id,
      ...(body.reason === undefined ? {} : { reason: body.reason.trim() }),
      diff: { decision: 'approve', delegation_id: delegation.id, delegator_membership_id: approved.delegatorId, delegate_membership_id: approved.delegateId },
    });
    return commandResult(scope, 'APPROVED', approved.version, approved.id);
  }

  @Post('standing-delegation-requests/:requestId/cancel')
  @HttpCode(200)
  @OperationId('cancelStandingDelegationRequest')
  @Command({ operation: 'cancelStandingDelegationRequest', versioned: true })
  async cancel(@Scope() scope: CommandScope, @Param('requestId', ParseUUIDPipe) requestId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const found = await this.requests.lockPending(scope.tx, requestId.toLowerCase(), scope.expectedVersion ?? 0);
    // Only the delegator takes their request back.
    if (found.delegatorId !== scope.tenant.membershipId) throw new DomainError('SCOPE_DENIED', 403);
    const cancelled = await this.requests.cancel(scope.tx, found.id, new Date());
    await scope.audit({ action: 'delegation.standing_cancelled', resourceType: REQUEST_TYPE, resourceId: cancelled.id, reason: body.reason.trim(), diff: { delegate_membership_id: cancelled.delegateId } });
    return commandResult(scope, 'CANCELLED', cancelled.version, cancelled.id);
  }

  @Post('delegations/:delegationId/review')
  @HttpCode(200)
  @OperationId('reviewDelegation')
  @Command({ operation: 'reviewDelegation', versioned: true })
  async review(@Scope() scope: CommandScope, @Param('delegationId', ParseUUIDPipe) delegationId: string, @Body() body: Schemas['DelegationReview']): Promise<CommandResult> {
    const now = new Date();
    const id = delegationId.toLowerCase();
    const found = await this.delegations.find(scope.tx, id);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The review is the delegator confirming that they still need what they handed over: nobody confirms for them (an administrator can revoke instead).
    if (found.delegatorId !== scope.tenant.membershipId) throw new DomainError('SCOPE_DENIED', 403);
    const nextDueAt = new Date(body.review_due_at);
    if (found.kind === 'PERMANENT') assertValidReview({ validUntil: new Date(found.validUntil), endOn: found.endOn === null ? null : new Date(found.endOn) }, nextDueAt, now);
    // A delegator who no longer holds what they passed on cannot confirm it: the job ends it as its source is gone.
    if (found.kind === 'PERMANENT' && !(await delegatorStillHolds(scope.tx, this.roles, found, now))) throw new DomainError('ROLE_ESCALATION_DENIED', 403, 'permissions');
    const { before, after } = await this.delegations.review(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, nextDueAt, now);
    await scope.emit({
      aggregateType: DELEGATION_TYPE,
      aggregateId: id,
      aggregateVersion: after.version,
      type: 'iam.delegation.reviewed.v1',
      schemaVersion: 1,
      payload: { delegation_id: id, delegator_membership_id: after.delegatorId, delegate_membership_id: after.delegateId, review_due_at: after.validUntil },
      eventKey: `${DELEGATION_TYPE}:${id}:reviewed:${after.reviewCount}`,
    });
    await scope.audit({
      action: 'delegation.reviewed',
      resourceType: DELEGATION_TYPE,
      resourceId: id,
      ...(body.note === undefined || body.note.trim() === '' ? {} : { reason: body.note.trim() }),
      diff: { delegate_membership_id: after.delegateId, previous_review_due_at: before.validUntil, review_due_at: after.validUntil, review_count: after.reviewCount },
    });
    return commandResult(scope, after.status.toUpperCase(), after.version, id);
  }

  /** The delegator holds, now, what the delegation passes on, with their own grants and not what they hold through a delegation (no chain). */
  private async assertHolds(
    scope: CommandScope,
    delegator: string,
    asked: { permissions: readonly string[]; scopeKind: string; scopeRefIds: readonly string[] },
    now: Date,
  ): Promise<void> {
    if (await delegatorStillHolds(scope.tx, this.roles, { delegatorId: delegator, ...asked }, now)) return;
    const received = await this.delegations.heldThroughDelegations(scope.tx, delegator, now);
    const throughDelegation = asked.permissions.some((permission) => permissionCovered(received, permission));
    throw new DomainError(throughDelegation ? 'DELEGATION_CHAIN_DENIED' : 'ROLE_ESCALATION_DENIED', 403, 'permissions');
  }

  /** A delegation that would close a loop of delegations is refused (also through other persons, and to oneself under another membership). */
  private async assertNoLoop(scope: CommandScope, delegator: string, delegate: string, permissions: readonly string[], now: Date): Promise<void> {
    const users = await this.delegations.usersOf(scope.tx, [delegator, delegate]);
    assertNoDelegationCycle(await this.delegations.edges(scope.tx, now), { delegatorUser: users.get(delegator) ?? delegator, delegateUser: users.get(delegate) ?? delegate, permissions });
  }

  /** The delegate's access changes with the delegation: their scope version is raised, and the delegation and the change are announced. */
  private async announce(scope: CommandScope, delegation: DelegationGrantRecord): Promise<void> {
    await bumpScopeVersion(scope.tx, [delegation.delegateId]);
    await scope.emit({
      aggregateType: DELEGATION_TYPE,
      aggregateId: delegation.id,
      aggregateVersion: delegation.version,
      type: 'iam.delegation.created.v1',
      schemaVersion: 1,
      payload: {
        delegation_id: delegation.id,
        delegator_membership_id: delegation.delegatorId,
        delegate_membership_id: delegation.delegateId,
        permissions: delegation.permissions,
        scope_kind: delegation.scopeKind,
        scope_ref_ids: delegation.scopeRefIds,
        valid_from: delegation.validFrom,
        valid_until: delegation.validUntil,
        kind: delegation.kind,
      },
      eventKey: `${DELEGATION_TYPE}:${delegation.id}:created`,
    });
    await scope.emit({
      aggregateType: 'membership',
      aggregateId: delegation.delegateId,
      aggregateVersion: delegation.version,
      type: 'iam.access.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, membership_ids: [delegation.delegateId] },
      eventKey: `access-changed:${scope.requestId}`,
    });
  }
}

function pageOf(rows: StandingRequestRecord[], limit: number, render: (row: StandingRequestRecord) => Record<string, unknown>): { items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string } {
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { items: shown.map(render), next_cursor: rows.length > limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
}

/** The requests a person made or is the delegate of, and for one who holds the right to decide or to read delegations on the whole tenant, all of them. */
@Controller('resources/standing_delegation_request')
export class StandingDelegationReadsController {
  private readonly store = new StandingRequestStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_standing_delegation_request')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown) {
    const request = parsePageRequest(limit, cursor);
    const filters = { status: oneOf(STATUSES, status, 'status') };
    const mayDecide = holdsOnWholeTenant(access, APPROVE_PERMISSION);
    const all = mayDecide || holdsOnWholeTenant(access, READ_PERMISSION);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { membershipId: tenant.membershipId, all }, filters, { limit: request.limit + 1, after: request.after }));
    return pageOf(rows, request.limit, (row) => view(row, tenant.membershipId, mayDecide));
  }

  @Get(':id')
  @OperationId('get_resources_standing_delegation_request_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const mayDecide = holdsOnWholeTenant(access, APPROVE_PERMISSION);
    const all = mayDecide || holdsOnWholeTenant(access, READ_PERMISSION);
    const [found] = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { membershipId: tenant.membershipId, all }, { id: id.toLowerCase() }, { limit: 1, after: undefined }));
    // Another person's request is not there for one who neither made it nor is its delegate.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view(found, tenant.membershipId, mayDecide);
  }
}
