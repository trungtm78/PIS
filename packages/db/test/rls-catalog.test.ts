import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { SCHEMA_SOURCE_PATH, findAppendOnlyTables, findNonTenantTables, loadCommittedMigrations } from '../src/generate-migrations';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import { MIGRATION_LEDGER_TABLE, NO_PRIVILEGES, RELAY_TABLE_BOUNDARY_ROLES, TENANT_PREDICATE, indexReport, readCatalog, rlsReport } from '../src/rls-catalog';
import type { CatalogPolicy, CatalogSnapshot, CatalogTable, RlsExpectations, RlsFailureReason } from '../src/rls-catalog';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const schemaSql = readFileSync(join(REPO_ROOT, SCHEMA_SOURCE_PATH), 'utf8');
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
// Tables whose design makes them append-only for the application role, and the table whose grants may never be deleted (V004).
const EXPECTED: RlsExpectations = {
  // The directory of hostnames (V1491, ST-SAS-017) is not in the design: it has no row-level security on purpose, because the control plane reads who holds a hostname across tenants, so its column is not called tenant_id and the application role has no right on it.
  controlPlane: [...findNonTenantTables(schemaSql), 'tenant_domain_directory', 'tenant_placement_migration_directory', 'int_client_directory', 'portal_directory'],
  appendOnly: findAppendOnlyTables(schemaSql),
  noDelete: ['role_grant'],
};

async function session(url: string, tenantId?: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  if (tenantId !== undefined) await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
  return client;
}

async function failure(client: Client, text: string): Promise<{ code?: string; message: string } | undefined> {
  try {
    await client.query(text);
    return undefined;
  } catch (error) {
    return error as { code?: string; message: string };
  }
}

function policy(overrides: Partial<CatalogPolicy> & Pick<CatalogPolicy, 'name' | 'permissive'>): CatalogPolicy {
  return { command: '*', roles: ['public'], using: TENANT_PREDICATE, withCheck: TENANT_PREDICATE, ...overrides };
}

function goodTable(name: string, overrides: Partial<CatalogTable> = {}): CatalogTable {
  return {
    name,
    hasTenantId: true,
    rowSecurity: true,
    forceRowSecurity: true,
    appPrivileges: { select: true, insert: true, update: true, delete: true, truncate: false },
    relayPrivileges: NO_PRIVILEGES,
    policies: [policy({ name: 'tenant_access', permissive: true }), policy({ name: 'tenant_boundary', permissive: false })],
    idColumns: [],
    ...overrides,
  };
}

function snapshotOf(tables: CatalogTable[], roles: CatalogSnapshot['roles'] = []): CatalogSnapshot {
  return { tables, roles };
}

const NONE: RlsExpectations = { controlPlane: [], appendOnly: [], noDelete: [] };

function reasonsOf(snapshot: CatalogSnapshot, expected: RlsExpectations = NONE): RlsFailureReason[] {
  return rlsReport(snapshot, expected).missing.map((failureEntry) => failureEntry.reason);
}

describe('RLS catalog of the migrated database (ST-KERNEL-020, ST-IAM-001)', () => {
  let database: TestDatabase;
  let snapshot: CatalogSnapshot;

  beforeAll(async () => {
    // The report reads cluster-wide facts (roles, grants) of a server that nothing else touches: a server of its own.
    database = await startMigratedTestDatabase(REPO_ROOT, { tempPrefix: 'machvon-pg-rls-' });
    snapshot = await readCatalog(database.adminUrl);
    const owner = await session(database.urlFor('machvon_owner'));
    try {
      for (const [tenant, count] of [[TENANT_A, 3], [TENANT_B, 2]] as const) {
        await owner.query("select set_config('app.tenant_id', $1, false)", [tenant]);
        for (let n = 1; n <= count; n += 1) {
          await owner.query(
            "insert into machvon.organization_unit (tenant_id, id, code, name, valid_from) values ($1, gen_random_uuid(), $2, $3, date '2026-01-01')",
            [tenant, `${tenant.slice(-1).toUpperCase()}-U${n}`, `Unit ${n}`],
          );
        }
      }
    } finally {
      await owner.end();
    }
  }, 180_000);

  afterAll(async () => {
    if (database) await database.stop();
  }, 60_000);

  it('runs on the database that all committed migrations built', async () => {
    const names = (await loadCommittedMigrations(REPO_ROOT)).map((migration) => migration.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'V001__roles_and_grants',
        'V002__schema',
        'V003__platform_services',
        'V004__authorization_core',
        'V006__roles_and_grants',
      ]),
    );
    const client = await session(database.adminUrl);
    try {
      const { rows } = await client.query<{ version: string }>('select version from machvon.schema_migration order by version');
      expect(rows.map((row) => row.version)).toEqual(names);
    } finally {
      await client.end();
    }
  });

  it('finds row-level security enabled, forced and exactly policed on every tenant table (AC-ST-IAM-001-2, AC-ST-KERNEL-020-1)', () => {
    const report = rlsReport(snapshot, EXPECTED);
    expect(report.missing).toEqual([]);
    expect(report.tenantTables).toBeGreaterThanOrEqual(283);
    // The migration ledger is not a design table; it is checked on its own (no grants for the application role).
    expect(report.controlPlaneTables).toEqual([...EXPECTED.controlPlane].sort());
    expect(snapshot.tables.find((table) => table.name === MIGRATION_LEDGER_TABLE)?.appPrivileges).toEqual(NO_PRIVILEGES);
    for (const table of snapshot.tables.filter((candidate) => candidate.hasTenantId)) {
      const names = table.policies.map((entry) => entry.name);
      expect(names).toEqual(expect.arrayContaining(['tenant_access', 'tenant_boundary']));
    }
  });

  it('keeps the outbox relay exception to one policy on one table, bounded to select and update', () => {
    const relayTables = snapshot.tables.filter((table) => table.policies.some((entry) => entry.name === 'outbox_relay_access'));
    expect(relayTables.map((table) => table.name)).toEqual(['outbox_event']);
    const outbox = relayTables[0];
    expect(outbox?.relayPrivileges).toEqual({ select: true, insert: false, update: true, delete: false, truncate: false });
    const boundary = outbox?.policies.find((entry) => entry.name === 'tenant_boundary');
    expect([...(boundary?.roles ?? [])].sort()).toEqual([...RELAY_TABLE_BOUNDARY_ROLES]);
    for (const table of snapshot.tables.filter((candidate) => candidate.name !== 'outbox_event')) {
      expect(table.relayPrivileges).toEqual(NO_PRIVILEGES);
    }
  });

  it('keeps every role away from superuser and RLS bypass, and the application role owns nothing (AC-ST-KERNEL-020-2)', () => {
    expect(snapshot.roles.map((role) => role.name).sort()).toEqual(
      ['machvon_app', 'machvon_control', 'machvon_outbox_relay', 'machvon_owner', 'machvon_reporting', 'machvon_sync'],
    );
    for (const role of snapshot.roles) {
      expect(role).toMatchObject({ superuser: false, bypassRls: false });
    }
    expect(snapshot.roles.find((role) => role.name === 'machvon_app')?.ownedRelations).toBe(0);
  });

  it('gives the application role INSERT and SELECT only on the audit and ledger tables, and nothing on control-plane tables (AC-ST-KERNEL-020-2)', () => {
    const insertSelectOnly = { select: true, insert: true, update: false, delete: false, truncate: false };
    for (const name of EXPECTED.appendOnly) {
      const table = snapshot.tables.find((candidate) => candidate.name === name);
      if (table?.hasTenantId === true) expect({ name, privileges: table.appPrivileges }).toEqual({ name, privileges: insertSelectOnly });
    }
    expect(snapshot.tables.find((table) => table.name === 'audit_event')?.appPrivileges).toEqual(insertSelectOnly);
    expect(snapshot.tables.find((table) => table.name === 'audit_seal')?.appPrivileges).toEqual(insertSelectOnly);
    for (const table of snapshot.tables.filter((candidate) => !candidate.hasTenantId)) {
      expect({ name: table.name, privileges: table.appPrivileges }).toEqual({ name: table.name, privileges: NO_PRIVILEGES });
    }
  });

  it('has a (tenant_id, column) index for every *_id column of every tenant table', () => {
    const report = indexReport(snapshot);
    expect(report.missing).toEqual([]);
    // The schema has 845 *_id columns on tenant and control-plane tables; control-plane ones are checked on their own.
    expect(report.checked).toBeGreaterThanOrEqual(840);
    expect(report.controlPlaneUnindexed).toEqual([]);
  });

  describe('the execution tables (ST-CTR-013)', () => {
    // The tables of the execution modules: the contracts, payments, quality, issues, land clearance and permits of the baseline schema, and every table that the migrations of those modules add.
    const BASELINE_EXECUTION = /^(contract|issue|payment|treasury|boq|measurement|acceptance|quality|inspection|ncr|punch|land|household|parcel|compensation|permit|retention|guarantee|advance|cumulative|settlement|disbursement)/;
    const created = (sql: string): string[] => [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:machvon\.)?(\w+)/gi)].map((match) => match[1] as string);
    const executionTables = (): string[] => {
      const directory = join(REPO_ROOT, 'db', 'migrations');
      const added = readdirSync(directory)
        .filter((name) => /__(?:ctr|pay|qms|iss|lnd|pmt)\d+_/.test(name))
        .flatMap((name) => created(readFileSync(join(directory, name), 'utf8')));
      const baseline = created(schemaSql).filter((name) => BASELINE_EXECUTION.test(name));
      return [...new Set([...baseline, ...added])].sort();
    };

    it('AC-ST-CTR-013-3 / UAT-AC396: gives every execution table forced row-level security and exactly the two required policies', () => {
      const names = executionTables();
      expect(names.length).toBeGreaterThanOrEqual(65);
      const found = names.map((name) => snapshot.tables.find((table) => table.name === name));
      expect(found.map((table, index) => (table === undefined ? `${names[index]} is not in the database` : undefined)).filter((entry) => entry !== undefined)).toEqual([]);
      for (const table of found.filter((entry) => entry !== undefined)) {
        expect([table.name, table.rowSecurity, table.forceRowSecurity]).toEqual([table.name, true, true]);
        // A table of personal data of households has one more restrictive policy, the guard of the units of the reader (scope_units_guard); it narrows, never widens.
        const tenantPolicies = table.policies.filter((entry) => entry.name !== 'scope_units_guard' && entry.name !== 'bi_reader_boundary' && entry.name !== 'portal_boundary');
        expect([table.name, tenantPolicies.map((entry) => entry.name).sort()]).toEqual([table.name, ['tenant_access', 'tenant_boundary']]);
        expect(table.policies.filter((entry) => entry.name === 'scope_units_guard').every((entry) => !entry.permissive)).toBe(true);
      }
      expect(rlsReport(snapshot, EXPECTED).missing.filter((entry) => names.includes(entry.table))).toEqual([]);
    });

    it('AC-ST-CTR-013-1 / UAT-AC398: leaves no *_id column of an execution table without an index that starts with tenant_id', () => {
      const names = new Set(executionTables());
      const report = indexReport(snapshot);
      expect(report.missing.filter((entry) => names.has(entry.table))).toEqual([]);
      const columns = snapshot.tables.filter((table) => names.has(table.name)).flatMap((table) => table.idColumns);
      expect(columns.length).toBeGreaterThan(100);
    });
  });

  describe('behaviour as the application role', () => {
    it('shows no rows without a tenant context, only the tenant rows with one, and refuses a foreign row (AC-ST-IAM-001-2, AC-ST-KERNEL-020-1)', async () => {
      const app = await session(database.urlFor('machvon_app'));
      try {
        const count = async (): Promise<number> => Number((await app.query<{ n: string }>('select count(*) as n from machvon.organization_unit')).rows[0]?.n);
        expect(await count()).toBe(0);
        await app.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
        expect(await count()).toBe(3);
        await app.query("select set_config('app.tenant_id', $1, false)", [TENANT_B]);
        expect(await count()).toBe(2);
        await app.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
        const refused = await failure(
          app,
          `insert into machvon.organization_unit (tenant_id, id, code, name, valid_from) values ('${TENANT_B}', gen_random_uuid(), 'X-FOREIGN', 'Foreign', date '2026-01-01')`,
        );
        expect(refused?.code).toBe('42501');
        expect(refused?.message).toMatch(/row-level security/);
      } finally {
        await app.end();
      }
    });

    it('is refused UPDATE, DELETE and TRUNCATE on every append-only tenant table and DELETE and TRUNCATE on role_grant', async () => {
      const app = await session(database.urlFor('machvon_app'), TENANT_A);
      try {
        const appendOnly = EXPECTED.appendOnly.filter((name) => snapshot.tables.find((table) => table.name === name)?.hasTenantId === true);
        expect(appendOnly).toEqual(expect.arrayContaining(['audit_event', 'audit_seal']));
        for (const name of appendOnly) {
          for (const statement of [`update machvon.${name} set tenant_id = tenant_id`, `delete from machvon.${name}`, `truncate machvon.${name}`]) {
            expect({ statement, code: (await failure(app, statement))?.code }).toEqual({ statement, code: '42501' });
          }
        }
        for (const statement of ['delete from machvon.role_grant', 'truncate machvon.role_grant']) {
          expect({ statement, code: (await failure(app, statement))?.code }).toEqual({ statement, code: '42501' });
        }
      } finally {
        await app.end();
      }
    });
  });

  describe('negative controls: the report goes red', () => {
    it('lists a table that was created without row-level security, then one that is not forced, on the real database', async () => {
      const owner = await session(database.urlFor('machvon_owner'));
      try {
        await owner.query('create table machvon.rls_probe (tenant_id uuid not null, id uuid primary key, owner_id uuid)');
        const unprotected = rlsReport(await readCatalog(database.adminUrl), EXPECTED).missing.filter((entry) => entry.table === 'rls_probe');
        expect(unprotected.map((entry) => entry.reason)).toEqual(expect.arrayContaining(['no_rls', 'no_permissive', 'no_restrictive']));
        expect(indexReport(await readCatalog(database.adminUrl)).missing).toEqual([{ table: 'rls_probe', column: 'owner_id' }]);

        await owner.query('alter table machvon.rls_probe enable row level security');
        const notForced = rlsReport(await readCatalog(database.adminUrl), EXPECTED).missing.filter((entry) => entry.table === 'rls_probe');
        expect(notForced.map((entry) => entry.reason)).toContain('not_forced');
      } finally {
        await owner.query('drop table if exists machvon.rls_probe');
        await owner.end();
      }
      expect(rlsReport(await readCatalog(database.adminUrl), EXPECTED).missing).toEqual([]);
    });

    it.each<[string, CatalogTable, RlsFailureReason]>([
      ['row-level security disabled', goodTable('t', { rowSecurity: false }), 'no_rls'],
      ['row-level security not forced', goodTable('t', { forceRowSecurity: false }), 'not_forced'],
      ['no permissive policy', goodTable('t', { policies: [policy({ name: 'tenant_boundary', permissive: false })] }), 'no_permissive'],
      ['permissive policy with another predicate', goodTable('t', { policies: [policy({ name: 'tenant_access', permissive: true, using: 'true' }), policy({ name: 'tenant_boundary', permissive: false })] }), 'no_permissive'],
      ['no restrictive policy', goodTable('t', { policies: [policy({ name: 'tenant_access', permissive: true })] }), 'no_restrictive'],
      ['restrictive policy without WITH CHECK', goodTable('t', { policies: [policy({ name: 'tenant_access', permissive: true }), policy({ name: 'tenant_boundary', permissive: false, withCheck: null })] }), 'no_restrictive'],
      ['unknown extra policy', goodTable('t', { policies: [...goodTable('t').policies, policy({ name: 'let_everyone_in', permissive: true, using: 'true', withCheck: 'true' })] }), 'unexpected_policy'],
      ['scope guard with a foreign predicate', goodTable('t', { policies: [...goodTable('t').policies, policy({ name: 'scope_units_guard', permissive: false, using: 'true', withCheck: 'true' })] }), 'unexpected_policy'],
      ['relay privileges on an ordinary table', goodTable('t', { relayPrivileges: { ...NO_PRIVILEGES, select: true } }), 'relay_exception_wrong'],
      ['a BI policy on an ordinary table', goodTable('t', { policies: [...goodTable('t').policies, policy({ name: 'bi_reader_boundary', permissive: false, command: 'r', roles: ['machvon_bi_reader'], using: '(tenant_id = ( SELECT machvon_bi.tenant_of((CURRENT_USER)::text) AS tenant_of))', withCheck: null })] }), 'bi_exception_wrong'],
      ['BI privileges on an ordinary table', goodTable('t', { biPrivileges: { ...NO_PRIVILEGES, select: true } }), 'bi_exception_wrong'],
      ['a BI table without its policy', goodTable('period_snapshot_line'), 'bi_exception_wrong'],
      ['a BI table whose policy is for another role', goodTable('period_snapshot_line', { policies: [...goodTable('x').policies, policy({ name: 'bi_reader_boundary', permissive: false, command: 'r', roles: ['public'], using: '(tenant_id = ( SELECT machvon_bi.tenant_of((CURRENT_USER)::text) AS tenant_of))', withCheck: null })] }), 'bi_exception_wrong'],
      ['a BI table whose policy ignores the binding', goodTable('period_snapshot_line', { policies: [...goodTable('x').policies, policy({ name: 'bi_reader_boundary', permissive: false, command: 'r', roles: ['machvon_bi_reader'], using: 'true', withCheck: null })] }), 'bi_exception_wrong'],
      ['a BI table the group role may write', goodTable('period_snapshot_line', { biPrivileges: { ...NO_PRIVILEGES, select: true, update: true }, policies: [...goodTable('x').policies, policy({ name: 'bi_reader_boundary', permissive: false, command: 'r', roles: ['machvon_bi_reader'], using: '(tenant_id = ( SELECT machvon_bi.tenant_of((CURRENT_USER)::text) AS tenant_of))', withCheck: null })] }), 'bi_exception_wrong'],
      ['relay policy on an ordinary table', goodTable('t', { policies: [...goodTable('t').policies, policy({ name: 'outbox_relay_access', permissive: true, roles: ['machvon_outbox_relay'], using: 'true', withCheck: 'true' })] }), 'relay_exception_wrong'],
    ])('reports %s', (_label, table, reason) => {
      expect(reasonsOf(snapshotOf([table]))).toContain(reason);
    });

    it('accepts a BI table with the policy bound to the tenant of the login and read-only privileges', () => {
      const table = goodTable('period_snapshot_line', { biPrivileges: { ...NO_PRIVILEGES, select: true }, policies: [...goodTable('x').policies, policy({ name: 'bi_reader_boundary', permissive: false, command: 'r', roles: ['machvon_bi_reader'], using: '(tenant_id = ( SELECT machvon_bi.tenant_of((CURRENT_USER)::text) AS tenant_of))', withCheck: null })] });
      expect(reasonsOf(snapshotOf([table]))).toEqual([]);
    });

    it('reports a relay table whose relay policy or restrictive roles are wrong', () => {
      const outbox = (relay: Partial<CatalogTable>, boundaryRoles: string[]): CatalogTable =>
        goodTable('outbox_event', {
          relayPrivileges: { select: true, insert: false, update: true, delete: false, truncate: false },
          policies: [
            policy({ name: 'tenant_access', permissive: true }),
            policy({ name: 'tenant_boundary', permissive: false, roles: boundaryRoles }),
            policy({ name: 'outbox_relay_access', permissive: true, roles: ['machvon_outbox_relay'], using: 'true', withCheck: 'true' }),
          ],
          ...relay,
        });
      expect(reasonsOf(snapshotOf([outbox({}, [...RELAY_TABLE_BOUNDARY_ROLES])]))).toEqual([]);
      expect(reasonsOf(snapshotOf([outbox({}, ['public'])]))).toContain('no_restrictive');
      expect(reasonsOf(snapshotOf([outbox({ relayPrivileges: { ...NO_PRIVILEGES, select: true, update: true, insert: true } }, [...RELAY_TABLE_BOUNDARY_ROLES])]))).toContain('relay_exception_wrong');
      expect(reasonsOf(snapshotOf([outbox({ policies: goodTable('x').policies }, [...RELAY_TABLE_BOUNDARY_ROLES])]))).toContain('relay_exception_wrong');
    });

    it('reports control-plane drift, grants and writable append-only tables', () => {
      const controlPlane = goodTable('registry', { hasTenantId: false, rowSecurity: false, forceRowSecurity: false, policies: [], appPrivileges: NO_PRIVILEGES });
      expect(reasonsOf(snapshotOf([controlPlane]), { ...NONE, controlPlane: ['registry'] })).toEqual([]);
      expect(reasonsOf(snapshotOf([controlPlane]), NONE)).toContain('control_plane_unexpected');
      expect(reasonsOf(snapshotOf([controlPlane]), { ...NONE, controlPlane: ['registry'] })).not.toContain('control_plane_granted');
      expect(reasonsOf(snapshotOf([{ ...controlPlane, appPrivileges: { ...NO_PRIVILEGES, select: true } }]), { ...NONE, controlPlane: ['registry'] })).toContain('control_plane_granted');
      expect(reasonsOf(snapshotOf([]), { ...NONE, controlPlane: ['registry'] })).toContain('control_plane_missing');
      expect(reasonsOf(snapshotOf([goodTable('registry')]), { ...NONE, controlPlane: ['registry'] })).toContain('control_plane_unexpected');
      const writable = goodTable('ledger');
      expect(reasonsOf(snapshotOf([writable]), { ...NONE, appendOnly: ['ledger'] })).toContain('append_only_writable');
      expect(reasonsOf(snapshotOf([writable]), { ...NONE, noDelete: ['ledger'] })).toContain('delete_allowed');
      const ledger = goodTable(MIGRATION_LEDGER_TABLE, { hasTenantId: false, rowSecurity: false, forceRowSecurity: false, policies: [], appPrivileges: { ...NO_PRIVILEGES, select: true } });
      expect(reasonsOf(snapshotOf([ledger]))).toEqual(['control_plane_granted']);
    });

    it('reports a privileged role and an application role that owns objects', () => {
      const roles = [
        { name: 'machvon_app', superuser: false, bypassRls: true, ownedRelations: 2 },
        { name: 'machvon_sync', superuser: true, bypassRls: false, ownedRelations: 0 },
      ];
      const report = rlsReport(snapshotOf([], roles), NONE).missing;
      expect(report).toEqual([
        { table: 'machvon_app', reason: 'role_privileged' },
        { table: 'machvon_app', reason: 'app_role_owns_objects' },
        { table: 'machvon_sync', reason: 'role_privileged' },
      ]);
    });

    it('reports id columns without a leading index, and keeps control-plane gaps apart', () => {
      const tenant = goodTable('contract', { idColumns: [{ column: 'project_id', indexed: true }, { column: 'party_id', indexed: false }] });
      const registry = goodTable('plan_feature', { hasTenantId: false, idColumns: [{ column: 'plan_version_id', indexed: false }] });
      const report = indexReport(snapshotOf([tenant, registry, goodTable(MIGRATION_LEDGER_TABLE, { hasTenantId: false, idColumns: [{ column: 'x_id', indexed: false }] })]));
      expect(report).toEqual({
        checked: 2,
        missing: [{ table: 'contract', column: 'party_id' }],
        controlPlaneUnindexed: [{ table: 'plan_feature', column: 'plan_version_id' }],
      });
    });
  });
});
