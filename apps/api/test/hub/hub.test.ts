import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { HUB_CLOCK, hubModule } from '../../src/modules/hub';
import { HubController } from '../../src/modules/hub/hub.controller';
import { HubReadsController } from '../../src/modules/hub/hub-reads.controller';
import { connectorResourceId } from '../../src/modules/hub/hub-view';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1;
const PROPOSER = 2;
const APPROVER = 3;
const READER = 4;
const UNIT_ADMIN = 5;
const NOBODY = 6;
const B_ADMIN = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const NOW = new Date('2027-10-15T03:00:00Z');
const HOURS = 3_600_000;
const ADMIN_RIGHTS = ['hub.read', 'hub.state.manage', 'hub.run.record', 'hub.incident.manage', 'hub.snapshot.capture', 'hub.reject.manage', 'hub.agent.manage', 'hub.agent.heartbeat'];
const REASON = 'Waiting for the official sample file';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the Integration Hub over HTTP (HUB-1)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null }>('select safe_diff, reason from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);
  const seedFile = (position: string, status: 'APPLIED' | 'FAILED', at: Date) =>
    rows(
      `insert into machvon.file_import (tenant_id, connector_code, format_version, file_sha256, file_object_key, status, error_code, rows_total, rows_applied, imported_by, created_at, completed_at)
       values ($1, $2, 'ASSUMED-2026.1', $3, $4, $5, $6, 1, $7, $8, $9::timestamptz, $9::timestamptz)`,
      [TENANT_A, position, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), `tenants/${TENANT_A}/import/${randomUUID()}`, status, status === 'FAILED' ? 'IMPORT_SCHEMA_INVALID' : null, status === 'APPLIED' ? 1 : 0, memberId(ADMIN), at.toISOString()],
    );
  const state = (code: string) => rows<{ enabled: boolean; version: string }>('select enabled, version::text as version from machvon.hub_connector_state where connector_code = $1', [code]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, PROPOSER, APPROVER, READER, UNIT_ADMIN, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HUB_ADMIN', ADMIN_RIGHTS, 50);
    await harness.seedRole(TENANT_A, 2, 'HUB_PROPOSER', ['hub.read', 'hub.mapping.propose'], 30);
    await harness.seedRole(TENANT_A, 3, 'HUB_APPROVER', ['hub.read', 'hub.mapping.approve'], 30);
    await harness.seedRole(TENANT_A, 4, 'HUB_READER', ['hub.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'HUB_ADMIN', ADMIN_RIGHTS, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: PROPOSER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [HubController, HubReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: HUB_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module HUB', () => {
    for (const controller of [HubController, HubReadsController]) expect(hubModule.controllers).toContain(controller);
    expect(hubModule.code).toBe('HUB');
  });

  it('refuses a caller without the right, and a right held over one unit only (a connection belongs to no unit)', async () => {
    expect((await call('GET', '/integration-hub/connectors', { member: NOBODY })).status).toBe(403);
    expect((await call('GET', '/integration-hub/connectors', { member: UNIT_ADMIN })).status).toBe(403);
    expect((await call('POST', '/integration-hub/snapshots', { member: UNIT_ADMIN, body: {} })).status).toBe(403);
    expect((await call('POST', '/integration-hub/snapshots', { member: READER, body: {} })).status).toBe(403);
    expect((await call('POST', '/integration-hub/connectors/treasury.statement/state', { member: READER, ifMatch: 1, body: { enabled: false, reason: REASON } })).status).toBe(403);
    expect((await call('GET', '/integration-hub/connectors', { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(200);
  });

  it('AC-ST-HUB-001-1 / UAT-HUB-001: lists every connector for a tenant that never used one as waiting for the outside, with no percentage, and writes nothing', async () => {
    const reply = await call('GET', '/integration-hub/connectors', { member: READER });
    expect(reply.status).toBe(200);
    const items = reply.json.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.code)).toEqual(['egp.muasamcong', 'treasury.statement', 'procurement.milestones', 'national.project_codes']);
    for (const item of items) expect(item).toMatchObject({ status: 'PENDING_EXTERNAL', acceptance: 'PENDING_EXTERNAL', alert: null, enabled: true });
    expect(items[0]).toMatchObject({ direction: 'BOTH', protocols: ['FILE_DROP'], planned_protocols: ['HTTPS_REST', 'SOAP_XML'], screens: [{ code: 'BID-22', route: '/bid/bid-22' }, { code: 'BID-23', route: '/bid/bid-23' }, { code: 'BID-24', route: '/bid/bid-24' }] });
    expect(reply.json.summary).toMatchObject({ total: 4, monitored: 0, healthy: 0, healthy_percent: null, hub_alert: null });
    expect(reply.json.summary).toMatchObject({ total: 8, monitored: 0, healthy: 0, healthy_percent: null, hub_alert: null });
    // HUB-2: the registry facts of each descriptor ride with the summary, so the catalogue can show what every connection is declared to be.
    const feed = items.find((item) => item.code === 'fin.sotaichinh');
    expect(feed).toMatchObject({
      registry: {
        transports: ['FILE', 'GENERATOR'],
        layouts: [{ code: 'PROJECT', version: 'WORKING-ASSUMPTION-FIN-2026.1', acceptance: 'PENDING_EXTERNAL' }, { code: 'PLAN' }, { code: 'DISBURSEMENT' }, { code: 'MILESTONE' }],
        freshness_rule: 'FIN_FEED',
        max_age_hours: 48,
        warn_after_hours: 24,
        credential_kind: 'NONE',
        state_owner: 'CONNECTOR',
        history: 'FILE_FRAMEWORK',
      },
    });
    expect((feed?.registry as { alert_types: string[] }).alert_types).toEqual(expect.arrayContaining(['CONNECTOR_FAILING', 'CONNECTOR_STALE', 'FEED_STALE']));
    expect(items.find((item) => item.code === 'access.open-api')).toMatchObject({
      registry: { transports: ['API_PULL'], layouts: [], freshness_rule: null, max_age_hours: null, rule_source: 'NOT_JUDGED', credential_kind: 'MACHINE_ACCOUNT', state_owner: 'HUB', history: 'HUB_RUNS', alert_types: ['CONNECTOR_FAILING'] },
    });
    expect(items.find((item) => item.code === 'mdm.catalogue-import')).toMatchObject({ registry: { layouts: [{ code: 'MASTER_FILE', version: 'TENANT-MAPPING', acceptance: 'NOT_APPLICABLE' }], history: 'HUB_RUNS' } });
    expect((await rows('select 1 from machvon.hub_connector_state')).length).toBe(0);
    expect((await rows('select 1 from machvon.hub_health_snapshot')).length).toBe(0);
  });

  it('shows the detail of a connector for every tab: layouts, freshness rule with its origin, protocols, alert types with owner and consequence, pipelines and credentials without a secret', async () => {
    const reply = await call('GET', '/integration-hub/connectors/treasury.statement', { member: READER });
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({
      state: { enabled: true, version: 1, owner: 'HUB' },
      layouts: [{ code: 'STATEMENT', version: 'ASSUMED-2026.1', acceptance: 'PENDING_EXTERNAL' }],
      freshness_rule: { rule_code: 'TREASURY_STATEMENT', source: 'DEFAULT', unverified: true, max_age_hours: 72, warn_after_hours: 36, figures_blocked_when_stale: true },
      credentials: { kind: 'NONE', scopes: [], secret_store: 'VAULT' },
      egress: { policy: 'NONE', hosts: [] },
      open_incidents: 0,
    });
    const protocols = reply.json.protocol_details as Array<Record<string, unknown>>;
    expect(protocols[0]).toMatchObject({ code: 'FILE_DROP', status: 'ACTIVE', egress: 'NONE', implementation: 'END_TO_END' });
    const alerts = reply.json.alert_types as Array<Record<string, unknown>>;
    expect(alerts.map((alert) => alert.code)).toEqual(['CONNECTOR_FAILING', 'CONNECTOR_STALE', 'TREASURY_RECON_ITEM_OVERDUE']);
    for (const alert of alerts) expect(String(alert.owner).length).toBeGreaterThan(0);
    expect(String(alerts[0]?.expected_action).length).toBeGreaterThan(10);
    const pipelines = reply.json.pipelines as Array<Record<string, unknown>>;
    expect(pipelines[0]).toMatchObject({ code: 'STATEMENT', protocol: 'FILE_DROP', mode: 'INCREMENTAL', stages: ['EXTRACT', 'VALIDATE', 'TRANSFORM', 'LOAD'], watermark: null, approved_mapping_version: null });
    expect(JSON.stringify(reply.json)).not.toMatch(/secret:\/\//);
    expect((await call('GET', '/integration-hub/connectors/no.such.connector', { member: READER })).status).toBe(404);
  });

  it('AC-ST-HUB-001-1 / UAT-HUB-001: gives the health summary with the five KPI definitions, each with formula, source, as-of and the unverified flag', async () => {
    const reply = await call('GET', '/integration-hub/health', { member: READER });
    expect(reply.status).toBe(200);
    const kpis = reply.json.kpis as Array<Record<string, unknown>>;
    expect(kpis.map((kpi) => kpi.code)).toEqual(['HUB_CONNECTORS_HEALTHY_PCT', 'HUB_OLDEST_DATA_AGE_DAYS', 'HUB_FAILED_RUNS_7D', 'HUB_DISCREPANCY_BACKLOG', 'HUB_PENDING_MAPPINGS']);
    for (const kpi of kpis) expect(kpi).toMatchObject({ unverified: true, rule_version: 0, as_of: NOW.toISOString() });
    expect(String(kpis[0]?.formula).length).toBeGreaterThan(10);
    expect(kpis[0]?.value).toBeNull();
    expect(reply.json.policy).toMatchObject({ failing_after_runs: 1, hub_stale_ratio_percent: 50, agent_stale_after_minutes: 15, source: 'DEFAULT', unverified: true });
  });

  it('AC-ST-HUB-001-3 / UAT-HUB-003: records a failed run, opens one incident for it with its audit and event, takes a repeat of the same run as already recorded, and closes the incident when a good run follows', async () => {
    const failed = { kind: 'IMPORT', outcome: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID', started_at: new Date(NOW.getTime() - 3 * HOURS).toISOString(), finished_at: new Date(NOW.getTime() - 2 * HOURS).toISOString(), rows_total: 5, source_ref: 'sha:national-1' };
    const first = await call('POST', '/integration-hub/connectors/national.project_codes/runs', { member: ADMIN, body: failed });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: 'RECORDED' });
    const runId = first.json.resource_id as string;
    expect((await audits(runId, 'hub.run_recorded'))[0]?.safe_diff).toMatchObject({ connector_code: 'national.project_codes', outcome: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID', incidents_opened: 1 });
    expect((await events(runId, 'hub.run.recorded.v1'))[0]?.payload).toMatchObject({ connector_code: 'national.project_codes', outcome: 'FAILED' });
    const repeat = await call('POST', '/integration-hub/connectors/national.project_codes/runs', { member: ADMIN, body: failed });
    expect(repeat.json).toMatchObject({ status: 'ALREADY_RECORDED', resource_id: runId });
    const incidents = await call('GET', '/integration-hub/incidents?state=OPEN', { member: READER });
    const open = incidents.json.items as Array<Record<string, unknown>>;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ connector_code: 'national.project_codes', kind: 'FAILING', severity: 'ACTION', state: 'OPEN', opened_by: null });
    expect(open[0]?.alert).toMatchObject({ code: 'CONNECTOR_FAILING', owner: 'INTEGRATION_ADMINISTRATOR' });
    const listed = await call('GET', '/integration-hub/connectors/national.project_codes', { member: READER });
    expect((listed.json.summary as Record<string, unknown>).status).toBe('FAILING');
    const good = { kind: 'IMPORT', outcome: 'SUCCEEDED', started_at: new Date(NOW.getTime() - HOURS).toISOString(), finished_at: new Date(NOW.getTime() - HOURS / 2).toISOString(), rows_total: 5, rows_applied: 5, source_ref: 'sha:national-2' };
    expect((await call('POST', '/integration-hub/connectors/national.project_codes/runs', { member: ADMIN, body: good })).status).toBe(200);
    const closed = await call('GET', '/integration-hub/incidents?state=RESOLVED', { member: READER });
    expect((closed.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: 'FAILING', state: 'RESOLVED', resolution: 'CONDITION_CLEARED', resolved_by: null });
    expect((await events((open[0] as { id: string }).id, 'hub.incident.auto_resolved.v1')).length).toBe(1);
    const runs = await call('GET', '/integration-hub/connectors/national.project_codes/runs', { member: READER });
    expect((runs.json.items as Array<Record<string, unknown>>).map((run) => run.outcome)).toEqual(['SUCCEEDED', 'FAILED']);
  });

  it('refuses a run that does not hold together: a failed run without an error code, a finish before the start, an unknown layout version', async () => {
    const base = { kind: 'IMPORT', started_at: new Date(NOW.getTime() - 2 * HOURS).toISOString(), finished_at: new Date(NOW.getTime() - HOURS).toISOString() };
    const send = (body: Record<string, unknown>) => call('POST', '/integration-hub/connectors/treasury.statement/runs', { member: ADMIN, body: { ...base, ...body } });
    expect((await send({ outcome: 'FAILED' })).status).toBe(422);
    expect((await send({ outcome: 'SUCCEEDED', finished_at: new Date(NOW.getTime() - 3 * HOURS).toISOString() })).status).toBe(422);
    const layout = await send({ outcome: 'SUCCEEDED', layout_code: 'STATEMENT', layout_version: '9.9' });
    expect(layout.status).toBe(422);
    expect((await call('POST', '/integration-hub/connectors/no.such.connector/runs', { member: ADMIN, body: { ...base, outcome: 'SUCCEEDED' } })).status).toBe(404);
  });

  it('AC-ST-HUB-001-2 / UAT-HUB-002: switches a connector of the hub off and on with a reason and a version, writes the audit and the event, and refuses a stale version, a repeat and a short reason', async () => {
    const id = connectorResourceId(TENANT_A, 'treasury.statement');
    const stale = await call('POST', '/integration-hub/connectors/treasury.statement/state', { member: ADMIN, ifMatch: 7, body: { enabled: false, reason: REASON } });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('VERSION_CONFLICT');
    expect((await call('POST', '/integration-hub/connectors/treasury.statement/state', { member: ADMIN, ifMatch: 1, body: { enabled: false, reason: 'short' } })).status).toBe(422);
    expect((await call('POST', '/integration-hub/connectors/treasury.statement/state', { member: ADMIN, ifMatch: 1, body: { enabled: true, reason: REASON } })).status).toBe(422);
    const off = await call('POST', '/integration-hub/connectors/treasury.statement/state', { member: ADMIN, ifMatch: 1, body: { enabled: false, reason: REASON } });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ status: 'DISABLED', resource_version: 2, resource_id: id });
    expect(await state('treasury.statement')).toEqual([{ enabled: false, version: '2' }]);
    expect((await audits(id, 'hub.connector_switched'))[0]).toMatchObject({ reason: REASON, safe_diff: { connector_code: 'treasury.statement', from_enabled: true, to_enabled: false, delegated_to_connector: false } });
    expect((await events(id, 'hub.connector.state_changed.v1'))[0]?.payload).toMatchObject({ connector_code: 'treasury.statement', enabled: false, version: 2, delegated: false });
    expect(((await call('GET', '/integration-hub/connectors/treasury.statement', { member: READER })).json.summary as Record<string, unknown>).status).toBe('DISABLED');
    expect((await call('POST', '/integration-hub/connectors/treasury.statement/state', { member: ADMIN, ifMatch: 2, body: { enabled: true, reason: 'The sample file was checked' } })).json).toMatchObject({ status: 'ENABLED', resource_version: 3 });
  });

  it('AC-ST-HUB-001-2 / UAT-HUB-002: moves the switch of e-GP through its own command, so its own history and version move', async () => {
    const before = await call('GET', '/integration-hub/connectors/egp.muasamcong', { member: READER });
    expect((before.json.state as Record<string, unknown>).owner).toBe('CONNECTOR');
    const off = await call('POST', '/integration-hub/connectors/egp.muasamcong/state', { member: ADMIN, ifMatch: 1, body: { enabled: false, reason: REASON } });
    expect(off.status).toBe(200);
    expect(await rows('select enabled from machvon.egp_connection')).toEqual([{ enabled: false }]);
    expect((await rows('select action from machvon.egp_connection_event order by connection_version')).map((row) => (row as { action: string }).action)).toEqual(['CREATED', 'DISABLED']);
    expect((await audits(connectorResourceId(TENANT_A, 'egp.muasamcong'), 'hub.connector_switched'))[0]?.safe_diff).toMatchObject({ delegated_to_connector: true });
    expect(((await call('GET', '/integration-hub/connectors/egp.muasamcong', { member: READER })).json.summary as Record<string, unknown>).status).toBe('DISABLED');
  });

  it('sweeps the health: one snapshot per connector and hour (a repeat finds them), an incident for a stale connector, and a hub-wide incident when many are stale at once', async () => {
    await seedFile('TREASURY_STATEMENT_FILE', 'APPLIED', new Date(NOW.getTime() - 400 * HOURS));
    await seedFile('PROCUREMENT_FILE', 'APPLIED', new Date(NOW.getTime() - 800 * HOURS));
    const first = await call('POST', '/integration-hub/snapshots', { member: ADMIN, body: {} });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ snapshots_written: 5, incidents_opened: 3, summary: { monitored: 3, hub_alert: { code: 'CONNECTOR_HUB_STALE', severity: 'URGENT' } } });
    const second = await call('POST', '/integration-hub/snapshots', { member: ADMIN, body: {} });
    expect(second.json).toMatchObject({ snapshots_written: 0, incidents_opened: 0 });
    const incidents = (await call('GET', '/integration-hub/incidents?state=OPEN', { member: READER })).json.items as Array<Record<string, unknown>>;
    expect(incidents.map((incident) => [incident.connector_code, incident.kind]).sort()).toEqual([[null, 'HUB_STALE'], ['procurement.milestones', 'STALE'], ['treasury.statement', 'STALE']]);
    expect((await audits(TENANT_A, 'hub.snapshot_captured'))[0]?.safe_diff).toMatchObject({ snapshots_written: 5, incidents_opened: 3 });
    const health = await call('GET', '/integration-hub/health', { member: READER });
    expect((health.json.trend as unknown[]).length).toBe(1);
    expect(((health.json.kpis as Array<Record<string, unknown>>)[1] as { value: number }).value).toBeGreaterThan(16);
  });

  it('AC-ST-HUB-001-3 / UAT-HUB-003: lets a person report, acknowledge and resolve an incident with a reason and a version; a stale version and a wrong step are refused', async () => {
    const opened = await call('POST', '/integration-hub/incidents', { member: ADMIN, body: { connector_code: 'treasury.statement', summary: 'The file arrived with another layout', severity: 'WATCH' } });
    expect(opened.status).toBe(200);
    const id = opened.json.resource_id as string;
    expect((await events(id, 'hub.incident.opened.v1'))[0]?.payload).toMatchObject({ connector_code: 'treasury.statement', kind: 'MANUAL' });
    expect((await call('POST', `/integration-hub/incidents/${id}/decision`, { member: ADMIN, ifMatch: 4, body: { decision: 'ACKNOWLEDGE', reason: 'I take it now' } })).status).toBe(409);
    expect((await call('POST', `/integration-hub/incidents/${id}/decision`, { member: ADMIN, ifMatch: 1, body: { decision: 'ACKNOWLEDGE', reason: 'short' } })).status).toBe(422);
    const ack = await call('POST', `/integration-hub/incidents/${id}/decision`, { member: ADMIN, ifMatch: 1, body: { decision: 'ACKNOWLEDGE', reason: 'I take it now and call the sender' } });
    expect(ack.json).toMatchObject({ status: 'ACKNOWLEDGED', resource_version: 2 });
    const again = await call('POST', `/integration-hub/incidents/${id}/decision`, { member: ADMIN, ifMatch: 2, body: { decision: 'ACKNOWLEDGE', reason: 'I take it again today' } });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('HUB_INCIDENT_STATE_INVALID');
    expect((await call('POST', `/integration-hub/incidents/${id}/decision`, { member: ADMIN, ifMatch: 2, body: { decision: 'RESOLVE', reason: 'The sender fixed the layout' } })).json).toMatchObject({ status: 'RESOLVED', resource_version: 3 });
    expect((await audits(id, 'hub.incident_resolved'))[0]).toMatchObject({ reason: 'The sender fixed the layout' });
    expect((await rows<{ action: string }>('select action from machvon.hub_incident_event where incident_id = $1 order by incident_version', [id])).map((row) => row.action)).toEqual(['OPENED', 'ACKNOWLEDGED', 'RESOLVED']);
    expect((await call('POST', '/integration-hub/incidents', { member: ADMIN, body: { connector_code: 'no.such', summary: 'The file arrived with another layout' } })).status).toBe(404);
  });

  it('AC-ST-HUB-001-4 / UAT-HUB-004: keeps a mapping proposed by one person and decided by another, refuses the proposer, and replaces the version in force', async () => {
    const fields = [{ source: 'code', target: 'project_code', required: true, transform: { kind: 'UPPER' } }];
    const proposed = await call('POST', '/integration-hub/connectors/national.project_codes/mappings', { member: PROPOSER, body: { pipeline_code: 'PROJECT_CODES', mapping_version: 'M1', fields } });
    expect(proposed.status).toBe(200);
    const id = proposed.json.resource_id as string;
    expect((await call('POST', '/integration-hub/connectors/national.project_codes/mappings', { member: PROPOSER, body: { pipeline_code: 'PROJECT_CODES', mapping_version: 'M1', fields } })).json.code).toBe('HUB_MAPPING_VERSION_TAKEN');
    expect((await call('POST', '/integration-hub/connectors/national.project_codes/mappings', { member: PROPOSER, body: { pipeline_code: 'NO_SUCH', mapping_version: 'M9', fields } })).status).toBe(422);
    expect((await call('POST', '/integration-hub/connectors/national.project_codes/mappings', { member: PROPOSER, body: { pipeline_code: 'PROJECT_CODES', mapping_version: 'M8', fields: [] } })).status).toBe(422);
    expect((await events(id, 'hub.mapping.proposed.v1'))[0]?.payload).toMatchObject({ pipeline_code: 'PROJECT_CODES', mapping_version: 'M1' });
    const denied = await call('POST', `/integration-hub/mappings/${id}/decision`, { member: PROPOSER, ifMatch: 1, body: { decision: 'APPROVE', reason: 'The columns match the register' } });
    expect(denied.status).toBe(403);
    const approved = await call('POST', `/integration-hub/mappings/${id}/decision`, { member: APPROVER, ifMatch: 1, body: { decision: 'APPROVE', reason: 'The columns match the register' } });
    expect(approved.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });
    const detail = (await call('GET', '/integration-hub/connectors/national.project_codes', { member: READER })).json;
    expect((detail.pipelines as Array<Record<string, unknown>>)[0]).toMatchObject({ approved_mapping_version: 'M1', pending_mapping_proposals: 0 });
    expect((await call('POST', `/integration-hub/mappings/${id}/decision`, { member: APPROVER, ifMatch: 2, body: { decision: 'REJECT', reason: 'It was approved already' } })).json.code).toBe('HUB_MAPPING_STATE_INVALID');
    expect((await audits(id, 'hub.mapping_approved'))[0]).toMatchObject({ reason: 'The columns match the register', safe_diff: { mapping_version: 'M1' } });
  });

  it('AC-ST-HUB-001-4 / UAT-HUB-004: closes a reject: reprocessing says the pipeline is not wired, discarding needs a reason and works once', async () => {
    const run = await call('POST', '/integration-hub/connectors/national.project_codes/runs', { member: ADMIN, body: { kind: 'IMPORT', outcome: 'PARTIAL', started_at: new Date(NOW.getTime() - HOURS).toISOString(), finished_at: new Date(NOW.getTime() - HOURS / 2).toISOString(), rows_total: 2, rows_applied: 1, rows_rejected: 1 } });
    const rejectId = randomUUID();
    await rows(
      `insert into machvon.hub_pipeline_reject (tenant_id, id, connector_code, pipeline_code, run_id, stage, reject_code, source_ref, record_key, line, record)
       values ($1, $2, 'national.project_codes', 'PROJECT_CODES', $3, 'VALIDATE', 'CODE_REQUIRED', 'f#3', 'REC-3', 3, '{"code":""}'::jsonb)`,
      [TENANT_A, rejectId, run.json.resource_id],
    );
    const listed = await call('GET', '/integration-hub/connectors/national.project_codes/rejects?state=OPEN', { member: READER });
    expect(listed.json).toMatchObject({ open_count: 1 });
    expect((listed.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: rejectId, stage: 'VALIDATE', reject_code: 'CODE_REQUIRED', record_key: 'REC-3', state: 'OPEN' });
    const notWired = await call('POST', `/integration-hub/rejects/${rejectId}/decision`, { member: ADMIN, ifMatch: 1, body: { decision: 'REPROCESS', reason: 'Corrected at the source today' } });
    expect(notWired.status).toBe(409);
    expect(notWired.json.code).toBe('HUB_PIPELINE_NOT_WIRED');
    expect((await call('POST', `/integration-hub/rejects/${rejectId}/decision`, { member: ADMIN, ifMatch: 1, body: { decision: 'DISCARD', reason: 'no' } })).status).toBe(422);
    const discarded = await call('POST', `/integration-hub/rejects/${rejectId}/decision`, { member: ADMIN, ifMatch: 1, body: { decision: 'DISCARD', reason: 'Not a project of ours' } });
    expect(discarded.json).toMatchObject({ status: 'DISCARDED', resource_version: 2 });
    expect((await call('POST', `/integration-hub/rejects/${rejectId}/decision`, { member: ADMIN, ifMatch: 2, body: { decision: 'DISCARD', reason: 'Not a project of ours' } })).json.code).toBe('HUB_REJECT_STATE_INVALID');
    expect((await events(rejectId, 'hub.reject.discarded.v1'))[0]?.payload).toMatchObject({ reject_code: 'CODE_REQUIRED' });
  });

  it('registers a collector agent with its platform, judges it by its heartbeat, and refuses a repeat code and an unknown connector', async () => {
    const body = { agent_code: 'collector-hn-01', os: 'linux', cpu_arch: 'arm64', agent_version: '1.4.2', connectors: ['egp.muasamcong', 'treasury.statement'] };
    const registered = await call('POST', '/integration-hub/agents', { member: ADMIN, body });
    expect(registered.status).toBe(200);
    expect((await call('POST', '/integration-hub/agents', { member: ADMIN, body })).json.code).toBe('HUB_AGENT_CODE_TAKEN');
    expect((await call('POST', '/integration-hub/agents', { member: ADMIN, body: { ...body, agent_code: 'collector-hn-02', connectors: ['no.such'] } })).status).toBe(422);
    expect((await call('POST', '/integration-hub/agents', { member: ADMIN, body: { ...body, agent_code: 'collector-hn-03', cpu_arch: 'x87' } })).status).toBe(422);
    const listed = await call('GET', '/integration-hub/agents?connector_code=treasury.statement', { member: READER });
    expect(listed.json.items).toEqual([expect.objectContaining({ agent_code: 'collector-hn-01', platform: 'linux/arm64', health: 'NEVER_SEEN', spool_depth: 0 })]);
    const beat = await call('POST', '/integration-hub/agents/collector-hn-01/heartbeat', { member: ADMIN, body: { agent_version: '1.4.3', spool_depth: 7 } });
    expect(beat.json).toMatchObject({ status: 'RECEIVED' });
    const after = await call('GET', '/integration-hub/agents', { member: READER });
    expect((after.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ health: 'ONLINE', agent_version: '1.4.3', spool_depth: 7 });
    const detail = (await call('GET', '/integration-hub/connectors/egp.muasamcong', { member: READER })).json;
    expect((detail.agents as Array<Record<string, unknown>>).map((agent) => agent.agent_code)).toEqual(['collector-hn-01']);
    expect((await call('POST', '/integration-hub/agents/nobody/heartbeat', { member: ADMIN, body: { agent_version: '1.0', spool_depth: 0 } })).status).toBe(404);
    expect((await call('POST', '/integration-hub/agents/collector-hn-01/heartbeat', { member: ADMIN, body: { agent_version: '1.0', spool_depth: -1 } })).status).toBe(422);
  });

  it('shows another tenant nothing of all this', async () => {
    const reply = await call('GET', '/integration-hub/connectors', { member: B_ADMIN, tenantId: TENANT_B });
    for (const item of reply.json.items as Array<Record<string, unknown>>) expect(item).toMatchObject({ status: ['access.open-api', 'ind.figure-import', 'mdm.catalogue-import'].includes(item.code as string) ? 'NEVER_RUN' : 'PENDING_EXTERNAL', last_run_at: null });
    expect(((await call('GET', '/integration-hub/incidents', { member: B_ADMIN, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
    expect(((await call('GET', '/integration-hub/agents', { member: B_ADMIN, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
  });

  it('refuses a malformed page request and an unknown filter', async () => {
    expect((await call('GET', '/integration-hub/incidents?limit=0', { member: READER })).status).toBe(422);
    expect((await call('GET', '/integration-hub/incidents?state=BOGUS', { member: READER })).status).toBe(422);
    expect((await call('GET', '/integration-hub/connectors/treasury.statement/runs?cursor=nonsense', { member: READER })).status).toBe(422);
  });
});
