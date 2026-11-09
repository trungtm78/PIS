import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client, Pool } from 'pg';
import { ControlDatabase, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, registerDirectMatchSystem } from '@machvon/db';
import { MachineRateLimiter, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { LocalTenantTokenIssuer, issuerKeyFromPem } from '../../src/auth/tenant-token-issuer';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { intModule } from '../../src/modules/int';
import { MachineAuthGuard, OPEN_API_SIGNER, OPEN_RATE_LIMITER, OpenApiService } from '../../src/modules/int/machine-auth';
import { OPEN_API_DOCUMENT } from '../../src/modules/int/open-api-document.generated';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedSnapshot } from '../../../../packages/db/test/support/dgv-quality-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, REPO_ROOT, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // every INT permission over the tenant
const CHECKER = 2; // the right to read codes and to approve them
const READER = 3; // reads, manages nothing
const UNIT_ADMIN = 4; // every INT permission over one unit only
const NOBODY = 5;
const ROOT = 1;
const DEPARTMENT = 2;
const INT_ALL = ['int.account.read', 'int.account.manage', 'int.access.read', 'int.dataset.read', 'int.dataset.manage', 'int.bi.read', 'int.bi.manage', 'int.codes.read', 'int.codes.propose', 'int.codes.approve', 'int.system.manage'];
const REASON = 'Một lý do đủ mười ký tự';

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

describe('the open interface over HTTP: machine accounts, the open API, certified datasets, BI logins and project codes (INT-1)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let control: Pool;
  const clients: Client[] = [];

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: response.headers };
  }

  /** A call of the open API: no session of a person, only a bearer token (or none). */
  async function open(method: string, url: string, options: { bearer?: string; body?: unknown; extra?: Record<string, string> } = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.extra ?? {}) };
    if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: response.headers };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const etag = (version: unknown): string => `"${String(version)}"`;
  const exchange = (clientId: string, clientSecret: string, scope?: string): Promise<Reply> =>
    open('POST', '/open/v1/token', { body: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, ...(scope === undefined ? {} : { scope }) } });

  /** Opens an account through the admin API and exchanges its credentials for a token. */
  async function machine(name: string, scopes: string[], extra: Record<string, unknown> = {}): Promise<{ id: string; clientId: string; secret: string; token: string; version: number }> {
    const made = await call('POST', '/int/machine-accounts', { member: ADMIN, body: { name, scopes, ...extra } });
    expect(made.status).toBe(201);
    const clientId = made.json.client_id as string;
    const secret = made.json.client_secret as string;
    const issued = await exchange(clientId, secret);
    expect(issued.status).toBe(200);
    return { id: made.json.account_id as string, clientId, secret, token: issued.json.access_token as string, version: made.json.resource_version as number };
  }

  const logOf = async (accountId: string): Promise<Array<{ operation: string; outcome: string; status: number; path: string; query_keys: string[]; row_count: number | null }>> =>
    rows('select operation, outcome, status, path, query_keys, row_count from machvon.int_access_log where account_id = $1 order by occurred_at, id', [accountId]);

  async function seedProject(tenant: string, code: string, status = 'IMPLEMENTATION'): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, created_by, updated_by)
       values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, $6, 1, 'B', $7, $7)`,
      [tenant, id, code, unitId(DEPARTMENT), randomUUID(), status, memberId(ADMIN)],
      tenant,
    );
    return id;
  }

  async function seedProduct(tenant: string, code: string, status: 'CERTIFIED' | 'PROVISIONAL' = 'CERTIFIED'): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.data_product (tenant_id, id, code, title, dataset_ids, owner_user_id, certification_status, certified_by, certified_at, certification_expires_on, evidence_refs, created_by, updated_by)
       values ($1, $2, $3, $3, $4::jsonb, $5, $6, $7, now(), date '2099-01-01', '["evidence-1"]', $5, $5)`,
      [tenant, id, code, JSON.stringify([randomUUID()]), memberId(ADMIN), status, status === 'CERTIFIED' ? memberId(CHECKER) : null],
      tenant,
    );
    return id;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, CHECKER, READER, UNIT_ADMIN, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'INT_ADMIN', INT_ALL, 50);
    await harness.seedRole(TENANT_A, 2, 'INT_CHECKER', ['int.codes.read', 'int.codes.approve'], 30);
    await harness.seedRole(TENANT_A, 3, 'INT_READER', ['int.account.read', 'int.access.read', 'int.dataset.read', 'int.bi.read', 'int.codes.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'INT_ADMIN', INT_ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: ADMIN, role: 1, kind: 'TENANT' }]);
    await dropSnapshotFixtureKeys(harness, TENANT_A);
    await seedSnapshot(harness, TENANT_A, ADMIN, { lines: [{}, {}, {}] });
    await seedProject(TENANT_A, 'AAA-1');
    await seedProject(TENANT_A, 'AAA-2', 'CONCEPT');
    await seedProject(TENANT_B, 'AAA-B1');
    const tenants = harness.tenants as TenantDatabase;
    control = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 2 });
    control.on('error', () => undefined);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const issuer = new LocalTenantTokenIssuer({ issuer: 'https://api.test', signingKey: issuerKeyFromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'int-test-key') });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [...intModule.controllers],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: ControlDatabase, useValue: new ControlDatabase(control) },
        { provide: OPEN_API_SIGNER, useValue: issuer },
        { provide: OPEN_RATE_LIMITER, useFactory: (): MachineRateLimiter => new MachineRateLimiter() },
        OpenApiService,
        MachineAuthGuard,
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    if (app) await app.close();
    await control?.end();
    await harness.stop();
  }, 60_000);

  it('is registered with the module registry under the code INT and every route has an operation id', () => {
    expect(intModule.code).toBe('INT');
    expect([...app.implementedOperations].filter((id) => /MachineAccount|MachineCredential|OpenAccessLog|ExportDataset|BiReader|SourceSystem|ProjectCode|OpenApi|OpenProject|OpenDataset|OpenDisbursement|OpenContract/.test(id)).length).toBeGreaterThanOrEqual(26);
  });

  describe('who may manage what', () => {
    it('lets a reader read the accounts and refuses the commands; a holder of a grant on one unit gets nothing; a stranger gets nothing', async () => {
      expect((await call('GET', '/int/machine-accounts', { member: READER })).status).toBe(200);
      expect((await call('POST', '/int/machine-accounts', { member: READER, body: { name: 'x', scopes: ['open.projects.read'] } })).status).toBe(403);
      expect((await call('GET', '/int/machine-accounts', { member: UNIT_ADMIN })).json).toMatchObject({ code: 'SCOPE_DENIED' });
      expect((await call('POST', '/int/machine-accounts', { member: UNIT_ADMIN, body: { name: 'x', scopes: ['open.projects.read'] } })).json).toMatchObject({ code: 'SCOPE_DENIED' });
      expect((await call('GET', '/int/access-log', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/int/bi-readers', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/int/project-codes', { member: NOBODY })).status).toBe(403);
      // The reader sees the screens read-only: no action is offered.
      const page = await call('GET', '/int/machine-accounts', { member: READER });
      expect(page.json).toMatchObject({ can_create: false, token_url: '/open/v1/token', rate_limit: { min: 1, max: 6000, default: 60 } });
      expect((page.json.scopes as unknown[]).length).toBe(4);
    });
  });

  describe('machine accounts: the secret is shown once and never kept', () => {
    it('opens an account, answers with the secret once, replays without it, and keeps only the hash anywhere', async () => {
      const key = `key-${randomUUID()}`;
      const body = { name: 'Lakehouse of the ministry', description: 'Nightly load', scopes: ['open.projects.read', 'open.contracts.read'], rate_limit_per_minute: 120 };
      const first = await call('POST', '/int/machine-accounts', { member: ADMIN, body, key });
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ shown_once: true, status: 'ACTIVE', resource_version: 1, token_url: '/open/v1/token' });
      expect(first.json.client_secret).toMatch(/^mvs_[A-Za-z0-9_-]{43}$/);
      expect(first.json.client_id).toMatch(/^mvc_[a-z2-7]{26}$/);
      const secret = first.json.client_secret as string;
      const replay = await call('POST', '/int/machine-accounts', { member: ADMIN, body, key });
      expect(replay.status).toBe(201);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      expect(replay.json).toMatchObject({ client_secret: '', client_id: first.json.client_id, account_id: first.json.account_id });
      // The secret is in no table: not the credential, not the stored answer, not the audit, not the outbox.
      for (const table of ['int_machine_credential', 'int_machine_account', 'idempotency_record', 'audit_event', 'outbox_event', 'int_access_log']) {
        const found = await rows<{ n: string }>(`select count(*)::text as n from machvon.${table} t where to_jsonb(t)::text like '%' || $1 || '%'`, [secret]);
        expect([table, found[0]?.n]).toEqual([table, '0']);
      }
      const listed = await call('GET', '/int/machine-accounts?q=Lakehouse', { member: READER });
      const item = (listed.json.items as Array<Record<string, unknown>>)[0] as { credentials: Array<Record<string, unknown>> };
      expect(JSON.stringify(listed.json)).not.toContain(secret);
      expect(item.credentials[0]).toMatchObject({ client_id: first.json.client_id, secret_hint: (first.json.secret_hint as string), state: 'ACTIVE' });
      expect(await rows('select action, reason from machvon.audit_event where resource_id = $1', [first.json.account_id])).toEqual([expect.objectContaining({ action: 'int.machine_account_created' })]);
      expect((await call('POST', '/int/machine-accounts', { member: ADMIN, body: { ...body, name: 'LAKEHOUSE of the ministry' } })).json).toMatchObject({ code: 'OPEN_ACCOUNT_NAME_TAKEN' });
    });

    it('refuses what the contract refuses: unknown scope, no scope, a rate out of range, unknown fields', async () => {
      const bad = async (body: Record<string, unknown>): Promise<Reply> => call('POST', '/int/machine-accounts', { member: ADMIN, body });
      expect((await bad({ name: 'x', scopes: ['open.everything'] })).status).toBe(422);
      expect((await bad({ name: 'x', scopes: [] })).status).toBeGreaterThanOrEqual(400);
      expect((await bad({ name: 'x', scopes: ['open.projects.read'], rate_limit_per_minute: 6001 })).status).toBeGreaterThanOrEqual(400);
      expect((await bad({ name: 'x', scopes: ['open.projects.read'], is_admin: true })).status).toBeGreaterThanOrEqual(400);
      expect((await bad({ name: 'x', scopes: ['open.projects.read'], expires_on: '2020-01-01' })).status).toBe(422);
    });

    it('updates, suspends, reactivates, rotates and revokes with versions and reasons', async () => {
      const account = await machine('Lifecycle account', ['open.projects.read']);
      const stale = await call('POST', `/int/machine-accounts/${account.id}/update`, { member: ADMIN, ifMatch: etag(9), body: { rate_limit_per_minute: 5, reason: REASON } });
      expect(stale.json).toMatchObject({ code: 'VERSION_CONFLICT' });
      const updated = await call('POST', `/int/machine-accounts/${account.id}/update`, { member: ADMIN, ifMatch: etag(account.version), body: { rate_limit_per_minute: 5, scopes: ['open.projects.read', 'open.project-codes.read'], reason: REASON } });
      expect(updated.status).toBe(200);
      expect(updated.json).toMatchObject({ resource_version: 2, status: 'ACTIVE' });
      expect((await call('POST', `/int/machine-accounts/${account.id}/update`, { member: ADMIN, ifMatch: etag(2), body: { reason: REASON } })).status).toBe(422);
      expect((await call('POST', `/int/machine-accounts/${account.id}/decision`, { member: ADMIN, ifMatch: etag(2), body: { decision: 'REACTIVATE', reason: REASON } })).json).toMatchObject({ code: 'OPEN_ACCOUNT_STATE_INVALID' });
      expect((await call('POST', `/int/machine-accounts/${account.id}/decision`, { member: ADMIN, ifMatch: etag(2), body: { decision: 'SUSPEND', reason: 'short' } })).status).toBe(422);
      expect((await call('POST', `/int/machine-accounts/${account.id}/decision`, { member: ADMIN, ifMatch: etag(2), body: { decision: 'SUSPEND', reason: REASON } })).json).toMatchObject({ status: 'SUSPENDED', resource_version: 3 });
      expect((await call('POST', `/int/machine-accounts/${account.id}/rotate`, { member: ADMIN, ifMatch: etag(3), body: { reason: REASON } })).json).toMatchObject({ code: 'OPEN_ACCOUNT_STATE_INVALID' });
      await call('POST', `/int/machine-accounts/${account.id}/decision`, { member: ADMIN, ifMatch: etag(3), body: { decision: 'REACTIVATE', reason: REASON } });
      const rotated = await call('POST', `/int/machine-accounts/${account.id}/rotate`, { member: ADMIN, ifMatch: etag(4), body: { reason: REASON, grace_hours: 1 } });
      expect(rotated.status).toBe(200);
      expect(rotated.json).toMatchObject({ shown_once: true, resource_version: 5, account_id: account.id });
      expect(rotated.json.client_id).not.toBe(account.clientId);
      const detail = await call('GET', `/int/machine-accounts/${account.id}`, { member: READER });
      expect((detail.json.credentials as Array<{ state: string }>).map((credential) => credential.state)).toEqual(['ACTIVE', 'RETIRING']);
      expect(JSON.stringify(detail.json)).not.toContain(rotated.json.client_secret as string);
      // Both secrets work during the overlap; after a revocation neither does.
      expect((await exchange(account.clientId, account.secret)).status).toBe(200);
      expect((await exchange(rotated.json.client_id as string, rotated.json.client_secret as string)).status).toBe(200);
      const revoked = await call('POST', `/int/machine-accounts/${account.id}/decision`, { member: ADMIN, ifMatch: etag(5), body: { decision: 'REVOKE', reason: REASON } });
      expect(revoked.json).toMatchObject({ status: 'REVOKED' });
      expect((await exchange(account.clientId, account.secret)).status).toBe(401);
      expect((await exchange(rotated.json.client_id as string, rotated.json.client_secret as string)).status).toBe(401);
      expect((await call('POST', `/int/machine-accounts/${account.id}/decision`, { member: ADMIN, ifMatch: etag(6), body: { decision: 'REACTIVATE', reason: REASON } })).json).toMatchObject({ code: 'OPEN_ACCOUNT_STATE_INVALID' });
    });

    it('never shows an account of another tenant and answers 404 for its id', async () => {
      const foreign = await call('POST', '/int/machine-accounts', { member: ADMIN, tenantId: TENANT_B, body: { name: 'Foreign account', scopes: ['open.projects.read'] } });
      const id = foreign.json.account_id as string;
      expect((await call('GET', `/int/machine-accounts/${id}`, { member: ADMIN })).status).toBe(404);
      expect((await call('POST', `/int/machine-accounts/${id}/decision`, { member: ADMIN, ifMatch: etag(1), body: { decision: 'REVOKE', reason: REASON } })).status).toBe(404);
      expect((await call('POST', `/int/machine-accounts/${id}/rotate`, { member: ADMIN, ifMatch: etag(1), body: { reason: REASON } })).status).toBe(404);
      expect(((await call('GET', '/int/machine-accounts?q=Foreign', { member: ADMIN })).json.items as unknown[]).length).toBe(0);
    });
  });

  describe('the token and the reads of the open API', () => {
    let reader: { id: string; clientId: string; secret: string; token: string };

    beforeAll(async () => {
      reader = await machine('Power BI reader', ['open.projects.read', 'open.project-codes.read', 'open.disbursement.read']);
    });

    it('answers every refusal of the exchange alike: unknown client, wrong secret, no secret, and writes the refusal of a known client to the log', async () => {
      const unknown = await exchange('mvc_aaaaaaaaaaaaaaaaaaaaaaaaaa', reader.secret);
      const wrong = await exchange(reader.clientId, `mvs_${'A'.repeat(43)}`);
      expect([unknown.status, wrong.status]).toEqual([401, 401]);
      expect(unknown.json.code).toBe('OPEN_CLIENT_INVALID');
      expect({ ...wrong.json, correlationId: undefined, detail: undefined }).toEqual({ ...unknown.json, correlationId: undefined, detail: undefined });
      expect((await open('POST', '/open/v1/token', { body: { grant_type: 'password', client_id: reader.clientId, client_secret: reader.secret } })).status).toBe(422);
      expect((await open('POST', '/open/v1/token', { body: { grant_type: 'client_credentials', client_id: 'nonsense', client_secret: 'x' } })).json.code).toBe('OPEN_CLIENT_INVALID');
      expect((await logOf(reader.id)).filter((entry) => entry.outcome === 'DENIED_CLIENT')).toEqual([expect.objectContaining({ operation: 'issueOpenApiToken', status: 401, path: '/open/v1/token' })]);
    });

    it('narrows the scopes of a token to what is asked and never beyond what the account holds', async () => {
      const narrow = await exchange(reader.clientId, reader.secret, 'open.projects.read');
      expect(narrow.json).toMatchObject({ token_type: 'Bearer', expires_in: 300, scope: 'open.projects.read' });
      expect((await exchange(reader.clientId, reader.secret, 'open.contracts.read')).json).toMatchObject({ code: 'OPEN_SCOPE_DENIED' });
      expect((await exchange(reader.clientId, reader.secret)).json.scope).toBe('open.disbursement.read open.project-codes.read open.projects.read');
      // The token is a short-lived signed value that carries no secret.
      const payload = JSON.parse(Buffer.from((narrow.json.access_token as string).split('.')[1] as string, 'base64url').toString('utf8')) as Record<string, unknown>;
      expect(payload).toMatchObject({ aud: 'machvon-open', tid: TENANT_A, mac: reader.id, scp: ['open.projects.read'] });
      expect(JSON.stringify(payload)).not.toContain(reader.secret);
    });

    it('lists the projects of its own tenant with their codes in other systems, and nothing of another tenant', async () => {
      const page = await open('GET', '/open/v1/projects?limit=1', { bearer: reader.token });
      expect(page.status).toBe(200);
      const items = page.json.items as Array<{ code: string; external_codes: unknown[] }>;
      expect(items.map((item) => item.code)).toEqual(['AAA-1']);
      expect(page.json.next_cursor).toEqual(expect.any(String));
      const second = await open('GET', `/open/v1/projects?limit=5&cursor=${page.json.next_cursor as string}`, { bearer: reader.token });
      expect((second.json.items as Array<{ code: string }>).map((item) => item.code)[0]).toBe('AAA-2');
      expect(second.json.next_cursor).toBeNull();
      expect(JSON.stringify([page.json, second.json])).not.toContain('AAA-B1');
      expect(((await open('GET', '/open/v1/projects?status=CONCEPT&limit=200', { bearer: reader.token })).json.items as Array<{ code: string }>).map((item) => item.code)).toEqual(expect.arrayContaining(['AAA-2']));
      expect((await open('GET', '/open/v1/projects?cursor=not-a-cursor', { bearer: reader.token })).status).toBe(422);
    });

    it('refuses what is not a machine token: none, garbage, a token of a person, a token of the wrong audience', async () => {
      expect((await open('GET', '/open/v1/projects')).json.code).toBe('OPEN_CLIENT_INVALID');
      expect((await open('GET', '/open/v1/projects', { bearer: 'garbage' })).status).toBe(401);
      expect((await open('GET', '/open/v1/projects', { bearer: tokenOf(ADMIN) })).status).toBe(401);
      const other = await open('GET', '/open/v1/projects', { bearer: `${reader.token.slice(0, -4)}AAAA` });
      expect(other.status).toBe(401);
      // A tenant session header does not open the machine routes either, and a machine token does not open the admin routes.
      expect((await fetch(`${app.baseUrl}/open/v1/projects`, { headers: { [TENANT_HEADER]: tokenOf(ADMIN) } })).status).toBe(401);
      const asPerson = await fetch(`${app.baseUrl}/int/machine-accounts`, { headers: { authorization: `Bearer ${reader.token}` } });
      expect(asPerson.status).toBeGreaterThanOrEqual(400);
    });

    it('needs the scope of the operation and logs the refusal', async () => {
      const denied = await open('GET', '/open/v1/contract-lines', { bearer: reader.token });
      expect(denied.status).toBe(403);
      expect(denied.json).toMatchObject({ code: 'OPEN_SCOPE_DENIED', required_scope: 'open.contracts.read' });
      expect((await logOf(reader.id)).some((entry) => entry.operation === 'listOpenContractLines' && entry.outcome === 'DENIED_SCOPE' && entry.status === 403)).toBe(true);
    });

    it('writes a row for every call, with the names of the parameters and never their values', async () => {
      await open('GET', '/open/v1/projects?status=SECRET-FILTER-VALUE&limit=3', { bearer: reader.token });
      const entries = await logOf(reader.id);
      const filtered = entries.filter((entry) => entry.operation === 'listOpenProjects' && entry.query_keys.includes('status') && entry.query_keys.includes('limit') && entry.status === 200);
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(entries)).not.toContain('SECRET-FILTER-VALUE');
      expect(entries.every((entry) => !entry.path.includes('?'))).toBe(true);
      expect(entries.some((entry) => entry.outcome === 'INVALID_REQUEST' && entry.status === 422)).toBe(true);
      const viaApi = await call('GET', `/int/access-log?account_id=${reader.id}&limit=200`, { member: READER });
      expect(viaApi.status).toBe(200);
      expect((viaApi.json.items as Array<{ operation: string }>).length).toBe(entries.length);
      expect(((await call('GET', '/int/access-log?outcome=RATE_LIMITED', { member: READER })).json.items as unknown[]).length).toBe(0);
      expect((await call('GET', '/int/access-log?outcome=NONSENSE', { member: READER })).status).toBe(422);
      expect(((await call('GET', `/int/access-log?account_id=${reader.id}`, { member: ADMIN, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
    });

    it('AC-ST-INT-001-1: reaches a token that is still alive: a suspension refuses the next call, a reactivation restores it', async () => {
      const account = await machine('Suspended while holding a token', ['open.projects.read']);
      expect((await open('GET', '/open/v1/projects', { bearer: account.token })).status).toBe(200);
      await call('POST', `/int/machine-accounts/${account.id}/decision`, { member: ADMIN, ifMatch: etag(account.version), body: { decision: 'SUSPEND', reason: REASON } });
      expect((await open('GET', '/open/v1/projects', { bearer: account.token })).json.code).toBe('OPEN_CLIENT_INVALID');
      // The refusal of a genuine token is a row of the log, for the account it names.
      expect((await logOf(account.id)).filter((entry) => entry.operation === 'authenticate')).toEqual([expect.objectContaining({ outcome: 'DENIED_CLIENT', status: 401, path: '/open/v1/projects' })]);
      expect((await exchange(account.clientId, account.secret)).status).toBe(401);
      await call('POST', `/int/machine-accounts/${account.id}/decision`, { member: ADMIN, ifMatch: etag(account.version + 1), body: { decision: 'REACTIVATE', reason: REASON } });
      expect((await open('GET', '/open/v1/projects', { bearer: account.token })).status).toBe(200);
      // Taking a scope away from the account stops the token that carries it, at once.
      await call('POST', `/int/machine-accounts/${account.id}/update`, { member: ADMIN, ifMatch: etag(account.version + 2), body: { scopes: ['open.project-codes.read'], reason: REASON } });
      expect((await open('GET', '/open/v1/projects', { bearer: account.token })).json.code).toBe('OPEN_SCOPE_DENIED');
    });

    it('limits the calls of each account to its own rate, answers 429 with Retry-After, and logs the refusal', async () => {
      const slow = await machine('Two per minute', ['open.projects.read'], { rate_limit_per_minute: 2 });
      const fast = await machine('A busy neighbour', ['open.projects.read']);
      expect((await open('GET', '/open/v1/projects', { bearer: slow.token })).status).toBe(200);
      expect((await open('GET', '/open/v1/projects', { bearer: slow.token })).status).toBe(200);
      const refused = await open('GET', '/open/v1/projects', { bearer: slow.token });
      expect(refused.status).toBe(429);
      expect(refused.json.code).toBe('RATE_LIMIT');
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(refused.headers.get('x-ratelimit-limit')).toBe('2');
      expect((await open('GET', '/open/v1/projects', { bearer: fast.token })).status).toBe(200);
      expect((await logOf(slow.id)).filter((entry) => entry.outcome === 'RATE_LIMITED')).toEqual([expect.objectContaining({ status: 429 })]);
    });

    it('reads another tenant only through its own account', async () => {
      const foreign = await call('POST', '/int/machine-accounts', { member: ADMIN, tenantId: TENANT_B, body: { name: 'Foreign reader', scopes: ['open.projects.read'] } });
      const token = ((await exchange(foreign.json.client_id as string, foreign.json.client_secret as string)).json.access_token as string);
      const items = (await open('GET', '/open/v1/projects', { bearer: token })).json.items as Array<{ code: string }>;
      expect(items.map((item) => item.code)).toEqual(['AAA-B1']);
    });
  });

  describe('certified datasets', () => {
    let accountToken: string;
    let accountId: string;

    beforeAll(async () => {
      const account = await machine('Dataset reader', ['open.disbursement.read', 'open.contracts.read']);
      accountToken = account.token;
      accountId = account.id;
    });

    it('lists both datasets as closed until the organization switches them on, and refuses to read a closed one with the reason', async () => {
      const listed = await open('GET', '/open/v1/datasets', { bearer: accountToken });
      expect((listed.json.items as Array<Record<string, unknown>>).map((item) => [item.dataset_code, item.open, item.reason])).toEqual([['DS-DISB', false, 'DISABLED'], ['DS-CTR', false, 'DISABLED']]);
      const closed = await open('GET', '/open/v1/disbursement-lines', { bearer: accountToken });
      expect(closed.status).toBe(403);
      expect(closed.json).toMatchObject({ code: 'OPEN_DATASET_NOT_CERTIFIED', reason: 'DISABLED' });
      expect((await logOf(accountId)).some((entry) => entry.operation === 'listOpenDisbursementLines' && entry.outcome === 'DENIED_DATASET')).toBe(true);
    });

    it('switches a dataset on only for a certified product, and then serves the frozen lines', async () => {
      const weak = await seedProduct(TENANT_A, 'DP-WEAK', 'PROVISIONAL');
      const strong = await seedProduct(TENANT_A, 'DP-STRONG');
      const refused = await call('POST', '/int/export-datasets/state', { member: ADMIN, ifMatch: etag(1), body: { dataset_code: 'DS-DISB', enabled: true, product_id: weak, reason: REASON } });
      expect(refused.status).toBe(422);
      expect(refused.json).toMatchObject({ code: 'OPEN_DATASET_NOT_CERTIFIED', reason: 'NOT_CERTIFIED' });
      expect((await call('POST', '/int/export-datasets/state', { member: READER, ifMatch: etag(1), body: { dataset_code: 'DS-DISB', enabled: true, product_id: strong, reason: REASON } })).status).toBe(403);
      expect((await call('POST', '/int/export-datasets/state', { member: ADMIN, ifMatch: etag(1), body: { dataset_code: 'DS-NOPE', enabled: true, product_id: strong, reason: REASON } })).status).toBe(422);
      const on = await call('POST', '/int/export-datasets/state', { member: ADMIN, ifMatch: etag(1), body: { dataset_code: 'DS-DISB', enabled: true, product_id: strong, reason: REASON } });
      expect(on.status).toBe(200);
      expect(on.json).toMatchObject({ status: 'ENABLED', resource_version: 2 });
      const lines = await open('GET', '/open/v1/disbursement-lines?limit=2', { bearer: accountToken });
      expect(lines.status).toBe(200);
      expect((lines.json.items as unknown[]).length).toBe(2);
      expect(lines.json.next_cursor).toEqual(expect.any(String));
      const rest = await open('GET', `/open/v1/disbursement-lines?limit=5&cursor=${lines.json.next_cursor as string}`, { bearer: accountToken });
      expect((rest.json.items as unknown[]).length).toBe(1);
      const every = [...(lines.json.items as Array<Record<string, unknown>>), ...(rest.json.items as Array<Record<string, unknown>>)];
      expect(new Set(every.map((line) => line.tenant_id))).toEqual(new Set([TENANT_A]));
      expect(every.every((line) => line.certification_expires_on === '2099-01-01')).toBe(true);
      expect((await open('GET', '/open/v1/disbursement-lines?period_id=not-a-uuid', { bearer: accountToken })).status).toBe(422);
      expect(((await open('GET', `/open/v1/disbursement-lines?period_id=${randomUUID()}`, { bearer: accountToken })).json.items as unknown[]).length).toBe(0);
      const listed = await call('GET', '/int/export-datasets', { member: READER });
      expect((listed.json.items as Array<{ dataset_code: string; enabled: boolean; gate: { open: boolean } }>).map((item) => [item.dataset_code, item.enabled, item.gate.open])).toEqual([['DS-CTR', false, false], ['DS-DISB', true, true]]);
      expect((listed.json.products as unknown[]).length).toBeGreaterThanOrEqual(2);
      // Another tenant has switched nothing on: it reads nothing of the dataset of this one.
      const foreign = await call('POST', '/int/machine-accounts', { member: ADMIN, tenantId: TENANT_B, body: { name: 'Foreign dataset reader', scopes: ['open.disbursement.read'] } });
      const foreignToken = (await exchange(foreign.json.client_id as string, foreign.json.client_secret as string)).json.access_token as string;
      expect((await open('GET', '/open/v1/disbursement-lines', { bearer: foreignToken })).json).toMatchObject({ code: 'OPEN_DATASET_NOT_CERTIFIED' });
    });

    it('closes by itself when the certification is revoked, and reopens only when the organization switches it on for a certified product again', async () => {
      const state = (await call('GET', '/int/export-datasets', { member: READER })).json.items as Array<{ dataset_code: string; product_id: string; version: number }>;
      const disb = state.find((item) => item.dataset_code === 'DS-DISB') as { product_id: string; version: number };
      await rows("update machvon.data_product set certification_status = 'REVOKED', revoke_reason = 'Revoked for the open API test' where id = $1", [disb.product_id]);
      const closed = await open('GET', '/open/v1/disbursement-lines', { bearer: accountToken });
      expect(closed.json).toMatchObject({ code: 'OPEN_DATASET_NOT_CERTIFIED', reason: 'NOT_CERTIFIED' });
      expect(((await open('GET', '/open/v1/datasets', { bearer: accountToken })).json.items as Array<{ open: boolean }>)[0]?.open).toBe(false);
      const fresh = await seedProduct(TENANT_A, 'DP-FRESH');
      const off = await call('POST', '/int/export-datasets/state', { member: ADMIN, ifMatch: etag(disb.version), body: { dataset_code: 'DS-DISB', enabled: false, reason: REASON } });
      expect(off.json).toMatchObject({ status: 'DISABLED', resource_version: 3 });
      const on = await call('POST', '/int/export-datasets/state', { member: ADMIN, ifMatch: etag(3), body: { dataset_code: 'DS-DISB', enabled: true, product_id: fresh, reason: REASON } });
      expect(on.json).toMatchObject({ status: 'ENABLED', resource_version: 4 });
      expect((await open('GET', '/open/v1/disbursement-lines', { bearer: accountToken })).status).toBe(200);
    });
  });

  describe('the published document', () => {
    it('serves the subset for external readers without any authentication, and it is the file that is published', async () => {
      const served = await open('GET', '/open/v1/openapi.json');
      expect(served.status).toBe(200);
      expect(served.json).toEqual(JSON.parse(JSON.stringify(OPEN_API_DOCUMENT)));
      const file = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'open-api', 'openapi.json'), 'utf8')) as Record<string, unknown>;
      expect(served.json).toEqual(file);
      const text = JSON.stringify(served.json);
      expect(Object.keys(served.json.paths as object)).toEqual(['/open/v1/contract-lines', '/open/v1/datasets', '/open/v1/disbursement-lines', '/open/v1/openapi.json', '/open/v1/project-codes', '/open/v1/projects', '/open/v1/token']);
      expect(text).not.toMatch(/\/int\/|x-permission|machine-accounts|bi-readers|int\.account/);
    });
  });

  describe('the logins of BI tools', () => {
    const urlOf = (login: string, password: string): string => {
      const url = new URL(harness.database.urlFor('machvon_app'));
      url.username = login;
      url.password = password;
      return url.toString();
    };

    it('makes a login, shows the password once, and the login reads its own catalogue and nothing else', async () => {
      const key = `key-${randomUUID()}`;
      const made = await call('POST', '/int/bi-readers', { member: ADMIN, body: { name: 'Power BI Desktop', tool: 'Power BI', connection_limit: 3 }, key });
      expect(made.status).toBe(201);
      expect(made.json).toMatchObject({ shown_once: true, status: 'ACTIVE', schema_name: 'machvon_bi', resource_version: 1 });
      const password = made.json.password as string;
      expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/);
      const login = made.json.login_name as string;
      expect(login).toMatch(/^machvon_bi_[0-9a-f]{12}$/);
      expect((await call('POST', '/int/bi-readers', { member: ADMIN, body: { name: 'Power BI Desktop', tool: 'Power BI', connection_limit: 3 }, key })).json).toMatchObject({ password: '', login_name: login });
      for (const table of ['int_bi_reader', 'int_bi_reader_event', 'idempotency_record', 'audit_event', 'outbox_event']) {
        const found = await rows<{ n: string }>(`select count(*)::text as n from machvon.${table} t where to_jsonb(t)::text like '%' || $1 || '%'`, [password]);
        expect([table, found[0]?.n]).toEqual([table, '0']);
      }
      const client = new Client({ connectionString: urlOf(login, password) });
      client.on('error', () => undefined);
      await client.connect();
      clients.push(client);
      const catalogue = (await client.query('select dataset_code, is_open from v_dataset_catalogue order by dataset_code')).rows as Array<{ dataset_code: string; is_open: boolean }>;
      expect(catalogue.map((row) => [row.dataset_code, row.is_open])).toEqual([['DS-CTR', false], ['DS-DISB', true]]);
      expect(((await client.query('select 1 from v_disbursement_lines')).rows as unknown[]).length).toBe(3);
      // The negative test of R13, from the API side as well: another tenant's setting reads nothing.
      await client.query("select set_config('app.tenant_id', $1, false)", [TENANT_B]);
      expect(((await client.query('select 1 from v_disbursement_lines')).rows as unknown[]).length).toBe(0);
      await expect(client.query('select * from machvon.project')).rejects.toThrow(/permission denied/);
      const listed = await call('GET', '/int/bi-readers', { member: READER });
      expect(listed.json).toMatchObject({ schema_name: 'machvon_bi', can_create: false, counts: { ACTIVE: 1, SUSPENDED: 0, RETIRED: 0 } });
      expect((listed.json.views as Array<{ view: string; open: boolean }>).map((view) => [view.view, view.open])).toEqual([['v_disbursement_lines', true], ['v_contract_lines', false]]);
      expect(JSON.stringify(listed.json)).not.toContain(password);
      const readerId = made.json.reader_id as string;
      // Another tenant cannot see or touch it.
      expect((await call('GET', `/int/bi-readers/${readerId}`, { member: ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('POST', `/int/bi-readers/${readerId}/decision`, { member: ADMIN, tenantId: TENANT_B, ifMatch: etag(1), body: { decision: 'RETIRE', reason: REASON } })).status).toBe(404);
      expect((await call('POST', `/int/bi-readers/${readerId}/password`, { member: ADMIN, tenantId: TENANT_B, ifMatch: etag(1), body: { reason: REASON } })).status).toBe(404);
      // Rotation cuts the open session and gives a password that is shown once; suspension refuses the login; retirement drops it.
      const rotated = await call('POST', `/int/bi-readers/${readerId}/password`, { member: ADMIN, ifMatch: etag(1), body: { reason: REASON } });
      expect(rotated.json).toMatchObject({ shown_once: true, resource_version: 2 });
      await expect(client.query('select 1')).rejects.toThrow();
      const again = new Client({ connectionString: urlOf(login, rotated.json.password as string) });
      again.on('error', () => undefined);
      await again.connect();
      clients.push(again);
      expect(((await again.query('select 1 from v_disbursement_lines')).rows as unknown[]).length).toBe(3);
      expect((await call('POST', `/int/bi-readers/${readerId}/decision`, { member: ADMIN, ifMatch: etag(2), body: { decision: 'SUSPEND', reason: REASON } })).json).toMatchObject({ status: 'SUSPENDED' });
      await expect(new Client({ connectionString: urlOf(login, rotated.json.password as string) }).connect()).rejects.toThrow();
      expect((await call('POST', `/int/bi-readers/${readerId}/decision`, { member: ADMIN, ifMatch: etag(3), body: { decision: 'RETIRE', reason: REASON } })).json).toMatchObject({ status: 'RETIRED' });
      expect(await rows('select 1 from pg_roles where rolname = $1', [login])).toEqual([]);
      expect((await call('POST', `/int/bi-readers/${readerId}/password`, { member: ADMIN, ifMatch: etag(4), body: { reason: REASON } })).json).toMatchObject({ code: 'BI_READER_STATE_INVALID' });
      const detail = await call('GET', `/int/bi-readers/${readerId}`, { member: READER });
      expect((detail.json.events as Array<{ action: string }>).map((event) => event.action)).toEqual(['RETIRED', 'SUSPENDED', 'PASSWORD_ROTATED', 'PROVISIONED']);
      expect((await call('POST', '/int/bi-readers', { member: READER, body: { name: 'x' } })).status).toBe(403);
      expect((await call('POST', '/int/bi-readers', { member: ADMIN, body: { name: 'x', connection_limit: 99 } })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('the codes of our projects in other systems', () => {
    it('registers a system, proposes a code, needs another person to approve it, and then shows it to the open API', async () => {
      const registered = await call('POST', '/int/source-systems', { member: ADMIN, body: { code: 'EBS', name: 'Oracle EBS', kind: 'ERP', code_pattern: 'P-\\d{3}' } });
      expect(registered.status).toBe(201);
      expect(registered.json).toMatchObject({ code: 'EBS', status: 'ACTIVE', active_codes: 0, can_retire: true });
      expect((await call('POST', '/int/source-systems', { member: ADMIN, body: { code: 'EBS', name: 'Again', kind: 'ERP' } })).json).toMatchObject({ code: 'INT_SOURCE_SYSTEM_TAKEN' });
      expect((await call('POST', '/int/source-systems', { member: ADMIN, body: { code: 'MUASAMCONG', name: 'No', kind: 'OTHER' } })).status).toBe(422);
      expect((await call('POST', '/int/source-systems', { member: READER, body: { code: 'HPM', name: 'No', kind: 'FINANCE' } })).status).toBe(403);
      const bad = await call('POST', '/int/project-codes', { member: ADMIN, body: { source_system: 'EBS', our_code: 'AAA-1', external_code: 'WRONG', reason: REASON } });
      expect(bad.json).toMatchObject({ code: 'VALIDATION_FAILED' });
      const proposed = await call('POST', '/int/project-codes', { member: ADMIN, body: { source_system: 'EBS', our_code: 'AAA-1', external_code: 'P-100', reason: REASON } });
      expect(proposed.status).toBe(201);
      expect(proposed.json).toMatchObject({ status: 'PROPOSED', project_code: 'AAA-1', external_code: 'P-100', version: 1, actions: { decide: false, retire: false } });
      const id = proposed.json.id as string;
      expect(((await open('GET', '/open/v1/project-codes', { bearer: await tokenWith(['open.project-codes.read']) })).json.items as unknown[]).length).toBe(0);
      expect((await call('POST', `/int/project-codes/${id}/decision`, { member: ADMIN, ifMatch: etag(1), body: { decision: 'APPROVE', reason: REASON } })).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect((await call('POST', `/int/project-codes/${id}/decision`, { member: READER, ifMatch: etag(1), body: { decision: 'APPROVE', reason: REASON } })).status).toBe(403);
      const listed = await call('GET', '/int/project-codes?source_system=EBS', { member: CHECKER });
      expect((listed.json.items as Array<{ actions: { decide: boolean } }>)[0]?.actions.decide).toBe(true);
      const approved = await call('POST', `/int/project-codes/${id}/decision`, { member: CHECKER, ifMatch: etag(1), body: { decision: 'APPROVE', reason: REASON } });
      expect(approved.json).toMatchObject({ status: 'ACTIVE', resource_version: 2 });
      const token = await tokenWith(['open.project-codes.read', 'open.projects.read']);
      const codes = await open('GET', '/open/v1/project-codes?source_system=EBS&external_code=P-100', { bearer: token });
      expect(codes.json.items).toEqual([expect.objectContaining({ project_code: 'AAA-1', source_system: 'EBS', external_type: 'PROJECT_CODE', external_code: 'P-100', valid_until: null })]);
      const projects = (await open('GET', '/open/v1/projects?limit=1', { bearer: token })).json.items as Array<{ external_codes: Array<{ source_system: string; external_code: string }> }>;
      expect(projects[0]?.external_codes).toEqual([expect.objectContaining({ source_system: 'EBS', external_code: 'P-100' })]);
      const dup = await call('POST', '/int/project-codes', { member: ADMIN, body: { source_system: 'EBS', our_code: 'AAA-2', external_code: 'P-100', reason: REASON } });
      expect(dup.json).toMatchObject({ code: 'CROSSWALK_DUPLICATE', reason: 'EXTERNAL_CODE_TAKEN' });
      expect((await call('POST', `/int/source-systems/${registered.json.id as string}/retire`, { member: ADMIN, ifMatch: etag(1), body: { reason: REASON } })).json).toMatchObject({ code: 'INT_SOURCE_SYSTEM_IN_USE' });
      const retired = await call('POST', `/int/project-codes/${id}/retire`, { member: ADMIN, ifMatch: etag(2), body: { reason: REASON } });
      expect(retired.json).toMatchObject({ status: 'RETIRED' });
      expect(((await open('GET', '/open/v1/project-codes?source_system=EBS', { bearer: token })).json.items as unknown[]).length).toBe(0);
      expect((await call('POST', `/int/source-systems/${registered.json.id as string}/retire`, { member: ADMIN, ifMatch: etag(1), body: { reason: REASON } })).json).toMatchObject({ status: 'RETIRED' });
      // Another tenant sees none of this, and cannot decide on it.
      expect(((await call('GET', '/int/project-codes', { member: ADMIN, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
      expect(((await call('GET', '/int/source-systems', { member: ADMIN, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
      expect((await call('POST', `/int/project-codes/${id}/decision`, { member: ADMIN, tenantId: TENANT_B, ifMatch: etag(1), body: { decision: 'APPROVE', reason: REASON } })).status).toBe(404);
      expect((await call('POST', `/int/source-systems/${registered.json.id as string}/retire`, { member: ADMIN, tenantId: TENANT_B, ifMatch: etag(1), body: { reason: REASON } })).status).toBe(404);
    });

    it('refuses a code of a system that is also read by direct match when it is the code of another project, and counts how far the codes reach (ENT-3e, R25)', async () => {
      // The enterprise edition registers Oracle EBS and HPM this way when it loads; a public process registers none.
      registerDirectMatchSystem('ORACLE_EBS');
      const registered = await call('POST', '/int/source-systems', { member: ADMIN, body: { code: 'ORACLE_EBS', name: 'Oracle EBS', kind: 'ERP' } });
      expect(registered.status).toBe(201);
      const clash = await call('POST', '/int/project-codes', { member: ADMIN, body: { source_system: 'ORACLE_EBS', our_code: 'AAA-1', external_code: 'AAA-2', reason: REASON } });
      expect(clash.json).toMatchObject({ code: 'CROSSWALK_DUPLICATE', reason: 'EXTERNAL_CODE_IS_OTHER_PROJECT' });
      // Its own code is no clash: the direct reading and the mapping mean the same project.
      const own = await call('POST', '/int/project-codes', { member: ADMIN, body: { source_system: 'ORACLE_EBS', our_code: 'AAA-1', external_code: 'AAA-1', reason: REASON } });
      expect(own.status).toBe(201);
      const waiting = await call('GET', '/int/project-codes?source_system=ORACLE_EBS', { member: CHECKER });
      const beforeApproval = (waiting.json.coverage as Array<Record<string, unknown>>).find((row) => row.source_system === 'ORACLE_EBS');
      expect(beforeApproval).toMatchObject({ mapped: 0, proposed: 1, shadows: 0, direct_fallback: true, unmapped: 0 });
      expect((await call('POST', `/int/project-codes/${own.json.id as string}/decision`, { member: CHECKER, ifMatch: etag(1), body: { decision: 'APPROVE', reason: REASON } })).json).toMatchObject({ status: 'ACTIVE' });
      const approved = await call('GET', '/int/project-codes?source_system=ORACLE_EBS', { member: CHECKER });
      const coverage = (approved.json.coverage as Array<{ source_system: string; projects: number; mapped: number; direct_only: number; proposed: number }>).find((row) => row.source_system === 'ORACLE_EBS');
      expect(coverage).toMatchObject({ mapped: 1, proposed: 0, shadows: 0, direct_fallback: true });
      expect(coverage?.projects).toBeGreaterThan(1);
      expect(coverage?.direct_only).toBe((coverage?.projects ?? 0) - 1);
      // A system nobody registered for direct match has no fallback: the rest is called unmapped.
      const other = (approved.json.coverage as Array<{ source_system: string; direct_fallback: boolean; unmapped: number; projects: number }>).filter((row) => row.source_system !== 'ORACLE_EBS');
      for (const row of other) expect(row).toMatchObject({ direct_fallback: false, unmapped: row.projects });
    });

    async function tokenWith(scopes: string[]): Promise<string> {
      const account = await machine(`Codes reader ${randomUUID().slice(0, 8)}`, scopes);
      return account.token;
    }
  });
});
