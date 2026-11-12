import { randomBytes } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, SearchProjectionStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { SearchController } from '../src/modules/search/search.controller';
import { searchModule } from '../src/modules/search';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;

// Members of tenant A and B.
const WHOLE_TENANT = 1; // search.use on the whole tenant
const UNIT_2_READER = 2; // search.use on the subtree of unit 2
const NO_SEARCH = 3; // a member without search.use
const TENANT_B_USER = 11;

interface Reply {
  status: number;
  contentType: string | null;
  json: Record<string, unknown>;
}

describe('searchGlobal (ST-IAM-008, IAM-07)', () => {
  const harness = new AuthzHarness();
  const store = new SearchProjectionStore();
  let app: RunningApp;

  async function get(query: string, member: number, tenantId = TENANT_A): Promise<Reply> {
    const token = signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}/search${query}`, { headers: { [TENANT_HEADER]: token } });
    return { status: response.status, contentType: response.headers.get('content-type'), json: (await response.json()) as Record<string, unknown> };
  }

  const entityIds = (reply: Reply): string[] => (reply.json.items as Array<{ entity_id: string }>).map((item) => item.entity_id);

  async function project(tenantId: string, n: number, title: string, body: string, unit: number, unitPath: string, classification = 'INTERNAL'): Promise<void> {
    await harness.tenants.withTenant({ tenantId, membershipId: memberId(1), scopeVersion: 1 }, (tx) =>
      store.upsert(tx, tenantId, {
        entityType: 'project',
        entityId: id(0x80, n),
        title,
        body,
        classification: classification as 'INTERNAL',
        ownerUnitId: unitId(unit),
        ownerUnitPath: unitPath,
      }),
    );
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: path(1) },
      { n: 2, path: path(1, 2), parent: 1 },
      { n: 3, path: path(1, 3), parent: 1 },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 21, path: path(21) }]);
    for (const n of [WHOLE_TENANT, UNIT_2_READER, NO_SEARCH]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, TENANT_B_USER, 21);
    await harness.seedRole(TENANT_A, 1, 'SEARCHER', ['search.use'], 20);
    await harness.seedRole(TENANT_A, 2, 'NOT_A_SEARCHER', ['project.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'SEARCHER', ['search.use'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: WHOLE_TENANT, role: 1, kind: 'TENANT' },
      { n: 2, member: UNIT_2_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 3, member: NO_SEARCH, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: TENANT_B_USER, role: 1, kind: 'TENANT' }]);

    await project(TENANT_A, 1, 'Ring road package', 'ring road earthworks', 2, path(1, 2));
    await project(TENANT_A, 2, 'Ring road drainage', 'ring road ring road drainage', 3, path(1, 3));
    await project(TENANT_A, 3, 'Ring road bridge', 'ring road bridge deck', 2, path(1, 2), 'CONFIDENTIAL');
    await project(TENANT_B, 4, 'Beta secret airport', 'beta secret airport apron', 21, path(21));

    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [SearchController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is the module SEARCH with the searchGlobal operation', () => {
    expect(searchModule.code).toBe('SEARCH');
    expect(searchModule.controllers).toContain(SearchController);
    expect([...app.implementedOperations]).toEqual(['searchGlobal']);
  });

  it('answers a reader of the whole tenant with the matches of the tenant, best first, as snake_case DTOs without a total', async () => {
    const reply = await get('?q=ring%20road', WHOLE_TENANT);
    expect(reply.status).toBe(200);
    expect(reply.contentType).toContain('application/json');
    expect(Object.keys(reply.json).sort()).toEqual(['items', 'next_cursor']);
    expect(entityIds(reply)).toEqual([id(0x80, 2), id(0x80, 1), id(0x80, 3)]);
    expect(reply.json.items).toEqual([
      { entity_type: 'project', entity_id: id(0x80, 2), title: 'Ring road drainage', classification: 'INTERNAL', snippet: expect.stringContaining('ring road') },
      { entity_type: 'project', entity_id: id(0x80, 1), title: 'Ring road package', classification: 'INTERNAL', snippet: expect.stringContaining('ring road') },
      { entity_type: 'project', entity_id: id(0x80, 3), title: 'Ring road bridge', classification: 'CONFIDENTIAL', snippet: null },
    ]);
    expect(reply.json.next_cursor).toBeNull();
  });

  it('shows a reader of one unit subtree only the documents of that subtree', async () => {
    const reply = await get('?q=ring%20road', UNIT_2_READER);
    expect(reply.status).toBe(200);
    expect(entityIds(reply)).toEqual([id(0x80, 1), id(0x80, 3)]);
  });

  it('refuses a member without the search permission with 403 SCOPE_DENIED', async () => {
    const reply = await get('?q=ring%20road', NO_SEARCH);
    expect(reply.status).toBe(403);
    expect(reply.json.code).toBe('SCOPE_DENIED');
  });

  it('never shows the documents of another tenant: an empty page, not an error and not a count (UAT-AC100, UAT-NFR-TENANCY-04)', async () => {
    const own = await get('?q=beta%20secret', WHOLE_TENANT);
    expect(own.status).toBe(200);
    expect(own.json).toEqual({ items: [], next_cursor: null });
    const other = await get('?q=beta%20secret', TENANT_B_USER, TENANT_B);
    expect(entityIds(other)).toEqual([id(0x80, 4)]);
    expect(JSON.stringify(await get('?q=ring', TENANT_B_USER, TENANT_B))).not.toContain('Ring');
  });

  it('pages with an opaque cursor and walks every visible hit once', async () => {
    const first = await get('?q=ring%20road&limit=2', WHOLE_TENANT);
    expect(entityIds(first)).toEqual([id(0x80, 2), id(0x80, 1)]);
    expect(typeof first.json.next_cursor).toBe('string');
    const second = await get(`?q=ring%20road&limit=2&cursor=${String(first.json.next_cursor)}`, WHOLE_TENANT);
    expect(entityIds(second)).toEqual([id(0x80, 3)]);
    expect(second.json.next_cursor).toBeNull();
  });

  it('rejects a missing, short, long, repeated or non-text query with 422 VALIDATION_FAILED naming q', async () => {
    for (const query of ['', '?q=', '?q=a', `?q=${'x'.repeat(201)}`, '?q=ab&q=cd', '?q[]=ab', '?q=ab%00cd']) {
      const reply = await get(query, WHOLE_TENANT);
      expect({ query: query.slice(0, 20), status: reply.status, code: reply.json.code }).toEqual({ query: query.slice(0, 20), status: 422, code: 'VALIDATION_FAILED' });
    }
    expect((await get(`?q=${'x'.repeat(200)}`, WHOLE_TENANT)).status).toBe(200);
  });

  it('rejects a bad limit or cursor with 422 VALIDATION_FAILED', async () => {
    for (const query of ['?q=ring&limit=0', '?q=ring&limit=201', '?q=ring&limit=abc', '?q=ring&cursor=!!!', '?q=ring&cursor=eyJ4IjoxfQ']) {
      const reply = await get(query, WHOLE_TENANT);
      expect({ query, status: reply.status, code: reply.json.code }).toEqual({ query, status: 422, code: 'VALIDATION_FAILED' });
    }
  });
});
