import { randomUUID } from 'node:crypto';
import { connectorResourceId } from '../../src/modules/hub/hub-view';
import { TENANT_A } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { UatWorld } from './uat-world';

/**
 * UAT of the Integration Hub (docs/uat/hub/uat.json, HSKT row TH.03, screens HUB-01 to HUB-03): a failed run opens one incident and a good run closes it, a repeat of a run is taken as already recorded, the switch of
 * a connection is a command with a reason and a version, an incident follows its steps and none back, a mapping is proposed by one person and decided by another, and a reject is closed once. Each case is named by its
 * id in docs/uat/hub/uat.json.
 */
jest.setTimeout(600_000);

const HOURS = 3_600_000;
const REASON = 'Waiting for the official sample file';
const PERSONAS = {
  'hub-admin': ['hub.read', 'hub.state.manage', 'hub.run.record', 'hub.incident.manage', 'hub.snapshot.capture', 'hub.reject.manage', 'hub.agent.manage', 'hub.agent.heartbeat'],
  'hub-proposer': ['hub.read', 'hub.mapping.propose'],
  'hub-approver': ['hub.read', 'hub.mapping.approve'],
  'hub-reader': ['hub.read'],
};
const ago = (hours: number): string => new Date(Date.now() - hours * HOURS).toISOString();
const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

describe('UAT of the Integration Hub (TH.03, HUB-01..HUB-03)', () => {
  const world = new UatWorld();

  beforeAll(async () => {
    await world.start(PERSONAS, { 'hub-admin': PERSONAS['hub-admin'] });
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  const run = (persona: string, connector: string, body: Record<string, unknown>): Promise<Reply> => world.as(persona, 'POST', `/integration-hub/connectors/${connector}/runs`, { body });
  const decide = (persona: string, path: string, version: number, body: Record<string, unknown>): Promise<Reply> => world.as(persona, 'POST', path, { ifMatch: version, body });

  it('UAT-HUB-E2E-01 a failed run opens one incident with its audit row and event, the same run again is ALREADY_RECORDED, and a good run closes the incident by itself', async () => {
    const failed = { kind: 'IMPORT', outcome: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID', started_at: ago(3), finished_at: ago(2), rows_total: 5, source_ref: 'sha:national-1' };
    const first = await run('hub-admin', 'national.project_codes', failed);
    assertStatus(first, 200);
    expect(first.json).toMatchObject({ status: 'RECORDED' });
    const runId = first.json.resource_id as string;
    expect((await world.audits(runId, 'hub.run_recorded'))[0]?.safe_diff).toMatchObject({ connector_code: 'national.project_codes', outcome: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID', incidents_opened: 1 });
    expect((await world.events(runId, 'hub.run.recorded.v1'))[0]?.payload).toMatchObject({ connector_code: 'national.project_codes', outcome: 'FAILED' });
    const repeat = await run('hub-admin', 'national.project_codes', failed);
    expect(repeat.json).toMatchObject({ status: 'ALREADY_RECORDED', resource_id: runId });
    const open = items(await world.as('hub-reader', 'GET', '/integration-hub/incidents?state=OPEN'));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ connector_code: 'national.project_codes', kind: 'FAILING', severity: 'ACTION', state: 'OPEN' });
    expect(open[0]?.alert).toMatchObject({ code: 'CONNECTOR_FAILING', owner: 'INTEGRATION_ADMINISTRATOR' });
    const detail = await world.as('hub-reader', 'GET', '/integration-hub/connectors/national.project_codes');
    expect((detail.json.summary as Record<string, unknown>).status).toBe('FAILING');
    const good = { kind: 'IMPORT', outcome: 'SUCCEEDED', started_at: ago(1), finished_at: ago(0.5), rows_total: 5, rows_applied: 5, source_ref: 'sha:national-2' };
    assertStatus(await run('hub-admin', 'national.project_codes', good), 200);
    const closed = items(await world.as('hub-reader', 'GET', '/integration-hub/incidents?state=RESOLVED'));
    expect(closed[0]).toMatchObject({ kind: 'FAILING', state: 'RESOLVED', resolution: 'CONDITION_CLEARED', resolved_by: null });
    expect(await world.events(open[0]?.id as string, 'hub.incident.auto_resolved.v1')).toHaveLength(1);
  });

  it('UAT-HUB-IDM-01 recording the same run twice keeps one run and one incident, and the same Idempotency-Key answers the first answer', async () => {
    const body = { kind: 'IMPORT', outcome: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID', started_at: ago(5), finished_at: ago(4), rows_total: 3, source_ref: 'sha:treasury-1' };
    const key = `uat-${randomUUID()}`;
    const first = await world.as('hub-admin', 'POST', '/integration-hub/connectors/treasury.statement/runs', { body, key });
    const second = await world.as('hub-admin', 'POST', '/integration-hub/connectors/treasury.statement/runs', { body, key });
    expect(second.json.resource_id).toBe(first.json.resource_id);
    const again = await run('hub-admin', 'treasury.statement', body);
    expect(again.json).toMatchObject({ status: 'ALREADY_RECORDED', resource_id: first.json.resource_id });
    expect(await world.rows("select 1 from machvon.hub_run_log where source_ref = 'sha:treasury-1'")).toHaveLength(1);
    expect(items(await world.as('hub-reader', 'GET', '/integration-hub/incidents?state=OPEN')).filter((incident) => incident.connector_code === 'treasury.statement')).toHaveLength(1);
  });

  it('UAT-HUB-EDG-01 a run that does not hold together is refused (422) and a connector that does not exist is 404: a failed run without an error code, a finish before the start, an unknown layout version', async () => {
    const base = { kind: 'IMPORT', started_at: ago(2), finished_at: ago(1) };
    assertStatus(await run('hub-admin', 'national.project_codes', { ...base, outcome: 'FAILED' }), 422);
    assertStatus(await run('hub-admin', 'national.project_codes', { ...base, outcome: 'SUCCEEDED', finished_at: ago(3) }), 422);
    assertStatus(await run('hub-admin', 'treasury.statement', { ...base, outcome: 'SUCCEEDED', layout_code: 'STATEMENT', layout_version: '9.9' }), 422);
    assertStatus(await run('hub-admin', 'no.such.connector', { ...base, outcome: 'SUCCEEDED' }), 404);
    assertStatus(await world.as('hub-reader', 'GET', '/integration-hub/incidents?state=NOPE'), 422);
  });

  it('UAT-HUB-DAT-01 a connection is switched off with a reason of ten characters and the current version, audited with its reason and announced, and a stale version, a short reason and a repeat are refused', async () => {
    const id = connectorResourceId(TENANT_A, 'treasury.statement');
    const path = '/integration-hub/connectors/treasury.statement/state';
    const before = (await world.rows<{ version: string }>("select version::text from machvon.hub_connector_state where connector_code = 'treasury.statement'"))[0];
    const version = before === undefined ? 1 : Number(before.version);
    assertStatus(await decide('hub-admin', path, version + 6, { enabled: false, reason: REASON }), 409, 'VERSION_CONFLICT');
    assertStatus(await decide('hub-admin', path, version, { enabled: false, reason: 'short' }), 422);
    assertStatus(await decide('hub-admin', path, version, { enabled: true, reason: REASON }), 422);
    const off = await decide('hub-admin', path, version, { enabled: false, reason: REASON });
    assertStatus(off, 200);
    expect(off.json).toMatchObject({ status: 'DISABLED', resource_id: id });
    expect((await world.audits(id, 'hub.connector_switched'))[0]).toMatchObject({ reason: REASON, safe_diff: { connector_code: 'treasury.statement', from_enabled: true, to_enabled: false } });
    expect((await world.events(id, 'hub.connector.state_changed.v1'))[0]?.payload).toMatchObject({ connector_code: 'treasury.statement', enabled: false });
    expect(((await world.as('hub-reader', 'GET', '/integration-hub/connectors/treasury.statement')).json.summary as Record<string, unknown>).status).toBe('DISABLED');
    assertStatus(await decide('hub-admin', path, off.json.resource_version as number, { enabled: true, reason: 'The sample file was checked' }), 200);
  });

  it('UAT-HUB-STA-01 an incident goes from open to acknowledged to resolved and no step back: a stale version is 409, a second acknowledgement is 409 HUB_INCIDENT_STATE_INVALID, and the history keeps the three steps', async () => {
    const opened = await world.as('hub-admin', 'POST', '/integration-hub/incidents', { body: { connector_code: 'treasury.statement', summary: 'The file arrived with another layout', severity: 'WATCH' } });
    assertStatus(opened, 200);
    const incident = opened.json.resource_id as string;
    expect((await world.events(incident, 'hub.incident.opened.v1'))[0]?.payload).toMatchObject({ connector_code: 'treasury.statement', kind: 'MANUAL' });
    const path = `/integration-hub/incidents/${incident}/decision`;
    assertStatus(await decide('hub-admin', path, 4, { decision: 'ACKNOWLEDGE', reason: 'I take it now' }), 409);
    assertStatus(await decide('hub-admin', path, 1, { decision: 'ACKNOWLEDGE', reason: 'short' }), 422);
    assertStatus(await decide('hub-admin', path, 1, { decision: 'ACKNOWLEDGE', reason: 'I take it now and call the sender' }), 200);
    assertStatus(await decide('hub-admin', path, 2, { decision: 'ACKNOWLEDGE', reason: 'I take it again today' }), 409, 'HUB_INCIDENT_STATE_INVALID');
    const resolved = await decide('hub-admin', path, 2, { decision: 'RESOLVE', reason: 'The sender fixed the layout' });
    expect(resolved.json).toMatchObject({ status: 'RESOLVED', resource_version: 3 });
    assertStatus(await decide('hub-admin', path, 3, { decision: 'ACKNOWLEDGE', reason: 'It is closed already' }), 409);
    expect((await world.audits(incident, 'hub.incident_resolved'))[0]).toMatchObject({ reason: 'The sender fixed the layout' });
    expect((await world.rows<{ action: string }>('select action from machvon.hub_incident_event where incident_id = $1 order by incident_version', [incident])).map((row) => row.action)).toEqual(['OPENED', 'ACKNOWLEDGED', 'RESOLVED']);
    assertStatus(await world.as('hub-admin', 'POST', '/integration-hub/incidents', { body: { connector_code: 'no.such', summary: 'The file arrived with another layout' } }), 404);
  });

  it('UAT-HUB-SOD-01 a mapping proposed by one person is decided by another (the proposer is 403), a second decision is 409 HUB_MAPPING_STATE_INVALID, and a version cannot be proposed twice', async () => {
    const fields = [{ source: 'code', target: 'project_code', required: true, transform: { kind: 'UPPER' } }];
    const body = { pipeline_code: 'PROJECT_CODES', mapping_version: 'M1', fields };
    const proposed = await world.as('hub-proposer', 'POST', '/integration-hub/connectors/national.project_codes/mappings', { body });
    assertStatus(proposed, 200);
    const mapping = proposed.json.resource_id as string;
    assertStatus(await world.as('hub-proposer', 'POST', '/integration-hub/connectors/national.project_codes/mappings', { body }), 409, 'HUB_MAPPING_VERSION_TAKEN');
    assertStatus(await world.as('hub-proposer', 'POST', '/integration-hub/connectors/national.project_codes/mappings', { body: { ...body, mapping_version: 'M8', fields: [] } }), 422);
    expect((await world.events(mapping, 'hub.mapping.proposed.v1'))[0]?.payload).toMatchObject({ pipeline_code: 'PROJECT_CODES', mapping_version: 'M1' });
    const path = `/integration-hub/mappings/${mapping}/decision`;
    assertStatus(await decide('hub-proposer', path, 1, { decision: 'APPROVE', reason: 'The columns match the register' }), 403);
    assertStatus(await decide('hub-approver', path, 1, { decision: 'APPROVE', reason: 'The columns match the register' }), 200);
    assertStatus(await decide('hub-approver', path, 2, { decision: 'REJECT', reason: 'It was approved already' }), 409, 'HUB_MAPPING_STATE_INVALID');
    expect((await world.audits(mapping, 'hub.mapping_approved'))[0]).toMatchObject({ reason: 'The columns match the register', safe_diff: { mapping_version: 'M1' } });
  });

  it('UAT-HUB-STA-02 a reject is closed once: reprocessing says the pipeline is not wired (409 HUB_PIPELINE_NOT_WIRED), discarding needs a reason, works once, and a second discard is 409 HUB_REJECT_STATE_INVALID', async () => {
    const recorded = await run('hub-admin', 'national.project_codes', { kind: 'IMPORT', outcome: 'PARTIAL', started_at: ago(1), finished_at: ago(0.5), rows_total: 2, rows_applied: 1, rows_rejected: 1, source_ref: 'sha:partial-1' });
    const rejectId = randomUUID();
    await world.seedAsAdmin([
      [
        `insert into machvon.hub_pipeline_reject (tenant_id, id, connector_code, pipeline_code, run_id, stage, reject_code, source_ref, record_key, line, record)
         values ($1, $2, 'national.project_codes', 'PROJECT_CODES', $3, 'VALIDATE', 'CODE_REQUIRED', 'f#3', 'REC-3', 3, '{"code":""}'::jsonb)`,
        [TENANT_A, rejectId, recorded.json.resource_id],
      ],
    ]);
    const listed = await world.as('hub-reader', 'GET', '/integration-hub/connectors/national.project_codes/rejects?state=OPEN');
    expect(listed.json).toMatchObject({ open_count: 1 });
    const path = `/integration-hub/rejects/${rejectId}/decision`;
    assertStatus(await decide('hub-admin', path, 1, { decision: 'REPROCESS', reason: 'Corrected at the source today' }), 409, 'HUB_PIPELINE_NOT_WIRED');
    assertStatus(await decide('hub-admin', path, 1, { decision: 'DISCARD', reason: 'no' }), 422);
    const discarded = await decide('hub-admin', path, 1, { decision: 'DISCARD', reason: 'Not a project of ours' });
    expect(discarded.json).toMatchObject({ status: 'DISCARDED', resource_version: 2 });
    assertStatus(await decide('hub-admin', path, 2, { decision: 'DISCARD', reason: 'Not a project of ours' }), 409, 'HUB_REJECT_STATE_INVALID');
    expect((await world.events(rejectId, 'hub.reject.discarded.v1'))[0]?.payload).toMatchObject({ reject_code: 'CODE_REQUIRED' });
  });

  it('UAT-HUB-ISO-01 another tenant sees none of the runs, incidents and rejects of this tenant, and cannot decide on them (404)', async () => {
    const incident = items(await world.as('hub-reader', 'GET', '/integration-hub/incidents'))[0] as { id: string };
    const asB = await world.asTenantB(1, 'POST', `/integration-hub/incidents/${incident.id}/decision`, { ifMatch: 1, body: { decision: 'ACKNOWLEDGE', reason: 'This is not my incident' } });
    const nothing = await world.asTenantB(1, 'POST', `/integration-hub/incidents/${randomUUID()}/decision`, { ifMatch: 1, body: { decision: 'ACKNOWLEDGE', reason: 'This is not my incident' } });
    expect([asB.status, codeOf(asB)]).toEqual([nothing.status, codeOf(nothing)]);
    assertStatus(asB, 404);
    expect(items(await world.asTenantB(1, 'GET', '/integration-hub/incidents'))).toEqual([]);
    expect(items(await world.asTenantB(1, 'GET', '/integration-hub/connectors/national.project_codes/runs'))).toEqual([]);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'HUB_INCIDENT_STATE_INVALID'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'HUB_REJECT_STATE_INVALID' } }, 409, 'HUB_INCIDENT_STATE_INVALID'));
  });
});
