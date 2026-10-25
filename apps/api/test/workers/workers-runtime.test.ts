import { randomUUID } from 'node:crypto';
import { AuditWriter, CertificateStore, PLATFORM_TENANT_ID, enqueueOutbox } from '@machvon/db';
import { InMemorySpanExporter, OUTBOX_MAX_ATTEMPTS } from '@machvon/kernel';
import type { Config } from '../../src/config/config';
import { Client } from 'pg';
import { createAlertSink } from '../../src/alerts/alert-sinks';
import { bootstrap } from '../../src/bootstrap';
import { InProcessWorkflowRunner } from '../../src/provisioning/workflow-runner';
import type { RunningApi } from '../../src/bootstrap';
import { ACTOR, TENANT_A, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { READER, startBootstrapFixture } from '../support/bootstrap-fixture';
import type { BootstrapFixture } from '../support/bootstrap-fixture';
import { ManualTimers, until } from '../support/manual-timers';

const DAY_MS = 86_400_000;
const SEAL_DELAY = 300_000;
const QUARTER_HOURLY_DELAY = 900_000;
const HOURLY_DELAY = 3_600_000;
const RELAY_DELAY = 5_000;
const CACHE_DELAY = 60_000;
const SIX_HOURLY_DELAY = 21_600_000;
const DAILY_DELAY = 86_400_000;
const ALL_DELAYS = [RELAY_DELAY, CACHE_DELAY, SEAL_DELAY, QUARTER_HOURLY_DELAY, HOURLY_DELAY, SIX_HOURLY_DELAY, DAILY_DELAY];
const TEST_TIMEOUT = 90_000;

interface RaisedAlert {
  code: string;
  context: Record<string, unknown>;
}

describe('the background workers of the real API process (N1: ST-ADM-002, ST-KERNEL-022, ST-KERNEL-051)', () => {
  const exporter = new InMemorySpanExporter();
  const running: RunningApi[] = [];
  const clients: Client[] = [];
  let fixture: BootstrapFixture;
  let timers: ManualTimers;
  let lines: string[];

  /** The alerts the process raised, read from the lines the real alert sink wrote to its log. */
  const alerts = (code?: string): RaisedAlert[] =>
    lines
      .map((line) => JSON.parse(line) as { level: string; code: string; context: Record<string, unknown> })
      .filter((entry) => entry.level === 'alert' && (code === undefined || entry.code === code))
      .map(({ code: raised, context }) => ({ code: raised, context }));

  async function start(extra: Record<string, string> = {}, options: { manualTimers?: boolean; workflowRunner?: InProcessWorkflowRunner } = {}): Promise<RunningApi> {
    const config: Config = fixture.configWith(extra);
    const api = await bootstrap(config, {
      exporter,
      port: 0,
      alerts: createAlertSink(config, { write: (line) => void lines.push(line) }),
      workerLog: (line) => void lines.push(line),
      ...(options.manualTimers === false ? {} : { timers }),
      ...(options.workflowRunner === undefined ? {} : { workflowRunner: options.workflowRunner }),
    });
    running.push(api);
    return api;
  }

  const createUnit = async (api: RunningApi): Promise<string> => {
    const reply = await fetch(`http://127.0.0.1:${api.port}/org-units`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ code: `W${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Unit made by a command', parent_id: unitId(1), unit_type: 'DEPARTMENT', valid_from: '2026-02-01' }),
    });
    const text = await reply.text();
    if (reply.status >= 300) throw new Error(`the create command answered ${reply.status}: ${text}`);
    return (JSON.parse(text) as { resource_id: string }).resource_id;
  };

  const eventOf = async (aggregateId: string): Promise<{ id: string; status: string }> => {
    const rows = await fixture.harness.owner<{ id: string; status: string }>(TENANT_A, [['select id, status from machvon.outbox_event where aggregate_id = $1', [aggregateId]]]);
    expect(rows).toHaveLength(1);
    return rows[0] as { id: string; status: string };
  };

  /** Writes an event the way a command does: inside a tenant transaction, through the outbox helper. */
  const plantEvent = (type: string, payload: Record<string, unknown>): Promise<string> =>
    fixture.harness.tenants
      .withTenant(contextFor(TENANT_A, memberId(READER)), (tx) =>
        enqueueOutbox(tx, { aggregateType: 'tenant', aggregateId: TENANT_A, aggregateVersion: 1, type, schemaVersion: 1, payload, eventKey: `planted:${randomUUID()}`, correlationId: randomUUID() }),
      )
      .then((written) => written.id);

  const admin = async (): Promise<Client> => {
    const client = new Client({ connectionString: fixture.harness.database.adminUrl });
    await client.connect();
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    fixture = await startBootstrapFixture(['organization_unit.read', 'iam.unit.manage']);
  }, 180_000);

  beforeEach(() => {
    timers = new ManualTimers();
    lines = [];
  });

  afterEach(async () => {
    // The tamper test leaves a broken chain behind; the next test starts from a clean audit trail of the control plane.
    await fixture.harness.owner(PLATFORM_TENANT_ID, [
      ['delete from machvon.audit_seal', []],
      ['delete from machvon.audit_event', []],
    ]);
    while (running.length > 0) await running.pop()?.stop();
    await Promise.all(clients.splice(0).map((client) => client.end()));
    exporter.spans.length = 0;
  });

  afterAll(async () => {
    await fixture.stop();
  }, 60_000);

  describe('the outbox relay', () => {
    it('delivers the event a command wrote, with no manual run of the relay', async () => {
      const api = await start();
      const unit = await createUnit(api);
      expect((await eventOf(unit)).status).toBe('PENDING');
      timers.fire(RELAY_DELAY);
      await until(async () => (await eventOf(unit)).status === 'PUBLISHED', 'the relay to publish the event');
      expect(api.workers?.history('outbox-relay').map((run) => run.outcome)).toEqual(['SUCCESS']);
    }, TEST_TIMEOUT);

    it('delivers it on the real clock too: the relay ticks every 5 seconds after the process started', async () => {
      const api = await start({}, { manualTimers: false });
      const unit = await createUnit(api);
      await until(async () => (await eventOf(unit)).status === 'PUBLISHED', 'the relay to publish the event on its own tick');
    }, TEST_TIMEOUT);

    it('hands the event to the consumers with the signed context: the tenant-status consumer leaves its inbox row', async () => {
      const api = await start();
      const eventId = await plantEvent('sas.tenant.status_changed.v1', { tenant_id: TENANT_A, from: 'Active', to: 'Suspended' });
      timers.fire(RELAY_DELAY);
      await until(async () => api.workers?.history('outbox-relay').length === 1, 'the relay tick');
      const inbox = await fixture.harness.owner<{ provider: string }>(TENANT_A, [['select provider from machvon.integration_event_inbox where event_key = $1', [eventId]]]);
      expect(inbox.map((row) => row.provider)).toEqual(['consumer:tenant-status-cache']);
      expect(alerts()).toEqual([]);
    }, TEST_TIMEOUT);

    it('raises OUTBOX_EVENT_DEAD through the real alert sink when an event runs out of attempts (AC-ST-KERNEL-022-3)', async () => {
      const api = await start();
      // A registered notification type with a payload that breaks its schema: the consumer refuses it on every delivery.
      const eventId = await plantEvent('sas.license.expiring.v1', {});
      await fixture.harness.owner(TENANT_A, [['update machvon.outbox_event set attempts = $2 where id = $1', [eventId, OUTBOX_MAX_ATTEMPTS - 1]]]);
      timers.fire(RELAY_DELAY);
      await until(async () => api.workers?.history('outbox-relay').length === 1, 'the relay tick');
      expect(alerts('OUTBOX_EVENT_DEAD')).toEqual([{ code: 'OUTBOX_EVENT_DEAD', context: { eventId, tenantId: TENANT_A, type: 'sas.license.expiring.v1', attempts: OUTBOX_MAX_ATTEMPTS } }]);
      const [row] = await fixture.harness.owner<{ status: string }>(TENANT_A, [['select status from machvon.outbox_event where id = $1', [eventId]]]);
      expect(row?.status).toBe('DEAD');
    }, TEST_TIMEOUT);
  });

  describe('the audit seal and verify jobs', () => {
    it('detects a planted tamper with the verify job the process started and raises AUDIT_CHAIN_BROKEN (AC-ST-ADM-002-1)', async () => {
      const writer = new AuditWriter(fixture.harness.tenants);
      const control = { tenantId: PLATFORM_TENANT_ID, membershipId: ACTOR, scopeVersion: 1 };
      await fixture.harness.tenants.withTenant(control, async (tx) => {
        for (let index = 1; index <= 3; index += 1) {
          await writer.recordInTx(tx, ACTOR, { action: `control.action-${index}`, resourceType: 'tenant', resourceId: TENANT_A, diff: { index }, correlationId: randomUUID(), requestId: randomUUID() });
        }
      });
      const api = await start();
      timers.fire(SEAL_DELAY);
      await until(() => api.workers?.history('audit-seal').length === 1, 'the seal tick');
      expect(api.workers?.history('audit-seal')[0]?.outcome).toBe('SUCCESS');
      const sealed = await fixture.harness.owner<{ n: string }>(PLATFORM_TENANT_ID, [['select count(*)::text as n from machvon.audit_seal', []]]);
      expect(Number(sealed[0]?.n)).toBeGreaterThan(0);

      // The untouched chain verifies and raises nothing.
      timers.fire(HOURLY_DELAY);
      await until(() => api.workers?.history('audit-verify').length === 1, 'the first verify tick');
      expect(api.workers?.history('audit-verify')[0]?.outcome).toBe('SUCCESS');
      expect(alerts()).toEqual([]);

      await fixture.harness.owner(PLATFORM_TENANT_ID, [["update machvon.audit_event set action = 'tampered' where action = 'control.action-2'", []]]);
      await until(() => timers.delays().includes(HOURLY_DELAY), 'the next verify tick to be armed');
      timers.fire(HOURLY_DELAY);
      await until(() => api.workers?.history('audit-verify').length === 2, 'the second verify tick');
      expect(api.workers?.history('audit-verify')[1]?.outcome).toBe('FAILED');
      expect(alerts('AUDIT_CHAIN_BROKEN')).toEqual([expect.objectContaining({ context: expect.objectContaining({ tenantId: PLATFORM_TENANT_ID, reason: 'ROOT_MISMATCH' }) })]);
      expect(alerts('JOB_FAILED')).toEqual([{ code: 'JOB_FAILED', context: { job: 'audit-verify', errorClass: 'AuditChainBroken' } }]);
    }, TEST_TIMEOUT);
  });

  describe('every job, on the real database', () => {
    it('runs each of the nine jobs once under its lock and succeeds, the certificate expiry marking an ended certificate Expired', async () => {
      const connection = await admin();
      const placement = randomUUID();
      await connection.query("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'north-1', 'kms-1', 'Active')", [placement]);
      await connection.query(
        "insert into machvon.tenant (id, code, name, status, placement_id, region, governing_body_type, isolation_mode) values ($1, 'cao-bang', 'Cao Bang', 'Active', $2, 'vn-north', 'PROVINCE', 'POOL')",
        [TENANT_A, placement],
      );
      try {
        const store = new CertificateStore();
        const registered = await fixture.harness.tenants.withTenant(contextFor(TENANT_A, memberId(READER)), (tx) =>
          store.register(
            tx,
            {
              kind: 'PERSONAL',
              holderMembershipId: memberId(READER),
              providerCode: 'VNPT-CA',
              parsed: {
                serial: '0A1B',
                issuerDn: 'CN=Test CA',
                subjectDn: 'CN=Nguyen Van A',
                validFrom: new Date(Date.now() - 2 * DAY_MS),
                validUntil: new Date(Date.now() - DAY_MS),
                fingerprintSha256: randomUUID().replaceAll('-', '').padEnd(64, '0'),
              },
            },
            ACTOR,
          ),
        );

        const api = await start();
        for (const delay of ALL_DELAYS) timers.fire(delay);
        await until(() => (api.workers?.history().length ?? 0) >= 29, 'every job to have run once');
        const outcomes = Object.fromEntries((api.workers?.history() ?? []).map((run) => [run.name, run.outcome]));
        expect(outcomes).toEqual({
          'outbox-relay': 'SUCCESS',
          'access-cache-expiry': 'SUCCESS',
          'audit-seal': 'SUCCESS',
          'audit-verify': 'SUCCESS',
          'idempotency-purge': 'SUCCESS',
          'certificate-expiry': 'SUCCESS',
          'master-activation': 'SUCCESS',
          'master-baseline-sync': 'SUCCESS',
          'dis-period-autoclose': 'SUCCESS',
          'dis-reopen-expiry': 'SUCCESS',
          'retention-purge': 'SUCCESS',
          'guarantee-expiry': 'SUCCESS',
          'retention-due': 'SUCCESS',
          'revision-effective': 'SUCCESS',
          'petition-due': 'SUCCESS',
          'permit-expiry': 'SUCCESS',
          'gate-waiver-expiry': 'SUCCESS',
          'issue-sla': 'SUCCESS',
          'integration-inbox': 'SUCCESS',
          'notification-dispatch': 'SUCCESS',
          'notification-reconcile': 'SUCCESS',
          'subscription-cycle': 'SUCCESS',
          'allocation-extension-lapse': 'SUCCESS',
          'fiscal-year-relock': 'SUCCESS',
          'entitlement-override-expiry': 'SUCCESS',
          'land-stage-late': 'SUCCESS',
          'reconciliation-overdue': 'SUCCESS',
          'settlement-deadline': 'SUCCESS',
          'capital-balance-reconcile': 'SUCCESS',
        });
        const [certificate] = await fixture.harness.owner<{ status: string }>(TENANT_A, [['select status from machvon.signing_certificate where id = $1', [registered.id]]]);
        expect(certificate?.status).toBe('Expired');
        // The baseline job also gave the tenant the starting permit type catalogue (ST-PMT-001): eight working assumptions, each awaiting its confirmation.
        const seeded = await fixture.harness.owner<{ code: string; cxn_ref: string; status: string }>(TENANT_A, [['select code, cxn_ref, status from machvon.permit_type order by code', []]]);
        expect(seeded.map((type) => type.code)).toEqual(['BUILDING_PERMIT', 'DESIGN_APPRAISAL', 'ENV_EIA', 'ENV_PERMIT', 'FIRE_DESIGN', 'LAND_ALLOCATION', 'TRAFFIC_CONNECTION', 'WATER_DISCHARGE']);
        expect(seeded.every((type) => type.status === 'PUBLISHED' && type.cxn_ref.startsWith('CXN-EXE-0'))).toBe(true);
      } finally {
        await fixture.harness.owner(TENANT_A, [['delete from machvon.permit_type', []]]);
        await fixture.harness.owner(TENANT_A, [['delete from machvon.signing_certificate', []]]);
        await connection.query('delete from machvon.tenant where id = $1', [TENANT_A]);
        await connection.query('delete from machvon.placement where id = $1', [placement]);
      }
    }, TEST_TIMEOUT);
  });

  describe('shutdown and the switch', () => {
    it('stops every timer on stop() and a second stop is safe', async () => {
      const api = await start();
      expect(timers.delays()).toHaveLength(30);
      await api.stop();
      expect(timers.delays()).toEqual([]);
      await expect(api.stop()).resolves.toBeUndefined();
    }, TEST_TIMEOUT);

    it('waits for the tick in flight before it closes the pools', async () => {
      const api = await start();
      const unit = await createUnit(api);
      const blocker = await admin();
      // A table lock holds the relay inside its claim query, so the tick is demonstrably in flight.
      await blocker.query('begin');
      await blocker.query('lock table machvon.outbox_event in access exclusive mode');
      let released = false;
      try {
        timers.fire(RELAY_DELAY);
        const watcher = await admin();
        await until(async () => {
          const waiting = await watcher.query("select 1 from pg_stat_activity where datname = current_database() and usename = 'machvon_outbox_relay' and wait_event_type = 'Lock'");
          return waiting.rowCount === 1;
        }, 'the relay to wait on the lock');
        const stopping = api.stop();
        const first = await Promise.race([stopping.then(() => 'stopped'), new Promise<string>((later) => setTimeout(() => later('waiting'), 500))]);
        expect(first).toBe('waiting');
        expect(timers.delays()).toEqual([]);
        await blocker.query('rollback');
        released = true;
        await stopping;
        // The tick ran to its end (SUCCESS) before stop() resolved, and the event it was claiming was published.
        expect(api.workers?.history('outbox-relay').map((run) => run.outcome)).toEqual(['SUCCESS']);
      } finally {
        if (!released) await blocker.query('rollback');
      }
      expect((await eventOf(unit)).status).toBe('PUBLISHED');
    }, TEST_TIMEOUT);

    it('waits for a provisioning workflow in flight before it closes the pools, and gives up on one that never ends after the shutdown timeout', async () => {
      const runner = new InProcessWorkflowRunner();
      const api = await start({}, { workflowRunner: runner });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let finished = false;
      await runner.start('prov:shutdown:1', async () => {
        await gate;
        finished = true;
      });
      const stopping = api.stop();
      const first = await Promise.race([stopping.then(() => 'stopped'), new Promise<string>((later) => setTimeout(() => later('waiting'), 500))]);
      expect(first).toBe('waiting');
      release();
      await stopping;
      expect(finished).toBe(true);
      expect(runner.isRunning('prov:shutdown:1')).toBe(false);

      const stuck = new InProcessWorkflowRunner();
      const second = await start({ SHUTDOWN_TIMEOUT_MS: '300' }, { workflowRunner: stuck });
      await stuck.start('prov:never-ends:1', () => new Promise<void>(() => undefined));
      const began = Date.now();
      await second.stop();
      expect(Date.now() - began).toBeLessThan(5_000);
    }, TEST_TIMEOUT);

    it('starts nothing when WORKERS_ENABLED is off: no timer, no workers, and the event waits', async () => {
      const api = await start({ WORKERS_ENABLED: 'false' });
      expect(api.workers).toBeUndefined();
      expect(timers.delays()).toEqual([]);
      const unit = await createUnit(api);
      expect((await eventOf(unit)).status).toBe('PENDING');
      await api.stop();
    }, TEST_TIMEOUT);

    it('starts no worker when the server cannot listen, and leaves no pool open', async () => {
      const first = await start({ WORKERS_ENABLED: 'false' });
      await expect(bootstrap(fixture.configWith(), { exporter, port: first.port, timers })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(timers.delays()).toEqual([]);
    }, TEST_TIMEOUT);

    it('starts the workers by default: an environment that does not mention the switch runs them', async () => {
      expect(fixture.configWith().workersEnabled).toBe(true);
      const api = await start();
      expect(api.workers?.jobs).toEqual(['audit-seal', 'audit-verify', 'outbox-relay', 'idempotency-purge', 'certificate-expiry', 'master-activation', 'master-baseline-sync', 'dis-period-autoclose', 'dis-reopen-expiry', 'retention-purge', 'guarantee-expiry', 'retention-due', 'revision-effective', 'petition-due', 'permit-expiry', 'gate-waiver-expiry', 'issue-sla', 'integration-inbox', 'notification-dispatch', 'notification-reconcile', 'dgv-quality-run', 'subscription-cycle', 'allocation-extension-lapse', 'fiscal-year-relock', 'entitlement-override-expiry', 'land-stage-late', 'reconciliation-overdue', 'settlement-deadline', 'capital-balance-reconcile', 'access-cache-expiry']);
    }, TEST_TIMEOUT);
  });
});
