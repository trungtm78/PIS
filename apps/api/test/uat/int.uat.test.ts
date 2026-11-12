import { randomUUID } from 'node:crypto';
import { TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * UAT of the open interface (docs/uat/int/uat.json, HSKT row TH.02, screens INT-01 to INT-05): a machine account whose secret is shown once and kept nowhere, the token exchange that answers every refusal alike,
 * the reads of the open API within the tenant of the account and the scope of the token, an account suspended or revoked at once, the access log that keeps the names of the parameters and never their values, and the codes of
 * our projects in other systems that a second person must approve. Each case is named by its id in docs/uat/int/uat.json.
 */
jest.setTimeout(600_000);

const REASON = 'The ministry asked for this change in writing.';
const INT_ALL = ['int.account.read', 'int.account.manage', 'int.access.read', 'int.dataset.read', 'int.dataset.manage', 'int.bi.read', 'int.bi.manage', 'int.codes.read', 'int.codes.propose', 'int.codes.approve', 'int.system.manage'];
const PERSONAS = {
  'int-admin': INT_ALL,
  'int-checker': ['int.codes.read', 'int.codes.approve'],
  'int-reader': ['int.account.read', 'int.access.read', 'int.dataset.read', 'int.bi.read', 'int.codes.read'],
};

describe('UAT of the open interface (TH.02, INT-01..INT-05)', () => {
  const world = new UatWorld();

  beforeAll(async () => {
    await world.start(PERSONAS, { 'int-admin': INT_ALL }, async (w) => {
      for (const [tenant, code] of [[TENANT_A, 'UAT-INT-A1'], [TENANT_A, 'UAT-INT-A2'], [TENANT_B, 'UAT-INT-B1']] as const) {
        await w.seedAsAdmin([
          [
            `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, created_by, updated_by)
             values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B', $6, $6)`,
            [tenant, randomUUID(), code, unitId(ROOT_UNIT), id(0x99, 1), memberId(1)],
          ],
        ]);
      }
    });
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  /** A call of the open API: no session of a person, only a bearer token (or none). */
  async function open(method: string, url: string, options: { bearer?: string; body?: unknown } = {}): Promise<Reply & { headers: Headers }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
    const response = await fetch(`${world.app.baseUrl}${url}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: response.headers };
  }

  const exchange = (clientId: string, clientSecret: string, scope?: string): Promise<Reply> =>
    open('POST', '/open/v1/token', { body: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, ...(scope === undefined ? {} : { scope }) } });

  async function machine(name: string, scopes: string[], extra: Record<string, unknown> = {}): Promise<{ id: string; clientId: string; secret: string; token: string; version: number }> {
    const made = await world.as('int-admin', 'POST', '/int/machine-accounts', { body: { name, scopes, ...extra } });
    assertStatus(made, 201);
    const issued = await exchange(made.json.client_id as string, made.json.client_secret as string);
    assertStatus(issued, 200);
    return { id: made.json.account_id as string, clientId: made.json.client_id as string, secret: made.json.client_secret as string, token: issued.json.access_token as string, version: made.json.resource_version as number };
  }

  const logOf = (accountId: string): Promise<Array<{ operation: string; outcome: string; status: number; path: string; query_keys: string[] }>> =>
    world.rows('select operation, outcome, status, path, query_keys from machvon.int_access_log where account_id = $1 order by occurred_at, id', [accountId]);

  it('UAT-INT-E2E-01 an account is opened and its secret is shown once, a token is exchanged for it, and the open API serves the projects of its own tenant and no other', async () => {
    const reader = await machine('Power BI reader', ['open.projects.read', 'open.disbursement.read']);
    const page = await open('GET', '/open/v1/projects?limit=200', { bearer: reader.token });
    assertStatus(page, 200);
    const codes = (page.json.items as Array<{ code: string }>).map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(['UAT-INT-A1', 'UAT-INT-A2']));
    expect(JSON.stringify(page.json)).not.toContain('UAT-INT-B1');
    const denied = await open('GET', '/open/v1/contract-lines', { bearer: reader.token });
    assertStatus(denied, 403, 'OPEN_SCOPE_DENIED');
    expect(denied.json).toMatchObject({ required_scope: 'open.contracts.read' });
    expect((await logOf(reader.id)).some((entry) => entry.operation === 'listOpenContractLines' && entry.outcome === 'DENIED_SCOPE' && entry.status === 403)).toBe(true);
    const foreign = await world.asTenantB(1, 'POST', '/int/machine-accounts', { body: { name: 'Foreign reader', scopes: ['open.projects.read'] } });
    const foreignToken = (await exchange(foreign.json.client_id as string, foreign.json.client_secret as string)).json.access_token as string;
    const foreignCodes = ((await open('GET', '/open/v1/projects?limit=200', { bearer: foreignToken })).json.items as Array<{ code: string }>).map((item) => item.code);
    expect(foreignCodes).toEqual(['UAT-INT-B1']);
  });

  it('UAT-INT-IDM-01 opening the same account again under the same Idempotency-Key replays the answer without the secret, one account exists, and the secret is in no table', async () => {
    const key = `uat-${randomUUID()}`;
    const body = { name: 'Lakehouse of the ministry', description: 'Nightly load', scopes: ['open.projects.read', 'open.contracts.read'], rate_limit_per_minute: 120 };
    const first = await world.as('int-admin', 'POST', '/int/machine-accounts', { body, key });
    assertStatus(first, 201);
    expect(first.json).toMatchObject({ shown_once: true, status: 'ACTIVE', resource_version: 1 });
    expect(first.json.client_secret).toMatch(/^mvs_[A-Za-z0-9_-]{43}$/);
    const secret = first.json.client_secret as string;
    const replay = await world.as('int-admin', 'POST', '/int/machine-accounts', { body, key });
    assertStatus(replay, 201);
    expect(replay.json).toMatchObject({ client_secret: '', client_id: first.json.client_id, account_id: first.json.account_id });
    for (const table of ['int_machine_credential', 'int_machine_account', 'idempotency_record', 'audit_event', 'outbox_event', 'int_access_log']) {
      const found = await world.rows<{ n: string }>(`select count(*)::text as n from machvon.${table} t where to_jsonb(t)::text like '%' || $1 || '%'`, [secret]);
      expect([table, found[0]?.n]).toEqual([table, '0']);
    }
    expect(await world.rows('select action from machvon.audit_event where resource_id = $1', [first.json.account_id])).toEqual([expect.objectContaining({ action: 'int.machine_account_created' })]);
    assertStatus(await world.as('int-admin', 'POST', '/int/machine-accounts', { body: { ...body, name: 'LAKEHOUSE of the ministry' } }), 409, 'OPEN_ACCOUNT_NAME_TAKEN');
  });

  it('UAT-INT-TKN-01 every refusal of the token exchange is alike (unknown client, wrong secret) and cannot tell which part was wrong, and what is not a machine token opens nothing', async () => {
    const reader = await machine('Refusal reader', ['open.projects.read']);
    const unknown = await exchange('mvc_aaaaaaaaaaaaaaaaaaaaaaaaaa', reader.secret);
    const wrong = await exchange(reader.clientId, `mvs_${'A'.repeat(43)}`);
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(codeOf(unknown)).toBe('OPEN_CLIENT_INVALID');
    expect({ ...wrong.json, correlationId: undefined, detail: undefined }).toEqual({ ...unknown.json, correlationId: undefined, detail: undefined });
    assertStatus(await open('GET', '/open/v1/projects'), 401, 'OPEN_CLIENT_INVALID');
    assertStatus(await open('GET', '/open/v1/projects', { bearer: 'garbage' }), 401);
    // A tenant session of a person does not open the machine routes, and a machine token does not open the admin routes.
    expect((await fetch(`${world.app.baseUrl}/open/v1/projects`, { headers: { 'x-tenant-context': 'x' } })).status).toBe(401);
    expect((await fetch(`${world.app.baseUrl}/int/machine-accounts`, { headers: { authorization: `Bearer ${reader.token}` } })).status).toBeGreaterThanOrEqual(400);
    expect((await logOf(reader.id)).filter((entry) => entry.outcome === 'DENIED_CLIENT').length).toBe(1);
  });

  it('UAT-INT-STA-01 a suspension refuses the very next call of a token that is still alive, a reactivation restores it, and a revoked account stays revoked', async () => {
    const account = await machine('Suspended while holding a token', ['open.projects.read']);
    assertStatus(await open('GET', '/open/v1/projects', { bearer: account.token }), 200);
    const decide = (version: number, decision: string): Promise<Reply> => world.as('int-admin', 'POST', `/int/machine-accounts/${account.id}/decision`, { ifMatch: version, body: { decision, reason: REASON } });
    assertStatus(await decide(account.version + 9, 'SUSPEND'), 409, 'VERSION_CONFLICT');
    assertStatus(await decide(account.version, 'SUSPEND'), 200);
    assertStatus(await open('GET', '/open/v1/projects', { bearer: account.token }), 401, 'OPEN_CLIENT_INVALID');
    assertStatus(await exchange(account.clientId, account.secret), 401);
    assertStatus(await decide(account.version + 1, 'REACTIVATE'), 200);
    assertStatus(await open('GET', '/open/v1/projects', { bearer: account.token }), 200);
    assertStatus(await decide(account.version + 2, 'REVOKE'), 200);
    assertStatus(await exchange(account.clientId, account.secret), 401);
    assertStatus(await decide(account.version + 3, 'REACTIVATE'), 409, 'OPEN_ACCOUNT_STATE_INVALID');
  });

  it('UAT-INT-DAT-01 every call leaves a row of the access log with the names of the query parameters and never their values, and the log is read through the API of the tenant only', async () => {
    const reader = await machine('Logged reader', ['open.projects.read']);
    await open('GET', '/open/v1/projects?status=SECRET-FILTER-VALUE&limit=3', { bearer: reader.token });
    await open('GET', '/open/v1/projects?cursor=not-a-cursor', { bearer: reader.token });
    const entries = await logOf(reader.id);
    const filtered = entries.filter((entry) => entry.operation === 'listOpenProjects' && entry.query_keys.includes('status') && entry.query_keys.includes('limit') && entry.status === 200);
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(entries)).not.toContain('SECRET-FILTER-VALUE');
    expect(entries.every((entry) => !entry.path.includes('?'))).toBe(true);
    expect(entries.some((entry) => entry.outcome === 'INVALID_REQUEST' && entry.status === 422)).toBe(true);
    const viaApi = await world.as('int-reader', 'GET', `/int/access-log?account_id=${reader.id}&limit=200`);
    assertStatus(viaApi, 200);
    expect((viaApi.json.items as unknown[]).length).toBe(entries.length);
    expect(((await world.asTenantB(1, 'GET', `/int/access-log?account_id=${reader.id}`)).json.items as unknown[]).length).toBe(0);
    assertStatus(await world.as('int-reader', 'GET', '/int/access-log?outcome=NONSENSE'), 422);
  });

  it('UAT-INT-EDG-01 the contract refuses an unknown scope, no scope, a rate out of range, an unknown field and a past expiry, and an account of the call is not made', async () => {
    const before = (await world.rows('select 1 from machvon.int_machine_account')).length;
    const bad = (body: Record<string, unknown>): Promise<Reply> => world.as('int-admin', 'POST', '/int/machine-accounts', { body });
    assertStatus(await bad({ name: 'x', scopes: ['open.everything'] }), 422);
    expect((await bad({ name: 'x', scopes: [] })).status).toBeGreaterThanOrEqual(400);
    expect((await bad({ name: 'x', scopes: ['open.projects.read'], rate_limit_per_minute: 6001 })).status).toBeGreaterThanOrEqual(400);
    expect((await bad({ name: 'x', scopes: ['open.projects.read'], is_admin: true })).status).toBeGreaterThanOrEqual(400);
    assertStatus(await bad({ name: 'x', scopes: ['open.projects.read'], expires_on: '2020-01-01' }), 422);
    expect((await world.rows('select 1 from machvon.int_machine_account')).length).toBe(before);
  });

  it('UAT-INT-SOD-01 a code of a project in another system needs a second person: the proposer cannot approve it (403 SELF_APPROVAL_DENIED), a reader cannot, and the open API shows it only after the approval', async () => {
    const registered = await world.as('int-admin', 'POST', '/int/source-systems', { body: { code: 'EBS', name: 'Oracle EBS', kind: 'ERP', code_pattern: 'P-\\d{3}' } });
    assertStatus(registered, 201);
    assertStatus(await world.as('int-admin', 'POST', '/int/project-codes', { body: { source_system: 'EBS', our_code: 'UAT-INT-A1', external_code: 'WRONG', reason: REASON } }), 422, 'VALIDATION_FAILED');
    const proposed = await world.as('int-admin', 'POST', '/int/project-codes', { body: { source_system: 'EBS', our_code: 'UAT-INT-A1', external_code: 'P-100', reason: REASON } });
    assertStatus(proposed, 201);
    expect(proposed.json).toMatchObject({ status: 'PROPOSED', external_code: 'P-100', version: 1 });
    const codeId = proposed.json.id as string;
    const watcher = await machine('Code watcher', ['open.project-codes.read']);
    expect(((await open('GET', '/open/v1/project-codes?source_system=EBS', { bearer: watcher.token })).json.items as unknown[]).length).toBe(0);
    assertStatus(await world.as('int-admin', 'POST', `/int/project-codes/${codeId}/decision`, { ifMatch: 1, body: { decision: 'APPROVE', reason: REASON } }), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await world.as('int-reader', 'POST', `/int/project-codes/${codeId}/decision`, { ifMatch: 1, body: { decision: 'APPROVE', reason: REASON } }), 403);
    const approved = await world.as('int-checker', 'POST', `/int/project-codes/${codeId}/decision`, { ifMatch: 1, body: { decision: 'APPROVE', reason: REASON } });
    assertStatus(approved, 200);
    expect(approved.json).toMatchObject({ status: 'ACTIVE', resource_version: 2 });
    const codes = await open('GET', '/open/v1/project-codes?source_system=EBS&external_code=P-100', { bearer: watcher.token });
    expect(codes.json.items).toEqual([expect.objectContaining({ project_code: 'UAT-INT-A1', source_system: 'EBS', external_code: 'P-100', valid_until: null })]);
    const dup = await world.as('int-admin', 'POST', '/int/project-codes', { body: { source_system: 'EBS', our_code: 'UAT-INT-A2', external_code: 'P-100', reason: REASON } });
    assertStatus(dup, 409, 'CROSSWALK_DUPLICATE');
    assertStatus(await world.as('int-admin', 'POST', `/int/source-systems/${registered.json.id as string}/retire`, { ifMatch: 1, body: { reason: REASON } }), 409, 'INT_SOURCE_SYSTEM_IN_USE');
    assertStatus(await world.as('int-admin', 'POST', `/int/project-codes/${codeId}/retire`, { ifMatch: 2, body: { reason: REASON } }), 200);
    expect(((await open('GET', '/open/v1/project-codes?source_system=EBS', { bearer: watcher.token })).json.items as unknown[]).length).toBe(0);
  });

  it('UAT-INT-ISO-01 a member of another tenant is answered 404 for an account and a project code of this tenant, and lists none', async () => {
    const account = await machine('Isolated account', ['open.projects.read']);
    assertStatus(await world.asTenantB(1, 'GET', `/int/machine-accounts/${account.id}`), 404);
    assertStatus(await world.asTenantB(1, 'POST', `/int/machine-accounts/${account.id}/decision`, { ifMatch: 1, body: { decision: 'REVOKE', reason: REASON } }), 404);
    assertStatus(await world.asTenantB(1, 'POST', `/int/machine-accounts/${account.id}/rotate`, { ifMatch: 1, body: { reason: REASON } }), 404);
    const listed = await world.asTenantB(1, 'GET', '/int/machine-accounts?q=Isolated');
    expect(listed.json.items).toEqual([]);
    expect(((await world.asTenantB(1, 'GET', '/int/project-codes')).json.items as unknown[]).length).toBe(0);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 401, 'OPEN_CLIENT_INVALID'));
    expectCheckFails(() => assertStatus({ status: 401, json: { code: 'OTHER' } }, 401, 'OPEN_CLIENT_INVALID'));
  });
});
