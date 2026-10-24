import { JOB_INTERVAL_SECONDS, PERMIT_EXPIRING_GAUGE, PERMIT_EXPIRY_HOUR, TenantJobsFailed, standardJobs, vietnamHourOf } from '../src/jobs';
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
  const handler = standardJobs(deps(options)).find((candidate) => candidate.name === 'permit-expiry');
  if (handler === undefined) throw new Error('no permit job');
  return handler;
};

describe('the permit job of the scheduler (ST-PMT-006)', () => {
  it('ticks hourly and works in the 06:00 hour of Vietnam time only, once for every tenant, as the worker', async () => {
    expect(JOB_INTERVAL_SECONDS['permit-expiry']).toBe(3600);
    expect(PERMIT_EXPIRY_HOUR).toBe(6);
    expect([AT_FIVE, AT_SIX, AT_SEVEN].map(vietnamHourOf)).toEqual([5, 6, 7]);
    const calls: Array<{ tenantId: string; membershipId: string; scopeVersion: number; now: Date }> = [];
    for (const clock of [AT_FIVE, AT_SIX, AT_SEVEN]) {
      await handlerOf({
        clock: () => clock,
        permitExpiry: { run: (ctx, now) => (calls.push({ ...ctx, now }), Promise.resolve({ expiring: {} })) },
      }).run();
    }
    expect(calls.map((call) => call.tenantId)).toEqual(['t1', 't2', 't3']);
    expect(calls.every((call) => call.now.getTime() === AT_SIX.getTime() && call.membershipId === '00000000-0000-4000-8000-000000000000' && call.scopeVersion === 0)).toBe(true);
  });

  it('is not scheduled by a process that cannot run it', () => {
    expect(standardJobs(deps({})).map((handler) => handler.name)).not.toContain('permit-expiry');
  });

  it('sets the gauges to the sums over the tenants: the permits within each threshold', async () => {
    const gauges: Array<{ name: string; value: number; labels?: Record<string, string> }> = [];
    await handlerOf({
      clock: () => AT_SIX,
      metrics: { increment: () => undefined, gauge: (name, value, labels) => void gauges.push({ name, value, ...(labels === undefined ? {} : { labels }) }) },
      permitExpiry: { run: () => Promise.resolve({ expiring: { 60: 4, 30: 3, 15: 2, 0: 1 } }) },
    }).run();
    expect(gauges).toEqual([
      { name: PERMIT_EXPIRING_GAUGE, value: 3, labels: { days: '0' } },
      { name: PERMIT_EXPIRING_GAUGE, value: 6, labels: { days: '15' } },
      { name: PERMIT_EXPIRING_GAUGE, value: 9, labels: { days: '30' } },
      { name: PERMIT_EXPIRING_GAUGE, value: 12, labels: { days: '60' } },
    ]);
  });

  it('visits every tenant when one fails, still sets the gauges for the others and then fails naming the class only', async () => {
    const gauges: number[] = [];
    const visited: string[] = [];
    const failure = await handlerOf({
      clock: () => AT_SIX,
      metrics: { increment: () => undefined, gauge: (_name, value) => void gauges.push(value) },
      permitExpiry: {
        run: (ctx) => {
          visited.push(ctx.tenantId);
          return ctx.tenantId === 't2' ? Promise.reject(new TypeError('boom with a secret')) : Promise.resolve({ expiring: { 30: 1 } });
        },
      },
    })
      .run()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(visited).toEqual(['t1', 't2', 't3']);
    expect(gauges).toEqual([0, 0, 2, 0]);
    expect(failure).toBeInstanceOf(TenantJobsFailed);
    expect((failure as TenantJobsFailed).errorClasses).toEqual(['TypeError']);
    expect((failure as Error).message).not.toContain('secret');
  });

  it('uses the system clock when none is given, and does nothing outside its hour', async () => {
    let called = 0;
    await handlerOf({ permitExpiry: { run: () => (called += 1, Promise.resolve({ expiring: {} })) } }).run();
    expect(called).toBe(vietnamHourOf(new Date()) === PERMIT_EXPIRY_HOUR ? 3 : 0);
  });
});
