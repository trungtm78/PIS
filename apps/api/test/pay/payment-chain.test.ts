import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { PaymentChainController } from '../../src/modules/pay/payment-chain.controller';
import { TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import { adminStatement, settledPayment } from '../../../../packages/db/test/support/settled-payment';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 61;
const SENDER = 62;
const CHECKER = 63;
const MATCHER = 64;
const AUDITOR = 65; // payment.chain.read over the tenant
const PROJECT_AUDITOR = 66; // payment.chain.read over the first project only
const READER = 67; // payment_request.read: no right to the chain
const GUEST = 68; // a guest contractor: whatever the grant, no chain
const MEMBERS = [MAKER, SENDER, CHECKER, MATCHER, AUDITOR, PROJECT_AUDITOR, READER, GUEST];
const OTHER_AUDITOR = 69; // of tenant B

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the trace of a payment over HTTP (ST-PAY-010, PAY-17, UAT-AC67)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function get(url: string, member: number, tenantId = TENANT_A): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId), 'content-type': 'application/json' } });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 501, 'PAY_AUDITOR', ['payment.chain.read'], 30);
    await harness.seedRole(TENANT_A, 502, 'PAY_ONLY_READ', ['payment_request.read'], 10);
    await fixtures.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST), fixtures.contractorId]);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUDITOR, role: 501, kind: 'TENANT' },
      { n: 2, member: PROJECT_AUDITOR, role: 501, kind: 'PROJECT', refs: [fixtures.projectId] },
      { n: 3, member: READER, role: 502, kind: 'TENANT' },
      { n: 4, member: GUEST, role: 501, kind: 'TENANT' },
    ]);
    // Tenant B has an auditor and a project of its own.
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, OTHER_AUDITOR, ROOT);
    await harness.seedRole(TENANT_B, 501, 'PAY_AUDITOR', ['payment.chain.read'], 30);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_AUDITOR, role: 501, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PaymentChainController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  it('is registered in the module of PAY', () => {
    expect(payModule.controllers).toEqual(expect.arrayContaining([PaymentChainController]));
  });

  it('UAT-AC67: gives the whole chain with the version of each node, and nothing that names a person', async () => {
    const paid = await settledPayment(fixtures, { maker: MAKER, sender: SENDER, checker: CHECKER, matcher: MATCHER });
    const reply = await get(`/payment-chain?project_id=${fixtures.projectId}&contract_id=${paid.contractId}`, AUDITOR);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ project_id: fixtures.projectId, contract_id: paid.contractId, truncated: [], totals: { counted_requests: 1, counted_gross_vnd: '3000000000', settled_gross_vnd: '3000000000' } });
    const nodes = reply.json.nodes as Array<{ type: string; id: string; version: number | null; revision: number | null; status: string | null; amount_vnd: string | null }>;
    expect([...new Set(nodes.map((node) => node.type))]).toEqual(['project', 'contract', 'measurement', 'acceptance', 'payment_request', 'treasury_transaction']);
    expect(nodes.find((node) => node.type === 'contract')).toMatchObject({ id: paid.contractId, revision: 1, status: 'ACTIVE', amount_vnd: '9000000000' });
    expect(nodes.find((node) => node.type === 'payment_request')).toMatchObject({ id: paid.paymentRequestId, status: 'SETTLED', amount_vnd: '3000000000' });
    expect(nodes.find((node) => node.type === 'treasury_transaction')).toMatchObject({ id: paid.transactionId, version: null, amount_vnd: '2100000000' });
    expect(nodes.filter((node) => node.type !== 'treasury_transaction').every((node) => typeof node.version === 'number')).toBe(true);
    expect((reply.json.edges as unknown[]).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(nodes[0] ?? {}).sort()).toEqual(['amount_vnd', 'contract_id', 'facts', 'id', 'label', 'revision', 'status', 'superseded', 'type', 'version']);
    // The chain tells no one's name or identifier: nobody of the fixtures appears in it.
    const text = JSON.stringify(reply.json);
    for (const member of [MAKER, SENDER, CHECKER, MATCHER, AUDITOR]) expect(text).not.toContain(memberId(member));
    expect(typeof reply.json.as_of).toBe('string');
  });

  it('gives every contract of the project when none is named', async () => {
    const reply = await get(`/payment-chain?project_id=${fixtures.projectId}`, AUDITOR);
    expect(reply.status).toBe(200);
    expect(reply.json.contract_id).toBeNull();
    expect((reply.json.nodes as Array<{ type: string }>).filter((node) => node.type === 'contract').length).toBeGreaterThanOrEqual(1);
  });

  it('answers 404 for a project that is not there, a project outside the scope, a contract of another project, and a contractor who is a guest', async () => {
    const paid = await settledPayment(fixtures, { maker: MAKER, sender: SENDER, checker: CHECKER, matcher: MATCHER });
    const other = await fixtures.world.publishedLine({ allocated: '1000000000' });
    await adminStatement(fixtures, "update machvon.project set status = 'IMPLEMENTATION' where id = $1::uuid", [other.projectId]);
    expect((await get(`/payment-chain?project_id=${randomUUID()}`, AUDITOR)).status).toBe(404);
    expect(await get(`/payment-chain?project_id=${other.projectId}&contract_id=${paid.contractId}`, AUDITOR)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    // The auditor of one project reads that project and no other.
    expect((await get(`/payment-chain?project_id=${fixtures.projectId}&contract_id=${paid.contractId}`, PROJECT_AUDITOR)).status).toBe(200);
    expect(await get(`/payment-chain?project_id=${other.projectId}`, PROJECT_AUDITOR)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    expect((await get(`/payment-chain?project_id=${other.projectId}`, AUDITOR)).status).toBe(200);
    // A guest contractor receives no chain, with any grant.
    expect(await get(`/payment-chain?project_id=${fixtures.projectId}&contract_id=${paid.contractId}`, GUEST)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('shows nothing of another tenant: its project is not there for ours, ours is not there for theirs, and a contract of theirs is not found under ours', async () => {
    const paid = await settledPayment(fixtures, { maker: MAKER, sender: SENDER, checker: CHECKER, matcher: MATCHER });
    const foreign = randomUUID();
    await adminStatement(
      fixtures,
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version)
       values ($1, $2::uuid, 'PRJ-B-CHAIN', 'Cầu của tenant B', $3::uuid, $4::uuid, 'INTERNAL', 1000, 'IMPLEMENTATION', 'B', '3000001', 1)`,
      [TENANT_B, foreign, unitId(ROOT), randomUUID()],
    );
    expect((await get(`/payment-chain?project_id=${foreign}`, OTHER_AUDITOR, TENANT_B)).status).toBe(200);
    expect(await get(`/payment-chain?project_id=${foreign}`, AUDITOR)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    expect(await get(`/payment-chain?project_id=${fixtures.projectId}&contract_id=${paid.contractId}`, OTHER_AUDITOR, TENANT_B)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    expect(await get(`/payment-chain?project_id=${foreign}&contract_id=${paid.contractId}`, OTHER_AUDITOR, TENANT_B)).toMatchObject({ status: 404 });
  });

  it('refuses a caller without the right to the chain, and a request that names no project or a project that is not an identifier', async () => {
    expect((await get(`/payment-chain?project_id=${fixtures.projectId}`, READER)).status).toBe(403);
    expect(await get('/payment-chain', AUDITOR)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await get('/payment-chain?project_id=nope', AUDITOR)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await get(`/payment-chain?project_id=${fixtures.projectId}&contract_id=nope`, AUDITOR)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
  });
});
