import { randomUUID } from 'node:crypto';
import { Body, Controller, Header, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditWriter, ControlDatabase, SupportAccessStore } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import type { TenantTokenIssuer } from '../../auth/tenant-token-issuer';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { principalOf } from '../../principal';
import { IdentityCommand } from '../../session/identity.guard';
import { CurrentTenant } from '../../tenant-context.decorator';

/** Where the issuer of tenant tokens is provided to the support token exchange; without it the exchange answers 503 SIGNING_KEY_UNAVAILABLE. */
export const SUPPORT_TOKEN_ISSUER = Symbol('SUPPORT_TOKEN_ISSUER');

/**
 * The exchange of a grant in force for a support token (ST-SAS-015, SAS-19). The operator, authenticated on the control plane, names the tenant and the grant; the answer is a tenant token with `act=support` that lasts
 * as long as the grant, and at most five minutes (the operator asks again). The grant must have been given to this operator, be approved by everybody it needs, not be revoked and be inside its window: otherwise
 * 403 `SCOPE_DENIED`, with a denied audit row of the tenant that names the operator. The token is returned only once the audit row of its issue is written (`support_access.token_issued`, with the operator as the impersonator),
 * and it is never kept in the record of an idempotent command: this route is not one. The token proves nothing by itself: the guard judges the grant again on every request that carries it.
 */
@Controller('support-access')
export class SupportTokenController {
  constructor(
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
    @Inject(SupportAccessStore) private readonly store: SupportAccessStore,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Optional() @Inject(SUPPORT_TOKEN_ISSUER) private readonly issuer?: TenantTokenIssuer,
  ) {}

  // Not a @Command: a command keeps its answer for the replay of its idempotency key, and this answer is a secret. The route writes its own audit rows (the gate of commands accepts the marker for such routes).
  @Post(':id/token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @OperationId('issueSupportAccessToken')
  @IdentityCommand('issueSupportAccessToken')
  async issue(
    @Req() request: { principal?: unknown; headers: Record<string, string | string[] | undefined> },
    @CurrentTenant() operator: TenantContext,
    @Param('id', ParseUUIDPipe) grantId: string,
    @Body() body: Schemas['SupportTokenRequest'],
  ): Promise<Schemas['SupportToken']> {
    const tenantId = asUuid(body?.tenant_id);
    if (tenantId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'tenant_id');
    if (this.issuer === undefined) throw new DomainError('SIGNING_KEY_UNAVAILABLE', 503);
    const principal = principalOf(request);
    const now = new Date();
    const correlationId = asUuid(request.headers['x-correlation-id']) ?? randomUUID();
    const context: TenantContext = { tenantId, membershipId: operator.membershipId, scopeVersion: 0 };
    const grant = await this.control.withTenantOf(tenantId, (tx) => this.store.liveGrant(tx, grantId, operator.membershipId, now));
    if (grant === undefined) {
      await this.audit.recordDenied(context, {
        action: 'support_access.token_denied',
        resourceType: 'support_access_grant',
        resourceId: grantId,
        diff: { reason: 'GRANT_NOT_IN_FORCE' },
        classification: 'CONFIDENTIAL',
        correlationId,
        requestId: randomUUID(),
        impersonatorId: operator.membershipId,
      });
      throw new DomainError('SCOPE_DENIED', 403);
    }
    const issued = await this.issuer.issue({
      tenant: context,
      sessionId: principal.sessionId,
      assurance: principal.assurance,
      ...(principal.aal2At === undefined ? {} : { aal2At: principal.aal2At }),
      mode: 'FULL',
      now,
      support: { grantId: grant.id, operatorId: operator.membershipId, grantEndsAt: grant.expiresAt },
    });
    await this.audit.record(context, {
      action: 'support_access.token_issued',
      resourceType: 'support_access_grant',
      resourceId: grant.id,
      diff: { expires_in: issued.expiresInSeconds, access_mode: grant.accessMode },
      classification: 'CONFIDENTIAL',
      correlationId,
      requestId: randomUUID(),
      impersonatorId: operator.membershipId,
    });
    return { access_token: issued.accessToken, token_type: 'Bearer', expires_in: issued.expiresInSeconds, grant_id: grant.id };
  }
}
