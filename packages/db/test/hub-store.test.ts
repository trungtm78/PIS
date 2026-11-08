import { randomUUID } from 'node:crypto';
import { connectorDescriptor, connectorDescriptors, hubRunOf, registerBuiltInConnectors, runEtl, makeBatch } from '@machvon/kernel';
import type { ConnectorDescriptor, EtlPorts, FieldMapping } from '@machvon/kernel';
import { EgpConnectionStore } from '../src/egp-store';
import { registerBuiltInHubAdapters } from '../src/hub-adapters';
import { IntegrationCursorStore } from '../src/integration-cursor-store';
import { TREASURY_CONNECTOR_CODE, TREASURY_FORMAT_VERSION } from '../src/pay-treasury-statement-format';
import { HubStore } from '../src/hub-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

registerBuiltInConnectors();
registerBuiltInHubAdapters();

const harness = new AuthzHarness();
const hub = new HubStore();
const MAKER = 1;
const CHECKER = 2;
const NOW = new Date('2026-11-08T03:00:00Z');
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const descriptor = (code: string): ConnectorDescriptor => connectorDescriptor(code) as ConnectorDescriptor;

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

const seedFileImport = (position: string, status: 'APPLIED' | 'FAILED', at: Date, tenant = TENANT_A): Promise<unknown> =>
  owner(
    `insert into machvon.file_import (tenant_id, connector_code, format_version, file_sha256, file_object_key, status, error_code, rows_total, rows_applied, imported_by, created_at, completed_at)
     values ($1, $2, 'ASSUMED-2026.1', $3, $4, $5, $6, 1, $7, $8, $9::timestamptz, $9::timestamptz)`,
    [tenant, position, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), `tenants/${tenant}/import/${randomUUID()}`, status, status === 'FAILED' ? 'IMPORT_SCHEMA_INVALID' : null, status === 'APPLIED' ? 1 : 0, memberId(MAKER), at.toISOString()],
    tenant,
  );

const REASON = 'Waiting for the official sample file';

describe('the Integration Hub store (HUB-1)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      for (const member of [MAKER, CHECKER]) await harness.seedMembership(tenant, member, 1);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the readings', () => {
    it('shows every registered connector for a tenant that never used one: waiting for the outside, never "fine", and writes nothing to show it', async () => {
      const { items, summary } = await as((tx) => hub.readings(tx, connectorDescriptors(), NOW));
      expect(items.map((item) => item.descriptor.code)).toEqual(connectorDescriptors().map((one) => one.code));
      for (const item of items) expect(item.health).toMatchObject({ status: 'PENDING_EXTERNAL', acceptance: 'PENDING_EXTERNAL', alert: null });
      expect(summary).toMatchObject({ monitored: 0, healthyPercent: null, hubAlert: null });
      expect((await owner('select 1 from machvon.hub_connector_state')).length).toBe(0);
      const treasury = items.find((item) => item.descriptor.code === 'treasury.statement');
      expect(treasury?.rule).toMatchObject({ source: 'DEFAULT', unverified: true, params: { maxAgeHours: 72, warnAfterHours: 36 } });
    });

    it('reads the age of the last applied file of the file import framework: healthy, then stale with the alert and blocked figures', async () => {
      await seedFileImport('TREASURY_STATEMENT_FILE', 'APPLIED', hoursAgo(10));
      const fresh = await as((tx) => hub.reading(tx, descriptor('treasury.statement'), NOW));
      expect(fresh.health).toMatchObject({ status: 'HEALTHY', freshness: 'FRESH', ageHours: 10, acceptance: 'PENDING_EXTERNAL' });
      expect(fresh.lastRunOutcome).toBe('SUCCEEDED');
      const stale = await as((tx) => hub.reading(tx, descriptor('treasury.statement'), new Date(NOW.getTime() + 100 * 3_600_000)));
      expect(stale.health).toMatchObject({ status: 'STALE', alert: { code: 'CONNECTOR_STALE', severity: 'ACTION' }, figuresBlocked: true });
    });

    it('is FAILING when the newest file failed, and recovers when a later one applied; counts the failed runs of the week', async () => {
      await seedFileImport('PROCUREMENT_FILE', 'APPLIED', hoursAgo(30));
      await seedFileImport('PROCUREMENT_FILE', 'FAILED', hoursAgo(5));
      const failing = await as((tx) => hub.reading(tx, descriptor('procurement.milestones'), NOW));
      expect(failing.health).toMatchObject({ status: 'FAILING', alert: { code: 'CONNECTOR_FAILING', severity: 'ACTION' }, consecutiveFailures: 1 });
      expect(failing.failedRuns7d).toBe(1);
      await seedFileImport('PROCUREMENT_FILE', 'APPLIED', hoursAgo(1));
      expect((await as((tx) => hub.reading(tx, descriptor('procurement.milestones'), NOW))).health.status).toBe('HEALTHY');
    });

    it('does not show one tenant the runs of another', async () => {
      const other = await as((tx) => hub.reading(tx, descriptor('treasury.statement'), NOW), MAKER, TENANT_B);
      expect(other.health.status).toBe('PENDING_EXTERNAL');
      expect(await as((tx) => hub.listRuns(tx, descriptor('treasury.statement'), { limit: 10, after: undefined }), MAKER, TENANT_B)).toEqual([]);
    });
  });

  describe('the conformance check of the database half', () => {
    it('reports a position without its ledger row and passes once the connector made it; the e-GP connection owns its positions, its switch adapter and a readable history', async () => {
      const treasury = await as((tx) => hub.conformanceProblems(tx, descriptor('treasury.statement'), NOW));
      expect(treasury).toEqual(['ledger: position TREASURY_STATEMENT_FILE has no integration_cursor row (call the ensure of the connector)']);
      await as((tx) => new IntegrationCursorStore().ensureDefaults(tx, memberId(MAKER)));
      expect(await as((tx) => hub.conformanceProblems(tx, descriptor('treasury.statement'), NOW))).toEqual([]);
      await as((tx) => new EgpConnectionStore().ensure(tx, memberId(MAKER)));
      expect(await as((tx) => hub.conformanceProblems(tx, descriptor('egp.muasamcong'), NOW))).toEqual([]);
    });

    it('keeps the built-in descriptors in step with the format versions of the modules that own the layouts', () => {
      expect(descriptor('treasury.statement').layouts[0]?.version).toBe(TREASURY_FORMAT_VERSION);
      expect(descriptor('treasury.statement').ledger.positions).toEqual([TREASURY_CONNECTOR_CODE]);
    });
  });

  describe('runs reported to the hub', () => {
    const runBody = { kind: 'IMPORT', outcome: 'SUCCEEDED', started_at: '2026-11-08T02:00:00Z', finished_at: '2026-11-08T02:01:00Z', rows_total: 4, rows_applied: 3, rows_rejected: 1, source_ref: 'sha:aaaa1111' };

    it('records a run once per source reference, merges it with the file imports in one list and refuses an unknown layout', async () => {
      const first = await as((tx) => hub.recordRun(tx, 'national.project_codes', hubRunOf(runBody, NOW), memberId(MAKER)));
      expect(first.duplicate).toBe(false);
      const again = await as((tx) => hub.recordRun(tx, 'national.project_codes', hubRunOf(runBody, NOW), memberId(MAKER)));
      expect(again).toEqual({ id: first.id, duplicate: true });
      expect((await owner('select 1 from machvon.hub_run_log where connector_code = $1', ['national.project_codes'])).length).toBe(1);
      await seedFileImport('NATIONAL_PIM_FILE', 'APPLIED', hoursAgo(2));
      const runs = await as((tx) => hub.listRuns(tx, descriptor('national.project_codes'), { limit: 10, after: undefined }));
      expect(runs.map((run) => [run.origin, run.outcome])).toEqual([['HUB', 'SUCCEEDED'], ['FILE_IMPORT', 'SUCCEEDED']]);
      const page = await as((tx) => hub.listRuns(tx, descriptor('national.project_codes'), { limit: 1, after: { key: (runs[0] as { startedAtKey: string }).startedAtKey, id: (runs[0] as { id: string }).id } }));
      expect(page.map((run) => run.origin)).toEqual(['FILE_IMPORT']);
      expect(await refusal(as((tx) => hub.recordRun(tx, 'national.project_codes', hubRunOf({ ...runBody, source_ref: 'sha:bbbb2222', layout_code: 'PROJECT_CODES', layout_version: '9.9' }, NOW), memberId(MAKER))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'layout_version' });
      expect(await refusal(as((tx) => hub.recordRun(tx, 'no.such.connector', hubRunOf(runBody, NOW), memberId(MAKER))))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('cannot be changed or deleted afterwards, for any role', async () => {
      expect(await databaseRefusal(owner("update machvon.hub_run_log set outcome = 'FAILED', error_code = 'X_ERR'"))).toContain('append-only');
      expect(await databaseRefusal(as((tx) => tx.query('delete from machvon.hub_run_log')))).toMatch(/permission denied|append-only/);
    });
  });

  describe('the switch', () => {
    it('is moved in the hub for a connector without a switch of its own, with a reason, a version and a history', async () => {
      const before = await as((tx) => hub.reading(tx, descriptor('treasury.statement'), NOW));
      expect(before).toMatchObject({ enabled: true, stateVersion: 1, stateOwner: 'HUB' });
      expect(await refusal(as((tx) => hub.setState(tx, 'treasury.statement', 2, { enabled: false, reason: REASON }, memberId(MAKER))))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(as((tx) => hub.setState(tx, 'treasury.statement', 1, { enabled: true, reason: REASON }, memberId(MAKER))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'enabled' });
      expect(await refusal(as((tx) => hub.setState(tx, 'treasury.statement', 1, { enabled: false, reason: 'short' }, memberId(MAKER))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const off = await as((tx) => hub.setState(tx, 'treasury.statement', 1, { enabled: false, reason: REASON }, memberId(CHECKER)), CHECKER);
      expect(off).toMatchObject({ delegated: false, after: { enabled: false, version: 2, reason: REASON } });
      expect((await as((tx) => hub.reading(tx, descriptor('treasury.statement'), NOW))).health).toMatchObject({ status: 'DISABLED', alert: null });
      const on = await as((tx) => hub.setState(tx, 'treasury.statement', 2, { enabled: true, reason: 'The sample file arrived and was checked' }, memberId(MAKER)));
      expect(on.after).toMatchObject({ enabled: true, version: 3 });
      expect((await as((tx) => hub.stateEvents(tx, 'treasury.statement', 10))).map((event) => event.action)).toEqual(['ENABLED', 'DISABLED']);
    });

    it('is delegated to the connector for e-GP: its own switch and history move, and the hub keeps its own line too', async () => {
      const before = await as((tx) => hub.reading(tx, descriptor('egp.muasamcong'), NOW));
      expect(before).toMatchObject({ enabled: true, stateOwner: 'CONNECTOR' });
      const off = await as((tx) => hub.setState(tx, 'egp.muasamcong', before.stateVersion, { enabled: false, reason: REASON }, memberId(MAKER)));
      expect(off.delegated).toBe(true);
      const own = await owner<{ enabled: boolean; version: string }>('select enabled, version::text as version from machvon.egp_connection');
      expect(own).toEqual([{ enabled: false, version: String(off.after.version) }]);
      expect((await owner('select 1 from machvon.egp_connection_event')).length).toBeGreaterThanOrEqual(2);
      expect((await as((tx) => hub.reading(tx, descriptor('egp.muasamcong'), NOW))).health.status).toBe('DISABLED');
      expect((await as((tx) => hub.stateEvents(tx, 'egp.muasamcong', 5))).map((event) => event.action)).toEqual(['DISABLED']);
      expect((await owner('select 1 from machvon.hub_connector_state where connector_code = $1', ['egp.muasamcong'])).length).toBe(0);
    });
  });

  describe('incidents and the sweep', () => {
    it('opens one incident for a failing connector however many sweeps run, closes it when the condition clears, and writes one snapshot per connector and hour', async () => {
      const probe = await owner('select 1');
      expect(probe.length).toBe(1);
      await seedFileImport('NATIONAL_PIM_FILE', 'FAILED', hoursAgo(0.5));
      const first = await as((tx) => hub.sweep(tx, connectorDescriptors(), NOW, memberId(MAKER)));
      expect(first.incidents.opened.map((row) => [row.connectorCode, row.kind, row.severity, row.openedBy])).toEqual([['national.project_codes', 'FAILING', 'ACTION', null]]);
      expect(first.snapshotsWritten).toBe(connectorDescriptors().length + 1);
      const second = await as((tx) => hub.sweep(tx, connectorDescriptors(), NOW, memberId(MAKER)));
      expect(second.incidents.opened).toEqual([]);
      expect(second.snapshotsWritten).toBe(0);
      const open = await as((tx) => hub.listIncidents(tx, { open: true, limit: 10, after: undefined }));
      expect(open).toHaveLength(1);
      expect((await as((tx) => hub.incidentEvents(tx, (open[0] as { id: string }).id))).map((event) => event.action)).toEqual(['OPENED']);
      await seedFileImport('NATIONAL_PIM_FILE', 'APPLIED', hoursAgo(0.1));
      const third = await as((tx) => hub.sweep(tx, connectorDescriptors(), new Date(NOW.getTime() + 2 * 3_600_000), memberId(MAKER)));
      expect(third.incidents.autoResolved.map((row) => [row.state, row.resolution, row.resolvedBy])).toEqual([['RESOLVED', 'CONDITION_CLEARED', null]]);
      expect(third.snapshotsWritten).toBe(connectorDescriptors().length + 1);
      expect((await as((tx) => hub.trend(tx, 'national.project_codes', 5))).map((point) => point.status)).toEqual(['HEALTHY', 'FAILING']);
      expect(((await as((tx) => hub.trend(tx, null, 5)))[0] as unknown as { summary: { total: number } }).summary.total).toBe(connectorDescriptors().length);
    });

    it('lets a person report, acknowledge and resolve an incident, each with a reason and a version', async () => {
      const row = await as((tx) => hub.openManual(tx, 'treasury.statement', { summary: 'The file arrived with another layout', severity: 'WATCH' }, memberId(MAKER)));
      expect(row).toMatchObject({ kind: 'MANUAL', state: 'OPEN', severity: 'WATCH', openedBy: memberId(MAKER), version: 1 });
      expect(await refusal(as((tx) => hub.moveIncident(tx, row.id, 2, { move: 'ACKNOWLEDGE', reason: 'I take it now' }, memberId(CHECKER)), CHECKER))).toMatchObject({ code: 'VERSION_CONFLICT' });
      const acknowledged = await as((tx) => hub.moveIncident(tx, row.id, 1, { move: 'ACKNOWLEDGE', reason: 'I take it now' }, memberId(CHECKER)), CHECKER);
      expect(acknowledged.row).toMatchObject({ state: 'ACKNOWLEDGED', acknowledgedBy: memberId(CHECKER), version: 2 });
      expect(await refusal(as((tx) => hub.moveIncident(tx, row.id, 2, { move: 'ACKNOWLEDGE', reason: 'I take it again' }, memberId(CHECKER)), CHECKER))).toMatchObject({ code: 'HUB_INCIDENT_STATE_INVALID', status: 409 });
      const resolved = await as((tx) => hub.moveIncident(tx, row.id, 2, { move: 'RESOLVE', reason: 'The sender fixed the layout' }, memberId(CHECKER)), CHECKER);
      expect(resolved.row).toMatchObject({ state: 'RESOLVED', resolution: 'The sender fixed the layout', version: 3 });
      expect((await as((tx) => hub.incidentEvents(tx, row.id))).map((event) => event.action)).toEqual(['OPENED', 'ACKNOWLEDGED', 'RESOLVED']);
      expect(await databaseRefusal(owner("update machvon.hub_incident set state = 'OPEN', version = version + 1 where id = $1", [row.id]))).toContain('resolved');
      expect(await databaseRefusal(owner('delete from machvon.hub_incident_event'))).toContain('append-only');
    });

    it('does not show one tenant the incidents of another', async () => {
      expect(await as((tx) => hub.listIncidents(tx, { limit: 50, after: undefined }), MAKER, TENANT_B)).toEqual([]);
    });
  });

  describe('the pipeline: mapping versions, run record, watermark, rejects, lineage', () => {
    const FIELDS: FieldMapping[] = [{ source: 'code', target: 'project_code', required: true, transform: { kind: 'UPPER' } }];
    const spec = { code: 'PROJECT_CODES', mode: 'INCREMENTAL' as const, layoutCode: 'PROJECT_CODES', layoutVersion: descriptor('national.project_codes').layouts[0]?.version as string };
    let mappingId = '';

    it('keeps a mapping version proposed by one person and decided by another, and retires the one it replaces', async () => {
      const proposed = await as((tx) => hub.proposeMapping(tx, 'national.project_codes', 'PROJECT_CODES', 'M1', FIELDS, memberId(MAKER)));
      mappingId = proposed.id;
      expect(proposed).toMatchObject({ state: 'PROPOSED', version: 1 });
      expect(await refusal(as((tx) => hub.proposeMapping(tx, 'national.project_codes', 'PROJECT_CODES', 'M1', FIELDS, memberId(MAKER))))).toMatchObject({ code: 'HUB_MAPPING_VERSION_TAKEN', status: 409 });
      expect(await refusal(as((tx) => hub.proposeMapping(tx, 'national.project_codes', 'NO_SUCH', 'M2', FIELDS, memberId(MAKER))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'pipeline_code' });
      expect(await as((tx) => hub.approvedMapping(tx, 'national.project_codes', 'PROJECT_CODES'))).toBeUndefined();
      expect(await refusal(as((tx) => hub.decideMapping(tx, mappingId, 1, 'APPROVE', 'The columns match the register', memberId(MAKER))))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const approved = await as((tx) => hub.decideMapping(tx, mappingId, 1, 'APPROVE', 'The columns match the register', memberId(CHECKER)), CHECKER);
      expect(approved.row).toMatchObject({ state: 'APPROVED', decidedBy: memberId(CHECKER), version: 2 });
      expect(await as((tx) => hub.approvedMapping(tx, 'national.project_codes', 'PROJECT_CODES'))).toMatchObject({ version: 'M1', approvedBy: memberId(CHECKER) });
      const second = await as((tx) => hub.proposeMapping(tx, 'national.project_codes', 'PROJECT_CODES', 'M2', FIELDS, memberId(MAKER)));
      const replaced = await as((tx) => hub.decideMapping(tx, second.id, 1, 'APPROVE', 'Adds the upper case rule', memberId(CHECKER)), CHECKER);
      expect(replaced.retired).toMatchObject({ mappingVersion: 'M1', state: 'RETIRED' });
      expect((await as((tx) => hub.approvedMapping(tx, 'national.project_codes', 'PROJECT_CODES')))?.version).toBe('M2');
      expect(await refusal(as((tx) => hub.decideMapping(tx, mappingId, 3, 'REJECT', 'It was replaced already', memberId(CHECKER)), CHECKER))).toMatchObject({ code: 'HUB_MAPPING_STATE_INVALID' });
      expect(await databaseRefusal(owner('update machvon.hub_pipeline_mapping set fields = \'[{"x":1}]\'::jsonb, version = version + 1 where id = $1', [mappingId]))).toContain('keeps its fields');
    });

    it('records a partial run with its rejects and lineage, moves the watermark after the load, and leaves it for a dry run or a failed load', async () => {
      const mapping = (await as((tx) => hub.approvedMapping(tx, 'national.project_codes', 'PROJECT_CODES'))) as NonNullable<Awaited<ReturnType<HubStore['approvedMapping']>>>;
      const records = [
        { key: 'a', sourceRef: 'f#2', line: 2, fields: { code: 'p1' } },
        { key: 'b', sourceRef: 'f#3', line: 3, fields: { code: '' } },
      ];
      const applied = new Set<string>();
      const ports: EtlPorts = {
        extract: async () => makeBatch(records, 'f'),
        validate: (record) => (record.fields.code === '' ? [{ code: 'CODE_REQUIRED', field: 'code' }] : []),
        crosswalk: { lookup: () => null },
        load: async (items, options) =>
          items.map((item) => {
            const known = applied.has(item.idempotencyKey);
            if (!options.dryRun) applied.add(item.idempotencyKey);
            return known ? { status: 'DUPLICATE' as const, targetRef: `project:${item.key}` } : { status: 'APPLIED' as const, targetRef: `project:${item.key}` };
          }),
      };
      const window = { startedAt: hoursAgo(0.2), finishedAt: hoursAgo(0.1) };
      const dry = await runEtl({ spec, mapping, ports, watermark: null, dryRun: true });
      const dryRecorded = await as((tx) => hub.recordPipelineRun(tx, 'national.project_codes', spec, dry, window, memberId(MAKER)));
      expect(dryRecorded).toMatchObject({ rejects: 1, lineage: 0, watermarkMoved: false });
      expect((await as((tx) => hub.watermark(tx, 'national.project_codes', 'PROJECT_CODES'))).watermark).toBeNull();
      const real = await runEtl({ spec, mapping, ports, watermark: null, dryRun: false });
      const recorded = await as((tx) => hub.recordPipelineRun(tx, 'national.project_codes', spec, real, window, memberId(MAKER)));
      expect(recorded).toMatchObject({ rejects: 1, lineage: 1, watermarkMoved: true });
      expect(await as((tx) => hub.watermark(tx, 'national.project_codes', 'PROJECT_CODES'))).toEqual({ watermark: 'f', version: 2 });
      const lineage = await as((tx) => hub.lineage(tx, 'national.project_codes', 5));
      expect(lineage).toEqual([expect.objectContaining({ sourceRef: 'f#2', targetRef: 'project:a', status: 'APPLIED', mappingVersion: 'M2' })]);
      // A second run that started from the old watermark cannot overwrite the one that moved it.
      expect(await refusal(as((tx) => hub.recordPipelineRun(tx, 'national.project_codes', spec, real, window, memberId(MAKER))))).toMatchObject({ code: 'VERSION_CONFLICT' });
      const rejects = await as((tx) => hub.listRejects(tx, 'national.project_codes', { state: 'OPEN', limit: 10, after: undefined }));
      expect(rejects.map((reject) => [reject.stage, reject.rejectCode, reject.sourceRef])).toEqual([['VALIDATE', 'CODE_REQUIRED', 'f#3'], ['VALIDATE', 'CODE_REQUIRED', 'f#3']]);
      const runs = await as((tx) => hub.listRuns(tx, descriptor('national.project_codes'), { limit: 20, after: undefined }));
      expect(runs.filter((run) => run.pipelineCode === 'PROJECT_CODES').map((run) => `${run.outcome}:${String(run.dryRun)}`).sort()).toEqual(['PARTIAL:false', 'PARTIAL:true']);
    });

    it('closes a reject once, with a reason, and never changes a closed one', async () => {
      const [reject] = await as((tx) => hub.listRejects(tx, 'national.project_codes', { state: 'OPEN', limit: 1, after: undefined }));
      const row = reject as { id: string; version: number };
      expect(await refusal(as((tx) => hub.resolveReject(tx, row.id, row.version + 1, 'DISCARDED', 'Not a project of ours', memberId(CHECKER)), CHECKER))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(as((tx) => hub.resolveReject(tx, row.id, row.version, 'DISCARDED', 'no', memberId(CHECKER)), CHECKER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'resolution' });
      const closed = await as((tx) => hub.resolveReject(tx, row.id, row.version, 'DISCARDED', 'Not a project of ours', memberId(CHECKER)), CHECKER);
      expect(closed.row).toMatchObject({ state: 'DISCARDED', resolvedBy: memberId(CHECKER), version: 2 });
      expect(await refusal(as((tx) => hub.resolveReject(tx, row.id, 2, 'REPROCESSED', 'Corrected and loaded', memberId(CHECKER)), CHECKER))).toMatchObject({ code: 'HUB_REJECT_STATE_INVALID', status: 409 });
      expect(await as((tx) => hub.openRejectCount(tx, 'national.project_codes'))).toBe(1);
      expect(await as((tx) => hub.listRejects(tx, 'national.project_codes', { limit: 10, after: undefined }), MAKER, TENANT_B)).toEqual([]);
    });
  });

  describe('collector agents', () => {
    const registration = { agentCode: 'collector-hn-01', os: 'linux' as const, cpuArch: 'arm64' as const, agentVersion: '1.4.2', connectors: ['egp.muasamcong', 'treasury.statement'] };

    it('registers an agent with its platform, judges its health from the heartbeat, and refuses a repeat code, an unknown connector and a retired agent', async () => {
      const row = await as((tx) => hub.registerAgent(tx, registration, memberId(MAKER), NOW, 15));
      expect(row).toMatchObject({ agentCode: 'collector-hn-01', os: 'linux', cpuArch: 'arm64', health: 'NEVER_SEEN', spoolDepth: 0, connectors: registration.connectors });
      expect(await refusal(as((tx) => hub.registerAgent(tx, registration, memberId(MAKER), NOW, 15)))).toMatchObject({ code: 'HUB_AGENT_CODE_TAKEN', status: 409 });
      expect(await refusal(as((tx) => hub.registerAgent(tx, { ...registration, agentCode: 'collector-hn-02', connectors: ['no.such'] }, memberId(MAKER), NOW, 15)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'connectors' });
      const beat = await as((tx) => hub.heartbeat(tx, 'collector-hn-01', { agentVersion: '1.4.3', spoolDepth: 7 }, NOW, 15));
      expect(beat).toMatchObject({ health: 'ONLINE', agentVersion: '1.4.3', spoolDepth: 7, version: 2 });
      const later = await as((tx) => hub.listAgents(tx, { connectorCode: 'egp.muasamcong', now: new Date(NOW.getTime() + 20 * 60_000), staleAfterMinutes: 15 }));
      expect(later.map((agent) => [agent.agentCode, agent.health])).toEqual([['collector-hn-01', 'STALE']]);
      expect(await as((tx) => hub.listAgents(tx, { connectorCode: 'national.project_codes', now: NOW, staleAfterMinutes: 15 }))).toEqual([]);
      expect(await as((tx) => hub.listAgents(tx, { now: NOW, staleAfterMinutes: 15 }), MAKER, TENANT_B)).toEqual([]);
      await owner("update machvon.hub_collector_agent set state = 'RETIRED', version = version + 1");
      expect(await refusal(as((tx) => hub.heartbeat(tx, 'collector-hn-01', { agentVersion: '1.4.3', spoolDepth: 0 }, NOW, 15)))).toMatchObject({ code: 'HUB_AGENT_RETIRED', status: 409 });
      expect(await refusal(as((tx) => hub.heartbeat(tx, 'nobody', { agentVersion: '1.0', spoolDepth: 0 }, NOW, 15)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('the KPI set', () => {
    it('gives the five definitions with formula, source, as-of and the unverified flag, and the values of the summary', async () => {
      const { summary } = await as((tx) => hub.readings(tx, connectorDescriptors(), NOW));
      const kpis = await as((tx) => hub.kpis(tx, summary, NOW));
      expect(kpis.map((kpi) => kpi.code)).toEqual(['HUB_CONNECTORS_HEALTHY_PCT', 'HUB_OLDEST_DATA_AGE_DAYS', 'HUB_FAILED_RUNS_7D', 'HUB_DISCREPANCY_BACKLOG', 'HUB_PENDING_MAPPINGS']);
      for (const kpi of kpis) {
        expect(kpi.definition.formula.length).toBeGreaterThan(10);
        expect(kpi.definition.source.length).toBeGreaterThan(5);
        expect(kpi.definition.unverified).toBe(true);
      }
    });
  });
});
