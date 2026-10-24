import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { NotificationDeliveryController } from '../../src/notifications/delivery/delivery.controller';
import { DeliveryAttemptReadsController } from '../../src/notifications/delivery/delivery-reads.controller';
import { DELIVERY_ENGINE } from '../../src/notifications/delivery/tokens';
import { createDeliveryEngine } from '../../src/notifications/delivery/wiring';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const OPERATOR = 1; // the three permissions, on the whole tenant
const SUBTREE = 2; // the same permissions, on the subtree of unit 2 only
const NOBODY = 3;
const RECIPIENT = 4;
const OTHER_TENANT_OPERATOR = 1; // of tenant B
const PERMISSIONS = ['delivery_attempt.read', 'notification.replay', 'notification.operate'];
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const ACCOUNT = '00000000-0000-4000-8000-0000000000d1';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const REASON = 'The provider has fixed its relay';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface PlantedAttempt {
  channel?: string;
  no: number;
  status: 'Queued' | 'Failed' | 'Unknown' | 'ProviderAccepted' | 'Sending';
  unknownAgoSeconds?: number;
  errorCode?: string;
}

describe('replay, cancel and the reads of the delivery attempts (ST-NOT-002, NOT-11, NOT-12, NOT-13)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? OPERATOR, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
  }

  /** A notification in a given state with the attempts it has had, planted as the engine would have left it. */
  async function plant(status: string, attempts: PlantedAttempt[], options: { tenant?: string; expiresInSeconds?: number; recipient?: number; ackRequired?: boolean } = {}): Promise<{ id: string; version: number; attemptIds: string[] }> {
    const tenant = options.tenant ?? TENANT_A;
    const id = randomUUID();
    await rows(
      `insert into machvon.notification_instance
         (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, event_version, priority, ack_required, channel_plan)
       values ($1, $2, gen_random_uuid(), $3, $4, 'OPERATIONAL', $5, now() + make_interval(secs => $6), $7, 'report.overdue', 1, 'NORMAL', $8, '{EMAIL,SMS}')`,
      [tenant, id, WORKFLOW, memberId(options.recipient ?? RECIPIENT), `n1:${randomBytes(32).toString('hex')}`, options.expiresInSeconds ?? 86_400, status, options.ackRequired ?? false],
      tenant,
    );
    const attemptIds: string[] = [];
    for (const attempt of attempts) {
      const attemptId = randomUUID();
      attemptIds.push(attemptId);
      const sent = attempt.status !== 'Queued';
      await rows(
        `insert into machvon.delivery_attempt
           (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id, sending_at, failed_at, unknown_at, failure_class, error_code, accepted_at)
         values ($1, $2, $3, $4, $5, $6, 0, $7, $8, case when $9 then now() end,
                 case when $6 in ('Failed', 'Unknown') then now() end,
                 case when $6 = 'Unknown' then now() - make_interval(secs => $10) end,
                 case $6 when 'Failed' then 'PERMANENT' when 'Unknown' then 'UNKNOWN' end,
                 case when $6 in ('Failed', 'Unknown') then $11 end,
                 case when $6 = 'ProviderAccepted' then now() end)`,
        [tenant, attemptId, id, ACCOUNT, attempt.no, attempt.status, attempt.channel ?? 'EMAIL', TEMPLATE, sent, attempt.unknownAgoSeconds ?? 0, attempt.errorCode ?? 'HTTP_550'],
        tenant,
      );
    }
    const [row] = await rows<{ version: string }>('select version::text as version from machvon.notification_instance where id = $1', [id], tenant);
    return { id, version: Number(row?.version), attemptIds };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const [member, unit] of [[OPERATOR, 1], [SUBTREE, 2], [NOBODY, 1]] as const) await harness.seedMembership(TENANT_A, member, unit, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_A, RECIPIENT, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_OPERATOR, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'NOTIFICATION_OPERATOR', PERMISSIONS, 50);
      await harness.owner(tenant, [
        [
          `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
           values ($1, $2, 'NOTIFICATION', 1, $3::jsonb, 'Published', 'NOTIFICATION', 'report.overdue', $4, repeat('a', 64))`,
          [tenant, WORKFLOW, JSON.stringify({ channels: [{ channel: 'EMAIL', templateCode: 'mail.a' }, { channel: 'SMS', templateCode: 'sms.a' }] }), ACTOR],
        ],
        [
          `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at)
           values ($1, $2, 'EMAIL', 'relay-1', 'secret://test/mail', 'v1', 'Active', now()), ($1, gen_random_uuid(), 'SMS', 'sms-1', 'secret://test/sms', 'v1', 'Active', now())`,
          [tenant, ACCOUNT],
        ],
        [
          `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by)
           values ($1, $2, 'mail.a', 'EMAIL', 'vi-VN', 1, '{"subject":"S","body":"B"}'::jsonb, '{}'::jsonb, 'Active', repeat('c', 64), $3),
                  ($1, gen_random_uuid(), 'sms.a', 'SMS', 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, 'Active', repeat('d', 64), $3)`,
          [tenant, TEMPLATE, ACTOR],
        ],
      ]);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OPERATOR, role: 1, kind: 'TENANT' },
      { n: 2, member: SUBTREE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_OPERATOR, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [NotificationDeliveryController, DeliveryAttemptReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DELIVERY_ENGINE, useValue: createDeliveryEngine() },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('get_resources_delivery_attempt and get_resources_delivery_attempt_id (NOT-11, NOT-12, NOT-13)', () => {
    it('lists the attempts of the tenant newest first and shows the operator nothing that identifies the person or the message', async () => {
      const planted = await plant('Failed', [{ no: 1, status: 'Failed' }]);
      const page = await call('GET', `/resources/delivery_attempt?notification_id=${planted.id}`);
      expect(page.status).toBe(200);
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ notification_id: planted.id, notification_status: 'Failed', channel: 'EMAIL', attempt_no: 1, status: 'Failed', failure_class: 'PERMANENT', error_code: 'HTTP_550', fallback_channel: 'SMS', needs_reconcile: false });
      // An allowlist: no address, no body, no payload, no recipient and no internal reference.
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(
        [
          'accepted_at', 'ack_required', 'acknowledged_at', 'attempt_no', 'channel', 'delivered_at', 'error_code', 'expires_at', 'failed_at', 'failure_class', 'fallback_channel', 'id',
          'needs_reconcile', 'next_retry_at', 'notification_id', 'notification_status', 'notification_version', 'provider_message_id', 'queued_at', 'read_at', 'reconcile_due_at', 'replay_of',
          'sending_at', 'status',
        ].sort(),
      );
      expect(JSON.stringify(page.json)).not.toMatch(/recipient|payload|address|channel_account|template|secret/);
    });

    it('filters by status, by notification and by the failed queue, pages with a cursor, and refuses a malformed filter or cursor with 422', async () => {
      const queue = await plant('Queued', [{ no: 1, status: 'Queued' }]);
      const dead = await plant('Failed', [{ no: 1, status: 'Failed' }]);
      const queued = await call('GET', '/resources/delivery_attempt?status=Queued,Sending&limit=200');
      expect((queued.json.items as Array<{ notification_id: string }>).map((item) => item.notification_id)).toContain(queue.id);
      expect((queued.json.items as Array<{ notification_id: string }>).map((item) => item.notification_id)).not.toContain(dead.id);
      const failures = await call('GET', '/resources/delivery_attempt?dlq=true&limit=200');
      expect((failures.json.items as Array<{ notification_id: string }>).map((item) => item.notification_id)).toContain(dead.id);
      const first = await call('GET', '/resources/delivery_attempt?limit=1');
      expect(first.json.next_cursor).toEqual(expect.any(String));
      const second = await call('GET', `/resources/delivery_attempt?limit=1&cursor=${first.json.next_cursor as string}`);
      expect((second.json.items as unknown[]).length).toBe(1);
      for (const query of ['status=Bogus', 'status=', `notification_id=not-a-uuid`, 'dlq=maybe', 'limit=0', 'cursor=!!']) {
        const refused = await call('GET', `/resources/delivery_attempt?${query}`);
        expect([query, refused.status, refused.json.code]).toEqual([query, 422, 'VALIDATION_FAILED']);
      }
      const falseFilter = await call('GET', '/resources/delivery_attempt?dlq=false&limit=200');
      expect(falseFilter.status).toBe(200);
    });

    it('shows the journey of the notification and the history of the attempt', async () => {
      const planted = await plant('Failed', [
        { no: 1, status: 'Failed', errorCode: 'HTTP_503' },
        { no: 2, status: 'Failed' },
      ]);
      const detail = await call('GET', `/resources/delivery_attempt/${planted.attemptIds[1]}`);
      expect(detail.status).toBe(200);
      expect(detail.json).toMatchObject({ id: planted.attemptIds[1], attempt_no: 2, status: 'Failed' });
      expect((detail.json.journey as Array<{ attempt_no: number }>).map((item) => item.attempt_no)).toEqual([1, 2]);
      expect(detail.json.history).toEqual([]);
    });

    it('is empty for a grant on a subtree and for a member with no grant, and 404 for an attempt by id, whoever asks', async () => {
      const planted = await plant('Failed', [{ no: 1, status: 'Failed' }]);
      expect((await call('GET', '/resources/delivery_attempt', { member: SUBTREE })).json).toEqual({ items: [], next_cursor: null });
      expect((await call('GET', `/resources/delivery_attempt/${planted.attemptIds[0]}`, { member: SUBTREE })).status).toBe(404);
      expect((await call('GET', '/resources/delivery_attempt', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/resources/delivery_attempt/${randomUUID()}`)).status).toBe(404);
    });

    it('does not show the attempt of another tenant, by id or in the list', async () => {
      const foreign = await plant('Failed', [{ no: 1, status: 'Failed' }], { tenant: TENANT_B });
      expect((await call('GET', `/resources/delivery_attempt/${foreign.attemptIds[0]}`)).status).toBe(404);
      const listed = await call('GET', `/resources/delivery_attempt?notification_id=${foreign.id}`);
      expect(listed.json.items).toEqual([]);
    });
  });

  describe('post_notifications_id_replay (NOT-13)', () => {
    const replay = (id: string, version: number, extra: { member?: number; body?: unknown; key?: string; tenantId?: string } = {}): Promise<Reply> =>
      call('POST', `/notifications/${id}/replay`, { ifMatch: `"${version}"`, body: { decision: 'approve', reason: REASON, evidence_ids: [] }, ...extra });

    it('queues a send again for a failed notification, answers 202 and audits it with the reason', async () => {
      const planted = await plant('Failed', [{ no: 1, status: 'Failed' }]);
      const reply = await replay(planted.id, planted.version);
      expect(reply.status).toBe(202);
      expect(reply.json).toMatchObject({ status: 'QUEUED', resource_id: planted.id, resource_version: planted.version + 1 });
      expect(await rows<{ attempt_no: number; status: string }>('select attempt_no, status from machvon.delivery_attempt where notification_id = $1 order by attempt_no', [planted.id])).toEqual([
        { attempt_no: 1, status: 'Failed' },
        { attempt_no: 2, status: 'Queued' },
      ]);
      const [audit] = await rows<{ reason: string; safe_diff: Record<string, unknown>; classification: string }>("select reason, safe_diff, classification from machvon.audit_event where action = 'notification.replayed' and resource_id = $1", [planted.id]);
      expect(audit).toMatchObject({ reason: REASON, classification: 'INTERNAL', safe_diff: { started_new_chain: false, channel: 'EMAIL', evidence_count: 0 } });
    });

    it('answers a repeat with the same key from the stored result and makes no second send', async () => {
      const planted = await plant('Failed', [{ no: 1, status: 'Failed' }]);
      const key = `key-${randomUUID()}`;
      const first = await replay(planted.id, planted.version, { key });
      const second = await replay(planted.id, planted.version, { key });
      expect([first.status, second.status]).toEqual([202, 202]);
      expect(second.json).toEqual(first.json);
      expect(await rows('select 1 from machvon.delivery_attempt where notification_id = $1', [planted.id])).toHaveLength(2);
    });

    it('AC-ST-NOT-002-5 (UAT-AC180): refuses 409 RECONCILE_REQUIRED while a send of unknown result is within its day, and sends nothing', async () => {
      const planted = await plant('Unknown', [{ channel: 'SMS', no: 1, status: 'Unknown', errorCode: 'TIMEOUT_AFTER_SEND' }]);
      const refused = await replay(planted.id, planted.version);
      expect([refused.status, refused.json.code]).toEqual([409, 'RECONCILE_REQUIRED']);
      expect(await rows('select 1 from machvon.delivery_attempt where notification_id = $1', [planted.id])).toHaveLength(1);
      // A day later the operator may decide, at the risk of a double send that NOT-13 states.
      const stale = await plant('Unknown', [{ channel: 'SMS', no: 1, status: 'Unknown', unknownAgoSeconds: 90_000, errorCode: 'TIMEOUT_AFTER_SEND' }]);
      expect((await replay(stale.id, stale.version)).status).toBe(202);
    });

    it('refuses a notification that is not failed, one that has expired, a stale version and a body that is not an approval', async () => {
      const delivered = await plant('Delivered', [{ no: 1, status: 'ProviderAccepted' }]);
      expect((await replay(delivered.id, delivered.version)).json.code).toBe('NOTIFICATION_STATE_INVALID');
      const expired = await plant('Failed', [{ no: 1, status: 'Failed' }], { expiresInSeconds: -60 });
      expect((await replay(expired.id, expired.version)).json.code).toBe('NOTIFICATION_EXPIRED');
      const failed = await plant('Failed', [{ no: 1, status: 'Failed' }]);
      const stale = await replay(failed.id, failed.version + 5);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const rejected = await replay(failed.id, failed.version, { body: { decision: 'reject', reason: REASON, evidence_ids: [] } });
      expect([rejected.status, rejected.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const noVersion = await call('POST', `/notifications/${failed.id}/replay`, { body: { decision: 'approve', reason: REASON, evidence_ids: [] } });
      expect(noVersion.status).toBe(428);
      const malformed = await replay(failed.id, failed.version, { body: { decision: 'approve' } });
      expect(malformed.status).toBe(400);
    });

    it('is refused for a member without the permission (403) and for a grant on a subtree (403 SCOPE_DENIED)', async () => {
      const planted = await plant('Failed', [{ no: 1, status: 'Failed' }]);
      expect((await replay(planted.id, planted.version, { member: NOBODY })).status).toBe(403);
      const scoped = await replay(planted.id, planted.version, { member: SUBTREE });
      expect([scoped.status, scoped.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select 1 from machvon.delivery_attempt where notification_id = $1', [planted.id])).toHaveLength(1);
    });

    it('does not reach a notification of another tenant', async () => {
      const foreign = await plant('Failed', [{ no: 1, status: 'Failed' }], { tenant: TENANT_B });
      const reply = await replay(foreign.id, foreign.version);
      expect([reply.status, reply.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(await rows('select 1 from machvon.delivery_attempt where notification_id = $1', [foreign.id], TENANT_B)).toHaveLength(1);
    });
  });

  describe('cancelNotification', () => {
    const cancel = (id: string, version: number, extra: { member?: number; body?: unknown } = {}): Promise<Reply> =>
      call('POST', `/notifications/${id}/cancel`, { ifMatch: `"${version}"`, body: { reason: 'The report was withdrawn' }, ...extra });

    it('cancels a notification that has not gone out and audits it', async () => {
      const planted = await plant('Queued', [{ no: 1, status: 'Queued' }]);
      const reply = await cancel(planted.id, planted.version);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'CANCELLED', resource_id: planted.id, resource_version: planted.version + 1 });
      expect(await rows('select status from machvon.notification_instance where id = $1', [planted.id])).toEqual([{ status: 'Cancelled' }]);
      expect(await rows("select reason from machvon.audit_event where action = 'notification.cancelled' and resource_id = $1", [planted.id])).toEqual([{ reason: 'The report was withdrawn' }]);
    });

    it('only records the request once a provider has accepted the message, and cancels what was waiting', async () => {
      const planted = await plant('ProviderAccepted', [
        { no: 1, status: 'ProviderAccepted' },
        { channel: 'SMS', no: 1, status: 'Queued' },
      ]);
      const reply = await cancel(planted.id, planted.version);
      expect(reply.json).toMatchObject({ status: 'CANCEL_REQUESTED' });
      expect(await rows('select status from machvon.notification_instance where id = $1', [planted.id])).toEqual([{ status: 'ProviderAccepted' }]);
      expect(await rows('select channel, status from machvon.delivery_attempt where notification_id = $1 order by channel', [planted.id])).toEqual([
        { channel: 'EMAIL', status: 'ProviderAccepted' },
        { channel: 'SMS', status: 'Cancelled' },
      ]);
      expect(await rows("select 1 from machvon.audit_event where action = 'notification.cancel_requested' and resource_id = $1", [planted.id])).toHaveLength(1);
    });

    it('refuses a notification that is over, a stale version and the wrong people', async () => {
      const failed = await plant('Failed', [{ no: 1, status: 'Failed' }]);
      expect((await cancel(failed.id, failed.version)).json.code).toBe('NOTIFICATION_STATE_INVALID');
      const queued = await plant('Queued', [{ no: 1, status: 'Queued' }]);
      expect((await cancel(queued.id, queued.version + 1)).json.code).toBe('VERSION_CONFLICT');
      expect((await cancel(queued.id, queued.version, { member: SUBTREE })).json.code).toBe('SCOPE_DENIED');
      expect((await cancel(queued.id, queued.version, { member: NOBODY })).status).toBe(403);
      expect((await cancel(queued.id, queued.version, { body: { reason: 'short' } })).status).toBe(422);
      const foreign = await plant('Queued', [{ no: 1, status: 'Queued' }], { tenant: TENANT_B });
      expect((await cancel(foreign.id, foreign.version)).status).toBe(404);
      expect(await rows('select status from machvon.notification_instance where id = $1', [queued.id])).toEqual([{ status: 'Queued' }]);
    });
  });
});
