import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import ExcelJS from 'exceljs';
import { CtrFactStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { concentrationOf, loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ContractAnalyticsController } from '../../src/modules/ctr/analytics.controller';
import { ctrModule } from '../../src/modules/ctr';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

/**
 * CA-1, part 2: the analytics of the contract portfolio over HTTP. The agreement tests hold the figures of the server to the raw rows: an additive total is the sum of the rows and the sum of the file read back, a ratio
 * is the ratio of the sums, the concentration is recomputed from the rows of the contracts and their parties, and a source that fails is an error and never an empty table. Scope, the ledger right and the guest are judged
 * on the same requests.
 */

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xc4;
const ROOT = 1;
const BQL1 = 2;
const BQL2 = 3;
const ADMIN = 10; // contract.read, contract.analytics.read, ledger.read on the whole tenant
const NO_LEDGER = 11; // contract.read, contract.analytics.read: no ledger
const UNIT_TWO = 12; // the three, on the subtree of BQL2 only
const GUEST = 13; // a guest contractor with contract.read
const NOBODY = 14; // no right at all
const MEMBERS = [ADMIN, NO_LEDGER, UNIT_TWO, GUEST, NOBODY];
const M = (million: number): number => million * 1_000_000;
const day = (offset: number): string => vietnamDateOf(new Date(Date.now() + offset * 86_400_000));

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface SeedContract {
  code: string;
  project: string;
  line: string;
  contractor: string;
  status: string;
  value: number;
  original?: number;
  bid?: number;
  bidders?: number;
  requested?: number;
  accepted?: number;
  paid?: number;
  advancePaid?: number;
  advanceRecovered?: number;
  retentionHeld?: number;
  retentionReleased?: number;
  due?: string | null;
  parties?: Array<[string, string, string]>;
  change?: { delta: number; tier: number; cumulative: string };
  guarantee?: { amount: number; expiresInDays: number };
  completedOn?: string;
}

describe('the analytics of the contract portfolio over HTTP (CA-1, part 2: R12, R16, R17)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let tenants: TenantDatabase;
  const contractors: string[] = [];
  const ids: Record<string, string> = {};
  const lines: Record<string, string> = {};
  const projects: Record<string, string> = {};
  const funds: Record<string, string> = {};
  let decision = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(url: string, member = ADMIN): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { method: 'GET', headers: { [TENANT_HEADER]: tokenOf(member) } });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const items = (reply: Reply): Array<{ contract_id: string; cells: Record<string, string | number | null>; na: Record<string, string>; health?: { level: string | null } }> => reply.json.items as never;
  const totals = (reply: Reply): { rows: number; ledger_rows: number; cells: Record<string, string | number | null>; na: Record<string, string> } => reply.json.totals as never;
  const codes = (reply: Reply): string[] => items(reply).map((item) => item.cells.code as string);

  async function seedContract(input: SeedContract): Promise<string> {
    const contractId = randomUUID();
    const packageId = randomUUID();
    const revisionId = randomUUID();
    const original = input.original ?? input.value;
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, allocation_line_id) values ($1, $2, $3, $4, 100000000000, 'OPEN', 1, 'AWARDED', $5)`,
        [TENANT_A, packageId, projects[input.project], `PKG-${input.code}`, lines[input.line]],
      ],
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by,
            signed_on, effective_from, completion_due, current_revision_id, requested_total_vnd, accepted_total_vnd, paid_total_vnd, advance_paid_vnd, advance_recovered_vnd, retention_held_vnd, retention_released_vnd,
            completed_on, completion_quality_acceptance_id, completed_by)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, $8, 'CONSTRUCTION', $9, true, $10, $11, $11, date '2026-01-01', date '2026-01-02', $12::date, $13,
                 $14, $15, $16, $17, $18, $19, $20, $21::date, $22::uuid, $23::uuid)`,
        [
          TENANT_A, contractId, projects[input.project], packageId, input.contractor, input.code, input.status, `Contract ${input.code}`, input.parties !== undefined, input.value, memberId(ADMIN),
          input.due === undefined ? day(60) : input.due, revisionId, input.requested ?? 0, input.accepted ?? 0, input.paid ?? 0, input.advancePaid ?? 0, input.advanceRecovered ?? 0, input.retentionHeld ?? 0, input.retentionReleased ?? 0,
          input.completedOn ?? null, input.completedOn === undefined ? null : randomUUID(), input.completedOn === undefined ? null : memberId(ADMIN),
        ],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, $4, $5, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $6, $6, $6, now())`,
        [TENANT_A, revisionId, contractId, original, decision, memberId(ADMIN)],
      ],
    ];
    if (input.bid !== undefined) {
      statements.push([
        `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, decision_document_id, outcome, status, submitted_by, approved_by, approved_at, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, 'AWARDED', 'APPROVED', $7, $8, now(), $7, $7)`,
        [TENANT_A, randomUUID(), packageId, input.contractor, input.bid, decision, memberId(NO_LEDGER), memberId(ADMIN)],
      ]);
    }
    for (let bidder = 0; bidder < (input.bidders ?? 0); bidder += 1) {
      statements.push([
        `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, bid_price_vnd, submitted_at, access_released_at, created_by)
         values ($1, $2, $3, $4, $5, '[]'::jsonb, 1, 'RECEIVED', $6, now(), now(), $7)`,
        [TENANT_A, randomUUID(), projects[input.project], packageId, contractors[(contractors.indexOf(input.contractor) + bidder) % contractors.length], input.bid ?? input.value, memberId(ADMIN)],
      ]);
    }
    for (const [contractorId, share, role] of input.parties ?? []) {
      statements.push([
        `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6::numeric, 0, 'ACTIVE', date '2026-01-02', $7, $7)`,
        [TENANT_A, randomUUID(), contractId, contractorId, role, share, memberId(ADMIN)],
      ]);
    }
    if (input.change !== undefined) {
      statements.push([
        `insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, approved_delta_vnd, effective_on,
            decision_document_version_id, decided_by, submitted_by, tier, cumulative_variation_pct, created_by, updated_by, decided_at, status_reason, resulting_revision_id)
         values ($1, $2, $3, $4, $5, 7, 'Change', 'APPROVED', 1, $6, 'CO', $5, date '2026-02-01', $7, $8, $9, $10, $11::numeric, $9, $9, now(), 'Approved', gen_random_uuid())`,
        [TENANT_A, randomUUID(), contractId, revisionId, input.change.delta, `CR-${input.code}`, decision, memberId(ADMIN), memberId(NO_LEDGER), input.change.tier, input.change.cumulative],
      ]);
    }
    if (input.guarantee !== undefined) {
      statements.push([
        `insert into machvon.guarantee (tenant_id, id, contract_id, kind, issuer, amount_vnd, expires_at, verification_status, status, guarantee_no, valid_from, created_by, updated_by, verified_by, verified_at, verification_method, verification_evidence_id)
         values ($1, $2, $3, 'PERFORMANCE', 'Bank', $4, (now() + make_interval(days => $5::int)), 'VERIFIED', 'ACTIVE', $6, date '2026-01-02', $7, $7, $8, now(), 'ISSUER_CONFIRMATION', $9)`,
        [TENANT_A, randomUUID(), contractId, input.guarantee.amount, input.guarantee.expiresInDays, `BL-${input.code}`, memberId(ADMIN), memberId(NO_LEDGER), decision],
      ]);
    }
    if (input.completedOn !== undefined) {
      statements.push([
        `insert into machvon.contract_status_change (tenant_id, id, contract_id, from_status, to_status, reason, effective_on, command, created_by) values ($1, $2, $3, 'ACTIVE', 'COMPLETED', 'Done', $4::date, 'completeContract', $5)`,
        [TENANT_A, randomUUID(), contractId, input.completedOn, memberId(ADMIN)],
      ]);
    }
    await seedAs(harness, statements);
    ids[input.code] = contractId;
    return contractId;
  }

  async function frozenPeriod(code: string, asOf: string, replaces?: string): Promise<{ periodId: string; snapshotId: string }> {
    const periodId = replaces === undefined ? randomUUID() : ((await rows<{ period_id: string }>('select period_id from machvon.period_snapshot where id = $1::uuid', [replaces]))[0]?.period_id as string);
    const snapshotId = randomUUID();
    const statements: Array<[string, unknown[]]> = [];
    if (replaces === undefined) {
      statements.push([
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, date '2030-01-01', date '2030-01-31', now(), 'DEFAULT', 'MONTH', 2030, 'OPEN', $4, $5, $5)`,
        [TENANT_A, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID],
      ]);
    } else {
      statements.push([`update machvon.period_snapshot set status = 'SUPERSEDED' where id = $1::uuid`, [replaces]]);
    }
    statements.push([
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, supersedes_id, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), $4::date, $4::date, 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', 0, $5, $6::uuid, now(), $7::uuid, $6::uuid, $6::uuid)`,
      [TENANT_A, snapshotId, periodId, asOf, 'd'.repeat(64), WORKER_MEMBERSHIP_ID, replaces ?? null],
    ]);
    await seedAs(harness, statements);
    return { periodId, snapshotId };
  }

  const freeze = (periodSnapshotId: string) => tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => new CtrFactStore().buildFor(tx, periodSnapshotId, WORKER_MEMBERSHIP_ID));

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: BQL2, path: `/${unitId(ROOT)}/${unitId(BQL2)}/`, parent: ROOT }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const all = ['contract.read', 'contract.analytics.read', 'ledger.read'];
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'CA_ALL', all, 50],
      [2, 'CA_NO_LEDGER', ['contract.read', 'contract.analytics.read'], 40],
      [3, 'CA_GUEST', ['contract.read'], 10],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 90 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 91, kind: 'TENANT' },
      { n: 2, member: NO_LEDGER, role: 92, kind: 'TENANT' },
      { n: 3, member: UNIT_TWO, role: 91, kind: 'UNIT_SUBTREE', refs: [unitId(BQL2)] },
      { n: 4, member: GUEST, role: 93, kind: 'TENANT' },
    ]);
    for (let n = 0; n < 4; n += 1) contractors.push(await seedContractor(harness, { name: `Nha thau ${n + 1}` }));
    decision = id(FAMILY, 10);
    // Two projects (one per unit), each with a line of capital of its own fund source.
    const fundA = await world.fundSource('NSTW');
    const fundB = await world.fundSource('NSDP');
    const first = await world.publishedLine({ unitNumber: BQL1, fundVersionId: fundA });
    const second = await world.publishedLine({ unitNumber: BQL2, fundVersionId: fundB });
    projects.P1 = first.projectId;
    projects.P2 = second.projectId;
    lines.P1 = first.lineId;
    lines.P2 = second.lineId;
    funds.A = fundA;
    funds.B = fundB;
    await rows('update machvon.project set investor_unit_id = $2::uuid where id = $1::uuid', [first.projectId, unitId(ROOT)]);
    await seedAs(harness, [
      [`update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '30 days' where id = $1::uuid`, [memberId(GUEST), contractors[0]]],
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(ADMIN)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/decision.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, decision, id(FAMILY, 11)],
      ],
    ]);
    const [k1, k2, k3, k4] = contractors as [string, string, string, string];
    // C1: late, grew by 100 (tier 2), bought below the signing price, one bidder, an advance half recovered, retention held, a guarantee in force
    await seedContract({ code: 'HD-1', project: 'P1', line: 'P1', contractor: k1, status: 'ACTIVE', value: M(1000), original: M(900), bid: M(880), bidders: 1, requested: M(400), accepted: M(400), paid: M(300), advancePaid: M(200), advanceRecovered: M(50), retentionHeld: M(40), retentionReleased: M(10), due: day(-60), change: { delta: M(100), tier: 2, cumulative: '11.11' }, guarantee: { amount: M(100), expiresInDays: 90 } });
    await seedContract({ code: 'HD-2', project: 'P1', line: 'P1', contractor: k2, status: 'ACTIVE', value: M(3000), bid: M(3100), bidders: 4, requested: M(1900), accepted: M(1900), paid: M(1500), advancePaid: M(600), advanceRecovered: M(600), guarantee: { amount: M(300), expiresInDays: 200 } });
    await seedContract({ code: 'HD-3', project: 'P2', line: 'P2', contractor: k1, status: 'ACTIVE', value: M(5000), bid: M(5000), bidders: 2, requested: M(1000), accepted: M(1000), paid: M(800), parties: [[k1, '60.0000', 'LEAD'], [k3, '40.0000', 'MEMBER']] });
    await seedContract({ code: 'HD-4', project: 'P2', line: 'P2', contractor: k4, status: 'COMPLETED', value: M(700), requested: M(700), accepted: M(700), paid: M(700), due: day(-100), completedOn: day(-80) });
    await seedContract({ code: 'HD-5', project: 'P1', line: 'P1', contractor: k2, status: 'DRAFT', value: M(500), due: null });
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

  it('is registered in the module of CTR', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([ContractAnalyticsController]));
  });

  describe('the portfolio: filters, sort, paging and the total made on the server', () => {
    it('lists every contract with the totals of all of them, and says what the figures are (scope, day, unit, freshness)', async () => {
      const reply = await call('/contracts/analytics/portfolio');
      expect(reply.status).toBe(200);
      expect(codes(reply)).toEqual(['HD-1', 'HD-2', 'HD-3', 'HD-4', 'HD-5']);
      expect(totals(reply)).toMatchObject({ rows: 5, ledger_rows: 5 });
      expect(reply.json.context).toMatchObject({ scope: 'PROVINCE', currency_unit: 'VND', freshness: { kind: 'LIVE', stale: false, snapshot: null } });
      expect(reply.json.next_cursor).toBeNull();
    });

    it('adds up: the total of an additive column is the sum of the rows, to the dong, and the ratio is of the sums', async () => {
      const reply = await call('/contracts/analytics/portfolio');
      const column = (key: string): bigint => items(reply).reduce((acc, item) => acc + BigInt((item.cells[key] as string | null) ?? '0'), 0n);
      const t = totals(reply).cells;
      for (const key of ['contract_value_vnd', 'original_value_vnd', 'approved_change_delta_vnd', 'accepted_vnd', 'paid_vnd']) expect(t[key]).toBe(column(key).toString());
      expect(t.contract_value_vnd).toBe(String(M(1000 + 3000 + 5000 + 700 + 500)));
      expect(t.approved_change_delta_vnd).toBe(String(M(100)));
      // paid over accepted of the portfolio: (300 + 1500 + 800 + 700) / (400 + 1900 + 1000 + 700)
      expect(t.paid_to_accepted_pct).toBe('82.50');
      // growth: 100 / (900 + 3000 + 5000 + 700 + 500)
      expect(t.change_growth_pct).toBe('0.99');
      const row = items(reply)[0];
      expect(row?.cells).toMatchObject({ code: 'HD-1', contract_status: 'ACTIVE', contract_value_vnd: String(M(1000)), original_value_vnd: String(M(900)), approved_change_delta_vnd: String(M(100)), change_growth_pct: '11.11' });
      // a row that has nothing to divide by says why, never zero
      const draft = items(reply).find((item) => item.cells.code === 'HD-5');
      expect(draft?.cells.paid_to_accepted_pct).toBeNull();
      expect(draft?.na.paid_to_accepted_pct).toBe('ZERO_DENOMINATOR');
      expect(draft?.cells.days_late).toBeNull();
    });

    it('colours a contract by its health: late and grown is not green', async () => {
      const reply = await call('/contracts/analytics/portfolio');
      const level = (code: string): string | null | undefined => items(reply).find((item) => item.cells.code === code)?.health?.level;
      expect(level('HD-1')).toBe('RED');
      expect(level('HD-2')).toBe('GREEN');
      // a draft with nothing to judge but a growth of zero is green: it is no colour only when no indicator applies
      expect(level('HD-5')).toBe('GREEN');
    });

    it('pages by cursor in the order asked, and the pages are the whole list once', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const reply: Reply = await call(`/contracts/analytics/portfolio?sort=contract_value_vnd&dir=desc&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
        expect(reply.status).toBe(200);
        seen.push(...codes(reply));
        // the total is the same on every page: it is of all that match, not of the page
        expect(totals(reply).rows).toBe(5);
        cursor = reply.json.next_cursor as string | null;
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBe(3);
      expect(seen).toEqual(['HD-3', 'HD-2', 'HD-1', 'HD-4', 'HD-5']);
      // a cursor belongs to the sort it was made for
      const first = await call('/contracts/analytics/portfolio?sort=contract_value_vnd&dir=desc&limit=2');
      const moved = await call(`/contracts/analytics/portfolio?sort=code&dir=desc&limit=2&cursor=${first.json.next_cursor as string}`);
      expect(moved.status).toBe(422);
    });

    it('sorts a missing figure first, and by days late', async () => {
      const reply = await call('/contracts/analytics/portfolio?sort=days_late&dir=desc');
      expect(codes(reply).slice(0, 2)).toEqual(['HD-1', 'HD-4']);
      expect(codes(reply).slice(-1)).toEqual(['HD-5']);
    });

    it('filters on the server by unit, project, contractor (a joint-venture member too), status, type, fund and text, and the total follows the filter', async () => {
      const [k1, , k3] = contractors as [string, string, string, string];
      expect(codes(await call(`/contracts/analytics/portfolio?status=ACTIVE`))).toEqual(['HD-1', 'HD-2', 'HD-3']);
      expect(codes(await call(`/contracts/analytics/portfolio?unit=${unitId(BQL2)}`))).toEqual(['HD-3', 'HD-4']);
      expect(codes(await call(`/contracts/analytics/portfolio?project=${projects.P1}`))).toEqual(['HD-1', 'HD-2', 'HD-5']);
      expect(codes(await call(`/contracts/analytics/portfolio?contractor=${k3}`))).toEqual(['HD-3']);
      expect(codes(await call(`/contracts/analytics/portfolio?contractor=${k1}`))).toEqual(['HD-1', 'HD-3']);
      expect(codes(await call(`/contracts/analytics/portfolio?fund=${funds.B}`))).toEqual(['HD-3', 'HD-4']);
      expect(codes(await call(`/contracts/analytics/portfolio?type=LUMP_SUM&q=hd-2`))).toEqual(['HD-2']);
      expect(codes(await call(`/contracts/analytics/portfolio?q=nha%20thau%203`))).toEqual([]);
      const filtered = await call(`/contracts/analytics/portfolio?unit=${unitId(BQL2)}`);
      expect(totals(filtered)).toMatchObject({ rows: 2, cells: { contract_value_vnd: String(M(5700)), paid_vnd: String(M(1500)) } });
      expect(totals(await call('/contracts/analytics/portfolio?status=CLOSED')).rows).toBe(0);
    });

    it('refuses what is not a query: an unknown sort, a status that is not one, a day in the future, a bad id, a bad limit', async () => {
      for (const query of ['sort=nope', 'status=NOPE', `as_of=${day(30)}`, 'project=not-an-id', 'limit=0', 'limit=500', 'dir=sideways', 'q=', `snapshot_id=${randomUUID()}&period=2030-01`]) {
        const reply = await call(`/contracts/analytics/portfolio?${query}`);
        expect([query, reply.status]).toEqual([query, 422]);
        expect(reply.json.code).toBe('VALIDATION_FAILED');
      }
      expect((await call(`/contracts/analytics/portfolio?snapshot_id=${randomUUID()}`)).json).toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
    });
  });

  describe('scope, the ledger and the guest', () => {
    it('hides the ledger from a reader without ledger.read: no figure, the reason, and a total that leaves those contracts out', async () => {
      const reply = await call('/contracts/analytics/portfolio', NO_LEDGER);
      expect(reply.status).toBe(200);
      const first = items(reply)[0];
      expect(first?.cells.paid_vnd).toBeNull();
      expect(first?.na.paid_vnd).toBe('LEDGER_DENIED');
      expect(first?.cells.contract_value_vnd).toBe(String(M(1000)));
      expect(totals(reply)).toMatchObject({ rows: 5, ledger_rows: 0, cells: { paid_vnd: null, paid_to_accepted_pct: null, contract_value_vnd: String(M(10200)) }, na: { paid_vnd: 'LEDGER_DENIED' } });
    });

    it('shows a reader only what their scope reaches, in the rows, the total and the report of the contractors (no id of another unit is a hit)', async () => {
      const reply = await call('/contracts/analytics/portfolio', UNIT_TWO);
      expect(codes(reply)).toEqual(['HD-3', 'HD-4']);
      expect(totals(reply)).toMatchObject({ rows: 2, cells: { contract_value_vnd: String(M(5700)) } });
      const other = await call(`/contracts/analytics/portfolio?project=${projects.P1}`, UNIT_TWO);
      expect(codes(other)).toEqual([]);
      expect(totals(other).rows).toBe(0);
      const report = await call('/contracts/analytics/reports/contractor-concentration', UNIT_TWO);
      expect(report.status).toBe(200);
      expect(report.json.active_contracts).toBe(1);
      const names = (report.json.contractors as Array<{ contractor_id: string }>).map((contractor) => contractor.contractor_id);
      expect(names).not.toContain(contractors[1]);
    });

    it('refuses a guest contractor, a member with no right and an unknown report', async () => {
      expect((await call('/contracts/analytics/portfolio', GUEST)).status).toBe(403);
      expect((await call('/contracts/analytics/reports/bid-variance', GUEST)).status).toBe(403);
      expect((await call('/contracts/analytics/portfolio', NOBODY)).status).toBe(403);
      expect((await call('/contracts/analytics/reports/nope')).status).toBe(404);
    });
  });

  describe('the reports of the catalogue', () => {
    it('gives the bid variance as the ratio of the sums over the contracts that have a bid, and says why a row has none', async () => {
      const reply = await call('/contracts/analytics/reports/bid-variance');
      expect(reply.status).toBe(200);
      // contract at signing against the winning bid: (900 + 3000 + 5000) vs (880 + 3100 + 5000)
      expect(totals(reply).cells).toMatchObject({ winning_bid_vnd: String(M(8980)), original_value_vnd: String(M(8900)), bid_variance_vnd: String(-M(80)), bid_variance_pct: '-0.89' });
      const hd1 = items(reply).find((item) => item.cells.code === 'HD-1');
      expect(hd1?.cells).toMatchObject({ bid_variance_vnd: String(M(20)), bid_variance_pct: '2.27', bidder_count: 1, single_bidder: 1 });
      const hd4 = items(reply).find((item) => item.cells.code === 'HD-4');
      expect(hd4?.cells.bid_variance_pct).toBeNull();
      expect(hd4?.na.bid_variance_pct).toBe('NO_WINNING_BID');
      // single bidder: 1 of the 3 contracts whose bidder count is known
      expect(totals(reply).cells.single_bidder).toBe('33.33');
      expect(reply.json.breakdown).toMatchObject({ dimension: 'bidder_band' });
      expect((reply.json.definitions as Array<{ code: string }>).map((one) => one.code)).toEqual(['BID_PRICE_VARIANCE', 'SINGLE_BIDDER_RATE']);
    });

    it('answers every report of the catalogue with its columns, rows, totals and the definitions of its figures', async () => {
      for (const code of ['bid-variance', 'portfolio-status', 'schedule-delay', 'payment-three-way', 'advance-ageing', 'retention-guarantee', 'change-growth']) {
        const reply = await call(`/contracts/analytics/reports/${code}`);
        expect([code, reply.status]).toEqual([code, 200]);
        expect(reply.json.code).toBe(code);
        expect(items(reply)).toHaveLength(5);
        expect(totals(reply).rows).toBe(5);
        const columns = (reply.json.columns as Array<{ key: string }>).map((column) => column.key);
        for (const item of items(reply)) expect(Object.keys(item.cells).sort()).toEqual([...columns].sort());
      }
      const delay = await call('/contracts/analytics/reports/schedule-delay');
      expect(totals(delay).cells.days_late).toBe(60);
      expect(delay.json.evm).toEqual({ status: 'UNAVAILABLE', reason: 'NOT_WIRED' });
      expect(items(delay).find((item) => item.cells.code === 'HD-4')?.cells.days_late).toBe(20);
    });

    it('reads the advance, the retention, the guarantee and the changes from the sums of the contracts that have them', async () => {
      const advance = await call('/contracts/analytics/reports/advance-ageing');
      expect(totals(advance).cells).toMatchObject({ advance_paid_vnd: String(M(800)), advance_recovered_vnd: String(M(650)), advance_outstanding_vnd: String(M(150)), advance_outstanding_pct: '18.75' });
      const keep = await call('/contracts/analytics/reports/retention-guarantee');
      expect(totals(keep).cells).toMatchObject({ retention_withheld_vnd: String(M(40)), retention_held_vnd: String(M(30)), guarantee_required_vnd: String(M(400)), guarantee_valid_vnd: String(M(400)), guarantee_coverage_pct: '100.00', guarantee_exposure_vnd: '0' });
      const growth = await call('/contracts/analytics/reports/change-growth');
      expect(totals(growth).cells).toMatchObject({ approved_change_delta_vnd: String(M(100)), approved_change_count: 1, max_change_tier: 2, max_cumulative_variation_pct: '11.11' });
      const status = await call('/contracts/analytics/reports/portfolio-status');
      const groups = (status.json.breakdown as { groups: Array<{ key: string; totals: { rows: number } }> }).groups;
      expect(groups.map((group) => [group.key, group.totals.rows])).toEqual([['DRAFT', 1], ['ACTIVE', 3], ['COMPLETED', 1]]);
    });

    it('recomputes the concentration from the raw rows: a joint venture is counted once by its shares', async () => {
      const reply = await call('/contracts/analytics/reports/contractor-concentration');
      expect(reply.status).toBe(200);
      const dimensions = reply.json.dimensions as Array<{ dimension: string; groups: Array<{ key: string; value_vnd: string }>; top_share: { value: string }; hhi: { value: string }; level: string }>;
      const contractor = dimensions.find((one) => one.dimension === 'contractor');
      // active: HD-1 1000 (K1), HD-2 3000 (K2), HD-3 5000 (K1 60%, K3 40%)
      const raw = [
        { contractId: 'a', status: 'ACTIVE', valueVnd: String(M(1000)), investorKey: null, unitKey: null, fundKey: null, contractorId: contractors[0] as string },
        { contractId: 'b', status: 'ACTIVE', valueVnd: String(M(3000)), investorKey: null, unitKey: null, fundKey: null, contractorId: contractors[1] as string },
        {
          contractId: 'c',
          status: 'ACTIVE',
          valueVnd: String(M(5000)),
          investorKey: null,
          unitKey: null,
          fundKey: null,
          contractorId: contractors[0] as string,
          parties: [
            { contractorId: contractors[0] as string, sharePct: '60.0000', status: 'ACTIVE' },
            { contractorId: contractors[2] as string, sharePct: '40.0000', status: 'ACTIVE' },
          ],
        },
      ];
      const expected = concentrationOf(raw, 'contractor', 5);
      expect(contractor?.groups.map((group) => [group.key, group.value_vnd])).toEqual(expected.groups.map((group) => [group.key, group.valueVnd]));
      expect(contractor?.top_share.value).toBe(expected.top.value);
      expect(contractor?.hhi.value).toBe(expected.hhi.value);
      // K1 = 1000 + 3000 = 4000, K2 = 3000, K3 = 2000 over 9000
      expect(contractor?.groups.map((group) => group.value_vnd)).toEqual([String(M(4000)), String(M(3000)), String(M(2000))]);
      // three active contracts are fewer than the minimum of the rule: the level is not judged, and says so
      expect(contractor?.level).toBe('NOT_ENOUGH_DATA');
      expect(reply.json.rule).toMatchObject({ type: 'CONTRACT_CONCENTRATION', version: 0, source: 'DEFAULT' });
      expect(reply.json.single_bidder).toMatchObject({ value: '33.33', numerator: '1', denominator: '3' });
      const loads = reply.json.contractors as Array<{ contractor_id: string; active_contracts: number; name: string | null }>;
      expect(loads.map((load) => [load.contractor_id, load.active_contracts])).toEqual([[contractors[0], 2], [contractors[1], 1], [contractors[2], 1]]);
      expect(loads[0]?.name).toBe('Nha thau 1');
    });
  });

  describe('the files: Excel, CSV and PDF carry the same figures as the screen', () => {
    type FileReply = { status: number; json: { format: string; file_name: string; size_bytes: number; file_sha256: string; row_count: number; stale: boolean; content_base64: string } };
    const exported = async (code: string, format: string, query = '', member = ADMIN): Promise<FileReply> => (await call(`/contracts/analytics/reports/${code}/export?format=${format}${query}`, member)) as unknown as FileReply;

    it('writes an Excel whose total is the sum of its rows and the total of the server, read back', async () => {
      const file = await exported('portfolio-status', 'xlsx');
      expect(file.status).toBe(200);
      const bytes = Buffer.from(file.json.content_base64, 'base64');
      expect(bytes.length).toBe(file.json.size_bytes);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as never);
      const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;
      const table: unknown[][] = [];
      sheet.eachRow((row) => table.push((row.values as unknown[]).slice(1)));
      const head = table.findIndex((row) => row[0] === 'code');
      expect(head).toBeGreaterThan(0);
      const data = table.slice(head + 1).filter((row) => row.length > 0);
      const total = data[data.length - 1] as unknown[];
      const body = data.slice(0, -1);
      expect(body).toHaveLength(5);
      const column = (key: string): bigint => {
        const index = (table[head] as string[]).indexOf(key);
        return body.reduce((acc, row) => acc + BigInt(String((row[index] as string | number | null | undefined) ?? '0') || '0'), 0n);
      };
      const server = totals(await call('/contracts/analytics/reports/portfolio-status'));
      for (const key of ['contract_value_vnd', 'original_value_vnd', 'approved_change_delta_vnd', 'accepted_vnd', 'paid_vnd']) {
        const index = (table[head] as string[]).indexOf(key);
        expect(String(total[index])).toBe(column(key).toString());
        expect(String(total[index])).toBe(String(server.cells[key]));
      }
      const header = new Map(table.slice(0, head).map((row) => [row[0], row[2]]));
      expect(header.get('currency_unit')).toBe('VND');
      expect(String(header.get('row_count'))).toBe('5');
      expect(header.get('snapshot_id') ?? '').toBe('');
    });

    it('writes a CSV with the totals line and a PDF, audits each export once, and refuses what is not a format', async () => {
      const csv = await exported('bid-variance', 'csv');
      expect(csv.status).toBe(200);
      const text = Buffer.from(csv.json.content_base64, 'base64').toString('utf8');
      expect(text.startsWith('﻿')).toBe(true);
      expect(text).toContain('HD-1');
      expect(text).toContain('-0.89');
      const pdf = await exported('contractor-concentration', 'pdf');
      expect(pdf.status).toBe(200);
      expect(Buffer.from(pdf.json.content_base64, 'base64').subarray(0, 4).toString('latin1')).toBe('%PDF');
      expect((await exported('bid-variance', 'docx')).status).toBe(422);
      const logged = await rows<{ n: string }>(`select count(*)::text as n from machvon.audit_event where action = 'contract.report_exported' and actor_id = $1`, [memberId(ADMIN)]);
      expect(Number(logged[0]?.n)).toBe(3);
      expect((await exported('bid-variance', 'csv', '', GUEST)).status).toBe(403);
    });
  });

  describe('the frozen fact and its lineage (R16, R17)', () => {
    it('freezes the fact with a period: revision 1, the lines of DS-CTR add up to the contracts, a joint venture counted once', async () => {
      const first = await frozenPeriod('2030-01', day(-1));
      const built = await freeze(first.snapshotId);
      expect(built.outcome).toBe('BUILT');
      expect(built.snapshot).toMatchObject({ revision: 1, latestRevision: 1, stale: false, supersedesId: null, contractCount: 5, rowCount: 6, periodCode: '2030-01' });
      ids.first = built.snapshot.id;
      const lines = await rows<{ contract_value: string; paid: string; n: string }>('select sum(contract_value_vnd)::text as contract_value, sum(paid_vnd)::text as paid, count(*)::text as n from machvon.contract_fact_snapshot_line where snapshot_id = $1::uuid', [built.snapshot.id]);
      expect(lines[0]).toMatchObject({ contract_value: String(M(10200)), paid: String(M(3300)), n: '6' });
      // the joint venture: 60 / 40 of 5000, once
      const venture = await rows<{ contractor_id: string; contract_value_vnd: string; is_lead: boolean; single_bidder_flag: number | null; days_late: number | null }>(
        'select contractor_id, contract_value_vnd::text, is_lead, single_bidder_flag, days_late from machvon.contract_fact_snapshot_line where snapshot_id = $1::uuid and contract_id = $2::uuid order by contract_value_vnd desc',
        [built.snapshot.id, ids['HD-3']],
      );
      expect(venture.map((line) => [line.contractor_id, line.contract_value_vnd, line.is_lead])).toEqual([[contractors[0], String(M(3000)), true], [contractors[2], String(M(2000)), false]]);
      expect(venture[1]).toMatchObject({ single_bidder_flag: null, days_late: null });
      // asking again changes nothing
      expect((await freeze(first.snapshotId)).outcome).toBe('UNCHANGED');
    });

    it('is append-only: a row of a snapshot cannot be changed or removed', async () => {
      await expect(rows('update machvon.contract_fact_snapshot set row_count = 1 where id = $1::uuid', [ids.first])).rejects.toThrow();
      await expect(rows('delete from machvon.contract_fact_snapshot_line where snapshot_id = $1::uuid', [ids.first])).rejects.toThrow();
      await expect(rows('delete from machvon.contract_fact_snapshot_contract where snapshot_id = $1::uuid', [ids.first])).rejects.toThrow();
    });

    it('reads a report from the frozen fact, with its revision and the cut-off day; a later change of the live contracts does not move it', async () => {
      const before = await call('/contracts/analytics/reports/portfolio-status?period=2030-01');
      expect(before.status).toBe(200);
      expect(before.json.context).toMatchObject({ freshness: { kind: 'SNAPSHOT', stale: false, snapshot: { revision: 1, period_code: '2030-01', id: ids.first } } });
      expect(totals(before).cells.paid_vnd).toBe(String(M(3300)));
      await rows('update machvon.contract set paid_total_vnd = paid_total_vnd + 1, requested_total_vnd = requested_total_vnd + 1, accepted_total_vnd = accepted_total_vnd + 1 where id = $1::uuid', [ids['HD-2']]);
      const live = await call('/contracts/analytics/reports/portfolio-status');
      expect(totals(live).cells.paid_vnd).toBe(String(M(3300) + 1));
      expect(totals(await call('/contracts/analytics/reports/portfolio-status?period=2030-01')).cells.paid_vnd).toBe(String(M(3300)));
      expect(totals(await call(`/contracts/analytics/reports/portfolio-status?snapshot_id=${ids.first}`)).cells.paid_vnd).toBe(String(M(3300)));
    });

    it('freezes a correction as the next revision, says which it replaces, and flags the older one stale in the screen and in the file', async () => {
      const second = await frozenPeriod('2030-01', day(-1), (await rows<{ id: string }>('select period_snapshot_id as id from machvon.contract_fact_snapshot where id = $1::uuid', [ids.first]))[0]?.id as string);
      const built = await freeze(second.snapshotId);
      expect(built.snapshot).toMatchObject({ revision: 2, latestRevision: 2, stale: false, supersedesId: ids.first });
      ids.second = built.snapshot.id;
      const old = await call(`/contracts/analytics/reports/portfolio-status?snapshot_id=${ids.first}`);
      expect(old.json.context).toMatchObject({ freshness: { kind: 'SNAPSHOT', stale: true, snapshot: { revision: 1, latest_revision: 2 } } });
      const latest = await call('/contracts/analytics/reports/portfolio-status?period=2030-01');
      expect(latest.json.context).toMatchObject({ freshness: { stale: false, snapshot: { revision: 2, id: ids.second } } });
      const file = await call(`/contracts/analytics/reports/portfolio-status/export?format=csv&snapshot_id=${ids.first}`);
      expect(file.json.stale).toBe(true);
      expect(Buffer.from(file.json.content_base64 as string, 'base64').toString('utf8')).toContain('CŨ');
      const lineage = await call('/contracts/analytics/snapshots?period=2030-01');
      expect((lineage.json.items as Array<{ revision: number; stale: boolean; supersedes_id: string | null }>).map((one) => [one.revision, one.stale, one.supersedes_id])).toEqual([[2, false, ids.first], [1, true, null]]);
    });
  });

  describe('the aggregate per contract (R12) is a cache of the definition, never another one', () => {
    const facts = (): Promise<Array<{ id: string; fact: Record<string, unknown> }>> =>
      tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(ADMIN), scopeVersion: 1 }, (tx) =>
        tx.query<{ id: string; fact: Record<string, unknown> }>("select c.id::text as id, to_jsonb(c) - 'as_of_date' as fact from machvon.contract_fact c order by c.id"),
      );

    it('gives the same figures whether a contract has its aggregate row or not (the seeds were written with the triggers off, so none has)', async () => {
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.contract_aggregate'))[0]?.n).toBe('0');
      const without = await facts();
      const made = await rows<{ made: string }>('select machvon.contract_aggregate_backfill()::text as made');
      expect(made[0]?.made).toBe('5');
      const withRows = await facts();
      expect(withRows).toEqual(without);
      expect(withRows).toHaveLength(5);
    });

    it('agrees on the days late with the kernel: the column of the view (the sort and the filter) and the figure of the report are one definition', async () => {
      const view = new Map((await facts()).map((row) => [row.id, row.fact.days_late as number | null]));
      const report = await call('/contracts/analytics/reports/schedule-delay');
      for (const item of items(report)) expect([item.cells.code, item.cells.days_late]).toEqual([item.cells.code, view.get(item.contract_id) ?? null]);
    });

    it('refreshes the aggregate in the transaction of the write that changes a source, and the view follows', async () => {
      const [k4] = [contractors[3] as string];
      const [row] = await rows<{ package_id: string; project_id: string }>('select package_id, project_id from machvon.contract where id = $1::uuid', [ids['HD-3']]);
      const before = (await rows<{ bidder_count: number | null }>('select bidder_count from machvon.contract_aggregate where contract_id = $1::uuid', [ids['HD-3']]))[0]?.bidder_count;
      expect(before).toBe(2);
      await rows(
        `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, bid_price_vnd, submitted_at, access_released_at, created_by)
         values ($1, $2, $3, $4, $5, '[]'::jsonb, 1, 'RECEIVED', 1, now(), now(), $6)`,
        [TENANT_A, randomUUID(), row?.project_id, row?.package_id, k4, memberId(ADMIN)],
      );
      expect((await rows<{ bidder_count: number | null }>('select bidder_count from machvon.contract_aggregate where contract_id = $1::uuid', [ids['HD-3']]))[0]?.bidder_count).toBe(3);
      const reply = await call('/contracts/analytics/reports/bid-variance');
      expect(items(reply).find((item) => item.cells.code === 'HD-3')?.cells.bidder_count).toBe(3);
    });
  });

  describe('a source that fails is an error, never an empty table', () => {
    it('answers a server error when the fact cannot be read, and not a table of no contracts', async () => {
      await rows('revoke select on machvon.contract_fact from machvon_app');
      try {
        for (const url of ['/contracts/analytics/portfolio', '/contracts/analytics/reports/bid-variance', '/contracts/analytics/reports/contractor-concentration']) {
          const reply = await call(url);
          expect([url, reply.status >= 500]).toEqual([url, true]);
          expect(reply.json.items).toBeUndefined();
          expect(reply.json.dimensions).toBeUndefined();
        }
      } finally {
        await rows('grant select on machvon.contract_fact to machvon_app');
      }
      expect((await call('/contracts/analytics/portfolio')).status).toBe(200);
    });
  });
});
