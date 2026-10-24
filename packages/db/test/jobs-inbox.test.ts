import { JOB_INTERVAL_SECONDS, TenantJobsFailed, standardJobs } from '../src/jobs';
import type { StandardJobDeps } from '../src/jobs';

function deps(overrides: Partial<StandardJobDeps>): StandardJobDeps {
  return {
    tenantIds: () => Promise.resolve(['t1', 't2', 't3']),
    seal: { seal: () => Promise.reject(new Error('not used')), verify: () => Promise.reject(new Error('not used')) },
    idempotency: { purgeExpired: () => Promise.resolve(0) },
    ...overrides,
  };
}

const handlerOf = (options: Partial<StandardJobDeps>) => standardJobs(deps(options)).find((candidate) => candidate.name === 'integration-inbox');

describe('the integration inbox job of the scheduler (ST-ADM-018)', () => {
  it('runs every minute, for every tenant, as the worker, and is not scheduled by a process with no inbox', async () => {
    expect(JOB_INTERVAL_SECONDS['integration-inbox']).toBe(60);
    expect(handlerOf({})).toBeUndefined();
    const contexts: Array<{ tenantId: string; membershipId: string; scopeVersion: number }> = [];
    await handlerOf({ inbox: { processDue: (ctx) => (contexts.push(ctx), Promise.resolve({ processed: 1 })) } })?.run();
    expect(contexts.map((ctx) => ctx.tenantId)).toEqual(['t1', 't2', 't3']);
    expect(contexts.every((ctx) => ctx.membershipId === '00000000-0000-4000-8000-000000000000' && ctx.scopeVersion === 0)).toBe(true);
  });

  it('visits every tenant when one fails, then fails naming the error class only', async () => {
    const visited: string[] = [];
    const failure = await handlerOf({
      inbox: {
        processDue: (ctx) => {
          visited.push(ctx.tenantId);
          return ctx.tenantId === 't1' ? Promise.reject(new RangeError('boom with a secret')) : Promise.resolve({});
        },
      },
    })
      ?.run()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(visited).toEqual(['t1', 't2', 't3']);
    expect(failure).toBeInstanceOf(TenantJobsFailed);
    expect((failure as TenantJobsFailed).errorClasses).toEqual(['RangeError']);
    expect((failure as Error).message).not.toContain('secret');
  });
});
