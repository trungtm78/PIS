import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { addDirectiveDays, loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { dirModule } from '../../src/modules/dir';
import { DirectiveController, SteeringMeetingController } from '../../src/modules/dir/directive.controller';
import { DirectiveReadsController, SteeringMeetingReadsController } from '../../src/modules/dir/directive-reads.controller';
import { MODULES } from '../../src/modules/registry';
import { BQL1, CapWorld, ROOT } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xd2;
const SECRETARY = 21; // directive.meeting.manage, directive.manage, directive.close, directive.read: records the meeting, gives and chases the directives
const ASSIGNEE = 22; // directive.progress, directive.read: the person a directive is given to
const CLOSER = 23; // directive.close, directive.read: a third person
const DECIDER = 24; // directive.extension.decide, directive.read
const READER = 25; // directive.read
const NOBODY = 26;
const OUTSIDER = 27; // directive.read on another unit only: reaches nothing
const DUAL = 28; // may note progress and decide: refused the decision of a request they made
const MEMBERS = [SECRETARY, ASSIGNEE, CLOSER, DECIDER, READER, NOBODY, OUTSIDER, DUAL];
const TODAY = vietnamDateOf(new Date());
const DAY = (offset: number): string => addDirectiveDays(TODAY, offset);
const REASON = 'The steering meeting asked for more time.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** A line of a list as the contract gives it: the fields the tests read, and the rest as they come. */
interface Item {
  id: string;
  status: string;
  phase: string;
  meeting_date: string;
  [field: string]: unknown;
}

describe('the directives of the steering meetings over HTTP (governance deepening, lane DIR-1: CN.03, QT.02)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let project = '';
  let otherProject = '';
  let version = '';
  let infected = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 and outcome = $3 order by occurred_at', [resourceId, action, 'SUCCESS']);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const items = (reply: Reply): Item[] => reply.json.items as Item[];

  async function meeting(body: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
    const made = await call('POST', '/steering-meetings', { member: SECRETARY, body: { meeting_date: DAY(-30), meeting_type: 'WEEKLY', title: 'Giao ban tuần về giải ngân', unit_id: unitId(ROOT), ...body } });
    expect(made.status).toBe(200);
    return { id: made.json.resource_id as string, code: made.json.code as string };
  }

  async function directive(meetingId: string, body: Record<string, unknown> = {}): Promise<{ id: string; code: string; version: number }> {
    const made = await call('POST', `/steering-meetings/${meetingId}/directives`, {
      member: SECRETARY,
      body: { scope_kind: 'PROJECT', project_id: project, text: 'Hoàn thành thủ tục giải phóng mặt bằng.', assignee_unit_id: unitId(BQL1), assignee_membership_id: memberId(ASSIGNEE), due_on: DAY(10), ...body },
    });
    expect(made.status).toBe(200);
    return { id: made.json.resource_id as string, code: made.json.code as string, version: made.json.resource_version as number };
  }

  beforeAll(async () => {
    await world.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedUnits(TENANT_A, [{ n: 60, path: `/${unitId(ROOT)}/${unitId(60)}/`, parent: ROOT }]);
    project = await world.project();
    otherProject = await world.project({ unitNumber: ROOT });
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'DIR_SECRETARY', ['directive.meeting.manage', 'directive.manage', 'directive.close', 'directive.read'], 30],
      [2, 'DIR_ASSIGNEE', ['directive.progress', 'directive.read'], 20],
      [3, 'DIR_CLOSER', ['directive.close', 'directive.read'], 40],
      [4, 'DIR_DECIDER', ['directive.extension.decide', 'directive.read'], 40],
      [5, 'DIR_READER', ['directive.read'], 10],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 80 + n, code, permissions, rank);
    const tenantWide = (n: number, member: number, role: number) => ({ n, member, role: 80 + role, kind: 'TENANT' as const });
    await harness.seedGrants(TENANT_A, [
      tenantWide(1, SECRETARY, 1),
      tenantWide(2, ASSIGNEE, 2),
      tenantWide(3, CLOSER, 3),
      tenantWide(4, DECIDER, 4),
      tenantWide(5, READER, 5),
      { n: 6, member: OUTSIDER, role: 85, kind: 'UNIT_ONLY' as const, refs: [unitId(60)] },
    ]);
    version = id(FAMILY, 10);
    infected = id(FAMILY, 12);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Biên bản', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(READER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/dir/minutes-1.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, version, id(FAMILY, 11)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 2, 'tenants/dir/minutes-2.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'INFECTED', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, infected, id(FAMILY, 11)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [SteeringMeetingController, SteeringMeetingReadsController, DirectiveController, DirectiveReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the modules of the API under its own code', () => {
    expect(MODULES).toContain(dirModule);
    expect(dirModule.code).toBe('DIR');
    expect(dirModule.controllers).toEqual(expect.arrayContaining([SteeringMeetingController, SteeringMeetingReadsController, DirectiveController, DirectiveReadsController]));
  });

  describe('the meeting', () => {
    it('is recorded, audited, replayed once on the same key, and refuses a day to come, a field that is not allowed, an infected file and whoever lacks the right', async () => {
      const body = { meeting_date: DAY(-3), meeting_type: 'MONTHLY', title: 'Giao ban tháng', summary: 'Rà soát tiến độ giải ngân.', unit_id: unitId(ROOT), minutes_document_version_id: version };
      const key = `meeting-${randomUUID()}`;
      const made = await call('POST', '/steering-meetings', { member: SECRETARY, body, key });
      expect(made).toMatchObject({ status: 200, json: { status: 'RECORDED', resource_version: 1 } });
      expect(String(made.json.code)).toMatch(/^GB-\d{4}-\d{3}$/);
      const meetingId = made.json.resource_id as string;
      const again = await call('POST', '/steering-meetings', { member: SECRETARY, body, key });
      expect(again).toMatchObject({ status: 200, json: { resource_id: meetingId, code: made.json.code } });
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.steering_meeting where id = $1::uuid', [meetingId]))[0]?.n).toBe('1');
      expect((await call('POST', '/steering-meetings', { member: SECRETARY, body: { ...body, title: 'Khác' }, key })).status).toBe(409);
      expect((await audits(meetingId, 'directive.meeting_created'))[0]).toMatchObject({ actor_id: memberId(SECRETARY), safe_diff: { code: made.json.code, unit_id: unitId(ROOT), meeting_type: 'MONTHLY', meeting_date: DAY(-3) } });
      expect((await events(meetingId, 'directive.meeting_created.v1'))[0]?.payload).toMatchObject({ meeting_id: meetingId, code: made.json.code, actor_id: memberId(SECRETARY) });

      expect(await call('POST', '/steering-meetings', { member: SECRETARY, body: { ...body, meeting_date: DAY(1) } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await call('POST', '/steering-meetings', { member: SECRETARY, body: { ...body, tenant_id: TENANT_A } })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect((await call('POST', '/steering-meetings', { member: SECRETARY, body: { ...body, meeting_type: 'DAILY' } })).status).toBeGreaterThanOrEqual(400);
      expect(await call('POST', '/steering-meetings', { member: SECRETARY, body: { ...body, minutes_document_version_id: infected } })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
      expect((await call('POST', '/steering-meetings', { member: NOBODY, body })).status).toBe(403);
      expect((await call('POST', '/steering-meetings', { member: ASSIGNEE, body })).status).toBe(403);
      expect((await call('POST', '/steering-meetings', { member: READER, body })).status).toBe(403);
    });

    it('attaches the minutes with the version of the meeting', async () => {
      const held = await meeting();
      expect(await call('POST', `/steering-meetings/${held.id}/minutes`, { member: SECRETARY, ifMatch: '"1"', body: { document_version_id: version } })).toMatchObject({ status: 200, json: { status: 'MINUTES_ATTACHED', resource_version: 2 } });
      expect(await call('POST', `/steering-meetings/${held.id}/minutes`, { member: SECRETARY, ifMatch: '"1"', body: { document_version_id: version } })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await call('POST', `/steering-meetings/${held.id}/minutes`, { member: SECRETARY, body: { document_version_id: version } })).status).toBeGreaterThanOrEqual(400);
      expect((await call('POST', `/steering-meetings/${held.id}/minutes`, { member: NOBODY, ifMatch: '"2"', body: { document_version_id: version } })).status).toBe(403);
      expect((await call('POST', `/steering-meetings/${randomUUID()}/minutes`, { member: SECRETARY, ifMatch: '"1"', body: { document_version_id: version } })).status).toBe(404);
      expect((await audits(held.id, 'directive.meeting_minutes_attached'))[0]).toMatchObject({ safe_diff: { minutes_document_version_id: version, version: 2 } });
    });
  });

  describe('giving a directive', () => {
    it('is given about a project, audited and put on the outbox, and refuses what the meeting and the scope do not allow', async () => {
      const held = await meeting();
      const body = { scope_kind: 'PROJECT', project_id: project, text: 'Hoàn thành thủ tục giải phóng mặt bằng.', assignee_unit_id: unitId(BQL1), assignee_membership_id: memberId(ASSIGNEE), due_on: DAY(10) };
      const key = `directive-${randomUUID()}`;
      const given = await call('POST', `/steering-meetings/${held.id}/directives`, { member: SECRETARY, body, key });
      expect(given).toMatchObject({ status: 200, json: { status: 'OPEN', resource_version: 1, code: `${held.code}/CD-01`, due_on: DAY(10) } });
      const directiveId = given.json.resource_id as string;
      expect(await call('POST', `/steering-meetings/${held.id}/directives`, { member: SECRETARY, body, key })).toMatchObject({ status: 200, json: { resource_id: directiveId } });
      expect((await call('POST', `/steering-meetings/${held.id}/directives`, { member: SECRETARY, body })).json.code).toBe(`${held.code}/CD-02`);
      expect((await audits(directiveId, 'directive.created'))[0]).toMatchObject({ actor_id: memberId(SECRETARY), safe_diff: { project_id: project, meeting_id: held.id, due_on: DAY(10), assignee_unit_id: unitId(BQL1), scope_kind: 'PROJECT' } });
      expect((await audits(directiveId, 'directive.created'))[0]?.safe_diff).not.toHaveProperty('text');
      expect((await events(directiveId, 'directive.created.v1'))[0]?.payload).toMatchObject({ directive_id: directiveId, code: `${held.code}/CD-01`, actor_id: memberId(SECRETARY), due_on: DAY(10) });

      const post = (changes: Record<string, unknown>, member = SECRETARY) => call('POST', `/steering-meetings/${held.id}/directives`, { member, body: { ...body, ...changes } });
      expect(await post({ due_on: DAY(-31) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await post({ scope_kind: 'UNIT', unit_id: unitId(BQL1) })).toMatchObject({ status: 422 });
      expect((await post({ scope_kind: 'UNIT', project_id: undefined, unit_id: unitId(BQL1) })).status).toBe(200);
      expect(await post({ assignee_membership_id: randomUUID() })).toMatchObject({ status: 422 });
      expect(await post({ project_id: randomUUID() })).toMatchObject({ status: 422 });
      expect(await post({ owner: 'x' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect((await post({}, NOBODY)).status).toBe(403);
      expect((await post({}, ASSIGNEE)).status).toBe(403);
      expect((await call('POST', `/steering-meetings/${randomUUID()}/directives`, { member: SECRETARY, body })).status).toBe(404);
    });
  });

  describe('following a directive to its close', () => {
    it('goes through progress, a request for time that someone else decides, and a close by a third person with evidence; every step is audited and the timeline keeps it', async () => {
      const held = await meeting();
      const given = await directive(held.id, { due_on: DAY(5) });
      const url = (suffix: string) => `/directives/${given.id}/${suffix}`;

      // Progress is the assignee's: the first note takes the directive to in progress; a person with no right is refused.
      expect(await call('POST', url('progress'), { member: ASSIGNEE, body: { note: 'Đã gửi hồ sơ cho sở.', progress_pct: 30, evidence_document_version_ids: [version] } })).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
      expect((await call('POST', url('progress'), { member: NOBODY, body: { note: 'x' } })).status).toBe(403);
      expect((await call('POST', url('progress'), { member: READER, body: { note: 'x' } })).status).toBe(403);
      expect(await call('POST', url('progress'), { member: ASSIGNEE, body: { note: 'x', evidence_document_version_ids: [infected] } })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
      expect((await call('POST', url('progress'), { member: ASSIGNEE, body: { note: 'x', progress_pct: 101 } })).status).toBeGreaterThanOrEqual(400);
      expect((await audits(given.id, 'directive.progress_recorded'))[0]).toMatchObject({ actor_id: memberId(ASSIGNEE), reason: 'Đã gửi hồ sơ cho sở.', safe_diff: { progress_pct: 30, evidence_count: 1 } });

      // A request for time: within the days of the policy, one at a time.
      expect(await call('POST', url('extension-requests'), { member: ASSIGNEE, body: { proposed_due_on: DAY(5), reason: REASON } })).toMatchObject({ status: 422, json: { code: 'DIRECTIVE_EXTENSION_INVALID' } });
      expect(await call('POST', url('extension-requests'), { member: ASSIGNEE, body: { proposed_due_on: DAY(70), reason: REASON } })).toMatchObject({ status: 422, json: { code: 'DIRECTIVE_EXTENSION_INVALID' } });
      const asked = await call('POST', url('extension-requests'), { member: ASSIGNEE, body: { proposed_due_on: DAY(20), reason: REASON } });
      expect(asked).toMatchObject({ status: 200, json: { status: 'EXTENSION_REQUESTED' } });
      const extensionId = asked.json.extension_id as string;
      expect(await call('POST', url('extension-requests'), { member: ASSIGNEE, body: { proposed_due_on: DAY(25), reason: REASON } })).toMatchObject({ status: 409, json: { code: 'DIRECTIVE_EXTENSION_PENDING' } });
      expect((await call('POST', url('extension-requests'), { member: NOBODY, body: { proposed_due_on: DAY(25), reason: REASON } })).status).toBe(403);

      // The decision is someone else's, with the version of the request; it moves the due day.
      const decide = (member: number, ifMatch = '"1"', decision = 'approve') => call('POST', `/directive-extensions/${extensionId}/decision`, { member, ifMatch, body: { decision, reason: 'Đã xem xét và đồng ý.' } });
      expect((await decide(NOBODY)).status).toBe(403);
      expect((await decide(ASSIGNEE)).status).toBe(403);
      expect(await decide(DECIDER, '"9"')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await decide(DECIDER, '"1"', 'maybe')).status).toBeGreaterThanOrEqual(400);
      const decided = await decide(DECIDER);
      expect(decided).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2, due_on: DAY(20), extension_id: extensionId } });
      expect(await decide(DECIDER, '"2"')).toMatchObject({ status: 409, json: { code: 'DIRECTIVE_EXTENSION_STATE_INVALID' } });
      expect((await audits(extensionId, 'directive.extension_approved'))[0]).toMatchObject({ actor_id: memberId(DECIDER), safe_diff: { directive_id: given.id, due_on: DAY(20) } });
      expect((await events(extensionId, 'directive.extension_decided.v1'))[0]?.payload).toMatchObject({ directive_id: given.id, decision: 'approve', actor_id: memberId(DECIDER) });

      // The same person cannot decide their own request: a secretary who also may decide is refused the decision of a request they made.
      await harness.seedRole(TENANT_A, 90, 'DIR_BOTH', ['directive.progress', 'directive.extension.decide', 'directive.read'], 20);
      await harness.seedGrants(TENANT_A, [{ n: 20, member: DUAL, role: 90, kind: 'TENANT' }]);
      const own = await call('POST', url('extension-requests'), { member: DUAL, body: { proposed_due_on: DAY(30), reason: REASON } });
      expect(own.status).toBe(200);
      expect(await call('POST', `/directive-extensions/${own.json.extension_id as string}/decision`, { member: DUAL, ifMatch: '"1"', body: { decision: 'approve', reason: 'Tự duyệt.' } })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await call('POST', `/directive-extensions/${own.json.extension_id as string}/decision`, { member: DECIDER, ifMatch: '"1"', body: { decision: 'reject', reason: 'Đủ thời gian.' } })).json.status).toBe('REJECTED');

      // Closing: not the person who recorded it, not without evidence, with the version.
      const current = async (): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.directive where id = $1::uuid', [given.id]))[0]?.version);
      const close = async (member: number, body: Record<string, unknown>, ifMatch?: string) => call('POST', url('closure'), { member, ifMatch: ifMatch ?? `"${await current()}"`, body });
      expect(await close(SECRETARY, { note: 'Xong.', evidence_document_version_ids: [version] })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await close(NOBODY, { note: 'Xong.', evidence_document_version_ids: [version] })).status).toBe(403);
      expect((await close(ASSIGNEE, { note: 'Xong.', evidence_document_version_ids: [version] })).status).toBe(403);
      expect(await close(CLOSER, { note: 'Xong.', evidence_document_version_ids: [infected] })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
      expect(await close(CLOSER, { note: 'Xong.', evidence_document_version_ids: [version] }, '"1"')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const closed = await close(CLOSER, { note: 'Đã bàn giao mặt bằng, có biên bản.', evidence_document_version_ids: [version] });
      expect(closed).toMatchObject({ status: 200, json: { status: 'DONE' } });
      expect((await audits(given.id, 'directive.closed'))[0]).toMatchObject({ actor_id: memberId(CLOSER), reason: 'Đã bàn giao mặt bằng, có biên bản.' });
      expect((await events(given.id, 'directive.closed.v1'))[0]?.payload).toMatchObject({ status: 'DONE', actor_id: memberId(CLOSER) });
      expect(await close(CLOSER, { note: 'Lần nữa.', evidence_document_version_ids: [version] })).toMatchObject({ status: 409, json: { code: 'DIRECTIVE_STATE_INVALID' } });

      const detail = await call('GET', `/directives/${given.id}`, { member: READER });
      expect(detail.status).toBe(200);
      expect((detail.json.timeline as Array<{ type: string }>).map((event) => event.type)).toEqual(['CREATED', 'PROGRESS', 'EXTENSION_REQUESTED', 'EXTENSION_APPROVED', 'EXTENSION_REQUESTED', 'EXTENSION_REJECTED', 'CLOSED']);
    });

    it('cancels with a reason and reopens a cancelled directive to open and a done one to in progress; each is audited and takes the version', async () => {
      const held = await meeting();
      const given = await directive(held.id);
      expect((await call('POST', `/directives/${given.id}/reopening`, { member: SECRETARY, ifMatch: '"1"', body: { reason: 'Mở lại.' } })).status).toBe(409);
      expect((await call('POST', `/directives/${given.id}/cancellation`, { member: NOBODY, ifMatch: '"1"', body: { reason: REASON } })).status).toBe(403);
      expect((await call('POST', `/directives/${given.id}/cancellation`, { member: CLOSER, ifMatch: '"1"', body: { reason: REASON } })).status).toBe(403);
      expect(await call('POST', `/directives/${given.id}/cancellation`, { member: SECRETARY, ifMatch: '"7"', body: { reason: REASON } })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await call('POST', `/directives/${given.id}/cancellation`, { member: SECRETARY, ifMatch: '"1"', body: { reason: 'Dự án đã dừng.' } })).toMatchObject({ status: 200, json: { status: 'CANCELLED', resource_version: 2 } });
      expect((await audits(given.id, 'directive.cancelled'))[0]).toMatchObject({ reason: 'Dự án đã dừng.' });
      expect(await call('POST', `/directives/${given.id}/reopening`, { member: SECRETARY, ifMatch: '"2"', body: { reason: 'Dự án tiếp tục.' } })).toMatchObject({ status: 200, json: { status: 'OPEN', resource_version: 3 } });
      expect((await audits(given.id, 'directive.reopened'))[0]).toBeDefined();
      expect((await events(given.id, 'directive.reopened.v1'))[0]?.payload).toMatchObject({ status: 'OPEN' });
    });

    it('gives the directive to another unit and person with the version, and refuses nothing to change', async () => {
      const held = await meeting();
      const given = await directive(held.id);
      expect(await call('POST', `/directives/${given.id}/assignment`, { member: SECRETARY, ifMatch: '"1"', body: {} })).toMatchObject({ status: 422 });
      expect(await call('POST', `/directives/${given.id}/assignment`, { member: SECRETARY, ifMatch: '"1"', body: { assignee_unit_id: unitId(ROOT), assignee_membership_id: null, note: 'Giao đơn vị pháp lý.' } })).toMatchObject({ status: 200, json: { resource_version: 2, code: given.code } });
      expect((await audits(given.id, 'directive.assigned'))[0]).toMatchObject({ reason: 'Giao đơn vị pháp lý.', safe_diff: { assignee_unit_id: unitId(ROOT) } });
      expect((await call('POST', `/directives/${given.id}/assignment`, { member: NOBODY, ifMatch: '"2"', body: { assignee_unit_id: unitId(BQL1) } })).status).toBe(403);
      expect((await call('GET', `/directives/${given.id}`, { member: READER })).json).toMatchObject({ directive: { assignee: null, assignee_unit: { id: unitId(ROOT) } } });
    });
  });

  describe('reading', () => {
    it('lists the directives with the late first, pages by cursor, filters, and gives the buttons of the caller on one directive', async () => {
      const held = await meeting({ meeting_date: DAY(-40), title: 'Giao ban đọc' });
      const late = await directive(held.id, { due_on: DAY(-10), text: 'Chỉ đạo quá hạn về nghiệm thu.' });
      const soon = await directive(held.id, { due_on: DAY(2), text: 'Chỉ đạo sắp đến hạn về quyết toán.' });
      const far = await directive(held.id, { due_on: DAY(60), project_id: otherProject, assignee_unit_id: unitId(ROOT), assignee_membership_id: undefined, text: 'Chỉ đạo xa.' });

      const all = await call('GET', `/directives?meeting_id=${held.id}`, { member: READER });
      expect(all.status).toBe(200);
      expect(items(all).map((item) => item.id)).toEqual([late.id, soon.id, far.id]);
      expect(items(all)[0]).toMatchObject({ code: late.code, status: 'OVERDUE', stored_status: 'OPEN', phase: 'ESCALATED', overdue_days: 10, due_on: DAY(-10), original_due_on: DAY(-10), assignee: { display_name: `User ${ASSIGNEE}` }, project: { id: project } });
      expect(items(all)[1]).toMatchObject({ status: 'OPEN', phase: 'DUE_SOON', days_to_due: 2, escalates_on: DAY(9) });
      expect(all.json.next_cursor).toBeNull();
      expect(typeof all.json.as_of).toBe('string');

      const first = await call('GET', `/directives?meeting_id=${held.id}&limit=2`, { member: READER });
      expect(items(first).map((item) => item.id)).toEqual([late.id, soon.id]);
      expect(typeof first.json.next_cursor).toBe('string');
      const second = await call('GET', `/directives?meeting_id=${held.id}&limit=2&cursor=${first.json.next_cursor as string}`, { member: READER });
      expect(items(second).map((item) => item.id)).toEqual([far.id]);
      expect(second.json.next_cursor).toBeNull();
      expect((await call('GET', '/directives?cursor=not-a-cursor', { member: READER })).status).toBe(422);

      expect(items(await call('GET', `/directives?meeting_id=${held.id}&status=OVERDUE`, { member: READER })).map((item) => item.id)).toEqual([late.id]);
      expect(items(await call('GET', `/directives?meeting_id=${held.id}&overdue=true`, { member: READER })).map((item) => item.id)).toEqual([late.id]);
      expect(items(await call('GET', `/directives?meeting_id=${held.id}&project_id=${otherProject}`, { member: READER })).map((item) => item.id)).toEqual([far.id]);
      expect(items(await call('GET', `/directives?meeting_id=${held.id}&q=quyết%20toán`, { member: READER })).map((item) => item.id)).toEqual([soon.id]);
      expect(items(await call('GET', `/directives?meeting_id=${held.id}&assigned_to_me=true`, { member: ASSIGNEE })).map((item) => item.id)).toEqual([late.id, soon.id]);
      expect(items(await call('GET', `/directives?meeting_id=${held.id}&unit_id=${unitId(BQL1)}&due_from=${DAY(0)}`, { member: READER })).map((item) => item.id)).toEqual([soon.id]);
      expect((await call('GET', '/directives?status=LATE', { member: READER })).status).toBe(422);
      expect((await call('GET', '/directives?overdue=maybe', { member: READER })).status).toBe(422);
      expect((await call('GET', '/directives?due_to=2026-13-40', { member: READER })).status).toBe(422);
      expect((await call('GET', '/directives', { member: NOBODY })).status).toBe(403);
      expect(items(await call('GET', `/directives?meeting_id=${held.id}`, { member: OUTSIDER }))).toEqual([]);

      const overdue = await call('GET', '/directives/overdue', { member: READER });
      expect(items(overdue).every((item) => item.status === 'OVERDUE')).toBe(true);
      expect(items(overdue).map((item) => item.id)).toContain(late.id);
      expect(items(await call('GET', `/projects/${project}/directives?status=OVERDUE`, { member: READER })).map((item) => item.id)).toContain(late.id);
      expect(items(await call('GET', `/projects/${otherProject}/directives`, { member: READER })).map((item) => item.id)).toContain(far.id);
      expect((await call('GET', `/projects/${randomUUID()}/directives`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/projects/${project}/directives`, { member: NOBODY })).status).toBe(403);

      // The buttons: the assignee notes progress and asks for time, but does not close (and cannot close their own); a third person closes; the one who recorded it does not.
      const buttons = async (member: number, directiveId: string): Promise<Record<string, boolean>> => ((await call('GET', `/directives/${directiveId}`, { member })).json.actions as Record<string, boolean>);
      expect(await buttons(READER, soon.id)).toEqual({ assign: false, record_progress: false, request_extension: false, decide_extension: false, close: false, cancel: false, reopen: false });
      expect(await buttons(ASSIGNEE, soon.id)).toMatchObject({ record_progress: true, request_extension: true, close: false, assign: false });
      expect(await buttons(CLOSER, soon.id)).toMatchObject({ close: true, record_progress: false });
      expect(await buttons(SECRETARY, soon.id)).toMatchObject({ assign: true, cancel: true, close: false, reopen: false });
      expect(await buttons(DECIDER, soon.id)).toMatchObject({ decide_extension: false });
      await call('POST', `/directives/${soon.id}/extension-requests`, { member: ASSIGNEE, body: { proposed_due_on: DAY(20), reason: REASON } });
      expect(await buttons(DECIDER, soon.id)).toMatchObject({ decide_extension: true });
      expect(await buttons(ASSIGNEE, soon.id)).toMatchObject({ decide_extension: false, request_extension: false });
      expect(await buttons(CLOSER, soon.id)).toMatchObject({ close: false });
    });

    it('reads one directive with its timeline, requests, evidence and the policy in force; a directive out of the scope or of nobody does not exist', async () => {
      const held = await meeting();
      const given = await directive(held.id);
      await call('POST', `/directives/${given.id}/progress`, { member: ASSIGNEE, body: { note: 'Đã có biên bản.', progress_pct: 50, evidence_document_version_ids: [version] } });
      const detail = await call('GET', `/directives/${given.id}`, { member: READER });
      expect(detail).toMatchObject({
        status: 200,
        json: {
          directive: { id: given.id, status: 'IN_PROGRESS', stored_status: 'IN_PROGRESS', evidence_count: 1, created_by: { display_name: `User ${SECRETARY}` }, meeting: { id: held.id } },
          policy: { code: 'DEFAULT', source: 'DEFAULT', version: null, unverified: true, reminder_days_before: [3, 1, 0], escalate_after_overdue_days: 7, max_extensions: 3, max_extension_days: 60, close_requires_evidence: true },
        },
      });
      expect((detail.json.timeline as Array<Record<string, unknown>>)[1]).toMatchObject({ type: 'PROGRESS', note: 'Đã có biên bản.', progress_pct: 50, actor: { display_name: `User ${ASSIGNEE}` } });
      expect(detail.json.evidence).toMatchObject([{ document_version_id: version, title: 'Biên bản' }]);
      expect((await call('GET', `/directives/${given.id}`, { member: OUTSIDER })).status).toBe(404);
      expect((await call('GET', `/directives/${given.id}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/directives/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', '/directives/not-an-id', { member: READER })).status).toBeGreaterThanOrEqual(400);
    });

    it('carries the latest progress that was reported on every line of the list, null when none was and never 0 (PWA-04, YCK.01)', async () => {
      const held = await meeting();
      const quiet = await directive(held.id);
      const worked = await directive(held.id);
      const listed = async (id: string): Promise<Record<string, unknown>> => {
        const page = await call('GET', `/directives?meeting_id=${held.id}`, { member: READER });
        return (page.json.items as Array<Record<string, unknown>>).find((item) => item.id === id) as Record<string, unknown>;
      };
      expect(await listed(worked.id)).toMatchObject({ progress_percent: null, progress_reported_at: null });
      await call('POST', `/directives/${worked.id}/progress`, { member: ASSIGNEE, body: { note: 'Bat dau.', progress_pct: 30, evidence_document_version_ids: [version] } });
      await call('POST', `/directives/${worked.id}/progress`, { member: ASSIGNEE, body: { note: 'Chi ghi chu, khong co ty le.' } });
      await call('POST', `/directives/${worked.id}/progress`, { member: ASSIGNEE, body: { note: 'Gan xong.', progress_pct: 80 } });
      const line = await listed(worked.id);
      expect(line.progress_percent).toBe(80);
      expect(typeof line.progress_reported_at).toBe('string');
      expect(await listed(quiet.id)).toMatchObject({ progress_percent: null, progress_reported_at: null });
      // The detail and the line of the meeting say the same thing as the list.
      const detail = await call('GET', `/directives/${worked.id}`, { member: READER });
      expect((detail.json.directive as Record<string, unknown>).progress_percent).toBe(80);
    });

    it('counts by status with the formula of each number, due soon, escalated and by unit, and the numbers add up to the list', async () => {
      const summary = await call('GET', '/directives/summary', { member: READER });
      expect(summary.status).toBe(200);
      const byStatus = summary.json.by_status as Record<string, number>;
      const listed = await call('GET', '/directives?limit=200', { member: READER });
      expect(Object.values(byStatus).reduce((sum, value) => sum + value, 0)).toBe(summary.json.total);
      expect(summary.json.total).toBe(items(listed).length);
      expect(byStatus.OVERDUE).toBe(items(listed).filter((item) => item.status === 'OVERDUE').length);
      expect(summary.json.escalated).toBe(items(listed).filter((item) => item.phase === 'ESCALATED').length);
      expect(summary.json.definitions).toMatchObject({ by_status: expect.stringContaining('Quá hạn'), due_soon: expect.any(String), escalated: expect.any(String), by_unit: expect.any(String) });
      expect(summary.json.policy).toMatchObject({ unverified: true, escalate_after_overdue_days: 7 });
      expect((summary.json.by_unit as Array<{ total: number }>).reduce((sum, row) => sum + row.total, 0)).toBe(summary.json.total);
      expect(typeof summary.json.as_of).toBe('string');
      expect((await call('GET', `/directives/summary?project_id=${otherProject}`, { member: READER })).json.total).toBe(items(await call('GET', `/directives?project_id=${otherProject}&limit=200`, { member: READER })).length);
      expect((await call('GET', '/directives/summary', { member: OUTSIDER })).json.total).toBe(0);
      expect((await call('GET', '/directives/summary', { member: NOBODY })).status).toBe(403);
    });

    it('gives the data of the dashboard widget: the counts, the oldest overdue directives first, and the definitions', async () => {
      const widget = await call('GET', '/directives/widget', { member: READER });
      expect(widget.status).toBe(200);
      const counts = widget.json.counts as Record<string, number>;
      expect(counts.overdue).toBeGreaterThanOrEqual(1);
      const shown = widget.json.items as Array<{ status: string; overdue_days: number }>;
      expect(shown.length).toBeLessThanOrEqual(5);
      expect(shown.every((item) => item.status === 'OVERDUE')).toBe(true);
      expect(shown.map((item) => item.overdue_days)).toEqual([...shown.map((item) => item.overdue_days)].sort((a, b) => b - a));
      expect(widget.json.definitions).toMatchObject({ overdue: expect.any(String) });
      expect((await call('GET', '/directives/widget', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/directives/widget', { member: OUTSIDER })).json.counts).toMatchObject({ overdue: 0 });
    });

    it('gives the directives of a period as the input of the report: counts that add up to the list, the state on the last day, and a refusal for a period that is none', async () => {
      const held = await meeting({ meeting_date: DAY(-20), title: 'Giao ban kỳ' });
      const open = await directive(held.id, { due_on: DAY(-5) });
      const done = await directive(held.id, { due_on: DAY(-2) });
      await call('POST', `/directives/${done.id}/closure`, { member: CLOSER, ifMatch: '"1"', body: { note: 'Xong.', evidence_document_version_ids: [version] } });
      const report = await call('GET', `/directives/for-report?from=${DAY(-30)}&to=${DAY(0)}`, { member: READER });
      expect(report.status).toBe(200);
      expect(report.json.period).toEqual({ from: DAY(-30), to: DAY(0) });
      const list = report.json.items as Array<{ id: string; status_at_end: string; raised_in_period: boolean; closed_in_period: boolean; open_at_end: boolean }>;
      const counts = report.json.counts as { total: number; raised: number; closed: number; open_at_end: number; overdue_at_end: number; by_status: Record<string, number> };
      expect(list.find((item) => item.id === open.id)).toMatchObject({ status_at_end: 'OVERDUE', raised_in_period: true, open_at_end: true });
      expect(list.find((item) => item.id === done.id)).toMatchObject({ status_at_end: 'DONE', closed_in_period: true, open_at_end: false });
      expect(counts.total).toBe(list.length);
      expect(counts.raised).toBe(list.filter((item) => item.raised_in_period).length);
      expect(counts.closed).toBe(list.filter((item) => item.closed_in_period).length);
      expect(counts.open_at_end).toBe(list.filter((item) => item.open_at_end).length);
      expect(counts.overdue_at_end).toBe(list.filter((item) => item.status_at_end === 'OVERDUE').length);
      expect(Object.values(counts.by_status).reduce((sum, value) => sum + value, 0)).toBe(counts.total);
      expect(report.json.definitions).toMatchObject({ overdue_at_end: expect.stringContaining('cuối') });
      expect((await call('GET', `/directives/for-report?from=${DAY(0)}&to=${DAY(-30)}`, { member: READER })).status).toBe(422);
      expect((await call('GET', `/directives/for-report?to=${DAY(0)}`, { member: READER })).status).toBe(422);
      expect((await call('GET', `/directives/for-report?from=x&to=${DAY(0)}`, { member: READER })).status).toBe(422);
      expect((await call('GET', `/directives/for-report?from=${DAY(-30)}&to=${DAY(0)}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/directives/for-report?from=${DAY(-30)}&to=${DAY(0)}`, { member: OUTSIDER })).json.counts).toMatchObject({ total: 0 });
    });

    it('lists the meetings with the counts of their directives and one meeting with the directives it gave, within the scope', async () => {
      const held = await meeting({ meeting_date: DAY(-2), title: 'Giao ban để đọc' });
      await directive(held.id, { due_on: DAY(-1) });
      await directive(held.id, { due_on: DAY(30) });
      const listed = await call('GET', '/steering-meetings?limit=100', { member: READER });
      expect(listed.status).toBe(200);
      const found = items(listed).find((item) => item.id === held.id);
      expect(found).toMatchObject({ code: held.code, title: 'Giao ban để đọc', unit: { id: unitId(ROOT) }, counts: { total: 2, by_status: { OVERDUE: 1, OPEN: 1 } } });
      const dates = items(listed).map((item) => item.meeting_date as string);
      expect(dates).toEqual([...dates].sort().reverse());
      const first = await call('GET', '/steering-meetings?limit=1', { member: READER });
      expect(items(first)).toHaveLength(1);
      expect(typeof first.json.next_cursor).toBe('string');
      expect(items(await call('GET', `/steering-meetings?limit=1&cursor=${first.json.next_cursor as string}`, { member: READER }))[0]?.id).not.toBe(items(first)[0]?.id);
      expect(items(await call('GET', `/steering-meetings?from=${DAY(-2)}&to=${DAY(-2)}`, { member: READER })).map((item) => item.id)).toContain(held.id);
      expect(items(await call('GET', '/steering-meetings?meeting_type=SITE_VISIT', { member: READER }))).toEqual([]);
      expect((await call('GET', '/steering-meetings?from=2026-02-31', { member: READER })).status).toBe(422);
      expect((await call('GET', '/steering-meetings', { member: NOBODY })).status).toBe(403);
      expect(items(await call('GET', '/steering-meetings', { member: OUTSIDER }))).toEqual([]);

      const detail = await call('GET', `/steering-meetings/${held.id}`, { member: READER });
      expect(detail.status).toBe(200);
      expect((detail.json.directives as Array<{ seq: number }>).map((line) => line.seq)).toEqual([1, 2]);
      expect(detail.json.actions).toEqual({ add_directive: false, attach_minutes: false });
      expect((await call('GET', `/steering-meetings/${held.id}`, { member: SECRETARY })).json.actions).toEqual({ add_directive: true, attach_minutes: true });
      expect(detail.json.policy).toMatchObject({ unverified: true });
      expect((await call('GET', `/steering-meetings/${held.id}`, { member: OUTSIDER })).status).toBe(404);
      expect((await call('GET', `/steering-meetings/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/steering-meetings/${held.id}`, { member: NOBODY })).status).toBe(403);
    });
  });
});
