import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { mneReportSourceRef, signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { DOC_ISSUED_EVENT, DOC_RECALLED_EVENT, DOC_REJECTED_EVENT } from '../../src/modules/aud/report.consumer';
import { DocumentIssueConsumer } from '../../src/modules/doc/issue-consumer';
import { DocumentIssueService } from '../../src/modules/doc/issue-request.service';
import { MneReportConsumer } from '../../src/modules/mne/report.consumer';
import { ADMIN, APPROVER, INVESTORS, MneApp, PREPARER, PREPARER_REVIEWER, READER, REVIEWER, SIGNING_KEY, TENANT_A, memberId, unitId } from './mne-app';
import type { Reply } from './mne-app';

jest.setTimeout(120_000);

const app = new MneApp();
const etag = (version: number): string => `"${version}"`;
const UNIT = INVESTORS[0];
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';

const FIELDS = [
  { key: 'plan_total', label: 'Plan', kind: 'MONEY', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' } },
  { key: 'rate_total', label: 'Rate', kind: 'PERCENT', required: false, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_total_pct' } },
  { key: 'assessment', label: 'Assessment', kind: 'TEXT', required: true },
];

const formBody = (formCode: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  form_code: formCode,
  title: 'Overall report',
  report_kind: 'OVERALL_SEMIANNUAL',
  legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
  effective_from: '2026-01-01',
  schema_json: { fields: FIELDS },
  doc_template_code: 'MNE-TT44-M02',
  export_formats: ['XLSX'],
  ...overrides,
});

async function publishedForm(formCode: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody(formCode, overrides) });
  expect(created.status).toBe(200);
  expect((await app.call('POST', `/mne-forms/${created.json.resource_id as string}/publish`, { member: APPROVER, ifMatch: etag(1) })).status).toBe(200);
  return created.json.resource_id as string;
}

async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: app.harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let counter = 0;
/** A project of the unit and a frozen snapshot of 2026-06-30 in which it holds a plan of 1250 billion and 600 billion paid. */
async function frozenSnapshot(): Promise<string> {
  counter += 1;
  const projectId = randomUUID();
  const snapshotId = randomUUID();
  const periodId = randomUUID();
  await seed([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, 'Bridge', $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, projectId, `MI-${counter}-${projectId.slice(0, 6)}`, unitId(UNIT), randomUUID()],
    ],
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2026, 'OPEN', $5, $6, $6)`,
      [TENANT_A, periodId, `MIP-${counter}`, new Date(Date.UTC(2044, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), randomUUID(), WORKER_MEMBERSHIP_ID],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), '2026-06-30', '2026-06-30', 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, repeat('a', 64), $4, now(), $4, $4)`,
      [TENANT_A, snapshotId, periodId, WORKER_MEMBERSHIP_ID],
    ],
    [
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
       values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000000, 250000000000, 1250000000000, 600000000000, 'COMPLETE')`,
      [TENANT_A, snapshotId, projectId, unitId(UNIT)],
    ],
  ]);
  return snapshotId;
}

const call = (method: 'GET' | 'POST', url: string, member: number, extra: { body?: unknown; ifMatch?: string; key?: string; tenantId?: string } = {}): Promise<Reply> => app.call(method, url, { member, ...extra });
const versionOf = async (id: string): Promise<number> => Number((await app.harness.owner<{ version: string }>(TENANT_A, [['select version::text as version from machvon.mne_report where id = $1::uuid', [id]]]))[0]?.version);
const rowOf = async (id: string) =>
  (
    await app.harness.owner<Record<string, unknown>>(TENANT_A, [
      ['select status, approved_by, decided_by, decision_reason, payload_sha256, payload_ref, issue_event_id, doc_document_id, issued_at, recalled_at, version::text as version from machvon.mne_report where id = $1::uuid', [id]],
    ])
  )[0] as Record<string, unknown>;
const decide = async (id: string, member: number, body: Record<string, unknown>): Promise<Reply> => call('POST', `/mne-reports/${id}/decision`, member, { body, ifMatch: etag(await versionOf(id)) });
const requestIssue = async (id: string, member = REVIEWER, key?: string): Promise<Reply> => call('POST', `/mne-reports/${id}/issue-requests`, member, { ifMatch: etag(await versionOf(id)), ...(key === undefined ? {} : { key }) });
const events = (aggregateId: string) => app.harness.owner<{ type: string; payload: Record<string, unknown> }>(TENANT_A, [['select type, payload from machvon.outbox_event where aggregate_id::text = $1 order by created_at, id', [aggregateId]]]);
const trail = (resourceId: string) => app.harness.owner<{ action: string; safe_diff: Record<string, unknown> }>(TENANT_A, [['select action, safe_diff from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [resourceId]]]);

/** A report of the unit in review: made by the preparer from the frozen snapshot, written and handed in. */
async function inReview(options: { formCode?: string; formOverrides?: Record<string, unknown>; creator?: number; submitter?: number } = {}): Promise<string> {
  const formId = await publishedForm(options.formCode ?? 'TT44-M02', options.formOverrides);
  const creator = options.creator ?? PREPARER;
  const made = await call('POST', '/mne-reports', creator, { body: { form_id: formId, report_year: 2026, period_label: 'H1-2026', scope_unit_id: unitId(UNIT), snapshot_id: await frozenSnapshot() } });
  expect(made.status).toBe(200);
  const id = made.json.resource_id as string;
  expect((await call('POST', `/mne-reports/${id}/revisions`, creator, { body: { narrative: { assessment: 'On track.' } }, ifMatch: etag(1) })).status).toBe(200);
  expect((await call('POST', `/mne-reports/${id}/submit`, options.submitter ?? creator, { ifMatch: etag(2) })).status).toBe(200);
  return id;
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

describe('review, approval and issuance of the monitoring report (ST-MNE-003, MNE-05)', () => {
  const alerts: Array<{ code: string; context: Record<string, unknown> }> = [];
  const gauges: Array<{ name: string; value: number }> = [];
  const metrics: MetricsSink = { increment: () => undefined, gauge: (name, value) => void gauges.push({ name, value }) };
  const consumer = (): MneReportConsumer => new MneReportConsumer({ database: app.harness.tenants, security: { signingKey: SIGNING_KEY, alerts: { raise: (code, context) => void alerts.push({ code, context }) } }, metrics });
  const answer = (type: string, id: string, sha256: string | null, extra: Record<string, unknown> = {}, revision = 1): OutboxDelivery =>
    delivery(type, { tenant_id: TENANT_A, document_id: DOCUMENT, actor_id: memberId(REVIEWER), occurred_at: new Date().toISOString(), source_module: 'MNE', source_ref: mneReportSourceRef(id, revision), payload_sha256: sha256, ...extra });

  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);
  afterEach(async () => {
    alerts.length = 0;
    gauges.length = 0;
    await app.reset();
    await seed([['delete from machvon.period_snapshot_line', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.project', []]]);
  });

  describe('AC-ST-MNE-003-1: approval, the request to DOC and the answer of DOC', () => {
    it('UAT-AC289: refuses the approval of who wrote or handed in the report, then approves, asks DOC to issue it, and marks it ISSUED only when DOC says so', async () => {
      const id = await inReview({ submitter: PREPARER_REVIEWER });
      const own = await decide(id, PREPARER_REVIEWER, { decision: 'approve', reason: 'Checked against the snapshot.' });
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await rowOf(id)).status).toBe('IN_REVIEW');
      const approved = await decide(id, REVIEWER, { decision: 'approve', reason: 'Checked against the snapshot.' });
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ status: 'APPROVED' });
      expect(await rowOf(id)).toMatchObject({ status: 'APPROVED', approved_by: memberId(REVIEWER), decided_by: memberId(REVIEWER), decision_reason: 'Checked against the snapshot.' });

      const asked = await requestIssue(id);
      expect(asked.status).toBe(200);
      expect(asked.json).toMatchObject({ status: 'ISSUING' });
      const row = await rowOf(id);
      expect(row.status).toBe('ISSUING');
      expect(row.doc_document_id).toBeNull();
      // The hash is in the key of the stored payload: bytes of a request that did not commit never stand in the way of the next one.
      expect(row.payload_ref).toBe(`tenants/${TENANT_A}/mne/reports/${id}/r1-${row.payload_sha256 as string}.json`);
      const [event] = (await events(id)).filter((entry) => entry.type === 'mne.report.issue_requested.v1');
      expect(event?.payload).toMatchObject({
        source_module: 'MNE',
        source_ref: mneReportSourceRef(id, 1),
        template_code: 'MNE-TT44-M02',
        payload_sha256: row.payload_sha256,
        payload_ref: row.payload_ref,
        event_id: row.issue_event_id,
        signer_hint: { drafting_unit_id: unitId(UNIT) },
      });
      // The payload kept for DOC is the one the hash is of, with the figures of the snapshot.
      const stored = JSON.parse(Buffer.from((await app.files.get(row.payload_ref as string))?.bytes ?? new Uint8Array()).toString('utf8')) as Record<string, string>;
      expect((stored.body ?? '').split('\n')).toEqual(['Plan: 1.250.000.000.000 đồng', 'Rate: 48.0000%', 'Assessment: On track.']);
      expect(stored.title).toBe('Overall report');

      // DOC takes the request and drafts the document; until it says it issued it the module does not.
      const doc = new DocumentIssueConsumer({ database: app.harness.tenants, service: new DocumentIssueService(app.files), security: { signingKey: SIGNING_KEY } });
      expect(await doc.handle(delivery('mne.report.issue_requested.v1', event?.payload as Record<string, unknown>))).toBe('processed');
      const [accepted] = await app.harness.owner<{ status: string; reject_code: string | null }>(TENANT_A, [['select status, reject_code from machvon.doc_issue_request where source_ref = $1', [mneReportSourceRef(id, 1)]]]);
      expect(accepted).toEqual({ status: 'ACCEPTED', reject_code: null });
      expect((await rowOf(id)).status).toBe('ISSUING');
      const live = await call('GET', `/mne-reports/${id}`, READER);
      expect(live.json).toMatchObject({ status: 'ISSUING', document_state: 'DRAFT', doc_document_id: null });

      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, row.payload_sha256 as string))).toBe('processed');
      expect(await rowOf(id)).toMatchObject({ status: 'ISSUED', doc_document_id: DOCUMENT });
      expect(gauges.some((gauge) => gauge.name === 'mne_issue_latency_seconds' && gauge.value >= 0)).toBe(true);
      expect((await call('GET', `/mne-reports/${id}`, READER)).json).toMatchObject({ status: 'ISSUED', doc_document_id: DOCUMENT });
      expect((await trail(id)).map((entry) => entry.action)).toEqual(expect.arrayContaining(['mne.report.approved', 'mne.report.issue_requested', 'mne.report_issued']));
      expect((await events(id)).map((entry) => entry.type)).toEqual(expect.arrayContaining(['mne.report.approved.v1', 'mne.report.issue_requested.v1', 'mne.report.issued.v1']));
    });

    it('refuses the approval of who wrote the report even when someone else handed it in, and lets another person with the right do it', async () => {
      const id = await inReview({ creator: PREPARER_REVIEWER, submitter: PREPARER });
      const author = await decide(id, PREPARER_REVIEWER, { decision: 'approve', reason: 'Looks right to me.' });
      expect([author.status, author.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await decide(id, REVIEWER, { decision: 'approve', reason: 'Looks right to me.' })).status).toBe(200);
      expect((await rowOf(id)).approved_by).toBe(memberId(REVIEWER));
    });

    it('returns a report with the reason, as a draft the preparer changes and hands in again', async () => {
      const id = await inReview();
      const short = await decide(id, REVIEWER, { decision: 'return', reason: 'no' });
      expect([short.status, short.json.code, short.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
      const returned = await decide(id, REVIEWER, { decision: 'return', reason: 'The assessment needs the difficulties.' });
      expect(returned.status).toBe(200);
      expect(returned.json).toMatchObject({ status: 'DRAFT' });
      expect(await rowOf(id)).toMatchObject({ status: 'DRAFT', approved_by: null, decided_by: memberId(REVIEWER), decision_reason: 'The assessment needs the difficulties.' });
      expect((await call('GET', `/mne-reports/${id}`, READER)).json).toMatchObject({ status: 'DRAFT', decision: { by: memberId(REVIEWER), reason: 'The assessment needs the difficulties.' } });
      expect((await call('POST', `/mne-reports/${id}/revisions`, PREPARER, { body: { narrative: { assessment: 'On track, with difficulties.' } }, ifMatch: etag(await versionOf(id)) })).status).toBe(200);
      expect((await call('POST', `/mne-reports/${id}/submit`, PREPARER, { ifMatch: etag(await versionOf(id)) })).status).toBe(200);
      expect((await rowOf(id)).status).toBe('IN_REVIEW');
    });

    it('answers the request for issue again with the first answer when the key is the same, and writes one event', async () => {
      const id = await inReview();
      await decide(id, REVIEWER, { decision: 'approve', reason: 'Checked against the snapshot.' });
      const version = await versionOf(id);
      const first = await call('POST', `/mne-reports/${id}/issue-requests`, REVIEWER, { ifMatch: etag(version), key: 'issue-retry-key-000001' });
      const retry = await call('POST', `/mne-reports/${id}/issue-requests`, REVIEWER, { ifMatch: etag(version), key: 'issue-retry-key-000001' });
      expect(retry.json).toEqual(first.json);
      expect((await events(id)).filter((entry) => entry.type === 'mne.report.issue_requested.v1')).toHaveLength(1);
      const again = await requestIssue(id);
      expect([again.status, again.json.code]).toEqual([409, 'REPORT_STATE_INVALID']);
    });
  });

  describe('AC-ST-MNE-003-2: a template that DOC does not have', () => {
    it('UAT-AC298: refuses the request (422 DOC_TEMPLATE_MISSING), keeps the report APPROVED and tells the administrator of the forms', async () => {
      const [profile] = await app.harness.owner<{ id: string }>(TENANT_A, [["select id from machvon.document_layout_profile where profile_code = 'ND30_A4_STANDARD'", []]]);
      await app.harness.owner(TENANT_A, [
        [
          `insert into machvon.document_template
             (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, watermark_text,
              origin, content_sha256, effective_from, status, published_at, created_by, updated_by)
           values ($1, $2, 'MNE-X', 1, 'REPORT_MONITORING', 'BC', 'Template', $3, '[{"kind":"paragraph","text":"{{body}}"}]'::jsonb, '{"required":["body"]}'::jsonb, 'Legal basis', 'Waiting',
              'PLATFORM_PACK', repeat('c', 64), '2026-01-01', 'PUBLISHED', now(), $4, $4)`,
          [TENANT_A, randomUUID(), profile?.id, memberId(ADMIN)],
        ],
      ]);
      const id = await inReview({ formCode: 'TT44-MX', formOverrides: { doc_template_code: 'MNE-X' } });
      await decide(id, REVIEWER, { decision: 'approve', reason: 'Checked against the snapshot.' });
      // The library of DOC loses the template after the form was published with it.
      await app.harness.owner(TENANT_A, [["delete from machvon.document_template where template_code = 'MNE-X'", []]]);
      const before = await versionOf(id);
      const refused = await requestIssue(id);
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'DOC_TEMPLATE_MISSING', 'doc_template_code']);
      expect(refused.json.template_code).toBe('MNE-X');
      expect(await rowOf(id)).toMatchObject({ status: 'APPROVED', payload_sha256: null, issue_event_id: null, version: String(before) });
      const alert = (await events(id)).find((entry) => entry.type === 'mne.configuration_alert.v1');
      expect(alert?.payload).toMatchObject({ form_code: 'TT44-MX', template_code: 'MNE-X', reason: 'DOC_TEMPLATE_MISSING', audience: 'FORM_ADMINISTRATOR' });
      expect((await trail(id)).map((entry) => entry.action)).toContain('mne.report_issue_blocked');
      expect((await events(id)).some((entry) => entry.type === 'mne.report.issue_requested.v1')).toBe(false);
      expect(app.files.keys().some((key) => key.includes(id))).toBe(false);
    });
  });

  describe('rights and states', () => {
    it('keeps the rights apart: the preparer and the reader neither approve nor ask for issue, and the reviewer neither writes nor hands in', async () => {
      const id = await inReview();
      expect((await decide(id, PREPARER, { decision: 'approve', reason: 'Fine by me.' })).status).toBe(403);
      expect((await decide(id, READER, { decision: 'approve', reason: 'Fine by me.' })).status).toBe(403);
      expect((await call('POST', `/mne-reports/${id}/revisions`, REVIEWER, { body: { narrative: {} }, ifMatch: etag(await versionOf(id)) })).status).toBe(403);
      await decide(id, REVIEWER, { decision: 'approve', reason: 'Checked against the snapshot.' });
      expect((await requestIssue(id, PREPARER)).status).toBe(403);
      expect((await requestIssue(id, READER)).status).toBe(403);
    });

    it('decides only a report in review (409 REPORT_STATE_INVALID naming the state), asks for issue only of an approved one, and refuses a stale version', async () => {
      const formId = await publishedForm('TT44-M02');
      const made = await call('POST', '/mne-reports', PREPARER, { body: { form_id: formId, report_year: 2026, period_label: 'H1-2026', scope_unit_id: unitId(UNIT), snapshot_id: await frozenSnapshot() } });
      const draft = made.json.resource_id as string;
      const early = await decide(draft, REVIEWER, { decision: 'approve', reason: 'Checked against the snapshot.' });
      expect([early.status, early.json.code]).toEqual([409, 'REPORT_STATE_INVALID']);
      expect(JSON.stringify(early.json)).toContain('DRAFT');
      const unapproved = await requestIssue(draft);
      expect([unapproved.status, unapproved.json.code]).toEqual([409, 'REPORT_STATE_INVALID']);
      const id = await inReview({ formCode: 'TT44-M03' });
      const stale = await call('POST', `/mne-reports/${id}/decision`, REVIEWER, { body: { decision: 'approve', reason: 'Checked against the snapshot.' }, ifMatch: etag(99) });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await call('POST', `/mne-reports/${randomUUID()}/decision`, REVIEWER, { body: { decision: 'approve', reason: 'Checked against the snapshot.' }, ifMatch: etag(1) })).status).toBe(404);
      const body = await call('POST', `/mne-reports/${id}/decision`, REVIEWER, { body: { decision: 'maybe', reason: 'Checked against the snapshot.' }, ifMatch: etag(await versionOf(id)) });
      expect(body.status).toBe(422);
    });

    it('refuses in the database what the commands refuse: a jump of state, a change of the hash, and an approver who is the submitter', async () => {
      const id = await inReview();
      await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_report set status = 'ISSUED' where id = $1::uuid`, [id]]])).rejects.toThrow(/state transition/);
      await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_report set status = 'APPROVED', approved_by = submitted_by, decided_by = submitted_by, decided_at = now() where id = $1::uuid`, [id]]])).rejects.toThrow(/mne_report_approver_sod_chk/);
      await decide(id, REVIEWER, { decision: 'approve', reason: 'Checked against the snapshot.' });
      await requestIssue(id);
      await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_report set payload_sha256 = repeat('b', 64) where id = $1::uuid`, [id]]])).rejects.toThrow(/keeps the hash/);
    });
  });

  describe('what DOC answers', () => {
    async function issuing(formCode?: string): Promise<{ id: string; sha256: string }> {
      const id = await inReview(formCode === undefined ? {} : { formCode });
      await decide(id, REVIEWER, { decision: 'approve', reason: 'Checked against the snapshot.' });
      await requestIssue(id);
      return { id, sha256: (await rowOf(id)).payload_sha256 as string };
    }

    it('keeps out an answer with another hash, raises it, and changes nothing', async () => {
      const { id } = await issuing();
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, 'f'.repeat(64)))).toBe('processed');
      expect(await rowOf(id)).toMatchObject({ status: 'ISSUING', doc_document_id: null });
      expect(alerts.map((entry) => entry.code)).toEqual(['MNE_REPORT_EXCEPTION']);
      expect(alerts[0]?.context).toMatchObject({ reason: 'HASH_MISMATCH' });
      expect((await trail(id)).map((entry) => entry.action)).toContain('mne.report_exception');
    });

    it('believes the hash the module asked for when DOC also names the hash of the draft its drafter changed (the place of issue)', async () => {
      const { id, sha256 } = await issuing();
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, 'd'.repeat(64), { source_payload_sha256: sha256 }))).toBe('processed');
      expect(await rowOf(id)).toMatchObject({ status: 'ISSUED', doc_document_id: DOCUMENT });
      expect(alerts).toEqual([]);
      // The hash of the draft alone, when it is not the one asked for, is still kept out.
      const other = await issuing('TT44-M03');
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, other.id, 'd'.repeat(64)))).toBe('processed');
      expect((await rowOf(other.id)).status).toBe('ISSUING');
    });

    it('does not let a refusal DOC repeats for an earlier attempt undo the attempt now in hand', async () => {
      const { id, sha256 } = await issuing();
      const first = (await rowOf(id)).issue_event_id as string;
      expect(await consumer().handle(answer(DOC_REJECTED_EVENT, id, sha256, { reject_code: 'PAYLOAD_INVALID', source_event_id: first }))).toBe('processed');
      expect((await rowOf(id)).status).toBe('APPROVED');
      expect((await requestIssue(id)).status).toBe(200);
      const second = (await rowOf(id)).issue_event_id as string;
      expect(second).not.toBe(first);
      // DOC says again that the first attempt was refused: the second is still waiting.
      expect(await consumer().handle(answer(DOC_REJECTED_EVENT, id, sha256, { reject_code: 'PAYLOAD_INVALID', source_event_id: first }))).toBe('processed');
      expect((await rowOf(id)).status).toBe('ISSUING');
      expect(alerts.filter((entry) => entry.code === 'MNE_REPORT_ISSUE_REJECTED')).toHaveLength(1);
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, sha256, { source_event_id: second }))).toBe('processed');
      expect((await rowOf(id)).status).toBe('ISSUED');
    });

    it('counts an answer that DOC repeats as a duplicate and issues the report once', async () => {
      const { id, sha256 } = await issuing();
      const first = answer(DOC_ISSUED_EVENT, id, sha256);
      expect(await consumer().handle(first)).toBe('processed');
      expect(await consumer().handle(first)).toBe('duplicate');
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, sha256))).toBe('processed');
      expect((await events(id)).filter((entry) => entry.type === 'mne.report.issued.v1')).toHaveLength(1);
      expect(alerts).toEqual([]);
    });

    it('puts the report back to APPROVED when DOC refuses, raises it, and lets the request be made again with the same payload', async () => {
      const { id, sha256 } = await issuing();
      expect(await consumer().handle(answer(DOC_REJECTED_EVENT, id, sha256, { reject_code: 'PAYLOAD_INVALID' }))).toBe('processed');
      expect(await rowOf(id)).toMatchObject({ status: 'APPROVED', payload_sha256: sha256 });
      expect(alerts.map((entry) => entry.code)).toEqual(['MNE_REPORT_ISSUE_REJECTED']);
      expect(alerts[0]?.context).toMatchObject({ rejectCode: 'PAYLOAD_INVALID', formCode: 'TT44-M02' });
      // The unit is renamed while the report waits: what was frozen is asked for again, not a payload built from the new name.
      const kept = await app.files.get((await rowOf(id)).payload_ref as string);
      await app.harness.owner(TENANT_A, [['update machvon.organization_unit set name = $2 where id = $1::uuid', [unitId(UNIT), 'Renamed investor']]]);
      const again = await requestIssue(id);
      expect(again.status).toBe(200);
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'ISSUING', payload_sha256: sha256 });
      expect(Buffer.from((await app.files.get(row.payload_ref as string))?.bytes ?? new Uint8Array()).equals(Buffer.from(kept?.bytes ?? new Uint8Array()))).toBe(true);
      const issues = (await events(id)).filter((entry) => entry.type === 'mne.report.issue_requested.v1');
      expect(issues[1]?.payload).toMatchObject({ payload_sha256: sha256, payload_ref: row.payload_ref });
      expect(issues[1]?.payload.event_id).not.toBe(issues[0]?.payload.event_id);
      expect((await events(id)).filter((entry) => entry.type === 'mne.report.issue_requested.v1')).toHaveLength(2);
    });

    it('marks a report that DOC recalled after issuing it, raises it, and keeps the document it was issued as', async () => {
      const { id, sha256 } = await issuing();
      await consumer().handle(answer(DOC_ISSUED_EVENT, id, sha256));
      expect(await consumer().handle(answer(DOC_RECALLED_EVENT, id, sha256))).toBe('processed');
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'ISSUED', doc_document_id: DOCUMENT });
      expect(row.recalled_at).not.toBeNull();
      expect(alerts.map((entry) => entry.code)).toEqual(['MNE_REPORT_RECALLED']);
      expect((await call('GET', `/mne-reports/${id}`, READER)).json.recalled_at).not.toBeNull();
    });

    it('does not consume a recall that comes before the answer of the issue: the delivery fails, and the recall is applied when it is tried again after the issue', async () => {
      const { id, sha256 } = await issuing();
      const recall = answer(DOC_RECALLED_EVENT, id, sha256);
      await expect(consumer().handle(recall)).rejects.toThrow(/before doc.issued/);
      expect((await rowOf(id)).status).toBe('ISSUING');
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, sha256))).toBe('processed');
      expect(await consumer().handle(recall)).toBe('processed');
      expect((await rowOf(id)).recalled_at).not.toBeNull();
      expect(alerts.map((entry) => entry.code)).toEqual(['MNE_REPORT_RECALLED']);
    });

    it('ignores what it was not asked and raises what cannot follow the report: an issue answer for an approved report, another module, an unknown report', async () => {
      const id = await inReview();
      await decide(id, REVIEWER, { decision: 'approve', reason: 'Checked against the snapshot.' });
      // Not asked for issue yet: there is no hash to match, so DOC's answer is kept out.
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, 'a'.repeat(64)))).toBe('processed');
      expect((await rowOf(id)).status).toBe('APPROVED');
      expect(await consumer().handle({ ...answer(DOC_ISSUED_EVENT, id, 'a'.repeat(64)), payload: { source_module: 'AUD', source_ref: mneReportSourceRef(id, 1) } })).toBe('ignored');
      expect(await consumer().handle(answer('doc.something.v1', id, null))).toBe('ignored');
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, randomUUID(), 'a'.repeat(64)))).toBe('processed');
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, 'a'.repeat(64), {}, 2))).toBe('processed');
      expect(await consumer().handle({ ...answer(DOC_ISSUED_EVENT, id, 'a'.repeat(64)), payload: { source_module: 'MNE', source_ref: 'not-a-reference' } })).toBe('ignored');
      expect((await rowOf(id)).status).toBe('APPROVED');
    });

    it('does not issue an answer without a document, or one that finds the report not waiting for DOC', async () => {
      const { id, sha256 } = await issuing();
      expect(await consumer().handle(answer(DOC_ISSUED_EVENT, id, sha256, { document_id: 'nope' }))).toBe('processed');
      expect(alerts[0]?.context).toMatchObject({ reason: 'DOCUMENT_MISSING' });
      expect(await consumer().handle(answer(DOC_REJECTED_EVENT, id, sha256, {}))).toBe('processed');
      expect(alerts[1]?.context).toMatchObject({ reason: 'REASON_MISSING' });
      expect((await rowOf(id)).status).toBe('ISSUING');
      await consumer().handle(answer(DOC_ISSUED_EVENT, id, sha256));
      alerts.length = 0;
      expect(await consumer().handle(answer(DOC_REJECTED_EVENT, id, sha256, { reject_code: 'LATE' }))).toBe('processed');
      expect(alerts[0]?.context).toMatchObject({ reason: 'STATE_UNEXPECTED' });
      expect((await rowOf(id)).status).toBe('ISSUED');
    });
  });
});
