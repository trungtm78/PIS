import { randomBytes, randomUUID } from 'node:crypto';
import { OutboxRelay, enqueueOutbox } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { reportSourceRef, reportTotals } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import {
  AUD_REPORT_CONSUMER,
  AUD_REPORT_EVENT_METRIC,
  AUD_REPORT_EXCEPTION_ALERT,
  AUD_REPORT_REJECTED_ALERT,
  DOC_ISSUED_EVENT,
  DOC_RECALLED_EVENT,
  DOC_REJECTED_EVENT,
  ReportConsumer,
} from '../../src/modules/aud/report.consumer';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';

const RELAY_KEY = randomBytes(32);
const REQUESTER = 1;
const SIGNER = 2;
const FAMILY = 0x9a;
const DECISION = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 11);
const OTHER_DOCUMENT = id(FAMILY, 12);
const SHA = 'a'.repeat(64);

/** What DOC answers to a report of AUD (ST-AUD-005, AUD 3.6 F6, UAT-AC440): issued, rejected, recalled, and the answers that do not fit. */
describe('the answers of DOC on the reports of AUD (AC-ST-AUD-005-1, AC-ST-AUD-005-2)', () => {
  const harness = new AuthzHarness();
  let relayPool: Pool;
  let counter = 0;
  const alerts: Array<{ code: string; context: Record<string, unknown> }> = [];
  const increments: Array<{ name: string; labels: Record<string, string> | undefined }> = [];

  const consumer = (): ReportConsumer =>
    new ReportConsumer({
      database: harness.tenants,
      security: { signingKey: RELAY_KEY, alerts: { raise: (code: string, context?: Record<string, unknown>) => void alerts.push({ code, context: context ?? {} }) } } as never,
      metrics: { increment: (name, labels) => void increments.push({ name, labels }), gauge: () => undefined },
    });

  /** The relay delivers what the outbox holds, to the real consumer. */
  async function relay(): Promise<string[]> {
    const outcomes: string[] = [];
    const real = consumer();
    await new OutboxRelay(relayPool, async (delivery: OutboxDelivery) => void outcomes.push(await real.handle(delivery)), { signingKey: RELAY_KEY }).runOnce();
    return outcomes.filter((outcome) => outcome !== 'ignored');
  }

  const publish = (type: string, payload: Record<string, unknown>, tenantId = TENANT_A): Promise<unknown> =>
    harness.tenants.withTenant(contextFor(tenantId, memberId(REQUESTER)), (tx) =>
      enqueueOutbox(tx, {
        aggregateType: 'outgoing_document',
        aggregateId: randomUUID(),
        aggregateVersion: 1,
        type,
        schemaVersion: 1,
        payload,
        eventKey: `${type}:${randomUUID()}`,
        correlationId: randomUUID(),
      }),
    );

  interface Report {
    reportId: string;
    engagementId: string;
    ref: string;
  }

  /** A report that asked DOC to issue it: its engagement, its conclusion and the row as the command writes it. */
  async function seed(): Promise<Report> {
    counter += 1;
    const engagementId = randomUUID();
    const conclusionId = randomUUID();
    const reportId = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.audit_engagement (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on, classification, created_by, updated_by, version)
         values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'State Audit Office', $4, 'Audit of the bridge', date '2025-01-01', date '2025-12-31', $5, 'FOLLOW_UP', date '2026-10-01', 'CONFIDENTIAL', $5, $5, 3)`,
        [TENANT_A, engagementId, `RC-${counter}`, DECISION, memberId(REQUESTER)],
      ],
      [
        `insert into machvon.audit_conclusion (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, summary, total_financial_vnd, status, created_by, updated_by, version)
         values ($1, $2, $3, 'AUDIT_REPORT', $4, 1, date '2026-10-10', date '2026-10-15', 'The audit found payments above the approved volumes.', 2000000000, 'RECEIVED', $5, $5, 1)`,
        [TENANT_A, conclusionId, engagementId, DECISION, memberId(REQUESTER)],
      ],
      [
        `insert into machvon.audit_follow_up_report (tenant_id, id, engagement_id, conclusion_id, as_of_date, revision, totals_json, payload_sha256, status, payload_ref, issue_event_id, drafting_unit_id, created_by, updated_by, version)
         values ($1, $2, $3, $4, date '2026-10-25', 1, $5::jsonb, $6, 'ISSUE_REQUESTED', $7, $8, $9, $10, $10, 1)`,
        [TENANT_A, reportId, engagementId, conclusionId, JSON.stringify(reportTotals('2026-10-25', [])), SHA, `tenants/${TENANT_A}/aud/follow-up-reports/${reportId}/r1.json`, randomUUID(), unitId(1), memberId(REQUESTER)],
      ],
    ]);
    return { reportId, engagementId, ref: reportSourceRef(reportId, 1) };
  }

  const issued = (report: Report, extra: Record<string, unknown> = {}) =>
    publish(DOC_ISSUED_EVENT, { tenant_id: TENANT_A, document_id: DOCUMENT, actor_id: memberId(SIGNER), occurred_at: '2026-10-26T03:00:00.000Z', source_module: 'AUD', source_ref: report.ref, payload_sha256: SHA, ...extra });
  const rejected = (report: Report, extra: Record<string, unknown> = {}) =>
    publish(DOC_REJECTED_EVENT, { source_module: 'AUD', source_ref: report.ref, payload_sha256: SHA, reject_code: 'TEMPLATE_NOT_EFFECTIVE', ...extra });
  const recalled = (report: Report, extra: Record<string, unknown> = {}) =>
    publish(DOC_RECALLED_EVENT, { tenant_id: TENANT_A, document_id: DOCUMENT, source_module: 'AUD', source_ref: report.ref, payload_sha256: SHA, reason: 'The report was withdrawn.', ...extra });

  const row = async (reportId: string) =>
    (
      await harness.owner<{ status: string; document: string | null; approved_by: string | null; reject_code: string | null; issued_at: string | null; version: string }>(TENANT_A, [
        ['select status, report_document_id as document, approved_by, reject_code, issued_at::text as issued_at, version::text as version from machvon.audit_follow_up_report where id = $1', [reportId]],
      ])
    )[0] as { status: string; document: string | null; approved_by: string | null; reject_code: string | null; issued_at: string | null; version: string };
  const events = (reportId: string) => harness.owner<{ type: string; payload: Record<string, unknown> }>(TENANT_A, [['select type, payload from machvon.outbox_event where aggregate_id::text = $1 order by created_at, id', [reportId]]]);
  const trail = (reportId: string) => harness.owner<{ action: string; classification: string; safe_diff: Record<string, unknown> }>(TENANT_A, [['select action, classification, safe_diff from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [reportId]]]);
  const metric = (outcome: string, event: string): number => increments.filter((item) => item.name === AUD_REPORT_EVENT_METRIC && item.labels?.outcome === outcome && item.labels.event === event).length;

  beforeAll(async () => {
    await harness.start();
    relayPool = new Pool({ connectionString: harness.database.urlFor('machvon_outbox_relay'), max: 2 });
    relayPool.on('error', () => undefined);
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [REQUESTER, SIGNER]) await harness.seedMembership(TENANT_A, n, 1);
    // The documents belong to another module, so the seed runs with foreign keys off.
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/KL-KTNN', date '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4),
                ($1, $3, 'REFERENCE', 'BC', 'The report DOC issued', '07/BC-UBND', date '2026-10-26', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [TENANT_A, DECISION, DOCUMENT, memberId(REQUESTER)],
      );
    } finally {
      await admin.end();
    }
  }, 240_000);

  afterAll(async () => {
    await relayPool?.end();
    await harness.stop();
  }, 60_000);

  beforeEach(() => {
    alerts.length = 0;
    increments.length = 0;
  });

  it('serves the answers of DOC under its own name', () => {
    expect(consumer().name).toBe(AUD_REPORT_CONSUMER);
    expect(AUD_REPORT_CONSUMER).toBe('aud-follow-up-report');
  });

  describe('doc.issued.v1', () => {
    it('AC-ST-AUD-005-1 / UAT-AC440: moves the report to ISSUED with the document and the signer DOC names, once, and says so in the trail and in an event', async () => {
      const report = await seed();
      await issued(report);
      expect(await relay()).toEqual(['processed']);
      expect(await row(report.reportId)).toMatchObject({ status: 'ISSUED', document: DOCUMENT, approved_by: memberId(SIGNER), reject_code: null, version: '2' });
      expect((await row(report.reportId)).issued_at).not.toBeNull();
      const [entry] = (await trail(report.reportId)).filter((item) => item.action === 'aud.report_issued');
      expect(entry).toMatchObject({ classification: 'CONFIDENTIAL', safe_diff: { report_id: report.reportId, document_id: DOCUMENT, approved_by: memberId(SIGNER), self_issued: false, payload_sha256: SHA } });
      const issuedEvents = (await events(report.reportId)).filter((item) => item.type === 'aud.report.issued.v1');
      expect(issuedEvents).toHaveLength(1);
      expect(issuedEvents[0]?.payload).toMatchObject({ tenant_id: TENANT_A, report_id: report.reportId, engagement_id: report.engagementId, document_id: DOCUMENT, source_module: 'AUD' });
      expect(metric('issued', DOC_ISSUED_EVENT)).toBe(1);
      expect(alerts).toEqual([]);
    });

    it('is a counted duplicate when DOC says it again, by the same delivery or by another that names the same document', async () => {
      const report = await seed();
      await issued(report);
      await relay();
      await issued(report);
      expect(await relay()).toEqual(['processed']);
      expect((await row(report.reportId)).version).toBe('2');
      expect(metric('duplicate', DOC_ISSUED_EVENT)).toBe(1);
      expect((await events(report.reportId)).filter((item) => item.type === 'aud.report.issued.v1')).toHaveLength(1);
    });

    it('does not move the report on a hash that is not the one frozen with it, and raises it', async () => {
      const report = await seed();
      await issued(report, { payload_sha256: 'b'.repeat(64) });
      await relay();
      expect((await row(report.reportId)).status).toBe('ISSUE_REQUESTED');
      expect(alerts).toEqual([{ code: AUD_REPORT_EXCEPTION_ALERT, context: expect.objectContaining({ tenantId: TENANT_A, reportId: report.reportId, reason: 'HASH_MISMATCH' }) as unknown }]);
      expect(metric('mismatch', DOC_ISSUED_EVENT)).toBe(1);
      expect((await trail(report.reportId)).map((item) => item.action)).toContain('aud.report_exception');
    });

    it('does not move the report when the event names no document, and raises it', async () => {
      const report = await seed();
      await issued(report, { document_id: 'not-a-document' });
      await relay();
      expect((await row(report.reportId)).status).toBe('ISSUE_REQUESTED');
      expect(alerts[0]).toMatchObject({ code: AUD_REPORT_EXCEPTION_ALERT, context: { reason: 'DOCUMENT_MISSING' } });
    });

    it('issues the report when the signer is the person who asked for it, with no approver, and raises it (the table keeps the two apart)', async () => {
      const report = await seed();
      await issued(report, { actor_id: memberId(REQUESTER) });
      await relay();
      expect(await row(report.reportId)).toMatchObject({ status: 'ISSUED', document: DOCUMENT, approved_by: null });
      expect(alerts[0]).toMatchObject({ code: AUD_REPORT_EXCEPTION_ALERT, context: { reason: 'SELF_ISSUED' } });
      expect((await trail(report.reportId)).find((item) => item.action === 'aud.report_issued')?.safe_diff).toMatchObject({ approved_by: null, self_issued: true });
    });

    it('issues the report when the event names no signer, with no approver, and says the signer is unknown', async () => {
      const report = await seed();
      await issued(report, { actor_id: undefined });
      await relay();
      expect(await row(report.reportId)).toMatchObject({ status: 'ISSUED', approved_by: null });
      expect(alerts[0]).toMatchObject({ context: { reason: 'SIGNER_UNKNOWN' } });
    });

    it('takes the instant of the issue from the event, and the time of its own when the event has none', async () => {
      const report = await seed();
      await issued(report, { occurred_at: undefined });
      await relay();
      expect((await row(report.reportId)).issued_at).not.toBeNull();
    });
  });

  describe('doc.rejected.v1', () => {
    it('AC-ST-AUD-005-2: moves the report to REJECTED with the reason of DOC and raises the alert, and a new revision can be asked for', async () => {
      const report = await seed();
      await rejected(report);
      expect(await relay()).toEqual(['processed']);
      expect(await row(report.reportId)).toMatchObject({ status: 'REJECTED', reject_code: 'TEMPLATE_NOT_EFFECTIVE', document: null, approved_by: null });
      expect(alerts).toEqual([{ code: AUD_REPORT_REJECTED_ALERT, context: expect.objectContaining({ tenantId: TENANT_A, reportId: report.reportId, rejectCode: 'TEMPLATE_NOT_EFFECTIVE' }) as unknown }]);
      const event = (await events(report.reportId)).find((item) => item.type === 'aud.report.rejected.v1');
      expect(event?.payload).toMatchObject({ report_id: report.reportId, reject_code: 'TEMPLATE_NOT_EFFECTIVE' });
      // The live index no longer holds the day: a new revision of the same conclusion and day is accepted by the table.
      const [conclusion] = await harness.owner<{ conclusion_id: string }>(TENANT_A, [['select conclusion_id from machvon.audit_follow_up_report where id = $1', [report.reportId]]]);
      await expect(
        harness.owner(TENANT_A, [
          [
            `insert into machvon.audit_follow_up_report (tenant_id, id, engagement_id, conclusion_id, as_of_date, revision, totals_json, payload_sha256, status, payload_ref, issue_event_id, drafting_unit_id, created_by, updated_by, version)
             values ($1, gen_random_uuid(), $2, $3, date '2026-10-25', 2, '{}'::jsonb, $4, 'ISSUE_REQUESTED', 'tenants/x/r2.json', gen_random_uuid(), $5, $6, $6, 1)`,
            [TENANT_A, report.engagementId, conclusion?.conclusion_id, SHA, unitId(1), memberId(REQUESTER)],
          ],
        ]),
      ).resolves.toBeDefined();
    });

    it('is a counted duplicate when DOC says it again, and does not reject a report that was issued', async () => {
      const report = await seed();
      await rejected(report);
      await relay();
      await rejected(report);
      await relay();
      expect(metric('duplicate', DOC_REJECTED_EVENT)).toBe(1);
      expect(alerts.filter((item) => item.code === AUD_REPORT_REJECTED_ALERT)).toHaveLength(1);
      const issuedReport = await seed();
      await issued(issuedReport);
      await relay();
      alerts.length = 0;
      await rejected(issuedReport);
      await relay();
      expect((await row(issuedReport.reportId)).status).toBe('ISSUED');
      expect(alerts[0]).toMatchObject({ code: AUD_REPORT_EXCEPTION_ALERT, context: { reason: 'STATE_UNEXPECTED' } });
      expect(metric('stale', DOC_REJECTED_EVENT)).toBe(1);
    });

    it('does not apply a rejection that gives no reason, and raises it', async () => {
      const report = await seed();
      await rejected(report, { reject_code: undefined });
      await relay();
      expect((await row(report.reportId)).status).toBe('ISSUE_REQUESTED');
      expect(alerts[0]).toMatchObject({ context: { reason: 'REASON_MISSING' } });
    });
  });

  describe('doc.recalled.v1', () => {
    it('moves an issued report to RECALLED, once, and keeps its document', async () => {
      const report = await seed();
      await issued(report);
      await relay();
      await recalled(report);
      expect(await relay()).toEqual(['processed']);
      expect(await row(report.reportId)).toMatchObject({ status: 'RECALLED', document: DOCUMENT, version: '3' });
      expect((await events(report.reportId)).filter((item) => item.type === 'aud.report.recalled.v1')).toHaveLength(1);
      await recalled(report);
      await relay();
      expect(metric('duplicate', DOC_RECALLED_EVENT)).toBe(1);
    });

    it('does not recall a report that was never issued, and raises it', async () => {
      const report = await seed();
      await recalled(report);
      await relay();
      expect((await row(report.reportId)).status).toBe('ISSUE_REQUESTED');
      expect(alerts[0]).toMatchObject({ context: { reason: 'STATE_UNEXPECTED' } });
    });
  });

  describe('what is not the consumer\'s', () => {
    it('leaves alone an event of another module, of another version, or of another kind', async () => {
      const report = await seed();
      await issued(report, { source_module: 'MNE' });
      expect(await relay()).toEqual([]);
      const handled = await consumer().handle({
        id: randomUUID(),
        tenantId: TENANT_A,
        tenantContext: undefined,
        type: 'doc.issued.v2',
        schemaVersion: 2,
        payload: { source_module: 'AUD', source_ref: report.ref },
      } as never);
      expect(handled).toBe('ignored');
      await publish('doc.submitted.v1', { source_module: 'AUD', source_ref: report.ref, payload_sha256: SHA });
      expect(await relay()).toEqual([]);
      expect((await row(report.reportId)).status).toBe('ISSUE_REQUESTED');
    });

    it('counts an event whose reference is not one of a report, and one that names a report that is not there, and changes nothing', async () => {
      await issued({ reportId: randomUUID(), engagementId: randomUUID(), ref: 'AUD:something-else' });
      expect(await relay()).toEqual([]);
      expect(metric('unknown', DOC_ISSUED_EVENT)).toBe(1);
      const gone = { reportId: randomUUID(), engagementId: randomUUID(), ref: reportSourceRef(randomUUID(), 1) };
      await issued(gone);
      expect(await relay()).toEqual(['processed']);
      expect(metric('unknown', DOC_ISSUED_EVENT)).toBe(2);
      const report = await seed();
      await issued({ ...report, ref: reportSourceRef(report.reportId, 2) });
      await relay();
      expect((await row(report.reportId)).status).toBe('ISSUE_REQUESTED');
      expect(metric('unknown', DOC_ISSUED_EVENT)).toBe(3);
    });

    it('does not reach a report of another tenant: the same reference from the other tenant finds nothing', async () => {
      const report = await seed();
      await issued(report, { tenant_id: TENANT_B });
      await harness.tenants.withTenant(contextFor(TENANT_B, memberId(REQUESTER)), (tx) =>
        enqueueOutbox(tx, {
          aggregateType: 'outgoing_document',
          aggregateId: randomUUID(),
          aggregateVersion: 1,
          type: DOC_ISSUED_EVENT,
          schemaVersion: 1,
          payload: { tenant_id: TENANT_B, document_id: OTHER_DOCUMENT, actor_id: memberId(SIGNER), source_module: 'AUD', source_ref: report.ref, payload_sha256: SHA },
          eventKey: `${DOC_ISSUED_EVENT}:${randomUUID()}`,
          correlationId: randomUUID(),
        }),
      );
      await relay();
      // The event of tenant A moved its own report; the one of tenant B found no report in its tenant and moved none.
      expect(await row(report.reportId)).toMatchObject({ status: 'ISSUED', document: DOCUMENT });
      expect(metric('unknown', DOC_ISSUED_EVENT)).toBe(1);
    });
  });
});
