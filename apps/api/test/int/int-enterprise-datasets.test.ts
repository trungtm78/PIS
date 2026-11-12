import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Pool } from 'pg';
import { ControlDatabase, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { MachineRateLimiter, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { LocalTenantTokenIssuer, issuerKeyFromPem } from '../../src/auth/tenant-token-issuer';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { intModule } from '../../src/modules/int';
import { MachineAuthGuard, OPEN_API_SIGNER, OPEN_RATE_LIMITER, OpenApiService } from '../../src/modules/int/machine-auth';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

/**
 * INT-2: the datasets a tenant may switch on depend on the edition the process serves. The public process offers DS-DISB and DS-CTR only (what INT-1 tests pin); the enterprise process adds DS-ENT, lists its four
 * views to the screen of the BI logins and accepts the command that switches it on.
 */
const SIGNING_KEY = randomBytes(32);
const ADMIN = 1;
const ROOT = 1;
const REASON = 'Một lý do đủ mười ký tự';
const INT_ALL = ['int.account.read', 'int.account.manage', 'int.access.read', 'int.dataset.read', 'int.dataset.manage', 'int.bi.read', 'int.bi.manage'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the datasets of a tenant by edition over HTTP (INT-2)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let control: Pool;
  let product: string;
  const previousEdition = process.env.MACHVON_EDITION;

  async function call(method: string, url: string, options: { body?: unknown; ifMatch?: string } = {}): Promise<Reply> {
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: memberId(ADMIN), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_A, ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'INT_ADMIN', INT_ALL, 50);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: ADMIN, role: 1, kind: 'TENANT' }]);
    product = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.data_product (tenant_id, id, code, title, dataset_ids, owner_user_id, certification_status, certified_by, certified_at, certification_expires_on, evidence_refs, created_by, updated_by)
         values ($1, $2, 'DP-ENT-API', 'DP-ENT-API', $3::jsonb, $4, 'CERTIFIED', $5, now(), date '2099-01-01', '["evidence-1"]', $4, $4)`,
        [TENANT_A, product, JSON.stringify([randomUUID()]), memberId(ADMIN), memberId(2)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    control = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 2 });
    control.on('error', () => undefined);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const issuer = new LocalTenantTokenIssuer({ issuer: 'https://api.test', signingKey: issuerKeyFromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'int-enterprise-key') });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
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

  afterEach(() => {
    if (previousEdition === undefined) delete process.env.MACHVON_EDITION;
    else process.env.MACHVON_EDITION = previousEdition;
  });

  afterAll(async () => {
    if (app) await app.close();
    await control?.end();
    await harness.stop();
  }, 60_000);

  const codesOf = (json: Record<string, unknown>): string[] => (json.items as Array<{ dataset_code: string }>).map((item) => item.dataset_code);

  it('does not offer DS-ENT in the public edition, neither in the list nor to the command', async () => {
    delete process.env.MACHVON_EDITION;
    expect(codesOf((await call('GET', '/int/export-datasets')).json)).toEqual(['DS-CTR', 'DS-DISB']);
    const refused = await call('POST', '/int/export-datasets/state', { ifMatch: '"1"', body: { dataset_code: 'DS-ENT', enabled: true, product_id: product, reason: REASON } });
    expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    const readers = await call('GET', '/int/bi-readers');
    expect((readers.json.views as Array<{ view: string }>).map((view) => view.view)).toEqual(['v_disbursement_lines', 'v_contract_lines']);
  });

  it('offers DS-ENT in the enterprise edition: listed with its first view, switched on with a certified product, its four views told to the BI screen', async () => {
    process.env.MACHVON_EDITION = 'enterprise';
    const listed = await call('GET', '/int/export-datasets');
    expect(codesOf(listed.json)).toEqual(['DS-CTR', 'DS-DISB', 'DS-ENT']);
    const entry = (listed.json.items as Array<Record<string, unknown>>).find((item) => item.dataset_code === 'DS-ENT');
    expect(entry).toMatchObject({ view_name: 'v_enterprise_figures', scope: '', enabled: false, version: 1, gate: { open: false, reason: 'DISABLED' } });
    const on = await call('POST', '/int/export-datasets/state', { ifMatch: '"1"', body: { dataset_code: 'DS-ENT', enabled: true, product_id: product, reason: REASON } });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ status: 'ENABLED' });
    const after = (await call('GET', '/int/export-datasets')).json.items as Array<Record<string, unknown>>;
    expect(after.find((item) => item.dataset_code === 'DS-ENT')).toMatchObject({ enabled: true, gate: { open: true, reason: null }, product_code: 'DP-ENT-API' });
    const readers = await call('GET', '/int/bi-readers');
    const views = readers.json.views as Array<{ dataset_code: string; view: string; open: boolean }>;
    expect(views.map((view) => view.view)).toEqual(['v_disbursement_lines', 'v_contract_lines', 'v_enterprise_figures', 'v_enterprise_plan_actual', 'v_enterprise_funding_split', 'v_enterprise_by_unit']);
    expect(views.filter((view) => view.dataset_code === 'DS-ENT').map((view) => view.open)).toEqual([true, true, true, true]);
    expect(views.filter((view) => view.dataset_code !== 'DS-ENT').map((view) => view.open)).toEqual([false, false]);
  });

  it('still refuses a code no edition knows', async () => {
    process.env.MACHVON_EDITION = 'enterprise';
    const refused = await call('POST', '/int/export-datasets/state', { ifMatch: '"1"', body: { dataset_code: 'DS-NOPE', enabled: true, product_id: product, reason: REASON } });
    expect(refused.status).toBe(422);
  });
});
