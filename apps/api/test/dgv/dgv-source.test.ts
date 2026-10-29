import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { DgvCatalogController, DgvDatasetController } from '../../src/modules/dgv/dgv-dataset.controller';
import { QualityIncidentReadsController } from '../../src/modules/dgv/dgv-incident.controller';
import { DgvMappingCommandsController, DgvMappingReadsController, DgvReconciliationController } from '../../src/modules/dgv/dgv-source.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedSnapshot } from '../../../../packages/db/test/support/dgv-quality-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const STEWARD = 1; // proposes mappings, runs reconciliations
const OWNER = 2; // owns the datasets, confirms mappings
const READER = 3; // reads, writes nothing
const UNIT_STEWARD = 4; // the same rights as the steward, on a unit subtree only
const OTHER_TENANT = 5;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('source mappings and reconciliation over HTTP (ST-DGV-004)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let tenants: TenantDatabase;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  const propose = (member: number, body: Record<string, unknown>, tenantId?: string) => call('POST', '/dgv/source-mappings', { member, body, ...(tenantId === undefined ? {} : { tenantId }) });
  const decide = (member: number, id: string, version: number, body: Record<string, unknown>, tenantId?: string) => call('POST', `/dgv/source-mappings/${id}/decision`, { member, ifMatch: `"${version}"`, body, ...(tenantId === undefined ? {} : { tenantId }) });
  const outbox = (id: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);

  async function dataset(extra: Record<string, unknown> = {}): Promise<string> {
    counter += 1;
    const created = await call('POST', '/dgv/datasets', {
      member: STEWARD,
      body: { dataset_code: `DS-SRC-${counter}-${randomUUID().slice(0, 5)}`.toUpperCase(), title: `Source dataset ${counter}`, domain: 'DISBURSEMENT', grain: 'one row per project', producer_module: 'DIS', owner_user_id: memberId(OWNER), steward_user_id: memberId(STEWARD), classification: 'INTERNAL', is_critical: true, freshness_slo_seconds: 86_400, ...extra },
    });
    expect(created.status).toBe(200);
    return created.json.resource_id as string;
  }
  const mappingBody = (datasetId: string, extra: Record<string, unknown> = {}) => ({ dataset_id: datasetId, source_system: 'PAY', source_field: 'so_tien', target_field: 'amount_vnd', unit: 'triệu đồng', ...extra });

  /** A closed month: a frozen snapshot with one line per project, each reporting what it disbursed; the Treasury cut-off of the report is the 25th. */
  async function closedMonth(reported: string[], period: string): Promise<string[]> {
    const periodId = randomUUID();
    const snapshot = await seedSnapshot(harness, TENANT_A, STEWARD, { status: 'BUILDING', lines: reported.map(() => ({ ctmtqg: '0' })) });
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, ($4::date + interval '1 month - 1 day')::date, now(), 'CAL-N', 'MONTH', 2026, 'OPEN', gen_random_uuid(), $5, $5)`,
        [TENANT_A, periodId, period, `${period}-01`, memberId(STEWARD)],
      ],
      ['alter table machvon.period_snapshot disable trigger period_snapshot_guard'],
      ['update machvon.period_snapshot set period_id = $2, treasury_cutoff_date = $3::date where id = $1', [snapshot.id, periodId, `${period}-25`]],
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
  const recon = (member: number, body: Record<string, unknown>, tenantId?: string) =>
    call('POST', '/dgv/reconciliations', {
      member,
      body: { recon_code: 'PAY-DIS-MONTH', source_a: 'PAY.treasury_transaction', source_b: 'DIS.report_accepted', as_of_period: '2026-08', basis: 'VND, ngày Kho bạc thanh toán', tolerance_vnd: '0', ...body },
      ...(tenantId === undefined ? {} : { tenantId }),
    });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [STEWARD, OWNER, READER, UNIT_STEWARD]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, 1);
    await dropSnapshotFixtureKeys(harness, TENANT_A);
    await harness.owner(TENANT_A, [['alter table machvon.reporting_period drop constraint reporting_period_calendar_version_fk']]);
    const reads = ['data.catalog.read', 'data.mapping.read', 'data.quality.read', 'quality_incident.read'];
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', ['data.catalog.manage', 'data.mapping.manage', 'data.mapping.approve', 'data.quality.run', ...reads], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_OWNER', ['data.mapping.approve', ...reads], 30);
    await harness.seedRole(TENANT_A, 3, 'DATA_READER', reads, 10);
    await harness.seedRole(TENANT_A, 4, 'UNIT_STEWARD', ['data.mapping.manage', 'data.mapping.approve', 'data.quality.run', ...reads], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: UNIT_STEWARD, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedRole(TENANT_B, 1, 'DATA_STEWARD', ['data.mapping.manage', 'data.mapping.approve', 'data.mapping.read', 'data.quality.read', 'data.quality.run'], 40);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    tenants = harness.tenants as TenantDatabase;
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

  it('AC-ST-DGV-004-2: a mapping is proposed with a unit, confirmed by somebody else at the version read, and the decision is audited and published', async () => {
    const datasetId = await dataset();
    const proposed = await propose(STEWARD, mappingBody(datasetId));
    expect(proposed).toMatchObject({ status: 200, json: { status: 'PROPOSED', resource_version: 1 } });
    const id = proposed.json.resource_id as string;
    expect((await outbox(id, 'dgv.mapping.proposed.v1'))[0]?.payload).toMatchObject({ mapping_id: id, dataset_id: datasetId, source_system: 'PAY', actor_id: memberId(STEWARD) });
    // The proposer does not confirm; a stale screen is told so; a reader and a steward limited to a unit cannot.
    expect(await decide(STEWARD, id, 1, { decision: 'CONFIRMED' })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await decide(OWNER, id, 9, { decision: 'CONFIRMED' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await decide(READER, id, 1, { decision: 'CONFIRMED' })).toMatchObject({ status: 403 });
    expect(await decide(UNIT_STEWARD, id, 1, { decision: 'CONFIRMED' })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await decide(OWNER, id, 1, { decision: 'MAYBE' })).toMatchObject({ status: 422, json: { detail: 'decision' } });
    expect(await decide(OWNER, id, 1, { decision: 'CONFIRMED', note: 'x'.repeat(1001) })).toMatchObject({ status: 422, json: { detail: 'note' } });
    expect((await rows<{ status: string }>('select status from machvon.dataset_source_mapping where id = $1', [id]))[0]?.status).toBe('PROPOSED');
    expect(await decide(OWNER, id, 1, { decision: 'CONFIRMED', note: 'Đơn vị đã kiểm với KBNN.' })).toMatchObject({ status: 200, json: { status: 'CONFIRMED', resource_version: 2 } });
    expect(await decide(OWNER, id, 2, { decision: 'REJECTED' })).toMatchObject({ status: 409, json: { code: 'MAPPING_STATE_INVALID' } });
    const audit = await rows<{ reason: string | null; safe_diff: Record<string, unknown> }>("select reason, safe_diff from machvon.audit_event where resource_id = $1 and action = 'dgv.source_mapping_decided'", [id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: 'Đơn vị đã kiểm với KBNN.', safe_diff: { decision: 'CONFIRMED', dataset_id: datasetId, proposed_by: memberId(STEWARD) } });
    expect((await outbox(id, 'dgv.mapping.decided.v1'))[0]?.payload).toMatchObject({ decision: 'CONFIRMED', version: 2, actor_id: memberId(OWNER) });
  });

  it('refuses what a mapping cannot be: a unit nobody knows, a short text, a duplicate that is live, a dataset that is not there, a steward limited to a unit, a reader', async () => {
    const datasetId = await dataset();
    expect(await propose(STEWARD, mappingBody(datasetId, { unit: 'đô la' }))).toMatchObject({ status: 422, json: { detail: 'unit' } });
    expect(await propose(STEWARD, mappingBody(datasetId, { source_system: 'P' }))).toMatchObject({ status: 422, json: { detail: 'source_system' } });
    expect(await propose(STEWARD, mappingBody(datasetId, { source_field: '  ' }))).toMatchObject({ status: 422, json: { detail: 'source_field' } });
    expect(await propose(STEWARD, mappingBody(randomUUID()))).toMatchObject({ status: 404 });
    expect(await propose(UNIT_STEWARD, mappingBody(datasetId))).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await propose(READER, mappingBody(datasetId))).toMatchObject({ status: 403 });
    expect(await propose(STEWARD, mappingBody(datasetId))).toMatchObject({ status: 200 });
    expect(await propose(STEWARD, mappingBody(datasetId))).toMatchObject({ status: 409, json: { code: 'MAPPING_DUPLICATE' } });
    expect(await rows('select id from machvon.dataset_source_mapping where dataset_id = $1', [datasetId])).toHaveLength(1);
  });

  it('lists the mappings with what the viewer may do, by dataset and status, and not to another tenant; the gates the same', async () => {
    const datasetId = await dataset();
    const first = (await propose(STEWARD, mappingBody(datasetId, { source_field: 'a' }))).json.resource_id as string;
    await propose(STEWARD, mappingBody(datasetId, { source_field: 'b' }));
    await decide(OWNER, first, 1, { decision: 'CONFIRMED' });
    const all = await call('GET', `/dgv/source-mappings?dataset_id=${datasetId}`, { member: OWNER });
    expect(all.status).toBe(200);
    const items = all.json.items as Array<{ id: string; status: string; source_field: string; actions: { decide: boolean }; proposed_by: { id: string } }>;
    expect(items.map((item) => [item.source_field, item.status])).toEqual([['b', 'PROPOSED'], ['a', 'CONFIRMED']]);
    // The owner may decide on the one that waits; the proposer may not, whatever their rights.
    expect(items.map((item) => item.actions.decide)).toEqual([true, false]);
    const mine = await call('GET', `/dgv/source-mappings?dataset_id=${datasetId}&status=PROPOSED`, { member: STEWARD });
    expect((mine.json.items as Array<{ actions: { decide: boolean } }>).map((item) => item.actions.decide)).toEqual([false]);
    expect(await call('GET', `/dgv/source-mappings?dataset_id=${datasetId}&status=BOGUS`, { member: OWNER })).toMatchObject({ status: 422, json: { detail: 'status' } });
    expect(await call('GET', '/dgv/source-mappings?dataset_id=not-a-uuid', { member: OWNER })).toMatchObject({ status: 422, json: { detail: 'dataset_id' } });
    expect(await call('GET', `/dgv/source-mappings?dataset_id=${datasetId}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 200, json: { items: [] } });
    expect(await decide(OTHER_TENANT, first, 2, { decision: 'REJECTED' }, TENANT_B)).toMatchObject({ status: 404 });
    // The gates: what the pipeline did with a batch is read by those who read mappings.
    await rows(
      `insert into machvon.dataset_batch_gate (tenant_id, id, dataset_id, source_system, batch_ref, outcome, reason, row_count, fields, gated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'PAY', 'B-API-1', 'QUARANTINED', 'MAPPING_NOT_CONFIRMED', 12, '[{"source_field":"so_tien","missing":true}]'::jsonb, $2::uuid)`,
      [datasetId, memberId(STEWARD)],
    );
    const gates = await call('GET', `/dgv/batch-gates?dataset_id=${datasetId}&outcome=QUARANTINED`, { member: READER });
    expect(gates).toMatchObject({ status: 200, json: { items: [{ batch_ref: 'B-API-1', outcome: 'QUARANTINED', reason: 'MAPPING_NOT_CONFIRMED', row_count: 12, dataset_id: datasetId }] } });
    expect(await call('GET', `/dgv/batch-gates?dataset_id=${datasetId}&outcome=APPLIED`, { member: READER })).toMatchObject({ status: 200, json: { items: [] } });
    expect(await call('GET', `/dgv/batch-gates?dataset_id=${datasetId}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 200, json: { items: [] } });
  });

  it('AC-ST-DGV-004-1: a reconciliation compares the two sources on the same basis, keeps the difference by kind, opens one incident, and the reads show it without merging the totals', async () => {
    const datasetId = await dataset();
    const [match, over, late] = await closedMonth(['100', '50', '0'], '2026-08');
    await paid(match as string, '100', '2026-08-10T09:00:00+07:00');
    await paid(over as string, '80', '2026-08-11T09:00:00+07:00');
    await paid(late as string, '30', '2026-08-28T09:00:00+07:00');
    const ran = await recon(STEWARD, { dataset_id: datasetId });
    expect(ran).toMatchObject({ status: 202, json: { status: 'DIFFERENT', resource_version: 1 } });
    const id = ran.json.resource_id as string;
    const detail = await call('GET', `/dgv/reconciliations/${id}`, { member: READER });
    expect(detail).toMatchObject({
      status: 200,
      json: { id, recon_code: 'PAY-DIS-MONTH', result: 'DIFFERENT', total_a_vnd: '210', total_b_vnd: '150', difference_vnd: '60', by_kind: { MISSING: 0, TIMING: 1, REVERSAL: 0, MAPPING: 0, AMOUNT: 1 }, differences_truncated: false, owner: { id: memberId(OWNER) }, dataset_id: datasetId },
    });
    const differences = detail.json.differences as Array<{ key: string; kind: string }>;
    expect(Object.fromEntries(differences.map((entry) => [entry.key, entry.kind]))).toEqual({ [over as string]: 'AMOUNT', [late as string]: 'TIMING' });
    const incidentId = detail.json.incident_id as string;
    expect(incidentId).toEqual(expect.any(String));
    // The list is the summary: no difference by difference.
    const listed = await call('GET', '/dgv/reconciliations?recon_code=PAY-DIS-MONTH&result=DIFFERENT', { member: READER });
    expect(listed.status).toBe(200);
    const summary = (listed.json.items as Array<Record<string, unknown>>).find((item) => item.id === id);
    expect(summary).toMatchObject({ differences_count: 2, result: 'DIFFERENT', incident_id: incidentId });
    expect(summary).not.toHaveProperty('differences');
    // The incident is the owner's, about this reconciliation, and the incident read says so.
    const incident = await call('GET', `/resources/quality_incident/${incidentId}`, { member: OWNER });
    expect(incident).toMatchObject({ status: 200, json: { severity: 'HIGH', status: 'OPEN', sla_hours: 24, run_id: null, reconciliation_id: id, rule: { code: 'PAY-DIS-MONTH', dimension: 'RECONCILIATION' }, owner: { id: memberId(OWNER) } } });
    // Audit and event name the figures and the incident, never the projects.
    const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'dgv.reconciliation_run'", [id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.safe_diff).toMatchObject({ result: 'DIFFERENT', total_a_vnd: '210', total_b_vnd: '150', incident_id: incidentId, differences: 2 });
    expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain(over as string);
    expect((await outbox(id, 'dgv.reconciliation.completed.v1'))[0]?.payload).toMatchObject({ reconciliation_id: id, result: 'DIFFERENT', incident_id: incidentId });
    // Again the same month: the same problem, the same incident.
    const again = await recon(STEWARD, { dataset_id: datasetId });
    expect((await call('GET', `/dgv/reconciliations/${again.json.resource_id}`, { member: READER })).json.incident_id).toBe(incidentId);
  });

  it('is MATCHED with no incident when the two agree, and refuses sources, a basis, a tolerance or a month it cannot compare, and a caller without the right on the whole tenant', async () => {
    const datasetId = await dataset();
    const [only] = await closedMonth(['7'], '2026-07');
    await paid(only as string, '7', '2026-07-03T09:00:00+07:00');
    const matched = await recon(STEWARD, { dataset_id: datasetId, as_of_period: '2026-07' });
    expect(matched).toMatchObject({ status: 202, json: { status: 'MATCHED' } });
    expect((await call('GET', `/dgv/reconciliations/${matched.json.resource_id}`, { member: STEWARD })).json).toMatchObject({ result: 'MATCHED', incident_id: null, differences: [] });
    expect(await recon(STEWARD, { dataset_id: datasetId, basis: 'VND, ngày báo cáo' })).toMatchObject({ status: 422, json: { code: 'BASIS_MISMATCH', detail: 'basis' } });
    expect(await recon(STEWARD, { dataset_id: datasetId, source_a: 'DIS.report_accepted' })).toMatchObject({ status: 422, json: { code: 'BASIS_MISMATCH', detail: 'source_a' } });
    expect(await recon(STEWARD, { dataset_id: datasetId, tolerance_vnd: '-1' })).toMatchObject({ status: 422, json: { detail: 'tolerance_vnd' } });
    expect(await recon(STEWARD, { dataset_id: datasetId, as_of_period: '2026-9' })).toMatchObject({ status: 422, json: { detail: 'as_of_period' } });
    expect(await recon(STEWARD, { dataset_id: datasetId, as_of_period: '2031-01' })).toMatchObject({ status: 422, json: { code: 'SNAPSHOT_NOT_FOUND' } });
    expect(await recon(STEWARD, { dataset_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'dataset_id' } });
    // The figures are those of every project: a steward of a unit does not run it nor read it, a reader reads but does not run.
    expect(await recon(UNIT_STEWARD, { dataset_id: datasetId, as_of_period: '2026-07' })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await recon(READER, { dataset_id: datasetId, as_of_period: '2026-07' })).toMatchObject({ status: 403 });
    expect(await call('GET', `/dgv/reconciliations/${matched.json.resource_id}`, { member: UNIT_STEWARD })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await call('GET', '/dgv/reconciliations', { member: UNIT_STEWARD })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    // Another tenant neither sees the reconciliation nor can run one against these datasets.
    expect(await call('GET', `/dgv/reconciliations/${matched.json.resource_id}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 404 });
    expect(await call('GET', `/dgv/reconciliations/${randomUUID()}`, { member: STEWARD })).toMatchObject({ status: 404 });
    expect(await recon(OTHER_TENANT, { dataset_id: datasetId, as_of_period: '2026-07' }, TENANT_B)).toMatchObject({ status: 422, json: { detail: 'dataset_id' } });
  });
});
