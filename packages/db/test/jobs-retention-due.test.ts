import { JOB_INTERVAL_SECONDS, RETENTION_DUE_HOUR, TenantJobsFailed, standardJobs, vietnamHourOf } from '../src/jobs';
import type { StandardJobDeps } from '../src/jobs';

// 23:00 UTC is 06:00 the next day in Vietnam.
const AT_SIX = new Date('2026-10-31T23:00:00.000Z');
const AT_FIVE = new Date('2026-10-31T22:00:00.000Z');
const AT_SEVEN = new Date('2027-10-31T00:00:00.000Z');

function deps(overrides: Partial<StandardJobDeps>): StandardJobDeps {
  return {
    tenantIds: () => Promise.resolve(['t1', 't2', 't3']),
    seal: { seal: () => Promise.reject(new Error('not used')), verify: () => Promise.reject(new Error('not used')) },
    idempotency: { purgeExpired: () => Promise.resolve(0) },
    ...overrides,
  };
}

const handlerOf = (options: Partial<StandardJobDeps>) => {
  const handler = standardJobs(deps(options)).find((candidate) => candidate.name === 'retention-due');
  if (handler === undefined) throw new Error('no retention job');
  return handler;
};

describe('the retention job of the scheduler (ST-CTR-010)', () => {
  it('ticks hourly and works in the 06:00 hour of Vietnam time only, once for every tenant, as the worker', async () => {
    expect(JOB_INTERVAL_SECONDS['retention-due']).toBe(3600);
    expect(RETENTION_DUE_HOUR).toBe(6);
    const calls: Array<{ tenantId: string; membershipId: string; scopeVersion: number; now: Date }> = [];
    for (const clock of [AT_FIVE, AT_SIX, AT_SEVEN]) {
      await handlerOf({ clock: () => clock, retentionDue: { run: (ctx, now) => (calls.push({ ...ctx, now }), Promise.resolve({ reminded: 0 })) } }).run();
    }
    expect([AT_FIVE, AT_SIX, AT_SEVEN].map(vietnamHourOf)).toEqual([5, 6, 7]);
    expect(calls.map((call) => call.tenantId)).toEqual(['t1', 't2', 't3']);
    expect(calls.every((call) => call.now.getTime() === AT_SIX.getTime() && call.membershipId === '00000000-0000-4000-8000-000000000000' && call.scopeVersion === 0)).toBe(true);
  });

  it('is not scheduled by a process that cannot run it', () => {
    expect(standardJobs(deps({})).map((handler) => handler.name)).not.toContain('retention-due');
  });

  it('visits every tenant when one fails and then fails naming the class only', async () => {
    const visited: string[] = [];
    const failure = await handlerOf({
      clock: () => AT_SIX,
      retentionDue: { run: (ctx) => (visited.push(ctx.tenantId), ctx.tenantId === 't2' ? Promise.reject(new TypeError('boom with a secret')) : Promise.resolve({ reminded: 1 })) },
    })
      .run()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(visited).toEqual(['t1', 't2', 't3']);
    expect(failure).toBeInstanceOf(TenantJobsFailed);
    expect((failure as TenantJobsFailed).errorClasses).toEqual(['TypeError']);
    expect((failure as Error).message).not.toContain('secret');
  });

  it('uses the system clock when none is given, and does nothing outside its hour', async () => {
    let called = 0;
    await handlerOf({ retentionDue: { run: () => ((called += 1), Promise.resolve({ reminded: 0 })) } }).run();
    expect(called).toBe(vietnamHourOf(new Date()) === RETENTION_DUE_HOUR ? 3 : 0);
  });
});
