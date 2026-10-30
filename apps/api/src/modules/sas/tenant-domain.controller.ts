import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ControlDatabase, PLATFORM_DOMAIN, TenantDomainStore, actingAsTenant, tenantOfDomainId } from '@machvon/db';
import type { ApprovalEffects, DomainPorts, DomainRow } from '@machvon/db';
import { DomainError, challengeRecordName, reservedUntil } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';

/** Where the DNS lookup and the certificate authority are provided to the domain commands and the lifecycle job: the MOCK until real ones are bound. */
export const DOMAIN_PORTS = Symbol('DOMAIN_PORTS');
/** The domain the platform's own subdomains live under. */
export const PLATFORM_DOMAIN_TOKEN = Symbol('PLATFORM_DOMAIN');

export function domainView(row: DomainRow): Schemas['TenantDomain'] {
  const pending = row.kind === 'CUSTOM' && (row.status === 'PendingVerification' || row.status === 'Failed');
  return {
    id: row.id,
    hostname: row.hostname,
    kind: row.kind,
    status: row.status,
    tls_status: row.tlsStatus,
    tls_expires_at: row.tlsExpiresAt?.toISOString() ?? null,
    verified_at: row.verifiedAt?.toISOString() ?? null,
    last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
    challenge_expires_at: row.challengeExpiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    reserved_until: row.revokedAt === null ? null : reservedUntil(row.revokedAt).toISOString(),
    failure_code: row.failureCode,
    txt_record_name: pending ? challengeRecordName(row.hostname) : null,
    created_at: row.createdAt.toISOString(),
    version: row.version,
  };
}

function effectsOf(scope: CommandScope): ApprovalEffects {
  return { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
}

/**
 * The domains of a tenant (ST-SAS-017, SAS-05), on the control plane (`system.tenant.manage`; the list needs `system.tenant.read`). The commands act as the tenant while they write, audit and emit. Adding a custom domain answers the
 * TXT record the customer must publish, once; verifying looks for it in the DNS and makes the domain Verified (the lifecycle job gives it a certificate and makes it Active); removing releases the hostname for 90 days.
 * A domain gives its tenant no membership: it only chooses the tenant that the sign-in starts from.
 */
@Controller('system')
export class TenantDomainController {
  private readonly store = new TenantDomainStore();

  constructor(
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
    @Inject(DOMAIN_PORTS) private readonly ports: DomainPorts,
    @Inject(PLATFORM_DOMAIN_TOKEN) private readonly platformDomain: string = PLATFORM_DOMAIN,
  ) {}

  @Get('tenants/:tenantId/domains')
  @OperationId('listTenantDomains')
  async list(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['TenantDomainPage']> {
    const page = parsePageRequest(limit, cursor);
    if (page.after !== undefined && Number.isNaN(Date.parse(page.after.code))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const known = await this.control.withControl((tx) => tx.query<{ id: string }>('select id from machvon.tenant where id = $1::uuid', [tenantId]));
    if (known.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.control.withTenantOf(tenantId, async (tx) => {
      const rows = await this.store.list(tx, { limit: page.limit + 1, after: page.after === undefined ? undefined : { createdAt: page.after.code, id: page.after.id } });
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      return { items: shown.map(domainView), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.createdAt.toISOString(), id: last.id }) : null };
    });
  }

  @Post('tenants/:tenantId/domains')
  @HttpCode(201)
  @OperationId('addTenantDomain')
  @Command({ operation: 'addTenantDomain', plane: 'control', withheld: ['txt_record_value'] })
  async add(@Scope() scope: CommandScope, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: Schemas['DomainAdd']): Promise<Schemas['DomainChallenge']> {
    const { domain, token } = await actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, () =>
      this.store.add(scope.tx, effectsOf(scope), { tenantId, hostname: body.hostname, kind: body.kind, platformDomain: this.platformDomain }, new Date()),
    );
    return {
      domain_id: domain.id,
      txt_record_name: challengeRecordName(domain.hostname),
      // A platform subdomain needs no proof: the platform owns its DNS.
      txt_record_value: token ?? '',
      ...(domain.challengeExpiresAt === null ? {} : { expires_at: domain.challengeExpiresAt.toISOString() }),
    };
  }

  @Post('tenant-domains/:domainId/verify')
  @HttpCode(202)
  @OperationId('verifyTenantDomain')
  @Command({ operation: 'verifyTenantDomain', plane: 'control', versioned: true })
  async verify(@Scope() scope: CommandScope, @Param('domainId', ParseUUIDPipe) domainId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const tenantId = await tenantOfDomainId(scope.tx, domainId);
    if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, async () => {
      const { domain, verified } = await this.store.verify(scope.tx, effectsOf(scope), domainId, scope.expectedVersion ?? undefined, { proof: this.ports.proof }, new Date());
      void body;
      // The check and its time are kept; the answer is the refusal.
      if (!verified) scope.refuseAfterCommit(new DomainError('DOMAIN_UNVERIFIED', 422));
      return commandResult(scope, domain.status.toUpperCase(), domain.version, domain.id);
    });
  }

  @Post('tenant-domains/:domainId/remove')
  @HttpCode(200)
  @OperationId('removeTenantDomain')
  @Command({ operation: 'removeTenantDomain', plane: 'control', versioned: true })
  async remove(@Scope() scope: CommandScope, @Param('domainId', ParseUUIDPipe) domainId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const tenantId = await tenantOfDomainId(scope.tx, domainId);
    if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, async () => {
      const domain = await this.store.remove(scope.tx, effectsOf(scope), domainId, body.reason, scope.expectedVersion ?? undefined, new Date());
      return commandResult(scope, 'REVOKED', domain.version, domain.id);
    });
  }
}
