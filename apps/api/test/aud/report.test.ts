import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { DomainError, loadErrorRegistry, payloadSha256, reportSourceRef, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { audModule } from '../../src/modules/aud';
import { AuditEngagementController } from '../../src/modules/aud/engagement.controller';
import { AuditReportController, AuditReportReadsController } from '../../src/modules/aud/report.controller';
import { DOC_ISSUED_EVENT, ReportConsumer } from '../../src/modules/aud/report.consumer';
import { DOCUMENT_FILE_PORT, MockDocumentFilePort } from '../../src/modules/doc/file-port';
import { DocumentIssueConsumer } from '../../src/modules/doc/issue-consumer';
import { DocumentIssueService } from '../../src/modules/doc/issue-request.service';
import { fillPlaceholders } from '../../src/modules/doc/template-render';
import { loadPlatformTemplates, loadTemplatePack } from '../../src/modules/doc/template-pack';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const REPORTER = 1; // aud.report.issue and aud.read over the whole tenant
const CLOSER = 2; // aud.engagement.close and aud.read over the whole tenant
const READER = 3; // aud.read over the whole tenant
const OUTSIDER = 4; // report, close and read over another branch, where the engagement is not
const NOBODY = 5;
const SIGNER = 6;
const B_REPORTER = 1; // of tenant B, which has no template
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x9b;
const DECISION = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 11);

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

interface Seeded {
  engagementId: string;
  conclusionId: string;
  recommendations: string[];
}

interface RecommendationSeed {
  type?: string;
  amount?: string | null;
  closed?: boolean;
  recovered?: string;
}

/** The report of the results of the recommendations and the closure of the engagement over HTTP (ST-AUD-005, AUD-10, UAT-AC440). */
describe('the follow-up report and the closure over HTTP (ST-AUD-005, AUD-10)', () => {
  const harness = new AuthzHarness();
  const files = new MockDocumentFilePort();
  let app: RunningApp;
  let counter = 0;
  const today = vietnamDateOf(new Date());

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // The documents belong to another module: the superuser seeds them with the foreign keys switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** An engagement that is followed up, its conclusion, the units it is about, and the recommendations asked for (closed ones walk through the states as the system would). */
  async function seed(items: RecommendationSeed[], options: { units?: number; tenant?: string; status?: string; conclusionStatus?: string } = {}): Promise<Seeded> {
    counter += 1;
    const tenant = options.tenant ?? TENANT_A;
    const engagementId = randomUUID();
    const conclusionId = randomUUID();
    await rows(
      `insert into machvon.audit_engagement (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on, classification, created_by, updated_by, version)
       values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'State Audit Office', $4, 'Audit of the bridge', date '2025-01-01', date '2025-12-31', $5, $6, date '2026-10-01', 'CONFIDENTIAL', $5, $5, 3)`,
      [tenant, engagementId, `RP-${counter}`, DECISION, memberId(REPORTER), options.status ?? 'FOLLOW_UP'],
      tenant,
    );
    const units = [DEPARTMENT, ELSEWHERE].slice(0, options.units ?? 1);
    for (const unit of units) {
      await rows("insert into machvon.audit_scope_item (tenant_id, id, engagement_id, scope_kind, organization_unit_id, added_by) values ($1, gen_random_uuid(), $2, 'UNIT', $3, $4)", [tenant, engagementId, unitId(unit), memberId(REPORTER)], tenant);
    }
    await rows(
      `insert into machvon.audit_conclusion (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, summary, total_financial_vnd, status, created_by, updated_by, version)
       values ($1, $2, $3, 'AUDIT_REPORT', $4, 1, date '2026-10-10', date '2026-10-15', 'The audit found payments above the approved volumes.', 5000000000, $6, $5, $5, 1)`,
      [tenant, conclusionId, engagementId, DECISION, memberId(REPORTER), options.conclusionStatus ?? 'RECEIVED'],
      tenant,
    );
    const recommendations: string[] = [];
    for (const [index, item] of items.entries()) {
      const recommendationId = randomUUID();
      recommendations.push(recommendationId);
      const amount = item.amount === undefined ? '500000000' : item.amount;
      await rows(
        `insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, status, created_by, updated_by, version)
         values ($1, $2, $3, $4, $5, 'Recover what was paid above the volume.', $6::numeric, 'OPEN', $7, $7, 1)`,
        [tenant, recommendationId, conclusionId, `R-${counter}-${index + 1}`, item.type ?? 'FINANCIAL_RECOVERY', amount, memberId(REPORTER)],
        tenant,
      );
      await rows("update machvon.audit_recommendation set status = 'ASSIGNED', owner_unit_id = $2, due_on = date '2026-12-01' where id = $1", [recommendationId, unitId(DEPARTMENT)], tenant);
      await rows("update machvon.audit_recommendation set status = 'IN_PROGRESS' where id = $1", [recommendationId], tenant);
      if (item.recovered !== undefined) {
        await rows(
          `insert into machvon.audit_recovery_link (tenant_id, id, recommendation_id, source_kind, source_id, amount_vnd, recorded_on, recorded_by)
           values ($1, gen_random_uuid(), $2::uuid, 'PAY_RECOVERY', gen_random_uuid(), $3::numeric, current_date, $4::uuid)`,
          [tenant, recommendationId, item.recovered, memberId(REPORTER)],
          tenant,
        );
      }
      if (item.closed === true) await close(recommendationId);
    }
    return { engagementId, conclusionId, recommendations };
  }

  const close = async (recommendationId: string): Promise<void> => {
    await rows("update machvon.audit_recommendation set status = 'PENDING_VERIFICATION', submitted_by = $2 where id = $1", [recommendationId, memberId(SIGNER)]);
    await rows("update machvon.audit_recommendation set status = 'CLOSED', verified_by = $2, verified_at = now() where id = $1", [recommendationId, memberId(CLOSER)]);
  };

  /** The three recommendations of the acceptance criterion: R1 and R3 closed and recovered in full, R2 in progress with 300,000,000 of 400,000,000. */
  const threeRecommendations = (): RecommendationSeed[] => [
    { amount: '500000000', recovered: '500000000', closed: true },
    { amount: '400000000', recovered: '300000000' },
    { amount: '300000000', recovered: '300000000', closed: true },
  ];

  const version = async (engagementId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.audit_engagement where id = $1', [engagementId]))[0]?.version);
  const request = async (engagementId: string, conclusionId: string, extra: Record<string, unknown> = {}, member = REPORTER, options: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/audit-engagements/${engagementId}/follow-up-reports`, {
      member,
      ifMatch: `"${await version(engagementId)}"`,
      body: { conclusion_id: conclusionId, as_of_date: today, ...extra },
      ...options,
    });
  const closure = async (engagementId: string, member = CLOSER, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/audit-engagements/${engagementId}/closure`, { member, ifMatch: `"${await version(engagementId)}"`, body: { on_date: today, ...extra }, ...options });
  const reportRow = async (reportId: string) =>
    (
      await rows<{ status: string; revision: number; totals: Record<string, unknown>; payload_sha256: string; payload_ref: string; drafting_unit_id: string; issue_event_id: string }>(
        'select status, revision, totals_json as totals, payload_sha256, payload_ref, drafting_unit_id, issue_event_id from machvon.audit_follow_up_report where id = $1',
        [reportId],
      )
    )[0] as { status: string; revision: number; totals: Record<string, unknown>; payload_sha256: string; payload_ref: string; drafting_unit_id: string; issue_event_id: string };
  const trail = (resourceId: string) => rows<{ action: string; classification: string; safe_diff: Record<string, unknown> }>('select action, classification, safe_diff from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [resourceId]);
  const events = (aggregateId: string) => rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id::text = $1 order by created_at, id', [aggregateId]);

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
  /** What DOC says when it has issued the document of a report: the reference and the hash it was asked for. */
  const issuedBy = (reportId: string, revision: number, sha256: string, signer = SIGNER): OutboxDelivery =>
    delivery(DOC_ISSUED_EVENT, { tenant_id: TENANT_A, document_id: DOCUMENT, actor_id: memberId(signer), occurred_at: new Date().toISOString(), source_module: 'AUD', source_ref: reportSourceRef(reportId, revision), payload_sha256: sha256 });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [REPORTER, CLOSER, READER, OUTSIDER, NOBODY, SIGNER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_REPORTER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'AUD_REPORTER', ['aud.report.issue', 'aud.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'AUD_CLOSER', ['aud.engagement.close', 'aud.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'AUD_READER', ['aud.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'AUD_ALL', ['aud.report.issue', 'aud.engagement.close', 'aud.read'], 30);
    await harness.seedRole(TENANT_B, 1, 'AUD_REPORTER', ['aud.report.issue', 'aud.read'], 30);
    await harness.seedRole(TENANT_B, 2, 'AUD_CLOSER', ['aud.engagement.close', 'aud.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: REPORTER, role: 1, kind: 'TENANT' },
      { n: 2, member: CLOSER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: OUTSIDER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [
      { n: 1, member: B_REPORTER, role: 1, kind: 'TENANT' },
      { n: 2, member: B_REPORTER, role: 2, kind: 'TENANT' },
    ]);
    await seedAs([
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Conclusion of the audit of the bridge', '12/KL-KTNN', '2026-10-10', 'EFFECTIVE', 'INTERNAL', $4, $4),
                ($1, $3, 'REFERENCE', 'BC', 'The report DOC issued', '07/BC-UBND', '2026-10-26', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [TENANT_A, DECISION, DOCUMENT, memberId(REPORTER)],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Conclusion of the audit of the bridge', '12/KL-KTNN', '2026-10-10', 'EFFECTIVE', 'INTERNAL', $3, $3)`,
        [TENANT_B, DECISION, memberId(B_REPORTER)],
      ],
    ]);
    // Tenant A has the platform templates, as a provisioned tenant has; tenant B has none.
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(REPORTER), scopeVersion: 1 }, (tx) => loadPlatformTemplates(tx, memberId(REPORTER)));
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AuditReportController, AuditReportReadsController, AuditEngagementController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DOCUMENT_FILE_PORT, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('serves the controllers of the report in the module of AUD', () => {
    const at = audModule.controllers.indexOf(AuditReportController);
    expect(audModule.controllers.slice(at, at + 2)).toEqual([AuditReportController, AuditReportReadsController]);
  });

  describe('requestAuditFollowUpReport', () => {
    it('AC-ST-AUD-005-1 / UAT-AC440: R1 and R3 closed and R2 in progress give a report ISSUE_REQUESTED with closed 2, in progress 1, 1,200,000,000 recommended and 1,100,000,000 recovered, and a hash of the payload that is in the file store', async () => {
      const made = await seed(threeRecommendations());
      const reply = await request(made.engagementId, made.conclusionId);
      expect(reply).toMatchObject({ status: 200, json: { status: 'ISSUE_REQUESTED', resource_version: 1 } });
      const row = await reportRow(idOf(reply));
      expect(row).toMatchObject({ status: 'ISSUE_REQUESTED', revision: 1, drafting_unit_id: unitId(DEPARTMENT) });
      expect(row.totals).toMatchObject({ as_of_date: today, total: 3, closed: 2, in_progress: 1, open: 0, disputed: 0, amount: '1200000000', recovered: '1100000000', remaining: '100000000' });
      expect(row.totals.money_rate).toEqual({ numerator: '1100000000', denominator: '1200000000', percent: '91.67' });
      // The payload DOC will read is in the file store under the tenant, and its hash is the one frozen with the report.
      const stored = await files.get(row.payload_ref);
      expect(row.payload_ref).toBe(`tenants/${TENANT_A}/aud/follow-up-reports/${idOf(reply)}/r1.json`);
      expect(payloadSha256(JSON.parse(Buffer.from(stored?.bytes ?? new Uint8Array()).toString('utf8')))).toBe(row.payload_sha256);
      expect(JSON.parse(Buffer.from(stored?.bytes ?? new Uint8Array()).toString('utf8'))).toMatchObject({ engagement_code: `RP-${counter}`, recommendations_closed: '2', recommended_vnd: '1.200.000.000', recovered_vnd: '1.100.000.000' });
      // The request to DOC is the event, with the reference DOC will name the report by.
      const [event] = (await events(idOf(reply))).filter((entry) => entry.type === 'aud.report.issue_requested.v1');
      expect(event?.payload).toMatchObject({
        tenant_id: TENANT_A,
        source_module: 'AUD',
        source_ref: reportSourceRef(idOf(reply), 1),
        template_code: 'AUD-BC-KET-QUA-THUC-HIEN-KIEN-NGHI',
        payload_ref: row.payload_ref,
        payload_sha256: row.payload_sha256,
        event_id: row.issue_event_id,
        as_of_date: today,
        signer_hint: { drafting_unit_id: unitId(DEPARTMENT) },
        recipients: [{ kind: 'EXTERNAL_AGENCY', name: 'State Audit Office' }],
      });
      expect((await trail(idOf(reply)))[0]).toMatchObject({ action: 'aud.report_requested', classification: 'CONFIDENTIAL', safe_diff: { as_of_date: today, revision: 1, payload_sha256: row.payload_sha256, recommendations_total: 3 } });
      // The audit trail and the event carry the hash and the counts, not the words of the engagement.
      expect(JSON.stringify([await trail(idOf(reply)), await events(idOf(reply))])).not.toContain('Audit of the bridge');
    });

    it('is understood by DOC: the same event makes one draft of the template with the figures filled in, and the reference of the report', async () => {
      const made = await seed(threeRecommendations());
      const reply = await request(made.engagementId, made.conclusionId);
      const [event] = (await events(idOf(reply))).filter((entry) => entry.type === 'aud.report.issue_requested.v1');
      const docConsumer = new DocumentIssueConsumer({ database: harness.tenants, service: new DocumentIssueService(files), security: { signingKey: SIGNING_KEY } });
      expect(await docConsumer.handle(delivery('aud.report.issue_requested.v1', event?.payload as Record<string, unknown>))).toBe('processed');
      const [accepted] = await rows<{ status: string; source_module: string; reject_code: string | null }>('select status, source_module, reject_code from machvon.doc_issue_request where source_ref = $1', [reportSourceRef(idOf(reply), 1)]);
      expect(accepted).toEqual({ status: 'ACCEPTED', source_module: 'AUD', reject_code: null });
      const [draft] = await rows<{ title: string; source_ref: string }>('select d.title, o.source_ref from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where o.source_ref = $1', [reportSourceRef(idOf(reply), 1)]);
      expect(draft).toEqual({ title: 'Audit of the bridge', source_ref: reportSourceRef(idOf(reply), 1) });
      // DOC answers with the reference and the hash, and AUD moves the report: the whole road of the acceptance criterion.
      const row = await reportRow(idOf(reply));
      const answered = await new ReportConsumer({ database: harness.tenants, security: { signingKey: SIGNING_KEY } }).handle(issuedBy(idOf(reply), 1, row.payload_sha256));
      expect(answered).toBe('processed');
      expect((await reportRow(idOf(reply))).status).toBe('ISSUED');
    });

    it('puts the drafting unit as the agency and the place the caller says in the head of the report, and a dash when nobody said it', async () => {
      const made = await seed(threeRecommendations());
      const [unit] = await rows<{ name: string }>('select name from machvon.organization_unit where id = $1', [unitId(DEPARTMENT)]);
      const sent = async (reply: Reply) => JSON.parse(Buffer.from((await files.get((await reportRow(idOf(reply))).payload_ref))?.bytes ?? new Uint8Array()).toString('utf8')) as Record<string, unknown>;
      const said = await request(made.engagementId, made.conclusionId, { place: ' Cao Bằng ' });
      expect(await sent(said)).toMatchObject({ agency: unit?.name, place: 'Cao Bằng' });
      const other = await seed(threeRecommendations());
      expect(await sent(await request(other.engagementId, other.conclusionId))).toMatchObject({ agency: unit?.name, place: '-' });
      expect(await request(other.engagementId, other.conclusionId, { place: 'x'.repeat(101) })).toMatchObject({ status: 422 });
    });

    it('fills every placeholder of the template of the library from the payload it sends', async () => {
      const made = await seed(threeRecommendations());
      const reply = await request(made.engagementId, made.conclusionId);
      const row = await reportRow(idOf(reply));
      const payload = JSON.parse(Buffer.from((await files.get(row.payload_ref))?.bytes ?? new Uint8Array()).toString('utf8')) as Record<string, unknown>;
      const template = loadTemplatePack().templates.find((candidate) => candidate.templateCode === 'AUD-BC-KET-QUA-THUC-HIEN-KIEN-NGHI');
      expect(template).toMatchObject({ groupCode: 'AUDIT_FOLLOWUP', sourceModule: 'AUD', docTypeCode: 'BC' });
      const blocks = fillPlaceholders(template?.bodyBlocks as never, payload, template?.placeholderSchema as never);
      const text = blocks.map((block) => block.text).join('\n');
      expect(text).not.toMatch(/\{\{|undefined/);
      expect(text).toContain('đã hoàn thành: 2');
      expect(text).toContain('số tiền kiến nghị 1.200.000.000 đồng; đã thu hồi 1.100.000.000 đồng; còn phải thu hồi 100.000.000 đồng; tỷ lệ thu hồi: 91,67%');
    });

    it('freezes the figures: what happens to the recommendations afterwards does not change the report', async () => {
      const made = await seed(threeRecommendations());
      const reply = await request(made.engagementId, made.conclusionId);
      await close(made.recommendations[1] as string);
      const row = await reportRow(idOf(reply));
      expect(row.totals).toMatchObject({ closed: 2, in_progress: 1 });
      const later = await request(made.engagementId, made.conclusionId, { as_of_date: today }, REPORTER);
      expect(later).toMatchObject({ status: 409, json: { code: 'FOLLOW_UP_REPORT_EXISTS', report_id: idOf(reply), revision: 1, report_status: 'ISSUE_REQUESTED' } });
    });

    it('asks again after DOC rejected it: the next revision of the same day, with the figures as they are now (AC-ST-AUD-005-2)', async () => {
      const made = await seed(threeRecommendations());
      const first = await request(made.engagementId, made.conclusionId);
      const row = await reportRow(idOf(first));
      await new ReportConsumer({ database: harness.tenants, security: { signingKey: SIGNING_KEY } }).handle(
        delivery('doc.rejected.v1', { source_module: 'AUD', source_ref: reportSourceRef(idOf(first), 1), payload_sha256: row.payload_sha256, reject_code: 'PAYLOAD_SCHEMA_INVALID' }),
      );
      expect((await reportRow(idOf(first))).status).toBe('REJECTED');
      await close(made.recommendations[1] as string);
      const second = await request(made.engagementId, made.conclusionId);
      expect(second.status).toBe(200);
      expect(await reportRow(idOf(second))).toMatchObject({ revision: 2, status: 'ISSUE_REQUESTED' });
      expect((await reportRow(idOf(second))).totals).toMatchObject({ closed: 3, in_progress: 0 });
      expect((await reportRow(idOf(second))).payload_ref).toBe(`tenants/${TENANT_A}/aud/follow-up-reports/${idOf(second)}/r2.json`);
    });

    it('answers a replay with the first body and writes one report', async () => {
      const made = await seed(threeRecommendations());
      const options = { key: 'report-replay-key-0001', ifMatch: `"${await version(made.engagementId)}"` };
      const first = await request(made.engagementId, made.conclusionId, {}, REPORTER, options);
      const again = await request(made.engagementId, made.conclusionId, {}, REPORTER, options);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(again.json).toEqual(first.json);
      expect(await rows('select id from machvon.audit_follow_up_report where engagement_id = $1', [made.engagementId])).toHaveLength(1);
    });

    it('names the drafting unit when the engagement is about more than one, and refuses one that is not in the tenant', async () => {
      const made = await seed(threeRecommendations(), { units: 2 });
      expect(await request(made.engagementId, made.conclusionId)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await request(made.engagementId, made.conclusionId, { drafting_unit_id: randomUUID() })).toMatchObject({ status: 404 });
      const named = await request(made.engagementId, made.conclusionId, { drafting_unit_id: unitId(ELSEWHERE) });
      expect(named.status).toBe(200);
      expect((await reportRow(idOf(named))).drafting_unit_id).toBe(unitId(ELSEWHERE));
      const none = await seed(threeRecommendations(), { units: 0 });
      expect(await request(none.engagementId, none.conclusionId)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    });

    it('refuses what cannot be reported: a day to come, a day before the conclusion was received, a conclusion of another engagement or that was replaced, an engagement that is not being followed up', async () => {
      const made = await seed(threeRecommendations());
      for (const day of ['2999-01-01', '2026-10-14']) {
        expect(await request(made.engagementId, made.conclusionId, { as_of_date: day })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      }
      const other = await seed(threeRecommendations());
      expect(await request(made.engagementId, other.conclusionId)).toMatchObject({ status: 404 });
      expect(await request(made.engagementId, randomUUID())).toMatchObject({ status: 404 });
      const replaced = await seed([], { conclusionStatus: 'SUPERSEDED' });
      expect(await request(replaced.engagementId, replaced.conclusionId)).toMatchObject({ status: 409, json: { code: 'CONCLUSION_REVISION_INVALID' } });
      const ended = await seed([], { status: 'ONGOING' });
      expect(await request(ended.engagementId, ended.conclusionId)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
      expect(await request(made.engagementId, made.conclusionId, { status: 'ISSUED' })).toMatchObject({ status: 400 });
      expect(await request(made.engagementId, made.conclusionId, {}, REPORTER, { ifMatch: '"1"' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await rows('select id from machvon.audit_follow_up_report where engagement_id = $1', [made.engagementId])).toHaveLength(0);
    });

    it('says the template is missing when the library of the tenant has none (422 DOC_TEMPLATE_MISSING)', async () => {
      const made = await seed(threeRecommendations(), { tenant: TENANT_B });
      const reply = await call('POST', `/audit-engagements/${made.engagementId}/follow-up-reports`, {
        member: B_REPORTER,
        tenantId: TENANT_B,
        ifMatch: '"3"',
        body: { conclusion_id: made.conclusionId, as_of_date: today },
      });
      expect(reply).toMatchObject({ status: 422, json: { code: 'DOC_TEMPLATE_MISSING' } });
    });

    it('says the file store of DOC is not bound when the application has none (503 PROVIDER_UNAVAILABLE)', async () => {
      const controller = new AuditReportController();
      await expect(controller.request({} as never, {} as never, randomUUID(), { conclusion_id: randomUUID(), as_of_date: today })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
      expect(new DomainError('PROVIDER_UNAVAILABLE', 503)).toBeInstanceOf(DomainError);
    });

    it('is for a person who may issue reports and sees the engagement: a reader and nobody are 403, another branch and another tenant are 404', async () => {
      const made = await seed(threeRecommendations());
      expect((await request(made.engagementId, made.conclusionId, {}, READER)).status).toBe(403);
      expect((await request(made.engagementId, made.conclusionId, {}, CLOSER)).status).toBe(403);
      expect((await request(made.engagementId, made.conclusionId, {}, NOBODY)).status).toBe(403);
      expect((await request(made.engagementId, made.conclusionId, {}, OUTSIDER)).status).toBe(404);
      expect((await request(made.engagementId, made.conclusionId, {}, B_REPORTER, { tenantId: TENANT_B, ifMatch: '"3"' })).status).toBe(404);
      expect(await rows('select id from machvon.audit_follow_up_report where engagement_id = $1', [made.engagementId])).toHaveLength(0);
    });
  });

  describe('closeAuditEngagement', () => {
    it('AC-ST-AUD-005-1 / UAT-AC440: refuses to close while R2 is open even after the report is issued, then needs the report, then closes', async () => {
      const made = await seed(threeRecommendations());
      const reply = await request(made.engagementId, made.conclusionId);
      const row = await reportRow(idOf(reply));
      await new ReportConsumer({ database: harness.tenants, security: { signingKey: SIGNING_KEY } }).handle(issuedBy(idOf(reply), 1, row.payload_sha256));
      expect((await reportRow(idOf(reply))).status).toBe('ISSUED');
      expect(await closure(made.engagementId)).toMatchObject({ status: 409, json: { code: 'OPEN_RECOMMENDATIONS_REMAIN', open_recommendations: 1 } });
      await close(made.recommendations[1] as string);
      const done = await closure(made.engagementId);
      expect(done).toMatchObject({ status: 200, json: { status: 'CLOSED', resource_id: made.engagementId } });
      expect(await rows('select status, closed_on::text as closed_on from machvon.audit_engagement where id = $1', [made.engagementId])).toEqual([{ status: 'CLOSED', closed_on: today }]);
      const [event] = (await events(made.engagementId)).filter((entry) => entry.type === 'aud.engagement.closed.v1');
      expect(event?.payload).toMatchObject({ engagement_id: made.engagementId, closed_on: today, legal_hold_released: false });
      expect((await trail(made.engagementId)).find((entry) => entry.action === 'aud.engagement_closed')).toMatchObject({ classification: 'CONFIDENTIAL', safe_diff: { from_status: 'FOLLOW_UP', to_status: 'CLOSED', on_date: today } });
      expect(await closure(made.engagementId)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
      expect(await closure(made.engagementId, CLOSER, {}, { ifMatch: '"1"' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    });

    it('needs a report that DOC issued: one that was only requested, or rejected, is not enough (422 FOLLOW_UP_REPORT_MISSING)', async () => {
      const made = await seed([{ amount: '500000000', recovered: '500000000', closed: true }]);
      expect(await closure(made.engagementId)).toMatchObject({ status: 422, json: { code: 'FOLLOW_UP_REPORT_MISSING', conclusions_without_report: 1 } });
      const reply = await request(made.engagementId, made.conclusionId);
      expect(await closure(made.engagementId)).toMatchObject({ status: 422, json: { code: 'FOLLOW_UP_REPORT_MISSING' } });
      expect((await rows<{ status: string }>('select status from machvon.audit_engagement where id = $1', [made.engagementId]))[0]?.status).toBe('FOLLOW_UP');
      expect(idOf(reply)).toBeTruthy();
    });

    it('closes on a day from the start to today, refuses another (422), and is for the person who may close: a reader is 403, another branch and another tenant 404', async () => {
      const made = await seed([{ amount: '500000000', recovered: '500000000', closed: true }]);
      const reply = await request(made.engagementId, made.conclusionId);
      await new ReportConsumer({ database: harness.tenants, security: { signingKey: SIGNING_KEY } }).handle(issuedBy(idOf(reply), 1, (await reportRow(idOf(reply))).payload_sha256));
      for (const day of ['2999-01-01', '2026-09-30']) {
        expect(await closure(made.engagementId, CLOSER, { on_date: day })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      }
      expect((await closure(made.engagementId, READER)).status).toBe(403);
      expect((await closure(made.engagementId, REPORTER)).status).toBe(403);
      expect((await closure(made.engagementId, OUTSIDER)).status).toBe(404);
      expect((await closure(made.engagementId, B_REPORTER, {}, { tenantId: TENANT_B })).status).toBe(404);
      expect((await closure(made.engagementId, CLOSER, { reason: 'x'.repeat(2001) })).status).toBe(422);
      expect(await closure(made.engagementId)).toMatchObject({ status: 200 });
    });

    it('does not close an engagement that is not being followed up (409 ENGAGEMENT_STATE_INVALID)', async () => {
      const made = await seed([], { status: 'ONGOING' });
      expect(await closure(made.engagementId)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
    });
  });

  describe('listAuditFollowUpReports', () => {
    it('lists the reports of an engagement with the frozen figures, the hash, the status and who asked, for a reader of the engagement', async () => {
      const made = await seed(threeRecommendations());
      const reply = await request(made.engagementId, made.conclusionId);
      const listed = await call('GET', `/audit-engagements/${made.engagementId}/follow-up-reports`, { member: READER });
      expect(listed.status).toBe(200);
      const [item] = listed.json.items as Array<Record<string, unknown>>;
      expect(item).toMatchObject({
        id: idOf(reply),
        conclusion_id: made.conclusionId,
        conclusion_symbol: '12/KL-KTNN',
        as_of_date: today,
        revision: 1,
        status: 'ISSUE_REQUESTED',
        source_ref: reportSourceRef(idOf(reply), 1),
        report_document_id: null,
        reject_code: null,
        approved_by: null,
        issued_at: null,
        requested_by: { id: memberId(REPORTER) },
        version: 1,
      });
      expect(item?.totals).toMatchObject({ closed: 2, amount: '1200000000' });
      expect(item?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is not found for a branch that does not see the engagement, another tenant, or an engagement that is not there', async () => {
      const made = await seed(threeRecommendations());
      expect((await call('GET', `/audit-engagements/${made.engagementId}/follow-up-reports`, { member: OUTSIDER })).status).toBe(404);
      expect((await call('GET', `/audit-engagements/${made.engagementId}/follow-up-reports`, { member: B_REPORTER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/audit-engagements/${randomUUID()}/follow-up-reports`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/audit-engagements/${made.engagementId}/follow-up-reports`, { member: NOBODY })).status).toBe(403);
    });
  });
});
