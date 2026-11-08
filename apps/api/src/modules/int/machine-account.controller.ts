import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AccessLogStore, BidWorkflowReads, MachineAccountStore, TenantDatabase } from '@machvon/db';
import type { MachineAccountFilter } from '@machvon/db';
import {
  DomainError,
  MACHINE_ACCOUNT_STATUSES,
  MACHINE_RATE_DEFAULT,
  MACHINE_RATE_MAX,
  MACHINE_RATE_MIN,
  OPEN_ACCESS_OUTCOMES,
  OPEN_API_SCOPES,
  asUuid,
  dayOf,
  egpReasonOf,
  expiryOf,
  generateClientCredentials,
  graceHoursOf,
  isMachineAccountMove,
  machineAccountRequestOf,
  ratePerMinuteOf,
  scopesOf,
  vietnamDateOf,
} from '@machvon/kernel';
import type { EffectiveAccess, OpenAccessOutcome, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { accessLogDto, machineAccountDto, nameLookup } from './int-view';

const ACCOUNT_RESOURCE = 'int_machine_account';
const CLASSIFICATION = 'CONFIDENTIAL';
export const OPEN_TOKEN_URL = '/open/v1/token';

const people = new BidWorkflowReads();

/** A query value that must be one non-empty string or absent. */
export function queryText(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

const wholeTenant = (access: EffectiveAccess, permission: string): void => {
  // What a machine may read is a decision about the whole organization: a grant on a subtree does not reach it.
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

/**
 * The machine accounts of the open API (INT-01, INT-02). Opening an account and rotating its secret answer with the secret once: the command interceptor withholds `client_secret` from the answer it keeps for
 * the replay of the idempotency key, the platform keeps only the SHA-256 of the secret, and neither the audit row nor the event carries it.
 */
@Controller()
export class MachineAccountController {
  private readonly accounts = new MachineAccountStore();

  private async announce(scope: CommandScope, change: string, id: string, version: number, now: Date): Promise<void> {
    await scope.emit({
      aggregateType: ACCOUNT_RESOURCE,
      aggregateId: id,
      aggregateVersion: version,
      type: 'int.machine_account.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, account_id: id, change, version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${ACCOUNT_RESOURCE}:${id}:${version}`,
    });
  }

  @Post('int/machine-accounts')
  @HttpCode(201)
  @OperationId('createMachineAccount')
  @Command({ operation: 'createMachineAccount', withheld: ['client_secret'] })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['MachineAccountCreate']): Promise<Schemas['MachineCredentialIssued']> {
    wholeTenant(access, PERMISSIONS.createMachineAccount);
    const now = new Date();
    const request = machineAccountRequestOf(body as unknown as Record<string, unknown>, vietnamDateOf(now));
    const credentials = generateClientCredentials();
    const account = await this.accounts.create(scope.tx, request, credentials, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'int.machine_account_created',
      resourceType: ACCOUNT_RESOURCE,
      resourceId: account.id,
      classification: CLASSIFICATION,
      diff: { name: account.name, scopes: account.scopes, rate_limit_per_minute: account.ratePerMinute, expires_on: account.expiresOn, client_id: credentials.clientId },
    });
    await this.announce(scope, 'CREATED', account.id, account.version, now);
    return {
      operation_id: scope.requestId,
      status: account.status,
      resource_version: account.version,
      resource_id: account.id,
      account_id: account.id,
      credential_id: (account.credentials[0] as { id: string }).id,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      secret_hint: credentials.secretHint,
      shown_once: true,
      token_url: OPEN_TOKEN_URL,
    };
  }

  @Post('int/machine-accounts/:id/update')
  @HttpCode(200)
  @OperationId('updateMachineAccount')
  @Command({ operation: 'updateMachineAccount', versioned: true })
  async update(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MachineAccountUpdate']): Promise<CommandResult> {
    wholeTenant(access, PERMISSIONS.updateMachineAccount);
    const now = new Date();
    const input = body as unknown as Record<string, unknown>;
    const reason = egpReasonOf(input.reason);
    const change: { description?: string | null; scopes?: string[]; ratePerMinute?: number; expiresOn?: string | null } = {};
    if (input.description !== undefined) change.description = input.description === null ? null : machineAccountRequestOf({ name: 'x', scopes: ['open.projects.read'], description: input.description }, vietnamDateOf(now)).description;
    if (input.scopes !== undefined) change.scopes = scopesOf(input.scopes);
    if (input.rate_limit_per_minute !== undefined) change.ratePerMinute = ratePerMinuteOf(input.rate_limit_per_minute);
    if (input.expires_on !== undefined) change.expiresOn = input.expires_on === null ? null : expiryOf(input.expires_on, vietnamDateOf(now));
    if (Object.keys(change).length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'change');
    const done = await this.accounts.update(scope.tx, id, scope.expectedVersion ?? 0, change, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'int.machine_account_updated',
      resourceType: ACCOUNT_RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason,
      diff: {
        scopes_from: done.before.scopes,
        scopes_to: done.row.scopes,
        rate_from: done.before.ratePerMinute,
        rate_to: done.row.ratePerMinute,
        expires_from: done.before.expiresOn,
        expires_to: done.row.expiresOn,
      },
    });
    await this.announce(scope, 'UPDATED', id, done.row.version, now);
    return commandResult(scope, done.row.status, done.row.version, id);
  }

  @Post('int/machine-accounts/:id/decision')
  @HttpCode(200)
  @OperationId('decideMachineAccount')
  @Command({ operation: 'decideMachineAccount', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MachineAccountDecision']): Promise<CommandResult> {
    wholeTenant(access, PERMISSIONS.decideMachineAccount);
    if (!isMachineAccountMove(body.decision)) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const now = new Date();
    const done = await this.accounts.decide(scope.tx, id, scope.expectedVersion ?? 0, { move: body.decision, reason: body.reason }, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'int.machine_account_decided',
      resourceType: ACCOUNT_RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason: done.row.statusReason ?? body.reason,
      diff: { decision: body.decision, from: done.before.status, to: done.row.status },
    });
    await this.announce(scope, body.decision, id, done.row.version, now);
    return commandResult(scope, done.row.status, done.row.version, id);
  }

  @Post('int/machine-accounts/:id/rotate')
  @HttpCode(200)
  @OperationId('rotateMachineCredential')
  @Command({ operation: 'rotateMachineCredential', versioned: true, withheld: ['client_secret'] })
  async rotate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MachineCredentialRotate']): Promise<Schemas['MachineCredentialIssued']> {
    wholeTenant(access, PERMISSIONS.rotateMachineCredential);
    const now = new Date();
    const reason = egpReasonOf(body.reason);
    const grace = graceHoursOf(body.grace_hours);
    const credentials = generateClientCredentials();
    const done = await this.accounts.rotate(scope.tx, id, scope.expectedVersion ?? 0, credentials, grace, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'int.machine_account_rotated',
      resourceType: ACCOUNT_RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason,
      diff: { client_id: credentials.clientId, grace_hours: grace },
    });
    await this.announce(scope, 'ROTATED', id, done.row.version, now);
    return {
      operation_id: scope.requestId,
      status: done.row.status,
      resource_version: done.row.version,
      resource_id: id,
      account_id: id,
      credential_id: done.credentialId,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      secret_hint: credentials.secretHint,
      shown_once: true,
      token_url: OPEN_TOKEN_URL,
    };
  }
}

/** The reads of the machine accounts and of the access log (INT-01, INT-02, INT-05): the whole tenant, never the secret, only its hint. */
@Controller()
export class MachineAccountReadsController {
  private readonly accounts = new MachineAccountStore();
  private readonly log = new AccessLogStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private caller(access: EffectiveAccess): { mayUpdate: boolean; mayDecide: boolean; mayRotate: boolean } {
    return {
      mayUpdate: holdsOnWholeTenant(access, PERMISSIONS.updateMachineAccount),
      mayDecide: holdsOnWholeTenant(access, PERMISSIONS.decideMachineAccount),
      mayRotate: holdsOnWholeTenant(access, PERMISSIONS.rotateMachineCredential),
    };
  }

  @Get('int/machine-accounts')
  @OperationId('listMachineAccounts')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    wholeTenant(access, PERMISSIONS.listMachineAccounts);
    const now = new Date();
    const status = queryText(query.status, 'status', 20);
    if (status !== undefined && !(MACHINE_ACCOUNT_STATUSES as readonly string[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const q = queryText(query.q, 'q');
    const request = parsePageRequest(query.limit, query.cursor);
    const filter: MachineAccountFilter = { status: status as MachineAccountFilter['status'], q };
    const caller = this.caller(access);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.accounts.list(tx, filter, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } }, now);
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const nameOf = nameLookup(await people.names(tx, shown.map((row) => row.createdBy)));
      return {
        items: shown.map((row) => machineAccountDto(row, nameOf, caller)),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
        counts: await this.accounts.counts(tx),
        scopes: OPEN_API_SCOPES.map((scope) => ({ code: scope.code, dataset_code: scope.dataset })),
        rate_limit: { min: MACHINE_RATE_MIN, max: MACHINE_RATE_MAX, default: MACHINE_RATE_DEFAULT },
        token_url: OPEN_TOKEN_URL,
        can_create: holdsOnWholeTenant(access, PERMISSIONS.createMachineAccount),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('int/machine-accounts/:id')
  @OperationId('getMachineAccount')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    wholeTenant(access, PERMISSIONS.getMachineAccount);
    const caller = this.caller(access);
    return this.database.withTenant(tenant, async (tx) => {
      const row = await this.accounts.find(tx, id, new Date());
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return machineAccountDto(row, nameLookup(await people.names(tx, [row.createdBy])), caller);
    });
  }

  @Get('int/access-log')
  @OperationId('listOpenAccessLog')
  async accessLog(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    wholeTenant(access, PERMISSIONS.listOpenAccessLog);
    const now = new Date();
    const accountText = queryText(query.account_id, 'account_id', 40);
    const accountId = accountText === undefined ? undefined : asUuid(accountText);
    if (accountText !== undefined && accountId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'account_id');
    const outcome = queryText(query.outcome, 'outcome', 30);
    if (outcome !== undefined && !(OPEN_ACCESS_OUTCOMES as readonly string[]).includes(outcome)) throw new DomainError('VALIDATION_FAILED', 422, 'outcome');
    const bound = (value: unknown, field: string): string | undefined => {
      const text = queryText(value, field, 40);
      if (text === undefined) return undefined;
      if (Number.isNaN(Date.parse(text))) throw new DomainError('VALIDATION_FAILED', 422, field);
      return new Date(text.length === 10 ? dayOf(text, field) : text).toISOString();
    };
    const from = bound(query.from, 'from');
    const to = bound(query.to, 'to');
    const request = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.log.list(tx, { accountId, outcome: outcome as OpenAccessOutcome | undefined, from, to }, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      return {
        items: shown.map(accessLogDto),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.occurredAtKey, id: last.id }) : null,
        outcomes: [...OPEN_ACCESS_OUTCOMES],
        as_of: now.toISOString(),
      };
    });
  }
}
