import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { IssIssueClosureController } from '../../src/modules/iss/iss-issue-closure.controller';
import { IssIssueController } from '../../src/modules/iss/iss-issue.controller';
import { IssIssueReadsController } from '../../src/modules/iss/iss-issue-reads.controller';
import { AuthzHarness, TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const REPORTER = 1; // issue.create, issue.read in unit 1
const ASSIGNER = 2; // issue.assign, issue.read in unit 1
const HANDLER = 3; // issue.work, issue.close, issue.extend, issue.read in unit 1: may do everything, so the independence rules are what stops them
const VERIFIER = 4; // issue.close, issue.reopen, issue.read in unit 1
const EXTENDER = 5; // issue.extend, issue.read in unit 1
const ELSEWHERE = 6; // issue.close, issue.extend, issue.read in unit 2
const FAMILY = 0x7c;
const PROJECT = id(FAMILY, 1);
const DOCUMENT_CLEAN = id(FAMILY, 3);
const DOCUMENT_PENDING = id(FAMILY, 4);
const UNIT_1 = unitId(1);
const MINUTE_MS = 60_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

describe('requestIssueVerification, closeIssue, reopenIssue and extendIssueDeadline (ST-ISS-003)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let category = '';
  let counter = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function post(url: string, options: { member: number; body?: unknown; key?: string; ifMatch?: number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json', 'idempotency-key': options.key ?? `key-${randomUUID()}` };
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method: 'POST', headers, body: JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
  }
  async function get(url: string, member: number): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(member) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
  }
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const audits = (issueId: string) => rows<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id = $1::uuid order by seq', [issueId]);
  const outbox = (issueId: string) => rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1::uuid order by created_at, id', [issueId]);
  const versionOf = async (issueId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.issue where id = $1::uuid', [issueId]))[0]?.version);

  /** An issue in IN_PROGRESS under HANDLER (version 3), through the commands. */
  async function working(): Promise<string> {
    counter += 1;
    const created = await post('/issues', {
      member: REPORTER,
      body: { project_id: PROJECT, category_version_id: category, severity: 'HIGH', title: `Plot ${counter} handover blocked`, description: 'The compensation is not agreed', owner_unit_id: UNIT_1, client_operation_id: randomUUID() },
    });
    const issueId = created.json.resource_id as string;
    expect((await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 1, body: { assignee_id: memberId(HANDLER) } })).status).toBe(200);
    expect((await post(`/issues/${issueId}/start`, { member: HANDLER, ifMatch: 2, body: {} })).status).toBe(200);
    return issueId;
  }
  const requestVerification = (issueId: string, version: number, evidence: string[] = [DOCUMENT_CLEAN], member = HANDLER): Promise<Reply> =>
    post(`/issues/${issueId}/request-verification`, { member, ifMatch: version, body: { result_note: 'The compensation was paid and the plot handed over', evidence_document_version_ids: evidence } });
  const close = (issueId: string, version: number, member = VERIFIER, key?: string): Promise<Reply> =>
    post(`/issues/${issueId}/close`, { member, ifMatch: version, body: { verification_note: 'Checked on the site' }, ...(key === undefined ? {} : { key }) });

  beforeAll(async () => {
    await harness.start();
    const thisYear = new Date().getUTCFullYear();
    for (const n of [1, 2]) await harness.seedUnits(TENANT_A, [{ n, path: `/${unitId(n)}/` }]);
    await harness.owner(
      TENANT_A,
      [thisYear - 1, thisYear, thisYear + 1].map((year, index): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
        [TENANT_A, id(0x72, 1 + index), year, memberId(1)],
      ]),
    );
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-ISS-3', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, UNIT_1, id(FAMILY, 20)],
      );
      await client.query(
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CV', 'Evidence', 'INTERNAL', $3, $3)`,
        [TENANT_A, id(FAMILY, 21), memberId(1)],
      );
      await client.query(
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $4, 1, 'tenants/iss/clean.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $3, $4, 2, 'tenants/iss/pending.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, DOCUMENT_CLEAN, DOCUMENT_PENDING, id(FAMILY, 21)],
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
    for (const n of [REPORTER, ASSIGNER, HANDLER, VERIFIER, EXTENDER, ELSEWHERE]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'CREATOR', ['issue.create', 'issue.read'], 20);
    await harness.seedRole(TENANT_A, 2, 'ASSIGNER', ['issue.assign', 'issue.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'HANDLER', ['issue.work', 'issue.close', 'issue.extend', 'issue.read'], 30);
    await harness.seedRole(TENANT_A, 4, 'VERIFIER', ['issue.close', 'issue.reopen', 'issue.read'], 30);
    await harness.seedRole(TENANT_A, 5, 'EXTENDER', ['issue.extend', 'issue.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: REPORTER, role: 1, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 2, member: ASSIGNER, role: 2, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 3, member: HANDLER, role: 3, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 4, member: VERIFIER, role: 4, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 5, member: EXTENDER, role: 5, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 6, member: ELSEWHERE, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 7, member: ELSEWHERE, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    // ELSEWHERE reads every issue of the tenant but acts in unit 2 only (a 403, not a 404).
    await harness.seedRole(TENANT_A, 6, 'READ_ALL', ['issue.read'], 10);
    await harness.seedGrants(TENANT_A, [{ n: 8, member: ELSEWHERE, role: 6, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [IssIssueController, IssIssueClosureController, IssIssueReadsController],
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

  describe('verification and closure (UAT-AC351)', () => {
    it('AC-ST-ISS-003-1: the handler cannot close what they worked; a different verifier closes it only with evidence, and the trail holds no notes', async () => {
      const issueId = await working();
      const noEvidence = await requestVerification(issueId, 3, []);
      expect([noEvidence.status, noEvidence.json.code]).toEqual([422, 'EVIDENCE_REQUIRED']);
      const pending = await requestVerification(issueId, 3, [DOCUMENT_PENDING]);
      expect([pending.status, pending.json.code]).toEqual([422, 'DOCUMENT_NOT_CLEAN']);
      expect((await requestVerification(issueId, 3, [DOCUMENT_CLEAN], REPORTER)).status).toBe(403);
      const asked = await requestVerification(issueId, 3);
      expect(asked.status).toBe(200);
      expect(asked.json).toMatchObject({ status: 'PENDING_VERIFICATION', resource_version: 4 });
      // X worked it: X gets 403 SELF_APPROVAL_DENIED even though X holds the permission.
      const self = await close(issueId, 4, HANDLER);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await versionOf(issueId)).toBe(4);
      const outside = await close(issueId, 4, ELSEWHERE);
      expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const closed = await close(issueId, 4);
      expect(closed.status).toBe(200);
      expect(closed.json).toMatchObject({ status: 'CLOSED', resource_version: 5 });
      expect(await rows('select status, closed_by, verifier_id, extension_count from machvon.issue where id = $1::uuid', [issueId])).toEqual([
        { status: 'CLOSED', closed_by: memberId(VERIFIER), verifier_id: memberId(VERIFIER), extension_count: 0 },
      ]);
      expect((await audits(issueId)).map((entry) => entry.action)).toEqual(['iss.issue_opened', 'iss.issue_assigned', 'iss.issue_started', 'iss.issue_verification_requested', 'iss.issue_closed']);
      expect((await outbox(issueId)).map((event) => event.type)).toEqual([
        'iss.issue.opened.v1',
        'iss.issue.assigned.v1',
        'iss.issue.started.v1',
        'iss.issue.verification_requested.v1',
        'iss.issue.closed.v1',
      ]);
      expect((await outbox(issueId)).at(-1)?.payload).toMatchObject({ issue_id: issueId, status: 'CLOSED', verifier_id: memberId(VERIFIER), version: 5 });
      const everything = JSON.stringify([await audits(issueId), await outbox(issueId)]);
      for (const secret of ['compensation', 'Checked on the site', 'handed over']) expect(everything).not.toContain(secret);
    });

    it('AC-ST-ISS-003-3, AC-ST-CTR-013-2, UAT-AC397: the same close command sent again returns the first answer without a second audit row or event; the same key with another body is a conflict; a new key is an invalid state', async () => {
      const issueId = await working();
      expect((await requestVerification(issueId, 3)).status).toBe(200);
      const first = await close(issueId, 4, VERIFIER, 'close-key-00000000001');
      const again = await close(issueId, 4, VERIFIER, 'close-key-00000000001');
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(again.json).toEqual(first.json);
      const changed = await post(`/issues/${issueId}/close`, { member: VERIFIER, ifMatch: 4, body: { verification_note: 'Another note than the first' }, key: 'close-key-00000000001' });
      expect([changed.status, changed.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect((await audits(issueId)).filter((entry) => entry.action === 'iss.issue_closed')).toHaveLength(1);
      expect((await outbox(issueId)).filter((event) => event.type === 'iss.issue.closed.v1')).toHaveLength(1);
      const fresh = await close(issueId, 5, VERIFIER, 'close-key-00000000002');
      expect([fresh.status, fresh.json.code]).toEqual([409, 'ISSUE_STATE_INVALID']);
      expect((await audits(issueId)).filter((entry) => entry.action === 'iss.issue_closed')).toHaveLength(1);
    });

    it('lets the verifier give the result back with assignIssue and the reason, and shows the refusal in the timeline', async () => {
      const issueId = await working();
      expect((await requestVerification(issueId, 3)).status).toBe(200);
      const noReason = await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 4, body: { assignee_id: memberId(HANDLER) } });
      expect([noReason.status, noReason.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const given = await post(`/issues/${issueId}/assign`, { member: ASSIGNER, ifMatch: 4, body: { assignee_id: memberId(HANDLER), note: 'The photos do not show the fence' } });
      expect(given.json).toMatchObject({ status: 'ASSIGNED' });
      const read = await get(`/resources/issue/${issueId}`, ASSIGNER);
      const events = read.json.events as Array<{ kind: string; payload: Record<string, unknown>; note: string | null }>;
      expect(events.at(-1)).toMatchObject({ kind: 'REASSIGNED', note: 'The photos do not show the fence', payload: { outcome: 'VERIFICATION_REFUSED' } });
      expect(events.find((event) => event.kind === 'VERIFICATION_REQUESTED')?.payload).toEqual({ evidence_document_version_ids: [DOCUMENT_CLEAN] });
    });
  });

  describe('reopening', () => {
    it('reopens within the window, counts it and refuses once the window has passed', async () => {
      const issueId = await working();
      expect((await requestVerification(issueId, 3)).status).toBe(200);
      expect((await close(issueId, 4)).status).toBe(200);
      const reopened = await post(`/issues/${issueId}/reopen`, { member: VERIFIER, ifMatch: 5, body: { reason: 'The fence fell again' } });
      expect(reopened.json).toMatchObject({ status: 'REOPENED', resource_version: 6 });
      expect(await rows('select reopen_count, closed_at from machvon.issue where id = $1::uuid', [issueId])).toEqual([{ reopen_count: 1, closed_at: null }]);
      expect((await outbox(issueId)).at(-1)).toMatchObject({ type: 'iss.issue.reopened.v1', payload: { reopen_count: 1, status: 'REOPENED' } });
      expect((await audits(issueId)).at(-1)?.action).toBe('iss.issue_reopened');
      // Another closed issue whose closing is 31 days old.
      const old = await working();
      expect((await requestVerification(old, 3)).status).toBe(200);
      expect((await close(old, 4)).status).toBe(200);
      await rows("update machvon.issue set closed_at = now() - interval '31 days' where id = $1::uuid", [old]);
      const late = await post(`/issues/${old}/reopen`, { member: VERIFIER, ifMatch: 5, body: { reason: 'Too late' } });
      expect([late.status, late.json.code]).toEqual([422, 'REOPEN_WINDOW_EXPIRED']);
      const notClosed = await post(`/issues/${issueId}/reopen`, { member: VERIFIER, ifMatch: 6, body: { reason: 'Again' } });
      expect([notClosed.status, notClosed.json.code]).toEqual([409, 'ISSUE_STATE_INVALID']);
    });
  });

  describe('extending the deadline (UAT-AC353)', () => {
    const dueOf = async (issueId: string): Promise<Date> => (await rows<{ due_at: Date }>('select due_at from machvon.issue where id = $1::uuid', [issueId]))[0]?.due_at as Date;
    const extend = (issueId: string, version: number, newDueAt: Date, member = EXTENDER): Promise<Reply> =>
      post(`/issues/${issueId}/extend`, { member, ifMatch: version, body: { new_due_at: newDueAt.toISOString(), reason: 'The landowner asked for time' } });

    it('AC-ST-ISS-003-2: the handler cannot approve their own extension; an independent person extends twice, the third is refused, and the trail names the approver', async () => {
      const issueId = await working();
      const due = await dueOf(issueId);
      const later = new Date(due.getTime() + MINUTE_MS);
      const self = await extend(issueId, 3, later, HANDLER);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const first = await extend(issueId, 3, later);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ resource_version: 4 });
      expect((await dueOf(issueId)).toISOString()).toBe(later.toISOString());
      expect((await extend(issueId, 4, new Date(later.getTime() + MINUTE_MS))).status).toBe(200);
      const third = await extend(issueId, 5, new Date(later.getTime() + 2 * MINUTE_MS));
      expect([third.status, third.json.code]).toEqual([422, 'EXTENSION_LIMIT_REACHED']);
      expect((await audits(issueId)).filter((entry) => entry.action === 'iss.issue_extended')).toHaveLength(2);
      const events = (await outbox(issueId)).filter((event) => event.type === 'iss.issue.extended.v1');
      expect(events).toHaveLength(2);
      expect(events[0]?.payload).toMatchObject({ previous_due_at: due.toISOString(), extension_count: 1, actor_id: memberId(EXTENDER) });
      const read = await get(`/resources/issue/${issueId}`, EXTENDER);
      expect(read.json.extensions).toEqual({ used: 2, limit: 2 });
      expect(read.json.reopen_window_days).toBe(30);
      const timeline = read.json.events as Array<{ kind: string; note: string | null; payload: Record<string, unknown>; actor: { membership_id: string } | null }>;
      const extended = timeline.filter((event) => event.kind === 'EXTENDED');
      expect(extended.map((event) => event.actor?.membership_id)).toEqual([memberId(EXTENDER), memberId(EXTENDER)]);
      expect(extended[0]?.payload).toMatchObject({ extension_number: 1, extension_limit: 2 });
    });

    it('refuses a date that is not later, one beyond the longest extension, and an extension outside the scope of the caller', async () => {
      const issueId = await working();
      const due = await dueOf(issueId);
      const same = await extend(issueId, 3, due);
      expect([same.status, same.json.code, same.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'new_due_at']);
      const farAway = await extend(issueId, 3, new Date(due.getTime() + 400 * 24 * 60 * MINUTE_MS));
      expect([farAway.status, farAway.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const outside = await extend(issueId, 3, new Date(due.getTime() + MINUTE_MS), ELSEWHERE);
      expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const stale = await extend(issueId, 2, new Date(due.getTime() + MINUTE_MS));
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    });
  });
});
