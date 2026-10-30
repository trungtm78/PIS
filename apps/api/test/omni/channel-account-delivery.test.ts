import { createHash, randomUUID } from 'node:crypto';
import { AuditWriter, ContactConsentStore, DeliveryStore, EffectiveAccessStore, InMemoryAuthzCache, NotificationStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { dedupeKeyOf } from '../../src/notifications/dedupe';
import { ChannelAdapterRegistry, InMemoryChannelAdapter } from '../../src/notifications/delivery/channel-adapters';
import { DeliveryDispatcher } from '../../src/notifications/delivery/dispatcher';
import { createDeliveryEngine } from '../../src/notifications/delivery/wiring';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { AuthzHarness, TENANT_A, id, memberId } from '../../../../packages/db/test/support/authz-fixtures';

const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e2';
const MEMBER = 1;
const NOON = new Date('2026-10-22T05:00:00.000Z');
const CONTEXT = { tenantId: TENANT_A, membershipId: memberId(MEMBER), scopeVersion: 0 };

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('only a verified channel account sends (ST-OMNI-001, BR-OMNI-02)', () => {
  const harness = new AuthzHarness();
  const notifications = new NotificationStore();
  const deliveries = new DeliveryStore();
  let sms: InMemoryChannelAdapter;
  let dispatcher: DeliveryDispatcher;
  let accountSeq = 0;
  let clock = NOON;
  const raised: Array<{ code: string; context: Record<string, unknown> }> = [];

  const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MEMBER), scopeVersion: 1 }, work);
  const owner = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => harness.owner<T>(TENANT_A, [[text, params]]);
  const engine = createDeliveryEngine({ recordInTx: (tx, actor, entry) => new AuditWriter(harness.tenants).recordInTx(tx, actor, entry) });

  /** The only Active SMS account of the tenant: the ones before it are closed, so the chain of a notification plans on this one. */
  async function account(): Promise<string> {
    await owner("update machvon.channel_account set status = 'Disabled' where channel = 'SMS' and status <> 'Disabled'");
    const accountId = id(0xd0, (accountSeq += 1));
    await owner(
      `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref)
       values ($1, $2, 'SMS', $3, 'secret://test/sms', 'v1', 'Active', now(), 'secret://test/sms-webhook')`,
      [TENANT_A, accountId, `sms-${accountSeq}-${randomUUID().slice(0, 6)}`],
    );
    return accountId;
  }

  const move = (accountId: string, status: string) => owner(`update machvon.channel_account set status = '${status}' where id = $1`, [accountId]);

  /** A notification planned on the Active account; the account may change before the attempt is taken up. */
  async function notify(): Promise<string> {
    return as(async (tx) => {
      const eventId = randomUUID();
      const inserted = await notifications.insert(tx, {
        eventId,
        workflowVersionId: WORKFLOW,
        recipientId: memberId(MEMBER),
        purpose: 'OPERATIONAL',
        dedupeKey: dedupeKeyOf({ tenantId: TENANT_A, sourceEventId: eventId, recipientId: memberId(MEMBER), purpose: 'OPERATIONAL' }),
        expiresAt: new Date('2026-10-30T00:00:00Z'),
        sourceEventType: 'report.overdue',
        eventVersion: 1,
        priority: 'NORMAL',
        ackRequired: false,
        channelPlan: ['SMS'],
      });
      await engine.startChain(tx, await deliveries.requireNotification(tx, inserted.id));
      return inserted.id;
    });
  }

  const attemptsOf = (notificationId: string) =>
    owner<{ status: string; error_code: string | null; failure_class: string | null; attempt_no: number }>('select status, error_code, failure_class, attempt_no from machvon.delivery_attempt where notification_id = $1 order by attempt_no', [notificationId]);
  const statusOf = async (accountId: string): Promise<string> => ((await owner<{ status: string }>('select status from machvon.channel_account where id = $1', [accountId]))[0] as { status: string }).status;

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
    dispatcher = new DeliveryDispatcher({ database: harness.tenants, engine, adapters: new ChannelAdapterRegistry([sms], 'test'), loadAccess: (ctx) => access.load(ctx), resourceAccess: new PermissionResourceAccess(), now: () => clock, alerts: { raise: (code, context) => void raised.push({ code, context: context ?? {} }) } }, 'test');
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  it('AC-ST-OMNI-001-3 UAT-PLAN-50: the attempts that wait on an account that was disabled are Suppressed and nothing is sent', async () => {
    const holder = await account();
    const first = await notify();
    const second = await notify();
    await move(holder, 'Disabled');
    const before = sms.requests.length;
    await dispatcher.dispatchDue(CONTEXT);
    for (const notificationId of [first, second]) expect(await attemptsOf(notificationId)).toMatchObject([{ status: 'Suppressed', error_code: 'CHANNEL_ACCOUNT_DISABLED' }]);
    expect(sms.requests).toHaveLength(before);
  });

  it('stops an account whose credential expired with CHANNEL_UNVERIFIED, and sends through an Active one', async () => {
    const holder = await account();
    const stopped = await notify();
    await move(holder, 'CredentialExpired');
    const before = sms.requests.length;
    await dispatcher.dispatchDue(CONTEXT);
    expect(await attemptsOf(stopped)).toMatchObject([{ status: 'Suppressed', error_code: 'CHANNEL_UNVERIFIED' }]);
    expect(sms.requests).toHaveLength(before);
    await account();
    const sent = await notify();
    await dispatcher.dispatchDue(CONTEXT);
    expect(await attemptsOf(sent)).toMatchObject([{ status: 'ProviderAccepted' }]);
    expect(sms.requests).toHaveLength(before + 1);
  });

  it('puts an account whose provider says the credential is gone into CredentialExpired, and what waits for it is stopped at its turn', async () => {
    const holder = await account();
    const first = await notify();
    const waiting = await notify();
    // The second waits for later, as an attempt put off by the quiet hours or a retry does.
    await owner("update machvon.delivery_attempt set next_retry_at = $2::timestamptz where notification_id = $1", [waiting, '2026-10-22T06:00:00Z']);
    sms.enqueue({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'CREDENTIAL_EXPIRED' });
    await dispatcher.dispatchDue(CONTEXT);
    expect(await attemptsOf(first)).toMatchObject([{ status: 'Failed', error_code: 'CREDENTIAL_EXPIRED' }]);
    expect(await statusOf(holder)).toBe('CredentialExpired');
    expect(raised.filter((alert) => alert.code === 'OMNI_CHANNEL_CREDENTIAL_EXPIRED').map((alert) => alert.context)).toEqual([{ tenantId: TENANT_A, channelAccountId: holder, channel: 'SMS' }]);
    const before = sms.requests.length;
    clock = new Date('2026-10-22T06:00:30Z');
    await dispatcher.dispatchDue(CONTEXT);
    expect(await attemptsOf(waiting)).toMatchObject([{ status: 'Suppressed', error_code: 'CHANNEL_UNVERIFIED' }]);
    expect(sms.requests).toHaveLength(before);
    clock = NOON;
  });

  it('serializes taking an attempt up with closing its account: the close waits for the claim, and what was claimed before it is sent', async () => {
    const holder = await account();
    const queued = await notify();
    const [attempt] = await owner<{ id: string }>('select id from machvon.delivery_attempt where notification_id = $1', [queued]);
    let closed = false;
    let closing: Promise<unknown> = Promise.resolve();
    const claimed = await harness.tenants.withTenant(CONTEXT, async (tx) => {
      const outcome = await engine.claim(tx, (attempt as { id: string }).id, 'sms-gateway', NOON);
      // The supervisor closes the account while the claim is open: the update has to wait for it.
      closing = owner("update machvon.channel_account set status = 'Disabled' where id = $1", [holder]).then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(closed).toBe(false);
      return outcome;
    });
    await closing;
    expect(closed).toBe(true);
    expect(claimed.kind).toBe('CLAIMED');
    expect(await statusOf(holder)).toBe('Disabled');
  });

  it('locks the account before its circuit when it records that the credential expired, the order a claim takes them in', async () => {
    await account();
    const queued = await notify();
    const [attempt] = await owner<{ id: string }>('select id from machvon.delivery_attempt where notification_id = $1', [queued]);
    await harness.tenants.withTenant(CONTEXT, (tx) => engine.claim(tx, (attempt as { id: string }).id, 'sms-gateway', NOON));
    const statements: string[] = [];
    await harness.tenants.withTenant(CONTEXT, (tx) => {
      const logged = Object.create(tx) as TenantTx;
      logged.query = ((text: string, params?: unknown[]) => {
        statements.push(text);
        return tx.query(text, params);
      }) as TenantTx['query'];
      // A failure that can be tried again takes the circuit too, so both locks are asked for.
      return engine.recordSendResult(logged, (attempt as { id: string }).id, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'CREDENTIAL_EXPIRED' }, NOON);
    });
    const expire = statements.findIndex((text) => text.includes("update machvon.channel_account set status = 'CredentialExpired'"));
    const circuit = statements.findIndex((text) => text.includes('channel_account_circuit'));
    expect(expire).toBeGreaterThanOrEqual(0);
    expect(circuit).toBeGreaterThanOrEqual(0);
    expect(expire).toBeLessThan(circuit);
  });

  it('does not take an account out of use for another failure of the provider', async () => {
    const holder = await account();
    const first = await notify();
    sms.enqueue({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'INVALID_NUMBER' });
    await dispatcher.dispatchDue(CONTEXT);
    expect(await attemptsOf(first)).toMatchObject([{ status: 'Failed', error_code: 'INVALID_NUMBER' }]);
    expect(await statusOf(holder)).toBe('Active');
  });
});
