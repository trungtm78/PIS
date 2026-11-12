import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CapitalCommitments } from '../../src/modules/cap/commitment.port';
import { BoqLineReadsController } from '../../src/modules/ctr/boq.controller';
import { ContractController, ContractReadsController } from '../../src/modules/ctr/contract.controller';
import { ContractLifecycleController } from '../../src/modules/ctr/lifecycle.controller';
import { MeasurementController, MeasurementReadsController } from '../../src/modules/ctr/measurement.controller';
import { CapWorld, money } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, TENANT_B, id, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb3;
const ROOT = 1;
const DRAFTER = 11; // contract.update, contract.read
const SUBMITTER = 12; // contract.review.submit, contract.read
const ACTIVATOR = 13; // contract.activate, contract.read
const GUEST = 14; // the contractor NT-A-01, invited to the contract HD-A-001 only
const MEMBERS = [DRAFTER, SUBMITTER, ACTIVATOR, GUEST];
const VALUE = '10000000000';

/**
 * Two UAT cases of the contract register over the same world: the guest contractor sees one contract and everything else is absent (FR-CTR-01, FR-CTR-03), and a joint venture whose members do not add up to 100 percent
 * is refused at the submission and by the database after the signature (FR-CTR-25, FR-CTR-02).
 */
describe('the contract register for a guest contractor and for a joint venture (UAT cases of CTR)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let cleanVersion = '';
  let period = '';
  let guestContractor = '';
  let otherContractor = '';

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);

  interface Seeded {
    id: string;
    code: string;
    revisionId: string;
    items: [string, string, string];
  }

  /**
   * A contract of a project with capital in force, with the bill of quantities of the fixture EXE-FX: B01 8,000 m3 at 500,000, B02 2,500 m3 at 2,000,000, B03 500 m2 at 2,000,000 (10 billion). A DRAFT one waits
   * for its review; an ACTIVE one is being performed and has its revision in force.
   */
  async function seedContract(code: string, contractorId: string, options: { status: 'DRAFT' | 'ACTIVE'; jointVenture?: boolean }): Promise<Seeded> {
    const line = await world.publishedLine({ allocated: money(60), appropriationAmount: money(80) });
    await world.owner("update machvon.project set status = 'IMPLEMENTATION' where id = $1::uuid", [line.projectId]);
    const contractId = randomUUID();
    const revisionId = randomUUID();
    const packageId = randomUUID();
    const items: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()];
    const active = options.status === 'ACTIVE';
    const boqLine = (n: number, key: string, unit: string, quantity: string, price: string, amount: string): [string, unknown[]] => [
      `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, 'HALF_UP', $11::numeric, 5, $12)`,
      [TENANT_A, revisionId, contractId, items[n - 1], n, key, `Item ${key}`, unit, quantity, price, amount, memberId(DRAFTER)],
    ];
    await seedAs(harness, [
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, allocation_line_id, created_by, version)
         values ($1, $2, $3, $4, 100000000000, 'OPEN_BIDDING', 1, 'AWARDED', 'Package', $5, $6, 1)`,
        [TENANT_A, packageId, line.projectId, `GT-${code}`, line.lineId, memberId(DRAFTER)],
      ],
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, estimate_ceiling_vnd,
            created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'CONSTRUCTION', $8, true, $9, 100000000000, $10, $10, $11::date, $12::date)`,
        [TENANT_A, contractId, line.projectId, packageId, contractorId, code, options.status, options.jointVenture === true, VALUE, memberId(DRAFTER), active ? '2026-03-01' : null, active ? '2026-03-01' : null],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, $4, $5, date '2026-03-01', $6, 'BASE', 1, $7, $7, $8, $9)`,
        [TENANT_A, revisionId, contractId, VALUE, cleanVersion, active ? 'EFFECTIVE' : 'DRAFT', memberId(DRAFTER), active ? memberId(DRAFTER) : null, active ? new Date().toISOString() : null],
      ],
      [
        `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
         values ($1, $2, $5, 'B01', 'Item B01', 'M3', $6, $6), ($1, $3, $5, 'B02', 'Item B02', 'M3', $6, $6), ($1, $4, $5, 'B03', 'Item B03', 'M2', $6, $6)`,
        [TENANT_A, items[0], items[1], items[2], contractId, memberId(DRAFTER)],
      ],
      boqLine(1, 'B01', 'M3', '8000', '500000', '4000000000'),
      boqLine(2, 'B02', 'M3', '2500', '2000000', '5000000000'),
      boqLine(3, 'B03', 'M2', '500', '2000000', '1000000000'),
      ['update machvon.contract set current_revision_id = $2 where id = $1::uuid', [contractId, revisionId]],
    ]);
    return { id: contractId, code, revisionId, items };
  }

  beforeAll(async () => {
    await world.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'CTR_DRAFTER', ['contract.update', 'contract.read'], 20],
      [2, 'CTR_SUBMITTER', ['contract.review.submit', 'contract.read'], 20],
      [3, 'CTR_ACTIVATOR', ['contract.activate', 'contract.read'], 50],
      [4, 'CTR_GUEST', ['contract.read', 'measurement.record', 'measurement.submit', 'measurement.read', 'boq_line.read'], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 70 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: DRAFTER, role: 71, kind: 'TENANT' },
      { n: 2, member: SUBMITTER, role: 72, kind: 'TENANT' },
      { n: 3, member: ACTIVATOR, role: 73, kind: 'TENANT' },
    ]);
    guestContractor = await seedContractor(harness, { name: 'Minh An Construction' });
    otherContractor = await seedContractor(harness, { name: 'Second Builders' });
    cleanVersion = id(FAMILY, 10);
    period = id(FAMILY, 20);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'Contract', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(DRAFTER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/contract.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, cleanVersion, id(FAMILY, 11)],
      ],
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, '2026-06', 1, date '2026-06-01', date '2026-06-28', date '2026-06-28' + interval '3 hours', 'CAL-M', 'MONTH', 2026, 'OPEN', gen_random_uuid(), $3, $3)`,
        [TENANT_A, period, memberId(DRAFTER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ContractController, ContractReadsController, ContractLifecycleController, BoqLineReadsController, MeasurementController, MeasurementReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
        CapitalCommitments,
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('UAT-AC301: a guest contractor sees HD-A-001 alone, HD-A-002 and the contract of another tenant as absent in every read, records a measurement on its own contract and cannot activate it', async () => {
    const own = await seedContract('HD-A-001', guestContractor, { status: 'ACTIVE' });
    const other = await seedContract('HD-A-002', otherContractor, { status: 'ACTIVE' });
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST), guestContractor]);
    await harness.seedGrants(TENANT_A, [{ n: 20, member: GUEST, role: 74, kind: 'CONTRACT', refs: [own.id] }]);
    // The contract of another tenant (TNT-B has HD-B-001): the token of the guest names tenant A, so it is out of sight for the database too.
    const foreign = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 'HD-B-001', 'UNIT_PRICE', 'VND', 'DRAFT', 1, 'Contract of tenant B', 'CONSTRUCTION', false, true, 1000, $6, $6)`,
        [TENANT_B, foreign, randomUUID(), randomUUID(), randomUUID(), memberId(1)],
      ],
    ]);

    // 1. The catalogue holds one row, and it does not carry the ledger or the ceiling.
    const list = await call('GET', '/resources/contract?limit=200', { member: GUEST });
    assertStatus(list, 200);
    const items = list.json.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.code)).toEqual(['HD-A-001']);
    expect(JSON.stringify(items)).not.toMatch(/accepted_total_vnd|requested_total_vnd|paid_total_vnd|retention_held_vnd|estimate_ceiling_vnd|ledger/);

    // 2. HD-A-002 by its id: 404 RESOURCE_NOT_FOUND (never 403) at the detail, the summary, the lines of its bill of quantities and the command that records a measurement.
    assertStatus(await call('GET', `/resources/contract/${other.id}`, { member: GUEST }), 404, 'RESOURCE_NOT_FOUND');
    assertStatus(await call('GET', `/contracts/${other.id}/summary`, { member: GUEST }), 404, 'RESOURCE_NOT_FOUND');
    const foreignLine = (await rows<{ id: string }>("select id from machvon.boq_line where contract_id = $1::uuid and business_key = 'B01'", [other.id]))[0];
    assertStatus(await call('GET', `/resources/boq_line/${foreignLine?.id}`, { member: GUEST }), 404, 'RESOURCE_NOT_FOUND');
    // The list of the lines of a contract outside the scope is an empty page: it does not say whether the contract exists.
    expect((await call('GET', `/resources/boq_line?contract_id=${other.id}&limit=200`, { member: GUEST })).json.items).toEqual([]);
    const refused = await call('POST', `/contracts/${other.id}/measurements`, {
      member: GUEST,
      body: { contract_revision_id: other.revisionId, boq_item_id: other.items[0], period_id: period, quantity_period: '10', reference_no: 'NK-FOREIGN', evidence_refs: [{ document_version_id: cleanVersion }] },
    });
    assertStatus(refused, 404, 'RESOURCE_NOT_FOUND');
    expect(await rows('select id from machvon.measurement where contract_id = $1::uuid', [other.id])).toEqual([]);

    // 3. The guest records a measurement of 4,000 m3 on its own contract.
    const recorded = await call('POST', `/contracts/${own.id}/measurements`, {
      member: GUEST,
      body: { contract_revision_id: own.revisionId, boq_item_id: own.items[0], period_id: period, quantity_period: '4000', reference_no: 'NK-A-001', evidence_refs: [{ document_version_id: cleanVersion }] },
    });
    assertStatus(recorded, 200);
    expect(recorded.json).toMatchObject({ status: 'DRAFT' });
    expect((await rows<{ actor_id: string }>("select actor_id from machvon.audit_event where resource_id = $1::uuid and action = 'measurement.recorded'", [recorded.json.resource_id]))[0]?.actor_id).toBe(memberId(GUEST));

    // 4. The contract of tenant B: 404.
    assertStatus(await call('GET', `/resources/contract/${foreign}`, { member: GUEST }), 404, 'RESOURCE_NOT_FOUND');

    // 5. The guest holds no right to activate: 403 SCOPE_DENIED, and the contract stays ACTIVE; the summary of its own contract shows the contract and nothing of the ledger.
    const activation = await call('POST', `/contracts/${own.id}/activate`, { member: GUEST, ifMatch: '"1"', body: { decision: 'approve', reason: 'The guest tries to activate.', evidence_ids: [], effective_from: '2026-03-01' } });
    assertStatus(activation, 403, 'SCOPE_DENIED');
    expect((await rows<{ status: string }>('select status from machvon.contract where id = $1::uuid', [own.id]))[0]?.status).toBe('ACTIVE');
    const summary = await call('GET', `/contracts/${own.id}/summary`, { member: GUEST });
    assertStatus(summary, 200);
    expect(JSON.stringify(summary.json)).not.toMatch(/accepted_total_vnd|requested_total_vnd|paid_total_vnd|retention_held_vnd|estimate_ceiling_vnd|ledger/);
    // The same read by the staff is not hidden by the route: the scope hid it.
    assertStatus(await call('GET', `/contracts/${other.id}/summary`, { member: ACTIVATOR }), 200);
  });

  it('UAT-AC306: a joint venture of 60 and 30 percent is refused at the review and by the command, 60 and 40 is sent to review with the work adding up to 10 billion, and the database refuses a dropped share after the signature', async () => {
    const target = await seedContract('HD-A-002-JV', guestContractor, { status: 'DRAFT', jointVenture: true });
    const party = (contractorId: string, role: string, share: string, work: string): Record<string, unknown> => ({ contractor_id: contractorId, role, share_pct: share, work_value_vnd: work });
    const replace = (version: number, parties: unknown[]): Promise<Reply> => call('POST', `/contracts/${target.id}/parties`, { member: DRAFTER, ifMatch: `"${version}"`, body: { parties } });
    const submit = (version: number): Promise<Reply> => call('POST', `/contracts/${target.id}/submit-review`, { member: SUBMITTER, ifMatch: `"${version}"`, body: {} });

    // 1. 60 + 30 is refused by the command, and nothing is stored.
    const short = await replace(1, [party(guestContractor, 'LEAD', '60', '6000000000'), party(otherContractor, 'MEMBER', '30', '3000000000')]);
    assertStatus(short, 422, 'JV_SHARE_NOT_100');
    expect(short.json.share_total).toBe('90.0000');
    expect(await rows('select 1 from machvon.contract_party where contract_id = $1::uuid', [target.id])).toEqual([]);
    // A set of members that adds up to 90 percent that reached the table by another way is refused at the submission.
    await seedAs(harness, [
      [
        `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, valid_from, status, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, $3, 'LEAD', 60, 6000000000, date '2026-03-01', 'ACTIVE', $5, $5), ($1, gen_random_uuid(), $2, $4, 'MEMBER', 30, 3000000000, date '2026-03-01', 'ACTIVE', $5, $5)`,
        [TENANT_A, target.id, guestContractor, otherContractor, memberId(DRAFTER)],
      ],
    ]);
    const refused = await submit(1);
    assertStatus(refused, 422, 'JV_SHARE_NOT_100');
    expect(refused.json.share_total).toBe('90.0000');
    expect((await rows<{ status: string }>('select status from machvon.contract where id = $1::uuid', [target.id]))[0]?.status).toBe('DRAFT');
    await seedAs(harness, [['delete from machvon.contract_party where contract_id = $1::uuid', [target.id]]]);

    // 2. 60 + 40 with the work of 6 and 4 billion: stored, the work adds up to the value of the contract, and the contract goes to review. A work that does not add up is refused.
    const heavy = await replace(1, [party(guestContractor, 'LEAD', '60', '6000000001'), party(otherContractor, 'MEMBER', '40', '4000000000')]);
    assertStatus(heavy, 422, 'BOQ_TOTAL_MISMATCH');
    const done = await replace(1, [party(guestContractor, 'LEAD', '60', '6000000000'), party(otherContractor, 'MEMBER', '40', '4000000000')]);
    assertStatus(done, 200);
    expect(await rows('select sum(work_value_vnd)::text as work, sum(share_pct)::text as share from machvon.contract_party where contract_id = $1::uuid', [target.id])).toEqual([{ work: VALUE, share: '100.0000' }]);
    const sent = await submit(2);
    assertStatus(sent, 200);
    expect(sent.json).toMatchObject({ status: 'IN_REVIEW' });

    // 3. After the signature the shares are held by the database: a direct update that leaves 60 and 50 fails at the commit with SQLSTATE 23514 and the rows stay as they were.
    await world.owner("update machvon.contract set status = 'SIGNED', signed_on = date '2026-10-25' where id = $1::uuid", [target.id]);
    await expect(world.owner('update machvon.contract_party set share_pct = 50 where contract_id = $1::uuid and contractor_id = $2::uuid', [target.id, otherContractor])).rejects.toMatchObject({ code: '23514' });
    expect(await rows('select sum(share_pct)::text as share from machvon.contract_party where contract_id = $1::uuid', [target.id])).toEqual([{ share: '100.0000' }]);
  });

  it('negative control of the contract cases: a check fed an answer that is not the refusal throws', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 404, 'RESOURCE_NOT_FOUND'));
    expectCheckFails(() => assertStatus({ status: 403, json: { code: 'SCOPE_DENIED' } }, 404, 'RESOURCE_NOT_FOUND'));
    expectCheckFails(() => expect(JSON.stringify({ accepted_total_vnd: '1' })).not.toMatch(/accepted_total_vnd/));
  });
});
