import { createHash, randomUUID } from 'node:crypto';
import { loadSelectionFacts, tenantOfDomain } from '@machvon/db';
import type { AuditWriter, ControlDatabase, IdempotencyStore, SelectionFacts, StoredResponse, TenantDatabase, UserSessionStore } from '@machvon/db';
import { DomainError, normalizeHostname } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import type { TenantTokenIssuer } from '../auth/tenant-token-issuer';
import type { VerifiedIdentity } from '../auth/token-verifier';
import { checkAssurance, checkMembership, modeOfTenant } from './selection-rules';
import type { SessionMode } from './selection-rules';
import type { UserSessionDenyList } from './user-session-deny-list';

export const SELECT_TENANT_OPERATION = 'selectTenantContext';
const REVOKE_REASON_SWITCHED = 'TENANT_SWITCHED';
const RETRY_AFTER_SECONDS = '2';
// Refusals that name a membership of the caller are audited as DENIED in the tenant they asked for.
const AUDITED_DENIALS: ReadonlySet<string> = new Set(['MEMBERSHIP_INACTIVE', 'TENANT_SUSPENDED', 'MFA_REQUIRED']);

export interface SelectTenantRequest {
  identity: VerifiedIdentity;
  userAccountId: string;
  tenantId: string;
  membershipId: string;
  keyHash: string;
  requestHash: string;
  ipHash: string;
  userAgentSummary: string;
  correlationId: string;
  /** The hostname the sign-in page was opened on, if the caller says so (`X-Tenant-Host`). */
  host?: string;
}

/** The answer to a tenant selection: the SessionContext of the contract plus the token the caller uses from now on. */
export interface SessionContextView {
  tenant_id: string;
  membership_id: string;
  scope_version: number;
  assurance_level: 'aal1' | 'aal2';
  expires_at: string;
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  mode: SessionMode;
}

/** One membership the chooser (IAM-04) offers: the tenant it belongs to and the state of both. */
export interface TenantSelectionCandidateView {
  tenant_id: string;
  tenant_name: string;
  tenant_status: string;
  membership_id: string;
  membership_type: string;
  status: string;
  valid_from: string;
  valid_until: string | null;
  /** The tenant of the verified domain the sign-in was opened on (it gives no right: the membership does). */
  preselected?: boolean;
}

export interface SelectTenantOutcome {
  body: SessionContextView;
  /** True when the stored result of an earlier identical request was used. */
  replayed: boolean;
}

/** What the idempotency record keeps of a selection: facts, never the access token (a bearer secret). */
interface StoredSelection {
  tenant_id: string;
  membership_id: string;
  scope_version: number;
  assurance_level: 'aal1' | 'aal2';
  mode: SessionMode;
  session_id: string;
}

interface MembershipOfUser {
  tenant_id: string;
  membership_id: string;
  status: string;
  valid_from: Date;
  valid_until: Date | null;
  tenant_status: string;
}

export interface SelectTenantServiceOptions {
  control: ControlDatabase;
  tenants: TenantDatabase;
  sessions: UserSessionStore;
  idempotency: IdempotencyStore;
  audit: AuditWriter;
  issuer: TenantTokenIssuer;
  denyList: UserSessionDenyList;
  metrics?: MetricsSink;
  now?: () => Date;
}

function isStored(value: unknown): value is StoredSelection {
  return typeof value === 'object' && value !== null && typeof (value as StoredSelection).session_id === 'string';
}

function inProgress(): DomainError {
  return new DomainError('IDEMPOTENCY_IN_PROGRESS', 409, undefined, { headers: { 'Retry-After': RETRY_AFTER_SECONDS } });
}

/**
 * selectTenantContext (IAM 3.2): the person, authenticated by the identity provider, chooses one of their
 * memberships; the answer is a tenant token bound to a `user_session` row and to the database scope version.
 * Order of checks: the membership belongs to the caller, it is Active and inside its validity, the tenant can be
 * entered, and a second factor where the roles require one. Selecting another tenant revokes the sessions that
 * the same identity-provider session holds elsewhere, at once. The command runs here, not through the command
 * interceptor, because no tenant principal exists yet: the idempotency record is begun under the tenant asked for
 * after the membership has been validated, and completed in the transaction that binds the session.
 */
export class SelectTenantService {
  private readonly now: () => Date;

  constructor(private readonly options: SelectTenantServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Every membership of the person, with the tenant's name and state; ordered by tenant name and membership id. */
  async candidates(userAccountId: string, host?: string): Promise<TenantSelectionCandidateView[]> {
    const preselected = await this.tenantOfHost(host);
    const rows = await this.options.control.withControl((tx) =>
      tx.query<{ tenant_id: string; tenant_name: string; tenant_status: string; membership_id: string; membership_type: string; status: string; valid_from: Date; valid_until: Date | null }>(
        `select tenant_id, tenant_name, tenant_status, membership_id, membership_type, status, valid_from, valid_until
           from machvon.memberships_of_user($1::uuid)
          order by tenant_name, membership_id`,
        [userAccountId],
      ),
    );
    return rows.map((row) => ({
      tenant_id: row.tenant_id,
      tenant_name: row.tenant_name,
      tenant_status: row.tenant_status,
      membership_id: row.membership_id,
      membership_type: row.membership_type,
      status: row.status,
      valid_from: row.valid_from.toISOString(),
      valid_until: row.valid_until === null ? null : row.valid_until.toISOString(),
      ...(preselected === undefined ? {} : { preselected: row.tenant_id === preselected }),
    }));
  }

  /** The tenant that a hostname chooses at sign-in, or undefined for a hostname nobody has proved (the platform's own, or one that is not a hostname at all). */
  private async tenantOfHost(host: string | undefined): Promise<string | undefined> {
    const name = host === undefined ? undefined : normalizeHostname(host);
    if (name === undefined) return undefined;
    return this.options.control.withControl((tx) => tenantOfDomain(tx, name));
  }

  async select(request: SelectTenantRequest): Promise<SelectTenantOutcome> {
    try {
      const outcome = await this.run(request);
      this.options.metrics?.increment('tenant_selection_total', { mode: outcome.body.mode });
      return outcome;
    } catch (error) {
      if (error instanceof DomainError) this.options.metrics?.increment('tenant_selection_failures_total', { code: error.code });
      throw error;
    }
  }

  private async run(request: SelectTenantRequest): Promise<SelectTenantOutcome> {
    const { control } = this.options;
    const candidates = await control.withControl((tx) =>
      tx.query<MembershipOfUser>('select tenant_id, membership_id, status, valid_from, valid_until, tenant_status from machvon.memberships_of_user($1::uuid)', [request.userAccountId]),
    );
    // A domain chooses the tenant the sign-in starts from: on the domain of one tenant, another is refused with the answer a membership that is not the caller's gets.
    const hostTenant = await this.tenantOfHost(request.host);
    if (hostTenant !== undefined && hostTenant !== request.tenantId) throw new DomainError('TENANT_SELECTION_INVALID', 403);
    // A membership of someone else and one that does not exist are the same answer, and the answer names no tenant.
    const chosen = candidates.find((candidate) => candidate.membership_id === request.membershipId && candidate.tenant_id === request.tenantId);
    if (chosen === undefined) throw new DomainError('TENANT_SELECTION_INVALID', 403);

    const ctx: TenantContext = { tenantId: request.tenantId, membershipId: request.membershipId, scopeVersion: 0 };
    const ids = { requestId: randomUUID(), correlationId: request.correlationId };
    const now = this.now();
    const mode = await this.denyAudited(ctx, ids, async () => {
      checkMembership({ status: chosen.status, insideValidity: chosen.valid_from <= now && (chosen.valid_until === null || now < chosen.valid_until) });
      const accessPolicy = chosen.tenant_status === 'Suspended' ? await this.accessPolicyOf(request.tenantId) : undefined;
      return modeOfTenant({ status: chosen.tenant_status, accessPolicy });
    });

    // Everything that follows reads and writes the sessions of one identity-provider session: one selection at a time per
    // identity-provider session, on every API node, so two selections cannot revoke each other.
    return this.withIdpSessionLock(request.identity.sessionId, () => this.complete(request, ctx, ids, mode, candidates));
  }

  private async complete(
    request: SelectTenantRequest,
    ctx: TenantContext,
    ids: { requestId: string; correlationId: string },
    mode: SessionMode,
    candidates: readonly MembershipOfUser[],
  ): Promise<SelectTenantOutcome> {
    // The key belongs to the login that sent it: another login reusing the same key must not receive this one's token.
    const keyHash = createHash('sha256').update(`${request.keyHash}:${request.identity.sessionId}`).digest('hex');
    const begin = await this.options.idempotency.begin(ctx, { operation: SELECT_TENANT_OPERATION, keyHash, requestHash: request.requestHash, ttl: 'standard' });
    switch (begin.kind) {
      case 'conflict':
        throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
      case 'in_progress':
        throw inProgress();
      case 'replay': {
        if (begin.response.kind === 'problem') {
          const { code, status, detail, extensions } = begin.response;
          throw new DomainError(code, status, detail, { extensions, headers: { 'Idempotency-Replayed': 'true' } });
        }
        if (!isStored(begin.response.body)) throw new Error('stored tenant selection is malformed');
        // The answer is rebuilt from the facts of now: the tenant may have been suspended, the scope version raised, the
        // assurance of this identity may be lower, and a newer selection may have retired the stored session.
        const current = await this.currentFacts(ctx, request, ids);
        if (await this.options.sessions.isRevoked(ctx, begin.response.body.session_id)) throw new DomainError('SESSION_EXPIRED', 401);
        return { body: await this.view(request, { ...begin.response.body, mode, scope_version: current.scopeVersion }), replayed: true };
      }
      case 'started':
        break;
    }

    let ownsRecord = true;
    let retired: string | undefined;
    try {
      const stored = await this.options.tenants.withTenant(ctx, async (tx) => {
        if (!(await this.options.idempotency.claimInTx(tx, begin.recordId))) {
          ownsRecord = false;
          throw inProgress();
        }
        const facts = await loadSelectionFacts(tx, request.membershipId);
        if (facts === undefined || facts.userAccountId !== request.userAccountId) throw new DomainError('TENANT_SELECTION_INVALID', 403);
        checkMembership({ status: facts.status, insideValidity: facts.insideValidity });
        checkAssurance({ roleCodes: facts.roleCodes, mfaRequiredRoles: facts.mfaRequiredRoles, assurance: request.identity.assurance });
        const session = await this.options.sessions.bindInTx(tx, ctx, {
          userAccountId: request.userAccountId,
          idpSessionId: request.identity.sessionId,
          assurance: request.identity.assurance,
          ipHash: request.ipHash,
          userAgentSummary: request.userAgentSummary,
        });
        retired = session.retiredSessionId;
        const result: StoredSelection = {
          tenant_id: request.tenantId,
          membership_id: request.membershipId,
          scope_version: facts.scopeVersion,
          assurance_level: session.assurance,
          mode,
          session_id: session.id,
        };
        await this.options.idempotency.completeInTx(tx, begin.recordId, { httpStatus: 200, response: { kind: 'success', body: result }, resourceType: 'user_session', resourceId: session.id });
        await this.options.audit.recordInTx(tx, request.membershipId, {
          action: 'session.tenant_selected',
          resourceType: 'user_session',
          resourceId: session.id,
          diff: { tenant_id: request.tenantId, membership_id: request.membershipId, mode, assurance_level: session.assurance },
          ...ids,
        });
        return result;
      });
      if (retired !== undefined) this.options.denyList.revoke(retired);
      await this.revokeElsewhere(candidates, request);
      return { body: await this.view(request, stored), replayed: false };
    } catch (error) {
      if (ownsRecord) await this.settle(ctx, begin.recordId, ids, error);
      throw error;
    }
  }

  /** Serialises work per identity-provider session with a transaction-scoped advisory lock on the control plane. */
  private withIdpSessionLock<T>(idpSessionId: string, work: () => Promise<T>): Promise<T> {
    return this.options.control.withControl(async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`idp-session:${idpSessionId}`]);
      return work();
    });
  }

  /** The membership as it is now, with the checks of a selection: validity of the membership and the assurance its roles need. */
  private currentFacts(ctx: TenantContext, request: SelectTenantRequest, ids: { requestId: string; correlationId: string }): Promise<SelectionFacts> {
    return this.denyAudited(ctx, ids, () =>
      this.options.tenants.withTenant(ctx, async (tx) => {
        const facts = await loadSelectionFacts(tx, request.membershipId);
        if (facts === undefined || facts.userAccountId !== request.userAccountId) throw new DomainError('TENANT_SELECTION_INVALID', 403);
        checkMembership({ status: facts.status, insideValidity: facts.insideValidity });
        checkAssurance({ roleCodes: facts.roleCodes, mfaRequiredRoles: facts.mfaRequiredRoles, assurance: request.identity.assurance });
        return facts;
      }),
    );
  }

  private async accessPolicyOf(tenantId: string): Promise<string | undefined> {
    const rows = await this.options.control.withControl((tx) => tx.query<{ access_policy: string }>('select access_policy from machvon.tenant_runtime($1::uuid)', [tenantId]));
    return rows[0]?.access_policy;
  }

  /** Runs a check of the caller's own membership; a 403 is written to the audit trail of that tenant as DENIED. */
  private async denyAudited<T>(ctx: TenantContext, ids: { requestId: string; correlationId: string }, check: () => Promise<T>): Promise<T> {
    try {
      return await check();
    } catch (error) {
      if (error instanceof DomainError && AUDITED_DENIALS.has(error.code)) await this.recordDenied(ctx, ids, error);
      throw error;
    }
  }

  private recordDenied(ctx: TenantContext, ids: { requestId: string; correlationId: string }, error: DomainError): Promise<string> {
    return this.options.audit.recordDenied(ctx, {
      action: 'session.tenant_selection_denied',
      resourceType: 'membership',
      resourceId: ctx.membershipId,
      diff: { code: error.code },
      ...ids,
    });
  }

  // The transaction rolled back: a definitive 4xx answer is stored and replays, anything else may be retried.
  private async settle(ctx: TenantContext, recordId: string, ids: { requestId: string; correlationId: string }, error: unknown): Promise<void> {
    const { idempotency } = this.options;
    if (error instanceof DomainError && error.status >= 400 && error.status < 500) {
      if (AUDITED_DENIALS.has(error.code)) await this.recordDenied(ctx, ids, error);
      const response: StoredResponse = { kind: 'problem', code: error.code, status: error.status, detail: error.detail, extensions: error.extensions };
      await idempotency.finishOutsideTx(ctx, recordId, { retryable: false, httpStatus: error.status, response });
    } else {
      await idempotency.finishOutsideTx(ctx, recordId, { retryable: true });
    }
  }

  /** The identity-provider session may hold live sessions in other tenants: they end now, in this process at once. */
  private async revokeElsewhere(candidates: readonly MembershipOfUser[], request: SelectTenantRequest): Promise<void> {
    const others = new Map<string, MembershipOfUser>();
    for (const candidate of candidates) if (candidate.tenant_id !== request.tenantId && !others.has(candidate.tenant_id)) others.set(candidate.tenant_id, candidate);
    for (const candidate of others.values()) {
      const other: TenantContext = { tenantId: candidate.tenant_id, membershipId: candidate.membership_id, scopeVersion: 0 };
      const revoked = await this.options.sessions.revokeIdpSession(other, request.identity.sessionId, REVOKE_REASON_SWITCHED);
      for (const sessionId of revoked) this.options.denyList.revoke(sessionId);
    }
  }

  private async view(request: SelectTenantRequest, stored: StoredSelection): Promise<SessionContextView> {
    const now = this.now();
    const tenant: TenantContext = { tenantId: stored.tenant_id, membershipId: stored.membership_id, scopeVersion: stored.scope_version };
    const issued = await this.options.issuer.issue({
      tenant,
      sessionId: stored.session_id,
      assurance: request.identity.assurance,
      aal2At: request.identity.aal2At,
      mode: stored.mode,
      now,
    });
    return {
      tenant_id: stored.tenant_id,
      membership_id: stored.membership_id,
      scope_version: stored.scope_version,
      assurance_level: request.identity.assurance,
      expires_at: new Date(now.getTime() + issued.expiresInSeconds * 1000).toISOString(),
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresInSeconds,
      mode: stored.mode,
    };
  }
}
