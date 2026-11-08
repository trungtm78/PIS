import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import { AccessLogStore, ControlDatabase, ExportDatasetStore, MachineAccountStore, TenantDatabase, liveAccount, lookupClient } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import {
  DomainError,
  OPEN_API_SCOPE_CODES,
  asUuid,
  hashClientSecret,
  isClientId,
  isOpenApiScope,
  machineAccountLive,
  queryKeysOf,
  rateLimitError,
  verifyClientSecret,
  vietnamDateOf,
} from '@machvon/kernel';
import type { MachineRateLimiter, OpenAccessOutcome, OpenDatasetCode, TenantContext } from '@machvon/kernel';
import { bearerOf } from '../../auth/auth.guard';
import { MACHINE_AUDIENCE } from '../../auth/claims';
import { audiencesOf, checkTimes, parseJwt, verifySignature } from '../../auth/jwt';
import type { JsonWebKeySet } from '../../auth/tenant-token-issuer';

/** What the open API needs of the signer of tokens: the issuer of the tenant tokens already holds the keys (the same, published ones verify a machine token). */
export interface MachineSigner {
  issueMachine(input: { tenantId: string; accountId: string; credentialId: string; scopes: readonly string[]; now: Date; ttlSeconds?: number }): { token: string; expiresInSeconds: number };
  publicKeys(): Promise<JsonWebKeySet>;
}

export const OPEN_API_SIGNER = Symbol('OPEN_API_SIGNER');
export const OPEN_RATE_LIMITER = Symbol('OPEN_RATE_LIMITER');
export const OPEN_API_CLOCK = Symbol('OPEN_API_CLOCK');
/** Request property that the machine guard fills. */
export const MACHINE_REQUEST_KEY = 'machineContext';

const CLOCK_SKEW_SECONDS = 30;
const FOREIGN_KEY_VIOLATION = '23503';
/** Failed and successful exchanges of one client id per minute: a guess of a secret is slow, and a stolen id cannot be used to flood the endpoint. */
export const TOKEN_ATTEMPTS_PER_MINUTE = 20;
/** The answer of a hash that exists for no one: an unknown client id costs the same work as a wrong secret. */
const NO_ONE = hashClientSecret('mvs_no-one-has-this-secret-and-no-one-ever-will-0123456789');

/** Who is calling the open API: the tenant of the account, the account and credential the token was issued for, and the scopes it carries. */
export interface MachineContext {
  tenant: TenantContext;
  accountId: string;
  credentialId: string;
  scopes: readonly string[];
  ratePerMinute: number;
}

interface MachineRequest {
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  url?: string;
  query?: Record<string, unknown>;
  [MACHINE_REQUEST_KEY]?: MachineContext;
}

const invalidClient = (): DomainError => new DomainError('OPEN_CLIENT_INVALID', 401);

export interface OpenCall {
  operation: string;
  scope: string;
  dataset?: OpenDatasetCode;
}

interface LogContext {
  machine: MachineContext;
  path: string;
  queryKeys: string[];
  correlationId: string;
}

/** The path of a request as called, without the query string. */
export const pathOf = (request: MachineRequest): string => (request.originalUrl ?? request.url ?? '/').split('?')[0] as string;

/**
 * The open API for machines (INT-1): the exchange of client credentials for a short-lived token, the judging of that token on every call, and the reading of data under it. Every call of a machine, allowed or
 * refused, leaves a row in the access log (R6: audit of every read); the read and its row are one transaction, so a read that could not be logged is not given.
 */
@Injectable()
export class OpenApiService {
  private readonly accounts = new MachineAccountStore();
  private readonly log = new AccessLogStore();
  private readonly datasets = new ExportDatasetStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(OPEN_API_SIGNER) private readonly signer: MachineSigner | undefined,
    @Inject(OPEN_RATE_LIMITER) private readonly limiter: MachineRateLimiter,
    @Optional() @Inject(ControlDatabase) private readonly control?: ControlDatabase,
    @Optional() @Inject(OPEN_API_CLOCK) private readonly clock?: () => Date,
  ) {}

  private now(): Date {
    return (this.clock ?? (() => new Date()))();
  }

  private tenantOf(machine: { tenantId: string; accountId: string }): TenantContext {
    return { tenantId: machine.tenantId, membershipId: machine.accountId, scopeVersion: 0 };
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  // The token.
  // ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Client credentials grant. An unknown client, a wrong secret, a revoked or expired credential, a suspended or ended account and a suspended tenant are all answered alike (401 `OPEN_CLIENT_INVALID`, no
   * reason); the requested scopes may only narrow what the account holds. The exchange is the first row of the access log of the account (or, when refused for a known client, a row `DENIED_CLIENT`).
   */
  async token(body: unknown, request: MachineRequest, correlationId: string): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number; scope: string }> {
    if (this.signer === undefined || this.control === undefined) throw new DomainError('SIGNING_KEY_UNAVAILABLE', 503);
    const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (input.grant_type !== 'client_credentials') throw new DomainError('VALIDATION_FAILED', 422, 'grant_type');
    if (typeof input.client_secret !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'client_secret');
    if (input.scope !== undefined && typeof input.scope !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'scope');
    if (!isClientId(input.client_id)) throw invalidClient();
    const clientId = input.client_id;
    const attempts = this.limiter.consume(`token:${clientId}`, TOKEN_ATTEMPTS_PER_MINUTE);
    if (!attempts.allowed) throw rateLimitError(attempts);
    const now = this.now();
    const found = await this.control.withControl((tx) => lookupClient(tx, clientId));
    const secretOk = verifyClientSecret(input.client_secret, found?.secretHash ?? NO_ONE);
    const requested = typeof input.scope === 'string' && input.scope.trim() !== '' ? [...new Set(input.scope.trim().split(/\s+/))] : undefined;
    if (found === undefined || !secretOk) {
      if (found !== undefined) await this.logDenied({ tenantId: found.tenantId, accountId: found.accountId }, found.credentialId, 'issueOpenApiToken', null, 'DENIED_CLIENT', 401, { path: pathOf(request), queryKeys: [], correlationId });
      throw invalidClient();
    }
    const today = vietnamDateOf(now);
    const credentialLive = found.credentialRevokedAt === null && (found.credentialExpiresAt === null || found.credentialExpiresAt.getTime() > now.getTime());
    const live = credentialLive && machineAccountLive({ status: found.accountStatus, expiresOn: found.accountExpiresOn }, today) && (found.tenantStatus === null || found.tenantStatus === 'Active');
    if (!live) {
      await this.logDenied({ tenantId: found.tenantId, accountId: found.accountId }, found.credentialId, 'issueOpenApiToken', null, 'DENIED_CLIENT', 401, { path: pathOf(request), queryKeys: [], correlationId });
      throw invalidClient();
    }
    if (requested !== undefined && requested.some((scope) => !isOpenApiScope(scope) || !found.scopes.includes(scope))) {
      await this.logDenied({ tenantId: found.tenantId, accountId: found.accountId }, found.credentialId, 'issueOpenApiToken', null, 'DENIED_SCOPE', 403, { path: pathOf(request), queryKeys: [], correlationId });
      throw new DomainError('OPEN_SCOPE_DENIED', 403, 'scope');
    }
    const scopes = (requested ?? found.scopes).filter((scope) => OPEN_API_SCOPE_CODES.includes(scope)).sort();
    const issued = this.signer.issueMachine({ tenantId: found.tenantId, accountId: found.accountId, credentialId: found.credentialId, scopes, now });
    await this.database.withTenant(this.tenantOf(found), async (tx) => {
      await this.log.append(tx, { accountId: found.accountId, credentialId: found.credentialId, operation: 'issueOpenApiToken', scope: '', path: pathOf(request), queryKeys: [], outcome: 'OK', status: 200, rowCount: null, correlationId });
      await this.accounts.touch(tx, found.credentialId);
    });
    return { access_token: issued.token, token_type: 'Bearer', expires_in: issued.expiresInSeconds, scope: scopes.join(' ') };
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  // The judging of a token on every call.
  // ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Verifies the token (signature, audience, time), then judges the account and the credential as they are now, and takes a place in the rate limit of the account. */
  async authenticate(request: MachineRequest, correlationId: string): Promise<MachineContext> {
    if (this.signer === undefined) throw new DomainError('SIGNING_KEY_UNAVAILABLE', 503);
    const token = bearerOf(request.headers.authorization);
    if (token === undefined) throw invalidClient();
    const now = this.now();
    const parsed = parseJwt(token);
    const keys = (await this.signer.publicKeys()).keys.filter((key) => key.kid === parsed.keyId);
    if (!keys.some((key) => verifySignature(parsed, key))) throw invalidClient();
    checkTimes(parsed.payload, Math.floor(now.getTime() / 1000), CLOCK_SKEW_SECONDS);
    if (!audiencesOf(parsed.payload).includes(MACHINE_AUDIENCE)) throw invalidClient();
    const { tid, mac, cid, scp } = parsed.payload;
    const tenantId = asUuid(tid);
    const accountId = asUuid(mac);
    const credentialId = asUuid(cid);
    if (tenantId === undefined || accountId === undefined || credentialId === undefined || !Array.isArray(scp) || !scp.every((scope): scope is string => typeof scope === 'string')) throw invalidClient();
    const tenant = this.tenantOf({ tenantId, accountId });
    const account = await this.database.withTenant(tenant, async (tx: TenantTx) => {
      const found = await liveAccount(tx, accountId, credentialId, now);
      const runtime = await tx.query<{ access_policy: string }>('select access_policy from machvon.tenant_runtime($1::uuid)', [tenantId]);
      return { found, tenantOpen: runtime[0]?.access_policy !== 'NO_ACCESS' };
    });
    if (account.found === undefined || !account.tenantOpen || !account.found.credentialLive || !machineAccountLive({ status: account.found.status, expiresOn: account.found.expiresOn }, vietnamDateOf(now))) {
      // The token is genuine and names an account and a credential of the tenant: the refusal is a row of the log (an unknown account has no row to belong to).
      if (account.found !== undefined) await this.logDeniedKnown({ tenantId, accountId }, credentialId, { path: pathOf(request), queryKeys: queryKeysOf(request.query ?? {}), correlationId });
      throw invalidClient();
    }
    // What the token says is narrowed by what the account holds now: a scope taken away from the account stops working at once.
    const scopes = scp.filter((scope) => account.found?.scopes.includes(scope) === true);
    const machine: MachineContext = { tenant, accountId, credentialId, scopes, ratePerMinute: account.found.ratePerMinute };
    const verdict = this.limiter.consume(accountId, machine.ratePerMinute);
    if (!verdict.allowed) {
      await this.logDenied({ tenantId, accountId }, credentialId, 'rateLimited', null, 'RATE_LIMITED', 429, { path: pathOf(request), queryKeys: queryKeysOf(request.query ?? {}), correlationId });
      throw rateLimitError(verdict);
    }
    return machine;
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  // A read under a token.
  // ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Serves one read: the scope is checked first, the dataset (when the call reads one) must be open now (switched on, CERTIFIED, not past its day), the work runs under the row-level security of the tenant of the
   * account, and the access log row is written in the same transaction. A refused call leaves its row in a transaction of its own.
   */
  async serve<T>(machine: MachineContext, request: MachineRequest, correlationId: string, call: OpenCall, work: (tx: TenantTx, certifiedUntil: string | null) => Promise<{ body: T; rows: number }>): Promise<T> {
    const context: LogContext = { machine, path: pathOf(request), queryKeys: queryKeysOf(request.query ?? {}), correlationId };
    if (!machine.scopes.includes(call.scope)) {
      await this.deny(context, call, 'DENIED_SCOPE', 403);
      throw new DomainError('OPEN_SCOPE_DENIED', 403, 'scope', { extensions: { required_scope: call.scope } });
    }
    try {
      return await this.database.withTenant(machine.tenant, async (tx) => {
        let certifiedUntil: string | null = null;
        if (call.dataset !== undefined) {
          const state = (await this.datasets.state(tx, this.now())).find((row) => row.datasetCode === call.dataset);
          if (state === undefined || !state.gate.open) throw new DomainError('OPEN_DATASET_NOT_CERTIFIED', 403, 'dataset', { extensions: { reason: state?.gate.open === false ? state.gate.reason : 'DISABLED' } });
          certifiedUntil = state.certificationExpiresOn;
        }
        const { body, rows } = await work(tx, certifiedUntil);
        await this.log.append(tx, { accountId: machine.accountId, credentialId: machine.credentialId, operation: call.operation, scope: call.scope, path: context.path, queryKeys: context.queryKeys, outcome: 'OK', status: 200, rowCount: rows, correlationId });
        await this.accounts.touchCoarse(tx, machine.credentialId);
        return body;
      });
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === 'OPEN_DATASET_NOT_CERTIFIED') await this.deny(context, call, 'DENIED_DATASET', 403);
        else if (error.status === 400 || error.status === 422) await this.deny(context, call, 'INVALID_REQUEST', error.status);
      }
      throw error;
    }
  }

  /** Logs the refusal of a genuine token; a credential that is not one of the account (a forged pair of ids in a genuine token cannot occur, but the log must never turn a refusal into a failure) leaves no row. */
  private async logDeniedKnown(who: { tenantId: string; accountId: string }, credentialId: string, context: { path: string; queryKeys: string[]; correlationId: string }): Promise<void> {
    try {
      await this.logDenied(who, credentialId, 'authenticate', null, 'DENIED_CLIENT', 401, context);
    } catch (error) {
      if ((error as { code?: string }).code !== FOREIGN_KEY_VIOLATION) throw error;
    }
  }

  private async deny(context: LogContext, call: OpenCall, outcome: OpenAccessOutcome, status: number): Promise<void> {
    await this.logDenied({ tenantId: context.machine.tenant.tenantId, accountId: context.machine.accountId }, context.machine.credentialId, call.operation, call.scope, outcome, status, context);
  }

  private async logDenied(
    who: { tenantId: string; accountId: string },
    credentialId: string,
    operation: string,
    scope: string | null,
    outcome: OpenAccessOutcome,
    status: number,
    context: { path: string; queryKeys: string[]; correlationId: string },
  ): Promise<void> {
    await this.database.withTenant(this.tenantOf(who), (tx) =>
      this.log.append(tx, { accountId: who.accountId, credentialId, operation, scope: scope ?? '', path: context.path, queryKeys: context.queryKeys, outcome, status, rowCount: null, correlationId: context.correlationId }),
    );
  }
}

/** The guard of the data routes of the open API: it authenticates the token, and leaves the MachineContext for the handler. The route itself is @Public(): no session of a person reaches it, and no token of a person is accepted by it. */
@Injectable()
export class MachineAuthGuard implements CanActivate {
  constructor(@Inject(OpenApiService) private readonly service: OpenApiService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MachineRequest>();
    const correlationId = asUuid(request.headers['x-correlation-id']) ?? randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    request[MACHINE_REQUEST_KEY] = await this.service.authenticate(request, correlationId);
    return true;
  }
}

/** The MachineContext the machine guard put on the request. */
export const CurrentMachine = createParamDecorator((_data: unknown, context: ExecutionContext): MachineContext => {
  const found = context.switchToHttp().getRequest<MachineRequest>()[MACHINE_REQUEST_KEY];
  if (found === undefined) throw invalidClient();
  return found;
});
