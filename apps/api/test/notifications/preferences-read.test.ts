import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { MyPreferencesController } from '../../src/notifications/preferences/preferences.controller';
import { MyPreferencesReadController } from '../../src/notifications/preferences/preferences-read.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const ANNA = 1;
const BEN = 2;
const ACTOR = '00000000-0000-4000-8000-0000000000f0';

describe('getMyNotificationPreferences (ST-NOT-003, NOT-03)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const call = async (method: 'GET' | 'PUT', member: number, body?: unknown, ifMatch?: string): Promise<{ status: number; json: Record<string, unknown> }> => {
    const headers: Record<string, string> = { [TENANT_HEADER]: signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY), 'content-type': 'application/json' };
    if (method === 'PUT') headers['idempotency-key'] = `key-${randomUUID()}-${randomUUID()}`;
    if (ifMatch !== undefined) headers['if-match'] = ifMatch;
    const response = await fetch(`${app.baseUrl}/me/notification-preferences`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: JSON.parse(await response.text()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const member of [ANNA, BEN]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedRole(TENANT_A, 1, 'MEMBER', ['notification.self'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ANNA, role: 1, kind: 'TENANT' },
      { n: 2, member: BEN, role: 1, kind: 'TENANT' },
    ]);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
         values ($1, gen_random_uuid(), 'approval.requested', 1, '{"priority":"CRITICAL"}'::jsonb, 'Published', 'NOTIFICATION', 'approval.requested', $2, repeat('b', 64))`,
        [TENANT_A, ACTOR],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({
          database: tenants,
          access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()),
        }),
      ],
      controllers: [MyPreferencesController, MyPreferencesReadController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  it('answers the defaults, version 0 and the locked inbox of the categories that hold an urgent event, for a person who never saved', async () => {
    const reply = await call('GET', ANNA);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      version: 0,
      is_default: true,
      quiet_start: '21:00',
      quiet_end: '07:00',
      time_zone: 'Asia/Ho_Chi_Minh',
      items: [],
      locked: [{ event_category: 'approval', channel: 'IN_APP' }],
    });
  });

  it('answers what the person saved with the version a next save is made under, and nothing of another person', async () => {
    const saved = await call('PUT', ANNA, { items: [{ event_category: 'report', channel: 'SMS', enabled: false, digest_mode: 'DAILY' }], quiet_start: '22:00', quiet_end: '06:30', time_zone: 'Asia/Tokyo' }, '"0"');
    expect(saved.status).toBe(200);
    const reply = await call('GET', ANNA);
    expect(reply.json).toMatchObject({ version: 1, is_default: false, quiet_start: '22:00', quiet_end: '06:30', time_zone: 'Asia/Tokyo', items: [{ event_category: 'report', channel: 'SMS', enabled: false, digest_mode: 'DAILY' }] });
    expect((await call('GET', BEN)).json).toMatchObject({ version: 0, items: [] });
  });

  it('answers null hours for a person who turned the quiet hours off', async () => {
    await call('PUT', BEN, { items: [] }, '"0"');
    expect(await call('GET', BEN)).toMatchObject({ status: 200, json: { version: 1, quiet_start: null, quiet_end: null } });
  });
});
