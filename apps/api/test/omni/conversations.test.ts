import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { ConversationStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { InboundInput, InboundOutcome } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ConversationsController } from '../../src/omni/conversations/conversations.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const SUPERVISOR = 1; // reads and assigns in the whole tenant
const AGENT = 2; // answers in the whole tenant, reads, does not assign
const UNIT_AGENT = 3; // answers in the unit 1 and below
const OTHER_UNIT_AGENT = 4; // answers in the unit 2 only
const NOBODY = 5; // no grant
const UNIT_SUPERVISOR = 6; // assigns in the unit 1 and below
const MIXED = 7; // reads the whole tenant, assigns in the unit 1 and below
const OTHER_TENANT_SUPERVISOR = 1; // of tenant B
const WORKER = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the conversations of the omnichannel center (ST-OMNI-004, OMNI-01, OMNI.md 3.1, 3.2)', () => {
  const harness = new AuthzHarness();
  const store = new ConversationStore();
  let app: RunningApp;
  let counter = 0;
  let emailAccount: string;
  let smsAccount: string;
  let whatsappAccount: string;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? SUPERVISOR, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function account(channel: string, name: string): Promise<string> {
    const accountId = id(0xe0, (counter += 1));
    await rows(
      `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, display_name)
       values ($1, $2, $3, $4, 'secret://t/x', 'v1', 'Active', now(), $5)`,
      [TENANT_A, accountId, channel, `ext-${accountId}`, name],
    );
    return accountId;
  }

  /** A message as the inbox processor puts it in: in the transaction of the worker. */
  const inbound = async (accountId: string, change: Partial<InboundInput> = {}): Promise<InboundOutcome> => {
    const n = (counter += 1);
    // The event is in the inbox before it is processed.
    const inboxId = randomUUID();
    await rows(
      `insert into machvon.integration_event_inbox (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id)
       values ($1, $2, 'test-provider', $3, repeat('b', 64), 'ref', now(), 'PROCESSING', 'k1')`,
      [TENANT_A, inboxId, `event-${inboxId}`],
    );
    const input: InboundInput = {
      inboxId,
      channelAccountId: accountId,
      providerMessageId: `pm-${n}`,
      externalThreadId: `thread-${n}`,
      sender: { externalId: accountId === emailAccount ? `sender${n}@example.com` : `0912${String(300_000 + n)}`, displayName: 'Nguyễn Thị Lan' },
      text: 'Tôi muốn hỏi về hồ sơ của tôi',
      occurredAt: new Date('2026-10-30T03:00:00.000Z'),
      ...change,
    };
    return (harness.tenants as TenantDatabase).withTenant(WORKER, (tx) => store.receiveInbound(tx, input));
  };
  const received = (outcome: InboundOutcome): Extract<InboundOutcome, { kind: 'RECEIVED' }> => {
    if (outcome.kind !== 'RECEIVED') throw new Error(`not received: ${outcome.kind}`);
    return outcome;
  };
  const conversation = async (conversationId: string) =>
    (await rows<{ status: string; assignee_id: string | null; version: string; window_expires_at: Date | null; contact_id: string; previous_conversation_id: string | null; queue_unit_id: string | null }>(
      'select status, assignee_id, version::text as version, window_expires_at, contact_id, previous_conversation_id, queue_unit_id from machvon.conversation where id = $1',
      [conversationId],
    ))[0];
  /** Moves a conversation along the states, as the agent's answers will (ST-OMNI-005): given to an agent, taken up, and so on. */
  async function advance(conversationId: string, ...states: string[]): Promise<void> {
    for (const state of states) {
      const set = state === 'Assigned' ? `status = 'Assigned', assignee_id = '${memberId(AGENT)}'` : `status = '${state}'`;
      await rows(`update machvon.conversation set ${set} where id = $1`, [conversationId]);
    }
  }
  const assign = (conversationId: string, assignee: number, version: number, member = SUPERVISOR, reason?: string) =>
    call('POST', `/conversations/${conversationId}/assign`, { member, ifMatch: `"${version}"`, body: { assignee_membership_id: memberId(assignee), ...(reason === undefined ? {} : { reason }) } });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(2)}/` }]);
    for (const member of [SUPERVISOR, AGENT, UNIT_AGENT, OTHER_UNIT_AGENT, NOBODY, UNIT_SUPERVISOR, MIXED]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_SUPERVISOR, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'OMNI_SUPERVISOR_TEST', ['omni.conversation.assign', 'omni.conversation.reply', 'conversation.read', 'channel_message.read'], 50);
      await harness.seedRole(tenant, 2, 'OMNI_AGENT_TEST', ['omni.conversation.reply', 'conversation.read', 'channel_message.read'], 35);
      await harness.seedRole(tenant, 3, 'OMNI_UNIT_SUPERVISOR_TEST', ['omni.conversation.assign', 'conversation.read', 'channel_message.read'], 45);
      await harness.seedRole(tenant, 4, 'OMNI_READER_TEST', ['conversation.read', 'channel_message.read'], 20);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: SUPERVISOR, role: 1, kind: 'TENANT' },
      { n: 2, member: AGENT, role: 2, kind: 'TENANT' },
      { n: 3, member: UNIT_AGENT, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
      { n: 4, member: OTHER_UNIT_AGENT, role: 2, kind: 'UNIT_ONLY', refs: [unitId(2)] },
      { n: 5, member: UNIT_SUPERVISOR, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
      { n: 6, member: MIXED, role: 4, kind: 'TENANT' },
      { n: 7, member: MIXED, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_SUPERVISOR, role: 1, kind: 'TENANT' }]);
    emailAccount = await account('EMAIL', 'Hộp thư hỗ trợ');
    smsAccount = await account('SMS', 'Đầu số hỗ trợ');
    whatsappAccount = await account('WHATSAPP', 'WhatsApp hỗ trợ');
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ConversationsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('a message that comes in', () => {
    it('AC-ST-OMNI-004-1 UAT-AC24: from someone the tenant does not know, opens a New conversation with a new contact, whose identity the provider vouches for on WhatsApp, with a window of 24 hours', async () => {
      const outcome = received(await inbound(whatsappAccount, { sender: { externalId: '84912345678', displayName: 'Trần Văn Nam' }, text: 'Xin chào' }));
      expect(outcome).toMatchObject({ created: true, reopened: false, newContact: true, withdrawn: [] });
      const row = await conversation(outcome.conversationId);
      expect(row).toMatchObject({ status: 'New', assignee_id: null, queue_unit_id: null, version: '2' });
      expect(row?.window_expires_at?.toISOString()).toBe('2026-10-31T03:00:00.000Z');
      const [contact] = await rows<{ display_name: string; status: string; classification: string }>('select display_name, status, classification from machvon.contact where id = $1', [row?.contact_id]);
      expect(contact).toEqual({ display_name: 'Trần Văn Nam', status: 'Verified', classification: 'OTHER' });
      const [identity] = await rows<{ status: string; verification_method: string; verified_by: string }>('select status, verification_method, verified_by from machvon.contact_identity where contact_id = $1', [row?.contact_id]);
      expect(identity).toEqual({ status: 'Verified', verification_method: 'PROVIDER_VERIFIED', verified_by: WORKER_MEMBERSHIP_ID });
      const [message] = await rows<{ direction: string; body_text: string; classification: string; kind: string }>('select direction, body_text, classification, kind from machvon.channel_message where id = $1', [outcome.messageId]);
      expect(message).toEqual({ direction: 'INBOUND', body_text: 'Xin chào', classification: 'PERSONAL', kind: 'TEXT' });
    });

    it('from an address a mail does not vouch for, leaves the contact Unverified and the identity Pending, with no window', async () => {
      const outcome = received(await inbound(emailAccount, { sender: { externalId: 'Lan.Nguyen@Example.com', displayName: undefined } }));
      const row = await conversation(outcome.conversationId);
      expect(row?.window_expires_at).toBeNull();
      const [contact] = await rows<{ display_name: string; status: string }>('select display_name, status from machvon.contact where id = $1', [row?.contact_id]);
      // No name given: the masked address stands in for it.
      expect(contact?.status).toBe('Unverified');
      expect(contact?.display_name).not.toContain('Lan.Nguyen');
      expect((await rows<{ status: string }>('select status from machvon.contact_identity where contact_id = $1', [row?.contact_id]))[0]?.status).toBe('Pending');
    });

    it('is one message when the provider sends it twice, and the second message of a thread goes into the same conversation, the later of the two deciding the window', async () => {
      const first = received(await inbound(whatsappAccount, { providerMessageId: 'dup-1', externalThreadId: 'thread-dup', sender: { externalId: '84900000001', displayName: 'A' } }));
      expect(await inbound(whatsappAccount, { providerMessageId: 'dup-1', externalThreadId: 'thread-dup', sender: { externalId: '84900000001', displayName: 'A' } })).toEqual({ kind: 'DUPLICATE', conversationId: first.conversationId });
      const second = received(await inbound(whatsappAccount, { providerMessageId: 'dup-2', externalThreadId: 'thread-dup', sender: { externalId: '84900000001', displayName: 'A' }, occurredAt: new Date('2026-10-30T05:00:00.000Z') }));
      expect(second).toMatchObject({ conversationId: first.conversationId, created: false, newContact: false });
      // A message that arrives late (an older time) does not bring the window back.
      received(await inbound(whatsappAccount, { providerMessageId: 'dup-3', externalThreadId: 'thread-dup', sender: { externalId: '84900000001', displayName: 'A' }, occurredAt: new Date('2026-10-30T01:00:00.000Z') }));
      expect((await conversation(first.conversationId))?.window_expires_at?.toISOString()).toBe('2026-10-31T05:00:00.000Z');
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.channel_message where conversation_id = $1', [first.conversationId]))[0]?.n).toBe('3');
    });

    it('from a person the directory already knows goes to that contact, also when the contact was merged into another', async () => {
      const first = received(await inbound(whatsappAccount, { sender: { externalId: '84900000002', displayName: 'B' } }));
      const [firstConversation] = await rows<{ contact_id: string }>('select contact_id from machvon.conversation where id = $1', [first.conversationId]);
      const again = received(await inbound(whatsappAccount, { sender: { externalId: '+84 900 000 002', displayName: 'Another name' } }));
      expect(again.newContact).toBe(false);
      expect((await conversation(again.conversationId))?.contact_id).toBe(firstConversation?.contact_id);
      // The contact is merged into a survivor: what comes in later belongs to the survivor.
      const survivor = id(0xc9, (counter += 1));
      await rows("insert into machvon.contact (tenant_id, id, display_name, verified_identities, classification, status) values ($1, $2, 'Survivor', '[]'::jsonb, 'OTHER', 'Verified')", [TENANT_A, survivor]);
      await rows("update machvon.contact set status = 'Merged', merged_into_id = $2 where id = $1", [firstConversation?.contact_id, survivor]);
      const after = received(await inbound(whatsappAccount, { sender: { externalId: '84900000002', displayName: 'B' } }));
      expect((await conversation(after.conversationId))?.contact_id).toBe(survivor);
    });

    it('from a contact who is blocked is not taken in', async () => {
      const first = received(await inbound(whatsappAccount, { sender: { externalId: '84900000003', displayName: 'C' } }));
      const [row] = await rows<{ contact_id: string }>('select contact_id from machvon.conversation where id = $1', [first.conversationId]);
      await rows("update machvon.contact set status = 'Blocked' where id = $1", [row?.contact_id]);
      const before = (await rows<{ n: string }>('select count(*)::text as n from machvon.channel_message'))[0]?.n;
      expect(await inbound(whatsappAccount, { sender: { externalId: '84900000003', displayName: 'C' } })).toEqual({ kind: 'BLOCKED' });
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.channel_message'))[0]?.n).toBe(before);
    });

    it('for an account that is not Active is refused for the inbox to try again, for one that is not there is unknown, and a channel that carries no message is 422', async () => {
      const disabled = await account('EMAIL', 'Disabled');
      await rows("update machvon.channel_account set status = 'Disabled' where id = $1", [disabled]);
      await expect(inbound(disabled)).rejects.toMatchObject({ code: 'CHANNEL_ACCOUNT_STATE_INVALID' });
      const push = await account('PUSH_FCM', 'Push');
      await expect(inbound(push)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(inbound(randomUUID())).rejects.toMatchObject({ code: 'CHANNEL_ACCOUNT_UNKNOWN' });
    });

    it('AC-ST-OMNI-004-2 UAT-AC25: a message that is only STOP ends every consent of the contact on that channel, and a sentence with the word in it ends none', async () => {
      const first = received(await inbound(smsAccount, { externalThreadId: 'thread-stop', sender: { externalId: '0987000111', displayName: 'D' } }));
      const [row] = await rows<{ contact_id: string }>('select contact_id from machvon.conversation where id = $1', [first.conversationId]);
      // The number is verified by a document, then two consents are taken on SMS and one on e-mail.
      await rows("update machvon.contact_identity set status = 'Verified', verification_method = 'ADMIN_DOCUMENT', verified_at = now(), verified_by = $2 where contact_id = $1", [row?.contact_id, memberId(SUPERVISOR)]);
      const consent = (channel: string, purpose: string) =>
        rows(
          `insert into machvon.contact_consent (tenant_id, id, contact_id, membership_id, channel, purpose, status, evidence_reference, effective_at, legal_basis, consent_text_version, capture_method)
           values ($1, $2, $3, null, $4, $5, 'Granted', 'proof', now(), 'CONSENT', 'v1', 'IN_APP')`,
          [TENANT_A, randomUUID(), row?.contact_id, channel, purpose],
        );
      await consent('SMS', 'SUPPORT_CONVERSATION');
      await consent('SMS', 'REMINDER');
      await consent('EMAIL', 'REMINDER');
      const sentence = received(await inbound(smsAccount, { externalThreadId: 'thread-stop', sender: { externalId: '0987000111', displayName: 'D' }, text: 'please do not stop the service' }));
      expect(sentence.withdrawn).toEqual([]);
      const stop = received(await inbound(smsAccount, { externalThreadId: 'thread-stop', sender: { externalId: '0987000111', displayName: 'D' }, text: ' Dừng. ' }));
      expect(stop.withdrawn.map((consent) => [consent.channel, consent.purpose, consent.status]).sort()).toEqual([
        ['SMS', 'REMINDER', 'Withdrawn'],
        ['SMS', 'SUPPORT_CONVERSATION', 'Withdrawn'],
      ]);
      expect(await rows<{ channel: string; status: string }>('select channel, status from machvon.contact_consent where contact_id = $1 order by channel, purpose', [row?.contact_id])).toEqual([
        { channel: 'EMAIL', status: 'Granted' },
        { channel: 'SMS', status: 'Withdrawn' },
        { channel: 'SMS', status: 'Withdrawn' },
      ]);
      // The message itself is kept: the person said it, and the conversation shows it.
      expect((await rows<{ body_text: string }>('select body_text from machvon.channel_message where id = $1', [stop.messageId]))[0]?.body_text).toBe(' Dừng. ');
    });

    it('knows a message the provider sends again under another event after its conversation was closed: it is one message, and opens nothing', async () => {
      const first = received(await inbound(whatsappAccount, { providerMessageId: 'closed-dup', externalThreadId: 'thread-closed-dup', sender: { externalId: '84900000020', displayName: 'G' } }));
      await advance(first.conversationId, 'Assigned', 'InProgress', 'Resolved', 'Closed');
      expect(await inbound(whatsappAccount, { providerMessageId: 'closed-dup', externalThreadId: 'thread-closed-dup', sender: { externalId: '84900000020', displayName: 'G' } })).toEqual({ kind: 'DUPLICATE', conversationId: first.conversationId });
      expect((await rows<{ n: string }>("select count(*)::text as n from machvon.conversation where external_thread_id = 'thread-closed-dup'"))[0]?.n).toBe('1');
      expect((await conversation(first.conversationId))?.status).toBe('Closed');
    });

    it('brings a conversation that waited for the customer, or was resolved, back to work, and opens a new one linked to the old when the old one is closed', async () => {
      const first = received(await inbound(whatsappAccount, { externalThreadId: 'thread-life', sender: { externalId: '84900000004', displayName: 'E' } }));
      await advance(first.conversationId, 'Assigned', 'InProgress', 'Resolved');
      const back = received(await inbound(whatsappAccount, { externalThreadId: 'thread-life', sender: { externalId: '84900000004', displayName: 'E' } }));
      expect(back).toMatchObject({ conversationId: first.conversationId, created: false, reopened: true });
      expect((await conversation(first.conversationId))?.status).toBe('InProgress');
      await rows("update machvon.conversation set status = 'PendingCustomer', assignee_id = $2 where id = $1", [first.conversationId, memberId(AGENT)]);
      // The customer answering a conversation that waited for them is not a reopening.
      expect(received(await inbound(whatsappAccount, { externalThreadId: 'thread-life', sender: { externalId: '84900000004', displayName: 'E' } })).reopened).toBe(false);
      expect(await conversation(first.conversationId)).toMatchObject({ status: 'InProgress', assignee_id: memberId(AGENT) });
      await advance(first.conversationId, 'Resolved', 'Closed');
      const next = received(await inbound(whatsappAccount, { externalThreadId: 'thread-life', sender: { externalId: '84900000004', displayName: 'E' } }));
      expect(next).toMatchObject({ created: true, newContact: false });
      expect(next.conversationId).not.toBe(first.conversationId);
      expect(await conversation(next.conversationId)).toMatchObject({ status: 'New', assignee_id: null, previous_conversation_id: first.conversationId });
      expect((await conversation(first.conversationId))?.status).toBe('Closed');
      // A second message goes to the new conversation, not the closed one.
      expect(received(await inbound(whatsappAccount, { externalThreadId: 'thread-life', sender: { externalId: '84900000004', displayName: 'E' } })).conversationId).toBe(next.conversationId);
    });

    it('keeps what a conversation and a message are: neither is deleted, the account, thread and text do not change, and the state moves only the ways the table allows', async () => {
      const made = received(await inbound(emailAccount));
      const refused = async (sql: string, params: unknown[]): Promise<string> => {
        try {
          await rows(sql, params);
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error('it was allowed');
      };
      expect(await refused('delete from machvon.conversation where id = $1', [made.conversationId])).toMatch(/CONVERSATION_IMMUTABLE/);
      expect(await refused('delete from machvon.channel_message where id = $1', [made.messageId])).toMatch(/MESSAGE_IMMUTABLE/);
      expect(await refused("update machvon.conversation set external_thread_id = 'other' where id = $1", [made.conversationId])).toMatch(/CONVERSATION_IMMUTABLE/);
      expect(await refused("update machvon.channel_message set body_text = 'changed' where id = $1", [made.messageId])).toMatch(/MESSAGE_IMMUTABLE/);
      expect(await refused("update machvon.conversation set status = 'Closed' where id = $1", [made.conversationId])).toMatch(/CONVERSATION_STATE_INVALID/);
      expect(await refused("update machvon.conversation set status = 'Resolved' where id = $1", [made.conversationId])).toMatch(/CONVERSATION_STATE_INVALID|conversation_assignee_ck/);
      // A Closed conversation does not come back.
      await advance(made.conversationId, 'Assigned', 'InProgress', 'Resolved', 'Closed');
      expect(await refused("update machvon.conversation set status = 'New' where id = $1", [made.conversationId])).toMatch(/CONVERSATION_STATE_INVALID/);
    });
  });

  describe('the assignment', () => {
    async function fresh(queueUnit?: number): Promise<{ id: string; version: number }> {
      const made = received(await inbound(whatsappAccount));
      if (queueUnit !== undefined) await rows('update machvon.conversation set queue_unit_id = $2 where id = $1', [made.conversationId, unitId(queueUnit)]);
      return { id: made.conversationId, version: Number((await conversation(made.conversationId))?.version) };
    }

    it('AC-ST-OMNI-004-3 UAT-AC26: a supervisor gives a New conversation to an agent: it is Assigned, with the moment, one trail row and one event', async () => {
      const target = await fresh();
      const done = await assign(target.id, AGENT, target.version, SUPERVISOR, 'The queue of the whole tenant');
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'ASSIGNED', resource_version: target.version + 1 });
      expect(await conversation(target.id)).toMatchObject({ status: 'Assigned', assignee_id: memberId(AGENT) });
      expect((await rows<{ assigned_at: Date | null }>('select assigned_at from machvon.conversation where id = $1', [target.id]))[0]?.assigned_at).toBeInstanceOf(Date);
      const trail = await rows<{ safe_diff: Record<string, unknown>; reason: string }>("select safe_diff, reason from machvon.audit_event where action = 'conversation.assigned' and resource_id = $1", [target.id]);
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({ reason: 'The queue of the whole tenant', safe_diff: { from_assignee_id: null, to_assignee_id: memberId(AGENT), from_status: 'New', to_status: 'Assigned', queue_unit_id: null } });
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'omni.conversation.assigned.v1' and aggregate_id = $1", [target.id]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ conversation_id: target.id, assignee_membership_id: memberId(AGENT), previous_assignee_membership_id: null, queue_unit_id: null });
    });

    it('moves it to another agent while it is under way, and keeps the state it is in', async () => {
      const target = await fresh();
      expect((await assign(target.id, AGENT, target.version)).status).toBe(200);
      await rows("update machvon.conversation set status = 'InProgress' where id = $1", [target.id]);
      const version = Number((await conversation(target.id))?.version);
      expect((await assign(target.id, UNIT_AGENT, version)).status).toBe(200);
      expect(await conversation(target.id)).toMatchObject({ status: 'InProgress', assignee_id: memberId(UNIT_AGENT) });
    });

    it('is 409 VERSION_CONFLICT for the second of two supervisors who assign at once, and for a stale version', async () => {
      const target = await fresh();
      const [one, two] = await Promise.all([assign(target.id, AGENT, target.version), assign(target.id, UNIT_AGENT, target.version)]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      const lost = one.status === 409 ? one : two;
      expect(lost.json.code).toBe('VERSION_CONFLICT');
      expect((await assign(target.id, AGENT, target.version)).json.code).toBe('VERSION_CONFLICT');
    });

    it('is 422 ASSIGNEE_NOT_ELIGIBLE for a member who may not answer, or answers elsewhere, and is a queue of a unit: only the members whose scope holds it', async () => {
      const target = await fresh(1);
      // No grant at all; a member who answers in another unit only; a member who has the permission to assign but not to answer.
      for (const member of [NOBODY, OTHER_UNIT_AGENT, UNIT_SUPERVISOR]) {
        const refused = await assign(target.id, member, target.version);
        expect(refused.status).toBe(422);
        expect(refused.json).toMatchObject({ code: 'ASSIGNEE_NOT_ELIGIBLE' });
      }
      expect((await conversation(target.id))?.status).toBe('New');
      // The agent of the unit, and the agent of the whole tenant, may be given it.
      expect((await assign(target.id, UNIT_AGENT, target.version)).status).toBe(200);
      const second = await fresh(1);
      expect((await assign(second.id, AGENT, second.version)).status).toBe(200);
      // Not one that does not exist.
      const ghost = await fresh();
      expect((await call('POST', `/conversations/${ghost.id}/assign`, { ifMatch: `"${ghost.version}"`, body: { assignee_membership_id: randomUUID() } })).json.code).toBe('ASSIGNEE_NOT_ELIGIBLE');
    });

    it('is 409 CONVERSATION_STATE_INVALID once the conversation is resolved or closed', async () => {
      const target = await fresh();
      await advance(target.id, 'Assigned', 'InProgress', 'Resolved');
      const version = Number((await conversation(target.id))?.version);
      const refused = await assign(target.id, AGENT, version);
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe('CONVERSATION_STATE_INVALID');
      await advance(target.id, 'Closed');
      expect((await assign(target.id, AGENT, Number((await conversation(target.id))?.version))).json.code).toBe('CONVERSATION_STATE_INVALID');
    });

    it('is refused to whoever does not hold the permission to assign, and a conversation outside the scope of the assigner is not found', async () => {
      const target = await fresh(2);
      expect((await assign(target.id, AGENT, target.version, AGENT)).status).toBe(403);
      expect((await assign(target.id, AGENT, target.version, NOBODY)).status).toBe(403);
      // The supervisor of the unit 1 does not see the queue of the unit 2.
      expect((await assign(target.id, AGENT, target.version, UNIT_SUPERVISOR)).status).toBe(404);
      // Nor a conversation of another tenant, whatever it is called.
      expect((await call('POST', `/conversations/${target.id}/assign`, { member: OTHER_TENANT_SUPERVISOR, tenantId: TENANT_B, ifMatch: `"${target.version}"`, body: { assignee_membership_id: memberId(OTHER_TENANT_SUPERVISOR) } })).status).toBe(404);
      expect((await conversation(target.id))?.status).toBe('New');
    });

    it('does not let what is assigned to a member widen where they may assign: the grant to assign must cover the queue itself', async () => {
      const target = await fresh(2);
      await advance(target.id, 'Assigned');
      await rows('update machvon.conversation set assignee_id = $2 where id = $1', [target.id, memberId(MIXED)]);
      const version = Number((await conversation(target.id))?.version);
      // The member reads it (it is theirs, and they read the whole tenant) but may assign only in the unit 1.
      expect((await call('GET', `/resources/conversation/${target.id}`, { member: MIXED })).status).toBe(200);
      expect((await assign(target.id, UNIT_AGENT, version, MIXED)).status).toBe(403);
      expect((await call('GET', `/conversations/${target.id}/assignees`, { member: MIXED })).status).toBe(403);
      expect((await conversation(target.id))?.assignee_id).toBe(memberId(MIXED));
    });

    it('is 403 SCOPE_DENIED for one who reads the conversation through the assignment but may not assign it', async () => {
      const target = await fresh(1);
      // The agent of the unit 1 reads it because it is in the queue of their unit; the permission to assign is another one.
      expect((await call('GET', `/conversations/${target.id}/assignees`, { member: UNIT_AGENT })).status).toBe(403);
    });

    it('lists the members who may be given a conversation: those who answer in its queue, by name', async () => {
      const queued = await fresh(1);
      const everyone = await call('GET', `/conversations/${queued.id}/assignees`);
      expect(everyone.status).toBe(200);
      const names = (everyone.json.items as Array<{ membership_id: string; display_name: string }>).map((item) => [item.membership_id, item.display_name]);
      // The supervisor answers too (the tenant), the agent of the tenant and the agent of the unit; not the agent of the other unit, nor the one with the permission to assign only.
      expect(names).toEqual([
        [memberId(SUPERVISOR), 'User 1'],
        [memberId(AGENT), 'User 2'],
        [memberId(UNIT_AGENT), 'User 3'],
      ]);
      const tenantWide = await fresh();
      const all = (await call('GET', `/conversations/${tenantWide.id}/assignees`)).json.items as Array<{ membership_id: string }>;
      expect(all.map((item) => item.membership_id)).toEqual([memberId(SUPERVISOR), memberId(AGENT), memberId(UNIT_AGENT), memberId(OTHER_UNIT_AGENT)]);
      expect((await call('GET', `/conversations/${randomUUID()}/assignees`)).status).toBe(404);
    });

    it('judges every candidate, a page at a time, so members of other queues do not hide an eligible one, and stops at the limit', async () => {
      const read = (options: { pageSize?: number; limit?: number }) =>
        (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: memberId(SUPERVISOR), scopeVersion: 1 }, (tx) => store.eligibleAssignees(tx, { queueUnitId: unitId(2) }, new Date(), options));
      const names = (items: Array<{ displayName: string }>) => items.map((item) => item.displayName);
      // The agent of the unit 1 (User 3) is between the others and may not answer in the unit 2.
      expect(names(await read({ pageSize: 1 }))).toEqual(['User 1', 'User 2', 'User 4']);
      expect(names(await read({ pageSize: 2 }))).toEqual(['User 1', 'User 2', 'User 4']);
      expect(names(await read({ pageSize: 1, limit: 2 }))).toEqual(['User 1', 'User 2']);
    });
  });

  describe('what is read', () => {
    it('AC-ST-OMNI-004-4: shows a reader the conversations of the queues in their scope and those assigned to them, and a supervisor of the tenant all of them', async () => {
      const inUnit1 = received(await inbound(emailAccount));
      const inUnit2 = received(await inbound(emailAccount));
      const unqueued = received(await inbound(emailAccount));
      await rows('update machvon.conversation set queue_unit_id = $2 where id = $1', [inUnit1.conversationId, unitId(1)]);
      await rows('update machvon.conversation set queue_unit_id = $2 where id = $1', [inUnit2.conversationId, unitId(2)]);
      const idsOf = async (member: number, query = ''): Promise<string[]> => {
        const out: string[] = [];
        let cursor: string | null = null;
        do {
          const page: Reply = await call('GET', `/resources/conversation?limit=5${query}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { member });
          expect(page.status).toBe(200);
          out.push(...(page.json.items as Array<{ id: string }>).map((item) => item.id));
          cursor = page.json.next_cursor as string | null;
        } while (cursor !== null);
        return out;
      };
      const mine = [inUnit1.conversationId, inUnit2.conversationId, unqueued.conversationId];
      const supervisor = await idsOf(SUPERVISOR);
      for (const target of mine) expect(supervisor).toContain(target);
      expect(new Set(supervisor).size).toBe(supervisor.length);
      const unitAgent = await idsOf(UNIT_AGENT);
      expect(unitAgent).toContain(inUnit1.conversationId);
      expect(unitAgent).not.toContain(inUnit2.conversationId);
      expect(unitAgent).not.toContain(unqueued.conversationId);
      const other = await idsOf(OTHER_UNIT_AGENT);
      expect(other).toContain(inUnit2.conversationId);
      expect(other).not.toContain(inUnit1.conversationId);
      expect((await call('GET', '/resources/conversation', { member: NOBODY })).status).toBe(403);
      // What is assigned to a reader is theirs wherever its queue is.
      const version = Number((await conversation(inUnit2.conversationId))?.version);
      expect((await assign(inUnit2.conversationId, UNIT_AGENT, version)).status).toBe(422);
      await rows("update machvon.conversation set status = 'Assigned', assignee_id = $2 where id = $1", [unqueued.conversationId, memberId(UNIT_AGENT)]);
      expect(await idsOf(UNIT_AGENT)).toContain(unqueued.conversationId);
      const own = await idsOf(UNIT_AGENT, '&mine=true');
      expect(own).toContain(unqueued.conversationId);
      expect((await rows<{ assignee_id: string }>('select assignee_id from machvon.conversation where id = any($1::uuid[])', [own])).every((row) => row.assignee_id === memberId(UNIT_AGENT))).toBe(true);
      expect(await idsOf(SUPERVISOR, '&status=Assigned')).toContain(unqueued.conversationId);
      expect(await idsOf(SUPERVISOR, '&status=Resolved')).not.toContain(unqueued.conversationId);
      const inQueue = await idsOf(SUPERVISOR, `&queue_unit_id=${unitId(2)}`);
      expect(inQueue).toContain(inUnit2.conversationId);
      expect((await rows<{ queue_unit_id: string }>('select queue_unit_id from machvon.conversation where id = any($1::uuid[])', [inQueue])).every((row) => row.queue_unit_id === unitId(2))).toBe(true);
      const other_tenant = await call('GET', '/resources/conversation', { member: OTHER_TENANT_SUPERVISOR, tenantId: TENANT_B });
      expect(other_tenant.json.items).toEqual([]);
    });

    it('shows one conversation with the person, the account, the window and the assignee, and not found outside the scope', async () => {
      const made = received(await inbound(whatsappAccount, { sender: { externalId: '84900000010', displayName: 'Lê Văn Đức' } }));
      await rows('update machvon.conversation set queue_unit_id = $2 where id = $1', [made.conversationId, unitId(1)]);
      const version = Number((await conversation(made.conversationId))?.version);
      expect((await assign(made.conversationId, UNIT_AGENT, version)).status).toBe(200);
      const view = await call('GET', `/resources/conversation/${made.conversationId}`, { member: UNIT_AGENT });
      expect(view.status).toBe(200);
      expect(view.json).toMatchObject({
        id: made.conversationId,
        channel: 'WHATSAPP',
        account_name: 'WhatsApp hỗ trợ',
        contact_name: 'Lê Văn Đức',
        status: 'Assigned',
        priority: 'NORMAL',
        assignee_membership_id: memberId(UNIT_AGENT),
        assignee_name: 'User 3',
        queue_unit_id: unitId(1),
        window_expires_at: '2026-10-31T03:00:00.000000Z',
        message_count: 1,
        version: version + 1,
      });
      expect((await call('GET', `/resources/conversation/${made.conversationId}`, { member: OTHER_UNIT_AGENT })).status).toBe(404);
      expect((await call('GET', `/resources/conversation/${made.conversationId}`, { member: OTHER_TENANT_SUPERVISOR, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/resources/conversation/${randomUUID()}`)).status).toBe(404);
    });

    it('lists the messages of a conversation oldest first without the text, and reads one with it, within the scope of the reader', async () => {
      const first = received(await inbound(smsAccount, { externalThreadId: 'thread-read', sender: { externalId: '0987000222', displayName: 'F' }, text: 'một', occurredAt: new Date('2026-10-30T03:00:00.000Z') }));
      const second = received(await inbound(smsAccount, { externalThreadId: 'thread-read', sender: { externalId: '0987000222', displayName: 'F' }, text: 'hai' }));
      await rows('update machvon.conversation set queue_unit_id = $2 where id = $1', [first.conversationId, unitId(1)]);
      const page = await call('GET', `/resources/channel_message?conversation_id=${first.conversationId}&limit=1`);
      expect(page.status).toBe(200);
      expect((page.json.items as Array<{ id: string; text: unknown }>).map((item) => [item.id, item.text])).toEqual([[first.messageId, null]]);
      const next = await call('GET', `/resources/channel_message?conversation_id=${first.conversationId}&limit=1&cursor=${encodeURIComponent(page.json.next_cursor as string)}`);
      expect((next.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second.messageId]);
      expect(next.json.next_cursor).toBeNull();
      const one = await call('GET', `/resources/channel_message/${second.messageId}`, { member: UNIT_AGENT });
      expect(one.status).toBe(200);
      expect(one.json).toMatchObject({ id: second.messageId, conversation_id: first.conversationId, direction: 'INBOUND', kind: 'TEXT', classification: 'PERSONAL', text: 'hai', delivery_status: null, author_membership_id: null });
      expect((await call('GET', `/resources/channel_message/${second.messageId}`, { member: OTHER_UNIT_AGENT })).status).toBe(404);
      expect((await call('GET', `/resources/channel_message?conversation_id=${first.conversationId}`, { member: OTHER_UNIT_AGENT })).json.items).toEqual([]);
      expect((await call('GET', `/resources/channel_message?conversation_id=${first.conversationId}`, { member: OTHER_TENANT_SUPERVISOR, tenantId: TENANT_B })).json.items).toEqual([]);
    });

    it('refuses a filter or a cursor that is not what it should be', async () => {
      for (const query of ['status=Done', 'mine=yes', 'queue_unit_id=x', 'cursor=!!', 'limit=0']) {
        const reply = await call('GET', `/resources/conversation?${query}`);
        expect([400, 422]).toContain(reply.status);
      }
      expect((await call('GET', '/resources/channel_message?conversation_id=x')).status).toBe(422);
      expect((await call('GET', '/resources/channel_message?cursor=2026-10-30')).status).toBeGreaterThanOrEqual(400);
    });
  });
});
