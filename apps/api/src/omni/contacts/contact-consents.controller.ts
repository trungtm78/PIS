import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ContactConsentStore } from '@machvon/db';
import type { ConsentRow } from '@machvon/db';
import { DomainError, assertContactConsent } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';

const CONSENT_RESOURCE = 'contact_consent';
const CONSENT_CHANGED_EVENT = 'not.consent.changed.v1';
const MANAGE = PERMISSIONS.recordContactConsent;
const MIN_REASON = 10;
const MAX_REASON = 2000;

/** The consents of the contacts are the tenant's, like the directory they rest on: who takes or withdraws one holds the permission on the whole tenant. */
function assertHolds(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, MANAGE)) throw new DomainError('SCOPE_DENIED', 403);
}

/** `not.consent.changed.v1` for a contact: whoever keeps a copy of the consent (a cache, the notification module) learns that it changed, and for whom. */
function payloadOf(row: ConsentRow, changedAt: string): Record<string, unknown> {
  return { consent_id: row.id, subject_kind: row.subjectKind, subject_id: row.subjectId, channel: row.channel, purpose: row.purpose, status: row.status, changed_at: changedAt };
}

/**
 * The consent of the contacts outside the tenant (ST-OMNI-003, OMNI-04, OMNI.md 3.6, BR-NOT-07): taken for a channel and a purpose on a version of the terms, with the proof of how it was taken, and withdrawn with a reason. Both write one audit row
 * and one `not.consent.changed.v1`. The next message to the contact finds the latest consent (`ContactConsentStore.latestForContact`) before it is taken up, so a withdrawal is felt at once.
 */
@Controller()
export class ContactConsentsController {
  private readonly consents = new ContactConsentStore();

  @Post('contacts/:contactId/consents')
  @HttpCode(201)
  @OperationId('recordContactConsent')
  @Command({ operation: 'recordContactConsent' })
  async record(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('contactId', ParseUUIDPipe) contactId: string, @Body() body: Schemas['ConsentGrant']): Promise<CommandResult> {
    assertHolds(access);
    const granted = await this.consents.grantForContact(scope.tx, contactId.toLowerCase(), assertContactConsent(body));
    await scope.audit({
      action: 'consent.granted',
      resourceType: CONSENT_RESOURCE,
      resourceId: granted.id,
      classification: 'PERSONAL',
      // What was agreed to and how it was taken; the reference of the proof stays with the consent, not on the trail.
      diff: { subject_kind: granted.subjectKind, subject_id: granted.subjectId, channel: granted.channel, purpose: granted.purpose, consent_text_version: granted.consentTextVersion, capture_method: granted.captureMethod },
    });
    await this.announce(scope, granted, granted.effectiveAt);
    return commandResult(scope, 'Granted', granted.version, granted.id);
  }

  @Post('contact-consents/:consentId/withdraw')
  @HttpCode(200)
  @OperationId('withdrawContactConsent')
  @Command({ operation: 'withdrawContactConsent', versioned: true })
  async withdraw(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('consentId', ParseUUIDPipe) consentId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    assertHolds(access);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const withdrawn = await this.consents.withdrawOfContact(scope.tx, consentId.toLowerCase(), scope.expectedVersion ?? 0, reason);
    await scope.audit({
      action: 'consent.withdrawn',
      resourceType: CONSENT_RESOURCE,
      resourceId: withdrawn.id,
      reason,
      classification: 'PERSONAL',
      diff: { subject_kind: withdrawn.subjectKind, subject_id: withdrawn.subjectId, channel: withdrawn.channel, purpose: withdrawn.purpose, consent_text_version: withdrawn.consentTextVersion },
    });
    await this.announce(scope, withdrawn, withdrawn.revokedAt ?? withdrawn.effectiveAt);
    return commandResult(scope, 'Withdrawn', withdrawn.version, withdrawn.id);
  }

  private async announce(scope: CommandScope, row: ConsentRow, changedAt: string): Promise<void> {
    await scope.emit({
      aggregateType: CONSENT_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: CONSENT_CHANGED_EVENT,
      schemaVersion: 1,
      payload: payloadOf(row, changedAt),
      eventKey: `${CONSENT_CHANGED_EVENT}:${row.id}:${row.version}`,
    });
  }
}
