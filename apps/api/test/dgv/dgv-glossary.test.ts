import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { DgvCatalogController, DgvDatasetController } from '../../src/modules/dgv/dgv-dataset.controller';
import { DgvGlossaryController } from '../../src/modules/dgv/dgv-glossary.controller';
import { dgvModule } from '../../src/modules/dgv';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const STEWARD = 1; // data.catalog.manage and data.catalog.read
const OWNER = 2; // owns the datasets; reads the catalogue
const READER = 3; // data.catalog.read only
const NOBODY = 4; // no right over the catalogue
const B_STEWARD = 6; // of tenant B

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Binding {
  id: string;
  column_name: string | null;
  term: { id: string; term_code: string; revision: number; status: string };
  deprecated: boolean;
  successor: { id: string; revision: number } | null;
  replaced: boolean;
  bound_by: { membership_id: string; display_name: string | null };
}

describe('the glossary bound to the datasets (ST-DGV-007, DGV 3.1, DGV-02)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let dataset = '';
  let hidden = '';
  let termR1 = '';
  let termR2 = '';
  let draftTerm = '';

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const bind = (member: number, datasetId: string, payload: Record<string, unknown>, tenantId?: string): Promise<Reply> => call('POST', `/dgv/datasets/${datasetId}/glossary-bindings`, { member, body: payload, ...(tenantId === undefined ? {} : { tenantId }) });
  const bindings = (member: number, datasetId: string, tenantId?: string): Promise<Reply> => call('GET', `/dgv/datasets/${datasetId}/glossary-bindings`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const items = (reply: Reply): Binding[] => reply.json.items as Binding[];

  async function seedDataset(code: string, classification: string, owner: number): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
       values ($1, $2, $3, $3, 'TREASURY', 'one row per payment order', 'PAY', $4, $5, $6, false, 86400, 'DRAFT', $5, $5)`,
      [TENANT_A, id, code, memberId(owner), memberId(STEWARD), classification],
    );
    return id;
  }

  /** A revision of a term in the state given, with the facts that state carries (a proposer other than the steward who approves and publishes it). */
  async function seedTerm(code: string, revision: number, status: string): Promise<string> {
    const id = randomUUID();
    const decided = !['DRAFT', 'IN_REVIEW'].includes(status);
    const approved = ['APPROVED', 'PUBLISHED', 'DEPRECATED'].includes(status);
    const published = ['PUBLISHED', 'DEPRECATED'].includes(status);
    await rows(
      `insert into machvon.glossary_term (tenant_id, id, term_code, term_vi, definition, domain, owner_membership_id, revision, status, approved_by, decided_by, decided_at, published_by, published_at, effective_from, created_by, updated_by)
       values ($1, $2, $3, 'Giải ngân lũy kế', 'The cumulative disbursement of a project up to a date', 'TREASURY', $4, $5, $6,
               $7, $8, case when $9::boolean then now() end, $10, case when $11::boolean then now() end, case when $11::boolean then current_date end, $12, $12)`,
      [TENANT_A, id, code, memberId(STEWARD), revision, status, approved ? memberId(STEWARD) : null, decided ? memberId(STEWARD) : null, decided, published ? memberId(STEWARD) : null, published, memberId(OWNER)],
    );
    return id;
  }

  /** The step MDM takes when it publishes a revision: the one in force before it is deprecated, in the same transaction. The guard of the table is out of the way: this is only the state the step leaves. */
  async function publishRevision(deprecated: string, published: string): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query("update machvon.glossary_term set status = 'DEPRECATED' where id = $1::uuid", [deprecated]);
      await client.query(
        "update machvon.glossary_term set status = 'PUBLISHED', approved_by = $2::uuid, decided_by = $2::uuid, decided_at = now(), published_by = $2::uuid, published_at = now(), effective_from = current_date where id = $1::uuid",
        [published, memberId(STEWARD)],
      );
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [STEWARD, OWNER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, B_STEWARD, 1);
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', ['data.catalog.manage', 'data.catalog.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_READER', ['data.catalog.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'DATA_STEWARD', ['data.catalog.manage', 'data.catalog.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_STEWARD, role: 1, kind: 'TENANT' }]);
    dataset = await seedDataset('DS-GLOSSARY', 'INTERNAL', OWNER);
    // A dataset only its owner and steward may see: the reader neither reads its glossary nor binds to it.
    hidden = await seedDataset('DS-CONFIDENTIAL', 'CONFIDENTIAL', OWNER);
    termR1 = await seedTerm('GIAI_NGAN_LUY_KE', 1, 'PUBLISHED');
    termR2 = await seedTerm('GIAI_NGAN_LUY_KE', 2, 'IN_REVIEW');
    draftTerm = await seedTerm('DRAFT_TERM', 1, 'DRAFT');
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DgvDatasetController, DgvCatalogController, DgvGlossaryController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of DGV', () => {
    expect(dgvModule.controllers).toEqual(expect.arrayContaining([DgvGlossaryController]));
  });

  it('UAT-AC490: binding a revision that is IN_REVIEW is 422 GLOSSARY_TERM_NOT_PUBLISHED, binding the PUBLISHED one succeeds, and once the newer revision publishes the read warns of the deprecated binding and offers it', async () => {
    const early = await bind(STEWARD, dataset, { glossary_term_id: termR2, column_name: 'cumulative_amount' });
    expect([early.status, early.json.code]).toEqual([422, 'GLOSSARY_TERM_NOT_PUBLISHED']);
    expect(await rows('select 1 from machvon.dataset_glossary_binding')).toEqual([]);
    const first = await bind(STEWARD, dataset, { glossary_term_id: termR1, column_name: 'cumulative_amount' });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: 'BOUND', resource_version: 1, existing: false });
    expect(await rows('select dataset_id, column_name, glossary_term_id, bound_by from machvon.dataset_glossary_binding where id = $1::uuid', [first.json.resource_id])).toEqual([
      { dataset_id: dataset, column_name: 'cumulative_amount', glossary_term_id: termR1, bound_by: memberId(STEWARD) },
    ]);
    const before = await bindings(READER, dataset);
    expect(items(before)).toHaveLength(1);
    expect(items(before)[0]).toMatchObject({ column_name: 'cumulative_amount', deprecated: false, successor: null, replaced: false, term: { id: termR1, term_code: 'GIAI_NGAN_LUY_KE', revision: 1, status: 'PUBLISHED' }, bound_by: { membership_id: memberId(STEWARD) } });
    expect(before.json.coverage).toEqual({ bound: 1, deprecated: 0, terms: 1 });
    // The newer revision publishes: MDM deprecates the one before it in the same step.
    await publishRevision(termR1, termR2);
    const after = await bindings(READER, dataset);
    expect(items(after)[0]).toMatchObject({ deprecated: true, successor: { id: termR2, revision: 2 }, term: { revision: 1, status: 'DEPRECATED' } });
    expect(after.json.coverage).toEqual({ bound: 1, deprecated: 1, terms: 1 });
    // Binding what is deprecated is refused; binding the revision in force replaces the old binding for the column, which stays as history.
    const old = await bind(STEWARD, dataset, { glossary_term_id: termR1, column_name: 'other_column' });
    expect([old.status, old.json.code]).toEqual([422, 'GLOSSARY_TERM_NOT_PUBLISHED']);
    const next = await bind(STEWARD, dataset, { glossary_term_id: termR2, column_name: 'cumulative_amount' });
    expect(next.status).toBe(200);
    const replaced = await bindings(READER, dataset);
    expect(items(replaced).map((line) => [line.term.revision, line.replaced, line.deprecated])).toEqual([[2, false, false], [1, true, true]]);
    expect(replaced.json.coverage).toEqual({ bound: 1, deprecated: 0, terms: 1 });
  });

  it('names the binding of the newest revision as the one in force whatever the clock says of when each was bound', async () => {
    const column = 'cumulative_amount';
    await rows(
      `update machvon.dataset_glossary_binding set bound_at = bound_at - interval '1 day' where dataset_id = $1::uuid and column_name = $2 and glossary_term_id = $3::uuid`,
      [dataset, column, termR2],
    );
    const lines = items(await bindings(READER, dataset)).filter((line) => line.column_name === column);
    expect(lines.map((line) => [line.term.revision, line.replaced])).toEqual([[1, true], [2, false]]);
    const read = await bindings(READER, dataset);
    expect(read.json.coverage).toMatchObject({ deprecated: 0 });
  });

  it('audits and announces a binding once, and binding what is bound again writes nothing and announces nothing', async () => {
    const column = 'budget_code';
    const made = await bind(STEWARD, dataset, { glossary_term_id: termR2, column_name: column });
    expect(made.json.existing).toBe(false);
    const again = await bind(STEWARD, dataset, { glossary_term_id: termR2, column_name: column });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, resource_id: made.json.resource_id });
    expect(await rows('select 1 from machvon.dataset_glossary_binding where dataset_id = $1::uuid and column_name = $2', [dataset, column])).toHaveLength(1);
    const audit = await rows<{ safe_diff: Record<string, unknown>; actor_id: string }>(`select safe_diff, actor_id from machvon.audit_event where action = 'dgv.glossary_bound' and resource_id = $1`, [made.json.resource_id]);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]).toMatchObject({ actor_id: memberId(STEWARD), safe_diff: { dataset_id: dataset, dataset_code: 'DS-GLOSSARY', column_name: column, term_code: 'GIAI_NGAN_LUY_KE', revision: 2, existing: false } });
    const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'dgv.glossary.bound.v1' and aggregate_id = $1`, [made.json.resource_id]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual(expect.objectContaining({ dataset_id: dataset, column_name: column, term_code: 'GIAI_NGAN_LUY_KE', revision: 2 }));
  });

  it('answers both callers when the same binding is made at once under different keys: one writes it, the other finds it, and one event is announced', async () => {
    const [one, two] = await Promise.all([bind(STEWARD, dataset, { glossary_term_id: termR2, column_name: 'race_column' }), bind(STEWARD, dataset, { glossary_term_id: termR2, column_name: 'race_column' })]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect([one.json.existing, two.json.existing].sort()).toEqual([false, true]);
    expect(one.json.resource_id).toBe(two.json.resource_id);
    expect(await rows('select 1 from machvon.dataset_glossary_binding where dataset_id = $1::uuid and column_name = $2', [dataset, 'race_column'])).toHaveLength(1);
    expect(await rows(`select 1 from machvon.outbox_event where type = 'dgv.glossary.bound.v1' and aggregate_id = $1`, [one.json.resource_id])).toHaveLength(1);
  });

  it('binds a term to the dataset as a whole when no column is named, and one term to several columns', async () => {
    const whole = await bind(STEWARD, dataset, { glossary_term_id: termR2 });
    expect(whole.status).toBe(200);
    expect((await bind(STEWARD, dataset, { glossary_term_id: termR2 })).json.existing).toBe(true);
    const lines = items(await bindings(STEWARD, dataset));
    expect(lines.filter((line) => line.column_name === null)).toHaveLength(1);
    expect(new Set(lines.filter((line) => !line.replaced).map((line) => line.column_name)).size).toBeGreaterThanOrEqual(3);
  });

  it('refuses what is not a binding: a term that is not published or does not exist, a column that is too long or empty (422), nothing is written', async () => {
    const before = (await rows<{ n: string }>('select count(*)::text as n from machvon.dataset_glossary_binding'))[0]?.n;
    const notPublished = await bind(STEWARD, dataset, { glossary_term_id: draftTerm });
    expect([notPublished.status, notPublished.json.code]).toEqual([422, 'GLOSSARY_TERM_NOT_PUBLISHED']);
    const missing = await bind(STEWARD, dataset, { glossary_term_id: randomUUID() });
    expect([missing.status, missing.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    for (const column of ['', ' '.repeat(3), 'x'.repeat(121)]) {
      const reply = await bind(STEWARD, dataset, { glossary_term_id: termR2, column_name: column });
      expect([column.length, reply.status >= 400 && reply.status <= 422]).toEqual([column.length, true]);
    }
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.dataset_glossary_binding'))[0]?.n).toBe(before);
  });

  it('shows a dataset only to those who may see it, binds only for those who manage the catalogue, and nothing of another tenant', async () => {
    expect((await bind(READER, dataset, { glossary_term_id: termR2 })).status).toBe(403);
    expect((await bind(NOBODY, dataset, { glossary_term_id: termR2 })).status).toBe(403);
    expect((await bindings(NOBODY, dataset)).status).toBe(403);
    const confidential = await bind(STEWARD, hidden, { glossary_term_id: termR2 });
    expect(confidential.status).toBe(200);
    // The reader holds the right to read the catalogue but is not on the allowed roles of a confidential dataset: it does not exist for them.
    expect((await bindings(READER, hidden)).status).toBe(404);
    expect((await bindings(OWNER, hidden)).status).toBe(200);
    expect((await bindings(STEWARD, randomUUID())).status).toBe(404);
    expect((await bind(B_STEWARD, dataset, { glossary_term_id: termR2 }, TENANT_B)).status).toBe(404);
    expect((await bindings(B_STEWARD, dataset, TENANT_B)).status).toBe(404);
  });

  it('is kept by the database as well: a binding is never edited or deleted by the application, one revision binds once to a column, and a term outside the tenant cannot be named', async () => {
    const attempt = async (sql: string, params: unknown[] = []): Promise<string> => {
      try {
        await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(STEWARD), scopeVersion: 0 }, (tx) => tx.query(sql, params));
        return 'written';
      } catch (error) {
        return (error as { message: string }).message;
      }
    };
    expect(await attempt("update machvon.dataset_glossary_binding set column_name = 'x'")).toContain('permission denied');
    expect(await attempt('delete from machvon.dataset_glossary_binding')).toContain('permission denied');
    expect(await rows('select 1 from machvon.dataset_glossary_binding').then((found) => found.length > 0)).toBe(true);
    expect(
      await rows(`insert into machvon.dataset_glossary_binding (tenant_id, id, dataset_id, column_name, glossary_term_id, bound_by) values ($1, $2, $3, 'cumulative_amount', $4, $5)`, [TENANT_A, randomUUID(), dataset, termR2, memberId(STEWARD)]).then(
        () => 'written',
        (error: { message: string }) => error.message,
      ),
    ).toContain('dataset_glossary_binding_uq');
    expect(
      await rows(`insert into machvon.dataset_glossary_binding (tenant_id, id, dataset_id, column_name, glossary_term_id, bound_by) values ($1, $2, $3, 'x', $4, $5)`, [TENANT_A, randomUUID(), dataset, randomUUID(), memberId(STEWARD)]).then(
        () => 'written',
        (error: { message: string }) => error.message,
      ),
    ).toContain('foreign key constraint');
  });
});
