import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ContactConsentStore, TenantDatabase } from '@machvon/db';
import type { ConsentRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const CONSENT_RESOURCE = 'contact_consent';
const CONSENT_CHANGED_EVENT = 'not.consent.changed.v1';
const READ_PERMISSION = PERMISSIONS.get_resources_contact_consent;

type Page = { items: Array<Record<string, unknown>>; next_cursor: string | null };

/**
 * openapi.json ConsentPage item (the person's own history, NOT-17): the facts of the consent and its end. `version` is the one a withdrawal is made under
 * (`If-Match`); the evidence reference and the reason of a withdrawal stay in the database, they are not for the screen.
 */
export function consentViewOf(row: ConsentRow): Record<string, unknown> {
  return {
    id: row.id,
    channel: row.channel,
    purpose: row.purpose,
    status: row.status,
    effective_at: row.effectiveAt,
    ...(row.revokedAt === null ? {} : { revoked_at: row.revokedAt }),
    consent_text_version: row.consentTextVersion,
    version: row.version,
  };
}

/** The operator's view of a consent (`contact_consent`, an explicit allowlist): whose consent it is, and what it covers; never the evidence or the reason. */
function operatorViewOf(row: ConsentRow): Record<string, unknown> {
  return {
    id: row.id,
    subject_kind: row.subjectKind,
    subject_id: row.subjectId,
    channel: row.channel,
    purpose: row.purpose,
    status: row.status,
    effective_at: row.effectiveAt,
    revoked_at: row.revokedAt,
    consent_text_version: row.consentTextVersion,
    capture_method: row.captureMethod,
    legal_basis: row.legalBasis,
    version: row.version,
  };
}

function eventPayloadOf(row: ConsentRow, changedAt: string): Record<string, unknown> {
  return { consent_id: row.id, subject_kind: row.subjectKind, subject_id: row.subjectId, channel: row.channel, purpose: row.purpose, status: row.status, changed_at: changedAt };
}

/**
 * The consent of a person to be written to on a channel for a purpose (ST-NOT-003, NOT-17, BR-NOT-07). The person gives and withdraws their own, nobody
 * else can on their behalf; the history is append-only. A withdrawal takes effect at once: the next send checks the latest consent before it is taken up.
 */
@Controller('me/consents')
export class MyConsentsController {
  private readonly consents = new ContactConsentStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listMyConsents')
  async list(@CurrentTenant() tenant: TenantContext, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Page> {
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.consents.historyOf(tx, tenant.membershipId, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(consentViewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.effectiveKey, id: last.id }) : null };
  }

  @Post()
  @OperationId('grantMyConsent')
  @Command({ operation: 'grantMyConsent' })
  async grant(@Scope() scope: CommandScope, @Body() body: Schemas['ConsentGrant']): Promise<CommandResult> {
    const granted = await this.consents.grant(scope.tx, scope.tenant.membershipId, {
      channel: body.channel,
      purpose: body.purpose,
      consentTextVersion: body.consent_text_version.trim(),
      captureMethod: body.capture_method,
      evidenceReference: body.evidence_reference?.trim(),
    });
    await scope.audit({
      action: 'consent.granted',
      resourceType: CONSENT_RESOURCE,
      resourceId: granted.id,
      classification: 'PERSONAL',
      diff: { channel: granted.channel, purpose: granted.purpose, consent_text_version: granted.consentTextVersion, capture_method: granted.captureMethod },
    });
    await this.announce(scope, granted, granted.effectiveAt);
    return commandResult(scope, 'Granted', granted.version, granted.id);
  }

  @Post(':consentId/withdraw')
  @HttpCode(200)
  @OperationId('withdrawMyConsent')
  @Command({ operation: 'withdrawMyConsent', versioned: true })
  async withdraw(@Scope() scope: CommandScope, @Param('consentId', ParseUUIDPipe) consentId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const withdrawn = await this.consents.withdraw(scope.tx, scope.tenant.membershipId, consentId.toLowerCase(), scope.expectedVersion ?? 0, body.reason.trim());
    await scope.audit({
      action: 'consent.withdrawn',
      resourceType: CONSENT_RESOURCE,
      resourceId: withdrawn.id,
      reason: body.reason.trim(),
      classification: 'PERSONAL',
      diff: { channel: withdrawn.channel, purpose: withdrawn.purpose, consent_text_version: withdrawn.consentTextVersion },
    });
    await this.announce(scope, withdrawn, withdrawn.revokedAt ?? withdrawn.effectiveAt);
    return commandResult(scope, 'Withdrawn', withdrawn.version, withdrawn.id);
  }

  /** `not.consent.changed.v1`: whoever keeps a copy of the consent of a person (OMNI, a cache) learns that it changed. */
  private async announce(scope: CommandScope, row: ConsentRow, changedAt: string): Promise<void> {
    await scope.emit({
      aggregateType: CONSENT_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: CONSENT_CHANGED_EVENT,
      schemaVersion: 1,
      payload: eventPayloadOf(row, changedAt),
      eventKey: `${CONSENT_CHANGED_EVENT}:${row.id}:${row.version}`,
    });
  }
}

/**
 * The consents of the tenant for the operator (openapi.json get_resources_contact_consent, x-exposure dto): who has consented to what, and when it ended. The
 * evidence of a consent and the reason of a withdrawal are personal data and stay in the database. The list spans the people of every unit, so a grant on a
 * subtree sees an empty list and a 404.
 */
@Controller('resources/contact_consent')
export class ContactConsentReadsController {
  private readonly consents = new ContactConsentStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_contact_consent')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Page> {
    const request = parsePageRequest(limit, cursor);
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) return { items: [], next_cursor: null };
    const rows = await this.database.withTenant(tenant, (tx) => this.consents.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(operatorViewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.effectiveKey, id: last.id }) : null };
  }

  @Get(':id')
  @OperationId('get_resources_contact_consent_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await this.database.withTenant(tenant, (tx) => this.consents.find(tx, id.toLowerCase()));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return operatorViewOf(row);
  }
}
