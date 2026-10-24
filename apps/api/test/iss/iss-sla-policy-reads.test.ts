import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { IssSlaPolicyController } from '../../src/modules/iss/iss-sla-policy.controller';
import { IssSlaPolicyReadsController } from '../../src/modules/iss/iss-sla-policy-reads.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // issue.sla.manage and issue.read
const READER = 2; // issue.read
const NOBODY = 3;
const OTHER_TENANT_READER = 1; // of tenant B
const DAY_MS = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);

describe('listIssueSlaPolicies (ST-ISS-001, ISS-09)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function category(tenant = TENANT_A): Promise<{ recordId: string; versionId: string }> {
    counter += 1;
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
         values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $3, 'EFFECTIVE', $4, $4)`,
        [tenant, recordId, `CAT-${counter}-${recordId.slice(0, 6)}`, memberId(1)],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
         values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, 'Category', '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', $5, $5)`,
        [tenant, versionId, recordId, `CAT-${counter}`, memberId(1)],
      ],
      ['update machvon.master_record set current_version_id = $2 where id = $1', [recordId, versionId]],
    ]);
    return { recordId, versionId };
  }

  const publish = (versionId: string, extra: Record<string, unknown>): Promise<Reply> =>
    call('POST', '/issue-sla-policies', {
      member: MANAGER,
      body: { code: `SLA-${randomUUID().slice(0, 8)}`, category_version_id: versionId, severity: 'HIGH', calendar_code: 'WORKDAY_VN', response_hours: 4, resolve_hours: 16, valid_from: inDays(2), ...extra },
    });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      const thisYear = new Date().getUTCFullYear();
      await harness.owner(
        tenant,
        [thisYear, thisYear + 1].map((year, index): [string, unknown[]] => [
          `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
           values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
          [tenant, id(0x72, (tenant === TENANT_A ? 1 : 3) + index), year, memberId(1)],
        ]),
      );
    }
    for (const n of [MANAGER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_READER, 1);
    await harness.seedRole(TENANT_A, 1, 'SLA_MANAGER', ['issue.sla.manage', 'issue.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'ISSUE_READER', ['issue.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'ISSUE_READER', ['issue.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_READER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [IssSlaPolicyController, IssSlaPolicyReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('lists the versions of a category with their category and dates, newest first, in pages, to those who may read issues (AC-ST-ISS-001-2)', async () => {
    const { recordId, versionId } = await category();
    const first = await publish(versionId, { code: 'SLA-LIST', resolve_hours: 72, valid_from: inDays(1) });
    const second = await publish(versionId, { code: 'SLA-LIST', resolve_hours: 48, valid_from: inDays(10) });
    await publish(versionId, { code: 'SLA-LOW', severity: 'LOW' });
    const all = await call('GET', `/issue-sla-policies?category_record_id=${recordId}`, { member: READER });
    expect(all.status).toBe(200);
    const items = all.json.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.code)).toEqual(['SLA-LOW', 'SLA-LIST', 'SLA-LIST']);
    expect(items[1]).toMatchObject({ id: second.json.resource_id, revision: 2, resolve_hours: 48, status: 'ACTIVE', valid_until: null, category_record_id: recordId, category_version_id: versionId, severity: 'HIGH', owner_unit_id: null });
    expect(items[2]).toMatchObject({ id: first.json.resource_id, revision: 1, resolve_hours: 72, status: 'RETIRED', valid_until: inDays(10) });
    expect(String(items[1]?.category_key)).toMatch(/^CAT-/);
    const history = await call('GET', `/issue-sla-policies?category_record_id=${recordId}&code=SLA-LIST`, { member: READER });
    expect((history.json.items as unknown[]).length).toBe(2);
    const retired = await call('GET', `/issue-sla-policies?category_record_id=${recordId}&status=RETIRED&severity=HIGH`, { member: READER });
    expect((retired.json.items as Array<Record<string, unknown>>).map((item) => item.revision)).toEqual([1]);
    const page = await call('GET', `/issue-sla-policies?category_record_id=${recordId}&limit=2`, { member: READER });
    expect((page.json.items as unknown[]).length).toBe(2);
    const next = await call('GET', `/issue-sla-policies?category_record_id=${recordId}&limit=2&cursor=${page.json.next_cursor as string}`, { member: READER });
    expect((next.json.items as Array<Record<string, unknown>>).map((item) => item.revision)).toEqual([1]);
    expect(next.json.next_cursor).toBeNull();
    expect(((await call('GET', `/issue-sla-policies?category_record_id=${recordId}`, { member: OTHER_TENANT_READER, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
  });

  it('filters by the unit of a policy', async () => {
    const { recordId, versionId } = await category();
    await publish(versionId, { code: 'SLA-DEFAULT-UNIT' });
    await publish(versionId, { code: 'SLA-OWN-UNIT', owner_unit_id: unitId(1) });
    const own = await call('GET', `/issue-sla-policies?category_record_id=${recordId}&owner_unit_id=${unitId(1)}`, { member: READER });
    expect((own.json.items as Array<Record<string, unknown>>).map((item) => item.code)).toEqual(['SLA-OWN-UNIT']);
  });

  it('refuses a filter that is not well formed and a caller without issue.read', async () => {
    for (const query of ['status=GONE', 'severity=URGENT', 'category_record_id=nope', 'owner_unit_id=nope', 'code=', 'limit=0', 'cursor=nope']) {
      expect((await call('GET', `/issue-sla-policies?${query}`, { member: READER })).status).toBe(422);
    }
    expect((await call('GET', '/issue-sla-policies', { member: NOBODY })).status).toBe(403);
  });
});
