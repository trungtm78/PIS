import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { MasterRules } from '../src/master-rules';
import { PrjAppraisalStore } from '../src/prj-appraisal-store';
import type { DecideRequest, RecordRequest, ScoreInput } from '../src/prj-appraisal-store';
import { PrjProjectStore } from '../src/prj-project-store';
import type { ProjectStatus } from '../src/prj-project-store';
import { PrjStageStore } from '../src/prj-stage-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const appraisals = new PrjAppraisalStore();
const stages = new PrjStageStore();
const TODAY = vietnamDateOf(new Date());
const PROPOSER = 1;
const APPRAISER = 2;
const SECOND_APPRAISER = 3;
const DECIDER = 4;
const THIRD_APPRAISER = 5;
const DEPARTMENT = 2;
const PROVINCE = 1;
const OTHER_BRANCH = 3;
const UNIX_DAY = 24 * 60 * 60 * 1000;

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const reachable = { act: everything, read: everything };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = PROPOSER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const sqlState = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
};

interface CriteriaSet {
  versionId: string;
  codes: string[];
}

let counter = 0;
let areaVersion = '';
let weighted: CriteriaSet;

async function seedCriteria(weights: readonly number[], options: { validFrom?: string; validUntil?: string | null; threshold?: number } = {}): Promise<CriteriaSet> {
  counter += 1;
  const recordId = randomUUID();
  const versionId = randomUUID();
  const codes = weights.map((_, index) => `C${index + 1}`);
  const attributes = { owner_module: 'PRJ', criteria: weights.map((weight, index) => ({ code: codes[index], name: `Criterion ${index + 1}`, max_score: weight })), pass_threshold: options.threshold ?? 60 };
  await harness.owner(TENANT_A, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'APPRAISAL_CRITERIA', $3, 'EFFECTIVE', $4, $4)`, [TENANT_A, recordId, `TEST-CRIT-${counter}`, memberId(PROPOSER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'APPRAISAL_CRITERIA', $3, 1, 'Test criteria', $4::jsonb, $5::date, $6::date, 'EFFECTIVE', $7, now(), $8, $8)`,
      [TENANT_A, versionId, `TEST-CRIT-${counter}`, JSON.stringify(attributes), options.validFrom ?? '2020-01-01', options.validUntil ?? null, recordId, memberId(PROPOSER)],
    ],
  ]);
  return { versionId, codes };
}

async function seedArea(tenant: string): Promise<string> {
  const recordId = randomUUID();
  const versionId = randomUUID();
  await harness.owner(tenant, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', $3, 'EFFECTIVE', $4, $4)`, [tenant, recordId, `AREA-${tenant.slice(-1)}`, memberId(PROPOSER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', $3, 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $4, now(), $5, $5)`,
      [tenant, versionId, `AREA-${tenant.slice(-1)}`, recordId, memberId(PROPOSER)],
    ],
  ]);
  return versionId;
}

async function document(status = 'EFFECTIVE', tenant = TENANT_A): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
    [tenant, id, `QD-${id.slice(0, 8)}/2026`, status, memberId(PROPOSER)],
    tenant,
  );
  return id;
}

interface Seeded {
  id: string;
  version: number;
}

/** A project of the register created by the proposer; `status` moves it straight there the way the owner of the database would. */
async function project(status: ProjectStatus = 'CONCEPT', options: { unit?: number; investment?: string; tenant?: string } = {}): Promise<Seeded> {
  counter += 1;
  const tenant = options.tenant ?? TENANT_A;
  const created = await as(
    (tx) =>
      projects.create(
        tx,
        { code: `AP-${counter}-${randomUUID().slice(0, 6)}`, name: `Appraised project ${counter}`, ownerUnitId: unitId(options.unit ?? DEPARTMENT), areaMasterVersionId: tenant === TENANT_A ? areaVersion : areaVersionB, totalInvestmentVnd: options.investment ?? '500000000000' },
        memberId(PROPOSER),
        TODAY,
      ),
    PROPOSER,
    tenant,
  );
  if (status !== 'CONCEPT') await owner('update machvon.project set status = $2, project_group = $3 where id = $1::uuid', [created.id, status, ['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED'].includes(status) ? null : 'B'], tenant);
  return { id: created.id, version: 1 };
}
let areaVersionB = '';

const projectRow = async (projectId: string) => (await owner<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [projectId]))[0] as Record<string, unknown>;
const sheetRows = (projectId: string) =>
  owner<Record<string, unknown>>('select * from machvon.project_appraisal where project_id = $1::uuid order by round, created_at, id', [projectId]);
const history = (projectId: string) =>
  owner<Record<string, unknown>>('select project_version::text as project_version, from_stage, to_stage, operation, actor_kind, actor_id, decision_document_id, reason from machvon.project_stage_change where project_id = $1::uuid order by project_version', [projectId]);

const scoresOf = (set: CriteriaSet, values: readonly number[]): ScoreInput[] => set.codes.map((code, index) => ({ criterionCode: code, score: values[index] as number }));

const submit = async (target: Seeded, overrides: { document?: string | null; reason?: string; version?: number; member?: number; act?: ScopeBuilder; read?: ScopeBuilder; extra?: Record<string, string> } = {}) =>
  as(
    async (tx) =>
      appraisals.submit(tx, {
        projectId: target.id,
        expectedVersion: overrides.version ?? target.version,
        actor: memberId(overrides.member ?? PROPOSER),
        scopes: { act: overrides.act ?? everything, read: overrides.read ?? everything },
        input: {
          reason: overrides.reason ?? 'Sent to appraisal with its proposal',
          ...(overrides.document === null ? {} : { policyProposalDocumentId: overrides.document ?? (await document()) }),
          ...(overrides.extra ?? {}),
        },
      }),
    overrides.member ?? PROPOSER,
  );

const record = (target: Seeded, set: CriteriaSet, values: readonly number[], options: Partial<RecordRequest> & { member?: number; recommendation?: string } = {}) =>
  as(
    (tx) =>
      appraisals.record(tx, {
        projectId: target.id,
        actor: memberId(options.member ?? APPRAISER),
        scopes: options.scopes ?? reachable,
        criteriaSetVersionId: options.criteriaSetVersionId ?? set.versionId,
        scores: options.scores ?? scoresOf(set, values),
        recommendation: options.recommendation ?? 'ADMIT',
        note: options.note,
        expectedSheetVersion: options.expectedSheetVersion,
        today: options.today ?? TODAY,
      }),
    options.member ?? APPRAISER,
  );

const decide = (sheetId: string, version: number, options: Partial<DecideRequest> & { member?: number } = {}) =>
  as(
    (tx) =>
      appraisals.decide(tx, {
        appraisalId: sheetId,
        expectedVersion: version,
        actor: memberId(options.member ?? DECIDER),
        scopes: options.scopes ?? reachable,
        decision: options.decision ?? 'ADMIT',
        reason: options.reason ?? 'Decided after the appraisal',
        decisionDocumentId: options.decisionDocumentId,
        projectGroup: options.projectGroup,
        overrideReason: options.overrideReason,
        today: TODAY,
      }),
    options.member ?? DECIDER,
  );

/** A project in APPRAISAL through the command, with the sheets of the appraisers. */
async function appraised(values: readonly number[][], recommendation = 'ADMIT'): Promise<{ target: Seeded; sheets: Array<{ id: string; version: number }> }> {
  const concept = await project();
  const sent = await submit(concept);
  const target = { id: concept.id, version: sent.version };
  const sheets: Array<{ id: string; version: number }> = [];
  for (const [index, scores] of values.entries()) {
    const sheet = await record(target, weighted, scores, { member: [APPRAISER, SECOND_APPRAISER, THIRD_APPRAISER][index] as number, recommendation });
    sheets.push({ id: sheet.id, version: sheet.version });
  }
  return { target, sheets };
}

jest.setTimeout(180_000);

describe('PrjAppraisalStore (appraisal scoring and admission to the project bank, ST-PRJ-003)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      for (const member of [PROPOSER, APPRAISER, SECOND_APPRAISER, DECIDER, THIRD_APPRAISER]) await harness.seedMembership(tenant, member, PROVINCE);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: '00000000-0000-4000-8000-000000000000', scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, '00000000-0000-4000-8000-000000000000', TODAY));
    }
    areaVersion = await seedArea(TENANT_A);
    areaVersionB = await seedArea(TENANT_B);
    weighted = await seedCriteria([30, 25, 20, 15, 10]);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the score of a sheet (BR-PRJ-03)', () => {
    it('AC-ST-PRJ-003-1: scores 4,3,5,2,4 against weights 30/25/20/15/10 are stored as 73.00 by the server', async () => {
      const target = await project('APPRAISAL');
      const sheet = await record(target, weighted, [4, 3, 5, 2, 4], { note: '  Solid case  ' });
      expect(sheet).toMatchObject({ totalScore: '73.00', round: 1, version: 1, replaced: false, meanScore: '73.00', sheetCount: 1, passThreshold: '60', thresholdRecommendation: 'ADMIT', scoreCount: 5, hasNote: true });
      const [row] = await sheetRows(target.id);
      expect(row).toMatchObject({ total_score: '73.00', status: 'SUBMITTED', recommendation: 'ADMIT', note: 'Solid case', criteria_set_version_id: weighted.versionId, appraiser_membership_id: memberId(APPRAISER) });
      expect(row?.scores_json).toEqual(weighted.codes.map((code, index) => ({ criterion_code: code, score: [4, 3, 5, 2, 4][index] })));
    });

    it('AC-ST-PRJ-003-1: weights that do not add up to 100 are CRITERIA_WEIGHT_INVALID and nothing is stored', async () => {
      const broken = await seedCriteria([30, 25, 20, 15, 9]);
      const target = await project('APPRAISAL');
      expect(await refusal(record(target, broken, [4, 3, 5, 2, 4]))).toMatchObject({ code: 'CRITERIA_WEIGHT_INVALID', status: 422 });
      expect(await sheetRows(target.id)).toEqual([]);
    });

    it('AC-ST-PRJ-003-1: a score outside 0..5 is SCORE_OUT_OF_RANGE, a missing or unknown criterion is VALIDATION_FAILED on scores', async () => {
      const target = await project('APPRAISAL');
      expect(await refusal(record(target, weighted, [4, 3, 6, 2, 4]))).toMatchObject({ code: 'SCORE_OUT_OF_RANGE', status: 422 });
      expect(await refusal(record(target, weighted, [4, 3, -1, 2, 4]))).toMatchObject({ code: 'SCORE_OUT_OF_RANGE', status: 422 });
      expect(await refusal(record(target, weighted, [], { scores: scoresOf(weighted, [4, 3, 5, 2, 4]).slice(1) }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'scores' });
      expect(await refusal(record(target, weighted, [], { scores: [...scoresOf(weighted, [4, 3, 5, 2, 4]).slice(1), { criterionCode: 'NOPE', score: 3 }] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'scores' });
      expect(await sheetRows(target.id)).toEqual([]);
    });

    it('AC-ST-PRJ-003-1: the project score is the mean of the sheets of the round, half-up to two digits', async () => {
      const target = await project('APPRAISAL');
      await record(target, weighted, [4, 3, 5, 2, 4]);
      const second = await record(target, weighted, [4, 3, 4, 2, 4], { member: SECOND_APPRAISER });
      // (4 x 30 + 3 x 25 + 4 x 20 + 2 x 15 + 4 x 10) / 5 = 69.00 ; the mean of 73.00 and 69.00
      expect(second).toMatchObject({ totalScore: '69.00', meanScore: '71.00', sheetCount: 2 });
    });

    it('AC-ST-PRJ-003-1: a set that is not in force, one that does not exist and one that is not a criteria set are refused by name', async () => {
      const target = await project('APPRAISAL');
      const future = await seedCriteria([30, 25, 20, 15, 10], { validFrom: vietnamDateOf(new Date(Date.now() + 30 * UNIX_DAY)) });
      const past = await seedCriteria([30, 25, 20, 15, 10], { validFrom: '2019-01-01', validUntil: '2020-01-01' });
      for (const set of [future, past]) expect(await refusal(record(target, set, [4, 3, 5, 2, 4]))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'criteria_set_version_id' });
      expect(await refusal(record(target, weighted, [4, 3, 5, 2, 4], { criteriaSetVersionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'criteria_set_version_id' });
      expect(await refusal(record(target, weighted, [4, 3, 5, 2, 4], { criteriaSetVersionId: 'not-an-id' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'criteria_set_version_id' });
      const [calendar] = await owner<{ id: string }>(`select v.id from machvon.master_record_version v where v.master_type = 'CALENDAR' limit 1`);
      expect(await refusal(record(target, weighted, [4, 3, 5, 2, 4], { criteriaSetVersionId: (calendar as { id: string }).id }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'criteria_set_version_id' });
      expect(await sheetRows(target.id)).toEqual([]);
    });

    it('AC-ST-PRJ-003-1: appraisers of one round score against the same set, or their mean would mean nothing', async () => {
      const target = await project('APPRAISAL');
      const other = await seedCriteria([20, 20, 20, 20, 20]);
      await record(target, weighted, [4, 3, 5, 2, 4]);
      expect(await refusal(record(target, other, [4, 3, 5, 2, 4], { member: SECOND_APPRAISER }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'criteria_set_version_id' });
    });

    it('AC-ST-PRJ-003-1: the recommendation, the note and the evidence are checked: a recommendation that does not exist, a long note, a document of another tenant', async () => {
      const target = await project('APPRAISAL');
      expect(await refusal(record(target, weighted, [4, 3, 5, 2, 4], { recommendation: 'MAYBE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'recommendation' });
      expect(await refusal(record(target, weighted, [4, 3, 5, 2, 4], { note: 'x'.repeat(2001) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      expect(await refusal(record(target, weighted, [4, 3, 5, 2, 4], { note: 'a\u0007b' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      const foreign = await document('EFFECTIVE', TENANT_B);
      const scores = scoresOf(weighted, [4, 3, 5, 2, 4]).map((entry, index) => (index === 0 ? { ...entry, evidenceIds: [foreign] } : entry));
      expect(await refusal(record(target, weighted, [], { scores }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'scores' });
      const malformed = scoresOf(weighted, [4, 3, 5, 2, 4]).map((entry, index) => (index === 0 ? { ...entry, evidenceIds: ['nope'] } : entry));
      expect(await refusal(record(target, weighted, [], { scores: malformed }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'scores' });
      const mine = await document();
      const withEvidence = scoresOf(weighted, [4, 3, 5, 2, 4]).map((entry, index) => (index === 0 ? { ...entry, evidenceIds: [mine.toUpperCase(), mine] } : entry));
      const sheet = await record(target, weighted, [], { scores: withEvidence });
      expect(sheet.evidenceCount).toBe(1);
      const [row] = await sheetRows(target.id);
      expect((row?.scores_json as Array<{ evidence_ids?: string[] }>)[0]?.evidence_ids).toEqual([mine]);
      const nothingElse = await project('APPRAISAL');
      const blank = await record(nothingElse, weighted, [4, 3, 5, 2, 4], { note: '   ' });
      expect(blank.hasNote).toBe(false);
    });

    it('AC-ST-PRJ-003-1: the same appraiser scoring again replaces their sheet under its version, and a stale version is 409', async () => {
      const target = await project('APPRAISAL');
      const first = await record(target, weighted, [4, 3, 5, 2, 4]);
      expect(await refusal(record(target, weighted, [5, 5, 5, 5, 5], { expectedSheetVersion: 7 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const again = await record(target, weighted, [5, 5, 5, 5, 5], { expectedSheetVersion: first.version, recommendation: 'ADMIT' });
      expect(again).toMatchObject({ id: first.id, version: 2, replaced: true, previousTotalScore: '73.00', totalScore: '100.00', sheetCount: 1 });
      const withoutVersion = await record(target, weighted, [0, 0, 0, 0, 0], { recommendation: 'REJECT' });
      expect(withoutVersion).toMatchObject({ version: 3, totalScore: '0.00', thresholdRecommendation: 'REJECT' });
      expect(await sheetRows(target.id)).toHaveLength(1);
    });
  });

  describe('sending a project to appraisal (F2 step 1)', () => {
    it('AC-ST-PRJ-003-2: CONCEPT moves to APPRAISAL with the proposal as the ground of the move, and the history keeps it', async () => {
      const concept = await project();
      const proposal = await document();
      const change = await submit(concept, { document: proposal });
      expect(change).toMatchObject({ from: 'CONCEPT', to: 'APPRAISAL', version: 2, operation: 'submitProjectForAppraisal', decisionDocumentId: proposal, actorId: memberId(PROPOSER) });
      expect((await projectRow(concept.id)).status).toBe('APPRAISAL');
      expect(await history(concept.id)).toEqual([expect.objectContaining({ from_stage: 'CONCEPT', to_stage: 'APPRAISAL', operation: 'submitProjectForAppraisal', decision_document_id: proposal, reason: 'Sent to appraisal with its proposal' })]);
    });

    it('AC-ST-PRJ-003-2: no proposal is DECISION_REQUIRED, a document that does not stand is too, and a document sent to the wrong command is refused by name', async () => {
      const concept = await project();
      expect(await refusal(submit(concept, { document: null }))).toMatchObject({ code: 'DECISION_REQUIRED', status: 422, detail: 'policy_proposal_document_id' });
      expect(await refusal(submit(concept, { document: await document('RECALLED') }))).toMatchObject({ code: 'DECISION_REQUIRED', detail: 'policy_proposal_document_id' });
      expect(await refusal(submit(concept, { document: await document('EFFECTIVE', TENANT_B) }))).toMatchObject({ code: 'DECISION_REQUIRED' });
      expect(await refusal(submit(concept, { document: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'policy_proposal_document_id' });
      expect(await refusal(submit(concept, { extra: { decisionDocumentId: randomUUID() } }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      expect(await refusal(submit(concept, { extra: { investmentDecisionDocumentId: randomUUID() } }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'investment_decision_document_id' });
      expect(await refusal(submit(concept, { reason: 'no' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(submit(concept, { extra: { effectiveDate: '2026-02-30' } }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_date' });
      expect((await projectRow(concept.id)).status).toBe('CONCEPT');
      expect(await history(concept.id)).toEqual([]);
    });

    it('AC-ST-PRJ-003-2: a project with no investment is not sent, the version must be the one seen, and only a CONCEPT project is sent', async () => {
      const empty = await project('CONCEPT', { investment: '0' });
      expect(await refusal(submit(empty))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'total_investment_vnd' });
      const concept = await project();
      expect(await refusal(submit(concept, { version: 9 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      for (const stage of ['APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'CLOSED', 'REJECTED', 'CANCELLED'] as const) {
        expect(await refusal(submit(await project(stage)))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      }
    });

    it('AC-ST-PRJ-003-2: a project out of sight is 404 and one that is readable but not the caller\'s to send is 403', async () => {
      const concept = await project();
      expect(await refusal(submit(concept, { act: nothing, read: nothing }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(submit(concept, { act: nothing, read: everything }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    });
  });

  describe('the decision (F2 step 3, BR-PRJ-04, BR-PRJ-05)', () => {
    it('AC-ST-PRJ-003-2: P-A-010 is sent, scored 72.50 by two sheets and ADMITted with a document: PIPELINE, group B, two moves in the history', async () => {
      const { target, sheets } = await appraised([
        [4, 3, 5, 2, 4],
        [4, 3, 4, 3, 4],
      ]);
      const decision = await document();
      // (4 x 30 + 3 x 25 + 4 x 20 + 3 x 15 + 4 x 10) / 5 = 72.00 ; the mean of 73.00 and 72.00 is 72.50
      const decided = await decide(sheets[0]?.id as string, sheets[0]?.version as number, { decision: 'ADMIT', decisionDocumentId: decision, projectGroup: 'B' });
      expect(decided).toMatchObject({ decision: 'ADMIT', meanScore: '72.50', sheetCount: 2, againstRecommendation: false, overrideReason: null, projectGroup: 'B', decisionDocumentId: decision, round: 1, appraisalVersion: 2 });
      expect(decided.change).toMatchObject({ from: 'APPRAISAL', to: 'PIPELINE', version: 3, operation: 'decideProjectAppraisal' });
      const row = await projectRow(target.id);
      expect(row).toMatchObject({ status: 'PIPELINE', project_group: 'B', appraisal_score: '72.50', policy_decision_document_id: decision, version: '3' });
      expect((await history(target.id)).map((entry) => [entry.from_stage, entry.to_stage, entry.operation])).toEqual([
        ['CONCEPT', 'APPRAISAL', 'submitProjectForAppraisal'],
        ['APPRAISAL', 'PIPELINE', 'decideProjectAppraisal'],
      ]);
      const stored = await sheetRows(target.id);
      expect(stored.map((sheet) => [sheet.status, sheet.decision, sheet.decided_by, sheet.decided_group, sheet.decision_document_id, sheet.override_reason, sheet.version])).toEqual([
        ['DECIDED', 'ADMIT', memberId(DECIDER), 'B', decision, null, '2'],
        ['DECIDED', 'ADMIT', memberId(DECIDER), 'B', decision, null, '2'],
      ]);
    });

    it('AC-ST-PRJ-003-4: ADMIT without a group is PROJECT_GROUP_REQUIRED, with a group that does not exist VALIDATION_FAILED, with the right group it is admitted', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      const decision = await document();
      expect(await refusal(decide(sheet.id, sheet.version, { decisionDocumentId: decision }))).toMatchObject({ code: 'PROJECT_GROUP_REQUIRED', status: 422, detail: 'project_group' });
      expect(await refusal(decide(sheet.id, sheet.version, { decisionDocumentId: decision, projectGroup: 'Z' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_group' });
      expect(await refusal(decide(sheet.id, sheet.version, { decisionDocumentId: decision, projectGroup: 'b' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_group' });
      expect((await projectRow(target.id)).status).toBe('APPRAISAL');
      await decide(sheet.id, sheet.version, { decisionDocumentId: decision, projectGroup: 'A' });
      expect((await projectRow(target.id)).project_group).toBe('A');
    });

    it('AC-ST-PRJ-003-4: the database itself refuses a project in the bank without a group (project_group_required_chk)', async () => {
      const target = await project('APPRAISAL');
      expect(await sqlState(owner("update machvon.project set status = 'PIPELINE', project_group = null where id = $1::uuid", [target.id]))).toBe('23514');
      expect(await sqlState(owner("update machvon.project set status = 'PIPELINE', project_group = 'Z' where id = $1::uuid", [target.id]))).toBe('23514');
      await owner("update machvon.project set status = 'PIPELINE', project_group = 'B' where id = $1::uuid", [target.id]);
      expect((await projectRow(target.id)).status).toBe('PIPELINE');
    });

    it('AC-ST-PRJ-003-4: ADMIT needs the document of the decision; REJECT and RETURN take no group', async () => {
      const { sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      expect(await refusal(decide(sheet.id, sheet.version, { projectGroup: 'B' }))).toMatchObject({ code: 'DECISION_REQUIRED', status: 422, detail: 'decision_document_id' });
      expect(await refusal(decide(sheet.id, sheet.version, { projectGroup: 'B', decisionDocumentId: await document('RECALLED') }))).toMatchObject({ code: 'DECISION_REQUIRED', detail: 'decision_document_id' });
      expect(await refusal(decide(sheet.id, sheet.version, { projectGroup: 'B', decisionDocumentId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      const rejected = await appraised([[0, 0, 0, 0, 0]], 'REJECT');
      const target = rejected.sheets[0] as { id: string; version: number };
      expect(await refusal(decide(target.id, target.version, { decision: 'REJECT', projectGroup: 'B' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_group' });
      expect(await refusal(decide(target.id, target.version, { decision: 'MAYBE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
    });

    it('AC-ST-PRJ-003-3: a decision against what the sheets say needs an override reason of at least 20 characters', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]], 'ADMIT');
      const sheet = sheets[0] as { id: string; version: number };
      expect(await refusal(decide(sheet.id, sheet.version, { decision: 'REJECT' }))).toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED', status: 422, detail: 'override_reason' });
      expect(await refusal(decide(sheet.id, sheet.version, { decision: 'REJECT', overrideReason: 'too short' }))).toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED', status: 422 });
      expect(await refusal(decide(sheet.id, sheet.version, { decision: 'REJECT', overrideReason: '                      ' }))).toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED' });
      const reason = 'The loan agreement fell through, so the project is rejected';
      const decided = await decide(sheet.id, sheet.version, { decision: 'REJECT', overrideReason: `  ${reason}  ` });
      expect(decided).toMatchObject({ againstRecommendation: true, overrideReason: reason, decision: 'REJECT' });
      expect(decided.change).toMatchObject({ to: 'REJECTED' });
      expect(await projectRow(target.id)).toMatchObject({ status: 'REJECTED', appraisal_score: '73.00', project_group: null });
      expect((await sheetRows(target.id))[0]).toMatchObject({ override_reason: reason, decision: 'REJECT' });
    });

    it('AC-ST-PRJ-003-3: admitting a project under the threshold, or against a sheet that does not recommend it, is a decision against the sheets; an override that is not needed is refused', async () => {
      const low = await appraised([[1, 1, 1, 1, 1]], 'ADMIT');
      const sheet = low.sheets[0] as { id: string; version: number };
      const decision = await document();
      expect(await refusal(decide(sheet.id, sheet.version, { decisionDocumentId: decision, projectGroup: 'C' }))).toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED' });
      const admitted = await decide(sheet.id, sheet.version, { decisionDocumentId: decision, projectGroup: 'C', overrideReason: 'Strategic project admitted below the threshold on instruction' });
      expect(admitted.againstRecommendation).toBe(true);
      const split = await appraised([[4, 3, 5, 2, 4], [4, 3, 5, 2, 4]], 'ADMIT');
      // one appraiser recommends against it
      await record(split.target, weighted, [4, 3, 5, 2, 4], { member: SECOND_APPRAISER, recommendation: 'RETURN' });
      const [first] = await sheetRows(split.target.id);
      expect(await refusal(decide(first?.id as string, Number(first?.version), { decisionDocumentId: decision, projectGroup: 'B' }))).toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED' });
      const fine = await appraised([[4, 3, 5, 2, 4]], 'ADMIT');
      const clean = fine.sheets[0] as { id: string; version: number };
      expect(await refusal(decide(clean.id, clean.version, { decisionDocumentId: decision, projectGroup: 'B', overrideReason: 'There is nothing to override here at all' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'override_reason' });
    });

    it('AC-ST-PRJ-003-3: RETURN sends the project back to CONCEPT, keeps no group, and the next round starts afresh', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]], 'RETURN');
      const sheet = sheets[0] as { id: string; version: number };
      const returned = await decide(sheet.id, sheet.version, { decision: 'RETURN', reason: 'Complete the feasibility study first' });
      expect(returned.change).toMatchObject({ from: 'APPRAISAL', to: 'CONCEPT', version: 3 });
      expect(await projectRow(target.id)).toMatchObject({ status: 'CONCEPT', project_group: null, appraisal_score: '73.00' });
      const again = await submit({ id: target.id, version: 3 });
      expect(again).toMatchObject({ from: 'CONCEPT', to: 'APPRAISAL', version: 4 });
      const second = await record({ id: target.id, version: 4 }, weighted, [5, 5, 5, 5, 5]);
      expect(second).toMatchObject({ round: 2, meanScore: '100.00', sheetCount: 1, version: 1 });
      expect((await sheetRows(target.id)).map((row) => [row.round, row.status])).toEqual([
        [1, 'DECIDED'],
        [2, 'SUBMITTED'],
      ]);
      // the sheet of the first round was decided and is not the sheet of this round
      expect(await refusal(decide(sheet.id, 2, { decision: 'RETURN' }))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
    });

    it('AC-ST-PRJ-003-3: a decision is taken once: the second decision on the same round finds it decided', async () => {
      const { sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      const decision = await document();
      await decide(sheet.id, sheet.version, { decisionDocumentId: decision, projectGroup: 'B' });
      expect(await refusal(decide(sheet.id, sheet.version, { decisionDocumentId: decision, projectGroup: 'B' }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(decide(sheet.id, sheet.version + 1, { decisionDocumentId: decision, projectGroup: 'B' }))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
    });

    it('AC-ST-PRJ-003-3: a stale version of the sheet is 409 VERSION_CONFLICT with the current version', async () => {
      const { sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      const conflict = await refusal(decide(sheet.id, sheet.version + 3, { decisionDocumentId: await document(), projectGroup: 'B' }));
      expect(conflict).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    });

    it('AC-ST-PRJ-003-3: a round that still has a draft sheet is not decided (APPRAISAL_INCOMPLETE)', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      await owner(
        `insert into machvon.project_appraisal (tenant_id, id, project_id, round, criteria_set_version_id, appraiser_membership_id, scores_json, total_score, recommendation, status, created_by, updated_by)
         values ($1, gen_random_uuid(), $2::uuid, 1, $3::uuid, $4::uuid, '[{"criterion_code":"C1","score":1}]'::jsonb, 6, 'ADMIT', 'DRAFT', $4::uuid, $4::uuid)`,
        [TENANT_A, target.id, weighted.versionId, memberId(THIRD_APPRAISER)],
      );
      expect(await refusal(decide(sheet.id, sheet.version, { decisionDocumentId: await document(), projectGroup: 'B' }))).toMatchObject({ code: 'APPRAISAL_INCOMPLETE', status: 422 });
    });

    it('AC-ST-PRJ-003-3: the sheet of a project that is not in appraisal, or that does not exist, cannot be decided', async () => {
      expect(await refusal(decide(randomUUID(), 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      await owner("update machvon.project set status = 'CONCEPT' where id = $1::uuid", [target.id]);
      expect(await refusal(decide(sheet.id, sheet.version, { decisionDocumentId: await document(), projectGroup: 'B' }))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
    });
  });

  describe('the proposer neither scores nor decides (four eyes)', () => {
    it('AC-ST-PRJ-003-3: whoever created the project, or sent it to appraisal, cannot score it: 403 SELF_APPROVAL_DENIED and no sheet', async () => {
      const concept = await project();
      const sent = await submit(concept, { member: SECOND_APPRAISER });
      const target = { id: concept.id, version: sent.version };
      for (const member of [PROPOSER, SECOND_APPRAISER]) expect(await refusal(record(target, weighted, [4, 3, 5, 2, 4], { member }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await sheetRows(target.id)).toEqual([]);
      expect(await record(target, weighted, [4, 3, 5, 2, 4], { member: APPRAISER })).toMatchObject({ totalScore: '73.00' });
    });

    it('AC-ST-PRJ-003-3: the proposer who also holds the permission to decide is refused, whether the decision follows the sheets or not', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      const decision = await document();
      expect(await refusal(decide(sheet.id, sheet.version, { member: PROPOSER, decisionDocumentId: decision, projectGroup: 'B' }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(sheet.id, sheet.version, { member: PROPOSER, decision: 'REJECT' }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await projectRow(target.id)).status).toBe('APPRAISAL');
    });

    it('AC-ST-PRJ-003-3: the database says the same to a statement that bypassed the store', async () => {
      const { target } = await appraised([[4, 3, 5, 2, 4]]);
      expect(
        await sqlState(
          owner(
            `insert into machvon.project_appraisal (tenant_id, id, project_id, round, criteria_set_version_id, appraiser_membership_id, scores_json, total_score, recommendation, status, created_by, updated_by)
             values ($1, gen_random_uuid(), $2::uuid, 1, $3::uuid, $4::uuid, '[{"criterion_code":"C1","score":1}]'::jsonb, 6, 'ADMIT', 'SUBMITTED', $4::uuid, $4::uuid)`,
            [TENANT_A, target.id, weighted.versionId, memberId(PROPOSER)],
          ),
        ),
      ).toBe('23514');
      const [sheet] = await sheetRows(target.id);
      expect(
        await sqlState(
          owner(
            `update machvon.project_appraisal set status = 'DECIDED', decision = 'REJECT', decided_by = $2::uuid, decided_at = now(), decision_reason = 'x' where id = $1::uuid`,
            [sheet?.id, memberId(PROPOSER)],
          ),
        ),
      ).toBe('23514');
    });
  });

  describe('scope and state', () => {
    it('AC-ST-PRJ-003-3: sheets are scored only on a project in appraisal, and only inside the scope of the permission', async () => {
      for (const stage of ['CONCEPT', 'PIPELINE', 'REJECTED'] as const) {
        expect(await refusal(record(await project(stage), weighted, [4, 3, 5, 2, 4]))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      }
      const target = await project('APPRAISAL');
      expect(await refusal(record(target, weighted, [4, 3, 5, 2, 4], { scopes: { act: nothing, read: nothing } }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(record(target, weighted, [4, 3, 5, 2, 4], { scopes: { act: nothing, read: everything } }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      const { sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      expect(await refusal(decide(sheet.id, sheet.version, { scopes: { act: nothing, read: nothing } }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(decide(sheet.id, sheet.version, { scopes: { act: nothing, read: everything } }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    });

    it('AC-ST-PRJ-003-3: a sheet of another tenant does not exist, for the sheet and for the project alike', async () => {
      const { sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      expect(await refusal(as((tx) => appraisals.decide(tx, { appraisalId: sheet.id, expectedVersion: sheet.version, actor: memberId(DECIDER), scopes: reachable, decision: 'RETURN', reason: 'Foreign attempt', today: TODAY }), DECIDER, TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const foreign = await project('APPRAISAL', { tenant: TENANT_B });
      expect(await refusal(as((tx) => appraisals.record(tx, { projectId: foreign.id, actor: memberId(APPRAISER), scopes: reachable, criteriaSetVersionId: weighted.versionId, scores: scoresOf(weighted, [4, 3, 5, 2, 4]), recommendation: 'ADMIT', today: TODAY }), APPRAISER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('AC-ST-PRJ-003-3: cancelling a project that is in appraisal voids its open sheets', async () => {
      const { target } = await appraised([[4, 3, 5, 2, 4], [4, 3, 4, 3, 4]]);
      const decisionDocument = await document();
      await as((tx) =>
        stages.transition(tx, {
          command: 'cancelProject',
          projectId: target.id,
          expectedVersion: 2,
          actor: memberId(DECIDER),
          scopes: reachable,
          input: { reason: 'The proposal was withdrawn', decisionDocumentId: decisionDocument },
          today: TODAY,
        }),
      );
      expect((await sheetRows(target.id)).map((sheet) => [sheet.status, sheet.version])).toEqual([
        ['VOID', '2'],
        ['VOID', '2'],
      ]);
      expect((await projectRow(target.id)).status).toBe('CANCELLED');
    });
  });

  describe('what the lifecycle shows of the appraisal', () => {
    it('AC-ST-PRJ-003-3: a decision maker sees every sheet, the mean and which decisions need an override; an appraiser only their own', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4], [1, 1, 1, 1, 1]]);
      const decider = await as((tx) => appraisals.overview(tx, target.id, { actor: memberId(DECIDER), canAppraise: false, canDecide: true, today: TODAY }), DECIDER);
      expect(decider).toMatchObject({
        round: 1,
        status: 'APPRAISAL',
        viewerIsProposer: false,
        canRecord: false,
        canDecide: true,
        decisionTarget: { id: sheets[0]?.id, version: 1 },
        summary: { sheetCount: 2, meanScore: '46.50', thresholdRecommendation: 'REJECT', overrideRequired: { ADMIT: true, REJECT: true, RETURN: true } },
      });
      expect(decider?.sheets.map((sheet) => [sheet.appraiserMembershipId, sheet.totalScore])).toEqual([
        [memberId(APPRAISER), '73.00'],
        [memberId(SECOND_APPRAISER), '20.00'],
      ]);
      expect(decider?.criteriaSet?.criteria.map((criterion) => criterion.weight)).toEqual(['30', '25', '20', '15', '10']);
      const appraiser = await as((tx) => appraisals.overview(tx, target.id, { actor: memberId(APPRAISER), canAppraise: true, canDecide: false, today: TODAY }), APPRAISER);
      expect(appraiser).toMatchObject({ canRecord: true, canDecide: false, summary: null, decisionTarget: null });
      expect(appraiser?.sheets.map((sheet) => sheet.appraiserMembershipId)).toEqual([memberId(APPRAISER)]);
    });

    it('AC-ST-PRJ-003-3: a reader who neither appraises nor decides gets nothing, a proposer cannot act, and a decided round is shown as it was decided', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]]);
      expect(await as((tx) => appraisals.overview(tx, target.id, { actor: memberId(DECIDER), canAppraise: false, canDecide: false, today: TODAY }), DECIDER)).toBeNull();
      expect(await as((tx) => appraisals.overview(tx, randomUUID(), { actor: memberId(DECIDER), canAppraise: true, canDecide: true, today: TODAY }), DECIDER)).toBeNull();
      const proposer = await as((tx) => appraisals.overview(tx, target.id, { actor: memberId(PROPOSER), canAppraise: true, canDecide: true, today: TODAY }), PROPOSER);
      expect(proposer).toMatchObject({ viewerIsProposer: true, canRecord: false, canDecide: false });
      const sheet = sheets[0] as { id: string; version: number };
      await decide(sheet.id, sheet.version, { decisionDocumentId: await document(), projectGroup: 'B' });
      const after = await as((tx) => appraisals.overview(tx, target.id, { actor: memberId(DECIDER), canAppraise: false, canDecide: true, today: TODAY }), DECIDER);
      expect(after).toMatchObject({ round: 1, status: 'PIPELINE', canRecord: false, canDecide: false, decisionTarget: null, summary: { sheetCount: 1, meanScore: '73.00' } });
      expect(after?.sheets[0]).toMatchObject({ status: 'DECIDED', decision: 'ADMIT' });
    });

    it('AC-ST-PRJ-003-3: before any sheet the criteria in force are offered; a project never sent has no round', async () => {
      const target = await project('APPRAISAL');
      const open = await as((tx) => appraisals.overview(tx, target.id, { actor: memberId(APPRAISER), canAppraise: true, canDecide: false, today: TODAY }), APPRAISER);
      expect(open?.round).toBe(1);
      expect(open?.sheets).toEqual([]);
      expect(open?.criteriaSet?.criteria.length).toBeGreaterThan(0);
      const concept = await project();
      const none = await as((tx) => appraisals.overview(tx, concept.id, { actor: memberId(APPRAISER), canAppraise: true, canDecide: true, today: TODAY }), APPRAISER);
      expect(none).toMatchObject({ round: null, sheets: [], canRecord: false, canDecide: false, criteriaSet: null });
    });

    it('the set in force is the platform one, with the weights of the rule and the threshold it waits to confirm', async () => {
      const set = await as((tx) => new MasterRules().appraisalCriteria(tx, TODAY));
      expect(set?.criteria.map((criterion) => [criterion.code, criterion.weight])).toEqual([
        ['POLICY_ALIGNMENT', '25'],
        ['FEASIBILITY', '25'],
        ['EFFECTIVENESS', '20'],
        ['CAPITAL_READINESS', '20'],
        ['RISK', '10'],
      ]);
      expect(set?.passThreshold).toBe('60');
      expect(set?.reading).toMatchObject({ awaitingConfirmation: true, cxn: 'ASSUMPTION-APPRAISAL-60' });
      expect(await as((tx) => new MasterRules().appraisalCriteria(tx, '1999-01-01'))).toBeUndefined();
      expect(await as((tx) => new MasterRules().appraisalCriteriaVersion(tx, randomUUID()))).toBeUndefined();
    });
  });

  describe('what the database keeps', () => {
    it('AC-ST-PRJ-003-3: a decided sheet is never changed, its identity never moves, and the runtime role cannot delete a sheet', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      expect(await sqlState(owner("update machvon.project_appraisal set round = 7 where id = $1::uuid", [sheet.id]))).toBe('23514');
      expect(await sqlState(owner("update machvon.project_appraisal set status = 'DRAFT' where id = $1::uuid", [sheet.id]))).toBe('23514');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.project_appraisal where id = $1::uuid', [sheet.id])))).toBe('42501');
      await decide(sheet.id, sheet.version, { decisionDocumentId: await document(), projectGroup: 'B' });
      expect(await sqlState(owner("update machvon.project_appraisal set total_score = 99 where id = $1::uuid", [sheet.id]))).toBe('23514');
      expect(await sqlState(owner("update machvon.project_appraisal set status = 'VOID' where id = $1::uuid", [sheet.id]))).toBe('23514');
      expect((await sheetRows(target.id))[0]).toMatchObject({ total_score: '73.00', status: 'DECIDED' });
    });

    it('AC-ST-PRJ-003-4: the shape of a decision is held by the database: no ADMIT without a group and a document, no group on another decision, no short override', async () => {
      const { sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const id = (sheets[0] as { id: string }).id;
      const update = (set: string) => owner(`update machvon.project_appraisal set status = 'DECIDED', decided_by = '${memberId(DECIDER)}', decided_at = now(), decision_reason = 'ok', ${set} where id = $1::uuid`, [id]);
      expect(await sqlState(update("decision = 'ADMIT'"))).toBe('23514');
      expect(await sqlState(update(`decision = 'ADMIT', decided_group = 'B'`))).toBe('23514');
      expect(await sqlState(update(`decision = 'REJECT', decided_group = 'B'`))).toBe('23514');
      expect(await sqlState(update(`decision = 'REJECT', override_reason = 'short'`))).toBe('23514');
      expect(await sqlState(owner(`update machvon.project_appraisal set decision = 'REJECT' where id = $1::uuid`, [id]))).toBe('23514');
      expect(await sqlState(owner(`update machvon.project_appraisal set scores_json = '{}'::jsonb where id = $1::uuid`, [id]))).toBe('23514');
      expect(await sqlState(owner(`update machvon.project_appraisal set note = '  padded ' where id = $1::uuid`, [id]))).toBe('23514');
    });
  });
});
