import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { LeaderReadsController } from '../../src/editions/enterprise/leader.controller';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * The leadership rates of the enterprise edition before any snapshot is frozen (ENT-4d): a tenant with no frozen snapshot gets an ANSWER (200, `snapshot: null` and the reason), not a 404 that the browser and the
 * installed app write to their console as a failed request. A snapshot that was named and is not there is still a 404. The name of this file ends in `.enterprise.test.ts`: it may name the enterprise controller.
 */
jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const READER = 1; // home.read over the tenant
const NOBODY = 2;
const ROOT = 1;

describe('GET /leader/rates without a frozen snapshot', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const get = async (member: number, query = ''): Promise<{ status: number; json: Record<string, unknown> }> => {
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}/leader/rates${query}`, { headers: { [TENANT_HEADER]: token } });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: READER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [LeaderReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('answers 200 with snapshot null and the reason when no snapshot is frozen', async () => {
    const reply = await get(READER);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ snapshot: null, reason: 'NO_FROZEN_SNAPSHOT' });
    expect(typeof reply.json.as_of).toBe('string');
    expect(reply.json.company).toBeUndefined();
  });

  it('still refuses a snapshot that was named and is not there, and a person without the read right', async () => {
    expect((await get(READER, `?snapshot_id=${randomUUID()}`)).status).toBe(404);
    expect((await get(READER, '?snapshot_id=not-a-uuid')).status).toBe(422);
    expect((await get(NOBODY)).status).toBe(403);
  });
});
