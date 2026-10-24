import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { loadCommittedMigrations } from '../src/generate-migrations';
import { migrate } from '../src/migrate';
import { startTestDatabase } from '../src/test-database';
import type { TestDatabase } from '../src/test-database';

// ST-CAP-002 TK-CAP-002-1: a database that holds plan versions in the legacy shape (no capital plan, no audit columns, lines without a
// project) is upgraded by V1362: the versions join the capital plan of their (fiscal year, decision, revision), the lines take their project,
// and what the register of appropriations could not give them stays empty instead of being invented. The migration runs as the owner role, to
// which row-level security applies, so the test also proves that it reaches the rows of every tenant.
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TENANT = '00000000-0000-4000-8000-00000000000a';
const EMPTY_TENANT = '00000000-0000-4000-8000-00000000000b';
const WORKER = '00000000-0000-4000-8000-000000000000';
const ROOT = '00000000-0000-4000-8000-0000000000a1';
const CHILD = '00000000-0000-4000-8000-0000000000a2';
const MAKER = '00000000-0000-4000-8000-0000000000f1';
const MIGRATION = 'V1362__cap1_capital_plan_drafting';

describe('V1362: the capital plans of the legacy plan versions (TK-CAP-002-1)', () => {
  let database: TestDatabase;
  let admin: Client;
  const documents = { existing: randomUUID(), other: randomUUID(), missing: randomUUID() };
  const versions: Record<string, string> = {};
  const lines: Record<string, string> = {};

  const run = async (text: string, params: unknown[] = []) => (await admin.query(text, params)).rows;

  async function legacyVersion(name: string, year: number, decision: string, revision: number, status: string, tenant = TENANT): Promise<void> {
    const id = randomUUID();
    const projectId = randomUUID();
    versions[name] = id;
    await run(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, created_by, updated_by)
       values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'CONCEPT', 1, $6, $6)`,
      [tenant, projectId, `P-${name}`, ROOT, randomUUID(), MAKER],
    );
    await run(
      `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at)
       values ($1, $2, $3, $4, $5, $6, $7, '2025-02-01T00:00:00Z')`,
      [tenant, id, projectId, year, revision, decision, status],
    );
    const lineId = randomUUID();
    lines[name] = lineId;
    await run(
      `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd)
       values ($1, $2, $3, $4, 'CURRENT_YEAR', $5, 1000, 0)`,
      [tenant, lineId, id, randomUUID(), year],
    );
  }

  beforeAll(async () => {
    const migrations = await loadCommittedMigrations(REPO_ROOT);
    const index = migrations.findIndex((migration) => migration.name === MIGRATION);
    expect(index).toBeGreaterThan(2);
    database = await startTestDatabase();
    await migrate(database.adminUrl, migrations.slice(0, index), { profile: 'test' });
    admin = new Client({ connectionString: database.adminUrl });
    await admin.connect();
    await run("select set_config('app.tenant_id', $1, false)", [TENANT]);
    // The rows of the old shape are written without the foreign keys (the projects and sources they name are not part of what is tested).
    await run('set session_replication_role = replica');
    await run(`insert into machvon.tenant (id, code, name, status, placement_id, region) values
      ($1, 'T-A', 'Tenant A', 'Active', $3, 'vn'), ($2, 'T-B', 'Tenant B', 'Active', $3, 'vn')`, [TENANT, EMPTY_TENANT, randomUUID()]);
    await run(`insert into machvon.organization_unit (tenant_id, id, code, name, parent_id, valid_from, path, depth) values
      ($1, $2, 'ROOT', 'Root', null, date '2026-01-01', '/${ROOT}/', 0),
      ($1, $3, 'CHILD', 'Child', $2, date '2026-01-01', '/${ROOT}/${CHILD}/', 1)`, [TENANT, ROOT, CHILD]);
    for (const id of [documents.existing, documents.other]) {
      await run(
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2025-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [TENANT, id, `QD-${id.slice(0, 6)}`, MAKER],
      );
    }
    // 2025 / decision A: revision 1 published, revision 2 published (the older one is superseded), two projects in revision 1.
    await legacyVersion('a1-first', 2025, documents.existing, 1, 'PUBLISHED');
    await legacyVersion('a1-second', 2025, documents.existing, 1, 'PUBLISHED');
    await legacyVersion('a2', 2025, documents.existing, 2, 'PUBLISHED');
    // 2026 / a decision that is no document: it cannot make a plan published.
    await legacyVersion('b', 2026, documents.missing, 1, 'PUBLISHED');
    // 2026 / decision B: two versions in different states are a draft.
    await legacyVersion('c-draft', 2026, documents.other, 1, 'DRAFT');
    await legacyVersion('c-approved', 2026, documents.other, 1, 'APPROVED');
    // 2027 / decision B: a single approved version.
    await legacyVersion('d', 2027, documents.other, 1, 'APPROVED');
    // A tenant without a unit has no root unit to give a plan to: its versions stay as they were.
    await legacyVersion('orphan', 2025, documents.existing, 1, 'APPROVED', EMPTY_TENANT);
    await run('set session_replication_role = origin');
    await migrate(database.adminUrl, migrations.slice(0, index + 1), { profile: 'test' });
  }, 240_000);

  afterAll(async () => {
    await admin?.end();
    if (database) await database.stop();
  }, 60_000);

  const planOf = async (name: string) =>
    (
      await run(
        `select cp.plan_code, cp.plan_kind, cp.plan_year, cp.period_from_year, cp.period_to_year, cp.scope_unit_id, cp.revision, cp.status, cp.decision_document_id, cp.created_by
           from machvon.plan_version pv join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id where pv.id = $1`,
        [versions[name]],
      )
    )[0];

  it('gives each (fiscal year, decision, revision) one annual capital plan at the root unit, and links the versions to it', async () => {
    const first = await planOf('a1-first');
    expect(first).toMatchObject({ plan_kind: 'ANNUAL', plan_year: 2025, period_from_year: 2025, period_to_year: 2025, scope_unit_id: ROOT, revision: 1, decision_document_id: documents.existing, created_by: WORKER });
    expect(first.plan_code).toBe(`LEGACY-2025-${documents.existing}`);
    expect((await planOf('a1-second')).plan_code).toBe(first.plan_code);
    expect(await run("select count(*)::int as n from machvon.capital_plan where tenant_id = $1 and plan_code like 'LEGACY-%'", [TENANT])).toEqual([{ n: 5 }]);
    expect(await run('select count(distinct capital_plan_id)::int as n from machvon.plan_version where tenant_id = $1', [TENANT])).toEqual([{ n: 5 }]);
  });

  it('keeps one published revision of a code: the older revision is superseded, the newer stays published', async () => {
    expect((await planOf('a1-first')).status).toBe('SUPERSEDED');
    expect((await planOf('a2')).status).toBe('PUBLISHED');
    expect((await planOf('a2')).revision).toBe(2);
  });

  it('does not let a decision that is no document of the tenant publish a plan, and does not invent the state of a mixed plan', async () => {
    expect(await planOf('b')).toMatchObject({ status: 'APPROVED', decision_document_id: null });
    expect(await planOf('c-draft')).toMatchObject({ status: 'DRAFT', decision_document_id: documents.other });
    expect((await planOf('c-approved')).plan_code).toBe((await planOf('c-draft')).plan_code);
    expect(await planOf('d')).toMatchObject({ status: 'APPROVED', plan_year: 2027 });
  });

  it('names the system as the author of the rows that had none, and gives the lines their project', async () => {
    const versionRows = await run('select created_by, updated_by from machvon.plan_version where id = $1', [versions['a1-first']]);
    expect(versionRows).toEqual([{ created_by: WORKER, updated_by: WORKER }]);
    const legacyLine = await run('select al.project_id, pv.project_id as version_project, al.created_by, al.updated_by, al.appropriation_id, al.budget_level, al.origin from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where al.id = $1', [
      lines['a1-first'],
    ]);
    expect(legacyLine[0]).toMatchObject({ created_by: WORKER, updated_by: WORKER, appropriation_id: null, budget_level: null, origin: null });
    expect(legacyLine[0]?.project_id).toBe(legacyLine[0]?.version_project);
  });

  it('leaves the versions of a tenant without a unit as they were', async () => {
    const orphan = await run('select capital_plan_id, created_by from machvon.plan_version where id = $1', [versions.orphan]);
    expect(orphan).toEqual([{ capital_plan_id: null, created_by: null }]);
    expect(await run('select 1 from machvon.capital_plan where tenant_id = $1', [EMPTY_TENANT])).toEqual([]);
  });

  it('starts the guards from the migrated rows: a line of a published plan is not edited, a superseded plan does not change, a plan is not deleted by the runtime role', async () => {
    await run('select set_config($1, $2, false)', ['app.tenant_id', TENANT]);
    const refuse = async (text: string, params: unknown[] = []): Promise<string | undefined> => {
      try {
        await run(text, params);
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    // The version of the first project is now bound to a SUPERSEDED plan; its own status is the legacy PUBLISHED, so the line is frozen.
    expect(await refuse('update machvon.allocation_line set amount_vnd = 5 where id = $1', [lines['a1-first']])).toBe('23514');
    expect(await refuse('delete from machvon.allocation_line where id = $1', [lines['a1-first']])).toBe('23514');
    expect(await refuse("update machvon.capital_plan set status = 'APPROVED' where id = (select capital_plan_id from machvon.plan_version where id = $1)", [versions['a1-first']])).toBe('23514');
    const app = new Client({ connectionString: database.urlFor('machvon_app') });
    await app.connect();
    try {
      await app.query("select set_config('app.tenant_id', $1, false)", [TENANT]);
      await expect(app.query('delete from machvon.capital_plan')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
  });
});
