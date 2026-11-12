import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_MEMBERSHIP_ID, enqueueOutbox } from '@machvon/db';
import type { IntegrationInboxProcessor } from '@machvon/db';
import { Client } from 'pg';
import { InMemorySpanExporter } from '@machvon/kernel';
import { bootstrap } from '../../src/bootstrap';
import type { RunningApi } from '../../src/bootstrap';
import { createAlertSink } from '../../src/alerts/alert-sinks';
import { ADM_INBOX_PROCESSOR } from '../../src/modules/adm/tokens';
import { CHANNEL_ADAPTERS } from '../../src/notifications/delivery/channel-adapters';
import type { ChannelAdapterRegistry, InMemoryChannelAdapter } from '../../src/notifications/delivery/channel-adapters';
import { WEBHOOK_PAYLOADS } from '../../src/notifications/delivery/webhook-support';
import type { WebhookPayloadStore } from '../../src/notifications/delivery/webhook-support';
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
const FORGED_SECRET = ['not', 'the', 'secret', 'of', 'this', 'account', '0000'].join('-');
const PROVIDER = 'smtp-relay';
const TICK = 5_000;
const RECONCILE_TICK = 300_000;
const TEST_TIMEOUT = 90_000;
const PERMISSIONS = ['organization_unit.read', 'iam.unit.manage', 'delivery_attempt.read', 'omni.channel.manage', 'channel_account.read', 'adm.integration.operate'];

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
  async function pump(condition: () => Promise<boolean>, what: string, timeoutMs?: number): Promise<void> {
    await until(
      async () => {
        timers.fire(TICK);
        await new Promise((wait) => setTimeout(wait, 150));
        return await condition();
      },
      what,
      timeoutMs,
    );
  }

  const createUnit = async (api: RunningApi): Promise<Response> =>
    fetch(`http://127.0.0.1:${api.port}/org-units`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ code: `N${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Unit made while the provider is down', parent_id: unitId(1), unit_type: 'DEPARTMENT', valid_from: '2026-02-01' }),
    });

  /** A delivery receipt as the in-memory provider writes it, signed the way the registry says. */
  async function receipt(api: RunningApi, body: Record<string, unknown>, options: { secret?: string; timestamp?: number; path?: string; signed?: boolean; idempotencyKey?: string; tamper?: boolean } = {}): Promise<Reply> {
    const raw = JSON.stringify(body);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-timestamp': String(timestamp) };
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
    if (options.signed !== false) headers['x-signature'] = createHmac('sha256', options.secret ?? WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
    // One byte of the body changes after it was signed.
    const sent = options.tamper === true ? raw.replace('delivery.status', 'delivery.statuz') : raw;
    const response = await fetch(`http://127.0.0.1:${api.port}/webhooks/channels/${options.path ?? PROVIDER}`, { method: 'POST', headers, body: sent });
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
        // The recipient consented to e-mail (BR-NOT-07): without a consent no send is taken up.
        `insert into machvon.contact_consent (tenant_id, id, membership_id, channel, purpose, status, evidence_reference, effective_at, consent_text_version, capture_method)
         values ($1, gen_random_uuid(), $2, 'EMAIL', 'OPERATIONAL', 'Granted', 'in-app:test', now(), 'v1', 'IN_APP')`,
        [TENANT_A, memberId(RECIPIENT)],
      ],
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

  it('AC-ST-KERNEL-073-1 (UAT-NFR-AVAILABILITY-04): a provider that fails every call does not touch the business commands: 20 of 20 succeed, every delivery waits for its retry, and the breaker of the account opens within 30 seconds and stops the calls', async () => {
    const { api, adapter } = await start();
    if (adapter === undefined) throw new Error('no e-mail adapter');
    // The breaker counts the failures of the last minute, and the case before this one (a provider that was down) leaves its own: with one of them still in the minute the 20th call is never made, because the
    // breaker opens at the 19th. The count starts from nothing here, as it does for a real account that was quiet.
    await rows('delete from machvon.channel_account_circuit where channel_account_id = $1', [ACCOUNT]);
    await rows("update machvon.delivery_attempt set failed_at = now() - interval '2 hours' where status = 'Failed' and failed_at > now() - interval '5 minutes'");
    // The provider fails every call (more refusals than there will be calls).
    adapter.enqueue(...Array.from({ length: 30 }, () => ({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'HTTP_503' }) as const));
    try {
      // The business commands (a unit is created here: the commands of the reports need a world this fixture does not have) are answered at once and none of them reaches the provider.
      const events: string[] = [];
      for (let n = 0; n < 20; n += 1) {
        const command = await createUnit(api);
        expect(command.status).toBeLessThan(300);
        events.push(await plantEvent(`Report ${n}`));
      }
      expect(adapter.requests).toHaveLength(0);
      // The claim is about the breaker, so the clock starts when the provider can first be called, not when the fixture began to make its twenty events (a slow runner needs a quarter of a minute for them alone).
      const started = Date.now();
      const circuit = async (): Promise<string | undefined> => (await rows<{ state: string }>('select state from machvon.channel_account_circuit where channel_account_id = $1', [ACCOUNT]))[0]?.state;
      await pump(async () => (await circuit()) === 'OPEN', 'the breaker of the account to open', 60_000);
      expect(Date.now() - started).toBeLessThan(30_000);
      // 20 failures opened it: 20 calls were made, one for each delivery, and each of them waits for a retry that is scheduled.
      expect(adapter.requests).toHaveLength(20);
      for (const eventId of events) {
        const attempts = await attemptsOf(eventId);
        expect(attempts.map((attempt) => [attempt.attempt_no, attempt.status, attempt.error_code])).toEqual([
          [1, 'Failed', 'HTTP_503'],
          [2, 'Queued', null],
        ]);
      }
      const [scheduled] = await rows<{ waiting: string }>("select count(*)::text as waiting from machvon.delivery_attempt where status = 'Queued' and attempt_no = 2 and next_retry_at > now()");
      expect(scheduled?.waiting).toBe('20');
      // With the breaker open, the retries that fall due are put back and the provider is not called again.
      await rows("update machvon.delivery_attempt set next_retry_at = now() where status = 'Queued'");
      for (let tick = 0; tick < 3; tick += 1) {
        timers.fire(TICK);
        await new Promise((wait) => setTimeout(wait, 150));
      }
      expect(adapter.requests).toHaveLength(20);
      expect(await circuit()).toBe('OPEN');
    } finally {
      // The account is left as the other tests expect it: a closed circuit and no send waiting.
      await rows('delete from machvon.channel_account_circuit where channel_account_id = $1', [ACCOUNT]);
      await rows("update machvon.delivery_attempt set status = 'Cancelled', error_code = 'TEST_CLEANUP' where status = 'Queued'");
      // The failures are over for the circuit, which counts those of the last minute.
      await rows("update machvon.delivery_attempt set failed_at = now() - interval '2 hours' where status = 'Failed' and failed_at > now() - interval '5 minutes'");
    }
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
    const forged = await receipt(api, eventBody('e-forged', message, 'DELIVERED'), { secret: FORGED_SECRET });
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
    // The Idempotency-Key header is not under the signature: whoever replays a signed receipt cannot make it a new event by writing another key.
    expect((await receipt(api, eventBody('e-delivered', message, 'DELIVERED'), { idempotencyKey: 'a-key-the-provider-never-signed' })).json).toEqual({ received: true, duplicate: true });
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

  it('AC-ST-OMNI-001-1 UAT-AC196: a webhook with one byte changed after it was signed is 401, one signed ten minutes ago is 401, and a valid one sent twice is 200 and 200 duplicate with one stored row', async () => {
    const { api } = await start();
    const count = async (key: string): Promise<number> => Number((await rows<{ n: string }>('select count(*)::text as n from machvon.integration_event_inbox where provider = $1 and event_key = $2', [PROVIDER, key]))[0]?.n);
    const body = eventBody('e-omni-196', 'msg-omni-196', 'DELIVERED');
    const tampered = await receipt(api, body, { tamper: true });
    expect([tampered.status, tampered.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    const old = await receipt(api, body, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect([old.status, old.json.code]).toEqual([401, 'REPLAY_WINDOW_EXCEEDED']);
    expect(await count('e-omni-196')).toBe(0);
    const first = await receipt(api, body);
    const second = await receipt(api, body);
    expect([first.status, first.json]).toEqual([200, { received: true, duplicate: false }]);
    expect([second.status, second.json]).toEqual([200, { received: true, duplicate: true }]);
    expect(await count('e-omni-196')).toBe(1);
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

  it('AC-ST-OMNI-004-1 UAT-AC196: a signed message that a person wrote to the account opens a conversation with a contact, once however often the provider sends it, and a stop word ends the consents', async () => {
    const { api } = await start();
    const inbound = (id: string, message: string, text: string): Record<string, unknown> => ({
      id,
      account: 'relay-1',
      type: 'message.inbound',
      at: new Date().toISOString(),
      inbound: { message, thread: 'thread-flow-1', from: 'Nguoi.Gui@Example.com', name: 'Người Gửi', text },
    });
    const conversations = (): Promise<Array<{ id: string; status: string; contact_id: string }>> => rows('select id, status, contact_id from machvon.conversation where external_thread_id = $1', ['thread-flow-1']);
    const first = await receipt(api, inbound('e-in-1', 'in-1', 'Tôi cần hỏi về hồ sơ'));
    expect([first.status, first.json]).toEqual([200, { received: true, duplicate: false }]);
    // The event is applied right after it is stored: the inbox says so and the conversation is there.
    expect((await rows<{ status: string }>('select status from machvon.integration_event_inbox where provider = $1 and event_key = $2', [PROVIDER, 'e-in-1']))[0]?.status).toBe('PROCESSED');
    const [opened] = await conversations();
    expect(opened?.status).toBe('New');
    expect((await rows<{ body_text: string; direction: string }>('select body_text, direction from machvon.channel_message where conversation_id = $1', [opened?.id]))).toEqual([{ body_text: 'Tôi cần hỏi về hồ sơ', direction: 'INBOUND' }]);
    // The provider sends the same event again, and the same message under another event: one message.
    expect((await receipt(api, inbound('e-in-1', 'in-1', 'Tôi cần hỏi về hồ sơ'))).json).toEqual({ received: true, duplicate: true });
    await receipt(api, inbound('e-in-1b', 'in-1', 'Tôi cần hỏi về hồ sơ'));
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.channel_message where conversation_id = $1', [opened?.id]))[0]?.n).toBe('1');
    expect((await rows<{ action: string }>("select action from machvon.audit_event where resource_id = $1 and action = 'conversation.opened'", [opened?.id])).length).toBe(1);
    // A tampered body is refused before anything is read.
    const forged = await receipt(api, inbound('e-in-2', 'in-2', 'x'), { secret: FORGED_SECRET });
    expect([forged.status, forged.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    // The person's address is verified by a document and a consent is taken; the word that withdraws it ends it.
    await rows("update machvon.contact_identity set status = 'Verified', verification_method = 'ADMIN_DOCUMENT', verified_at = now(), verified_by = $2 where contact_id = $1", [opened?.contact_id, memberId(RECIPIENT)]);
    await rows(
      `insert into machvon.contact_consent (tenant_id, id, contact_id, membership_id, channel, purpose, status, evidence_reference, effective_at, legal_basis, consent_text_version, capture_method)
       values ($1, gen_random_uuid(), $2, null, 'EMAIL', 'SUPPORT_CONVERSATION', 'Granted', 'proof', now(), 'CONSENT', 'v1', 'IN_APP')`,
      [TENANT_A, opened?.contact_id],
    );
    await receipt(api, inbound('e-in-3', 'in-3', 'STOP'));
    expect((await rows<{ status: string }>('select status from machvon.contact_consent where contact_id = $1', [opened?.contact_id]))[0]?.status).toBe('Withdrawn');
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'contact_consent.withdrawn' and safe_diff ->> 'by' = 'stop_keyword'"))[0]?.n).toBe('1');
    expect((await conversations()).length).toBe(1);
  }, TEST_TIMEOUT);

  it('AC-ST-OMNI-004-2 UAT-AC138: a message event that failed because the account was not Active is replayed to PROCESSED once, and a second replay is 409 INBOX_STATE_INVALID', async () => {
    const { api } = await start();
    const worker = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
    const body = Buffer.from(JSON.stringify({ id: 'e-replay-1', account: 'relay-1', type: 'message.inbound', at: new Date().toISOString(), inbound: { message: 'replay-1', thread: 'thread-replay', from: 'replay@example.com', name: 'Replay', text: 'Xin chào' } }));
    const reference = await api.app.get<WebhookPayloadStore>(WEBHOOK_PAYLOADS, { strict: false }).put(worker, PROVIDER, 'e-replay-1', body);
    const [row] = await rows<{ id: string }>(
      `insert into machvon.integration_event_inbox (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id, provider_event_type, channel_account_id)
       values ($1, gen_random_uuid(), $2, 'e-replay-1', repeat('d', 64), $3, now(), 'RECEIVED', 'k1', 'message.inbound', $4) returning id`,
      [TENANT_A, PROVIDER, reference, ACCOUNT],
    );
    // The provider's credential expired between the receipt and the processing: the message waits as a failure for an operator.
    await rows("update machvon.channel_account set status = 'CredentialExpired' where id = $1", [ACCOUNT]);
    await api.app.get<IntegrationInboxProcessor>(ADM_INBOX_PROCESSOR, { strict: false }).processOne(worker, row?.id as string);
    const [failed] = await rows<{ status: string; error_code: string; version: string }>('select status, error_code, version::text as version from machvon.integration_event_inbox where id = $1', [row?.id]);
    expect(failed).toMatchObject({ status: 'FAILED', error_code: 'CHANNEL_ACCOUNT_STATE_INVALID' });
    expect((await rows('select 1 from machvon.conversation where external_thread_id = $1', ['thread-replay'])).length).toBe(0);
    await rows("update machvon.channel_account set status = 'Active' where id = $1", [ACCOUNT]);
    const replay = (version: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${api.port}/integration-inbox/${row?.id}/replay`, {
        method: 'POST',
        headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'if-match': `"${version}"` },
        body: JSON.stringify({ reason: 'The credential of the account was renewed.' }),
      });
    expect((await replay(failed?.version as string)).status).toBe(202);
    await until(async () => (await rows<{ status: string }>('select status from machvon.integration_event_inbox where id = $1', [row?.id]))[0]?.status === 'PROCESSED', 'the replayed message to be processed');
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.channel_message m join machvon.conversation c on c.id = m.conversation_id where c.external_thread_id = $1', ['thread-replay']))[0]?.n).toBe('1');
    const [done] = await rows<{ version: string }>('select version::text as version from machvon.integration_event_inbox where id = $1', [row?.id]);
    const again = await replay(done?.version as string);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('INBOX_STATE_INVALID');
  }, TEST_TIMEOUT);

  it('AC-ST-OMNI-001-3 UAT-PLAN-50: once the supervisor disables the account, a webhook for it is 404 CHANNEL_ACCOUNT_UNKNOWN', async () => {
    const { api } = await start();
    const closed = await fetch(`http://127.0.0.1:${api.port}/channel-accounts/${ACCOUNT}/disable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'if-match': '"1"' },
      body: JSON.stringify({ reason: 'The relay account is closed for good.' }),
    });
    expect(closed.status).toBe(200);
    const before = Number((await rows<{ n: string }>('select count(*)::text as n from machvon.integration_event_inbox where provider = $1', [PROVIDER]))[0]?.n);
    const refused = await receipt(api, eventBody('e-after-disable', 'msg-after-disable', 'DELIVERED'));
    expect([refused.status, refused.json.code]).toEqual([404, 'CHANNEL_ACCOUNT_UNKNOWN']);
    expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.integration_event_inbox where provider = $1', [PROVIDER]))[0]?.n)).toBe(before);
  }, TEST_TIMEOUT);
});
