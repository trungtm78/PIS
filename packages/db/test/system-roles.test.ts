import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TenantContext } from '@machvon/kernel';
import { PERMISSIONS } from '@machvon/contracts/src/permissions.generated';
import { Client, Pool } from 'pg';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import { SYSTEM_ROLES, seedSystemRoles } from '../src/system-roles';
import { TenantDatabase } from '../src/tenant-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const TENANT_OLD_SEED = '00000000-0000-4000-8000-00000000000c';
const ACTOR = '00000000-0000-4000-8000-0000000000f1';
const ctx = (tenantId: string): TenantContext => ({ tenantId, membershipId: ACTOR, scopeVersion: 1 });

interface RoleRow {
  code: string;
  rank: number;
  guest_allowed: boolean;
  is_system: boolean;
  status: string;
  permissions: string[];
}

const catalogue = [...new Set(Object.values(PERMISSIONS))];
const matches = (pattern: string, permission: string): boolean =>
  pattern.endsWith('.*') ? permission.startsWith(pattern.slice(0, -1)) : pattern === permission;

describe('SYSTEM_ROLES', () => {
  it('lists the seventeen system roles of the IAM role table with their ranks', () => {
    expect(SYSTEM_ROLES.map((role) => [role.code, role.rank])).toEqual([
      ['TENANT_OWNER', 99],
      ['TENANT_ADMIN', 90],
      ['SECURITY_ADMIN', 85],
      ['UNIT_ADMIN', 70],
      ['LEADER', 60],
      ['COMMITTEE_HEAD', 62],
      ['COMMITTEE_MEMBER', 55],
      ['COMMITTEE_SECRETARIAT', 52],
      ['NOTIFICATION_ADMIN', 50],
      ['OMNI_SUPERVISOR', 50],
      ['SPECIALIST', 40],
      ['OMNI_AGENT', 35],
      ['INVESTOR_OFFICER', 30],
      ['AUDITOR', 25],
      ['BILLING_VIEWER', 20],
      ['GUEST_CONTRACTOR', 10],
      ['MEMBER', 5],
    ]);
  });

  it('lets every member read their own session data (getMyEntitlements needs session.self)', () => {
    expect(SYSTEM_ROLES.find((role) => role.code === 'MEMBER')?.permissions).toEqual(expect.arrayContaining(['session.self', 'notification.self', 'profile.self', 'tenant.theme.read', 'support.ticket.create', 'support.ticket.read']));
  });

  it('gives the committee roles read, directive and report rights and NO write right on financial data', () => {
    const committee = SYSTEM_ROLES.filter((role) => role.code.startsWith('COMMITTEE_'));
    expect(committee.map((role) => role.code)).toEqual(['COMMITTEE_HEAD', 'COMMITTEE_MEMBER', 'COMMITTEE_SECRETARIAT']);
    const financial = /^(capital|payment|payment_request|disbursement|treasury|treasury_transaction|settlement|contract|advance|guarantee|invoice_line|allocation_line|budget_reservation|ledger|boq|reconciliation|appropriation|cap|pay|ctr|iam|adm|audit|system)\./;
    for (const role of committee) {
      expect(role.permissions.filter((permission) => financial.test(permission))).toEqual([]);
      expect(role.permissions).toContain('committee.read');
      expect(role.guestAllowed).toBe(false);
    }
    expect(SYSTEM_ROLES.find((role) => role.code === 'COMMITTEE_HEAD')?.permissions).toEqual(expect.arrayContaining(['directive.manage', 'directive.meeting.manage', 'rpt.approve']));
    // Reading the audit of who viewed the workspace is for the security administrator and the auditor, never for the committee.
    for (const role of committee) expect(role.permissions).not.toContain('committee.audit.read');
    expect(SYSTEM_ROLES.find((role) => role.code === 'SECURITY_ADMIN')?.permissions).toContain('committee.audit.read');
    expect(SYSTEM_ROLES.find((role) => role.code === 'AUDITOR')?.permissions).toContain('committee.audit.read');
  });

  it('allows guests only for GUEST_CONTRACTOR and MEMBER', () => {
    expect(SYSTEM_ROLES.filter((role) => role.guestAllowed).map((role) => role.code)).toEqual(['GUEST_CONTRACTOR', 'MEMBER']);
  });

  it('never stores a system.* permission, and ranks stay in 1..99', () => {
    for (const role of SYSTEM_ROLES) {
      expect(role.permissions.some((permission) => permission.startsWith('system.'))).toBe(false);
      expect(role.rank).toBeGreaterThanOrEqual(1);
      expect(role.rank).toBeLessThanOrEqual(99);
    }
  });

  it('matches at least one catalogue permission with every pattern and exact name it stores', () => {
    for (const role of SYSTEM_ROLES) {
      for (const permission of role.permissions) {
        const known = permission === 'audit.read' || catalogue.some((entry) => matches(permission, entry));
        expect({ role: role.code, permission, known }).toEqual({ role: role.code, permission, known: true });
      }
    }
  });

  it('gives TENANT_OWNER every tenant-plane permission of the catalogue and no system permission', () => {
    const owner = SYSTEM_ROLES.find((role) => role.code === 'TENANT_OWNER');
    const doc = JSON.parse(readFileSync(join(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, { 'x-permission'?: string; 'x-plane'?: string }>>;
    };
    const tenantPlane = new Set<string>();
    for (const item of Object.values(doc.paths)) {
      for (const operation of Object.values(item)) {
        const permission = operation['x-permission'];
        const plane = operation['x-plane'];
        if (permission !== undefined && (plane === undefined || plane === 'tenant') && !permission.startsWith('system.')) tenantPlane.add(permission);
      }
    }
    expect(tenantPlane.size).toBeGreaterThan(400);
    const uncovered = [...tenantPlane].filter((permission) => !(owner?.permissions ?? []).some((pattern) => matches(pattern, permission)));
    expect(uncovered).toEqual([]);
    expect(catalogue.some((permission) => permission.startsWith('system.') && (owner?.permissions ?? []).some((pattern) => matches(pattern, permission)))).toBe(false);
  });
});

describe('seedSystemRoles', () => {
  let database: TestDatabase;
  let pool: Pool;
  let tenants: TenantDatabase;

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    pool = new Pool({ connectionString: database.urlFor('machvon_app'), max: 3 });
    tenants = new TenantDatabase(pool);
  }, 180_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (database) await database.stop();
  }, 60_000);

  const rolesOf = (tenantId: string): Promise<RoleRow[]> =>
    tenants.withTenant(ctx(tenantId), (tx) =>
      tx.query<RoleRow>('select code, rank, guest_allowed, is_system, status, permissions from machvon.role_definition order by rank desc, code'),
    );

  it('inserts the seventeen roles once and nothing the second time', async () => {
    expect(await tenants.withTenant(ctx(TENANT_A), (tx) => seedSystemRoles(tx, ACTOR))).toEqual({ inserted: 17 });
    expect(await tenants.withTenant(ctx(TENANT_A), (tx) => seedSystemRoles(tx, ACTOR))).toEqual({ inserted: 0 });
    const rows = await rolesOf(TENANT_A);
    expect(rows).toHaveLength(17);
    expect(rows.every((row) => row.is_system && row.status === 'Active')).toBe(true);
    expect(rows.find((row) => row.code === 'TENANT_OWNER')).toMatchObject({ rank: 99, guest_allowed: false });
    expect(rows.find((row) => row.code === 'MEMBER')).toMatchObject({ rank: 5, guest_allowed: true });
    expect(rows.find((row) => row.code === 'UNIT_ADMIN')?.permissions).toEqual(['iam.member.*', 'iam.role.grant', 'iam.unit.manage']);
  });

  it('backfills session.self into MEMBER roles seeded before the permission joined the seed, once and only for system roles', async () => {
    await tenants.withTenant(ctx(TENANT_OLD_SEED), (tx) => seedSystemRoles(tx, ACTOR));
    const admin = new Client({ connectionString: database.adminUrl });
    await admin.connect();
    try {
      // A tenant seeded by an older release: MEMBER without session.self.
      await admin.query("update machvon.role_definition set permissions = array_remove(permissions, 'session.self') where code = 'MEMBER'");
      const migration = readFileSync(join(REPO_ROOT, 'db', 'migrations', 'V010__member_session_self.sql'), 'utf8');
      expect((await admin.query("select count(*)::int as n from machvon.role_definition where code = 'MEMBER' and 'session.self' = any(permissions)")).rows[0].n).toBe(0);
      await admin.query(migration);
      const after = await admin.query("select tenant_id, permissions, version::int as version from machvon.role_definition where code = 'MEMBER' order by tenant_id");
      expect(after.rows.length).toBeGreaterThanOrEqual(2);
      for (const row of after.rows) expect([...row.permissions].sort()).toEqual(['notification.self', 'profile.self', 'session.self', 'support.ticket.create', 'support.ticket.read', 'sync.submit', 'sync.upload', 'tenant.theme.read']);
      const versions = after.rows.map((row) => row.version);
      // Running it again changes nothing, version included.
      await admin.query(migration);
      const again = await admin.query("select version::int as version from machvon.role_definition where code = 'MEMBER' order by tenant_id");
      expect(again.rows.map((row) => row.version)).toEqual(versions);
    } finally {
      await admin.end();
    }
  });

  it('backfills the support ticket permissions into MEMBER roles seeded before they joined the seed, once and only for system roles (ST-IAM-007)', async () => {
    await tenants.withTenant(ctx(TENANT_OLD_SEED), (tx) => seedSystemRoles(tx, ACTOR));
    const admin = new Client({ connectionString: database.adminUrl });
    await admin.connect();
    try {
      // A tenant seeded by an older release: MEMBER without the support ticket permissions,.
      await admin.query("update machvon.role_definition set permissions = array_remove(array_remove(permissions, 'support.ticket.create'), 'support.ticket.read') where code = 'MEMBER'");
      const migration = readFileSync(join(REPO_ROOT, 'db', 'migrations', 'V1241__iam1_member_support_ticket.sql'), 'utf8');
      expect((await admin.query("select count(*)::int as n from machvon.role_definition where code = 'MEMBER' and 'support.ticket.create' = any(permissions)")).rows[0].n).toBe(0);
      await admin.query(migration);
      const after = await admin.query("select permissions, version::int as version from machvon.role_definition where code = 'MEMBER' order by tenant_id");
      expect(after.rows.length).toBeGreaterThanOrEqual(2);
      for (const row of after.rows) expect(row.permissions).toEqual(expect.arrayContaining(['support.ticket.create', 'support.ticket.read']));
      const versions = after.rows.map((row) => row.version);
      // Running it again changes nothing, version included, and the roles that are not MEMBER keep their permissions.
      await admin.query(migration);
      const again = await admin.query("select version::int as version from machvon.role_definition where code = 'MEMBER' order by tenant_id");
      expect(again.rows.map((row) => row.version)).toEqual(versions);
      const unit = await admin.query("select permissions from machvon.role_definition where code = 'UNIT_ADMIN' limit 1");
      expect(unit.rows[0].permissions).toEqual(['iam.member.*', 'iam.role.grant', 'iam.unit.manage']);
    } finally {
      await admin.end();
    }
  });

  it('stores no system.* permission', async () => {
    const rows = await rolesOf(TENANT_A);
    expect(rows.flatMap((row) => row.permissions).some((permission) => permission.startsWith('system.'))).toBe(false);
  });

  it('keeps the roles of one tenant invisible to another', async () => {
    expect(await rolesOf(TENANT_B)).toEqual([]);
    expect(await tenants.withTenant(ctx(TENANT_B), (tx) => seedSystemRoles(tx, ACTOR))).toEqual({ inserted: 17 });
    expect(await rolesOf(TENANT_B)).toHaveLength(17);
  });
});
