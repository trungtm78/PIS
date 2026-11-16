import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { GovernanceRuleReadsController, GovernanceRulesController } from '../../src/modules/adm/governance-rule.controller';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

/**
 * R75 over HTTP (docs PWF 22.2, 22.8): `createGovernanceRuleDraft` stores a workflow template with the stamps of its verified legal grounds as the server gives them, and its answer tells what was stamped and what was put back
 * to unverified. A rule of another type is answered as before.
 */

const SIGNING_KEY = randomBytes(32);
const AUTHOR = 1;
const SECOND = 2;
const day = (offset: number): string => new Date(Date.now() + 7 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);

type Ground = Record<string, unknown>;
const ground = (extra: Ground = {}): Ground => ({ document: 'ND_15_2021', article: 'Điều 5', verification: 'VERIFIED', ...extra });
const template = (grounds: Ground[]): Record<string, unknown> => ({
  name: 'Stamp flow over HTTP',
  phases: [{ code: 'PREP', name: 'Phase one', gates: [] }],
  tasks: [{ code: 'TASK_A', name: 'Task A', phase: 'PREP', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'WORKER_ROLE', priority: 'NORMAL', predecessors: [], legal_basis: grounds }],
});

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the stamps of a workflow template over HTTP (R75)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  async function call(method: 'GET' | 'POST', url: string, member: number, body?: unknown, key?: string): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const draft = (member: number, code: string, params: unknown, key?: string, type = 'PROJECT_WORKFLOW_TEMPLATE'): Promise<Reply> =>
    call('POST', '/governance-rules', member, { rule_type: type, code, params, effective_from: day(0), reason: 'A draft for the tests' }, key);
  const groundsOf = async (id: string): Promise<Ground[]> => {
    const rows = await harness.owner<{ params: { tasks: Array<{ legal_basis: Ground[] }> } }>(TENANT_A, [['select params from machvon.governance_rule where id = $1::uuid', [id]]]);
    return rows[0]?.params.tasks[0]?.legal_basis ?? [];
  };

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [AUTHOR, SECOND]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 11, 'GOV_MANAGER', ['adm.governance.manage', 'adm.governance.read'], 60);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUTHOR, role: 11, kind: 'TENANT' },
      { n: 2, member: SECOND, role: 11, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [GovernanceRulesController, GovernanceRuleReadsController],
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

  it('stamps what the caller verifies, resets a stamp that is sent, tells both in the answer, and keeps the stamp on the next save', async () => {
    const key = `key-${randomUUID()}`;
    const params = template([ground(), ground({ article: 'Điều 6', verified_by: memberId(SECOND), verified_at: '2020-01-01T00:00:00.000Z' })]);
    const first = await draft(AUTHOR, 'STAMP_HTTP', params, key);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ status: 'DRAFT', resource_version: 1, legal_verification: { stamped: 1, reset: 1 } });
    const stored = await groundsOf(first.json.resource_id as string);
    expect(stored[0]).toEqual(ground({ verified_by: memberId(AUTHOR), verified_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) }));
    expect(stored[1]).toEqual(ground({ article: 'Điều 6', verification: 'UNVERIFIED' }));

    // The same request again with the same key is the first answer, the report included, and no second version.
    const again = await draft(AUTHOR, 'STAMP_HTTP', params, key);
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);

    // The read of the rule shows the stamped params; the next save, by a colleague who sends them back, keeps the stamp of the first person.
    const listed = await call('GET', '/governance-rules?rule_type=PROJECT_WORKFLOW_TEMPLATE&code=STAMP_HTTP', AUTHOR);
    expect(listed.status).toBe(200);
    const shown = (listed.json.items as Array<{ params: unknown }>)[0]?.params;
    const second = await draft(SECOND, 'STAMP_HTTP', shown);
    expect(second.status).toBe(201);
    expect(second.json).toMatchObject({ legal_verification: { stamped: 0, reset: 0 } });
    expect(await groundsOf(second.json.resource_id as string)).toEqual(stored);

    // Under another code the same params carry stamps that belong to STAMP_HTTP: back to unverified.
    const cloned = await draft(SECOND, 'STAMP_HTTP_COPY', shown);
    expect(cloned.json).toMatchObject({ legal_verification: { stamped: 0, reset: 1 } });
    expect((await groundsOf(cloned.json.resource_id as string)).map((one) => one.verification)).toEqual(['UNVERIFIED', 'UNVERIFIED']);
  });

  it('answers a draft of another rule type as before, with no report', async () => {
    const reply = await draft(AUTHOR, 'DEFAULT', { every_working_hours: { URGENT: 2, ACTION: 8, WATCH: 40 }, max_per_item: { URGENT: 40, ACTION: 20, WATCH: 8 } }, undefined, 'REMINDER_POLICY');
    expect(reply.status).toBe(201);
    expect(Object.keys(reply.json).sort()).toEqual(['operation_id', 'resource_id', 'resource_version', 'status']);
  });
});
