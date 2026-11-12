import { Client, Pool } from 'pg';
import { JOB_FAILED_ALERT, JobRunner } from '../src/job-runner';
import { recorder, startAuditHarness } from './support/audit-fixtures';
import type { AuditHarness } from './support/audit-fixtures';

/** A job that runs until the test lets it end, and tells when it has started. */
function gatedJob(name: string): { handler: { name: string; run(): Promise<void> }; started: Promise<void>; release(): void; runs(): number } {
  let release: () => void = () => undefined;
  let signalStarted: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let runs = 0;
  return {
    handler: {
      name,
      run: async () => {
        runs += 1;
        signalStarted();
        await gate;
      },
    },
    started,
    release,
    runs: () => runs,
  };
}

describe('JobRunner', () => {
  let harness: AuditHarness;
  const pools: Pool[] = [];

  const newPool = (): Pool => {
    const pool = new Pool({ connectionString: harness.database.urlFor('machvon_app'), max: 2 });
    pool.on('error', () => undefined); // a backend the test ends on purpose is reported by the pool as an error event
    pools.push(pool);
    return pool;
  };

  const lockHolders = async (): Promise<number[]> => {
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ pid: number }>(
        `select l.pid from pg_locks l join pg_stat_activity a on a.pid = l.pid
          where l.locktype = 'advisory' and l.granted and a.datname = current_database() and l.pid <> pg_backend_pid()`,
      );
      return rows.map((row) => row.pid);
    } finally {
      await admin.end();
    }
  };

  const terminate = async (pid: number): Promise<void> => {
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('select pg_terminate_backend($1)', [pid]);
    } finally {
      await admin.end();
    }
  };

  beforeAll(async () => {
    harness = await startAuditHarness();
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (harness) await harness.stop();
  }, 60_000);

  it('lets exactly one of two racing runners run the job and skips the other', async () => {
    const seen = recorder();
    const first = new JobRunner(newPool(), seen.sinks);
    const second = new JobRunner(newPool(), seen.sinks);
    const job = gatedJob('race');
    first.register(job.handler);
    second.register(job.handler);

    const running = first.runOnce('race');
    await job.started;
    const skipped = await second.runOnce('race');
    expect(skipped.outcome).toBe('SKIPPED');
    expect(job.runs()).toBe(1);

    job.release();
    expect((await running).outcome).toBe('SUCCESS');
    // The lock is free again: the second runner takes the next run.
    expect((await second.runOnce('race')).outcome).toBe('SUCCESS');
    expect(job.runs()).toBe(2);
    expect(seen.alerts).toEqual([]);
    expect(seen.metrics.map((metric) => metric.labels)).toEqual([
      { job: 'race', outcome: 'SKIPPED' },
      { job: 'race', outcome: 'SUCCESS' },
      { job: 'race', outcome: 'SUCCESS' },
    ]);
  });

  it('frees the lock when the runner dies, fails the dead run once, and lets the other runner take over', async () => {
    const seen = recorder();
    const doomed = new JobRunner(newPool(), seen.sinks);
    const survivor = new JobRunner(newPool(), seen.sinks);
    const job = gatedJob('crash');
    doomed.register(job.handler);
    survivor.register({ name: 'crash', run: async () => undefined });

    const running = doomed.runOnce('crash');
    await job.started;
    const [pid] = await lockHolders();
    expect(pid).toBeDefined();
    await terminate(pid as number);

    // The dead session's lock disappears with it; the survivor runs as soon as the server has noticed.
    let taken = (await survivor.runOnce('crash')).outcome;
    for (let attempt = 0; taken === 'SKIPPED' && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      taken = (await survivor.runOnce('crash')).outcome;
    }
    expect(taken).toBe('SUCCESS');

    job.release();
    expect((await running).outcome).toBe('FAILED');
    expect(seen.alerts).toEqual([{ code: JOB_FAILED_ALERT, context: { job: 'crash', errorClass: 'JobLockLost' } }]);
  }, 60_000);

  it('records a failing run, raises one alert with the error class only, and runs again next time', async () => {
    const seen = recorder();
    const runner = new JobRunner(newPool(), seen.sinks);
    let calls = 0;
    runner.register({
      name: 'flaky',
      run: async () => {
        calls += 1;
        if (calls === 1) throw new RangeError('secret detail that must not leave the process');
      },
    });
    const failed = await runner.runOnce('flaky');
    expect(failed.outcome).toBe('FAILED');
    expect(seen.alerts).toEqual([{ code: JOB_FAILED_ALERT, context: { job: 'flaky', errorClass: 'RangeError' } }]);
    expect((await runner.runOnce('flaky')).outcome).toBe('SUCCESS');
    expect(seen.alerts).toHaveLength(1);
  });

  it('treats a job that throws a non-error as a failure', async () => {
    const seen = recorder();
    const runner = new JobRunner(newPool(), seen.sinks);
    runner.register({
      name: 'odd',
      run: () => Promise.reject(undefined),
    });
    expect((await runner.runOnce('odd')).outcome).toBe('FAILED');
    expect(seen.alerts).toEqual([{ code: JOB_FAILED_ALERT, context: { job: 'odd', errorClass: 'Error' } }]);
  });

  it('fails the run with an alert when the database cannot be reached', async () => {
    const seen = recorder();
    const unreachable = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', max: 1, connectionTimeoutMillis: 2000 });
    unreachable.on('error', () => undefined); // a backend the test ends on purpose is reported by the pool as an error event
    pools.push(unreachable);
    const runner = new JobRunner(unreachable, seen.sinks);
    runner.register({ name: 'offline', run: async () => undefined });
    expect((await runner.runOnce('offline')).outcome).toBe('FAILED');
    expect(seen.alerts).toHaveLength(1);
    expect(seen.alerts[0]?.code).toBe(JOB_FAILED_ALERT);
  });

  it('records started and ended times from the injected clock, keeps a bounded history and reports names', async () => {
    let tick = 0;
    const runner = new JobRunner(newPool(), { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, (tick += 1))), historyLimit: 2 });
    runner.register({ name: 'a', run: async () => undefined });
    runner.register({ name: 'b', run: async () => undefined });
    expect(runner.names()).toEqual(['a', 'b']);
    const record = await runner.runOnce('a');
    expect(record).toEqual({ name: 'a', startedAt: new Date('2026-01-01T00:00:01Z'), endedAt: new Date('2026-01-01T00:00:02Z'), outcome: 'SUCCESS' });
    await runner.runOnce('b');
    await runner.runOnce('b');
    expect(runner.history().map((entry) => entry.name)).toEqual(['b', 'b']);
    expect(runner.history('a')).toEqual([]);
    expect(runner.history('b')).toHaveLength(2);
  });

  it('refuses an unknown job, a duplicate registration and a bad history limit', async () => {
    const runner = new JobRunner(newPool());
    runner.register({ name: 'job', run: async () => undefined });
    await expect(runner.runOnce('missing')).rejects.toThrow('unknown job missing');
    expect(() => runner.register({ name: 'job', run: async () => undefined })).toThrow('registered twice');
    expect(() => new JobRunner(newPool(), { historyLimit: 0 })).toThrow(RangeError);
  });

  it('hands the scheduler a definition whose run goes through the lock and never rejects for a failed job', async () => {
    const seen = recorder();
    const runner = new JobRunner(newPool(), seen.sinks);
    runner.register({
      name: 'scheduled',
      run: async () => {
        throw new Error('boom');
      },
    });
    const definition = runner.scheduled('scheduled', 300);
    expect(definition.name).toBe('scheduled');
    expect(definition.intervalSeconds).toBe(300);
    await expect(definition.run()).resolves.toBeUndefined();
    expect(runner.history('scheduled').map((entry) => entry.outcome)).toEqual(['FAILED']);
  });
});
