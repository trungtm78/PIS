import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { DelegationStore, RoleStore, TenantDatabase, bumpScopeVersion, loadAccessIn } from '@machvon/db';
import type { DelegationGrantRecord, ResolvedScope, ScopeKind } from '@machvon/db';
import { DomainError, assertNoDelegationCycle, assertValidDelegation, assertValidPeriodCodes, delegatorHolds, normalisePeriodCodes, permissionCovered, reviewDueSoon } from '@machvon/kernel';
import type { DelegationRequest, EffectiveAccess, TenantContext } from '@machvon/kernel';
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

const CREATE_PERMISSION = 'iam.delegation.create';
const READ_PERMISSION = 'iam.delegation.read';
const STATUSES: readonly string[] = ['Scheduled', 'Active', 'Ended', 'Revoked'];
const ROLES: readonly string[] = ['given', 'received'];
const KINDS: readonly string[] = ['TIMEBOXED', 'PERMANENT'];

function oneOf(list: readonly string[], value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !list.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

/**
 * Whether the delegator's own grants still hold what the delegation passes on, over its scope (the scope itself, or for a project the owner units that stand in for it). What they hold through a delegation they received does not
 * count. Used when the delegation is made and, every minute, by the job that ends one whose source is gone.
 */
export async function delegatorStillHolds(
  tx: Parameters<typeof loadAccessIn>[0],
  roles: RoleStore,
  delegation: { delegatorId: string; permissions: readonly string[]; scopeKind: string; scopeRefIds: readonly string[] },
  now: Date,
): Promise<boolean> {
  const access = await loadAccessIn(tx, delegation.delegatorId);
  if (!access.membershipActive) return false;
  const resolved = await roles.resolveScope(tx, delegation.scopeKind as ScopeKind, delegation.scopeRefIds);
  if (resolved === undefined) return false;
  return holdsOver(access, delegation.permissions, resolved, now);
}

/** Who runs the delegations of the whole tenant: holds the right to make them and to read them all, both on the whole tenant. */
export function mayRunAll(access: EffectiveAccess): boolean {
  return holdsOnWholeTenant(access, CREATE_PERMISSION) && holdsOnWholeTenant(access, READ_PERMISSION);
}

export function holdsOver(access: EffectiveAccess, permissions: readonly string[], resolved: ResolvedScope, now: Date): boolean {
  return [resolved.scope, resolved.ownerUnitScope].some((scope) => scope !== undefined && delegatorHolds(access, permissions, scope, now));
}

function view(row: DelegationGrantRecord, membershipId: string, mayRevokeAny: boolean): Record<string, unknown> {
  const permanent = row.kind === 'PERMANENT';
  const working = row.status === 'Scheduled' || row.status === 'Active';
  return {
    id: row.id,
    kind: row.kind,
    period_codes: row.periodCodes,
    // A permanent delegation works until its review date: the date is what the screen shows as the review, and the same instant as valid_until.
    review_due_at: permanent ? row.validUntil : null,
    review_due_soon: permanent && working && reviewDueSoon(new Date(row.validUntil), new Date()),
    last_reviewed_at: row.lastReviewedAt,
    review_count: row.reviewCount,
    end_condition_kind: row.endConditionKind,
    end_condition_text: row.endConditionText,
    end_on: row.endOn,
    request_id: row.requestId,
    delegator: { id: row.delegatorId, name: row.delegatorName },
    delegate: { id: row.delegateId, name: row.delegateName },
    permissions: row.permissions,
    scope_kind: row.scopeKind,
    scope_ref_ids: row.scopeRefIds,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    reason: row.reason,
    legal_basis_ref: row.legalBasisRef,
    status: row.status,
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
    ended_at: row.endedAt,
    end_reason: row.endReason,
    created_at: row.createdAt,
    version: row.version,
    // The server judges again: this only says whether the screen should offer it.
    actions: { revoke: working && (row.delegatorId === membershipId || mayRevokeAny), review: permanent && working && row.delegatorId === membershipId },
  };
}

/**
 * Time-boxed delegation of approval authority (ST-ADM-014, ADM 3.5, BR-ADM-06). A leader delegates business permissions they hold, over a scope they hold them in, to another active member for at most 90 days; the delegate never
 * receives more than the delegator has and cannot pass it on. Creating and revoking change the access of the delegate, so their scope version is raised and the change is announced.
 */
@Controller()
export class DelegationCommandsController {
  private readonly store = new DelegationStore();
  private readonly roles = new RoleStore();

  @Post('delegations')
  @HttpCode(201)
  @OperationId('createDelegation')
  @Command({ operation: 'createDelegation' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DelegationCreate']): Promise<CommandResult> {
    const now = new Date();
    const delegator = scope.tenant.membershipId;
    const delegate = body.delegate_membership_id.toLowerCase();
    if (delegate === delegator) throw new DomainError('SELF_GRANT_DENIED', 403, 'delegate_membership_id');
    const periodCodes = body.period_codes === undefined ? undefined : normalisePeriodCodes(body.period_codes);
    if (periodCodes !== undefined) assertValidPeriodCodes(periodCodes);
    const request: DelegationRequest = { permissions: body.permissions, scopeKind: body.scope_kind, scopeRefIds: body.scope_ref_ids.map((id) => id.toLowerCase()), validFrom: new Date(body.valid_from), validUntil: new Date(body.valid_until) };
    assertValidDelegation(request, now);
    // The delegate is locked first, so that two delegations to one member and a change of their membership serialise; a member of another tenant is not there (404).
    const state = await this.store.delegateState(scope.tx, delegate, now);
    if (state === 'UNKNOWN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const resolved = await this.roles.resolveScope(scope.tx, body.scope_kind, request.scopeRefIds);
    if (resolved === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref_ids');
    if (state === 'GUEST') throw new DomainError('DELEGATION_INVALID', 422, 'delegate_membership_id');
    if (state === 'INACTIVE') throw new DomainError('MEMBERSHIP_INACTIVE', 403);
    // What is passed on has to be the delegator's own, now; held only through a delegation they received it is not theirs to pass on (no chain).
    if (!holdsOver(access, body.permissions, resolved, now)) {
      const received = await this.store.heldThroughDelegations(scope.tx, delegator, now);
      const throughDelegation = body.permissions.some((permission) => permissionCovered(received, permission));
      throw new DomainError(throughDelegation ? 'DELEGATION_CHAIN_DENIED' : 'ROLE_ESCALATION_DENIED', 403, 'permissions');
    }
    // Authority that goes round is authority nobody holds: a delegation that closes a loop of delegations (also through other persons) is refused.
    const users = await this.store.usersOf(scope.tx, [delegator, delegate]);
    assertNoDelegationCycle(await this.store.edges(scope.tx, now), { delegatorUser: users.get(delegator) ?? delegator, delegateUser: users.get(delegate) ?? delegate, permissions: body.permissions });
    const created = await this.store.insert(scope.tx, {
      delegatorId: delegator,
      delegateId: delegate,
      permissions: body.permissions,
      scopeKind: body.scope_kind,
      scopeRefIds: request.scopeRefIds,
      validFrom: request.validFrom,
      validUntil: request.validUntil,
      reason: body.reason.trim(),
      legalBasisRef: body.legal_basis_ref,
      periodCodes,
      now,
    });
    await this.announce(scope, created, 'iam.delegation.created.v1', 'created');
    await scope.audit({
      action: 'delegation.created',
      resourceType: 'delegation_grant',
      resourceId: created.id,
      reason: created.reason,
      diff: { delegate_membership_id: delegate, permissions: created.permissions, scope_kind: created.scopeKind, scope_ref_ids: created.scopeRefIds, valid_from: created.validFrom, valid_until: created.validUntil, ...(created.periodCodes === null ? {} : { period_codes: created.periodCodes }) },
    });
    return commandResult(scope, created.status.toUpperCase(), created.version, created.id);
  }

  @Post('delegations/:delegationId/revoke')
  @HttpCode(200)
  @OperationId('revokeDelegation')
  @Command({ operation: 'revokeDelegation', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('delegationId', ParseUUIDPipe) delegationId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const id = delegationId.toLowerCase();
    const found = await this.store.find(scope.tx, id);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The delegator takes back what they gave; the one who runs delegations for the whole tenant (the right to make them and to read them all, on the whole tenant) can take back any.
    if (found.delegatorId !== scope.tenant.membershipId && !mayRunAll(access)) throw new DomainError('SCOPE_DENIED', 403);
    const { after } = await this.store.revoke(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, body.reason.trim(), new Date());
    await this.announce(scope, after, 'iam.delegation.revoked.v1', 'revoked');
    await scope.audit({
      action: 'delegation.revoked',
      resourceType: 'delegation_grant',
      resourceId: id,
      reason: body.reason.trim(),
      diff: { delegator_membership_id: after.delegatorId, delegate_membership_id: after.delegateId, by_delegator: after.delegatorId === scope.tenant.membershipId },
    });
    return commandResult(scope, 'REVOKED', after.version, id);
  }

  /** The delegate's access changes with the delegation: their scope version is raised, and the delegation and the change are announced. */
  private async announce(scope: CommandScope, delegation: DelegationGrantRecord, type: 'iam.delegation.created.v1' | 'iam.delegation.revoked.v1', what: string): Promise<void> {
    await bumpScopeVersion(scope.tx, [delegation.delegateId]);
    await scope.emit({
      aggregateType: 'delegation_grant',
      aggregateId: delegation.id,
      aggregateVersion: delegation.version,
      type,
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
      },
      eventKey: `delegation_grant:${delegation.id}:${what}`,
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

function pageOf(rows: DelegationGrantRecord[], limit: number, view_: (row: DelegationGrantRecord) => Record<string, unknown>): { items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string } {
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { items: shown.map(view_), next_cursor: rows.length > limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
}

/** The delegations a person gave or received, and for who holds `iam.delegation.read` on the whole tenant all of them. */
@Controller('resources/delegation_grant')
export class DelegationReadsController {
  private readonly store = new DelegationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_delegation_grant')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('role') role?: unknown, @Query('kind') kind?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown) {
    const request = parsePageRequest(limit, cursor);
    const filters = { status: oneOf(STATUSES, status, 'status'), role: oneOf(ROLES, role, 'role') as 'given' | 'received' | undefined, kind: oneOf(KINDS, kind, 'kind') as 'TIMEBOXED' | 'PERMANENT' | undefined };
    const all = holdsOnWholeTenant(access, READ_PERMISSION);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { membershipId: tenant.membershipId, all }, filters, { limit: request.limit + 1, after: request.after }));
    const mayRevokeAny = mayRunAll(access);
    return pageOf(rows, request.limit, (row) => view(row, tenant.membershipId, mayRevokeAny));
  }

  @Get(':id')
  @OperationId('get_resources_delegation_grant_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const all = holdsOnWholeTenant(access, READ_PERMISSION);
    const [found] = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { membershipId: tenant.membershipId, all }, { id: id.toLowerCase() }, { limit: 1, after: undefined }));
    // Another person's delegation is not there for one who neither gave nor received it.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...view(found, tenant.membershipId, mayRunAll(access)), as_of: new Date().toISOString() };
  }
}
