import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { mneReportSourceRef, signTenantContext } from '@machvon/kernel';
import { DOC_ISSUED_EVENT } from '../../src/modules/aud/report.consumer';
import { MneReportConsumer } from '../../src/modules/mne/report.consumer';
import { ADMIN, APPROVER, INVESTORS, PREPARER, REVIEWER, SIGNING_KEY, TENANT_A, memberId, unitId } from './mne-app';
import type { MneApp, Reply } from './mne-app';

export const etag = (version: number): string => `"${version}"`;
export const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';

export const FIELDS = [
  { key: 'plan_total', label: 'Kế hoạch vốn', kind: 'MONEY', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' } },
  { key: 'rate_pm', label: 'Tỷ lệ theo kế hoạch Thủ tướng giao', kind: 'PERCENT', required: false, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_pm_pct' } },
  { key: 'rate_total', label: 'Tỷ lệ theo kế hoạch tổng', kind: 'PERCENT', required: false, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_total_pct' } },
  { key: 'assessment', label: 'Đánh giá chung', kind: 'TEXT', required: true },
];

/** The steps a test of the monitoring report needs on the way to a report in the state it wants: forms, a frozen snapshot, and a report taken through review, approval and issue by DOC. */
export function flowOf(app: MneApp, unit: number = INVESTORS[0]) {
  let counter = 0;

  const call = (method: 'GET' | 'POST', url: string, member: number, extra: { body?: unknown; ifMatch?: string; key?: string; tenantId?: string } = {}): Promise<Reply> => app.call(method, url, { member, ...extra });

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

  async function publishedForm(formCode: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await call('POST', '/mne-forms', ADMIN, {
      body: {
        form_code: formCode,
        title: 'Báo cáo giám sát',
        report_kind: 'OVERALL_SEMIANNUAL',
        legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
        effective_from: '2026-01-01',
        schema_json: { fields: FIELDS },
        doc_template_code: 'MNE-TT44-M02',
        export_formats: ['XLSX', 'PDF', 'CSV'],
        ...overrides,
      },
    });
    if (created.status !== 200) throw new Error(`form not created: ${JSON.stringify(created.json)}`);
    const published = await call('POST', `/mne-forms/${created.json.resource_id as string}/publish`, APPROVER, { ifMatch: etag(1) });
    if (published.status !== 200) throw new Error(`form not published: ${JSON.stringify(published.json)}`);
    return created.json.resource_id as string;
  }

  /** A project of the unit, and a frozen snapshot of the day in which it holds a plan of 1250 billion (1000 billion from the Prime Minister) and `paid` paid by the Treasury. */
  async function frozenSnapshot(options: { asOf?: string; paid?: string; unitNumber?: number } = {}): Promise<{ snapshotId: string; projectId: string; periodId: string }> {
    counter += 1;
    const projectId = randomUUID();
    const snapshotId = randomUUID();
    const periodId = randomUUID();
    const owner = options.unitNumber ?? unit;
    await seed([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Bridge', $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `MF-${counter}-${projectId.slice(0, 6)}`, unitId(owner), randomUUID()],
      ],
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2026, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `MFP-${counter}`, new Date(Date.UTC(2046, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), randomUUID(), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), $4::date, $4::date, 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, repeat('a', 64), $5, now(), $5, $5)`,
        [TENANT_A, snapshotId, periodId, options.asOf ?? '2026-06-30', WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000000, 250000000000, 1250000000000, $5::numeric, 'COMPLETE')`,
        [TENANT_A, snapshotId, projectId, unitId(owner), options.paid ?? '600000000000'],
      ],
    ]);
    return { snapshotId, projectId, periodId };
  }

  const versionOf = async (id: string): Promise<number> => Number((await app.harness.owner<{ version: string }>(TENANT_A, [['select version::text as version from machvon.mne_report where id = $1::uuid', [id]]]))[0]?.version);
  const rowOf = async (id: string) => (await app.harness.owner<Record<string, unknown>>(TENANT_A, [['select * from machvon.mne_report where id = $1::uuid', [id]]]))[0] as Record<string, unknown>;

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

  const consumer = (): MneReportConsumer => new MneReportConsumer({ database: app.harness.tenants, security: { signingKey: SIGNING_KEY } });

  /** What a report that is handed in and approved goes through until DOC says it issued it. */
  async function approveAndIssue(id: string, documentId = DOCUMENT): Promise<string> {
    await call('POST', `/mne-reports/${id}/decision`, REVIEWER, { body: { decision: 'approve', reason: 'Đã đối chiếu với snapshot.' }, ifMatch: etag(await versionOf(id)) });
    await call('POST', `/mne-reports/${id}/issue-requests`, REVIEWER, { ifMatch: etag(await versionOf(id)) });
    const row = await rowOf(id);
    const sha256 = row.payload_sha256 as string;
    await consumer().handle(
      delivery(DOC_ISSUED_EVENT, { tenant_id: TENANT_A, document_id: documentId, occurred_at: new Date().toISOString(), source_module: 'MNE', source_ref: mneReportSourceRef(id, row.revision as number), payload_sha256: sha256 }),
    );
    return sha256;
  }

  /** A report of the unit from the form and the snapshot, written, handed in, approved and issued by DOC. */
  async function issuedReport(options: { formId?: string; formCode?: string; paid?: string; period?: string; year?: number; asOf?: string } = {}): Promise<{ id: string; formId: string; sha256: string; snapshotId: string }> {
    const formId = options.formId ?? (await publishedForm(options.formCode ?? 'TT44-M02'));
    const { snapshotId } = await frozenSnapshot({ paid: options.paid, asOf: options.asOf });
    const made = await call('POST', '/mne-reports', PREPARER, { body: { form_id: formId, report_year: options.year ?? 2026, period_label: options.period ?? 'H1-2026', scope_unit_id: unitId(unit), snapshot_id: snapshotId } });
    if (made.status !== 200) throw new Error(`report not created: ${JSON.stringify(made.json)}`);
    const id = made.json.resource_id as string;
    await call('POST', `/mne-reports/${id}/revisions`, PREPARER, { body: { narrative: { assessment: 'Giải ngân đúng tiến độ.' } }, ifMatch: etag(1) });
    await call('POST', `/mne-reports/${id}/submit`, PREPARER, { ifMatch: etag(2) });
    const sha256 = await approveAndIssue(id);
    return { id, formId, sha256, snapshotId };
  }

  async function clean(): Promise<void> {
    await app.harness.owner(TENANT_A, [['delete from machvon.mne_export_package'], ['delete from machvon.integration_connector']]);
    await app.reset();
    await seed([['delete from machvon.period_snapshot_line', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.project', []]]);
  }

  return { call, seed, publishedForm, frozenSnapshot, versionOf, rowOf, delivery, consumer, approveAndIssue, issuedReport, clean, memberId };
}
