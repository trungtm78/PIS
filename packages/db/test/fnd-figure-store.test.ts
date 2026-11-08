import { randomUUID } from 'node:crypto';
import { figuresOfProject, indicatorsOf, moneyIndicatorsOf } from '@machvon/kernel';
import { FndFigureStore } from '../src/fnd-figure-store';
import type { FigureProposal } from '../src/fnd-figure-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { everything, seedAs } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const store = new FndFigureStore();
const MAKER = 1;
const CHECKER = 2;
const THIRD = 3;
const PACK = 'ENTERPRISE';
const NOW = new Date('2026-11-08T03:00:00Z');

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string | undefined }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, detail: e.detail };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

let projectId = '';
let calendarVersionId = '';
const periods: Record<string, string> = {};

async function seedProject(): Promise<string> {
  const created = randomUUID();
  await seedAs(harness, [[
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
     values ($1, $2, $3, 'Enterprise project', $4, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
    [TENANT_A, created, `FND-${created.slice(0, 6)}`, unitId(1), id(0x50, 90)],
  ]]);
  return created;
}

async function seedCalendar(): Promise<string> {
  return randomUUID();
}

async function seedPeriod(type: 'MONTH' | 'QUARTER' | 'YEAR', year: number, start: string, end: string, status: 'OPEN' | 'SOFT_CLOSED' | 'LOCKED'): Promise<string> {
  const periodId = randomUUID();
  const locked = status === 'LOCKED';
  await seedAs(harness, [[
    `insert into machvon.reporting_period
       (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
     values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'ENTERPRISE', $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
    [TENANT_A, periodId, `${type}-${start}`, start, end, type, year, status, status === 'OPEN' ? null : `${end}T05:00:00Z`, locked ? `${end}T06:00:00Z` : null, locked ? memberId(CHECKER) : null, calendarVersionId, memberId(MAKER)],
  ]]);
  return periodId;
}

/** A published plan version of the enterprise pack for the project: one line of the class EQUITY on the single tier. */
async function seedPlan(year: number, revision: number, status: 'PUBLISHED' | 'SUPERSEDED', effectiveAt: string, amount: string, bucket = 'EQUITY'): Promise<string> {
  const versionId = randomUUID();
  await seedAs(harness, [[`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`, [TENANT_A, versionId, projectId, year, revision, randomUUID(), status, effectiveAt]]]);
  await seedAs(harness, [[
    `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, budget_level, taxonomy_pack)
     values ($1, $2, $3, $4, $5, $6, $7::numeric, 0, 'ALL', 'ENTERPRISE')`,
    [TENANT_A, randomUUID(), versionId, randomUUID(), bucket, year, amount],
  ]]);
  return versionId;
}

const proposal = (over: Partial<FigureProposal> & Pick<FigureProposal, 'kind' | 'grain' | 'entries'>): FigureProposal => ({
  projectId,
  classCode: 'EQUITY',
  tierCode: 'ALL',
  measure: 'DISBURSED',
  planYear: 2026,
  asOfDate: '2026-02-01',
  ...over,
});

/** Propose, submit and accept by two people; returns what the acceptance did. */
async function settle(input: FigureProposal, preparer = MAKER, checker = CHECKER) {
  const drafted = await as((tx) => store.propose(tx, input, PACK, memberId(preparer), everything, NOW), preparer);
  const submitted = await as((tx) => store.submit(tx, drafted.batchId, 1, memberId(preparer), everything, NOW), preparer);
  const accepted = await as((tx) => store.accept(tx, drafted.batchId, submitted.version, memberId(checker), PACK, everything, NOW), checker);
  return { drafted, submitted, accepted };
}

const rowsOf = (kind: string, ordinal: number) =>
  owner<{ id: string; status: string; amount: string; revision: number; converted_from_id: string | null; estimate_amount_vnd: string | null; conversion_reason: string | null; supersedes_id: string | null }>(
    `select id, status, amount_vnd::text as amount, revision, converted_from_id, estimate_amount_vnd::text as estimate_amount_vnd, conversion_reason, supersedes_id
       from machvon.plan_figure_revision where project_id = $1::uuid and figure_kind = $2 and period_ordinal = $3 and status <> 'WITHDRAWN' order by revision`,
    [projectId, kind, ordinal],
  );

describe('the stored figures of the funding model (FND-1 section 7.3)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      for (const member of [MAKER, CHECKER, THIRD]) await harness.seedMembership(tenant, member, 1);
    }
    projectId = await seedProject();
    calendarVersionId = await seedCalendar();
    periods['M1'] = await seedPeriod('MONTH', 2026, '2026-01-01', '2026-01-31', 'LOCKED');
    periods['M2'] = await seedPeriod('MONTH', 2026, '2026-02-01', '2026-02-28', 'SOFT_CLOSED');
    periods['M3'] = await seedPeriod('MONTH', 2026, '2026-03-01', '2026-03-31', 'OPEN');
    await seedPlan(2026, 1, 'SUPERSEDED', '2026-01-10T03:00:00Z', '1000');
    await seedPlan(2026, 2, 'PUBLISHED', '2026-07-01T03:00:00Z', '1200');
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('resolves the pack of the tenant on a day: the built-in default with version 0, flagged unverified for the enterprise', async () => {
    const resolved = await as((tx) => store.resolvePack(tx, PACK, '2026-11-08'));
    expect(resolved).toMatchObject({ ruleId: null, version: 0, unverified: true });
    expect(resolved.pack.classes.map((one) => one.code)).toEqual(['EQUITY', 'LOAN', 'OTHER']);
    const publicPack = await as((tx) => store.resolvePack(tx, 'PUBLIC', '2026-11-08'));
    expect(publicPack.unverified).toBe(false);
  });

  it('reads the year plans of CAP as the first plan and its adjustment, effective on the Vietnam day of the publication', async () => {
    const resolved = await as((tx) => store.resolvePack(tx, PACK, '2026-11-08'));
    const books = await as((tx) => store.loadBooks(tx, [projectId], resolved));
    const book = books.get(projectId);
    expect(book?.figures.map((one) => [one.kind, one.amountVnd, one.asOfDate])).toEqual([
      ['PLAN_YEAR', '1000', '2026-01-10'],
      ['PLAN_ADJUSTED', '1200', '2026-07-01'],
    ]);
    const query = { period: { grain: 'YEAR' as const, planYear: 2026, ordinal: 0 }, measure: 'DISBURSED' as const, view: 'AS_REPORTED' as const };
    const before = moneyIndicatorsOf(resolved.pack, [figuresOfProject(book as NonNullable<typeof book>, projectId, { ...query, asOf: '2026-06-30' })], { ...query, asOf: '2026-06-30' });
    const after = moneyIndicatorsOf(resolved.pack, [figuresOfProject(book as NonNullable<typeof book>, projectId, { ...query, asOf: '2026-07-01' })], { ...query, asOf: '2026-07-01' });
    expect(before.find((one) => one.code === 'PLAN_IN_FORCE')?.valueVnd).toBe('1000');
    expect(after.find((one) => one.code === 'PLAN_IN_FORCE')?.valueVnd).toBe('1200');
    expect(after.find((one) => one.code === 'PLAN_ADJUSTMENT_DELTA')?.valueVnd).toBe('200');
  });

  describe('the phased plan', () => {
    it('accepts four quarters that add up to the year plan in force, as a draft, a submission and an acceptance by another person', async () => {
      const { drafted, submitted, accepted } = await settle(proposal({ kind: 'PLAN_QUARTER', grain: 'QUARTER', entries: [1, 2, 3, 4].map((ordinal) => ({ ordinal, amountVnd: '250' })) }));
      expect(drafted).toMatchObject({ status: 'DRAFT', count: 4, version: 1 });
      expect(submitted).toMatchObject({ fromStatus: 'DRAFT', status: 'SUBMITTED', version: 2 });
      expect(accepted).toMatchObject({ fromStatus: 'SUBMITTED', status: 'ACCEPTED', version: 3, conversions: 0 });
      const rows = await rowsOf('PLAN_QUARTER', 1);
      expect(rows).toEqual([expect.objectContaining({ status: 'ACCEPTED', amount: '250', revision: 1 })]);
    });

    it('refuses quarters that do not add up (422 PHASING_SUM_MISMATCH) and a phasing that is not the whole set (422 VALIDATION_FAILED naming entries)', async () => {
      const wrong = await refusal(as((tx) => store.propose(tx, proposal({ kind: 'PLAN_QUARTER', grain: 'QUARTER', entries: [1, 2, 3, 4].map((ordinal) => ({ ordinal, amountVnd: '300' })) }), PACK, memberId(MAKER), everything, NOW)));
      expect(wrong).toMatchObject({ code: 'PHASING_SUM_MISMATCH', status: 422, detail: 'quarters' });
      const partial = await refusal(as((tx) => store.propose(tx, proposal({ kind: 'PLAN_QUARTER', grain: 'QUARTER', entries: [1, 2, 3].map((ordinal) => ({ ordinal, amountVnd: '250' })) }), PACK, memberId(MAKER), everything, NOW)));
      expect(partial).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'entries' });
    });

    it('holds the months of a quarter to the quarter, and lets a corrected phasing supersede the one before it with the lineage kept', async () => {
      const months = [1, 2, 3].map((ordinal) => ({ ordinal, amountVnd: ordinal === 3 ? '100' : '75' }));
      const full = [...months, ...[4, 5, 6, 7, 8, 9, 10, 11, 12].map((ordinal) => ({ ordinal, amountVnd: '75' }))];
      // The quarters are 250 each; the months of the first quarter add up to 250, the others to 225: the set is refused at the first quarter that breaks.
      const broken = await refusal(as((tx) => store.propose(tx, proposal({ kind: 'PLAN_MONTH', grain: 'MONTH', entries: full }), PACK, memberId(MAKER), everything, NOW)));
      expect(broken).toMatchObject({ code: 'GRAIN_SUM_MISMATCH', status: 422, detail: 'months' });
      const good = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((ordinal) => ({ ordinal, amountVnd: ordinal % 3 === 0 ? '100' : '75' }));
      const first = await settle(proposal({ kind: 'PLAN_MONTH', grain: 'MONTH', entries: good }));
      expect(first.accepted.count).toBe(12);
      const corrected = good.map((entry) => ({ ...entry, amountVnd: entry.ordinal % 3 === 0 ? '90' : '80' }));
      const second = await settle(proposal({ kind: 'PLAN_MONTH', grain: 'MONTH', asOfDate: '2026-03-01', entries: corrected }));
      expect(second.accepted.count).toBe(12);
      expect(await rowsOf('PLAN_MONTH', 3)).toEqual([expect.objectContaining({ status: 'SUPERSEDED', amount: '100', revision: 1 }), expect.objectContaining({ status: 'ACCEPTED', amount: '90', revision: 2 })]);
      const [chain] = await owner<{ supersedes: string | null; first_id: string }>(
        `select a.supersedes_id as supersedes, b.id as first_id from machvon.plan_figure_revision a join machvon.plan_figure_revision b on b.id = a.supersedes_id where a.project_id = $1::uuid and a.figure_kind = 'PLAN_MONTH' and a.period_ordinal = 3 and a.revision = 2`,
        [projectId],
      );
      expect(chain?.supersedes).toBe(chain?.first_id);
    });

    it('a year plan of DISBURSED belongs to CAP and is refused here (422 on figure_kind)', async () => {
      const refused = await refusal(as((tx) => store.propose(tx, proposal({ kind: 'PLAN_YEAR', grain: 'YEAR', entries: [{ ordinal: 0, amountVnd: '5' }] }), PACK, memberId(MAKER), everything, NOW)));
      expect(refused).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'figure_kind' });
      expect(await databaseRefusal(owner(`insert into machvon.plan_figure_revision (tenant_id, batch_id, project_id, taxonomy_pack, bucket, budget_level, measure, figure_kind, period_grain, plan_year, period_ordinal, amount_vnd, basis, as_of_date, prepared_by, updated_by)
        values ($1, gen_random_uuid(), $2, 'ENTERPRISE', 'EQUITY', 'ALL', 'DISBURSED', 'PLAN_YEAR', 'YEAR', 2026, 0, 1, 'PLAN_DECISION', '2026-01-01', $3, $3)`, [TENANT_A, projectId, memberId(MAKER)]))).toContain('plan_figure_cap_owns_chk');
    });
  });

  describe('maker is not checker', () => {
    it('refuses the acceptance by the person who prepared (403 SELF_APPROVAL_DENIED), the submission by another person, and an acceptance of a draft', async () => {
      const drafted = await as((tx) => store.propose(tx, proposal({ kind: 'ESTIMATE', grain: 'MONTH', entries: [{ ordinal: 3, amountVnd: '100' }] }), PACK, memberId(MAKER), everything, NOW));
      expect((await refusal(as((tx) => store.accept(tx, drafted.batchId, 1, memberId(CHECKER), PACK, everything, NOW), CHECKER))).code).toBe('FIGURE_STATE_INVALID');
      expect((await refusal(as((tx) => store.submit(tx, drafted.batchId, 1, memberId(THIRD), everything, NOW), THIRD)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      await as((tx) => store.submit(tx, drafted.batchId, 1, memberId(MAKER), everything, NOW));
      expect((await refusal(as((tx) => store.accept(tx, drafted.batchId, 2, memberId(MAKER), PACK, everything, NOW)))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await refusal(as((tx) => store.accept(tx, drafted.batchId, 1, memberId(CHECKER), PACK, everything, NOW), CHECKER))).code).toBe('VERSION_CONFLICT');
      await as((tx) => store.sendBack(tx, drafted.batchId, 2, memberId(CHECKER), everything, NOW), CHECKER);
      expect((await as((tx) => store.find(tx, drafted.batchId, everything)))?.status).toBe('DRAFT');
      await as((tx) => store.withdraw(tx, drafted.batchId, 3, memberId(MAKER), everything, NOW));
      expect((await as((tx) => store.find(tx, drafted.batchId, everything)))?.status).toBe('WITHDRAWN');
    });

    it('the database refuses an acceptance by the preparer even when the application is bypassed', async () => {
      const drafted = await as((tx) => store.propose(tx, proposal({ kind: 'ESTIMATE', grain: 'MONTH', entries: [{ ordinal: 9, amountVnd: '10' }] }), PACK, memberId(MAKER), everything, NOW));
      await as((tx) => store.submit(tx, drafted.batchId, 1, memberId(MAKER), everything, NOW));
      expect(await databaseRefusal(owner(`update machvon.plan_figure_revision set status = 'ACCEPTED', approved_by = prepared_by, approved_at = now() where batch_id = $1::uuid`, [drafted.batchId]))).toContain('plan_figure_sod_chk');
    });
  });

  describe('estimate and actual with the history kept', () => {
    it('keeps every estimate revision, converts the estimate when the actual is accepted (one transaction, with the link and the amount of the estimate), and refuses an estimate after the actual', async () => {
      await settle(proposal({ kind: 'ESTIMATE', grain: 'MONTH', asOfDate: '2026-03-10', entries: [{ ordinal: 3, amountVnd: '100' }] }));
      await settle(proposal({ kind: 'ESTIMATE', grain: 'MONTH', asOfDate: '2026-03-25', entries: [{ ordinal: 3, amountVnd: '120' }] }));
      expect(await rowsOf('ESTIMATE', 3)).toEqual([expect.objectContaining({ status: 'SUPERSEDED', amount: '100' }), expect.objectContaining({ status: 'ACCEPTED', amount: '120' })]);
      const { accepted } = await settle(proposal({ kind: 'ACTUAL', grain: 'MONTH', asOfDate: '2026-04-05', entries: [{ ordinal: 3, amountVnd: '125' }] }), THIRD, CHECKER);
      expect(accepted).toMatchObject({ status: 'ACCEPTED', conversions: 1 });
      const estimates = await rowsOf('ESTIMATE', 3);
      const actual = (await rowsOf('ACTUAL', 3))[0];
      expect(estimates.map((row) => row.status)).toEqual(['SUPERSEDED', 'SUPERSEDED']);
      expect(actual).toMatchObject({ status: 'ACCEPTED', amount: '125', estimate_amount_vnd: '120', conversion_reason: 'PERIOD_ACTUAL_IN', converted_from_id: estimates[1]?.id });
      const late = await refusal(as((tx) => store.propose(tx, proposal({ kind: 'ESTIMATE', grain: 'MONTH', asOfDate: '2026-04-06', entries: [{ ordinal: 3, amountVnd: '130' }] }), PACK, memberId(MAKER), everything, NOW)));
      expect(late).toMatchObject({ code: 'ESTIMATE_AFTER_ACTUAL', status: 422 });
      const history = await as((tx) => store.history(tx, { projectId, classCode: 'EQUITY', tierCode: 'ALL', measure: 'DISBURSED', grain: 'MONTH', planYear: 2026, ordinal: 3, packCode: PACK }, everything));
      expect(history.history.map((entry) => [entry.kind, entry.amountVnd, entry.changeVnd, entry.conversionDeltaVnd])).toEqual([['ESTIMATE', '100', null, null], ['ESTIMATE', '120', '20', null], ['ACTUAL', '125', null, '5']]);
    });

    it('the database refuses to delete a figure, to change what it says, to move it backwards, and to write the link of a conversion twice', async () => {
      const [actual] = await rowsOf('ACTUAL', 3);
      const [estimate] = await rowsOf('ESTIMATE', 3);
      expect(await databaseRefusal(owner('delete from machvon.plan_figure_revision where id = $1::uuid', [actual?.id]))).toContain('kept for good');
      expect(await databaseRefusal(owner('update machvon.plan_figure_revision set amount_vnd = 1 where id = $1::uuid', [actual?.id]))).toContain('does not change');
      expect(await databaseRefusal(owner(`update machvon.plan_figure_revision set status = 'DRAFT' where id = $1::uuid`, [actual?.id]))).toContain('does not move');
      expect(await databaseRefusal(owner('update machvon.plan_figure_revision set converted_from_id = $2::uuid, estimate_amount_vnd = 1 where id = $1::uuid', [actual?.id, estimate?.id]))).toContain('written once');
    });

    it('the conversion is one transaction: a failure after the acceptance leaves the estimate and the actual as they were', async () => {
      await settle(proposal({ kind: 'ESTIMATE', grain: 'MONTH', asOfDate: '2026-03-12', entries: [{ ordinal: 4, amountVnd: '40' }] }));
      const drafted = await as((tx) => store.propose(tx, proposal({ kind: 'ACTUAL', grain: 'MONTH', asOfDate: '2026-04-10', entries: [{ ordinal: 4, amountVnd: '45' }] }), PACK, memberId(MAKER), everything, NOW));
      await as((tx) => store.submit(tx, drafted.batchId, 1, memberId(MAKER), everything, NOW));
      const failed = as(async (tx) => {
        await store.accept(tx, drafted.batchId, 2, memberId(CHECKER), PACK, everything, NOW);
        throw new Error('after the acceptance');
      }, CHECKER);
      await expect(failed).rejects.toThrow('after the acceptance');
      expect((await rowsOf('ESTIMATE', 4)).map((row) => row.status)).toEqual(['ACCEPTED']);
      expect((await rowsOf('ACTUAL', 4)).map((row) => [row.status, row.converted_from_id])).toEqual([['SUBMITTED', null]]);
    });

    it('a negative actual needs its explanation (422), a late adjustment is booked in the open period against the month it corrects and is read in both views', async () => {
      const negative = await refusal(as((tx) => store.propose(tx, proposal({ kind: 'ACTUAL', grain: 'MONTH', asOfDate: '2026-04-05', entries: [{ ordinal: 5, amountVnd: '-5' }] }), PACK, memberId(MAKER), everything, NOW)));
      expect(negative).toMatchObject({ code: 'NEGATIVE_DELTA_EXPLANATION_REQUIRED', status: 422 });
      await settle(proposal({ kind: 'ACTUAL', grain: 'MONTH', asOfDate: '2026-04-05', entries: [{ ordinal: 6, amountVnd: '50' }] }));
      await settle(proposal({ kind: 'ACTUAL', grain: 'MONTH', asOfDate: '2026-08-05', entries: [{ ordinal: 7, amountVnd: '70' }] }));
      await settle(proposal({ kind: 'ACTUAL', grain: 'MONTH', basis: 'ADJUSTMENT', adjusts: { planYear: 2026, ordinal: 6 }, asOfDate: '2026-08-06', explanation: 'an invoice of June was booked in July by the accounting division', entries: [{ ordinal: 7, amountVnd: '15' }] }));
      const resolved = await as((tx) => store.resolvePack(tx, PACK, '2026-11-08'));
      const book = (await as((tx) => store.loadBooks(tx, [projectId], resolved))).get(projectId) as NonNullable<ReturnType<Awaited<ReturnType<FndFigureStore['loadBooks']>>['get']>>;
      const at = (ordinal: number, view: 'AS_REPORTED' | 'RESTATED') => figuresOfProject(book, projectId, { period: { grain: 'MONTH', planYear: 2026, ordinal }, asOf: '2026-11-01', measure: 'DISBURSED', view }).cells.find((cell) => cell.classCode === 'EQUITY');
      expect([at(6, 'AS_REPORTED')?.actual, at(7, 'AS_REPORTED')?.actual]).toEqual(['50', '85']);
      expect([at(6, 'RESTATED')?.actual, at(7, 'RESTATED')?.actual]).toEqual(['65', '70']);
      expect(at(7, 'AS_REPORTED')?.cumulativeYtd).toBe(at(7, 'RESTATED')?.cumulativeYtd);
      const rates = indicatorsOf(resolved.pack, [figuresOfProject(book, projectId, { period: { grain: 'MONTH', planYear: 2026, ordinal: 7 }, asOf: '2026-11-01', measure: 'DISBURSED', view: 'AS_REPORTED' })], { period: { grain: 'MONTH', planYear: 2026, ordinal: 7 }, asOf: '2026-11-01', measure: 'DISBURSED', view: 'AS_REPORTED' });
      expect(rates.find((one) => one.code === 'RATE_YEAR_IN_FORCE')).toMatchObject({ denominatorVnd: '1200', nullReason: null });
    });
  });

  describe('the period and the pack', () => {
    it('writes nothing into a locked period (409 FIGURE_PERIOD_LOCKED) and takes no new estimate in a soft-closed one, but still takes its actual', async () => {
      const locked = await refusal(as((tx) => store.propose(tx, proposal({ kind: 'ACTUAL', grain: 'MONTH', asOfDate: '2026-02-05', entries: [{ ordinal: 1, amountVnd: '1' }] }), PACK, memberId(MAKER), everything, NOW)));
      expect(locked).toMatchObject({ code: 'FIGURE_PERIOD_LOCKED', status: 409 });
      const estimate = await refusal(as((tx) => store.propose(tx, proposal({ kind: 'ESTIMATE', grain: 'MONTH', entries: [{ ordinal: 2, amountVnd: '1' }] }), PACK, memberId(MAKER), everything, NOW)));
      expect(estimate).toMatchObject({ code: 'ESTIMATE_AFTER_ACTUAL', status: 422 });
      const actual = await settle(proposal({ kind: 'ACTUAL', grain: 'MONTH', asOfDate: '2026-03-05', entries: [{ ordinal: 2, amountVnd: '30' }] }));
      expect(actual.accepted.status).toBe('ACCEPTED');
      const [period] = await owner<{ status: string }>('select status from machvon.reporting_period where id = $1::uuid', [periods['M1']]);
      expect(period?.status).toBe('LOCKED');
    });

    it('refuses a class or a tier that is not of the pack (422 FUNDING_CLASS_UNKNOWN) and the actuals of a pack headed by the Treasury', async () => {
      const unknownClass = await refusal(as((tx) => store.propose(tx, proposal({ classCode: 'CURRENT_YEAR', kind: 'ESTIMATE', grain: 'MONTH', entries: [{ ordinal: 3, amountVnd: '1' }] }), PACK, memberId(MAKER), everything, NOW)));
      expect(unknownClass).toMatchObject({ code: 'FUNDING_CLASS_UNKNOWN', status: 422, detail: 'class_code' });
      const unknownTier = await refusal(as((tx) => store.propose(tx, proposal({ tierCode: 'CENTRAL', kind: 'ESTIMATE', grain: 'MONTH', entries: [{ ordinal: 3, amountVnd: '1' }] }), PACK, memberId(MAKER), everything, NOW)));
      expect(unknownTier).toMatchObject({ code: 'FUNDING_CLASS_UNKNOWN', detail: 'tier_code' });
      const treasury = await refusal(as((tx) => store.propose(tx, proposal({ classCode: 'CURRENT_YEAR', tierCode: 'CENTRAL', kind: 'ACTUAL', grain: 'MONTH', entries: [{ ordinal: 3, amountVnd: '1' }] }), 'PUBLIC', memberId(MAKER), everything, NOW)));
      expect(treasury).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'figure_kind' });
    });

    it('the closed lists are open by pack: an enterprise line is accepted in the enterprise pack, a public class is refused there, and a public line stays public', async () => {
      expect(await databaseRefusal(owner(`insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, budget_level, taxonomy_pack)
        select tenant_id, gen_random_uuid(), id, gen_random_uuid(), 'CURRENT_YEAR', 2026, 1, 0, 'ALL', 'ENTERPRISE' from machvon.plan_version where project_id = $1::uuid limit 1`, [projectId]))).toContain('allocation_line_class_pack_chk');
      expect(await databaseRefusal(owner(`insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, budget_level, taxonomy_pack)
        select tenant_id, gen_random_uuid(), id, gen_random_uuid(), 'EQUITY', 2026, 1, 0, 'CENTRAL', 'PUBLIC' from machvon.plan_version where project_id = $1::uuid limit 1`, [projectId]))).toContain('allocation_line_class_pack_chk');
      const [counts] = await owner<{ n: string }>(`select count(*)::text as n from machvon.allocation_line where taxonomy_pack = 'ENTERPRISE' and bucket = 'EQUITY'`);
      expect(Number(counts?.n)).toBeGreaterThanOrEqual(2);
    });
  });

  describe('snapshots and the shared reading shape', () => {
    const snapshotId = randomUUID();
    const reportingPeriod = randomUUID();

    it('a restatement names the closed snapshot it restates; the figures of a snapshot are written only while it is built and never changed; the view reads both shapes', async () => {
      await seedAs(harness, [[
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, 'Q-X', 1, '2026-04-01', '2026-06-30', '2026-07-03', 'ENTERPRISE', 'QUARTER', 2026, 'OPEN', $3, $4, $4)`,
        [TENANT_A, reportingPeriod, calendarVersionId, memberId(MAKER)],
      ]]);
      await owner(
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, taxonomy_pack, taxonomy_version, hash_schema, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), '2026-06-30', '2026-06-30', 'BUILDING', 'FND-1', 'PROPOSED_PENDING_SIGNOFF', 'ENTERPRISE', 1, 2, $4, $4)`,
        [TENANT_A, snapshotId, reportingPeriod, memberId(MAKER)],
      );
      await owner(
        `insert into machvon.period_snapshot_figure (tenant_id, snapshot_id, project_id, unit_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal, amount_vnd, basis)
         values ($1, $2, $3, $4, 'EQUITY', 'ALL', 'DISBURSED', 'ACTUAL', 'MONTH', 2026, 6, 50, 'REPORTED')`,
        [TENANT_A, snapshotId, projectId, unitId(1)],
      );
      expect(await databaseRefusal(owner(`update machvon.period_snapshot_figure set amount_vnd = 1 where snapshot_id = $1::uuid`, [snapshotId]))).toContain('not changed');
      expect(await databaseRefusal(owner(`delete from machvon.period_snapshot_figure where snapshot_id = $1::uuid`, [snapshotId]))).toContain('not changed');
      expect(await databaseRefusal(owner(`insert into machvon.period_snapshot_figure (tenant_id, snapshot_id, project_id, unit_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal, amount_vnd, null_reason)
        values ($1, $2, $3, $4, 'EQUITY', 'ALL', 'DISBURSED', 'ACTUAL', 'MONTH', 2026, 5, 1, 'NO_DATA')`, [TENANT_A, snapshotId, projectId, unitId(1)]))).toContain('snapshot_figure_null_chk');
      const viewed = await owner<{ class_code: string; figure_kind: string; amount_vnd: string; basis: string; taxonomy_pack: string }>(`select class_code, figure_kind, amount_vnd::text as amount_vnd, basis, taxonomy_pack from machvon.v_snapshot_figure where snapshot_id = $1::uuid`, [snapshotId]);
      expect(viewed).toEqual([{ class_code: 'EQUITY', figure_kind: 'ACTUAL', amount_vnd: '50', basis: 'REPORTED', taxonomy_pack: 'ENTERPRISE' }]);
      await owner(`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2::uuid, frozen_at = now() where id = $1::uuid`, [snapshotId, memberId(CHECKER)]);
      expect(await databaseRefusal(owner(`insert into machvon.period_snapshot_figure (tenant_id, snapshot_id, project_id, unit_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal, amount_vnd, basis)
        values ($1, $2, $3, $4, 'EQUITY', 'ALL', 'DISBURSED', 'ACTUAL', 'MONTH', 2026, 4, 1, 'REPORTED')`, [TENANT_A, snapshotId, projectId, unitId(1)]))).toContain('while it is being built');
      expect(await databaseRefusal(owner(`update machvon.period_snapshot set taxonomy_pack = 'PUBLIC' where id = $1::uuid`, [snapshotId]))).toBeDefined();
    });

    it('a restatement is a snapshot of the kind RESTATED that names a frozen snapshot of the same period and pack; no other kind names one', async () => {
      const build = (kind: string, restates: string | null, period = reportingPeriod, pack = 'ENTERPRISE') =>
        owner(
          `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, taxonomy_pack, taxonomy_version, hash_schema, restates_snapshot_id, created_by, updated_by)
           values ($1, $2, $3, $4, now(), '2026-06-30', '2026-06-30', 'BUILDING', 'FND-1', 'PROPOSED_PENDING_SIGNOFF', $5, 1, 2, $6::uuid, $7, $7)`,
          [TENANT_A, randomUUID(), period, kind, pack, restates, memberId(MAKER)],
        );
      expect(await databaseRefusal(build('RESTATED', null))).toContain('period_snapshot_restates_chk');
      expect(await databaseRefusal(build('PERIOD_CLOSE', snapshotId))).toContain('period_snapshot_restates_chk');
      expect(await databaseRefusal(build('RESTATED', randomUUID()))).toContain('restates a closed snapshot');
      await build('RESTATED', snapshotId);
      expect(await databaseRefusal(build('RESTATED', snapshotId, reportingPeriod, 'PUBLIC'))).toContain('same period and pack');
    });

    it('a public snapshot of version 1 keeps hash schema 1 and the defaults say public for every row that existed', async () => {
      const [row] = await owner<{ taxonomy_pack: string; taxonomy_version: number; hash_schema: number }>(`select taxonomy_pack, taxonomy_version, hash_schema from machvon.period_snapshot where id = $1::uuid`, [snapshotId]);
      expect(row).toEqual({ taxonomy_pack: 'ENTERPRISE', taxonomy_version: 1, hash_schema: 2 });
      expect(await databaseRefusal(owner(`insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, taxonomy_pack, taxonomy_version, hash_schema, created_by, updated_by)
        values ($1, gen_random_uuid(), $2, 'ADHOC', now(), '2026-06-30', '2026-06-30', 'BUILDING', 'x', 'PROPOSED_PENDING_SIGNOFF', 'ENTERPRISE', 1, 1, $3, $3)`, [TENANT_A, reportingPeriod, memberId(MAKER)]))).toContain('period_snapshot_hash_pack_chk');
    });
  });

  describe('tenants and the lists', () => {
    it('another tenant sees none of the figures; a batch outside the scope is not found; the list is filtered and newest first', async () => {
      const first = (await as((tx) => store.list(tx, { projectId }, everything, 50)))[0];
      expect(first).toBeDefined();
      expect(await as((tx) => store.find(tx, (first as NonNullable<typeof first>).batchId, everything), MAKER, TENANT_B)).toBeUndefined();
      expect(await as((tx) => store.list(tx, {}, everything, 50), MAKER, TENANT_B)).toEqual([]);
      expect(await as((tx) => store.find(tx, (first as NonNullable<typeof first>).batchId, () => ({ sql: 'false', params: [] })))).toBeUndefined();
      expect((await refusal(as((tx) => store.propose(tx, proposal({ kind: 'ESTIMATE', grain: 'MONTH', entries: [{ ordinal: 3, amountVnd: '1' }] }), PACK, memberId(MAKER), () => ({ sql: 'false', params: [] }), NOW)))).status).toBe(404);
      const accepted = await as((tx) => store.list(tx, { projectId, status: 'ACCEPTED', kind: 'ACTUAL' }, everything, 50));
      expect(accepted.length).toBeGreaterThanOrEqual(3);
      expect(accepted.every((batch) => batch.status === 'ACCEPTED' && batch.kind === 'ACTUAL')).toBe(true);
      const all = await as((tx) => store.list(tx, { projectId }, everything, 50));
      expect(all.map((batch) => batch.createdAt)).toEqual([...all.map((batch) => batch.createdAt)].sort().reverse());
    });
  });
});
