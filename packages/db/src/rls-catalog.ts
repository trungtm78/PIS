import { Client } from 'pg';
import { APP_ROLE, MACHVON_ROLES } from './roles.ts';

/** Schema that holds every product table. */
const SCHEMA = 'machvon';
/** The migration ledger is created by the migrator, not by the design, and is owned by the owner role alone. */
export const MIGRATION_LEDGER_TABLE = 'schema_migration';
const RELAY_ROLE = 'machvon_outbox_relay';
const RELAY_TABLE = 'outbox_event';
const RELAY_POLICY = 'outbox_relay_access';
const PERMISSIVE_POLICY = 'tenant_access';
const RESTRICTIVE_POLICY = 'tenant_boundary';
// The design adds a second restrictive guard on a few project-scoped tables (owner unit scope).
const SCOPE_POLICY = 'scope_units_guard';
const SCOPE_PREDICATE_MARKER = "current_setting('app.scope_units'::text, true)";
// INT-1 (V2202, eng-review R13): the BI logins read four snapshot tables through certified views. Each of those tables carries ONE more restrictive policy for the group role of the BI logins, bound to the tenant
// of the login by its own name (machvon_bi.tenant_of(current_user)), so a login that changes app.tenant_id reads nothing. No other table may carry it, and no other table may be readable by the group role.
export const BI_ROLE = 'machvon_bi_reader';
const BI_POLICY = 'bi_reader_boundary';
const BI_PREDICATE_MARKER = 'machvon_bi.tenant_of(';
export const BI_TABLES: readonly string[] = ['contract_fact_snapshot', 'contract_fact_snapshot_line', 'period_snapshot', 'period_snapshot_line'];

/** The tenant predicate exactly as PostgreSQL prints it (pg_get_expr), for USING and WITH CHECK alike. */
export const TENANT_PREDICATE = "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";
/** Roles the restrictive boundary of the relay table names; every role but the relay (see V003). */
export const RELAY_TABLE_BOUNDARY_ROLES: readonly string[] = MACHVON_ROLES.filter((role) => role !== RELAY_ROLE).slice().sort();

export interface TablePrivileges {
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
}

export interface CatalogPolicy {
  name: string;
  permissive: boolean;
  /** `*` for ALL, otherwise r, a, w or d. */
  command: string;
  /** Role names; `public` for the PUBLIC pseudo-role. */
  roles: string[];
  using: string | null;
  withCheck: string | null;
}

export interface CatalogTable {
  name: string;
  hasTenantId: boolean;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  appPrivileges: TablePrivileges;
  relayPrivileges: TablePrivileges;
  policies: CatalogPolicy[];
  /** What the group role of the BI logins may do on the table with some column (absent in catalogs read before INT-1). */
  biPrivileges?: TablePrivileges;
  /** Every `*_id` column except tenant_id, with whether an index leads with (tenant_id, column) or, on tables without tenant_id, with the column. */
  idColumns: { column: string; indexed: boolean }[];
}

export interface CatalogRole {
  name: string;
  superuser: boolean;
  bypassRls: boolean;
  ownedRelations: number;
}

export interface CatalogSnapshot {
  tables: CatalogTable[];
  roles: CatalogRole[];
}

export type RlsFailureReason =
  | 'no_rls'
  | 'not_forced'
  | 'no_permissive'
  | 'no_restrictive'
  | 'unexpected_policy'
  | 'relay_exception_wrong'
  | 'bi_exception_wrong'
  | 'control_plane_unexpected'
  | 'control_plane_missing'
  | 'control_plane_granted'
  | 'append_only_writable'
  | 'delete_allowed'
  | 'role_privileged'
  | 'app_role_owns_objects';

export interface RlsFailure {
  table: string;
  reason: RlsFailureReason;
}

export interface RlsReport {
  tenantTables: number;
  controlPlaneTables: string[];
  missing: RlsFailure[];
}

export interface RlsExpectations {
  /** Tables the design keeps outside tenant row-level security (findNonTenantTables of the design SQL). */
  controlPlane: readonly string[];
  /** Tables the application role may only INSERT into and SELECT from. */
  appendOnly: readonly string[];
  /** Tables the application role may not DELETE from (but may update). */
  noDelete: readonly string[];
}

const NO_PRIVILEGES: TablePrivileges = { select: false, insert: false, update: false, delete: false, truncate: false };

function anyPrivilege(privileges: TablePrivileges): boolean {
  return privileges.select || privileges.insert || privileges.update || privileges.delete || privileges.truncate;
}

function isTenantPredicate(policy: CatalogPolicy): boolean {
  return policy.using === TENANT_PREDICATE && policy.withCheck === TENANT_PREDICATE;
}

function isScopePolicy(policy: CatalogPolicy): boolean {
  return (
    policy.name === SCOPE_POLICY &&
    !policy.permissive &&
    (policy.using?.includes(SCOPE_PREDICATE_MARKER) ?? false) &&
    (policy.withCheck?.includes(SCOPE_PREDICATE_MARKER) ?? false)
  );
}

function sameRoles(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && [...actual].sort().every((role, index) => role === expected[index]);
}

function policyFailures(table: CatalogTable): RlsFailureReason[] {
  const failures: RlsFailureReason[] = [];
  const permissive = table.policies.filter((policy) => policy.name === PERMISSIVE_POLICY);
  if (!permissive.some((policy) => policy.permissive && policy.command === '*' && isTenantPredicate(policy))) failures.push('no_permissive');
  const restrictive = table.policies.filter((policy) => policy.name === RESTRICTIVE_POLICY);
  const wanted = table.name === RELAY_TABLE ? RELAY_TABLE_BOUNDARY_ROLES : ['public'];
  if (!restrictive.some((policy) => !policy.permissive && policy.command === '*' && isTenantPredicate(policy) && sameRoles(policy.roles, wanted))) {
    failures.push('no_restrictive');
  }
  const known = new Set([PERMISSIVE_POLICY, RESTRICTIVE_POLICY, SCOPE_POLICY, RELAY_POLICY, BI_POLICY]);
  for (const policy of table.policies) {
    if (!known.has(policy.name) || (policy.name === SCOPE_POLICY && !isScopePolicy(policy))) failures.push('unexpected_policy');
  }
  const relayPolicies = table.policies.filter((policy) => policy.name === RELAY_POLICY);
  const relayOk =
    table.name === RELAY_TABLE
      ? relayPolicies.length === 1 &&
        relayPolicies[0] !== undefined &&
        relayPolicies[0].permissive &&
        relayPolicies[0].command === '*' &&
        sameRoles(relayPolicies[0].roles, [RELAY_ROLE]) &&
        relayPolicies[0].using === 'true' &&
        relayPolicies[0].withCheck === 'true' &&
        table.relayPrivileges.select &&
        table.relayPrivileges.update &&
        !table.relayPrivileges.insert &&
        !table.relayPrivileges.delete &&
        !table.relayPrivileges.truncate
      : relayPolicies.length === 0 && !anyPrivilege(table.relayPrivileges);
  if (!relayOk) failures.push('relay_exception_wrong');
  const biPolicies = table.policies.filter((policy) => policy.name === BI_POLICY);
  const biOk = BI_TABLES.includes(table.name)
    ? biPolicies.length === 1 &&
      biPolicies[0] !== undefined &&
      !biPolicies[0].permissive &&
      biPolicies[0].command === 'r' &&
      sameRoles(biPolicies[0].roles, [BI_ROLE]) &&
      (biPolicies[0].using?.includes(BI_PREDICATE_MARKER) ?? false) &&
      biPolicies[0].withCheck === null &&
      (table.biPrivileges === undefined || (table.biPrivileges.select && !table.biPrivileges.insert && !table.biPrivileges.update && !table.biPrivileges.delete && !table.biPrivileges.truncate))
    : biPolicies.length === 0 && (table.biPrivileges === undefined || !anyPrivilege(table.biPrivileges));
  if (!biOk) failures.push('bi_exception_wrong');
  return failures;
}

/**
 * Pure verdict over a catalog snapshot (ST-KERNEL-020, ST-IAM-001). Every tenant table needs row-level security
 * enabled and forced, the permissive and restrictive tenant policies in their exact form, and nothing else but
 * the design's scope guard and the single outbox relay exception; control-plane tables must be exactly the
 * expected set and unreachable for the application role; append-only tables must not be writable.
 */
export function rlsReport(snapshot: CatalogSnapshot, expected: RlsExpectations): RlsReport {
  const missing: RlsFailure[] = [];
  const add = (table: string, reason: RlsFailureReason): void => void missing.push({ table, reason });
  const controlPlane = new Set(expected.controlPlane);
  const tables = snapshot.tables.filter((table) => table.name !== MIGRATION_LEDGER_TABLE);
  const present = new Set(tables.map((table) => table.name));

  for (const name of controlPlane) if (!present.has(name)) add(name, 'control_plane_missing');
  for (const table of tables) {
    if (!table.hasTenantId) {
      if (!controlPlane.has(table.name)) add(table.name, 'control_plane_unexpected');
      if (anyPrivilege(table.appPrivileges)) add(table.name, 'control_plane_granted');
      continue;
    }
    if (controlPlane.has(table.name)) add(table.name, 'control_plane_unexpected');
    if (!table.rowSecurity) add(table.name, 'no_rls');
    else if (!table.forceRowSecurity) add(table.name, 'not_forced');
    for (const reason of policyFailures(table)) add(table.name, reason);
    const privileges = table.appPrivileges;
    if (expected.appendOnly.includes(table.name) && (privileges.update || privileges.delete || privileges.truncate)) add(table.name, 'append_only_writable');
    if (expected.noDelete.includes(table.name) && (privileges.delete || privileges.truncate)) add(table.name, 'delete_allowed');
  }
  const ledger = snapshot.tables.find((table) => table.name === MIGRATION_LEDGER_TABLE);
  if (ledger !== undefined && anyPrivilege(ledger.appPrivileges)) add(MIGRATION_LEDGER_TABLE, 'control_plane_granted');

  for (const role of snapshot.roles) {
    if (role.superuser || role.bypassRls) add(role.name, 'role_privileged');
    if (role.name === APP_ROLE && role.ownedRelations > 0) add(role.name, 'app_role_owns_objects');
  }
  return {
    tenantTables: tables.filter((table) => table.hasTenantId).length,
    controlPlaneTables: tables.filter((table) => !table.hasTenantId).map((table) => table.name).sort(),
    missing,
  };
}

export interface IndexReport {
  /** Number of `*_id` columns checked on tenant tables. */
  checked: number;
  /** Tenant-table columns without an index that leads with (tenant_id, column). */
  missing: { table: string; column: string }[];
  /** Control-plane columns without a leading index (informational: those tables have no tenant_id to lead with). */
  controlPlaneUnindexed: { table: string; column: string }[];
}

/** Pure verdict: every `*_id` column of a tenant table has an index starting with (tenant_id, column). */
export function indexReport(snapshot: CatalogSnapshot): IndexReport {
  const report: IndexReport = { checked: 0, missing: [], controlPlaneUnindexed: [] };
  for (const table of snapshot.tables) {
    if (table.name === MIGRATION_LEDGER_TABLE) continue;
    for (const { column, indexed } of table.idColumns) {
      if (table.hasTenantId) report.checked += 1;
      if (indexed) continue;
      (table.hasTenantId ? report.missing : report.controlPlaneUnindexed).push({ table: table.name, column });
    }
  }
  return report;
}

const TABLES_SQL = `
  select c.oid, c.relname as name, c.relrowsecurity as row_security, c.relforcerowsecurity as force_row_security,
    exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped) as has_tenant_id,
    has_table_privilege($2, c.oid, 'select') as app_select, has_table_privilege($2, c.oid, 'insert') as app_insert,
    has_table_privilege($2, c.oid, 'update') as app_update, has_table_privilege($2, c.oid, 'delete') as app_delete,
    has_table_privilege($2, c.oid, 'truncate') as app_truncate,
    has_table_privilege($3, c.oid, 'select') as relay_select, has_table_privilege($3, c.oid, 'insert') as relay_insert,
    has_table_privilege($3, c.oid, 'update') as relay_update, has_table_privilege($3, c.oid, 'delete') as relay_delete,
    has_table_privilege($3, c.oid, 'truncate') as relay_truncate,
    case when to_regrole($4) is null then false else has_any_column_privilege($4, c.oid, 'select') end as bi_select,
    case when to_regrole($4) is null then false else has_any_column_privilege($4, c.oid, 'insert') end as bi_insert,
    case when to_regrole($4) is null then false else has_any_column_privilege($4, c.oid, 'update') end as bi_update,
    case when to_regrole($4) is null then false else has_table_privilege($4, c.oid, 'delete') end as bi_delete,
    case when to_regrole($4) is null then false else has_table_privilege($4, c.oid, 'truncate') end as bi_truncate
  from pg_class c join pg_namespace s on s.oid = c.relnamespace
  where s.nspname = $1 and c.relkind in ('r', 'p') order by c.relname`;

const POLICIES_SQL = `
  select p.polrelid as table_oid, p.polname as name, p.polpermissive as permissive, p.polcmd as command,
    coalesce((select array_agg(case when r = 0 then 'public'::text else (select rolname::text from pg_roles where oid = r) end) from unnest(p.polroles) r), array[]::text[]) as roles,
    pg_get_expr(p.polqual, p.polrelid) as using_expr, pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace s on s.oid = c.relnamespace where s.nspname = $1 order by 1, 2`;

// An id column counts as indexed when some index has tenant_id first and the column second (tenant tables) or the column first (others).
const ID_COLUMNS_SQL = `
  select c.oid as table_oid, a.attname as column_name,
    exists (
      select 1 from pg_index i
      where i.indrelid = c.oid and i.indisvalid
        and case when t.attnum is null then i.indkey[0] = a.attnum else i.indkey[0] = t.attnum and i.indkey[1] = a.attnum end
    ) as indexed
  from pg_class c join pg_namespace s on s.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attribute t on t.attrelid = c.oid and t.attname = 'tenant_id' and t.attnum > 0 and not t.attisdropped
  where s.nspname = $1 and c.relkind in ('r', 'p') and a.attname like '%\\_id' escape '\\' and a.attname <> 'tenant_id'
  order by 1, 2`;

const ROLES_SQL = `
  select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypass_rls,
    (select count(*) from pg_class c where c.relowner = r.oid)::int as owned_relations
  from pg_roles r where r.rolname = any($1) order by r.rolname`;

interface TableRow {
  oid: string;
  name: string;
  row_security: boolean;
  force_row_security: boolean;
  has_tenant_id: boolean;
  app_select: boolean;
  app_insert: boolean;
  app_update: boolean;
  app_delete: boolean;
  app_truncate: boolean;
  relay_select: boolean;
  relay_insert: boolean;
  relay_update: boolean;
  relay_delete: boolean;
  relay_truncate: boolean;
  bi_select: boolean;
  bi_insert: boolean;
  bi_update: boolean;
  bi_delete: boolean;
  bi_truncate: boolean;
}

/** Reads the catalog of the product schema through a privileged connection. */
export async function readCatalog(adminUrl: string): Promise<CatalogSnapshot> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const tables = (await client.query<TableRow>(TABLES_SQL, [SCHEMA, APP_ROLE, RELAY_ROLE, BI_ROLE])).rows;
    const policies = (
      await client.query<{ table_oid: string; name: string; permissive: boolean; command: string; roles: string[]; using_expr: string | null; check_expr: string | null }>(
        POLICIES_SQL,
        [SCHEMA],
      )
    ).rows;
    const idColumns = (await client.query<{ table_oid: string; column_name: string; indexed: boolean }>(ID_COLUMNS_SQL, [SCHEMA])).rows;
    const roles = (await client.query<{ name: string; superuser: boolean; bypass_rls: boolean; owned_relations: number }>(ROLES_SQL, [[...MACHVON_ROLES]])).rows;
    return {
      tables: tables.map((row) => ({
        name: row.name,
        hasTenantId: row.has_tenant_id,
        rowSecurity: row.row_security,
        forceRowSecurity: row.force_row_security,
        appPrivileges: { select: row.app_select, insert: row.app_insert, update: row.app_update, delete: row.app_delete, truncate: row.app_truncate },
        relayPrivileges: { select: row.relay_select, insert: row.relay_insert, update: row.relay_update, delete: row.relay_delete, truncate: row.relay_truncate },
        biPrivileges: { select: row.bi_select, insert: row.bi_insert, update: row.bi_update, delete: row.bi_delete, truncate: row.bi_truncate },
        policies: policies
          .filter((policy) => policy.table_oid === row.oid)
          .map((policy) => ({
            name: policy.name,
            permissive: policy.permissive,
            command: policy.command,
            roles: policy.roles,
            using: policy.using_expr,
            withCheck: policy.check_expr,
          })),
        idColumns: idColumns.filter((column) => column.table_oid === row.oid).map((column) => ({ column: column.column_name, indexed: column.indexed })),
      })),
      roles: roles.map((role) => ({ name: role.name, superuser: role.superuser, bypassRls: role.bypass_rls, ownedRelations: role.owned_relations })),
    };
  } finally {
    await client.end();
  }
}

export { NO_PRIVILEGES };
