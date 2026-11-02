/* eslint-disable @typescript-eslint/no-explicit-any -- the replies of the API and the rows of the tables are read as the JSON they are */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { AnalysisController } from '../../src/modules/bid/analysis.controller';
import { BidAnalysisService } from '../../src/modules/bid/analysis.service';
import { ConflictController } from '../../src/modules/bid/conflict.controller';
import { ResultController } from '../../src/modules/bid/result.controller';
import { ReviewController } from '../../src/modules/bid/review.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { LlmGatewayService } from '../../src/modules/llm/gateway.service';
import { MockEmbeddingPort, OcrDocumentTextPort } from '../../src/modules/llm/knowledge-ports';
import { AiKnowledgeService } from '../../src/modules/llm/knowledge.service';
import { MockAiGateway } from '../../src/modules/llm/mock-gateway';
import { LLM_GATEWAY } from '../../src/modules/llm/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAnalysisProfile, seedCriteria } from '../../../../packages/db/test/support/bid-analysis-fixtures';
import { onProjects, seedBidPackage } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import type { SeededPackage } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { DEFAULT_SAID, seedAnalysedProposal } from '../../../../packages/db/test/support/bid-review-fixtures';
import type { AnalysedProposal, AnalysisWorld } from '../../../../packages/db/test/support/bid-review-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const E1 = 1; // bid.evaluate: decides on findings
const E2 = 2; // the same: recused from one contractor in one test, undeclared in another
const E3 = 3; // the same: never declares
const AI_REVIEWER = 4; // bid.evaluate and ai.review: the baseline form
const RUNNER = 5; // reads runs only: not a member of the evaluation team
const AUTHORITY = 6; // bid.result.approve and bid.conflict.decide
const B_EVALUATOR = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const REASON_OF_RELATION = 'The relation was examined by the authority and recorded.';
const WHY = 'Hợp đồng tương tự ở trang 18 chưa được nghiệm thu, không đạt yêu cầu kinh nghiệm';

interface Reply {
  status: number;
  json: Record<string, any>;
}

describe('the review of the findings of an analysis by an expert and the comparison of proposals (ST-BID-010)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let tenants: TenantDatabase;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string | null }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== null && options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  interface Fixture {
    seeded: SeededPackage;
    world: AnalysisWorld;
    criteriaId: string;
    run: AnalysedProposal;
  }

  const declare = (member: number, packageId: string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/procurement-packages/${packageId}/conflict-declarations`, { member, body });

  /** A package with approved criteria (C1 met or not, C2 and C3 scored out of 10), a proposal analysed on them (C1 and C2 supported, C3 missing), and E1 who declared that no conflict stands. */
  async function fixture(): Promise<Fixture> {
    const seeded = await seedBidPackage(harness);
    expect((await declare(E1, seeded.packageId, { has_conflict: false })).status).toBe(200);
    const criteria = await seedCriteria(harness, seeded.packageId, { codes: ['C1', 'C2', 'C3'] });
    const profile = await seedAnalysisProfile(harness);
    const world: AnalysisWorld = { seeded, profileId: profile.id, evaluator: { membershipId: memberId(E1), evaluate: onProjects(seeded.projectId), receive: () => ({ sql: 'false', params: [] }), now: new Date() }, member: E1 };
    return { seeded, world, criteriaId: criteria.id, run: await seedAnalysedProposal(harness, world, 'NT-1', criteria.id) };
  }

  const review = (finding: string, version: number, body: Record<string, unknown>, options: { member?: number; key?: string; ifMatch?: string | null; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', `/analysis-findings/${finding}/review`, {
      member: options.member ?? E1,
      tenantId: options.tenantId,
      key: options.key,
      ifMatch: options.ifMatch === undefined ? `"${version}"` : options.ifMatch,
      body,
    });
  const compare = (packageId: string, query = '', member = E1): Promise<Reply> => call('GET', `/procurement-packages/${packageId}/proposal-comparison${query}`, { member });
  const findings = (runId: string, member = E1): Promise<Reply> => call('GET', `/analysis-runs/${runId}/findings`, { member });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-bid-review-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [E1, E2, E3, AI_REVIEWER, RUNNER, AUTHORITY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_EVALUATOR, ROOT);
    const expert = ['bid.evaluate', 'analysis_run.read', 'analysis_finding.read'];
    await harness.seedRole(TENANT_A, 1, 'BID_EXPERT', expert, 30);
    await harness.seedRole(TENANT_A, 2, 'BID_EXPERT_AI', [...expert, 'ai.review'], 30);
    await harness.seedRole(TENANT_A, 3, 'RUN_READER', ['analysis_run.read'], 10);
    await harness.seedRole(TENANT_A, 4, 'BID_AUTHORITY', ['bid.conflict.decide', 'bid.read', 'bid.result.approve'], 40);
    await harness.seedRole(TENANT_B, 1, 'BID_EXPERT', expert, 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: E1, role: 1, kind: 'TENANT' },
      { n: 2, member: E2, role: 1, kind: 'TENANT' },
      { n: 3, member: E3, role: 1, kind: 'TENANT' },
      { n: 4, member: AI_REVIEWER, role: 2, kind: 'TENANT' },
      { n: 5, member: RUNNER, role: 3, kind: 'TENANT' },
      { n: 6, member: AUTHORITY, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_EVALUATOR, role: 1, kind: 'TENANT' }]);
    tenants = harness.tenants as TenantDatabase;
    // The reads of the runs and of their findings are those of the analysis; the review needs none of what runs a model.
    const files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    const knowledge = new AiKnowledgeService(new MockEmbeddingPort(), new OcrDocumentTextPort(files), files, new AuditWriter(tenants));
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ReviewController, AnalysisController, ConflictController, ResultController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: LLM_GATEWAY, useValue: new MockAiGateway() },
        { provide: AiKnowledgeService, useValue: knowledge },
        LlmGatewayService,
        BidAnalysisService,
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of BID', () => {
    expect(bidModule.controllers).toContain(ReviewController);
  });

  describe('AC-ST-BID-010-1, UAT-AC16: an expert changes a finding with a reason, and the award is not theirs to decide', () => {
    it('AC-ST-BID-010-1, UAT-AC16: refuses a short reason with 422 REASON_REQUIRED, records 4 to 2 with the decision of a person ACCEPTED_WITH_CHANGE, and refuses the decision on the award with 403 SCOPE_DENIED', async () => {
      const fx = await fixture();
      const finding = fx.run.findings.get('C2') as string;
      // The finding was scored 4 out of 10 by the first decision.
      const scored = await review(finding, 1, { to_status: 'SUPPORTED', score_after: '4', reason: 'The pages show three bridges, one of them still open to traffic.' });
      expect(scored).toMatchObject({ status: 200, json: { final_status: 'SUPPORTED', final_score: '4.00', resource_version: 2, run_status: 'AWAITING_REVIEW' } });

      const short = await review(finding, 2, { to_status: 'CONTRADICTED', score_after: '2', reason: 'short' });
      expect(short).toMatchObject({ status: 422, json: { code: 'REASON_REQUIRED' } });
      expect(await rows('select count(*)::int as n from machvon.analysis_finding_review where finding_id = $1', [finding])).toEqual([{ n: 1 }]);

      const done = await review(finding, 2, { to_status: 'CONTRADICTED', score_after: '2', reason: WHY });
      expect(done).toMatchObject({ status: 200, json: { status: 'CONTRADICTED', final_status: 'CONTRADICTED', final_score: '2.00', decision: 'ACCEPTED_WITH_CHANGE', resource_id: finding, resource_version: 3, run_status: 'AWAITING_REVIEW' } });
      const [stored] = await rows<any>(
        `select r.from_status, r.to_status, r.score_before::text as score_before, r.score_after::text as score_after, r.reason, r.decision, r.reviewer_user_id, d.decision as record, d.rationale, d.subject_id, d.action_kind, d.applied_operation_id,
                d.applied_resource_version::int as applied_version
           from machvon.analysis_finding_review r join machvon.ai_decision_record d on d.id = r.ai_decision_record_id where r.id = $1`,
        [done.json.review_id],
      );
      expect(stored).toEqual({
        from_status: 'SUPPORTED',
        to_status: 'CONTRADICTED',
        score_before: '4.00',
        score_after: '2.00',
        reason: WHY,
        decision: 'ACCEPTED_WITH_CHANGE',
        reviewer_user_id: memberId(E1),
        record: 'ACCEPTED_WITH_CHANGE',
        rationale: WHY,
        subject_id: finding,
        action_kind: 'DECISION',
        applied_operation_id: done.json.operation_id,
        applied_version: 3,
      });
      expect(done.json.ai_decision_record_id).toEqual(expect.any(String));
      // What the model said is what it said: the finding still reads SUPPORTED and the expert's decision is read beside it.
      const read = await findings(fx.run.runId);
      const item = (read.json.items as any[]).find((entry) => entry.id === finding);
      expect(item).toMatchObject({ status: 'SUPPORTED', final_status: 'CONTRADICTED', final_score: '2.00', review_count: 2, version: 3 });
      expect(item.reviews.map((entry: any) => [entry.from_status, entry.to_status, entry.score_before, entry.score_after, entry.decision])).toEqual([
        ['SUPPORTED', 'SUPPORTED', null, '4.00', 'ACCEPTED_WITH_CHANGE'],
        ['SUPPORTED', 'CONTRADICTED', '4.00', '2.00', 'ACCEPTED_WITH_CHANGE'],
      ]);
      expect(item.reviews[1].reviewer.id).toBe(memberId(E1));
      // The trail and the event say who decided what, with the reason; the text of the finding is not in them.
      const audit = await rows<any>("select safe_diff, reason from machvon.audit_event where action = 'bid.finding_reviewed' and resource_id = $1 order by occurred_at desc limit 1", [finding]);
      expect(audit[0]).toMatchObject({ reason: WHY, safe_diff: { from_status: 'SUPPORTED', to_status: 'CONTRADICTED', score_before: '4.00', score_after: '2.00', decision: 'ACCEPTED_WITH_CHANGE' } });
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('NT-1 on C2');
      expect(await rows("select count(*)::int as n from machvon.outbox_event where aggregate_id = $1 and type = 'bid.finding.reviewed.v1'", [finding])).toEqual([{ n: 2 }]);

      // The expert has no say over the award: the decision on a result is the authority of someone who holds the permission.
      const award = await call('POST', `/procurement-results/${randomUUID()}/decision`, { member: E1, ifMatch: '"1"', body: { decision: 'APPROVE', decision_document_id: randomUUID(), comment: 'The proposal of NT-1 is the best.' } });
      expect(award).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    });

    it('is a decision that can be sent again: the same key gives the same answer and one row, and the same key for another body is refused', async () => {
      const fx = await fixture();
      const finding = fx.run.findings.get('C1') as string;
      const body = { to_status: 'SUPPORTED', reason: WHY };
      const first = await review(finding, 1, body, { key: 'review-key-0000000001' });
      const again = await review(finding, 1, body, { key: 'review-key-0000000001' });
      expect(again).toMatchObject({ status: 200, json: { review_id: first.json.review_id, operation_id: first.json.operation_id } });
      expect(await rows('select count(*)::int as n from machvon.analysis_finding_review where finding_id = $1', [finding])).toEqual([{ n: 1 }]);
      expect(await review(finding, 1, { to_status: 'CONTRADICTED', reason: WHY }, { key: 'review-key-0000000001' })).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    });

    it('asks the version the expert saw, and the first of two experts who decide on the same version wins', async () => {
      const fx = await fixture();
      const finding = fx.run.findings.get('C1') as string;
      expect(await review(finding, 1, { to_status: 'SUPPORTED', reason: WHY }, { ifMatch: null })).toMatchObject({ status: 428 });
      expect((await review(finding, 1, { to_status: 'SUPPORTED', reason: WHY })).status).toBe(200);
      expect(await review(finding, 1, { to_status: 'CONTRADICTED', reason: WHY })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT', current_version: 2 } });
      expect(await review(finding, 2, { to_status: 'CONTRADICTED', reason: WHY }, { member: E3 })).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      expect(await rows('select count(*)::int as n from machvon.analysis_finding_review where finding_id = $1', [finding])).toEqual([{ n: 1 }]);
    });

    it('refuses what is not a decision: a status that does not exist, a score off the scale or for a criterion that is met or not, fields that are not part of it, and a run that does not wait for the experts', async () => {
      const fx = await fixture();
      const [c1, c2] = [fx.run.findings.get('C1') as string, fx.run.findings.get('C2') as string];
      expect(await review(c2, 1, { to_status: 'APPROVED', reason: WHY })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await review(c2, 1, { to_status: 'SUPPORTED', score_after: '10.5', reason: WHY })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await review(c2, 1, { to_status: 'SUPPORTED', score_after: 'abc', reason: WHY })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await review(c1, 1, { to_status: 'SUPPORTED', score_after: '1', reason: WHY })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await review(c2, 1, { to_status: 'SUPPORTED', reason: WHY, final_status: 'SUPPORTED' })).toMatchObject({ status: 400 });
      expect(await review(c2, 1, { to_status: 'SUPPORTED', reason: `   ${'x'.repeat(19)}   ` })).toMatchObject({ status: 422, json: { code: 'REASON_REQUIRED' } });
      const cancelled = await seedAnalysedProposal(harness, fx.world, 'NT-9', fx.criteriaId, DEFAULT_SAID, 'CANCELLED');
      expect(await review(cancelled.findings.get('C1') as string, 1, { to_status: 'SUPPORTED', reason: WHY })).toMatchObject({ status: 422, json: { code: 'RUN_NOT_COMPLETED' } });
      expect(await rows('select count(*)::int as n from machvon.analysis_finding_review where finding_id = any($1::uuid[])', [[...fx.run.findings.values(), ...cancelled.findings.values()]])).toEqual([{ n: 0 }]);
    });

    it('is the decision of a member of the evaluation team with the full view: not of someone without the permission, who owes the declaration, who is recused from the contractor, or of another tenant', async () => {
      const fx = await fixture();
      const finding = fx.run.findings.get('C1') as string;
      const body = { to_status: 'SUPPORTED', reason: WHY };
      expect(await review(finding, 1, body, { member: RUNNER })).toMatchObject({ status: 403 });
      expect(await review(finding, 1, body, { member: E2 })).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      const made = await declare(E2, fx.seeded.packageId, { has_conflict: true, relation_text: 'The director of NT-1 is my cousin.', contractor_id: fx.run.contractorId });
      expect(made.status).toBe(200);
      const decided = await call('POST', `/bid-conflict-declarations/${made.json.resource_id}/decision`, { member: AUTHORITY, ifMatch: '"1"', body: { decision: 'RECUSED', decision_reason: REASON_OF_RELATION } });
      expect(decided.status).toBe(200);
      expect(await review(finding, 1, body, { member: E2 })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await review(finding, 1, body, { member: B_EVALUATOR, tenantId: TENANT_B })).toMatchObject({ status: 404 });
      expect(await review(randomUUID(), 1, body)).toMatchObject({ status: 404 });
      expect(await rows('select count(*)::int as n from machvon.analysis_finding_review where finding_id = $1', [finding])).toEqual([{ n: 0 }]);
      expect(await rows('select count(*)::int as n from machvon.ai_decision_record where subject_id = $1', [finding])).toEqual([{ n: 0 }]);
    });

    it('has no way to accept all the findings at once, and completes the run only with the decision on the last of them', async () => {
      const fx = await fixture();
      expect((await call('POST', `/analysis-runs/${fx.run.runId}/review`, { member: E1, ifMatch: '"2"', body: { to_status: 'SUPPORTED', reason: WHY } })).status).toBe(404);
      expect((await call('POST', `/analysis-runs/${fx.run.runId}/accept-all`, { member: E1, ifMatch: '"2"', body: {} })).status).toBe(404);
      const finalVersions = new Map<string, number>();
      for (const code of ['C1', 'C2', 'C3']) {
        const done = await review(fx.run.findings.get(code) as string, 1, { to_status: code === 'C3' ? 'MISSING' : 'SUPPORTED', reason: WHY });
        finalVersions.set(code, done.json.resource_version);
        expect(done.json.run_status).toBe(code === 'C3' ? 'COMPLETED' : 'AWAITING_REVIEW');
      }
      expect(await rows('select status, version::int as version from machvon.analysis_run where id = $1', [fx.run.runId])).toEqual([{ status: 'COMPLETED', version: 3 }]);
      expect((await call('GET', `/resources/analysis_run/${fx.run.runId}`, { member: E1 })).json).toMatchObject({ status: 'COMPLETED', reviewed_count: 3 });
      expect((await call('GET', `/resources/analysis_finding/${fx.run.findings.get('C1')}`, { member: E1 })).json).toMatchObject({ final_status: 'SUPPORTED', version: 2 });
    });
  });

  describe('post_findings_id_review: the form that approves what stands or sets it aside', () => {
    const decide = (finding: string, version: number, body: Record<string, unknown>, member = AI_REVIEWER): Promise<Reply> => call('POST', `/findings/${finding}/review`, { member, ifMatch: `"${version}"`, body });

    it('approves with the citations the expert checked, sets aside with a reason, and is the same command: one decision and the record of the decision of a person each', async () => {
      const fx = await fixture();
      expect((await declare(AI_REVIEWER, fx.seeded.packageId, { has_conflict: false })).status).toBe(200);
      const c1 = fx.run.findings.get('C1') as string;
      const [evidence] = await rows<{ id: string }>('select id from machvon.analysis_evidence where finding_id = $1', [c1]);
      const approved = await decide(c1, 1, { decision: 'approve', reason: WHY, evidence_ids: [evidence?.id] });
      expect(approved).toMatchObject({ status: 200, json: { decision: 'ACCEPTED', final_status: 'SUPPORTED', resource_version: 2 } });
      const [row] = await rows<any>('select checked_evidence_ids, decision from machvon.analysis_finding_review where id = $1', [approved.json.review_id]);
      expect(row).toEqual({ checked_evidence_ids: [evidence?.id], decision: 'ACCEPTED' });
      const rejected = await decide(c1, 2, { decision: 'reject', reason: WHY, evidence_ids: [] });
      expect(rejected).toMatchObject({ status: 200, json: { decision: 'REJECTED', final_status: 'NEEDS_REVIEW', resource_version: 3 } });
      expect(await rows('select decision from machvon.ai_decision_record where subject_id = $1 order by decided_at', [c1])).toEqual([{ decision: 'ACCEPTED' }, { decision: 'REJECTED' }]);
    });

    it('needs the permission of the operation over the permission to evaluate, refuses citations of another finding and a decision to return, and shows a short reason as 422 REASON_REQUIRED', async () => {
      const fx = await fixture();
      expect((await declare(AI_REVIEWER, fx.seeded.packageId, { has_conflict: false })).status).toBe(200);
      const [c1, c2] = [fx.run.findings.get('C1') as string, fx.run.findings.get('C2') as string];
      const [foreign] = await rows<{ id: string }>('select id from machvon.analysis_evidence where finding_id = $1', [c2]);
      expect(await decide(c1, 1, { decision: 'approve', reason: WHY, evidence_ids: [] }, E1)).toMatchObject({ status: 403 });
      expect(await decide(c1, 1, { decision: 'approve', reason: WHY, evidence_ids: [foreign?.id] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await decide(c1, 1, { decision: 'return', reason: WHY, evidence_ids: [] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await decide(c1, 1, { decision: 'approve', reason: 'short', evidence_ids: [] })).toMatchObject({ status: 422, json: { code: 'REASON_REQUIRED' } });
      expect(await rows('select count(*)::int as n from machvon.analysis_finding_review where finding_id = $1', [c1])).toEqual([{ n: 0 }]);
    });
  });

  describe('AC-ST-BID-010-2, UAT-AC17: the proposals of a package on one version of the criteria', () => {
    it('AC-ST-BID-010-2, UAT-AC17: compares only the runs on CV-2, excludes the one on CV-1 as CRITERIA_VERSION_MISMATCH and lists the excluded attributes', async () => {
      const fx = await fixture();
      const second = await seedCriteria(harness, fx.seeded.packageId, { revision: 2, codes: ['C1', 'C2', 'C3'] });
      const other = await seedAnalysedProposal(harness, fx.world, 'NT-2', second.id);
      await review(other.findings.get('C2') as string, 1, { to_status: 'SUPPORTED', score_after: '8', reason: WHY });
      const read = await compare(fx.seeded.packageId, `?criteria_version_id=${second.id}`);
      expect(read.status).toBe(200);
      expect(read.json).toMatchObject({ package: { id: fx.seeded.packageId }, criteria_version_id: second.id, criteria_status: 'APPROVED' });
      expect(read.json.proposals.map((proposal: any) => [proposal.proposal_id, proposal.contractor.legal_name, proposal.decided_count])).toEqual([[other.proposalId, 'NT-2', 1]]);
      expect(read.json.excluded).toEqual([
        { proposal_id: fx.run.proposalId, contractor: { id: fx.run.contractorId, legal_name: 'NT-1' }, run_id: fx.run.runId, criteria_version_id: fx.criteriaId, reason: 'CRITERIA_VERSION_MISMATCH' },
      ]);
      expect(read.json.excluded_attributes).toEqual(expect.arrayContaining(['GENDER', 'LOCAL_PRESENCE', 'ETHNICITY']));
      // A cell holds what the expert decided and nothing the model said: one is decided, the others wait.
      const cells = new Map<string, any>(read.json.rows.map((row: any) => [row.criterion.code, row.cells[0]]));
      expect(cells.get('C2')).toMatchObject({ risk: 'NONE', decided: { status: 'SUPPORTED', score: '8.00', decision: 'ACCEPTED_WITH_CHANGE' } });
      expect(cells.get('C1')).toMatchObject({ risk: 'UNDECIDED', decided: null });
      expect(JSON.stringify(read.json)).not.toContain('NT-2 on C');
      expect(read.json.proposals[0]).not.toHaveProperty('rank');
      // The default is the version in force, and opening the comparison is on the trail.
      expect((await compare(fx.seeded.packageId)).json.criteria_version_id).toBe(second.id);
      const audit = await rows<any>("select safe_diff from machvon.audit_event where action = 'bid.comparison_opened' and resource_id = $1 order by occurred_at desc limit 1", [fx.seeded.packageId]);
      expect(audit[0]?.safe_diff).toMatchObject({ criteria_version_id: second.id, compared: 1, excluded: 1 });
    });

    it('does not exist for someone without the permission or the project, is refused to someone who owes the declaration, and refuses a version of another package', async () => {
      const fx = await fixture();
      expect((await compare(fx.seeded.packageId, '', RUNNER)).status).toBe(403);
      expect(await compare(fx.seeded.packageId, '', E3)).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      expect((await compare(randomUUID())).status).toBe(404);
      expect((await call('GET', `/procurement-packages/${fx.seeded.packageId}/proposal-comparison`, { member: B_EVALUATOR, tenantId: TENANT_B })).status).toBe(404);
      expect(await compare(fx.seeded.packageId, '?criteria_version_id=not-a-uuid')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const foreign = await seedCriteria(harness, (await seedBidPackage(harness)).packageId);
      expect(await compare(fx.seeded.packageId, `?criteria_version_id=${foreign.id}`)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await compare(fx.seeded.packageId, `?criteria_version_id=${randomUUID()}`)).toMatchObject({ status: 404 });
    });
  });
});
