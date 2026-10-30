import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Ip, Post, Query, Res, UseGuards } from '@nestjs/common';
import { DomainError, asUuid, keyHashOf, parseIdempotencyKey, requestHashOf } from '@machvon/kernel';
import { OperationId } from '../operation-id.decorator';
import { Public } from '../public.decorator';
import { assertValidBody } from '../request-validation';
import { CurrentIdentity, IdentityCommand, IdentityGuard } from './identity.guard';
import type { IdentityContext } from './identity.guard';
import { SELECT_TENANT_OPERATION, SelectTenantService } from './select-tenant.service';
import type { SessionContextView, TenantSelectionCandidateView } from './select-tenant.service';

const MAX_USER_AGENT_LENGTH = 200;

interface TenantSelectionBody {
  tenant_id: string;
  membership_id: string;
}

/** The hash that stands in for the address of the caller in `user_session.ip_hash`. */
export function hashIp(ip: string | undefined): string {
  return createHash('sha256').update(ip ?? '').digest('hex');
}

const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= LAST_CONTROL_CODE || code === DELETE_CODE;
}

// A short, printable summary of the browser: control characters out, length bounded.
export function summaryOf(userAgent: string | undefined): string {
  const printable = Array.from(userAgent ?? '', (character) => (isControlCharacter(character) ? ' ' : character)).join('').trim();
  return printable === '' ? 'unknown' : printable.slice(0, MAX_USER_AGENT_LENGTH);
}

/**
 * POST /me/session/tenant-selection (selectTenantContext). It is not a tenant-plane route: the caller holds an
 * identity token, not a tenant token, so the authentication and policy guards skip it (@Public) and the identity
 * guard authenticates it instead.
 */
@Controller('me/session')
export class SelectTenantController {
  constructor(@Inject(SelectTenantService) private readonly service: SelectTenantService) {}

  /** GET /me/session/tenant-selection/candidates (listTenantSelectionCandidates): what the IAM-04 chooser lists. */
  @Get('tenant-selection/candidates')
  @Public()
  @UseGuards(IdentityGuard)
  @OperationId('listTenantSelectionCandidates')
  async candidates(@CurrentIdentity() who: IdentityContext, @Query('host') host?: unknown, @Headers('x-tenant-host') hostHeader?: string | string[]): Promise<{ items: TenantSelectionCandidateView[] }> {
    // The page states the host it was opened on in the header on every request; the query is the same statement for a caller that cannot set one.
    const stated = typeof host === 'string' ? host : typeof hostHeader === 'string' ? hostHeader : undefined;
    return { items: await this.service.candidates(who.userAccountId, stated) };
  }

  @Post('tenant-selection')
  @HttpCode(200)
  @Public()
  @UseGuards(IdentityGuard)
  @OperationId('selectTenantContext')
  @IdentityCommand('selectTenantContext')
  async select(
    @CurrentIdentity() who: IdentityContext,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | string[] | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('x-tenant-host') host: string | string[] | undefined,
    @Ip() ip: string | undefined,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
  ): Promise<SessionContextView> {
    const idempotencyKey = parseIdempotencyKey(key);
    assertValidBody(SELECT_TENANT_OPERATION, body);
    const request = body as TenantSelectionBody;
    const outcome = await this.service.select({
      identity: who.identity,
      userAccountId: who.userAccountId,
      tenantId: asUuidOrThrow(request.tenant_id),
      membershipId: asUuidOrThrow(request.membership_id),
      keyHash: keyHashOf(idempotencyKey),
      // The host is part of what was asked: the same key with another host is another request.
      requestHash: requestHashOf({ body, pathParams: typeof host === 'string' ? { host: host.trim().toLowerCase() } : {}, ifMatch: null }),
      ipHash: hashIp(ip),
      userAgentSummary: summaryOf(userAgent),
      correlationId: asUuid(correlation) ?? randomUUID(),
      ...(typeof host === 'string' && host.trim() !== '' ? { host } : {}),
    });
    if (outcome.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return outcome.body;
  }
}

function asUuidOrThrow(value: string): string {
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('INVALID_REQUEST', 400);
  return id;
}
