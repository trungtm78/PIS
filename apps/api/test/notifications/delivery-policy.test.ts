import { createHash, randomUUID } from 'node:crypto';
import { AuditWriter, ContactConsentStore, DeliveryStore, EffectiveAccessStore, InMemoryAuthzCache, NotificationPreferenceStore, NotificationStore } from '@machvon/db';
import type { NotificationPriority, TenantTx } from '@machvon/db';
import { dedupeKeyOf } from '../../src/notifications/dedupe';
import { ChannelAdapterRegistry, InMemoryChannelAdapter } from '../../src/notifications/delivery/channel-adapters';
import { DeliveryDispatcher } from '../../src/notifications/delivery/dispatcher';
import { createDeliveryEngine } from '../../src/notifications/delivery/wiring';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { AuthzHarness, TENANT_A, id, memberId } from '../../../../packages/db/test/support/authz-fixtures';

const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const WORKFLOW_URGENT = '00000000-0000-4000-8000-0000000000b2';
const SMS_ACCOUNT = '00000000-0000-4000-8000-0000000000d2';
const SMS_TEMPLATE = '00000000-0000-4000-8000-0000000000e2';
const ZNS_ACCOUNT = '00000000-0000-4000-8000-0000000000d3';
const ZNS_TEMPLATE = '00000000-0000-4000-8000-0000000000e3';
const VIETNAM = 1;
const TOKYO = 2;
const NIGHT = new Date('2026-10-22T15:30:00.000Z');
const EVENT_TIME = new Date('2026-10-22T13:30:00.000Z');
const CONTEXT = { tenantId: TENANT_A, membershipId: memberId(1), scopeVersion: 0 };
const NOON = new Date('2026-10-22T05:00:00.000Z');

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('the dispatcher honours consent, preferences and quiet hours (ST-NOT-003)', () => {
  const harness = new AuthzHarness();
  const notifications = new NotificationStore();
  const deliveries = new DeliveryStore();
  const consents = new ContactConsentStore();
  const preferences = new NotificationPreferenceStore();
  let sms: InMemoryChannelAdapter;
  let zns: InMemoryChannelAdapter;
  let clock: Date;
  let dispatcher: DeliveryDispatcher;

  const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, work);
  const owner = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => harness.owner<T>(TENANT_A, [[text, params]]);

  /** A notification as the consumer makes it: inserted with its plan, and its chain started. */
  async function notify(member: number, options: { priority?: NotificationPriority; workflow?: string; purpose?: string; plan?: string[] } = {}): Promise<string> {
    return as(member, async (tx) => {
      const eventId = randomUUID();
      const purpose = options.purpose ?? 'OPERATIONAL';
      const inserted = await notifications.insert(tx, {
        eventId,
        workflowVersionId: options.workflow ?? WORKFLOW,
        recipientId: memberId(member),
        purpose,
        dedupeKey: dedupeKeyOf({ tenantId: TENANT_A, sourceEventId: eventId, recipientId: memberId(member), purpose }),
        expiresAt: new Date('2026-10-30T00:00:00Z'),
        sourceEventType: 'report.overdue',
        eventVersion: 1,
        priority: options.priority ?? 'NORMAL',
        ackRequired: false,
        channelPlan: options.plan ?? ['IN_APP', 'SMS'],
      });
      await engine.startChain(tx, await deliveries.requireNotification(tx, inserted.id));
      return inserted.id;
    });
  }

  const engine = createDeliveryEngine({ recordInTx: (tx, actor, entry) => new AuditWriter(harness.tenants).recordInTx(tx, actor, entry) });
  const attemptOf = async (notificationId: string): Promise<{ status: string; error_code: string | null; next_retry_at: Date | null }> => {
    const [row] = await owner<{ status: string; error_code: string | null; next_retry_at: Date | null }>('select status, error_code, next_retry_at from machvon.delivery_attempt where notification_id = $1', [notificationId]);
    if (row === undefined) throw new Error('no attempt');
    return row;
  };
  const dispatch = async (at: Date): Promise<void> => {
    clock = at;
    await dispatcher.dispatchDue(CONTEXT);
  };

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/1/' }]);
    for (const member of [VIETNAM, TOKYO]) {
      await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
      await owner('update machvon.user_account set phone_e164 = $2 where id = $1', [id(0x60, member), `+8490000000${member}`]);
    }
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'report.overdue', 1, $4::jsonb, 'Published', 'NOTIFICATION', 'report.overdue', $3, repeat('a', 64)),
                ($1, $5, 'approval.requested', 1, $6::jsonb, 'Published', 'NOTIFICATION', 'approval.requested', $3, repeat('b', 64))`,
        [
          TENANT_A,
          WORKFLOW,
          ACTOR,
          JSON.stringify({ channels: [{ channel: 'IN_APP' }, { channel: 'SMS', templateCode: 'sms.a' }, { channel: 'ZALO_ZNS', templateCode: 'zns.a' }] }),
          WORKFLOW_URGENT,
          JSON.stringify({ channels: [{ channel: 'IN_APP' }, { channel: 'SMS', templateCode: 'sms.a' }], priority: 'CRITICAL', quietHoursOverride: true }),
        ],
      ],
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref)
         values ($1, $2, 'SMS', 'sms-1', 'secret://test/sms', 'v1', 'Active', now(), 'secret://test/sms-webhook')`,
        [TENANT_A, SMS_ACCOUNT],
      ],
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref)
         values ($1, $2, 'ZALO_ZNS', 'zns-1', 'secret://test/zns', 'v1', 'Active', now(), 'secret://test/zns-webhook')`,
        [TENANT_A, ZNS_ACCOUNT],
      ],
      [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by, provider_status, provider_template_id)
         values ($1, $2, 'zns.a', 'ZALO_ZNS', 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, 'Active', $3, $4, 'PROVIDER_APPROVED', 'zns-template-1')`,
        [TENANT_A, ZNS_TEMPLATE, sha('zns.a'), ACTOR],
      ],
      [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by)
         values ($1, $2, 'sms.a', 'SMS', 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, 'Active', $3, $4)`,
        [TENANT_A, SMS_TEMPLATE, sha('sms.a'), ACTOR],
      ],
      [`insert into machvon.notification_preference_profile (tenant_id, membership_id, quiet_start, quiet_end, time_zone) values ($1, $2, '21:00', '07:00', 'Asia/Tokyo')`, [TENANT_A, memberId(TOKYO)]],
    ]);
    sms = new InMemoryChannelAdapter({ provider: 'sms-gateway', channel: 'SMS', status: 'MOCK', paid: true });
    zns = new InMemoryChannelAdapter({ provider: 'zalo-zns', channel: 'ZALO_ZNS', status: 'MOCK', paid: true });
    const access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
    dispatcher = new DeliveryDispatcher(
      {
        database: harness.tenants,
        engine,
        adapters: new ChannelAdapterRegistry([sms, zns], 'test'),
        loadAccess: (ctx) => access.load(ctx),
        resourceAccess: new PermissionResourceAccess(),
        now: () => clock,
      },
      'test',
    );
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  const grant = (member: number, purpose: 'OPERATIONAL' | 'ANNOUNCEMENT' = 'OPERATIONAL') =>
    as(member, (tx) => consents.grant(tx, memberId(member), { channel: 'SMS', purpose, consentTextVersion: 'v1', captureMethod: 'IN_APP' }));

  it('AC-ST-NOT-003-1 (UAT-AC183): the first attempt is Suppressed NO_CONSENT, and once the person consented the second is sent', async () => {
    const first = await notify(VIETNAM);
    await dispatch(NOON);
    expect(await attemptOf(first)).toMatchObject({ status: 'Suppressed', error_code: 'NO_CONSENT' });
    expect(sms.requests).toHaveLength(0);
    await grant(VIETNAM);
    const second = await notify(VIETNAM);
    await dispatch(NOON);
    expect(await attemptOf(second)).toMatchObject({ status: 'ProviderAccepted' });
    expect(sms.requests).toHaveLength(1);
    expect(sms.requests[0]).toMatchObject({ to: '+84900000001', idempotencyKey: `${second}:SMS:1` });
  });

  it('AC-ST-NOT-003-2 (UAT-AC184): a scheduled attempt is Suppressed with zero adapter calls when the consent is withdrawn before its time', async () => {
    const [live] = await as(VIETNAM, (tx) => consents.historyOf(tx, memberId(VIETNAM), { limit: 5, after: undefined }));
    const scheduled = await notify(VIETNAM);
    await owner("update machvon.delivery_attempt set next_retry_at = $2::timestamptz where notification_id = $1", [scheduled, '2026-10-22T08:00:00Z']);
    await dispatch(NOON);
    expect(await attemptOf(scheduled)).toMatchObject({ status: 'Queued' });
    await as(VIETNAM, (tx) => consents.withdraw(tx, memberId(VIETNAM), live?.id ?? '', 1, 'I withdraw before the send time'));
    const before = sms.requests.length;
    await dispatch(new Date('2026-10-22T08:00:30Z'));
    expect(await attemptOf(scheduled)).toMatchObject({ status: 'Suppressed', error_code: 'CONSENT_WITHDRAWN' });
    expect(sms.requests).toHaveLength(before);
  });

  it('AC-ST-NOT-003-3 (UAT-AC27): at 22:30 the ordinary message waits for 07:00 while the urgent one is sent and leaves an override audit row', async () => {
    await grant(VIETNAM);
    const ordinary = await notify(VIETNAM);
    const urgent = await notify(VIETNAM, { priority: 'CRITICAL', workflow: WORKFLOW_URGENT });
    const before = sms.requests.length;
    await dispatch(NIGHT);
    expect(await attemptOf(urgent)).toMatchObject({ status: 'ProviderAccepted' });
    const held = await attemptOf(ordinary);
    expect(held).toMatchObject({ status: 'Queued', error_code: 'QUIET_HOURS' });
    expect(held.next_retry_at?.toISOString()).toBe('2026-10-23T00:00:00.000Z');
    expect(sms.requests).toHaveLength(before + 1);
    const audit = await owner<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'notification.quiet_hours_override' and resource_id = $1", [urgent]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.safe_diff).toMatchObject({ channel: 'SMS', priority: 'CRITICAL' });
    // At 07:00 the held message goes.
    await dispatch(new Date('2026-10-23T00:00:00.000Z'));
    expect(await attemptOf(ordinary)).toMatchObject({ status: 'ProviderAccepted' });
  });

  it('AC-ST-NOT-003-4 (UAT-AC185): one event at 13:30Z is sent now to the person in Vietnam and held until 22:00Z for the person in Tokyo', async () => {
    await grant(TOKYO);
    await as(TOKYO, async (tx) => preferences.replace(tx, memberId(TOKYO), { items: [], quietStart: '21:00', quietEnd: '07:00', timeZone: 'Asia/Tokyo' }, 1));
    const vietnam = await notify(VIETNAM);
    const tokyo = await notify(TOKYO);
    await dispatch(EVENT_TIME);
    expect(await attemptOf(vietnam)).toMatchObject({ status: 'ProviderAccepted' });
    const held = await attemptOf(tokyo);
    expect(held).toMatchObject({ status: 'Queued', error_code: 'QUIET_HOURS' });
    expect(held.next_retry_at?.toISOString()).toBe('2026-10-22T22:00:00.000Z');
  });

  it('counts what a pass did: sent, suppressed and deferred', async () => {
    const quiet = await notify(TOKYO, { purpose: 'ANNOUNCEMENT' });
    const sent = await notify(VIETNAM);
    clock = EVENT_TIME;
    const result = await dispatcher.dispatchDue(CONTEXT);
    expect(result).toMatchObject({ sent: 1, suppressed: 1, deferred: 0 });
    expect(await attemptOf(quiet)).toMatchObject({ status: 'Suppressed', error_code: 'NO_CONSENT' });
    expect(await attemptOf(sent)).toMatchObject({ status: 'ProviderAccepted' });
    await grant(TOKYO, 'ANNOUNCEMENT');
    await notify(TOKYO, { purpose: 'ANNOUNCEMENT' });
    expect(await dispatcher.dispatchDue(CONTEXT)).toMatchObject({ sent: 0, suppressed: 0, deferred: 1 });
  });

  it('AC-ST-KERNEL-061-2 (UAT-NFR-PRIVACY-01): a Zalo consent withdrawn between two events suppresses the second recipient decision with CONSENT_WITHDRAWN, and the adapter is called 0 times for it', async () => {
    await as(VIETNAM, (tx) => consents.grant(tx, memberId(VIETNAM), { channel: 'ZALO', purpose: 'OPERATIONAL', consentTextVersion: 'v1', captureMethod: 'IN_APP' }));
    const first = await notify(VIETNAM, { plan: ['ZALO_ZNS'] });
    await dispatch(NOON);
    expect(await attemptOf(first)).toMatchObject({ status: 'ProviderAccepted' });
    expect(zns.requests).toHaveLength(1);
    const [live] = await as(VIETNAM, (tx) => consents.historyOf(tx, memberId(VIETNAM), { limit: 5, after: undefined }));
    expect(live).toMatchObject({ channel: 'ZALO', status: 'Granted' });
    await as(VIETNAM, (tx) => consents.withdraw(tx, memberId(VIETNAM), live?.id ?? '', 1, 'I no longer want Zalo messages'));
    const second = await notify(VIETNAM, { plan: ['ZALO_ZNS'] });
    await dispatch(NOON);
    expect(await attemptOf(second)).toMatchObject({ status: 'Suppressed', error_code: 'CONSENT_WITHDRAWN', next_retry_at: null });
    expect((await owner<{ status: string; suppression_reason: string | null }>('select status, suppression_reason from machvon.notification_instance where id = $1', [second]))[0]).toEqual({ status: 'Suppressed', suppression_reason: 'CONSENT_WITHDRAWN' });
    expect(zns.requests).toHaveLength(1);
    expect(zns.requests.some((request) => request.idempotencyKey.startsWith(second))).toBe(false);
    // A person who never consented is told apart: that is NO_CONSENT, not a withdrawal.
    const never = await notify(TOKYO, { plan: ['ZALO_ZNS'] });
    await dispatch(NOON);
    expect(await attemptOf(never)).toMatchObject({ status: 'Suppressed', error_code: 'NO_CONSENT' });
  });
});
