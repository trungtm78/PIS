import type { Client } from 'pg';
import { Client as PgClient, Pool } from 'pg';
import { AuditSealJob } from '../src/audit-seal-job';
import { ControlDatabase, PLATFORM_TENANT_ID } from '../src/control-database';
import { IdempotencyStore } from '../src/idempotency-store';
import { JOB_FAILED_ALERT, JobRunner } from '../src/job-runner';
import { DATABASE_JOBS, JOB_INTERVAL_SECONDS, registeredTenantIds, standardJobs } from '../src/jobs';
import { main } from '../src/jobs-cli';
import { TENANT_A, TENANT_B, appendEntries, ownerSession, recorder, startAuditHarness } from './support/audit-fixtures';
import type { AuditHarness } from './support/audit-fixtures';

function capture() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

describe('standard jobs', () => {
  let harness: AuditHarness;
  let owner: Client;
  let pool: Pool;

  const reset = async (tenantId: string): Promise<void> => {
    const session = await ownerSession(harness, tenantId);
    try {
      await session.query('delete from machvon.audit_seal');
      await session.query('delete from machvon.audit_event');
    } finally {
      await session.end();
    }
  };

  const sealCount = async (tenantId: string): Promise<number> => {
    const session = await ownerSession(harness, tenantId);
    try {
      return Number((await session.query<{ n: string }>('select count(*) as n from machvon.audit_seal')).rows[0]?.n);
    } finally {
      await session.end();
    }
  };

  beforeAll(async () => {
    harness = await startAuditHarness();
    pool = new Pool({ connectionString: harness.database.urlFor('machvon_app'), max: 4 });
    owner = await ownerSession(harness, TENANT_A);
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await pool?.end();
    if (harness) await harness.stop();
  }, 60_000);

  afterEach(async () => {
    for (const tenantId of [TENANT_A, TENANT_B, PLATFORM_TENANT_ID]) await reset(tenantId);
  });

  const runnerFor = (tenantIds: readonly string[], seen = recorder()): { runner: JobRunner; seen: ReturnType<typeof recorder> } => {
    const runner = new JobRunner(pool, seen.sinks);
    const seal = new AuditSealJob(harness.tenantDatabase, { windowRows: 10, ...seen.sinks });
    for (const handler of standardJobs({ tenantIds: async () => tenantIds, seal, idempotency: new IdempotencyStore(harness.tenantDatabase) })) runner.register(handler);
    return { runner, seen };
  };

  it('seals the audit rows of every tenant', async () => {
    await appendEntries(harness, TENANT_A, 25);
    await appendEntries(harness, TENANT_B, 5);
    const { runner } = runnerFor([TENANT_A, TENANT_B]);
    expect((await runner.runOnce('audit-seal')).outcome).toBe('SUCCESS');
    expect(await sealCount(TENANT_A)).toBe(3);
    expect(await sealCount(TENANT_B)).toBe(1);
  });

  it('detects a row altered by the owner role within one verify run and raises AUDIT_CHAIN_BROKEN (AC-ST-ADM-002-1)', async () => {
    const { seqs } = await appendEntries(harness, TENANT_A, 25);
    const { runner, seen } = runnerFor([TENANT_A, TENANT_B]);
    await runner.runOnce('audit-seal');
    expect((await runner.runOnce('audit-verify')).outcome).toBe('SUCCESS');
    expect(seen.alerts).toEqual([]);

    await owner.query("update machvon.audit_event set action = 'tampered' where seq = $1", [seqs[12]]);
    const verified = await runner.runOnce('audit-verify');
    expect(verified.outcome).toBe('FAILED');
    expect(seen.alerts.map((alert) => alert.code)).toEqual(['AUDIT_CHAIN_BROKEN', JOB_FAILED_ALERT]);
    expect(seen.alerts[0]?.context).toMatchObject({ tenantId: TENANT_A, reason: 'ROOT_MISMATCH' });
    expect(seen.alerts[1]?.context).toEqual({ job: 'audit-verify', errorClass: 'AuditChainBroken' });
  });

  it('keeps going when one tenant fails and reports how many did', async () => {
    await appendEntries(harness, TENANT_A, 5);
    const { runner, seen } = runnerFor(['not-a-tenant-id', TENANT_A]);
    expect((await runner.runOnce('audit-seal')).outcome).toBe('FAILED');
    expect(await sealCount(TENANT_A)).toBe(1);
    expect(seen.alerts).toEqual([{ code: JOB_FAILED_ALERT, context: { job: 'audit-seal', errorClass: 'TenantJobsFailed' } }]);
    // A verify run where a tenant cannot be checked fails the same way, and still checks the others.
    expect((await runner.runOnce('audit-verify')).outcome).toBe('FAILED');
  });

  it('purges the expired idempotency rows of every tenant', async () => {
    const purged: string[] = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: {
        purgeExpired: async (ctx) => {
          purged.push(ctx.tenantId);
          return 0;
        },
      },
    });
    await handlers.find((handler) => handler.name === 'idempotency-purge')?.run();
    expect(purged).toEqual([TENANT_A, TENANT_B]);
  });

  it('expires the ended signing certificates of every tenant, one failing tenant not stopping the others', async () => {
    const visited: string[] = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      certificates: {
        expireDue: async (ctx) => {
          visited.push(ctx.tenantId);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
          return 1;
        },
      },
    });
    const job = handlers.find((handler) => handler.name === 'certificate-expiry');
    await expect(job?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([TENANT_A, TENANT_B]);
  });

  it('activates the master data of every tenant and reports the reviews that wait as one gauge (ST-MDM-001)', async () => {
    const visited: string[] = [];
    const gauges: Array<[string, number]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      masterData: {
        activateDue: async (ctx) => {
          visited.push(ctx.tenantId);
          return { changed: 1, pendingReviews: ctx.tenantId === TENANT_A ? 2 : 3 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) },
    });
    await handlers.find((handler) => handler.name === 'master-activation')?.run();
    expect(visited).toEqual([TENANT_A, TENANT_B]);
    expect(gauges).toEqual([['mdm_change_pending_gauge', 5]]);
  });

  it('applies the baseline of the platform to every tenant and keeps going when one fails', async () => {
    const applied: string[] = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      masterBaseline: {
        apply: async (ctx) => {
          applied.push(ctx.tenantId);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'master-baseline-sync')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(applied).toEqual([TENANT_A, TENANT_B]);
  });

  it('closes and locks the periods of every tenant and keeps going when one fails (dis-period-autoclose, ST-DIS-001)', async () => {
    const visited: string[] = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      disPeriods: {
        autoclose: async (ctx) => {
          visited.push(ctx.tenantId);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'dis-period-autoclose')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([TENANT_A, TENANT_B]);
  });

  it('runs the subscription cycle of every tenant at the time of the clock and keeps going when one fails (subscription-cycle, ST-SAS-008)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      subscriptionCycle: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'subscription-cycle')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
  });

  it('lets the requests to carry capital over lapse in every tenant at the time of the clock and keeps going when one fails (allocation-extension-lapse, ST-CAP-007)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      extensionLapse: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
          return { lapsed: 1 };
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'allocation-extension-lapse')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
  });

  it('locks again the fiscal years of every tenant whose reopening has ended at the time of the clock and keeps going when one fails (fiscal-year-relock, ST-CAP-008)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      fiscalYearRelock: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
          return { years: [2025] };
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'fiscal-year-relock')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
  });

  it('lets the overrides of every tenant run out at the time of the clock and keeps going when one fails (entitlement-override-expiry, ST-SAS-009)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      overrideExpiry: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'entitlement-override-expiry')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
  });

  it('moves the licenses of every tenant along their windows at the time of the clock and keeps going when one fails (license-status, AC-ST-SAS-003-1)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      licenseStatus: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'license-status')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
  });

  it('sweeps the virtual keys of every tenant at the time of the clock and keeps going when one fails (llm-key-sweep, ST-LLM-002)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      llmKeySweep: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'llm-key-sweep')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
  });

  it('puts the lapsed reservations of every tenant in PENDING_RECONCILE at the time of the clock and keeps going when one fails (llm-reservation-expiry, ST-LLM-003)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      llmReservationExpiry: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'llm-reservation-expiry')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
  });

  it('expires the lapsed invitations of every tenant at the time of the clock and keeps going when one fails (membership-invitation-expiry, ST-ADM-006)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      invitationExpiry: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'membership-invitation-expiry')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
  });

  it('marks the overdue incoming letters of every tenant at the time of the clock and keeps going when one fails (incoming-overdue, ST-DOC-011)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      incomingOverdue: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'incoming-overdue')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
    expect(JOB_INTERVAL_SECONDS['incoming-overdue']).toBe(3600);
  });

  it('takes the late stages of every tenant into LATE at the time of the clock and keeps going when one fails (land-stage-late, ST-LND-010)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-10-25T06:00:00Z'),
      stageLate: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'land-stage-late')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-10-25T06:00:00.000Z'],
      [TENANT_B, '2026-10-25T06:00:00.000Z'],
    ]);
  });

  it('reminds the settlements whose verification deadline is near in every tenant in the 06:00 hour of Vietnam time only, and keeps going when one tenant fails (settlement-deadline, ST-PAY-009)', async () => {
    const visited: Array<[string, string]> = [];
    let now = new Date('2026-07-10T22:59:00Z');
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => now,
      settlementDeadline: {
        run: async (ctx, at) => {
          visited.push([ctx.tenantId, at.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    const job = handlers.find((handler) => handler.name === 'settlement-deadline');
    // 05:59 in Vietnam: not the hour of the morning.
    await job?.run();
    expect(visited).toEqual([]);
    now = new Date('2026-07-10T23:00:00Z');
    await expect(job?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-07-10T23:00:00.000Z'],
      [TENANT_B, '2026-07-10T23:00:00.000Z'],
    ]);
    expect(JOB_INTERVAL_SECONDS['settlement-deadline']).toBe(3600);
  });

  it('looks at the advances that are owed in every tenant in the 06:00 hour of Vietnam time only, and keeps going when one tenant fails (advance-overdue, ST-PAY-011)', async () => {
    const visited: Array<[string, string]> = [];
    const gauges: Array<[string, number]> = [];
    let now = new Date('2026-07-10T22:59:00Z');
    let failing = true;
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => now,
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) },
      advanceOverdue: {
        run: async (ctx, at) => {
          visited.push([ctx.tenantId, at.toISOString()]);
          if (failing && ctx.tenantId === TENANT_A) throw new Error('boom');
          return { overdue: ctx.tenantId === TENANT_A ? 2 : 3 };
        },
      },
    });
    const job = handlers.find((handler) => handler.name === 'advance-overdue');
    // 05:59 in Vietnam: not the hour of the morning.
    await job?.run();
    expect(visited).toEqual([]);
    now = new Date('2026-07-10T23:00:00Z');
    await expect(job?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-07-10T23:00:00.000Z'],
      [TENANT_B, '2026-07-10T23:00:00.000Z'],
    ]);
    // The tenant that could be read still counts, and the gauge is one figure for all of them.
    expect(gauges).toEqual([['pay_advance_overdue', 3]]);
    failing = false;
    await job?.run();
    expect(gauges.at(-1)).toEqual(['pay_advance_overdue', 5]);
    expect(JOB_INTERVAL_SECONDS['advance-overdue']).toBe(3600);
  });

  it('reminds in every tenant every 15 minutes and keeps going when one tenant fails (work-reminder, G2-4)', async () => {
    const visited: Array<[string, string]> = [];
    let failing = true;
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-07-10T03:00:00Z'),
      workReminder: {
        run: async (ctx, at) => {
          visited.push([ctx.tenantId, at.toISOString()]);
          if (failing && ctx.tenantId === TENANT_A) throw new Error('boom');
          return { reminders: 1, reclaimNotices: 0, failed: 0 };
        },
      },
    });
    const job = handlers.find((handler) => handler.name === 'work-reminder');
    await expect(job?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-07-10T03:00:00.000Z'],
      [TENANT_B, '2026-07-10T03:00:00.000Z'],
    ]);
    failing = false;
    await job?.run();
    expect(visited).toHaveLength(4);
    expect(JOB_INTERVAL_SECONDS['work-reminder']).toBe(900);
  });

  it('compares the balances of capital with their ledger in every tenant in the 02:00 hour of Vietnam time only, and keeps going when one tenant fails (capital-balance-reconcile, ST-CAP-006)', async () => {
    const visited: Array<[string, string]> = [];
    let now = new Date('2026-07-11T18:59:00Z');
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => now,
      capitalBalanceReconcile: {
        run: async (ctx, at) => {
          visited.push([ctx.tenantId, at.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    const job = handlers.find((handler) => handler.name === 'capital-balance-reconcile');
    // 01:59 in Vietnam: not the hour of the night.
    await job?.run();
    expect(visited).toEqual([]);
    now = new Date('2026-07-11T19:00:00Z');
    await expect(job?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-07-11T19:00:00.000Z'],
      [TENANT_B, '2026-07-11T19:00:00.000Z'],
    ]);
    expect(JOB_INTERVAL_SECONDS['capital-balance-reconcile']).toBe(3600);
  });

  it('compares the recovered amounts of AUD with their ledgers in every tenant in the 02:00 hour of Vietnam time only, and keeps going when one tenant fails (aud-recovery-reconcile, ST-AUD-004)', async () => {
    const visited: Array<[string, string]> = [];
    let now = new Date('2026-07-11T18:59:00Z');
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => now,
      audRecoveryReconcile: {
        run: async (ctx, at) => {
          visited.push([ctx.tenantId, at.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    const job = handlers.find((handler) => handler.name === 'aud-recovery-reconcile');
    // 01:59 in Vietnam: not the hour of the night.
    await job?.run();
    expect(visited).toEqual([]);
    now = new Date('2026-07-11T19:00:00Z');
    await expect(job?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-07-11T19:00:00.000Z'],
      [TENANT_B, '2026-07-11T19:00:00.000Z'],
    ]);
    expect(JOB_INTERVAL_SECONDS['aud-recovery-reconcile']).toBe(3600);
  });

  it('reports the items of difference past their day in every tenant at the time of the clock and keeps going when one fails (reconciliation-overdue, ST-PAY-007)', async () => {
    const visited: Array<[string, string]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => new Date('2026-07-11T06:00:00Z'),
      reconciliationOverdue: {
        run: async (ctx, now) => {
          visited.push([ctx.tenantId, now.toISOString()]);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'reconciliation-overdue')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([
      [TENANT_A, '2026-07-11T06:00:00.000Z'],
      [TENANT_B, '2026-07-11T06:00:00.000Z'],
    ]);
  });

  it('stores the end of the reopening windows of every tenant and keeps going when one fails (dis-reopen-expiry, ST-DIS-002)', async () => {
    const visited: string[] = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      disReopens: {
        expire: async (ctx) => {
          visited.push(ctx.tenantId);
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
        },
      },
    });
    await expect(handlers.find((handler) => handler.name === 'dis-reopen-expiry')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(visited).toEqual([TENANT_A, TENANT_B]);
  });

  it('keeps going when one tenant fails to activate, reports it, and still sets the gauge for the others', async () => {
    const gauges: number[] = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      masterData: {
        activateDue: async (ctx) => {
          if (ctx.tenantId === TENANT_A) throw new Error('boom');
          return { changed: 0, pendingReviews: 4 };
        },
      },
      metrics: { increment: () => undefined, gauge: (_name, value) => void gauges.push(value) },
    });
    await expect(handlers.find((handler) => handler.name === 'master-activation')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(gauges).toEqual([4]);
  });

  it('unit-reorganization: sums the reorganisations that stopped on a step of every tenant into the gauge, whatever tenant fails (ST-ADM-015)', async () => {
    const gauges: Array<[string, number]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B, PLATFORM_TENANT_ID],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      unitReorganization: {
        run: async (ctx) => {
          if (ctx.tenantId === TENANT_B) throw new Error('boom');
          return { stopped: 2 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) },
    });
    await expect(handlers.find((handler) => handler.name === 'unit-reorganization')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(gauges).toEqual([['unit_reorganization_failed_total', 4]]);
  });

  it('tenant-export: tells the backlog before the pass drains it and again after it, and a tenant whose pass fails keeps the exports that wait for it (ST-SAS-016)', async () => {
    const gauges: Array<[string, number]> = [];
    const waiting = new Map([[TENANT_A, 2], [TENANT_B, 3]]);
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      tenantExport: {
        pending: async (ctx) => waiting.get(ctx.tenantId) ?? 0,
        run: async (ctx) => {
          if (ctx.tenantId === TENANT_B) throw new Error('boom');
          waiting.set(ctx.tenantId, 0);
          return { expired: [], pending: 0 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) },
    });
    await expect(handlers.find((handler) => handler.name === 'tenant-export')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    // 5 waited when the pass began; tenant A was drained, tenant B failed and still has its 3.
    expect(gauges).toEqual([['tenant_export_pending', 5], ['tenant_export_pending', 3]]);
  });

  it('tenant-domain: sums the domains that are Failed of every tenant into the gauge, whatever tenant fails (ST-SAS-017)', async () => {
    const gauges: Array<[string, number]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B, PLATFORM_TENANT_ID],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      tenantDomain: {
        run: async (ctx) => {
          if (ctx.tenantId === TENANT_B) throw new Error('boom');
          return { activated: [], failed: [], renewed: [], failing: 2 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) },
    });
    await expect(handlers.find((handler) => handler.name === 'tenant-domain')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(gauges).toEqual([['tenant_domain_failed_total', 4]]);
  });

  it('placement-migration: sums the copies that differ and the workers that fail of every tenant into the gauges, names the tenant that needs a person, whatever tenant fails (ST-SAS-018)', async () => {
    const gauges: Array<[string, number, Record<string, string> | undefined]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B, PLATFORM_TENANT_ID],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      placementMigration: {
        run: async (ctx) => {
          if (ctx.tenantId === TENANT_B) throw new Error('boom');
          return ctx.tenantId === TENANT_A ? { open: 1, mismatch: 1, failing: 2 } : { open: 0, mismatch: 0, failing: 0 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value, labels) => void gauges.push([name, value, labels]) },
    });
    await expect(handlers.find((handler) => handler.name === 'placement-migration')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(gauges).toEqual([
      ['placement_migration_attention', 3, { tenant_id: TENANT_A }],
      ['placement_migration_mismatch_total', 1, undefined],
      ['placement_migration_failing_total', 2, undefined],
    ]);
  });

  it('tenant-restore: sums the restores that wait and the ones that failed of every tenant into the gauges, whatever tenant fails (ST-SAS-019)', async () => {
    const gauges: Array<[string, number]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B, PLATFORM_TENANT_ID],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      tenantRestore: {
        run: async (ctx) => {
          if (ctx.tenantId === TENANT_B) throw new Error('boom');
          return { pending: 2, failed: 1 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) },
    });
    await expect(handlers.find((handler) => handler.name === 'tenant-restore')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(gauges).toEqual([
      ['tenant_restore_pending', 4],
      ['tenant_restore_failed_24h', 2],
    ]);
  });

  it('einvoice-billing: sums the invoices that could not be issued of every tenant into the gauge, whatever tenant fails (ST-SAS-011)', async () => {
    const gauges: Array<[string, number]> = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B, PLATFORM_TENANT_ID],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      einvoiceBilling: {
        run: async (ctx) => {
          if (ctx.tenantId === TENANT_B) throw new Error('boom');
          return { failed: 3 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) },
    });
    await expect(handlers.find((handler) => handler.name === 'einvoice-billing')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(gauges).toEqual([['einvoice_issue_failed_invoices', 6]]);
  });

  it('payment-reconciliation: makes one pass for the platform, not one for each tenant, and gives the payments that wait to the gauge (ST-SAS-012)', async () => {
    const gauges: Array<[string, number]> = [];
    let passes = 0;
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B, PLATFORM_TENANT_ID],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      paymentReconciliation: {
        run: async () => {
          passes += 1;
          return { waiting: 5 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) },
    });
    await handlers.find((handler) => handler.name === 'payment-reconciliation')?.run();
    expect(passes).toBe(1);
    expect(gauges).toEqual([['payment_unmatched_total', 5]]);
  });

  it('approval-sla: sums the open and overdue approval tasks of every tenant into the gauges, whatever tenant fails (ST-ADM-013)', async () => {
    const gauges: Array<[string, number]> = [];
    const clock = new Date('2026-08-12T07:00:00Z');
    const seen: Date[] = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B, PLATFORM_TENANT_ID],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => clock,
      approvalSla: {
        run: async (ctx, now) => {
          seen.push(now);
          if (ctx.tenantId === TENANT_B) throw new Error('boom');
          return { reminded: 1, overdueReminded: 0, breached: 1, escalated: 0, escalationFailed: 0, expired: 0, instancesExpired: 0, open: 5, overdue: 2 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) },
    });
    await expect(handlers.find((handler) => handler.name === 'approval-sla')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(seen).toEqual([clock, clock, clock]);
    expect(gauges).toEqual([
      ['approval_task_open_total', 10],
      ['approval_task_overdue_total', 4],
    ]);
  });

  it('issue-sla: sums the open issues and the waiting escalations of every tenant into the gauges, whatever tenant fails (ST-ISS-004)', async () => {
    const gauges: Array<[string, number, Record<string, string> | undefined]> = [];
    const clock = new Date('2026-08-12T07:00:00Z');
    const seen: Date[] = [];
    const handlers = standardJobs({
      tenantIds: async () => [TENANT_A, TENANT_B, PLATFORM_TENANT_ID],
      seal: new AuditSealJob(harness.tenantDatabase),
      idempotency: new IdempotencyStore(harness.tenantDatabase),
      clock: () => clock,
      issueSla: {
        run: async (ctx, now) => {
          seen.push(now);
          if (ctx.tenantId === TENANT_B) throw new Error('boom');
          return { overdueMarked: 1, escalated: { 2: 1, 3: 0 }, withoutTaskForce: 0, withoutCalendar: 0, open: { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 0 }, pending: 2 };
        },
      },
      metrics: { increment: () => undefined, gauge: (name, value, labels) => void gauges.push([name, value, labels]) },
    });
    await expect(handlers.find((handler) => handler.name === 'issue-sla')?.run()).rejects.toMatchObject({ name: 'TenantJobsFailed', failed: 1 });
    expect(seen).toEqual([clock, clock, clock]);
    expect(gauges).toEqual([
      ['iss_open_total', 2, { severity: 'LOW' }],
      ['iss_open_total', 4, { severity: 'MEDIUM' }],
      ['iss_open_total', 6, { severity: 'HIGH' }],
      ['iss_open_total', 0, { severity: 'CRITICAL' }],
      ['iss_escalation_pending', 4, undefined],
    ]);
  });

  it('serves the relay and the access cache only when the process has them, in schedule order', async () => {
    const deps = { tenantIds: async () => [], seal: new AuditSealJob(harness.tenantDatabase), idempotency: new IdempotencyStore(harness.tenantDatabase) };
    expect(standardJobs(deps).map((handler) => handler.name)).toEqual(['audit-seal', 'audit-verify', 'idempotency-purge']);
    let relayed = 0;
    let expired = 0;
    const all = standardJobs({
      ...deps,
      relay: { runOnce: async () => void (relayed += 1) },
      certificates: { expireDue: async () => 0 },
      masterData: { activateDue: async () => ({ changed: 0, pendingReviews: 0 }) },
      masterBaseline: { apply: async () => undefined },
      disPeriods: { autoclose: async () => undefined },
      disReopens: { expire: async () => undefined },
      retention: { run: async () => ({ pending: 0 }) },
      guaranteeExpiry: { run: async () => ({ expiring: {}, advanceAtRisk: 0 }) },
      retentionDue: { run: async () => ({ reminded: 0 }) },
      revisionEffective: { run: async () => ({ overdue: 0 }) }, petitionDue: { run: async () => ({ overdue: 0 }) },
      permitExpiry: { run: async () => ({ expiring: {} }) },
      gateWaiverExpiry: { run: async () => ({ active: 0 }) },
      issueSla: { run: async () => ({ overdueMarked: 0, escalated: { 2: 0, 3: 0 }, withoutTaskForce: 0, withoutCalendar: 0, open: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }, pending: 0 }) },
      unitReorganization: { run: async () => ({ stopped: 0 }) },
      admMigration: { run: async () => ({}) },
      llmKnowledgeReindex: { run: async () => ({}) },
      einvoiceBilling: { run: async () => ({ failed: 0 }) },
      paymentReconciliation: { run: async () => ({ waiting: 0 }) },
      delegationLifecycle: { run: async () => ({ activated: 0, expired: 0, sourceEnded: 0, reviewLapsed: 0, reviewReminded: 0, active: 0 }) },
      supportAccessLifecycle: { run: async () => ({ activated: [], expired: [], lapsed: [], active: 0 }) },
      tenantExport: { run: async () => ({ expired: [], pending: 0 }), pending: async () => 0 },
      tenantRestore: { run: async () => ({ pending: 0, failed: 0 }) },
      tenantDomain: { run: async () => ({ activated: [], failed: [], renewed: [], failing: 0 }) },
      placementMigration: { run: async () => ({ open: 0, mismatch: 0, failing: 0 }) },
      approvalSla: { run: async () => ({ reminded: 0, overdueReminded: 0, breached: 0, escalated: 0, escalationFailed: 0, expired: 0, instancesExpired: 0, open: 0, overdue: 0 }) },
      inbox: { processDue: async () => undefined },
      notificationDelivery: { dispatchDue: async () => undefined, reconcile: async () => undefined },
      campaignProgress: { run: async () => undefined },
      dgvQuality: { run: async () => ({ notAssessed: 0 }) },
      subscriptionCycle: { run: async () => undefined },
      overrideExpiry: { run: async () => undefined },
      licenseStatus: { run: async () => undefined },
      invitationExpiry: { run: async () => undefined },
      extensionLapse: { run: async () => ({ lapsed: 0 }) },
      fiscalYearRelock: { run: async () => ({ years: [] }) },
      stageLate: { run: async () => ({ late: 0 }) },
      explanationOverdue: { run: async () => ({ overdue: 0 }) },
      packageExpiry: { run: async () => ({ expired: 0 }) },
      transferApply: { run: async () => ({ applied: 0 }) },
      incomingOverdue: { run: async () => ({ marked: 0 }) },
      handoverDue: { run: async () => ({ sent: 0 }) },
      docInteropSend: { run: async () => ({ sent: 0 }) },
      biExportRunner: { run: async () => [] },
      biExportExpiry: { run: async () => [] },
      biQueryJobs: { run: async () => 0 },
      biQueryAnswerExpiry: { run: async () => 0 },
      dgvIncidentSweep: { run: async () => ({ breached: 0, reopened: 0 }) },
      dgvProductExpiry: { run: async () => ({ expired: 0 }) },
      dgvMaturitySweep: { run: async () => ({ evidenceExpired: 0, milestonesMissed: 0 }) },
      reconciliationOverdue: { run: async () => ({ reported: 0 }) },
      treasuryDailyRecon: { run: async () => ({ written: 0 }) },
      capitalBalanceReconcile: { run: async () => ({ drift: [] }) },
      capitalReservationExpiry: { run: async () => ({ expired: 0 }) },
      astEvaluationDue: { run: async () => ({ fired: 0 }) },
      astClaimOverdue: { run: async () => ({ flagged: 0 }) },
      settlementDeadline: { run: async () => ({ overdue: 0 }) },
      advanceOverdue: { run: async () => ({ overdue: 0 }) },
      workReminder: { run: async () => ({ reminders: 0, reclaimNotices: 0, failed: 0 }) },
      alertObserve: { run: async () => ({ closed: 0, reopened: 0, incomplete: false }) },
      alertLadder: { run: async () => ({ sent: 0, escalated: 0, failed: 0 }) },
      redFlagScan: { run: async () => ({ flagged: 0 }) },
      earlyWarningScore: { run: async () => ({ written: 0 }) },
      riskRescore: { run: async () => ({ opened: 0, rescored: 0, cleared: 0 }) },
      diaryCoverage: { run: async () => ({ contracts: 0, missing: 0 }) },
      audRecoveryReconcile: { run: async () => ({ mismatches: [] }) },
      llmKeySweep: { run: async () => ({ revoked: 0, failed: 0 }) },
      llmReservationExpiry: { run: async () => ({ expired: 0, oldestAgeSeconds: 0 }) },
      alertEscalation: { run: async () => ({ escalations: 0, failed: 0 }) },
      alertCoverage: { run: async () => ({ gaps: 0 }) },
      contractSettlementClock: { run: async () => ({ started: 0, met: 0, open: 0 }) },
      accessCache: { expire: () => (expired += 1) },
    });
    expect(all.map((handler) => handler.name)).toEqual(['audit-seal', 'audit-verify', 'outbox-relay', 'idempotency-purge', 'certificate-expiry', 'master-activation', 'master-baseline-sync', 'dis-period-autoclose', 'dis-reopen-expiry', 'retention-purge', 'guarantee-expiry', 'retention-due', 'revision-effective', 'petition-due', 'permit-expiry', 'gate-waiver-expiry', 'issue-sla', 'unit-reorganization', 'adm-migration', 'llm-knowledge-reindex', 'delegation-lifecycle', 'support-access-lifecycle', 'tenant-domain', 'placement-migration', 'tenant-export', 'tenant-restore', 'approval-sla', 'integration-inbox', 'notification-dispatch', 'notification-reconcile', 'notification-campaign-progress', 'dgv-quality-run', 'subscription-cycle', 'einvoice-billing', 'payment-reconciliation', 'allocation-extension-lapse', 'fiscal-year-relock', 'entitlement-override-expiry', 'license-status', 'membership-invitation-expiry', 'land-stage-late', 'prj-explanation-overdue', 'mne-package-expiry', 'prj-transfer-apply', 'incoming-overdue', 'doc-handover-due', 'doc-interop-send', 'bi-export-schedule-runner', 'bi-export-expiry', 'bi-query-jobs', 'bi-query-answer-expiry', 'dgv-incident-sweep', 'dgv-product-cert-expiry', 'dgv-maturity-sweep', 'reconciliation-overdue', 'treasury-daily-recon', 'settlement-deadline', 'advance-overdue', 'work-reminder', 'alert-observe', 'alert-ladder', 'red-flag-scan', 'early-warning-score', 'diary-coverage', 'capital-balance-reconcile', 'capital-reservation-expiry', 'ast-evaluation-due', 'ast-claim-overdue', 'aud-recovery-reconcile', 'llm-key-sweep', 'llm-reservation-expiry', 'alert-escalation', 'alert-coverage', 'access-cache-expiry']);
    expect(all.map((handler) => handler.name)).toEqual(['audit-seal', 'audit-verify', 'outbox-relay', 'idempotency-purge', 'certificate-expiry', 'master-activation', 'master-baseline-sync', 'dis-period-autoclose', 'dis-reopen-expiry', 'retention-purge', 'guarantee-expiry', 'retention-due', 'revision-effective', 'petition-due', 'permit-expiry', 'gate-waiver-expiry', 'issue-sla', 'unit-reorganization', 'adm-migration', 'llm-knowledge-reindex', 'delegation-lifecycle', 'support-access-lifecycle', 'tenant-domain', 'placement-migration', 'tenant-export', 'tenant-restore', 'approval-sla', 'integration-inbox', 'notification-dispatch', 'notification-reconcile', 'notification-campaign-progress', 'dgv-quality-run', 'subscription-cycle', 'einvoice-billing', 'payment-reconciliation', 'allocation-extension-lapse', 'fiscal-year-relock', 'entitlement-override-expiry', 'license-status', 'membership-invitation-expiry', 'land-stage-late', 'prj-explanation-overdue', 'mne-package-expiry', 'prj-transfer-apply', 'incoming-overdue', 'doc-handover-due', 'doc-interop-send', 'bi-export-schedule-runner', 'bi-export-expiry', 'bi-query-jobs', 'bi-query-answer-expiry', 'dgv-incident-sweep', 'dgv-product-cert-expiry', 'dgv-maturity-sweep', 'reconciliation-overdue', 'treasury-daily-recon', 'settlement-deadline', 'advance-overdue', 'work-reminder', 'early-warning-score', 'diary-coverage', 'capital-balance-reconcile', 'capital-reservation-expiry', 'ast-evaluation-due', 'ast-claim-overdue', 'aud-recovery-reconcile', 'llm-key-sweep', 'llm-reservation-expiry', 'contract-settlement-clock', 'access-cache-expiry']);
    expect(all.map((handler) => handler.name)).toEqual(['audit-seal', 'audit-verify', 'outbox-relay', 'idempotency-purge', 'certificate-expiry', 'master-activation', 'master-baseline-sync', 'dis-period-autoclose', 'dis-reopen-expiry', 'retention-purge', 'guarantee-expiry', 'retention-due', 'revision-effective', 'petition-due', 'permit-expiry', 'gate-waiver-expiry', 'issue-sla', 'unit-reorganization', 'adm-migration', 'llm-knowledge-reindex', 'delegation-lifecycle', 'support-access-lifecycle', 'tenant-domain', 'placement-migration', 'tenant-export', 'tenant-restore', 'approval-sla', 'integration-inbox', 'notification-dispatch', 'notification-reconcile', 'notification-campaign-progress', 'dgv-quality-run', 'subscription-cycle', 'einvoice-billing', 'payment-reconciliation', 'allocation-extension-lapse', 'fiscal-year-relock', 'entitlement-override-expiry', 'license-status', 'membership-invitation-expiry', 'land-stage-late', 'prj-explanation-overdue', 'mne-package-expiry', 'prj-transfer-apply', 'incoming-overdue', 'doc-handover-due', 'doc-interop-send', 'bi-export-schedule-runner', 'bi-export-expiry', 'bi-query-jobs', 'bi-query-answer-expiry', 'dgv-incident-sweep', 'dgv-product-cert-expiry', 'dgv-maturity-sweep', 'reconciliation-overdue', 'treasury-daily-recon', 'settlement-deadline', 'advance-overdue', 'work-reminder', 'early-warning-score', 'risk-rescore', 'diary-coverage', 'capital-balance-reconcile', 'capital-reservation-expiry', 'ast-evaluation-due', 'ast-claim-overdue', 'aud-recovery-reconcile', 'llm-key-sweep', 'llm-reservation-expiry', 'access-cache-expiry']);
    expect(all.map((handler) => handler.name)).toEqual(Object.keys(JOB_INTERVAL_SECONDS));
    for (const handler of all.filter((candidate) => ['outbox-relay', 'access-cache-expiry'].includes(candidate.name))) await handler.run();
    expect({ relayed, expired }).toEqual({ relayed: 1, expired: 1 });
    expect(DATABASE_JOBS.every((name) => name in JOB_INTERVAL_SECONDS)).toBe(true);
  });

  it('lists the registered tenants and the platform tenant', async () => {
    const control = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 2 });
    const admin = new PgClient({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      const placement = '00000000-0000-4000-8000-0000000000b1';
      await admin.query("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'c-1', 'k-1', 'Active')", [placement]);
      await admin.query("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, 'JOBS_A', 'Jobs A', 'Active', $2, 'vn-north'), ($3, 'JOBS_B', 'Jobs B', 'Requested', $2, 'vn-north')", [
        TENANT_A,
        placement,
        TENANT_B,
      ]);
      expect(await registeredTenantIds(new ControlDatabase(control))).toEqual([TENANT_A, TENANT_B, PLATFORM_TENANT_ID]);
      await admin.query('delete from machvon.tenant where id in ($1, $2)', [TENANT_A, TENANT_B]);
      await admin.query('delete from machvon.placement where id = $1', [placement]);
    } finally {
      await admin.end();
      await control.end();
    }
  });

  describe('command line', () => {
    const env = (): Record<string, string> => ({
      DATABASE_URL_APP: harness.database.urlFor('machvon_app'),
      DATABASE_URL_CONTROL: harness.database.urlFor('machvon_control'),
    });

    it('runs one job once and exits 0', async () => {
      await appendEntries(harness, PLATFORM_TENANT_ID, 3);
      const io = capture();
      expect(await main(['audit-seal'], env(), io)).toBe(0);
      expect(io.lines).toEqual(['audit-seal: SUCCESS']);
      expect(await sealCount(PLATFORM_TENANT_ID)).toBe(1);
    });

    it('exits non-zero on a broken audit chain and prints the alert as one line of JSON', async () => {
      const { seqs } = await appendEntries(harness, PLATFORM_TENANT_ID, 3);
      expect(await main(['audit-seal'], env(), capture())).toBe(0);
      const session = await ownerSession(harness, PLATFORM_TENANT_ID);
      try {
        await session.query("update machvon.audit_event set action = 'tampered' where seq = $1", [seqs[1]]);
      } finally {
        await session.end();
      }
      const io = capture();
      expect(await main(['audit-verify'], env(), io)).toBe(1);
      expect(io.lines.map((line) => (line.startsWith('{') ? (JSON.parse(line) as { alert: string }).alert : line))).toEqual(['AUDIT_CHAIN_BROKEN', JOB_FAILED_ALERT, 'audit-verify: FAILED']);
    });

    it('exits 0 and says so when another runner holds the job', async () => {
      const holder = new PgClient({ connectionString: harness.database.urlFor('machvon_app') });
      await holder.connect();
      try {
        await holder.query("select pg_advisory_lock(hashtextextended('job:idempotency-purge', 0))");
        const io = capture();
        expect(await main(['idempotency-purge'], env(), io)).toBe(0);
        expect(io.lines).toEqual(['idempotency-purge: SKIPPED']);
      } finally {
        await holder.end();
      }
    });

    it('prints the usage and exits 2 for a missing, unknown or process-bound job and for missing configuration', async () => {
      const io = capture();
      expect(await main([], env(), io)).toBe(2);
      expect(await main(['bogus'], env(), io)).toBe(2);
      expect(await main(['outbox-relay'], env(), io)).toBe(2);
      expect(await main(['audit-seal', 'audit-verify'], env(), io)).toBe(2);
      // An option the CLI does not have is a usage error too, not an uncaught exception.
      expect(await main(['--help'], env(), io)).toBe(2);
      expect(await main(['-x', 'audit-seal'], env(), io)).toBe(2);
      expect(await main(['audit-seal', '--bogus=1'], env(), io)).toBe(2);
      expect(io.lines.every((line) => line.startsWith('Usage: jobs-cli.ts <audit-seal|audit-verify|idempotency-purge>'))).toBe(true);
      const configuration = capture();
      expect(await main(['audit-seal'], {}, configuration)).toBe(2);
      expect(await main(['audit-seal'], { DATABASE_URL_APP: 'x', DATABASE_URL_CONTROL: '' }, configuration)).toBe(2);
      expect(configuration.lines[0]).toContain('DATABASE_URL_APP');
    });
  });
});
