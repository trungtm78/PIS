import { createHash, createHmac, randomUUID } from 'node:crypto';
import { BODY_HMAC_SHA256_PREFIXED } from '@machvon/kernel';
import type { ChannelSendResult, MetricsSink } from '@machvon/kernel';
import { DELIVERY_ATTEMPTS_METRIC, DeliveryEngine, OUT_OF_ORDER_METRIC } from '../src/delivery-engine';
import type { ResultNext } from '../src/delivery-engine';
import { DeliveryStore } from '../src/delivery-store';
import { NotificationStore } from '../src/notification-store';
import { ProviderCallbackStore } from '../src/provider-callback-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new NotificationStore();
const deliveries = new DeliveryStore();
const callbacks = new ProviderCallbackStore();

const RECIPIENT = 1;
const ENDED = 2;
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const WORKFLOW_ZNS = '00000000-0000-4000-8000-0000000000b2';
const EMAIL_ACCOUNT = '00000000-0000-4000-8000-0000000000d1';
const SMS_ACCOUNT = '00000000-0000-4000-8000-0000000000d2';
const EMAIL_TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const SMS_TEMPLATE = '00000000-0000-4000-8000-0000000000e2';
const EMAIL = 'smtp-relay';
const SMS = 'sms-gateway';
const SECRET = Buffer.from('relay-webhook-secret-0123456789abcdef');
const T0 = new Date('2026-10-24T03:00:00.000Z');
const NOW_SECONDS = Math.floor(T0.getTime() / 1000);

const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

function dedupeKeyOf(input: { tenantId: string; sourceEventId: string; recipientId: string; purpose: string }): string {
  const text = [input.tenantId, input.sourceEventId, input.recipientId, input.purpose].map((part) => part.toLowerCase()).join('|');
  return `n1:${createHash('sha256').update(text).digest('hex')}`;
}

class CountingMetrics implements MetricsSink {
  readonly counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  readonly gauges: Array<{ name: string; value: number; labels: Record<string, string> | undefined }> = [];

  increment(name: string, labels?: Record<string, string>): void {
    this.counted.push({ name, labels });
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.push({ name, value, labels });
  }

  count(name: string, labels?: Record<string, string>): number {
    return this.counted.filter((entry) => entry.name === name && Object.entries(labels ?? {}).every(([key, value]) => entry.labels?.[key] === value)).length;
  }
}

const unavailable = (retryAfterSeconds?: number): ChannelSendResult => ({
  kind: 'FAILED',
  failureClass: 'RETRYABLE',
  errorCode: 'HTTP_503',
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});
const refused: ChannelSendResult = { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'HTTP_550' };
const accepted = (providerMessageId: string): ChannelSendResult => ({ kind: 'ACCEPTED', providerMessageId });
const timedOut: ChannelSendResult = { kind: 'UNKNOWN', errorCode: 'TIMEOUT_AFTER_SEND' };

interface AttemptRow {
  id: string;
  channel: string;
  attempt_no: number;
  status: string;
  failure_class: string | null;
  error_code: string | null;
  next_retry_at: Date | null;
  provider_message_id: string | null;
}

describe('DeliveryEngine (ST-NOT-002)', () => {
  const metrics = new CountingMetrics();
  const engine = new DeliveryEngine({ metrics, random: () => 0.5, dedupeKeyOf });
  const inTenant = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(RECIPIENT)), work);

  async function owner<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
    return harness.owner<T>(TENANT_A, [[text, params]]);
  }

  /** A notification with the given plan, started as the consumer does: inserted, locked, and its chain started. */
  async function notify(plan: readonly string[], options: { expiresInSeconds?: number; recipient?: number; workflow?: string } = {}): Promise<string> {
    return inTenant(async (tx) => {
      const eventId = randomUUID();
      const inserted = await store.insert(tx, {
        eventId,
        workflowVersionId: options.workflow ?? WORKFLOW,
        recipientId: memberId(options.recipient ?? RECIPIENT),
        purpose: 'OPERATIONAL',
        dedupeKey: dedupeKeyOf({ tenantId: TENANT_A, sourceEventId: eventId, recipientId: memberId(options.recipient ?? RECIPIENT), purpose: 'OPERATIONAL' }),
        expiresAt: at(options.expiresInSeconds ?? 86_400),
        sourceEventType: 'report.overdue',
        eventVersion: 1,
        priority: 'NORMAL',
        ackRequired: false,
        channelPlan: plan,
      });
      const locked = await deliveries.requireNotification(tx, inserted.id);
      await engine.startChain(tx, locked);
      return inserted.id;
    });
  }

  const attemptsOf = (notificationId: string): Promise<AttemptRow[]> =>
    owner<AttemptRow>(
      'select id, channel, attempt_no, status, failure_class, error_code, next_retry_at, provider_message_id from machvon.delivery_attempt where notification_id = $1 order by created_at, attempt_no, id',
      [notificationId],
    );

  const queuedOf = async (notificationId: string, channel?: string): Promise<AttemptRow> => {
    const rows = (await attemptsOf(notificationId)).filter((row) => row.status === 'Queued' && (channel === undefined || row.channel === channel));
    const row = rows[rows.length - 1];
    if (row === undefined) throw new Error('no queued attempt');
    return row;
  };

  const statusOf = async (notificationId: string): Promise<{ status: string; version: number }> => {
    const [row] = await owner<{ status: string; version: string }>('select status, version::text as version from machvon.notification_instance where id = $1', [notificationId]);
    return { status: row?.status ?? '', version: Number(row?.version ?? 0) };
  };

  /** Takes up the queued attempt at `now` and records the adapter result, as the dispatcher does. */
  async function send(attemptId: string, result: ChannelSendResult, now: Date, provider = EMAIL): Promise<ResultNext> {
    const claimed = await inTenant((tx) => engine.claim(tx, attemptId, provider, now));
    expect(claimed.kind).toBe('CLAIMED');
    return inTenant((tx) => engine.recordSendResult(tx, attemptId, result, now));
  }

  /** The signed callback of a provider, received and applied in one tenant transaction, as the inbox handler does. */
  async function callback(provider: string, account: string, eventKey: string, providerMessageId: string, status: 'ACCEPTED' | 'DELIVERED' | 'READ' | 'FAILED') {
    const rawBody = Buffer.from(JSON.stringify({ id: eventKey, message: providerMessageId, status }), 'utf8');
    const signature = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
    return inTenant(async (tx) => {
      const received = await callbacks.receive(tx, {
        provider,
        eventKey,
        eventType: 'delivery.status',
        rawBody,
        signature,
        timestampSeconds: NOW_SECONDS,
        keys: [{ keyId: 'k1', secret: SECRET }],
        scheme: BODY_HMAC_SHA256_PREFIXED,
        channelAccountId: account,
        payloadReference: `object://callbacks/${eventKey}`,
        now: () => NOW_SECONDS,
      });
      if (received.duplicate) return { duplicate: true, outcome: undefined };
      const outcome = await engine.applyCallback(tx, { inboxId: received.inboxId, channelAccountId: account, providerMessageId, status, occurredAt: at(5) });
      return { duplicate: false, outcome };
    });
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: '/1/' }]);
    await harness.seedMembership(TENANT_A, RECIPIENT, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_A, ENDED, 1, { status: 'Ended' });
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'NOTIFICATION', 1, $3::jsonb, 'Published', 'NOTIFICATION', 'report.overdue', $4, repeat('a', 64)),
                ($1, $5, 'NOTIFICATION', 2, $6::jsonb, 'Draft', 'NOTIFICATION', 'report.overdue', $4, repeat('b', 64))`,
        [
          TENANT_A,
          WORKFLOW,
          JSON.stringify({ channels: [{ channel: 'IN_APP' }, { channel: 'EMAIL', templateCode: 'mail.a' }, { channel: 'SMS', templateCode: 'sms.a' }] }),
          ACTOR,
          WORKFLOW_ZNS,
          JSON.stringify({ channels: [{ channel: 'ZALO_ZNS', templateCode: 'zns.a' }, { channel: 'EMAIL', templateCode: 'mail.missing' }] }),
        ],
      ],
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref)
         values ($1, $2, 'EMAIL', 'relay-1', 'secret://test/mail', 'v1', 'Active', now(), 'secret://test/mail-webhook'),
                ($1, $3, 'SMS', 'sms-1', 'secret://test/sms', 'v1', 'Active', now(), 'secret://test/sms-webhook')`,
        [TENANT_A, EMAIL_ACCOUNT, SMS_ACCOUNT],
      ],
      [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by)
         values ($1, $2, 'mail.a', 'EMAIL', 'vi-VN', 1, '{"subject":"S","body":"B"}'::jsonb, '{}'::jsonb, 'Active', repeat('c', 64), $4),
                ($1, $3, 'sms.a', 'SMS', 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, 'Active', repeat('d', 64), $4)`,
        [TENANT_A, EMAIL_TEMPLATE, SMS_TEMPLATE, ACTOR],
      ],
    ]);
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  describe('starting the chain', () => {
    it('queues the first send on the first external channel with an account and a template, and delivers the inbox at once', async () => {
      const id = await notify(['IN_APP', 'EMAIL', 'SMS']);
      expect(await statusOf(id)).toMatchObject({ status: 'Delivered' });
      const attempts = await attemptsOf(id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ channel: 'EMAIL', attempt_no: 1, status: 'Queued', next_retry_at: null });
    });

    it('starts Queued when the plan has no inbox', async () => {
      const id = await notify(['EMAIL']);
      expect(await statusOf(id)).toMatchObject({ status: 'Queued' });
    });

    it('skips a channel that has no account or no Active template and counts it', async () => {
      const before = metrics.count('notification_channel_skipped_total');
      const id = await notify(['ZALO_ZNS', 'EMAIL'], { workflow: WORKFLOW_ZNS });
      // ZNS has no account and the e-mail template of this workflow does not exist: nothing can be queued and there is no inbox.
      expect(await attemptsOf(id)).toHaveLength(0);
      expect(await statusOf(id)).toMatchObject({ status: 'Suppressed' });
      expect(metrics.count('notification_channel_skipped_total') - before).toBe(2);
      const [row] = await owner<{ suppression_reason: string }>('select suppression_reason from machvon.notification_instance where id = $1', [id]);
      expect(row?.suppression_reason).toBe('NO_CHANNEL_AVAILABLE');
    });

    it('leaves a notification delivered in the application as it is when no external channel can be queued', async () => {
      const id = await notify(['IN_APP', 'ZALO_ZNS'], { workflow: WORKFLOW_ZNS });
      expect(await attemptsOf(id)).toHaveLength(0);
      expect(await statusOf(id)).toMatchObject({ status: 'Delivered' });
    });
  });

  describe('taking a send up', () => {
    it('moves a due attempt to Sending, tracks it and gives the dispatcher the idempotency key, the account and the template', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      const claimed = await inTenant((tx) => engine.claim(tx, attempt.id, EMAIL, T0));
      if (claimed.kind !== 'CLAIMED') throw new Error('not claimed');
      expect(claimed.send.idempotencyKey).toBe(`${id}:EMAIL:1`);
      expect(claimed.send.accountId).toBe('relay-1');
      expect(claimed.send.template).toMatchObject({ id: EMAIL_TEMPLATE, code: 'mail.a', contentAst: { subject: 'S', body: 'B' } });
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'Sending' });
      expect(await statusOf(id)).toMatchObject({ status: 'Sending' });
      const item = await inTenant((tx) => callbacks.find(tx, { provider: EMAIL, subjectType: 'delivery_attempt', subjectId: attempt.id }));
      expect(item?.status).toBe('SENDING');
    });

    it('is taken up once even when several processes race for it', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      const results = await Promise.all([1, 2, 3, 4].map(() => inTenant((tx) => engine.claim(tx, attempt.id, EMAIL, T0))));
      expect(results.filter((result) => result.kind === 'CLAIMED')).toHaveLength(1);
      expect(results.filter((result) => result.kind === 'SKIPPED')).toHaveLength(3);
    });

    it('does not take up an attempt before its time, one of a closed notification or one that is not queued', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      await owner('update machvon.delivery_attempt set next_retry_at = $2 where id = $1', [attempt.id, at(60).toISOString()]);
      expect(await inTenant((tx) => engine.claim(tx, attempt.id, EMAIL, T0))).toEqual({ kind: 'SKIPPED', reason: 'NOT_DUE' });
      expect(await inTenant((tx) => engine.claim(tx, randomUUID(), EMAIL, T0))).toEqual({ kind: 'SKIPPED', reason: 'NOT_DUE' });
      await owner("update machvon.notification_instance set status = 'Cancelled' where id = $1", [id]);
      expect(await inTenant((tx) => engine.claim(tx, attempt.id, EMAIL, at(120)))).toEqual({ kind: 'SKIPPED', reason: 'CLOSED' });
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'Cancelled', error_code: 'NOTIFICATION_CLOSED' });
    });

    it('cancels the attempt of a notification that has expired and ends the notification Expired', async () => {
      const id = await notify(['EMAIL'], { expiresInSeconds: 60 });
      const attempt = await queuedOf(id);
      expect(await inTenant((tx) => engine.claim(tx, attempt.id, EMAIL, at(61)))).toEqual({ kind: 'SKIPPED', reason: 'EXPIRED' });
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'Cancelled', error_code: 'EXPIRED' });
      expect(await statusOf(id)).toMatchObject({ status: 'Expired' });
    });

    it('suppresses an attempt whose recipient no longer qualifies, then moves on to the next channel or ends Suppressed', async () => {
      const id = await notify(['EMAIL', 'SMS']);
      const first = await queuedOf(id);
      await inTenant((tx) => engine.suppress(tx, first.id, 'NO_ACCESS', T0));
      const attempts = await attemptsOf(id);
      expect(attempts.map((row) => [row.channel, row.attempt_no, row.status])).toEqual([
        ['EMAIL', 1, 'Suppressed'],
        ['SMS', 1, 'Queued'],
      ]);
      await inTenant((tx) => engine.suppress(tx, attempts[1]?.id ?? '', 'NO_ACCESS', T0));
      expect(await statusOf(id)).toMatchObject({ status: 'Suppressed' });
      const [row] = await owner<{ suppression_reason: string }>('select suppression_reason from machvon.notification_instance where id = $1', [id]);
      expect(row?.suppression_reason).toBe('NO_ACCESS');
      // A repeat, or an attempt that is not queued, changes nothing.
      await inTenant((tx) => engine.suppress(tx, attempts[1]?.id ?? '', 'NO_ACCESS', T0));
      await inTenant((tx) => engine.suppress(tx, randomUUID(), 'NO_ACCESS', T0));
      expect(metrics.count(DELIVERY_ATTEMPTS_METRIC, { outcome: 'suppressed' })).toBeGreaterThanOrEqual(2);
    });

  });

  describe('retry and fallback (BR-NOT-03)', () => {
    it('AC-ST-NOT-002-1 (UAT-AC177): five sends at 30 s, 2 min, 10 min and 30 min, then the next channel takes over', async () => {
      const id = await notify(['IN_APP', 'EMAIL', 'SMS']);
      const waits: number[] = [];
      let now = T0;
      for (let attemptNo = 1; attemptNo <= 5; attemptNo += 1) {
        const attempt = await queuedOf(id, 'EMAIL');
        expect(attempt.attempt_no).toBe(attemptNo);
        const next = await send(attempt.id, unavailable(), now);
        if (attemptNo < 5) {
          expect(next).toBe('RETRY');
          const due = (await queuedOf(id, 'EMAIL')).next_retry_at;
          waits.push((due?.getTime() ?? 0) - now.getTime());
          now = due ?? now;
        } else {
          expect(next).toBe('FALLBACK');
        }
      }
      // With the middle of the jitter range the waits are exactly the schedule; the whole run takes 42.5 minutes, inside the 60 of the story.
      expect(waits).toEqual([30_000, 120_000, 600_000, 1_800_000]);
      expect(now.getTime() - T0.getTime()).toBe(2_550_000);
      const attempts = await attemptsOf(id);
      expect(attempts.filter((row) => row.channel === 'EMAIL').map((row) => [row.attempt_no, row.status, row.failure_class])).toEqual([
        [1, 'Failed', 'RETRYABLE'],
        [2, 'Failed', 'RETRYABLE'],
        [3, 'Failed', 'RETRYABLE'],
        [4, 'Failed', 'RETRYABLE'],
        [5, 'Failed', 'RETRYABLE'],
      ]);
      expect(attempts.filter((row) => row.channel === 'SMS').map((row) => [row.attempt_no, row.status])).toEqual([[1, 'Queued']]);
      // The in-app delivery is untouched by the failures of an external channel.
      expect(await statusOf(id)).toMatchObject({ status: 'Delivered' });
    });

    it('never makes a sixth send on a channel or a second send with the same number: the database refuses both', async () => {
      const id = await notify(['EMAIL']);
      const insert = (attemptNo: number): Promise<unknown> =>
        owner(
          `insert into machvon.delivery_attempt (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id)
           values ($1, gen_random_uuid(), $2, $3, $4, 'Queued', 0, 'EMAIL', $5)`,
          [TENANT_A, id, EMAIL_ACCOUNT, attemptNo, EMAIL_TEMPLATE],
        );
      await expect(insert(6)).rejects.toMatchObject({ code: '23514' });
      await expect(insert(1)).rejects.toMatchObject({ code: '23505' });
    });

    it('AC-ST-NOT-002-2 (UAT-AC178): a notification with a TTL of 5 minutes and a Retry-After of 600 ends Expired with no second attempt', async () => {
      const id = await notify(['EMAIL', 'SMS'], { expiresInSeconds: 300 });
      const attempt = await queuedOf(id);
      expect(await send(attempt.id, unavailable(600), T0)).toBe('EXPIRED');
      expect((await attemptsOf(id)).map((row) => [row.channel, row.attempt_no, row.status])).toEqual([['EMAIL', 1, 'Failed']]);
      expect(await statusOf(id)).toMatchObject({ status: 'Expired' });
    });

    it('uses a Retry-After that is longer than the schedule', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      expect(await send(attempt.id, unavailable(900), T0)).toBe('RETRY');
      expect((await queuedOf(id)).next_retry_at?.getTime()).toBe(T0.getTime() + 900_000);
    });

    it('does not retry a permanent failure: the next channel is tried at once, and when none is left the notification Fails', async () => {
      const id = await notify(['EMAIL', 'SMS']);
      expect(await send((await queuedOf(id)).id, refused, T0)).toBe('FALLBACK');
      const sms = await queuedOf(id, 'SMS');
      expect(sms).toMatchObject({ attempt_no: 1, next_retry_at: null });
      expect(await send(sms.id, refused, at(1), SMS)).toBe('FAILED');
      expect(await statusOf(id)).toMatchObject({ status: 'Failed' });
      expect((await attemptsOf(id)).map((row) => [row.channel, row.status, row.failure_class, row.error_code])).toEqual([
        ['EMAIL', 'Failed', 'PERMANENT', 'HTTP_550'],
        ['SMS', 'Failed', 'PERMANENT', 'HTTP_550'],
      ]);
    });

    it('keeps a notification delivered in the application Delivered when every external channel fails', async () => {
      const id = await notify(['IN_APP', 'EMAIL']);
      expect(await send((await queuedOf(id)).id, refused, T0)).toBe('FAILED');
      expect(await statusOf(id)).toMatchObject({ status: 'Delivered' });
    });

    it('records the acceptance with the provider message id, the latency and the metrics, and ignores a result that comes late', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      expect(await send(attempt.id, accepted('msg-accepted-1'), at(2))).toBe('ACCEPTED');
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'ProviderAccepted', provider_message_id: 'msg-accepted-1', error_code: null });
      expect(await statusOf(id)).toMatchObject({ status: 'ProviderAccepted' });
      expect(metrics.gauges.find((entry) => entry.name === 'delivery_latency_seconds')?.labels).toEqual({ channel: 'EMAIL' });
      expect(metrics.count(DELIVERY_ATTEMPTS_METRIC, { channel: 'EMAIL', outcome: 'accepted' })).toBeGreaterThanOrEqual(1);
      expect(await inTenant((tx) => engine.recordSendResult(tx, attempt.id, refused, at(3)))).toBe('IGNORED');
      expect(await inTenant((tx) => engine.recordSendResult(tx, randomUUID(), refused, at(3)))).toBe('IGNORED');
    });

    it('stops the chain when a cancel arrived while the send was in flight', async () => {
      const id = await notify(['EMAIL', 'SMS']);
      const attempt = await queuedOf(id);
      await inTenant((tx) => engine.claim(tx, attempt.id, EMAIL, T0));
      const { version } = await statusOf(id);
      expect(await inTenant((tx) => engine.cancel(tx, { notificationId: id, expectedVersion: version, now: at(1) }))).toMatchObject({ outcome: 'CANCEL_REQUESTED', cancelledAttempts: 0 });
      expect(await inTenant((tx) => engine.recordSendResult(tx, attempt.id, unavailable(), at(2)))).toBe('FAILED');
      expect((await attemptsOf(id)).map((row) => [row.channel, row.status])).toEqual([['EMAIL', 'Failed']]);
    });
  });

  describe('callbacks and the monotonic reducer (BR-NOT-06)', () => {
    async function acceptedNotification(plan: readonly string[] = ['EMAIL']): Promise<{ id: string; attemptId: string; messageId: string }> {
      const id = await notify(plan);
      const attempt = await queuedOf(id);
      const messageId = `msg-${randomUUID()}`;
      await send(attempt.id, accepted(messageId), T0);
      return { id, attemptId: attempt.id, messageId };
    }

    const historyOf = (attemptId: string): Promise<Array<{ to_status: string; cause: string }>> =>
      owner(
        `select h.to_status, h.cause from machvon.provider_status_history h join machvon.provider_status_item i on i.id = h.item_id
          where i.subject_id = $1 order by h.item_version`,
        [attemptId],
      );

    it('AC-ST-NOT-002-3 (UAT-AC182): a delivered then an accepted callback never move a send back, and a re-sent callback adds no history', async () => {
      const { id, attemptId, messageId } = await acceptedNotification();
      expect(await callback(EMAIL, EMAIL_ACCOUNT, `evt-${messageId}-1`, messageId, 'DELIVERED')).toMatchObject({ outcome: 'APPLIED' });
      expect(await callback(EMAIL, EMAIL_ACCOUNT, `evt-${messageId}-2`, messageId, 'ACCEPTED')).toMatchObject({ outcome: 'STALE' });
      // Re-sent by the provider: the inbox answers duplicate and nothing is applied.
      expect(await callback(EMAIL, EMAIL_ACCOUNT, `evt-${messageId}-1`, messageId, 'DELIVERED')).toMatchObject({ duplicate: true });
      expect(await callback(EMAIL, EMAIL_ACCOUNT, `evt-${messageId}-2`, messageId, 'ACCEPTED')).toMatchObject({ duplicate: true });
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'Delivered' });
      expect(await statusOf(id)).toMatchObject({ status: 'Delivered' });
      expect(await historyOf(attemptId)).toEqual([
        { to_status: 'SENDING', cause: 'CREATED' },
        { to_status: 'ACCEPTED', cause: 'RESPONSE' },
        { to_status: 'DELIVERED', cause: 'CALLBACK' },
      ]);
      expect(metrics.count(OUT_OF_ORDER_METRIC)).toBeGreaterThanOrEqual(1);
    });

    it('stamps the moments of the attempt from the callbacks, and a provider read leaves the notification Delivered', async () => {
      const { id, messageId } = await acceptedNotification();
      await callback(EMAIL, EMAIL_ACCOUNT, `evt-${messageId}-r`, messageId, 'READ');
      const [row] = await owner<{ status: string; delivered_at: Date | null; read_at: Date | null; accepted_at: Date | null }>(
        'select status, delivered_at, read_at, accepted_at from machvon.delivery_attempt where notification_id = $1',
        [id],
      );
      expect(row?.status).toBe('Read');
      expect(row?.delivered_at).not.toBeNull();
      expect(row?.read_at).not.toBeNull();
      expect(await statusOf(id)).toMatchObject({ status: 'Delivered' });
    });

    it('a failure reported after a delivery is a late callback and changes nothing; a failure reported late lets a delivery win', async () => {
      const first = await acceptedNotification();
      await callback(EMAIL, EMAIL_ACCOUNT, `evt-${first.messageId}-d`, first.messageId, 'DELIVERED');
      expect(await callback(EMAIL, EMAIL_ACCOUNT, `evt-${first.messageId}-f`, first.messageId, 'FAILED')).toMatchObject({ outcome: 'STALE' });
      expect((await attemptsOf(first.id))[0]).toMatchObject({ status: 'Delivered' });
      const second = await acceptedNotification();
      await callback(EMAIL, EMAIL_ACCOUNT, `evt-${second.messageId}-f`, second.messageId, 'FAILED');
      expect((await attemptsOf(second.id))[0]).toMatchObject({ status: 'Failed', failure_class: 'PERMANENT', error_code: 'PROVIDER_REPORTED_FAILURE' });
      expect(await statusOf(second.id)).toMatchObject({ status: 'Failed' });
      await callback(EMAIL, EMAIL_ACCOUNT, `evt-${second.messageId}-d`, second.messageId, 'DELIVERED');
      expect((await attemptsOf(second.id))[0]).toMatchObject({ status: 'Delivered' });
      expect(await statusOf(second.id)).toMatchObject({ status: 'Delivered' });
    });

    it('moves the plan on when the provider reports a bounce after accepting a message', async () => {
      const { id, messageId } = await acceptedNotification(['EMAIL', 'SMS']);
      await callback(EMAIL, EMAIL_ACCOUNT, `evt-${messageId}-bounce`, messageId, 'FAILED');
      expect((await attemptsOf(id)).map((row) => [row.channel, row.attempt_no, row.status])).toEqual([
        ['EMAIL', 1, 'Failed'],
        ['SMS', 1, 'Queued'],
      ]);
    });

    it('a delivery reported late cancels the send that the late failure had queued on the next channel, so the person is not messaged twice', async () => {
      const { id, messageId } = await acceptedNotification(['EMAIL', 'SMS']);
      await callback(EMAIL, EMAIL_ACCOUNT, `evt-${messageId}-bounce`, messageId, 'FAILED');
      expect((await attemptsOf(id)).map((row) => [row.channel, row.status])).toEqual([
        ['EMAIL', 'Failed'],
        ['SMS', 'Queued'],
      ]);
      await callback(EMAIL, EMAIL_ACCOUNT, `evt-${messageId}-late`, messageId, 'DELIVERED');
      expect((await attemptsOf(id)).map((row) => [row.channel, row.status])).toEqual([
        ['EMAIL', 'Delivered'],
        ['SMS', 'Cancelled'],
      ]);
      expect(await statusOf(id)).toMatchObject({ status: 'Delivered' });
    });

    it('answers 404 for a provider message id it does not know, and keeps a message id of one account apart from the same id of another', async () => {
      await expect(callback(EMAIL, EMAIL_ACCOUNT, `evt-${randomUUID()}`, 'msg-unknown', 'DELIVERED')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const { messageId } = await acceptedNotification();
      await expect(callback(SMS, SMS_ACCOUNT, `evt-${randomUUID()}`, messageId, 'DELIVERED')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('a result that was lost (BR-NOT-04)', () => {
    const openTasksOf = async (attemptId: string): Promise<number> => {
      const [row] = await owner<{ n: string }>(
        `select count(*)::text as n from machvon.provider_reconciliation_task t join machvon.provider_status_item i on i.id = t.item_id
          where i.subject_id = $1 and t.status = 'OPEN'`,
        [attemptId],
      );
      return Number(row?.n);
    };

    it('AC-ST-NOT-002-5 (UAT-AC180): a timeout after the request left makes the send Unknown, opens a task and blocks a replay until it is reconciled', async () => {
      const id = await notify(['SMS']);
      const attempt = await queuedOf(id);
      expect(await send(attempt.id, timedOut, T0, SMS)).toBe('UNKNOWN');
      expect(await statusOf(id)).toMatchObject({ status: 'Unknown' });
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'Unknown', failure_class: 'UNKNOWN', error_code: 'TIMEOUT_AFTER_SEND' });
      expect(await openTasksOf(attempt.id)).toBe(1);
      const [event] = await owner<{ n: string }>("select count(*)::text as n from machvon.outbox_event where type = 'provider.result_uncertain'");
      expect(Number(event?.n)).toBeGreaterThanOrEqual(1);
      const { version } = await statusOf(id);
      await expect(inTenant((tx) => engine.replay(tx, { notificationId: id, expectedVersion: version, tenantId: TENANT_A, now: at(60) }))).rejects.toMatchObject({
        code: 'RECONCILE_REQUIRED',
        status: 409,
      });
      // Nothing was sent again: still the one attempt.
      expect(await attemptsOf(id)).toHaveLength(1);
    });

    it('a send that was taken up and never reported back becomes Unknown', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      await inTenant((tx) => engine.claim(tx, attempt.id, EMAIL, T0));
      expect(await inTenant((tx) => deliveries.staleSending(tx, at(299), 10))).toEqual([]);
      const stale = await inTenant((tx) => deliveries.staleSending(tx, at(301), 100));
      expect(stale.map((row) => row.id)).toContain(attempt.id);
      expect(await inTenant((tx) => engine.markLost(tx, attempt.id, at(301)))).toBe(true);
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'Unknown', error_code: 'SEND_RESULT_LOST' });
      expect(await inTenant((tx) => engine.markLost(tx, attempt.id, at(302)))).toBe(false);
    });

    it('reconciles by the answer of the provider: a message it holds moves forward and the task closes', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      await send(attempt.id, timedOut, T0);
      const listed = await inTenant((tx) => deliveries.unknownToReconcile(tx, at(300), 100));
      expect(listed.map((row) => row.id)).toContain(attempt.id);
      expect(await inTenant((tx) => engine.reconcile(tx, attempt.id, { kind: 'UNDETERMINED' }, at(300)))).toBe('UNCHANGED');
      expect(await inTenant((tx) => engine.reconcile(tx, attempt.id, { kind: 'FOUND', status: 'DELIVERED', providerMessageId: 'msg-found' }, at(301)))).toBe('RESOLVED');
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'Delivered', provider_message_id: 'msg-found' });
      expect(await statusOf(id)).toMatchObject({ status: 'Delivered' });
      expect(await openTasksOf(attempt.id)).toBe(0);
      expect(await inTenant((tx) => engine.reconcile(tx, attempt.id, { kind: 'FOUND', status: 'DELIVERED', providerMessageId: 'msg-found' }, at(302)))).toBe('UNCHANGED');
    });

    it('reconciles a message the provider has never seen as a failed send that the schedule repeats', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      await send(attempt.id, timedOut, T0);
      expect(await inTenant((tx) => engine.reconcile(tx, attempt.id, { kind: 'NOT_FOUND' }, at(300)))).toBe('RETRIED');
      expect((await attemptsOf(id)).map((row) => [row.attempt_no, row.status, row.error_code])).toEqual([
        [1, 'Failed', 'NOT_FOUND_AT_PROVIDER'],
        [2, 'Queued', null],
      ]);
      expect(await statusOf(id)).toMatchObject({ status: 'Queued' });
      expect(await openTasksOf(attempt.id)).toBe(0);
      expect(await inTenant((tx) => engine.reconcile(tx, randomUUID(), { kind: 'NOT_FOUND' }, at(300)))).toBe('UNCHANGED');
    });

    it('a failure that the provider reports for a send of unknown result, by callback or by the answer to the question, ends the send Failed and moves the plan on', async () => {
      const byCallback = await notify(['EMAIL', 'SMS']);
      const first = await queuedOf(byCallback);
      await send(first.id, timedOut, T0);
      await owner("update machvon.delivery_attempt set provider_message_id = 'msg-bounced' where id = $1", [first.id]);
      expect(await callback(EMAIL, EMAIL_ACCOUNT, `evt-${randomUUID()}`, 'msg-bounced', 'FAILED')).toMatchObject({ outcome: 'APPLIED' });
      expect((await attemptsOf(byCallback)).map((row) => [row.channel, row.status, row.failure_class])).toEqual([
        ['EMAIL', 'Failed', 'PERMANENT'],
        ['SMS', 'Queued', null],
      ]);
      expect(await openTasksOf(first.id)).toBe(0);

      const byLookup = await notify(['EMAIL', 'SMS']);
      const second = await queuedOf(byLookup);
      await send(second.id, timedOut, T0);
      expect(await inTenant((tx) => engine.reconcile(tx, second.id, { kind: 'FOUND', status: 'FAILED', providerMessageId: 'msg-refused' }, at(300)))).toBe('RESOLVED');
      expect((await attemptsOf(byLookup)).map((row) => [row.channel, row.status, row.failure_class])).toEqual([
        ['EMAIL', 'Failed', 'PERMANENT'],
        ['SMS', 'Queued', null],
      ]);
    });

    it('a callback that arrives for a send of unknown result resolves it and closes the task', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      await send(attempt.id, timedOut, T0);
      await owner("update machvon.delivery_attempt set provider_message_id = 'msg-late' where id = $1", [attempt.id]);
      expect(await callback(EMAIL, EMAIL_ACCOUNT, `evt-${randomUUID()}`, 'msg-late', 'ACCEPTED')).toMatchObject({ outcome: 'APPLIED' });
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'ProviderAccepted' });
      expect(await openTasksOf(attempt.id)).toBe(0);
    });
  });

  describe('the circuit breaker of a channel account (BR-NOT-16)', () => {
    it('opens after twenty failures in a minute, rejects for two minutes, lets one probe through and closes on its success', async () => {
      await owner('delete from machvon.channel_account_circuit');
      for (let n = 0; n < 20; n += 1) {
        const failing = await queuedOf(await notify(['EMAIL']));
        await send(failing.id, unavailable(), at(1000 + n));
      }
      const [opened] = await owner<{ state: string; opened_at: Date }>('select state, opened_at from machvon.channel_account_circuit where channel_account_id = $1', [EMAIL_ACCOUNT]);
      expect(opened?.state).toBe('OPEN');
      const waiting = await queuedOf(await notify(['EMAIL']));
      expect(await inTenant((tx) => engine.claim(tx, waiting.id, EMAIL, at(1030)))).toEqual({ kind: 'SKIPPED', reason: 'CIRCUIT_OPEN' });
      const [held] = await owner<{ next_retry_at: Date; status: string }>('select next_retry_at, status from machvon.delivery_attempt where id = $1', [waiting.id]);
      expect(held?.status).toBe('Queued');
      expect(held?.next_retry_at.getTime()).toBe(at(1019).getTime() + 120_000);
      // After the open period one send tests the provider; the others wait for its answer.
      expect((await inTenant((tx) => engine.claim(tx, waiting.id, EMAIL, at(1140)))).kind).toBe('CLAIMED');
      const behind = await queuedOf(await notify(['EMAIL']));
      expect(await inTenant((tx) => engine.claim(tx, behind.id, EMAIL, at(1141)))).toEqual({ kind: 'SKIPPED', reason: 'CIRCUIT_OPEN' });
      expect(await inTenant((tx) => engine.recordSendResult(tx, waiting.id, accepted('msg-probe'), at(1142)))).toBe('ACCEPTED');
      const [closed] = await owner<{ state: string }>('select state from machvon.channel_account_circuit where channel_account_id = $1', [EMAIL_ACCOUNT]);
      expect(closed?.state).toBe('CLOSED');
    });

    it('opens again after a failed probe, and a probe that never reported is lost after five minutes', async () => {
      await owner('delete from machvon.channel_account_circuit');
      await owner("insert into machvon.channel_account_circuit (tenant_id, channel_account_id, state, opened_at) values ($1, $2, 'OPEN', $3)", [TENANT_A, EMAIL_ACCOUNT, at(2000).toISOString()]);
      const probe = await queuedOf(await notify(['EMAIL']));
      expect((await inTenant((tx) => engine.claim(tx, probe.id, EMAIL, at(2121)))).kind).toBe('CLAIMED');
      await inTenant((tx) => engine.recordSendResult(tx, probe.id, unavailable(), at(2123)));
      const [reopened] = await owner<{ state: string; opened_at: Date }>('select state, opened_at from machvon.channel_account_circuit where channel_account_id = $1', [EMAIL_ACCOUNT]);
      expect(reopened?.state).toBe('OPEN');
      expect(reopened?.opened_at.getTime()).toBe(at(2123).getTime());
      // A probe whose process died: HALF_OPEN for more than five minutes counts as a failed probe.
      await owner(
        "update machvon.channel_account_circuit set state = 'HALF_OPEN', probe_started_at = $2, opened_at = $2 where channel_account_id = $1",
        [EMAIL_ACCOUNT, at(3000).toISOString()],
      );
      const stuck = await queuedOf(await notify(['EMAIL']));
      expect(await inTenant((tx) => engine.claim(tx, stuck.id, EMAIL, at(3200)))).toEqual({ kind: 'SKIPPED', reason: 'CIRCUIT_OPEN' });
      expect((await inTenant((tx) => engine.claim(tx, stuck.id, EMAIL, at(3400)))).kind).toBe('CLAIMED');
      await owner('delete from machvon.channel_account_circuit');
    });

    it('does not count the refusals that are about one recipient: twenty permanent failures in a minute leave the provider circuit closed, and a permanent failure of a probe lets the next send probe again', async () => {
      await owner('delete from machvon.channel_account_circuit');
      for (let n = 0; n < 20; n += 1) {
        const bad = await queuedOf(await notify(['EMAIL']));
        await send(bad.id, refused, at(6000 + n));
      }
      const [afterRefusals] = await owner<{ state: string }>('select state from machvon.channel_account_circuit where channel_account_id = $1', [EMAIL_ACCOUNT]);
      expect(afterRefusals?.state ?? 'CLOSED').toBe('CLOSED');
      const next = await queuedOf(await notify(['EMAIL']));
      expect((await inTenant((tx) => engine.claim(tx, next.id, EMAIL, at(6030)))).kind).toBe('CLAIMED');
      await inTenant((tx) => engine.recordSendResult(tx, next.id, accepted('msg-after-refusals'), at(6031)));

      // A probe that ended in a refusal about its recipient says nothing about the provider: the circuit stays open and the next send is the next probe.
      await owner('delete from machvon.channel_account_circuit');
      await owner("insert into machvon.channel_account_circuit (tenant_id, channel_account_id, state, opened_at) values ($1, $2, 'OPEN', $3)", [TENANT_A, EMAIL_ACCOUNT, at(7000).toISOString()]);
      const probe = await queuedOf(await notify(['EMAIL']));
      expect((await inTenant((tx) => engine.claim(tx, probe.id, EMAIL, at(7121)))).kind).toBe('CLAIMED');
      await inTenant((tx) => engine.recordSendResult(tx, probe.id, refused, at(7122)));
      const [released] = await owner<{ state: string }>('select state from machvon.channel_account_circuit where channel_account_id = $1', [EMAIL_ACCOUNT]);
      expect(released?.state).toBe('OPEN');
      const following = await queuedOf(await notify(['EMAIL']));
      expect((await inTenant((tx) => engine.claim(tx, following.id, EMAIL, at(7123)))).kind).toBe('CLAIMED');
      await owner('delete from machvon.channel_account_circuit');
    });

    it('names the circuits that have stayed open for ten minutes, once', async () => {
      await owner('delete from machvon.channel_account_circuit');
      await owner("insert into machvon.channel_account_circuit (tenant_id, channel_account_id, state, opened_at) values ($1, $2, 'OPEN', $3)", [TENANT_A, EMAIL_ACCOUNT, at(4000).toISOString()]);
      expect(await inTenant((tx) => deliveries.circuitsToAlert(tx, at(4500)))).toEqual([]);
      expect(await inTenant((tx) => deliveries.circuitsToAlert(tx, at(4601)))).toEqual([{ channelAccountId: EMAIL_ACCOUNT, channel: 'EMAIL' }]);
      expect(await inTenant((tx) => deliveries.circuitsToAlert(tx, at(4700)))).toEqual([]);
      await owner('delete from machvon.channel_account_circuit');
    });
  });


  describe('replay (NOT 3.6)', () => {
    const replay = (notificationId: string, expectedVersion: number, now: Date) =>
      inTenant((tx) => engine.replay(tx, { notificationId, expectedVersion, tenantId: TENANT_A, now }));

    async function failed(plan: readonly string[] = ['EMAIL'], options: { expiresInSeconds?: number; recipient?: number } = {}): Promise<string> {
      const id = await notify(plan, options);
      await send((await queuedOf(id)).id, refused, T0);
      expect(await statusOf(id)).toMatchObject({ status: 'Failed' });
      return id;
    }

    it('continues the numbering of the channel on the same notification and queues it again', async () => {
      const id = await failed();
      const before = await statusOf(id);
      const result = await replay(id, before.version, at(10));
      expect(result).toMatchObject({ notificationId: id, startedNewChain: false, channel: 'EMAIL' });
      expect(result.version).toBe(before.version + 1);
      expect((await attemptsOf(id)).map((row) => [row.attempt_no, row.status])).toEqual([
        [1, 'Failed'],
        [2, 'Queued'],
      ]);
      expect(await statusOf(id)).toMatchObject({ status: 'Queued' });
    });

    it('refuses a stale version, a notification that is not Failed or Unknown, an expired one and one whose recipient is no longer a member', async () => {
      const id = await failed();
      const { version } = await statusOf(id);
      await expect(replay(id, version - 1, at(10))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: version } });
      await expect(replay(randomUUID(), 1, at(10))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });

      const delivered = await notify(['IN_APP', 'EMAIL']);
      await expect(replay(delivered, (await statusOf(delivered)).version, at(10))).rejects.toMatchObject({ code: 'NOTIFICATION_STATE_INVALID', status: 409 });

      const lapsed = await failed(['EMAIL'], { expiresInSeconds: 100 });
      await expect(replay(lapsed, (await statusOf(lapsed)).version, at(200))).rejects.toMatchObject({ code: 'NOTIFICATION_EXPIRED', status: 409 });

      const ended = await failed(['EMAIL'], { recipient: ENDED });
      await expect(replay(ended, (await statusOf(ended)).version, at(10))).rejects.toMatchObject({ code: 'NOTIFICATION_STATE_INVALID', detail: 'RECIPIENT_INACTIVE' });
    });

    it('refuses when no channel of the plan can take a send now', async () => {
      const id = await failed();
      await owner("update machvon.channel_account set status = 'Disabled' where id = $1", [EMAIL_ACCOUNT]);
      try {
        await expect(replay(id, (await statusOf(id)).version, at(10))).rejects.toMatchObject({ code: 'NOTIFICATION_STATE_INVALID', detail: 'NO_CHANNEL_AVAILABLE' });
      } finally {
        await owner("update machvon.channel_account set status = 'Active' where id = $1", [EMAIL_ACCOUNT]);
      }
    });

    it('lets a replay of an Unknown send through once the day of reconciliation is over, on the channel that may have sent it', async () => {
      const id = await notify(['EMAIL', 'SMS'], { expiresInSeconds: 200_000 });
      await send((await queuedOf(id)).id, timedOut, T0);
      expect(await statusOf(id)).toMatchObject({ status: 'Unknown' });
      await expect(replay(id, (await statusOf(id)).version, at(86_399))).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
      // The alert on a send that stays Unknown is about notifications still waiting for a decision: once the operator has replayed it, it no longer counts.
      const [unknown] = await attemptsOf(id);
      await owner("update machvon.delivery_attempt set unknown_at = '2001-01-01T00:00:00Z' where id = $1", [unknown?.id]);
      expect((await inTenant((tx) => deliveries.gauges(tx))).oldestUnknownSeconds).toBeGreaterThan(20 * 365 * 86_400);
      const result = await replay(id, (await statusOf(id)).version, at(86_401));
      expect((await inTenant((tx) => deliveries.gauges(tx))).oldestUnknownSeconds).toBeLessThan(10 * 365 * 86_400);
      expect(result).toMatchObject({ notificationId: id, startedNewChain: false, channel: 'EMAIL' });
      expect((await attemptsOf(id)).map((row) => [row.channel, row.attempt_no, row.status])).toEqual([
        ['EMAIL', 1, 'Unknown'],
        ['EMAIL', 2, 'Queued'],
      ]);
    });

    it('starts a new notification when the channel has had its five sends, so no channel is ever sent to more than five times', async () => {
      const id = await notify(['EMAIL']);
      let now = T0;
      for (let attemptNo = 1; attemptNo <= 5; attemptNo += 1) {
        const attempt = await queuedOf(id);
        await send(attempt.id, unavailable(), now);
        if (attemptNo < 5) now = (await queuedOf(id)).next_retry_at ?? now;
      }
      expect(await statusOf(id)).toMatchObject({ status: 'Failed' });
      const before = await statusOf(id);
      const queueBefore = await inTenant((tx) => deliveries.gauges(tx));
      const result = await replay(id, before.version, at(5000));
      expect(result.startedNewChain).toBe(true);
      // The original stays Failed in its record, but it is no longer waiting in the failed queue: the gauge of the alert counts what the screen lists.
      expect((await inTenant((tx) => deliveries.gauges(tx))).deadLetter).toBe(queueBefore.deadLetter - 1);
      expect(result.notificationId).not.toBe(id);
      const [copy] = await owner<{ status: string; replay_of: string; replay_seq: number; dedupe_key: string; channel_plan: string[]; recipient_id: string }>(
        'select status, replay_of, replay_seq, dedupe_key, channel_plan, recipient_id from machvon.notification_instance where id = $1',
        [result.notificationId],
      );
      expect(copy).toMatchObject({ status: 'Queued', replay_of: id, replay_seq: 1, channel_plan: ['EMAIL'], recipient_id: memberId(RECIPIENT) });
      expect(copy?.dedupe_key).toBe(dedupeKeyOf({ tenantId: TENANT_A, sourceEventId: `replay:${id}:1`, recipientId: memberId(RECIPIENT), purpose: 'OPERATIONAL' }));
      expect((await attemptsOf(result.notificationId)).map((row) => [row.channel, row.attempt_no, row.status])).toEqual([['EMAIL', 1, 'Queued']]);
      // The original keeps its record, its version moved, and it cannot be replayed again from a stale view or from a fresh one.
      expect((await statusOf(id)).version).toBe(before.version + 1);
      await expect(replay(id, before.version, at(5001))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(replay(id, (await statusOf(id)).version, at(5001))).rejects.toMatchObject({ code: 'NOTIFICATION_STATE_INVALID' });
      // The inbox of the person shows only the original, and the failed queue no longer lists it.
      const inbox = await inTenant((tx) => store.listFor(tx, memberId(RECIPIENT), { limit: 200, after: undefined }));
      expect(inbox.some((row) => row.id === result.notificationId)).toBe(false);
      const dead = await inTenant((tx) => deliveries.list(tx, { notificationId: id, deadLetter: true }, { limit: 50, after: undefined }));
      expect(dead).toEqual([]);
    });
  });

  describe('cancel (NOT 3.6)', () => {
    const cancel = (notificationId: string, expectedVersion: number, now: Date = at(1)) =>
      inTenant((tx) => engine.cancel(tx, { notificationId, expectedVersion, now }));

    it('cancels a notification that has not gone out: its waiting sends and the notification itself', async () => {
      const id = await notify(['EMAIL']);
      const before = await statusOf(id);
      expect(await cancel(id, before.version)).toEqual({ outcome: 'CANCELLED', version: before.version + 1, cancelledAttempts: 1 });
      expect(await statusOf(id)).toEqual({ status: 'Cancelled', version: before.version + 1 });
      expect((await attemptsOf(id))[0]).toMatchObject({ status: 'Cancelled', error_code: 'CANCELLED' });
    });

    it('cancels only the waiting sends of a notification that is already delivered in the application, and records the request', async () => {
      const id = await notify(['IN_APP', 'EMAIL']);
      const before = await statusOf(id);
      expect(await cancel(id, before.version)).toMatchObject({ outcome: 'CANCEL_REQUESTED', cancelledAttempts: 1 });
      expect(await statusOf(id)).toEqual({ status: 'Delivered', version: before.version + 1 });
      const [row] = await owner<{ cancel_requested_at: Date | null }>('select cancel_requested_at from machvon.notification_instance where id = $1', [id]);
      expect(row?.cancel_requested_at).not.toBeNull();
    });

    it('cancels a notification that is only waiting for its next retry: nothing is in flight, so it ends Cancelled and is not left Sending', async () => {
      const id = await notify(['EMAIL']);
      expect(await send((await queuedOf(id)).id, unavailable(), T0)).toBe('RETRY');
      const before = await statusOf(id);
      expect(await cancel(id, before.version)).toEqual({ outcome: 'CANCELLED', version: before.version + 1, cancelledAttempts: 1 });
      expect(await statusOf(id)).toEqual({ status: 'Cancelled', version: before.version + 1 });
      expect((await attemptsOf(id)).map((row) => [row.attempt_no, row.status])).toEqual([
        [1, 'Failed'],
        [2, 'Cancelled'],
      ]);
    });

    it('refuses a stale version, an unknown notification and a notification that is already over', async () => {
      const id = await notify(['EMAIL']);
      const { version } = await statusOf(id);
      await expect(cancel(id, version + 1)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(cancel(randomUUID(), 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await send((await queuedOf(id)).id, refused, T0);
      await expect(cancel(id, (await statusOf(id)).version)).rejects.toMatchObject({ code: 'NOTIFICATION_STATE_INVALID', status: 409 });
    });
  });

  describe('what the database guarantees', () => {
    it('keeps the status of an attempt moving forward and its identity fixed', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      await send(attempt.id, accepted('msg-guard'), T0);
      await callback(EMAIL, EMAIL_ACCOUNT, `evt-${randomUUID()}`, 'msg-guard', 'DELIVERED');
      const update = (set: string): Promise<unknown> => owner(`update machvon.delivery_attempt set ${set} where id = $1`, [attempt.id]);
      await expect(update("status = 'ProviderAccepted'")).rejects.toMatchObject({ code: '23514' });
      await expect(update("status = 'Queued'")).rejects.toMatchObject({ code: '23514' });
      await expect(update("provider_message_id = 'msg-other'")).rejects.toMatchObject({ code: '23514' });
      await expect(update('attempt_no = 2')).rejects.toMatchObject({ code: '23514' });
      await expect(update("channel = 'SMS'")).rejects.toMatchObject({ code: '23514' });
      await expect(update("status = 'Failed'")).rejects.toMatchObject({ code: '23514' });
      await update("status = 'Read'");
    });

    it('requires a failure class and a time for a failed send, and a code in capitals', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      await inTenant((tx) => engine.claim(tx, attempt.id, EMAIL, T0));
      const update = (set: string): Promise<unknown> => owner(`update machvon.delivery_attempt set ${set} where id = $1`, [attempt.id]);
      await expect(update("status = 'Failed'")).rejects.toMatchObject({ code: '23514' });
      await expect(update("status = 'Unknown', failure_class = 'RETRYABLE', unknown_at = now()")).rejects.toMatchObject({ code: '23514' });
      await expect(update("error_code = 'lower case'")).rejects.toMatchObject({ code: '23514' });
    });

    it('does not deliver a send that was never taken up', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      await expect(owner("update machvon.delivery_attempt set status = 'Delivered' where id = $1", [attempt.id])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('the reads of the operator', () => {
    it('lists the attempts newest first in keyset pages, filtered by status and by notification', async () => {
      const id = await notify(['EMAIL', 'SMS']);
      await send((await queuedOf(id)).id, unavailable(), T0);
      const all = await inTenant((tx) => deliveries.list(tx, { notificationId: id }, { limit: 50, after: undefined }));
      expect(all.map((row) => [row.channel, row.attemptNo, row.status])).toEqual([
        ['EMAIL', 2, 'Queued'],
        ['EMAIL', 1, 'Failed'],
      ]);
      const first = await inTenant((tx) => deliveries.list(tx, { notificationId: id }, { limit: 1, after: undefined }));
      const rest = await inTenant((tx) => deliveries.list(tx, { notificationId: id }, { limit: 5, after: { code: first[0]?.cursorKey ?? '', id: first[0]?.id ?? '' } }));
      expect([...first, ...rest].map((row) => row.id)).toEqual(all.map((row) => row.id));
      const queued = await inTenant((tx) => deliveries.list(tx, { notificationId: id, statuses: ['Queued'] }, { limit: 50, after: undefined }));
      expect(queued.map((row) => row.attemptNo)).toEqual([2]);
      await expect(inTenant((tx) => deliveries.list(tx, {}, { limit: 5, after: { code: 'not-a-date', id: randomUUID() } }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('shows what NOT-11, NOT-12 and NOT-13 need and never an address or a body', async () => {
      const id = await notify(['IN_APP', 'EMAIL', 'SMS']);
      await send((await queuedOf(id)).id, unavailable(), T0);
      const [first] = await inTenant((tx) => deliveries.list(tx, { notificationId: id, statuses: ['Failed'] }, { limit: 5, after: undefined }));
      if (first === undefined) throw new Error('no failed attempt');
      const found = await inTenant((tx) => deliveries.find(tx, first.id));
      expect(found).toMatchObject({
        id: first.id,
        notificationId: id,
        channel: 'EMAIL',
        attemptNo: 1,
        status: 'Failed',
        failureClass: 'RETRYABLE',
        errorCode: 'HTTP_503',
        fallbackChannel: 'SMS',
        needsReconcile: false,
        reconcileDueAt: null,
        replayOf: null,
        ackRequired: false,
      });
      expect(Object.keys(found ?? {}).sort()).not.toEqual(expect.arrayContaining(['to', 'address', 'body', 'payload']));
      const journey = await inTenant((tx) => deliveries.journey(tx, id));
      expect(journey.map((row) => row.attemptNo)).toEqual([1, 2]);
      const history = await inTenant((tx) => deliveries.history(tx, first.id));
      expect(history.map((row) => [row.fromStatus, row.toStatus, row.cause])).toEqual([
        [null, 'SENDING', 'CREATED'],
        ['SENDING', 'FAILED', 'RESPONSE'],
      ]);
      expect(await inTenant((tx) => deliveries.find(tx, randomUUID()))).toBeUndefined();
    });

    it('lists the failed queue: the notifications that could not be delivered, with the last send of each channel, and what needs reconciling', async () => {
      const dead = await notify(['EMAIL']);
      await send((await queuedOf(dead)).id, refused, T0);
      const lost = await notify(['SMS']);
      await send((await queuedOf(lost)).id, timedOut, new Date(Date.now() - 1000), SMS);
      const delivered = await notify(['IN_APP', 'EMAIL']);
      await send((await queuedOf(delivered)).id, refused, T0);
      const queue = await inTenant((tx) => deliveries.list(tx, { deadLetter: true }, { limit: 200, after: undefined }));
      const ids = queue.map((row) => row.notificationId);
      expect(ids).toContain(dead);
      expect(ids).toContain(lost);
      expect(ids).not.toContain(delivered);
      const unknown = queue.find((row) => row.notificationId === lost);
      expect(unknown).toMatchObject({ status: 'Unknown', needsReconcile: true });
      expect(unknown?.reconcileDueAt).not.toBeNull();
      const gauges = await inTenant((tx) => deliveries.gauges(tx));
      expect(gauges.deadLetter).toBeGreaterThanOrEqual(2);
      expect(gauges.oldestUnknownSeconds).toBeGreaterThanOrEqual(0);
    });

    it('keeps the attempts of one tenant out of the reads of another', async () => {
      const id = await notify(['EMAIL']);
      const attempt = await queuedOf(id);
      const other = await harness.tenants.withTenant(contextFor(TENANT_B, memberId(RECIPIENT)), async (tx) => ({
        found: await deliveries.find(tx, attempt.id),
        listed: await deliveries.list(tx, {}, { limit: 200, after: undefined }),
        locked: await deliveries.lockNotification(tx, id),
      }));
      expect(other.found).toBeUndefined();
      expect(other.listed).toEqual([]);
      expect(other.locked).toBeUndefined();
    });
  });

});
