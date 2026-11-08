import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import ExcelJS from 'exceljs';
import { CtrFactStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { advanceRecoveryOf, guaranteeBandOf, loadErrorRegistry, matchStatusOf, signTenantContext, threeWayDefaults, timingOfRequests, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ContractAnalyticsController } from '../../src/modules/ctr/analytics.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

/**
 * CA-2: the money reports of the contract portfolio over HTTP. The agreement tests hold the server to the raw rows, each kind of figure to its own law: an additive total is the sum of the rows and of the Excel read
 * back, a ratio is of the sums, a status or a band the database cuts by is the one the kernel gives the same row, the earned value of a selection is the sum of its contracts and the point of its curve on the day,
 * and what a frozen snapshot does not hold is NOT_IN_SNAPSHOT and never a zero.
 */

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xc5;
const ROOT = 1;
const BQL1 = 2;
const BQL2 = 3;
const ADMIN = 10; // contract.read, contract.analytics.read, ledger.read on the whole tenant
const NO_LEDGER = 11; // contract.read, contract.analytics.read: no ledger
const MAKER = 12; // submits the acceptances
const MEMBERS = [ADMIN, NO_LEDGER, MAKER];
const M = (million: number): number => million * 1_000_000;
const day = (offset: number): string => vietnamDateOf(new Date(Date.now() + offset * 86_400_000));
const at = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString();

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
type Cells = Record<string, string | number | null>;
type Item = { contract_id: string; cells: Cells; na: Record<string, string> };
type Group = { key: string; totals: { rows: number; cells: Cells } };
interface Seed {
  code: string;
  project: string;
  line: string;
  contractor: string;
  status: string;
  value: number;
  requested?: number;
  accepted?: number;
  paid?: number;
  advancePaid?: number;
  advanceRecovered?: number;
  retentionHeld?: number;
  retentionReleased?: number;
  due?: string;
  changes?: Array<{ delta: number; tier: number | null; cumulative: string }>;
  guarantee?: { amount: number; expiresInDays: number };
  measured?: number;
}

describe('the money reports of the contract portfolio over HTTP (CA-2)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let tenants: TenantDatabase;
  const contractors: string[] = [];
  const ids: Record<string, string> = {};
  const revisions: Record<string, string> = {};
  const lines: Record<string, string> = {};
  const projects: Record<string, string> = {};
  let decision = '';
  let periodId = '';
  let frozenId = '';
  let counter = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(url: string, member = ADMIN): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { method: 'GET', headers: { [TENANT_HEADER]: tokenOf(member) } });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const items = (reply: Reply): Item[] => reply.json.items as Item[];
  const totals = (reply: Reply): { rows: number; ledger_rows: number; cells: Cells; na: Record<string, string>; indicators: Array<{ code: string; value: string | null; status: string; reason: string | null }> } => reply.json.totals as never;
  const byCode = (reply: Reply): Record<string, Item> => Object.fromEntries(items(reply).map((item) => [item.cells.code as string, item]));
  const groupsOf = (reply: Reply, dimension: string): Group[] => ((reply.json.breakdowns as Array<{ dimension: string; groups: Group[] }>).find((one) => one.dimension === dimension)?.groups ?? []) as Group[];
  const sumOf = (list: Item[], key: string): bigint => list.reduce((acc, item) => acc + BigInt(item.cells[key] === null || item.cells[key] === undefined ? '0' : String(item.cells[key])), 0n);

  async function seedContract(input: Seed): Promise<void> {
    const contractId = randomUUID();
    const packageId = randomUUID();
    const revisionId = randomUUID();
    const statements: Array<[string, unknown[]]> = [
      [`insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, allocation_line_id) values ($1, $2, $3, $4, 100000000000, 'OPEN', 1, 'AWARDED', $5)`, [TENANT_A, packageId, projects[input.project], `PKG-${input.code}`, lines[input.line]]],
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by,
            signed_on, effective_from, completion_due, current_revision_id, requested_total_vnd, accepted_total_vnd, paid_total_vnd, advance_paid_vnd, advance_recovered_vnd, retention_held_vnd, retention_released_vnd)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, $8, 'CONSTRUCTION', false, true, $9, $10, $10, date '2026-01-01', date '2026-01-02', $11::date, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [TENANT_A, contractId, projects[input.project], packageId, input.contractor, input.code, input.status, `Contract ${input.code}`, input.value, memberId(ADMIN), input.due ?? day(60), revisionId, input.requested ?? 0, input.accepted ?? 0, input.paid ?? 0, input.advancePaid ?? 0, input.advanceRecovered ?? 0, input.retentionHeld ?? 0, input.retentionReleased ?? 0],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, $4, $5, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $6, $6, $6, now())`,
        [TENANT_A, revisionId, contractId, input.value, decision, memberId(ADMIN)],
      ],
    ];
    for (const change of input.changes ?? []) {
      counter += 1;
      statements.push([
        `insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, approved_delta_vnd, effective_on,
            decision_document_version_id, decided_by, submitted_by, tier, cumulative_variation_pct, created_by, updated_by, decided_at, status_reason, resulting_revision_id)
         values ($1, $2, $3, $4, $5, 7, 'Change', 'APPROVED', 1, $6, 'CO', $5, date '2026-02-01', $7, $8, $9, $10, $11::numeric, $9, $9, now(), 'Approved', gen_random_uuid())`,
        [TENANT_A, randomUUID(), contractId, revisionId, change.delta, `CR-${input.code}-${counter}`, decision, memberId(ADMIN), memberId(NO_LEDGER), change.tier, change.cumulative],
      ]);
    }
    if (input.guarantee !== undefined) {
      statements.push([
        `insert into machvon.guarantee (tenant_id, id, contract_id, kind, issuer, amount_vnd, expires_at, verification_status, status, guarantee_no, valid_from, created_by, updated_by, verified_by, verified_at, verification_method, verification_evidence_id)
         values ($1, $2, $3, 'PERFORMANCE', 'Bank', $4, (now() + make_interval(days => $5::int)), 'VERIFIED', 'ACTIVE', $6, date '2026-01-02', $7, $7, $8, now(), 'ISSUER_CONFIRMATION', $9)`,
        [TENANT_A, randomUUID(), contractId, input.guarantee.amount, input.guarantee.expiresInDays, `BL-${input.code}`, memberId(ADMIN), memberId(NO_LEDGER), decision],
      ]);
    }
    if (input.measured !== undefined) {
      const item = randomUUID();
      statements.push(
        [`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, 'B01', 'Item', 'M3', $4, $4)`, [TENANT_A, item, contractId, memberId(ADMIN)]],
        [
          `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
           values ($1, gen_random_uuid(), $2, $3, $4, 1, 'B01', 'Item B01', 'M3', 1, $5::numeric, 'HALF_UP', $5::numeric, 5, $6)`,
          [TENANT_A, revisionId, contractId, item, input.measured, memberId(ADMIN)],
        ],
      );
    }
    await seedAs(harness, statements);
    ids[input.code] = contractId;
    revisions[input.code] = revisionId;
    if (input.measured !== undefined) {
      const lineId = (await rows<{ id: string }>('select id from machvon.boq_line where contract_id = $1::uuid', [contractId]))[0]?.id;
      const item = (await rows<{ id: string }>('select id from machvon.boq_item where contract_id = $1::uuid', [contractId]))[0]?.id;
      counter += 1;
      await seedAs(harness, [
        [
          `insert into machvon.measurement
             (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no, inspection_id,
              created_by, updated_by, submitted_by, submitted_at, decided_by, decided_at, version)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, 1, 1, 1, 'APPROVED', jsonb_build_array(jsonb_build_object('document_version_id', $7::text)), $8, $9, $10, $10, $10, now(), $11, now(), 1)`,
          [TENANT_A, contractId, revisionId, lineId, item, periodId, decision, `NK-${counter}`, null, memberId(MAKER), memberId(ADMIN)],
        ],
      ]);
    }
  }

  /** An approved acceptance of a contract on a day; returns its id (a payment request points at it). */
  async function accept(code: string, amount: number, approvedAt: string): Promise<string> {
    counter += 1;
    const acceptanceId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, signer_refs, status, version, acceptance_no, accepted_amount_vnd, approved_at, decided_by, decision_reason, submitted_by, submitted_at, created_by, updated_by)
         values ($1, $2, $3, jsonb_build_array($4::text), $5, '[]'::jsonb, 'APPROVED', 3, $6, $7::numeric, $8::timestamptz, $9, 'Checked.', $10, $8::timestamptz, $10, $10)`,
        [TENANT_A, acceptanceId, ids[code], randomUUID(), decision, `NT-C2-${counter}`, amount, approvedAt, memberId(ADMIN), memberId(MAKER)],
      ],
    ]);
    return acceptanceId;
  }

  /** A payment request of a contract: submitted on a day, certified on a day, and (when `sentOn` is given) sent to the Treasury on a day. */
  async function request(code: string, acceptanceId: string, gross: number, submittedAt: string, options: { verifiedAt?: string; sentOn?: string; status?: string } = {}): Promise<void> {
    counter += 1;
    const status = options.status ?? (options.sentOn === undefined ? 'VERIFIED' : 'SENT_TREASURY');
    await seedAs(harness, [
      [
        `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, request_kind, request_no, claims_acceptance,
            submitted_by, submitted_at, verified_by, verified_at, created_by, updated_by)
         values ($1, $2, (select project_id from machvon.contract where id = $3::uuid), $3, $4, 'VND', $5::numeric, 0, 0, 0, $5::numeric, $6, 1, 'INTERIM', $7, true, $8, $9::timestamptz, $10, $11::timestamptz, $8, $8)`,
        [TENANT_A, randomUUID(), ids[code], acceptanceId, gross, status, `DNTT-C2-${counter}`, memberId(MAKER), submittedAt, memberId(ADMIN), options.verifiedAt ?? submittedAt],
      ],
    ]);
    if (options.sentOn !== undefined) {
      await rows(`update machvon.payment_request set treasury_sent_by = $2::uuid, treasury_sent_at = $3::timestamptz, treasury_submitted_on = $4::date where request_no = $1`, [`DNTT-C2-${counter}`, memberId(ADMIN), `${options.sentOn}T05:00:00Z`, options.sentOn]);
    }
  }

  const freeze = (periodSnapshotId: string) => tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => new CtrFactStore().buildFor(tx, periodSnapshotId, WORKER_MEMBERSHIP_ID));

  async function rule(type: string, params: Record<string, unknown>): Promise<void> {
    await world.owner(
      `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
       values ($1, $2, $3, 'DEFAULT', 1, 'APPROVED', $4::jsonb, '2026-01-01', 'Confirmed by the board', $5, $6, now(), $7, now())`,
      [TENANT_A, randomUUID(), type, JSON.stringify(params), memberId(ADMIN), memberId(NO_LEDGER), memberId(MAKER)],
    );
  }
  const cleanRules = (type: string): Promise<unknown[]> => world.owner('delete from machvon.governance_rule where rule_type = $1', [type]);

  beforeAll(async () => {
    await world.start();
    // The register keeps paid <= requested <= accepted (contract_ledger_order_chk), so the statuses that guard the order (paid beyond accepted, requested beyond accepted) cannot arise from it. The rule of the report must
    // still judge them the same way in the kernel and in the database, so this test database runs without that check to put such a contract in front of both.
    await world.owner('alter table machvon.contract drop constraint contract_ledger_order_chk');
    await harness.seedUnits(TENANT_A, [{ n: BQL2, path: `/${unitId(ROOT)}/${unitId(BQL2)}/`, parent: ROOT }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const all = ['contract.read', 'contract.analytics.read', 'ledger.read'];
    await harness.seedRole(TENANT_A, 91, 'CA2_ALL', all, 50);
    await harness.seedRole(TENANT_A, 92, 'CA2_NO_LEDGER', ['contract.read', 'contract.analytics.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 91, kind: 'TENANT' },
      { n: 2, member: NO_LEDGER, role: 92, kind: 'TENANT' },
      { n: 3, member: MAKER, role: 92, kind: 'TENANT' },
    ]);
    for (let n = 0; n < 3; n += 1) contractors.push(await seedContractor(harness, { name: `Contractor ${n + 1}` }));
    decision = id(FAMILY, 10);
    const first = await world.publishedLine({ unitNumber: BQL1, fundVersionId: await world.fundSource('NSTW') });
    const second = await world.publishedLine({ unitNumber: BQL2, fundVersionId: await world.fundSource('NSDP') });
    projects.P1 = first.projectId;
    projects.P2 = second.projectId;
    lines.P1 = first.lineId;
    lines.P2 = second.lineId;
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(ADMIN)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/decision.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, decision, id(FAMILY, 11)],
      ],
    ]);
    periodId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, '2031-01', 1, date '2031-01-01', date '2031-01-31', now(), 'DEFAULT', 'MONTH', 2031, 'OPEN', $3, $4, $4)`,
        [TENANT_A, periodId, randomUUID(), WORKER_MEMBERSHIP_ID],
      ],
    ]);
    const [k1, k2, k3] = contractors as [string, string, string];
    // M1: paid beyond accepted (OVER_PAID), 60 days late, an advance recovered slowly, retention, a guarantee that lapses in 20 days, two tiers of change.
    await seedContract({ code: 'M-1', project: 'P1', line: 'P1', contractor: k1, status: 'ACTIVE', value: M(1000), requested: M(900), accepted: M(800), paid: M(850), measured: M(800), advancePaid: M(200), advanceRecovered: M(50), retentionHeld: M(40), retentionReleased: M(10), due: day(-60), changes: [{ delta: M(20), tier: 1, cumulative: '2.00' }, { delta: M(80), tier: 2, cumulative: '10.00' }], guarantee: { amount: M(100), expiresInDays: 20 } });
    // M2: matched (measured = accepted = requested), an advance recovered in step, a guarantee far away, a tier 3 reduction and a change that has no tier.
    await seedContract({ code: 'M-2', project: 'P1', line: 'P1', contractor: k2, status: 'ACTIVE', value: M(3000), requested: M(1900), accepted: M(1900), paid: M(1500), measured: M(1900), advancePaid: M(600), advanceRecovered: M(600), changes: [{ delta: -M(50), tier: 3, cumulative: '12.00' }, { delta: M(10), tier: null, cumulative: '1.00' }], guarantee: { amount: M(300), expiresInDays: 200 } });
    // M3: of a project with no baseline; measured work that was not accepted.
    await seedContract({ code: 'M-3', project: 'P2', line: 'P2', contractor: k1, status: 'ACTIVE', value: M(5000), requested: M(1000), accepted: M(1000), paid: M(800), measured: M(1500) });
    // M4: matched, never linked to a package.
    await seedContract({ code: 'M-4', project: 'P2', line: 'P2', contractor: k3, status: 'ACTIVE', value: M(700), requested: M(700), accepted: M(700), paid: M(700), measured: M(700), due: day(-100) });
    await seedContract({ code: 'M-5', project: 'P1', line: 'P1', contractor: k2, status: 'DRAFT', value: M(500) });
    // The baseline of project P1: one package of 4 billion planned over the year of the as-of day, version 0, and the two contracts of it linked.
    const component = randomUUID();
    const baseline = randomUUID();
    const year = new Date().getUTCFullYear();
    const other = randomUUID();
    await seedAs(harness, [
      [`insert into machvon.project_component (tenant_id, id, project_id, code, name, planned_value_vnd, valid_from, created_by, updated_by) values ($1, $2, $3, 'PK-A', 'Package A', 4000000000, date '2020-01-01', $4, $4)`, [TENANT_A, component, projects.P1, memberId(ADMIN)]],
      [`insert into machvon.project_component (tenant_id, id, project_id, code, name, planned_value_vnd, valid_from, created_by, updated_by) values ($1, $2, $3, 'PK-B', 'Package B', 5000000000, date '2020-01-01', $4, $4)`, [TENANT_A, other, projects.P2, memberId(ADMIN)]],
      [`insert into machvon.project_component_contract (tenant_id, id, project_id, component_id, contract_id, linked_by) values ($1, gen_random_uuid(), $2, $3, $4, $5)`, [TENANT_A, projects.P2, other, ids['M-3'], memberId(ADMIN)]],
      [
        `insert into machvon.project_baseline (tenant_id, id, project_id, version, kind, basis, total_investment_vnd, bac_vnd, planned_start, planned_finish, taken_by) values ($1, $2, $3, 0, 'V0', 'BASELINE', 4000000000, 4000000000, $4::date, $5::date, $6)`,
        [TENANT_A, baseline, projects.P1, `${year - 1}-01-01`, `${year + 1}-12-31`, memberId(ADMIN)],
      ],
      [
        `insert into machvon.project_baseline_line (tenant_id, id, baseline_id, project_id, component_id, code, name, bac_vnd, planned_start, planned_finish) values ($1, gen_random_uuid(), $2, $3, $4, 'PK-A', 'Package A', 4000000000, $5::date, $6::date)`,
        [TENANT_A, baseline, projects.P1, component, `${year - 1}-01-01`, `${year + 1}-12-31`],
      ],
      [`insert into machvon.project_component_contract (tenant_id, id, project_id, component_id, contract_id, linked_by) values ($1, gen_random_uuid(), $2, $3, $4, $5), ($1, gen_random_uuid(), $2, $3, $6, $5)`, [TENANT_A, projects.P1, component, ids['M-1'], memberId(ADMIN), ids['M-2']]],
    ]);
    // The work: acceptances (what EVM earns from) and requests (what it costs, and the payment clock). M-1: accepted 14 days before its request (on time) and 20 days before another (late).
    const a1 = await accept('M-1', M(500), at(-100));
    const a2 = await accept('M-1', M(300), at(-50));
    await request('M-1', a1, M(450), at(-90), { verifiedAt: at(-88), sentOn: day(-85) });
    await request('M-1', a2, M(400), at(-30), { verifiedAt: at(-28) });
    const a3 = await accept('M-2', M(1900), at(-70));
    await request('M-2', a3, M(1500), at(-65), { verifiedAt: at(-60) });
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ContractAnalyticsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  describe('schedule: the earned value and the S-curve (R3)', () => {
    it('gives each linked contract its share of the package, and the total is the sum of the rows, to the dong', async () => {
      const reply = await call('/contracts/analytics/reports/schedule-delay');
      expect(reply.status).toBe(200);
      const found = byCode(reply);
      // The package of 4 billion is cut by the values of its two contracts, 1 and 3 billion.
      expect(found['M-1']?.cells.bac_vnd).toBe(String(M(1000)));
      expect(found['M-2']?.cells.bac_vnd).toBe(String(M(3000)));
      // Earned: the budget of the contract times the share of it that was accepted (500 + 300 of 1000 for M-1).
      expect(found['M-1']?.cells.earned_value_vnd).toBe(String(M(800)));
      expect(found['M-2']?.cells.earned_value_vnd).toBe(String(M(1900)));
      expect(found['M-1']?.cells.actual_cost_vnd).toBe(String(M(850)));
      expect(found['M-1']?.cells.schedule_variance_vnd).toBe((BigInt(found['M-1']?.cells.earned_value_vnd as string) - BigInt(found['M-1']?.cells.planned_value_vnd as string)).toString());
      const server = totals(reply);
      for (const key of ['bac_vnd', 'planned_value_vnd', 'earned_value_vnd', 'actual_cost_vnd', 'schedule_variance_vnd']) expect(server.cells[key]).toBe(sumOf(items(reply), key).toString());
      // The ratio is of the sums, not the mean of the ratios.
      const ev = BigInt(server.cells.earned_value_vnd as string);
      const ac = BigInt(server.cells.actual_cost_vnd as string);
      const scaled = (ev * 10_000n * 2n + ac) / (2n * ac);
      expect(server.cells.cpi).toBe(`${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, '0')}`);
      expect(server.indicators.map((one) => one.code)).toEqual(expect.arrayContaining(['SPI', 'CPI']));
    });

    it('says why a contract has no figure and what the selection covers: none is a zero', async () => {
      const reply = await call('/contracts/analytics/reports/schedule-delay');
      const found = byCode(reply);
      expect(found['M-3']?.cells.spi).toBeNull();
      expect(found['M-3']?.na.spi).toBe('NO_BASELINE');
      expect(found['M-4']?.na.earned_value_vnd).toBe('NO_CONTRACT_LINK');
      expect(found['M-5']?.na.bac_vnd).toBe('NO_CONTRACT_LINK');
      expect(reply.json.evm).toMatchObject({ status: 'OK', coverage: { contracts: 5, covered: 2, missing: { NO_CONTRACT_LINK: 2, NO_BASELINE: 1 }, v0_contracts: 2 }, policy: { source: 'BUILT_IN' } });
      const only = await call(`/contracts/analytics/reports/schedule-delay?project=${projects.P2}`);
      expect(only.json.evm).toMatchObject({ status: 'UNAVAILABLE', reason: 'NO_BASELINE', coverage: { covered: 0 } });
      expect(totals(only).cells.earned_value_vnd).toBeNull();
      expect(totals(only).na.earned_value_vnd).toBe('NO_BASELINE');
    });

    it('draws the curve of the selection: its point on the day of the view is the sum of the rows, the original plan is the one of version 0, and the days to come have no earned value', async () => {
      const curve = await call('/contracts/analytics/reports/schedule-delay/s-curve');
      expect(curve.status).toBe(200);
      const report = await call('/contracts/analytics/reports/schedule-delay');
      const points = (curve.json.curve as { points: Array<{ day: string; pv_v0_vnd: string | null; pv_current_vnd: string; ev_vnd: string | null; ac_vnd: string | null }>; v0_complete: boolean; contracts: number }).points;
      const today = points.find((point) => point.day === day(0));
      expect(today).toMatchObject({ ev_vnd: totals(report).cells.earned_value_vnd, ac_vnd: totals(report).cells.actual_cost_vnd, pv_current_vnd: totals(report).cells.planned_value_vnd });
      expect((curve.json.curve as { v0_complete: boolean }).v0_complete).toBe(true);
      expect(points.at(-1)).toMatchObject({ pv_current_vnd: String(M(4000)), ev_vnd: null, ac_vnd: null });
      expect(points.every((point) => point.pv_v0_vnd !== null)).toBe(true);
      expect(curve.json.evm).toMatchObject({ status: 'OK', figures: { ev_vnd: totals(report).cells.earned_value_vnd } });
      // A contract of a project with no baseline has no curve and no flat line at zero.
      const none = await call(`/contracts/analytics/reports/schedule-delay/s-curve?project=${projects.P2}`);
      expect(none.json.curve).toMatchObject({ points: [], contracts: 0 });
    });

    it('shows no earned value to a reader without the ledger, and refuses a curve of a frozen period', async () => {
      const reply = await call('/contracts/analytics/reports/schedule-delay', NO_LEDGER);
      expect(byCode(reply)['M-1']?.na.earned_value_vnd).toBe('LEDGER_DENIED');
      expect(totals(reply).cells.earned_value_vnd).toBeNull();
      expect((await call('/contracts/analytics/reports/schedule-delay/s-curve', NO_LEDGER)).json.evm).toMatchObject({ status: 'UNAVAILABLE', coverage: { contracts: 0 } });
      expect((await call('/contracts/analytics/reports/schedule-delay/s-curve?period=2031-01')).status).toBe(422);
      expect((await call('/contracts/analytics/reports/schedule-delay/s-curve?as_of=2999-01-01')).status).toBe(422);
    });
  });

  describe('payments: the three-way match and the clock (R4)', () => {
    it('gives each contract the status the kernel gives its four figures, and the groups the database cuts are the same statuses', async () => {
      const reply = await call('/contracts/analytics/reports/payment-three-way');
      const found = byCode(reply);
      const rowsRaw = await rows<{ code: string; measured: string; requested: string; accepted: string; paid: string }>(
        `select c.code, f.measured_vnd::text as measured, c.requested_total_vnd::text as requested, c.accepted_total_vnd::text as accepted, c.paid_total_vnd::text as paid from machvon.contract c join machvon.contract_fact f on f.id = c.id`,
      );
      const expected = new Map(rowsRaw.map((row) => [row.code, matchStatusOf({ measuredVnd: row.measured, requestedVnd: row.requested, acceptedVnd: row.accepted, paidVnd: row.paid }, threeWayDefaults())]));
      for (const [code, status] of expected) expect(found[code]?.cells.match_status).toBe(status);
      expect(found['M-1']?.cells.match_status).toBe('OVER_PAID');
      expect(found['M-2']?.cells.match_status).toBe('MATCHED');
      expect(found['M-3']?.cells.match_status).toBe('MEASURED_NOT_ACCEPTED');
      expect(found['M-5']?.cells.match_status).toBe('NO_ACTIVITY');
      const groups = groupsOf(reply, 'match_status');
      const counted = new Map<string, number>();
      for (const status of expected.values()) counted.set(status, (counted.get(status) ?? 0) + 1);
      expect(Object.fromEntries(groups.map((group) => [group.key, group.totals.rows]))).toEqual(Object.fromEntries(counted));
      expect(groups.reduce((acc, group) => acc + group.totals.rows, 0)).toBe(totals(reply).rows);
      // The measured work is read from the approved measurements at the price of their line.
      expect(found['M-3']?.cells.measured_vnd).toBe(String(M(1500)));
      expect(found['M-3']?.cells.measured_not_accepted_vnd).toBe(String(M(500)));
    });

    it('adds up: the gap and the counts are sums of the rows, the ratio is of the sums', async () => {
      const reply = await call('/contracts/analytics/reports/payment-three-way');
      const server = totals(reply);
      for (const key of ['measured_vnd', 'accepted_vnd', 'measured_not_accepted_vnd', 'payments_judged', 'payments_on_time']) expect(String(server.cells[key])).toBe(sumOf(items(reply), key).toString());
      const accepted = sumOf(items(reply), 'accepted_vnd');
      const measured = sumOf(items(reply), 'measured_vnd');
      expect(server.cells.measured_to_accepted_pct).toBe(`${((accepted * 20_000n + measured) / (2n * measured)) / 100n}.${(((accepted * 20_000n + measured) / (2n * measured)) % 100n).toString().padStart(2, '0')}`);
    });

    it('judges every payment request by the clock, one by one, as the kernel does, and a contract is late exactly when one of its requests is', async () => {
      const reply = await call('/contracts/analytics/reports/payment-three-way');
      const found = byCode(reply);
      const raw = await rows<{ code: string; a: number | null; b: number | null }>(
        `select c.code,
                case when pr.request_kind <> 'ADVANCE' and a.approved_at is not null and pr.submitted_at is not null and pr.status in ('SUBMITTED','VERIFIED','SENT_TREASURY','SETTLED') then (pr.submitted_at at time zone 'Asia/Ho_Chi_Minh')::date - (a.approved_at at time zone 'Asia/Ho_Chi_Minh')::date end as a,
                case when pr.status in ('SENT_TREASURY','SETTLED') and pr.treasury_submitted_on is not null and pr.submitted_at is not null then pr.treasury_submitted_on - (pr.submitted_at at time zone 'Asia/Ho_Chi_Minh')::date end as b
           from machvon.payment_request pr join machvon.contract c on c.id = pr.contract_id left join machvon.acceptance a on a.id = pr.acceptance_id`,
      );
      const clock = { acceptance_to_request_days: 14, request_to_treasury_days: 7 };
      for (const code of ['M-1', 'M-2']) {
        const timing = timingOfRequests(raw.filter((row) => row.code === code).map((row) => ({ acceptanceToRequestDays: row.a === null ? null : Number(row.a), requestToTreasuryDays: row.b === null ? null : Number(row.b) })), clock);
        expect([found[code]?.cells.payments_judged, found[code]?.cells.payments_on_time]).toEqual([timing.judged, timing.onTime]);
        expect((found[code]?.cells.payment_clock === 'LATE') === (timing.onTime < timing.judged)).toBe(true);
      }
      // M-1: the first request took 10 days (on time) and the second 20 (late): one of two.
      expect(found['M-1']?.cells.on_time_payment_pct).toBe('50.00');
      expect(found['M-5']?.cells.on_time_payment_pct).toBeNull();
      expect(found['M-5']?.na.on_time_payment_pct).toBe('NO_PAYMENT_JUDGED');
      expect(totals(reply).cells.on_time_payment_pct).toBe(totals(reply).indicators.find((one) => one.code === 'ON_TIME_PAYMENT_RATE')?.value);
    });

    it('moves a status with the rule of the tenant, and names the rule and its version in the answer', async () => {
      await rule('CONTRACT_THREE_WAY_MATCH', { tolerance_pct: 60, tolerance_vnd: 0 });
      try {
        const reply = await call('/contracts/analytics/reports/payment-three-way');
        expect(byCode(reply)['M-1']?.cells.match_status).toBe('MATCHED');
        expect(byCode(reply)['M-3']?.cells.match_status).toBe('MATCHED');
        expect((reply.json.rules as Array<{ type: string; version: number; source: string; params: Record<string, number> }>).find((one) => one.type === 'CONTRACT_THREE_WAY_MATCH')).toMatchObject({ version: 1, source: 'RULE', params: { tolerance_pct: 60, tolerance_vnd: 0 } });
        expect(groupsOf(reply, 'match_status').find((group) => group.key === 'MATCHED')?.totals.rows).toBe(4);
      } finally {
        await cleanRules('CONTRACT_THREE_WAY_MATCH');
      }
      const back = await call('/contracts/analytics/reports/payment-three-way');
      expect(byCode(back)['M-1']?.cells.match_status).toBe('OVER_PAID');
      expect((back.json.rules as Array<{ type: string; source: string; unverified: boolean }>).find((one) => one.type === 'CONTRACT_THREE_WAY_MATCH')).toMatchObject({ source: 'DEFAULT', unverified: true });
    });
  });

  describe('advances: recovered as fast as the work was accepted (R5)', () => {
    it('gives each contract what it should have recovered and what it is short, as the kernel does, and the totals are sums of the rows', async () => {
      const reply = await call('/contracts/analytics/reports/advance-ageing');
      const found = byCode(reply);
      const raw = await rows<{ code: string; paid: string; recovered: string; accepted: string; value: string }>(
        `select code, advance_paid_vnd::text as paid, advance_recovered_vnd::text as recovered, accepted_total_vnd::text as accepted, contract_value_vnd::text as value from machvon.contract where advance_paid_vnd > 0`,
      );
      for (const row of raw) {
        const one = advanceRecoveryOf({ advancePaidVnd: row.paid, advanceRecoveredVnd: row.recovered, acceptedVnd: row.accepted, contractValueVnd: row.value }, 0n);
        expect([found[row.code]?.cells.advance_expected_recovery_vnd, found[row.code]?.cells.advance_recovery_shortfall_vnd, found[row.code]?.cells.recovery_status]).toEqual([one?.expectedVnd, one?.shortfallVnd, one?.status]);
      }
      // M-1: 200 paid, 800 of 1000 accepted: 160 should be back, 50 is: 110 short. M-2 is recovered in full.
      expect(found['M-1']?.cells).toMatchObject({ advance_expected_recovery_vnd: String(M(160)), advance_recovery_shortfall_vnd: String(M(110)), recovery_status: 'BEHIND' });
      expect(found['M-2']?.cells.recovery_status).toBe('RECOVERED');
      expect(found['M-3']?.na.recovery_status).toBe('NO_ADVANCE');
      const server = totals(reply);
      expect(server.cells.advance_expected_recovery_vnd).toBe(sumOf(items(reply), 'advance_expected_recovery_vnd').toString());
      expect(server.cells.advance_recovery_shortfall_vnd).toBe(sumOf(items(reply), 'advance_recovery_shortfall_vnd').toString());
      expect(server.indicators.find((one) => one.code === 'ADVANCE_RECOVERY_SHORTFALL')?.value).toBe(server.cells.advance_recovery_shortfall_vnd);
      const groups = groupsOf(reply, 'recovery_status');
      expect(Object.fromEntries(groups.map((group) => [group.key, group.totals.rows]))).toEqual({ BEHIND: 1, RECOVERED: 1 });
      expect(groups.find((group) => group.key === 'BEHIND')?.totals.cells.advance_recovery_shortfall_vnd).toBe(String(M(110)));
      expect(reply.json.rules).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'ADVANCE_RECOVERY', source: 'DEFAULT' })]));
    });

    it('keeps the ledger to those who may see it, and has no shortfall figure for nobody', async () => {
      const denied = await call('/contracts/analytics/reports/advance-ageing', NO_LEDGER);
      expect(byCode(denied)['M-1']?.na.advance_recovery_shortfall_vnd).toBe('LEDGER_DENIED');
      expect(totals(denied).cells.advance_recovery_shortfall_vnd).toBeNull();
      const none = await call(`/contracts/analytics/reports/advance-ageing?contractor=${contractors[2]}`);
      expect(totals(none).cells.advance_recovery_shortfall_vnd).toBeNull();
      expect(totals(none).na.advance_recovery_shortfall_vnd).toBe('NO_ADVANCE');
    });
  });

  describe('retention and guarantee: what falls due (R6)', () => {
    it('cuts the guarantees by the day they lapse as the kernel does, and the figure of the total is read off the ladder', async () => {
      const reply = await call('/contracts/analytics/reports/retention-guarantee');
      const ladders = reply.json.ladders as { guarantee: Array<{ key: string; count: number; amount_vnd: string }>; retention: Array<{ key: string; count: number; amount_vnd: string }> };
      const raw = await rows<{ expiry: string; amount: string }>(`select (expires_at at time zone 'Asia/Ho_Chi_Minh')::date::text as expiry, amount_vnd::text as amount from machvon.guarantee where status = 'ACTIVE'`);
      const expected = new Map<string, bigint>();
      for (const row of raw) expected.set(guaranteeBandOf(row.expiry, day(0)), (expected.get(guaranteeBandOf(row.expiry, day(0))) ?? 0n) + BigInt(row.amount));
      for (const group of ladders.guarantee) expect(BigInt(group.amount_vnd)).toBe(expected.get(group.key) ?? 0n);
      expect(ladders.guarantee.map((group) => group.key)).toEqual(['LAPSED', 'WITHIN_30', 'WITHIN_90', 'LATER']);
      expect(ladders.guarantee.find((group) => group.key === 'WITHIN_30')).toMatchObject({ count: 1, amount_vnd: String(M(100)) });
      expect(ladders.guarantee.find((group) => group.key === 'LATER')).toMatchObject({ count: 1, amount_vnd: String(M(300)) });
      expect(totals(reply).cells.guarantee_expiring_vnd).toBe(String(M(100)));
      expect(items(reply).find((item) => item.cells.code === 'M-1')?.cells.guarantee_expiring_vnd).toBe(String(M(100)));
      expect(byCode(reply)['M-2']?.cells.guarantee_expiring_vnd).toBe('0');
      expect(byCode(reply)['M-3']?.na.guarantee_expiring_vnd).toBe('NO_GUARANTEE_REQUIRED');
      expect(sumOf(items(reply), 'guarantee_expiring_vnd').toString()).toBe(String(totals(reply).cells.guarantee_expiring_vnd));
    });

    it('reads the guarantee not in force as required less valid, and has no figure when no contract requires one', async () => {
      const reply = await call('/contracts/analytics/reports/retention-guarantee');
      expect(totals(reply).cells.guarantee_exposure_vnd).toBe('0');
      expect(totals(reply).indicators.find((one) => one.code === 'GUARANTEE_EXPOSURE')).toMatchObject({ status: 'OK', value: '0' });
      const none = await call(`/contracts/analytics/reports/retention-guarantee?contractor=${contractors[2]}`);
      expect(totals(none).cells.guarantee_exposure_vnd).toBeNull();
      expect(totals(none).na.guarantee_exposure_vnd).toBe('NO_GUARANTEE_REQUIRED');
      expect((none.json.ladders as { guarantee: Array<{ count: number }> }).guarantee.every((group) => group.count === 0)).toBe(true);
    });

    it('lists the retention that may be released by the day it falls due, for the readers of the ledger only', async () => {
      const denied = await call('/contracts/analytics/reports/retention-guarantee', NO_LEDGER);
      expect(byCode(denied)['M-1']?.na.retention_releasable_vnd).toBe('LEDGER_DENIED');
      expect((denied.json.ladders as { retention: Array<{ count: number }> }).retention.every((group) => group.count === 0)).toBe(true);
      expect(byCode(await call('/contracts/analytics/reports/retention-guarantee'))['M-2']?.na.retention_releasable_vnd).toBe('NO_RETENTION');
    });
  });

  describe('changes: growth by tier (R7)', () => {
    it('cuts the changes of each contract by tier, and the tiers add up to the growth of the selection', async () => {
      const reply = await call('/contracts/analytics/reports/change-growth');
      const found = byCode(reply);
      expect(found['M-1']?.cells).toMatchObject({ tier_1_delta_vnd: String(M(20)), tier_2_delta_vnd: String(M(80)), tier_3_delta_vnd: null });
      expect(found['M-1']?.na.tier_3_delta_vnd).toBe('NO_CHANGE');
      expect(found['M-2']?.cells).toMatchObject({ tier_3_delta_vnd: String(-M(50)), tier_none_delta_vnd: String(M(10)) });
      const server = totals(reply);
      for (const key of ['tier_1_delta_vnd', 'tier_2_delta_vnd', 'tier_3_delta_vnd', 'tier_none_delta_vnd']) expect(server.cells[key]).toBe(sumOf(items(reply), key).toString());
      const split = reply.json.tier_split as { total_delta_vnd: string; original_value_vnd: string; total_count: number; groups: Array<{ key: string; count: number; delta_vnd: string | null; growth: { value: string | null; reason: string | null } }> };
      expect(split.total_delta_vnd).toBe(server.cells.approved_change_delta_vnd);
      expect(split.original_value_vnd).toBe(server.cells.original_value_vnd);
      expect(split.total_count).toBe(server.cells.approved_change_count);
      expect(split.groups.map((group) => group.key)).toEqual(['TIER_1', 'TIER_2', 'TIER_3', 'UNTIERED']);
      expect(split.groups.reduce((acc, group) => acc + BigInt(group.delta_vnd ?? '0'), 0n).toString()).toBe(split.total_delta_vnd);
      // One denominator for all of them: the growth of the tiers, in hundredths of a percent, adds up to that of the selection to within the rounding of each.
      const whole = Number(server.indicators.find((one) => one.code === 'CHANGE_GROWTH')?.value);
      const parts = split.groups.reduce((acc, group) => acc + Number(group.growth.value ?? '0'), 0);
      expect(Math.abs(whole - parts)).toBeLessThanOrEqual(0.03);
    });

    it('has no growth for a tier nobody changed, and names the reason; a selection without changes has none at all', async () => {
      const reply = await call(`/contracts/analytics/reports/change-growth?project=${projects.P2}`);
      const split = reply.json.tier_split as { groups: Array<{ count: number; delta_vnd: string | null; growth: { value: string | null; reason: string | null } }> };
      expect(split.groups.every((group) => group.count === 0 && group.delta_vnd === null && group.growth.value === null && group.growth.reason === 'NO_CHANGE')).toBe(true);
      expect(totals(reply).cells.tier_1_delta_vnd).toBeNull();
      expect(totals(reply).na.tier_1_delta_vnd).toBe('NO_CHANGE');
    });
  });

  describe('the colour of a contract follows the rule of the tenant', () => {
    it('reads CONTRACT_HEALTH_RAG through the governance port and names its version; the worst indicator wins and a looser rule turns the colour', async () => {
      const before = await call('/contracts/analytics/portfolio');
      expect(byCode(before)['M-1']).toBeDefined();
      const level = (reply: Reply, code: string): string | null => (items(reply).find((item) => item.cells.code === code) as unknown as { health?: { level: string | null } }).health?.level ?? null;
      expect(level(before, 'M-1')).toBe('RED');
      expect((before.json.rules as Array<{ type: string; source: string }>)[0]).toMatchObject({ type: 'CONTRACT_HEALTH_RAG', source: 'DEFAULT' });
      await rule('CONTRACT_HEALTH_RAG', {
        days_late_amber: 100,
        days_late_red: 200,
        change_growth_amber_pct: 50,
        change_growth_red_pct: 90,
        guarantee_coverage_amber_pct: 10,
        guarantee_coverage_red_pct: 5,
        paid_to_accepted_amber_pct: 200,
        paid_to_accepted_red_pct: 300,
      });
      try {
        const loose = await call('/contracts/analytics/portfolio');
        expect(level(loose, 'M-1')).toBe('GREEN');
        expect((loose.json.rules as Array<{ type: string; version: number; source: string }>)[0]).toMatchObject({ type: 'CONTRACT_HEALTH_RAG', version: 1, source: 'RULE' });
      } finally {
        await cleanRules('CONTRACT_HEALTH_RAG');
      }
      expect(level(await call('/contracts/analytics/portfolio'), 'M-1')).toBe('RED');
    });
  });

  describe('the files carry the same figures as the screen', () => {
    type FileReply = { status: number; json: { content_base64: string; row_count: number } };
    async function table(code: string, query = ''): Promise<{ head: string[]; body: unknown[][]; total: unknown[] }> {
      const file = (await call(`/contracts/analytics/reports/${code}/export?format=xlsx${query}`)) as unknown as FileReply;
      expect(file.status).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(file.json.content_base64, 'base64') as never);
      const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;
      const all: unknown[][] = [];
      sheet.eachRow((row) => all.push((row.values as unknown[]).slice(1)));
      const head = all.findIndex((row) => row[0] === 'code');
      const data = all.slice(head + 1).filter((row) => row.length > 0);
      return { head: all[head] as string[], body: data.slice(0, -1), total: data[data.length - 1] as unknown[] };
    }
    const column = (found: { head: string[]; body: unknown[][] }, key: string): bigint => found.body.reduce<bigint>((acc, row) => acc + BigInt(String(row[found.head.indexOf(key)] ?? '0') || '0'), 0n);

    it('writes the earned value, the advance recovery and the tiers with totals that are the sum of the rows read back, and the same as the server', async () => {
      for (const [code, keys] of [
        ['schedule-delay', ['bac_vnd', 'earned_value_vnd', 'actual_cost_vnd', 'schedule_variance_vnd']],
        ['advance-ageing', ['advance_expected_recovery_vnd', 'advance_recovery_shortfall_vnd']],
        ['change-growth', ['tier_1_delta_vnd', 'tier_2_delta_vnd', 'tier_3_delta_vnd', 'tier_none_delta_vnd']],
        ['retention-guarantee', ['guarantee_expiring_vnd', 'guarantee_exposure_vnd']],
        ['payment-three-way', ['measured_not_accepted_vnd', 'payments_judged', 'payments_on_time']],
      ] as const) {
        const file = await table(code);
        const server = totals(await call(`/contracts/analytics/reports/${code}`));
        for (const key of keys) {
          expect(String(file.total[file.head.indexOf(key)])).toBe(column(file, key).toString());
          expect(String(file.total[file.head.indexOf(key)])).toBe(String(server.cells[key]));
        }
      }
    });

    it('writes the words of a status and not its code', async () => {
      const file = await table('payment-three-way');
      const index = file.head.indexOf('match_status');
      const written = file.body.map((row) => String(row[index] ?? ''));
      expect(written).not.toContain('OVER_PAID');
      expect(written.every((text) => !/^[A-Z_]+$/.test(text))).toBe(true);
    });
  });

  describe('a frozen period does not hold what it did not freeze', () => {
    it('says NOT_IN_SNAPSHOT for the earned value, the clock, the tiers and the ladders, and holds the rest as it was', async () => {
      const snapshotId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
           values ($1, $2, $3, 'PERIOD_CLOSE', now(), $4::date, $4::date, 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', 0, $5, $6::uuid, now(), $6::uuid, $6::uuid)`,
          [TENANT_A, snapshotId, periodId, day(0), 'd'.repeat(64), WORKER_MEMBERSHIP_ID],
        ],
      ]);
      expect((await freeze(snapshotId)).outcome).toBe('BUILT');
      frozenId = snapshotId;
      const schedule = await call('/contracts/analytics/reports/schedule-delay?period=2031-01');
      expect(byCode(schedule)['M-1']?.na.earned_value_vnd).toBe('NOT_IN_SNAPSHOT');
      expect(totals(schedule).cells.earned_value_vnd).toBeNull();
      expect(totals(schedule).na.earned_value_vnd).toBe('NOT_IN_SNAPSHOT');
      expect(schedule.json.evm).toEqual({ status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT' });
      const payments = await call('/contracts/analytics/reports/payment-three-way?period=2031-01');
      expect(byCode(payments)['M-1']?.na.payments_judged).toBe('NOT_IN_SNAPSHOT');
      // What the snapshot does hold is read from it: the status and the breakdown come from the frozen figures.
      expect(byCode(payments)['M-1']?.cells.match_status).toBe('OVER_PAID');
      expect(groupsOf(payments, 'match_status').find((group) => group.key === 'OVER_PAID')?.totals.rows).toBe(1);
      expect((await call('/contracts/analytics/reports/change-growth?period=2031-01')).json.tier_split).toEqual({ status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT' });
      expect((await call('/contracts/analytics/reports/retention-guarantee?period=2031-01')).json.ladders).toEqual({ status: 'UNAVAILABLE', reason: 'NOT_IN_SNAPSHOT' });
      const advance = await call('/contracts/analytics/reports/advance-ageing?period=2031-01');
      expect(byCode(advance)['M-1']?.cells.recovery_status).toBe('BEHIND');
      expect(frozenId).toBe(snapshotId);
    });
  });
});
