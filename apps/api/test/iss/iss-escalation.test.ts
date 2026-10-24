import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, IssSlaJob, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { IssEscalationController } from '../../src/modules/iss/iss-escalation.controller';
import { IssEscalationReadsController } from '../../src/modules/iss/iss-escalation-reads.controller';
import { IssIssueController } from '../../src/modules/iss/iss-issue.controller';
import { IssIssueReadsController } from '../../src/modules/iss/iss-issue-reads.controller';
import { AuthzHarness, TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const REPORTER = 1; // issue.create, issue.read in unit 1
const ASSIGNER = 2; // issue.assign, issue.read in unit 1
const HANDLER = 3; // issue.work, issue.read in unit 1
const COORDINATOR = 4; // issue.escalate, issue.read in unit 1
const TF_MEMBER = 5; // issue.escalation.accept and issue.read over unit 2: a member of the task force whose grants do not reach the issues of unit 1
const OUTSIDER = 6; // issue.escalation.accept and issue.read on the whole tenant, not in the task force
const STRANGER = 7; // issue.escalation.accept only, not in the task force
const GUEST = 8; // a guest contractor: issue.read on one contract
const UNIT_HEAD = 9; // issue.escalation.accept and issue.read over unit 1
const FAMILY = 0x7b;
const PROJECT = id(FAMILY, 1);
const CONTRACT = id(FAMILY, 2);
const CONTRACTOR = id(FAMILY, 5);
const TASK_FORCE = id(FAMILY, 30);
const TASK_FORCE_OLD = id(FAMILY, 31);
const UNIT_1 = unitId(1);
const DAY_MS = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

describe('escalateIssue, acceptIssueEscalation and listIssueSlaBreaches (ST-ISS-004)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let category = '';
  let counter = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; body?: unknown; key?: string; ifMatch?: number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
  }
  const post = (url: string, options: Parameters<typeof call>[2]): Promise<Reply> => call('POST', url, options);
  const get = (url: string, member: number): Promise<Reply> => call('GET', url, { member });
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const audits = (issueId: string) => rows<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id = $1::uuid order by seq', [issueId]);
  const outbox = (issueId: string) => rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1::uuid order by created_at, id', [issueId]);

  /** An issue in IN_PROGRESS under HANDLER (version 3), through the commands. */
  async function working(over: Record<string, unknown> = {}): Promise<string> {
    counter += 1;
    const created = await post('/issues', {
      member: REPORTER,
      body: { project_id: PROJECT, category_version_id: category, severity: 'HIGH', title: `Plot ${counter} handover blocked`, description: 'The compensation is not agreed', owner_unit_id: UNIT_1, client_operation_id: randomUUID(), ...over },
    });
    const issueId = created.json.resource_id as string;
    expect((await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 1, body: { assignee_id: memberId(HANDLER) } })).status).toBe(200);
    expect((await post(`/issues/${issueId}/start`, { member: HANDLER, ifMatch: 2, body: {} })).status).toBe(200);
    return issueId;
  }
  const escalate = (issueId: string, version: number, body: Record<string, unknown>, member = COORDINATOR): Promise<Reply> =>
    post(`/issues/${issueId}/escalate`, { member, ifMatch: version, body: { reason: 'The owner has not answered', ...body } });
  const accept = (escalationId: string, member: number, key?: string): Promise<Reply> => post(`/issue-escalations/${escalationId}/accept`, { member, body: { note: 'We take it up' }, ...(key === undefined ? {} : { key }) });

  /** Runs the job a month after the issues were opened: every working issue is past 150 percent of its time. */
  async function lateJob(): Promise<void> {
    const job = new IssSlaJob(new AuditWriter(harness.tenants as TenantDatabase));
    await (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: memberId(10), scopeVersion: 1 }, (tx) => job.run(tx, memberId(10), new Date(Date.now() + 40 * DAY_MS)));
  }
  const escalationsOf = (issueId: string) => rows<{ id: string; level: number; status: string }>('select id, level, status from machvon.issue_escalation where issue_id = $1::uuid order by level', [issueId]);

  beforeAll(async () => {
    await harness.start();
    const thisYear = new Date().getUTCFullYear();
    for (const n of [1, 2]) await harness.seedUnits(TENANT_A, [{ n, path: `/${unitId(n)}/` }]);
    await harness.owner(
      TENANT_A,
      [thisYear - 1, thisYear, thisYear + 1].map((year, index): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
        [TENANT_A, id(0x71, 1 + index), year, memberId(1)],
      ]),
    );
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-ISS-4', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, UNIT_1, id(FAMILY, 20)],
      );
      await client.query(
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CV', 'Evidence', 'INTERNAL', $3, $3)`,
        [TENANT_A, id(FAMILY, 21), memberId(1)],
      );
      await client.query(
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $3)`,
        [TENANT_A, CONTRACTOR, id(FAMILY, 21)],
      );
      await client.query(
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version) values ($1, $2, $3, $4, $5, 'HD-ISS-4', 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
        [TENANT_A, CONTRACT, PROJECT, id(FAMILY, 22), CONTRACTOR],
      );
      await client.query(
        `insert into machvon.task_force (tenant_id, id, code, name, purpose, lead_membership_id, scope_unit_id, valid_from, valid_until, status, created_by, updated_by)
         values ($1, $2, 'TF-A-01', 'Task force A', 'Clear the plots', $4, $5, date '2026-01-01', null, 'ACTIVE', $4, $4),
                ($1, $3, 'TF-OLD', 'Dissolved', 'Old', $4, $5, date '2025-01-01', date '2025-12-31', 'DISSOLVED', $4, $4)`,
        [TENANT_A, TASK_FORCE, TASK_FORCE_OLD, memberId(TF_MEMBER), UNIT_1],
      );
      await client.query(
        `insert into machvon.task_force_member (tenant_id, id, task_force_id, membership_id, member_role, valid_from, created_by, updated_by) values ($1, $2, $3, $4, 'MEMBER', date '2026-01-01', $4, $4)`,
        [TENANT_A, id(FAMILY, 32), TASK_FORCE, memberId(TF_MEMBER)],
      );
    } finally {
      await client.end();
    }
    const recordId = randomUUID();
    category = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', 'LAND', 'EFFECTIVE', $3, $3)`,
        [TENANT_A, recordId, memberId(1)],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
         values ($1, $2, $3, 'ISSUE_CATEGORY', 'LAND', 1, 'Land clearance', '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', $4, $4)`,
        [TENANT_A, category, recordId, memberId(1)],
      ],
      ['update machvon.master_record set current_version_id = $2 where id = $1', [recordId, category]],
      [
        `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
         values ($1, $2, 'SLA-LAND-HIGH', 1, $3, $4, 'HIGH', 'WORKDAY_VN', 4, 16, '2026-01-01', 'ACTIVE', $5, $5)`,
        [TENANT_A, id(FAMILY, 23), category, recordId, memberId(1)],
      ],
    ]);
    for (const n of [REPORTER, ASSIGNER, HANDLER, COORDINATOR, TF_MEMBER, OUTSIDER, STRANGER, GUEST, UNIT_HEAD, 10]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.owner(TENANT_A, [
      ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1", [memberId(GUEST), CONTRACTOR]],
    ]);
    await harness.seedRole(TENANT_A, 1, 'CREATOR', ['issue.create', 'issue.read'], 20);
    await harness.seedRole(TENANT_A, 2, 'ASSIGNER', ['issue.assign', 'issue.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'HANDLER', ['issue.work', 'issue.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'COORDINATOR', ['issue.escalate', 'issue.read'], 30);
    await harness.seedRole(TENANT_A, 5, 'ACCEPTOR', ['issue.escalation.accept'], 30);
    await harness.seedRole(TENANT_A, 6, 'ACCEPTOR_READER', ['issue.escalation.accept', 'issue.read'], 30);
    await harness.seedRole(TENANT_A, 7, 'GUEST', ['issue.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: REPORTER, role: 1, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 2, member: ASSIGNER, role: 2, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 3, member: HANDLER, role: 3, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 4, member: COORDINATOR, role: 4, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 5, member: TF_MEMBER, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 6, member: OUTSIDER, role: 6, kind: 'TENANT' },
      { n: 7, member: STRANGER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 8, member: GUEST, role: 7, kind: 'CONTRACT', refs: [CONTRACT] },
      { n: 9, member: UNIT_HEAD, role: 6, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [IssIssueController, IssEscalationController, IssEscalationReadsController, IssIssueReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('escalateIssue', () => {
    it('raises a working issue to a unit by hand, keeps it open, and leaves an audit row and an event without the reason', async () => {
      const issueId = await working();
      const denied = await escalate(issueId, 3, { level: 1 }, HANDLER);
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const raised = await escalate(issueId, 3, { level: 1, target_unit_id: unitId(2) });
      expect(raised.status).toBe(200);
      expect(raised.json).toMatchObject({ status: 'ESCALATED', resource_version: 4 });
      expect(await rows('select status, escalation_level, escalated_at is not null as escalated from machvon.issue where id = $1::uuid', [issueId])).toEqual([{ status: 'ESCALATED', escalation_level: 1, escalated: true }]);
      expect((await audits(issueId)).at(-1)).toMatchObject({ action: 'iss.issue_escalated', safe_diff: { level: 1, trigger: 'MANUAL', from_status: 'IN_PROGRESS', to_status: 'ESCALATED', target_unit_id: unitId(2) } });
      const event = (await outbox(issueId)).at(-1);
      expect(event).toMatchObject({ type: 'iss.issue.escalated.v1', payload: { issue_id: issueId, level: 1, trigger: 'MANUAL', status: 'ESCALATED', version: 4, notification: { resource: { type: 'issue', id: issueId } } } });
      expect(JSON.stringify([await audits(issueId), await outbox(issueId)])).not.toContain('The owner has not answered');
      // The reader of the workspace sees the escalation with its reason (staff), the task force offered for level 3 to those who may escalate, and the extra events.
      const read = await get(`/resources/issue/${issueId}`, COORDINATOR);
      expect(read.json.escalations).toMatchObject([{ level: 1, trigger: 'MANUAL', status: 'OPEN', reason: 'The owner has not answered', target_unit: { id: unitId(2) } }]);
      expect(read.json.active_task_force).toMatchObject({ code: 'TF-A-01' });
      expect(((read.json.events as Array<{ kind: string; payload: Record<string, unknown> }>).find((item) => item.kind === 'ESCALATED'))?.payload).toMatchObject({ level: 1, trigger: 'MANUAL' });
      const reporterRead = await get(`/resources/issue/${issueId}`, REPORTER);
      expect(reporterRead.json.active_task_force).toBeNull();
      // The state machine has no edge from ESCALATED to ESCALATED.
      const again = await escalate(issueId, 4, { level: 2 });
      expect([again.status, again.json.code]).toEqual([409, 'ISSUE_STATE_INVALID']);
    });

    it('AC-ST-ISS-004-1: level 3 goes only to an active task force that answers for the issue', async () => {
      const issueId = await working();
      const dissolved = await escalate(issueId, 3, { level: 3, task_force_id: TASK_FORCE_OLD });
      expect([dissolved.status, dissolved.json.code]).toEqual([422, 'TASK_FORCE_NOT_ACTIVE']);
      const missing = await escalate(issueId, 3, { level: 3 });
      expect([missing.status, missing.json.code, missing.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'task_force_id']);
      const wrongLevel = await escalate(issueId, 3, { level: 1, task_force_id: TASK_FORCE });
      expect([wrongLevel.status, wrongLevel.json.code]).toEqual([422, 'ESCALATION_LEVEL_INVALID']);
      expect(await escalationsOf(issueId)).toEqual([]);
      const raised = await escalate(issueId, 3, { level: 3, task_force_id: TASK_FORCE });
      expect(raised.json).toMatchObject({ status: 'ESCALATED', resource_version: 4 });
      expect((await outbox(issueId)).at(-1)?.payload).toMatchObject({ level: 3, task_force_id: TASK_FORCE, notification: { recipients: [memberId(TF_MEMBER)] } });
    });
  });

  describe('acceptIssueEscalation (UAT-AC352, UAT-PLAN-24)', () => {
    it('AC-ST-ISS-004-1: the job escalates to the unit and the task force once each; a member of the task force accepts and the issue goes back to work', async () => {
      const issueId = await working();
      await lateJob();
      await lateJob();
      const levels = await escalationsOf(issueId);
      expect(levels.map((row) => row.level)).toEqual([2, 3]);
      expect((await get(`/resources/issue/${issueId}`, COORDINATOR)).json).toMatchObject({ status: 'ESCALATED', escalation_level: 3 });
      const l3 = levels[1]?.id as string;
      const l2 = levels[0]?.id as string;

      // AC-ST-ISS-004-2: a stranger to the task force is refused; the member accepts.
      const refused = await accept(l3, STRANGER);
      expect([refused.status, refused.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const outsider = await accept(l3, OUTSIDER);
      expect([outsider.status, outsider.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await escalationsOf(issueId))[1]?.status).toBe('OPEN');
      const first = await accept(l3, TF_MEMBER, 'accept-key-0000000001');
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'IN_PROGRESS', resource_id: l3 });
      const replay = await accept(l3, TF_MEMBER, 'accept-key-0000000001');
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      expect(replay.json).toEqual(first.json);
      const fresh = await accept(l3, TF_MEMBER, 'accept-key-0000000002');
      expect([fresh.status, fresh.json.code]).toEqual([409, 'ESCALATION_STATE_INVALID']);
      expect((await audits(issueId)).filter((entry) => entry.action === 'iss.issue_escalation_accepted')).toHaveLength(1);
      expect((await outbox(issueId)).filter((event) => event.type === 'iss.issue.escalation_accepted.v1')).toHaveLength(1);
      expect(await escalationsOf(issueId)).toMatchObject([{ level: 2, status: 'OPEN' }, { level: 3, status: 'ACCEPTED' }]);

      // The head of the unit accepts the escalation to the unit; the original issue was never closed.
      const head = await accept(l2, UNIT_HEAD);
      expect(head.json).toMatchObject({ status: 'IN_PROGRESS', resource_id: l2 });
      expect(await rows('select status, closed_at from machvon.issue where id = $1::uuid', [issueId])).toEqual([{ status: 'IN_PROGRESS', closed_at: null }]);
      const unknown = await accept(randomUUID(), TF_MEMBER);
      expect([unknown.status, unknown.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });

  describe('the board (listIssueSlaBreaches)', () => {
    it('lists the escalations a coordinator can read and the ones addressed to a task force member, masks them for a guest, filters by level and refuses a bad level', async () => {
      const issueId = await working({ contract_id: CONTRACT, title: 'Plot on the contract' });
      await lateJob();
      const coordinator = await get('/issues/sla-breaches?limit=100', COORDINATOR);
      expect(coordinator.status).toBe(200);
      const mine = (coordinator.json.items as Array<Record<string, unknown>>).filter((item) => item.issue_id === issueId);
      expect(mine.map((item) => item.level).sort()).toEqual([2, 3]);
      expect(mine[0]).toMatchObject({ issue_title: 'Plot on the contract', status: 'OPEN', acceptable: false, overdue_days: expect.any(Number) as number });
      expect(coordinator.json.next_cursor).toBeNull();

      const member = await get('/issues/sla-breaches?limit=100&level=3', TF_MEMBER);
      const memberLines = member.json.items as Array<Record<string, unknown>>;
      expect(memberLines.length).toBeGreaterThan(0);
      expect(memberLines.every((item) => item.level === 3 && (item.task_force as { code: string }).code === 'TF-A-01')).toBe(true);
      expect(memberLines.find((item) => item.issue_id === issueId)).toMatchObject({ acceptable: true });
      expect((await get('/issues/sla-breaches?level=2', TF_MEMBER)).json.items).toEqual([]);

      const guest = await get('/issues/sla-breaches?limit=100', GUEST);
      const guestLine = (guest.json.items as Array<Record<string, unknown>>).find((item) => item.issue_id === issueId);
      expect(guestLine).toMatchObject({ issue_title: null, target_unit: null, task_force: null, accepted_by: null, level: expect.any(Number) as number });
      expect((guest.json.items as Array<Record<string, unknown>>).every((item) => item.issue_id === issueId)).toBe(true);

      const page = await get('/issues/sla-breaches?limit=1', COORDINATOR);
      expect((page.json.items as unknown[]).length).toBe(1);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await get(`/issues/sla-breaches?limit=1&cursor=${String(page.json.next_cursor)}`, COORDINATOR);
      expect((next.json.items as Array<{ escalation_id: string }>)[0]?.escalation_id).not.toBe((page.json.items as Array<{ escalation_id: string }>)[0]?.escalation_id);
      const bad = await get('/issues/sla-breaches?level=7', COORDINATOR);
      expect([bad.status, bad.json.code, bad.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'level']);
      const nobody = await get('/issues/sla-breaches', REPORTER);
      expect(nobody.status).toBe(200);
    });
  });
});
