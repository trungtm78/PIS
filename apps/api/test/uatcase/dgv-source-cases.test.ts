import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { DgvMappingStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { DgvCatalogController, DgvDatasetController } from '../../src/modules/dgv/dgv-dataset.controller';
import { QualityIncidentReadsController } from '../../src/modules/dgv/dgv-incident.controller';
import { DgvMappingCommandsController, DgvMappingReadsController, DgvReconciliationController } from '../../src/modules/dgv/dgv-source.controller';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedSnapshot } from '../../../../packages/db/test/support/dgv-quality-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

jest.setTimeout(240_000);

/**
 * The cases of the data governance area that the UAT plan asks for with figures and with the pipeline of a source (FR-DGV-09 reconciliation of the Treasury with the accepted report, FR-DGV-20 the confirmed mapping of a
 * unit): a closed month with the Treasury at 98.45 billion against 98.2 billion in the report, and a weekly report in millions of dong that is quarantined until the owner confirms the mapping.
 */
const SIGNING_KEY = randomBytes(32);
const STEWARD = 1; // proposes mappings, runs reconciliations
const OWNER = 2; // owns the datasets, confirms mappings
const READER = 3; // reads
const PERIOD = '2026-10';
const CUTOFF = `${PERIOD}-25`;

describe('the reconciliation of the Treasury with the accepted report, and the mapping of a source (UAT cases of DGV)', () => {
  const harness = new AuthzHarness();
  const mappings = new DgvMappingStore();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  async function dataset(code: string): Promise<string> {
    counter += 1;
    const created = await call('POST', '/dgv/datasets', {
      member: STEWARD,
      body: { dataset_code: `${code}-${counter}`, title: `Dataset ${code}`, domain: 'DISBURSEMENT', grain: 'one row per project', producer_module: 'DIS', owner_user_id: memberId(OWNER), steward_user_id: memberId(STEWARD), classification: 'INTERNAL', is_critical: true, freshness_slo_seconds: 86_400 },
    });
    assertStatus(created, 200);
    return created.json.resource_id as string;
  }

  /** A closed month: a frozen snapshot with one line per project, each reporting what it disbursed (null: the report has no figure for the project); the Treasury cut-off of the report is the 25th. */
  async function closedMonth(reported: Array<string | null>): Promise<string[]> {
    const periodId = randomUUID();
    const snapshot = await seedSnapshot(harness, TENANT_A, STEWARD, { status: 'BUILDING', lines: reported.map(() => ({ ctmtqg: '0' })) });
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, ($4::date + interval '1 month - 1 day')::date, now(), 'CAL-N', 'MONTH', 2026, 'OPEN', gen_random_uuid(), $5, $5)`,
        [TENANT_A, periodId, PERIOD, `${PERIOD}-01`, memberId(STEWARD)],
      ],
      ['alter table machvon.period_snapshot disable trigger period_snapshot_guard'],
      ['update machvon.period_snapshot set period_id = $2, treasury_cutoff_date = $3::date where id = $1', [snapshot.id, periodId, CUTOFF]],
      ['alter table machvon.period_snapshot enable trigger period_snapshot_guard'],
    ]);
    for (const [n, projectId] of snapshot.projectIds.entries()) {
      await harness.owner(TENANT_A, [
        ['alter table machvon.period_snapshot_line disable trigger period_snapshot_line_guard'],
        ['update machvon.period_snapshot_line set disbursed_reported_vnd = $2::numeric where snapshot_id = $1 and project_id = $3', [snapshot.id, reported[n], projectId]],
        ['alter table machvon.period_snapshot_line enable trigger period_snapshot_line_guard'],
      ]);
    }
    await harness.owner(TENANT_A, [["update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('c', 64), frozen_by = $2, frozen_at = now() where id = $1", [snapshot.id, memberId(STEWARD)]]]);
    return snapshot.projectIds;
  }

  async function paid(projectId: string, amount: string, at: string): Promise<void> {
    const id = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind, provider_event_id, direction)
         values ($1, $2, $3, $4, 'TREASURY', $5::numeric, $6::timestamptz, repeat('d', 64), 'CALLBACK_MOCK', $4, 'PAYMENT')`,
        [TENANT_A, id, projectId, `EXT-${id}`, amount, at],
      ],
    ]);
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [STEWARD, OWNER, READER]) await harness.seedMembership(TENANT_A, n, 1);
    await dropSnapshotFixtureKeys(harness, TENANT_A);
    await harness.owner(TENANT_A, [['alter table machvon.reporting_period drop constraint reporting_period_calendar_version_fk']]);
    const reads = ['data.catalog.read', 'data.mapping.read', 'data.quality.read', 'quality_incident.read'];
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', ['data.catalog.manage', 'data.mapping.manage', 'data.mapping.approve', 'data.quality.run', ...reads], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_OWNER', ['data.mapping.approve', ...reads], 30);
    await harness.seedRole(TENANT_A, 3, 'DATA_READER', reads, 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DgvDatasetController, DgvCatalogController, QualityIncidentReadsController, DgvMappingCommandsController, DgvMappingReadsController, DgvReconciliationController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('UAT-AC488: the Treasury 98,450,000,000 against the accepted report 98,200,000,000 is DIFFERENT by 250,000,000, in three differences by kind, with both totals kept apart and an incident for the owner', async () => {
    const datasetId = await dataset('DS-PAY-DIS');
    // The report has the one project that was paid 98.2 billion and nothing for the three others; two of those were paid before the cut-off of the report, one after it.
    const [big, missingOne, missingTwo, late] = await closedMonth(['98200000000', null, null, null]);
    await paid(big as string, '98200000000', `${PERIOD}-10T09:00:00+07:00`);
    await paid(missingOne as string, '100000000', `${PERIOD}-11T09:00:00+07:00`);
    await paid(missingTwo as string, '100000000', `${PERIOD}-12T09:00:00+07:00`);
    await paid(late as string, '50000000', `${PERIOD}-28T09:00:00+07:00`);

    const ran = await call('POST', '/dgv/reconciliations', {
      member: STEWARD,
      body: { recon_code: 'PAY_vs_DIS', source_a: 'PAY.treasury_transaction', source_b: 'DIS.report_accepted', as_of_period: PERIOD, basis: 'VND, ngày Kho bạc thanh toán', tolerance_vnd: '0', dataset_id: datasetId },
    });
    assertStatus(ran, 202);
    expect(ran.json).toMatchObject({ status: 'DIFFERENT', resource_version: 1 });
    const id = ran.json.resource_id as string;
    const detail = await call('GET', `/dgv/reconciliations/${id}`, { member: READER });
    assertStatus(detail, 200);
    expect(detail.json).toMatchObject({
      result: 'DIFFERENT',
      total_a_vnd: '98450000000',
      total_b_vnd: '98200000000',
      difference_vnd: '250000000',
      differences_truncated: false,
      by_kind: { MISSING: 2, TIMING: 1, REVERSAL: 0, MAPPING: 0, AMOUNT: 0 },
      owner: { id: memberId(OWNER) },
    });
    const differences = detail.json.differences as Array<{ key: string; kind: string; amount_a_vnd: string; amount_b_vnd: string; difference_vnd: string }>;
    expect(differences).toHaveLength(3);
    expect(Object.fromEntries(differences.map((entry) => [entry.key, entry.kind]))).toEqual({ [missingOne as string]: 'MISSING', [missingTwo as string]: 'MISSING', [late as string]: 'TIMING' });
    // Neither side is taken as the true one: each difference keeps the two amounts as the two sources gave them, and the two totals are not added.
    for (const entry of differences) expect([entry.amount_b_vnd, BigInt(entry.amount_a_vnd) - BigInt(entry.amount_b_vnd) === BigInt(entry.difference_vnd)]).toEqual(['0', true]);
    expect(BigInt(detail.json.total_a_vnd as string) - BigInt(detail.json.total_b_vnd as string)).toBe(BigInt(differences.reduce((sum, entry) => sum + BigInt(entry.difference_vnd), 0n)));
    const incident = await call('GET', `/resources/quality_incident/${detail.json.incident_id as string}`, { member: STEWARD });
    assertStatus(incident, 200);
    expect(incident.json).toMatchObject({ status: 'OPEN', reconciliation_id: id, owner: { id: memberId(OWNER) } });
    // Nothing of the two systems was written to: the reconciliation only reads them.
    const treasury = await rows<{ total: string }>("select coalesce(sum(amount_vnd), 0)::text as total from machvon.treasury_transaction where project_id = any($1::uuid[])", [[big, missingOne, missingTwo, late]]);
    expect(treasury[0]?.total).toBe('98450000000');
  });

  it('UAT-AC491: a mapping in millions of dong is confirmed by somebody else; the batch before the confirmation is quarantined as MAPPING_NOT_CONFIRMED and the batch after it is read with the factor 1,000,000', async () => {
    const datasetId = await dataset('DS-WEEKLY');
    const proposed = await call('POST', '/dgv/source-mappings', {
      member: STEWARD,
      body: { dataset_id: datasetId, source_system: 'BC_TUAN', source_field: 'so_tien', target_field: 'funding_snapshot_line.amount_vnd', unit: 'triệu đồng' },
    });
    assertStatus(proposed, 200);
    const mappingId = proposed.json.resource_id as string;
    const gate = (batchRef: string) =>
      harness.tenants.withTenant(contextFor(TENANT_A, memberId(STEWARD)), (tx) => mappings.gate(tx, { datasetId, sourceSystem: 'BC_TUAN', batchRef, rowCount: 40, sourceFields: ['so_tien'], actor: memberId(STEWARD) }));

    const before = await gate('BC-TUAN-01');
    expect(before).toMatchObject({ outcome: 'QUARANTINED', reason: 'MAPPING_NOT_CONFIRMED', missing: ['so_tien'] });

    const own = await call('POST', `/dgv/source-mappings/${mappingId}/decision`, { member: STEWARD, ifMatch: '"1"', body: { decision: 'CONFIRMED' } });
    assertStatus(own, 403, 'SELF_APPROVAL_DENIED');
    expect((await rows<{ status: string }>('select status from machvon.dataset_source_mapping where id = $1', [mappingId]))[0]?.status).toBe('PROPOSED');
    const stillOut = await gate('BC-TUAN-02');
    expect(stillOut.outcome).toBe('QUARANTINED');

    const confirmed = await call('POST', `/dgv/source-mappings/${mappingId}/decision`, { member: OWNER, ifMatch: '"1"', body: { decision: 'CONFIRMED', note: 'Đơn vị đã kiểm với báo cáo tuần.' } });
    assertStatus(confirmed, 200);
    expect(confirmed.json).toMatchObject({ status: 'CONFIRMED', resource_version: 2 });
    const after = await gate('BC-TUAN-03');
    expect(after).toMatchObject({ outcome: 'APPLIED', fields: [{ sourceField: 'so_tien', targetField: 'funding_snapshot_line.amount_vnd', factor: 1_000_000n }] });

    const gates = await call('GET', `/dgv/batch-gates?dataset_id=${datasetId}`, { member: READER });
    assertStatus(gates, 200);
    const items = gates.json.items as Array<{ batch_ref: string; outcome: string; reason: string | null; fields: Array<{ factor?: string; missing?: boolean }> }>;
    expect(items.map((item) => [item.batch_ref, item.outcome, item.reason])).toEqual([
      ['BC-TUAN-03', 'APPLIED', null],
      ['BC-TUAN-02', 'QUARANTINED', 'MAPPING_NOT_CONFIRMED'],
      ['BC-TUAN-01', 'QUARANTINED', 'MAPPING_NOT_CONFIRMED'],
    ]);
    expect(items[0]?.fields[0]?.factor).toBe('1000000');
  });

  it('negative control of the data governance cases: a check fed a wrong total or a wrong refusal throws', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403, 'SELF_APPROVAL_DENIED'));
    expectCheckFails(() => assertStatus({ status: 403, json: { code: 'SCOPE_DENIED' } }, 403, 'SELF_APPROVAL_DENIED'));
    expectCheckFails(() => expect({ total_a_vnd: '98450000000', total_b_vnd: '98200000000' }).toMatchObject({ total_a_vnd: '98200000000' }));
  });
});
