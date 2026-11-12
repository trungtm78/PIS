import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { IssIssueController } from '../../src/modules/iss/iss-issue.controller';
import { IssIssueReadsController } from '../../src/modules/iss/iss-issue-reads.controller';
import { IssSlaPolicyController } from '../../src/modules/iss/iss-sla-policy.controller';
import { AuthzHarness, TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, callerOf, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

/**
 * UAT-PLAN-22 (FR-ISS-09): an issue is bound to the SLA policy that was in force when it was opened. A second policy for the same category, severity and unit is refused while the first stands, and retiring
 * the first leaves the issue under it with the deadline it was given.
 */
const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // issue.sla.manage on the whole tenant
const REPORTER = 2; // issue.create and issue.read in unit 1
const FAMILY = 0x7e;
const PROJECT = id(FAMILY, 1);
const DAY_MS = 86_400_000;
const TODAY = vietnamDateOf(new Date());
const inDays = (days: number): string => vietnamDateOf(new Date(Date.now() + days * DAY_MS));

describe('UAT-PLAN-22: the SLA policy of an issue after its policy is replaced and retired', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let category = '';
  const call = callerOf(() => app.baseUrl, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  const policyBody = (code: string, validFrom: string): Record<string, unknown> => ({ code, category_version_id: category, severity: 'HIGH', owner_unit_id: unitId(1), calendar_code: 'WORKDAY_VN', response_hours: 4, resolve_hours: 16, valid_from: validFrom });

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }]);
    const thisYear = new Date().getUTCFullYear();
    await harness.owner(
      TENANT_A,
      [thisYear - 1, thisYear, thisYear + 1].map((year, index): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
        [TENANT_A, id(0x75, 1 + index), year, memberId(1)],
      ]),
    );
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-PLAN-22', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, unitId(1), id(FAMILY, 20)],
      );
    } finally {
      await client.end();
    }
    const recordId = randomUUID();
    category = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', 'QUALITY', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
         values ($1, $2, $3, 'ISSUE_CATEGORY', 'QUALITY', 1, 'Quality', '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', $4, $4)`,
        [TENANT_A, category, recordId, memberId(1)],
      ],
      ['update machvon.master_record set current_version_id = $2 where id = $1', [recordId, category]],
    ]);
    for (const n of [MANAGER, REPORTER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'SLA_MANAGER', ['issue.sla.manage', 'issue.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'ISSUE_CREATOR', ['issue.create', 'issue.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: REPORTER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [IssSlaPolicyController, IssIssueController, IssIssueReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('goes red on a wrong answer (negative control)', () => {
    const wrong: Reply = { status: 200, json: {} };
    expectCheckFails(() => assertStatus(wrong, 409, 'SLA_POLICY_OVERLAP'));
  });

  it('UAT-PLAN-22: a second policy over the same days is 409 and writes nothing, the first retires 200, and the issue opened under it keeps its policy and its deadline', async () => {
    // SP-1 is published and issue I-1 is opened under it.
    const sp1 = await call('POST', '/issue-sla-policies', { member: MANAGER, body: policyBody('SLA-QUALITY-HIGH', TODAY) });
    assertStatus(sp1, 200);
    const sp1Id = sp1.json.resource_id as string;
    const opened = await call('POST', '/issues', {
      member: REPORTER,
      body: { project_id: PROJECT, category_version_id: category, severity: 'HIGH', title: 'Concrete of the pier below the strength asked', description: 'The cores of the pier P3 failed the test', owner_unit_id: unitId(1), client_operation_id: randomUUID() },
    });
    assertStatus(opened, 200);
    const issueId = opened.json.resource_id as string;
    const issueRow = () => rows<{ sla_policy_id: string; due_at: Date; response_due_at: Date }>('select sla_policy_id, due_at, response_due_at from machvon.issue where id = $1::uuid', [issueId]);
    const [before] = await issueRow();
    expect(before?.sla_policy_id).toBe(sp1Id);

    // Step 1: SP-2 for the same category, severity and unit, over the same days.
    const sp2 = await call('POST', '/issue-sla-policies', { member: MANAGER, body: policyBody('SLA-QUALITY-HIGH-2', inDays(5)) });
    assertStatus(sp2, 409, 'SLA_POLICY_OVERLAP');
    expect(await rows('select id from machvon.issue_sla_policy where code = $1', ['SLA-QUALITY-HIGH-2'])).toEqual([]);
    expect(await rows('select status from machvon.issue_sla_policy where id = $1::uuid', [sp1Id])).toEqual([{ status: 'ACTIVE' }]);

    // Step 2: SP-1 is retired.
    const retired = await call('POST', `/issue-sla-policies/${sp1Id}/retire`, { member: MANAGER, body: { valid_until: inDays(30) } });
    assertStatus(retired, 200);
    expect(retired.json).toMatchObject({ status: 'RETIRED', resource_id: sp1Id });
    expect(await rows('select status from machvon.issue_sla_policy where id = $1::uuid', [sp1Id])).toEqual([{ status: 'RETIRED' }]);

    // Step 3: I-1 is read: its policy and its deadlines are as they were.
    const [after] = await issueRow();
    expect(after?.sla_policy_id).toBe(sp1Id);
    expect(after?.due_at.getTime()).toBe(before?.due_at.getTime());
    expect(after?.response_due_at.getTime()).toBe(before?.response_due_at.getTime());
    const read = await call('GET', `/resources/issue/${issueId}`, { member: REPORTER });
    assertStatus(read, 200);
    expect(JSON.stringify(read.json)).toContain(sp1Id);
  });
});
