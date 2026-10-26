import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { AudConclusionStore, withinEngagementScope } from '../src/aud-conclusion-store';
import type { ConclusionRow, NewConclusion, NewFinding, NewRecommendation } from '../src/aud-conclusion-store';
import { AudEngagementStore, engagementScope } from '../src/aud-engagement-store';
import type { EngagementRow, NewEngagement, ResolvedTarget } from '../src/aud-engagement-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const engagements = new AudEngagementStore();
const store = new AudConclusionStore();

const COORDINATOR = 1;
const FAMILY = 0x92;
const PROJECT = id(FAMILY, 1);
const PROJECT_ELSEWHERE = id(FAMILY, 2);
const CONTRACT = id(FAMILY, 3);
const CONTRACT_ELSEWHERE = id(FAMILY, 4);
const FOREIGN_PROJECT = id(FAMILY, 5);
const DECISION = id(FAMILY, 10);
const CONCLUSION_DOCUMENT = id(FAMILY, 11);
const DOCUMENT_PENDING = id(FAMILY, 12);
const DOCUMENT_ATTACHMENT = id(FAMILY, 13);
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const TODAY = '2026-10-26';
const TOTAL = '1250000000';

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = COORDINATOR): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const grantOf = (permissions: readonly string[], scope: Scope): EffectiveAccess => ({
  membershipId: memberId(COORDINATOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'AUD', rank: 30, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const NOW = new Date('2026-10-26T03:00:00Z');
const everything = engagementScope(grantOf(['aud.read'], { kind: 'TENANT' }), 'aud.read', NOW);
const nothing = engagementScope(grantOf(['aud.read'], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] }), 'aud.read', NOW);

let counter = 0;
const engagementRequest = (extra: Partial<NewEngagement> = {}): NewEngagement => {
  counter += 1;
  return {
    engagementCode: `KL-2026-${String(counter).padStart(3, '0')}`,
    engagementType: 'STATE_AUDIT',
    authorityKind: 'STATE_AUDIT_OFFICE',
    authorityName: 'State Audit Office, region 2',
    decisionDocumentId: DECISION,
    title: 'Audit of the investment in the bridge',
    periodFrom: '2025-01-01',
    periodTo: '2025-12-31',
    coordinatorId: memberId(COORDINATOR),
    scope: [
      { kind: 'PROJECT', id: PROJECT },
      { kind: 'CONTRACT', id: CONTRACT },
    ],
    ...extra,
  };
};

/** An engagement that is ONGOING (or AWAITING_CONCLUSION) and the row a command locks. */
async function ongoing(extra: Partial<NewEngagement> = {}, fieldworkEnded = false): Promise<{ id: string; row: EngagementRow }> {
  const data = engagementRequest(extra);
  const targets = await as((tx) => engagements.resolveTargets(tx, data.scope));
  const created = await as((tx) => engagements.create(tx, data, targets, memberId(COORDINATOR)));
  await as((tx) => engagements.lock(tx, created.id, everything, everything, 1).then((row) => engagements.start(tx, row, { startedOn: '2026-10-20', placeLegalHold: false, today: TODAY }, memberId(COORDINATOR))));
  if (fieldworkEnded) await as((tx) => engagements.lock(tx, created.id, everything, everything, 2).then((row) => engagements.endFieldwork(tx, row, { onDate: '2026-10-22', today: TODAY }, memberId(COORDINATOR))));
  const row = await as((tx) => engagements.lock(tx, created.id, everything, everything, fieldworkEnded ? 3 : 2));
  return { id: created.id, row };
}

const conclusionRequest = (extra: Partial<NewConclusion> = {}): NewConclusion => ({
  conclusionKind: 'AUDIT_REPORT',
  conclusionDocumentId: CONCLUSION_DOCUMENT,
  issuedOn: '2026-10-10',
  receivedOn: '2026-10-15',
  implementationDueOn: '2026-12-31',
  reportDueOn: '2027-01-15',
  summary: 'The audit found payments above the approved volumes.',
  totalFinancialVnd: TOTAL,
  isPublic: false,
  supersedesId: undefined,
  ...extra,
});

/** An engagement with its conclusion recorded and the conclusion locked for a command, in the scope of the whole tenant. */
async function followed(extra: Partial<NewConclusion> = {}, engagement: Partial<NewEngagement> = {}): Promise<{ engagementId: string; conclusionId: string }> {
  const opened = await ongoing(engagement);
  const recorded = await as((tx) => store.record(tx, opened.row, conclusionRequest(extra), TODAY, memberId(COORDINATOR)));
  return { engagementId: opened.id, conclusionId: recorded.id };
}

const lockConclusion = (tx: TenantTx, conclusionId: string): Promise<ConclusionRow> => store.lock(tx, conclusionId, everything, everything);

const finding = (extra: Partial<NewFinding> = {}): NewFinding => {
  counter += 1;
  return {
    findingCode: `F-${counter}`,
    category: 'FINANCIAL',
    projectId: PROJECT,
    contractId: undefined,
    organizationUnitId: undefined,
    description: 'Payment above the volume accepted on site.',
    legalBasisCited: 'Article 12 of the law on public investment',
    amountVnd: '300000000',
    severity: 'HIGH',
    ...extra,
  };
};

const recommendation = (extra: Partial<NewRecommendation> = {}): NewRecommendation => {
  counter += 1;
  return { findingId: undefined, recCode: `R-${counter}`, recType: 'FINANCIAL_RECOVERY', description: 'Recover the amount paid above the volume accepted.', amountVnd: '100000000', projectId: undefined, ...extra };
};

const addRecommendation = (conclusionId: string, input: NewRecommendation) => as((tx) => lockConclusion(tx, conclusionId).then((row) => store.createRecommendation(tx, row, input, memberId(COORDINATOR))));
const addFinding = (conclusionId: string, input: NewFinding) => as((tx) => lockConclusion(tx, conclusionId).then((row) => store.recordFinding(tx, row, input, memberId(COORDINATOR))));

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (projects, contracts, documents) are seeded with the foreign keys they have to other modules switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

describe('AudConclusionStore (conclusions, findings and recommendations, ST-AUD-002)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
        { n: ELSEWHERE, path: '/u3/' },
      ]);
    }
    await harness.seedMembership(TENANT_A, COORDINATOR, ROOT);
    await harness.seedMembership(TENANT_B, COORDINATOR, ROOT);
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-A-001', 'Bridge', $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $3, 'PRJ-A-002', 'Road', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, PROJECT_ELSEWHERE, unitId(DEPARTMENT), unitId(ELSEWHERE), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-B-001', 'Foreign bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_B, FOREIGN_PROJECT, unitId(DEPARTMENT), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version)
         values ($1, $2, $3, $5, $5, 'HD-A-001', 'LUMP_SUM', 'VND', 'DRAFT', 1), ($1, $4, $6, $5, $5, 'HD-A-002', 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
        [TENANT_A, CONTRACT, PROJECT, CONTRACT_ELSEWHERE, id(FAMILY, 31), PROJECT_ELSEWHERE],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, document_number, number_year, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/QD-KTNN', '2026-01-15', 'EFFECTIVE', 'INTERNAL', null, null, $6, $6),
                ($1, $3, 'INCOMING', 'KL', 'Audit report on the bridge', '88/BC-KTNN', '2026-10-10', 'EFFECTIVE', 'INTERNAL', 88, 2026, $6, $6),
                ($1, $4, 'INCOMING', 'KL', 'A report not yet in force', null, null, 'PENDING', 'INTERNAL', null, null, $6, $6),
                ($1, $5, 'ATTACHMENT', 'KL', 'An attachment, not a conclusion', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $6, $6)`,
        [TENANT_A, DECISION, CONCLUSION_DOCUMENT, DOCUMENT_PENDING, DOCUMENT_ATTACHMENT, memberId(COORDINATOR)],
      ],
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('recording a conclusion (AC-ST-AUD-002-2)', () => {
    it('records the conclusion of an ONGOING engagement and moves it to FOLLOW_UP in the same transaction, with the dates, the total and the document', async () => {
      const opened = await ongoing();
      const recorded = await as((tx) => store.record(tx, opened.row, conclusionRequest({ isPublic: true }), TODAY, memberId(COORDINATOR)));
      expect(recorded.engagementVersion).toBe(opened.row.version + 1);
      const [engagement] = await owner<{ status: string; version: string }>('select status, version::text as version from machvon.audit_engagement where id = $1', [opened.id]);
      expect(engagement).toEqual({ status: 'FOLLOW_UP', version: String(opened.row.version + 1) });
      const [shown] = await as((tx) => store.listConclusions(tx, opened.id, everything));
      expect(shown).toMatchObject({
        id: recorded.id,
        engagementId: opened.id,
        conclusionKind: 'AUDIT_REPORT',
        document: { id: CONCLUSION_DOCUMENT, title: 'Audit report on the bridge', symbol: '88/BC-KTNN' },
        revision: 1,
        supersedesId: null,
        issuedOn: '2026-10-10',
        receivedOn: '2026-10-15',
        implementationDueOn: '2026-12-31',
        reportDueOn: '2027-01-15',
        totalFinancialVnd: TOTAL,
        recommendedVnd: '0',
        shortfallVnd: TOTAL,
        isPublic: true,
        status: 'RECEIVED',
        findingCount: 0,
        recommendationCount: 0,
        version: 1,
      });
    });

    it('also records it once the fieldwork has ended (AWAITING_CONCLUSION), and the due dates may be left out', async () => {
      const opened = await ongoing({}, true);
      expect(opened.row.status).toBe('AWAITING_CONCLUSION');
      await as((tx) => store.record(tx, opened.row, conclusionRequest({ implementationDueOn: undefined, reportDueOn: undefined }), TODAY, memberId(COORDINATOR)));
      const [shown] = await as((tx) => store.listConclusions(tx, opened.id, everything));
      expect(shown).toMatchObject({ implementationDueOn: null, reportDueOn: null });
    });

    it('refuses an engagement that is PLANNED, FOLLOW_UP or cancelled with 409 ENGAGEMENT_STATE_INVALID, and writes nothing', async () => {
      const data = engagementRequest();
      const targets = await as((tx) => engagements.resolveTargets(tx, data.scope));
      const planned = await as((tx) => engagements.create(tx, data, targets, memberId(COORDINATOR)));
      const plannedRow = await as((tx) => engagements.lock(tx, planned.id, everything, everything, 1));
      expect(await refusal(as((tx) => store.record(tx, plannedRow, conclusionRequest(), TODAY, memberId(COORDINATOR))))).toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID', status: 409, detail: 'PLANNED->recordConclusion' });
      const done = await followed();
      const row = await as((tx) => engagements.lock(tx, done.engagementId, everything, everything, 3));
      expect(await refusal(as((tx) => store.record(tx, row, conclusionRequest(), TODAY, memberId(COORDINATOR))))).toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID', status: 409 });
      expect((await owner<{ n: string }>('select count(*) as n from machvon.audit_conclusion where engagement_id = any($1::uuid[])', [[planned.id, done.engagementId]]))[0]?.n).toBe('1');
    });

    it('refuses a document that is not a received or reference document in force, with one answer for a pending one, an attachment, a missing one and one of another tenant', async () => {
      for (const conclusionDocumentId of [DOCUMENT_PENDING, DOCUMENT_ATTACHMENT, randomUUID()]) {
        const opened = await ongoing();
        expect(await refusal(as((tx) => store.record(tx, opened.row, conclusionRequest({ conclusionDocumentId }), TODAY, memberId(COORDINATOR))))).toMatchObject({
          code: 'DECISION_DOCUMENT_NOT_EFFECTIVE',
          status: 422,
        });
      }
    });

    it('refuses days out of order or in the future, a due date before the day of issue, a short summary and a total that is not a whole number of dong', async () => {
      const cases: Array<[Partial<NewConclusion>, string]> = [
        [{ receivedOn: '2026-10-09' }, 'received_on'],
        [{ receivedOn: '2026-10-27' }, 'received_on'],
        [{ implementationDueOn: '2026-10-09' }, 'implementation_due_on'],
        [{ reportDueOn: '2026-10-09' }, 'report_due_on'],
        [{ summary: '   too short ' }, 'summary'],
        [{ totalFinancialVnd: '12.5' }, 'total_financial_vnd'],
        [{ totalFinancialVnd: '-5' }, 'total_financial_vnd'],
      ];
      for (const [extra, detail] of cases) {
        const opened = await ongoing();
        expect(await refusal(as((tx) => store.record(tx, opened.row, conclusionRequest(extra), TODAY, memberId(COORDINATOR))))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail });
      }
    });

    it('leaves a revision that supersedes another to the amended conclusions: 409 CONCLUSION_REVISION_INVALID, and the engagement stays where it was', async () => {
      const opened = await ongoing();
      expect(await refusal(as((tx) => store.record(tx, opened.row, conclusionRequest({ supersedesId: randomUUID() }), TODAY, memberId(COORDINATOR))))).toMatchObject({
        code: 'CONCLUSION_REVISION_INVALID',
        status: 409,
      });
      expect((await owner<{ status: string }>('select status from machvon.audit_engagement where id = $1', [opened.id]))[0]?.status).toBe('ONGOING');
    });

    it('keeps the dates and the summary in order at the table as well, and a revision at most one successor', async () => {
      const done = await followed();
      const insert = (revision: number, summary: string, due: string | null) =>
        owner(
          `insert into machvon.audit_conclusion
             (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, supersedes_id, issued_on, received_on, implementation_due_on, summary, total_financial_vnd, created_by, updated_by)
           values ($1, gen_random_uuid(), $2::uuid, 'AUDIT_NOTICE', $3::uuid, $4, $5::uuid, '2026-10-10', '2026-10-15', $6::date, $7, 0, $8::uuid, $8::uuid)`,
          [TENANT_A, done.engagementId, CONCLUSION_DOCUMENT, revision, done.conclusionId, due, summary, memberId(COORDINATOR)],
        );
      await expect(insert(2, 'short', null)).rejects.toMatchObject({ code: '23514', constraint: 'audit_conclusion_summary_chk' });
      await expect(insert(2, 'The amended conclusion of the audit.', '2026-10-01')).rejects.toMatchObject({ code: '23514', constraint: 'audit_conclusion_due_chk' });
      await insert(2, 'The amended conclusion of the audit.', null);
      await expect(insert(3, 'Another amended conclusion of the audit.', null)).rejects.toMatchObject({ code: '23505', constraint: 'audit_conclusion_successor_uq' });
    });
  });

  describe('locking a conclusion for a command', () => {
    it('does not find a conclusion outside the scope of the caller or of another tenant (404) and tells a caller who sees it but may not act (403)', async () => {
      const done = await followed();
      expect(await refusal(as((tx) => store.lock(tx, done.conclusionId, nothing, everything)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.lock(tx, randomUUID(), everything, everything)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.lock(tx, done.conclusionId, everything, everything), TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.lock(tx, done.conclusionId, everything, nothing)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    });

    it('takes nothing more once the engagement is closed (409 ENGAGEMENT_STATE_INVALID) or the revision was superseded (409 CONCLUSION_REVISION_INVALID)', async () => {
      const closed = await followed();
      await owner("update machvon.audit_engagement set status = 'CLOSED', closed_on = '2026-10-26' where id = $1", [closed.engagementId]);
      expect(await refusal(as((tx) => lockConclusion(tx, closed.conclusionId)))).toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID', status: 409 });
      const old = await followed();
      await owner("update machvon.audit_conclusion set status = 'SUPERSEDED' where id = $1", [old.conclusionId]);
      expect(await refusal(as((tx) => lockConclusion(tx, old.conclusionId)))).toMatchObject({ code: 'CONCLUSION_REVISION_INVALID', status: 409 });
    });
  });

  describe('findings', () => {
    it('records a finding about the project, the contract and the unit of the engagement, in whole dong, once per code', async () => {
      const done = await followed();
      const one = finding({ findingCode: 'F-1', contractId: CONTRACT, organizationUnitId: unitId(DEPARTMENT) });
      const created = await addFinding(done.conclusionId, one);
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      const [shown] = await as((tx) => store.listFindings(tx, done.conclusionId, everything, { limit: 10, after: undefined }));
      expect(shown).toMatchObject({
        id: created.id,
        conclusionId: done.conclusionId,
        findingCode: 'F-1',
        category: 'FINANCIAL',
        project: { id: PROJECT, code: 'PRJ-A-001', name: 'Bridge' },
        contract: { id: CONTRACT, code: 'HD-A-001' },
        unit: { id: unitId(DEPARTMENT), name: expect.any(String) },
        legalBasisCited: 'Article 12 of the law on public investment',
        amountVnd: '300000000',
        severity: 'HIGH',
      });
      expect(await refusal(addFinding(done.conclusionId, { ...one, description: 'Another description of the same code.' }))).toMatchObject({ code: 'FINDING_CODE_DUPLICATE', status: 409 });
      // The same code in another conclusion is another finding.
      const other = await followed();
      await addFinding(other.conclusionId, one);
    });

    it('keeps a finding without a place or an amount, trims the words and drops an empty legal basis', async () => {
      const done = await followed();
      await addFinding(done.conclusionId, finding({ findingCode: '  F-GENERAL  ', projectId: undefined, amountVnd: undefined, legalBasisCited: '   ', description: '  A general failing of the procedure.  ' }));
      const [shown] = await as((tx) => store.listFindings(tx, done.conclusionId, everything, { limit: 10, after: undefined }));
      expect(shown).toMatchObject({ findingCode: 'F-GENERAL', project: null, contract: null, unit: null, amountVnd: null, legalBasisCited: null, description: 'A general failing of the procedure.' });
    });

    it('does not find a place of another tenant or one that does not exist (404), and refuses a place that is in the tenant but not in the engagement (422 TARGET_OUT_OF_ENGAGEMENT)', async () => {
      const done = await followed();
      for (const extra of [{ projectId: FOREIGN_PROJECT }, { projectId: randomUUID() }, { contractId: randomUUID() }, { organizationUnitId: randomUUID() }]) {
        expect(await refusal(addFinding(done.conclusionId, finding(extra)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      }
      const outside: Array<[Partial<NewFinding>, string]> = [
        [{ projectId: PROJECT_ELSEWHERE }, 'project_id'],
        [{ projectId: undefined, contractId: CONTRACT_ELSEWHERE }, 'contract_id'],
        [{ projectId: undefined, organizationUnitId: unitId(ELSEWHERE) }, 'organization_unit_id'],
        [{ projectId: undefined, organizationUnitId: unitId(ROOT) }, 'organization_unit_id'],
      ];
      for (const [extra, detail] of outside) {
        expect(await refusal(addFinding(done.conclusionId, finding(extra)))).toMatchObject({ code: 'TARGET_OUT_OF_ENGAGEMENT', status: 422, detail });
      }
      expect((await as((tx) => store.listFindings(tx, done.conclusionId, everything, { limit: 10, after: undefined }))).length).toBe(0);
    });

    it('refuses an empty code, a short description and an amount that is not a whole number of dong', async () => {
      const done = await followed();
      expect(await refusal(addFinding(done.conclusionId, finding({ findingCode: '   ' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'finding_code' });
      expect(await refusal(addFinding(done.conclusionId, finding({ description: 'short' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'description' });
      expect(await refusal(addFinding(done.conclusionId, finding({ amountVnd: '1.5' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
    });

    it('lists the findings by code with a cursor, and none outside the scope of the reader', async () => {
      const done = await followed();
      for (const code of ['F-C', 'F-A', 'F-B']) await addFinding(done.conclusionId, finding({ findingCode: code }));
      const first = await as((tx) => store.listFindings(tx, done.conclusionId, everything, { limit: 2, after: undefined }));
      expect(first.map((line) => line.findingCode)).toEqual(['F-A', 'F-B']);
      const last = first[1] as { findingCode: string; id: string };
      const second = await as((tx) => store.listFindings(tx, done.conclusionId, everything, { limit: 2, after: { code: last.findingCode, id: last.id } }));
      expect(second.map((line) => line.findingCode)).toEqual(['F-C']);
      expect(await as((tx) => store.listFindings(tx, done.conclusionId, nothing, { limit: 10, after: undefined }))).toEqual([]);
    });
  });

  describe('recommendations and the financial total (AC-ST-AUD-002-1, BR-AUD-05)', () => {
    it('AC-ST-AUD-002-1: 800,000,000 and 400,000,000 against a total of 1,250,000,000 leave 50,000,000; a further 100,000,000 is 422 FINANCIAL_TOTAL_MISMATCH and a financial recommendation without an amount is 422 AMOUNT_REQUIRED', async () => {
      const done = await followed();
      const first = await addRecommendation(done.conclusionId, recommendation({ amountVnd: '800000000' }));
      expect(first).toMatchObject({ recommendedVnd: '800000000', shortfallVnd: '450000000' });
      const second = await addRecommendation(done.conclusionId, recommendation({ recType: 'FINANCIAL_ADJUSTMENT', amountVnd: '400000000' }));
      expect(second).toMatchObject({ recommendedVnd: '1200000000', shortfallVnd: '50000000' });
      const [before] = await as((tx) => store.listConclusions(tx, done.engagementId, everything));
      expect(before).toMatchObject({ totalFinancialVnd: TOTAL, recommendedVnd: '1200000000', shortfallVnd: '50000000', recommendationCount: 2 });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ amountVnd: '100000000' })))).toMatchObject({
        code: 'FINANCIAL_TOTAL_MISMATCH',
        status: 422,
        detail: 'amount_vnd',
        extensions: { total_financial_vnd: TOTAL, recommended_vnd: '1200000000', amount_vnd: '100000000', remaining_vnd: '50000000', excess_vnd: '50000000' },
      });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ amountVnd: undefined })))).toMatchObject({ code: 'AMOUNT_REQUIRED', status: 422, detail: 'amount_vnd' });
      // What fits is allowed, to the last dong, and the next dong is not.
      expect(await addRecommendation(done.conclusionId, recommendation({ amountVnd: '50000000' }))).toMatchObject({ recommendedVnd: TOTAL, shortfallVnd: '0' });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ amountVnd: '1' })))).toMatchObject({ code: 'FINANCIAL_TOTAL_MISMATCH', extensions: { remaining_vnd: '0', excess_vnd: '1' } });
      const [after] = await as((tx) => store.listConclusions(tx, done.engagementId, everything));
      expect(after).toMatchObject({ recommendedVnd: TOTAL, shortfallVnd: '0', recommendationCount: 3 });
    });

    it('does not count a cancelled recommendation, and recommendations that are not financial are no part of the sum', async () => {
      const done = await followed();
      const big = await addRecommendation(done.conclusionId, recommendation({ amountVnd: '1250000000' }));
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ amountVnd: '1' })))).toMatchObject({ code: 'FINANCIAL_TOTAL_MISMATCH' });
      await owner("update machvon.audit_recommendation set status = 'CANCELLED' where id = $1", [big.id]);
      expect(await addRecommendation(done.conclusionId, recommendation({ amountVnd: '1250000000' }))).toMatchObject({ shortfallVnd: '0' });
      for (const recType of ['PROCESS_CORRECTION', 'ACCOUNTABILITY', 'REFERRAL', 'POLICY_CHANGE'] as const) {
        expect(await addRecommendation(done.conclusionId, recommendation({ recType, amountVnd: undefined }))).toMatchObject({ recommendedVnd: TOTAL });
      }
    });

    it('refuses an amount on a recommendation that is not financial and a zero or fractional amount on one that is', async () => {
      const done = await followed();
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ recType: 'PROCESS_CORRECTION', amountVnd: '5' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      for (const amountVnd of ['0', '1.5', '-3']) {
        expect(await refusal(addRecommendation(done.conclusionId, recommendation({ amountVnd })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      }
    });

    it('stores the recommendation OPEN with no owner and no due day, once per code in the conclusion, and answers a finding of the same conclusion only', async () => {
      const done = await followed();
      const other = await followed();
      const mine = await addFinding(done.conclusionId, finding());
      const theirs = await addFinding(other.conclusionId, finding());
      const created = await addRecommendation(done.conclusionId, recommendation({ recCode: 'R-ONE', findingId: mine.id, projectId: PROJECT }));
      const [shown] = await owner<Record<string, unknown>>(
        'select id, conclusion_id, finding_id, rec_code, rec_type, amount_vnd::text as amount_vnd, recovered_vnd::text as recovered_vnd, project_id, owner_unit_id, due_on, status, is_overdue from machvon.audit_recommendation where id = $1',
        [created.id],
      );
      expect(shown).toEqual({
        id: created.id,
        conclusion_id: done.conclusionId,
        finding_id: mine.id,
        rec_code: 'R-ONE',
        rec_type: 'FINANCIAL_RECOVERY',
        amount_vnd: '100000000',
        recovered_vnd: '0',
        project_id: PROJECT,
        owner_unit_id: null,
        due_on: null,
        status: 'OPEN',
        is_overdue: false,
      });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ recCode: 'R-ONE' })))).toMatchObject({ code: 'REC_CODE_DUPLICATE', status: 409 });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ findingId: theirs.id })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'finding_id' });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ findingId: randomUUID() })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'finding_id' });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ projectId: PROJECT_ELSEWHERE })))).toMatchObject({ code: 'TARGET_OUT_OF_ENGAGEMENT', detail: 'project_id' });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ projectId: FOREIGN_PROJECT })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ recCode: ' ' })))).toMatchObject({ detail: 'rec_code' });
      expect(await refusal(addRecommendation(done.conclusionId, recommendation({ description: 'short' })))).toMatchObject({ detail: 'description' });
    });

    it('serialises two recommendations added at the same time: one fits, the other is 422 FINANCIAL_TOTAL_MISMATCH, and the sum never passes the total', async () => {
      const done = await followed({ totalFinancialVnd: '1000' });
      const attempts = await Promise.allSettled([
        addRecommendation(done.conclusionId, recommendation({ amountVnd: '700' })),
        addRecommendation(done.conclusionId, recommendation({ amountVnd: '700' })),
      ]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled').length).toBe(1);
      const failed = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'FINANCIAL_TOTAL_MISMATCH', status: 422 });
      expect((await owner<{ total: string }>('select coalesce(sum(amount_vnd), 0)::text as total from machvon.audit_recommendation where conclusion_id = $1', [done.conclusionId]))[0]?.total).toBe('700');
    });

    it('keeps the same rule at the table: a writer that does not go through the command cannot add up to more than the total, nor put money on a recommendation that is not financial', async () => {
      const done = await followed({ totalFinancialVnd: '1000' });
      const insert = (code: string, type: string, amount: string | null) =>
        owner(
          `insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, status, created_by, updated_by)
           values ($1, gen_random_uuid(), $2::uuid, $3, $4, 'Recover what was paid above the volume.', $5::numeric, 'OPEN', $6::uuid, $6::uuid)`,
          [TENANT_A, done.conclusionId, code, type, amount, memberId(COORDINATOR)],
        );
      await insert('T-1', 'FINANCIAL_RECOVERY', '600');
      await expect(insert('T-2', 'FINANCIAL_RECOVERY', '401')).rejects.toMatchObject({ code: '23514', constraint: 'audit_recommendation_total_guard' });
      await insert('T-3', 'FINANCIAL_ADJUSTMENT', '400');
      await expect(insert('T-4', 'PROCESS_CORRECTION', '1')).rejects.toMatchObject({ code: '23514', constraint: 'audit_recommendation_amount_kind_chk' });
      // Putting a cancelled one back in play is the same sum again.
      await owner("update machvon.audit_recommendation set status = 'CANCELLED' where conclusion_id = $1 and rec_code = 'T-3'", [done.conclusionId]);
      await insert('T-5', 'FINANCIAL_RECOVERY', '400');
      await expect(owner("update machvon.audit_recommendation set status = 'OPEN' where conclusion_id = $1 and rec_code = 'T-3'", [done.conclusionId])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('reading', () => {
    it('finds one conclusion with its counts in the scope of the caller, and nothing outside it', async () => {
      const done = await followed();
      await addFinding(done.conclusionId, finding());
      await addRecommendation(done.conclusionId, recommendation({ amountVnd: '250000000' }));
      expect(await as((tx) => store.findConclusion(tx, done.conclusionId, everything))).toMatchObject({ id: done.conclusionId, findingCount: 1, recommendationCount: 1, recommendedVnd: '250000000', shortfallVnd: '1000000000' });
      expect(await as((tx) => store.findConclusion(tx, done.conclusionId, nothing))).toBeUndefined();
      expect(await as((tx) => store.findConclusion(tx, randomUUID(), everything))).toBeUndefined();
      expect(await as((tx) => store.listConclusions(tx, done.engagementId, nothing))).toEqual([]);
    });
  });

  describe('withinEngagementScope', () => {
    const target = (kind: ResolvedTarget['kind'], idValue: string, ownerUnitId: string, ownerUnitPath: string, projectId: string | null = null): ResolvedTarget => ({
      kind,
      id: idValue,
      code: idValue,
      name: idValue,
      ownerUnitId,
      ownerUnitPath,
      projectId,
      contractId: kind === 'CONTRACT' ? idValue : null,
    });
    const unit = target('UNIT', 'u2', 'u2', '/u1/u2/');
    const project = target('PROJECT', 'p1', 'u2', '/u1/u2/', 'p1');
    const contract = target('CONTRACT', 'c1', 'u2', '/u1/u2/', 'p1');

    it('lets a unit item cover the units under it and the projects and contracts owned there, and nothing else', () => {
      const scope = [target('UNIT', 'u1', 'u1', '/u1/')];
      expect([unit, project, contract].map((place) => withinEngagementScope(place, scope))).toEqual([true, true, true]);
      expect(withinEngagementScope(target('UNIT', 'u3', 'u3', '/u3/'), scope)).toBe(false);
      expect(withinEngagementScope(target('PROJECT', 'p2', 'u3', '/u3/', 'p2'), scope)).toBe(false);
      // The unit above the item is not covered by it.
      expect(withinEngagementScope(target('UNIT', 'u1', 'u1', '/u1/'), [unit])).toBe(false);
    });

    it('lets a project item cover itself, its contracts and the unit that owns it, and a contract item itself and the unit that owns its project', () => {
      expect([project, contract, unit].map((place) => withinEngagementScope(place, [project]))).toEqual([true, true, true]);
      expect(withinEngagementScope(target('PROJECT', 'p2', 'u2', '/u1/u2/', 'p2'), [project])).toBe(false);
      expect(withinEngagementScope(target('CONTRACT', 'c2', 'u2', '/u1/u2/', 'p2'), [project])).toBe(false);
      expect([contract, unit].map((place) => withinEngagementScope(place, [contract]))).toEqual([true, true]);
      expect(withinEngagementScope(project, [contract])).toBe(false);
      expect(withinEngagementScope(target('CONTRACT', 'c2', 'u2', '/u1/u2/', 'p1'), [contract])).toBe(false);
    });

    it('covers a place that any item covers, and none when the scope is empty', () => {
      expect(withinEngagementScope(contract, [target('UNIT', 'u3', 'u3', '/u3/'), project])).toBe(true);
      expect(withinEngagementScope(contract, [])).toBe(false);
    });
  });
});
