import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { DelegationStore, PeriodScopeStore, RoleStore, TenantDatabase } from '@machvon/db';
import type { PeriodScopeRecord } from '@machvon/db';
import { DomainError, assertValidPeriodCodes, effectivePermissions, holdsPermission, maxRank, normalisePeriodCodes } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { assertVerdict } from '../../iam-dto';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { authorise, reachOf } from '../../role-grants.controller';
import { CurrentTenant } from '../../tenant-context.decorator';

const TYPE = 'role_grant_period_scope';
const STATUSES: readonly string[] = ['Active', 'Lifted'];
const GRANT_PERMISSION = 'iam.role.grant';
/** The limits read in one go when the caller sees only some of them. */
const SCAN_BATCH = 100;

/** Whether the caller holds the right to grant roles anywhere: the screen offers the lift to them (the server judges the grant itself). */
const mayGrantSomewhere = (access: EffectiveAccess): boolean => holdsPermission(effectivePermissions(access, new Date()), GRANT_PERMISSION);

const party = (id: string | null, name: string | null): { id: string; name: string | null } | null => (id === null ? null : { id, name });

function view(row: PeriodScopeRecord, mayLift: boolean): Record<string, unknown> {
  return {
    id: row.id,
    role_grant_id: row.roleGrantId,
    member: party(row.membershipId, row.memberName),
    role_code: row.roleCode,
    period_codes: row.periodCodes,
    reason: row.reason,
    status: row.status,
    set_by: row.setBy,
    set_at: row.setAt,
    lifted_by: row.liftedBy,
    lifted_at: row.liftedAt,
    lift_reason: row.liftReason,
    version: row.version,
    // The server judges again: this only says whether the screen should offer it.
    actions: { lift: row.status === 'Active' && mayLift },
  };
}

/**
 * The limit of a role grant to report periods (IAM-2, ADM-27): a person who holds a role only for some periods (a reporter of the third quarter, an assistant for the year 2026) uses it only on the reports of those periods;
 * a role grant without a limit is as it always was. Setting or lifting a limit changes what the holder may do, so it is judged as the grant is: the caller has to hold the role's permissions over its scope and outrank the holder
 * (BR-IAM-05), and is never the holder (by the person); lifting widens authority. Either raises the holder's scope version, so their next request is judged again.
 */
@Controller()
export class PeriodScopeCommandsController {
  private readonly store = new PeriodScopeStore();
  private readonly roles = new RoleStore();
  private readonly delegations = new DelegationStore();

  @Post('period-scopes')
  @HttpCode(201)
  @OperationId('createPeriodScope')
  @Command({ operation: 'createPeriodScope' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PeriodScopeCreate']): Promise<CommandResult> {
    const periodCodes = normalisePeriodCodes(body.period_codes);
    assertValidPeriodCodes(periodCodes);
    const grantId = body.role_grant_id.toLowerCase();
    const held = await this.authorisedGrant(scope, access, grantId);
    const created = await this.store.insert(scope.tx, { roleGrantId: grantId, membershipId: held.membershipId, periodCodes, reason: body.reason.trim(), setBy: scope.tenant.membershipId });
    await this.announce(scope, created, 'iam.period_scope.set.v1', 'set');
    await scope.audit({
      action: 'period_scope.set',
      resourceType: TYPE,
      resourceId: created.id,
      reason: created.reason,
      diff: { role_grant_id: grantId, membership_id: held.membershipId, role_code: created.roleCode, period_codes: created.periodCodes },
    });
    return commandResult(scope, 'ACTIVE', created.version, created.id);
  }

  @Post('period-scopes/:scopeId/lift')
  @HttpCode(200)
  @OperationId('liftPeriodScope')
  @Command({ operation: 'liftPeriodScope', versioned: true })
  async lift(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('scopeId', ParseUUIDPipe) scopeId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const id = scopeId.toLowerCase();
    const found = await this.store.find(scope.tx, id);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.authorisedGrant(scope, access, found.roleGrantId);
    const { after } = await this.store.lift(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, body.reason.trim(), new Date());
    await this.announce(scope, after, 'iam.period_scope.lifted.v1', 'lifted');
    await scope.audit({
      action: 'period_scope.lifted',
      resourceType: TYPE,
      resourceId: id,
      reason: body.reason.trim(),
      diff: { role_grant_id: after.roleGrantId, membership_id: after.membershipId, role_code: after.roleCode, period_codes: after.periodCodes },
    });
    return commandResult(scope, 'LIFTED', after.version, id);
  }

  /**
   * The grant the limit belongs to, once the caller may touch it: 404 when there is none, 403 `SELF_GRANT_DENIED` when its holder is the caller (by the person), and the anti-escalation rules of a grant of that role over that scope;
   * the caller has to outrank everything the holder holds, as when a grant is revoked.
   */
  private async authorisedGrant(scope: CommandScope, access: EffectiveAccess, grantId: string): Promise<{ membershipId: string }> {
    const peek = await this.roles.getGrant(scope.tx, grantId);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const users = await this.delegations.usersOf(scope.tx, [peek.membershipId, scope.tenant.membershipId]);
    if (peek.membershipId === scope.tenant.membershipId || users.get(peek.membershipId) === users.get(scope.tenant.membershipId)) throw new DomainError('SELF_GRANT_DENIED', 403);
    await this.roles.lockMembership(scope.tx, peek.membershipId);
    const grant = await this.store.lockGrant(scope.tx, grantId);
    if (grant === undefined || !grant.active) throw new DomainError('VALIDATION_FAILED', 422, 'role_grant_id');
    const role = await this.roles.findRole(scope.tx, peek.roleId);
    const resolved = await this.roles.resolveScope(scope.tx, peek.scopeKind, peek.scopeRefIds);
    if (role === undefined || resolved === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'role_grant_id');
    const authorised = authorise(access, peek.membershipId, role, resolved);
    assertVerdict(authorised.verdict);
    const now = new Date();
    const actorRank = Math.max(maxRank(access, now, authorised.scope), resolved.ownerUnitScope === undefined ? 0 : maxRank(access, now, resolved.ownerUnitScope));
    if (actorRank <= (await this.roles.highestRankOf(scope.tx, peek.membershipId))) throw new DomainError('ROLE_ESCALATION_DENIED', 403);
    return { membershipId: peek.membershipId };
  }

  /** The holder's access changes with the limit (their scope version was raised by the store): the change is announced so caches of access are dropped. */
  private async announce(scope: CommandScope, record: PeriodScopeRecord, type: 'iam.period_scope.set.v1' | 'iam.period_scope.lifted.v1', what: string): Promise<void> {
    await scope.emit({
      aggregateType: TYPE,
      aggregateId: record.id,
      aggregateVersion: record.version,
      type,
      schemaVersion: 1,
      payload: { period_scope_id: record.id, role_grant_id: record.roleGrantId, membership_id: record.membershipId, period_codes: record.periodCodes },
      eventKey: `${TYPE}:${record.id}:${what}`,
    });
    await scope.emit({
      aggregateType: 'membership',
      aggregateId: record.membershipId,
      aggregateVersion: record.version,
      type: 'iam.access.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, membership_ids: [record.membershipId] },
      eventKey: `access-changed:${scope.requestId}`,
    });
  }
}

function pageOf(rows: PeriodScopeRecord[], limit: number, render: (row: PeriodScopeRecord) => Record<string, unknown>): { items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string } {
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { items: shown.map(render), next_cursor: rows.length > limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
}

/** The limits of the role grants a caller may see: those of the grants they could read (`reachOf` as for the grants themselves). */
@Controller('resources/period_scope')
export class PeriodScopeReadsController {
  private readonly store = new PeriodScopeStore();
  private readonly roles = new RoleStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_period_scope')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('membership_id') membershipId?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown) {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && !(typeof status === 'string' && STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (membershipId !== undefined && !(typeof membershipId === 'string' && /^[0-9a-f-]{36}$/i.test(membershipId))) throw new DomainError('VALIDATION_FAILED', 422, 'membership_id');
    const reach = reachOf(access, tenant);
    const filters = { status: status as string | undefined, membershipId: membershipId === undefined ? undefined : (membershipId as string).toLowerCase() };
    const rows = await this.database.withTenant(tenant, async (tx) => {
      if (reach === undefined) return this.store.list(tx, filters, { limit: request.limit + 1, after: request.after });
      // The limits of grants the caller may not see are skipped before the page is cut: batches are read on until a page and one row more are visible, or nothing is left, so that the cursor and the end of the list are true.
      const visible: PeriodScopeRecord[] = [];
      let after = request.after;
      for (;;) {
        const batch = await this.store.list(tx, filters, { limit: SCAN_BATCH, after });
        for (const row of batch) if ((await this.roles.getGrant(tx, row.roleGrantId, reach)) !== undefined) visible.push(row);
        const last = batch[batch.length - 1];
        if (batch.length < SCAN_BATCH || last === undefined || visible.length > request.limit) return visible;
        after = { code: last.sortKey, id: last.id };
      }
    });
    const mayLift = mayGrantSomewhere(access);
    return pageOf(rows, request.limit, (row) => view(row, mayLift));
  }

  @Get(':id')
  @OperationId('get_resources_period_scope_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const reach = reachOf(access, tenant);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const [row] = await this.store.list(tx, { id: id.toLowerCase() }, { limit: 1, after: undefined });
      if (row === undefined) return undefined;
      return reach === undefined || (await this.roles.getGrant(tx, row.roleGrantId, reach)) !== undefined ? row : undefined;
    });
    // A limit of a grant the caller may not see is indistinguishable from a missing one.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view(found, mayGrantSomewhere(access));
  }
}
