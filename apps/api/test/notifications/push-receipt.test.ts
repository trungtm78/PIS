import { createHash, randomUUID } from 'node:crypto';
import { AuditWriter, DeliveryStore, EffectiveAccessStore, InMemoryAuthzCache, NotificationStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { dedupeKeyOf } from '../../src/notifications/dedupe';
import { ChannelAdapterRegistry } from '../../src/notifications/delivery/channel-adapters';
import { DeliveryDispatcher } from '../../src/notifications/delivery/dispatcher';
import { createDeliveryEngine } from '../../src/notifications/delivery/wiring';
import { InMemoryPushTokenVault, pushSecretRefOf } from '../../src/notifications/devices/push-vault';
import { MockPushProvider } from '../../src/notifications/push/ports';
import { PushChannelAdapter } from '../../src/notifications/push/push-adapter';
import { PushReceiptController } from '../../src/notifications/push/push-receipt.controller';
import { mintReceipt } from '../../src/notifications/push/web-push-receipt';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { AuthzHarness, TENANT_A, TENANT_B, memberId } from '../../../../packages/db/test/support/authz-fixtures';

const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const FCM_ACCOUNT = '00000000-0000-4000-8000-0000000000d3';
const FCM_TEMPLATE = '00000000-0000-4000-8000-0000000000e3';
const PERSON = 1;
const OTHER = 2;
const NOON = new Date('2026-10-22T05:00:00.000Z');
const CONTEXT = { tenantId: TENANT_A, membershipId: memberId(PERSON), scopeVersion: 0 };
const KEY = 'r'.repeat(40);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('the acknowledgement of a web push (YCK.01, NOT-30)', () => {
  const harness = new AuthzHarness();
  const notifications = new NotificationStore();
  const deliveries = new DeliveryStore();
  const vault = new InMemoryPushTokenVault();
  const fcm = new MockPushProvider();
  const engine = createDeliveryEngine({ recordInTx: (tx, actor, entry) => new AuditWriter(harness.tenants).recordInTx(tx, actor, entry) });
  let dispatcher: DeliveryDispatcher;
  let controller: PushReceiptController;

  const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, work);
  const owner = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => harness.owner<T>(TENANT_A, [[text, params]]);

  async function device(member: number): Promise<string> {
    const deviceId = randomUUID();
    const token = `token-${randomUUID()}`;
    const ref = pushSecretRefOf(TENANT_A, deviceId);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, permission_state, app_version)
         values ($1, $2, $3, $4, $5, 'android', now(), $6, 'granted', '1.0.0')`,
        [TENANT_A, deviceId, memberId(member), `public-${deviceId}`, ref, sha(token)],
      ],
    ]);
    await vault.put(ref, token);
    return deviceId;
  }

  /** A notification that reached the push provider: its attempt is ProviderAccepted. */
  async function pushed(member: number): Promise<string> {
    const eventId = randomUUID();
    const id = await as(member, async (tx) => {
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
        channelPlan: ['PUSH_FCM'],
      });
      await engine.startChain(tx, await deliveries.requireNotification(tx, inserted.id));
      return inserted.id;
    });
    await dispatcher.dispatchDue(CONTEXT);
    return id;
  }

  const statusOf = async (notificationId: string): Promise<string> => {
    const [row] = await owner<{ status: string }>('select status from machvon.delivery_attempt where notification_id = $1 order by attempt_no limit 1', [notificationId]);
    return row?.status ?? 'none';
  };
  const receipt = (notificationId: string, deviceId: string, tenantId = TENANT_A, at = Math.floor(Date.now() / 1000)): string => mintReceipt(KEY, { tenantId, notificationId, deviceId }, at) as string;
  const ack = (token: string, event = 'SHOWN', ip = '203.0.113.7') => controller.acknowledge({ ip }, { receipt: token, event });

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/1/' }]);
    for (const member of [PERSON, OTHER]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'report.overdue', 1, $4::jsonb, 'Published', 'NOTIFICATION', 'report.overdue', $3, repeat('a', 64))`,
        [TENANT_A, WORKFLOW, ACTOR, JSON.stringify({ channels: [{ channel: 'PUSH_FCM', templateCode: 'push.fcm' }] })],
      ],
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref)
         values ($1, $2, 'PUSH_FCM', 'fcm-project', 'secret://test/fcm', 'v1', 'Active', now(), 'secret://test/fcm-webhook')`,
        [TENANT_A, FCM_ACCOUNT],
      ],
      [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by, lockscreen_safe)
         values ($1, $2, 'push.fcm', 'PUSH_FCM', 'vi-VN', 1, $4::jsonb, '{}'::jsonb, 'Active', $5, $3, true)`,
        [TENANT_A, FCM_TEMPLATE, ACTOR, JSON.stringify({ body: 'A dossier needs your attention.' }), sha('push.fcm')],
      ],
    ]);
    const registry = new ChannelAdapterRegistry([new PushChannelAdapter('mock-fcm', 'PUSH_FCM', fcm)], 'test');
    const access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
    dispatcher = new DeliveryDispatcher({ database: harness.tenants, engine, adapters: registry, loadAccess: (ctx) => access.load(ctx), resourceAccess: new PermissionResourceAccess(), now: () => NOON, pushTokens: vault }, 'test');
    controller = new PushReceiptController(harness.tenants, engine, [KEY]);
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  it('moves the push send to Delivered when the device shows it and to Read when the person taps it, once each', async () => {
    const mine = await device(PERSON);
    const notificationId = await pushed(PERSON);
    expect(await statusOf(notificationId)).toBe('ProviderAccepted');
    expect(await ack(receipt(notificationId, mine))).toEqual({ acknowledged: true });
    expect(await statusOf(notificationId)).toBe('Delivered');
    // A repeat is answered the same and changes nothing.
    expect(await ack(receipt(notificationId, mine))).toEqual({ acknowledged: true });
    expect(await statusOf(notificationId)).toBe('Delivered');
    expect(await ack(receipt(notificationId, mine), 'CLICKED')).toEqual({ acknowledged: true });
    expect(await statusOf(notificationId)).toBe('Read');
    // A late SHOWN after the tap never takes it back.
    expect(await ack(receipt(notificationId, mine))).toEqual({ acknowledged: true });
    expect(await statusOf(notificationId)).toBe('Read');
    const [times] = await owner<{ delivered_at: Date | null; read_at: Date | null }>('select delivered_at, read_at from machvon.delivery_attempt where notification_id = $1', [notificationId]);
    expect(times?.delivered_at).not.toBeNull();
    expect(times?.read_at).not.toBeNull();
  });

  it('lets a tap alone end the wait (a SHOWN that never arrived)', async () => {
    const mine = await device(PERSON);
    const notificationId = await pushed(PERSON);
    await ack(receipt(notificationId, mine), 'CLICKED');
    expect(await statusOf(notificationId)).toBe('Read');
  });

  it('refuses a device that is not the recipient, a notification that does not exist and a tenant that does not hold it', async () => {
    await device(PERSON);
    const strangers = await device(OTHER);
    const notificationId = await pushed(PERSON);
    await expect(ack(receipt(notificationId, strangers))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    await expect(ack(receipt(randomUUID(), strangers))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(ack(receipt(notificationId, await device(PERSON), TENANT_B))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(await statusOf(notificationId)).toBe('ProviderAccepted');
  });

  it('refuses a token that is forged, expired, signed with another key or of another shape, and an event it does not know', async () => {
    const mine = await device(PERSON);
    const notificationId = await pushed(PERSON);
    const good = receipt(notificationId, mine);
    const raw = Buffer.from(good, 'base64url');
    raw[60] = (raw[60] as number) ^ 1;
    await expect(ack(raw.toString('base64url'))).rejects.toMatchObject({ code: 'SIGNATURE_INVALID', status: 401 });
    await expect(ack(receipt(notificationId, mine, TENANT_A, 1000))).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(ack(mintReceipt('x'.repeat(40), { tenantId: TENANT_A, notificationId, deviceId: mine }, Math.floor(Date.now() / 1000)) as string)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(ack('short')).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(ack(good, 'OPENED')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    await expect(controller.acknowledge({ ip: '203.0.113.9' }, {})).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await statusOf(notificationId)).toBe('ProviderAccepted');
  });

  it('limits one client address', async () => {
    const mine = await device(PERSON);
    const notificationId = await pushed(PERSON);
    const token = receipt(notificationId, mine);
    let refused: unknown;
    for (let index = 0; index < 130 && refused === undefined; index += 1) refused = await ack(token, 'SHOWN', '198.51.100.1').then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'RATE_LIMIT', status: 429 });
    await expect(ack(token, 'SHOWN', '198.51.100.2')).resolves.toEqual({ acknowledged: true });
  });

  it('writes nothing when the notification has no push send that the provider took', async () => {
    const mine = await device(PERSON);
    const eventId = randomUUID();
    const notificationId = await as(PERSON, async (tx) => {
      const inserted = await notifications.insert(tx, {
        eventId,
        workflowVersionId: WORKFLOW,
        recipientId: memberId(PERSON),
        purpose: 'OPERATIONAL',
        dedupeKey: dedupeKeyOf({ tenantId: TENANT_A, sourceEventId: eventId, recipientId: memberId(PERSON), purpose: 'OPERATIONAL' }),
        expiresAt: new Date('2026-10-30T00:00:00Z'),
        sourceEventType: 'report.overdue',
        eventVersion: 1,
        priority: 'NORMAL',
        ackRequired: false,
        channelPlan: ['PUSH_FCM'],
      });
      return inserted.id;
    });
    await expect(ack(receipt(notificationId, mine))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
