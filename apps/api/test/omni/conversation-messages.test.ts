import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { ContactConsentStore, ConversationOutboundStore, DeliveryLimits, ConversationStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { InboundInput, InboundOutcome } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ChannelAdapterRegistry, InMemoryChannelAdapter } from '../../src/notifications/delivery/channel-adapters';
import { OMNI_CHANNEL_CREDENTIAL_EXPIRED_ALERT } from '../../src/notifications/delivery/dispatcher';
import { ConversationSender } from '../../src/omni/conversations/conversation-sender';
import { ConversationsController } from '../../src/omni/conversations/conversations.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const AGENT = 1; // answers in the whole tenant
const OTHER_AGENT = 2; // the same
const READER = 3; // reads the conversations, may not answer
const UNIT_AGENT = 4; // answers in the unit 2 only
const NOBODY = 5;
const WORKER = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
const REASON = 'The question of the person was answered in full.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('what an agent says in a conversation (ST-OMNI-005, OMNI-02, OMNI.md 3.3)', () => {
  const harness = new AuthzHarness();
  const store = new ConversationStore();
  const outbound = new ConversationOutboundStore();
  const consents = new ContactConsentStore();
  const email = new InMemoryChannelAdapter({ provider: 'mail-mock', channel: 'EMAIL' });
  const whatsapp = new InMemoryChannelAdapter({ provider: 'wa-mock', channel: 'WHATSAPP' });
  let sender: ConversationSender;
  let app: RunningApp;
  let counter = 0;
  const channelOf = new Map<string, string>();
  let emailAccount: string;
  let whatsappAccount: string;
  let smsAccount: string;
  let foreignAccount: string;

  const tenants = (): TenantDatabase => harness.tenants as TenantDatabase;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? AGENT, options.tenantId), 'content-type': 'application/json', 'idempotency-key': options.key ?? `key-${randomUUID()}` };
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method: 'POST', headers, body: JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function account(channel: string, name: string, tenant = TENANT_A): Promise<string> {
    const accountId = id(0xe1, (counter += 1));
    await rows(
      `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, display_name)
       values ($1, $2, $3, $4, 'secret://t/x', 'v1', 'Active', now(), $5)`,
      [tenant, accountId, channel, `ext-${accountId}`, name],
      tenant,
    );
    channelOf.set(accountId, channel);
    return accountId;
  }

  const inbound = async (accountId: string, change: Partial<InboundInput> = {}): Promise<Extract<InboundOutcome, { kind: 'RECEIVED' }>> => {
    const n = (counter += 1);
    const inboxId = randomUUID();
    await rows(
      `insert into machvon.integration_event_inbox (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id)
       values ($1, $2, 'test-provider', $3, repeat('b', 64), 'ref', now(), 'PROCESSING', 'k1')`,
      [TENANT_A, inboxId, `event-${inboxId}`],
    );
    const channel = channelOf.get(accountId) === 'EMAIL' ? 'email' : channelOf.get(accountId) === 'SMS' ? 'sms' : 'wa';
    const input: InboundInput = {
      inboxId,
      channelAccountId: accountId,
      providerMessageId: `pm-${n}`,
      externalThreadId: `reply-handle-${n}`,
      sender: { externalId: channel === 'email' ? `person${n}@example.com` : channel === 'sms' ? `0913${String(400_000 + n)}` : `8491${String(500_000 + n)}`, displayName: 'Lê Thị Hoa' },
      text: 'Tôi cần hỏi về hồ sơ',
      occurredAt: new Date(),
      ...change,
    };
    const outcome = await tenants().withTenant(WORKER, (tx) => store.receiveInbound(tx, input));
    if (outcome.kind !== 'RECEIVED') throw new Error(`not received: ${outcome.kind}`);
    return outcome;
  };

  interface Conversation {
    id: string;
    contactId: string;
  }
  /** A conversation the person opened on an account, given to an agent and taken up (InProgress) unless said otherwise. */
  async function conversation(accountId: string, states: string[] = ['Assigned', 'InProgress']): Promise<Conversation> {
    const made = await inbound(accountId);
    for (const state of states) await rows(state === 'Assigned' ? `update machvon.conversation set status = 'Assigned', assignee_id = '${memberId(AGENT)}' where id = $1` : `update machvon.conversation set status = '${state}' where id = $1`, [made.conversationId]);
    const [row] = await rows<{ contact_id: string }>('select contact_id from machvon.conversation where id = $1', [made.conversationId]);
    return { id: made.conversationId, contactId: row?.contact_id as string };
  }
  const versionOf = async (conversationId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.conversation where id = $1', [conversationId]))[0]?.version);
  const statusOf = async (conversationId: string): Promise<string> => (await rows<{ status: string }>('select status from machvon.conversation where id = $1', [conversationId]))[0]?.status as string;
  const messages = (conversationId: string) =>
    rows<{ id: string; direction: string; delivery_status: string | null; body_text: string; provider_message_id: string | null; purpose: string | null; error_code: string | null; send_attempts: number; links: unknown; author_membership_id: string | null }>(
      'select id, direction, delivery_status, body_text, provider_message_id, purpose, error_code, send_attempts, links, author_membership_id from machvon.channel_message where conversation_id = $1 order by created_at, id',
      [conversationId],
    );

  async function say(target: string, accountId: string, change: Record<string, unknown> = {}, options: { member?: number; version?: number; key?: string } = {}): Promise<Reply> {
    const version = options.version ?? (await versionOf(target));
    return call(`/conversations/${target}/messages`, { member: options.member ?? AGENT, ifMatch: `"${version}"`, ...(options.key === undefined ? {} : { key: options.key }), body: { kind: 'EXTERNAL', channel_account_id: accountId, text: 'Chào bạn, hồ sơ đang được xử lý.', ...change } });
  }

  /** Makes the contact's address verified (by a document) so that consents can rest on it, then grants them. */
  async function consentOf(target: Conversation, channel: 'EMAIL' | 'SMS' | 'ZALO' | 'WHATSAPP', grants: Array<{ purpose: 'SUPPORT_CONVERSATION' | 'REMINDER' | 'OPERATIONAL'; withdraw?: boolean }>): Promise<void> {
    await rows("update machvon.contact_identity set status = 'Verified', verification_method = 'ADMIN_DOCUMENT', verified_at = now(), verified_by = $2 where contact_id = $1 and status <> 'Verified'", [target.contactId, memberId(AGENT)]);
    for (const grant of grants) {
      const made = await tenants().withTenant(WORKER, (tx) => consents.grantForContact(tx, target.contactId, { channel, purpose: grant.purpose, consentTextVersion: 'v1', captureMethod: 'IN_APP', evidenceReference: undefined }));
      if (grant.withdraw === true) await tenants().withTenant(WORKER, (tx) => consents.withdrawOfContact(tx, made.id, made.version, 'The person asked to stop these messages.'));
    }
  }

  const pass = (at = new Date()) => sender.run(WORKER, at);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(2)}/` }]);
    for (const member of [AGENT, OTHER_AGENT, READER, UNIT_AGENT, NOBODY]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedRole(TENANT_A, 1, 'OMNI_AGENT_TEST', ['omni.conversation.reply', 'conversation.read', 'channel_message.read'], 35);
    await harness.seedRole(TENANT_A, 2, 'OMNI_READER_TEST', ['conversation.read', 'channel_message.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AGENT, role: 1, kind: 'TENANT' },
      { n: 2, member: OTHER_AGENT, role: 1, kind: 'TENANT' },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
      { n: 4, member: UNIT_AGENT, role: 1, kind: 'UNIT_ONLY', refs: [unitId(2)] },
    ]);
    emailAccount = await account('EMAIL', 'Hộp thư hỗ trợ');
    whatsappAccount = await account('WHATSAPP', 'WhatsApp hỗ trợ');
    smsAccount = await account('SMS', 'Đầu số hỗ trợ');
    foreignAccount = await account('EMAIL', 'Hộp thư của tenant khác', TENANT_B);
    sender = new ConversationSender({ database: tenants(), adapters: new ChannelAdapterRegistry([email, whatsapp], 'test'), webBaseUrl: 'https://app.example.test' });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants() }), PolicyModule.register({ database: tenants(), access: new EffectiveAccessStore(tenants(), new InMemoryAuthzCache()) })],
      controllers: [ConversationsController],
      providers: [{ provide: TenantDatabase, useValue: tenants() }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    // What an earlier test left queued goes out (or fails) first, so each test counts only its own sends.
    await pass();
    email.requests.length = 0;
    whatsapp.requests.length = 0;
  });

  describe('a note for the colleagues', () => {
    it('AC-ST-OMNI-005-1 UAT-AC23: is kept in the conversation and reaches no adapter, and the database refuses a note that has a provider id or a status', async () => {
      const target = await conversation(whatsappAccount);
      const done = await call(`/conversations/${target.id}/messages`, { ifMatch: `"${await versionOf(target.id)}"`, body: { kind: 'INTERNAL_NOTE', channel_account_id: whatsappAccount, text: 'Gọi lại cho khách sau 3 giờ chiều.' } });
      expect(done.status).toBe(202);
      expect(done.json).toMatchObject({ status: 'RECORDED' });
      expect(await pass()).toBe(0);
      expect(whatsapp.requests).toHaveLength(0);
      expect(email.requests).toHaveLength(0);
      const [note] = (await messages(target.id)).filter((message) => message.direction === 'INTERNAL_NOTE');
      expect(note).toMatchObject({ body_text: 'Gọi lại cho khách sau 3 giờ chiều.', delivery_status: null, provider_message_id: null, author_membership_id: memberId(AGENT) });
      for (const sql of ["update machvon.channel_message set provider_message_id = 'x' where id = $1", "update machvon.channel_message set delivery_status = 'Queued' where id = $1"]) {
        await expect(rows(sql, [note?.id])).rejects.toThrow(/channel_message_note_ck|channel_message_outbound_status_ck|MESSAGE_STATE_INVALID/);
      }
      // No trail row carries the words of the note, and one event is not raised for it.
      expect(JSON.stringify(await rows('select safe_diff from machvon.audit_event where resource_id = $1', [target.id]))).not.toContain('Gọi lại');
      expect(await rows("select 1 from machvon.outbox_event where type = 'omni.message.queued.v1' and aggregate_id = $1", [target.id])).toHaveLength(0);
    });

    it('refuses what would make a note leave the system, and is allowed on a resolved conversation but not on a closed one', async () => {
      const target = await conversation(emailAccount);
      const version = await versionOf(target.id);
      for (const change of [{ purpose: 'REMINDER' }, { template_version_id: randomUUID() }, { attachment_ids: [randomUUID()] }, { resource_links: [{ resource_type: 'document_version', resource_id: randomUUID() }] }]) {
        const refused = await call(`/conversations/${target.id}/messages`, { ifMatch: `"${version}"`, body: { kind: 'INTERNAL_NOTE', channel_account_id: emailAccount, text: 'x', ...change } });
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      await rows("update machvon.conversation set status = 'Resolved' where id = $1", [target.id]);
      const resolved = await call(`/conversations/${target.id}/messages`, { ifMatch: `"${version}"`, body: { kind: 'INTERNAL_NOTE', channel_account_id: emailAccount, text: 'Ghi chú sau khi giải quyết' } });
      expect(resolved.status).toBe(202);
      await rows("update machvon.conversation set status = 'Closed' where id = $1", [target.id]);
      const closed = await call(`/conversations/${target.id}/messages`, { ifMatch: `"${version}"`, body: { kind: 'INTERNAL_NOTE', channel_account_id: emailAccount, text: 'x' } });
      expect([closed.status, closed.json.code]).toEqual([409, 'CONVERSATION_STATE_INVALID']);
    });
  });

  describe('the checks of a message to the person', () => {
    it('AC-ST-OMNI-005-2 UAT-AC24: an account of another tenant is 422 CHANNEL_ACCOUNT_MISMATCH, a disabled account is 422 CHANNEL_UNVERIFIED, and the right account is 202 with one adapter call', async () => {
      const target = await conversation(emailAccount);
      const mismatch = await say(target.id, foreignAccount);
      expect([mismatch.status, mismatch.json.code]).toEqual([422, 'CHANNEL_ACCOUNT_MISMATCH']);
      // Another account of the same tenant is no better, and the answer names nobody's account.
      const sibling = await say(target.id, smsAccount);
      expect([sibling.status, sibling.json.code]).toEqual([422, 'CHANNEL_ACCOUNT_MISMATCH']);
      expect(JSON.stringify([mismatch.json, sibling.json])).not.toContain(foreignAccount);
      const closed = await account('EMAIL', 'Hộp thư sắp đóng');
      const onClosed = await conversation(closed);
      await rows("update machvon.channel_account set status = 'Disabled' where id = $1", [closed]);
      const unverified = await say(onClosed.id, closed);
      expect([unverified.status, unverified.json.code]).toEqual([422, 'CHANNEL_UNVERIFIED']);
      expect(await messages(target.id).then((found) => found.filter((message) => message.direction === 'OUTBOUND'))).toHaveLength(0);
      const accepted = await say(target.id, emailAccount);
      expect(accepted.status).toBe(202);
      expect(accepted.json).toMatchObject({ status: 'QUEUED' });
      expect(email.requests).toHaveLength(0);
      expect(await pass()).toBeGreaterThanOrEqual(1);
      expect(email.requests).toHaveLength(1);
      expect(email.requests[0]?.to).toBe(handleOf(await rows<{ external_thread_id: string }>('select external_thread_id from machvon.conversation where id = $1', [target.id])));
    });

    it('AC-ST-OMNI-005-3 UAT-AC22: with the consent for support withdrawn and the one for reminders kept, a message for support is 422 CONSENT_DENIED and one for a reminder is 202 with one adapter call', async () => {
      const target = await conversation(emailAccount);
      await consentOf(target, 'EMAIL', [{ purpose: 'SUPPORT_CONVERSATION', withdraw: true }, { purpose: 'REMINDER' }]);
      const denied = await say(target.id, emailAccount, { purpose: 'SUPPORT_CONVERSATION' });
      expect([denied.status, denied.json.code]).toEqual([422, 'CONSENT_DENIED']);
      expect(email.requests).toHaveLength(0);
      const reminder = await say(target.id, emailAccount, { purpose: 'REMINDER', text: 'Nhắc: hạn bổ sung hồ sơ là ngày 5.' });
      expect(reminder.status).toBe(202);
      await pass();
      expect(email.requests.filter((request) => request.text.startsWith('Nhắc:'))).toHaveLength(1);
      expect(email.requests).toHaveLength(1);
    });

    it('asks a consent for a reminder that the person never gave (CONSENT_DENIED), and answers for support on a channel without a window without one', async () => {
      const target = await conversation(emailAccount);
      const denied = await say(target.id, emailAccount, { purpose: 'REMINDER' });
      expect([denied.status, denied.json.code]).toEqual([422, 'CONSENT_DENIED']);
      expect((await say(target.id, emailAccount)).status).toBe(202);
    });

    it('AC-ST-OMNI-005-4 UAT-AC195: with the window of 24 hours closed, a free text is 422 CHANNEL_WINDOW_CLOSED, an approved template is 202, and a WhatsApp contact that never opted in is 422 OPT_IN_REQUIRED', async () => {
      const target = await conversation(whatsappAccount);
      await consentOf(target, 'WHATSAPP', [{ purpose: 'SUPPORT_CONVERSATION' }]);
      await rows("update machvon.conversation set window_expires_at = now() - interval '1 hour' where id = $1", [target.id]);
      const free = await say(target.id, whatsappAccount);
      expect([free.status, free.json.code]).toEqual([422, 'CHANNEL_WINDOW_CLOSED']);
      const template = id(0xe2, (counter += 1));
      await rows(
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by, provider_status, provider_template_id, purpose)
         values ($1, $2, $3, 'WHATSAPP', 'vi-VN', 1, '{"body":"Xin chào {{name}}, hồ sơ của bạn đã có kết quả."}'::jsonb, '{"properties":{"name":{}}}'::jsonb, 'Active', repeat('c', 64), $4, 'PROVIDER_APPROVED', 'wa-tpl-1', 'OPERATIONAL')`,
        [TENANT_A, template, `wa.result.${counter}`, memberId(AGENT)],
      );
      const approved = await say(target.id, whatsappAccount, { text: undefined, template_version_id: template, template_variables: { name: 'Hoa' } });
      expect(approved.status).toBe(202);
      await pass();
      expect(whatsapp.requests.map((request) => request.text)).toEqual(['Xin chào Hoa, hồ sơ của bạn đã có kết quả.']);
      // A variable the template does not declare, or one that is missing, is a broken message: nothing is queued.
      const broken = await say(target.id, whatsappAccount, { text: undefined, template_version_id: template, template_variables: {} });
      expect([broken.status, broken.json.code]).toEqual([422, 'TEMPLATE_INVALID']);
      // A contact that never opted in on WhatsApp.
      const stranger = await conversation(whatsappAccount);
      await rows("update machvon.conversation set window_expires_at = now() - interval '1 hour' where id = $1", [stranger.id]);
      const optIn = await say(stranger.id, whatsappAccount);
      expect([optIn.status, optIn.json.code]).toEqual([422, 'OPT_IN_REQUIRED']);
      // The window of the person is still open: the answer for support needs no consent.
      const open = await conversation(whatsappAccount);
      expect((await say(open.id, whatsappAccount)).status).toBe(202);
    });

    it('refuses a template that is not Active, is for another channel, or is not the provider\'s approved one outside the window', async () => {
      const target = await conversation(whatsappAccount);
      await consentOf(target, 'WHATSAPP', [{ purpose: 'SUPPORT_CONVERSATION' }]);
      const template = id(0xe2, (counter += 1));
      await rows(
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by, provider_status, purpose)
         values ($1, $2, $3, 'EMAIL', 'vi-VN', 1, '{"body":"Xin chào"}'::jsonb, '{}'::jsonb, 'Active', repeat('c', 64), $4, 'NOT_REQUIRED', 'OPERATIONAL')`,
        [TENANT_A, template, `mail.hello.${counter}`, memberId(AGENT)],
      );
      const wrongChannel = await say(target.id, whatsappAccount, { text: undefined, template_version_id: template });
      expect([wrongChannel.status, wrongChannel.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const missing = await say(target.id, whatsappAccount, { text: undefined, template_version_id: randomUUID() });
      expect([missing.status, missing.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      // An e-mail template is fine on an e-mail conversation (no approval of the provider is asked there).
      const mail = await conversation(emailAccount);
      const mailed = await say(mail.id, emailAccount, { text: undefined, template_version_id: template });
      expect(mailed.status).toBe(202);
    });

    it('AC-ST-OMNI-005-5 UAT-AC25: a confidential document is 422 CONTENT_CLASSIFICATION_BLOCKED as an attachment, and goes as an opaque link that asks the person to sign in', async () => {
      const target = await conversation(emailAccount);
      const document = id(0xe3, (counter += 1));
      const confidential = id(0xe4, counter);
      const internal = id(0xe5, counter);
      const pending = id(0xe6, counter);
      await rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`, [TENANT_A, document, memberId(AGENT)]);
      await rows(
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $5, 1, 'tenants/omni/secret.pdf', repeat('a', 64), 'application/pdf', 1, 'CONFIDENTIAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $3, $5, 2, 'tenants/omni/public.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $5, 3, 'tenants/omni/unscanned.pdf', repeat('c', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, confidential, internal, pending, document],
      );
      for (const blocked of [confidential, pending]) {
        const refused = await say(target.id, emailAccount, { attachment_ids: [blocked] });
        expect([refused.status, refused.json.code]).toEqual([422, 'CONTENT_CLASSIFICATION_BLOCKED']);
      }
      const unknown = await say(target.id, emailAccount, { attachment_ids: [randomUUID()] });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const unknownLink = await say(target.id, emailAccount, { resource_links: [{ resource_type: 'document_version', resource_id: randomUUID() }] });
      expect([unknownLink.status, unknownLink.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await messages(target.id)).filter((message) => message.direction === 'OUTBOUND')).toHaveLength(0);
      // The same document as a link: opaque and behind the login, so the class does not matter; a clean public one may be attached (as a link too: the adapters carry text only).
      const linked = await say(target.id, emailAccount, { resource_links: [{ resource_type: 'document_version', resource_id: confidential }], attachment_ids: [internal] });
      expect(linked.status).toBe(202);
      await pass();
      expect(email.requests).toHaveLength(1);
      expect(email.requests[0]?.text).toBe(`Chào bạn, hồ sơ đang được xử lý.\nhttps://app.example.test/d/${internal}\nhttps://app.example.test/d/${confidential}`);
      expect(email.requests[0]?.text).not.toContain('secret.pdf');
      const [sent] = (await messages(target.id)).filter((message) => message.direction === 'OUTBOUND');
      // What is kept is the path; the whole address is made when it is sent.
      expect(sent?.body_text).toContain(`\n/d/${internal}\n/d/${confidential}`);
      expect(sent?.links).toEqual([
        { resource_type: 'document_version', resource_id: internal, as: 'attachment' },
        { resource_type: 'document_version', resource_id: confidential, as: 'link' },
      ]);
    });
  });

  describe('the state of the conversation', () => {
    it('is 409 CONVERSATION_STATE_INVALID for a message to the person while the conversation is New, Resolved or Closed, and 409 CONTACT_STATE_INVALID for a contact that is blocked', async () => {
      const fresh = await conversation(emailAccount, []);
      const onNew = await say(fresh.id, emailAccount);
      expect([onNew.status, onNew.json.code]).toEqual([409, 'CONVERSATION_STATE_INVALID']);
      for (const state of ['Assigned', 'InProgress', 'Resolved']) {
        const target = await conversation(emailAccount, state === 'Resolved' ? ['Assigned', 'InProgress', 'Resolved'] : state === 'InProgress' ? ['Assigned', 'InProgress'] : ['Assigned']);
        const reply = await say(target.id, emailAccount);
        expect(reply.status).toBe(state === 'Resolved' ? 409 : 202);
      }
      const blocked = await conversation(emailAccount);
      await rows("update machvon.contact set status = 'Blocked' where id = $1", [blocked.contactId]);
      const refused = await say(blocked.id, emailAccount);
      expect([refused.status, refused.json.code]).toEqual([409, 'CONTACT_STATE_INVALID']);
    });

    it('moves a conversation that was given to an agent, or waited for the customer, to InProgress, asking the version it was read at, and leaves one under way where it is', async () => {
      const assigned = await conversation(emailAccount, ['Assigned']);
      const version = await versionOf(assigned.id);
      const stale = await say(assigned.id, emailAccount, {}, { version: version + 5 });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect(await statusOf(assigned.id)).toBe('Assigned');
      const moved = await say(assigned.id, emailAccount, {}, { version });
      expect(moved.status).toBe(202);
      expect(moved.json).toMatchObject({ resource_version: version + 1 });
      expect(await statusOf(assigned.id)).toBe('InProgress');
      const waiting = await conversation(emailAccount, ['Assigned', 'InProgress', 'PendingCustomer']);
      expect((await say(waiting.id, emailAccount)).status).toBe(202);
      expect(await statusOf(waiting.id)).toBe('InProgress');
    });

    it('lets two agents answer at once: both messages are kept, and the version only guards the state', async () => {
      const target = await conversation(emailAccount);
      const version = await versionOf(target.id);
      const [one, two] = await Promise.all([
        say(target.id, emailAccount, { text: 'Câu trả lời của người thứ nhất' }, { member: AGENT, version }),
        say(target.id, emailAccount, { text: 'Câu trả lời của người thứ hai' }, { member: OTHER_AGENT, version }),
      ]);
      expect([one.status, two.status]).toEqual([202, 202]);
      expect((await messages(target.id)).filter((message) => message.direction === 'OUTBOUND').map((message) => message.body_text).sort()).toEqual(['Câu trả lời của người thứ hai', 'Câu trả lời của người thứ nhất']);
      expect(await versionOf(target.id)).toBe(version);
    });

    it('answers the same key with the same answer and one message, and refuses the same key with another body', async () => {
      const target = await conversation(emailAccount);
      const key = `key-${randomUUID()}`;
      const first = await say(target.id, emailAccount, {}, { key });
      const again = await say(target.id, emailAccount, {}, { key });
      expect([first.status, again.status]).toEqual([202, 202]);
      expect(again.json).toEqual(first.json);
      expect((await messages(target.id)).filter((message) => message.direction === 'OUTBOUND')).toHaveLength(1);
      const other = await say(target.id, emailAccount, { text: 'Một nội dung khác' }, { key });
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('is for the agents who may answer in the scope of the conversation: a reader is 403, another tenant and a queue outside the scope are 404', async () => {
      const target = await conversation(emailAccount);
      await rows('update machvon.conversation set queue_unit_id = $2 where id = $1', [target.id, unitId(1)]);
      expect((await say(target.id, emailAccount, {}, { member: READER })).status).toBe(403);
      expect((await say(target.id, emailAccount, {}, { member: NOBODY })).status).toBe(403);
      expect((await say(target.id, emailAccount, {}, { member: UNIT_AGENT })).status).toBe(404);
      const foreign = await call(`/conversations/${target.id}/messages`, { member: AGENT, tenantId: TENANT_B, ifMatch: '"1"', body: { kind: 'EXTERNAL', channel_account_id: foreignAccount, text: 'x' } });
      expect(foreign.status).toBe(403);
      expect((await messages(target.id)).filter((message) => message.direction === 'OUTBOUND')).toHaveLength(0);
    });
  });

  describe('resolve and reopen', () => {
    it('resolves a conversation that is under way with a reason and reopens it, each with its trail row and event, at the version read', async () => {
      const target = await conversation(emailAccount);
      const version = await versionOf(target.id);
      const stale = await call(`/conversations/${target.id}/resolve`, { ifMatch: `"${version + 3}"`, body: { reason: REASON } });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const short = await call(`/conversations/${target.id}/resolve`, { ifMatch: `"${version}"`, body: { reason: 'short' } });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const resolved = await call(`/conversations/${target.id}/resolve`, { ifMatch: `"${version}"`, body: { reason: REASON } });
      expect(resolved.status).toBe(200);
      expect(resolved.json).toMatchObject({ status: 'RESOLVED', resource_version: version + 1 });
      expect(await statusOf(target.id)).toBe('Resolved');
      const again = await call(`/conversations/${target.id}/resolve`, { ifMatch: `"${version + 1}"`, body: { reason: REASON } });
      expect([again.status, again.json.code]).toEqual([409, 'CONVERSATION_STATE_INVALID']);
      const reopened = await call(`/conversations/${target.id}/reopen`, { ifMatch: `"${version + 1}"`, body: { reason: 'The person wrote again with a new question.' } });
      expect(reopened.status).toBe(200);
      expect(reopened.json).toMatchObject({ status: 'INPROGRESS', resource_version: version + 2 });
      const trail = await rows<{ action: string; reason: string; safe_diff: Record<string, unknown> }>("select action, reason, safe_diff from machvon.audit_event where resource_id = $1 and action in ('conversation.resolved', 'conversation.reopened') order by occurred_at", [target.id]);
      expect(trail.map((row) => [row.action, row.safe_diff])).toEqual([
        ['conversation.resolved', { from_status: 'InProgress', to_status: 'Resolved' }],
        ['conversation.reopened', { from_status: 'Resolved', to_status: 'InProgress' }],
      ]);
      expect(trail[0]?.reason).toBe(REASON);
      const events = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = $1 and type like 'omni.conversation.%' order by aggregate_version", [target.id]);
      expect(events.map((event) => event.type)).toEqual(['omni.conversation.resolved.v1', 'omni.conversation.reopened.v1']);
    });

    it('does not resolve what nobody took up (New, Assigned), reopens only what is resolved, and keeps a closed conversation closed', async () => {
      for (const states of [[], ['Assigned']]) {
        const target = await conversation(emailAccount, states);
        const refused = await call(`/conversations/${target.id}/resolve`, { ifMatch: `"${await versionOf(target.id)}"`, body: { reason: REASON } });
        expect([refused.status, refused.json.code]).toEqual([409, 'CONVERSATION_STATE_INVALID']);
      }
      const open = await conversation(emailAccount);
      const notResolved = await call(`/conversations/${open.id}/reopen`, { ifMatch: `"${await versionOf(open.id)}"`, body: { reason: REASON } });
      expect([notResolved.status, notResolved.json.code]).toEqual([409, 'CONVERSATION_STATE_INVALID']);
      const closed = await conversation(emailAccount, ['Assigned', 'InProgress', 'Resolved', 'Closed']);
      for (const operation of ['resolve', 'reopen']) {
        const refused = await call(`/conversations/${closed.id}/${operation}`, { ifMatch: `"${await versionOf(closed.id)}"`, body: { reason: REASON } });
        expect([refused.status, refused.json.code]).toEqual([409, 'CONVERSATION_STATE_INVALID']);
      }
    });

    it('is for the agents who may answer in the scope of the conversation', async () => {
      const target = await conversation(emailAccount);
      const version = await versionOf(target.id);
      expect((await call(`/conversations/${target.id}/resolve`, { member: READER, ifMatch: `"${version}"`, body: { reason: REASON } })).status).toBe(403);
      await rows('update machvon.conversation set queue_unit_id = $2 where id = $1', [target.id, unitId(1)]);
      expect((await call(`/conversations/${target.id}/resolve`, { member: UNIT_AGENT, ifMatch: `"${version}"`, body: { reason: REASON } })).status).toBe(404);
      expect((await call(`/conversations/${randomUUID()}/reopen`, { ifMatch: '"1"', body: { reason: REASON } })).status).toBe(404);
      expect(await statusOf(target.id)).toBe('InProgress');
    });
  });

  describe('the sending', () => {
    const lastOutbound = async (conversationId: string) => (await messages(conversationId)).filter((message) => message.direction === 'OUTBOUND').at(-1);

    it('hands the message to the adapter of the channel of the conversation with the handle of the thread, its id as the key, and records the id the provider gives', async () => {
      const target = await conversation(emailAccount);
      await say(target.id, emailAccount);
      await pass();
      expect(email.requests).toHaveLength(1);
      const sent = await lastOutbound(target.id);
      expect(email.requests[0]).toMatchObject({ idempotencyKey: sent?.id, text: 'Chào bạn, hồ sơ đang được xử lý.' });
      expect(email.requests[0]?.to).toBe(handleOf(await rows<{ external_thread_id: string }>('select external_thread_id from machvon.conversation where id = $1', [target.id])));
      expect(sent).toMatchObject({ delivery_status: 'ProviderAccepted', send_attempts: 1, error_code: null });
      expect(sent?.provider_message_id).toBe(email.messageIdOf(sent?.id as string));
      // A second pass has nothing to send.
      expect(await pass()).toBe(0);
      expect(email.requests).toHaveLength(1);
    });

    it('tries again after a failure that is worth it, waiting longer each time, and gives up after three, with the code of the failure', async () => {
      const target = await conversation(emailAccount);
      await say(target.id, emailAccount);
      email.enqueue({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'HTTP_503' }, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'HTTP_503' });
      const start = new Date();
      await pass(start);
      expect(await lastOutbound(target.id)).toMatchObject({ delivery_status: 'Queued', send_attempts: 1, error_code: 'HTTP_503' });
      // Not yet due: nothing is sent.
      expect(await pass(new Date(start.getTime() + 10_000))).toBe(0);
      await pass(new Date(start.getTime() + 31_000));
      expect(await lastOutbound(target.id)).toMatchObject({ delivery_status: 'Queued', send_attempts: 2 });
      await pass(new Date(start.getTime() + 31_000 + 61_000));
      expect(await lastOutbound(target.id)).toMatchObject({ delivery_status: 'ProviderAccepted', send_attempts: 3, error_code: null });
      expect(email.requests).toHaveLength(3);
      expect(new Set(email.requests.map((request) => request.idempotencyKey)).size).toBe(1);
      const failing = await conversation(emailAccount);
      await say(failing.id, emailAccount);
      email.enqueue(...Array.from({ length: 3 }, () => ({ kind: 'FAILED' as const, failureClass: 'RETRYABLE' as const, errorCode: 'HTTP_503' })));
      for (let round = 0; round < 3; round += 1) await pass(new Date(start.getTime() + 3_600_000 * (round + 1)));
      expect(await lastOutbound(failing.id)).toMatchObject({ delivery_status: 'Failed', send_attempts: 3, error_code: 'HTTP_503' });
    });

    describe('an attempt whose result was lost', () => {
      /** The process took the message up and died before it recorded anything: the lease runs out with the claim still on it. */
      async function lost(): Promise<{ id: string; conversationId: string }> {
        const target = await conversation(emailAccount);
        await say(target.id, emailAccount);
        const taken = await tenants().withTenant(WORKER, (tx) => outbound.claimNext(tx, new Date()));
        if (taken === undefined) throw new Error('nothing to take');
        await rows("update machvon.channel_message set next_attempt_at = now() - interval '1 second' where id = $1", [taken.id]);
        return { id: taken.id, conversationId: target.id };
      }

      it('is asked about at the provider, and a message the provider holds is taken as sent, with its id and status, and not sent again', async () => {
        const gone = await lost();
        const providerId = email.holds(gone.id, 'DELIVERED');
        email.requests.length = 0;
        expect(await pass()).toBe(0);
        expect(email.requests).toHaveLength(0);
        expect(await lastOutbound(gone.conversationId)).toMatchObject({ delivery_status: 'Delivered', provider_message_id: providerId, send_attempts: 1, error_code: null });
      });

      it('is sent again only when the provider says that it has no such request, as a new attempt that counts', async () => {
        const gone = await lost();
        expect(await pass()).toBe(1);
        expect(email.requests).toHaveLength(1);
        expect(email.requests[0]?.idempotencyKey).toBe(gone.id);
        expect(await lastOutbound(gone.conversationId)).toMatchObject({ delivery_status: 'ProviderAccepted', send_attempts: 2 });
        expect((await rows('select 1 from machvon.channel_message_send where message_id = $1', [gone.id])).length).toBe(2);
      });

      it('is not sent again when the provider cannot tell, nor when it says that the request failed', async () => {
        const unsure = await lost();
        email.lookupOfUnknown = { kind: 'UNDETERMINED' };
        try {
          await pass();
        } finally {
          email.lookupOfUnknown = { kind: 'NOT_FOUND' };
        }
        expect(await lastOutbound(unsure.conversationId)).toMatchObject({ delivery_status: 'Failed', error_code: 'SEND_UNCERTAIN' });
        const refused = await lost();
        email.holds(refused.id, 'FAILED');
        await pass();
        expect(await lastOutbound(refused.conversationId)).toMatchObject({ delivery_status: 'Failed', error_code: 'PROVIDER_FAILED' });
        expect(email.requests).toHaveLength(0);
      });

      it('is judged again before it is sent again: a consent withdrawn meanwhile ends it, and the message that the provider failed to answer about is not charged twice', async () => {
        const gone = await lost();
        const [row] = await rows<{ contact_id: string }>('select contact_id from machvon.conversation where id = $1', [gone.conversationId]);
        await rows("update machvon.contact set status = 'Blocked' where id = $1", [row?.contact_id]);
        await pass();
        expect(await lastOutbound(gone.conversationId)).toMatchObject({ delivery_status: 'Failed', error_code: 'CONTACT_STATE_INVALID' });
        expect(email.requests).toHaveLength(0);
      });

      it('leaves a message that recorded a failure worth another try to its time: it is not asked about at the provider', async () => {
        const target = await conversation(emailAccount);
        await say(target.id, emailAccount);
        email.enqueue({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'HTTP_503' });
        const start = new Date();
        await pass(start);
        expect((await rows<{ claimed_at: Date | null }>('select claimed_at from machvon.channel_message where conversation_id = $1 and direction = \'OUTBOUND\'', [target.id]))[0]?.claimed_at).toBeNull();
        email.lookupOfUnknown = { kind: 'UNDETERMINED' };
        try {
          await pass(new Date(start.getTime() + 31_000));
        } finally {
          email.lookupOfUnknown = { kind: 'NOT_FOUND' };
        }
        expect(await lastOutbound(target.id)).toMatchObject({ delivery_status: 'ProviderAccepted', send_attempts: 2 });
      });
    });

    it('ends a permanent failure at once, and never sends again a message whose answer was lost', async () => {
      const refused = await conversation(emailAccount);
      await say(refused.id, emailAccount);
      email.enqueue({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'ADDRESS_REJECTED' });
      await pass();
      expect(await lastOutbound(refused.id)).toMatchObject({ delivery_status: 'Failed', error_code: 'ADDRESS_REJECTED', send_attempts: 1 });
      const lost = await conversation(emailAccount);
      await say(lost.id, emailAccount);
      email.enqueue({ kind: 'UNKNOWN', errorCode: 'TIMEOUT' });
      await pass();
      expect(await lastOutbound(lost.id)).toMatchObject({ delivery_status: 'Failed', error_code: 'TIMEOUT' });
      email.requests.length = 0;
      expect(await pass(new Date(Date.now() + 3_600_000))).toBe(0);
      const thrown = await conversation(emailAccount);
      await say(thrown.id, emailAccount);
      email.enqueue('THROW');
      await pass();
      expect(await lastOutbound(thrown.id)).toMatchObject({ delivery_status: 'Failed', error_code: 'ADAPTER_ERROR' });
    });

    it('counts the messages of the agents with the sends of the notifications against the cap and the budget of the account: what would go over waits for the next day or month, and is sent then', async () => {
      const capped = await account('EMAIL', 'Hộp thư có hạn mức');
      await rows('update machvon.channel_account set daily_send_cap = 1 where id = $1', [capped]);
      const first = await conversation(capped);
      const second = await conversation(capped);
      await say(first.id, capped);
      await say(second.id, capped);
      const at = new Date();
      await pass(at);
      expect(email.requests).toHaveLength(1);
      const held = await lastOutbound(second.id);
      expect(held).toMatchObject({ delivery_status: 'Queued', error_code: 'CHANNEL_CAP', send_attempts: 0 });
      const [due] = await rows<{ next_attempt_at: Date }>('select next_attempt_at from machvon.channel_message where id = $1', [held?.id]);
      expect(due?.next_attempt_at.getTime()).toBeGreaterThan(at.getTime());
      expect(await pass(at)).toBe(0);
      // The notifications see the messages: the same account would hold one more send of theirs today.
      const verdict = await tenants().withTenant(WORKER, (tx) => new DeliveryLimits().check(tx, capped, 'EMAIL', 'NORMAL', at));
      expect(verdict).toMatchObject({ kind: 'HOLD', code: 'CHANNEL_CAP' });
      // The next day it goes.
      expect(await pass(new Date(due?.next_attempt_at.getTime() as number + 1))).toBe(1);
      expect(await lastOutbound(second.id)).toMatchObject({ delivery_status: 'ProviderAccepted' });
      // A budget holds a paid channel: WhatsApp costs 1,000 a message.
      const budget = await account('WHATSAPP', 'WhatsApp có ngân sách');
      await rows('update machvon.channel_account set monthly_budget_vnd = 1500 where id = $1', [budget]);
      const one = await conversation(budget);
      const two = await conversation(budget);
      await say(one.id, budget);
      await say(two.id, budget);
      await pass();
      expect(whatsapp.requests).toHaveLength(1);
      expect(await lastOutbound(two.id)).toMatchObject({ delivery_status: 'Queued', error_code: 'CHANNEL_BUDGET' });
      expect((await rows<{ cost: string }>('select cost::text as cost from machvon.channel_message_send where message_id = $1', [(await lastOutbound(one.id))?.id]))[0]?.cost).toBe('1000.00000000');
    });

    it('counts every attempt as a send of its own, on the day it is made, and gives back the send of a message that was put back because the channel was closed', async () => {
      const retrying = await account('EMAIL', 'Hộp thư thử lại');
      await rows('update machvon.channel_account set daily_send_cap = 2 where id = $1', [retrying]);
      const target = await conversation(retrying);
      await say(target.id, retrying);
      const day = new Date();
      email.enqueue({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'HTTP_503' });
      await pass(day);
      const sentId = (await lastOutbound(target.id))?.id as string;
      const count = async (): Promise<number> => (await rows('select 1 from machvon.channel_message_send where message_id = $1', [sentId])).length;
      expect(await count()).toBe(1);
      // The retry, on a later day, is a second send: the first stays where it was.
      await pass(new Date(day.getTime() + 2 * 86_400_000));
      expect(await count()).toBe(2);
      expect((await rows<{ n: string }>('select count(distinct date_trunc(\'day\', sending_at))::text as n from machvon.channel_message_send where message_id = $1', [sentId]))[0]?.n).toBe('2');
      // The first send was on another day: it does not count under the cap of today, and the retry counts once.
      const today = new Date(day.getTime() + 2 * 86_400_000);
      expect(await tenants().withTenant(WORKER, (tx) => new DeliveryLimits().check(tx, retrying, 'EMAIL', 'NORMAL', today))).toEqual({ kind: 'WITHIN' });
      // A message put back because the channel is closed gives its place back.
      const closed = await account('EMAIL', 'Hộp thư ngoài giờ');
      await rows('update machvon.channel_account set daily_send_cap = 1 where id = $1', [closed]);
      const waiting = await conversation(closed);
      await say(waiting.id, closed);
      const hours = email as unknown as { closedUntil?: (now: Date) => Date | undefined };
      const opens = new Date(Date.now() + 3_600_000);
      hours.closedUntil = () => opens;
      try {
        await pass();
      } finally {
        delete hours.closedUntil;
      }
      const waitingId = (await lastOutbound(waiting.id))?.id as string;
      expect((await rows('select 1 from machvon.channel_message_send where message_id = $1', [waitingId])).length).toBe(0);
      expect(await tenants().withTenant(WORKER, (tx) => new DeliveryLimits().check(tx, closed, 'EMAIL', 'NORMAL', new Date()))).toEqual({ kind: 'WITHIN' });
      // When the hours open it goes, under the cap it did not use.
      expect(await pass(new Date(opens.getTime() + 1))).toBe(1);
      expect(await lastOutbound(waiting.id)).toMatchObject({ delivery_status: 'ProviderAccepted', send_attempts: 1 });
      expect((await rows('select 1 from machvon.channel_message_send where message_id = $1', [waitingId])).length).toBe(1);
    });

    it('expires the account when the provider rejects its credential, raises the alert once, and fails what waits for it at its turn', async () => {
      const raised: Array<[string, unknown]> = [];
      const alerting = new ConversationSender({ database: tenants(), adapters: new ChannelAdapterRegistry([email, whatsapp], 'test'), alerts: { raise: (name: string, details: unknown) => void raised.push([name, details]), resolve: () => undefined } as never });
      const expiring = await account('EMAIL', 'Hộp thư hết hạn thông tin');
      const first = await conversation(expiring);
      const second = await conversation(expiring);
      await say(first.id, expiring);
      await say(second.id, expiring);
      email.enqueue({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'CREDENTIAL_EXPIRED' });
      await alerting.run(WORKER);
      expect((await rows<{ status: string }>('select status from machvon.channel_account where id = $1', [expiring]))[0]?.status).toBe('CredentialExpired');
      expect(raised).toEqual([[OMNI_CHANNEL_CREDENTIAL_EXPIRED_ALERT, { tenantId: TENANT_A, channelAccountId: expiring, channel: 'EMAIL' }]]);
      const states = [(await lastOutbound(first.id))?.error_code, (await lastOutbound(second.id))?.error_code].sort();
      // The first is the one the provider refused; the other is stopped at its turn, the account no longer being usable, and never sent.
      expect(states).toEqual(['CHANNEL_UNVERIFIED', 'CREDENTIAL_EXPIRED']);
      expect(email.requests).toHaveLength(1);
    });

    it('keeps the subject of a mail made from a template and gives it to the adapter', async () => {
      const template = id(0xe2, (counter += 1));
      await rows(
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by, provider_status, purpose)
         values ($1, $2, $3, 'EMAIL', 'vi-VN', 1, '{"subject":"Hồ sơ {{code}} đã có kết quả","body":"Xin chào, hồ sơ {{code}} đã có kết quả."}'::jsonb, '{"properties":{"code":{}}}'::jsonb, 'Active', repeat('c', 64), $4, 'NOT_REQUIRED', 'OPERATIONAL')`,
        [TENANT_A, template, `mail.subject.${counter}`, memberId(AGENT)],
      );
      const target = await conversation(emailAccount);
      expect((await say(target.id, emailAccount, { text: undefined, template_version_id: template, template_variables: { code: 'HS-07' } })).status).toBe(202);
      expect((await rows<{ subject: string }>('select subject from machvon.channel_message where conversation_id = $1 and direction = \'OUTBOUND\'', [target.id]))[0]?.subject).toBe('Hồ sơ HS-07 đã có kết quả');
      await pass();
      expect(email.requests).toHaveLength(1);
      expect(email.requests[0]).toMatchObject({ subject: 'Hồ sơ HS-07 đã có kết quả', text: 'Xin chào, hồ sơ HS-07 đã có kết quả.' });
      await expect(rows("update machvon.channel_message set subject = 'other' where conversation_id = $1 and direction = 'OUTBOUND'", [target.id])).rejects.toThrow(/MESSAGE_IMMUTABLE/);
    });

    it('does not send a link that has no origin of the application to rest on: the message ends as failed with the reason', async () => {
      const withoutOrigin = new ConversationSender({ database: tenants(), adapters: new ChannelAdapterRegistry([email, whatsapp], 'test') });
      const target = await conversation(emailAccount);
      const document = id(0xe3, (counter += 1));
      const version = id(0xe4, counter);
      await rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`, [TENANT_A, document, memberId(AGENT)]);
      await rows(
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/omni/linked.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, version, document],
      );
      expect((await say(target.id, emailAccount, { resource_links: [{ resource_type: 'document_version', resource_id: version }] })).status).toBe(202);
      await withoutOrigin.run(WORKER);
      expect(await lastOutbound(target.id)).toMatchObject({ delivery_status: 'Failed', error_code: 'WEB_BASE_URL_MISSING' });
      expect(email.requests).toHaveLength(0);
      // The send that was counted when it was taken up did not happen, so it takes nothing from the cap and the budget.
      expect((await rows('select 1 from machvon.channel_message_send where message_id = $1', [(await lastOutbound(target.id))?.id])).length).toBe(0);
      // A message without a link needs none.
      const plain = await conversation(emailAccount);
      await say(plain.id, emailAccount);
      await withoutOrigin.run(WORKER);
      expect(await lastOutbound(plain.id)).toMatchObject({ delivery_status: 'ProviderAccepted' });
    });

    it('does not move a reply to another channel: a message on a channel with no adapter fails with ADAPTER_MISSING and nothing is sent anywhere', async () => {
      const unserved = await conversation(smsAccount);
      await say(unserved.id, smsAccount);
      await pass();
      expect(await lastOutbound(unserved.id)).toMatchObject({ delivery_status: 'Failed', error_code: 'ADAPTER_MISSING' });
      expect((await rows('select 1 from machvon.channel_message_send where message_id = $1', [(await lastOutbound(unserved.id))?.id])).length).toBe(0);
      expect(email.requests).toHaveLength(0);
      expect(whatsapp.requests).toHaveLength(0);
    });

    it('asks again at the moment of sending: a consent withdrawn or a window ended after the message was queued ends it as failed, with the code, and nothing is sent', async () => {
      const withdrawn = await conversation(emailAccount);
      await consentOf(withdrawn, 'EMAIL', [{ purpose: 'REMINDER' }]);
      expect((await say(withdrawn.id, emailAccount, { purpose: 'REMINDER' })).status).toBe(202);
      const [granted] = await rows<{ id: string; version: string }>("select id, version::text as version from machvon.contact_consent where contact_id = $1 and purpose = 'REMINDER'", [withdrawn.contactId]);
      await tenants().withTenant(WORKER, (tx) => consents.withdrawOfContact(tx, granted?.id as string, Number(granted?.version), 'The person wrote STOP to the account.'));
      const closing = await conversation(whatsappAccount);
      expect((await say(closing.id, whatsappAccount)).status).toBe(202);
      await rows("update machvon.conversation set window_expires_at = now() - interval '1 minute' where id = $1", [closing.id]);
      await pass();
      expect(await lastOutbound(withdrawn.id)).toMatchObject({ delivery_status: 'Failed', error_code: 'CONSENT_DENIED', send_attempts: 0 });
      expect(await lastOutbound(closing.id)).toMatchObject({ delivery_status: 'Failed', error_code: 'OPT_IN_REQUIRED' });
      expect(email.requests).toHaveLength(0);
      expect(whatsapp.requests).toHaveLength(0);
    });

    it('also asks again whether the contact was blocked and whether the template is still Active, and fails the message with the code', async () => {
      const blocked = await conversation(emailAccount);
      expect((await say(blocked.id, emailAccount)).status).toBe(202);
      await rows("update machvon.contact set status = 'Blocked' where id = $1", [blocked.contactId]);
      const template = id(0xe2, (counter += 1));
      await rows(
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by, provider_status, purpose)
         values ($1, $2, $3, 'EMAIL', 'vi-VN', 1, '{"body":"Xin chào"}'::jsonb, '{}'::jsonb, 'Active', repeat('c', 64), $4, 'NOT_REQUIRED', 'OPERATIONAL')`,
        [TENANT_A, template, `mail.retired.${counter}`, memberId(AGENT)],
      );
      const retired = await conversation(emailAccount);
      expect((await say(retired.id, emailAccount, { text: undefined, template_version_id: template })).status).toBe(202);
      await rows("update machvon.notification_template_version set status = 'Retired' where id = $1", [template]);
      await pass();
      expect(await lastOutbound(blocked.id)).toMatchObject({ delivery_status: 'Failed', error_code: 'CONTACT_STATE_INVALID', send_attempts: 0 });
      expect(await lastOutbound(retired.id)).toMatchObject({ delivery_status: 'Failed', error_code: 'TEMPLATE_UNAVAILABLE', send_attempts: 0 });
      expect(email.requests).toHaveLength(0);
    });

    it('leases one message when its turn comes and not the whole batch: the messages that wait are not taken, and an answer of an attempt that was taken over changes nothing', async () => {
      const queued = [];
      for (let index = 0; index < 3; index += 1) {
        const target = await conversation(emailAccount);
        await say(target.id, emailAccount, { text: `Tin số ${index}` });
        queued.push(target.id);
      }
      const at = new Date();
      const first = await tenants().withTenant(WORKER, (tx) => outbound.claimNext(tx, at));
      expect(first).toBeDefined();
      const states = await Promise.all(queued.map((target) => lastOutbound(target)));
      expect(states.filter((state) => state?.send_attempts === 1)).toHaveLength(1);
      expect(states.filter((state) => state?.send_attempts === 0)).toHaveLength(2);
      // The lease ran out and another pass took the message up again: the answer of the first attempt is not written over it.
      await rows('update machvon.channel_message set next_attempt_at = now() - interval \'1 second\' where id = $1', [first?.id]);
      const second = await tenants().withTenant(WORKER, (tx) => outbound.claimNext(tx, new Date()));
      // The first attempt was never recorded: the message comes back to be asked about at the provider, uncounted.
      expect(second).toMatchObject({ id: first?.id, attempts: 1, reconcile: true });
      // The provider has no such request: it is taken up again, as the second attempt.
      const third = await tenants().withTenant(WORKER, (tx) => outbound.retake(tx, second as { id: string }, new Date()));
      expect(third).toMatchObject({ id: first?.id, attempts: 2, reconcile: false });
      await tenants().withTenant(WORKER, (tx) => outbound.recordResult(tx, { id: first?.id as string, attempts: 1, channelAccountId: emailAccount }, { kind: 'ACCEPTED', providerMessageId: 'late-answer' }, new Date()));
      expect((await rows<{ delivery_status: string; provider_message_id: string | null }>('select delivery_status, provider_message_id from machvon.channel_message where id = $1', [first?.id]))[0]).toEqual({ delivery_status: 'Queued', provider_message_id: null });
      await tenants().withTenant(WORKER, (tx) => outbound.recordResult(tx, { id: first?.id as string, attempts: 2, channelAccountId: emailAccount }, { kind: 'ACCEPTED', providerMessageId: 'current-answer' }, new Date()));
      expect((await rows<{ provider_message_id: string | null }>('select provider_message_id from machvon.channel_message where id = $1', [first?.id]))[0]?.provider_message_id).toBe('current-answer');
    });

    it('waits for the hours of a channel that is closed for the moment, without using an attempt', async () => {
      const target = await conversation(emailAccount);
      await say(target.id, emailAccount);
      const opens = new Date(Date.now() + 3_600_000);
      const hours = email as unknown as { closedUntil?: (now: Date) => Date | undefined };
      hours.closedUntil = () => opens;
      try {
        await pass();
      } finally {
        delete hours.closedUntil;
      }
      const waiting = await lastOutbound(target.id);
      expect(waiting).toMatchObject({ delivery_status: 'Queued', send_attempts: 0 });
      expect(email.requests).toHaveLength(0);
      expect(await pass(new Date(opens.getTime() + 1))).toBeGreaterThanOrEqual(1);
      expect(await lastOutbound(target.id)).toMatchObject({ delivery_status: 'ProviderAccepted', send_attempts: 1 });
    });

    it('takes a receipt of the provider forward only, and tells a receipt for something else from one for a message of a conversation', async () => {
      const target = await conversation(emailAccount);
      await say(target.id, emailAccount);
      await pass();
      const sent = await lastOutbound(target.id);
      const receipt = (status: string, providerMessageId = sent?.provider_message_id as string) => tenants().withTenant(WORKER, (tx) => outbound.applyReceipt(tx, emailAccount, providerMessageId, status));
      expect(await receipt('DELIVERED')).toBe('APPLIED');
      expect((await lastOutbound(target.id))?.delivery_status).toBe('Delivered');
      // A late receipt can not undo a later one, and a failure does not follow a delivery.
      expect(await receipt('ACCEPTED')).toBe('IGNORED');
      expect(await receipt('FAILED')).toBe('IGNORED');
      expect(await receipt('DELIVERED')).toBe('IGNORED');
      expect(await receipt('READ')).toBe('APPLIED');
      expect((await lastOutbound(target.id))?.delivery_status).toBe('Read');
      expect(await receipt('SOMETHING')).toBe('IGNORED');
      expect(await receipt('DELIVERED', 'not-a-message-of-a-conversation')).toBe('UNKNOWN');
      // The same id on another account is not this message.
      expect(await tenants().withTenant(WORKER, (tx) => outbound.applyReceipt(tx, smsAccount, sent?.provider_message_id as string, 'READ'))).toBe('UNKNOWN');
    });

    it('keeps what a message says and the way its status moves: the text, the purpose and the links never change, a status does not go back, a failure is final', async () => {
      const target = await conversation(emailAccount);
      await say(target.id, emailAccount);
      await pass();
      const sent = await lastOutbound(target.id);
      const refused = async (sql: string): Promise<string> => {
        try {
          await rows(sql, [sent?.id]);
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error('it was allowed');
      };
      expect(await refused("update machvon.channel_message set body_text = 'changed' where id = $1")).toMatch(/MESSAGE_IMMUTABLE/);
      expect(await refused("update machvon.channel_message set purpose = 'REMINDER' where id = $1")).toMatch(/MESSAGE_IMMUTABLE/);
      expect(await refused("update machvon.channel_message set links = '[1]'::jsonb where id = $1")).toMatch(/MESSAGE_IMMUTABLE/);
      expect(await refused("update machvon.channel_message set delivery_status = 'Queued' where id = $1")).toMatch(/MESSAGE_STATE_INVALID/);
      await rows("update machvon.channel_message set delivery_status = 'Delivered' where id = $1", [sent?.id]);
      expect(await refused("update machvon.channel_message set delivery_status = 'Failed' where id = $1")).toMatch(/MESSAGE_STATE_INVALID/);
      expect(await refused("update machvon.channel_message set delivery_status = 'ProviderAccepted' where id = $1")).toMatch(/MESSAGE_STATE_INVALID/);
      expect(await refused("update machvon.channel_message set delivery_status = null where id = $1")).toMatch(/MESSAGE_STATE_INVALID|channel_message_outbound_status_ck/);
      const failed = await conversation(emailAccount);
      await say(failed.id, emailAccount);
      email.enqueue({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'NO' });
      await pass();
      const final = await lastOutbound(failed.id);
      await expect(rows("update machvon.channel_message set delivery_status = 'Delivered' where id = $1", [final?.id])).rejects.toThrow(/MESSAGE_STATE_INVALID/);
    });
  });

  // The handle of the thread at the provider, which is where an answer goes.
  function handleOf(found: Array<{ external_thread_id: string }>): string | undefined {
    return found[0]?.external_thread_id;
  }
});
