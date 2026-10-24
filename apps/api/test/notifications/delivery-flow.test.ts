import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueOutbox } from '@machvon/db';
import { Client } from 'pg';
import { InMemorySpanExporter } from '@machvon/kernel';
import { bootstrap } from '../../src/bootstrap';
import type { RunningApi } from '../../src/bootstrap';
import { createAlertSink } from '../../src/alerts/alert-sinks';
import { CHANNEL_ADAPTERS } from '../../src/notifications/delivery/channel-adapters';
import type { ChannelAdapterRegistry, InMemoryChannelAdapter } from '../../src/notifications/delivery/channel-adapters';
import { TENANT_A, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { READER, startBootstrapFixture } from '../support/bootstrap-fixture';
import type { BootstrapFixture } from '../support/bootstrap-fixture';
import { ManualTimers, until } from '../support/manual-timers';

const RECIPIENT = 2;
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const ACCOUNT = '00000000-0000-4000-8000-0000000000d1';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const WEBHOOK_SECRET = 'relay-webhook-secret-0123456789abcdef';
const PROVIDER = 'smtp-relay';
const TICK = 5_000;
const RECONCILE_TICK = 300_000;
const TEST_TIMEOUT = 90_000;
const PERMISSIONS = ['organization_unit.read', 'iam.unit.manage', 'delivery_attempt.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the delivery engine in the real API process (ST-NOT-002)', () => {
  const exporter = new InMemorySpanExporter();
  const running: RunningApi[] = [];
  const objectRoot = mkdtempSync(join(tmpdir(), 'machvon-not-'));
  const saved: Record<string, string | undefined> = {};
  let fixture: BootstrapFixture;
  let timers: ManualTimers;
  let lines: string[];

  const setEnvironment = (values: Record<string, string>): void => {
    for (const [name, value] of Object.entries(values)) {
      if (!(name in saved)) saved[name] = process.env[name];
      process.env[name] = value;
    }
  };

  async function start(environment = 'test'): Promise<{ api: RunningApi; adapter: InMemoryChannelAdapter | undefined }> {
    setEnvironment({ MACHVON_ENVIRONMENT: environment });
    const config = fixture.configWith();
    const api = await bootstrap(config, {
      exporter,
      port: 0,
      timers,
      alerts: createAlertSink(config, { write: (line) => void lines.push(line) }),
      workerLog: (line) => void lines.push(line),
    });
    running.push(api);
    const registry = api.app.get<ChannelAdapterRegistry>(CHANNEL_ADAPTERS, { strict: false });
    return { api, adapter: registry.forChannel('EMAIL') as InMemoryChannelAdapter | undefined };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixture.harness.owner<R>(TENANT_A, [[sql, params]]);

  /** The event a business module writes when something that concerns a person happens, as its command would: in a tenant transaction through the outbox. */
  const plantEvent = (project: string): Promise<string> =>
    fixture.harness.tenants
      .withTenant(contextFor(TENANT_A, memberId(READER)), (tx) =>
        enqueueOutbox(tx, {
          aggregateType: 'report',
          aggregateId: randomUUID(),
          aggregateVersion: 1,
          type: 'report.overdue',
          schemaVersion: 1,
          payload: { notification: { recipients: [memberId(RECIPIENT)], variables: { project } } },
          eventKey: `planted:${randomUUID()}`,
          correlationId: randomUUID(),
        }),
      )
      .then((written) => written.id);

  const attemptsOf = (eventId: string): Promise<Array<{ id: string; attempt_no: number; status: string; error_code: string | null; provider_message_id: string | null; notification_id: string }>> =>
    rows(
      `select a.id, a.attempt_no, a.status, a.error_code, a.provider_message_id, a.notification_id from machvon.delivery_attempt a
         join machvon.notification_instance n on n.id = a.notification_id where n.event_id = $1 order by a.created_at, a.attempt_no`,
      [eventId],
    );

  /** Fires the five-second jobs (the outbox relay and the dispatcher) until the condition holds. */
  async function pump(condition: () => Promise<boolean>, what: string): Promise<void> {
    await until(async () => {
      timers.fire(TICK);
      await new Promise((wait) => setTimeout(wait, 150));
      return await condition();
    }, what);
  }

  const createUnit = async (api: RunningApi): Promise<Response> =>
    fetch(`http://127.0.0.1:${api.port}/org-units`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ code: `N${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Unit made while the provider is down', parent_id: unitId(1), unit_type: 'DEPARTMENT', valid_from: '2026-02-01' }),
    });

  /** A delivery receipt as the in-memory provider writes it, signed the way the registry says. */
  async function receipt(api: RunningApi, body: Record<string, unknown>, options: { secret?: string; timestamp?: number; path?: string; signed?: boolean } = {}): Promise<Reply> {
    const raw = JSON.stringify(body);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-timestamp': String(timestamp) };
    if (options.signed !== false) headers['x-signature'] = createHmac('sha256', options.secret ?? WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
    const response = await fetch(`http://127.0.0.1:${api.port}/webhooks/channels/${options.path ?? PROVIDER}`, { method: 'POST', headers, body: raw });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const eventBody = (id: string, message: string, status: string, account = 'relay-1'): Record<string, unknown> => ({ id, account, message, status, type: 'delivery.status', at: new Date().toISOString() });

  beforeAll(async () => {
    setEnvironment({ MACHVON_OBJECT_ROOT: objectRoot, MACHVON_SECRET_TEST_RELAY_WEBHOOK: `k1:${WEBHOOK_SECRET}` });
    fixture = await startBootstrapFixture(PERMISSIONS);
    await fixture.harness.seedMembership(TENANT_A, RECIPIENT, 1, { validFrom: '2026-01-01T00:00:00Z' });
    // The jobs visit the tenants of the registry, and a provider receipt finds its tenant among them: the fixture tenant is registered like a provisioned one.
    const admin = new Client({ connectionString: fixture.harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ('00000000-0000-4000-8000-0000000000b1', 'POOL', 'vn-north', 'c-1', 'k-1', 'Active')");
      await admin.query("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, 'FLOW_A', 'Flow A', 'Active', '00000000-0000-4000-8000-0000000000b1', 'vn-north')", [TENANT_A]);
    } finally {
      await admin.end();
    }
    await fixture.harness.owner(TENANT_A, [
      [
        `insert into machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
         values (gen_random_uuid(), 'report.overdue', 'DIS', 1, '{"type":"object"}'::jsonb, '{OPERATIONAL}', 'INTERNAL', 'Active')`,
      ],
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, $2, 'NOTIFICATION', 1, $3::jsonb, 'Published', 'NOTIFICATION', 'report.overdue', $4, repeat('a', 64))`,
        [TENANT_A, WORKFLOW, JSON.stringify({ channels: [{ channel: 'IN_APP' }, { channel: 'EMAIL', templateCode: 'report.overdue' }] }), ACTOR],
      ],
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref)
         values ($1, $2, 'EMAIL', 'relay-1', 'secret://test/relay', 'v1', 'Active', now(), 'secret://test/relay-webhook')`,
        [TENANT_A, ACCOUNT],
      ],
      [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by)
         values ($1, $2, 'report.overdue', 'EMAIL', 'vi-VN', 1, '{"subject":"{{project}} is late","body":"The report of {{project}} is overdue."}'::jsonb, '{"properties":{"project":{}}}'::jsonb, 'Active', repeat('c', 64), $3)`,
        [TENANT_A, TEMPLATE, ACTOR],
      ],
    ]);
  }, 180_000);

  beforeEach(() => {
    timers = new ManualTimers();
    lines = [];
  });

  afterEach(async () => {
    while (running.length > 0) await running.pop()?.stop();
    exporter.spans.length = 0;
  });

  afterAll(async () => {
    await fixture.stop();
    rmSync(objectRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }, 60_000);

  it('AC-ST-NOT-002-6 (UAT-AC29): a business command answers at once while the e-mail provider is down, and the message goes out later', async () => {
    const { api, adapter } = await start();
    if (adapter === undefined) throw new Error('no e-mail adapter');
    // The provider is down: two refusals, then it recovers.
    adapter.enqueue({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'HTTP_503' });
    const started = Date.now();
    const command = await createUnit(api);
    const elapsed = Date.now() - started;
    expect(command.status).toBeLessThan(300);
    expect(elapsed).toBeLessThan(2000);
    // The command did not touch the provider.
    expect(adapter.requests).toHaveLength(0);

    const eventId = await plantEvent('Alpha');
    await pump(async () => (await attemptsOf(eventId)).length > 0, 'the notification to be queued by the consumer');
    await pump(async () => (await attemptsOf(eventId)).some((attempt) => attempt.status === 'Failed'), 'the first send to fail');
    const afterFailure = await attemptsOf(eventId);
    expect(afterFailure.map((attempt) => [attempt.attempt_no, attempt.status, attempt.error_code])).toEqual([
      [1, 'Failed', 'HTTP_503'],
      [2, 'Queued', null],
    ]);
    // The retry waits for its time (30 seconds after the failure); the test brings it forward.
    await rows("update machvon.delivery_attempt set next_retry_at = now() where id = $1", [afterFailure[1]?.id]);
    await pump(async () => (await attemptsOf(eventId)).some((attempt) => attempt.status === 'ProviderAccepted'), 'the retry to be accepted');

    expect(adapter.requests.map((request) => request.idempotencyKey)).toEqual([`${afterFailure[0]?.notification_id}:EMAIL:1`, `${afterFailure[0]?.notification_id}:EMAIL:2`]);
    // The message is written from the template and the event, to the address of the recipient.
    expect(adapter.requests[1]).toMatchObject({ to: 'user2@example.test', subject: 'Alpha is late', text: 'The report of Alpha is overdue.', accountId: 'relay-1' });
    const [notification] = await rows<{ status: string; channel_plan: string[] }>('select status, channel_plan from machvon.notification_instance where event_id = $1', [eventId]);
    expect(notification).toMatchObject({ status: 'Delivered', channel_plan: ['IN_APP', 'EMAIL'] });
    // No address is kept anywhere in the delivery tables, the audit trail or the logs.
    const stored = JSON.stringify(await rows('select * from machvon.delivery_attempt where notification_id = $1', [afterFailure[0]?.notification_id]));
    expect(stored).not.toContain('user2@example.test');
    expect(lines.join('\n')).not.toContain('user2@example.test');
  }, TEST_TIMEOUT);

  it('AC-ST-NOT-002-4 (NOT01): provider receipts that are unsigned, stale, repeated or late are judged by the signature first and by the reducer after', async () => {
    const { api, adapter } = await start();
    if (adapter === undefined) throw new Error('no e-mail adapter');
    const eventId = await plantEvent('Beta');
    await pump(async () => (await attemptsOf(eventId)).some((attempt) => attempt.status === 'ProviderAccepted'), 'the message to be accepted');
    const [attempt] = await attemptsOf(eventId);
    const message = attempt?.provider_message_id ?? '';
    const inboxCount = async (): Promise<number> => Number((await rows<{ n: string }>("select count(*)::text as n from machvon.integration_event_inbox where provider = $1", [PROVIDER]))[0]?.n);
    const before = await inboxCount();

    // Unsigned, wrongly signed, signed with a key the account does not have, and signed long ago: all refused, and nothing is stored.
    const unsigned = await receipt(api, eventBody('e-unsigned', message, 'DELIVERED'), { signed: false });
    expect([unsigned.status, unsigned.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    const forged = await receipt(api, eventBody('e-forged', message, 'DELIVERED'), { secret: 'not-the-secret-of-this-account-0000' });
    expect([forged.status, forged.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    const old = await receipt(api, eventBody('e-old', message, 'DELIVERED'), { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect([old.status, old.json.code]).toEqual([401, 'REPLAY_WINDOW_EXCEEDED']);
    expect(await inboxCount()).toBe(before);

    // A receipt for an account nobody has, for a provider nobody serves, or one that is not a receipt at all, is a 404.
    const unknownAccount = await receipt(api, eventBody('e-account', message, 'DELIVERED', 'no-such-account'));
    expect([unknownAccount.status, unknownAccount.json.code]).toEqual([404, 'CHANNEL_ACCOUNT_UNKNOWN']);
    expect((await receipt(api, eventBody('e-provider', message, 'DELIVERED'), { path: 'no-such-provider' })).status).toBe(404);
    const garbage = await fetch(`http://127.0.0.1:${api.port}/webhooks/channels/${PROVIDER}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'abc', 'x-timestamp': '1' }, body: '[1,2]' });
    expect(garbage.status).toBe(404);

    // The delivery receipt is applied; the accepted receipt that arrives after it is late; the repeats add nothing.
    const delivered = await receipt(api, eventBody('e-delivered', message, 'DELIVERED'));
    expect([delivered.status, delivered.json]).toEqual([200, { received: true, duplicate: false }]);
    const late = await receipt(api, eventBody('e-accepted', message, 'ACCEPTED'));
    expect(late.json).toEqual({ received: true, duplicate: false });
    expect((await receipt(api, eventBody('e-delivered', message, 'DELIVERED'))).json).toEqual({ received: true, duplicate: true });
    expect((await receipt(api, eventBody('e-accepted', message, 'ACCEPTED'))).json).toEqual({ received: true, duplicate: true });
    expect((await attemptsOf(eventId))[0]).toMatchObject({ status: 'Delivered' });
    const history = await rows<{ to_status: string; cause: string }>(
      `select h.to_status, h.cause from machvon.provider_status_history h join machvon.provider_status_item i on i.id = h.item_id where i.subject_id = $1 order by h.item_version`,
      [attempt?.id],
    );
    expect(history).toEqual([
      { to_status: 'SENDING', cause: 'CREATED' },
      { to_status: 'ACCEPTED', cause: 'RESPONSE' },
      { to_status: 'DELIVERED', cause: 'CALLBACK' },
    ]);
    // The body is kept by reference only; the audit row of the receipt names no content.
    expect(await rows("select payload_hash, payload_reference is not null as kept from machvon.integration_event_inbox where event_key = 'e-delivered'")).toEqual([{ payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/), kept: true }]);
    const audits = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'channel.webhook_received'");
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits)).not.toContain(message);
  }, TEST_TIMEOUT);

  it('keeps a receipt whose message id is not known yet and applies it once the send is recorded', async () => {
    const { api } = await start();
    const unknown = await receipt(api, eventBody('e-early', 'msg-not-yet-known', 'DELIVERED'));
    // Persisted and acknowledged: the processing failed and the inbox keeps the event for its next attempt.
    expect(unknown.json).toEqual({ received: true, duplicate: false });
    const [stored] = await rows<{ status: string; error_code: string | null; attempts: number }>("select status, error_code, attempts from machvon.integration_event_inbox where event_key = 'e-early'");
    expect(stored).toMatchObject({ status: 'FAILED', error_code: 'RESOURCE_NOT_FOUND', attempts: 1 });
  }, TEST_TIMEOUT);

  it('asks the provider about a send whose answer was lost and sends it again when the provider never saw it', async () => {
    const { adapter } = await start();
    if (adapter === undefined) throw new Error('no e-mail adapter');
    // The adapter fails in a way it cannot classify: the request may have been made, so the send is Unknown and not repeated on its own.
    adapter.enqueue('THROW');
    const eventId = await plantEvent('Gamma');
    await pump(async () => (await attemptsOf(eventId)).some((attempt) => attempt.status === 'Unknown'), 'the send to become Unknown');
    expect(adapter.requests).toHaveLength(1);
    await pump(async () => true, 'a quiet tick');
    expect(adapter.requests).toHaveLength(1);
    // The reconcile job asks the provider: it has no such request, so the send is a failed one that the schedule repeats.
    timers.fire(RECONCILE_TICK);
    await until(async () => (await attemptsOf(eventId)).length === 2, 'the reconcile job to queue the send again');
    expect((await attemptsOf(eventId)).map((attempt) => [attempt.attempt_no, attempt.status, attempt.error_code])).toEqual([
      [1, 'Failed', 'NOT_FOUND_AT_PROVIDER'],
      [2, 'Queued', null],
    ]);
    // The repeat waits for its time on the schedule (30 seconds); the test brings it forward.
    await rows("update machvon.delivery_attempt set next_retry_at = now() where status = 'Queued' and notification_id = $1", [(await attemptsOf(eventId))[0]?.notification_id]);
    await pump(async () => (await attemptsOf(eventId)).some((attempt) => attempt.status === 'ProviderAccepted'), 'the second send to be accepted');
    expect(adapter.requests).toHaveLength(2);
  }, TEST_TIMEOUT);

  it('does not send on a channel that has no adapter or only a test adapter where real data lives: the attempts are suppressed, not pretended', async () => {
    await start('production');
    const eventId = await plantEvent('Delta');
    await pump(async () => (await attemptsOf(eventId)).some((attempt) => attempt.status === 'Suppressed'), 'the attempt to be suppressed');
    expect((await attemptsOf(eventId)).map((attempt) => [attempt.attempt_no, attempt.status, attempt.error_code])).toEqual([[1, 'Suppressed', 'ADAPTER_MISSING']]);
    const [notification] = await rows<{ status: string }>('select status from machvon.notification_instance where event_id = $1', [eventId]);
    expect(notification?.status).toBe('Delivered');
  }, TEST_TIMEOUT);
});
