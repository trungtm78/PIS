import { JOB_INTERVAL_SECONDS, RETENTION_HOUR, TenantJobsFailed, standardJobs, vietnamHourOf } from '../src/jobs';
import type { StandardJobDeps } from '../src/jobs';
import { RETENTION_PENDING_GAUGE } from '../src/retention-job';

// 18:00 UTC is 01:00 the next day in Vietnam.
const AT_ONE = new Date('2026-10-23T18:00:00.000Z');
const AT_TWO = new Date('2026-10-23T19:00:00.000Z');
const AT_MIDNIGHT = new Date('2026-10-23T17:00:00.000Z');

function deps(overrides: Partial<StandardJobDeps>): StandardJobDeps {
  return {
    tenantIds: () => Promise.resolve(['t1', 't2', 't3']),
    seal: { seal: () => Promise.reject(new Error('not used')), verify: () => Promise.reject(new Error('not used')) },
    idempotency: { purgeExpired: () => Promise.resolve(0) },
    ...overrides,
  };
}

const handlerOf = (options: Partial<StandardJobDeps>) => {
  const handler = standardJobs(deps(options)).find((candidate) => candidate.name === 'retention-purge');
  if (handler === undefined) throw new Error('no retention job');
  return handler;
};

describe('the retention job of the scheduler (ST-ADM-017)', () => {
  it('runs hourly and works in the 01:00 hour of Vietnam time only', async () => {
    expect(JOB_INTERVAL_SECONDS['retention-purge']).toBe(3600);
    expect(RETENTION_HOUR).toBe(1);
    expect([AT_MIDNIGHT, AT_ONE, AT_TWO].map(vietnamHourOf)).toEqual([0, 1, 2]);
    expect(vietnamHourOf(new Date('2026-10-23T05:30:00.000Z'))).toBe(12);
    const calls: Array<{ tenantId: string; now: Date }> = [];
    for (const clock of [AT_MIDNIGHT, AT_ONE, AT_TWO]) {
      const handler = handlerOf({
        clock: () => clock,
        retention: { run: (ctx, now) => (calls.push({ tenantId: ctx.tenantId, now }), Promise.resolve({ pending: 0 })) },
      });
      await handler.run();
    }
    expect(calls.map((call) => call.tenantId)).toEqual(['t1', 't2', 't3']);
    expect(calls.every((call) => call.now.getTime() === AT_ONE.getTime())).toBe(true);
  });

  it('is not scheduled by a process that cannot run it', () => {
    expect(standardJobs(deps({})).map((handler) => handler.name)).not.toContain('retention-purge');
  });

  it('sets the gauge of the items that wait for review to the sum over the tenants, as the job of the worker context', async () => {
    const gauges: Array<{ name: string; value: number }> = [];
    const contexts: Array<{ tenantId: string; membershipId: string; scopeVersion: number }> = [];
    const handler = handlerOf({
      clock: () => AT_ONE,
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push({ name, value }) },
      retention: { run: (ctx) => (contexts.push(ctx), Promise.resolve({ pending: contexts.length })) },
    });
    await handler.run();
    expect(gauges).toEqual([{ name: RETENTION_PENDING_GAUGE, value: 6 }]);
    expect(contexts.every((ctx) => ctx.membershipId === '00000000-0000-4000-8000-000000000000' && ctx.scopeVersion === 0)).toBe(true);
  });

  it('visits every tenant when one fails, still sets the gauge for the others and then fails naming the class only', async () => {
    const gauges: number[] = [];
    const visited: string[] = [];
    const handler = handlerOf({
      clock: () => AT_ONE,
      metrics: { increment: () => undefined, gauge: (_name, value) => void gauges.push(value) },
      retention: {
        run: (ctx) => {
          visited.push(ctx.tenantId);
          return ctx.tenantId === 't2' ? Promise.reject(new TypeError('boom with a secret')) : Promise.resolve({ pending: 5 });
        },
      },
    });
    const failure = await handler.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(visited).toEqual(['t1', 't2', 't3']);
    expect(gauges).toEqual([10]);
    expect(failure).toBeInstanceOf(TenantJobsFailed);
    expect((failure as TenantJobsFailed).errorClasses).toEqual(['TypeError']);
    expect((failure as Error).message).not.toContain('secret');
  });

  it('uses the system clock when none is given, and does nothing outside its hour', async () => {
    let called = 0;
    const handler = handlerOf({ retention: { run: () => (called += 1, Promise.resolve({ pending: 0 })) } });
    await handler.run();
    expect(called).toBe(vietnamHourOf(new Date()) === RETENTION_HOUR ? 3 : 0);
  });
});
