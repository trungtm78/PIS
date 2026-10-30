import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, DeliveryStore, EffectiveAccessStore, InMemoryAuthzCache, NotificationStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import { dedupeKeyOf } from '../../src/notifications/dedupe';
import { ChannelAdapterRegistry } from '../../src/notifications/delivery/channel-adapters';
import { DeliveryDispatcher } from '../../src/notifications/delivery/dispatcher';
import { defaultChannelAdapters, createDeliveryEngine } from '../../src/notifications/delivery/wiring';
import { InMemoryPushTokenVault, pushSecretRefOf } from '../../src/notifications/devices/push-vault';
import { MockPushProvider } from '../../src/notifications/push/ports';
import type { PushProviderAnswer } from '../../src/notifications/push/ports';
import { PushChannelAdapter } from '../../src/notifications/push/push-adapter';
import { SilentPushConsumer } from '../../src/notifications/push/silent-push';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { AuthzHarness, TENANT_A, TENANT_B, memberId } from '../../../../packages/db/test/support/authz-fixtures';

const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const FCM_ACCOUNT = '00000000-0000-4000-8000-0000000000d3';
const APNS_ACCOUNT = '00000000-0000-4000-8000-0000000000d4';
const FCM_TEMPLATE = '00000000-0000-4000-8000-0000000000e3';
const APNS_TEMPLATE = '00000000-0000-4000-8000-0000000000e4';
const RELAY_KEY = randomBytes(32);
const PERSON = 1;
const OTHER = 2;
const NOBODY = 3;
const NOON = new Date('2026-10-22T05:00:00.000Z');
const CONTEXT = { tenantId: TENANT_A, membershipId: memberId(PERSON), scopeVersion: 0 };
const NEUTRAL = 'A dossier needs your attention.';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('the push channels (ST-NOT-007, NOT 9)', () => {
  const harness = new AuthzHarness();
  const notifications = new NotificationStore();
  const deliveries = new DeliveryStore();
  const vault = new InMemoryPushTokenVault();
  const fcm = new MockPushProvider();
  const apns = new MockPushProvider();
  let registry: ChannelAdapterRegistry;
  let dispatcher: DeliveryDispatcher;
  let silent: SilentPushConsumer;
  let counter = 0;

  const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, work);
  const owner = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => harness.owner<T>(TENANT_A, [[text, params]]);
  const engine = createDeliveryEngine({ recordInTx: (tx, actor, entry) => new AuditWriter(harness.tenants).recordInTx(tx, actor, entry) });

  /** A device as the registration command leaves it: a row, and the token in the vault under its reference. */
  async function device(member: number, options: { platform?: string; permission?: string; token?: string; tenant?: string } = {}): Promise<{ id: string; ref: string; token: string }> {
    const tenant = options.tenant ?? TENANT_A;
    const deviceId = randomUUID();
    const token = options.token ?? `token-${(counter += 1)}-${randomUUID()}`;
    const ref = pushSecretRefOf(tenant, deviceId);
    await harness.owner(tenant, [
      [
        `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, permission_state, app_version)
         values ($1, $2, $3, $4, $5, $6, now(), $7, $8, '1.0.0')`,
        [tenant, deviceId, memberId(member), `public-${deviceId}`, ref, options.platform ?? 'android', sha(token), options.permission ?? 'granted'],
      ],
    ]);
    await vault.put(ref, token);
    return { id: deviceId, ref, token };
  }

  const deviceRow = async (deviceId: string): Promise<{ revoked_at: Date | null; push_secret_ref: string | null; revoke_reason: string | null }> => {
    const [row] = await owner<{ revoked_at: Date | null; push_secret_ref: string | null; revoke_reason: string | null }>('select revoked_at, push_secret_ref, revoke_reason from machvon.device_registration where id = $1', [deviceId]);
    if (row === undefined) throw new Error('no device');
    return row;
  };

  /** A notification as the consumer makes it: inserted with its plan for one push channel, and its chain started. */
  async function notify(member: number, channel: 'PUSH_FCM' | 'PUSH_APNS' = 'PUSH_FCM'): Promise<string> {
    return as(member, async (tx) => {
      const eventId = randomUUID();
      const inserted = await notifications.insert(tx, {
        eventId,
        workflowVersionId: WORKFLOW,
        recipientId: memberId(member),
        purpose: 'OPERATIONAL',
        dedupeKey: dedupeKeyOf({ tenantId: TENANT_A, sourceEventId: eventId, recipientId: memberId(member), purpose: 'OPERATIONAL' }),
        expiresAt: new Date('2026-10-30T00:00:00Z'),
        sourceEventType: 'report.overdue',
        eventVersion: 1,
        priority: 'NORMAL',
        ackRequired: false,
        channelPlan: [channel],
      });
      await engine.startChain(tx, await deliveries.requireNotification(tx, inserted.id));
      return inserted.id;
    });
  }

  const attemptOf = async (notificationId: string): Promise<{ status: string; error_code: string | null; failure_class: string | null }> => {
    const [row] = await owner<{ status: string; error_code: string | null; failure_class: string | null }>('select status, error_code, failure_class from machvon.delivery_attempt where notification_id = $1 order by attempt_no limit 1', [notificationId]);
    if (row === undefined) throw new Error('no attempt');
    return row;
  };

  const dispatch = async (): Promise<void> => {
    await dispatcher.dispatchDue(CONTEXT);
  };

  const delivery = (type: string, payload: Record<string, unknown>, tenant = TENANT_A) => ({
    id: randomUUID(),
    tenantId: tenant,
    tenantContext: signTenantContext({ tenantId: tenant, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, RELAY_KEY),
    type,
    payload,
  });

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/1/' }]);
    for (const member of [PERSON, OTHER, NOBODY]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'report.overdue', 1, $4::jsonb, 'Published', 'NOTIFICATION', 'report.overdue', $3, repeat('a', 64))`,
        [TENANT_A, WORKFLOW, ACTOR, JSON.stringify({ channels: [{ channel: 'PUSH_FCM', templateCode: 'push.fcm' }, { channel: 'PUSH_APNS', templateCode: 'push.apns' }] })],
      ],
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref)
         values ($1, $2, 'PUSH_FCM', 'fcm-project', 'secret://test/fcm', 'v1', 'Active', now(), 'secret://test/fcm-webhook'),
                ($1, $3, 'PUSH_APNS', 'apns-team', 'secret://test/apns', 'v1', 'Active', now(), 'secret://test/apns-webhook')`,
        [TENANT_A, FCM_ACCOUNT, APNS_ACCOUNT],
      ],
      [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by, lockscreen_safe)
         values ($1, $2, 'push.fcm', 'PUSH_FCM', 'vi-VN', 1, $5::jsonb, '{}'::jsonb, 'Active', $6, $4, true),
                ($1, $3, 'push.apns', 'PUSH_APNS', 'vi-VN', 1, $5::jsonb, '{}'::jsonb, 'Active', $7, $4, true)`,
        [TENANT_A, FCM_TEMPLATE, APNS_TEMPLATE, ACTOR, JSON.stringify({ body: NEUTRAL }), sha('push.fcm'), sha('push.apns')],
      ],
    ]);
    registry = new ChannelAdapterRegistry(
      [new PushChannelAdapter('mock-fcm', 'PUSH_FCM', fcm), new PushChannelAdapter('mock-apns', 'PUSH_APNS', apns)],
      'test',
    );
    const access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
    dispatcher = new DeliveryDispatcher(
      { database: harness.tenants, engine, adapters: registry, loadAccess: (ctx) => access.load(ctx), resourceAccess: new PermissionResourceAccess(), now: () => NOON, pushTokens: vault },
      'test',
    );
    silent = new SilentPushConsumer({ database: harness.tenants, adapters: registry, vault, security: { signingKey: RELAY_KEY } });
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  beforeEach(() => {
    fcm.sent.length = 0;
    apns.sent.length = 0;
    fcm.recover();
    apns.recover();
  });

  describe('a push to the devices of the recipient', () => {
    it('AC-ST-NOT-007-2 UAT-AC28: the provider receives a neutral sentence and an opaque link, nothing of the event, and a figure in the event reaches no lock screen', async () => {
      const mine = await device(PERSON);
      const notificationId = await notify(PERSON);
      await dispatch();
      expect(await attemptOf(notificationId)).toMatchObject({ status: 'ProviderAccepted' });
      expect(fcm.sent).toHaveLength(1);
      const [message] = fcm.sent;
      expect(message).toMatchObject({ token: mine.token, body: NEUTRAL, silent: false });
      expect(message?.data).toEqual({ deep_link: `/r/${notificationId}` });
      expect(JSON.stringify(message)).not.toMatch(/\{\{|amount|đồng|VND/i);
    });

    it('AC-ST-NOT-007-1 UAT-AC179: a token the provider no longer knows is revoked with its token, the attempt is PERMANENT, and the other device of the person is still served', async () => {
      const gone = await device(PERSON, { token: 'token-unregistered' });
      const kept = await device(PERSON);
      fcm.refuseToken('token-unregistered', 'UNREGISTERED');
      const notificationId = await notify(PERSON);
      await dispatch();
      // One device accepted: the send is accepted and only the dead one is revoked.
      expect(await attemptOf(notificationId)).toMatchObject({ status: 'ProviderAccepted' });
      expect(await deviceRow(gone.id)).toMatchObject({ push_secret_ref: null, revoke_reason: 'PROVIDER_UNREGISTERED' });
      expect((await deviceRow(gone.id)).revoked_at).not.toBeNull();
      expect(vault.tokens.has(gone.ref)).toBe(false);
      expect((await deviceRow(kept.id)).revoked_at).toBeNull();
      expect(vault.tokens.get(kept.ref)).toBe(kept.token);
    });

    it('AC-ST-NOT-007-1 UAT-AC179: when every device of the person is unknown to the provider the attempt fails for good, with the code of the provider', async () => {
      const [only] = [await device(NOBODY, { token: 'token-bad-device', platform: 'ios' })];
      apns.refuseToken('token-bad-device', 'BadDeviceToken');
      const notificationId = await notify(NOBODY, 'PUSH_APNS');
      await dispatch();
      expect(await attemptOf(notificationId)).toMatchObject({ status: 'Failed', failure_class: 'PERMANENT', error_code: 'BAD_DEVICE_TOKEN' });
      expect((await deviceRow(only.id)).revoke_reason).toBe('PROVIDER_UNREGISTERED');
      expect(vault.tokens.has(only.ref)).toBe(false);
    });

    it('AC-ST-NOT-007-3 NOT02: a push the provider accepted does not mark the notification read, and its link names the notification and nothing else', async () => {
      await device(PERSON);
      const notificationId = await notify(PERSON);
      await dispatch();
      expect(await attemptOf(notificationId)).toMatchObject({ status: 'ProviderAccepted' });
      const [instance] = await owner<{ read_at: Date | null; status: string }>('select read_at, status from machvon.notification_instance where id = $1', [notificationId]);
      expect(instance?.read_at).toBeNull();
      expect(instance?.status).not.toBe('Read');
      expect(fcm.sent[0]?.data.deep_link).toBe(`/r/${notificationId}`);
    });

    it('goes only to the platforms of the channel and to devices that allow notifications: an iOS device does not get an FCM message, a denied one gets nothing', async () => {
      const ios = await device(OTHER, { platform: 'ios' });
      const denied = await device(OTHER, { permission: 'denied' });
      const notificationId = await notify(OTHER, 'PUSH_FCM');
      await dispatch();
      expect(await attemptOf(notificationId)).toMatchObject({ status: 'Failed', failure_class: 'PERMANENT', error_code: 'NO_DEVICE' });
      expect(fcm.sent).toHaveLength(0);
      expect((await deviceRow(ios.id)).revoked_at).toBeNull();
      expect((await deviceRow(denied.id)).revoked_at).toBeNull();
    });

    it('a refusal of the token a device had does not revoke the token it rotated to while the push was in flight', async () => {
      const phone = await device(PERSON, { token: 'token-before-rotation' });
      const rotatedRef = `${phone.ref}/rotated`;
      await vault.put(rotatedRef, 'token-after-rotation');
      const rotating = new (class extends MockPushProvider {
        override async send(): Promise<PushProviderAnswer> {
          // The app registers its new token (a new reference) while the provider is still answering about the old one.
          await owner('update machvon.device_registration set push_secret_ref = $2 where id = $1', [phone.id, rotatedRef]);
          return { ok: false, code: 'UNREGISTERED' };
        }
      })();
      const quick = new ChannelAdapterRegistry([new PushChannelAdapter('mock-fcm', 'PUSH_FCM', rotating), new PushChannelAdapter('mock-apns', 'PUSH_APNS', apns)], 'test');
      const access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
      const other = new DeliveryDispatcher({ database: harness.tenants, engine, adapters: quick, loadAccess: (ctx) => access.load(ctx), resourceAccess: new PermissionResourceAccess(), now: () => NOON, pushTokens: vault }, 'test');
      const notificationId = await notify(PERSON);
      await other.dispatchDue(CONTEXT);
      expect(await attemptOf(notificationId)).toMatchObject({ status: 'Failed', failure_class: 'PERMANENT', error_code: 'UNREGISTERED' });
      expect(await deviceRow(phone.id)).toMatchObject({ revoked_at: null, push_secret_ref: rotatedRef });
      expect(vault.tokens.get(rotatedRef)).toBe('token-after-rotation');
    });

    it('a vault that does not answer is a pause, not the end: the send is retried, and a device whose token could not be read does not stop the others', async () => {
      const mine = await device(NOBODY);
      vault.failNext('read');
      const first = await notify(NOBODY);
      await dispatch();
      expect(await attemptOf(first)).toMatchObject({ failure_class: 'RETRYABLE', error_code: 'VAULT_UNAVAILABLE' });
      expect(fcm.sent).toHaveLength(0);
      expect((await deviceRow(mine.id)).revoked_at).toBeNull();
      // With two live devices and the vault failing for one read only, the other is still served.
      await device(NOBODY);
      await device(NOBODY);
      vault.failNext('read');
      const next = await notify(NOBODY);
      await dispatch();
      expect(await attemptOf(next)).toMatchObject({ status: 'ProviderAccepted' });
      // Three live devices, one read failed: the other two are written to.
      expect(fcm.sent).toHaveLength(2);
    });

    it('an outage of the provider is retried and revokes nothing', async () => {
      const phone = await device(PERSON);
      fcm.failAll('UNAVAILABLE');
      const notificationId = await notify(PERSON);
      await dispatch();
      expect(await attemptOf(notificationId)).toMatchObject({ failure_class: 'RETRYABLE', error_code: 'UNAVAILABLE' });
      expect((await deviceRow(phone.id)).revoked_at).toBeNull();
      expect(vault.tokens.get(phone.ref)).toBe(phone.token);
    });
  });

  describe('the adapter looks once more at what it is about to send', () => {
    const adapter = new PushChannelAdapter('mock-fcm', 'PUSH_FCM', new MockPushProvider());
    const target = { deviceId: randomUUID(), token: 'token-x' };
    const request = (overrides: Record<string, unknown>) => ({ idempotencyKey: 'k', accountId: 'a', to: 'devices', text: NEUTRAL, targets: [target], deepLink: '/r/00000000-0000-4000-8000-000000000001', ...overrides });

    it('AC-ST-NOT-007-2 UAT-AC28: a text with a placeholder left, an empty or a long one, or a link that names a record, is refused before the provider', async () => {
      for (const bad of [{ text: 'You owe {{amount}}' }, { text: '' }, { text: 'x'.repeat(200) }, { deepLink: 'machvon://report/12345' }]) {
        expect(await adapter.send(request(bad) as never)).toMatchObject({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'LOCKSCREEN_UNSAFE' });
      }
    });

    it('a call that throws for one device does not take the others with it: the acceptance of another stands, and with none the send is of unknown result', async () => {
      const provider = new (class extends MockPushProvider {
        override async send(message: Parameters<MockPushProvider['send']>[0]): Promise<PushProviderAnswer> {
          if (message.token === 'token-throws') throw new Error('socket closed');
          return super.send(message);
        }
      })();
      const tolerant = new PushChannelAdapter('mock-fcm', 'PUSH_FCM', provider);
      const other = { deviceId: randomUUID(), token: 'token-fine' };
      const throwing = { deviceId: randomUUID(), token: 'token-throws' };
      expect(await tolerant.send(request({ targets: [throwing, other] }) as never)).toMatchObject({ kind: 'ACCEPTED' });
      expect(provider.sent.map((message) => message.token)).toEqual(['token-fine']);
      expect(await tolerant.send(request({ targets: [throwing] }) as never)).toEqual({ kind: 'UNKNOWN', errorCode: 'ADAPTER_ERROR' });
      // A retryable answer of another device does not turn the unknown into a retry: that would write twice to the device whose call may have gone out.
      provider.failAll('UNAVAILABLE');
      expect(await tolerant.send(request({ targets: [throwing, other] }) as never)).toEqual({ kind: 'UNKNOWN', errorCode: 'ADAPTER_ERROR' });
    });

    it('sends nothing without a device, and classifies the answers of the provider in the words of the engine', async () => {
      expect(await adapter.send(request({ targets: [] }) as never)).toMatchObject({ kind: 'FAILED', errorCode: 'NO_DEVICE' });
      const provider = new MockPushProvider();
      const classifying = new PushChannelAdapter('mock-fcm', 'PUSH_FCM', provider);
      provider.refuseToken('token-x', 'UNREGISTERED');
      expect(await classifying.send(request({}) as never)).toMatchObject({ kind: 'FAILED', failureClass: 'PERMANENT', deadTargets: [target.deviceId] });
      provider.recover();
      provider.failAll('QUOTA_EXCEEDED');
      expect(await classifying.send(request({}) as never)).toMatchObject({ kind: 'FAILED', failureClass: 'RETRYABLE' });
    });
  });

  describe('the silent push when entitlements or access change (UAT-NOT02)', () => {
    it('UAT-NOT02: a change of entitlements wakes every device of the tenant with a data message that has no text', async () => {
      const a = await device(PERSON, { token: 'silent-a' });
      const b = await device(OTHER, { token: 'silent-b', platform: 'ios' });
      const event = delivery('sas.entitlement.changed.v1', { tenant_id: TENANT_A, entitlements_hash: 'h1' });
      expect(await silent.handle(event)).toBe('processed');
      const reached = [...fcm.sent, ...apns.sent].filter((message) => message.token === a.token || message.token === b.token);
      expect(reached.map((message) => message.token).sort()).toEqual([a.token, b.token].sort());
      for (const message of reached) {
        expect(message).toMatchObject({ silent: true, data: { kind: 'refresh', what: 'entitlements' } });
        expect(message.body).toBeUndefined();
      }
      // Delivered again, it wakes nobody twice.
      const before = fcm.sent.length + apns.sent.length;
      expect(await silent.handle(event)).toBe('duplicate');
      expect(fcm.sent.length + apns.sent.length).toBe(before);
    });

    it('UAT-NOT02: a change of access wakes the devices of the members it names only', async () => {
      const mine = await device(PERSON, { token: 'access-mine' });
      const theirs = await device(OTHER, { token: 'access-theirs' });
      expect(await silent.handle(delivery('iam.access.changed.v1', { tenant_id: TENANT_A, membership_ids: [memberId(PERSON)] }))).toBe('processed');
      const tokens = fcm.sent.map((message) => message.token);
      expect(tokens).toContain(mine.token);
      expect(tokens).not.toContain(theirs.token);
      // The access events of the org-unit commands carry no tenant in the payload: the signed tenant of the delivery is the one.
      fcm.sent.length = 0;
      expect(await silent.handle(delivery('iam.access.changed.v1', { membership_ids: [memberId(OTHER)] }))).toBe('processed');
      expect(fcm.sent.map((message) => message.token)).toContain(theirs.token);
    });

    it('a change of access that names one member as `membership_id` (the events of the tenant owner) wakes that member', async () => {
      const owner_ = await device(OTHER, { token: 'access-singular' });
      expect(await silent.handle(delivery('iam.access.changed.v1', { tenant_id: TENANT_A, membership_id: memberId(OTHER) }))).toBe('processed');
      expect(fcm.sent.map((message) => message.token)).toContain(owner_.token);
    });

    it('ignores what is not for it: another event, a payload of another tenant, an access change naming nobody', async () => {
      await device(PERSON, { token: 'ignored' });
      const before = fcm.sent.length + apns.sent.length;
      expect(await silent.handle(delivery('report.overdue', { tenant_id: TENANT_A }))).toBe('ignored');
      expect(await silent.handle(delivery('sas.entitlement.changed.v1', { tenant_id: TENANT_B }))).toBe('ignored');
      expect(await silent.handle(delivery('sas.entitlement.changed.v1', {}))).toBe('ignored');
      expect(await silent.handle(delivery('iam.access.changed.v1', { tenant_id: TENANT_B, membership_ids: [memberId(PERSON)] }))).toBe('ignored');
      expect(await silent.handle(delivery('iam.access.changed.v1', { tenant_id: TENANT_A, membership_ids: [] }))).toBe('ignored');
      expect(fcm.sent.length + apns.sent.length).toBe(before);
    });

    it('revokes the device the provider no longer knows, and a failure of one provider does not stop the other', async () => {
      const dead = await device(PERSON, { token: 'silent-dead' });
      const ios = await device(PERSON, { token: 'silent-ios', platform: 'ios' });
      fcm.refuseToken('silent-dead', 'UNREGISTERED');
      apns.failAll('Unavailable');
      expect(await silent.handle(delivery('iam.access.changed.v1', { tenant_id: TENANT_A, membership_ids: [memberId(PERSON)] }))).toBe('processed');
      expect((await deviceRow(dead.id)).revoke_reason).toBe('PROVIDER_UNREGISTERED');
      expect(vault.tokens.has(dead.ref)).toBe(false);
      expect(apns.sent.map((message) => message.token)).toContain(ios.token);
      expect((await deviceRow(ios.id)).revoked_at).toBeNull();
    });

    it('a provider that never answers does not hold the consumer: the call is given up and the other channel is still served', async () => {
      const mine = await device(PERSON, { token: 'silent-hang-android' });
      const phone = await device(PERSON, { token: 'silent-hang-ios', platform: 'ios' });
      const hanging = new (class extends MockPushProvider {
        override send(): Promise<PushProviderAnswer> {
          return new Promise(() => undefined);
        }
      })();
      const impatient = new SilentPushConsumer({
        database: harness.tenants,
        adapters: new ChannelAdapterRegistry([new PushChannelAdapter('mock-fcm', 'PUSH_FCM', hanging), new PushChannelAdapter('mock-apns', 'PUSH_APNS', apns)], 'test'),
        vault,
        security: { signingKey: RELAY_KEY },
        adapterTimeoutMs: 50,
      });
      expect(await impatient.handle(delivery('iam.access.changed.v1', { tenant_id: TENANT_A, membership_ids: [memberId(PERSON)] }))).toBe('processed');
      expect(apns.sent.map((message) => message.token)).toContain(phone.token);
      expect((await deviceRow(mine.id)).revoked_at).toBeNull();
    });

    it('does not reach the devices of another tenant', async () => {
      await harness.seedUnits(TENANT_B, [{ n: 1, path: '/1/' }]);
      await harness.seedMembership(TENANT_B, 1, 1, { validFrom: '2026-01-01T00:00:00Z' });
      const foreign = await device(1, { tenant: TENANT_B, token: 'tenant-b-device' });
      await silent.handle(delivery('sas.entitlement.changed.v1', { tenant_id: TENANT_A, entitlements_hash: 'h2' }));
      expect([...fcm.sent, ...apns.sent].map((message) => message.token)).not.toContain(foreign.token);
    });
  });

  it('wires the two push channels as stand-ins outside production and none in production', () => {
    const outside = defaultChannelAdapters('test');
    expect([outside.forChannel('PUSH_FCM')?.status, outside.forChannel('PUSH_APNS')?.status]).toEqual(['MOCK', 'MOCK']);
    expect(defaultChannelAdapters('production').forChannel('PUSH_FCM')).toBeUndefined();
  });
});
