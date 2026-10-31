import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { bidModule } from '../../src/modules/bid';
import { ContractorHistoryController } from '../../src/modules/bid/contractor-history.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const EVALUATOR = 21; // bid.contractor.read and contractor.performance.read over the whole tenant
const BID_ONLY = 22; // bid.contractor.read alone
const GUEST = 23; // a guest contractor with the same rights
const NOBODY = 24;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the history of a contractor for the evaluators (ST-BID-013, UAT-AC451, UAT-AC446)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  let app: RunningApp;
  let counter = 0;
  let contractor = '';
  let other = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function history(member: number, id: string): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}/contractors/${id}/history`, { headers: { [TENANT_HEADER]: tokenOf(member) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function contract(holder: string): Promise<string> {
    counter += 1;
    const line = await world.publishedLine();
    const id = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'OTHER', false, true, 1000000, $7, $7, date '2026-01-01', date '2026-01-02', null, null)`,
        [TENANT_A, id, line.projectId, randomUUID(), holder, `HD-H-${String(counter).padStart(4, '0')}`, memberId(EVALUATOR)],
      ],
    ]);
    return id;
  }

  /** A scorecard of CTR in the status given; an approved one carries the approval. */
  async function scorecard(contractId: string, holder: string, status: string, overall: string, options: { period?: string; revision?: number; approvedAt?: string } = {}): Promise<string> {
    const id = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contractor_performance
           (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, revision, score_quality, score_schedule, score_safety_env, score_cooperation, score_financial, overall_score, rating, status,
            evaluated_by, approved_by, approved_at, created_by, updated_by)
         values ($1, $2, $3, $4, 'PERIODIC', $5, $6, 80, 70, 90, 60, 100, $7::numeric, 'GOOD', $8, $9,
                 case when $8 in ('APPROVED', 'SUPERSEDED') then $10::uuid end, case when $8 in ('APPROVED', 'SUPERSEDED') then $11::timestamptz end, $9, $9)`,
        [TENANT_A, id, contractId, holder, options.period ?? '2026-Q3', options.revision ?? 1, overall, status, memberId(EVALUATOR), memberId(BID_ONLY), options.approvedAt ?? '2026-10-10T03:00:00Z'],
      ],
    ]);
    return id;
  }

  async function restriction(holder: string, kind: string, from: string, until: string | null): Promise<string> {
    const id = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, effective_until, created_by, updated_by)
         values ($1, $2, $3, $4, 'NATIONAL_E_PROCUREMENT_IMPORT', $5::date, $6::date, $7, $7)`,
        [TENANT_A, id, holder, kind, from, until, memberId(EVALUATOR)],
      ],
    ]);
    return id;
  }

  beforeAll(async () => {
    await world.start();
    for (const n of [EVALUATOR, BID_ONLY, GUEST, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'BID_EVALUATOR', ['bid.contractor.read', 'contractor.performance.read'], 30);
    await harness.seedRole(TENANT_A, 102, 'BID_READER', ['bid.contractor.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: EVALUATOR, role: 101, kind: 'TENANT' },
      { n: 2, member: BID_ONLY, role: 102, kind: 'TENANT' },
      { n: 3, member: GUEST, role: 101, kind: 'TENANT' },
    ]);
    contractor = await seedContractor(harness);
    other = await seedContractor(harness);
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST), contractor]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ContractorHistoryController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the module of BID', () => {
    expect(bidModule.controllers).toContain(ContractorHistoryController);
  });

  it('AC-ST-BID-013-1, UAT-AC451: only the approved scorecards that stand are history: CP-7 (83.00) is there, CP-8 (submitted), a draft and a replaced revision are not', async () => {
    const one = await contract(contractor);
    const two = await contract(contractor);
    const cp7 = await scorecard(one, contractor, 'APPROVED', '83.00', { period: '2026-Q2' });
    await scorecard(two, contractor, 'SUBMITTED', '60.00', { period: '2026-Q3' });
    await scorecard(two, contractor, 'DRAFT', '55.00', { period: '2026-Q4' });
    await scorecard(one, contractor, 'SUPERSEDED', '40.00', { period: '2026-Q1' });
    const reply = await history(EVALUATOR, contractor);
    expect(reply.status).toBe(200);
    const cards = reply.json.scorecards as Array<Record<string, unknown>>;
    expect(cards.map((card) => card.id)).toEqual([cp7]);
    expect(cards[0]).toMatchObject({ contract_id: one, kind: 'PERIODIC', period_label: '2026-Q2', revision: 1, overall_score: '83.00', rating: 'GOOD', scores: { quality: 80 } });
    expect(reply.json.average_overall_score).toBe('83.00');
    expect((reply.json.contracts as Array<{ id: string }>).map((entry) => entry.id).sort()).toEqual([one, two].sort());
    expect(reply.json.contractor).toEqual({ id: contractor, legal_name: expect.any(String) });
  });

  it('finds the approved scorecards however many newer ones are not: the list is cut after the approved ones are chosen, and the count is of all of them', async () => {
    const holder = await seedContractor(harness);
    const first = await contract(holder);
    const approved = await scorecard(first, holder, 'APPROVED', '77.00', { period: '2025-Q1', approvedAt: '2025-04-10T03:00:00Z' });
    // 520 evaluations made after it, none of them approved: the 500 newest of all would hold no approved one.
    await rows(
      `insert into machvon.contractor_performance
         (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, revision, score_quality, score_schedule, score_safety_env, score_cooperation, score_financial, overall_score, rating, status, evaluated_by, created_at, created_by, updated_by)
       select $1, gen_random_uuid(), $2, $3, 'PERIODIC', 'P-' || n, 1, 50, 50, 50, 50, 50, 50.00, 'FAIR', 'SUBMITTED', $4, now() + make_interval(secs => n), $4, $4 from generate_series(1, 520) as n`,
      [TENANT_A, first, holder, memberId(EVALUATOR)],
    );
    const reply = await history(EVALUATOR, holder);
    expect((reply.json.scorecards as Array<{ id: string }>).map((card) => card.id)).toEqual([approved]);
    expect(reply.json).toMatchObject({ approved_count: 1, average_overall_score: '77.00' });
  });

  it('averages the approved scorecards and puts the latest approval first', async () => {
    const holder = await seedContractor(harness);
    const first = await contract(holder);
    const early = await scorecard(first, holder, 'APPROVED', '70.00', { period: '2026-Q1', approvedAt: '2026-04-10T03:00:00Z' });
    const late = await scorecard(first, holder, 'APPROVED', '91.00', { period: '2026-Q2', approvedAt: '2026-07-10T03:00:00Z' });
    const reply = await history(EVALUATOR, holder);
    expect((reply.json.scorecards as Array<{ id: string }>).map((card) => card.id)).toEqual([late, early]);
    expect(reply.json.average_overall_score).toBe('80.50');
  });

  it('shows no scorecard and no contract to someone who may not read the scorecards, but the restrictions all the same', async () => {
    const holder = await seedContractor(harness);
    await scorecard(await contract(holder), holder, 'APPROVED', '83.00');
    await restriction(holder, 'WARNING', '2026-01-01', '2026-02-01');
    const reply = await history(BID_ONLY, holder);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ scorecards: [], contracts: [], average_overall_score: null, restrictions: [{ kind: 'WARNING', in_force: false }] });
  });

  it('AC-ST-BID-013-2, UAT-AC446: lists the restrictions with their source and validity, the one that applies today marked, and says so', async () => {
    const holder = await seedContractor(harness);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const ended = await restriction(holder, 'WARNING', '2025-01-01', '2025-06-30');
    const lastDay = await restriction(holder, 'SUSPENSION', '2026-01-01', today);
    const open = await restriction(holder, 'DEBARMENT', '2026-02-01', null);
    const ahead = await restriction(holder, 'SUSPENSION', '2999-01-01', '2999-12-31');
    const reply = await history(EVALUATOR, holder);
    const list = reply.json.restrictions as Array<Record<string, unknown>>;
    expect(list.map((entry) => [entry.id, entry.in_force])).toEqual([
      [ahead, false],
      [open, true],
      [lastDay, true],
      [ended, false],
    ]);
    expect(list.find((entry) => entry.id === open)).toEqual({ id: open, kind: 'DEBARMENT', source: 'NATIONAL_E_PROCUREMENT_IMPORT', effective_from: '2026-02-01', effective_until: null, in_force: true });
    expect(reply.json.restriction_in_force).toBe(true);
    const clean = await history(EVALUATOR, other);
    expect(clean.json).toMatchObject({ restrictions: [], restriction_in_force: false, scorecards: [], contracts: [], average_overall_score: null });
  });

  it('leaves out the decision and the note of a restriction: they stay with the register of contractors', async () => {
    const holder = await seedContractor(harness);
    await restriction(holder, 'DEBARMENT', '2026-02-01', null);
    const text = JSON.stringify((await history(EVALUATOR, holder)).json);
    expect(text).not.toContain('decision_document_id');
    expect(text).not.toContain('note');
  });

  it('is closed to a guest contractor (403), to whoever lacks the right (403), and an unknown contractor is 404', async () => {
    expect((await history(GUEST, contractor)).status).toBe(403);
    expect((await history(NOBODY, contractor)).status).toBe(403);
    expect((await history(EVALUATOR, randomUUID())).status).toBe(404);
    expect((await history(EVALUATOR, 'not-a-uuid')).status).toBe(422);
  });
});
