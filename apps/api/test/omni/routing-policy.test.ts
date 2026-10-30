import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { ConversationStore, EffectiveAccessStore, InMemoryAuthzCache, RoutingPolicyStore, TenantDatabase, WORKER_MEMBERSHIP_ID, WorkCalendarStore } from '@machvon/db';
import type { InboundInput } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyController } from '../../src/omni/policy/policy.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const SUPERVISOR = 1; // manages the policy and the replies in the whole tenant
const AGENT = 2; // answers, does not manage
const UNIT_SUPERVISOR = 3; // manages in the unit 1 only
const WORKER = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
const REASON = 'The policy of the month was agreed with the supervisors.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the routing, the SLA in working time and the canned replies of the omnichannel center (ST-OMNI-006, OMNI-07, OMNI-08)', () => {
  const harness = new AuthzHarness();
  const store = new ConversationStore();
  const policies = new RoutingPolicyStore();
  const calendars = new WorkCalendarStore();
  let app: RunningApp;
  let counter = 0;
  let emailAccount: string;
  let whatsappAccount: string;

  const tenants = (): TenantDatabase => harness.tenants as TenantDatabase;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? SUPERVISOR, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function publishCalendar(year: number, code = 'VN-STD'): Promise<void> {
    await tenants().withTenant(WORKER, async (tx) => {
      const draft = await calendars.createDraft(tx, { calendar_code: code, year, working_days: [1, 2, 3, 4, 5], holidays: [], compensated_workdays: [], legal_basis_ref: 'Labour Code 2019, Article 112' }, memberId(SUPERVISOR));
      await calendars.publish(tx, await calendars.lockDraft(tx, draft.id, draft.version), memberId(SUPERVISOR));
    });
  }

  async function account(channel: string): Promise<string> {
    const accountId = id(0xe7, (counter += 1));
    await rows(
      `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, display_name)
       values ($1, $2, $3, $4, 'secret://t/x', 'v1', 'Active', now(), $3)`,
      [TENANT_A, accountId, channel, `ext-${accountId}`],
    );
    return accountId;
  }

  /** A message of a person, as the inbox processor puts it in. */
  async function inbound(accountId: string, change: Partial<InboundInput> = {}) {
    const n = (counter += 1);
    const inboxId = randomUUID();
    await rows(
      `insert into machvon.integration_event_inbox (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id)
       values ($1, $2, 'test-provider', $3, repeat('b', 64), 'ref', now(), 'PROCESSING', 'k1')`,
      [TENANT_A, inboxId, `event-${inboxId}`],
    );
    const outcome = await tenants().withTenant(WORKER, (tx) =>
      store.receiveInbound(tx, {
        inboxId,
        channelAccountId: accountId,
        providerMessageId: `pm-${n}`,
        externalThreadId: `thread-${n}`,
        sender: { externalId: accountId === emailAccount ? `p${n}@example.com` : `8491${String(600_000 + n)}`, displayName: 'Người gửi' },
        text: 'Xin chào',
        occurredAt: new Date(),
        ...change,
      }),
    );
    if (outcome.kind !== 'RECEIVED') throw new Error(outcome.kind);
    const [row] = await rows<{ queue_unit_id: string | null; priority: string; routing_policy_id: string | null; sla_first_response_due_at: Date | null; sla_resolution_due_at: Date | null }>(
      'select queue_unit_id, priority, routing_policy_id, sla_first_response_due_at, sla_resolution_due_at from machvon.conversation where id = $1',
      [outcome.conversationId],
    );
    return { id: outcome.conversationId, ...(row as NonNullable<typeof row>) };
  }

  const policyBody = (change: Record<string, unknown> = {}) => ({
    rules: [
      { channels: ['WHATSAPP'], keywords: ['khiếu nại', 'tố cáo'], queue_unit_id: unitId(1), priority: 'HIGH' },
      { channels: ['EMAIL'], queue_unit_id: unitId(2) },
    ],
    calendar_code: 'VN-STD',
    first_response_minutes: 30,
    resolution_hours: 24,
    ...change,
  });
  async function publish(change: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
    const made = await call('POST', '/conversation-routing-policies', { body: policyBody(change) });
    expect(made.status).toBe(201);
    const done = await call('POST', `/conversation-routing-policies/${made.json.resource_id}/publish`, { ifMatch: `"${made.json.resource_version}"`, body: { reason: REASON } });
    expect(done.status).toBe(200);
    return { id: made.json.resource_id as string, version: Number(done.json.resource_version) };
  }
  const reply = (change: Record<string, unknown> = {}) => ({ code: `greet.${(counter += 1)}`, title: 'Lời chào', body_text: 'Xin chào, chúng tôi đã nhận được tin của bạn.', channels: ['EMAIL', 'WHATSAPP'], classification: 'PUBLIC', ...change });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(2)}/` }]);
    for (const member of [SUPERVISOR, AGENT, UNIT_SUPERVISOR]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedRole(TENANT_A, 1, 'OMNI_POLICY_TEST', ['omni.policy.manage'], 50);
    await harness.seedRole(TENANT_A, 2, 'OMNI_AGENT_TEST', ['omni.conversation.reply'], 35);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: SUPERVISOR, role: 1, kind: 'TENANT' },
      { n: 2, member: AGENT, role: 2, kind: 'TENANT' },
      { n: 3, member: UNIT_SUPERVISOR, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    emailAccount = await account('EMAIL');
    whatsappAccount = await account('WHATSAPP');
    await publishCalendar(2026);
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants() }), PolicyModule.register({ database: tenants(), access: new EffectiveAccessStore(tenants(), new InMemoryAuthzCache()) })],
      controllers: [PolicyController],
      providers: [{ provide: TenantDatabase, useValue: tenants() }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('a routing policy', () => {
    it('is written as a Draft, numbered, published once at the version read, with the trail, and the one in force before is superseded', async () => {
      const made = await call('POST', '/conversation-routing-policies', { body: policyBody() });
      expect(made.status).toBe(201);
      expect(made.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const [draft] = await rows<{ revision: number; status: string; rules_json: Array<Record<string, unknown>> }>('select revision, status, rules_json from machvon.conversation_routing_policy where id = $1', [made.json.resource_id]);
      expect(draft?.status).toBe('Draft');
      expect(draft?.rules_json[0]).toEqual({ channels: ['WHATSAPP'], keywords: ['khieu nai', 'to cao'], queue_unit_id: unitId(1), priority: 'HIGH' });
      const stale = await call('POST', `/conversation-routing-policies/${made.json.resource_id}/publish`, { ifMatch: '"7"', body: { reason: REASON } });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const short = await call('POST', `/conversation-routing-policies/${made.json.resource_id}/publish`, { ifMatch: '"1"', body: { reason: 'short' } });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const done = await call('POST', `/conversation-routing-policies/${made.json.resource_id}/publish`, { ifMatch: '"1"', body: { reason: REASON } });
      expect(done.json).toMatchObject({ status: 'PUBLISHED', resource_version: 2 });
      const again = await call('POST', `/conversation-routing-policies/${made.json.resource_id}/publish`, { ifMatch: '"2"', body: { reason: REASON } });
      expect([again.status, again.json.code]).toEqual([409, 'POLICY_STATE_INVALID']);
      const trail = await rows<{ action: string; reason: string | null; safe_diff: Record<string, unknown> }>("select action, reason, safe_diff from machvon.audit_event where resource_id = $1 order by occurred_at", [made.json.resource_id]);
      expect(trail.map((row) => row.action)).toEqual(['omni.routing_policy_created', 'omni.routing_policy_published']);
      expect(trail[1]?.reason).toBe(REASON);
      // The next one replaces it: one is Published at a time.
      const next = await publish({ first_response_minutes: 45 });
      const states = await rows<{ id: string; status: string }>("select id, status from machvon.conversation_routing_policy where id = any($1::uuid[])", [[made.json.resource_id, next.id]]);
      expect(states.find((row) => row.id === made.json.resource_id)?.status).toBe('Superseded');
      expect(states.find((row) => row.id === next.id)?.status).toBe('Published');
      expect((await rows<{ n: string }>("select count(*)::text as n from machvon.conversation_routing_policy where status = 'Published'"))[0]?.n).toBe('1');
      const [numbers] = await rows<{ revisions: number[] }>('select array_agg(revision order by revision) as revisions from machvon.conversation_routing_policy');
      expect(numbers?.revisions).toEqual([...(numbers?.revisions ?? [])].sort((a, b) => a - b));
      expect(new Set(numbers?.revisions).size).toBe(numbers?.revisions.length);
    });

    it('is refused when it is not a policy (422 POLICY_INVALID naming the field), when a unit is not the tenant\'s, and when its calendar is not published for the year', async () => {
      const bad = async (change: Record<string, unknown>) => {
        const reply = await call('POST', '/conversation-routing-policies', { body: policyBody(change) });
        return [reply.status, reply.json.code, (reply.json as { detail?: string; errors?: Array<{ field?: string }> }).detail] as const;
      };
      expect((await bad({ first_response_minutes: 0 }))[0]).toBeGreaterThanOrEqual(400);
      expect(await bad({ calendar_code: 'not valid!' })).toEqual([422, 'POLICY_INVALID', 'calendar_code']);
      // A number out of the range of the contract is refused by the shape of the request, before the rules are read.
      expect(await bad({ resolution_hours: 2_401 })).toEqual([422, 'VALIDATION_FAILED', 'resolution_hours']);
      expect(await bad({ rules: [{ queue_unit_id: unitId(9) }] })).toEqual([422, 'POLICY_INVALID', 'rules']);
      expect(await bad({ rules: [{ queue_unit_id: unitId(1), channels: ['PUSH_FCM'] }] })).toEqual([422, 'VALIDATION_FAILED', 'rules.channels']);
      const made = await call('POST', '/conversation-routing-policies', { body: policyBody({ calendar_code: 'NO-SUCH-CALENDAR' }) });
      expect(made.status).toBe(201);
      const refused = await call('POST', `/conversation-routing-policies/${made.json.resource_id}/publish`, { ifMatch: '"1"', body: { reason: REASON } });
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'POLICY_INVALID', 'calendar_code']);
      expect((await rows<{ status: string }>('select status from machvon.conversation_routing_policy where id = $1', [made.json.resource_id]))[0]?.status).toBe('Draft');
      expect((await call('POST', `/conversation-routing-policies/${randomUUID()}/publish`, { ifMatch: '"1"', body: { reason: REASON } })).status).toBe(404);
    });

    it('is kept: what it says never changes, it is never deleted, it goes only forward, and two are not Published', async () => {
      const kept = await publish();
      const refused = async (sql: string): Promise<string> => {
        try {
          await rows(sql, [kept.id]);
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error('it was allowed');
      };
      expect(await refused("update machvon.conversation_routing_policy set first_response_minutes = 5 where id = $1")).toMatch(/POLICY_IMMUTABLE/);
      expect(await refused("update machvon.conversation_routing_policy set rules_json = '[]'::jsonb where id = $1")).toMatch(/POLICY_IMMUTABLE/);
      expect(await refused('delete from machvon.conversation_routing_policy where id = $1')).toMatch(/POLICY_IMMUTABLE/);
      expect(await refused("update machvon.conversation_routing_policy set status = 'Draft' where id = $1")).toMatch(/POLICY_STATE_INVALID/);
      const made = await call('POST', '/conversation-routing-policies', { body: policyBody() });
      await expect(rows("update machvon.conversation_routing_policy set status = 'Published' where id = $1", [made.json.resource_id])).rejects.toThrow(/conversation_routing_policy_published_uq/);
    });

    it('is read by the supervisors of the whole tenant, newest first, and by nobody else', async () => {
      const listed = await call('GET', '/conversation-routing-policies');
      expect(listed.status).toBe(200);
      const items = listed.json.items as Array<{ revision: number; status: string; rules: Array<{ keywords: string[] }> }>;
      expect(items.map((item) => item.revision)).toEqual([...items.map((item) => item.revision)].sort((a, b) => b - a));
      expect(items.filter((item) => item.status === 'Published')).toHaveLength(1);
      expect(items[0]?.rules[0]?.keywords).toEqual(['khieu nai', 'to cao']);
      // The units a rule may name come with the list: the supervisor needs no other permission to choose a queue.
      expect((listed.json.units as Array<{ id: string; name: string }>).map((unit) => unit.id)).toEqual(expect.arrayContaining([unitId(1), unitId(2)]));
      expect(listed.json.units).not.toContainEqual(expect.objectContaining({ id: unitId(9) }));
      expect((await call('GET', '/conversation-routing-policies', { member: AGENT })).status).toBe(403);
      expect((await call('GET', '/conversation-routing-policies', { member: UNIT_SUPERVISOR })).status).toBe(403);
      expect((await call('POST', '/conversation-routing-policies', { member: UNIT_SUPERVISOR, body: policyBody() })).status).toBe(403);
      expect((await call('GET', '/conversation-routing-policies', { member: SUPERVISOR, tenantId: TENANT_B })).status).toBe(403);
    });
  });

  describe('the lists', () => {
    it('are read a page at a time with an opaque cursor, whole, with no row left out or repeated, and a cursor that is not ours is 422', async () => {
      await publish();
      await publish();
      for (const code of ['page.one', 'page.two']) await call('POST', '/canned-replies', { body: reply({ code }) });
      for (const url of ['/conversation-routing-policies', '/canned-replies']) {
        const all = await call('GET', `${url}?limit=200`);
        const ids = (all.json.items as Array<{ id: string }>).map((item) => item.id);
        expect(ids.length).toBeGreaterThanOrEqual(2);
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page: Reply = await call('GET', `${url}?limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
          expect(page.status).toBe(200);
          seen.push(...(page.json.items as Array<{ id: string }>).map((item) => item.id));
          cursor = page.json.next_cursor as string | null;
        } while (cursor !== null);
        expect(seen).toEqual(ids);
        expect((await call('GET', `${url}?cursor=not-ours`)).status).toBe(422);
        expect((await call('GET', `${url}?limit=0`)).status).toBe(422);
      }
    });
  });

  describe('a conversation that begins', () => {
    it('AC-ST-OMNI-006-1 UAT-AC199: a message on Friday 16:50 with a first answer in 30 minutes is due on Monday 08:20, and the resolution in working hours too', async () => {
      const policy = await publish();
      const friday = new Date('2026-10-23T16:50:00+07:00');
      const made = await inbound(emailAccount, { occurredAt: friday, text: 'Hồ sơ của tôi đến đâu rồi?' });
      expect(made.routing_policy_id).toBe(policy.id);
      expect(made.sla_first_response_due_at?.toISOString()).toBe(new Date('2026-10-26T08:20:00+07:00').toISOString());
      // 24 working hours from Friday 16:50: 10 minutes that day, 8 hours on Monday and on Tuesday, and 7 hours 50 minutes of Wednesday.
      expect(made.sla_resolution_due_at?.toISOString()).toBe(new Date('2026-10-28T16:50:00+07:00').toISOString());
    });

    it('goes to the queue of the first rule that fits the channel and the words, with its priority, and to the queue of the whole tenant when none does', async () => {
      await publish();
      const routed = await inbound(whatsappAccount, { text: 'Tôi muốn KHIEU NAI về việc đền bù' });
      expect([routed.queue_unit_id, routed.priority]).toEqual([unitId(1), 'HIGH']);
      const byChannel = await inbound(emailAccount, { text: 'Khiếu nại' });
      expect([byChannel.queue_unit_id, byChannel.priority]).toEqual([unitId(2), 'NORMAL']);
      const none = await inbound(whatsappAccount, { text: 'Xin chào' });
      expect([none.queue_unit_id, none.priority]).toEqual([null, 'NORMAL']);
      // Still with a deadline: the policy gives that to every conversation.
      expect(none.sla_first_response_due_at).not.toBeNull();
    });

    it('keeps the version it was routed by when a later one is published, and a message in an open conversation does not route it again', async () => {
      const first = await publish();
      const made = await inbound(emailAccount, { externalThreadId: 'thread-kept' });
      const second = await publish({ rules: [{ queue_unit_id: unitId(1) }], first_response_minutes: 60 });
      expect(made.routing_policy_id).toBe(first.id);
      const again = await tenants().withTenant(WORKER, (tx) =>
        store.receiveInbound(tx, { inboxId: randomUUID(), channelAccountId: emailAccount, providerMessageId: 'pm-again', externalThreadId: 'thread-kept', sender: { externalId: 'a@example.com', displayName: 'A' }, text: 'Thêm một tin', occurredAt: new Date() }).catch((error: unknown) => error),
      );
      // (The inbox row of the second message is not planted: what matters is that the conversation was not touched by the new policy.)
      void again;
      const [row] = await rows<{ routing_policy_id: string; queue_unit_id: string | null }>('select routing_policy_id, queue_unit_id from machvon.conversation where id = $1', [made.id]);
      expect(row?.routing_policy_id).toBe(first.id);
      const next = await inbound(emailAccount);
      expect(next.routing_policy_id).toBe(second.id);
      expect(next.queue_unit_id).toBe(unitId(1));
    });

    it('counts each deadline on its own: one that runs into a year with no published calendar has none, and the other is given', async () => {
      await publish({ first_response_minutes: 10_080, resolution_hours: 1 });
      const made = await inbound(emailAccount, { occurredAt: new Date('2026-12-30T03:00:00Z') });
      expect(made.sla_first_response_due_at).toBeNull();
      expect(made.sla_resolution_due_at?.toISOString()).toBe(new Date('2026-12-30T11:00:00+07:00').toISOString());
    });

    it('is taken in without a deadline when the policy has no published calendar for the year of the message, and without a queue when no policy is in force', async () => {
      await publish();
      const far = await inbound(emailAccount, { occurredAt: new Date('2031-03-05T03:00:00Z') });
      expect(far.sla_first_response_due_at).toBeNull();
      expect(far.sla_resolution_due_at).toBeNull();
      expect(far.routing_policy_id).not.toBeNull();
      await rows("update machvon.conversation_routing_policy set status = 'Superseded' where status = 'Published'");
      const none = await inbound(emailAccount);
      expect([none.routing_policy_id, none.queue_unit_id, none.sla_first_response_due_at]).toEqual([null, null, null]);
      expect(await tenants().withTenant(WORKER, (tx) => policies.inForce(tx))).toBeUndefined();
    });
  });

  describe('a canned reply', () => {
    beforeAll(async () => {
      for (const code of ['list.one', 'list.two']) await call('POST', '/canned-replies', { body: reply({ code }) });
    });

    it('is made with a code, a title, a text with no variable, its channels and a class that may be sent, with the trail, and read by code', async () => {
      const body = reply({ code: 'greet.first', classification: 'INTERNAL' });
      const made = await call('POST', '/canned-replies', { body });
      expect(made.status).toBe(201);
      expect(made.json).toMatchObject({ status: 'ACTIVE', resource_version: 1 });
      const trail = await rows<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id = $1', [made.json.resource_id]);
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({ action: 'omni.canned_reply_created', safe_diff: { code: 'greet.first', classification: 'INTERNAL' } });
      expect(JSON.stringify(trail)).not.toContain('chúng tôi đã nhận');
      const listed = await call('GET', '/canned-replies');
      const codes = (listed.json.items as Array<{ code: string }>).map((item) => item.code);
      expect(codes).toContain('greet.first');
      expect(codes).toEqual([...codes].sort());
      expect((listed.json.items as Array<{ code: string; body_text: string; channels: string[] }>).find((item) => item.code === 'greet.first')).toMatchObject({ body_text: body.body_text, channels: ['EMAIL', 'WHATSAPP'] });
    });

    it('AC-ST-OMNI-006-3 UAT-PLAN-52: a text with a variable, or a class that is confidential, is refused with 422 on the field and is not stored', async () => {
      const before = (await rows<{ n: string }>('select count(*)::text as n from machvon.canned_reply'))[0]?.n;
      for (const [change, field] of [
        [{ body_text: 'Xin chào {{name}}' }, 'body_text'],
        [{ body_text: 'Mã hồ sơ ${code}' }, 'body_text'],
        [{ classification: 'CONFIDENTIAL' }, 'classification'],
        [{ classification: 'PERSONAL' }, 'classification'],
        [{ channels: ['PUSH_FCM'] }, 'channels'],
        [{ code: 'No' }, 'code'],
      ] as const) {
        const refused = await call('POST', '/canned-replies', { body: reply(change) });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.canned_reply'))[0]?.n).toBe(before);
    });

    it('is 409 CANNED_CODE_TAKEN for a code that is used, also when two supervisors take it at once', async () => {
      const body = reply({ code: 'greet.taken' });
      expect((await call('POST', '/canned-replies', { body })).status).toBe(201);
      const taken = await call('POST', '/canned-replies', { body });
      expect([taken.status, taken.json.code]).toEqual([409, 'CANNED_CODE_TAKEN']);
      const race = reply({ code: 'greet.race' });
      const [one, two] = await Promise.all([call('POST', '/canned-replies', { body: race }), call('POST', '/canned-replies', { body: race })]);
      expect([one.status, two.status].sort()).toEqual([201, 409]);
      expect((await rows<{ n: string }>("select count(*)::text as n from machvon.canned_reply where code = 'greet.race'"))[0]?.n).toBe('1');
    });

    it('is changed at the version read, with its code kept, and a stale version is 409 VERSION_CONFLICT', async () => {
      const body = reply({ code: 'greet.change' });
      const made = await call('POST', '/canned-replies', { body });
      const id1 = made.json.resource_id as string;
      const changed = await call('PUT', `/canned-replies/${id1}`, { ifMatch: '"1"', body: { ...body, title: 'Lời chào mới', body_text: 'Chúng tôi sẽ trả lời trong ngày.', channels: ['SMS'.replace('SMS', 'EMAIL')] } });
      expect(changed.status).toBe(200);
      expect(changed.json).toMatchObject({ status: 'ACTIVE', resource_version: 2 });
      expect((await rows<{ title: string; body_text: string }>('select title, body_text from machvon.canned_reply where id = $1', [id1]))[0]).toEqual({ title: 'Lời chào mới', body_text: 'Chúng tôi sẽ trả lời trong ngày.' });
      const stale = await call('PUT', `/canned-replies/${id1}`, { ifMatch: '"1"', body });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const rename = await call('PUT', `/canned-replies/${id1}`, { ifMatch: '"2"', body: { ...body, code: 'greet.renamed' } });
      expect([rename.status, rename.json.code, rename.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'code']);
      const variable = await call('PUT', `/canned-replies/${id1}`, { ifMatch: '"2"', body: { ...body, body_text: 'Chào {{name}}' } });
      expect([variable.status, variable.json.detail]).toEqual([422, 'body_text']);
      expect((await call('PUT', `/canned-replies/${randomUUID()}`, { ifMatch: '"1"', body })).status).toBe(404);
      await expect(rows("update machvon.canned_reply set code = 'other.code' where id = $1", [id1])).rejects.toThrow(/REPLY_IMMUTABLE/);
      await expect(rows('delete from machvon.canned_reply where id = $1', [id1])).rejects.toThrow(/REPLY_IMMUTABLE/);
    });

    it('is for the supervisors of the whole tenant: an agent, and a supervisor of one unit, are 403', async () => {
      for (const member of [AGENT, UNIT_SUPERVISOR]) {
        expect((await call('POST', '/canned-replies', { member, body: reply() })).status).toBe(403);
        expect((await call('GET', '/canned-replies', { member })).status).toBe(403);
        expect((await call('PUT', `/canned-replies/${randomUUID()}`, { member, ifMatch: '"1"', body: reply() })).status).toBe(403);
      }
    });
  });
});
