import { GATE_WAIVER_ACTIVE_GAUGE, GATE_WAIVER_EXPIRY_HOUR, JOB_INTERVAL_SECONDS, TenantJobsFailed, standardJobs, vietnamHourOf } from '../src/jobs';
import type { StandardJobDeps } from '../src/jobs';

// 17:00 UTC is 00:00 the next day in Vietnam.
const AT_MIDNIGHT = new Date('2026-10-31T17:00:00.000Z');
const AT_ELEVEN = new Date('2026-10-31T16:00:00.000Z');
const AT_ONE = new Date('2026-10-31T18:00:00.000Z');

function deps(overrides: Partial<StandardJobDeps>): StandardJobDeps {
  return {
    tenantIds: () => Promise.resolve(['t1', 't2', 't3']),
    seal: { seal: () => Promise.reject(new Error('not used')), verify: () => Promise.reject(new Error('not used')) },
    idempotency: { purgeExpired: () => Promise.resolve(0) },
    ...overrides,
  };
}

const handlerOf = (options: Partial<StandardJobDeps>) => {
  const handler = standardJobs(deps(options)).find((candidate) => candidate.name === 'gate-waiver-expiry');
  if (handler === undefined) throw new Error('no waiver job');
  return handler;
};

describe('the gate waiver job of the scheduler (ST-PMT-005)', () => {
  it('ticks hourly and works in the 00:00 hour of Vietnam time only, once for every tenant, as the worker', async () => {
    expect(JOB_INTERVAL_SECONDS['gate-waiver-expiry']).toBe(3600);
    expect(GATE_WAIVER_EXPIRY_HOUR).toBe(0);
    expect([AT_ELEVEN, AT_MIDNIGHT, AT_ONE].map(vietnamHourOf)).toEqual([23, 0, 1]);
    const calls: Array<{ tenantId: string; membershipId: string; scopeVersion: number; now: Date }> = [];
    for (const clock of [AT_ELEVEN, AT_MIDNIGHT, AT_ONE]) {
      await handlerOf({
        clock: () => clock,
        gateWaiverExpiry: { run: (ctx, now) => (calls.push({ ...ctx, now }), Promise.resolve({ active: 0 })) },
      }).run();
    }
    expect(calls.map((call) => call.tenantId)).toEqual(['t1', 't2', 't3']);
    expect(calls.every((call) => call.now.getTime() === AT_MIDNIGHT.getTime() && call.membershipId === '00000000-0000-4000-8000-000000000000' && call.scopeVersion === 0)).toBe(true);
  });

  it('is not scheduled by a process that cannot run it', () => {
    expect(standardJobs(deps({})).map((handler) => handler.name)).not.toContain('gate-waiver-expiry');
  });

  it('sets the gauge to the sum over the tenants: the waivers in force', async () => {
    const gauges: Array<{ name: string; value: number }> = [];
    await handlerOf({
      clock: () => AT_MIDNIGHT,
      metrics: { increment: () => undefined, gauge: (name, value) => void gauges.push({ name, value }) },
      gateWaiverExpiry: { run: () => Promise.resolve({ active: 4 }) },
    }).run();
    expect(gauges).toEqual([{ name: GATE_WAIVER_ACTIVE_GAUGE, value: 12 }]);
  });

  it('visits every tenant when one fails, still sets the gauge for the others and then fails naming the class only', async () => {
    const gauges: number[] = [];
    const visited: string[] = [];
    const failure = await handlerOf({
      clock: () => AT_MIDNIGHT,
      metrics: { increment: () => undefined, gauge: (_name, value) => void gauges.push(value) },
      gateWaiverExpiry: {
        run: (ctx) => {
          visited.push(ctx.tenantId);
          return ctx.tenantId === 't2' ? Promise.reject(new TypeError('boom with a secret')) : Promise.resolve({ active: 3 });
        },
      },
    })
      .run()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(visited).toEqual(['t1', 't2', 't3']);
    expect(gauges).toEqual([6]);
    expect(failure).toBeInstanceOf(TenantJobsFailed);
    expect((failure as TenantJobsFailed).errorClasses).toEqual(['TypeError']);
    expect((failure as Error).message).not.toContain('secret');
  });

  it('uses the system clock when none is given, and does nothing outside its hour', async () => {
    let called = 0;
    await handlerOf({ gateWaiverExpiry: { run: () => (called += 1, Promise.resolve({ active: 0 })) } }).run();
    expect(called).toBe(vietnamHourOf(new Date()) === GATE_WAIVER_EXPIRY_HOUR ? 3 : 0);
  });
});
