import { resolve } from 'node:path';
import type { AlertSink, MetricsSink, TenantContext } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { AuditWriter } from '../../src/audit-writer';
import type { AuditEntry } from '../../src/audit-writer';
import { startMigratedTestDatabase } from '../../src/migrated-test-database';
import { TenantDatabase } from '../../src/tenant-database';
import type { TestDatabase } from '../../src/test-database';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const TENANT_A = '00000000-0000-4000-8000-00000000000a';
export const TENANT_B = '00000000-0000-4000-8000-00000000000b';
export const MEMBERSHIP = '00000000-0000-4000-8000-0000000000f1';
export const RESOURCE = '00000000-0000-4000-8000-0000000000e1';
export const CORRELATION = '00000000-0000-4000-8000-0000000000c1';

export function contextOf(tenantId: string): TenantContext {
  return { tenantId, membershipId: MEMBERSHIP, scopeVersion: 1 };
}

export function entryOf(action: string, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    action,
    resourceType: 'widget',
    resourceId: RESOURCE,
    diff: { name: 'Đà Nẵng' },
    correlationId: CORRELATION,
    requestId: CORRELATION,
    ...overrides,
  };
}

export interface AuditHarness {
  database: TestDatabase;
  pool: Pool;
  tenantDatabase: TenantDatabase;
  writer: AuditWriter;
  stop(): Promise<void>;
}

/** Embedded PostgreSQL with every migration, plus a pool for the application role. */
export async function startAuditHarness(): Promise<AuditHarness> {
  const database = await startMigratedTestDatabase(REPO_ROOT);
  const pool = new Pool({ connectionString: database.urlFor('machvon_app'), max: 8 });
  pool.on('error', () => undefined); // a backend the test ends on purpose is reported by the pool as an error event
  const tenantDatabase = new TenantDatabase(pool);
  return {
    database,
    pool,
    tenantDatabase,
    writer: new AuditWriter(tenantDatabase),
    stop: async () => {
      await pool.end();
      await database.stop();
    },
  };
}

/**
 * Appends `count` success rows in one transaction. `burnAfter` lists 1-based positions after which one
 * audit_event_seq value is consumed without a row, leaving a free seq for a tamper insert.
 * Returns the seq of every row in order and of every burnt value.
 */
export async function appendEntries(
  harness: AuditHarness,
  tenantId: string,
  count: number,
  burnAfter: readonly number[] = [],
): Promise<{ seqs: number[]; burnt: number[] }> {
  const burnt: number[] = [];
  const seqs = await harness.tenantDatabase.withTenant(contextOf(tenantId), async (tx) => {
    for (let index = 1; index <= count; index += 1) {
      await harness.writer.recordInTx(tx, MEMBERSHIP, entryOf(`action-${index}`, { diff: { index } }));
      if (burnAfter.includes(index)) {
        const [row] = await tx.query<{ n: string }>("select nextval('machvon.audit_event_seq') as n");
        burnt.push(Number(row?.n));
      }
    }
    const rows = await tx.query<{ seq: string }>('select seq from machvon.audit_event order by seq');
    return rows.map((row) => Number(row.seq));
  });
  return { seqs, burnt };
}

/** A session of the owner role (the only role that may edit audit tables) bound to one tenant. */
export async function ownerSession(harness: AuditHarness, tenantId: string): Promise<Client> {
  const client = new Client({ connectionString: harness.database.urlFor('machvon_owner') });
  await client.connect();
  await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
  return client;
}

export interface Recorded {
  metrics: Array<{ name: string; labels?: Record<string, string> }>;
  alerts: Array<{ code: string; context: Record<string, unknown> }>;
  sinks: { metrics: MetricsSink; alerts: AlertSink };
}

export function recorder(): Recorded {
  const recorded: Recorded = {
    metrics: [],
    alerts: [],
    sinks: {
      metrics: {
        increment: (name, labels) => {
          recorded.metrics.push({ name, labels });
        },
        gauge: () => undefined,
      },
      alerts: {
        raise: (code, context) => {
          recorded.alerts.push({ code, context });
        },
      },
    },
  };
  return recorded;
}
