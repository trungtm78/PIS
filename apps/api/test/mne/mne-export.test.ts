import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Client } from 'pg';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { mneReportSourceRef, parseObjectKey, readTabularFile, signTenantContext } from '@machvon/kernel';
import { DOC_ISSUED_EVENT, DOC_RECALLED_EVENT } from '../../src/modules/aud/report.consumer';
import { MneReportConsumer } from '../../src/modules/mne/report.consumer';
import { ADMIN, APPROVER, INVESTORS, MneApp, PREPARER, READER, REVIEWER, SIGNING_KEY, TENANT_A, TENANT_B, memberId, unitId } from './mne-app';
import type { Reply } from './mne-app';

jest.setTimeout(120_000);

const app = new MneApp();
const etag = (version: number): string => `"${version}"`;
const UNIT = INVESTORS[0];
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';

const FIELDS = [
  { key: 'plan_total', label: 'Kế hoạch vốn', kind: 'MONEY', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' } },
  { key: 'rate_total', label: 'Tỷ lệ giải ngân', kind: 'PERCENT', required: false, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_total_pct' } },
  { key: 'assessment', label: 'Đánh giá chung', kind: 'TEXT', required: true },
];

async function publishedForm(formCode: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await app.call('POST', '/mne-forms', {
    member: ADMIN,
    body: {
      form_code: formCode,
      title: 'Báo cáo giám sát',
      report_kind: 'OVERALL_SEMIANNUAL',
      legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
      effective_from: '2026-01-01',
      schema_json: { fields: FIELDS },
      doc_template_code: 'MNE-TT44-M02',
      export_formats: ['XLSX', 'PDF', 'CSV', 'XML'],
      ...overrides,
    },
  });
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
async function frozenSnapshot(): Promise<string> {
  counter += 1;
  const projectId = randomUUID();
  const snapshotId = randomUUID();
  const periodId = randomUUID();
  await seed([
    [`insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group) values ($1, $2, $3, 'Bridge', $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`, [TENANT_A, projectId, `ME-${counter}-${projectId.slice(0, 6)}`, unitId(UNIT), randomUUID()]],
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2026, 'OPEN', $5, $6, $6)`,
      [TENANT_A, periodId, `MEP-${counter}`, new Date(Date.UTC(2045, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), randomUUID(), WORKER_MEMBERSHIP_ID],
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
const packageVersion = async (id: string): Promise<number> => Number((await app.harness.owner<{ version: string }>(TENANT_A, [['select version::text as version from machvon.mne_export_package where id = $1::uuid', [id]]]))[0]?.version);
const reportRow = async (id: string) => (await app.harness.owner<{ status: string; is_late: boolean; version: string }>(TENANT_A, [['select status, is_late, version::text as version from machvon.mne_report where id = $1::uuid', [id]]]))[0] as { status: string; is_late: boolean; version: string };
const packageRows = (reportId: string) =>
  app.harness.owner<{ id: string; format: string; target_system: string; status: string; file_sha256: string; adapter_status: string; object_key: string; receipt_reference: string | null; submitted_at: string | null }>(TENANT_A, [
    ['select id, format, target_system, status, file_sha256, adapter_status, object_key, receipt_reference, submitted_at::text as submitted_at from machvon.mne_export_package where mne_report_id = $1::uuid order by format, target_system', [reportId]],
  ]);
const generate = async (id: string, body: Record<string, unknown>, member = REVIEWER, key?: string): Promise<Reply> =>
  call('POST', `/mne-reports/${id}/export-packages`, member, { body, ifMatch: etag(await versionOf(id)), ...(key === undefined ? {} : { key }) });
const receipt = async (packageId: string, body: Record<string, unknown>, member = REVIEWER): Promise<Reply> => call('POST', `/mne-export-packages/${packageId}/submission-receipt`, member, { body, ifMatch: etag(await packageVersion(packageId)) });

/** The test guard asks every call for a tenant context, the public link too: the real one does not (the signature is what the link carries). */
const tenantHeader = (): Record<string, string> => ({ 'x-tenant-context': signTenantContext({ tenantId: TENANT_A, membershipId: memberId(REVIEWER), scopeVersion: 1 }, SIGNING_KEY) });

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

/** A report that DOC issued: made, handed in, approved, asked for issue and answered. */
async function issuedReport(formCode = 'TT44-M02', formOverrides: Record<string, unknown> = {}): Promise<{ id: string; sha256: string }> {
  const formId = await publishedForm(formCode, formOverrides);
  const made = await call('POST', '/mne-reports', PREPARER, { body: { form_id: formId, report_year: 2026, period_label: 'H1-2026', scope_unit_id: unitId(UNIT), snapshot_id: await frozenSnapshot() } });
  const id = made.json.resource_id as string;
  await call('POST', `/mne-reports/${id}/revisions`, PREPARER, { body: { narrative: { assessment: 'Giải ngân đúng tiến độ.' } }, ifMatch: etag(1) });
  await call('POST', `/mne-reports/${id}/submit`, PREPARER, { ifMatch: etag(2) });
  await call('POST', `/mne-reports/${id}/decision`, REVIEWER, { body: { decision: 'approve', reason: 'Đã đối chiếu với snapshot.' }, ifMatch: etag(await versionOf(id)) });
  await call('POST', `/mne-reports/${id}/issue-requests`, REVIEWER, { ifMatch: etag(await versionOf(id)) });
  const [row] = await app.harness.owner<{ payload_sha256: string }>(TENANT_A, [['select payload_sha256 from machvon.mne_report where id = $1::uuid', [id]]]);
  const sha256 = row?.payload_sha256 as string;
  const consumer = new MneReportConsumer({ database: app.harness.tenants, security: { signingKey: SIGNING_KEY } });
  await consumer.handle(delivery(DOC_ISSUED_EVENT, { tenant_id: TENANT_A, document_id: DOCUMENT, occurred_at: new Date().toISOString(), source_module: 'MNE', source_ref: mneReportSourceRef(id, 1), payload_sha256: sha256 }));
  expect((await reportRow(id)).status).toBe('ISSUED');
  return { id, sha256 };
}

describe('the export package and the receipt of the filing (ST-MNE-004, MNE-06)', () => {
  const outbound: string[] = [];
  const spies: jest.SpyInstance[] = [];

  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);
  beforeEach(() => {
    outbound.length = 0;
    // Everything the process asks of a host other than itself is recorded: the egress log of the test.
    const real = globalThis.fetch;
    spies.push(
      jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!target.startsWith(app.app.baseUrl)) outbound.push(target);
        return real(input, init);
      }),
    );
    for (const module of [http, https]) {
      const original = module.request.bind(module);
      spies.push(
        jest.spyOn(module, 'request').mockImplementation(((...args: unknown[]) => {
          const first = args[0] as { hostname?: string; host?: string } | string | URL;
          const host = typeof first === 'string' ? new URL(first).hostname : first instanceof URL ? first.hostname : (first.hostname ?? first.host ?? '');
          if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') outbound.push(String(host));
          return (original as (...rest: unknown[]) => unknown)(...args);
        }) as unknown as typeof http.request),
      );
    }
  });
  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    await app.harness.owner(TENANT_A, [['delete from machvon.mne_export_package'], ['delete from machvon.integration_connector']]);
    await app.reset();
    await seed([['delete from machvon.period_snapshot_line', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.project', []]]);
  });

  describe('AC-ST-MNE-004-1: the packages and the receipt', () => {
    it('UAT-AC290: makes an XLSX and a PDF package labelled with the adapter, calls nothing outside, refuses a receipt without its reference, then files the report', async () => {
      await app.harness.owner(TENANT_A, [[`insert into machvon.integration_connector (tenant_id, id, connector_code, adapter_status, mode, config_json, status) values ($1, $2, 'national_pim_file', 'PROPOSED', 'FILE_EXPORT', '{}'::jsonb, 'Draft')`, [TENANT_A, randomUUID()]]]);
      const { id } = await issuedReport();
      const made = await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['XLSX', 'PDF'] });
      expect(made.status).toBe(200);
      expect(made.json).toMatchObject({ status: 'EXPORTED' });
      const rows = await packageRows(id);
      expect(rows.map((row) => [row.format, row.target_system, row.status, row.adapter_status])).toEqual([
        ['PDF', 'NATIONAL_PIM_SYSTEM', 'GENERATED', 'PROPOSED'],
        ['XLSX', 'NATIONAL_PIM_SYSTEM', 'GENERATED', 'PROPOSED'],
      ]);
      for (const row of rows) {
        expect(row.file_sha256).toMatch(/^[0-9a-f]{64}$/);
        // The file is under the prefix of the tenant, and nowhere else.
        expect(parseObjectKey(row.object_key)).toMatchObject({ tenantId: TENANT_A, id: row.id });
      }
      expect((await reportRow(id)).status).toBe('EXPORTED');
      expect(outbound).toEqual([]);
      // The files made are counted, by format and by how far the way to the target goes.
      expect(app.counted.filter((entry) => entry.name === 'mne_export_package_total').map((entry) => entry.labels)).toEqual(expect.arrayContaining([{ format: 'XLSX', adapter_status: 'PROPOSED' }, { format: 'PDF', adapter_status: 'PROPOSED' }]));

      const missing = await receipt(rows[0]?.id as string, { submitted_at: new Date().toISOString() });
      expect([missing.status, missing.json.code]).toEqual([422, 'RECEIPT_REQUIRED']);
      expect((await packageRows(id)).map((row) => row.status)).toEqual(['GENERATED', 'GENERATED']);
      const filed = await receipt(rows[1]?.id as string, { receipt_reference: 'QG-2026-000123', submitted_at: new Date(Date.now() - 3_600_000).toISOString() });
      expect(filed.status).toBe(200);
      expect(filed.json).toMatchObject({ status: 'SUBMISSION_CONFIRMED' });
      expect((await packageRows(id)).find((row) => row.id === rows[1]?.id)).toMatchObject({ status: 'SUBMISSION_CONFIRMED', receipt_reference: 'QG-2026-000123' });
      // The report is filed; its due date (2026-06-30) is long past, so the filing is late.
      expect(await reportRow(id)).toMatchObject({ status: 'SUBMITTED_EXTERNAL', is_late: true });
      expect(outbound).toEqual([]);
    });

    it('refuses a receipt that is dated in the future, one twice, and one of a stale version', async () => {
      const { id } = await issuedReport();
      await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['XLSX'] });
      const [pkg] = await packageRows(id);
      const future = await receipt(pkg?.id as string, { receipt_reference: 'QG-1', submitted_at: new Date(Date.now() + 86_400_000).toISOString() });
      expect([future.status, future.json.code, future.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'submitted_at']);
      const stale = await call('POST', `/mne-export-packages/${pkg?.id as string}/submission-receipt`, REVIEWER, { body: { receipt_reference: 'QG-1', submitted_at: new Date().toISOString() }, ifMatch: etag(9) });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await receipt(pkg?.id as string, { receipt_reference: 'QG-1', submitted_at: new Date().toISOString() })).status).toBe(200);
      const again = await receipt(pkg?.id as string, { receipt_reference: 'QG-2', submitted_at: new Date().toISOString() });
      expect([again.status, again.json.code]).toEqual([409, 'PACKAGE_STATE_INVALID']);
      expect((await packageRows(id))[0]).toMatchObject({ receipt_reference: 'QG-1' });
    });

    it('does not mark a report late when it was filed on the day, and keeps the document of the receipt', async () => {
      const { id } = await issuedReport();
      await generate(id, { target_system: 'RECIPIENT_AGENCY', formats: ['CSV'] });
      await app.harness.owner(TENANT_A, [[`update machvon.mne_report set due_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date + 3 where id = $1::uuid`, [id]]]);
      const [pkg] = await packageRows(id);
      const documentId = randomUUID();
      await app.harness.owner(TENANT_A, [
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
           values ($1, $2, 'REFERENCE', 'QD', 'Receipt', 'QD-RECEIPT', '2026-01-15', 'EFFECTIVE', 'INTERNAL', $3, $3)`,
          [TENANT_A, documentId, memberId(REVIEWER)],
        ],
      ]);
      const unusable = await receipt(pkg?.id as string, { receipt_reference: 'QG-9', submitted_at: new Date().toISOString(), receipt_document_id: randomUUID() });
      expect([unusable.status, unusable.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      expect((await receipt(pkg?.id as string, { receipt_reference: 'QG-9', submitted_at: new Date().toISOString(), receipt_document_id: documentId })).status).toBe(200);
      expect(await reportRow(id)).toMatchObject({ status: 'SUBMITTED_EXTERNAL', is_late: false });
      const shown = await call('GET', `/mne-reports/${id}`, READER);
      expect((shown.json.packages as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'SUBMISSION_CONFIRMED', receipt: { reference: 'QG-9', document_id: documentId } });
    });
  });

  describe('AC-ST-MNE-004-2: the same content is the same package', () => {
    it('UAT-AC297: answers a replay with the first answer and an asking with a new key and the same content with the same packages', async () => {
      const { id } = await issuedReport();
      const body = { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['XLSX', 'PDF'] };
      const version = await versionOf(id);
      const first = await call('POST', `/mne-reports/${id}/export-packages`, REVIEWER, { body, ifMatch: etag(version), key: 'export-retry-key-000001' });
      const replay = await call('POST', `/mne-reports/${id}/export-packages`, REVIEWER, { body, ifMatch: etag(version), key: 'export-retry-key-000001' });
      expect(replay.json).toEqual(first.json);
      const again = await generate(id, body);
      expect(again.status).toBe(200);
      const ids = (reply: Reply) => (reply.json.packages as Array<{ id: string; created: boolean }>).map((entry) => entry.id).sort();
      expect(ids(again)).toEqual(ids(first));
      expect((again.json.packages as Array<{ created: boolean }>).map((entry) => entry.created)).toEqual([false, false]);
      expect(await packageRows(id)).toHaveLength(2);
      // Another target is another package of the same content.
      const other = await generate(id, { target_system: 'RECIPIENT_AGENCY', formats: ['XLSX'] });
      expect(other.status).toBe(200);
      expect(await packageRows(id)).toHaveLength(3);
      // One row for each file that is new and one for each request, new or not.
      const trail = async (action: string) => app.harness.owner(TENANT_A, [['select count(*)::text as n from machvon.audit_event where action = $1 and resource_id::text = any($2::text[])', [action, [id, ...(await packageRows(id)).map((row) => row.id)]]]]);
      expect(await trail('mne.package_generated')).toEqual([{ n: '3' }]);
      expect(await trail('mne.export_requested')).toEqual([{ n: '3' }]);
    });
  });

  describe('what is refused', () => {
    it('refuses a report that is not issued (409 REPORT_NOT_ISSUED), and one that DOC recalled', async () => {
      const formId = await publishedForm('TT44-M02');
      const made = await call('POST', '/mne-reports', PREPARER, { body: { form_id: formId, report_year: 2026, period_label: 'H1-2026', scope_unit_id: unitId(UNIT), snapshot_id: await frozenSnapshot() } });
      const draft = made.json.resource_id as string;
      const early = await generate(draft, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['XLSX'] });
      expect([early.status, early.json.code]).toEqual([409, 'REPORT_NOT_ISSUED']);
      const { id, sha256 } = await issuedReport('TT44-M03');
      await new MneReportConsumer({ database: app.harness.tenants, security: { signingKey: SIGNING_KEY } }).handle(
        delivery(DOC_RECALLED_EVENT, { tenant_id: TENANT_A, source_module: 'MNE', source_ref: mneReportSourceRef(id, 1), payload_sha256: sha256, occurred_at: new Date().toISOString() }),
      );
      const recalled = await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['XLSX'] });
      expect([recalled.status, recalled.json.code]).toEqual([409, 'REPORT_NOT_ISSUED']);
      expect(await packageRows(id)).toHaveLength(0);
    });

    it('refuses the XML of the national system, a format the form does not allow, a format twice and an unknown target', async () => {
      const { id } = await issuedReport('TT44-M02', { export_formats: ['XLSX', 'XML'] });
      const xml = await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['XML'] });
      expect([xml.status, xml.json.code, xml.json.detail]).toEqual([422, 'EXPORT_FORMAT_UNSUPPORTED', 'formats[0]']);
      const notAllowed = await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['PDF'] });
      expect([notAllowed.status, notAllowed.json.code]).toEqual([422, 'EXPORT_FORMAT_UNSUPPORTED']);
      const twice = await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['XLSX', 'XLSX'] });
      expect([twice.status, twice.json.code, twice.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'formats[1]']);
      expect((await generate(id, { target_system: 'SOMEWHERE', formats: ['XLSX'] })).status).toBe(422);
      expect((await generate(id, { target_system: 'LGSP', formats: [] })).status).toBe(422);
      expect(await packageRows(id)).toHaveLength(0);
      expect((await reportRow(id)).status).toBe('ISSUED');
    });

    it('keeps the rights apart and the tenants: the reader and the preparer neither export nor file, another tenant finds nothing', async () => {
      const { id } = await issuedReport();
      const body = { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['XLSX'] };
      expect((await generate(id, body, READER)).status).toBe(403);
      expect((await generate(id, body, PREPARER)).status).toBe(403);
      expect((await generate(id, body, REVIEWER)).status).toBe(200);
      const [pkg] = await packageRows(id);
      expect((await receipt(pkg?.id as string, { receipt_reference: 'QG-1', submitted_at: new Date().toISOString() }, READER)).status).toBe(403);
      expect((await receipt(pkg?.id as string, { receipt_reference: 'QG-1', submitted_at: new Date().toISOString() }, PREPARER)).status).toBe(403);
      const foreign = await call('POST', `/mne-export-packages/${pkg?.id as string}/submission-receipt`, ADMIN, { tenantId: TENANT_B, body: { receipt_reference: 'QG-1', submitted_at: new Date().toISOString() }, ifMatch: etag(1) });
      expect(foreign.status).toBe(403);
      expect((await call('POST', `/mne-export-packages/${randomUUID()}/submission-receipt`, REVIEWER, { body: { receipt_reference: 'QG-1', submitted_at: new Date().toISOString() }, ifMatch: etag(1) })).status).toBe(404);
    });
  });

  describe('the files', () => {
    it('writes the cells of the report in million dong, with the watermark of a form that waits for its legal confirmation, and downloads them by a signed link', async () => {
      const { id } = await issuedReport();
      await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['XLSX', 'CSV', 'PDF'] });
      const rows = await packageRows(id);
      const shown = await call('GET', `/mne-reports/${id}`, REVIEWER);
      const entries = shown.json.packages as Array<{ id: string; format: string; file_sha256: string; adapter_status: string; download: { url: string; expires_at: string } | null }>;
      expect(entries).toHaveLength(3);
      for (const entry of entries) {
        expect(entry).toMatchObject({ adapter_status: 'MISSING' });
        expect(entry.download?.url).toContain(`/mne-export-packages/${entry.id}/file?`);
      }
      const fetched = async (format: string): Promise<{ bytes: Buffer; type: string; status: number }> => {
        const entry = entries.find((candidate) => candidate.format === format);
        const response = await fetch(`${app.app.baseUrl}${entry?.download?.url as string}`, { headers: tenantHeader() });
        return { bytes: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') ?? '', status: response.status };
      };
      const csv = await fetched('CSV');
      expect(csv.status).toBe(200);
      const text = csv.bytes.toString('utf8');
      expect(text).toContain('Kế hoạch vốn,1250000.000000,triệu đồng,SNAPSHOT_METRIC: plan_total_vnd');
      expect(text).toContain('Tỷ lệ giải ngân,48.0000,%');
      expect(text).toContain('Đánh giá chung,Giải ngân đúng tiến độ.');
      expect(text).toContain('CHƯA XÁC NHẬN PHÁP LÝ');
      const xlsx = await fetched('XLSX');
      expect(xlsx.status).toBe(200);
      expect(readTabularFile(new Uint8Array(xlsx.bytes)).rows.flat().join('|')).toContain('1250000.000000');
      const pdf = await fetched('PDF');
      expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // What is served is the file the package names by its hash.
      const { createHash } = await import('node:crypto');
      for (const [format, served] of [['CSV', csv], ['XLSX', xlsx], ['PDF', pdf]] as const) {
        expect(createHash('sha256').update(served.bytes).digest('hex')).toBe(rows.find((row) => row.format === format)?.file_sha256);
      }
      // The first time a package is served it is DOWNLOADED, and the trail says so.
      expect((await packageRows(id)).map((row) => row.status)).toEqual(['DOWNLOADED', 'DOWNLOADED', 'DOWNLOADED']);
      expect(await app.harness.owner(TENANT_A, [['select count(*)::text as n from machvon.audit_event where action = $1', ['mne.package_downloaded']]])).toEqual([{ n: '3' }]);
    });

    it('records the first download once when two people fetch the file at the same moment', async () => {
      const { id } = await issuedReport();
      await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['CSV'] });
      const entry = ((await call('GET', `/mne-reports/${id}`, REVIEWER)).json.packages as Array<{ id: string; download: { url: string } }>)[0];
      const fetchFile = (): Promise<number> => fetch(`${app.app.baseUrl}${entry?.download.url as string}`, { headers: tenantHeader() }).then((response) => response.status);
      expect(await Promise.all([fetchFile(), fetchFile(), fetchFile()])).toEqual([200, 200, 200]);
      expect(await app.harness.owner(TENANT_A, [['select count(*)::text as n from machvon.audit_event where action = $1 and resource_id::text = $2', ['mne.package_downloaded', entry?.id]]])).toEqual([{ n: '1' }]);
      expect((await packageRows(id))[0]).toMatchObject({ status: 'DOWNLOADED' });
    });

    it('offers the link only to who may export, and serves nothing for a link that is forged, altered or of another package', async () => {
      const { id } = await issuedReport();
      await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['CSV'] });
      const asReviewer = (await call('GET', `/mne-reports/${id}`, REVIEWER)).json.packages as Array<{ id: string; download: { url: string } | null }>;
      const asReader = (await call('GET', `/mne-reports/${id}`, READER)).json.packages as Array<{ id: string; download: { url: string } | null }>;
      expect(asReviewer[0]?.download).not.toBeNull();
      expect(asReader).toHaveLength(1);
      expect(asReader[0]?.download).toBeNull();
      const url = asReviewer[0]?.download?.url as string;
      const bad = async (target: string): Promise<number> => (await fetch(`${app.app.baseUrl}${target}`, { headers: tenantHeader() })).status;
      expect(await bad(url.replace(/signature=[0-9a-f]{4}/, 'signature=0000'))).toBe(401);
      expect(await bad(url.replace(/expires=\d+/, 'expires=1'))).toBe(401);
      expect(await bad(url.replace(`/mne-export-packages/${asReviewer[0]?.id as string}/`, `/mne-export-packages/${randomUUID()}/`))).toBe(401);
      expect(await bad(`/mne-export-packages/${asReviewer[0]?.id as string}/file`)).toBe(401);
      expect(await bad(url)).toBe(200);
    });
  });

  describe('a package that expired, and a report that was recalled', () => {
    it('makes the same content again as a new package once the first one expired, and keeps the expired one as the record', async () => {
      const { id } = await issuedReport();
      const body = { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['CSV'] };
      const first = await generate(id, body);
      const [old] = await packageRows(id);
      await app.harness.owner(TENANT_A, [[`update machvon.mne_export_package set status = 'EXPIRED', expired_at = now() where id = $1::uuid`, [old?.id]]]);
      const again = await generate(id, body);
      expect(again.status).toBe(200);
      const made = (again.json.packages as Array<{ id: string; created: boolean }>)[0];
      expect(made?.created).toBe(true);
      expect(made?.id).not.toBe(old?.id);
      expect((await packageRows(id)).map((row) => row.status).sort()).toEqual(['EXPIRED', 'GENERATED']);
      // The new one is the one that is offered, and the same content asked for once more is the new one.
      const third = await generate(id, body);
      expect((third.json.packages as Array<{ id: string; created: boolean }>)[0]).toMatchObject({ id: made?.id, created: false });
      expect(first.status).toBe(200);
    });

    it('gives no link for the files of a report that DOC recalled, and still lists them', async () => {
      const { id, sha256 } = await issuedReport();
      await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['CSV'] });
      const before = (await call('GET', `/mne-reports/${id}`, REVIEWER)).json.packages as Array<{ download: unknown }>;
      expect(before[0]?.download).not.toBeNull();
      await new MneReportConsumer({ database: app.harness.tenants, security: { signingKey: SIGNING_KEY } }).handle(
        delivery(DOC_RECALLED_EVENT, { tenant_id: TENANT_A, source_module: 'MNE', source_ref: mneReportSourceRef(id, 1), payload_sha256: sha256, occurred_at: new Date().toISOString() }),
      );
      const after = (await call('GET', `/mne-reports/${id}`, REVIEWER)).json.packages as Array<{ status: string; download: unknown }>;
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ status: 'GENERATED', download: null });
    });
  });

  describe('a package whose file is not in the store', () => {
    it('is listed with no link, and does not stop the report from being read', async () => {
      const { id } = await issuedReport();
      const lost = randomUUID();
      await app.harness.owner(TENANT_A, [
        [
          `insert into machvon.mne_export_package (tenant_id, id, mne_report_id, target_system, format, object_key, file_sha256, adapter_status, status, created_by, updated_by)
           values ($1, $2, $3, 'NATIONAL_PIM_SYSTEM', 'CSV', $4, repeat('e', 64), 'MISSING', 'GENERATED', $5, $5)`,
          [TENANT_A, lost, id, `tenants/${TENANT_A}/report_export/${lost}`, memberId(REVIEWER)],
        ],
      ]);
      const shown = await call('GET', `/mne-reports/${id}`, REVIEWER);
      expect(shown.status).toBe(200);
      expect((shown.json.packages as Array<Record<string, unknown>>)[0]).toMatchObject({ id: lost, status: 'GENERATED', download: null });
    });
  });

  describe('the table', () => {
    it('keeps what a package is, the receipt it was given, and refuses a state that is not an edge', async () => {
      const { id } = await issuedReport();
      await generate(id, { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['CSV'] });
      const [pkg] = await packageRows(id);
      await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_export_package set file_sha256 = repeat('b', 64) where id = $1::uuid`, [pkg?.id]]])).rejects.toThrow(/keeps its report, target, format, file and hash/);
      await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_export_package set status = 'DOWNLOADED', downloaded_at = now() where id = $1::uuid`, [pkg?.id]], [`update machvon.mne_export_package set status = 'GENERATED' where id = $1::uuid`, [pkg?.id]]])).rejects.toThrow(/state transition/);
      await receipt(pkg?.id as string, { receipt_reference: 'QG-5', submitted_at: new Date().toISOString() });
      await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_export_package set receipt_reference = 'QG-6' where id = $1::uuid`, [pkg?.id]]])).rejects.toThrow(/written once/);
      await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_export_package set status = 'EXPIRED' where id = $1::uuid`, [pkg?.id]]])).rejects.toThrow(/state transition/);
    });
  });
});
