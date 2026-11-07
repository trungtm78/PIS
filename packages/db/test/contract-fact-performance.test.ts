import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { CtrFactStore, contractScope, loadAccessIn } from '../src/index';
import type { FactQuery, TenantTx } from '../src/index';
import { REPORT_SUMS } from '@machvon/kernel';
import { AuthzHarness, TENANT_A, id, memberId, unitId } from './support/authz-fixtures';

/**
 * R12 of the eng-review of the contract analytics: the portfolio over `contract_fact` is measured at the size of a province before anyone builds a table to make it faster. 50,000 contracts under 10 units, with their
 * revisions, packages, bids, results, changes, guarantees and joint-venture parties, row-level security on, a reader of the whole tenant and one of a single unit subtree. The budget is the p95 of the non-functional
 * requirement NFR-PERFORMANCE: 800 ms for what a screen asks (a page of the list and the totals of all of it, the sums of a report).
 */

jest.setTimeout(900_000);

const CONTRACTS = 50_000;
const UNITS = 10;
const PROJECTS = 500;
const CONTRACTORS = 300;
const CALLS = 15;
const P95_BUDGET_MS = 800;
const TENANT_READER = 40;
const UNIT_READER = 41;

const p95 = (samples: readonly number[]): number => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;

describe('the contract fact at the size of a province (R12: 50,000 contracts, 10 units, RLS on, p95 within 800 ms)', () => {
  const harness = new AuthzHarness();
  const store = new CtrFactStore();
  const now = new Date();
  const unitNumbers = Array.from({ length: UNITS }, (_, index) => index + 1);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: `/${unitId(1)}/` },
      ...unitNumbers.slice(1).map((n) => ({ n, path: `/${unitId(1)}/${unitId(n)}/`, parent: 1 })),
    ]);
    for (const n of [TENANT_READER, UNIT_READER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 70, 'PERF_READER', ['contract.read', 'contract.analytics.read', 'ledger.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: TENANT_READER, role: 70, kind: 'TENANT' },
      { n: 2, member: UNIT_READER, role: 70, kind: 'UNIT_SUBTREE', refs: [unitId(3)] },
    ]);
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      const units = unitNumbers.map(unitId);
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, investor_unit_id)
         select $1, gen_random_uuid(), 'PERF-' || n, 'PERF-' || n, ($2::uuid[])[(n % $3::int) + 1], gen_random_uuid(), 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B', ($2::uuid[])[1]
           from generate_series(1, $4::int) n`,
        [TENANT_A, units, UNITS, PROJECTS],
      );
      await client.query(
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         select $1, gen_random_uuid(), '1' || lpad(n::text, 9, '0'), 'Contractor ' || n, 'VERIFIED', gen_random_uuid() from generate_series(1, $2::int) n`,
        [TENANT_A, CONTRACTORS],
      );
      await client.query(
        `create temp table seed as
           select n, gen_random_uuid() as cid, gen_random_uuid() as pkg, gen_random_uuid() as rev,
                  (select p.id from (select id, row_number() over (order by code) r from machvon.project) p where p.r = (n % $2::int) + 1) as project_id,
                  (select k.id from (select id, row_number() over (order by legal_name) r from machvon.contractor) k where k.r = (n % $3::int) + 1) as contractor_id,
                  ((n % 1000) + 1)::bigint * 10000000 as value
             from generate_series(1, $1::int) n`,
        [CONTRACTS, PROJECTS, CONTRACTORS],
      );
      await client.query('create index seed_n on seed (n)');
      const member = memberId(TENANT_READER);
      const doc = id(0xc5, 1);
      await client.query(
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status)
         select $1::uuid, pkg, project_id, 'PKG-' || n, 100000000000, 'OPEN', 1, 'AWARDED' from seed`,
        [TENANT_A],
      );
      await client.query(
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by,
            signed_on, effective_from, completion_due, current_revision_id, requested_total_vnd, accepted_total_vnd, paid_total_vnd, advance_paid_vnd, advance_recovered_vnd, retention_held_vnd, retention_released_vnd)
         select $1::uuid, cid, project_id, pkg, contractor_id, 'HD-' || lpad(n::text, 6, '0'), 'LUMP_SUM', 'VND', case when n % 10 < 7 then 'ACTIVE' when n % 10 < 9 then 'DRAFT' else 'SIGNED' end, 1, 'Contract ' || n, 'CONSTRUCTION',
                n % 10 = 0, true, value, $2::uuid, $2::uuid, date '2026-01-01', date '2026-01-02', date '2027-01-01' + (n % 400), rev,
                (value / 2) * 9 / 10, value / 2, ((value / 2) * 9 / 10) * 8 / 10, case when n % 3 = 0 then value / 10 else 0 end, case when n % 3 = 0 then value / 20 else 0 end,
                case when n % 4 = 0 then value / 50 else 0 end, case when n % 8 = 0 then value / 100 else 0 end
           from seed`,
        [TENANT_A, member],
      );
      await client.query(
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         select $1::uuid, rev, cid, 1, value - case when n % 5 = 0 then value / 11 else 0 end, $3::uuid, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $2::uuid, $2::uuid, $2::uuid, now() from seed`,
        [TENANT_A, member, doc],
      );
      await client.query(
        `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, decision_document_id, outcome, status, submitted_by, approved_by, approved_at, created_by, updated_by)
         select $1::uuid, gen_random_uuid(), pkg, contractor_id, value - 1000, $3::uuid, 'AWARDED', 'APPROVED', $2::uuid, $4::uuid, now(), $2::uuid, $2::uuid from seed`,
        [TENANT_A, member, doc, memberId(UNIT_READER)],
      );
      await client.query(
        `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, bid_price_vnd, submitted_at, access_released_at, created_by)
         select $1::uuid, gen_random_uuid(), project_id, pkg, contractor_id, '[]'::jsonb, 1, 'RECEIVED', value - 1000, now(), now(), $2::uuid from seed
         union all
         select $1::uuid, gen_random_uuid(), project_id, pkg, (select k.id from (select id, row_number() over (order by legal_name) r from machvon.contractor) k where k.r = ((n + 7) % $3::int) + 1), '[]'::jsonb, 1, 'RECEIVED', value, now(), now(), $2
           from seed where n % 3 <> 0`,
        [TENANT_A, member, CONTRACTORS],
      );
      await client.query(
        `insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, approved_delta_vnd, effective_on,
            decision_document_version_id, decided_by, submitted_by, tier, cumulative_variation_pct, created_by, updated_by, decided_at, status_reason, resulting_revision_id)
         select $1::uuid, gen_random_uuid(), cid, rev, value / 11, 7, 'Change', 'APPROVED', 1, 'CR-' || n, 'CO', value / 11, date '2026-02-01', $3::uuid, $4::uuid, $2::uuid, 1 + n % 3, 9.09, $2::uuid, $2::uuid, now(), 'Approved', gen_random_uuid() from seed where n % 5 = 0`,
        [TENANT_A, member, doc, memberId(UNIT_READER)],
      );
      await client.query(
        `insert into machvon.guarantee (tenant_id, id, contract_id, kind, issuer, amount_vnd, expires_at, verification_status, status, guarantee_no, valid_from, created_by, updated_by, verified_by, verified_at, verification_method, verification_evidence_id)
         select $1::uuid, gen_random_uuid(), cid, 'PERFORMANCE', 'Bank', value / 20, now() + make_interval(days => (n % 300) - 30), 'VERIFIED', 'ACTIVE', 'BL-' || n, date '2026-01-02', $2::uuid, $2::uuid, $4::uuid, now(), 'ISSUER_CONFIRMATION', $3::uuid from seed where n % 2 = 0`,
        [TENANT_A, member, doc, memberId(UNIT_READER)],
      );
      await client.query(
        `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
         select $1::uuid, gen_random_uuid(), cid, contractor_id, 'LEAD', 60, 0, 'ACTIVE', date '2026-01-02', $2::uuid, $2::uuid from seed where n % 10 = 0
         union all
         select $1::uuid, gen_random_uuid(), cid, (select k.id from (select id, row_number() over (order by legal_name) r from machvon.contractor) k where k.r = ((n + 11) % $3::int) + 1), 'MEMBER', 40, 0, 'ACTIVE', date '2026-01-02', $2::uuid, $2::uuid from seed where n % 10 = 0`,
        [TENANT_A, member, CONTRACTORS],
      );
      // What autovacuum does on a live database: the planner judges the tables by their statistics.
      for (const table of ['project', 'contractor', 'procurement_package', 'contract', 'contract_revision', 'procurement_result', 'proposal', 'change_request', 'guarantee', 'contract_party', 'organization_unit']) await client.query(`analyze machvon.${table}`);
    } finally {
      await client.end();
    }
    // The aggregate of every contract: what the triggers keep after the load (the load itself is written with them off).
    await harness.owner(TENANT_A, [['select machvon.contract_aggregate_backfill()'], ['analyze machvon.contract_aggregate']]);
  }, 900_000);

  afterAll(() => harness.stop(), 60_000);

  async function queryFor(member: number, filters: FactQuery['filters'] = {}): Promise<{ run: <T>(work: (tx: TenantTx, query: FactQuery) => Promise<T>) => Promise<T> }> {
    return {
      run: (work) =>
        harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, async (tx) => {
          const access = await loadAccessIn(tx, memberId(member));
          const query: FactQuery = { asOf: now.toISOString().slice(0, 10), scope: contractScope(access, 'contract.read', now), ledgerScope: contractScope(access, 'ledger.read', now), filters };
          return work(tx, query);
        }),
    };
  }

  async function measure(label: string, member: number, filters: FactQuery['filters'], work: (tx: TenantTx, query: FactQuery) => Promise<unknown>): Promise<number> {
    const reader = await queryFor(member, filters);
    await reader.run(work);
    const samples: number[] = [];
    for (let call = 0; call < CALLS; call += 1) {
      const started = performance.now();
      await reader.run(work);
      samples.push(performance.now() - started);
    }
    const value = p95(samples);
    process.stdout.write(`R12 ${label}: p95 ${value.toFixed(0)} ms (median ${[...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]?.toFixed(0)} ms)
`);
    return value;
  }

  it('has the 50,000 contracts the budget is about', async () => {
    const [row] = await harness.owner<{ n: string; units: string }>(TENANT_A, [['select count(*)::text as n, (select count(*)::text from machvon.organization_unit) as units from machvon.contract']]);
    expect(row).toMatchObject({ n: String(CONTRACTS), units: String(UNITS) });
  });

  it('reads a page of the portfolio and the totals of all of it within the budget, for the whole tenant and for one unit', async () => {
    const page = (tx: TenantTx, query: FactQuery) => store.page(tx, query, { sort: 'code', direction: 'asc', limit: 51 });
    const totals = (tx: TenantTx, query: FactQuery) => store.reportSums(tx, query, 'portfolio-status', 'contract_status');
    const both = async (tx: TenantTx, query: FactQuery) => {
      await page(tx, query);
      await totals(tx, query);
    };
    expect(await measure('portfolio page + totals, tenant', TENANT_READER, {}, both)).toBeLessThanOrEqual(P95_BUDGET_MS);
    expect(await measure('portfolio page + totals, one unit subtree', UNIT_READER, {}, both)).toBeLessThanOrEqual(P95_BUDGET_MS);
    expect(await measure('portfolio page + totals, filtered (unit, status)', TENANT_READER, { unit: [unitId(4)], status: ['ACTIVE'] }, both)).toBeLessThanOrEqual(P95_BUDGET_MS);
    expect(await measure('portfolio page sorted by value desc', TENANT_READER, {}, (tx, query) => store.page(tx, query, { sort: 'contract_value_vnd', direction: 'desc', limit: 51 }))).toBeLessThanOrEqual(P95_BUDGET_MS);
  });

  it('reads the sums of every report within the budget', async () => {
    for (const code of Object.keys(REPORT_SUMS) as Array<keyof typeof REPORT_SUMS>) {
      expect(await measure(`sums of ${code}`, TENANT_READER, {}, (tx, query) => store.reportSums(tx, query, code))).toBeLessThanOrEqual(P95_BUDGET_MS);
    }
  });

  it('reads the contracts of the concentration within the budget', async () => {
    expect(await measure('inputs of the concentration', TENANT_READER, {}, (tx, query) => store.concentrationInputs(tx, query))).toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
