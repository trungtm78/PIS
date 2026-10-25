import { JOB_INTERVAL_SECONDS, REVISION_OVERDUE_GAUGE, TenantJobsFailed, standardJobs } from '../src/jobs';
import type { StandardJobDeps } from '../src/jobs';

const NOON = new Date('2026-10-31T05:00:00.000Z');

function deps(overrides: Partial<StandardJobDeps>): StandardJobDeps {
  return {
    tenantIds: () => Promise.resolve(['t1', 't2', 't3']),
    seal: { seal: () => Promise.reject(new Error('not used')), verify: () => Promise.reject(new Error('not used')) },
    idempotency: { purgeExpired: () => Promise.resolve(0) },
    ...overrides,
  };
}

const handlerOf = (options: Partial<StandardJobDeps>) => {
  const handler = standardJobs(deps(options)).find((candidate) => candidate.name === 'revision-effective');
  if (handler === undefined) throw new Error('no revision job');
  return handler;
};

describe('the revision job of the scheduler (ST-CTR-007)', () => {
  it('ticks hourly and works at every hour, once for every tenant, as the worker: a night that was missed is made good by the next tick', async () => {
    expect(JOB_INTERVAL_SECONDS['revision-effective']).toBe(3600);
    const calls: Array<{ tenantId: string; membershipId: string; scopeVersion: number; now: Date }> = [];
    for (const clock of [new Date('2026-10-31T17:05:00.000Z'), NOON]) {
      await handlerOf({ clock: () => clock, revisionEffective: { run: (ctx, now) => (calls.push({ ...ctx, now }), Promise.resolve({ overdue: 0 })) } }).run();
    }
    expect(calls.map((call) => call.tenantId)).toEqual(['t1', 't2', 't3', 't1', 't2', 't3']);
    expect(calls.every((call) => call.membershipId === '00000000-0000-4000-8000-000000000000' && call.scopeVersion === 0)).toBe(true);
    expect(calls[3]?.now.getTime()).toBe(NOON.getTime());
  });

  it('is not scheduled by a process that cannot run it', () => {
    expect(standardJobs(deps({})).map((handler) => handler.name)).not.toContain('revision-effective');
  });

  it('sets the gauge to the sum over the tenants: the pending revisions more than a day late', async () => {
    const gauges: Array<{ name: string; value: number }> = [];
    await handlerOf({
      clock: () => NOON,
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push({ name, value }) },
      revisionEffective: { run: (ctx) => Promise.resolve({ overdue: ctx.tenantId === 't2' ? 2 : 1 }) },
    }).run();
    expect(gauges).toEqual([{ name: REVISION_OVERDUE_GAUGE, value: 4 }]);
  });

  it('visits every tenant when one fails, still sets the gauge for the others and then fails naming the class only', async () => {
    const gauges: number[] = [];
    const visited: string[] = [];
    const failure = await handlerOf({
      clock: () => NOON,
      metrics: { increment: () => undefined, gauge: (_name, value) => void gauges.push(value) },
      revisionEffective: {
        run: (ctx) => {
          visited.push(ctx.tenantId);
          return ctx.tenantId === 't2' ? Promise.reject(new TypeError('boom with a secret')) : Promise.resolve({ overdue: 1 });
        },
      },
    })
      .run()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(visited).toEqual(['t1', 't2', 't3']);
    expect(gauges).toEqual([2]);
    expect(failure).toBeInstanceOf(TenantJobsFailed);
    expect((failure as TenantJobsFailed).errorClasses).toEqual(['TypeError']);
    expect((failure as Error).message).not.toContain('secret');
  });

  it('uses the system clock when none is given', async () => {
    let called = 0;
    await handlerOf({ revisionEffective: { run: () => (called += 1, Promise.resolve({ overdue: 0 })) } }).run();
    expect(called).toBe(3);
  });
});
