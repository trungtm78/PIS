import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, SearchProjectionStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry } from '@machvon/kernel';
import { ProblemFilter } from '../../src/problem.filter';
import { SearchController } from '../../src/modules/search/search.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProjectReadsController } from '../../src/modules/prj/project.controller';
import { PRJ_METRICS } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { asObjects } from '../support/json';
import { assertStatus, callerOf, expectCheckFails } from '../uat/uat-kit';

/**
 * UAT-PLAN-41 (FR-MOB-51, the API half of MOB-51): a user with the scope of unit U-BQL1 searches "cầu" and gets the record of U-BQL1 only; the record of U-BQL2 that matches as well is not found by its id (404 RESOURCE_NOT_FOUND), and neither the
 * answer nor the log of the server carries a field of it. The screen of the phone that shows these answers is tested on the device (apps/mobile/test/features/phone_search/search_test.dart).
 */
const SIGNING_KEY = randomBytes(32);
const USER = 1; // search.use and project.read on the subtree of U-BQL1
const ROOT = 1;
const U_BQL1 = 2;
const U_BQL2 = 3;
const FAMILY = 0x7d;
const R1 = id(FAMILY, 1);
const R2 = id(FAMILY, 2);
const R2_TITLE = 'Cầu Thủ Thiêm Bốn';
const R2_CODE = 'DA-UAT-R2-BQL2';
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;

describe('UAT-PLAN-41: the search of a user with a scope', () => {
  const harness = new AuthzHarness();
  const store = new SearchProjectionStore();
  let app: RunningApp;
  const call = callerOf(() => app.baseUrl, SIGNING_KEY);
  const logged: string[] = [];
  const restore: Array<() => void> = [];
  let area = '';

  /** The area the projects are in: a master version in force, as the register of projects reads it. */
  async function seedArea(): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-P', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(USER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, 'AREA', 'TINH-P', 1, 'TINH-P', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
        [TENANT_A, versionId, recordId, memberId(USER)],
      ],
    ]);
    return versionId;
  }

  async function project(recordId: string, code: string, title: string, unit: number): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 5000000000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, recordId, code, title, unitId(unit), area],
      );
    } finally {
      await client.end();
    }
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(USER), scopeVersion: 1 }, (tx) =>
      store.upsert(tx, TENANT_A, { entityType: 'project', entityId: recordId, title, body: `Gói thầu xây lắp ${title}`, classification: 'INTERNAL', ownerUnitId: unitId(unit), ownerUnitPath: path(ROOT, unit) }),
    );
  }

  beforeAll(async () => {
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      restore.push(() => {
        stream.write = original;
      });
    }
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: path(ROOT) },
      { n: U_BQL1, path: path(ROOT, U_BQL1), parent: ROOT },
      { n: U_BQL2, path: path(ROOT, U_BQL2), parent: ROOT },
    ]);
    await harness.seedMembership(TENANT_A, USER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'FIELD_OFFICER', ['search.use', 'project.read'], 20);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: USER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(U_BQL1)] }]);
    area = await seedArea();
    await project(R1, 'DA-UAT-R1-BQL1', 'Cầu Bình An', U_BQL1);
    await project(R2, R2_CODE, R2_TITLE, U_BQL2);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [SearchController, ProjectReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: PRJ_METRICS, useValue: { increment: () => undefined, gauge: () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    for (const undo of restore) undo();
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('goes red on a wrong answer (negative control)', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 404, 'RESOURCE_NOT_FOUND'));
  });

  it('UAT-PLAN-41: the list holds R-1 only, R-2 opened by its id is 404 RESOURCE_NOT_FOUND, and neither the answers nor the log carry a field of R-2', async () => {
    const mark = logged.length;
    // Step 1: the search.
    const found = await call('GET', `/search?q=${encodeURIComponent('cầu')}&limit=50`, { member: USER });
    assertStatus(found, 200);
    const items = asObjects(found.json.items);
    expect(items.map((item) => item.entity_id)).toEqual([R1]);
    expect(found.json).not.toHaveProperty('total');
    expect(JSON.stringify(found.json)).not.toContain(R2);
    expect(JSON.stringify(found.json)).not.toContain(R2_TITLE);

    // Step 2: R-2 by its id.
    const opened = await call('GET', `/resources/project/${R2}`, { member: USER });
    assertStatus(opened, 404, 'RESOURCE_NOT_FOUND');
    for (const field of [R2_TITLE, R2_CODE, 'Thiêm', 'BQL2']) expect(JSON.stringify(opened.json)).not.toContain(field);
    // R-1 opens as it should.
    assertStatus(await call('GET', `/resources/project/${R1}`, { member: USER }), 200);

    const lines = logged.slice(mark).join('');
    for (const field of [R2_TITLE, R2_CODE, 'Thiêm']) expect(lines).not.toContain(field);
  });
});
