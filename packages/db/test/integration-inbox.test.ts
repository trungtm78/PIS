import { DomainError } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { INBOX_DEAD_ALERT, INBOX_FAILED_METRIC, INBOX_PROCESSED_METRIC, INBOX_WAITING_GAUGE, InboxHandlerRegistry, IntegrationInboxProcessor } from '../src/integration-inbox-processor';
import type { InboxDelivery, InboxHandler } from '../src/integration-inbox-processor';
import { IntegrationInboxStore } from '../src/integration-inbox-store';
import type { InboxStatus } from '../src/integration-inbox-store';
import { INBOX_MAX_ATTEMPTS } from '../src/provider-callback-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new IntegrationInboxStore();
const ACTOR = 1;
const WORKER = '00000000-0000-4000-8000-000000000000';

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const ctx = (tenant = TENANT_A): TenantContext => ({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 });

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return { code: e.code ?? '', status: e.status ?? 0 };
  }
  throw new Error('expected a refusal');
}

let counter = 0;
interface Seed {
  provider?: string;
  status?: InboxStatus;
  attempts?: number;
  nextAttempt?: string | null;
  receivedAt?: string;
  reference?: string | null;
  errorCode?: string | null;
  tenant?: string;
}
async function seed(options: Seed = {}): Promise<string> {
  counter += 1;
  const reference = options.reference === undefined ? `tenants/${options.tenant ?? TENANT_A}/webhook/payload-${counter}` : options.reference;
  const rows = await owner<{ id: string }>(
    `insert into machvon.integration_event_inbox
       (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id, attempts, next_attempt_at, error_code, provider_event_type, payload_purged_at)
     values ($1, gen_random_uuid(), $2, $3, repeat('b', 64), $4, $5, $6, 'k1', $7, $8, $9, 'message.created', case when $4::text is null then now() end)
     returning id`,
    [options.tenant ?? TENANT_A, options.provider ?? 'TEST_PROVIDER', `event-${counter}`, reference, options.receivedAt ?? '2026-10-01T00:00:00Z', options.status ?? 'FAILED', options.attempts ?? 3, options.nextAttempt ?? null, options.errorCode ?? null],
    options.tenant ?? TENANT_A,
  );
  return (rows[0] as { id: string }).id;
}
const statusOf = async (id: string): Promise<{ status: string; attempts: number; error_code: string | null; version: string; wait: number | null; processed: boolean }> =>
  (
    await owner<{ status: string; attempts: number; error_code: string | null; version: string; wait: number | null; processed: boolean }>(
      "select status, attempts, error_code, version::text as version, extract(epoch from (next_attempt_at - now()))::float8 as wait, (processed_at is not null) as processed from machvon.integration_event_inbox where id = $1",
      [id],
    )
  )[0] as never;

describe('the integration inbox: replay and worker (ST-ADM-018)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, ACTOR, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('IntegrationInboxStore', () => {
    it('takes a failed or a dead event up again: received, no attempts, due now, with the replay counted and signed', async () => {
      const failed = await seed({ status: 'FAILED', attempts: 4, errorCode: 'PROCESSING_FAILED', nextAttempt: '2099-01-01T00:00:00Z' });
      const before = await as((tx) => store.find(tx, failed));
      expect(before).toMatchObject({ status: 'FAILED', attempts: 4, errorCode: 'PROCESSING_FAILED', replayCount: 0, lastReplayedAt: null, payloadKept: true });
      const done = await as((tx) => store.requeue(tx, failed, before?.version as number, memberId(ACTOR)));
      expect(done.before.status).toBe('FAILED');
      expect(done.row).toMatchObject({ status: 'RECEIVED', attempts: 0, errorCode: null, replayCount: 1, version: (before?.version as number) + 1 });
      expect(done.row.lastReplayedAt).not.toBeNull();
      expect((await statusOf(failed)).wait).toBeLessThanOrEqual(0);
      expect((await owner<{ last_replayed_by: string }>('select last_replayed_by from machvon.integration_event_inbox where id = $1', [failed]))[0]?.last_replayed_by).toBe(memberId(ACTOR));

      const dead = await seed({ status: 'DEAD', attempts: INBOX_MAX_ATTEMPTS });
      expect((await as((tx) => store.requeue(tx, dead, 1, memberId(ACTOR)))).row).toMatchObject({ status: 'RECEIVED', attempts: 0 });
    });

    it('answers 409 INBOX_STATE_INVALID to an event that is received, processing or processed, whatever version the caller sends, so a second replay is told the state (AC-ST-ADM-018-2, UAT-AC138)', async () => {
      const failed = await seed({ status: 'FAILED' });
      await as((tx) => store.requeue(tx, failed, 1, memberId(ACTOR)));
      expect(await refusal(as((tx) => store.requeue(tx, failed, 1, memberId(ACTOR))))).toEqual({ code: 'INBOX_STATE_INVALID', status: 409 });
      expect(await refusal(as((tx) => store.requeue(tx, failed, 2, memberId(ACTOR))))).toEqual({ code: 'INBOX_STATE_INVALID', status: 409 });
      for (const status of ['PROCESSED', 'PROCESSING', 'RECEIVED'] as const) {
        const other = await seed({ status, attempts: 0 });
        expect(await refusal(as((tx) => store.requeue(tx, other, 1, memberId(ACTOR))))).toEqual({ code: 'INBOX_STATE_INVALID', status: 409 });
      }
    });

    it('cannot replay what is gone: an event whose payload was purged', async () => {
      const gone = await seed({ status: 'DEAD', reference: null });
      expect(await as((tx) => store.find(tx, gone))).toMatchObject({ payloadKept: false });
      expect(await refusal(as((tx) => store.requeue(tx, gone, 1, memberId(ACTOR))))).toEqual({ code: 'INBOX_STATE_INVALID', status: 409 });
    });

    it('answers 409 VERSION_CONFLICT to a stale version of a failed event, and 404 to an event that is not there or of another tenant', async () => {
      const failed = await seed({ status: 'FAILED' });
      await owner("update machvon.integration_event_inbox set error_code = 'CHANGED' where id = $1", [failed]);
      expect(await refusal(as((tx) => store.requeue(tx, failed, 1, memberId(ACTOR))))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => store.requeue(tx, '00000000-0000-4000-8000-0000000000ff', 1, memberId(ACTOR))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.requeue(tx, failed, 2, memberId(ACTOR)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await as((tx) => store.find(tx, failed), TENANT_B)).toBeUndefined();
    });

    it('moves the version on every change by any writer, and keeps what identifies and proves an event for good', async () => {
      const id = await seed({ status: 'RECEIVED', attempts: 0 });
      expect((await statusOf(id)).version).toBe('1');
      await owner("update machvon.integration_event_inbox set attempts = 1 where id = $1", [id]);
      await owner("update machvon.integration_event_inbox set attempts = 2, version = 99 where id = $1", [id]);
      expect((await statusOf(id)).version).toBe('3');
      for (const change of ["provider = 'OTHER'", "event_key = 'other'", "payload_hash = repeat('c', 64)", "received_at = now()", "signature_key_id = 'k2'", "provider_event_type = 'x'", "provider_timestamp = now()", "payload_reference = 'tenants/other/key/1'"]) {
        await expect(owner(`update machvon.integration_event_inbox set ${change} where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
      }
      await owner("update machvon.integration_event_inbox set payload_reference = null, payload_purged_at = now() where id = $1", [id]);
      expect((await statusOf(id)).version).toBe('4');
    });

    it('lists the events newest first with a filter by status or provider, without ever showing the payload, and pages without losing one', async () => {
      const marker = 'tenants/00000000-0000-4000-8000-00000000000a/webhook/SECRET-PAYLOAD-MARKER';
      await seed({ status: 'DEAD', provider: 'LIST_PROVIDER', reference: marker, receivedAt: '2026-10-02T00:00:00Z' });
      for (let index = 0; index < 5; index += 1) await seed({ status: 'FAILED', provider: 'LIST_PROVIDER', receivedAt: '2026-10-03T00:00:00Z' });
      const failed = await as((tx) => store.list(tx, { status: 'FAILED', provider: 'LIST_PROVIDER' }, { limit: 50, after: undefined }));
      expect(failed).toHaveLength(5);
      const dead = await as((tx) => store.list(tx, { status: 'DEAD', provider: 'LIST_PROVIDER' }, { limit: 50, after: undefined }));
      expect(dead).toHaveLength(1);
      expect(JSON.stringify(dead)).not.toContain('SECRET-PAYLOAD-MARKER');
      expect(dead[0]).not.toHaveProperty('payloadReference');
      expect(dead[0]).toMatchObject({ payloadKept: true, provider: 'LIST_PROVIDER', status: 'DEAD' });

      const all = await as((tx) => store.list(tx, { provider: 'LIST_PROVIDER' }, { limit: 50, after: undefined }));
      expect(all.map((row) => row.status)).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED', 'FAILED', 'DEAD']);
      const seen: string[] = [];
      let after: { code: string; id: string } | undefined;
      for (let page = 0; page < 10; page += 1) {
        const rows = await as((tx) => store.list(tx, { provider: 'LIST_PROVIDER' }, { limit: 2, after }));
        seen.push(...rows.map((row) => row.id));
        const last = rows[rows.length - 1];
        if (rows.length < 2 || last === undefined) break;
        after = { code: last.cursorKey, id: last.id };
      }
      expect(seen).toEqual(all.map((row) => row.id));
      expect(await refusal(as((tx) => store.list(tx, {}, { limit: 5, after: { code: 'junk', id: 'x' } })))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
      expect(await refusal(as((tx) => store.list(tx, { status: 'WRONG' as InboxStatus }, { limit: 5, after: undefined })))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
      expect(await as((tx) => store.list(tx, { provider: 'LIST_PROVIDER' }, { limit: 50, after: undefined }), TENANT_B)).toEqual([]);
    });
  });

  describe('IntegrationInboxProcessor', () => {
    let registry: InboxHandlerRegistry;
    let alerts: Array<{ code: string; context: Record<string, unknown> }>;
    let metrics: Array<{ name: string; value?: number; labels?: Record<string, string> }>;
    const processor = (batch?: number): IntegrationInboxProcessor =>
      new IntegrationInboxProcessor(harness.tenants, registry, {
        ...(batch === undefined ? {} : { batch }),
        alerts: { raise: (code, context) => void alerts.push({ code, context }) },
        metrics: {
          increment: (name, labels) => void metrics.push({ name, ...(labels === undefined ? {} : { labels }) }),
          gauge: (name, value, labels) => void metrics.push({ name, value, ...(labels === undefined ? {} : { labels }) }),
        },
      });

    beforeEach(async () => {
      registry = new InboxHandlerRegistry();
      alerts = [];
      metrics = [];
      await owner("delete from machvon.integration_event_inbox where provider like 'PROC_%' or provider = 'TEST_PROVIDER'");
      await owner("delete from machvon.integration_cursor where connector_code = 'HANDLER_EFFECT'");
    });

    const insertEffect = (tx: TenantTx) =>
      tx.query("insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'HANDLER_EFFECT', gen_random_uuid()::text, '{}', '1', 'MOCK', 'ACTIVE')");
    const effects = async (): Promise<number> => (await owner<{ n: number }>("select count(*)::int as n from machvon.integration_cursor where connector_code = 'HANDLER_EFFECT'"))[0]?.n as number;

    it('keeps one adapter per provider and lists the providers it serves', () => {
      const handler: InboxHandler = () => Promise.resolve();
      registry.register('B', handler);
      registry.register('A', handler);
      expect(registry.providers()).toEqual(['A', 'B']);
      expect(registry.get('A')).toBe(handler);
      expect(registry.get('C')).toBeUndefined();
      expect(() => registry.register('A', handler)).toThrow(/already has an inbox handler/);
    });

    it('processes a replayed event: the adapter runs, the work and the PROCESSED mark commit together, and a second replay is refused (AC-ST-ADM-018-2, UAT-AC138)', async () => {
      const calls: InboxDelivery[] = [];
      registry.register('PROC_OK', async (delivery, tx) => {
        calls.push(delivery);
        await insertEffect(tx);
      });
      const id = await seed({ provider: 'PROC_OK', status: 'FAILED', attempts: 3, errorCode: 'OLD' });
      const queued = await as((tx) => store.requeue(tx, id, 1, memberId(ACTOR)));
      expect(queued.row.status).toBe('RECEIVED');
      expect(await processor().processOne(ctx(), id)).toBe('PROCESSED');
      expect(await statusOf(id)).toMatchObject({ status: 'PROCESSED', attempts: 0, error_code: null, processed: true });
      expect(calls).toEqual([{ id, provider: 'PROC_OK', eventKey: expect.any(String), eventType: 'message.created', payloadReference: expect.stringContaining('payload-'), attempts: 0 }]);
      expect(await effects()).toBe(1);
      expect(await refusal(as((tx) => store.requeue(tx, id, queued.row.version, memberId(ACTOR))))).toEqual({ code: 'INBOX_STATE_INVALID', status: 409 });
      expect(await processor().processOne(ctx(), id)).toBe('SKIPPED');
      expect(calls).toHaveLength(1);
      expect(metrics).toContainEqual({ name: INBOX_PROCESSED_METRIC, labels: { tenant_id: TENANT_A, provider: 'PROC_OK' } });
    });

    it('undoes the work of an adapter that fails, records the attempt by code and never by message, and waits 1, 5 and then 30 minutes', async () => {
      registry.register('PROC_FAIL', async (_delivery, tx) => {
        await insertEffect(tx);
        throw new Error('connection to secret-host.internal refused for user hunter2');
      });
      const id = await seed({ provider: 'PROC_FAIL', status: 'RECEIVED', attempts: 0 });
      const waits: number[] = [];
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await owner("update machvon.integration_event_inbox set next_attempt_at = now() - interval '1 second' where id = $1", [id]);
        expect(await processor().processOne(ctx(), id)).toBe('FAILED');
        const state = await statusOf(id);
        expect(state).toMatchObject({ status: 'FAILED', attempts: attempt, error_code: 'HANDLER_FAILED' });
        waits.push(Math.round((state.wait as number) / 60));
      }
      expect(waits).toEqual([1, 5, 30, 30]);
      expect(await effects()).toBe(0);
      expect(JSON.stringify(await owner('select * from machvon.integration_event_inbox where id = $1', [id]))).not.toMatch(/hunter2|secret-host/);
      expect(metrics.filter((metric) => metric.name === INBOX_FAILED_METRIC)).toHaveLength(4);
    });

    it('records the code of a domain failure, and parks the event as DEAD with an alert after the tenth failure, then leaves it alone', async () => {
      registry.register('PROC_DEAD', () => Promise.reject(new DomainError('PROVIDER_REJECTED', 422)));
      const id = await seed({ provider: 'PROC_DEAD', status: 'FAILED', attempts: INBOX_MAX_ATTEMPTS - 1, nextAttempt: '2020-01-01T00:00:00Z' });
      expect(await processor().processOne(ctx(), id)).toBe('DEAD');
      expect(await statusOf(id)).toMatchObject({ status: 'DEAD', attempts: INBOX_MAX_ATTEMPTS, error_code: 'PROVIDER_REJECTED' });
      expect(alerts).toEqual([{ code: INBOX_DEAD_ALERT, context: { tenantId: TENANT_A, provider: 'PROC_DEAD', eventId: id } }]);
      expect(JSON.stringify(alerts)).not.toContain('payload-');
      expect(await processor().processOne(ctx(), id)).toBe('SKIPPED');
      expect((await processor().processDue(ctx())).dead).toBe(0);
      expect(alerts).toHaveLength(1);
    });

    it('takes up only what is due and has an adapter: not an event that waits, not a provider with no adapter, not a finished one, oldest first, a batch at a time', async () => {
      const order: string[] = [];
      registry.register('PROC_DUE', (delivery) => (order.push(delivery.eventKey), Promise.resolve()));
      const late = await seed({ provider: 'PROC_DUE', status: 'RECEIVED', attempts: 0, receivedAt: '2026-10-02T00:00:00Z' });
      const early = await seed({ provider: 'PROC_DUE', status: 'FAILED', attempts: 1, nextAttempt: '2020-01-01T00:00:00Z', receivedAt: '2026-10-01T00:00:00Z' });
      const waiting = await seed({ provider: 'PROC_DUE', status: 'FAILED', attempts: 1, nextAttempt: '2099-01-01T00:00:00Z' });
      const noAdapter = await seed({ provider: 'PROC_NONE', status: 'RECEIVED', attempts: 0 });
      const finished = await seed({ provider: 'PROC_DUE', status: 'PROCESSED', attempts: 0 });
      const purged = await seed({ provider: 'PROC_DUE', status: 'RECEIVED', attempts: 0, reference: null });
      const result = await processor(1).processDue(ctx());
      expect(result).toEqual({ processed: 1, failed: 0, dead: 0 });
      expect((await statusOf(early)).status).toBe('PROCESSED');
      expect((await statusOf(late)).status).toBe('RECEIVED');
      expect(await processor().processDue(ctx())).toEqual({ processed: 1, failed: 0, dead: 0 });
      for (const [id, status] of [[waiting, 'FAILED'], [noAdapter, 'RECEIVED'], [finished, 'PROCESSED'], [purged, 'RECEIVED']] as const) expect((await statusOf(id)).status).toBe(status);
      expect(order).toHaveLength(2);
      // The gauge counts what still waits in the tenant (RECEIVED and FAILED, whoever the provider): one less after each event that was processed.
      const waitingNow = metrics.filter((metric) => metric.name === INBOX_WAITING_GAUGE).map((metric) => metric.value as number);
      expect(waitingNow).toHaveLength(2);
      expect(waitingNow[1]).toBe((waitingNow[0] as number) - 1);
      expect(waitingNow[1]).toBeGreaterThanOrEqual(3);
    });

    it('does nothing for a tenant when no provider has an adapter', async () => {
      await seed({ provider: 'PROC_NONE', status: 'RECEIVED', attempts: 0 });
      expect(await processor().processDue(ctx())).toEqual({ processed: 0, failed: 0, dead: 0 });
      expect(metrics).toEqual([]);
    });

    it('processes each event once when two workers run at the same time', async () => {
      let calls = 0;
      registry.register('PROC_RACE', async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      const ids = [];
      for (let index = 0; index < 6; index += 1) ids.push(await seed({ provider: 'PROC_RACE', status: 'RECEIVED', attempts: 0 }));
      const [first, second] = await Promise.all([processor().processDue(ctx()), processor().processDue(ctx())]);
      expect(first.processed + second.processed).toBe(6);
      expect(calls).toBe(6);
      for (const id of ids) expect((await statusOf(id)).status).toBe('PROCESSED');
    });

    it('works on its own tenant only', async () => {
      registry.register('PROC_ISOLATED', () => Promise.resolve());
      const own = await seed({ provider: 'PROC_ISOLATED', status: 'RECEIVED', attempts: 0 });
      const foreign = await seed({ provider: 'PROC_ISOLATED', status: 'RECEIVED', attempts: 0, tenant: TENANT_B });
      expect(await processor().processDue(ctx())).toMatchObject({ processed: 1 });
      expect((await statusOf(own)).status).toBe('PROCESSED');
      expect(await processor().processOne(ctx(), foreign)).toBe('SKIPPED');
      expect((await owner<{ status: string }>('select status from machvon.integration_event_inbox where id = $1', [foreign], TENANT_B))[0]?.status).toBe('RECEIVED');
    });
  });
});
