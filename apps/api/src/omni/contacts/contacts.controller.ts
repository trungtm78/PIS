import { randomInt } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ContactStore, TenantDatabase } from '@machvon/db';
import type { ContactRecord, IdentityRecord } from '@machvon/db';
import {
  DomainError,
  OTP_CHANNELS,
  OTP_TTL_MS,
  assertContactDraft,
  assertMergeRequest,
  assertVerification,
  generateOtp,
  identityHash,
  isIdentityChannel,
  judgeOtp,
  maskIdentity,
  normaliseIdentity,
  otpHashOf,
} from '@machvon/kernel';
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
import { IDENTITY_OTP_SENDER } from './identity-otp';
import type { IdentityOtpSender } from './identity-otp';

const CONTACT_RESOURCE = 'contact';
const MERGED_EVENT = 'omni.contact.merged.v1';
const MERGE_PERMISSION = PERMISSIONS.mergeContacts;
const MANAGE_PERMISSION = PERMISSIONS.createContact;
const READ_PERMISSION = PERMISSIONS.get_resources_contact;

/** The directory is the tenant's, not a unit's (a contact has no unit): who reads or changes it holds the permission on the whole tenant, as for the channel accounts. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

const identityView = (identity: IdentityRecord): Schemas['ContactView']['identities'][number] => ({
  id: identity.id,
  contact_id: identity.contactId,
  channel: identity.channel,
  masked: identity.masked,
  status: identity.status,
  verification_method: identity.verificationMethod,
  verified_at: identity.verifiedAt,
  created_at: identity.createdAt,
  version: identity.version,
});

/** A contact as it may be shown: the identities masked, the merge it went through, and no hash, no value and no code. */
function viewOf(contact: ContactRecord): Schemas['ContactView'] {
  return {
    id: contact.id,
    display_name: contact.displayName,
    classification: contact.classification,
    status: contact.status,
    preferred_channel: contact.preferredChannel,
    merged_into_id: contact.mergedIntoId,
    identities: contact.identities.map(identityView),
    merge_candidates: contact.mergeCandidates.map((candidate) => ({ contact_id: candidate.contactId, display_name: candidate.displayName, identity_id: candidate.identityId })),
    created_at: contact.createdAt,
    version: contact.version,
  };
}

/**
 * The contact directory (ST-OMNI-002, OMNI-03, OMNI.md 3.5, BR-OMNI-05): contacts are made, given identities (a phone number, an address, a Zalo or WhatsApp id) that are verified by a code, by the provider that authenticates the sender, or by a
 * document, and merged only on a verified identity they share, never by name. The directory is the tenant's: a contact is not a unit's. An identity is kept as a hash and a masked copy; what is shown is the copy.
 */
@Controller()
export class ContactsController {
  private readonly contacts = new ContactStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(IDENTITY_OTP_SENDER) private readonly sender: IdentityOtpSender,
  ) {}

  @Get('resources/contact')
  @OperationId('get_resources_contact')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['ContactPage']> {
    assertHolds(access, READ_PERMISSION);
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.contacts.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(viewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
  }

  @Get('resources/contact/:id')
  @OperationId('get_resources_contact_id')
  async read(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['ContactView']> {
    assertHolds(access, READ_PERMISSION);
    return viewOf(await this.database.withTenant(tenant, (tx) => this.contacts.require(tx, id.toLowerCase())));
  }

  @Post('contacts')
  @HttpCode(201)
  @OperationId('createContact')
  @Command({ operation: 'createContact' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['ContactCreate']): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const made = await this.contacts.create(scope.tx, assertContactDraft(body));
    await scope.audit({
      action: 'contact.created',
      resourceType: CONTACT_RESOURCE,
      resourceId: made.id,
      classification: 'PERSONAL',
      // The class and the preferred channel; the name of the person is in the directory and not in the trail.
      diff: { classification: made.classification, preferred_channel: made.preferredChannel },
    });
    return commandResult(scope, made.status.toUpperCase(), made.version, made.id);
  }

  @Post('contacts/:contactId/identities')
  @HttpCode(201)
  @OperationId('addContactIdentity')
  @Command({ operation: 'addContactIdentity' })
  async addIdentity(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('contactId', ParseUUIDPipe) contactId: string, @Body() body: Schemas['ContactIdentityAdd']): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    if (!isIdentityChannel(body.channel)) throw new DomainError('VALIDATION_FAILED', 422, 'channel');
    const normalised = normaliseIdentity(body.channel, body.external_id);
    const outcome = await this.contacts.addIdentity(scope.tx, contactId.toLowerCase(), { channel: body.channel, hash: identityHash(normalised), masked: maskIdentity(body.channel, normalised) });
    let sent = false;
    // A code goes out for an identity that waits for one, on a channel that can carry it, where a sender is configured; after the commit, so a refusal sends nothing.
    if (outcome.kind !== 'UNCHANGED' && outcome.identity.status === 'Pending' && OTP_CHANNELS.has(body.channel) && this.sender.configured) {
      const otp = generateOtp(randomInt);
      await this.contacts.setOtp(scope.tx, outcome.identity.id, otpHashOf(outcome.identity.id, otp), new Date(Date.now() + OTP_TTL_MS));
      const channel = body.channel as 'PHONE' | 'EMAIL';
      scope.afterCommit(() => this.sender.send({ channel, destination: normalised, otp }));
      sent = true;
    }
    await scope.audit({
      action: 'contact.identity_added',
      resourceType: CONTACT_RESOURCE,
      resourceId: contactId.toLowerCase(),
      classification: 'PERSONAL',
      diff: { channel: body.channel, masked: outcome.identity.masked, outcome: outcome.kind, code_sent: sent },
    });
    const identity = await this.contacts.requireIdentity(scope.tx, outcome.identity.id);
    return commandResult(scope, identity.status.toUpperCase(), identity.version, identity.id);
  }

  @Post('contacts/:contactId/identities/:identityId/verify')
  @HttpCode(200)
  @OperationId('verifyContactIdentity')
  @Command({ operation: 'verifyContactIdentity', versioned: true })
  async verify(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Param('identityId', ParseUUIDPipe) identityId: string,
    @Body() body: Schemas['IdentityVerify'],
  ): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const verification = assertVerification(body);
    const now = new Date();
    const contact = await this.contacts.lock(scope.tx, contactId.toLowerCase());
    if (contact.status === 'Merged' || contact.status === 'Blocked') throw new DomainError('CONTACT_STATE_INVALID', 409, 'status');
    const { identity, otp } = await this.contacts.lockOtp(scope.tx, contact.id, identityId.toLowerCase());
    if (identity.version !== (scope.expectedVersion ?? 0)) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: identity.version } });
    if (identity.status !== 'Pending') throw new DomainError('CONTACT_STATE_INVALID', 409, 'status');
    if (verification.method === 'OTP' && !OTP_CHANNELS.has(identity.channel)) throw new DomainError('VALIDATION_FAILED', 422, 'method');
    // The provider's word is written by the processing of the inbound messages of the channel that authenticates the sender (ST-OMNI-004), never by a person who says so: it is no way to verify through this operation.
    if (verification.method === 'PROVIDER_VERIFIED') throw new DomainError('VALIDATION_FAILED', 422, 'method');
    // A document stands for the identity only when a supervisor has seen it: whoever may merge contacts.
    if (verification.method === 'ADMIN_DOCUMENT') assertHolds(access, MERGE_PERMISSION);
    if (verification.method === 'OTP') {
      const verdict = judgeOtp(otp, verification.otp as string, identity.id, now);
      if (verdict.kind !== 'OK') {
        // The failure is a record: it is committed (the wrong codes are counted, the lock is set), with the trail, and the answer is the refusal.
        if (verdict.kind === 'INVALID') await this.contacts.recordOtpFailure(scope.tx, identity.id, verdict.failures, verdict.lockedUntil, now);
        const lockedUntil = verdict.kind === 'LOCKED' ? verdict.until : verdict.lockedUntil;
        await scope.audit({
          action: 'contact.identity_verification_failed',
          resourceType: CONTACT_RESOURCE,
          resourceId: contact.id,
          classification: 'PERSONAL',
          diff: { channel: identity.channel, masked: identity.masked, locked: lockedUntil !== undefined },
        });
        scope.refuseAfterCommit(new DomainError('OTP_INVALID', 422, 'otp', lockedUntil === undefined ? undefined : { extensions: { locked_until: lockedUntil.toISOString() } }));
        return commandResult(scope, 'REFUSED', identity.version, identity.id);
      }
    }
    const verified = await this.contacts.markVerified(scope.tx, contact.id, identity.id, { method: verification.method, by: scope.tenant.membershipId, at: now, ref: verification.documentRef });
    await scope.audit({
      action: 'contact.identity_verified',
      resourceType: CONTACT_RESOURCE,
      resourceId: contact.id,
      classification: 'PERSONAL',
      // The method and the reference of the document; the identity is the masked copy.
      diff: { channel: verified.channel, masked: verified.masked, method: verification.method, document_ref: verification.documentRef ?? null },
    });
    return commandResult(scope, verified.status.toUpperCase(), verified.version, verified.id);
  }

  @Post('contacts/merges')
  @HttpCode(200)
  @OperationId('mergeContacts')
  @Command({ operation: 'mergeContacts' })
  async merge(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['ContactMerge']): Promise<CommandResult> {
    assertHolds(access, MERGE_PERMISSION);
    const request = assertMergeRequest(body);
    const outcome = await this.contacts.merge(scope.tx, request);
    const shared = outcome.survivor.identities.find((identity) => identity.id === request.identityId) ?? outcome.merged.identities.find((identity) => identity.id === request.identityId);
    await scope.audit({
      action: 'contact.merged',
      resourceType: CONTACT_RESOURCE,
      resourceId: outcome.survivor.id,
      reason: request.reason,
      classification: 'PERSONAL',
      // The two contacts, the identity that joins them (the masked copy) and what moved: the trail that lets a merge be explained, and, in R3, undone.
      diff: {
        survivor_contact_id: outcome.survivor.id,
        merged_contact_id: outcome.merged.id,
        shared_identity_id: request.identityId,
        shared_identity_masked: shared?.masked ?? null,
        moved_conversations: outcome.movedConversations,
      },
    });
    await scope.emit({
      aggregateType: CONTACT_RESOURCE,
      aggregateId: outcome.survivor.id,
      aggregateVersion: outcome.survivor.version,
      type: MERGED_EVENT,
      schemaVersion: 1,
      payload: { survivor_contact_id: outcome.survivor.id, merged_contact_id: outcome.merged.id, moved_conversations: outcome.movedConversations },
      eventKey: `${MERGED_EVENT}:${outcome.merged.id}`,
    });
    return commandResult(scope, 'MERGED', outcome.survivor.version, outcome.survivor.id);
  }
}
