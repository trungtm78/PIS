import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedSnapshot } from '../../../../packages/db/test/support/dgv-quality-fixtures';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';
import { UatWorld } from '../uat/uat-world';
import { assertWithinBudget, measureP95 } from './support';

/**
 * Cases of docs/uat/int/uat.json that the suite `../uat/int.uat.test.ts` does not script: the certified datasets of the open interface (closed until the organisation opens them for a certified product, closed again by
 * themselves when the certification is revoked) and the database login of a BI tool (a password shown once, one tenant, no base table, no write). Each case is named by its id in the title of its test.
 */
jest.setTimeout(240_000);

const REASON = 'The ministry asked for this change in writing.';
const INT_ALL = ['int.account.read', 'int.account.manage', 'int.access.read', 'int.dataset.read', 'int.dataset.manage', 'int.bi.read', 'int.bi.manage', 'int.codes.read', 'int.codes.propose', 'int.codes.approve', 'int.system.manage'];
const PERSONAS = { 'int-admin': INT_ALL, 'int-reader': ['int.account.read', 'int.dataset.read', 'int.bi.read'] };
const LINES_A = 3;
const LINES_B = 2;
const LINES_PERF = 100_000;

describe('UAT cases of the open interface that the suite of the area does not script (INT)', () => {
  const world = new UatWorld();
  const clients: Client[] = [];

  beforeAll(async () => {
    await world.start(PERSONAS, { 'int-admin': INT_ALL }, async (w) => {
      for (const tenant of [TENANT_A, TENANT_B]) {
        await dropSnapshotFixtureKeys(w.harness, tenant);
        await seedSnapshot(w.harness, tenant, 1, { lines: Array.from({ length: tenant === TENANT_A ? LINES_A : LINES_B }, () => ({})) });
      }
    });
  }, 300_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    await world.stop();
  }, 60_000);

  async function open(url: string, bearer: string): Promise<Reply> {
    const response = await fetch(`${world.app.baseUrl}${url}`, { headers: { authorization: `Bearer ${bearer}` } });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  async function machine(name: string, scopes: string[], tenantB = false, rate = 60): Promise<string> {
    const body = { name, scopes, rate_limit_per_minute: rate };
    const made = tenantB ? await world.asTenantB(1, 'POST', '/int/machine-accounts', { body }) : await world.as('int-admin', 'POST', '/int/machine-accounts', { body });
    assertStatus(made, 201);
    const response = await fetch(`${world.app.baseUrl}/open/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: made.json.client_id, client_secret: made.json.client_secret }),
    });
    return ((await response.json()) as { access_token: string }).access_token;
  }

  /** A data product of a tenant, certified until 2099 by a person other than its owner, or only provisional. */
  async function product(tenant: string, code: string, status: 'CERTIFIED' | 'PROVISIONAL' = 'CERTIFIED'): Promise<string> {
    const productId = randomUUID();
    await world.rows(
      `insert into machvon.data_product (tenant_id, id, code, title, dataset_ids, owner_user_id, certification_status, certified_by, certified_at, certification_expires_on, evidence_refs, created_by, updated_by)
       values ($1, $2, $3, $3, $4::jsonb, $5, $6, $7, now(), date '2099-01-01', '["evidence-1"]', $5, $5)`,
      [tenant, productId, code, JSON.stringify([randomUUID()]), memberId(1), status, status === 'CERTIFIED' ? memberId(2) : null],
      tenant,
    );
    return productId;
  }

  const dataset = async (): Promise<{ dataset_code: string; enabled: boolean; version: number; product_id: string | null; gate: { open: boolean } }> =>
    ((await world.as('int-reader', 'GET', '/int/export-datasets')).json.items as Array<{ dataset_code: string; enabled: boolean; version: number; product_id: string | null; gate: { open: boolean } }>).find((item) => item.dataset_code === 'DS-DISB') as {
      dataset_code: string;
      enabled: boolean;
      version: number;
      product_id: string | null;
      gate: { open: boolean };
    };
  const switchOn = (version: number, productId: string): Promise<Reply> => world.as('int-admin', 'POST', '/int/export-datasets/state', { ifMatch: version, body: { dataset_code: 'DS-DISB', enabled: true, product_id: productId, reason: REASON } });
  /** The dataset of tenant A is open for a certified product: as it is, or switched on for a new one. */
  async function ensureOpen(tenant: string): Promise<void> {
    const own = await dataset();
    if (!own.gate.open) assertStatus(await switchOn(own.version, await product(tenant, `DP-UAT-OPEN-${randomUUID().slice(0, 6)}`)), 200);
  }
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  it('UAT-INT-DST-01 a dataset is closed with its reason until the organisation opens it, is refused for a provisional product, serves the frozen lines for a certified one, closes by itself when the certification is revoked, and reopens only for a certified product', async () => {
    const token = await machine('Dataset reader of the UAT', ['open.disbursement.read']);
    const weak = await product(TENANT_A, 'DP-UAT-WEAK', 'PROVISIONAL');
    const strong = await product(TENANT_A, 'DP-UAT-STRONG');

    // Step 1: closed, and the reason is told.
    const listed = await open('/open/v1/datasets', token);
    assertStatus(listed, 200);
    expect(items(listed).find((item) => item.dataset_code === 'DS-DISB')).toMatchObject({ open: false, reason: 'DISABLED' });
    const closed = await open('/open/v1/disbursement-lines', token);
    assertStatus(closed, 403, 'OPEN_DATASET_NOT_CERTIFIED');
    expect(closed.json).toMatchObject({ reason: 'DISABLED' });

    // Step 2: a provisional product does not open it.
    const first = await dataset();
    expect(first).toMatchObject({ enabled: false, product_id: null, gate: { open: false } });
    const refused = await switchOn(first.version, weak);
    assertStatus(refused, 422, 'OPEN_DATASET_NOT_CERTIFIED');
    expect(refused.json).toMatchObject({ reason: 'NOT_CERTIFIED' });
    expect(await dataset()).toMatchObject({ enabled: false, version: first.version });
    assertStatus(await open('/open/v1/disbursement-lines', token), 403, 'OPEN_DATASET_NOT_CERTIFIED');

    // Step 3: a certified product opens it, and the lines served are the frozen lines of this tenant.
    const on = await switchOn(first.version, strong);
    assertStatus(on, 200);
    expect(on.json).toMatchObject({ status: 'ENABLED' });
    const lines = await open('/open/v1/disbursement-lines?limit=200', token);
    assertStatus(lines, 200);
    expect(items(lines)).toHaveLength(LINES_A);
    expect(new Set(items(lines).map((line) => line.tenant_id))).toEqual(new Set([TENANT_A]));
    expect(items(lines).every((line) => line.certification_expires_on === '2099-01-01')).toBe(true);

    // Step 4: the certification is revoked and the dataset is closed by itself, the switch of the organisation unchanged.
    await world.rows("update machvon.data_product set certification_status = 'REVOKED', revoke_reason = 'Revoked for the UAT of the open interface' where id = $1", [strong]);
    const shut = await open('/open/v1/disbursement-lines', token);
    assertStatus(shut, 403, 'OPEN_DATASET_NOT_CERTIFIED');
    expect(shut.json).toMatchObject({ reason: 'NOT_CERTIFIED' });
    expect(items(await open('/open/v1/datasets', token)).find((item) => item.dataset_code === 'DS-DISB')).toMatchObject({ open: false });
    expect(await dataset()).toMatchObject({ enabled: true, gate: { open: false } });

    // Step 5: switching it on again for the revoked product is refused; switching it off and on for a certified product opens it again.
    const current = await dataset();
    assertStatus(await switchOn(current.version, strong), 422, 'OPEN_DATASET_NOT_CERTIFIED');
    assertStatus(await open('/open/v1/disbursement-lines', token), 403, 'OPEN_DATASET_NOT_CERTIFIED');
    const fresh = await product(TENANT_A, 'DP-UAT-FRESH');
    const off = await world.as('int-admin', 'POST', '/int/export-datasets/state', { ifMatch: current.version, body: { dataset_code: 'DS-DISB', enabled: false, reason: REASON } });
    assertStatus(off, 200);
    assertStatus(await switchOn(off.json.resource_version as number, fresh), 200);
    expect(items(await open('/open/v1/disbursement-lines?limit=200', token))).toHaveLength(LINES_A);
  });

  it('UAT-INT-BI-01 a BI login is made with a password shown once and kept in no table, reads the catalogue and the lines of its own tenant only, even when it names the other tenant, is refused every base table, and may write nothing', async () => {
    const login = async (tenant: string): Promise<{ client: Client; name: string; password: string; readerId: string }> => {
      const body = { name: `Power BI of ${tenant.slice(-1)}`, tool: 'Power BI', connection_limit: 3 };
      const made = tenant === TENANT_A ? await world.as('int-admin', 'POST', '/int/bi-readers', { body }) : await world.asTenantB(1, 'POST', '/int/bi-readers', { body });
      assertStatus(made, 201);
      expect(made.json).toMatchObject({ shown_once: true, status: 'ACTIVE', schema_name: 'machvon_bi' });
      const password = made.json.password as string;
      const name = made.json.login_name as string;
      // Step 1: the password is in no table, whatever the tenant.
      for (const table of ['int_bi_reader', 'int_bi_reader_event', 'idempotency_record', 'audit_event', 'outbox_event']) {
        const found = await world.rows<{ n: string }>(`select count(*)::text as n from machvon.${table} t where to_jsonb(t)::text like '%' || $1 || '%'`, [password], tenant);
        expect([table, found[0]?.n]).toEqual([table, '0']);
      }
      // Step 2: the login opens a connection to the database.
      const url = new URL(world.harness.database.urlFor('machvon_app'));
      url.username = name;
      url.password = password;
      const client = new Client({ connectionString: url.toString() });
      client.on('error', () => undefined);
      await client.connect();
      clients.push(client);
      return { client, name, password, readerId: made.json.reader_id as string };
    };
    const a = await login(TENANT_A);
    const b = await login(TENANT_B);
    expect(a.name).not.toBe(b.name);
    // Both tenants open the dataset for a certified product, so each login has lines to read.
    await ensureOpen(TENANT_A);
    const bDataset = ((await world.asTenantB(1, 'GET', '/int/export-datasets')).json.items as Array<{ dataset_code: string; version: number }>).find((item) => item.dataset_code === 'DS-DISB') as { version: number };
    assertStatus(await world.asTenantB(1, 'POST', '/int/export-datasets/state', { ifMatch: bDataset.version, body: { dataset_code: 'DS-DISB', enabled: true, product_id: await product(TENANT_B, 'DP-UAT-BI-B'), reason: REASON } }), 200);

    // Step 3: the views answer with the rows of the tenant of the login and no other.
    const count = async (client: Client, view: string): Promise<number> => ((await client.query(`select 1 from ${view}`)).rows as unknown[]).length;
    expect(await count(a.client, 'v_disbursement_lines')).toBe(LINES_A);
    expect(await count(b.client, 'v_disbursement_lines')).toBe(LINES_B);
    const catalogue = (await a.client.query('select dataset_code, is_open from v_dataset_catalogue order by dataset_code')).rows as Array<{ dataset_code: string; is_open: boolean }>;
    expect(catalogue.find((row) => row.dataset_code === 'DS-DISB')).toMatchObject({ is_open: true });
    // A login that names the other tenant in its own setting reads nothing of it, and nothing of its own either: the binding of the login decides, not the setting.
    await a.client.query("select set_config('app.tenant_id', $1, false)", [TENANT_B]);
    expect(await count(a.client, 'v_disbursement_lines')).toBe(0);
    await a.client.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
    expect(await count(a.client, 'v_disbursement_lines')).toBe(LINES_A);

    // The base tables are closed to it, whichever it asks for.
    for (const table of ['machvon.project', 'machvon.period_snapshot_line', 'machvon.audit_event', 'machvon.int_bi_reader', 'machvon_bi.reader_binding']) {
      await expect(a.client.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
    }

    // Step 4: it writes nothing, to a table or to a view, and the rows are as they were. The login is read-only; it is also told to try as a writer, and the privileges refuse it.
    await a.client.query("set default_transaction_read_only = off").catch(() => undefined);
    await expect(a.client.query(`insert into machvon.project (tenant_id, id, code, name) values ($1, $2, 'BI-WRITE', 'BI-WRITE')`, [TENANT_A, randomUUID()])).rejects.toThrow(/permission denied|read-only transaction|cannot (update|insert into|delete from) view/);
    await expect(a.client.query('update machvon.period_snapshot_line set plan_total_vnd = 1')).rejects.toThrow(/permission denied|read-only transaction|cannot (update|insert into|delete from) view/);
    await expect(a.client.query('delete from machvon.period_snapshot_line')).rejects.toThrow(/permission denied|read-only transaction|cannot (update|insert into|delete from) view/);
    await expect(a.client.query('update machvon_bi.v_disbursement_lines set plan_total_vnd = 1')).rejects.toThrow(/permission denied|read-only transaction|cannot (update|insert into|delete from) view/);
    await expect(a.client.query(`insert into machvon_bi.v_dataset_catalogue (dataset_code) values ('X')`)).rejects.toThrow(/permission denied|read-only transaction|cannot (update|insert into|delete from) view/);
    expect(await world.rows("select 1 from machvon.project where code = 'BI-WRITE'")).toEqual([]);
    expect(await count(a.client, 'v_disbursement_lines')).toBe(LINES_A);
  });

  it('UAT-INT-PRF-01 the open API serves a page of 200 disbursement lines within 5 seconds at the p95 on a tenant with 100,000 frozen lines', async () => {
    await ensureOpen(TENANT_A);
    const token = await machine('Performance reader of the UAT', ['open.disbursement.read'], false, 600);
    // One frozen close snapshot of 100,000 lines, written in one statement (the lines of a frozen snapshot are the ones the open API serves).
    const snapshotId = randomUUID();
    await world.seedAsAdmin([
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, gen_random_uuid(), 'PERIOD_CLOSE', now(), current_date, current_date, 'FROZEN', 'v1', 'PROPOSED_PENDING_SIGNOFF', $3, repeat('b', 64), $4, now(), $4, $4)`,
        [TENANT_A, snapshotId, LINES_PERF, memberId(1)],
      ],
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, ctmtqg_subset_vnd, rate_total_pct, treasury_coverage)
         select $1, gen_random_uuid(), $2, gen_random_uuid(), $3, 'CURRENT_YEAR', 'CENTRAL', 1000, 0, 1000, 500, 50, 'COMPLETE' from generate_series(1, $4::int)`,
        [TENANT_A, snapshotId, unitId(1), LINES_PERF],
      ],
    ]);
    expect((await world.rows<{ n: string }>('select count(*)::text as n from machvon.period_snapshot_line where snapshot_id = $1', [snapshotId]))[0]?.n).toBe(String(LINES_PERF));
    const page = await open('/open/v1/disbursement-lines?limit=200', token);
    assertStatus(page, 200);
    expect(items(page)).toHaveLength(200);
    expect(typeof page.json.next_cursor).toBe('string');
    const measured = await measureP95(world, () => open('/open/v1/disbursement-lines?limit=200', token), 5000);
    assertWithinBudget(measured);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403, 'OPEN_DATASET_NOT_CERTIFIED'));
    expectCheckFails(() => assertStatus({ status: 403, json: { code: 'OPEN_SCOPE_DENIED' } }, 403, 'OPEN_DATASET_NOT_CERTIFIED'));
    expectCheckFails(() => assertWithinBudget({ p95Ms: 6000, budgetMs: 5000, failures: 0 }));
  });
});
