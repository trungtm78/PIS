/* eslint-disable @typescript-eslint/no-explicit-any -- the replies of the API and the rows of the tables are read as the JSON they are */
import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { evaluationReportSourceRef, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { ConflictController } from '../../src/modules/bid/conflict.controller';
import { BID_REPORT_ISSUE_REQUESTED_EVENT, ReportController } from '../../src/modules/bid/report.controller';
import { BID_REPORT_CONSUMER, BID_REPORT_EVENT_METRIC, BID_ISSUE_LATENCY_METRIC, BidReportConsumer } from '../../src/modules/bid/report.consumer';
import { ReviewController } from '../../src/modules/bid/review.controller';
import { DOC_ISSUED_EVENT, DOC_RECALLED_EVENT, DOC_REJECTED_EVENT } from '../../src/modules/aud/report.consumer';
import { DocumentIssueConsumer } from '../../src/modules/doc/issue-consumer';
import { DocumentIssueService } from '../../src/modules/doc/issue-request.service';
import { DOCUMENT_FILE_PORT, MockDocumentFilePort } from '../../src/modules/doc/file-port';
import { loadPlatformTemplates } from '../../src/modules/doc/template-pack';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAnalysisProfile, seedCriteria } from '../../../../packages/db/test/support/bid-analysis-fixtures';
import { onProjects, seedAs, seedBidPackage } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import type { SeededPackage } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { seedAnalysedProposal } from '../../../../packages/db/test/support/bid-review-fixtures';
import type { AnalysedProposal } from '../../../../packages/db/test/support/bid-review-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const E1 = 1; // a member of the evaluation team: bid.evaluate over the whole tenant
const E2 = 2; // the same
const E3 = 3; // the same
const READER = 4; // bid.read only
const AUTHORITY = 5; // decides the conflicts
const NOBODY = 6; // holds nothing
const B_EVALUATOR = 1; // of tenant B
const ROOT = 1;
const CONCLUSION = 'Hai hồ sơ được đánh giá trên cùng bộ tiêu chí; tổ chuyên gia nêu rõ từng tiêu chí đáp ứng hay không.';
const DISSENT = 'Tôi không đồng ý với điểm kinh nghiệm của nhà thầu thứ hai vì hợp đồng cầu chưa được nghiệm thu.';
const WHY = 'The contract of the bridge was examined by the team and found as said.';

interface Reply {
  status: number;
  json: Record<string, any>;
}

describe('the evaluation report and its sign-off over HTTP (ST-BID-012, BID-13)', () => {
  const harness = new AuthzHarness();
  const files = new MockDocumentFilePort();
  const alerts: Array<{ code: string; context: Record<string, unknown> }> = [];
  const counted: Array<{ name: string; labels?: Record<string, string> | undefined }> = [];
  const gauges: Array<{ name: string; value: number }> = [];
  const metrics: MetricsSink = { increment: (name, labels) => void counted.push({ name, labels }), gauge: (name, value) => void gauges.push({ name, value }) };
  let app: RunningApp;
  let appWithoutFiles: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string | null; on?: RunningApp }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== null && options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${(options.on ?? app).baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, any>; actor_id: string }>('select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, any>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const stored = async (id: string) =>
    (
      await rows<{ status: string; version: string; signed_off_by: any[]; payload_sha256: string | null; payload_ref: string | null; issue_event_id: string | null; report_document_id: string | null; recalled_at: Date | null }>(
        'select status, version::text, signed_off_by, payload_sha256, payload_ref, issue_event_id, report_document_id, recalled_at from machvon.evaluation_report where id = $1::uuid',
        [id],
      )
    )[0] as { status: string; version: string; signed_off_by: any[]; payload_sha256: string | null; payload_ref: string | null; issue_event_id: string | null; report_document_id: string | null; recalled_at: Date | null };
  const etag = (version: number): string => `"${version}"`;

  interface World {
    seeded: SeededPackage;
    criteriaId: string;
    alpha: AnalysedProposal;
    beta: AnalysedProposal;
  }

  const declare = (member: number, packageId: string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/procurement-packages/${packageId}/conflict-declarations`, { member, body });
  const reviewFinding = async (findingId: string, member: number, body: Record<string, unknown>, version = 1): Promise<Reply> =>
    call('POST', `/analysis-findings/${findingId}/review`, { member, ifMatch: etag(version), body: { reason: WHY, ...body } });

  /** The findings of a proposal decided by the experts over HTTP, but the ones named: C1 met, C2 scored 8, C3 missing and scored 5. */
  async function decideOver(run: AnalysedProposal, except: string[] = []): Promise<void> {
    const plan: Array<[string, Record<string, unknown>]> = [['C1', { to_status: 'SUPPORTED' }], ['C2', { to_status: 'SUPPORTED', score_after: '8' }], ['C3', { to_status: 'MISSING', score_after: '5' }]];
    for (const [code, body] of plan) if (!except.includes(code)) expect((await reviewFinding(run.findings.get(code) as string, E1, body)).status).toBe(200);
  }

  /** A package with the team of three, each having declared that no conflict stands, and two proposals analysed on the approved criteria; the findings are not decided yet. */
  async function world(declared: number[] = [E1, E2, E3]): Promise<World> {
    const seeded = await seedBidPackage(harness);
    for (const member of declared) expect((await declare(member, seeded.packageId, { has_conflict: false })).status).toBe(200);
    const criteria = await seedCriteria(harness, seeded.packageId, { codes: ['C1', 'C2', 'C3'] });
    const profile = await seedAnalysisProfile(harness);
    const base = { seeded, profileId: profile.id, evaluator: { membershipId: memberId(E1), evaluate: onProjects(seeded.projectId), receive: () => ({ sql: 'false', params: [] }), now: new Date() }, member: E1 };
    return { seeded, criteriaId: criteria.id, alpha: await seedAnalysedProposal(harness, base, 'Alpha Builders', criteria.id), beta: await seedAnalysedProposal(harness, base, 'Beta Builders', criteria.id) };
  }

  const createBody = (w: World, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    package_id: w.seeded.packageId,
    criteria_version_id: w.criteriaId,
    run_ids: [w.alpha.runId, w.beta.runId],
    summary: { conclusion: CONCLUSION },
    ...over,
  });
  const create = (w: World, over: Record<string, unknown> = {}, options: { member?: number; key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/evaluation-reports', { member: options.member ?? E1, key: options.key, tenantId: options.tenantId, body: createBody(w, over) });
  const sign = async (id: string, member: number, options: { version?: number; dissent?: string; on?: RunningApp; key?: string } = {}): Promise<Reply> => {
    const version = options.version ?? Number((await stored(id)).version);
    return call('POST', `/evaluation-reports/${id}/sign-off`, { member, ifMatch: etag(version), on: options.on, key: options.key, body: options.dissent === undefined ? {} : { dissent: options.dissent } });
  };

  /** A report every member signed, waiting for DOC. */
  async function requested(): Promise<{ w: World; id: string }> {
    const w = await world();
    await decideOver(w.alpha);
    await decideOver(w.beta);
    const made = await create(w);
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    for (const member of [E1, E2, E3]) expect((await sign(id, member)).status).toBe(200);
    expect((await stored(id)).status).toBe('ISSUE_REQUESTED');
    return { w, id };
  }

  const delivery = (type: string, payload: Record<string, unknown>): OutboxDelivery => ({
    id: randomUUID(),
    tenantId: TENANT_A,
    tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
    type,
    schemaVersion: 1,
    aggregateType: 'outgoing_document',
    aggregateId: randomUUID(),
    aggregateVersion: 1,
    payload,
    eventKey: randomUUID(),
    correlationId: randomUUID(),
    attempts: 0,
  });
  const consumer = (): BidReportConsumer => new BidReportConsumer({ database: harness.tenants, security: { signingKey: SIGNING_KEY, alerts: { raise: (code, context) => void alerts.push({ code, context }) } }, metrics });
  /** A document of DOC, the minutes that DOC issued: one for each report, since one document is the minutes of one report. */
  const newDocument = async (): Promise<string> => {
    const id = randomUUID();
    await seedAs(harness, [[`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'OUTGOING', 'BB', 'Minutes', 'CONFIDENTIAL', $3, $3)`, [TENANT_A, id, memberId(1)]]]);
    return id;
  };
  const answer = (type: string, id: string, sha256: string | null, extra: Record<string, unknown> = {}): OutboxDelivery =>
    delivery(type, { tenant_id: TENANT_A, document_id: randomUUID(), actor_id: memberId(E1), occurred_at: new Date().toISOString(), source_module: 'BID', source_ref: evaluationReportSourceRef(id), payload_sha256: sha256, ...extra });
  const sentRequest = async (id: string): Promise<Record<string, unknown>> => ((await events(id, BID_REPORT_ISSUE_REQUESTED_EVENT))[0] as { payload: Record<string, unknown> }).payload;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }, { n: 2, path: `/${unitId(ROOT)}/${unitId(2)}/`, parent: ROOT }]);
    }
    for (const n of [E1, E2, E3, READER, AUTHORITY, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_EVALUATOR, ROOT);
    await harness.seedRole(TENANT_A, 1, 'BID_EVALUATOR', ['bid.evaluate'], 30);
    await harness.seedRole(TENANT_A, 2, 'BID_READER', ['bid.read'], 10);
    await harness.seedRole(TENANT_A, 3, 'BID_AUTHORITY', ['bid.conflict.decide', 'bid.read'], 40);
    await harness.seedRole(TENANT_B, 1, 'BID_EVALUATOR', ['bid.evaluate'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: E1, role: 1, kind: 'TENANT' },
      { n: 2, member: E2, role: 1, kind: 'TENANT' },
      { n: 3, member: E3, role: 1, kind: 'TENANT' },
      { n: 4, member: READER, role: 2, kind: 'TENANT' },
      { n: 5, member: AUTHORITY, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_EVALUATOR, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    // The DOC library of each tenant: the layout profile of Decree 30/2020 and the platform pack, with the template of the minutes.
    for (const tenant of [TENANT_A, TENANT_B]) await tenants.withTenant(contextFor(tenant, memberId(1)), (tx) => loadPlatformTemplates(tx, memberId(1)));
    const imports = [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })];
    const errors = { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) };
    app = await startTestApp({ signingKey: SIGNING_KEY, imports, controllers: [ReportController, ReviewController, ConflictController], providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: DOCUMENT_FILE_PORT, useValue: files }, errors] });
    appWithoutFiles = await startTestApp({ signingKey: SIGNING_KEY, imports, controllers: [ReportController], providers: [{ provide: TenantDatabase, useValue: tenants }, errors] });
  }, 300_000);

  afterEach(() => {
    alerts.length = 0;
    counted.length = 0;
    gauges.length = 0;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (appWithoutFiles) await appWithoutFiles.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of BID', () => {
    expect(bidModule.controllers).toContain(ReportController);
  });

  describe('AC-ST-BID-012-1, UAT-AC453: from the unreviewed finding to the minutes DOC issued', () => {
    it('AC-ST-BID-012-1, UAT-AC453: answers 422 UNREVIEWED_FINDINGS first, a DRAFT after the review, ISSUE_REQUESTED after the third signature and ISSUED with report_document_id after doc.issued', async () => {
      const w = await world();
      await decideOver(w.alpha);
      await decideOver(w.beta, ['C3']);
      const refused = await create(w);
      expect(refused).toMatchObject({ status: 422, json: { code: 'UNREVIEWED_FINDINGS', unreviewed_count: 1, finding_ids: [w.beta.findings.get('C3')] } });
      expect(await rows('select id from machvon.evaluation_report where package_id = $1::uuid', [w.seeded.packageId])).toEqual([]);

      expect((await reviewFinding(w.beta.findings.get('C3') as string, E1, { to_status: 'MISSING', score_after: '5' })).status).toBe(200);
      const made = await create(w, {}, { key: 'create-report-once-0001' });
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
      expect(await create(w, {}, { key: 'create-report-once-0001' })).toEqual(made);
      const id = made.json.resource_id as string;
      expect(await rows('select id from machvon.evaluation_report where package_id = $1::uuid', [w.seeded.packageId])).toHaveLength(1);
      const [drafted] = await audits(id, 'bid.report_drafted');
      expect(drafted).toMatchObject({ actor_id: memberId(E1), safe_diff: { package_code: w.seeded.packageCode, criteria_version_id: w.criteriaId, proposal_count: 2, not_covered_count: 0 } });
      const [draftedEvent] = await events(id, 'bid.report.drafted.v1');
      expect(draftedEvent?.payload).toMatchObject({ report_id: id, package_id: w.seeded.packageId, run_ids: [w.alpha.runId, w.beta.runId].sort(), actor_id: memberId(E1) });
      expect(JSON.stringify([drafted, draftedEvent])).not.toContain('tiêu chí');

      const first = await sign(id, E1);
      expect(first).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2 } });
      const second = await sign(id, E2, { dissent: DISSENT });
      expect(second).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 3 } });
      expect((await events(id, BID_REPORT_ISSUE_REQUESTED_EVENT)).length).toBe(0);
      const third = await sign(id, E3);
      expect(third).toMatchObject({ status: 200, json: { status: 'ISSUE_REQUESTED', resource_version: 5 } });

      const row = await stored(id);
      expect(row.signed_off_by.map((signature) => signature.membership_id)).toEqual([memberId(E1), memberId(E2), memberId(E3)]);
      expect(row.payload_ref).toBe(`tenants/${TENANT_A}/bid/reports/${id}/${row.payload_sha256 as string}.json`);
      // The audit rows and the events say who signed; the dissent lives in the report in the words of the member.
      const signed = await audits(id, 'bid.report_signed_off');
      expect(signed.map((entry) => [entry.actor_id, entry.safe_diff.signatures, entry.safe_diff.with_dissent, entry.safe_diff.complete])).toEqual([[memberId(E1), 1, false, false], [memberId(E2), 2, true, false], [memberId(E3), 3, false, true]]);
      expect((await events(id, 'bid.report.signed_off.v1')).map((entry) => entry.payload.status)).toEqual(['DRAFT', 'DRAFT', 'ISSUE_REQUESTED']);
      expect(JSON.stringify([signed, await events(id, 'bid.report.signed_off.v1')])).not.toContain('hợp đồng cầu');
      const request = await sentRequest(id);
      expect(request).toMatchObject({
        source_module: 'BID',
        source_ref: evaluationReportSourceRef(id),
        template_code: 'BID-BB-DANH-GIA-HSDT',
        payload_ref: row.payload_ref,
        payload_sha256: row.payload_sha256,
        event_id: row.issue_event_id,
        signer_hint: { drafting_unit_id: unitId(2) },
      });
      const payload = JSON.parse(Buffer.from((await files.get(row.payload_ref as string))?.bytes ?? new Uint8Array()).toString('utf8')) as Record<string, string>;
      expect(payload.title).toBe(`BIÊN BẢN ĐÁNH GIÁ HỒ SƠ DỰ THẦU - GÓI THẦU ${w.seeded.packageCode}`);
      expect(payload.body).toContain('Alpha Builders');
      expect(payload.body).toContain(CONCLUSION);
      expect(payload.body).toContain(DISSENT);
      expect(payload.body).toContain('User 3');

      // DOC takes the request and drafts the minutes; until it says it issued them, the module does not.
      const doc = new DocumentIssueConsumer({ database: harness.tenants, service: new DocumentIssueService(files), security: { signingKey: SIGNING_KEY } });
      expect(await doc.handle(delivery(BID_REPORT_ISSUE_REQUESTED_EVENT, request))).toBe('processed');
      const [accepted] = await rows<{ status: string; reject_code: string | null }>('select status, reject_code from machvon.doc_issue_request where source_ref = $1', [evaluationReportSourceRef(id)]);
      expect(accepted).toEqual({ status: 'ACCEPTED', reject_code: null });
      const live = await call('GET', `/evaluation-reports/${id}`, { member: E1 });
      expect(live.json).toMatchObject({ status: 'ISSUE_REQUESTED', document_status: 'DRAFT', report_document_id: null });
      const [draft] = await rows<{ document_id: string }>('select document_id from machvon.outgoing_document where source_ref = $1', [evaluationReportSourceRef(id)]);

      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, row.payload_sha256, { document_id: draft?.document_id, source_payload_sha256: row.payload_sha256, source_event_id: row.issue_event_id }))).toBe('processed');
      expect(await stored(id)).toMatchObject({ status: 'ISSUED', report_document_id: draft?.document_id });
      const done = await call('GET', `/evaluation-reports/${id}`, { member: E2 });
      expect(done.json).toMatchObject({ status: 'ISSUED', report_document_id: draft?.document_id, awaiting: [], actions: { sign_off: false } });
      expect(done.json.dissenting_opinions).toEqual([expect.objectContaining({ membership_id: memberId(E2), text: DISSENT, display_name: 'User 2' })]);
      expect(gauges.some((gauge) => gauge.name === BID_ISSUE_LATENCY_METRIC && gauge.value >= 0)).toBe(true);
      expect((await audits(id, 'bid.report_issued')).length).toBe(1);
      expect((await events(id, 'bid.report.issued.v1')).length).toBe(1);

      // What the experts decided is in the minutes: a finding of its runs is not decided again.
      expect(await reviewFinding(w.alpha.findings.get('C2') as string, E1, { to_status: 'CONTRADICTED', score_after: '1' }, 2)).toMatchObject({ status: 409, json: { code: 'REPORT_FROZEN' } });
    });

    it('refuses what the story names on the draft: the criteria of another version (422), a run that is not found (404), a conclusion that is too short (422) and a field nobody may write (400)', async () => {
      const w = await world();
      await decideOver(w.alpha);
      await decideOver(w.beta);
      const next = await seedCriteria(harness, w.seeded.packageId, { codes: ['C1', 'C2', 'C3'], revision: 2 });
      expect(await create(w, { criteria_version_id: next.id })).toMatchObject({ status: 422, json: { code: 'CRITERIA_VERSION_MISMATCH', run_ids: [w.alpha.runId, w.beta.runId].sort() } });
      expect(await create(w, { run_ids: [randomUUID()] })).toMatchObject({ status: 404 });
      expect(await create(w, { run_ids: [w.alpha.runId, w.alpha.runId] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'run_ids' } });
      expect(await create(w, { summary: { conclusion: 'too short' } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'summary' } });
      expect(await create(w, { summary: { conclusion: CONCLUSION, winner: 'Alpha Builders' } })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await create(w, { dissenting_opinions: [] })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await create(w, { status: 'ISSUED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await rows('select id from machvon.evaluation_report where package_id = $1::uuid', [w.seeded.packageId])).toEqual([]);
    });

    it('keeps the rights apart: the reader and the stranger neither make nor sign nor read a report, the member who has not declared is asked to, and another tenant finds nothing', async () => {
      const w = await world();
      await decideOver(w.alpha);
      await decideOver(w.beta);
      expect((await create(w, {}, { member: READER })).status).toBe(403);
      expect((await create(w, {}, { member: NOBODY })).status).toBe(403);
      expect(await create(w, {}, { member: B_EVALUATOR, tenantId: TENANT_B })).toMatchObject({ status: 404 });
      const made = await create(w);
      const id = made.json.resource_id as string;
      expect((await sign(id, READER, { version: 1 })).status).toBe(403);
      expect((await call('GET', `/evaluation-reports/${id}`, { member: READER })).status).toBe(403);
      expect((await call('GET', `/procurement-packages/${w.seeded.packageId}/evaluation-reports`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/evaluation-reports/${id}`, { member: B_EVALUATOR, tenantId: TENANT_B })).status).toBe(404);
      expect(await call('POST', `/evaluation-reports/${id}/sign-off`, { member: B_EVALUATOR, tenantId: TENANT_B, ifMatch: etag(1) })).toMatchObject({ status: 404 });
      // The authority that decides the conflicts is not a member of the evaluation team: it holds no right to evaluate.
      expect((await sign(id, AUTHORITY, { version: 1 })).status).toBe(403);
      expect((await stored(id)).signed_off_by).toEqual([]);
    });

    it('refuses the sign-off in the order of the story: the declaration (403), the second signature (422), the version (409) and the state of the report (409)', async () => {
      const w = await world([E1, E2]);
      await decideOver(w.alpha);
      await decideOver(w.beta);
      const id = (await create(w)).json.resource_id as string;
      // A member of the team who never declared is asked to, whatever the report says.
      expect(await sign(id, E3, { version: 1 })).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      await declare(E3, w.seeded.packageId, { has_conflict: false });
      expect((await sign(id, E1, { version: 1 })).status).toBe(200);
      expect(await sign(id, E1, { version: 2 })).toMatchObject({ status: 422, json: { code: 'ALREADY_SIGNED_OFF' } });
      expect(await sign(id, E2, { version: 1 })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT', current_version: 2 } });
      expect((await call('POST', `/evaluation-reports/${id}/sign-off`, { member: E2, body: {} })).status).toBe(428);
      expect(await sign(id, E2, { version: 2, dissent: 'short' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'dissent' } });
      expect(await sign(id, E2, { version: 2, dissent: DISSENT, key: 'sign-once-for-this-key-1' })).toMatchObject({ status: 200 });
      expect((await sign(id, E3, { version: 3 })).json).toMatchObject({ status: 'ISSUE_REQUESTED' });
      expect(await sign(id, E1, { version: 5 })).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID', report_status: 'ISSUE_REQUESTED' } });
      expect(await call('POST', `/evaluation-reports/${randomUUID()}/sign-off`, { member: E1, ifMatch: etag(1) })).toMatchObject({ status: 404 });
    });

    it('refuses 409 REPORT_OUT_OF_DATE a report whose decisions the experts took again, shows it as stale and signs a new report from what stands', async () => {
      const w = await world();
      await decideOver(w.alpha);
      await decideOver(w.beta);
      const id = (await create(w)).json.resource_id as string;
      expect((await reviewFinding(w.alpha.findings.get('C2') as string, E1, { to_status: 'CONTRADICTED', score_after: '2' }, 2)).status).toBe(200);
      expect(await sign(id, E1)).toMatchObject({ status: 409, json: { code: 'REPORT_OUT_OF_DATE' } });
      expect((await call('GET', `/evaluation-reports/${id}`, { member: E1 })).json).toMatchObject({ stale: true, actions: { sign_off: false } });
      const fresh = await create(w);
      expect(fresh.status).toBe(200);
      expect((await call('GET', `/evaluation-reports/${fresh.json.resource_id}`, { member: E1 })).json).toMatchObject({ stale: false, actions: { sign_off: true } });
    });
  });

  describe('the request to DOC', () => {
    it('undoes the signature that completes the team when the file store is not there (503 PROVIDER_UNAVAILABLE) or the template is missing from the library of DOC (422 DOC_TEMPLATE_MISSING), and takes it once they are', async () => {
      const w = await world();
      await decideOver(w.alpha);
      await decideOver(w.beta);
      const id = (await create(w)).json.resource_id as string;
      await sign(id, E1);
      await sign(id, E2);
      expect(await sign(id, E3, { on: appWithoutFiles })).toMatchObject({ status: 503, json: { code: 'PROVIDER_UNAVAILABLE' } });
      expect(await stored(id)).toMatchObject({ status: 'DRAFT', version: '3', payload_sha256: null });
      expect(await events(id, BID_REPORT_ISSUE_REQUESTED_EVENT)).toEqual([]);

      // The library of DOC loses the template after the minutes of another package were drafted with it (a draft keeps pointing at it, so it is renamed, not deleted).
      const rename = (from: string, to: string) => harness.owner(TENANT_A, [['update machvon.document_template set template_code = $2 where template_code = $1', [from, to]]]);
      await rename('BID-BB-DANH-GIA-HSDT', 'BID-BB-DANH-GIA-HSDT-GONE');
      try {
        expect(await sign(id, E3)).toMatchObject({ status: 422, json: { code: 'DOC_TEMPLATE_MISSING' } });
        expect(await stored(id)).toMatchObject({ status: 'DRAFT', version: '3' });
        expect(files.keys().filter((key) => key.includes(id))).toEqual([]);
      } finally {
        await rename('BID-BB-DANH-GIA-HSDT-GONE', 'BID-BB-DANH-GIA-HSDT');
      }
      expect(await sign(id, E3)).toMatchObject({ status: 200, json: { status: 'ISSUE_REQUESTED' } });
    });

    it('lets a member who signed confirm a team that a decision on a conflict cut down to the members who signed, and nobody else', async () => {
      const w = await world();
      await decideOver(w.alpha);
      await decideOver(w.beta);
      const id = (await create(w)).json.resource_id as string;
      await sign(id, E1);
      await sign(id, E2);
      // While E3 is awaited the members who signed are offered nothing: a second signature is refused.
      expect((await call('GET', `/evaluation-reports/${id}`, { member: E1 })).json).toMatchObject({ actions: { sign_off: false } });
      // E3 declared no conflict, so nothing can shut them out: the team is cut by taking the right to evaluate away from them.
      await harness.owner(TENANT_A, [["update machvon.role_grant set status = 'Revoked', revoked_at = now() where membership_id = $1::uuid", [memberId(E3)]]]);
      const read = await call('GET', `/evaluation-reports/${id}`, { member: E1 });
      expect(read.json).toMatchObject({ status: 'DRAFT', awaiting: [], actions: { sign_off: true } });
      const listed = await call('GET', `/procurement-packages/${w.seeded.packageId}/evaluation-reports`, { member: E2 });
      expect((listed.json.items as Array<{ id: string }>).find((item) => item.id === id)).toMatchObject({ actions: { sign_off: true } });
      expect(await sign(id, E1, { dissent: DISSENT })).toMatchObject({ status: 422, json: { code: 'ALREADY_SIGNED_OFF' } });
      expect(await sign(id, E1)).toMatchObject({ status: 200, json: { status: 'ISSUE_REQUESTED' } });
      expect((await stored(id)).signed_off_by).toHaveLength(2);
      // Completed: nothing is left to sign.
      expect((await call('GET', `/evaluation-reports/${id}`, { member: E1 })).json).toMatchObject({ status: 'ISSUE_REQUESTED', actions: { sign_off: false } });
      await harness.owner(TENANT_A, [["update machvon.role_grant set status = 'Active', revoked_at = null where membership_id = $1::uuid", [memberId(E3)]]]);
    });
  });

  describe('reading', () => {
    it('lists the reports of a package for the team, newest first, with who still has to sign; a recused member and a package of another tenant find nothing', async () => {
      const w = await world();
      await decideOver(w.alpha);
      await decideOver(w.beta);
      const first = (await create(w, { run_ids: [w.alpha.runId] })).json.resource_id as string;
      const second = (await create(w)).json.resource_id as string;
      await sign(second, E1);
      const listed = await call('GET', `/procurement-packages/${w.seeded.packageId}/evaluation-reports`, { member: E2 });
      expect(listed.status).toBe(200);
      expect(listed.json.items.map((item: any) => item.id)).toEqual([second, first]);
      expect(listed.json.items[0]).toMatchObject({ status: 'DRAFT', package: { code: w.seeded.packageCode }, actions: { sign_off: true }, version: 2 });
      expect(listed.json.items[0].signed_off_by).toEqual([expect.objectContaining({ membership_id: memberId(E1), display_name: 'User 1', dissent: false })]);
      expect(listed.json.items[0].awaiting.map((member: any) => member.membership_id).sort()).toEqual([memberId(E2), memberId(E3)].sort());
      expect(listed.json.items[0].summary.not_covered).toEqual([]);
      expect(listed.json.items[1].summary.not_covered).toEqual([expect.objectContaining({ reason: 'NOT_SELECTED' })]);
      expect(listed.json.as_of).toEqual(expect.any(String));
      expect((await call('GET', `/procurement-packages/${randomUUID()}/evaluation-reports`, { member: E1 })).status).toBe(404);
      expect((await call('GET', `/evaluation-reports/${randomUUID()}`, { member: E1 })).status).toBe(404);
    });
  });

  describe('what DOC answers', () => {
    it('keeps out an answer with another hash, raises it, and changes nothing', async () => {
      const { id } = await requested();
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, 'f'.repeat(64)))).toBe('processed');
      expect(await stored(id)).toMatchObject({ status: 'ISSUE_REQUESTED', report_document_id: null });
      expect(alerts.map((entry) => entry.code)).toEqual(['BID_REPORT_EXCEPTION']);
      expect(alerts[0]?.context).toMatchObject({ reason: 'HASH_MISMATCH' });
      expect((await audits(id, 'bid.report_exception')).length).toBe(1);
    });

    it('believes the hash the module asked for when DOC also names the hash of the draft its drafter changed, and counts the same answer twice as a duplicate', async () => {
      const { id } = await requested();
      const row = await stored(id);
      const document = await newDocument();
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, 'd'.repeat(64), { source_payload_sha256: row.payload_sha256, document_id: document }))).toBe('processed');
      expect(await stored(id)).toMatchObject({ status: 'ISSUED', report_document_id: document });
      expect(alerts).toEqual([]);
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, row.payload_sha256, { document_id: document }))).toBe('processed');
      expect(counted.filter((entry) => entry.name === BID_REPORT_EVENT_METRIC).map((entry) => entry.labels?.outcome)).toEqual(['issued', 'duplicate']);
      expect((await audits(id, 'bid.report_issued')).length).toBe(1);
    });

    it('does not let an answer for an earlier request undo the request now in hand', async () => {
      const { id } = await requested();
      const row = await stored(id);
      expect(await consumer().handle(answer(DOC_REJECTED_EVENT, id, row.payload_sha256, { reject_code: 'DOC_TEMPLATE_MISSING', source_event_id: randomUUID() }))).toBe('processed');
      expect((await stored(id)).status).toBe('ISSUE_REQUESTED');
      expect(counted.at(-1)?.labels?.outcome).toBe('stale');
    });

    it('puts the report back to SIGNED_OFF when DOC refuses, with the reason raised, and refuses to be told twice or without a reason', async () => {
      const { id } = await requested();
      const row = await stored(id);
      expect(await consumer().handle(answer(DOC_REJECTED_EVENT, id, row.payload_sha256))).toBe('processed');
      expect(alerts[0]).toMatchObject({ code: 'BID_REPORT_EXCEPTION', context: { reason: 'REASON_MISSING' } });
      expect((await stored(id)).status).toBe('ISSUE_REQUESTED');
      alerts.length = 0;
      expect(await consumer().handle(answer(DOC_REJECTED_EVENT, id, row.payload_sha256, { reject_code: 'TEMPLATE_NOT_EFFECTIVE', source_event_id: row.issue_event_id }))).toBe('processed');
      expect(await stored(id)).toMatchObject({ status: 'SIGNED_OFF' });
      expect((await stored(id)).signed_off_by).toHaveLength(3);
      expect(alerts).toEqual([{ code: 'BID_REPORT_ISSUE_REJECTED', context: { tenantId: TENANT_A, reportId: id, rejectCode: 'TEMPLATE_NOT_EFFECTIVE' } }]);
      expect((await audits(id, 'bid.report_issue_rejected'))[0]?.safe_diff).toMatchObject({ reject_code: 'TEMPLATE_NOT_EFFECTIVE' });
      expect(await consumer().handle(answer(DOC_REJECTED_EVENT, id, row.payload_sha256, { reject_code: 'TEMPLATE_NOT_EFFECTIVE' }))).toBe('processed');
      expect(counted.at(-1)?.labels?.outcome).toBe('duplicate');
      // An issue that comes after the refusal does not fit the state of the report.
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, row.payload_sha256))).toBe('processed');
      expect(alerts.at(-1)).toMatchObject({ code: 'BID_REPORT_EXCEPTION', context: { reason: 'STATE_UNEXPECTED' } });
      expect((await stored(id)).status).toBe('SIGNED_OFF');
    });

    it('answers an issue without the document with an exception, and marks the minutes recalled once, raising it', async () => {
      const { id } = await requested();
      const row = await stored(id);
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, row.payload_sha256, { document_id: 'not-an-id' }))).toBe('processed');
      expect(alerts[0]).toMatchObject({ code: 'BID_REPORT_EXCEPTION', context: { reason: 'DOCUMENT_MISSING' } });
      // A recall that comes before the issue is out of order: the delivery fails and is tried again.
      await expect(consumer().handle(answer(DOC_RECALLED_EVENT, id, row.payload_sha256))).rejects.toThrow(/tried again later/);
      alerts.length = 0;
      await consumer().handle(answer(DOC_ISSUED_EVENT, id, row.payload_sha256, { document_id: await newDocument() }));
      expect(await consumer().handle(answer(DOC_RECALLED_EVENT, id, row.payload_sha256))).toBe('processed');
      expect((await stored(id)).recalled_at).not.toBeNull();
      expect(alerts).toEqual([{ code: 'BID_REPORT_RECALLED', context: { tenantId: TENANT_A, reportId: id } }]);
      expect(await consumer().handle(answer(DOC_RECALLED_EVENT, id, row.payload_sha256))).toBe('processed');
      expect(counted.at(-1)?.labels?.outcome).toBe('duplicate');
      expect((await audits(id, 'bid.report_recalled')).length).toBe(1);
    });

    it('supersedes the minutes issued before for the package when the next ones are issued, with its own audit row and event, once', async () => {
      const first = await requested();
      const firstRow = await stored(first.id);
      await consumer().handle(answer(DOC_ISSUED_EVENT, first.id, firstRow.payload_sha256, { document_id: await newDocument() }));
      expect((await stored(first.id)).status).toBe('ISSUED');
      // A later report of the same package: made from the run of a third proposal, since the findings of the first are frozen.
      const gamma = await seedAnalysedProposal(
        harness,
        { seeded: first.w.seeded, profileId: (await seedAnalysisProfile(harness)).id, evaluator: { membershipId: memberId(E1), evaluate: onProjects(first.w.seeded.projectId), receive: () => ({ sql: 'false', params: [] }), now: new Date() }, member: E1 },
        'Gamma Builders',
        first.w.criteriaId,
      );
      await decideOver(gamma);
      const second = (await create(first.w, { run_ids: [gamma.runId] })).json.resource_id as string;
      for (const member of [E1, E2, E3]) expect((await sign(second, member)).status).toBe(200);
      const secondRow = await stored(second);
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, second, secondRow.payload_sha256, { document_id: await newDocument() }))).toBe('processed');
      expect((await stored(first.id)).status).toBe('SUPERSEDED');
      expect((await stored(second)).status).toBe('ISSUED');
      expect((await audits(first.id, 'bid.report_superseded'))[0]?.safe_diff).toMatchObject({ superseded_by: second, package_id: first.w.seeded.packageId });
      expect((await events(first.id, 'bid.report.superseded.v1')).length).toBe(1);
    });

    it('leaves alone what is not about an evaluation report: another module, another event, a reference nobody knows, a report of no tenant', async () => {
      const { id } = await requested();
      const row = await stored(id);
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, row.payload_sha256, { source_module: 'MNE' }))).toBe('ignored');
      expect(await consumer().handle(delivery('doc.something.v1', { source_module: 'BID', source_ref: evaluationReportSourceRef(id) }))).toBe('ignored');
      expect(await consumer().handle({ ...answer(DOC_ISSUED_EVENT, id, row.payload_sha256), schemaVersion: 2 })).toBe('ignored');
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, row.payload_sha256, { source_ref: 'BID:evaluation_report:nope' }))).toBe('ignored');
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, randomUUID(), row.payload_sha256))).toBe('processed');
      expect(counted.map((entry) => entry.labels?.outcome)).toEqual(['unknown', 'unknown']);
      expect((await stored(id)).status).toBe('ISSUE_REQUESTED');
      expect(new BidReportConsumer({ database: harness.tenants, security: { signingKey: SIGNING_KEY } }).name).toBe(BID_REPORT_CONSUMER);
    });
  });
});
