import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { enumerateSweep, fill, implementedOperationIds, tableCandidates } from '../support/uat-sweep.ts';
import type { OpenApiDocument, SweepOperation } from '../support/uat-sweep.ts';
import { membershipOf, sql, stackInfo } from '../support/stack.ts';

/**
 * UAT of the critical slice, area `isolation-api` (docs/uat/critical/uat.json): tenant isolation seen from the API of the stack
 * (apps/api/test/e2e-stack) and from its database. The expected results are the design's: every operation of
 * Design/MACHVON_Design/03_Engineering/openapi.json that names an object by its id answers 404 RESOURCE_NOT_FOUND for the id of an object of
 * another tenant, the database refuses a row of another tenant, a member sees only what their scope covers. TC-UAT-NFR-TENANCY-05 and
 * TC-UAT-NFR-TENANCY-08 need what the stack lacks and are in not-executed.isolation-api.json.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const OPENAPI_PATH = resolve(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json');
const API_SOURCE = resolve(REPO_ROOT, 'apps', 'api', 'src');
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const PROJECT_B_ID = '2b000000-0000-4000-8000-000000000001';
const PROJECT_B_CODE = 'PRJ-B-001';
/** What only tenant B knows: its id, the code of its project, the name of its province and the codes of its units. */
const B_MARKERS = ['PRJ-B-001', 'Lào Cai', 'LC-HQ', 'LC-SKHDT'];
const DAY_MS = 86_400_000;

interface Reply {
  status: number;
  code: string;
  text: string;
}

const tenantA = (): string => stackInfo().tenants.A;
const tenantB = (): string => stackInfo().tenants.B;

/** The development token of the stack (the format the web session signs with): the member of a tenant, with a fresh second factor for the step-up commands. */
function tokenOf(tenantId: string, membershipId: string, scopeVersion = 1): string {
  const key = process.env.E2E_SESSION_KEY;
  if (key === undefined || key === '') throw new Error('E2E_SESSION_KEY is not set');
  const claims = { tenantId, membershipId, scopeVersion, exp: Math.floor(Date.now() / 1000) + 3600, aal: 'aal2', aal2At: new Date().toISOString() };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', Buffer.from(key, 'base64')).update(payload).digest('base64url')}`;
}

interface CallOptions {
  body?: unknown;
  versioned?: boolean;
}

async function call(request: APIRequestContext, token: string | undefined, method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (method !== 'get') headers['idempotency-key'] = `uat-${randomUUID()}`;
  if (options.versioned === true) headers['if-match'] = '"1"';
  const response = await request.fetch(`http://127.0.0.1:${stackInfo().apiPort}${path}`, {
    method: method.toUpperCase(),
    headers,
    data: method === 'get' ? undefined : JSON.stringify(options.body ?? {}),
  });
  const text = await response.text();
  let code = '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { code?: unknown }).code === 'string') code = (parsed as { code: string }).code;
  } catch {
    code = '';
  }
  return { status: response.status(), code, text };
}

const json = (reply: Reply): Record<string, unknown> => JSON.parse(reply.text) as Record<string, unknown>;

/** Runs statements through the superuser connection with the foreign keys and the triggers of ordinary rows off (the fixtures of the stack do the same). */
async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const [text, params] of statements) await client.query(text, params);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

const insertProject = (tenantId: string, id: string, code: string, name: string, unitId: string, areaId: string = randomUUID()): [string, unknown[]] => [
  `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
   values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
  [tenantId, id, code, name, unitId, areaId],
];

/** The area of the master data that the projects of tenant A name (a project whose area cannot be read is a server error when it is opened). */
async function areaOfA(): Promise<string> {
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenantA()]);
  if (area === undefined) throw new Error('tenant A has no area in its master data');
  return area.id;
}

/* -------------------------------------------------------------------------------------------------------------------------------------- */
/* The sweep of TC-UAT-NFR-TENANCY-01 and TC-SEC01: every operation with an object id in its path, aimed at an object of tenant B by tenant A. */
/* -------------------------------------------------------------------------------------------------------------------------------------- */

interface SweepRow {
  operationId: string;
  method: string;
  path: string;
  plane: string;
  idKind: 'object of B' | 'random uuid';
  status: number;
  code: string;
  leaked: string[];
}

interface SweepResult {
  rows: SweepRow[];
  /** Operations the API source declares but the running stack does not serve (an unauthenticated call finds no route). */
  notServed: string[];
  skipped: string[];
  clonedTables: string[];
  auditBefore: number;
  auditAfter: number;
  outboxBefore: number;
  outboxAfter: number;
  digestsBefore: Record<string, string>;
  digestsAfter: Record<string, string>;
}

const EXCLUDED_TABLE = /audit|outbox|idempotency/;

function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Gives tenant B one row of every kind of object tenant A has (the row of A with a new id and the tenant of B), so that an id in the path of an
 * operation can name an object of B of the kind the operation reads. Returns the ids of B by table.
 */
const createdInB: Array<[string, string]> = [];

async function giveBObjects(): Promise<Map<string, string>> {
  const made = new Map<string, string>();
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    const tables = (
      await client.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
          where s.nspname = 'machvon' and c.relkind = 'r'
            and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
            and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'id' and a.atttypid = 'uuid'::regtype and not a.attisdropped)
          order by c.relname`,
      )
    ).rows
      .map((row) => row.relname)
      .filter((name) => !EXCLUDED_TABLE.test(name));
    for (const table of tables) {
      const original = await client.query<{ j: Record<string, unknown> }>(`select to_jsonb(t) as j from machvon.${quoted(table)} t where t.tenant_id = $1 limit 1`, [tenantA()]);
      const row = original.rows[0]?.j;
      if (row === undefined) {
        continue;
      }
      const id = randomUUID();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        // The columns the database computes itself (generated ones) are left to it.
        const columns = (
          await client.query<{ attname: string }>(
            `select a.attname from pg_attribute a where a.attrelid = ('machvon.' || quote_ident($1))::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' order by a.attnum`,
            [table],
          )
        ).rows.map((column) => quoted(column.attname));
        await client.query(
          `insert into machvon.${quoted(table)} (${columns.join(', ')}) overriding system value select ${columns.join(', ')} from jsonb_populate_record(null::machvon.${quoted(table)}, $1::jsonb || jsonb_build_object('id', $2::text, 'tenant_id', $3::text))`,
          [JSON.stringify(row), id, tenantB()],
        );
        await client.query('commit');
        made.set(table, id);
        createdInB.push([table, id]);
      } catch {
        await client.query('rollback');
      }
    }
  } finally {
    await client.end();
  }
  return made;
}

async function removeBObjects(): Promise<void> {
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    for (const [table, id] of createdInB) {
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        await client.query(`delete from machvon.${quoted(table)} where tenant_id = $1 and id = $2`, [tenantB(), id]);
        await client.query('commit');
      } catch {
        await client.query('rollback');
      }
    }
  } finally {
    await client.end();
  }
}

async function digestsOfB(tables: Iterable<string>): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of tables) {
    const rows = await sql<{ d: string }>(`select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as d from machvon.${quoted(table)} t where t.tenant_id = $1`, [tenantB()]);
    result[table] = rows[0]?.d ?? '';
  }
  return result;
}

const rowsOfB = async (): Promise<{ audit: number; outbox: number }> => {
  const [audit] = await sql<{ n: number }>('select count(*)::int as n from machvon.audit_event where tenant_id = $1', [tenantB()]);
  const [outbox] = await sql<{ n: number }>('select count(*)::int as n from machvon.outbox_event where tenant_id = $1', [tenantB()]);
  return { audit: audit?.n ?? -1, outbox: outbox?.n ?? -1 };
};

let sweepPromise: Promise<SweepResult> | undefined;

async function runSweep(request: APIRequestContext): Promise<SweepResult> {
  const document = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDocument;
  const { operations, skipped } = enumerateSweep(document, implementedOperationIds(API_SOURCE));
  const owner = tokenOf(tenantA(), membershipOf('owner'));
  const unitB = stackInfo().units.B['LC-SKHDT'] ?? '';
  // The project the design names, with the code and the name that must never show up in an answer given to tenant A.
  await seed([insertProject(tenantB(), PROJECT_B_ID, PROJECT_B_CODE, 'Đường cao tốc Lào Cai PRJ-B-001', unitB)]);
  createdInB.push(['project', PROJECT_B_ID]);
  const made = await giveBObjects();
  made.set('project', PROJECT_B_ID);
  const tables = new Set(made.keys());
  const before = await rowsOfB();
  const digestsBefore = await digestsOfB(tables);

  const notServed: string[] = [];
  const served: SweepOperation[] = [];
  for (const operation of operations) {
    const probe = await call(request, undefined, operation.method, fill(operation, () => randomUUID()), { body: operation.body, versioned: operation.versioned });
    if (probe.status === 401) served.push(operation);
    else notServed.push(`${operation.operationId} (${probe.status})`);
  }

  const rows: SweepRow[] = [];
  const attack = async (operation: SweepOperation): Promise<void> => {
    let real = 0;
    const path = fill(operation, (slot) => {
      const table = tableCandidates(operation, slot).find((candidate) => made.has(candidate));
      if (table === undefined) return randomUUID();
      real += 1;
      return made.get(table) ?? randomUUID();
    });
    const query = operation.query.map((entry) => `${encodeURIComponent(entry.name)}=${encodeURIComponent(entry.value)}`).join('&');
    const reply = await call(request, owner, operation.method, query === '' ? path : `${path}?${query}`, { body: operation.body, versioned: operation.versioned });
    rows.push({
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      plane: operation.plane,
      idKind: real > 0 ? 'object of B' : 'random uuid',
      status: reply.status,
      code: reply.code,
      leaked: B_MARKERS.filter((marker) => reply.text.includes(marker)).concat(reply.text.includes(tenantB()) ? [tenantB()] : []),
    });
  };
  const batch = 8;
  for (let from = 0; from < served.length; from += batch) await Promise.all(served.slice(from, from + batch).map(attack));
  rows.sort((a, b) => (a.operationId < b.operationId ? -1 : 1));

  const after = await rowsOfB();
  return {
    rows,
    notServed,
    skipped: skipped.map((entry) => `${entry.operationId}: ${entry.reason}`),
    clonedTables: [...made.keys()],
    auditBefore: before.audit,
    auditAfter: after.audit,
    outboxBefore: before.outbox,
    outboxAfter: after.outbox,
    digestsBefore,
    digestsAfter: await digestsOfB(tables),
  };
}

const sweepOnce = (request: APIRequestContext): Promise<SweepResult> => (sweepPromise ??= runSweep(request));

const csvOf = (result: SweepResult): string =>
  ['operationId,method,path,plane,id_kind,status,code', ...result.rows.map((row) => [row.operationId, row.method, row.path, row.plane, row.idKind, row.status, row.code].join(','))].join('\n');

/* -------------------------------------------------------------------------------------------------------------------------------------- */
/* BI exports (TC-UAT-NFR-TENANCY-06, TC-BI02): a leader with the scope of two units, the figures of the projects of both, and the files made. */
/* -------------------------------------------------------------------------------------------------------------------------------------- */

interface BiWorld {
  leader: string;
  grantX: string;
  grantY: string;
  metric: string;
  period: string;
  /** The projects of the unit that stays in the scope (five) and of the unit whose grant is revoked (three). */
  projectsX: string[];
  projectsY: string[];
  cleanup: Array<[string, unknown[]]>;
}

const DATASET_CODE = 'DS-DISB';
const WORKER = '00000000-0000-4000-8000-000000000000';

/** The version of the scope of a member as the database holds it: a token that follows a change of scope carries the new one. */
async function scopeVersionOf(membershipId: string): Promise<number> {
  const [row] = await sql<{ v: string }>('select scope_version::text as v from machvon.membership where id = $1', [membershipId]);
  return Number(row?.v ?? '1');
}

/**
 * The leader u.a.ld of the design: a member whose role may query and export, with a grant over the subtree of two units that do not contain one another
 * (Sở Tài chính stands for Sở X and the Ban Quản lý dự án for Ban Y), five projects under the first and three under the second, a certified metric of
 * disbursement, a frozen close snapshot with a line for each project, the dataset version built over it through the API, and the policy that opens the dataset to the role.
 */
async function seedBiWorld(request: APIRequestContext): Promise<BiWorld> {
  const units = stackInfo().units.A;
  const unitX = units['CB-STC'] ?? '';
  const unitY = units['CB-SKHDT-QLDA'] ?? '';
  const suffix = randomUUID().slice(0, 8);
  const area = await areaOfA();
  const ids = { role: randomUUID(), leader: randomUUID(), grantX: randomUUID(), grantY: randomUUID(), metric: randomUUID(), policy: randomUUID(), period: randomUUID(), snapshot: randomUUID(), dataset: randomUUID() };
  const code = `UB${suffix}`;
  const projectsX = Array.from({ length: 5 }, () => randomUUID());
  const projectsY = Array.from({ length: 3 }, () => randomUUID());
  const owner = membershipOf('owner');
  const grant = (id: string, unit: string): [string, unknown[]] => [
    `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', 'UNIT_SUBTREE', $6::uuid[], 'Active', $7, 'uat fixture')`,
    [tenantA(), id, ids.leader, ids.role, JSON.stringify({ kind: 'UNIT_SUBTREE', ref_ids: [unit] }), [unit], ACTOR],
  ];
  const statements: Array<[string, unknown[]]> = [
    [
      "insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, $3, $3, $4, 30, 'Active', $5)",
      [tenantA(), ids.role, `UAT_BI_LEADER_${suffix}`, ['bi.query', 'drill_context.read', 'bi.export', 'bi.export.schedule'], ACTOR],
    ],
    ["insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, 'u.a.ld', 'Active')", [ids.leader, `uat-bi-${ids.leader}`, `${ids.leader}@example.test`]],
    ["insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $2, $3, 'Active', now() - interval '1 day')", [tenantA(), ids.leader, unitX]],
    grant(ids.grantX, unitX),
    grant(ids.grantY, unitY),
    [
      `insert into machvon.metric_definition (tenant_id, id, code, grain, aggregation_type, expression_ast, numerator_ast, denominator_ast, unit, null_policy, dimension_codes, effective_from, revision, owner_id, status, origin, source_commit, definition_sha256, certified_at, created_by)
       values ($1, $2, $3, 'project', 'additive', $4::jsonb, null, null, 'VND', 'NULL_NOT_ZERO', '[]'::jsonb, date '2026-01-01', 1, $5, 'CERTIFIED', 'PLATFORM_CODE', 'uat', repeat('d', 64), now(), $5)`,
      [tenantA(), ids.metric, `uat_disbursed_${suffix}`, JSON.stringify({ op: 'sum', args: [{ op: 'field', name: 'GIAI_NGAN' }] }), owner],
    ],
    [
      `insert into machvon.bi_dataset (tenant_id, id, dataset_code, title, source_kind, grain, join_paths, owner_user_id, created_by, updated_by, status)
       values ($1, $2, $3, 'Dataset', 'PERIOD_SNAPSHOT', 'project', $4::jsonb, $5, $5, $5, 'ACTIVE') on conflict do nothing`,
      [tenantA(), ids.dataset, DATASET_CODE, JSON.stringify({ dimensions: ['unit', 'fund'] }), owner],
    ],
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2035-01-01', date '2035-01-31', now(), $4, 'MONTH', 2035, 'OPEN', $5, $6, $6)`,
      [tenantA(), ids.period, code, `UAT-BI-${suffix}`, randomUUID(), WORKER],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2035-01-31', date '2035-01-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', 8, repeat('c', 64), $4::uuid, now(), $4::uuid, $4::uuid)`,
      [tenantA(), ids.snapshot, ids.period, WORKER],
    ],
  ];
  const lines: Array<[string, string]> = [...projectsX.map((id): [string, string] => [id, unitX]), ...projectsY.map((id): [string, string] => [id, unitY])];
  lines.forEach(([project, unit], index) => {
    statements.push(insertProject(tenantA(), project, `UATBI-${suffix}-${index}`, `Dự án BI ${index}`, unit, area));
    statements.push([
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, rate_null_reason, treasury_coverage)
       values ($1, gen_random_uuid(), $2, $3, $4, null, 'CURRENT_YEAR', 'CENTRAL', 10, 0, 10, $5::numeric, 'NO_DATA', 'COMPLETE')`,
      [tenantA(), ids.snapshot, project, unit, (index + 1) * 1_000_000],
    ]);
  });
  statements.push([
    `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
     values ($1, $2, (select id from machvon.bi_dataset where tenant_id = $1 and dataset_code = $3), 1, 'ROLE', $4, '{"op":"unit_in_scope"}'::jsonb, '{}'::jsonb, 'ACTIVE', $5, $6, $5)`,
    [tenantA(), ids.policy, DATASET_CODE, ids.role, owner, ACTOR],
  ]);
  await seed(statements);
  const [dataset] = await sql<{ id: string }>('select id from machvon.bi_dataset where tenant_id = $1 and dataset_code = $2', [tenantA(), DATASET_CODE]);
  const built = await call(request, tokenOf(tenantA(), owner), 'post', `/bi/datasets/${dataset?.id}/versions`, { body: { as_of_period: code } });
  expect(built.status, 'the dataset version is built').toBe(202);
  return {
    leader: ids.leader,
    grantX: ids.grantX,
    grantY: ids.grantY,
    metric: ids.metric,
    period: code,
    projectsX,
    projectsY,
    cleanup: [
      ['delete from machvon.bi_export_schedule where owner_user_id = $1', [ids.leader]],
      ['delete from machvon.bi_export_job where subject_user_id = $1', [ids.leader]],
      ['delete from machvon.bi_access_policy where id = $1', [ids.policy]],
      ['delete from machvon.bi_dataset_version where source_snapshot_id = $1', [ids.snapshot]],
      ['delete from machvon.period_snapshot_line where snapshot_id = $1', [ids.snapshot]],
      ['delete from machvon.period_snapshot where id = $1', [ids.snapshot]],
      ['delete from machvon.reporting_period where id = $1', [ids.period]],
      ['delete from machvon.project where id = any($1::uuid[])', [[...projectsX, ...projectsY]]],
      ['delete from machvon.metric_definition where id = $1', [ids.metric]],
      ['delete from machvon.role_grant where membership_id = $1', [ids.leader]],
      ['delete from machvon.membership where id = $1', [ids.leader]],
      ['delete from machvon.user_account where id = $1', [ids.leader]],
      ['delete from machvon.role_definition where id = $1', [ids.role]],
    ],
  };
}

/** Removes what a world made, statement by statement: a row that a guard of the database keeps is left and named, the rest goes. */
async function removeBiWorld(world: BiWorld): Promise<string[]> {
  const kept: string[] = [];
  for (const [text, params] of world.cleanup) {
    try {
      await seed([[text, params]]);
    } catch (error) {
      kept.push(`${text}: ${(error as Error).message}`);
    }
  }
  return kept;
}

const leaderToken = async (world: BiWorld): Promise<string> => tokenOf(tenantA(), world.leader, await scopeVersionOf(world.leader));

const exportBody = (world: BiWorld): Record<string, unknown> => ({ query_spec: { metric_version_id: world.metric, dimensions: ['project'] }, as_of_period: world.period, format: 'CSV' });

/** The text of the file of an export job, through the signed link the API gives its subject. */
async function fileOf(request: APIRequestContext, token: string, jobId: string): Promise<{ status: number; text: string }> {
  const shown = await call(request, token, 'get', `/bi/exports/${jobId}`);
  if (shown.status !== 200) return { status: shown.status, text: shown.text };
  const link = (json(shown).download as { url: string } | undefined)?.url;
  if (link === undefined) return { status: 200, text: '' };
  const response = await request.fetch(`http://127.0.0.1:${stackInfo().apiPort}${link}`);
  return { status: response.status(), text: await response.text() };
}

const idsIn = (text: string, ids: string[]): string[] => ids.filter((id) => text.includes(id));

test.afterAll(async () => {
  await removeBObjects();
});

test.describe('tenant isolation: the API and the database', () => {
  test('TC-UAT-NFR-TENANCY-01: every operation with an id answers 404 RESOURCE_NOT_FOUND for an object of tenant B and shows nothing of B', { tag: ['@P0', '@S1', '@isolation-api'] }, async ({ request }, testInfo) => {
    test.setTimeout(900_000);
    const result = await sweepOnce(request);
    await testInfo.attach('sweep-status-by-operation.csv', { body: csvOf(result), contentType: 'text/csv' });
    await testInfo.attach('sweep-not-served-and-skipped.txt', { body: `not served by the stack:\n${result.notServed.join('\n')}\n\nskipped:\n${result.skipped.join('\n')}`, contentType: 'text/plain' });

    const tenantOps = result.rows.filter((row) => row.plane === 'tenant');
    const controlOps = result.rows.filter((row) => row.plane !== 'tenant');
    // Enough of the API was really swept for the result to mean something.
    expect(tenantOps.length, 'tenant-plane operations swept').toBeGreaterThan(300);
    expect(tenantOps.filter((row) => row.idKind === 'object of B').length, 'operations aimed at a real object of tenant B').toBeGreaterThan(100);

    // 1. Every request of tenant A for an id of tenant B: 404 RESOURCE_NOT_FOUND.
    const notFound = tenantOps.filter((row) => row.status !== 404 || row.code !== 'RESOURCE_NOT_FOUND').map((row) => `${row.operationId} ${row.method.toUpperCase()} ${row.path} -> ${row.status} ${row.code} (${row.idKind})`);
    expect(notFound, 'operations that did not answer 404 RESOURCE_NOT_FOUND').toEqual([]);
    // The control plane refuses a tenant token by its plane (403) before any lookup.
    expect(controlOps.filter((row) => row.status !== 403 && row.status !== 404).map((row) => `${row.operationId} -> ${row.status} ${row.code}`), 'control-plane operations that did not refuse').toEqual([]);

    // 2. No answer carries the name or the code of the project of B, or anything else only B knows.
    expect(result.rows.filter((row) => row.leaked.length > 0).map((row) => `${row.operationId}: ${row.leaked.join(', ')}`), 'answers that carry data of B').toEqual([]);

    // 3. A search for the code of the project of B finds nothing and counts nothing.
    const search = await call(request, tokenOf(tenantA(), membershipOf('owner')), 'get', `/search?q=${PROJECT_B_CODE}`);
    expect(search.status).toBe(200);
    expect((json(search).items as unknown[]).length).toBe(0);
    expect(search.text).not.toContain(PROJECT_B_CODE);
    // The register of tenant A lists none of the projects of B either (a count of the page, no total of B behind it).
    const register = await call(request, tokenOf(tenantA(), membershipOf('owner')), 'get', '/resources/project?limit=200');
    expect(register.status).toBe(200);
    expect(register.text).not.toContain(PROJECT_B_CODE);
    expect(register.text).not.toContain(PROJECT_B_ID);

    // 4. The audit and the outbox of tenant B, and every row of B the sweep named, are the same after as before.
    expect(result.auditAfter - result.auditBefore, 'audit rows of tenant B added by the sweep').toBe(0);
    expect(result.outboxAfter - result.outboxBefore, 'outbox rows of tenant B added by the sweep').toBe(0);
    expect(result.digestsAfter).toEqual(result.digestsBefore);
    // The owner of B reads its own project, so the sweep did not run against an empty tenant.
    const own = await call(request, tokenOf(tenantB(), membershipOf('owner')), 'get', '/resources/project?limit=200');
    expect(own.status).toBe(200);
    expect((json(own).items as Array<{ id: string; code: string }>).filter((item) => item.id === PROJECT_B_ID).map((item) => item.code)).toEqual([PROJECT_B_CODE]);
  });

  test('TC-SEC01: tenant A reaching for the ids of tenant B through detail, search, export and file gets 403 or 404, no metadata, no count, no file, no side effect', { tag: ['@P0', '@S1', '@isolation-api'] }, async ({ request }, testInfo) => {
    test.setTimeout(900_000);
    const result = await sweepOnce(request);
    await testInfo.attach('sweep-status-by-operation.csv', { body: csvOf(result), contentType: 'text/csv' });
    const owner = tokenOf(tenantA(), membershipOf('owner'));

    // Every operation with an id: 403 or 404, and the answer is a problem with a registered code, never data.
    expect(result.rows.length, 'operations swept').toBeGreaterThan(300);
    const refused = result.rows.filter((row) => row.status !== 403 && row.status !== 404).map((row) => `${row.operationId} -> ${row.status} ${row.code}`);
    expect(refused, 'operations that were not refused').toEqual([]);
    // No metadata of B: no answer carries a marker of B, and the files and exports of the sweep gave no bytes.
    expect(result.rows.filter((row) => row.leaked.length > 0).map((row) => row.operationId), 'answers that carry data of B').toEqual([]);
    const channels = result.rows.filter((row) => /export|download|file|attachment/i.test(row.path));
    expect(channels.length, 'export, download and file operations swept').toBeGreaterThan(5);
    expect(channels.filter((row) => row.status !== 403 && row.status !== 404).map((row) => row.operationId)).toEqual([]);

    // Search: the code of the project of B is unknown to tenant A; the answer has no hit and no count.
    const search = await call(request, owner, 'get', `/search?q=${PROJECT_B_CODE}`);
    expect(search.status).toBe(200);
    expect(Object.keys(json(search)).sort()).toEqual(['items', 'next_cursor']);
    expect((json(search).items as unknown[]).length).toBe(0);
    // The export list of tenant A holds no job of B, and the download of an export of B is refused.
    const exports = await call(request, owner, 'get', '/bi/exports');
    expect(exports.status).toBe(200);
    expect(exports.text).not.toContain(tenantB());

    // No side effect: the rows of B did not move.
    expect(result.auditAfter).toBe(result.auditBefore);
    expect(result.outboxAfter).toBe(result.outboxBefore);
    expect(result.digestsAfter).toEqual(result.digestsBefore);
  });

  test('TC-UAT-NFR-TENANCY-02: no table with a tenant lacks row-level security, and the application role sees and writes only its own tenant', { tag: ['@P0', '@S1', '@isolation-api'] }, async () => {
    const unit = stackInfo().units.A['CB-SKHDT'] ?? '';
    const ids = { a: [randomUUID(), randomUUID(), randomUUID()], b: [randomUUID(), randomUUID()] };
    await seed([
      ...ids.a.map((id, index) => insertProject(tenantA(), id, `UAT02-A-${index}`, `Dự án A ${index}`, unit)),
      ...ids.b.map((id, index) => insertProject(tenantB(), id, `UAT02-B-${index}`, `Dự án B ${index}`, stackInfo().units.B['LC-SKHDT'] ?? '')),
    ]);
    try {
      // 1. The catalogue: every table of the schema that has a tenant_id has row-level security on and forced, and at least one policy.
      const [unprotected] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'machvon' AND c.relkind = 'r'
           AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity) AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`,
      );
      expect(unprotected?.n, 'tables with tenant_id lacking RLS or FORCE').toBe(0);
      const withoutPolicy = await sql<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'machvon' AND c.relkind = 'r'
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
           AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'machvon' AND p.tablename = c.relname)`,
      );
      expect(withoutPolicy.map((row) => row.relname), 'tables with tenant_id and no policy').toEqual([]);
      const [checked] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'machvon' AND c.relkind = 'r'
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`,
      );
      expect(checked?.n, 'tables the catalogue query looked at').toBeGreaterThan(50);

      // The application role is not a superuser, does not bypass row-level security and does not own the tables.
      const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean; owner: string }>(
        `SELECT r.rolsuper, r.rolbypassrls, (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'machvon' AND c.relname = 'project') AS owner
           FROM pg_roles r WHERE r.rolname = 'machvon_app'`,
      );
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      expect(role?.owner).not.toBe('machvon_app');

      // 2 to 4 run on one connection, as the application role (the superuser of the stack switches to it for the transaction).
      const client = new Client({ connectionString: stackInfo().adminUrl });
      await client.connect();
      try {
        const asApp = async <T>(work: () => Promise<T>): Promise<T> => {
          await client.query('begin');
          try {
            await client.query('set local role machvon_app');
            return await work();
          } finally {
            await client.query('rollback');
          }
        };
        // No tenant context: nothing is visible.
        const bare = await asApp(async () => (await client.query<{ n: number }>('select count(*)::int as n from machvon.project')).rows[0]?.n);
        expect(bare, 'rows visible with no tenant context').toBe(0);
        // The context of A: the count is that of A, three rows of this case among them, and none of B.
        const [adminCount] = await sql<{ n: number }>('select count(*)::int as n from machvon.project where tenant_id = $1', [tenantA()]);
        const asA = await asApp(async () => {
          await client.query("select set_config('app.tenant_id', $1, true)", [tenantA()]);
          const all = (await client.query<{ n: number }>('select count(*)::int as n from machvon.project')).rows[0]?.n;
          const ours = (await client.query<{ n: number }>("select count(*)::int as n from machvon.project where code like 'UAT02-%'")).rows[0]?.n;
          const foreign = (await client.query<{ n: number }>('select count(*)::int as n from machvon.project where tenant_id = $1', [tenantB()])).rows[0]?.n;
          return { all, ours, foreign };
        });
        expect(asA).toEqual({ all: adminCount?.n, ours: 3, foreign: 0 });
        // Under the context of A, a row for tenant B is refused by the policy.
        const refusal = await asApp(async () => {
          await client.query("select set_config('app.tenant_id', $1, true)", [tenantA()]);
          return client
            .query(
              `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
               values ($1, $2, 'UAT02-WRONG', 'Dự án sai tenant', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
              [tenantB(), randomUUID(), unit, randomUUID()],
            )
            .then(() => 'inserted')
            .catch((error: unknown) => (error as Error).message);
        });
        expect(refusal).toMatch(/new row violates row-level security policy/);
      } finally {
        await client.end();
      }
      const [leftover] = await sql<{ n: number }>("select count(*)::int as n from machvon.project where code = 'UAT02-WRONG'");
      expect(leftover?.n, 'rows the refused insert left').toBe(0);
    } finally {
      await seed([['delete from machvon.project where id = any($1::uuid[])', [[...ids.a, ...ids.b]]]]);
    }
  });

  test('TC-UAT-NFR-TENANCY-09: a member sees only the projects of their unit, and a guest contractor only their own contract', { tag: ['@P0', '@S1', '@isolation-api'] }, async ({ request }) => {
    const units = stackInfo().units.A;
    // The units of the stack stand in for the design's: Sở Tài chính for Sở NN, and the Ban Quản lý dự án under Sở Kế hoạch và Đầu tư for Ban QLDA GT.
    const unitNn = units['CB-STC'] ?? '';
    const unitGt = units['CB-SKHDT-QLDA'] ?? '';
    const suffix = randomUUID().slice(0, 8);
    const ids = {
      roleStaff: randomUUID(),
      roleGuest: randomUUID(),
      staff: randomUUID(),
      guest: randomUUID(),
      contractor: randomUUID(),
      projectNn: randomUUID(),
      projectGt: randomUUID(),
      packageId: randomUUID(),
      contracts: [randomUUID(), randomUUID(), randomUUID()],
    };
    const codes = { nn: `UAT09-NN-${suffix}`, gt: `UAT09-GT-${suffix}`, contracts: [1, 2, 3].map((n) => `UAT09-HD-A-00${n}-${suffix}`) };
    const grant = (membership: string, role: string, kind: string, refs: string[]): [string, unknown[]] => [
      `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', $6, $7::uuid[], 'Active', $8, 'uat fixture')`,
      [tenantA(), randomUUID(), membership, role, JSON.stringify({ kind, ref_ids: refs }), kind, refs, ACTOR],
    ];
    const account = (id: string): [string, unknown[]] => ['insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, $4, \'Active\')', [id, `uat09-${id}`, `${id}@example.test`, `UAT09 ${id.slice(0, 4)}`]];
    await seed([
      ...[
        [ids.roleStaff, `UAT09_STAFF_${suffix}`, ['project.read', 'contract.read', 'organization_unit.read'], false],
        [ids.roleGuest, `UAT09_GUEST_${suffix}`, ['contract.read'], true],
      ].map(
        ([id, code, permissions, guest]): [string, unknown[]] => [
          "insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by, guest_allowed) values ($1, $2, $3, $3, $4, 20, 'Active', $5, $6)",
          [tenantA(), id, code, permissions, ACTOR, guest],
        ],
      ),
      account(ids.staff),
      account(ids.guest),
      ["insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $2, $3, 'Active', now() - interval '1 day')", [tenantA(), ids.staff, unitNn]],
      [
        "insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from, membership_type, contractor_id, valid_until) values ($1, $2, $2, $3, 'Active', now() - interval '1 day', 'GUEST_CONTRACTOR', $4, $5)",
        [tenantA(), ids.guest, unitGt, ids.contractor, new Date(Date.now() + 30 * DAY_MS).toISOString()],
      ],
      grant(ids.staff, ids.roleStaff, 'UNIT_SUBTREE', [unitNn]),
      grant(ids.guest, ids.roleGuest, 'CONTRACT', [ids.contracts[0] ?? '']),
      ["insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, $3, 'Nhà thầu g.nt01', 'VERIFIED', $4)", [tenantA(), ids.contractor, String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)), randomUUID()]],
      insertProject(tenantA(), ids.projectNn, codes.nn, 'Dự án của Sở NN', unitNn, await areaOfA()),
      insertProject(tenantA(), ids.projectGt, codes.gt, 'Dự án của Ban QLDA GT', unitGt, await areaOfA()),
      ...ids.contracts.map(
        (id, index): [string, unknown[]] => [
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, completion_due)
           values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', 'ACTIVE', 1, 1000, date '2026-01-01', date '2026-01-01', current_date + 200)`,
          [tenantA(), id, ids.projectGt, ids.packageId, ids.contractor, codes.contracts[index]],
        ],
      ),
    ]);
    try {
      const staff = tokenOf(tenantA(), ids.staff);
      const guest = tokenOf(tenantA(), ids.guest);
      const expectedForStaff = await sql<{ code: string }>(
        `select p.code from machvon.project p join machvon.organization_unit u on u.id = p.owner_unit_id and u.tenant_id = p.tenant_id
          where p.tenant_id = $1 and u.path like (select path || '%' from machvon.organization_unit where id = $2) order by p.code`,
        [tenantA(), unitNn],
      );
      expect(expectedForStaff.map((row) => row.code)).toContain(codes.nn);

      // 1. The member of Sở NN lists only the projects of Sở NN; the project of Ban QLDA GT is 404, its code and name are not in the answer.
      const list = await call(request, staff, 'get', '/resources/project?limit=200');
      expect(list.status).toBe(200);
      const listed = (json(list).items as Array<{ code: string }>).map((item) => item.code).sort();
      expect(listed).toEqual(expectedForStaff.map((row) => row.code));
      expect(list.text).not.toContain(codes.gt);
      const foreign = await call(request, staff, 'get', `/resources/project/${ids.projectGt}`);
      expect(foreign).toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });
      expect(foreign.text).not.toContain(codes.gt);
      expect(foreign.text).not.toContain('Ban QLDA GT');
      const own = await call(request, staff, 'get', `/resources/project/${ids.projectNn}`);
      expect(own.status).toBe(200);
      expect(json(own).code).toBe(codes.nn);

      // 2. The guest contractor lists one contract (HD-A-001) and no other; HD-A-002 is 404; the project register is 403 SCOPE_DENIED.
      const contracts = await call(request, guest, 'get', '/resources/contract?limit=200');
      expect(contracts.status).toBe(200);
      expect((json(contracts).items as Array<{ code: string }>).map((item) => item.code)).toEqual([codes.contracts[0]]);
      expect(contracts.text).not.toContain(codes.contracts[1] ?? '');
      expect(contracts.text).not.toContain(codes.contracts[2] ?? '');
      const second = await call(request, guest, 'get', `/resources/contract/${ids.contracts[1]}`);
      expect(second).toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });
      expect(second.text).not.toContain(codes.contracts[1] ?? '');
      const first = await call(request, guest, 'get', `/resources/contract/${ids.contracts[0]}`);
      expect(first.status).toBe(200);
      expect(json(first).code).toBe(codes.contracts[0]);
      const projects = await call(request, guest, 'get', '/resources/project');
      expect(projects).toMatchObject({ status: 403, code: 'SCOPE_DENIED' });
    } finally {
      await seed([
        ['delete from machvon.contract where id = any($1::uuid[])', [ids.contracts]],
        ['delete from machvon.contractor where id = $1', [ids.contractor]],
        ['delete from machvon.project where id = any($1::uuid[])', [[ids.projectNn, ids.projectGt]]],
        ['delete from machvon.role_grant where membership_id = any($1::uuid[])', [[ids.staff, ids.guest]]],
        ['delete from machvon.membership where id = any($1::uuid[])', [[ids.staff, ids.guest]]],
        ['delete from machvon.user_account where id = any($1::uuid[])', [[ids.staff, ids.guest]]],
        ['delete from machvon.role_definition where id = any($1::uuid[])', [[ids.roleStaff, ids.roleGuest]]],
      ]);
    }
  });
  test('TC-BI02: after the scope of the requester narrows, the old export gives no link and a new one holds only what the old and the new scope both cover', { tag: ['@P0', '@S1', '@isolation-api'] }, async ({ request }) => {
    test.setTimeout(300_000);
    const world = await seedBiWorld(request);
    try {
      // An export asked without a session is refused.
      const anonymous = await call(request, undefined, 'post', '/bi/exports', { body: exportBody(world) });
      expect(anonymous.status).toBe(401);
      // The export saved under the old scope holds the eight projects of both units, and its owner is given the link.
      const wide = await call(request, await leaderToken(world), 'post', '/bi/exports', { body: exportBody(world) });
      expect(wide.status).toBe(200);
      expect(json(wide).row_count).toBe(8);
      const wideId = String(json(wide).resource_id);
      const wideFile = await fileOf(request, await leaderToken(world), wideId);
      expect(wideFile.status).toBe(200);
      expect(idsIn(wideFile.text, [...world.projectsX, ...world.projectsY])).toHaveLength(8);

      // The ACL changes: the administrator revokes the grant over Ban Y.
      const revoked = await call(request, tokenOf(tenantA(), membershipOf('owner')), 'post', `/role-grants/${world.grantY}/revoke`, { body: { reason: 'The leader leaves Ban Y' }, versioned: true });
      expect(revoked.status).toBe(200);

      // The permission is rechecked now: the old job is still a record, but its owner is given no link, and no figure of it is shown.
      const stale = await fileOf(request, await leaderToken(world), wideId);
      expect(stale.status).toBe(403);
      expect(JSON.parse(stale.text)).toMatchObject({ code: 'SCOPE_DENIED' });
      expect(idsIn(stale.text, world.projectsY)).toEqual([]);
      expect((await sql<{ status: string }>('select status from machvon.bi_export_job where id = $1', [wideId]))[0]?.status).toBe('READY');

      // A new export holds only the projects both scopes cover: the five of Sở X.
      const narrow = await call(request, await leaderToken(world), 'post', '/bi/exports', { body: exportBody(world) });
      expect(narrow.status).toBe(200);
      expect(json(narrow).row_count).toBe(5);
      const narrowFile = await fileOf(request, await leaderToken(world), String(json(narrow).resource_id));
      expect(narrowFile.status).toBe(200);
      const inBoth = idsIn(wideFile.text, world.projectsX);
      expect(idsIn(narrowFile.text, [...world.projectsX, ...world.projectsY]).sort()).toEqual(inBoth.sort());
      expect(idsIn(narrowFile.text, world.projectsY)).toEqual([]);
      expect(narrowFile.text).not.toContain('Ban Y');
      // The audit of each export names the scope it was made under, and the two are not the same scope.
      const hashOf = async (job: string): Promise<string | undefined> =>
        (await sql<{ safe_diff: { scope_hash?: string } }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'bi.export_request'", [job]))[0]?.safe_diff.scope_hash;
      const wideHash = await hashOf(wideId);
      const narrowHash = await hashOf(String(json(narrow).resource_id));
      expect(wideHash).toMatch(/^[0-9a-f]{16,}$/);
      expect(narrowHash).toMatch(/^[0-9a-f]{16,}$/);
      expect(narrowHash).not.toBe(wideHash);
    } finally {
      const kept = await removeBiWorld(world);
      test.info().annotations.push(...kept.map((description) => ({ type: 'left-behind', description })));
    }
  });

  test('TC-UAT-NFR-TENANCY-06: a scheduled export generated after the grant over Ban Y was revoked holds the five projects of Sở X only, none of Ban Y, and its audit row names a new scope hash', { tag: ['@P0', '@S1', '@isolation-api'] }, async ({ request }) => {
    test.setTimeout(420_000);
    const world = await seedBiWorld(request);
    try {
      const hashOf = async (job: string, action: string): Promise<string | undefined> =>
        (await sql<{ safe_diff: { scope_hash?: string } }>('select safe_diff from machvon.audit_event where resource_id = $1 and action = $2', [job, action]))[0]?.safe_diff.scope_hash;

      // The scope of the leader before the change: an export asked now holds the eight projects of both units, and its audit row names the scope it was made under.
      const wide = await call(request, await leaderToken(world), 'post', '/bi/exports', { body: exportBody(world) });
      expect(wide.status).toBe(200);
      expect(json(wide).row_count).toBe(8);
      const wideHash = await hashOf(String(json(wide).resource_id), 'bi.export_request');
      expect(wideHash).toMatch(/^[0-9a-f]{16,}$/);

      // Step 1: the leader makes a schedule of the export, daily (the job of the stack runs every two seconds and the schedule is due at the next minute but one, Vietnamese time: the time the job generates the file is after the revocation below).
      const due = new Date(Date.now() + 75_000);
      const vietnamese = new Date(due.getTime() + 7 * 3_600_000);
      const cron = `${vietnamese.getUTCMinutes()} ${vietnamese.getUTCHours()} * * *`;
      const schedule = await call(request, await leaderToken(world), 'post', '/bi/export-schedules', {
        body: { query_spec: { metric_version_id: world.metric, dimensions: ['project'], as_of_period: world.period }, cron, format: 'CSV', recipients: [world.leader] },
      });
      expect(schedule.status).toBe(200);
      const scheduleId = String(json(schedule).resource_id);
      const [stored] = await sql<{ owner_user_id: string; status: string; last_run_at: string | null }>('select owner_user_id, status, last_run_at::text as last_run_at from machvon.bi_export_schedule where id = $1', [scheduleId]);
      expect(stored).toEqual({ owner_user_id: world.leader, status: 'ACTIVE', last_run_at: null });

      // Step 2: the Tenant Admin revokes the grant over Ban Y before the schedule's time has come.
      const revoked = await call(request, tokenOf(tenantA(), membershipOf('owner')), 'post', `/role-grants/${world.grantY}/revoke`, { body: { reason: 'The leader leaves Ban Y' }, versioned: true });
      expect(revoked.status).toBe(200);
      expect((await sql('select 1 from machvon.bi_export_job where schedule_id = $1', [scheduleId])).length, 'no job was made before the time of the schedule').toBe(0);

      // Step 3: the job of the schedules runs (the worker of the stack, at the time of the schedule) and makes the file for the leader under the scope the leader has now.
      await expect
        .poll(async () => (await sql<{ status: string }>('select status from machvon.bi_export_job where schedule_id = $1', [scheduleId]))[0]?.status, { timeout: 180_000, intervals: [1_000, 2_000] })
        .toBeDefined();
      const jobs = await sql<{ id: string; status: string; row_count: number | null; subject_user_id: string; scope_hash: string | null }>(
        'select id, status, row_count, subject_user_id, scope_hash from machvon.bi_export_job where schedule_id = $1',
        [scheduleId],
      );
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job).toMatchObject({ status: 'READY', subject_user_id: world.leader, row_count: 5 });

      // Step 4: the file holds the five projects of Sở X and none of Ban Y.
      const file = await fileOf(request, await leaderToken(world), job?.id ?? '');
      expect(file.status).toBe(200);
      expect(idsIn(file.text, world.projectsX).sort()).toEqual([...world.projectsX].sort());
      expect(idsIn(file.text, world.projectsY)).toEqual([]);
      expect(file.text).not.toContain('Ban Y');

      // The audit of the job names the scope it was made under, and it is not the scope of the export made before the revocation; it is the scope an export asked now is made under.
      const jobHash = await hashOf(job?.id ?? '', 'bi.export_scheduled');
      expect(jobHash).toMatch(/^[0-9a-f]{16,}$/);
      expect(jobHash).not.toBe(wideHash);
      expect(job?.scope_hash).toBe(jobHash);
      const now = await call(request, await leaderToken(world), 'post', '/bi/exports', { body: exportBody(world) });
      expect(json(now).row_count).toBe(5);
      expect(await hashOf(String(json(now).resource_id), 'bi.export_request')).toBe(jobHash);
    } finally {
      const kept = await removeBiWorld(world);
      test.info().annotations.push(...kept.map((description) => ({ type: 'left-behind', description })));
    }
  });
});
