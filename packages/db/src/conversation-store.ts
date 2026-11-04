import {
  ANSWER_PERMISSION,
  addWorkingTime,
  DomainError,
  SENDER_AUTHENTICATED_CHANNELS,
  assigneeEligible,
  consentChannelOfAccount,
  conversationAfter,
  identityChannelOfAccount,
  identityHash,
  isStopKeyword,
  maskIdentity,
  normaliseIdentity,
  routeOf,
  versionConflict,
  vietnamDateOf,
  windowExpiresAt,
  hasControlChar,
} from '@machvon/kernel';
import type { Assignment, ConversationStatus, EffectiveAccess, StoredLink } from '@machvon/kernel';
import { ContactConsentStore } from './contact-consent-store.ts';
import type { ConsentRow } from './contact-consent-store.ts';
import { ContactStore } from './contact-store.ts';
import { loadAccessIn } from './effective-access-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import { scopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { WORKER_MEMBERSHIP_ID } from './consumer-inbox.ts';
import { RoutingPolicyStore } from './routing-policy-store.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
export const READ_CONVERSATION = 'conversation.read';
export const READ_MESSAGE = 'channel_message.read';
export const ASSIGN_CONVERSATION = 'omni.conversation.assign';
const STOP_REASON = 'The contact wrote a stop word on the channel.';
/** At most this many members are listed, and the candidates are read in pages of this size, however many there are. */
const MAX_ASSIGNEES = 200;
const CANDIDATE_PAGE = 200;
/** A tenant has no more staff holding the permission than this; a scan that goes beyond it stops (the list is then the first of them by name). */
const MAX_SCANNED = 5000;

export interface ConversationRecord {
  id: string;
  channelAccountId: string;
  channel: string;
  accountName: string;
  contactId: string;
  contactName: string;
  status: ConversationStatus;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  queueUnitId: string | null;
  queueUnitName: string | null;
  lastInboundAt: string | null;
  windowExpiresAt: string | null;
  slaFirstResponseDueAt: string | null;
  slaResolutionDueAt: string | null;
  messageCount: number;
  /** The records the conversation points to: the projects, the issue it was turned into, the contracts. */
  resourceLinks: StoredLink[];
  assignedAt: string | null;
  createdAt: string;
  version: number;
  sortKey: string;
}

interface ConversationRow {
  id: string;
  channel_account_id: string;
  channel: string;
  account_name: string;
  contact_id: string;
  contact_name: string;
  status: ConversationStatus;
  priority: string;
  assignee_id: string | null;
  assignee_name: string | null;
  queue_unit_id: string | null;
  queue_unit_name: string | null;
  last_inbound_at: string | null;
  window_expires_at: string | null;
  sla_first_response_due_at: string | null;
  sla_resolution_due_at: string | null;
  message_count: string;
  resource_links: StoredLink[] | null;
  assigned_at: string | null;
  created_at: string;
  version: string;
  sort_key: string;
}

const CONVERSATION_FROM = `from machvon.conversation c
  join machvon.channel_account a on a.tenant_id = c.tenant_id and a.id = c.channel_account_id
  join machvon.contact k on k.tenant_id = c.tenant_id and k.id = c.contact_id
  left join machvon.organization_unit q on q.tenant_id = c.tenant_id and q.id = c.queue_unit_id
  left join machvon.tenant_user_directory d on d.tenant_id = c.tenant_id and d.membership_id = c.assignee_id`;

const CONVERSATION_COLUMNS = `c.id, c.channel_account_id, a.channel, a.display_name as account_name, c.contact_id, k.display_name as contact_name, c.status, c.priority, c.assignee_id, d.display_name as assignee_name,
  c.queue_unit_id, q.name as queue_unit_name, ${TIME('c.last_inbound_at')} as last_inbound_at, ${TIME('c.window_expires_at')} as window_expires_at,
  ${TIME('c.sla_first_response_due_at')} as sla_first_response_due_at, ${TIME('c.sla_resolution_due_at')} as sla_resolution_due_at,
  (select count(*) from machvon.channel_message m where m.tenant_id = c.tenant_id and m.conversation_id = c.id)::text as message_count,
  c.resource_links, ${TIME('c.assigned_at')} as assigned_at, ${TIME('c.created_at')} as created_at, c.version::text as version, ${TIME('c.created_at')} as sort_key`;

const toConversation = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  channelAccountId: row.channel_account_id,
  channel: row.channel,
  accountName: row.account_name,
  contactId: row.contact_id,
  contactName: row.contact_name,
  status: row.status,
  priority: row.priority,
  assigneeId: row.assignee_id,
  assigneeName: row.assignee_name,
  queueUnitId: row.queue_unit_id,
  queueUnitName: row.queue_unit_name,
  lastInboundAt: row.last_inbound_at,
  windowExpiresAt: row.window_expires_at,
  slaFirstResponseDueAt: row.sla_first_response_due_at,
  slaResolutionDueAt: row.sla_resolution_due_at,
  messageCount: Number(row.message_count),
  resourceLinks: row.resource_links ?? [],
  assignedAt: row.assigned_at,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

export interface MessageRecord {
  id: string;
  conversationId: string;
  direction: string;
  kind: string;
  deliveryStatus: string | null;
  authorMembershipId: string | null;
  classification: string;
  /** The text; only the read of one message carries it. */
  text: string | null;
  createdAt: string;
  sortKey: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  direction: string;
  kind: string;
  delivery_status: string | null;
  author_membership_id: string | null;
  classification: string;
  text: string | null;
  created_at: string;
  sort_key: string;
}

const MESSAGE_FROM = `from machvon.channel_message m
  join machvon.conversation c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
  left join machvon.organization_unit q on q.tenant_id = c.tenant_id and q.id = c.queue_unit_id`;
const MESSAGE_COLUMNS = (withText: boolean): string =>
  `m.id, m.conversation_id, m.direction, m.kind, m.delivery_status, m.author_membership_id, m.classification, ${withText ? 'm.body_text' : 'null::text'} as text, ${TIME('m.created_at')} as created_at, ${TIME('m.created_at')} as sort_key`;
const toMessage = (row: MessageRow): MessageRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  direction: row.direction,
  kind: row.kind,
  deliveryStatus: row.delivery_status,
  authorMembershipId: row.author_membership_id,
  classification: row.classification,
  text: row.text,
  createdAt: row.created_at,
  sortKey: row.sort_key,
});

/** What a message that came in is made of, after the adapter of the provider read it. */
export interface InboundInput {
  inboxId: string;
  channelAccountId: string;
  providerMessageId: string;
  externalThreadId: string;
  sender: { externalId: string; displayName: string | undefined };
  text: string;
  occurredAt: Date;
}

export type InboundOutcome =
  /** The message was taken in. `created` says the conversation is a new one (also when the thread had a closed one), `reopened` that a resolved one came back; `withdrawn` are the consents a stop word ended. */
  | { kind: 'RECEIVED'; conversationId: string; messageId: string; created: boolean; reopened: boolean; newContact: boolean; withdrawn: ConsentRow[] }
  /** The provider's message id was seen already: nothing changed. */
  | { kind: 'DUPLICATE'; conversationId: string }
  /** The contact is blocked: the message is not taken in. */
  | { kind: 'BLOCKED' };

export interface ScopeOf {
  access: EffectiveAccess;
  membershipId: string;
  now: Date;
}

/**
 * The conversations and the messages of the omnichannel center (ST-OMNI-004, OMNI.md 3.1, 3.2). What comes in is put into a conversation in the transaction of the inbox processor, so a message that fails leaves nothing; what is read is
 * limited to the conversations of the queues in the scope of the reader, and those assigned to them. Every query runs in the caller's tenant transaction.
 */
export class ConversationStore {
  private readonly contacts = new ContactStore();
  private readonly consents = new ContactConsentStore();
  private readonly policies = new RoutingPolicyStore();
  private readonly calendars = new WorkCalendarStore();

  // ---- what comes in ----------------------------------------------------------------------------------------------------------------

  async receiveInbound(tx: TenantTx, input: InboundInput): Promise<InboundOutcome> {
    const [account] = await tx.query<{ status: string; channel: string }>('select status, channel from machvon.channel_account where id = $1::uuid for share', [input.channelAccountId]);
    if (account === undefined) throw new DomainError('CHANNEL_ACCOUNT_UNKNOWN', 404);
    // A message for an account that is not Active is refused for the inbox to try again, or to show to an operator: the account may be verified again.
    if (account.status !== 'Active') throw new DomainError('CHANNEL_ACCOUNT_STATE_INVALID', 409, 'status');
    const identityChannel = identityChannelOfAccount(account.channel);
    if (identityChannel === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'channel');
    const normalised = normaliseIdentity(identityChannel, input.sender.externalId);
    const hash = identityHash(normalised);
    const authenticated = SENDER_AUTHENTICATED_CHANNELS.has(account.channel);

    // The same person writing twice at once is one contact: the lookup and the creation go one at a time for an identity.
    await tx.query("select pg_advisory_xact_lock(hashtext('omni-identity:' || current_setting('app.tenant_id', true) || ':' || $1 || ':' || $2))", [identityChannel, hash]);
    let contact = await this.contacts.ownerOfIdentity(tx, identityChannel, hash);
    let newContact = false;
    if (contact === undefined) {
      const name = nameOf(input.sender.displayName, maskIdentity(identityChannel, normalised));
      const made = await this.contacts.create(tx, { displayName: name, classification: 'OTHER', preferredChannel: identityChannel });
      const added = await this.contacts.addIdentity(tx, made.id, { channel: identityChannel, hash, masked: maskIdentity(identityChannel, normalised) });
      contact = { contactId: made.id, status: made.status, identityId: added.identity.id, identityStatus: 'Pending' };
      newContact = true;
    }
    if (contact.status === 'Blocked') return { kind: 'BLOCKED' };
    // The channel authenticates the sender: the id that wrote is the id it says, so the identity is verified by the provider (the signature of the webhook stands for the provider).
    if (authenticated && contact.identityStatus === 'Pending') {
      await this.contacts.markVerified(tx, contact.contactId, contact.identityId, { method: 'PROVIDER_VERIFIED', by: WORKER_MEMBERSHIP_ID, at: input.occurredAt, ref: undefined });
      contact = { ...contact, status: 'Verified', identityStatus: 'Verified' };
    }

    await tx.query("select pg_advisory_xact_lock(hashtext('omni-thread:' || current_setting('app.tenant_id', true) || ':' || $1 || ':' || $2))", [input.channelAccountId, input.externalThreadId]);
    // A message the provider sent before is one, whichever conversation of the account it went into (also one that has been closed since): the thread lookup below would not find it.
    const [seen] = await tx.query<{ conversation_id: string }>(
      `select m.conversation_id from machvon.channel_message m join machvon.conversation c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
        where c.channel_account_id = $1::uuid and m.direction = 'INBOUND' and m.provider_message_id = $2 limit 1`,
      [input.channelAccountId, input.providerMessageId],
    );
    if (seen !== undefined) return { kind: 'DUPLICATE', conversationId: seen.conversation_id };
    // The conversation of the thread is the one that is not closed: a closed one is final, and a message on its thread opens a new conversation that points to the last of them (OMNI.md 4).
    const [existing] = await tx.query<{ id: string; status: ConversationStatus; last_inbound_at: Date | null }>(
      "select id, status, last_inbound_at from machvon.conversation where channel_account_id = $1::uuid and external_thread_id = $2 and status <> 'Closed' for update",
      [input.channelAccountId, input.externalThreadId],
    );
    let conversationId: string;
    const created = existing === undefined;
    if (existing === undefined) {
      const routing = await this.routingOf(tx, account.channel, input.text, input.occurredAt);
      const [made] = await tx.query<{ id: string }>(
        `insert into machvon.conversation
           (tenant_id, id, channel_account_id, external_thread_id, verified_contact_id, resource_links, status, contact_id, previous_conversation_id, queue_unit_id, priority, routing_policy_id, sla_first_response_due_at, sla_resolution_due_at)
         values (${TENANT}, gen_random_uuid(), $1::uuid, $2, null, '[]'::jsonb, 'New', $3::uuid,
           (select p.id from machvon.conversation p where p.channel_account_id = $1::uuid and p.external_thread_id = $2 and p.status = 'Closed' order by p.created_at desc, p.id desc limit 1),
           $4::uuid, $5, $6::uuid, $7::timestamptz, $8::timestamptz) returning id`,
        [input.channelAccountId, input.externalThreadId, contact.contactId, routing.queueUnitId, routing.priority, routing.policyId, routing.firstResponseDueAt?.toISOString() ?? null, routing.resolutionDueAt?.toISOString() ?? null],
      );
      conversationId = (made as { id: string }).id;
    } else {
      conversationId = existing.id;
    }

    const [message] = await tx.query<{ id: string }>(
      `insert into machvon.channel_message (tenant_id, id, conversation_id, provider_message_id, kind, content_reference, sent_at, direction, classification, inbox_event_id, body_text)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2, 'TEXT', 'inline', $3::timestamptz, 'INBOUND', 'PERSONAL', $4::uuid, $5)
       on conflict (tenant_id, conversation_id, provider_message_id) where provider_message_id is not null do nothing returning id`,
      [conversationId, input.providerMessageId, input.occurredAt.toISOString(), input.inboxId, input.text],
    );
    if (message === undefined) return { kind: 'DUPLICATE', conversationId };

    // The conversation takes in the message: the time of the last one that came in (never earlier than one already there), the window that follows it, and the state: a customer who answers moves what waited for them.
    const last = existing?.last_inbound_at === null || existing?.last_inbound_at === undefined || existing.last_inbound_at.getTime() < input.occurredAt.getTime() ? input.occurredAt : existing.last_inbound_at;
    const window = windowExpiresAt(account.channel, last);
    const next = existing === undefined ? 'New' : conversationAfter(existing.status, 'inbound');
    const reopened = existing?.status === 'Resolved';
    await tx.query(
      `update machvon.conversation set last_inbound_at = $2::timestamptz, window_expires_at = $3::timestamptz, status = $4, contact_id = $5::uuid,
          verified_contact_id = case when $6::boolean then $5::uuid else verified_contact_id end, version = version + 1
        where id = $1::uuid`,
      [conversationId, last.toISOString(), window?.toISOString() ?? null, next, contact.contactId, contact.status === 'Verified'],
    );

    // The word that withdraws a consent ends the consents of the contact on that channel at once (BR-OMNI-03).
    const withdrawn: ConsentRow[] = [];
    const consentChannel = consentChannelOfAccount(account.channel);
    if (consentChannel !== undefined && isStopKeyword(input.text)) {
      for (const live of await this.consents.liveOfContact(tx, contact.contactId, consentChannel)) withdrawn.push(await this.consents.withdrawOfContact(tx, live.id, live.version, STOP_REASON));
    }
    return { kind: 'RECEIVED', conversationId, messageId: message.id, created, reopened, newContact, withdrawn };
  }

  /**
   * The queue, the priority and the deadlines a conversation that begins is given by the policy in force (OMNI.md 3.1 step 5, BR-OMNI-06): the first rule that fits the channel and the words of the first message gives the unit and the
   * priority, and the deadlines are counted in working time on the published calendar of the policy from the moment the message came. No policy, or no rule that fits, leaves the queue of the whole tenant; a year with no published calendar
   * leaves no deadline (the conversation is still taken in). The version of the policy is kept with the conversation.
   */
  private async routingOf(
    tx: TenantTx,
    channel: string,
    text: string,
    start: Date,
  ): Promise<{ policyId: string | null; queueUnitId: string | null; priority: string; firstResponseDueAt: Date | undefined; resolutionDueAt: Date | undefined }> {
    const policy = await this.policies.inForce(tx);
    if (policy === undefined) return { policyId: null, queueUnitId: null, priority: 'NORMAL', firstResponseDueAt: undefined, resolutionDueAt: undefined };
    const routed = routeOf(policy.rules, { channel, text });
    const year = Number(vietnamDateOf(start).slice(0, 4));
    const source = await this.calendars.source(tx, policy.calendarCode, year);
    // Each deadline is counted on its own: one that runs into a year with no published calendar has none, and the other is still given.
    const counted = (duration: { minutes?: number; hours?: number }): Date | undefined => {
      try {
        return addWorkingTime(source, start, duration);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'CALENDAR_NOT_EFFECTIVE') return undefined;
        throw error;
      }
    };
    const firstResponseDueAt = counted({ minutes: policy.firstResponseMinutes });
    const resolutionDueAt = counted({ hours: policy.resolutionHours });
    return { policyId: policy.id, queueUnitId: routed?.queueUnitId ?? null, priority: routed?.priority ?? 'NORMAL', firstResponseDueAt, resolutionDueAt };
  }

  // ---- what is read -----------------------------------------------------------------------------------------------------------------

  /** The conversations of the queues in the scope of the reader for the permission, and those assigned to them; tenant-wide readers see all. Compiled over the aliases `c` and `q`. */
  private visible(scope: ScopeOf, permission: string, first: number): { sql: string; params: unknown[] } {
    // What is assigned to a reader is theirs to read wherever its queue is; it does not widen what they may assign: the grant to assign must cover the queue itself.
    if (permission === ASSIGN_CONVERSATION) {
      const own = scopePredicate(scope.access, permission, scope.now, { unitPath: 'q.path', unitId: 'q.id' }, first);
      return { sql: own.sql, params: own.params };
    }
    const predicate = scopePredicate(scope.access, permission, scope.now, { unitPath: 'q.path', unitId: 'q.id' }, first + 1);
    if (predicate.sql === 'true') return { sql: 'true', params: [] };
    return { sql: `(c.assignee_id = $${first}::uuid or ${predicate.sql})`, params: [scope.membershipId, ...predicate.params] };
  }

  async list(
    tx: TenantTx,
    scope: ScopeOf,
    filters: { status?: string | undefined; mine?: boolean | undefined; queueUnitId?: string | undefined },
    page: { limit: number; after: { code: string; id: string } | undefined },
  ): Promise<ConversationRecord[]> {
    assertTimestampCursor(page.after?.code);
    const params: unknown[] = [filters.status ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit, filters.mine === true ? scope.membershipId : null, filters.queueUnitId ?? null];
    const visible = this.visible(scope, READ_CONVERSATION, params.length + 1);
    params.push(...visible.params);
    const rows = await tx.query<ConversationRow>(
      `select ${CONVERSATION_COLUMNS} ${CONVERSATION_FROM}
        where ${visible.sql} and ($1::text is null or c.status = $1) and ($5::uuid is null or c.assignee_id = $5::uuid) and ($6::uuid is null or c.queue_unit_id = $6::uuid)
          and ($2::timestamptz is null or (c.created_at, c.id) < ($2::timestamptz, $3::uuid))
        order by c.created_at desc, c.id desc limit $4::int`,
      params,
    );
    return rows.map(toConversation);
  }

  /** One conversation, or nothing when it is not there or not in the scope of the reader. */
  async find(tx: TenantTx, scope: ScopeOf, id: string, permission = READ_CONVERSATION): Promise<ConversationRecord | undefined> {
    const params: unknown[] = [id];
    const visible = this.visible(scope, permission, 2);
    params.push(...visible.params);
    const [row] = await tx.query<ConversationRow>(`select ${CONVERSATION_COLUMNS} ${CONVERSATION_FROM} where c.id = $1::uuid and ${visible.sql}`, params);
    return row === undefined ? undefined : toConversation(row);
  }

  async listMessages(tx: TenantTx, scope: ScopeOf, filters: { conversationId?: string | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<MessageRecord[]> {
    assertTimestampCursor(page.after?.code);
    const params: unknown[] = [filters.conversationId ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit];
    const visible = this.visible(scope, READ_MESSAGE, params.length + 1);
    params.push(...visible.params);
    // Oldest first: a conversation is read from its beginning.
    const rows = await tx.query<MessageRow>(
      `select ${MESSAGE_COLUMNS(false)} ${MESSAGE_FROM}
        where ${visible.sql} and ($1::uuid is null or m.conversation_id = $1::uuid) and ($2::timestamptz is null or (m.created_at, m.id) > ($2::timestamptz, $3::uuid))
        order by m.created_at, m.id limit $4::int`,
      params,
    );
    return rows.map(toMessage);
  }

  async findMessage(tx: TenantTx, scope: ScopeOf, id: string): Promise<MessageRecord | undefined> {
    const params: unknown[] = [id];
    const visible = this.visible(scope, READ_MESSAGE, 2);
    params.push(...visible.params);
    const [row] = await tx.query<MessageRow>(`select ${MESSAGE_COLUMNS(true)} ${MESSAGE_FROM} where m.id = $1::uuid and ${visible.sql}`, params);
    return row === undefined ? undefined : toMessage(row);
  }

  // ---- the assignment ---------------------------------------------------------------------------------------------------------------

  /**
   * Gives a conversation to a member (OMNI.md 3.2). The conversation must be in the scope of the assigner for the permission to assign (else it is not found, or 403 when they may read it); the version is the one they saw; the member must be one
   * who may be given it (422 ASSIGNEE_NOT_ELIGIBLE); a New conversation becomes Assigned, and one that is under way keeps its state (409 CONVERSATION_STATE_INVALID once it is resolved or closed). Two supervisors assigning at once: the second is
   * 409 VERSION_CONFLICT.
   */
  async assign(tx: TenantTx, scope: ScopeOf, id: string, expectedVersion: number, assignment: Assignment): Promise<{ before: ConversationRecord; after: ConversationRecord }> {
    await tx.query('select 1 from machvon.conversation where id = $1::uuid for update', [id]);
    const before = await this.find(tx, scope, id);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if ((await this.find(tx, scope, id, ASSIGN_CONVERSATION)) === undefined) throw new DomainError('SCOPE_DENIED', 403);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const next = conversationAfter(before.status, 'assign');
    const assignee = await loadAccessIn(tx, assignment.assigneeId);
    const [unit] = before.queueUnitId === null ? [] : await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [before.queueUnitId]);
    const [kind] = await tx.query<{ membership_type: string }>('select membership_type from machvon.membership where id = $1::uuid', [assignment.assigneeId]);
    if (kind?.membership_type !== 'STAFF' || !assigneeEligible(assignee, unit, scope.now)) throw new DomainError('ASSIGNEE_NOT_ELIGIBLE', 422, 'assignee_membership_id');
    await tx.query('update machvon.conversation set assignee_id = $2::uuid, assigned_at = $3::timestamptz, status = $4, version = version + 1 where id = $1::uuid', [id, assignment.assigneeId, scope.now.toISOString(), next]);
    const after = await this.find(tx, scope, id);
    if (after === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, after };
  }

  /**
   * The members a conversation can be given to: those with a grant of the permission to answer whose scope contains its queue, found by the same rule as the assignment, by name. The candidates are read a page at a time and each is judged, so the
   * members of other queues, or with a grant that has ended, never hide an eligible one behind them; at most 200 are listed.
   */
  async eligibleAssignees(
    tx: TenantTx,
    conversation: Pick<ConversationRecord, 'queueUnitId'>,
    now: Date,
    options: { pageSize?: number; limit?: number } = {},
  ): Promise<Array<{ membershipId: string; displayName: string }>> {
    const pageSize = options.pageSize ?? CANDIDATE_PAGE;
    const limit = options.limit ?? MAX_ASSIGNEES;
    const [unit] = conversation.queueUnitId === null ? [] : await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [conversation.queueUnitId]);
    const found: Array<{ membershipId: string; displayName: string }> = [];
    let after: { name: string; id: string } | undefined;
    for (let scanned = 0; scanned < MAX_SCANNED && found.length < limit; ) {
      // Those who hold the permission by name or by a wildcard that can cover it are the candidates; the rule of the assignment decides.
      const candidates = await tx.query<{ membership_id: string; display_name: string }>(
        `select d.membership_id, d.display_name
           from machvon.membership m
           join machvon.tenant_user_directory d on d.tenant_id = m.tenant_id and d.membership_id = m.id
          where m.status = 'Active' and m.membership_type = 'STAFF'
            and exists (select 1 from machvon.role_grant g join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
                         where g.tenant_id = m.tenant_id and g.membership_id = m.id and g.status = 'Active' and r.permissions && array[$1, 'omni.*', 'omni.conversation.*', '*']::text[])
            and ($2::text is null or (d.display_name, d.membership_id) > ($2::text, $3::uuid))
          order by d.display_name, d.membership_id limit $4::int`,
        [ANSWER_PERMISSION, after?.name ?? null, after?.id ?? null, pageSize],
      );
      for (const candidate of candidates) {
        if (found.length >= limit) break;
        if (assigneeEligible(await loadAccessIn(tx, candidate.membership_id), unit, now)) found.push({ membershipId: candidate.membership_id, displayName: candidate.display_name });
      }
      scanned += candidates.length;
      const last = candidates[candidates.length - 1];
      if (candidates.length < pageSize || last === undefined) break;
      after = { name: last.display_name, id: last.membership_id };
    }
    return found;
  }
}

/** The name a contact that came in is given: the one the provider gives, when it is a name; else the masked identity. */
function nameOf(given: string | undefined, fallback: string): string {
  const name = (given ?? '').normalize('NFC').trim();
  return name === '' || name.length > 120 || hasControlChar(name) ? fallback : name;
}
