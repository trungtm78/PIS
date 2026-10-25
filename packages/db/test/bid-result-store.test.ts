import { randomUUID } from 'node:crypto';
import { BidResultStore } from '../src/bid-result-store';
import type { NewResultInput, ResultFacts, ResultHooks } from '../src/bid-result-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { DEPARTMENT, PROVINCE, everything, nothing, onProjects, seedAs, seedBidPackage, seedContractor } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const results = new BidResultStore();
const FAMILY = 0xa9;
const PROPOSER = 1;
const APPROVER = 2;
const OTHER = 3;
const BUDGET = '18000000000';
const MINUTES = id(FAMILY, 1);
const MINUTES_DRAFT = id(FAMILY, 2);
const DECISION = id(FAMILY, 3);
const DECISION_DRAFT = id(FAMILY, 4);
const NOT_A_DECISION = id(FAMILY, 5);

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = PROPOSER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { message: string }).message;
  }
  throw new Error('expected the database to refuse');
};

const NOW = new Date('2026-10-25T03:00:00Z');
const open = (): ResultHooks & { authorise: jest.Mock } => ({ authorise: jest.fn(async (facts: ResultFacts) => void facts) }) as ResultHooks & { authorise: jest.Mock };

interface Setup {
  seeded: SeededPackage;
  winner: string;
}

const setup = async (options: { status?: string; budget?: string } = {}): Promise<Setup> => ({
  seeded: await seedBidPackage(harness, { ...(options.status === undefined ? {} : { status: options.status }), budgetVnd: options.budget ?? BUDGET }),
  winner: await seedContractor(harness),
});

const submit = (s: Setup, overrides: Partial<NewResultInput> = {}, scope: ScopeBuilder = everything, member = PROPOSER) =>
  as((tx) => results.submit(tx, { packageId: s.seeded.packageId, outcome: 'AWARDED', winnerContractorId: s.winner, awardPriceVnd: '17650000000', evaluationReportId: MINUTES, ...overrides }, memberId(member), scope, NOW), member);
const decide = (resultId: string, version: number, input: Parameters<BidResultStore['decide']>[3], member = APPROVER, hooks: ResultHooks = open(), scope: ScopeBuilder = everything) =>
  as((tx) => results.decide(tx, resultId, version, input, memberId(member), scope, NOW, hooks), member);
const approve = (resultId: string, version = 1, member = APPROVER, hooks: ResultHooks = open()) => decide(resultId, version, { decision: 'APPROVE', decisionDocumentId: DECISION, comment: 'KQ-01' }, member, hooks);

const row = async (resultId: string) =>
  (
    await owner<{
      status: string;
      outcome: string;
      winner_contractor_id: string | null;
      award_price_vnd: string | null;
      evaluation_minutes_document_id: string | null;
      decision_document_id: string | null;
      submitted_by: string | null;
      approved_by: string | null;
      rejected_by: string | null;
      decision_comment: string | null;
      version: string;
    }>(
      `select status, outcome, winner_contractor_id, award_price_vnd::text, evaluation_minutes_document_id, decision_document_id, submitted_by, approved_by, rejected_by, decision_comment, version::text
         from machvon.procurement_result where id = $1::uuid`,
      [resultId],
    )
  )[0];
const packageStatus = async (packageId: string) => (await owner<{ status: string }>('select status from machvon.procurement_package where id = $1::uuid', [packageId]))[0]?.status;

describe('the result of the selection of a contractor (ST-BID-006)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
    ]);
    for (const n of [PROPOSER, APPROVER, OTHER]) await harness.seedMembership(TENANT_A, n, PROVINCE);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, effect_status, symbol, issued_on, created_by, updated_by) values
           ($1, $2, 'REFERENCE', 'BB-DG', 'Evaluation minutes', 'INTERNAL', 'EFFECTIVE', 'BB-01', date '2026-10-01', $7, $7),
           ($1, $3, 'REFERENCE', 'BB-DG', 'Evaluation minutes (draft)', 'INTERNAL', 'PENDING', null, null, $7, $7),
           ($1, $4, 'REFERENCE', 'QD', 'Decision KQ-01', 'INTERNAL', 'EFFECTIVE', 'KQ-01', date '2026-10-20', $7, $7),
           ($1, $5, 'REFERENCE', 'QD', 'Decision (draft)', 'INTERNAL', 'PENDING', null, null, $7, $7),
           ($1, $6, 'REFERENCE', 'CV', 'A letter', 'INTERNAL', 'EFFECTIVE', 'CV-01', date '2026-10-20', $7, $7)`,
        [TENANT_A, MINUTES, MINUTES_DRAFT, DECISION, DECISION_DRAFT, NOT_A_DECISION, memberId(PROPOSER)],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('submitProcurementResult', () => {
    it('AC-ST-BID-006-1, UAT-AC455: refuses 18,500,000,000 against a package of 18,000,000,000, then takes 17,650,000,000 and stores it SUBMITTED by the proposer', async () => {
      const s = await setup();
      expect(await refusal(submit(s, { awardPriceVnd: '18500000000' }))).toEqual({
        code: 'PRICE_EXCEEDS_PACKAGE_BUDGET',
        status: 422,
        detail: 'award_price_vnd',
        extensions: { budget_vnd: BUDGET, award_price_vnd: '18500000000' },
      });
      expect(await owner('select 1 from machvon.procurement_result where package_id = $1::uuid', [s.seeded.packageId])).toEqual([]);

      const done = await submit(s);
      expect(done).toMatchObject({ outcome: 'AWARDED', winnerContractorId: s.winner, awardPriceVnd: '17650000000', budgetVnd: BUDGET, evaluationMinutesDocumentId: MINUTES, status: 'SUBMITTED', version: 1, packageId: s.seeded.packageId });
      expect(await row(done.id)).toEqual({
        status: 'SUBMITTED',
        outcome: 'AWARDED',
        winner_contractor_id: s.winner,
        award_price_vnd: '17650000000',
        evaluation_minutes_document_id: MINUTES,
        decision_document_id: null,
        submitted_by: memberId(PROPOSER),
        approved_by: null,
        rejected_by: null,
        decision_comment: null,
        version: '1',
      });
      expect(await packageStatus(s.seeded.packageId)).toBe('APPROVED');
    });

    it('takes the price of the package itself, and the other two outcomes with neither a winner nor a price', async () => {
      const s = await setup();
      const exact = await submit(s, { awardPriceVnd: BUDGET });
      expect(exact.awardPriceVnd).toBe(BUDGET);
      await decide(exact.id, 1, { decision: 'REJECT', comment: 'Resubmit as no acceptable bid.' });
      const none = await submit(s, { outcome: 'NO_ACCEPTABLE_BID', winnerContractorId: undefined, awardPriceVnd: undefined });
      expect(none).toMatchObject({ outcome: 'NO_ACCEPTABLE_BID', winnerContractorId: null, awardPriceVnd: null });
      expect(await row(none.id)).toMatchObject({ winner_contractor_id: null, award_price_vnd: null });
    });

    it('judges the shape: an unknown outcome, an award without a winner or a price, a price that is not whole VND, and a winner or a price on an outcome that has none', async () => {
      const s = await setup();
      expect(await refusal(submit(s, { outcome: 'WON' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'outcome' });
      expect(await refusal(submit(s, { winnerContractorId: undefined }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'winner_contractor_id' });
      expect(await refusal(submit(s, { awardPriceVnd: undefined }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'award_price_vnd' });
      for (const price of ['1.5', '-5', '0', 'abc', '1'.repeat(25)]) expect(await refusal(submit(s, { awardPriceVnd: price }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'award_price_vnd' });
      expect(await refusal(submit(s, { outcome: 'CANCELLED' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'winner_contractor_id' });
      expect(await refusal(submit(s, { outcome: 'CANCELLED', winnerContractorId: undefined }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'award_price_vnd' });
      expect(await owner('select 1 from machvon.procurement_result where package_id = $1::uuid', [s.seeded.packageId])).toEqual([]);
    });

    it('AC-ST-BID-006-2, UAT-AC446: refuses a winner under a restriction in force, and one nobody verified, and a winner that does not exist', async () => {
      const s = await setup();
      const restricted = await seedContractor(harness, { restricted: true });
      expect(await refusal(submit(s, { winnerContractorId: restricted }))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED', status: 422 });
      const unverified = await seedContractor(harness, { status: 'UNVERIFIED' });
      expect(await refusal(submit(s, { winnerContractorId: unverified }))).toMatchObject({ code: 'CONTRACTOR_NOT_VERIFIED', status: 422 });
      expect(await refusal(submit(s, { winnerContractorId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'winner_contractor_id' });
      expect(await owner('select 1 from machvon.procurement_result where package_id = $1::uuid', [s.seeded.packageId])).toEqual([]);
    });

    it('is for a package whose plan is in force, and for a package of the scope of the caller', async () => {
      for (const status of ['DRAFT', 'IN_REVIEW', 'SUPERSEDED', 'CANCELLED', 'AWARDED']) {
        const s = await setup({ status });
        expect(await refusal(submit(s))).toMatchObject({ code: 'PLAN_NOT_APPROVED', status: 409, extensions: { package_status: status } });
      }
      const s = await setup();
      expect(await refusal(submit(s, {}, nothing))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(submit(s, {}, onProjects(randomUUID())))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(submit(s, { packageId: randomUUID() }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await submit(s, {}, onProjects(s.seeded.projectId))).status).toBe('SUBMITTED');
    });

    it('rests on an evaluation that was issued: minutes still being drafted are 409 REPORT_NOT_ISSUED and a document that does not exist is a fault of the request', async () => {
      const s = await setup();
      expect(await refusal(submit(s, { evaluationReportId: MINUTES_DRAFT }))).toMatchObject({ code: 'REPORT_NOT_ISSUED', status: 409, extensions: { effect_status: 'PENDING' } });
      expect(await refusal(submit(s, { evaluationReportId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evaluation_report_id' });
      expect((await submit(s, { evaluationReportId: MINUTES.toUpperCase() })).evaluationMinutesDocumentId).toBe(MINUTES);
    });

    it('keeps one result open for a package: a second is refused until the first is decided', async () => {
      const s = await setup();
      const first = await submit(s);
      expect(await refusal(submit(s))).toMatchObject({ code: 'RESULT_STATE_INVALID', status: 409, extensions: { result_status: 'SUBMITTED', reason: 'OPEN_RESULT' } });
      expect(await databaseRefusal(owner("insert into machvon.procurement_result (tenant_id, id, package_id, outcome, status, submitted_by, evaluation_minutes_document_id, created_by, updated_by) values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1::uuid, 'CANCELLED', 'SUBMITTED', $2::uuid, $3::uuid, $2::uuid, $2::uuid)", [s.seeded.packageId, memberId(PROPOSER), MINUTES]))).toContain('procurement_result_one_open_uq');
      await decide(first.id, 1, { decision: 'REJECT', comment: 'The price is not supported.' });
      expect((await submit(s, { awardPriceVnd: '17000000000' })).status).toBe('SUBMITTED');
    });
  });

  describe('decideProcurementResult', () => {
    it('AC-ST-BID-006-1, UAT-AC455: refuses the proposer who approves their own result, then an approver approves it on the decision document and the package is awarded', async () => {
      const s = await setup();
      const submitted = await submit(s);
      expect(await refusal(approve(submitted.id, 1, PROPOSER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await row(submitted.id))?.status).toBe('SUBMITTED');
      expect(await packageStatus(s.seeded.packageId)).toBe('APPROVED');

      const authorise = open();
      const done = await approve(submitted.id, 1, APPROVER, authorise);
      expect(authorise.authorise).toHaveBeenCalledTimes(1);
      expect(authorise.authorise.mock.calls[0]?.[0]).toMatchObject({ resultId: submitted.id, packageId: s.seeded.packageId, projectId: s.seeded.projectId, amountVnd: '17650000000', ownerUnit: { path: '/u1/u2/' } });
      expect(done).toMatchObject({
        id: submitted.id,
        packageId: s.seeded.packageId,
        outcome: 'AWARDED',
        winnerContractorId: s.winner,
        awardPriceVnd: '17650000000',
        decision: 'APPROVE',
        status: 'APPROVED',
        decisionDocumentId: DECISION,
        comment: 'KQ-01',
        packageStatus: 'AWARDED',
        version: 2,
      });
      expect(await row(submitted.id)).toMatchObject({ status: 'APPROVED', decision_document_id: DECISION, approved_by: memberId(APPROVER), submitted_by: memberId(PROPOSER), decision_comment: 'KQ-01', version: '2' });
      expect(await packageStatus(s.seeded.packageId)).toBe('AWARDED');
    });

    it('gives the package the status of the outcome: no acceptable bid, and cancelled', async () => {
      for (const outcome of ['NO_ACCEPTABLE_BID', 'CANCELLED'] as const) {
        const s = await setup();
        const submitted = await submit(s, { outcome, winnerContractorId: undefined, awardPriceVnd: undefined });
        const done = await decide(submitted.id, 1, { decision: 'APPROVE', decisionDocumentId: DECISION });
        expect([done.status, done.packageStatus, done.comment]).toEqual(['APPROVED', outcome, null]);
        expect(await packageStatus(s.seeded.packageId)).toBe(outcome);
      }
    });

    it('turns a result down with the reason in words and no document, and the package stays open for a new result', async () => {
      const s = await setup();
      const submitted = await submit(s);
      expect(await refusal(decide(submitted.id, 1, { decision: 'REJECT' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'comment' });
      expect(await refusal(decide(submitted.id, 1, { decision: 'REJECT', comment: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'comment' });
      expect(await refusal(decide(submitted.id, 1, { decision: 'REJECT', comment: 'No.', decisionDocumentId: DECISION }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      expect(await refusal(decide(submitted.id, 1, { decision: 'REJECT', comment: 'x'.repeat(2001) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'comment' });
      const done = await decide(submitted.id, 1, { decision: 'REJECT', comment: '  The evaluation does not support the price.  ' });
      expect(done).toMatchObject({ decision: 'REJECT', status: 'REJECTED', decisionDocumentId: null, comment: 'The evaluation does not support the price.', packageStatus: 'APPROVED', version: 2 });
      expect(await row(submitted.id)).toMatchObject({ status: 'REJECTED', rejected_by: memberId(APPROVER), approved_by: null, decision_comment: 'The evaluation does not support the price.' });
      expect(await packageStatus(s.seeded.packageId)).toBe('APPROVED');
    });

    it('does not let the proposer turn their own result down either', async () => {
      const s = await setup();
      const submitted = await submit(s);
      expect(await refusal(decide(submitted.id, 1, { decision: 'REJECT', comment: 'Withdrawn.' }, PROPOSER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    });

    it('asks an approval for a decision document in force: none, one still being drafted, one that is no decision, and one that does not exist', async () => {
      const s = await setup();
      const submitted = await submit(s);
      const attempt = (decisionDocumentId?: string) => decide(submitted.id, 1, { decision: 'APPROVE', ...(decisionDocumentId === undefined ? {} : { decisionDocumentId }) });
      expect(await refusal(attempt())).toMatchObject({ code: 'DECISION_DOCUMENT_NOT_EFFECTIVE', status: 422 });
      expect(await refusal(attempt(DECISION_DRAFT))).toMatchObject({ code: 'DECISION_DOCUMENT_NOT_EFFECTIVE', status: 422 });
      expect(await refusal(attempt(NOT_A_DECISION))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      expect(await refusal(attempt(randomUUID()))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      expect((await row(submitted.id))?.status).toBe('SUBMITTED');
    });

    it('judges the version, the state and the scope: a stale version, a decided result, and a result outside the scope', async () => {
      const s = await setup();
      const submitted = await submit(s);
      expect(await refusal(approve(submitted.id, 7))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(decide(submitted.id, 1, { decision: 'APPROVE', decisionDocumentId: DECISION }, APPROVER, open(), nothing))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(decide(randomUUID(), 1, { decision: 'APPROVE', decisionDocumentId: DECISION }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(decide(submitted.id, 1, { decision: 'MAYBE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      await approve(submitted.id);
      expect(await refusal(approve(submitted.id, 2))).toMatchObject({ code: 'RESULT_STATE_INVALID', status: 409, extensions: { result_status: 'APPROVED' } });
    });

    it('stops where the delegation limit stops it, and decides nothing', async () => {
      const s = await setup();
      const submitted = await submit(s);
      const refused = { authorise: jest.fn(async () => Promise.reject(Object.assign(new Error('limit'), { code: 'SCOPE_DENIED', status: 403 }))) } as ResultHooks;
      expect(await refusal(approve(submitted.id, 1, APPROVER, refused))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect((await row(submitted.id))?.status).toBe('SUBMITTED');
      expect(await packageStatus(s.seeded.packageId)).toBe('APPROVED');
    });

    it('judges the award again at the approval: the plan, the price and the winner may have moved since it was submitted', async () => {
      const lost = await setup();
      const first = await submit(lost);
      await seedAs(harness, [["update machvon.procurement_package set status = 'SUPERSEDED' where id = $1::uuid", [lost.seeded.packageId]]]);
      expect(await refusal(approve(first.id))).toMatchObject({ code: 'PLAN_NOT_APPROVED', status: 409 });

      const cheaper = await setup();
      const second = await submit(cheaper);
      await seedAs(harness, [['update machvon.procurement_package set budget_vnd = 17000000000 where id = $1::uuid', [cheaper.seeded.packageId]]]);
      expect(await refusal(approve(second.id))).toMatchObject({ code: 'PRICE_EXCEEDS_PACKAGE_BUDGET', status: 422 });

      const barred = await setup();
      const third = await submit(barred);
      await seedAs(harness, [
        [
          `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, decision_document_id, created_by, updated_by)
           values ($1, $2, $3, 'DEBARMENT', 'DECISION', date '2020-01-01', $5, $4, $4)`,
          [TENANT_A, randomUUID(), barred.winner, memberId(PROPOSER), DECISION],
        ],
      ]);
      expect(await refusal(approve(third.id))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED', status: 422 });
      for (const result of [first, second, third]) expect((await row(result.id))?.status).toBe('SUBMITTED');
    });
  });

  describe('listProcurementResults', () => {
    it('lists the results of the packages in the scope with the package, the winner, the price, the evaluation, who submitted and who decided, the newest first', async () => {
      const s = await setup();
      const first = await submit(s);
      await decide(first.id, 1, { decision: 'REJECT', comment: 'Too high.' });
      const second = await submit(s, { awardPriceVnd: '17000000000' });
      const lines = await as((tx) => results.list(tx, everything, { packageId: s.seeded.packageId }));
      expect(lines.map((line) => [line.id, line.status])).toEqual([
        [second.id, 'SUBMITTED'],
        [first.id, 'REJECTED'],
      ]);
      expect(lines[0]).toMatchObject({
        package: { id: s.seeded.packageId, code: s.seeded.packageCode, budgetVnd: BUDGET },
        outcome: 'AWARDED',
        winner: { id: s.winner },
        awardPriceVnd: '17000000000',
        evaluationMinutes: { documentId: MINUTES, title: 'Evaluation minutes' },
        decisionDocumentId: null,
        submittedBy: { membershipId: memberId(PROPOSER) },
        decidedBy: null,
        decidedAt: null,
        comment: null,
        version: 1,
      });
      expect(lines[1]).toMatchObject({ decidedBy: { membershipId: memberId(APPROVER) }, comment: 'Too high.', version: 2 });
      expect(lines[1]?.decidedAt).toEqual(expect.any(String));
    });

    it('lists only what the scope reaches, and every package when none is named', async () => {
      const s = await setup();
      const result = await submit(s);
      expect(await as((tx) => results.list(tx, nothing, {}))).toEqual([]);
      expect(await as((tx) => results.list(tx, onProjects(randomUUID()), {}))).toEqual([]);
      const all = await as((tx) => results.list(tx, everything, {}));
      expect(all.map((line) => line.id)).toContain(result.id);
      expect(all.length).toBeGreaterThan(1);
    });
  });

  describe('what the database keeps as it was', () => {
    it('refuses to rewrite what a result says, a decided result, a move off the edges, and a delete', async () => {
      const s = await setup();
      const result = await submit(s);
      const update = (set: string, params: unknown[] = []) => databaseRefusal(owner(`update machvon.procurement_result set ${set} where id = $1::uuid`, [result.id, ...params]));
      for (const change of ["award_price_vnd = 1", "outcome = 'CANCELLED'", 'winner_contractor_id = null', 'package_id = gen_random_uuid()', 'evaluation_minutes_document_id = null']) {
        expect(await update(change)).toContain('what a result of the selection says never changes');
      }
      expect(await update("status = 'DRAFT'")).toContain('RESULT_STATE_INVALID');
      await approve(result.id);
      expect(await update("status = 'REJECTED'")).toContain('a decided result is kept as it is');
      expect(await update('decision_comment = null')).toContain('a decided result is kept as it is');
      expect(await databaseRefusal(as((tx) => tx.query('delete from machvon.procurement_result where id = $1::uuid', [result.id])))).toContain('permission denied');
    });

    it('refuses a decision by the one who submitted, an approval without its day, a rejection without its reason, and an outcome that carries a winner', async () => {
      const s = await setup();
      const result = await submit(s);
      const update = (set: string, params: unknown[] = []) => databaseRefusal(owner(`update machvon.procurement_result set ${set} where id = $1::uuid`, [result.id, ...params]));
      expect(await update("status = 'APPROVED', approved_by = submitted_by, approved_at = now(), decision_document_id = $2::uuid", [DECISION])).toContain('procurement_result_approved_chk');
      expect(await update("status = 'APPROVED', approved_by = $2::uuid, decision_document_id = $3::uuid", [memberId(APPROVER), DECISION])).toContain('procurement_result_approved_at_chk');
      expect(await update("status = 'REJECTED', rejected_by = $2::uuid, rejected_at = now()", [memberId(APPROVER)])).toContain('procurement_result_rejected_chk');
      expect(await update("status = 'REJECTED', rejected_by = submitted_by, rejected_at = now(), decision_comment = 'No'")).toContain('procurement_result_rejected_chk');
      const bare = await submit(await setup(), { outcome: 'CANCELLED', winnerContractorId: undefined, awardPriceVnd: undefined });
      expect(await databaseRefusal(owner('update machvon.procurement_result set winner_contractor_id = $2::uuid where id = $1::uuid', [bare.id, s.winner]))).toContain('what a result of the selection says never changes');
      expect(
        await databaseRefusal(
          owner("insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, outcome, status, created_by, updated_by) values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 'CANCELLED', 'DRAFT', $3::uuid, $3::uuid)", [s.seeded.packageId, s.winner, memberId(PROPOSER)]),
        ),
      ).toContain('procurement_result_outcome_chk');
    });
  });
});
