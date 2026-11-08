import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import ExcelJS from 'exceljs';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ContractAnalyticsController } from '../../src/modules/ctr/analytics.controller';
import { RatingController, RatingReadsController } from '../../src/modules/ctr/rating.controller';
import { ScorecardController } from '../../src/modules/ctr/scorecard.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

/**
 * CA-3: the register reports of the contract portfolio and the rating of the performance of a contractor over HTTP. The agreement tests hold the server to the raw rows: an additive total is the sum of the rows and of
 * the Excel read back, a ratio is of the sums, what a register does not hold (a frozen period, a past day) is refused and never filled in, audit money follows the ledger right, and the life of a proposal runs
 * from the proposal to the evaluation of CTR-23 with the fact CONTRACTOR_NOTIFIED opening the e-GP obligation.
 */

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xc6;
const ROOT = 1;
const BQL1 = 2;
const ADMIN = 10; // every right
const NO_LEDGER = 11; // reads the contracts and the analytics, not the ledger, not the audits
const SECOND = 12; // every right, the second person
const MEMBERS = [ADMIN, NO_LEDGER, SECOND];
const M = (million: number): number => million * 1_000_000;
const day = (offset: number): string => vietnamDateOf(new Date(Date.now() + offset * 86_400_000));
const at = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString();

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
type Cells = Record<string, string | number | null>;
type Item = { contract_id: string; record_id?: string; cells: Cells; na: Record<string, string> };
type Totals = { rows: number; ledger_rows: number; cells: Cells; na: Record<string, string>; indicators: Array<{ code: string; value: string | null; numerator: string | null; denominator: string | null }> };
type Group = { key: string; totals: Totals };

describe('the register reports and the rating of the contractors over HTTP (CA-3)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let tenants: TenantDatabase;
  const ids: Record<string, string> = {};
  const contractors: string[] = [];
  let project = '';
  let line = '';
  let decision = '';
  let documentId = '';
  let counter = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member?: number; body?: unknown; ifMatch?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? ADMIN), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const get = (url: string, member = ADMIN): Promise<Reply> => call('GET', url, { member });
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const items = (reply: Reply): Item[] => reply.json.items as Item[];
  const totals = (reply: Reply): Totals => reply.json.totals as Totals;
  const groupsOf = (reply: Reply, dimension: string): Group[] => ((reply.json.breakdowns as Array<{ dimension: string; groups: Group[] }>).find((one) => one.dimension === dimension)?.groups ?? []) as Group[];
  const sumOf = (list: Item[], key: string): bigint => list.reduce((acc, item) => acc + BigInt(item.cells[key] === null || item.cells[key] === undefined ? '0' : String(item.cells[key])), 0n);

  async function seedContract(code: string, status: string, value: number, patch: { accepted?: number; requested?: number; paid?: number; due?: string; guarantee?: number } = {}): Promise<void> {
    const contractId = randomUUID();
    const packageId = randomUUID();
    const revisionId = randomUUID();
    const statements: Array<[string, unknown[]]> = [
      [`insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, allocation_line_id) values ($1, $2, $3, $4, 100000000000, 'OPEN', 1, 'AWARDED', $5)`, [TENANT_A, packageId, project, `PKG-${code}`, line]],
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by,
            signed_on, effective_from, completion_due, current_revision_id, requested_total_vnd, accepted_total_vnd, paid_total_vnd, advance_paid_vnd, advance_recovered_vnd, retention_held_vnd, retention_released_vnd)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, $8, 'CONSTRUCTION', false, true, $9, $10, $10, date '2026-01-01', date '2026-01-02', $11::date, $12, $13, $14, $15, 0, 0, 0, 0)`,
        [TENANT_A, contractId, project, packageId, contractors[0], code, status, `Contract ${code}`, value, memberId(ADMIN), patch.due ?? day(60), revisionId, patch.requested ?? 0, patch.accepted ?? 0, patch.paid ?? 0],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, $4, $5, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $6, $6, $6, now())`,
        [TENANT_A, revisionId, contractId, value, decision, memberId(ADMIN)],
      ],
    ];
    if (patch.guarantee !== undefined) {
      statements.push([
        `insert into machvon.guarantee (tenant_id, id, contract_id, kind, issuer, amount_vnd, expires_at, verification_status, status, guarantee_no, valid_from, created_by, updated_by, verified_by, verified_at, verification_method, evidence_document_version_id)
         values ($1, $2, $3, 'PERFORMANCE', 'Bank', $4, (now() + make_interval(days => 300)), 'VERIFIED', 'ACTIVE', $5, date '2026-01-02', $6, $6, $7, now(), 'ISSUER_CONFIRMATION', $8)`,
        [TENANT_A, randomUUID(), contractId, patch.guarantee, `BL-${code}`, memberId(ADMIN), memberId(NO_LEDGER), decision],
      ]);
    }
    await seedAs(harness, statements);
    ids[code] = contractId;
  }

  async function defect(code: string, severity: string, status: string, patch: { dueOffset: number; reopen?: number }): Promise<void> {
    counter += 1;
    await rows(
      `insert into machvon.quality_nonconformance (tenant_id, id, project_id, contract_id, severity, action_owner_id, due_at, status, closure_evidence, ncr_no, title, detected_on, reopen_count, reopened_at, blocks_acceptance, created_by, updated_by, closed_at, closed_by, closure_note, verified_by, verified_at)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6::timestamptz, $7, '[]'::jsonb, $8, $9, current_date - 20, $10, case when $10 > 0 then now() else null end, false, $5, $5,
               case when $7 in ('CLOSED') then now() else null end, case when $7 in ('CLOSED') then $11::uuid else null end, case when $7 in ('CLOSED') then 'Closed' else null end,
               case when $7 in ('VERIFIED', 'CLOSED') then $11::uuid else null end, case when $7 in ('VERIFIED', 'CLOSED') then now() else null end)`,
      [TENANT_A, project, ids[code], severity, memberId(ADMIN), at(patch.dueOffset), status, `NCR-C3-${counter}`, `Defect ${counter}`, patch.reopen ?? 0, memberId(SECOND)],
    );
  }

  async function variation(code: string, status: string, estimated: number, approved: number | null, createdOffset: number): Promise<void> {
    counter += 1;
    const [revision] = await rows<{ id: string }>('select id from machvon.contract_revision where contract_id = $1::uuid limit 1', [ids[code]]);
    await rows(
      `insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, event_kind, estimated_delta_vnd, approved_delta_vnd, effective_on,
         decision_document_version_id, decided_by, decided_at, submitted_by, created_by, updated_by, created_at, status_reason, resulting_revision_id)
       values ($1, gen_random_uuid(), $2, $3, $4::numeric, 5, $5, $6, 1, $7, 'CO', 'DESIGN_CHANGE', $4::numeric, $8::numeric, case when $6 = 'APPROVED' then date '2026-02-01' else null end,
               case when $6 = 'APPROVED' then $9::uuid else null end, case when $6 in ('APPROVED', 'REJECTED') then $10::uuid else null end, case when $6 in ('APPROVED', 'REJECTED') then now() else null end, $10, $10, $10, $11::timestamptz,
               case when $6 in ('APPROVED', 'REJECTED') then 'Decided' else null end, case when $6 = 'APPROVED' then gen_random_uuid() else null end)`,
      [TENANT_A, ids[code], (revision as { id: string }).id, estimated, `Variation ${counter}`, status, `CR-C3-${counter}`, approved, decision, memberId(ADMIN), at(createdOffset)],
    );
  }

  async function auditFinding(code: string, recommended: number, recovered: number, overdue: boolean): Promise<void> {
    counter += 1;
    const engagement = randomUUID();
    const conclusion = randomUUID();
    const findingId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.audit_engagement (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, classification, created_by, updated_by, version)
         values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'Authority', $4, 'Audit of the works', date '2025-01-01', date '2025-12-31', $5, 'PLANNED', 'CONFIDENTIAL', $5, $5, 1)`,
        [TENANT_A, engagement, `KT-C3-${counter}`, documentId, memberId(ADMIN)],
      ],
      [`insert into machvon.audit_scope_item (tenant_id, id, engagement_id, scope_kind, project_id, added_by) values ($1, gen_random_uuid(), $2, 'PROJECT', $3, $4)`, [TENANT_A, engagement, project, memberId(ADMIN)]],
      [
        `insert into machvon.audit_conclusion (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, summary, total_financial_vnd, status, created_by, updated_by, version)
         values ($1, $2, $3, 'AUDIT_REPORT', $4, 1, date '2026-10-10', date '2026-10-15', 'Conclusion', 100000000, 'RECEIVED', $5, $5, 1)`,
        [TENANT_A, conclusion, engagement, documentId, memberId(ADMIN)],
      ],
      [
        `insert into machvon.audit_finding (tenant_id, id, conclusion_id, finding_code, category, project_id, contract_id, description, amount_vnd, severity, created_by, updated_by, version)
         values ($1, $2, $3, $4, 'FINANCIAL', $5, $6, 'Words of the finding that no report may carry', $7, 'HIGH', $8, $8, 1)`,
        [TENANT_A, findingId, conclusion, `F-C3-${counter}`, project, ids[code], recommended, memberId(ADMIN)],
      ],
      [
        `insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, finding_id, rec_code, rec_type, description, amount_vnd, recovered_vnd, project_id, status, is_overdue, created_by, updated_by, version)
         values ($1, gen_random_uuid(), $2, $3, $4, 'FINANCIAL_RECOVERY', 'Recover', $5, $6, $7, 'OPEN', $8, $9, $9, 1)`,
        [TENANT_A, conclusion, findingId, `R-C3-${counter}`, recommended, recovered, project, overdue, memberId(ADMIN)],
      ],
    ]);
  }

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const all = ['contract.read', 'contract.analytics.read', 'ledger.read', 'aud.read', 'contractor.performance.read', 'contractor.performance.propose', 'contractor.performance.notify', 'contractor.performance.respond', 'contractor.performance.evaluate'];
    await harness.seedRole(TENANT_A, 91, 'CA3_ALL', all, 50);
    await harness.seedRole(TENANT_A, 92, 'CA3_NO_LEDGER', ['contract.read', 'contract.analytics.read', 'contractor.performance.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 91, kind: 'TENANT' },
      { n: 2, member: NO_LEDGER, role: 92, kind: 'TENANT' },
      { n: 3, member: SECOND, role: 91, kind: 'TENANT' },
    ]);
    contractors.push(await seedContractor(harness, { name: 'Contractor 1' }));
    decision = id(FAMILY, 10);
    documentId = id(FAMILY, 11);
    const first = await world.publishedLine({ unitNumber: BQL1, fundVersionId: await world.fundSource('NSTW') });
    project = first.projectId;
    line = first.lineId;
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`, [TENANT_A, documentId, memberId(ADMIN)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/decision.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, decision, documentId],
      ],
    ]);
    // The published working calendar of the years the response window falls in: a deadline is never guessed.
    await rows(
      `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
       select $1, gen_random_uuid(), 'WORKDAY_VN', y, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $2, $2, now() from unnest(array[2026, 2027]) as y`,
      [TENANT_A, memberId(ADMIN)],
    );
    // R-1: 40 days late, money in the ledger, a guarantee; R-2: on time; R-3: a draft (it can be neither rated nor coloured).
    await seedContract('R-1', 'ACTIVE', M(1000), { accepted: M(800), requested: M(800), paid: M(900), due: day(-40), guarantee: M(100) });
    await seedContract('R-2', 'ACTIVE', M(2000), { accepted: M(500), requested: M(500), paid: M(400), due: day(90), guarantee: M(200) });
    await seedContract('R-3', 'DRAFT', M(500));
    await defect('R-1', 'CRITICAL', 'OPEN', { dueOffset: -5 });
    await defect('R-1', 'MAJOR', 'CLOSED', { dueOffset: -15, reopen: 1 });
    await defect('R-1', 'MINOR', 'VERIFIED', { dueOffset: -10 });
    await defect('R-2', 'MINOR', 'OPEN', { dueOffset: 10 });
    await variation('R-1', 'APPROVED', M(100), M(60), -40);
    await variation('R-1', 'REJECTED', M(300), null, -30);
    await variation('R-2', 'SUBMITTED', M(50), null, -22);
    await variation('R-2', 'DRAFT', M(999), null, -1);
    await auditFinding('R-1', M(40), M(10), true);
    await auditFinding('R-2', M(60), M(60), false);
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ContractAnalyticsController, RatingController, RatingReadsController, ScorecardController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  describe('the registers', () => {
    it('quality defects: the total is the sum of the rows, the ratios are of the sums, the groups add up', async () => {
      const reply = await get('/contracts/analytics/reports/quality-defects?limit=200');
      expect(reply.status).toBe(200);
      const list = items(reply);
      expect(list).toHaveLength(4);
      expect(list.every((item) => item.record_id !== undefined && item.contract_id !== undefined)).toBe(true);
      expect(totals(reply).rows).toBe(4);
      expect(totals(reply).cells.reopen_count).toBe(list.reduce((acc, item) => acc + Number(item.cells.reopen_count), 0));
      // open: the critical one of R-1 (overdue) and the minor of R-2 (not): one overdue of two open; closed or verified: two of four
      expect(totals(reply).cells.overdue).toBe('50.00');
      expect(totals(reply).cells.closed).toBe('50.00');
      expect(totals(reply).cells.reopened).toBe('25.00');
      const bySeverity = groupsOf(reply, 'severity');
      expect(bySeverity.reduce((acc, group) => acc + group.totals.rows, 0)).toBe(4);
      expect(bySeverity.find((group) => group.key === 'CRITICAL')?.totals.rows).toBe(1);
      const closedItem = list.find((item) => item.cells.ncr_status === 'CLOSED');
      expect(closedItem?.cells.days_overdue).toBeNull();
      expect(closedItem?.na.days_overdue).toBe('NOT_OPEN');
    });

    it('filters and sorts on the server and pages by a cursor that shows every row once', async () => {
      const critical = await get('/contracts/analytics/reports/quality-defects?severity=CRITICAL');
      expect(items(critical)).toHaveLength(1);
      expect(totals(critical).rows).toBe(1);
      const open = await get('/contracts/analytics/reports/quality-defects?state=OPEN,REOPENED');
      expect(items(open).every((item) => item.cells.ncr_status === 'OPEN')).toBe(true);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 6; guard += 1) {
        const page: Reply = await get(`/contracts/analytics/reports/quality-defects?sort=severity&dir=desc&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`);
        expect(page.status).toBe(200);
        seen.push(...items(page).map((item) => item.record_id as string));
        cursor = page.json.next_cursor as string | null;
        if (cursor === null) break;
      }
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
      expect((await get('/contracts/analytics/reports/quality-defects?sort=nonsense')).status).toBe(422);
      expect((await get('/contracts/analytics/reports/quality-defects?cursor=abc')).status).toBe(422);
    });

    it('refuses a frozen period and a past day for a register, and never answers a part of a selection', async () => {
      expect((await get(`/contracts/analytics/reports/claims-limitation?snapshot_id=${randomUUID()}`)).status).toBe(422);
      expect((await get('/contracts/analytics/reports/claims-limitation?period=2031-01')).status).toBe(422);
      expect((await get(`/contracts/analytics/reports/obstacles?as_of=${day(-3)}`)).status).toBe(422);
      expect((await get(`/contracts/analytics/reports/quality-defects?as_of=${day(0)}`)).status).toBe(200);
    });

    it('claims: a draft is not a claim, the settlement rate is of the sums of the decided claims, limitation is judged by the window of the rule', async () => {
      const reply = await get('/contracts/analytics/reports/claims-limitation?limit=200');
      expect(reply.status).toBe(200);
      const list = items(reply);
      expect(list).toHaveLength(3);
      expect(list.map((item) => item.cells.claim_status).sort()).toEqual(['OPEN', 'PARTLY_GRANTED', 'REJECTED']);
      expect(totals(reply).cells.claimed_amount_vnd).toBe(String(sumOf(list, 'claimed_amount_vnd')));
      // 60 granted of 100 + 300 claimed, the two that were decided
      expect(totals(reply).cells.settlement_pct).toBe('15.00');
      const decided = list.filter((item) => item.cells.claim_status !== 'OPEN');
      expect(decided.every((item) => item.cells.limitation_status === 'OUT_OF_TIME')).toBe(true);
      const open = list.find((item) => item.cells.claim_status === 'OPEN') as Item;
      // submitted 22 days ago, window 28 days, near 7: six days are left, it is near
      expect(open.cells.limitation_status).toBe('NEAR');
      expect(open.cells.limitation_days_left).toBe(6);
      expect((reply.json.rules as Array<{ type: string; unverified: boolean }>).map((rule) => rule.type)).toEqual(['CONTRACT_CLAIM_LIMITATION']);
    });

    it('audit findings: no words of a finding, the recovery is a ratio of sums, the money follows the ledger right and the audit right', async () => {
      const reply = await get('/contracts/analytics/reports/audit-findings');
      expect(reply.status).toBe(200);
      expect(JSON.stringify(reply.json)).not.toContain('Words of the finding');
      expect(totals(reply).cells.recommended_vnd).toBe(String(M(100)));
      expect(totals(reply).cells.recovered_vnd).toBe(String(M(70)));
      expect(totals(reply).cells.recovery_pct).toBe('70.00');
      // one overdue of two open recommendations
      expect(totals(reply).cells.overdue_recommendation_pct).toBe('50.00');
      const noLedger = await get('/contracts/analytics/reports/audit-findings', NO_LEDGER);
      // no audit right: no finding at all (an engagement outside every grant is not found)
      expect(items(noLedger)).toHaveLength(0);
      expect(totals(noLedger).rows).toBe(0);
    });

    it('contract health: the colour is the worst indicator, the red share is over the coloured contracts, and a frozen period is accepted', async () => {
      const reply = await get('/contracts/analytics/reports/contract-health?limit=200');
      expect(reply.status).toBe(200);
      const byCode = Object.fromEntries(items(reply).map((item) => [item.cells.code as string, item]));
      expect(byCode['R-1']?.cells.health).toBe('RED');
      expect(byCode['R-1']?.cells.health_driver).toBe('DAYS_LATE');
      expect(byCode['R-2']?.cells.health).toBe('GREEN');
      const coloured = items(reply).filter((item) => item.cells.health !== null);
      expect(totals(reply).indicators.find((one) => one.code === 'CONTRACT_RED_SHARE')).toMatchObject({ numerator: String(coloured.filter((item) => item.cells.health === 'RED').length), denominator: String(coloured.length) });
      expect(groupsOf(reply, 'health').reduce((acc, group) => acc + group.totals.rows, 0)).toBe(totals(reply).rows);
      expect((await get(`/contracts/analytics/reports/contract-health?as_of=${day(-3)}`)).status).toBe(200);
    });

    it('the Excel read back has the totals row of the page: quality defects', async () => {
      const reply = await get('/contracts/analytics/reports/quality-defects/export?format=xlsx');
      expect(reply.status).toBe(200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.from(reply.json.content_base64 as string, 'base64') as never);
      const sheet = book.worksheets[0] as ExcelJS.Worksheet;
      const table: string[][] = [];
      sheet.eachRow((row) => table.push((row.values as unknown[]).slice(1).map((cell) => (cell === null || cell === undefined ? '' : String(cell)))));
      const head = table.find((row) => row.includes('ncr_no') || row.some((cell) => cell.includes('NCR')));
      expect(head).toBeDefined();
      const last = table[table.length - 1] as string[];
      expect(last.some((cell) => cell === '50.00')).toBe(true);
      expect(reply.json.row_count).toBe(4);
      expect(JSON.stringify(reply.json.context)).toContain('LIVE');
      const csv = await get('/contracts/analytics/reports/obstacles/export?format=csv');
      expect(csv.status).toBe(200);
      expect((await get('/contracts/analytics/reports/obstacles/export?format=doc')).status).toBe(422);
    });
  });

  describe('the rating of the performance of a contractor', () => {
    let proposalId = '';

    it('the report shows the proposal from the data, without zero for a missing criterion, and counts coverage over the rows', async () => {
      const reply = await get('/contracts/analytics/reports/performance-rating?limit=200');
      expect(reply.status).toBe(200);
      const byCode = Object.fromEntries(items(reply).map((item) => [item.cells.code as string, item]));
      expect(Object.keys(byCode).sort()).toEqual(['R-1', 'R-2']);
      expect(byCode['R-1']?.cells.score_schedule).toBe('56.00');
      expect(byCode['R-1']?.cells.overall_score).not.toBeNull();
      expect(byCode['R-1']?.cells.rating_status).toBe('NONE');
      expect(totals(reply).indicators.find((one) => one.code === 'RATING_COVERAGE')).toMatchObject({ denominator: '2' });
      const noLedger = await get('/contracts/analytics/reports/performance-rating?limit=200', NO_LEDGER);
      expect(items(noLedger)[0]?.cells.score_financial).toBeNull();
      expect(items(noLedger)[0]?.na.score_financial).toBe('LEDGER_DENIED');
      expect(items(noLedger)[0]?.cells.overall_score).toBeNull();
    });

    it('proposes from the data, once per contract, kind and period', async () => {
      const made = await call('POST', `/contracts/${ids['R-1']}/rating-proposals`, { body: { period_label: '2026-Q4', note: 'Quarter four' } });
      expect(made.status).toBe(200);
      proposalId = made.json.resource_id as string;
      const [row] = await rows<{ state: string; score_schedule: number; score_quality: number; overall_score: string | null; inputs_sha256: string; rule_source: string }>(
        'select state, score_schedule, score_quality, overall_score::text as overall_score, inputs_sha256, rule_source from machvon.contract_rating_proposal where id = $1::uuid',
        [proposalId],
      );
      expect(row).toMatchObject({ state: 'PROPOSED', score_schedule: 56, rule_source: 'DEFAULT' });
      expect(row?.inputs_sha256).toMatch(/^[0-9a-f]{64}$/);
      const again = await call('POST', `/contracts/${ids['R-1']}/rating-proposals`, { body: { period_label: '2026-Q4' } });
      expect(again.status).toBe(409);
      expect(JSON.stringify(again.json)).toContain('RATING_PROPOSAL_EXISTS');
      const draft = await call('POST', `/contracts/${ids['R-3']}/rating-proposals`, { body: { period_label: '2026-Q4' } });
      expect(draft.status).toBe(409);
      const noLedger = await call('POST', `/contracts/${ids['R-2']}/rating-proposals`, { member: NO_LEDGER, body: { period_label: '2026-Q4' } });
      expect([403, 404]).toContain(noLedger.status);
    });

    it('is told to the contractor by a second person, which opens the e-GP obligation of the response with the deadline of the rule', async () => {
      const own = await call('POST', `/contract-rating-proposals/${proposalId}/notify`, { member: ADMIN, ifMatch: '"1"', body: {} });
      expect(own.status).toBe(403);
      const told = await call('POST', `/contract-rating-proposals/${proposalId}/notify`, { member: SECOND, ifMatch: '"1"', body: { note: 'Letter sent' } });
      expect(told.status).toBe(200);
      const [row] = await rows<{ state: string; notified_by: string; response_due_at: string; notified_at: string }>('select state, notified_by::text as notified_by, response_due_at::text as response_due_at, notified_at::text as notified_at from machvon.contract_rating_proposal where id = $1::uuid', [proposalId]);
      expect(row).toMatchObject({ state: 'NOTIFIED', notified_by: memberId(SECOND) });
      const [obligation] = await rows<{ kind: string; trigger_event: string; due_at: string; subject_type: string; state: string }>(
        'select kind, trigger_event, due_at::text as due_at, subject_type, state from machvon.egp_posting_obligation where source_ref = $1::uuid',
        [proposalId],
      );
      expect(obligation).toMatchObject({ kind: 'CONTRACTOR_RESPONSE', trigger_event: 'CONTRACTOR_NOTIFIED', subject_type: 'CONTRACTOR', state: 'DUE' });
      // one source of the 20 days: the window of the proposal ends where the obligation does
      expect(new Date(obligation?.due_at as string).getTime()).toBe(new Date(row?.response_due_at as string).getTime());
      const days = (new Date(row?.response_due_at as string).getTime() - new Date(row?.notified_at as string).getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(19);
      expect(days).toBeLessThan(24);
      const again = await call('POST', `/contract-rating-proposals/${proposalId}/notify`, { member: SECOND, ifMatch: '"2"', body: {} });
      expect(again.status).toBe(409);
      const view = await get(`/contract-rating-proposals/${proposalId}`);
      expect(view.status).toBe(200);
      expect(view.json).toMatchObject({ state: 'NOTIFIED', allowed: { respond: true, adopt: false, notify: false, withdraw: false } });
      expect((view.json.response_clock as { status: string }).status).toBe('RUNNING');
      // the financial score, the overall score and the rating are made of the ledger: a reader without it is shown none of them
      const masked = await get(`/contract-rating-proposals/${proposalId}`, NO_LEDGER);
      expect(masked.status).toBe(200);
      expect(masked.json.overall_score).toBeNull();
      expect(masked.json.rating).toBeNull();
      expect((masked.json.criteria as Record<string, { score: number | null; reason: string | null; readings: object }>).financial).toEqual({ score: null, reason: 'LEDGER_DENIED', readings: {} });
      expect((view.json.criteria as Record<string, { score: number | null }>).financial?.score).not.toBeNull();
    });

    it('cannot be adopted while the window runs, takes the answer, and is adopted by a second person into the evaluation of CTR-23', async () => {
      const early = await call('POST', `/contract-rating-proposals/${proposalId}/adopt`, { member: SECOND, ifMatch: '"2"', body: {} });
      expect(early.status).toBe(409);
      const disputeShort = await call('POST', `/contract-rating-proposals/${proposalId}/response`, { member: ADMIN, ifMatch: '"2"', body: { response_kind: 'DISPUTE', received_on: day(0), response_text: 'too short' } });
      expect(disputeShort.status).toBe(422);
      const answered = await call('POST', `/contract-rating-proposals/${proposalId}/response`, { member: ADMIN, ifMatch: '"2"', body: { response_kind: 'ACCEPT', received_on: day(0) } });
      expect(answered.status).toBe(200);
      const own = await call('POST', `/contract-rating-proposals/${proposalId}/adopt`, { member: ADMIN, ifMatch: '"3"', body: {} });
      expect(own.status).toBe(403);
      const adopted = await call('POST', `/contract-rating-proposals/${proposalId}/adopt`, { member: SECOND, ifMatch: '"3"', body: { note: 'Adopted' } });
      expect(adopted.status).toBe(200);
      const [row] = await rows<{ state: string; evaluation_id: string | null; adopted_by: string }>('select state, evaluation_id::text as evaluation_id, adopted_by::text as adopted_by from machvon.contract_rating_proposal where id = $1::uuid', [proposalId]);
      expect(row).toMatchObject({ state: 'ADOPTED', adopted_by: memberId(SECOND) });
      const [evaluation] = await rows<{ status: string; evaluation_kind: string; period_label: string; score_schedule: number; evaluated_by: string }>(
        'select status, evaluation_kind, period_label, score_schedule, evaluated_by::text as evaluated_by from machvon.contractor_performance where id = $1::uuid',
        [row?.evaluation_id],
      );
      // the evaluation waits for its own approval by a second person, with the scores of the proposal
      expect(evaluation).toMatchObject({ status: 'SUBMITTED', evaluation_kind: 'PERIODIC', period_label: '2026-Q4', score_schedule: 56, evaluated_by: memberId(SECOND) });
      const report = await get('/contracts/analytics/reports/performance-rating?limit=200');
      expect(items(report).find((item) => item.cells.code === 'R-1')?.cells.rating_status).toBe('ADOPTED');
    });

    it('withdraws only a proposal the contractor was not told of, and the list shows the proposals in scope', async () => {
      const made = await call('POST', `/contracts/${ids['R-2']}/rating-proposals`, { member: ADMIN, body: { period_label: '2026-Q4' } });
      expect(made.status).toBe(200);
      const withdrawn = await call('POST', `/contract-rating-proposals/${made.json.resource_id as string}/withdraw`, { member: SECOND, ifMatch: '"1"', body: { reason: 'Proposed on the wrong day' } });
      expect(withdrawn.status).toBe(200);
      const late = await call('POST', `/contract-rating-proposals/${proposalId}/withdraw`, { member: SECOND, ifMatch: '"4"', body: { reason: 'It is already adopted' } });
      expect(late.status).toBe(409);
      const list = await get('/contract-rating-proposals');
      expect(list.status).toBe(200);
      expect((list.json.items as Array<{ state: string }>).map((one) => one.state).sort()).toEqual(['ADOPTED', 'WITHDRAWN']);
      expect((await get('/contract-rating-proposals?state=bogus')).status).toBe(422);
      expect((await get(`/contract-rating-proposals/${randomUUID()}`)).status).toBe(404);
    });

    it('a criterion with no data needs an override with its reason, and a score the data gave cannot be replaced', async () => {
      await seedContract('R-4', 'ACTIVE', M(300), { due: day(30) });
      const made = await call('POST', `/contracts/${ids['R-4']}/rating-proposals`, { member: ADMIN, body: { period_label: '2026-Q4' } });
      expect(made.status).toBe(200);
      const id4 = made.json.resource_id as string;
      const [stored] = await rows<{ score_quality: number | null; score_financial: number | null; score_schedule: number | null; covered: number; reasons: Record<string, string> }>(
        'select score_quality, score_financial, score_schedule, covered, reasons from machvon.contract_rating_proposal where id = $1::uuid',
        [id4],
      );
      expect(stored).toMatchObject({ score_quality: null, score_financial: null, score_schedule: 100, covered: 3 });
      expect(stored?.reasons).toMatchObject({ quality: 'NO_QUALITY_EVIDENCE', financial: 'NO_FINANCIAL_EVIDENCE' });
      expect((await call('POST', `/contract-rating-proposals/${id4}/notify`, { member: SECOND, ifMatch: '"1"', body: {} })).status).toBe(200);
      expect((await call('POST', `/contract-rating-proposals/${id4}/response`, { member: ADMIN, ifMatch: '"2"', body: { response_kind: 'NO_COMMENT', received_on: day(0) } })).status).toBe(200);
      const incomplete = await call('POST', `/contract-rating-proposals/${id4}/adopt`, { member: SECOND, ifMatch: '"3"', body: {} });
      expect(incomplete.status).toBe(422);
      expect(JSON.stringify(incomplete.json)).toContain('RATING_INCOMPLETE');
      const reason = 'Scored by hand from the file of the contractor.';
      const replaced = await call('POST', `/contract-rating-proposals/${id4}/adopt`, { member: SECOND, ifMatch: '"3"', body: { overrides: { schedule: { score: 10, reason }, quality: { score: 60, reason }, financial: { score: 70, reason } } } });
      expect(replaced.status).toBe(422);
      const adopted = await call('POST', `/contract-rating-proposals/${id4}/adopt`, { member: SECOND, ifMatch: '"3"', body: { overrides: { quality: { score: 60, reason }, financial: { score: 70, reason } } } });
      expect(adopted.status).toBe(200);
      const [evaluation] = await rows<{ score_quality: number; score_financial: number; score_schedule: number }>(
        'select e.score_quality, e.score_financial, e.score_schedule from machvon.contractor_performance e join machvon.contract_rating_proposal q on q.evaluation_id = e.id where q.id = $1::uuid',
        [id4],
      );
      expect(evaluation).toMatchObject({ score_quality: 60, score_financial: 70, score_schedule: 100 });
    });
  });
});
