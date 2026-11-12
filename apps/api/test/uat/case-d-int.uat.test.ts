import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedSnapshot } from '../../../../packages/db/test/support/dgv-quality-fixtures';
import type { Doc } from './case-d-support';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * The design cases of the open interface that no suite named (docs/uat/int/uat.json): INT-001 (a machine account of one tenant, its scope, a suspension while it holds a token, the rotation of its secret and the rate
 * limit), INT-002 (the certified views read by the BI logins of two tenants, the tenant a login cannot change, and the certification that is revoked) and INT-003 (the code of a project in another system, proposed
 * by one person and approved by another). The world is the whole enterprise edition over a real database; the logins of BI tools are real roles of the database, read with real connections.
 */
jest.setTimeout(600_000);

const FAMILY = 0x9c;
const REASON = 'The ministry asked for this change in writing.';
const INT_ALL = ['int.account.read', 'int.account.manage', 'int.access.read', 'int.dataset.read', 'int.dataset.manage', 'int.bi.read', 'int.bi.manage', 'int.codes.read', 'int.codes.propose', 'int.codes.approve', 'int.system.manage'];
const PERSONAS = {
  'int-admin': INT_ALL,
  'int-checker': ['int.codes.read', 'int.codes.approve'],
  'int-reader': ['int.account.read', 'int.access.read', 'int.dataset.read', 'int.bi.read', 'int.codes.read'],
  'int-certifier': ['data.product.certify', 'int.dataset.read'],
};

describe('UAT cases of the open interface (INT-001, INT-002, INT-003)', () => {
  const world = new UatWorld();
  const clients: Client[] = [];
  const productOf: Record<string, string> = {};

  beforeAll(async () => {
    await world.start(PERSONAS, { 'int-admin': INT_ALL }, async (w) => {
      for (const [tenant, code] of [[TENANT_A, 'UAT-INTC-A1'], [TENANT_A, 'UAT-INTC-A2'], [TENANT_B, 'UAT-INTC-B1']] as const) {
        await w.seedAsAdmin([
          [
            `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, created_by, updated_by)
             values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B', $6, $6)`,
            [tenant, randomUUID(), code, unitId(ROOT_UNIT), id(FAMILY, 1), memberId(1)],
          ],
        ]);
      }
      // A frozen close snapshot for each tenant (three lines for A, two for B): the rows the certified views are made of.
      for (const tenant of [TENANT_A, TENANT_B]) await dropSnapshotFixtureKeys(w.harness, tenant);
      await seedSnapshot(w.harness, TENANT_A, 1, { lines: [{}, {}, {}] });
      await seedSnapshot(w.harness, TENANT_B, 1, { lines: [{}, {}] });
      // The data product behind the dataset of each tenant, certified: no command registers a product (the register of products is read by DGV, whose certification needs a published contract and a quality run).
      for (const tenant of [TENANT_A, TENANT_B]) {
        productOf[tenant] = randomUUID();
        await w.seedAsAdmin([
          [
            `insert into machvon.data_product (tenant_id, id, code, title, dataset_ids, owner_user_id, certification_status, certified_by, certified_at, certification_expires_on, evidence_refs, created_by, updated_by)
             values ($1, $2, 'DP-DISB', 'Disbursement', $3::jsonb, $4, 'CERTIFIED', $5, now(), date '2099-01-01', '["evidence-1"]', $4, $4)`,
            [tenant, productOf[tenant], JSON.stringify([randomUUID()]), memberId(1), memberId(2)],
          ],
        ]);
      }
    });
  }, 600_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    await world.stop();
  }, 60_000);

  /** A call of the open API: no session of a person, only a bearer token (or none). */
  async function open(method: string, url: string, options: { bearer?: string; body?: unknown } = {}): Promise<Reply & { headers: Headers }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
    const response = await fetch(`${world.app.baseUrl}${url}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: response.headers };
  }

  const exchange = (clientId: string, clientSecret: string): Promise<Reply> => open('POST', '/open/v1/token', { body: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret } });

  async function machine(name: string, scopes: string[], extra: Record<string, unknown> = {}): Promise<{ id: string; clientId: string; secret: string; token: string; version: number }> {
    const made = await world.as('int-admin', 'POST', '/int/machine-accounts', { body: { name, scopes, ...extra } });
    assertStatus(made, 201);
    const issued = await exchange(made.json.client_id as string, made.json.client_secret as string);
    assertStatus(issued, 200);
    return { id: made.json.account_id as string, clientId: made.json.client_id as string, secret: made.json.client_secret as string, token: issued.json.access_token as string, version: made.json.resource_version as number };
  }

  const logOf = (accountId: string): Promise<Array<{ operation: string; outcome: string; status: number; path: string; query_keys: string[] }>> =>
    world.rows('select operation, outcome, status, path, query_keys from machvon.int_access_log where account_id = $1 order by occurred_at, id', [accountId]);
  const decide = (accountId: string, version: number, decision: string): Promise<Reply> => world.as('int-admin', 'POST', `/int/machine-accounts/${accountId}/decision`, { ifMatch: version, body: { decision, reason: REASON } });

  it('UAT-INT-001 an account reads the projects of its own tenant and is refused the contracts it has no scope for, a suspension stops its live token at once, a rotated secret is shown once and is in no audit row, event or stored answer, and the third call in a minute of an account limited to two is refused with Retry-After, every call leaving a row of the log with the names of the parameters', async () => {
    // Step 1: the projects of its own tenant only, then the dataset it has no scope for.
    const reader = await machine('Power BI reader', ['open.projects.read']);
    const projects = await open('GET', '/open/v1/projects?limit=200', { bearer: reader.token });
    assertStatus(projects, 200);
    expect((projects.json.items as Array<{ code: string }>).map((item) => item.code).sort()).toEqual(expect.arrayContaining(['UAT-INTC-A1', 'UAT-INTC-A2']));
    expect(JSON.stringify(projects.json)).not.toContain('UAT-INTC-B1');
    assertStatus(await open('GET', '/open/v1/projects?status=SECRET-FILTER-VALUE', { bearer: reader.token }), 200);
    const denied = await open('GET', '/open/v1/contract-lines', { bearer: reader.token });
    assertStatus(denied, 403, 'OPEN_SCOPE_DENIED');
    expect(denied.json).toMatchObject({ required_scope: 'open.contracts.read' });
    // Step 2: the account is suspended while its token is alive: the very next call is refused, and a reactivation restores it.
    assertStatus(await decide(reader.id, reader.version, 'SUSPEND'), 200);
    assertStatus(await open('GET', '/open/v1/projects', { bearer: reader.token }), 401, 'OPEN_CLIENT_INVALID');
    assertStatus(await exchange(reader.clientId, reader.secret), 401, 'OPEN_CLIENT_INVALID');
    assertStatus(await decide(reader.id, reader.version + 1, 'REACTIVATE'), 200);
    assertStatus(await open('GET', '/open/v1/projects', { bearer: reader.token }), 200);
    // Step 3: the secret is rotated; the new one is shown once and neither of them is in an audit row, an event or an answer that is stored.
    const key = `uat-${randomUUID()}`;
    const rotated = await world.as('int-admin', 'POST', `/int/machine-accounts/${reader.id}/rotate`, { ifMatch: reader.version + 2, key, body: { reason: REASON, grace_hours: 1 } });
    assertStatus(rotated, 200);
    expect(rotated.json).toMatchObject({ shown_once: true, account_id: reader.id });
    const fresh = rotated.json.client_secret as string;
    expect(fresh).toMatch(/^mvs_[A-Za-z0-9_-]{43}$/);
    const replay = await world.as('int-admin', 'POST', `/int/machine-accounts/${reader.id}/rotate`, { ifMatch: reader.version + 2, key, body: { reason: REASON, grace_hours: 1 } });
    assertStatus(replay, 200);
    expect(replay.json.client_secret).toBe('');
    for (const secret of [fresh, reader.secret]) {
      for (const table of ['int_machine_credential', 'int_machine_account', 'idempotency_record', 'audit_event', 'outbox_event', 'int_access_log']) {
        const found = await world.rows<{ n: string }>(`select count(*)::text as n from machvon.${table} t where to_jsonb(t)::text like '%' || $1 || '%'`, [secret]);
        expect([table, found[0]?.n]).toEqual([table, '0']);
      }
    }
    expect((await world.audits(reader.id, 'int.machine_account_secret_rotated')).length + (await world.audits(reader.id, 'int.machine_account_rotated')).length).toBeGreaterThanOrEqual(1);
    assertStatus(await exchange(rotated.json.client_id as string, fresh), 200);
    // Step 4: an account limited to two calls a minute: the third is refused with Retry-After, and the refusal is a row of the log too.
    const slow = await machine('Two per minute', ['open.projects.read'], { rate_limit_per_minute: 2 });
    assertStatus(await open('GET', '/open/v1/projects?limit=1', { bearer: slow.token }), 200);
    assertStatus(await open('GET', '/open/v1/projects?limit=2', { bearer: slow.token }), 200);
    const refused = await open('GET', '/open/v1/projects?limit=3', { bearer: slow.token });
    assertStatus(refused, 429, 'RATE_LIMIT');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(refused.headers.get('x-ratelimit-limit')).toBe('2');
    const slowLog = await logOf(slow.id);
    expect(slowLog.filter((entry) => entry.path === '/open/v1/projects').map((entry) => [entry.outcome, entry.status])).toEqual([['OK', 200], ['OK', 200], ['RATE_LIMITED', 429]]);
    expect(slowLog.filter((entry) => entry.path === '/open/v1/projects').every((entry) => entry.query_keys.includes('limit'))).toBe(true);
    // Every call of the first account is a row of the log with the names of the parameters and never their values.
    const readerLog = await logOf(reader.id);
    const logged = readerLog.map((entry) => [entry.operation, entry.outcome, entry.status, entry.query_keys]);
    expect(logged).toContainEqual(['listOpenProjects', 'OK', 200, ['limit']]);
    expect(logged).toContainEqual(['listOpenProjects', 'OK', 200, ['status']]);
    expect(readerLog.some((entry) => entry.operation === 'listOpenContractLines' && entry.outcome === 'DENIED_SCOPE' && entry.status === 403)).toBe(true);
    expect(readerLog.some((entry) => entry.outcome === 'DENIED_CLIENT' && entry.status === 401)).toBe(true);
    expect(JSON.stringify(readerLog)).not.toContain('SECRET-FILTER-VALUE');
    expect(readerLog.every((entry) => !entry.path.includes('?'))).toBe(true);
  });

  it('UAT-INT-002 each BI login reads the certified views of its own tenant only, setting another tenant in the session shows no row of the views and none of the tables, and revoking the certification of the product closes the dataset at once with the reason NOT_CERTIFIED', async () => {
    const issue = async (member: 'A' | 'B'): Promise<{ client: Client; reader: Record<string, unknown> }> => {
      const made = member === 'A' ? await world.as('int-admin', 'POST', '/int/bi-readers', { body: { name: 'Power BI of A', tool: 'Power BI', connection_limit: 3 } }) : await world.asTenantB(1, 'POST', '/int/bi-readers', { body: { name: 'Power BI of B', tool: 'Power BI', connection_limit: 3 } });
      assertStatus(made, 201);
      const url = new URL(world.harness.database.urlFor('machvon_app'));
      url.username = made.json.login_name as string;
      url.password = made.json.password as string;
      const client = new Client({ connectionString: url.toString() });
      client.on('error', () => undefined);
      await client.connect();
      clients.push(client);
      return { client, reader: made.json };
    };
    const switchOn = async (member: 'A' | 'B'): Promise<void> => {
      const tenant = member === 'A' ? TENANT_A : TENANT_B;
      const body = { dataset_code: 'DS-DISB', enabled: true, product_id: productOf[tenant], reason: REASON };
      const reply = member === 'A' ? await world.as('int-admin', 'POST', '/int/export-datasets/state', { ifMatch: 1, body }) : await world.asTenantB(1, 'POST', '/int/export-datasets/state', { ifMatch: 1, body });
      assertStatus(reply, 200);
      expect(reply.json).toMatchObject({ status: 'ENABLED' });
    };
    await switchOn('A');
    await switchOn('B');
    const a = await issue('A');
    const b = await issue('B');
    const lines = async (client: Client): Promise<Array<Doc>> => (await client.query('select to_jsonb(v) as line from v_disbursement_lines v')).rows.map((row) => row.line as Doc);
    // Step 1: each login reads its own tenant only.
    const ofA = await lines(a.client);
    const ofB = await lines(b.client);
    expect([ofA.length, ofB.length]).toEqual([3, 2]);
    expect(JSON.stringify(ofA)).not.toContain(TENANT_B);
    expect(JSON.stringify(ofB)).not.toContain(TENANT_A);
    expect(((await a.client.query('select dataset_code, is_open from v_dataset_catalogue order by dataset_code')).rows as Array<{ dataset_code: string; is_open: boolean }>).map((row) => [row.dataset_code, row.is_open])).toContainEqual(['DS-DISB', true]);
    // Step 2: the login of A names tenant B in its session: no row of the views, and the tables are not readable at all.
    await a.client.query("select set_config('app.tenant_id', $1, false)", [TENANT_B]);
    expect(await lines(a.client)).toEqual([]);
    for (const table of ['machvon.project', 'machvon.period_snapshot_line', 'machvon.period_snapshot']) await expect(a.client.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
    await a.client.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
    expect(await lines(a.client)).toHaveLength(3);
    // Step 3: the certification of the product is revoked by the command of the certifier; the dataset is closed at once, for the open API and for the BI login, with the reason.
    const watcher = await machine('Dataset reader', ['open.disbursement.read']);
    assertStatus(await open('GET', '/open/v1/disbursement-lines?limit=5', { bearer: watcher.token }), 200);
    const product = (await world.rows<{ version: string }>('select version::text from machvon.data_product where id = $1::uuid', [productOf[TENANT_A]]))[0];
    const revoked = await world.as('int-certifier', 'POST', `/dgv/data-products/${productOf[TENANT_A]}/certification`, { ifMatch: Number(product?.version), body: { decision: 'REVOKED', reason: 'The quality of the figures was challenged', evidence_refs: [] } });
    assertStatus(revoked, 200);
    expect(revoked.json).toMatchObject({ status: 'REVOKED' });
    const closed = await open('GET', '/open/v1/disbursement-lines?limit=5', { bearer: watcher.token });
    assertStatus(closed, 403, 'OPEN_DATASET_NOT_CERTIFIED');
    expect(closed.json).toMatchObject({ reason: 'NOT_CERTIFIED' });
    const catalogue = (await open('GET', '/open/v1/datasets', { bearer: watcher.token })).json.items as Array<{ dataset_code: string; open: boolean; reason: string | null }>;
    expect(catalogue.find((entry) => entry.dataset_code === 'DS-DISB')).toMatchObject({ open: false, reason: 'NOT_CERTIFIED' });
    expect(await lines(a.client)).toEqual([]);
    expect(((await a.client.query('select dataset_code, is_open from v_dataset_catalogue order by dataset_code')).rows as Array<{ dataset_code: string; is_open: boolean }>).map((row) => [row.dataset_code, row.is_open])).toContainEqual(['DS-DISB', false]);
    // The other tenant is not touched.
    expect(await lines(b.client)).toHaveLength(2);
  });

  it('UAT-INT-003 a code of a project in another system proposed by one person is refused when the same person approves it (403 SELF_APPROVAL_DENIED), is ACTIVE on master_crosswalk when another approves it, and the same code for another project and a second code for the same project are refused (409 CROSSWALK_DUPLICATE) while a code outside the format is refused (422)', async () => {
    const registered = await world.as('int-admin', 'POST', '/int/source-systems', { body: { code: 'ERPX', name: 'The ERP of the ministry', kind: 'ERP', code_pattern: 'P-\\d{3}' } });
    assertStatus(registered, 201);
    const mine = 'UAT-INTC-A1';
    const other = 'UAT-INTC-A2';
    const crosswalk = (): Promise<Array<{ external_code: string; status: string; project: string }>> =>
      world.rows("select x.external_code, x.status, p.code as project from machvon.master_crosswalk x join machvon.project p on p.id = x.subject_id where x.source_system = 'ERPX' and x.subject_type = 'PROJECT' order by x.external_code");
    // Step 1: proposed and approved by the same person.
    const proposed = await world.as('int-admin', 'POST', '/int/project-codes', { body: { source_system: 'ERPX', our_code: mine, external_code: 'P-100', reason: REASON } });
    assertStatus(proposed, 201);
    expect(proposed.json).toMatchObject({ status: 'PROPOSED', external_code: 'P-100', version: 1 });
    const codeId = proposed.json.id as string;
    assertStatus(await world.as('int-admin', 'POST', `/int/project-codes/${codeId}/decision`, { ifMatch: 1, body: { decision: 'APPROVE', reason: REASON } }), 403, 'SELF_APPROVAL_DENIED');
    expect(await crosswalk()).toEqual([{ external_code: 'P-100', status: 'PROPOSED', project: mine }]);
    // Step 2: another person approves it: ACTIVE on master_crosswalk.
    const approved = await world.as('int-checker', 'POST', `/int/project-codes/${codeId}/decision`, { ifMatch: 1, body: { decision: 'APPROVE', reason: REASON } });
    assertStatus(approved, 200);
    expect(approved.json).toMatchObject({ status: 'ACTIVE', resource_version: 2 });
    expect(await crosswalk()).toEqual([{ external_code: 'P-100', status: 'ACTIVE', project: mine }]);
    expect((await world.audits(codeId, 'int.project_code_approved'))[0]).toMatchObject({ actor_id: world.idOf('int-checker') });
    // Step 3: the same code for another project, and a second code for the same project, are duplicates; a code outside the format is refused. Nothing is written for any of them.
    const duplicate = await world.as('int-admin', 'POST', '/int/project-codes', { body: { source_system: 'ERPX', our_code: other, external_code: 'P-100', reason: REASON } });
    assertStatus(duplicate, 409, 'CROSSWALK_DUPLICATE');
    expect(codeOf(duplicate)).toBe('CROSSWALK_DUPLICATE');
    assertStatus(await world.as('int-admin', 'POST', '/int/project-codes', { body: { source_system: 'ERPX', our_code: mine, external_code: 'P-101', reason: REASON } }), 409, 'CROSSWALK_DUPLICATE');
    assertStatus(await world.as('int-admin', 'POST', '/int/project-codes', { body: { source_system: 'ERPX', our_code: other, external_code: 'WRONG', reason: REASON } }), 422);
    expect(await crosswalk()).toEqual([{ external_code: 'P-100', status: 'ACTIVE', project: mine }]);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403, 'OPEN_SCOPE_DENIED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'OTHER' } }, 409, 'CROSSWALK_DUPLICATE'));
  });
});
