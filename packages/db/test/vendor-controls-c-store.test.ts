import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { HomeWorkStore } from '../src/home-work-store';
import { VendorPerformanceStore } from '../src/vendor-performance-store';
import { VendorProfileStore } from '../src/vendor-profile-store';
import { VendorQualificationStore } from '../src/vendor-qualification-store';
import { VendorReputationStore } from '../src/vendor-reputation-store';
import { VendorRiskStore } from '../src/vendor-risk-store';
import { WorkCalendarStore } from '../src/work-calendar-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const profiles = new VendorProfileStore();
const qualifications = new VendorQualificationStore();
const reputation = new VendorReputationStore();
const calendars = new WorkCalendarStore();
const risk = new VendorRiskStore({
  finance: async () => 'BELOW',
  load: async () => 'OVER',
  openStrongFindings: async () => 1,
  subcontractBreaches: async () => 0,
  securityForfeits: async () => 0,
});
const quietRisk = new VendorRiskStore({});
const performance = new VendorPerformanceStore();
const work = new HomeWorkStore();

const [M1, M2, M3, M4] = [1, 2, 3, 4];
const PROJECT = randomUUID();
const PACKAGE = randomUUID();
const TODAY = '2026-11-09';
const NOW = new Date('2026-11-09T03:00:00Z');
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = M1, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the database to refuse');
};

/** Rows whose parents belong to other lanes (a project and its master data) are written with the checks of foreign keys off, as the other tests of the package do. */
async function admin(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let counter = 0;
async function contractor(name: string): Promise<string> {
  counter += 1;
  const id = randomUUID();
  const profile = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)`,
    [TENANT_A, profile, memberId(M1)],
  );
  await owner(
    `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis)
     values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $5, 'EVIDENCE_DOCUMENT')`,
    [TENANT_A, id, `04${String(counter).padStart(8, '0')}`, name, profile, memberId(M1), memberId(M2)],
  );
  return id;
}

interface RatedSeed {
  contractorId: string;
  code: string;
  kind?: 'PERIODIC' | 'COMPLETION' | 'TERMINATION';
  rating: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  /** The day the contract ended (terminated_on) and the day the rating was adopted. */
  endedOn: string;
  adoptedOn: string;
  state?: 'ADOPTED' | 'RESPONDED' | 'NOTIFIED';
  respondedOn?: string;
  adoptedBy?: number;
  proposedBy?: number;
}

/** A contract, its evaluation and a rating proposal in the state the seed says, written by the owner of the schema (the checks of the tables still hold). */
async function rated(seed: RatedSeed): Promise<string> {
  const contract = randomUUID();
  const evaluation = randomUUID();
  const proposal = randomUUID();
  const kind = seed.kind ?? 'COMPLETION';
  const state = seed.state ?? 'ADOPTED';
  const proposer = memberId(seed.proposedBy ?? M1);
  const adopter = memberId(seed.adoptedBy ?? M2);
  await owner(
    `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, signed_on, effective_from, contract_value_vnd, terminated_on)
     values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', 'ACTIVE', 1, date '2025-01-01', date '2025-01-01', 1000000, $7::date)`,
    [TENANT_A, contract, PROJECT, PACKAGE, seed.contractorId, seed.code, seed.endedOn],
  );
  const score = seed.rating === 'POOR' ? 40 : 90;
  if (state === 'ADOPTED') {
    await owner(
      `insert into machvon.contractor_performance (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, score_quality, score_schedule, score_safety_env, score_cooperation, score_financial, overall_score, rating, status, evaluated_by, approved_by, approved_at, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'FINAL', $6::smallint, $6::smallint, $6::smallint, $6::smallint, $6::smallint, $6::numeric, $7, 'APPROVED', $8, $9, now(), $8, $8)`,
      [TENANT_A, evaluation, contract, seed.contractorId, kind, score, seed.rating, proposer, adopter],
    );
  }
  const response = seed.respondedOn;
  await owner(
    `insert into machvon.contract_rating_proposal
       (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, as_of_date, rule_version, rule_source, reasons, readings, covered, overall_score, rating, inputs_sha256, state, proposed_by,
        notified_by, notified_at, response_due_at, responded_by, responded_at, response_kind, response_received_on, adopted_by, adopted_at, evaluation_id, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'FINAL', $6::date, 0, 'DEFAULT', '{}'::jsonb, '{}'::jsonb, 5, $7, $8, $9, $10, $11,
             $12, $13::timestamptz, $13::timestamptz + interval '20 days', $14, $15::timestamptz, $16, $17::date, $18, $19::timestamptz, $20, $11, $11)`,
    [
      TENANT_A,
      proposal,
      contract,
      seed.contractorId,
      kind,
      seed.endedOn,
      score,
      seed.rating,
      'a'.repeat(64),
      state,
      proposer,
      memberId(M3),
      `${seed.adoptedOn}T01:00:00Z`,
      response === undefined ? null : memberId(M4),
      response === undefined ? null : `${response}T01:00:00Z`,
      response === undefined ? null : 'ACCEPT',
      response ?? null,
      state === 'ADOPTED' ? adopter : null,
      state === 'ADOPTED' ? `${seed.adoptedOn}T02:00:00Z` : null,
      state === 'ADOPTED' ? evaluation : null,
    ],
  );
  return proposal;
}

describe('the risk grade and the performance of a contractor (VND-2, slice gamma)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    for (const member of [M1, M2, M3, M4]) await harness.seedMembership(TENANT_A, member, 1);
    await admin([[`insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, 'PRJ-VND2C', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`, [TENANT_A, PROJECT, unitId(1), randomUUID()]]]);
    await admin([[`insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by)
       values ($1, $2, $3, 'GT-VND2C', 900000000, 'OPEN_BIDDING', 1, 'APPROVED', 'Package', $4)`, [TENANT_A, PACKAGE, PROJECT, memberId(M1)]]]);
    for (const year of [2026, 2027]) {
      await as(async (tx) => {
        const draft = await calendars.createDraft(tx, { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code' }, memberId(M1));
        const locked = await calendars.lockDraft(tx, draft.id, draft.version);
        await calendars.publish(tx, locked, memberId(M1));
      });
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the risk grade', () => {
    it('grades a bare contractor on its profile gap, keeps one proposal waiting and confirms without a second person when the grade needs none', async () => {
      const id = await contractor('Cty Risk Bare');
      const live = await as((tx) => quietRisk.liveProposal(tx, id, TODAY));
      expect(live.inputs).toMatchObject({ profileCoveragePct: 0, restrictionsInForce: 0, poorRatingsConsecutive: 0, financeStatus: null, loadStatus: null, openStrongFindings: 0 });
      expect(live.grade).toMatchObject({ score: 10, tier: 'LOW' });
      const proposed = await as((tx) => quietRisk.assess(tx, id, TODAY, memberId(M1)));
      expect(proposed).toMatchObject({ state: 'PROPOSED', tier: 'LOW', score: 10, dualCheck: false, reviewMonths: 24, nextReviewOn: '2028-11-09', ruleVersion: 'builtin', ruleUnverified: true, version: 1 });
      expect(proposed.factors).toHaveLength(11);
      expect(proposed.reasons).toEqual(['PROFILE_GAP']);
      expect(await refusal(as((tx) => quietRisk.assess(tx, id, TODAY, memberId(M1))))).toMatchObject({ code: 'RISK_ASSESSMENT_STATE_INVALID', status: 409 });
      expect((await refusal(as((tx) => quietRisk.decide(tx, proposed.id, 2, 'CONFIRM', undefined, memberId(M1), TODAY)))).code).toBe('VERSION_CONFLICT');
      const confirmed = await as((tx) => quietRisk.decide(tx, proposed.id, 1, 'CONFIRM', undefined, memberId(M1), TODAY));
      expect(confirmed).toMatchObject({ state: 'CONFIRMED', decidedBy: memberId(M1), version: 2 });
      const [contractorRow] = await owner<{ risk_tier: string; risk_next_review_on: string; risk_assessment_id: string }>('select risk_tier, risk_next_review_on::text, risk_assessment_id from machvon.contractor where id = $1', [id]);
      expect(contractorRow).toMatchObject({ risk_tier: 'LOW', risk_next_review_on: '2028-11-09', risk_assessment_id: proposed.id });
      expect(await as((tx) => quietRisk.riskTierOf(tx, id))).toBe('LOW');
      expect((await refusal(as((tx) => quietRisk.decide(tx, proposed.id, 2, 'CONFIRM', undefined, memberId(M2), TODAY)))).code).toBe('STAGE_TRANSITION_DENIED');
    });

    it('keeps the floor of a restriction in force, needs a second person for a high grade and supersedes the grade that stood', async () => {
      const id = await contractor('Cty Risk Restricted');
      const first = await as((tx) => quietRisk.assess(tx, id, TODAY, memberId(M1)));
      await as((tx) => quietRisk.decide(tx, first.id, 1, 'CONFIRM', undefined, memberId(M1), TODAY));
      await owner(
        `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, effective_until, decision_document_id, created_by, updated_by)
         values ($1, $2, $3, 'DEBARMENT', 'DECISION', date '2026-01-01', date '2028-01-01', (select profile_document_id from machvon.contractor where id = $3), $4, $4)`,
        [TENANT_A, randomUUID(), id, memberId(M1)],
      );
      const second = await as((tx) => quietRisk.assess(tx, id, TODAY, memberId(M1)));
      expect(second).toMatchObject({ tier: 'HIGH', scoreTier: 'HIGH', floored: false, score: 50, dualCheck: true, reviewMonths: 6, nextReviewOn: '2027-05-09' });
      expect(second.inputs.restrictionsInForce).toBe(1);
      expect(await refusal(as((tx) => quietRisk.decide(tx, second.id, 1, 'CONFIRM', undefined, memberId(M1), TODAY)))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await databaseRefusal(owner("update machvon.vendor_risk_assessment set state = 'CONFIRMED', decided_by = assessed_by, decided_at = now(), version = version + 1 where id = $1", [second.id]))).toMatch(/vendor_risk_dual_chk/);
      const decided = await as((tx) => quietRisk.decide(tx, second.id, 1, 'CONFIRM', undefined, memberId(M2), TODAY), M2);
      expect(decided).toMatchObject({ state: 'CONFIRMED', decidedBy: memberId(M2) });
      const history = await as((tx) => quietRisk.history(tx, id));
      expect(history.map((one) => [one.id === second.id ? 'new' : 'old', one.state, one.supersededById === second.id])).toEqual([['new', 'CONFIRMED', false], ['old', 'SUPERSEDED', true]]);
      expect(await as((tx) => quietRisk.riskTierOf(tx, id))).toBe('HIGH');
      const { confirmed, pending } = await as((tx) => quietRisk.current(tx, id));
      expect([confirmed?.id, pending]).toEqual([second.id, undefined]);
      // The facts of a snapshot never change and it is never deleted.
      expect(await databaseRefusal(owner('update machvon.vendor_risk_assessment set score = 1, version = version + 1 where id = $1', [second.id]))).toMatch(/keeps its figures/);
      expect(await databaseRefusal(owner('delete from machvon.vendor_risk_assessment where id = $1', [second.id]))).toMatch(/never deleted/);
    });

    it('rejects with a reason of 20 characters and leaves the contractor as it was', async () => {
      const id = await contractor('Cty Risk Rejected');
      const proposed = await as((tx) => quietRisk.assess(tx, id, TODAY, memberId(M1)));
      expect(await refusal(as((tx) => quietRisk.decide(tx, proposed.id, 1, 'REJECT', 'short', memberId(M2), TODAY), M2))).toMatchObject({ code: 'REASON_REQUIRED' });
      const rejected = await as((tx) => quietRisk.decide(tx, proposed.id, 1, 'REJECT', 'the licence data were taken from the wrong year', memberId(M2), TODAY), M2);
      expect(rejected).toMatchObject({ state: 'REJECTED', decisionReason: 'the licence data were taken from the wrong year' });
      expect(await as((tx) => quietRisk.riskTierOf(tx, id))).toBeNull();
      // A rejected snapshot frees the place: a new one can be assessed.
      expect((await as((tx) => quietRisk.assess(tx, id, TODAY, memberId(M1)))).state).toBe('PROPOSED');
      expect((await refusal(as((tx) => quietRisk.decide(tx, randomUUID(), 1, 'CONFIRM', undefined, memberId(M2), TODAY), M2))).code).toBe('RESOURCE_NOT_FOUND');
      expect((await refusal(as((tx) => quietRisk.assess(tx, randomUUID(), TODAY, memberId(M1))))).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('reads a posted event, a lapsed certificate, poor ratings and the readings the other controls provide', async () => {
      const id = await contractor('Cty Risk Inputs');
      const event = await as((tx) => reputation.record(tx, { contractorId: id, behaviourCode: 'NO_BID_SECURITY', eventOn: '2026-11-06', description: 'The contractor did not pay the bid security before the opening' }, memberId(M1), NOW));
      await as((tx) => reputation.post(tx, event.id, 1, 'MSC-2026-0099', memberId(M2), NOW), M2);
      const doc = (await owner<{ profile_document_id: string }>('select profile_document_id from machvon.contractor where id = $1', [id]))[0]?.profile_document_id as string;
      await as((tx) => qualifications.addQualification(tx, id, { kind: 'CONSTRUCTION_ACTIVITY', certificateNo: 'CC-OLD', grade: 'II', issuer: 'Ministry of Construction', issuedOn: '2020-01-01', expiresOn: '2026-01-31', documentId: doc }, memberId(M1)));
      await rated({ contractorId: id, code: 'HD-R1', rating: 'POOR', endedOn: '2025-12-31', adoptedOn: '2026-01-15' });
      await rated({ contractorId: id, code: 'HD-R2', rating: 'POOR', endedOn: '2026-05-31', adoptedOn: '2026-06-15' });
      const live = await as((tx) => risk.liveProposal(tx, id, TODAY));
      expect(live.inputs).toMatchObject({ reputationEventsPosted: 1, qualificationsLapsed: 1, poorRatingsConsecutive: 2, financeStatus: 'BELOW', loadStatus: 'OVER', openStrongFindings: 1, payeeAlerts: 0 });
      const points = Object.fromEntries(live.grade.factors.map((one) => [one.factor, one.points]));
      expect(points).toMatchObject({ REPUTATION_EVENTS: 5, QUALIFICATION_LAPSE: 3, POOR_PERFORMANCE: 13, FINANCE_BELOW: 10, LOAD_OVER: 5, OPEN_FINDINGS: 5, PROFILE_GAP: 10 });
      expect(live.grade.score).toBe(51);
      expect(live.grade.tier).toBe('HIGH');
      expect(live.grade.reasons[0]).toBe('POOR_PERFORMANCE');
    });

    it('lists the register by tier, pending proposal and review day, and counts the figures', async () => {
      const due = await contractor('Cty Register Due');
      const waiting = await contractor('Cty Register Waiting');
      const proposed = await as((tx) => quietRisk.assess(tx, due, '2025-01-01', memberId(M1)));
      await as((tx) => quietRisk.decide(tx, proposed.id, 1, 'CONFIRM', undefined, memberId(M1), '2025-01-01'));
      await owner("update machvon.contractor set risk_next_review_on = date '2026-10-01' where id = $1", [due]);
      await as((tx) => quietRisk.assess(tx, waiting, TODAY, memberId(M1)));
      const all = await as((tx) => quietRisk.register(tx, { limit: 200 }, TODAY));
      const byName = Object.fromEntries(all.map((row) => [row.name, row]));
      expect(byName['Cty Register Due']).toMatchObject({ tier: 'LOW', score: 10, reviewOverdue: true, pendingAssessmentId: null });
      expect(byName['Cty Register Waiting']).toMatchObject({ tier: null, pendingTier: 'LOW', reviewOverdue: false });
      expect((await as((tx) => quietRisk.register(tx, { limit: 200, reviewDue: true }, TODAY))).map((row) => row.name)).toContain('Cty Register Due');
      expect((await as((tx) => quietRisk.register(tx, { limit: 200, reviewDue: true }, TODAY))).map((row) => row.name)).not.toContain('Cty Register Waiting');
      expect((await as((tx) => quietRisk.register(tx, { limit: 200, pending: true }, TODAY))).map((row) => row.name)).toContain('Cty Register Waiting');
      expect((await as((tx) => quietRisk.register(tx, { limit: 200, tier: 'LOW', q: 'Register Due' }, TODAY))).map((row) => row.name)).toEqual(['Cty Register Due']);
      expect((await as((tx) => quietRisk.waiting(tx))).map((row) => row.contractorName)).toContain('Cty Register Waiting');
      const figures = await as((tx) => quietRisk.figures(tx, TODAY));
      const inTime = figures.find((one) => one.code === 'VENDOR_RISK_REVIEW_IN_TIME');
      expect(inTime?.denominator).toBeGreaterThanOrEqual(3);
      expect(inTime?.numerator).toBeLessThan(inTime?.denominator ?? 0);
    });

    it('does not show the snapshots to another tenant', async () => {
      const id = await contractor('Cty Risk Tenant');
      await as((tx) => quietRisk.assess(tx, id, TODAY, memberId(M1)));
      const foreign = await harness.tenants.withTenant(contextFor(TENANT_B, memberId(M1)), (tx) => quietRisk.history(tx, id));
      expect(foreign).toEqual([]);
      expect((await refusal(harness.tenants.withTenant(contextFor(TENANT_B, memberId(M1)), (tx) => quietRisk.assess(tx, id, TODAY, memberId(M1))))).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('the performance and its publication', () => {
    it('counts the six months from the end of the contract, records the posting by another person once, and supersedes it with an update', async () => {
      const id = await contractor('Cty Perf Publish');
      const proposal = await rated({ contractorId: id, code: 'HD-P1', rating: 'GOOD', endedOn: '2026-03-31', adoptedOn: '2026-04-20', adoptedBy: M2 });
      const before = await as((tx) => performance.history(tx, id, TODAY));
      expect(before.lines).toHaveLength(1);
      expect(before.lines[0]).toMatchObject({ proposalId: proposal, rating: 'GOOD', endedOn: '2026-03-31', publicationDueOn: '2026-09-30', publicationClock: 'OVERDUE', publication: null, responseReview: 'NOT_ANSWERED', construction: true });
      expect(before.policy).toMatchObject({ version: 'builtin', unverified: true });
      expect(before.streak).toBe(0);
      expect(await refusal(as((tx) => performance.post(tx, proposal, { kind: 'INITIAL', receipt: 'MSC-0001' }, memberId(M2), TODAY), M2))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await databaseRefusal(owner(`insert into machvon.vendor_performance_publication (tenant_id, id, rating_proposal_id, contractor_id, contract_id, kind, receipt, posted_by, posted_on, due_on, clock, rule_version, created_by)
        select tenant_id, gen_random_uuid(), id, contractor_id, contract_id, 'INITIAL', 'MSC-9999', adopted_by, date '2026-11-09', date '2026-09-30', 'MET_LATE', 'builtin', adopted_by from machvon.contract_rating_proposal where id = $1`, [proposal]))).toMatch(/does not post it/);
      expect(await refusal(as((tx) => performance.post(tx, proposal, { kind: 'INITIAL', receipt: 'x' }, memberId(M3), TODAY), M3))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'receipt' });
      expect(await refusal(as((tx) => performance.post(tx, proposal, { kind: 'UPDATE_AFTER_WARRANTY', receipt: 'MSC-0002' }, memberId(M3), TODAY), M3))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      const posted = await as((tx) => performance.post(tx, proposal, { kind: 'INITIAL', receipt: 'MSC-0001' }, memberId(M3), TODAY), M3);
      expect(posted.publication).toMatchObject({ kind: 'INITIAL', receipt: 'MSC-0001', postedOn: TODAY, clock: 'MET_LATE' });
      expect(posted.publicationClock).toBe('MET_LATE');
      expect(await refusal(as((tx) => performance.post(tx, proposal, { kind: 'INITIAL', receipt: 'MSC-0003' }, memberId(M3), TODAY), M3))).toMatchObject({ code: 'PERFORMANCE_PUBLICATION_DUPLICATE', status: 409 });
      const updated = await as((tx) => performance.post(tx, proposal, { kind: 'UPDATE_AFTER_WARRANTY', receipt: 'MSC-0004' }, memberId(M3), '2026-11-10'), M3);
      expect(updated.updates.map((one) => [one.kind, one.receipt])).toEqual([['UPDATE_AFTER_WARRANTY', 'MSC-0004']]);
      const [link] = await owner<{ supersedes_id: string; initial_id: string }>(
        "select u.supersedes_id, i.id as initial_id from machvon.vendor_performance_publication u join machvon.vendor_performance_publication i on i.rating_proposal_id = u.rating_proposal_id and i.kind = 'INITIAL' where u.kind = 'UPDATE_AFTER_WARRANTY' and u.rating_proposal_id = $1",
        [proposal],
      );
      expect(link?.supersedes_id).toBe(link?.initial_id);
      expect(await databaseRefusal(owner("update machvon.vendor_performance_publication set receipt = 'CHANGED-1' where rating_proposal_id = $1", [proposal]))).toMatch(/appended/);
      expect(await databaseRefusal(owner('delete from machvon.vendor_performance_publication where rating_proposal_id = $1', [proposal]))).toMatch(/appended|permission denied|never/);
    });

    it('refuses a rating that is not adopted and one that does not exist', async () => {
      const id = await contractor('Cty Perf Open');
      const open = await rated({ contractorId: id, code: 'HD-P2', rating: 'FAIR', endedOn: '2026-06-30', adoptedOn: '2026-07-10', state: 'NOTIFIED' });
      expect(await refusal(as((tx) => performance.post(tx, open, { kind: 'INITIAL', receipt: 'MSC-0010' }, memberId(M3), TODAY), M3))).toMatchObject({ code: 'RATING_NOT_ADOPTED', status: 409 });
      expect((await refusal(as((tx) => performance.post(tx, randomUUID(), { kind: 'INITIAL', receipt: 'MSC-0011' }, memberId(M3), TODAY), M3))).code).toBe('RESOURCE_NOT_FOUND');
      expect((await refusal(as((tx) => performance.history(tx, randomUUID(), TODAY)))).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('runs the review clock of an answer: within, near the end, past it, and closed once adopted', async () => {
      const id = await contractor('Cty Perf Response');
      const answered = (offset: number): string => new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
      await rated({ contractorId: id, code: 'HD-R10', rating: 'FAIR', endedOn: '2026-06-30', adoptedOn: '2026-07-10', state: 'RESPONDED', respondedOn: answered(3) });
      await rated({ contractorId: id, code: 'HD-R11', rating: 'FAIR', endedOn: '2026-06-30', adoptedOn: '2026-07-10', state: 'RESPONDED', respondedOn: answered(17) });
      await rated({ contractorId: id, code: 'HD-R12', rating: 'FAIR', endedOn: '2026-06-30', adoptedOn: '2026-07-10', state: 'RESPONDED', respondedOn: answered(25) });
      await rated({ contractorId: id, code: 'HD-R13', rating: 'GOOD', endedOn: '2026-06-30', adoptedOn: answered(5), state: 'ADOPTED', respondedOn: answered(30) });
      const history = await as((tx) => performance.history(tx, id, TODAY));
      const clocks = Object.fromEntries(history.lines.map((line) => [line.contractCode, line.responseReview]));
      expect(clocks).toEqual({ 'HD-R10': 'WITHIN_REVIEW', 'HD-R11': 'DUE_SOON', 'HD-R12': 'OVERDUE', 'HD-R13': 'CLOSED' });
      const figures = await as((tx) => performance.figures(tx, TODAY));
      const reviewed = figures.find((one) => one.code === 'VENDOR_RESPONSE_REVIEWED_IN_TIME');
      expect(reviewed?.denominator).toBeGreaterThanOrEqual(2);
    });

    it('counts the streak of poor ratings and suggests a plan, then a case, without acting', async () => {
      const id = await contractor('Cty Perf Streak');
      await rated({ contractorId: id, code: 'HD-S1', rating: 'GOOD', endedOn: '2025-01-31', adoptedOn: '2025-02-15' });
      await rated({ contractorId: id, code: 'HD-S2', rating: 'POOR', endedOn: '2026-01-31', adoptedOn: '2026-02-15' });
      expect(await as((tx) => performance.history(tx, id, TODAY))).toMatchObject({ streak: 1, suggestion: 'NONE' });
      await rated({ contractorId: id, code: 'HD-S3', rating: 'POOR', endedOn: '2026-05-31', adoptedOn: '2026-06-15' });
      expect(await as((tx) => performance.history(tx, id, TODAY))).toMatchObject({ streak: 2, suggestion: 'REMEDY_PLAN' });
      await rated({ contractorId: id, code: 'HD-S4', rating: 'POOR', endedOn: '2026-08-31', adoptedOn: '2026-09-15' });
      const history = await as((tx) => performance.history(tx, id, TODAY));
      expect(history).toMatchObject({ streak: 3, suggestion: 'PROPOSE_RESTRICTION' });
      expect(history.retrospectProposalIds).toHaveLength(4);
      expect(await as((tx) => performance.streakOf(tx, id, TODAY))).toBe(3);
    });

    it('lists the worklist by state and counts the figure of the publications', async () => {
      const id = await contractor('Cty Perf Worklist');
      const overdue = await rated({ contractorId: id, code: 'HD-W1', rating: 'GOOD', endedOn: '2026-03-31', adoptedOn: '2026-04-01' });
      const soon = await rated({ contractorId: id, code: 'HD-W2', rating: 'GOOD', endedOn: '2026-05-20', adoptedOn: '2026-05-25' });
      const calm = await rated({ contractorId: id, code: 'HD-W3', rating: 'GOOD', endedOn: '2026-10-20', adoptedOn: '2026-10-25' });
      const done = await rated({ contractorId: id, code: 'HD-W4', rating: 'GOOD', endedOn: '2026-10-01', adoptedOn: '2026-10-05' });
      await as((tx) => performance.post(tx, done, { kind: 'INITIAL', receipt: 'MSC-0020' }, memberId(M3), TODAY), M3);
      const ids = async (state: 'DUE' | 'OVERDUE' | 'POSTED' | 'ALL'): Promise<string[]> => (await as((tx) => performance.worklist(tx, { state, contractorId: id }, TODAY))).lines.map((line) => line.proposalId).sort();
      expect(await ids('OVERDUE')).toEqual([overdue]);
      expect(await ids('DUE')).toEqual([soon, calm].sort());
      expect(await ids('POSTED')).toEqual([done]);
      expect(await ids('ALL')).toEqual([overdue, soon, calm, done].sort());
      const figure = (await as((tx) => performance.figures(tx, TODAY))).find((one) => one.code === 'VENDOR_PERFORMANCE_PUBLISHED_IN_TIME');
      expect(figure?.numerator).toBeGreaterThanOrEqual(1);
      expect(figure?.denominator).toBeGreaterThanOrEqual(3);
      const foreign = await harness.tenants.withTenant(contextFor(TENANT_B, memberId(M1)), (tx) => performance.worklist(tx, { state: 'ALL' }, TODAY));
      expect(foreign.lines).toEqual([]);
    });
  });

  describe('the alerts of the alert centre', () => {
    const everything = () => ({ sql: 'true', params: [] as unknown[] });
    const collect = async (holds: boolean) =>
      (await as((tx) => work.collect(tx, { membershipId: memberId(M1), now: NOW, today: TODAY, view: 'mine', unitScope: everything, projectScope: everything, mode: 'count', holds: () => holds }))).rows.filter((row) => row.source === 'VENDOR');

    it('reads the publication, the answer to review, the streak and the grade as alerts of their owners, each with its facet', async () => {
      const id = await contractor('Cty Alert Gamma');
      await rated({ contractorId: id, code: 'HD-A1', rating: 'POOR', endedOn: '2026-01-31', adoptedOn: '2026-02-15' });
      await rated({ contractorId: id, code: 'HD-A2', rating: 'POOR', endedOn: '2026-02-28', adoptedOn: '2026-03-15', adoptedBy: M3 });
      await rated({ contractorId: id, code: 'HD-A3', rating: 'FAIR', endedOn: '2026-06-30', adoptedOn: '2026-07-10', state: 'RESPONDED', respondedOn: '2026-10-10' });
      const waiting = await as((tx) => quietRisk.assess(tx, id, TODAY, memberId(M1)));
      const mine = (await collect(true)).filter((row) => row.title.includes('Cty Alert Gamma') || row.id === waiting.id);
      const byKind = (kind: string) => mine.filter((row) => row.kind === kind);
      expect(byKind('VENDOR_PERFORMANCE_PUBLISH').map((row) => [row.severity, row.status, row.dueOn, row.target.screen]).sort()).toEqual([
        ['URGENT', 'OVERDUE', '2026-07-31', 'VND-12'],
        ['URGENT', 'OVERDUE', '2026-08-28', 'VND-12'],
      ]);
      expect(byKind('VENDOR_PERFORMANCE_RESPONSE').map((row) => [row.severity, row.status])).toEqual([['URGENT', 'OVERDUE']]);
      expect(byKind('VENDOR_POOR_STREAK').map((row) => [row.severity, row.status, row.target])).toEqual([['WATCH', 'REMEDY_PLAN', { screen: 'VND-12', id }]]);
      expect(byKind('VENDOR_RISK_REVIEW').map((row) => [row.severity, row.status, row.target])).toEqual([['ACTION', 'PENDING', { screen: 'VND-11', id }]]);
      for (const row of mine) expect(row.consequence?.length ?? 0).toBeGreaterThan(20);
      // A reader who holds none of the permissions of the owners sees none of them.
      expect((await collect(false)).filter((row) => row.title.includes('Cty Alert Gamma'))).toEqual([]);
      // A grade in force past its review day is an alert once the waiting one is decided.
      await as((tx) => quietRisk.decide(tx, waiting.id, 1, 'CONFIRM', undefined, memberId(M1), '2024-01-01'));
      const overdue = (await collect(true)).filter((row) => row.kind === 'VENDOR_RISK_REVIEW' && row.title.includes('Cty Alert Gamma'));
      expect(overdue.map((row) => [row.severity, row.status, row.dueOn])).toEqual([['ACTION', 'OVERDUE', '2025-01-01']]);
    });
  });

  it('keeps the profile store of VND-1 usable beside the grade (a profile with every field lifts the coverage)', async () => {
    const id = await contractor('Cty Risk Full Profile');
    await as((tx) => profiles.update(tx, id, 1, { legalRepName: 'Nguyen Van A', registeredAddress: '12 Le Loi, Quan 1', phone: '0912345678', email: 'a@firm.vn', businessRegistrationNo: '0101234567' }, memberId(M1), TODAY, 12));
    await as((tx) => profiles.declareNoOwnerAboveThreshold(tx, id, 2, memberId(M1)));
    const live = await as((tx) => quietRisk.liveProposal(tx, id, TODAY));
    expect(live.inputs.profileCoveragePct).toBe(100);
    expect(live.grade.score).toBe(0);
  });
});
