import {
  ANSWER_PERMISSION,
  DELIVERY_STATUS_OF,
  DomainError,
  SEND_ATTEMPTS_MAX,
  CHANNEL_UNIT_COST_VND,
  CREDENTIAL_EXPIRED_CODE,
  attachable,
  consentChannelOfAccount,
  conversationAfter,
  judgeSend,
  mayMoveDelivery,
  retryDelayMs,
  textWithLinks,
  versionConflict,
} from '@machvon/kernel';
import type { ConsentWord, MessageDraft, MessagePurpose } from '@machvon/kernel';
import { ContactConsentStore } from './contact-consent-store.ts';
import { DeliveryLimits } from './delivery-limits.ts';
import { ConversationStore } from './conversation-store.ts';
import type { ConversationRecord, ScopeOf } from './conversation-store.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
/** A send that was taken up is left alone this long: a process that dies before it records the answer leaves it to be taken up again, with the same idempotency key. */
const LEASE_MS = 5 * 60_000;

/** The template of a message to the person: what is needed to write it, and to judge whether the provider let it be used. */
export interface TemplateRow {
  id: string;
  channel: string;
  status: string;
  providerStatus: string;
  contentAst: unknown;
  variableSchema: unknown;
}

/** What goes out: the message, the account and the thread it is for, with what the dispatcher needs to ask the adapter. */
export interface DueMessage {
  id: string;
  conversationId: string;
  channelAccountId: string;
  text: string;
  /** The subject of a mail made from a template. */
  subject: string | undefined;
  attempts: number;
  /** The attempt it counts may have gone and its result was lost: ask the provider about it before sending again. */
  reconcile: boolean;
  channel: string;
  /** The external account id of the channel account: the sender identity at the provider. */
  accountId: string;
  /** The handle of the thread at the provider: where the answer goes. */
  threadId: string;
}

interface DueRow {
  id: string;
  conversation_id: string;
  channel_account_id: string;
  body_text: string;
  subject: string | null;
  purpose: MessagePurpose;
  send_attempts: number;
  template_version_id: string | null;
  claimed_at: Date | null;
  thread_id: string;
  contact_id: string;
  contact_status: string;
  channel: string;
  account_id: string;
  account_status: string;
  verified: boolean;
  window_expires_at: Date | null;
}

const dueOf = (row: DueRow, attempts: number): DueMessage => ({
  id: row.id,
  conversationId: row.conversation_id,
  channelAccountId: row.channel_account_id,
  text: row.body_text,
  subject: row.subject ?? undefined,
  attempts,
  channel: row.channel,
  accountId: row.account_id,
  threadId: row.thread_id,
  reconcile: false,
});

export type SendResult =
  | { kind: 'ACCEPTED'; providerMessageId: string }
  | { kind: 'FAILED'; failureClass: 'RETRYABLE' | 'PERMANENT'; errorCode: string; retryAfterSeconds?: number | undefined }
  | { kind: 'UNKNOWN'; errorCode: string };

interface Facts {
  conversationAccountId: string;
  accountStatus: string;
  accountVerified: boolean;
  channel: string;
  contactId: string;
  windowExpiresAt: Date | undefined;
}

/**
 * What an agent says in a conversation (ST-OMNI-005, OMNI.md 3.3): a note for the colleagues, or a message to the person on the channel the person used. The checks of a message run in a fixed order and all before the adapter is called;
 * what passes is queued, and goes out later through the dispatcher, with the checks that can change made again at the moment of sending. The conversation row is locked first, so what an agent sees and what they change are one.
 */
export class ConversationOutboundStore {
  private readonly conversations = new ConversationStore();
  private readonly consents = new ContactConsentStore();
  private readonly limits = new DeliveryLimits();

  /** The template a message names, or nothing; the controller renders it, the checks judge it. */
  async template(tx: TenantTx, id: string): Promise<TemplateRow | undefined> {
    const [row] = await tx.query<{ id: string; channel: string; status: string; provider_status: string; content_ast: unknown; variable_schema: unknown }>(
      'select id, channel, status, provider_status, content_ast, variable_schema from machvon.notification_template_version where id = $1::uuid',
      [id],
    );
    return row === undefined ? undefined : { id: row.id, channel: row.channel, status: row.status, providerStatus: row.provider_status, contentAst: row.content_ast, variableSchema: row.variable_schema };
  }

  private async facts(tx: TenantTx, conversation: ConversationRecord): Promise<Facts> {
    const [row] = await tx.query<{ status: string; verified: boolean; channel: string; window_expires_at: Date | null }>(
      `select a.status, (a.verified_at is not null) as verified, a.channel, c.window_expires_at
         from machvon.conversation c join machvon.channel_account a on a.tenant_id = c.tenant_id and a.id = c.channel_account_id where c.id = $1::uuid`,
      [conversation.id],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { conversationAccountId: conversation.channelAccountId, accountStatus: row.status, accountVerified: row.verified, channel: row.channel, contactId: conversation.contactId, windowExpiresAt: row.window_expires_at ?? undefined };
  }

  private async consentOf(tx: TenantTx, facts: Facts, purpose: MessagePurpose): Promise<ConsentWord> {
    const channel = consentChannelOfAccount(facts.channel);
    if (channel === undefined) return undefined;
    return (await this.consents.latestForContact(tx, facts.contactId, channel, purpose))?.status;
  }

  /** Whether the provider let the template be used outside the window of the person. A template that is not Active, or is for another channel, is not usable at all (422 on `template_version_id`). */
  private approvedTemplate(template: TemplateRow | undefined, accountChannel: string): boolean {
    if (template === undefined) return false;
    const channel = accountChannel === 'ZALO_OA' ? 'ZALO_ZNS' : accountChannel;
    if (template.status !== 'Active' || template.channel !== channel) throw new DomainError('VALIDATION_FAILED', 422, 'template_version_id');
    return template.providerStatus === 'PROVIDER_APPROVED';
  }

  /** The documents a message names: each must be one of the tenant (422 on the field else); an attachment must also be one that may leave and was scanned clean (422 CONTENT_CLASSIFICATION_BLOCKED). */
  private async documents(tx: TenantTx, draft: MessageDraft): Promise<Array<{ id: string; as: 'attachment' | 'link' }>> {
    const wanted = [...draft.attachmentIds.map((id) => ({ id, as: 'attachment' as const })), ...draft.links.map((link) => ({ id: link.resourceId, as: 'link' as const }))];
    if (wanted.length === 0) return [];
    const rows = await tx.query<{ id: string; classification: string; scan_status: string }>('select id, classification, scan_status from machvon.document_version where id = any($1::uuid[])', [wanted.map((item) => item.id)]);
    for (const item of wanted) {
      const found = rows.find((row) => row.id === item.id);
      if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, item.as === 'attachment' ? 'attachment_ids' : 'resource_links');
      // A link is opaque and asks the person to sign in; a file leaves the system, so what is confidential does not (BR-OMNI-07).
      if (item.as === 'attachment' && !attachable({ classification: found.classification, scanStatus: found.scan_status })) throw new DomainError('CONTENT_CLASSIFICATION_BLOCKED', 422, 'attachment_ids');
    }
    return wanted;
  }

  /**
   * Says something in the conversation. The conversation must be in the scope of the agent for the permission to answer (404 else) and not Closed (409). A note is written and nothing else happens. A message to the person must find the conversation
   * Assigned, InProgress or PendingCustomer (409 else), a contact that is not blocked, and pass the checks in order; the version of the conversation is asked only when the message moves it (Assigned or PendingCustomer to InProgress), since
   * two agents who answer at once both say something true.
   */
  async send(
    tx: TenantTx,
    scope: ScopeOf,
    id: string,
    expectedVersion: number | undefined,
    draft: MessageDraft,
    rendered: { text: string; subject?: string | undefined; template: TemplateRow | undefined },
  ): Promise<{ messageId: string; before: ConversationRecord; after: ConversationRecord; queued: boolean }> {
    await tx.query('select 1 from machvon.conversation where id = $1::uuid for update', [id]);
    const before = await this.conversations.find(tx, scope, id, ANSWER_PERMISSION);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.status === 'Closed') throw new DomainError('CONVERSATION_STATE_INVALID', 409, 'status');
    if (draft.kind === 'INTERNAL_NOTE') {
      const [note] = await tx.query<{ id: string }>(
        `insert into machvon.channel_message (tenant_id, id, conversation_id, provider_message_id, kind, content_reference, sent_at, direction, author_membership_id, classification, body_text)
         values (${TENANT}, gen_random_uuid(), $1::uuid, null, 'TEXT', 'inline', null, 'INTERNAL_NOTE', $2::uuid, 'INTERNAL', $3) returning id`,
        [id, scope.membershipId, draft.text],
      );
      return { messageId: (note as { id: string }).id, before, after: before, queued: false };
    }
    if (draft.templateVersionId !== undefined && rendered.template?.id !== draft.templateVersionId) throw new DomainError('VALIDATION_FAILED', 422, 'template_version_id');
    const next = conversationAfter(before.status, 'reply');
    const facts = await this.facts(tx, before);
    const [contact] = await tx.query<{ status: string }>('select status from machvon.contact where id = $1::uuid', [before.contactId]);
    if (contact === undefined || contact.status === 'Blocked' || contact.status === 'Merged') throw new DomainError('CONTACT_STATE_INVALID', 409, 'status');
    judgeSend({
      requestedAccountId: draft.channelAccountId,
      conversationAccountId: facts.conversationAccountId,
      accountStatus: facts.accountStatus,
      accountVerified: facts.accountVerified,
      channel: facts.channel,
      purpose: draft.purpose,
      consent: await this.consentOf(tx, facts, draft.purpose),
      windowExpiresAt: facts.windowExpiresAt,
      now: scope.now,
      approvedTemplate: this.approvedTemplate(rendered.template, facts.channel),
    });
    const documents = await this.documents(tx, draft);
    if (next !== before.status && expectedVersion !== before.version) throw versionConflict(before.version);
    const links = documents.map((document) => ({ resource_type: 'document_version', resource_id: document.id, as: document.as }));
    const [message] = await tx.query<{ id: string }>(
      `insert into machvon.channel_message
         (tenant_id, id, conversation_id, provider_message_id, kind, content_reference, sent_at, direction, author_membership_id, purpose, template_version_id, delivery_status, classification, body_text, links, next_attempt_at, subject)
       values (${TENANT}, gen_random_uuid(), $1::uuid, null, 'TEXT', 'inline', null, 'OUTBOUND', $2::uuid, $3, $4::uuid, 'Queued', 'INTERNAL', $5, $6::jsonb, $7::timestamptz, $8) returning id`,
      [id, scope.membershipId, draft.purpose, draft.templateVersionId ?? null, textWithLinks(rendered.text, documents.map((document) => document.id)), JSON.stringify(links), scope.now.toISOString(), rendered.subject ?? null],
    );
    if (next !== before.status) await tx.query('update machvon.conversation set status = $2, version = version + 1 where id = $1::uuid', [id, next]);
    const after = await this.conversations.find(tx, scope, id, ANSWER_PERMISSION);
    if (after === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { messageId: (message as { id: string }).id, before, after, queued: true };
  }

  /** Resolves or reopens a conversation (the agent who answers it, in the scope of the permission to answer): the version read goes with it, and a state that does not allow it is 409. */
  async move(tx: TenantTx, scope: ScopeOf, id: string, expectedVersion: number, action: 'resolve' | 'reopen'): Promise<{ before: ConversationRecord; after: ConversationRecord }> {
    await tx.query('select 1 from machvon.conversation where id = $1::uuid for update', [id]);
    const before = await this.conversations.find(tx, scope, id, ANSWER_PERMISSION);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const next = conversationAfter(before.status, action);
    await tx.query('update machvon.conversation set status = $2, version = version + 1 where id = $1::uuid', [id, next]);
    const after = await this.conversations.find(tx, scope, id, ANSWER_PERMISSION);
    if (after === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, after };
  }

  // ---- the sends that are due -------------------------------------------------------------------------------------------------------

  /**
   * Takes up the next message that is due, oldest first, or none. The checks that can change are made again for it (the consent may have been withdrawn, the window may have ended, the account may have been closed, the contact blocked, the
   * template retired): a message that no longer passes ends as Failed with the code of the check and is not sent, and the next one is looked at. What passes is leased for five minutes and counted as an attempt, **at this moment**: the
   * dispatcher takes up one message at a time, just before it calls the adapter, so a slow provider never lets the lease of a message it has not reached run out.
   *
   * A message whose lease ran out with the result of its attempt never recorded (the process died, or the record failed) may have gone: it is handed back as `reconcile`, unchanged and not counted, to be asked about at the provider (`retake`
   * once the provider says it has no such request), and never sent again blindly.
   */
  async claimNext(tx: TenantTx, now: Date): Promise<DueMessage | undefined> {
    for (;;) {
      const [row] = await tx.query<DueRow>(
        `select m.id, m.conversation_id, c.channel_account_id, m.body_text, m.subject, m.purpose, m.send_attempts, m.template_version_id, m.claimed_at, c.external_thread_id as thread_id, c.contact_id, k.status as contact_status, a.channel,
                a.external_account_id as account_id, a.status as account_status, (a.verified_at is not null) as verified, c.window_expires_at
           from machvon.channel_message m
           join machvon.conversation c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
           join machvon.channel_account a on a.tenant_id = c.tenant_id and a.id = c.channel_account_id
           join machvon.contact k on k.tenant_id = c.tenant_id and k.id = c.contact_id
          where m.direction = 'OUTBOUND' and m.delivery_status = 'Queued' and m.next_attempt_at <= $1::timestamptz
          order by m.next_attempt_at, m.id limit 1 for update of m skip locked`,
        [now.toISOString()],
      );
      if (row === undefined) return undefined;
      if (row.claimed_at !== null) {
        await tx.query('update machvon.channel_message set next_attempt_at = $2::timestamptz, claimed_at = $3::timestamptz where id = $1::uuid', [row.id, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString()]);
        return { ...dueOf(row, row.send_attempts), reconcile: true };
      }
      const taken = await this.takeUp(tx, row, now);
      if (taken !== undefined) return taken;
    }
  }

  /** Makes the checks again and, if the message passes, counts the attempt and leases it. Nothing when the message ended as failed or was put back for the cap or the budget. */
  private async takeUp(tx: TenantTx, row: DueRow, now: Date): Promise<DueMessage | undefined> {
    const refusal = await this.refusalAtSending(tx, row, now);
    if (refusal !== undefined) {
      await tx.query("update machvon.channel_message set delivery_status = 'Failed', error_code = $2, next_attempt_at = null, claimed_at = null where id = $1::uuid", [row.id, refusal]);
      return undefined;
    }
    // The cap and the budget of the account (BR-NOT-13) are the notifications' too: what agents say is counted with what they send, and a message that would go over waits for the next day or month.
    const limit = await this.limits.check(tx, row.channel_account_id, row.channel, 'NORMAL', now);
    if (limit.kind === 'HOLD') {
      await tx.query('update machvon.channel_message set next_attempt_at = $2::timestamptz, error_code = $3, claimed_at = null where id = $1::uuid', [row.id, limit.until.toISOString(), limit.code]);
      return undefined;
    }
    await tx.query('update machvon.channel_message set send_attempts = send_attempts + 1, next_attempt_at = $2::timestamptz, claimed_at = $3::timestamptz where id = $1::uuid', [
      row.id,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
    ]);
    // Each attempt is a send of its own for the cap and the budget: a retry costs again, on the day it is made.
    await tx.query(
      `insert into machvon.channel_message_send (tenant_id, id, message_id, attempt_no, channel_account_id, sending_at, cost)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2::int, $3::uuid, $4::timestamptz, $5::numeric)`,
      [row.id, row.send_attempts + 1, row.channel_account_id, now.toISOString(), CHANNEL_UNIT_COST_VND[row.channel] ?? 0],
    );
    return dueOf(row, row.send_attempts + 1);
  }

  /** The provider has no such request: the attempt that was lost never happened, and the message is taken up again like any other (the checks, the cap and the budget, a new attempt). Nothing when it ends as failed or is put back. */
  async retake(tx: TenantTx, message: Pick<DueMessage, 'id'>, now: Date): Promise<DueMessage | undefined> {
    const [row] = await tx.query<DueRow>(
      `select m.id, m.conversation_id, c.channel_account_id, m.body_text, m.subject, m.purpose, m.send_attempts, m.template_version_id, m.claimed_at, c.external_thread_id as thread_id, c.contact_id, k.status as contact_status, a.channel,
              a.external_account_id as account_id, a.status as account_status, (a.verified_at is not null) as verified, c.window_expires_at
         from machvon.channel_message m
         join machvon.conversation c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
         join machvon.channel_account a on a.tenant_id = c.tenant_id and a.id = c.channel_account_id
         join machvon.contact k on k.tenant_id = c.tenant_id and k.id = c.contact_id
        where m.id = $1::uuid and m.delivery_status = 'Queued' for update of m`,
      [message.id],
    );
    if (row === undefined) return undefined;
    // The attempt that was lost is over: its send is not given back (it may have cost), and the new one is counted.
    return await this.takeUp(tx, row, now);
  }

  /** What the provider says it holds for the request that was lost: the message is taken as that, with the id of the provider and the status it reached. */
  async recordFound(tx: TenantTx, message: Pick<DueMessage, 'id' | 'attempts'>, found: { providerMessageId: string; status: string }, now: Date): Promise<void> {
    if (found.status === 'FAILED') {
      await tx.query("update machvon.channel_message set delivery_status = 'Failed', error_code = 'PROVIDER_FAILED', next_attempt_at = null, claimed_at = null where id = $1::uuid and delivery_status = 'Queued' and send_attempts = $2", [message.id, message.attempts]);
      return;
    }
    const status = DELIVERY_STATUS_OF[found.status] ?? 'ProviderAccepted';
    await tx.query(
      "update machvon.channel_message set delivery_status = $2, provider_message_id = $3, sent_at = $4::timestamptz, error_code = null, next_attempt_at = null, claimed_at = null where id = $1::uuid and delivery_status = 'Queued' and send_attempts = $5",
      [message.id, status, found.providerMessageId, now.toISOString(), message.attempts],
    );
  }

  /** The code of the check a queued message no longer passes, or nothing: the same checks as when it was queued, with what is true now. */
  private async refusalAtSending(
    tx: TenantTx,
    row: { channel_account_id: string; contact_id: string; contact_status: string; channel: string; account_status: string; verified: boolean; purpose: MessagePurpose; template_version_id: string | null; window_expires_at: Date | null },
    now: Date,
  ): Promise<string | undefined> {
    if (row.contact_status === 'Blocked' || row.contact_status === 'Merged') return 'CONTACT_STATE_INVALID';
    const template = row.template_version_id === null ? undefined : await this.template(tx, row.template_version_id);
    let approved: boolean;
    try {
      approved = this.approvedTemplate(template, row.channel);
    } catch (error) {
      // A template that was retired, or changed to another channel, since the message was queued does not send it.
      if (error instanceof DomainError) return 'TEMPLATE_UNAVAILABLE';
      throw error;
    }
    try {
      judgeSend({
        requestedAccountId: row.channel_account_id,
        conversationAccountId: row.channel_account_id,
        accountStatus: row.account_status,
        accountVerified: row.verified,
        channel: row.channel,
        purpose: row.purpose,
        consent: await this.consentOf(tx, { conversationAccountId: row.channel_account_id, accountStatus: row.account_status, accountVerified: row.verified, channel: row.channel, contactId: row.contact_id, windowExpiresAt: undefined }, row.purpose),
        windowExpiresAt: row.window_expires_at ?? undefined,
        now,
        approvedTemplate: approved,
      });
      return undefined;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return error.code;
    }
  }

  /** Records what the adapter said, for the attempt that was taken up: an answer of an attempt that was taken over since (its lease ran out) changes nothing. Accepted: the provider's id and the moment. A failure the provider says is worth another try waits, up to three attempts; any other failure, and a send whose answer was lost (it may have gone: never sent again on its own), is final. */
  async recordResult(tx: TenantTx, message: Pick<DueMessage, 'id' | 'attempts' | 'channelAccountId'>, result: SendResult, now: Date): Promise<{ credentialExpired: boolean }> {
    // The provider says the credential is gone: the account stops being used until it is verified again (OMNI 3.7), as for the notifications; what waits for it is stopped at its next turn.
    let credentialExpired = false;
    if (result.kind === 'FAILED' && result.errorCode === CREDENTIAL_EXPIRED_CODE) {
      credentialExpired = (await tx.query<{ id: string }>("update machvon.channel_account set status = 'CredentialExpired', version = version + 1 where id = $1::uuid and status = 'Active' returning id", [message.channelAccountId])).length > 0;
    }
    await this.record(tx, message, result, now);
    return { credentialExpired };
  }

  private async record(tx: TenantTx, message: Pick<DueMessage, 'id' | 'attempts'>, result: SendResult, now: Date): Promise<void> {
    if (result.kind === 'ACCEPTED') {
      await tx.query("update machvon.channel_message set delivery_status = 'ProviderAccepted', provider_message_id = $2, sent_at = $3::timestamptz, error_code = null, next_attempt_at = null, claimed_at = null where id = $1::uuid and delivery_status = 'Queued' and send_attempts = $4", [message.id, result.providerMessageId, now.toISOString(), message.attempts]);
      return;
    }
    if (result.kind === 'FAILED' && result.failureClass === 'RETRYABLE' && message.attempts < SEND_ATTEMPTS_MAX) {
      const wait = Math.max(retryDelayMs(message.attempts), (result.retryAfterSeconds ?? 0) * 1000);
      await tx.query("update machvon.channel_message set error_code = $2, next_attempt_at = $3::timestamptz, claimed_at = null where id = $1::uuid and delivery_status = 'Queued' and send_attempts = $4", [message.id, result.errorCode, new Date(now.getTime() + wait).toISOString(), message.attempts]);
      return;
    }
    await tx.query("update machvon.channel_message set delivery_status = 'Failed', error_code = $2, next_attempt_at = null, claimed_at = null where id = $1::uuid and delivery_status = 'Queued' and send_attempts = $3", [message.id, result.errorCode, message.attempts]);
  }

  /** Puts a message back for later without counting the attempt or its send: the channel is closed for the moment (the sending hours of a text). */
  async defer(tx: TenantTx, messageId: string, until: Date): Promise<void> {
    // The send that was counted when the message was taken up did not happen: it gives back its place under the cap and the budget.
    await tx.query('delete from machvon.channel_message_send where message_id = $1::uuid and attempt_no = (select send_attempts from machvon.channel_message where id = $1::uuid)', [messageId]);
    await tx.query("update machvon.channel_message set send_attempts = greatest(send_attempts - 1, 0), next_attempt_at = $2::timestamptz, claimed_at = null where id = $1::uuid and delivery_status = 'Queued'", [messageId, until.toISOString()]);
  }

  /** Ends a message that cannot be sent at all (no adapter for its channel): Failed with the reason, as a suppressed send. */
  async suppress(tx: TenantTx, messageId: string, reason: string): Promise<void> {
    // The send that was counted when the message was taken up did not happen: it gives back its place under the cap and the budget.
    await tx.query('delete from machvon.channel_message_send where message_id = $1::uuid and attempt_no = (select send_attempts from machvon.channel_message where id = $1::uuid)', [messageId]);
    await tx.query("update machvon.channel_message set delivery_status = 'Failed', error_code = $2, next_attempt_at = null, claimed_at = null where id = $1::uuid and delivery_status = 'Queued'", [messageId, reason]);
  }

  /**
   * A receipt of the provider for a message of a conversation: the status moves forward only (a late receipt can not undo a later one). Returns what became of it: `APPLIED`, `IGNORED` (the message is there, the receipt is not later than what it
   * knows) or `UNKNOWN` (no message of the account has that id: the receipt is for something else).
   */
  async applyReceipt(tx: TenantTx, channelAccountId: string, providerMessageId: string, status: string): Promise<'APPLIED' | 'IGNORED' | 'UNKNOWN'> {
    const [row] = await tx.query<{ id: string; delivery_status: string }>(
      `select m.id, m.delivery_status from machvon.channel_message m join machvon.conversation c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
        where c.channel_account_id = $1::uuid and m.direction = 'OUTBOUND' and m.provider_message_id = $2 for update of m`,
      [channelAccountId, providerMessageId],
    );
    if (row === undefined) return 'UNKNOWN';
    const next = DELIVERY_STATUS_OF[status];
    if (next === undefined || !mayMoveDelivery(row.delivery_status, next)) return 'IGNORED';
    await tx.query('update machvon.channel_message set delivery_status = $2 where id = $1::uuid', [row.id, next]);
    return 'APPLIED';
  }
}
