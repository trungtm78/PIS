import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { LogCapacityJob } from '../src/log-capacity-job';
import type { LogArchiveSink } from '../src/log-capacity-job';
import { LogCapacityStore } from '../src/log-capacity-store';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new LogCapacityStore();
const WORKER = '00000000-0000-4000-8000-000000000000';
const NOW = new Date('2026-10-24T01:30:00.000Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const ctx: TenantContext = { tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 };

async function admin<R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    return (await client.query(sql, params)).rows as R[];
  } finally {
    await client.end();
  }
}

const sink = (): LogArchiveSink & { files: Map<string, Uint8Array> } => {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    storeGenerated: async (_tenant, kind, id, bytes) => {
      const key = `${kind}/${id}`;
      files.set(key, bytes);
      return key;
    },
  };
};

const delivery = (createdAt: string) =>
  admin(
    `insert into machvon.delivery_attempt (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id, created_at)
     values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'Delivered', 0, 'EMAIL', gen_random_uuid(), $2)`,
    [TENANT_A, createdAt],
  );
const rows = async (table: string): Promise<number> => Number((await admin<{ n: string }>(`select count(*)::text as n from machvon.${table} where tenant_id = $1`, [TENANT_A]))[0]?.n);
const cap = (recordClass: string, maxRows: number, version = 0) =>
  harness.tenants.withTenant(contextFor(TENANT_A, memberId(1)), (tx) => store.save(tx, memberId(1), { recordClass, maxRows, maxBytes: null, warnPct: 80, active: true, reason: 'capacity plan' }, version));

describe('LogCapacityJob (HT.06, ENT-4e)', () => {
  beforeAll(async () => {
    await harness.start();
  }, 180_000);
  afterAll(async () => {
    await harness.stop();
  }, 60_000);
  beforeEach(async () => {
    for (const table of ['log_archive_batch', 'log_capacity_reading', 'delivery_attempt', 'audit_event_detail', 'log_capacity_policy_event', 'log_capacity_policy']) await admin(`delete from machvon.${table}`);
  });

  it('archives the oldest eligible rows to a hashed file and removes exactly those, leaving the young ones', async () => {
    for (let n = 0; n < 12; n += 1) await delivery(daysAgo(800 + n));
    for (let n = 0; n < 4; n += 1) await delivery(daysAgo(10 + n));
    await cap('delivery_attempt', 10);
    const archives = sink();
    const result = await new LogCapacityJob(harness.tenants, { archives }).run(ctx, NOW);
    // 16 rows against a cap of 10: down to 90 percent of it, nine rows, so seven of the old ones go
    expect(result.archived.delivery_attempt).toBe(7);
    expect(await rows('delivery_attempt')).toBe(9);
    const [batch] = await admin<{ status: string; row_count: string; file_key: string; file_sha256: string }>("select status, row_count::text, file_key, file_sha256 from machvon.log_archive_batch where tenant_id = $1", [TENANT_A]);
    expect(batch).toMatchObject({ status: 'PURGED', row_count: '7' });
    expect(archives.files.get(batch?.file_key ?? '')?.length).toBeGreaterThan(0);
    expect(result.states.delivery_attempt).toBe('OK');
  });

  it('removes nothing that is younger than the retention rule, and says the cap is exceeded', async () => {
    for (let n = 0; n < 12; n += 1) await delivery(daysAgo(5 + n));
    await cap('delivery_attempt', 10);
    const result = await new LogCapacityJob(harness.tenants, { archives: sink() }).run(ctx, NOW);
    expect(await rows('delivery_attempt')).toBe(12);
    expect(result.exceeded).toContain('delivery_attempt');
    expect(await rows('log_archive_batch')).toBe(0);
  });

  it('never removes a row without an archive store', async () => {
    for (let n = 0; n < 12; n += 1) await delivery(daysAgo(800 + n));
    await cap('delivery_attempt', 10);
    await new LogCapacityJob(harness.tenants).run(ctx, NOW);
    expect(await rows('delivery_attempt')).toBe(12);
  });

  it('only measures the audit trail, however far over its cap', async () => {
    await cap('audit_event', 1);
    const before = await rows('audit_event');
    const result = await new LogCapacityJob(harness.tenants, { archives: sink() }).run(ctx, NOW);
    expect(await rows('audit_event')).toBeGreaterThanOrEqual(before);
    expect(result.archived.audit_event).toBeUndefined();
    expect(randomUUID()).toBeTruthy();
  });

  it('refuses a row cap below the rows the retention rule protects', async () => {
    for (let n = 0; n < 6; n += 1) await delivery(daysAgo(5 + n));
    await new LogCapacityJob(harness.tenants).run(ctx, NOW);
    await expect(cap('delivery_attempt', 3)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
