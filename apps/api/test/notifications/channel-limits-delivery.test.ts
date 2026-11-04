import { createHash, randomUUID } from 'node:crypto';
import { AuditWriter, ChannelAccountStore, ContactConsentStore, DeliveryStore, EffectiveAccessStore, InMemoryAuthzCache, NotificationStore } from '@machvon/db';
import type { NotificationPriority, TenantTx } from '@machvon/db';
import { dedupeKeyOf } from '../../src/notifications/dedupe';
import { ChannelAdapterRegistry, InMemoryChannelAdapter } from '../../src/notifications/delivery/channel-adapters';
import { DeliveryDispatcher } from '../../src/notifications/delivery/dispatcher';
import { SmsHoursAdapter } from '../../src/notifications/delivery/sms-adapter';
import { createDeliveryEngine } from '../../src/notifications/delivery/wiring';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { AuthzHarness, TENANT_A, id, memberId } from '../../../../packages/db/test/support/authz-fixtures';

const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e2';
const MEMBER = 1;
// 12:00 in Vietnam, inside the sending hours of the SMS gateway.
const NOON = new Date('2026-10-22T05:00:00.000Z');
const CONTEXT = { tenantId: TENANT_A, membershipId: memberId(MEMBER), scopeVersion: 0 };

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('the cap and the budget of a channel account at the moment of sending (ST-NOT-010, BR-NOT-13)', () => {
  const harness = new AuthzHarness();
  const notifications = new NotificationStore();
  const deliveries = new DeliveryStore();
  let sms: InMemoryChannelAdapter;
  let clock = NOON;
  let dispatcher: DeliveryDispatcher;
  let accountId = '';
  let accountSeq = 0;

  const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MEMBER), scopeVersion: 1 }, work);
  const owner = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => harness.owner<T>(TENANT_A, [[text, params]]);
  const engine = createDeliveryEngine({ recordInTx: (tx, actor, entry) => new AuditWriter(harness.tenants).recordInTx(tx, actor, entry) });

  /** The only Active SMS account, with the limits the test needs. */
  async function account(limits: { cap?: number; budget?: string } = {}): Promise<string> {
    await owner("update machvon.channel_account set status = 'Disabled' where channel = 'SMS' and status <> 'Disabled'");
    accountId = id(0xd0, (accountSeq += 1));
    await owner(
      `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref, daily_send_cap, monthly_budget_vnd)
       values ($1, $2, 'SMS', $3, 'secret://test/sms', 'v1', 'Active', now(), 'secret://test/sms-webhook', $4, $5)`,
      [TENANT_A, accountId, `sms-${accountSeq}-${randomUUID().slice(0, 6)}`, limits.cap ?? null, limits.budget ?? null],
    );
    return accountId;
  }

  async function notify(priority: NotificationPriority = 'NORMAL'): Promise<string> {
    return as(async (tx) => {
      const eventId = randomUUID();
      const inserted = await notifications.insert(tx, {
        eventId,
        workflowVersionId: WORKFLOW,
        recipientId: memberId(MEMBER),
        purpose: 'OPERATIONAL',
        dedupeKey: dedupeKeyOf({ tenantId: TENANT_A, sourceEventId: eventId, recipientId: memberId(MEMBER), purpose: 'OPERATIONAL' }),
        expiresAt: new Date('2026-12-30T00:00:00Z'),
        sourceEventType: 'report.overdue',
        eventVersion: 1,
        priority,
        ackRequired: false,
        channelPlan: ['SMS'],
      });
      await engine.startChain(tx, await deliveries.requireNotification(tx, inserted.id));
      return inserted.id;
    });
  }

  const attemptOf = async (notificationId: string) => {
    const [row] = await owner<{ id: string; status: string; error_code: string | null; next_retry_at: Date | null; cost: string }>('select id, status, error_code, next_retry_at, cost::text as cost from machvon.delivery_attempt where notification_id = $1 order by attempt_no limit 1', [notificationId]);
    if (row === undefined) throw new Error('no attempt');
    return row;
  };
  const dispatch = async (at: Date = clock): Promise<void> => {
    clock = at;
    await dispatcher.dispatchDue(CONTEXT);
  };

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/1/' }]);
    await harness.seedMembership(TENANT_A, MEMBER, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await owner('update machvon.user_account set phone_e164 = $2 where id = $1', [id(0x60, MEMBER), '+84900000001']);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'report.overdue', 1, $4::jsonb, 'Published', 'NOTIFICATION', 'report.overdue', $3, repeat('a', 64))`,
        [TENANT_A, WORKFLOW, ACTOR, JSON.stringify({ channels: [{ channel: 'SMS', templateCode: 'sms.a' }] })],
      ],
      [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by)
         values ($1, $2, 'sms.a', 'SMS', 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, 'Active', $3, $4)`,
        [TENANT_A, TEMPLATE, sha('sms.a'), ACTOR],
      ],
    ]);
    await as((tx) => new ContactConsentStore().grant(tx, memberId(MEMBER), { channel: 'SMS', purpose: 'OPERATIONAL', consentTextVersion: 'v1', captureMethod: 'IN_APP' }));
    sms = new InMemoryChannelAdapter({ provider: 'sms-gateway', channel: 'SMS', status: 'MOCK', paid: true });
    const access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
    dispatcher = new DeliveryDispatcher({ database: harness.tenants, engine, adapters: new ChannelAdapterRegistry([sms], 'test'), loadAccess: (ctx) => access.load(ctx), resourceAccess: new PermissionResourceAccess(), now: () => clock }, 'test');
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  beforeEach(() => {
    clock = NOON;
  });

  it('AC-ST-NOT-010-1 UAT-AC191: a budget at 999,900 of 1,000,000: an ordinary message is held until next month and a CRITICAL one is sent', async () => {
    const holder = await account({ budget: '1000000' });
    // The month so far cost 999,900: one earlier send that was priced so.
    const earlier = await notify();
    await dispatch();
    expect(await attemptOf(earlier)).toMatchObject({ status: 'ProviderAccepted', cost: '800.00000000' });
    await owner("update machvon.delivery_attempt set cost = 999900 where notification_id = $1", [earlier]);
    const ordinary = await notify('NORMAL');
    const urgent = await notify('CRITICAL');
    const before = sms.requests.length;
    await dispatch();
    expect(await attemptOf(urgent)).toMatchObject({ status: 'ProviderAccepted' });
    const held = await attemptOf(ordinary);
    expect(held).toMatchObject({ status: 'Queued', error_code: 'CHANNEL_BUDGET' });
    // Held until the first moment of next month in Vietnam (October 31st 17:00 UTC).
    expect(held.next_retry_at?.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    expect(sms.requests).toHaveLength(before + 1);
    // Next month the budget is a new one and the held message goes (after the quiet hours of the person, which end at 07:00).
    await dispatch(new Date('2026-11-01T00:00:30Z'));
    expect(await attemptOf(ordinary)).toMatchObject({ status: 'ProviderAccepted' });
    expect(holder).toBeDefined();
  });

  it('judges what the old limits held again as soon as the limits are changed, instead of leaving it for the next month', async () => {
    const holder = await account({ budget: '1000' });
    const earlier = await notify();
    await dispatch();
    await owner('update machvon.delivery_attempt set cost = 900 where notification_id = $1', [earlier]);
    const waiting = await notify();
    await dispatch();
    expect(await attemptOf(waiting)).toMatchObject({ status: 'Queued', error_code: 'CHANNEL_BUDGET' });
    // The budget is raised: the held one is due now and goes at the next round, with no wait for November.
    await as((tx) => new ChannelAccountStore().setLimits(tx, holder, 1, { monthlyBudgetVnd: '5000' }));
    await dispatch();
    expect(await attemptOf(waiting)).toMatchObject({ status: 'ProviderAccepted' });
    // A change that keeps it over the limit holds it again for the next period.
    const again = await notify();
    await owner('update machvon.delivery_attempt set cost = 4500 where notification_id = $1', [earlier]);
    await dispatch();
    expect(await attemptOf(again)).toMatchObject({ status: 'Queued', error_code: 'CHANNEL_BUDGET' });
    await as((tx) => new ChannelAccountStore().setLimits(tx, holder, 2, { monthlyBudgetVnd: '5100' }));
    await dispatch();
    expect(await attemptOf(again)).toMatchObject({ status: 'Queued', error_code: 'CHANNEL_BUDGET' });
    expect((await attemptOf(again)).next_retry_at?.toISOString()).toBe('2026-10-31T17:00:00.000Z');
  });

  it('wakes a held message no later than its expiry, so it expires at its deadline and not at the next reset of the limit', async () => {
    await account({ budget: '1000' });
    const earlier = await notify();
    await dispatch();
    await owner('update machvon.delivery_attempt set cost = 900 where notification_id = $1', [earlier]);
    const waiting = await notify();
    await owner("update machvon.notification_instance set expires_at = '2026-10-25T00:00:00Z' where id = $1", [waiting]);
    await dispatch();
    const held = await attemptOf(waiting);
    expect(held).toMatchObject({ status: 'Queued', error_code: 'CHANNEL_BUDGET' });
    expect(held.next_retry_at?.toISOString()).toBe('2026-10-25T00:00:00.000Z');
    await dispatch(new Date('2026-10-25T00:00:30Z'));
    expect((await attemptOf(waiting)).status).toBe('Cancelled');
    expect(await owner<{ status: string }>('select status from machvon.notification_instance where id = $1', [waiting])).toEqual([{ status: 'Expired' }]);
  });

  it('does not deadlock a change of the limits with a claim of a held attempt: both take the attempt before the account', async () => {
    const holder = await account({ cap: 1 });
    const queued = await notify();
    await owner("update machvon.delivery_attempt set error_code = 'CHANNEL_CAP', next_retry_at = now() + interval '1 day' where notification_id = $1", [queued]);
    const attemptId = (await attemptOf(queued)).id;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    // What a claim does: the attempt first, then the account (shared).
    const claimer = as(async (tx) => {
      await tx.query('select id from machvon.delivery_attempt where id = $1::uuid for update', [attemptId]);
      locked();
      await gate;
      await tx.query('select id from machvon.channel_account where id = $1::uuid for share', [holder]);
    });
    await hasLock;
    const changer = as((tx) => new ChannelAccountStore().setLimits(tx, holder, 1, { dailySendCap: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await expect(Promise.all([claimer, changer])).resolves.toBeDefined();
    expect(await attemptOf(queued)).toMatchObject({ status: 'Queued', error_code: null, next_retry_at: null });
  });

  it('holds what goes over the daily cap until tomorrow, lets the CRITICAL one go, and sends the held ones the next day', async () => {
    await account({ cap: 2 });
    const first = [await notify(), await notify(), await notify(), await notify('LOW')];
    const urgent = await notify('CRITICAL');
    await dispatch();
    const states = await Promise.all(first.map(attemptOf));
    expect(states.filter((state) => state.status === 'ProviderAccepted')).toHaveLength(2);
    const held = states.filter((state) => state.status === 'Queued');
    expect(held).toHaveLength(2);
    for (const state of held) {
      expect(state.error_code).toBe('CHANNEL_CAP');
      expect(state.next_retry_at?.toISOString()).toBe('2026-10-22T17:00:00.000Z');
    }
    expect((await attemptOf(urgent)).status).toBe('ProviderAccepted');
    // The day after, a new day's cap: two of the held go, then the cap holds the rest again.
    await dispatch(new Date('2026-10-23T00:00:30Z'));
    const next = await Promise.all(first.map(attemptOf));
    expect(next.filter((state) => state.status === 'ProviderAccepted')).toHaveLength(4);
  });

  it('writes the estimated price on a message when it is taken up, and counts an accepted message once in SAS under the meter of its channel', async () => {
    await account({});
    const notificationId = await notify();
    await dispatch();
    const attempt = await attemptOf(notificationId);
    expect(attempt).toMatchObject({ status: 'ProviderAccepted', cost: '800.00000000' });
    const events = await owner<{ meter: string; quantity: string; external_event_key: string }>("select meter, quantity::text as quantity, external_event_key from machvon.usage_meter_event where external_event_key = $1", [attempt.id]);
    expect(events).toEqual([{ meter: 'notification.sms', quantity: '1.000000', external_event_key: attempt.id }]);
    // Nothing else to do for it: another pass adds no event.
    await dispatch();
    expect(await owner("select 1 from machvon.usage_meter_event where external_event_key = $1", [attempt.id])).toHaveLength(1);
  });

  it('puts a text back for the sending hours without taking it up: no attempt used, no price written, no failure for the circuit, and it goes when the hours open', async () => {
    await account({});
    const hours = new SmsHoursAdapter(undefined, () => clock);
    const access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
    const nightly = new DeliveryDispatcher({ database: harness.tenants, engine, adapters: new ChannelAdapterRegistry([hours], 'test'), loadAccess: (ctx) => access.load(ctx), resourceAccess: new PermissionResourceAccess(), now: () => clock }, 'test');
    const queued = await notify();
    // 23:30 in Vietnam: the gateway is closed.
    clock = new Date('2026-10-22T16:30:00Z');
    await nightly.dispatchDue(CONTEXT);
    const waiting = await attemptOf(queued);
    expect(waiting).toMatchObject({ status: 'Queued', error_code: 'OUTSIDE_SENDING_HOURS', cost: '0.00000000' });
    expect(waiting.next_retry_at?.toISOString()).toBe('2026-10-22T17:30:00.000Z'.replace('17:30', '00:00').replace('10-22', '10-23'));
    expect(await owner('select 1 from machvon.delivery_attempt where notification_id = $1', [queued])).toHaveLength(1);
    expect(await owner('select 1 from machvon.channel_account_circuit where channel_account_id = $1 and (state <> $2 or opened_at is not null)', [accountId, 'CLOSED'])).toEqual([]);
    expect(hours.requests).toHaveLength(0);
    // 07:00 the next morning in Vietnam: the hours are open and the text goes (after the quiet hours of the person, which end at 07:00).
    clock = new Date('2026-10-23T00:00:30Z');
    await nightly.dispatchDue(CONTEXT);
    expect(await attemptOf(queued)).toMatchObject({ status: 'ProviderAccepted', cost: '800.00000000' });
    expect(hours.requests).toHaveLength(1);
    clock = NOON;
  });

  it('lets a text that expires in the night expire at its deadline instead of putting it back again and again until the hours open', async () => {
    await account({});
    const hours = new SmsHoursAdapter(undefined, () => clock);
    const access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
    const nightly = new DeliveryDispatcher({ database: harness.tenants, engine, adapters: new ChannelAdapterRegistry([hours], 'test'), loadAccess: (ctx) => access.load(ctx), resourceAccess: new PermissionResourceAccess(), now: () => clock }, 'test');
    const queued = await notify();
    // It expires at 01:00 in Vietnam, in the middle of the closed hours.
    await owner("update machvon.notification_instance set expires_at = '2026-10-22T18:00:00Z' where id = $1", [queued]);
    clock = new Date('2026-10-22T16:30:00Z');
    await nightly.dispatchDue(CONTEXT);
    expect((await attemptOf(queued)).next_retry_at?.toISOString()).toBe('2026-10-22T18:00:00.000Z');
    clock = new Date('2026-10-22T18:00:30Z');
    await nightly.dispatchDue(CONTEXT);
    expect((await attemptOf(queued)).status).toBe('Cancelled');
    expect(await owner<{ status: string }>('select status from machvon.notification_instance where id = $1', [queued])).toEqual([{ status: 'Expired' }]);
    expect(hours.requests).toHaveLength(0);
    clock = NOON;
  });

  it('does not count a message that was not sent: a held one costs nothing and an account without limits holds nothing', async () => {
    await account({ cap: 1 });
    const sent = await notify();
    const held = await notify();
    await dispatch();
    // The two messages are sent at the same time and race for the one place under the cap: which of them gets it is not decided, that exactly one does and the other costs nothing is.
    const attempts = [await attemptOf(sent), await attemptOf(held)];
    expect(attempts.filter((attempt) => attempt.status === 'ProviderAccepted')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'Queued')).toEqual([expect.objectContaining({ status: 'Queued', cost: '0.00000000' })]);
    await account({});
    const free = [await notify(), await notify(), await notify()];
    await dispatch();
    for (const notificationId of free) expect((await attemptOf(notificationId)).status).toBe('ProviderAccepted');
  });
});

describe('the SMS gateway sends only in its hours (ST-NOT-010, MOCK)', () => {
  const request = { idempotencyKey: 'n:SMS:1', accountId: 'a', to: '+84900000001', text: 'B' };

  it('accepts a text in the day and holds one in the night until the hours open, with the wait', async () => {
    const at = (iso: string) => new SmsHoursAdapter(undefined, () => new Date(iso));
    // 12:00 in Vietnam.
    expect(await at('2026-10-22T05:00:00Z').send(request)).toMatchObject({ kind: 'ACCEPTED' });
    // 23:30 in Vietnam: opens at 07:00, 7.5 hours later.
    expect(await at('2026-10-22T16:30:00Z').send({ ...request, idempotencyKey: 'n:SMS:2' })).toEqual({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'OUTSIDE_SENDING_HOURS', retryAfterSeconds: 27_000 });
    // 03:00 in Vietnam: four hours.
    expect(await at('2026-10-21T20:00:00Z').send({ ...request, idempotencyKey: 'n:SMS:3' })).toMatchObject({ kind: 'FAILED', retryAfterSeconds: 14_400 });
    // 21:00 is closed, 07:00 is open.
    expect((await at('2026-10-22T14:00:00Z').send({ ...request, idempotencyKey: 'n:SMS:4' })).kind).toBe('FAILED');
    expect((await at('2026-10-22T00:00:00Z').send({ ...request, idempotencyKey: 'n:SMS:5' })).kind).toBe('ACCEPTED');
  });
});
