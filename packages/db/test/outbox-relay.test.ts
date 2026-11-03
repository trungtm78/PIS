import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { verifyTenantContext } from '@machvon/kernel';
import type { AlertSink, MetricsSink, TenantContext } from '@machvon/kernel';
import { WORKER_MEMBERSHIP_ID } from '../src/consumer-inbox';
import { Client, Pool } from 'pg';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import { enqueueOutbox } from '../src/outbox';
import { OutboxRelay } from '../src/outbox-relay';
import type { OutboxDelivery, OutboxRelayOptions } from '../src/outbox-relay';
import { TenantDatabase } from '../src/tenant-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000f1';
const AGGREGATE = '00000000-0000-4000-8000-0000000000a1';
const CORRELATION = '00000000-0000-4000-8000-0000000000b1';

function context(tenantId: string): TenantContext {
  return { tenantId, membershipId: MEMBERSHIP, scopeVersion: 1 };
}

class RecordingMetrics implements MetricsSink {
  readonly counters = new Map<string, number>();
  readonly gauges = new Map<string, number>();

  increment(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }
}

class RecordingAlerts implements AlertSink {
  readonly raised: Array<{ code: string; context: Record<string, unknown> }> = [];

  raise(code: string, alertContext: Record<string, unknown>): void {
    this.raised.push({ code, context: alertContext });
  }
}

class PublisherDown extends Error {}

const SIGNING_KEY = randomBytes(32);

/** The relay under test: every instance signs deliveries with the same test key unless a test says otherwise. */
class TestRelay extends OutboxRelay {
  constructor(pool: ConstructorParameters<typeof OutboxRelay>[0], publish: ConstructorParameters<typeof OutboxRelay>[1], options: Partial<OutboxRelayOptions> = {}) {
    super(pool, publish, { signingKey: SIGNING_KEY, ...options });
  }
}

describe('OutboxRelay', () => {
  let database: TestDatabase;
  let appPool: Pool;
  let tenants: TenantDatabase;
  const relayPools: Pool[] = [];

  function relayPool(): Pool {
    const pool = new Pool({ connectionString: database.urlFor('machvon_outbox_relay'), max: 2 });
    pool.on('error', () => undefined);
    relayPools.push(pool);
    return pool;
  }

  async function admin<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: database.adminUrl });
    await client.connect();
    try {
      return (await client.query<T>(text, params)).rows;
    } finally {
      await client.end();
    }
  }

  async function enqueue(tenantId: string, count: number, prefix = 'e'): Promise<string[]> {
    const ids: string[] = [];
    for (let n = 1; n <= count; n += 1) {
      const { id } = await tenants.withTenant(context(tenantId), (tx) =>
        enqueueOutbox(tx, {
          aggregateType: 'contract',
          aggregateId: AGGREGATE,
          aggregateVersion: n,
          type: 'ContractSubmitted',
          schemaVersion: 1,
          payload: { n },
          eventKey: `${prefix}-${n}`,
          correlationId: CORRELATION,
        }),
      );
      ids.push(id);
    }
    return ids;
  }

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    appPool = new Pool({ connectionString: database.urlFor('machvon_app'), max: 4 });
    tenants = new TenantDatabase(appPool);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(relayPools.map((pool) => pool.end()));
    if (appPool) await appPool.end();
    if (database) await database.stop();
  }, 60_000);

  beforeEach(async () => {
    await admin('delete from machvon.outbox_event');
  });

  it('delivers 250 events in batches of 100, oldest first, each exactly once', async () => {
    const ids = await enqueue(TENANT_A, 250);
    const delivered: string[] = [];
    const relay = new TestRelay(relayPool(), async (delivery) => {
      delivered.push(delivery.id);
    });
    const first = await relay.runOnce();
    expect(first).toEqual({ published: 100, retried: 0, dead: 0 });
    expect(delivered).toEqual(ids.slice(0, 100));
    expect(await relay.runOnce()).toEqual({ published: 100, retried: 0, dead: 0 });
    expect(await relay.runOnce()).toEqual({ published: 50, retried: 0, dead: 0 });
    expect(await relay.runOnce()).toEqual({ published: 0, retried: 0, dead: 0 });
    expect(delivered).toEqual(ids);
    const rows = await admin<{ status: string; published_at: Date | null }>('select status, published_at from machvon.outbox_event');
    expect(rows.every((row) => row.status === 'PUBLISHED' && row.published_at !== null)).toBe(true);
  }, 120_000);

  it('attaches a signed worker context for the tenant of each event', async () => {
    await enqueue(TENANT_A, 1, 'a');
    await enqueue(TENANT_B, 1, 'b');
    const seen: OutboxDelivery[] = [];
    await new TestRelay(relayPool(), async (delivery) => {
      seen.push(delivery);
    }).runOnce();
    expect(seen).toHaveLength(2);
    for (const delivery of seen) {
      expect(verifyTenantContext(delivery.tenantContext, SIGNING_KEY)).toEqual({ tenantId: delivery.tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 });
      expect(() => verifyTenantContext(delivery.tenantContext, randomBytes(32))).toThrow();
    }
  });

  it('hands the consumer the full delivery including the tenant of each event', async () => {
    await enqueue(TENANT_A, 1, 'a');
    await enqueue(TENANT_B, 1, 'b');
    const seen: OutboxDelivery[] = [];
    await new TestRelay(relayPool(), async (delivery) => {
      seen.push(delivery);
    }).runOnce();
    expect(seen.map((d) => d.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
    expect(seen[0]).toMatchObject({
      type: 'ContractSubmitted',
      schemaVersion: 1,
      aggregateType: 'contract',
      aggregateId: AGGREGATE,
      aggregateVersion: 1,
      correlationId: CORRELATION,
      attempts: 0,
    });
  });

  it('never lets two concurrent relays claim the same event', async () => {
    await enqueue(TENANT_A, 60);
    const counts = new Map<string, number>();
    const publish = async (delivery: OutboxDelivery): Promise<void> => {
      counts.set(delivery.id, (counts.get(delivery.id) ?? 0) + 1);
      await new Promise((done) => setTimeout(done, 5));
    };
    const relays = [new TestRelay(relayPool(), publish, { batchSize: 10 }), new TestRelay(relayPool(), publish, { batchSize: 10 })];
    for (let round = 0; round < 6; round += 1) await Promise.all(relays.map((relay) => relay.runOnce()));
    expect(counts.size).toBe(60);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  }, 120_000);

  it('schedules a retry after a failed publish and stores only the error class', async () => {
    await enqueue(TENANT_A, 1);
    const metrics = new RecordingMetrics();
    const relay = new TestRelay(
      relayPool(),
      async () => {
        throw new PublisherDown('secret connection string');
      },
      { metrics },
    );
    expect(await relay.runOnce()).toEqual({ published: 0, retried: 1, dead: 0 });
    const [row] = await admin<{ attempts: number; status: string; last_error: string; soon: boolean; later: boolean }>(
      `select attempts, status, last_error, next_attempt_at > now() as soon, next_attempt_at < now() + interval '5 seconds' as later
       from machvon.outbox_event`,
    );
    expect(row).toEqual({ attempts: 1, status: 'PENDING', last_error: 'PublisherDown', soon: true, later: true });
    expect(await relay.runOnce()).toEqual({ published: 0, retried: 0, dead: 0 });
    expect(metrics.counters.get('outbox_retried_total')).toBe(1);
  });

  it('schedules the retry from the moment of the failure, not from the start of a slow batch', async () => {
    await enqueue(TENANT_A, 1);
    let failedAt = 0;
    const relay = new TestRelay(relayPool(), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      failedAt = Date.now();
      throw new PublisherDown('slow broker');
    });
    await relay.runOnce();
    const [row] = await admin<{ next_ms: string }>('select (extract(epoch from next_attempt_at) * 1000)::bigint::text as next_ms from machvon.outbox_event');
    // First retry is due one second after the failure; start-of-transaction time would put it 500 ms before the failure.
    expect(Number(row?.next_ms) - failedAt).toBeGreaterThan(900);
  }, 30_000);

  it('uses exponential backoff and honours the delay of a later attempt', async () => {
    await enqueue(TENANT_A, 1);
    await admin('update machvon.outbox_event set attempts = 10');
    const relay = new TestRelay(relayPool(), async () => {
      throw new PublisherDown('down');
    });
    await relay.runOnce();
    const [row] = await admin<{ attempts: number; seconds: number }>(
      'select attempts, extract(epoch from next_attempt_at - now())::float8 as seconds from machvon.outbox_event',
    );
    expect(row?.attempts).toBe(11);
    expect(row?.seconds).toBeGreaterThan(590);
    expect(row?.seconds).toBeLessThanOrEqual(600);
  });

  it('marks the event DEAD on the 20th failure (AC-ST-KERNEL-022-3)', async () => {
    await enqueue(TENANT_A, 1);
    await admin('update machvon.outbox_event set attempts = 19');
    const metrics = new RecordingMetrics();
    const alerts = new RecordingAlerts();
    const relay = new TestRelay(
      relayPool(),
      async () => {
        throw new PublisherDown('down');
      },
      { metrics, alerts },
    );
    expect(await relay.runOnce()).toEqual({ published: 0, retried: 0, dead: 1 });
    const [row] = await admin<{ attempts: number; status: string }>('select attempts, status from machvon.outbox_event');
    expect(row).toEqual({ attempts: 20, status: 'DEAD' });
    expect(metrics.counters.get('outbox_dead_total')).toBe(1);
    expect(alerts.raised.filter((alert) => alert.code === 'OUTBOX_EVENT_DEAD')).toEqual([
      { code: 'OUTBOX_EVENT_DEAD', context: { eventId: expect.any(String), tenantId: TENANT_A, type: 'ContractSubmitted', attempts: 20 } },
    ]);
    expect(await relay.runOnce()).toEqual({ published: 0, retried: 0, dead: 0 });
    expect(alerts.raised.filter((alert) => alert.code === 'OUTBOX_EVENT_DEAD')).toHaveLength(1);
  });

  it.each([
    [301, 1],
    [299, 0],
  ])('with the oldest pending event %i seconds old raises the OUTBOX_LAG alert %i time(s)', async (age, alertCount) => {
    await enqueue(TENANT_A, 1);
    await admin('update machvon.outbox_event set created_at = now() - make_interval(secs => $1)', [age]);
    const metrics = new RecordingMetrics();
    const alerts = new RecordingAlerts();
    const relay = new TestRelay(
      relayPool(),
      async () => {
        throw new PublisherDown('down');
      },
      { metrics, alerts },
    );
    await relay.runOnce();
    expect(alerts.raised.filter((alert) => alert.code === 'OUTBOX_LAG')).toHaveLength(alertCount);
    expect(metrics.gauges.get('outbox_oldest_pending_seconds')).toBeGreaterThanOrEqual(age);
    expect(await relay.oldestPendingSeconds()).toBeGreaterThanOrEqual(age);
  });

  it('refuses a signing key shorter than 32 bytes when it is created', () => {
    expect(() => new OutboxRelay(relayPool(), async () => undefined, { signingKey: randomBytes(31) })).toThrow('at least 32 bytes');
  });

  it('reports no lag when nothing is pending', async () => {
    expect(await new TestRelay(relayPool(), async () => undefined).oldestPendingSeconds()).toBe(0);
  });

  it('keeps events PENDING and rejects when the relay connection is lost mid-batch', async () => {
    await enqueue(TENANT_A, 5);
    let calls = 0;
    const relay = new TestRelay(relayPool(), async () => {
      calls += 1;
      if (calls === 3) {
        await admin(
          "select pg_terminate_backend(pid) from pg_stat_activity where usename = 'machvon_outbox_relay' and datname = current_database() and pid <> pg_backend_pid()",
        );
      }
    });
    await expect(relay.runOnce()).rejects.toThrow();
    const rows = await admin<{ status: string }>('select status from machvon.outbox_event');
    expect(rows.map((row) => row.status)).toEqual(Array(5).fill('PENDING'));
    // The pool discarded the dead connection, so the relay works again.
    expect((await relay.runOnce()).published).toBe(5);
  });

  it('AC-ST-KERNEL-014-1 (UAT-NFR-OPERABILITY-03) delivers 100 events that release N wrote, through the relay of release N-1, after the rollback', async () => {
    // Release N writes 100 events of a version of its own, and its relay dies in the middle of the first batch: nothing is lost and nothing is half-delivered.
    const ids = await enqueue(TENANT_A, 100, 'n');
    await admin("update machvon.outbox_event set schema_version = 2, payload = payload || '{\"added_by_n\": true}'::jsonb");
    let published = 0;
    const releaseN = new TestRelay(relayPool(), async () => {
      published += 1;
      if (published === 40) {
        await admin(
          "select pg_terminate_backend(pid) from pg_stat_activity where usename = 'machvon_outbox_relay' and datname = current_database() and pid <> pg_backend_pid()",
        );
      }
    });
    await expect(releaseN.runOnce()).rejects.toThrow();
    expect((await admin<{ n: string }>("select count(*) as n from machvon.outbox_event where status = 'PENDING'"))[0]?.n).toBe('100');
    // The rollback starts release N-1: a relay of its own, on a connection of its own, which only reads the fields of the event that N-1 knows.
    const delivered = new Map<string, number>();
    const releaseNMinus1 = new TestRelay(relayPool(), async (delivery) => {
      const { id, type, aggregateId, payload } = delivery;
      expect({ type, aggregateId, n: typeof payload.n }).toEqual({ type: 'ContractSubmitted', aggregateId: AGGREGATE, n: 'number' });
      delivered.set(id, (delivered.get(id) ?? 0) + 1);
    });
    expect(await releaseNMinus1.runOnce()).toEqual({ published: 100, retried: 0, dead: 0 });
    expect([...delivered.keys()].sort()).toEqual([...ids].sort());
    expect([...delivered.values()].every((count) => count === 1)).toBe(true);
    const rows = await admin<{ status: string; schema_version: number; added: boolean }>("select status, schema_version, payload ? 'added_by_n' as added from machvon.outbox_event");
    expect(rows).toHaveLength(100);
    expect(rows.every((row) => row.status === 'PUBLISHED' && row.schema_version === 2 && row.added)).toBe(true);
  }, 120_000);

  it('gives the relay role no way to insert events or read business tables', async () => {
    const pool = relayPool();
    await expect(pool.query("insert into machvon.outbox_event (tenant_id, id) values ($1, $1)", [TENANT_A])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('select 1 from machvon.organization_unit')).rejects.toMatchObject({ code: '42501' });
  });
});
