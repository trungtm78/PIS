import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { HOME_CLOCK, HOME_CONTEXT_KEY } from '../../src/modules/home/tokens';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

export { TENANT_A, TENANT_B, id, memberId, unitId };

export interface Reply {
  status: number;
  json: Record<string, unknown>;
}

export const MEMBERS = { LEADER: 1, SECOND: 2, BRANCH: 3, NOBODY: 4 } as const;
export const UNITS = { ROOT: 1, NORTH: 2, SOUTH: 3 } as const;

export interface AnaFixture {
  harness: AuthzHarness;
  app: () => RunningApp;
  clock: { now: Date };
  call: (method: 'GET' | 'POST', url: string, options?: { member?: number; tenantId?: string; body?: unknown; key?: string }) => Promise<Reply>;
  get: (url: string, member?: number, tenantId?: string) => Promise<Reply>;
  post: (url: string, body: unknown, member?: number, key?: string) => Promise<Reply>;
  admin: (work: (client: Client) => Promise<void>) => Promise<void>;
  rows: <R extends object>(sql: string, params?: unknown[], tenant?: string) => Promise<R[]>;
  /** Inserts a row, filling the not-null columns the test does not name; `replica` skips the foreign keys and triggers for a row whose parents the test does not build. */
  insert: (table: string, values: Record<string, unknown>, tenant?: string, options?: { replica?: boolean }) => Promise<string>;
  /** A frozen weekly snapshot as of a day. */
  snapshot: (options: { asOf: string; frozenAt?: string }) => Promise<string>;
  /** A project of a unit with a line in a snapshot (the fund source optional), plan 1000 + 250 (in billions), `paid` whole dong paid by the Treasury, null when the Treasury booked nothing. */
  project: (snapshotId: string, unit: number, paid: string | null, options?: { projectId?: string; fundSourceVersionId?: string; planPm?: string; planLocal?: string }) => Promise<string>;
  fundSource: (code: string, label: string) => Promise<string>;
  wipe: (extraTables?: string[]) => Promise<void>;
  start: (config: { controllers: Type[]; roles: Array<{ n: number; name: string; permissions: string[] }>; grants: Array<{ n: number; member: number; role: number; kind: 'TENANT' | 'UNIT_SUBTREE'; unit?: number }> }) => Promise<void>;
  stop: () => Promise<void>;
}

/** The pieces every API suite of the executive analytics needs: a tenant pair, members, a clock, a call helper and direct inserts for the facts the commands read. */
export function createAnaFixture(family: number, initialNow: Date): AnaFixture {
  const harness = new AuthzHarness();
  const signingKey = randomBytes(32);
  const contextKey = randomBytes(32);
  const clock = { now: initialNow };
  let app: RunningApp | undefined;
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, signingKey);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? MEMBERS.LEADER, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${(app as RunningApp).baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  async function admin(work: (client: Client) => Promise<void>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await work(client);
    } finally {
      await client.end();
    }
  }
  async function insert(table: string, values: Record<string, unknown>, tenant = TENANT_A, options: { replica?: boolean } = {}): Promise<string> {
    const rowId = (values.id as string | undefined) ?? randomUUID();
    await admin(async (client) => {
      const columns = (
        await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_generated: string }>(
          `select column_name, data_type, is_nullable, column_default, is_generated from information_schema.columns where table_schema = 'machvon' and table_name = $1`,
          [table],
        )
      ).rows;
      const all: Record<string, unknown> = { tenant_id: tenant, id: rowId, ...values };
      const json = new Set(columns.filter((column) => column.data_type === 'jsonb').map((column) => column.column_name));
      for (const column of columns) {
        if (column.column_name in all || column.is_generated === 'ALWAYS' || column.is_nullable === 'YES' || column.column_default !== null) continue;
        all[column.column_name] =
          column.data_type === 'uuid'
            ? randomUUID()
            : ['integer', 'smallint', 'bigint', 'numeric'].includes(column.data_type)
              ? 1
              : column.data_type === 'boolean'
                ? false
                : column.data_type === 'date'
                  ? '2027-10-15'
                  : column.data_type.startsWith('timestamp')
                    ? clock.now.toISOString()
                    : column.data_type === 'jsonb'
                      ? {}
                      : 'x';
      }
      const names = Object.keys(all);
      const params = names.map((name) => {
        const value = all[name];
        return json.has(name) || (typeof value === 'object' && value !== null && !Array.isArray(value)) ? JSON.stringify(value) : value;
      });
      if (options.replica === true) await client.query('set session_replication_role = replica');
      await client.query(`insert into machvon.${table} (${names.map((name) => `"${name}"`).join(', ')}) values (${names.map((_, index) => `$${index + 1}`).join(', ')})`, params);
      if (options.replica === true) await client.query('set session_replication_role = default');
    });
    return rowId;
  }
  const day = (offset: number): string => new Date(Date.UTC(2046, 0, 2) + offset * 86_400_000).toISOString().slice(0, 10);

  async function snapshot(options: { asOf: string; frozenAt?: string }): Promise<string> {
    counter += 1;
    const periodId = id(family, 2000 + counter);
    const snapshotId = randomUUID();
    const frozenAt = options.frozenAt ?? `${options.asOf}T03:00:00Z`;
    await admin(async (client) => {
      await client.query(
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `ANA-${family}-${counter}`, day(counter * 7), id(family, 40), WORKER_MEMBERSHIP_ID],
      );
      await client.query(
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, $5::date, $5::date, 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, repeat('a', 64), $6::uuid, $7::timestamptz, $6, $6)`,
        [TENANT_A, snapshotId, periodId, frozenAt, options.asOf, WORKER_MEMBERSHIP_ID, frozenAt],
      );
    });
    return snapshotId;
  }
  async function project(snapshotId: string, unit: number, paid: string | null, options: { projectId?: string; fundSourceVersionId?: string; planPm?: string; planLocal?: string } = {}): Promise<string> {
    counter += 1;
    const pid = options.projectId ?? id(family, 500 + counter);
    if (options.projectId === undefined) await insert('project', { id: pid, code: `ANA-${family}-${counter}`, name: `ANA-${family}-${counter}`, owner_unit_id: unitId(unit), classification: 'INTERNAL', total_investment_vnd: 1000, status: 'IMPLEMENTATION', version: 1, project_group: 'B' });
    const planPm = options.planPm ?? '1000000000000';
    const planLocal = options.planLocal ?? '250000000000';
    await admin(async (client) => {
      await client.query(
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, 'CURRENT_YEAR', 'CENTRAL', $6::numeric, $7::numeric, $6::numeric + $7::numeric, $8::numeric, $9)`,
        [TENANT_A, snapshotId, pid, unitId(unit), options.fundSourceVersionId ?? null, planPm, planLocal, paid, paid === null ? 'NONE' : 'COMPLETE'],
      );
    });
    return pid;
  }
  async function fundSource(code: string, label: string): Promise<string> {
    return insert('master_record_version', { master_type: 'FUND_SOURCE', code, revision: 1, label, attributes: {}, valid_from: '2020-01-01', status: 'EFFECTIVE' });
  }
  const wipe = (extra: string[] = []): Promise<void> =>
    admin(async (client) => {
      for (const table of [...extra, 'period_snapshot_line', 'period_snapshot', 'project']) await client.query(`delete from machvon.${table}`);
    });

  return {
    harness,
    app: () => app as RunningApp,
    clock,
    call,
    get: (url, member, tenantId) => call('GET', url, { ...(member === undefined ? {} : { member }), ...(tenantId === undefined ? {} : { tenantId }) }),
    post: (url, body, member, key) => call('POST', url, { body, ...(member === undefined ? {} : { member }), ...(key === undefined ? {} : { key }) }),
    admin,
    rows: <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A) => harness.owner<R>(tenant, [[sql, params]]),
    insert,
    snapshot,
    project,
    fundSource,
    wipe,
    start: async (config) => {
      await harness.start();
      for (const tenant of [TENANT_A, TENANT_B]) {
        await harness.seedUnits(tenant, [
          { n: UNITS.ROOT, path: `/${unitId(UNITS.ROOT)}/` },
          { n: UNITS.NORTH, path: `/${unitId(UNITS.ROOT)}/${unitId(UNITS.NORTH)}/`, parent: UNITS.ROOT },
          { n: UNITS.SOUTH, path: `/${unitId(UNITS.ROOT)}/${unitId(UNITS.SOUTH)}/`, parent: UNITS.ROOT },
        ]);
      }
      for (const n of [MEMBERS.LEADER, MEMBERS.SECOND, MEMBERS.BRANCH, MEMBERS.NOBODY]) await harness.seedMembership(TENANT_A, n, UNITS.ROOT);
      await harness.seedMembership(TENANT_B, 1, UNITS.ROOT);
      for (const role of config.roles) {
        await harness.seedRole(TENANT_A, role.n, role.name, role.permissions, 20);
        await harness.seedRole(TENANT_B, role.n, role.name, role.permissions, 20);
      }
      await harness.seedGrants(
        TENANT_A,
        config.grants.map((grant) => ({ n: grant.n, member: grant.member, role: grant.role, kind: grant.kind, ...(grant.unit === undefined ? {} : { refs: [unitId(grant.unit)] }) })),
      );
      await harness.seedGrants(TENANT_B, [{ n: 1, member: 1, role: 1, kind: 'TENANT' }]);
      const tenants = harness.tenants as TenantDatabase;
      app = await startTestApp({
        signingKey,
        imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
        controllers: config.controllers,
        providers: [
          { provide: TenantDatabase, useValue: tenants },
          { provide: HOME_CLOCK, useValue: () => clock.now },
          { provide: HOME_CONTEXT_KEY, useValue: contextKey },
          { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
        ],
      });
    },
    stop: async () => {
      if (app) await app.close();
      await harness.stop();
    },
  };
}
