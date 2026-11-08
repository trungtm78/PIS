import { ControlDatabase, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { Pool } from 'pg';
import { InMemoryVault, MockLiteLlm } from '../../src/modules/llm/mock-key-ports';
import { startWorkers } from '../../src/workers/workers';
import type { RunningWorkers, WorkersDeps } from '../../src/workers/workers';
import { ManualTimers, until } from '../support/manual-timers';

// Port 1 of the loopback address has no listener: every connection is refused at once, with no database involved.
const UNREACHABLE = 'postgres://nobody:nothing@127.0.0.1:1/none';

describe('startWorkers without a reachable database', () => {
  const pools: Pool[] = [];
  const raised: Array<{ code: string; context: Record<string, unknown> }> = [];
  const lines: string[] = [];
  let timers: ManualTimers;
  let workers: RunningWorkers | undefined;

  const pool = (): Pool => {
    const made = new Pool({ connectionString: UNREACHABLE, max: 2 });
    made.on('error', () => undefined);
    pools.push(made);
    return made;
  };

  const depsWith = (alerts: WorkersDeps['alerts']): WorkersDeps => {
    return {
      tenants: new TenantDatabase(pool()),
      control: new ControlDatabase(pool()),
      relayPool: pool(),
      lockPool: pool(),
      signingKey: Buffer.alloc(32, 3),
      alerts,
      publish: () => Promise.resolve(),
      accessCache: new InMemoryAuthzCache(),
    };
  };

  const collecting: WorkersDeps['alerts'] = { raise: (code, context) => void raised.push({ code, context }) };

  beforeEach(() => {
    timers = new ManualTimers();
    raised.length = 0;
    lines.length = 0;
  });

  afterEach(async () => {
    await workers?.stop();
    workers = undefined;
    await Promise.all(pools.splice(0).map((made) => made.end()));
  });

  const start = (deps: WorkersDeps, overrides: Partial<Parameters<typeof startWorkers>[1]> = {}): RunningWorkers => {
    workers = startWorkers(deps, { timers, log: (line) => void lines.push(line), ...overrides });
    return workers;
  };

  it('schedules the jobs of docs/runbooks/jobs.md at their documented intervals', () => {
    const running = start(depsWith(collecting));
    expect(running.jobs).toEqual(['audit-seal', 'audit-verify', 'outbox-relay', 'idempotency-purge', 'certificate-expiry', 'master-activation', 'master-baseline-sync', 'dis-period-autoclose', 'dis-reopen-expiry', 'retention-purge', 'guarantee-expiry', 'retention-due', 'revision-effective', 'petition-due', 'permit-expiry', 'gate-waiver-expiry', 'issue-sla', 'unit-reorganization', 'delegation-lifecycle', 'support-access-lifecycle', 'tenant-domain', 'placement-migration', 'tenant-restore', 'approval-sla', 'notification-campaign-progress', 'dgv-quality-run', 'subscription-cycle', 'einvoice-billing', 'payment-reconciliation', 'allocation-extension-lapse', 'fiscal-year-relock', 'entitlement-override-expiry', 'license-status', 'membership-invitation-expiry', 'land-stage-late', 'prj-explanation-overdue', 'mne-package-expiry', 'prj-transfer-apply', 'incoming-overdue', 'doc-handover-due', 'bi-query-jobs', 'bi-query-answer-expiry', 'dgv-incident-sweep', 'dgv-product-cert-expiry', 'dgv-maturity-sweep', 'reconciliation-overdue', 'treasury-daily-recon', 'settlement-deadline', 'advance-overdue', 'work-reminder', 'alert-observe', 'alert-ladder', 'red-flag-scan', 'vendor-link-scan', 'vendor-screening', 'early-warning-score', 'risk-rescore', 'diary-coverage', 'capital-balance-reconcile', 'capital-reservation-expiry', 'ast-evaluation-due', 'ast-claim-overdue', 'aud-recovery-reconcile', 'llm-reservation-expiry', 'alert-escalation', 'alert-coverage', 'contract-settlement-clock', 'access-cache-expiry']);
    expect(timers.delays()).toEqual([5, 10, 30, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 300, 300, 300, 300, 300, 300, 300, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 10800, 21600, 21600, 86400, 86400, 86400].map((seconds) => seconds * 1000));
  });

  it('schedules the sweep of the virtual keys every five minutes where the ports of the keys are bound (ST-LLM-002), and not otherwise', () => {
    expect(start(depsWith(collecting)).jobs).not.toContain('llm-key-sweep');
    const running = start({ ...depsWith(collecting), llmKeys: { litellm: new MockLiteLlm(), vault: new InMemoryVault() } });
    expect(running.jobs).toContain('llm-key-sweep');
    expect(timers.delays()).toContain(300_000);
  });

  it('takes an interval override of the caller (the end-to-end stack polls its relay faster)', () => {
    start(depsWith(collecting), { intervalSeconds: { 'outbox-relay': 1 } });
    expect(timers.delays()[0]).toBe(1000);
  });

  it('survives a tick that cannot reach the database: the run is FAILED and JOB_FAILED is raised with the error class only', async () => {
    const running = start(depsWith(collecting));
    timers.fire(5000);
    await until(() => running.history('outbox-relay').length === 1, 'the relay tick');
    expect(running.history('outbox-relay')[0]?.outcome).toBe('FAILED');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.code).toBe('JOB_FAILED');
    expect(Object.keys(raised[0]?.context ?? {}).sort()).toEqual(['errorClass', 'job']);
    expect(raised[0]?.context.job).toBe('outbox-relay');
    // The next tick is armed again: a failed run does not end the schedule.
    await until(() => timers.delays().includes(5000), 'the next relay tick to be armed');
  });

  it('logs a failure that escapes the job runner by error class only, never its message, and raises the alert', async () => {
    const leakedUrl = 'postgres://machvon_app:hunter2@db.internal:5432/machvon';
    let attempts = 0;
    // The first raise (inside the runner) throws, so the run rejects and reaches the safety net of the scheduler.
    const failing: WorkersDeps['alerts'] = {
      raise: (code, context) => {
        attempts += 1;
        if (attempts === 1) throw new RangeError(leakedUrl);
        raised.push({ code, context });
      },
    };
    const running = start(depsWith(failing));
    timers.fire(5000);
    await until(() => raised.length === 1, 'the alert of the safety net');
    expect(raised[0]).toEqual({ code: 'JOB_FAILED', context: { job: 'outbox-relay', errorClass: 'RangeError' } });
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toEqual([{ level: 'error', message: 'worker tick failed', job: 'outbox-relay', errorClass: 'RangeError' }]);
    expect(lines.join('\n')).not.toContain('hunter2');
    await running.stop();
  });

  it('writes a second line when the alert itself cannot be raised, and still carries on', async () => {
    const broken: WorkersDeps['alerts'] = {
      raise: () => {
        throw new TypeError('sink down');
      },
    };
    const running = start(depsWith(broken));
    timers.fire(5000);
    await until(() => lines.length === 2, 'the two log lines');
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged[1]).toEqual({ level: 'error', message: 'worker alert not raised', job: 'outbox-relay', errorClass: 'TypeError' });
    await expect(running.stop()).resolves.toBeUndefined();
  });

  it('stops every timer, and a second stop is safe', async () => {
    const running = start(depsWith(collecting));
    expect(timers.delays()).toHaveLength(68);
    await running.stop();
    expect(timers.delays()).toEqual([]);
    await expect(running.stop()).resolves.toBeUndefined();
  });
});
