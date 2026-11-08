import { ACCESS_CONNECTOR_CODE, FEED_CONNECTOR_CODE, FEED_LAYOUT_VERSION, MASTER_IMPORT_CONNECTOR_CODE, connectorDescriptor, feedGeneratorParamsOf, generateClientCredentials, generateFeedRecords, registerBuiltInConnectors } from '@machvon/kernel';
import type { ConnectorDescriptor } from '@machvon/kernel';
import { FeedConnectionStore, FeedRecordStore } from '../src/finance-feed-store';
import { registerBuiltInHubAdapters } from '../src/hub-adapters';
import { HubRunPort } from '../src/hub-run-port';
import { HubStore } from '../src/hub-store';
import { MachineAccountStore } from '../src/int-open-api-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

registerBuiltInConnectors();
registerBuiltInHubAdapters();

/**
 * HUB-2: the connections that existed before the hub report to it without changing their own behaviour. These cases prove the shared run port (once per reference, nothing for a connector the process does not know),
 * the feed that writes its generator moves to the hub run log and has its switch moved by the hub, the open interface that the hub checks every hour, and the database half of the conformance check for the
 * connectors added by this lane.
 */
const harness = new AuthzHarness();
const hub = new HubStore();
const port = new HubRunPort();
const MAKER = 1;
const NOW = new Date('2026-11-08T03:00:00Z');
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const descriptor = (code: string): ConnectorDescriptor => connectorDescriptor(code) as ConnectorDescriptor;

describe('the connections adopted by the Integration Hub (HUB-2)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      await harness.seedMembership(tenant, MAKER, 1);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the shared run port', () => {
    const report = { kind: 'IMPORT' as const, outcome: 'SUCCEEDED' as const, startedAt: new Date(NOW.getTime() - 60_000), finishedAt: NOW, layoutCode: 'MASTER_FILE', layoutVersion: 'TENANT-MAPPING', rowsTotal: 10, rowsApplied: 8, rowsRejected: 2, sourceRef: 'master-import:batch-1' };

    it('records a run once per source reference and shows it in the list of runs of the connector', async () => {
      const first = await as((tx) => port.report(tx, MASTER_IMPORT_CONNECTOR_CODE, report, memberId(MAKER)));
      expect(first?.duplicate).toBe(false);
      const again = await as((tx) => port.report(tx, MASTER_IMPORT_CONNECTOR_CODE, report, memberId(MAKER)));
      expect(again).toEqual({ id: first?.id, duplicate: true });
      const runs = await as((tx) => hub.listRuns(tx, descriptor(MASTER_IMPORT_CONNECTOR_CODE), { limit: 10, after: undefined }));
      expect(runs.map((run) => [run.origin, run.kind, run.outcome, run.rowsTotal, run.rowsRejected])).toEqual([['HUB', 'IMPORT', 'SUCCEEDED', 10, 2]]);
      const reading = await as((tx) => hub.reading(tx, descriptor(MASTER_IMPORT_CONNECTOR_CODE), NOW));
      expect(reading.health).toMatchObject({ status: 'HEALTHY', acceptance: 'NOT_APPLICABLE' });
    });

    it('replaces an error code that is not a stable code, writes nothing for a connector the process does not know and refuses an unknown layout', async () => {
      const failed = await as((tx) => port.report(tx, MASTER_IMPORT_CONNECTOR_CODE, { ...report, outcome: 'FAILED', errorCode: 'free text of the other side', sourceRef: 'master-import:batch-2' }, memberId(MAKER)));
      expect(failed?.duplicate).toBe(false);
      const stored = await owner<{ error_code: string }>("select error_code from machvon.hub_run_log where source_ref = 'master-import:batch-2'");
      expect(stored[0]?.error_code).toBe('RUN_FAILED');
      expect(await as((tx) => port.report(tx, 'no.such-connector', report, memberId(MAKER)))).toBeNull();
      await expect(as((tx) => port.report(tx, MASTER_IMPORT_CONNECTOR_CODE, { ...report, layoutVersion: 'OTHER', sourceRef: 'master-import:batch-3' }, memberId(MAKER)))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('does not show one tenant the runs of another', async () => {
      expect(await as((tx) => hub.listRuns(tx, descriptor(MASTER_IMPORT_CONNECTOR_CODE), { limit: 10, after: undefined }), MAKER, TENANT_B)).toEqual([]);
    });
  });

  describe('the Finance Department feed', () => {
    it('has its switch moved by the hub through the feed store, with the history of the feed', async () => {
      const feed = new FeedConnectionStore();
      await as((tx) => feed.ensure(tx, memberId(MAKER)));
      const before = await as((tx) => hub.reading(tx, descriptor(FEED_CONNECTOR_CODE), NOW));
      expect(before).toMatchObject({ enabled: true, stateOwner: 'CONNECTOR' });
      const moved = await as((tx) => hub.setState(tx, FEED_CONNECTOR_CODE, before.stateVersion, { enabled: false, reason: 'Paused while the Finance Department fixes its export' }, memberId(MAKER)));
      expect(moved).toMatchObject({ delegated: true, after: { enabled: false } });
      expect((await as((tx) => feed.current(tx))).enabled).toBe(false);
      expect((await as((tx) => hub.reading(tx, descriptor(FEED_CONNECTOR_CODE), NOW))).health.status).toBe('DISABLED');
      const back = await as((tx) => hub.setState(tx, FEED_CONNECTOR_CODE, moved.after.version, { enabled: true, reason: 'The export is fixed again' }, memberId(MAKER)));
      expect(back.after.enabled).toBe(true);
    });

    it('writes a generator move to the hub run log once and shows the feed as healthy', async () => {
      const params = feedGeneratorParamsOf({ seed: 7, fiscal_year: 2026, current_month: 6 }, '2026-11-08');
      const batch = generateFeedRecords(params).slice(0, 5);
      const records = new FeedRecordStore();
      const written = await as((tx) => records.writeRun(tx, { channel: 'GENERATOR', kind: null, action: 'GENERATOR_START', layoutVersion: FEED_LAYOUT_VERSION, records: batch, rejected: 0, epoch: 1, seed: params.seed }, memberId(MAKER)));
      const logged = await owner<{ run_kind: string; outcome: string; rows_total: number; source_ref: string }>("select run_kind, outcome, rows_total, source_ref from machvon.hub_run_log where connector_code = 'fin.sotaichinh'");
      expect(logged).toEqual([{ run_kind: 'GENERATE', outcome: 'SUCCEEDED', rows_total: batch.length, source_ref: `feed-run:${written.runId}` }]);
      const reading = await as((tx) => hub.reading(tx, descriptor(FEED_CONNECTOR_CODE), NOW));
      expect(reading.health).toMatchObject({ status: 'HEALTHY', acceptance: 'PENDING_EXTERNAL' });
    });
  });

  describe('the open interface', () => {
    const accounts = new MachineAccountStore();
    const request = { name: 'Reporting robot', description: null, scopes: ['open.projects.read'], ratePerMinute: 60, expiresOn: '2026-12-31' };

    it('is NEVER_RUN for a tenant that never opened it: the check is skipped and nothing is claimed', async () => {
      const swept = await as((tx) => hub.sweep(tx, [descriptor(ACCESS_CONNECTOR_CODE)], NOW, memberId(MAKER)));
      expect(swept.items[0]?.health.status).toBe('NEVER_RUN');
      const runs = await owner<{ outcome: string; run_kind: string }>("select outcome, run_kind from machvon.hub_run_log where connector_code = 'access.open-api'");
      expect(runs).toEqual([{ outcome: 'SKIPPED', run_kind: 'CHECK' }]);
    });

    it('is checked once an hour: healthy with an account in order, failing when a credential has expired, and the hub opens the incident', async () => {
      const later = new Date(NOW.getTime() + 2 * 3_600_000);
      await as((tx) => accounts.create(tx, request, generateClientCredentials(), memberId(MAKER), later));
      const ok = await as((tx) => hub.sweep(tx, [descriptor(ACCESS_CONNECTOR_CODE)], later, memberId(MAKER)));
      expect(ok.items[0]?.health.status).toBe('HEALTHY');
      const sameHour = await as((tx) => hub.sweep(tx, [descriptor(ACCESS_CONNECTOR_CODE)], new Date(later.getTime() + 60_000), memberId(MAKER)));
      expect(sameHour.snapshotsWritten).toBe(0);
      expect((await owner("select 1 from machvon.hub_run_log where connector_code = 'access.open-api' and run_kind = 'CHECK'")).length).toBe(2);
      await owner("update machvon.int_machine_account set expires_on = '2026-11-01' where name = $1", [request.name]);
      const expiredAt = new Date(later.getTime() + 2 * 3_600_000);
      const failed = await as((tx) => hub.sweep(tx, [descriptor(ACCESS_CONNECTOR_CODE)], expiredAt, memberId(MAKER)));
      expect(failed.items[0]?.health).toMatchObject({ status: 'FAILING', alert: { code: 'CONNECTOR_FAILING' } });
      expect(failed.incidents.opened).toEqual([expect.objectContaining({ kind: 'FAILING', connectorCode: 'access.open-api', state: 'OPEN' })]);
      const error = await owner<{ error_code: string }>("select error_code from machvon.hub_run_log where connector_code = 'access.open-api' and outcome = 'FAILED'");
      expect(error).toEqual([{ error_code: 'ACCESS_CREDENTIAL_EXPIRED' }]);
    });
  });

  describe('the database half of the conformance check', () => {
    it('asks no cursor row of an import that keeps none, and the feed has its positions once it was used', async () => {
      expect(await as((tx) => hub.conformanceProblems(tx, descriptor('ind.figure-import'), NOW))).toEqual([]);
      expect(await as((tx) => hub.conformanceProblems(tx, descriptor(MASTER_IMPORT_CONNECTOR_CODE), NOW))).toEqual([]);
      expect(await as((tx) => hub.conformanceProblems(tx, descriptor(ACCESS_CONNECTOR_CODE), NOW))).toEqual([]);
      expect(await as((tx) => hub.conformanceProblems(tx, descriptor(FEED_CONNECTOR_CODE), NOW))).toEqual([]);
    });
  });
});
