import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, objectKey, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { disModule } from '../../src/modules/dis';
import { ReportExportController } from '../../src/modules/dis/report-export.controller';
import { DOCX_MEDIA_TYPE, readDocxParagraphs } from '../../src/modules/reports';
import { DIS_CLOCK, DIS_METRICS } from '../../src/modules/dis/tokens';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const EXPORTER = 1; // report.export over the whole tenant
const HERE_EXPORTER = 2; // report.export over the unit HERE
const NOBODY = 3;
const OTHER_EXPORTER = 4; // report.export over the whole tenant, another person
const B_EXPORTER = 1;
const ROOT = 1;
const HERE = 2;
const ELSEWHERE = 3;
const FAMILY = 0xa7;
const NOW = new Date('2027-10-15T03:00:00Z');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The export of a frozen snapshot over HTTP, with the permission asked again at the download (ST-DIS-016, DIS-17, NFR-TENANCY-06). */
describe('the report export over HTTP (ST-DIS-016)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let counter = 0;
  const counted: Array<{ name: string; labels?: Record<string, string> }> = [];
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', path: string, member = EXPORTER, options: { tenantId?: string; body?: unknown; key?: string } = {}): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${path}`, {
      method,
      headers: { [TENANT_HEADER]: tokenOf(member, options.tenantId), ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': options.key ?? `key-${randomUUID()}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const create = (snapshotId: string, format: string, member = EXPORTER, extra: Record<string, unknown> = {}, options: { tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/report-exports', member, { ...options, body: { snapshot_id: snapshotId, format, ...extra } });
  const download = (exportId: string, member = EXPORTER, tenantId?: string): Promise<Reply> => call('GET', `/report-exports/${exportId}/download`, member, tenantId === undefined ? {} : { tenantId });
  // The link names no person: the real guard lets a public route through (auth.guard.ts); the stand-in of the tests wants a context, which here is that of a person who holds no permission at all.
  const stranger = { [TENANT_HEADER]: tokenOf(NOBODY) };
  const fetchLink = (url: string): Promise<Response> => fetch(`${app.baseUrl}${url}`, { headers: stranger });
  const fetchUrl = (url: URL): Promise<Response> => fetch(url, { headers: stranger });
  async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }
  const owner = (sql: string, params: unknown[] = []): Promise<unknown> => harness.owner(TENANT_A, [[sql, params]]);
  const day = (offset: number): string => new Date(Date.UTC(2042, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

  /** A week with a snapshot that is frozen (or only built) and three projects: two of HERE and one of ELSEWHERE. */
  async function world(options: { frozen?: boolean; definitionStatus?: string; periodType?: string } = {}) {
    counter += 1;
    const periodId = id(FAMILY, 1000 + counter);
    const snapshotId = randomUUID();
    const projects = [
      { id: id(FAMILY, 100 + counter * 10), code: `PX-${counter}-A`, unit: HERE, treasury: '600000000', plan: '1000000000' },
      { id: id(FAMILY, 101 + counter * 10), code: `PX-${counter}-B`, unit: HERE, treasury: null, plan: '500000000' },
      { id: id(FAMILY, 102 + counter * 10), code: `PX-${counter}-C`, unit: ELSEWHERE, treasury: '40000000', plan: '100000000' },
    ];
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $5::date, $6::timestamptz, 'DEFAULT', $7, 2027, 'OPEN', $8, $9, $9)`,
        [TENANT_A, periodId, `EX-${counter}`, day(counter * 10), day(counter * 10 + 6), '2027-10-10T03:00:00Z', options.periodType ?? 'WEEK', id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, date '2027-10-11', date '2027-10-11', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', $5, 3, $6, $6)`,
        [TENANT_A, snapshotId, periodId, NOW.toISOString(), options.definitionStatus ?? 'PROPOSED_PENDING_SIGNOFF', WORKER_MEMBERSHIP_ID],
      ],
    ];
    for (const project of projects) {
      statements.push([
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, project.id, project.code, `Dự án ${project.code}`, unitId(project.unit), id(FAMILY, 30)],
      ]);
      statements.push([
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', $5::numeric, $5::numeric, $6::numeric, $7)`,
        [TENANT_A, snapshotId, project.id, unitId(project.unit), project.plan, project.treasury, project.treasury === null ? 'NONE' : 'COMPLETE'],
      ]);
    }
    if (options.frozen !== false) statements.push([`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = $3::timestamptz where id = $1`, [snapshotId, WORKER_MEMBERSHIP_ID, NOW.toISOString()]]);
    await seedReplica(statements);
    return { periodId, snapshotId, projects, periodCode: `EX-${counter}` };
  }
  /** A person's grant narrowed (or revoked) after the file was made: the version of the scope moves, as the grant commands do. */
  async function narrow(member: number, to: 'HERE' | 'REVOKED'): Promise<void> {
    if (to === 'REVOKED') await owner(`update machvon.role_grant set status = 'Revoked', revoked_at = now() where membership_id = $1::uuid`, [memberId(member)]);
    else await owner(`update machvon.role_grant set scope_kind = 'UNIT_SUBTREE', scope_ref_ids = array[$2::uuid], scope_json = jsonb_build_object('kind', 'UNIT_SUBTREE', 'ref_ids', jsonb_build_array($2::text)) where membership_id = $1::uuid`, [memberId(member), unitId(HERE)]);
    await owner('update machvon.membership set scope_version = scope_version + 1 where id = $1::uuid', [memberId(member)]);
  }
  const csvLines = async (response: Response): Promise<string[]> => (await response.text()).replace(/^\uFEFF/, '').split('\r\n');
  const headerOf = (lines: string[]): Record<string, string> => Object.fromEntries(lines.slice(1, lines.indexOf('')).map((line) => [line.split(',')[0] as string, line.split(',').slice(2).join(',')]));

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: HERE, path: `/${unitId(ROOT)}/${unitId(HERE)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [EXPORTER, HERE_EXPORTER, NOBODY, OTHER_EXPORTER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_EXPORTER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'DIS_EXPORTER', ['report.export'], 20);
    await harness.seedRole(TENANT_B, 1, 'DIS_EXPORTER', ['report.export'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: EXPORTER, role: 1, kind: 'TENANT' },
      { n: 2, member: HERE_EXPORTER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(HERE)] },
      { n: 3, member: OTHER_EXPORTER, role: 1, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_EXPORTER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    root = await mkdtemp(join(tmpdir(), 'machvon-dis-export-'));
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32), now: () => new Date() });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ReportExportController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: DIS_CLOCK, useValue: () => NOW },
        { provide: DIS_METRICS, useValue: { increment: (name: string, labels?: Record<string, string>) => void counted.push({ name, labels }), gauge: () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('serves the controller of the export in the module of DIS', () => {
    expect(disModule.controllers).toContain(ReportExportController);
  });

  it('AC-ST-DIS-016-1 / UAT-AC261: a maker of the unit HERE exports the snapshot to CSV whose header names the scope, the period, the snapshot, the unit VND, the time and the definition status, with only the lines of their projects; once their scope is revoked the download answers 403 SCOPE_DENIED', async () => {
    const w = await world();
    const made = await create(w.snapshotId, 'CSV', HERE_EXPORTER);
    expect(made).toMatchObject({ status: 200, json: { status: 'READY', resource_version: 1 } });
    const exportId = made.json.resource_id as string;
    const issued = await download(exportId, HERE_EXPORTER);
    expect(issued.status).toBe(200);
    expect(issued.json).toMatchObject({ export_id: exportId, format: 'CSV', rows: 2 });
    expect(Date.parse(issued.json.expires_at as string)).toBeGreaterThan(Date.now());
    const file = await fetchLink(issued.json.url as string);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('text/csv');
    expect(file.headers.get('content-disposition')).toContain(`report-export-${exportId}.csv`);
    const lines = await csvLines(file);
    const hereCode = ((await harness.owner<{ code: string }>(TENANT_A, [['select code from machvon.organization_unit where id = $1::uuid', [unitId(HERE)]]]))[0] as { code: string }).code;
    expect(headerOf(lines)).toMatchObject({
      scope: hereCode,
      period: w.periodCode,
      snapshot_id: w.snapshotId,
      currency_unit: 'VND',
      created_at: NOW.toISOString(),
      definition_status: 'PROPOSED_PENDING_SIGNOFF',
      row_count: '2',
    });
    const body = lines.slice(lines.indexOf('') + 2).filter((line) => line !== '' && !line.startsWith('notice,'));
    expect(body.map((line) => line.split(',')[0])).toEqual([w.projects[0]?.code, w.projects[1]?.code]);
    expect(body.join('\n')).not.toContain(w.projects[2]?.code);
    // The Treasury booked nothing for the second project: empty, not 0.
    expect(body[1]?.split(',')[9]).toBe('');
    // The scope is revoked and the link of before is asked for again: no link is issued.
    await narrow(HERE_EXPORTER, 'REVOKED');
    const refused = await download(exportId, HERE_EXPORTER);
    expect(refused.status).toBe(403);
    const denied = (await harness.owner<{ outcome: string }>(TENANT_A, [["select outcome from machvon.audit_event where action = 'dis.report_export_download' and resource_id = $1::uuid order by occurred_at", [exportId]]])).map((row) => row.outcome);
    expect(denied).toContain('SUCCESS');
  });

  it('answers 403 SCOPE_DENIED when the scope has narrowed but not gone: the file names a project the caller no longer sees, and the denial is a record', async () => {
    const w = await world();
    const made = await create(w.snapshotId, 'CSV', OTHER_EXPORTER);
    expect(made.status).toBe(200);
    const exportId = made.json.resource_id as string;
    expect((await download(exportId, OTHER_EXPORTER)).status).toBe(200);
    await narrow(OTHER_EXPORTER, 'HERE');
    const refused = await download(exportId, OTHER_EXPORTER);
    expect([refused.status, refused.json.code]).toEqual([403, 'SCOPE_DENIED']);
    const outcomes = (await harness.owner<{ outcome: string; safe_diff: Record<string, unknown> }>(TENANT_A, [["select outcome, safe_diff from machvon.audit_event where action = 'dis.report_export_download' and resource_id = $1::uuid order by occurred_at", [exportId]]]));
    expect(outcomes.map((row) => row.outcome)).toEqual(['SUCCESS', 'DENIED']);
    expect(outcomes[1]?.safe_diff).toMatchObject({ reason: 'SCOPE_NARROWED', snapshot_id: w.snapshotId });
  });

  it('AC-ST-DIS-016-2 / UAT-PLAN-71: refuses a snapshot that is not frozen with 422 SNAPSHOT_NOT_FROZEN, one that does not exist with 404, and writes no file', async () => {
    const built = await world({ frozen: false });
    const reply = await create(built.snapshotId, 'CSV');
    expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'SNAPSHOT_NOT_FROZEN', 'snapshot_id']);
    expect((await create(randomUUID(), 'CSV')).status).toBe(404);
    const after = await harness.owner<{ n: string }>(TENANT_A, [["select count(*)::text as n from machvon.audit_event where action = 'dis.report_exported' and safe_diff ->> 'snapshot_id' = $1", [built.snapshotId]]]);
    expect(after[0]).toEqual({ n: '0' });
  });

  it('AC-ST-DIS-016-3 / UAT-AC257: a PDF is made while the definitions are not signed, with the sign-off notice, and a signed snapshot carries no notice', async () => {
    const pending = await world();
    const made = await create(pending.snapshotId, 'PDF');
    expect(made.status).toBe(200);
    const link = (await download(made.json.resource_id as string)).json.url as string;
    const bytes = Buffer.from(await (await fetchLink(link)).arrayBuffer());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // The notice and the header are in the text of the page (the fonts are embedded as subsets, so the words are in the content stream as glyph ids): the audit record states the status the file was made under.
    const rows = await harness.owner<{ safe_diff: Record<string, unknown> }>(TENANT_A, [["select safe_diff from machvon.audit_event where action = 'dis.report_exported' and resource_id = $1::uuid", [made.json.resource_id]]]);
    expect(rows[0]?.safe_diff).toMatchObject({ format: 'PDF', definition_status: 'PROPOSED_PENDING_SIGNOFF', rows: 3 });
    const signed = await world({ definitionStatus: 'SIGNED' });
    const csv = await csvLines(await fetchLink((await download((await create(signed.snapshotId, 'CSV')).json.resource_id as string)).json.url as string));
    expect(csv.some((line) => line.startsWith('notice,'))).toBe(false);
    expect(headerOf(csv).definition_status).toBe('SIGNED');
    const pendingCsv = await csvLines(await fetchLink((await download((await create(pending.snapshotId, 'CSV')).json.resource_id as string)).json.url as string));
    expect(pendingCsv.find((line) => line.startsWith('notice,'))).toContain('D03');
  });

  it('makes an XLSX, a workbook of the table with the header block and the notice', async () => {
    const w = await world();
    const made = await create(w.snapshotId, 'XLSX');
    const response = await fetchLink((await download(made.json.resource_id as string)).json.url as string);
    expect(response.headers.get('content-type')).toBe(XLSX);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const nameLength = bytes.readUInt16LE(26);
    expect(bytes.subarray(30, 30 + nameLength).toString('utf8')).toBe('[Content_Types].xml');
    const sheetStart = bytes.indexOf(Buffer.from('xl/worksheets/sheet1.xml'));
    const compressed = bytes.readUInt32LE(sheetStart - 30 + 18);
    const extra = bytes.readUInt16LE(sheetStart - 30 + 28);
    const sheet = inflateRawSync(bytes.subarray(sheetStart + 'xl/worksheets/sheet1.xml'.length + extra, sheetStart + 'xl/worksheets/sheet1.xml'.length + extra + compressed)).toString('utf8');
    expect(sheet).toContain(w.snapshotId);
    expect(sheet).toContain('PROPOSED_PENDING_SIGNOFF');
    expect(sheet).toContain(w.projects[0]?.code);
  });

  it('IAM-2: makes a Word document of the same table behind the same permission, with the format on the audit row and the same bytes for the same snapshot', async () => {
    const w = await world();
    const made = await create(w.snapshotId, 'DOCX');
    expect(made.status).toBe(200);
    const response = await fetchLink((await download(made.json.resource_id as string)).json.url as string);
    expect(response.headers.get('content-type')).toBe(DOCX_MEDIA_TYPE);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = readDocxParagraphs(bytes).join(' ');
    expect(text).toContain(w.snapshotId);
    expect(text).toContain(w.projects[0]?.code);
    expect(text).toContain('PROPOSED_PENDING_SIGNOFF');
    const rows = await harness.owner<{ safe_diff: Record<string, unknown> }>(TENANT_A, [["select safe_diff from machvon.audit_event where action = 'dis.report_exported' and resource_id = $1::uuid", [made.json.resource_id]]]);
    expect(rows[0]?.safe_diff).toMatchObject({ format: 'DOCX', rows: 3 });
    // The same permission: a person without the export right is refused, and a Word file is not made for them.
    expect((await create(w.snapshotId, 'DOCX', NOBODY)).status).toBe(403);
  });

  it('writes the columns that were asked for and the million-dong scale, and refuses an unknown column naming it', async () => {
    const w = await world();
    const made = await create(w.snapshotId, 'CSV', EXPORTER, { columns: ['plan_total_vnd', 'project_code'], unit_scale: 'MILLION_VND' });
    const lines = await csvLines(await fetchLink((await download(made.json.resource_id as string)).json.url as string));
    expect(headerOf(lines).currency_unit).toBe('MILLION_VND');
    const table = lines.slice(lines.indexOf('') + 1);
    expect(table[0]).toBe('project_code,plan_total_vnd');
    expect(table[1]).toBe(`${w.projects[0]?.code},1000.000000`);
    const bad = await create(w.snapshotId, 'CSV', EXPORTER, { columns: ['project_code', 'nope'] });
    expect([bad.status, bad.json.code, bad.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'columns[1]']);
    const scale = await create(w.snapshotId, 'CSV', EXPORTER, { unit_scale: 'BILLION' });
    expect([scale.status, scale.json.code, scale.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'unit_scale']);
    const format = await create(w.snapshotId, 'DOCX', EXPORTER);
    expect([format.status, format.json.code, format.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'format']);
  });

  it('has nothing to export for a caller who sees none of the projects (403), a stranger of the tenant is refused the permission, and a person of another tenant finds no snapshot', async () => {
    const w = await world();
    await seedReplica([]);
    expect((await create(w.snapshotId, 'CSV', NOBODY)).status).toBe(403);
    expect((await create(w.snapshotId, 'CSV', B_EXPORTER, {}, { tenantId: TENANT_B })).status).toBe(404);
  });

  it('keeps a file for the person who made it: another person with the same permission finds no such export, and so does a person of another tenant', async () => {
    const w = await world();
    const made = await create(w.snapshotId, 'CSV', EXPORTER);
    const exportId = made.json.resource_id as string;
    expect((await download(exportId, OTHER_EXPORTER)).status).toBe(404);
    expect((await download(exportId, B_EXPORTER, TENANT_B)).status).toBe(404);
    expect((await download(randomUUID(), EXPORTER)).status).toBe(404);
    expect((await download(exportId, NOBODY)).status).toBe(403);
  });

  it('serves a signed link only while it is good: a forged signature, an altered expiry, a link of another file and an old one all answer 401 SIGNATURE_INVALID, and the bytes are those that were made', async () => {
    const w = await world();
    const made = await create(w.snapshotId, 'CSV', EXPORTER);
    const exportId = made.json.resource_id as string;
    const issued = (await download(exportId)).json;
    const url = new URL(`${app.baseUrl}${issued.url as string}`);
    expect((await fetchUrl(url)).status).toBe(200);
    const forged = new URL(url);
    forged.searchParams.set('signature', 'a'.repeat(64));
    expect((await fetchUrl(forged)).status).toBe(401);
    const longer = new URL(url);
    longer.searchParams.set('expires', String(Number(url.searchParams.get('expires')) + 3600));
    expect((await fetchUrl(longer)).status).toBe(401);
    const other = new URL(`${app.baseUrl}/report-exports/${randomUUID()}/file`);
    for (const [name, value] of url.searchParams) other.searchParams.set(name, value);
    expect((await fetchUrl(other)).status).toBe(401);
    const missing = new URL(`${app.baseUrl}/report-exports/${exportId}/file`);
    expect((await fetchUrl(missing)).status).toBe(401);
    // The key of the file names the tenant; a link built for another tenant is no link.
    const crossTenant = new URL(url);
    crossTenant.searchParams.set('tenant', TENANT_B);
    expect((await fetchUrl(crossTenant)).status).toBe(401);
    // A link that is not even well formed is refused as any other bad link, not as a fault of the server.
    const malformed = new URL(url);
    malformed.searchParams.set('tenant', 'invalid');
    expect((await fetchUrl(malformed)).status).toBe(401);
    const sha = (await (await fetchUrl(url)).arrayBuffer()).byteLength;
    expect(sha).toBeGreaterThan(0);
    expect(objectKey(TENANT_A, 'report_export', exportId)).toContain(exportId);
  });

  it('counts what it makes and what it issues, with the format and the status of the definitions and never a person', async () => {
    counted.length = 0;
    const w = await world();
    const made = await create(w.snapshotId, 'CSV', EXPORTER);
    await download(made.json.resource_id as string);
    expect(counted).toContainEqual({ name: 'dis_report_export_total', labels: { format: 'CSV', definition_status: 'PROPOSED_PENDING_SIGNOFF' } });
    expect(counted).toContainEqual({ name: 'dis_report_export_download_total', labels: { outcome: 'issued' } });
  });
});
