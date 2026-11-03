import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { ApprovalEffects } from '../../src/approval-store';
import { ControlDatabase } from '../../src/control-database';
import type { TenantTx } from '../../src/tenant-database';
import { AuthzHarness } from './authz-fixtures';

export const POOL_PLACEMENT = '00000000-0000-4000-8000-0000000000b1';
export const REQUESTER = '00000000-0000-4000-8000-0000000000e1';
export const APPROVER = '00000000-0000-4000-8000-0000000000e2';
export const WORKER = '00000000-0000-4000-8000-0000000000e3';
export const NOW = new Date('2026-11-03T03:00:00Z');
export const minutes = (n: number, from = NOW): Date => new Date(from.getTime() + n * 60_000);
export const hours = (n: number, from = NOW): Date => minutes(n * 60, from);
export const days = (n: number, from = NOW): Date => hours(n * 24, from);
export const REASON = 'The tenant asked for a database of its own.';

export interface Recorded {
  audits: Array<{ action: string; resourceId: string; diff: unknown; reason: string | undefined }>;
  events: Array<{ type: string; eventKey: string; payload: Record<string, unknown> }>;
}

export function recorder(actor = REQUESTER): ApprovalEffects & Recorded {
  const audits: Recorded['audits'] = [];
  const events: Recorded['events'] = [];
  return {
    actor,
    audits,
    events,
    audit: async (entry) => void audits.push({ action: entry.action, resourceId: entry.resourceId, diff: entry.diff, reason: entry.reason }),
    emit: async (event) => void events.push({ type: event.type, eventKey: event.eventKey, payload: event.payload }),
  };
}

/** The control plane over a migrated database with a pool and a stock of tenants and silos to promote. */
export class PlacementHarness {
  readonly base = new AuthzHarness();
  control!: ControlDatabase;
  private controlPool!: Pool;
  private counter = 0;

  async start(): Promise<void> {
    await this.base.start();
    this.controlPool = new Pool({ connectionString: this.base.database.urlFor('machvon_control'), max: 4 });
    this.controlPool.on('error', () => undefined);
    this.control = new ControlDatabase(this.controlPool);
    await this.admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-pool', 'kms-pool', 'Active') on conflict do nothing", [POOL_PLACEMENT]);
  }

  async stop(): Promise<void> {
    await this.controlPool?.end();
    await this.base.stop();
  }

  get tenants() {
    return this.base.tenants;
  }

  inTenant<T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.control.withTenantOf(tenant, work);
  }

  /** Runs statements as the superuser of the test database (row-level security does not apply to it; the guards do). */
  async admin<T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: this.base.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  async sqlError(text: string, params: unknown[] = [], url = this.base.database.adminUrl): Promise<{ code: string | undefined; message: string } | undefined> {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    } finally {
      await client.end();
    }
  }

  /** An Active tenant on the shared pool of vn-north. */
  async tenant(status = 'Active', region = 'vn-north', where: { placement?: string; isolation?: 'POOL' | 'SILO' } = {}): Promise<string> {
    this.counter += 1;
    const id = randomUUID();
    await this.admin('insert into machvon.tenant (id, code, name, status, placement_id, region, isolation_mode) values ($1, $2, $2, $3, $4, $5, $6)', [id, `promo-${this.counter}-${id.slice(0, 6)}`, status, where.placement ?? POOL_PLACEMENT, region, where.isolation ?? 'POOL']);
    return id;
  }

  /** A silo (one tenant's own database) in a region. */
  async silo(options: { region?: string; status?: string; kind?: string; max?: number | null } = {}): Promise<string> {
    const id = randomUUID();
    await this.admin('insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status, max_tenants) values ($1, $2, $3, $4, $5, $6, $7)', [
      id,
      options.kind ?? 'SILO',
      options.region ?? 'vn-north',
      `cluster-${id.slice(0, 8)}`,
      `kms-${id.slice(0, 8)}`,
      options.status ?? 'Active',
      options.max === undefined ? 1 : options.max,
    ]);
    return id;
  }

  async rowOf(migrationId: string): Promise<Record<string, unknown>> {
    return (await this.admin('select * from machvon.tenant_placement_migration where id = $1', [migrationId]))[0] as Record<string, unknown>;
  }

  async tenantRow(tenantId: string): Promise<{ placement_id: string; isolation_mode: string; write_frozen_until: Date | null; version: string }> {
    return (await this.admin<{ placement_id: string; isolation_mode: string; write_frozen_until: Date | null; version: string }>('select placement_id, isolation_mode, write_frozen_until, version::text from machvon.tenant where id = $1', [tenantId]))[0] as {
      placement_id: string;
      isolation_mode: string;
      write_frozen_until: Date | null;
      version: string;
    };
  }
}
