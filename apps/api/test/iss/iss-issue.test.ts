import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { IssIssueController } from '../../src/modules/iss/iss-issue.controller';
import { IssIssueAssigneesController } from '../../src/modules/iss/iss-issue-assignees.controller';
import { IssIssueReadsController } from '../../src/modules/iss/iss-issue-reads.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const REPORTER = 1; // issue.create, issue.read, issue.work in unit 1
const ASSIGNER = 2; // issue.assign, issue.read in unit 1
const WORKER = 3; // issue.work, issue.read in unit 1
const OFFICER_U2 = 4; // issue.create, issue.read, issue.work, issue.assign in unit 2
const GUEST = 5; // a guest contractor: issue.read and issue.work on one contract
const NOTHING = 6; // no issue permission at all
const READER_ALL = 7; // issue.read on the whole tenant
const LAND_READER = 8; // issue.read and land.household.read on the whole tenant
const WORKER_ALL = 9; // issue.work on the whole tenant
const OTHER_TENANT = 1; // of tenant B: every issue permission on the whole tenant
const FAMILY = 0x7f;
const PROJECT = id(FAMILY, 1);
const CONTRACT = id(FAMILY, 2);
const DOCUMENT_CLEAN = id(FAMILY, 3);
const DOCUMENT_PENDING = id(FAMILY, 4);
const CONTRACTOR = id(FAMILY, 5);
const PROJECT_B = id(FAMILY, 6);
const UNIT_1 = unitId(1);
const UNIT_2 = unitId(2);
const UNIT_3 = unitId(3);

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

describe('createIssue, assignIssue, startIssue, commentIssue, transferIssueUnit and the issue reads (ST-ISS-002)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let category = '';
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: number | string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = typeof options.ifMatch === 'number' ? `"${options.ifMatch}"` : options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
  }
  const post = (url: string, options: Parameters<typeof call>[2]): Promise<Reply> => call('POST', url, options);
  const get = (url: string, options: Parameters<typeof call>[2]): Promise<Reply> => call('GET', url, options);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  const createBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return {
      project_id: PROJECT,
      category_version_id: category,
      severity: 'HIGH',
      title: `Plot 12 handover blocked ${counter}`,
      description: 'The compensation of plot 12 is not agreed',
      owner_unit_id: UNIT_1,
      client_operation_id: randomUUID(),
      ...extra,
    };
  };
  const open = (extra: Record<string, unknown> = {}, member = REPORTER): Promise<Reply> => post('/issues', { member, body: createBody(extra) });
  const audits = (issueId: string) => rows<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id = $1::uuid order by seq', [issueId]);
  const outbox = (issueId: string) => rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1::uuid order by created_at, id', [issueId]);
  const timeline = (issueId: string) => rows<{ event_kind: string; note: string | null }>('select event_kind, note from machvon.issue_event where issue_id = $1::uuid order by created_at, id', [issueId]);

  /** An issue that has been assigned to WORKER (version 2). */
  async function assigned(over: Record<string, unknown> = {}): Promise<string> {
    const issueId = idOf(await open(over));
    const reply = await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 1, body: { assignee_id: memberId(WORKER) } });
    expect(reply.status).toBe(200);
    return issueId;
  }

  async function seedAdmin(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await harness.start();
    const thisYear = new Date().getUTCFullYear();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unitId(1)}/` },
        { n: 2, path: `/${unitId(2)}/` },
        { n: 3, path: `/${unitId(3)}/` },
      ]);
      // The deadline of an issue is counted on the working calendar: the years an issue created now can reach.
      await harness.owner(
        tenant,
        [thisYear - 1, thisYear, thisYear + 1].map((year, index): [string, unknown[]] => [
          `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
           values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
          [tenant, id(0x73, (tenant === TENANT_A ? 1 : 4) + index), year, memberId(1)],
        ]),
      );
      await seedAdmin([
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, 'Bridge', $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [tenant, tenant === TENANT_A ? PROJECT : PROJECT_B, tenant === TENANT_A ? 'PRJ-ISS-1' : 'PRJ-ISS-2', UNIT_1, id(FAMILY, 20)],
        ],
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'REFERENCE', 'CV', 'Evidence', 'INTERNAL', $3, $3)`,
          [tenant, id(FAMILY, 21), memberId(1)],
        ],
        [
          `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
           values ($1, $2, $4, 1, 'tenants/iss/clean.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                  ($1, $3, $4, 2, 'tenants/iss/pending.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
          [tenant, DOCUMENT_CLEAN, DOCUMENT_PENDING, id(FAMILY, 21)],
        ],
      ]);
    }
    await seedAdmin([
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $3)`,
        [TENANT_A, CONTRACTOR, id(FAMILY, 21)],
      ],
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version)
         values ($1, $2, $3, $4, $5, 'HD-ISS-1', 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
        [TENANT_A, CONTRACT, PROJECT, id(FAMILY, 22), CONTRACTOR],
      ],
    ]);
    const recordId = randomUUID();
    category = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
         values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', 'LAND', 'EFFECTIVE', $3, $3)`,
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
    for (const n of [REPORTER, ASSIGNER, WORKER, OFFICER_U2, GUEST, NOTHING, READER_ALL, LAND_READER, WORKER_ALL]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, 1);
    await harness.owner(TENANT_A, [
      ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1", [memberId(GUEST), CONTRACTOR]],
    ]);
    await harness.seedRole(TENANT_A, 1, 'CREATOR', ['issue.create', 'issue.read', 'issue.work'], 20);
    await harness.seedRole(TENANT_A, 2, 'ASSIGNER', ['issue.assign', 'issue.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'WORKER', ['issue.work', 'issue.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'OFFICER', ['issue.create', 'issue.read', 'issue.work', 'issue.assign'], 30);
    await harness.seedRole(TENANT_A, 5, 'GUEST', ['issue.read', 'issue.work'], 10);
    await harness.seedRole(TENANT_A, 6, 'READER', ['issue.read'], 10);
    await harness.seedRole(TENANT_A, 7, 'LAND', ['issue.read', 'land.household.read'], 10);
    await harness.seedRole(TENANT_A, 8, 'NOTHING', ['project.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'ALL', ['issue.create', 'issue.read', 'issue.work', 'issue.assign'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: REPORTER, role: 1, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 2, member: ASSIGNER, role: 2, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 3, member: WORKER, role: 3, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 4, member: OFFICER_U2, role: 4, kind: 'UNIT_SUBTREE', refs: [UNIT_2] },
      { n: 5, member: GUEST, role: 5, kind: 'CONTRACT', refs: [CONTRACT] },
      { n: 6, member: NOTHING, role: 8, kind: 'TENANT' },
      { n: 7, member: READER_ALL, role: 6, kind: 'TENANT' },
      { n: 8, member: LAND_READER, role: 7, kind: 'TENANT' },
      { n: 9, member: WORKER_ALL, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [IssIssueController, IssIssueReadsController, IssIssueAssigneesController],
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

  describe('createIssue', () => {
    it('opens the issue under the policy in force, writes the first event, the audit row and the outbox event, and none of them holds the text or the position', async () => {
      const reply = await open({ title: 'Quarry blocked, call 0901234567', geo_consent: true, geo_lat: '10.812345', geo_lng: '106.712345', geo_accuracy_m: '12' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'OPEN', resource_version: 1 });
      expect(reply.headers.get('etag')).toBe('"1"');
      const issueId = idOf(reply);
      const [issue] = await rows<{ status: string; code: string; reported_by: string; due_at: Date; response_due_at: Date; sla_policy_id: string }>('select * from machvon.issue where id = $1::uuid', [issueId]);
      expect(issue).toMatchObject({ status: 'OPEN', reported_by: memberId(REPORTER), sla_policy_id: id(FAMILY, 23) });
      expect(issue?.code).toMatch(/^VM-\d{4}-\d{6}$/);
      expect(issue?.due_at.getTime()).toBeGreaterThan(issue?.response_due_at.getTime() ?? 0);
      expect(await timeline(issueId)).toEqual([{ event_kind: 'CREATED', note: null }]);
      const trail = await audits(issueId);
      expect(trail.map((entry) => entry.action)).toEqual(['iss.issue_opened']);
      expect(trail[0]?.safe_diff).toMatchObject({ code: issue?.code, owner_unit_id: UNIT_1, severity: 'HIGH', source_module: 'MANUAL', sla_policy_id: id(FAMILY, 23), geo_recorded: true });
      const events = await outbox(issueId);
      expect(events.map((event) => event.type)).toEqual(['iss.issue.opened.v1']);
      expect(events[0]?.payload).toMatchObject({ issue_id: issueId, project_id: PROJECT, owner_unit_id: UNIT_1, severity: 'HIGH', status: 'OPEN', escalation_level: 0, sla_policy_id: id(FAMILY, 23), version: 1 });
      const everything = JSON.stringify([trail, events]);
      for (const secret of ['Quarry', '0901234567', 'compensation', '10.812345', '106.712345']) expect(everything).not.toContain(secret);
    });

    it('answers a create sent twice from an offline phone with one issue, under the same key or under a new one, and the follow-up reads the status and the deadline the server counted (AC-ST-ISS-002-2, UAT-AC355, UAT-PLAN-37)', async () => {
      const body = createBody({ geo_consent: true, geo_lat: '10.8', geo_lng: '106.7', geo_accuracy_m: '12' });
      const first = await post('/issues', { member: REPORTER, body, key: 'offline-key-0000000001' });
      const sameKey = await post('/issues', { member: REPORTER, body, key: 'offline-key-0000000001' });
      const newKey = await post('/issues', { member: REPORTER, body, key: 'offline-key-0000000002' });
      expect([first.status, sameKey.status, newKey.status]).toEqual([200, 200, 200]);
      expect(sameKey.headers.get('idempotency-replayed')).toBe('true');
      expect(idOf(sameKey)).toBe(idOf(first));
      expect(idOf(newKey)).toBe(idOf(first));
      expect(await rows<{ n: string }>('select count(*)::text as n from machvon.issue where client_operation_id = $1::uuid', [body.client_operation_id])).toEqual([{ n: '1' }]);
      expect((await audits(idOf(first))).map((entry) => entry.action)).toEqual(['iss.issue_opened', 'iss.issue_open_replayed']);
      expect(await outbox(idOf(first))).toHaveLength(1);
      expect(await timeline(idOf(first))).toHaveLength(1);
      // The follow-up screen reads the one issue: its status and the deadlines the server counted from the policy, not from the phone.
      const [counted] = await rows<{ status: string; due_at: Date; response_due_at: Date }>('select status, due_at, response_due_at from machvon.issue where id = $1::uuid', [idOf(first)]);
      const followUp = await get(`/resources/issue/${idOf(first)}`, { member: READER_ALL });
      expect(followUp.status).toBe(200);
      expect(followUp.json).toMatchObject({ id: idOf(first), status: 'OPEN', due_at: counted?.due_at.toISOString(), response_due_at: counted?.response_due_at.toISOString() });
      expect(new Date(followUp.json.due_at as string).getTime()).toBeGreaterThan(new Date(followUp.json.response_due_at as string).getTime());
      expect(await rows('select geo_lat::text as geo_lat, geo_consent from machvon.issue where id = $1::uuid', [idOf(first)])).toEqual([{ geo_lat: '10.800000', geo_consent: true }]);
      // The same operation id with another request is not a retry.
      const other = await post('/issues', { member: REPORTER, body: { ...body, title: 'Something else entirely' }, key: 'offline-key-0000000003' });
      expect(other.status).toBe(409);
      expect(other.json.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('stores a position only with consent: coordinates without it are refused and nothing is written (UAT-AC355)', async () => {
      const body = createBody({ geo_consent: false, geo_lat: '10.8', geo_lng: '106.7' });
      const refused = await post('/issues', { member: REPORTER, body });
      expect(refused.status).toBe(422);
      expect(refused.json.code).toBe('VALIDATION_FAILED');
      expect(await rows<{ n: string }>('select count(*)::text as n from machvon.issue where client_operation_id = $1::uuid', [body.client_operation_id])).toEqual([{ n: '0' }]);
      const without = await open({ geo_consent: false });
      expect(await rows('select geo_lat, geo_consent from machvon.issue where id = $1::uuid', [idOf(without)])).toEqual([{ geo_lat: null, geo_consent: false }]);
    });

    it('refuses what the caller may not do or what is not allowed: another unit, no permission, a foreign project, no policy, a duplicate source, a field outside the allowlist', async () => {
      expect((await open({ owner_unit_id: UNIT_2 })).json.code).toBe('SCOPE_DENIED');
      expect((await open({}, NOTHING)).json.code).toBe('SCOPE_DENIED');
      const foreign = await open({ project_id: PROJECT_B });
      expect(foreign.status).toBe(404);
      expect(foreign.json.code).toBe('RESOURCE_NOT_FOUND');
      const noPolicy = await open({ severity: 'LOW' });
      expect([noPolicy.status, noPolicy.json.code]).toEqual([422, 'SLA_POLICY_MISSING']);
      const source = randomUUID();
      expect((await open({ source_module: 'PMT', source_ref_id: source })).status).toBe(200);
      const duplicate = await open({ source_module: 'PMT', source_ref_id: source });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'DUPLICATE_SOURCE_OPEN']);
      const extra = await open({ status: 'CLOSED' });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const missing = await post('/issues', { member: REPORTER, body: { ...createBody(), client_operation_id: undefined } });
      expect(missing.status).toBe(400);
      const strangeContract = await open({ owner_unit_id: UNIT_1, contract_id: randomUUID() });
      expect([strangeContract.status, strangeContract.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('opens an issue on a contract, and refuses a guest contractor who holds no right to create', async () => {
      // The guest holds issue.work and issue.read, not issue.create: the policy guard refuses before anything is read.
      expect((await open({ contract_id: CONTRACT }, GUEST)).json.code).toBe('SCOPE_DENIED');
      const reply = await open({ contract_id: CONTRACT });
      expect(reply.status).toBe(200);
      expect((await rows<{ contract_id: string }>('select contract_id from machvon.issue where id = $1::uuid', [idOf(reply)]))[0]?.contract_id).toBe(CONTRACT);
    });
  });

  describe('assignIssue, startIssue, commentIssue and transferIssueUnit', () => {
    it('takes an issue from OPEN to ASSIGNED to IN_PROGRESS, comments on it and moves it, each step a timeline event, an audit row and an outbox event', async () => {
      const issueId = idOf(await open());
      const assign = await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 1, body: { assignee_id: memberId(WORKER).toUpperCase(), note: 'Please take it' } });
      expect(assign.status).toBe(200);
      expect(assign.json).toMatchObject({ status: 'ASSIGNED', resource_version: 2 });
      expect(assign.headers.get('etag')).toBe('"2"');
      // The identifiers are written as the database stores them, whatever case the request spelt them in.
      const start = await post(`/issues/${issueId.toUpperCase()}/start`, { member: WORKER, ifMatch: 2, body: { note: 'On my way' } });
      expect(start.json).toMatchObject({ status: 'IN_PROGRESS', resource_version: 3 });
      const comment = await post(`/issues/${issueId}/comments`, { member: WORKER, body: { note: 'Owner informed', document_version_id: DOCUMENT_CLEAN } });
      expect(comment.json).toMatchObject({ status: 'IN_PROGRESS', resource_version: 3 });
      const transfer = await post(`/issues/${issueId}/transfer`, { member: ASSIGNER, ifMatch: 3, body: { target_unit_id: UNIT_3, reason: 'The works are in another commune' } });
      expect(transfer.json).toMatchObject({ status: 'IN_PROGRESS', resource_version: 4 });
      expect(await timeline(issueId)).toEqual([
        { event_kind: 'CREATED', note: null },
        { event_kind: 'ASSIGNED', note: 'Please take it' },
        { event_kind: 'STARTED', note: 'On my way' },
        { event_kind: 'EVIDENCE_ADDED', note: 'Owner informed' },
        { event_kind: 'TRANSFERRED', note: 'The works are in another commune' },
      ]);
      expect((await audits(issueId)).map((entry) => entry.action)).toEqual(['iss.issue_opened', 'iss.issue_assigned', 'iss.issue_started', 'iss.issue_commented', 'iss.issue_transferred']);
      const events = await outbox(issueId);
      expect(events.map((event) => event.type)).toEqual(['iss.issue.opened.v1', 'iss.issue.assigned.v1', 'iss.issue.started.v1', 'iss.issue.commented.v1', 'iss.issue.transferred.v1']);
      expect(events[1]?.payload).toMatchObject({ assignee_id: memberId(WORKER), previous_assignee_id: null, status: 'ASSIGNED' });
      expect(events[2]?.payload).toMatchObject({ issue_id: issueId, status: 'IN_PROGRESS' });
      expect(start.json.resource_id).toBe(issueId);
      expect(events[4]?.payload).toMatchObject({ owner_unit_id: UNIT_3, from_unit_id: UNIT_1, version: 4 });
      const everything = JSON.stringify([await audits(issueId), events]);
      for (const secret of ['Please take it', 'On my way', 'Owner informed', 'another commune', 'compensation']) expect(everything).not.toContain(secret);
    });

    it('answers a replay of a command with the first answer and no second audit row or event', async () => {
      const issueId = idOf(await open());
      const key = `assign-${randomUUID()}`;
      const body = { assignee_id: memberId(WORKER) };
      const first = await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 1, body, key });
      const again = await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 1, body, key });
      expect(again.json).toEqual(first.json);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect((await audits(issueId)).filter((entry) => entry.action === 'iss.issue_assigned')).toHaveLength(1);
      expect((await outbox(issueId)).filter((event) => event.type === 'iss.issue.assigned.v1')).toHaveLength(1);
    });

    it('refuses a stale version, a missing If-Match, a state the machine does not allow and an assignee who cannot work the issue', async () => {
      const issueId = idOf(await open());
      const stale = await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 5, body: { assignee_id: memberId(WORKER) } });
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', 1]);
      const noMatch = await post(`/issues/${issueId}/assign`, { member: ASSIGNER, body: { assignee_id: memberId(WORKER) } });
      expect([noMatch.status, noMatch.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      for (const assignee of [memberId(NOTHING), memberId(OFFICER_U2), id(0x20, 999)]) {
        const refused = await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 1, body: { assignee_id: assignee } });
        expect([refused.status, refused.json.code]).toEqual([422, 'ASSIGNEE_OUT_OF_SCOPE']);
      }
      const notAssigned = await post(`/issues/${issueId}/start`, { member: WORKER, ifMatch: 1, body: {} });
      expect([notAssigned.status, notAssigned.json.code]).toEqual([409, 'ISSUE_STATE_INVALID']);
      expect((await rows<{ status: string }>('select status from machvon.issue where id = $1::uuid', [issueId]))[0]?.status).toBe('OPEN');
    });

    it('lets only the assignee start the issue, and refuses a document that is not clean', async () => {
      const issueId = await assigned();
      const other = await post(`/issues/${issueId}/start`, { member: WORKER_ALL, ifMatch: 2, body: {} });
      expect([other.status, other.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const pending = await post(`/issues/${issueId}/comments`, { member: WORKER, body: { note: 'See attached', document_version_id: DOCUMENT_PENDING } });
      expect([pending.status, pending.json.code]).toEqual([422, 'DOCUMENT_NOT_CLEAN']);
      expect((await post(`/issues/${issueId}/start`, { member: WORKER, ifMatch: 2, body: {} })).status).toBe(200);
    });

    it('does not let a caller act outside their scope: an issue of another unit does not exist for them, one they can only read is refused', async () => {
      const issueId = await assigned();
      const elsewhere = await post(`/issues/${issueId}/transfer`, { member: OFFICER_U2, ifMatch: 2, body: { target_unit_id: UNIT_3, reason: 'Not mine' } });
      expect([elsewhere.status, elsewhere.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const commentElsewhere = await post(`/issues/${issueId}/comments`, { member: OFFICER_U2, body: { note: 'Hello' } });
      expect(commentElsewhere.status).toBe(404);
      // READER_ALL may read every issue and holds no right to assign: the policy guard refuses before the scope is read.
      expect((await post(`/issues/${issueId}/assign`, { member: READER_ALL, ifMatch: 2, body: { assignee_id: memberId(WORKER) } })).json.code).toBe('SCOPE_DENIED');
    });

    it('lets the person who reported the issue comment on it from another unit', async () => {
      const issueId = idOf(await open({ owner_unit_id: UNIT_1 }));
      await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 1, body: { assignee_id: memberId(WORKER) } });
      await post(`/issues/${issueId}/transfer`, { member: ASSIGNER, ifMatch: 2, body: { target_unit_id: UNIT_2, reason: 'To the commune' } });
      // The reporter is in unit 1 and the issue is now in unit 2: they still reach their own issue.
      const comment = await post(`/issues/${issueId}/comments`, { member: REPORTER, body: { note: 'Any news?' } });
      expect(comment.status).toBe(200);
      expect((await post(`/issues/${issueId}/comments`, { member: WORKER, body: { note: 'Not my unit any more' } })).status).toBe(404);
    });

    it('moves an issue overdue for days to another unit without moving its deadline or the days it has been overdue (AC-ST-ISS-002-1, UAT-AC350)', async () => {
      const issueId = await assigned();
      // The issue became overdue 15 calendar days ago, on its own deadline's hour.
      await rows('update machvon.issue set overdue_since = now() - interval \'15 days\' where id = $1::uuid', [issueId]);
      const before = await get(`/resources/issue/${issueId}`, { member: READER_ALL });
      const [stored] = await rows<{ due_at: Date; response_due_at: Date; overdue_since: Date }>('select due_at, response_due_at, overdue_since from machvon.issue where id = $1::uuid', [issueId]);
      expect(before.json.overdue_days).toBeGreaterThanOrEqual(9);
      const moved = await post(`/issues/${issueId}/transfer`, { member: ASSIGNER, ifMatch: 2, body: { target_unit_id: UNIT_2, reason: 'The works are in unit 2' } });
      expect(moved.status).toBe(200);
      const [after] = await rows<{ due_at: Date; response_due_at: Date; overdue_since: Date; owner_unit_id: string }>('select due_at, response_due_at, overdue_since, owner_unit_id from machvon.issue where id = $1::uuid', [issueId]);
      expect(after).toMatchObject({ owner_unit_id: UNIT_2, due_at: stored?.due_at, response_due_at: stored?.response_due_at, overdue_since: stored?.overdue_since });
      const read = await get(`/resources/issue/${issueId}`, { member: OFFICER_U2 });
      expect(read.status).toBe(200);
      expect(read.json).toMatchObject({ owner_unit_id: UNIT_2, overdue_days: before.json.overdue_days, due_at: before.json.due_at, overdue_since: before.json.overdue_since });
      const events = read.json.events as Array<Record<string, unknown>>;
      expect(events.map((event) => event.kind)).toEqual(['CREATED', 'ASSIGNED', 'TRANSFERRED']);
      expect(events[2]).toMatchObject({ payload: { from_unit_id: UNIT_1, to_unit_id: UNIT_2 }, note: 'The works are in unit 2' });
    });
  });

  describe('listIssueAssignees (CR-ISS-14)', () => {
    const assigneesOf = (issueId: string, member: number, tenantId?: string): Promise<Reply> => get(`/issues/${issueId}/assignees`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
    const idsOf = (reply: Reply): string[] => (reply.json.items as Array<{ membership_id: string }>).map((item) => item.membership_id);

    it('lists the active members who hold issue.work over the place of the issue, and the command accepts each of them', async () => {
      const issueId = idOf(await open({ owner_unit_id: UNIT_1 }));
      const reply = await assigneesOf(issueId, ASSIGNER);
      expect(reply.status).toBe(200);
      expect(reply.json.next_cursor).toBeNull();
      expect(idsOf(reply).sort()).toEqual([memberId(REPORTER), memberId(WORKER), memberId(WORKER_ALL)].sort());
      expect((reply.json.items as Array<{ display_name: string }>).every((item) => item.display_name !== '')).toBe(true);
      for (const person of idsOf(reply)) {
        const fresh = idOf(await open({ owner_unit_id: UNIT_1 }));
        expect((await post(`/issues/${fresh}/assign`, { member: ASSIGNER, ifMatch: 1, body: { assignee_id: person } })).status).toBe(200);
      }
    });

    it('names the guest of a contract for an issue on it, and refuses to show an issue outside the scope or of another tenant (404) or to someone who may not assign (403)', async () => {
      const onContract = idOf(await open({ owner_unit_id: UNIT_1, contract_id: CONTRACT }));
      expect(idsOf(await assigneesOf(onContract, ASSIGNER))).toContain(memberId(GUEST));
      for (const reply of [await assigneesOf(onContract, OFFICER_U2), await assigneesOf(onContract, OTHER_TENANT, TENANT_B), await assigneesOf(randomUUID(), ASSIGNER)]) {
        expect([reply.status, reply.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      }
      expect((await assigneesOf(onContract, READER_ALL)).json.code).toBe('SCOPE_DENIED');
    });
  });

  describe('the reads (AC-ST-ISS-002-3, UAT-PLAN-23)', () => {
    let inUnit1: string;
    let inUnit2: string;
    let onContract: string;
    let fromLand: string;

    beforeAll(async () => {
      inUnit1 = idOf(await open({ owner_unit_id: UNIT_1 }));
      inUnit2 = idOf(await open({ owner_unit_id: UNIT_2 }, OFFICER_U2));
      onContract = idOf(await open({ owner_unit_id: UNIT_1, contract_id: CONTRACT, geo_consent: true, geo_lat: '10.8', geo_lng: '106.7', geo_accuracy_m: '60' }));
      fromLand = idOf(await open({ owner_unit_id: UNIT_1, source_module: 'LND', source_ref_id: randomUUID(), title: 'Complaint LC-1 waits', description: 'Household Nguyen Van A, ID 079000000001' }));
      await post(`/issues/${fromLand}/comments`, { member: REPORTER, body: { note: 'The household asks for a visit' } });
      await post(`/issues/${onContract}/comments`, { member: REPORTER, body: { note: 'Staff only remark' } });
    });

    const idsOf = (reply: Reply): string[] => (reply.json.items as Array<{ id: string }>).map((item) => item.id);

    it('shows each caller only the issues in their scope', async () => {
      const officer1 = idsOf(await get('/resources/issue?limit=200', { member: ASSIGNER }));
      expect(officer1).toEqual(expect.arrayContaining([inUnit1, onContract, fromLand]));
      expect(officer1).not.toContain(inUnit2);
      const officer2 = idsOf(await get('/resources/issue?limit=200', { member: OFFICER_U2 }));
      expect(officer2).toContain(inUnit2);
      expect(officer2).not.toContain(inUnit1);
      const guest = idsOf(await get('/resources/issue?limit=200', { member: GUEST }));
      expect(guest).toContain(onContract);
      expect(guest).not.toContain(inUnit1);
      expect(guest).not.toContain(fromLand);
      const all = idsOf(await get('/resources/issue?limit=200', { member: READER_ALL }));
      expect(all).toEqual(expect.arrayContaining([inUnit1, inUnit2, onContract, fromLand]));
      expect((await get('/resources/issue', { member: NOTHING })).json.code).toBe('SCOPE_DENIED');
    });

    it('opens an issue inside the scope and answers 404 outside it, for a foreign tenant and for an id that does not exist', async () => {
      expect((await get(`/resources/issue/${inUnit1}`, { member: ASSIGNER })).status).toBe(200);
      for (const reply of [
        await get(`/resources/issue/${inUnit2}`, { member: ASSIGNER }),
        await get(`/resources/issue/${inUnit1}`, { member: OFFICER_U2 }),
        await get(`/resources/issue/${inUnit1}`, { member: OTHER_TENANT, tenantId: TENANT_B }),
        await get(`/resources/issue/${randomUUID()}`, { member: READER_ALL }),
        await get(`/resources/issue/${onContract}`, { member: OFFICER_U2 }),
      ]) {
        expect([reply.status, reply.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      }
      const foreignList = await get('/resources/issue?limit=200', { member: OTHER_TENANT, tenantId: TENANT_B });
      expect(foreignList.json.items).toEqual([]);
      const commands: Array<[string, Record<string, unknown>]> = [
        [`/issues/${inUnit1}/assign`, { assignee_id: memberId(OTHER_TENANT) }],
        [`/issues/${inUnit1}/start`, {}],
        [`/issues/${inUnit1}/transfer`, { target_unit_id: UNIT_3, reason: 'x' }],
        [`/issues/${inUnit1}/comments`, { note: 'x' }],
      ];
      for (const [url, body] of commands) {
        const foreign = await post(url, { member: OTHER_TENANT, tenantId: TENANT_B, ifMatch: 1, body });
        expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      }
      expect((await get('/resources/issue/not-a-uuid', { member: READER_ALL })).status).toBe(422);
    });

    it('shows the staff the position with the warning for a low accuracy, and a guest contractor the work without the people or the place', async () => {
      const staff = (await get(`/resources/issue/${onContract}`, { member: READER_ALL })).json;
      expect(staff).toMatchObject({
        id: onContract,
        status: 'OPEN',
        geo_consent: true,
        geo: { lat: '10.800000', lng: '106.700000', accuracy_m: '60.00', low_accuracy: true },
        reported_by: { membership_id: memberId(REPORTER) },
        sla: { policy_code: 'SLA-LAND-HIGH', policy_revision: 1, calendar_code: 'WORKDAY_VN', response_hours: 4, resolve_hours: 16, require_evidence: true },
        project_code: 'PRJ-ISS-1',
        category_label: 'Land clearance',
      });
      const guest = (await get(`/resources/issue/${onContract}`, { member: GUEST })).json;
      expect(guest).toMatchObject({ id: onContract, geo: null, assignee: null, reported_by: null, source_ref_id: null, verifier: null, description: null });
      const events = guest.events as Array<{ actor: unknown; note: unknown }>;
      expect(events.every((event) => event.actor === null && event.note === null)).toBe(true);
      expect(JSON.stringify(guest)).not.toContain('Staff only remark');
      const lines = (await get('/resources/issue', { member: GUEST })).json.items as Array<Record<string, unknown>>;
      expect(lines[0]).toMatchObject({ id: onContract, assignee: null, reported_by: null, source_ref_id: null });
      expect(lines[0]).not.toHaveProperty('geo');
    });

    it('hides what a land complaint says from those who may not read the household (UAT-AC354)', async () => {
      const plain = (await get(`/resources/issue/${fromLand}`, { member: READER_ALL })).json;
      expect(plain).toMatchObject({ title: 'Complaint LC-1 waits', source_module: 'LND', description: null });
      expect((plain.events as Array<{ note: unknown }>).every((event) => event.note === null)).toBe(true);
      expect(JSON.stringify(plain)).not.toContain('079000000001');
      const allowed = (await get(`/resources/issue/${fromLand}`, { member: LAND_READER })).json;
      expect(allowed.description).toBe('Household Nguyen Van A, ID 079000000001');
      expect((allowed.events as Array<{ note: unknown }>).map((event) => event.note)).toEqual([null, 'The household asks for a visit']);
    });

    it('pages the timeline of an issue with its cursor and refuses a malformed one', async () => {
      const issueId = idOf(await open());
      for (const note of ['one', 'two', 'three']) await post(`/issues/${issueId}/comments`, { member: REPORTER, body: { note } });
      const first = (await get(`/resources/issue/${issueId}?limit=2`, { member: READER_ALL })).json;
      expect((first.events as Array<{ kind: string }>).map((event) => event.kind)).toEqual(['CREATED', 'COMMENTED']);
      expect(typeof first.next_cursor).toBe('string');
      const second = (await get(`/resources/issue/${issueId}?limit=2&cursor=${first.next_cursor as string}`, { member: READER_ALL })).json;
      expect((second.events as Array<{ note: string }>).map((event) => event.note)).toEqual(['two', 'three']);
      expect(second.next_cursor).toBeNull();
      const malformed = await get(`/resources/issue/${issueId}?cursor=${Buffer.from(JSON.stringify(['not-a-time', randomUUID()])).toString('base64url')}`, { member: READER_ALL });
      expect([malformed.status, malformed.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('pages the list newest first and answers the page after the cursor', async () => {
      const page = (await get('/resources/issue?limit=2', { member: READER_ALL })).json;
      const items = page.items as Array<{ code: string }>;
      expect(items).toHaveLength(2);
      expect((items[0]?.code ?? '') > (items[1]?.code ?? '')).toBe(true);
      const next = (await get(`/resources/issue?limit=2&cursor=${page.next_cursor as string}`, { member: READER_ALL })).json.items as Array<{ code: string }>;
      expect((next[0]?.code ?? '') < (items[1]?.code ?? '')).toBe(true);
      expect(Number.isNaN(Date.parse(page.as_of as string))).toBe(false);
      expect((await get('/resources/issue?limit=0', { member: READER_ALL })).status).toBe(422);
    });
  });

  it('keeps an issue of tenant A out of tenant B in the database itself', async () => {
    const issueId = idOf(await open());
    expect(await rows('select id from machvon.issue where id = $1::uuid', [issueId], TENANT_B)).toEqual([]);
    expect(await rows('select id from machvon.issue_event where issue_id = $1::uuid', [issueId], TENANT_B)).toEqual([]);
  });
});
