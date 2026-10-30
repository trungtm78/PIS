import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { ConversationStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ConversationsController } from '../../src/omni/conversations/conversations.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const AGENT = 1; // converts and links in the project P-01 only
const SUPERVISOR = 2; // converts and links in the whole tenant
const READER = 3; // reads conversations, converts nothing
const FAMILY = 0x7e;
const P01 = id(FAMILY, 1);
const P09 = id(FAMILY, 2);
const CONTRACT_01 = id(FAMILY, 3);
const CONTRACT_09 = id(FAMILY, 4);
const WORKER = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
const SUMMARY = 'Người dân báo hư hỏng mặt đường trước cổng dự án';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the links of a conversation and its conversion into an issue (ST-OMNI-007, OMNI-09, OMNI.md 3.4)', () => {
  const harness = new AuthzHarness();
  const store = new ConversationStore();
  let app: RunningApp;
  let counter = 0;
  let account: string;
  let issueId: string;

  const tenants = (): TenantDatabase => harness.tenants as TenantDatabase;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? AGENT, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
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

  /** A conversation of a person, given to the agent so that it is theirs to read, and taken up. */
  async function conversation(assignee = AGENT, status = 'InProgress'): Promise<{ id: string; version: number }> {
    const n = (counter += 1);
    const inboxId = randomUUID();
    await rows(
      `insert into machvon.integration_event_inbox (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id)
       values ($1, $2, 'test-provider', $3, repeat('b', 64), 'ref', now(), 'PROCESSING', 'k1')`,
      [TENANT_A, inboxId, `event-${inboxId}`],
    );
    const outcome = await tenants().withTenant(WORKER, (tx) =>
      store.receiveInbound(tx, { inboxId, channelAccountId: account, providerMessageId: `pm-${n}`, externalThreadId: `thread-${n}`, sender: { externalId: `8491${String(700_000 + n)}`, displayName: 'Người báo tin' }, text: 'Đường trước cổng bị sụt lún, xin xử lý gấp', occurredAt: new Date() }),
    );
    if (outcome.kind !== 'RECEIVED') throw new Error(outcome.kind);
    await rows("update machvon.conversation set assignee_id = $2, status = 'Assigned' where id = $1", [outcome.conversationId, memberId(assignee)]);
    if (status !== 'Assigned') await rows('update machvon.conversation set status = $2 where id = $1', [outcome.conversationId, status]);
    return { id: outcome.conversationId, version: await versionOf(outcome.conversationId) };
  }
  const versionOf = async (conversationId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.conversation where id = $1', [conversationId]))[0]?.version);
  const linksOf = async (conversationId: string) => (await rows<{ resource_links: Array<{ resource_type: string; resource_id: string }> }>('select resource_links from machvon.conversation where id = $1', [conversationId]))[0]?.resource_links ?? [];
  const convert = (target: string, version: number, body: Record<string, unknown>, member = AGENT, key?: string) =>
    call('POST', `/conversations/${target}/issues`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body: { project_id: P01, issue_type: 'LAND', summary: SUMMARY, ...body } });
  const link = (target: string, version: number, resource_type: string, resource_id: string, member = AGENT) =>
    call('POST', `/conversations/${target}/links`, { member, ifMatch: `"${version}"`, body: { resource_type, resource_id } });

  beforeAll(async () => {
    await harness.start();
    const thisYear = new Date().getUTCFullYear();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }, { n: 3, path: `/${unitId(3)}/` }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const member of [AGENT, SUPERVISOR, READER]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    // The deadline of an issue is counted on the working calendar: the years an issue created now can reach.
    await harness.owner(
      TENANT_A,
      [thisYear - 1, thisYear, thisYear + 1].map((year, index): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
        [TENANT_A, id(0x74, 1 + index), year, memberId(SUPERVISOR)],
      ]),
    );
    await seedAdmin([
      [`insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group) values ($1, $2, 'P-01', 'Cầu Nà Hang', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`, [TENANT_A, P01, unitId(1), id(FAMILY, 20)]],
      [`insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group) values ($1, $2, 'P-09', 'Đường Bắc Kạn', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`, [TENANT_A, P09, unitId(3), id(FAMILY, 21)]],
    ]);
    await seedAdmin(
      [[CONTRACT_01, P01, 'C-01'], [CONTRACT_09, P09, 'C-09']].map(([contract, project, code]): [string, unknown[]] => [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version) values ($1, $2, $3, $4, $4, $5, 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
        [TENANT_A, contract, project, id(FAMILY, 31), code],
      ]),
    );
    for (const [code, label, record, version] of [
      ['LAND', 'Giải phóng mặt bằng', randomUUID(), randomUUID()],
      ['NOPOLICY', 'Loại chưa có chính sách SLA', randomUUID(), randomUUID()],
    ] as const) {
      await harness.owner(TENANT_A, [
        [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $3, 'EFFECTIVE', $4, $4)`, [TENANT_A, record, code, memberId(SUPERVISOR)]],
        [
          `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
           values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, $5, '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', $6, $6)`,
          [TENANT_A, version, record, code, label, memberId(SUPERVISOR)],
        ],
        ['update machvon.master_record set current_version_id = $2 where id = $1', [record, version]],
        ...(code === 'LAND'
          ? ([
              [
                `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
                 values ($1, $2, 'SLA-LAND-MEDIUM', 1, $3, $4, 'MEDIUM', 'WORKDAY_VN', 8, 40, '2026-01-01', 'ACTIVE', $5, $5)`,
                [TENANT_A, id(FAMILY, 23), version, record, memberId(SUPERVISOR)],
              ],
            ] as Array<[string, unknown[]]>)
          : []),
      ]);
    }
    await harness.seedRole(TENANT_A, 1, 'OMNI_CONVERTER', ['omni.conversation.convert', 'omni.conversation.reply', 'conversation.read', 'channel_message.read', 'project.read', 'issue.read', 'contract.read'], 35);
    await harness.seedRole(TENANT_A, 2, 'OMNI_READER', ['conversation.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AGENT, role: 1, kind: 'PROJECT', refs: [P01] },
      { n: 2, member: SUPERVISOR, role: 1, kind: 'TENANT' },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
    ]);
    account = id(0xe8, 1);
    await rows(
      `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, display_name)
       values ($1, $2, 'WHATSAPP', 'ext-links', 'secret://t/x', 'v1', 'Active', now(), 'WhatsApp')`,
      [TENANT_A, account],
    );
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants() }), PolicyModule.register({ database: tenants(), access: new EffectiveAccessStore(tenants(), new InMemoryAuthzCache()) })],
      controllers: [ConversationsController],
      providers: [{ provide: TenantDatabase, useValue: tenants() }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('the conversion into an issue', () => {
    it('AC-ST-OMNI-007-1 UAT-AC198: an agent scoped to the project P-01 is 403 SCOPE_DENIED for P-09, and for P-01 the issue is made and the conversation points to it', async () => {
      const target = await conversation();
      const denied = await convert(target.id, target.version, { project_id: P09 });
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await rows('select 1 from machvon.issue where project_id = $1', [P09])).length).toBe(0);
      expect(await versionOf(target.id)).toBe(target.version);
      const done = await convert(target.id, target.version, {});
      expect(done.status).toBe(201);
      expect(done.json).toMatchObject({ status: 'CONVERTED', resource_version: target.version + 1 });
      issueId = done.json.resource_id as string;
      const [issue] = await rows<{ project_id: string; title: string; description: string; severity: string; owner_unit_id: string; source_module: string; reported_by: string; status: string; sla_policy_id: string }>('select * from machvon.issue where id = $1', [issueId]);
      expect(issue).toMatchObject({ project_id: P01, title: SUMMARY, severity: 'MEDIUM', owner_unit_id: unitId(1), source_module: 'MANUAL', reported_by: memberId(AGENT), status: 'OPEN', sla_policy_id: id(FAMILY, 23) });
      // Only the summary and the address of the conversation were copied: not one word of what the person wrote.
      expect(issue?.description).toBe(`${SUMMARY}\n\n/omni/omni-02?id=${target.id}`);
      expect(JSON.stringify(issue)).not.toContain('sụt lún');
      const links = await linksOf(target.id);
      expect(links).toEqual([expect.objectContaining({ resource_type: 'issue', resource_id: issueId }), expect.objectContaining({ resource_type: 'project', resource_id: P01 })]);
      const trail = await rows<{ action: string; resource_type: string; safe_diff: Record<string, unknown> }>("select action, resource_type, safe_diff from machvon.audit_event where resource_id = any($1::uuid[]) and action in ('iss.issue_opened', 'conversation.converted_to_issue') order by seq", [[issueId, target.id]]);
      expect(trail.map((row) => row.action).sort()).toEqual(['conversation.converted_to_issue', 'iss.issue_opened']);
      expect(JSON.stringify(trail)).not.toContain('sụt lún');
      const events = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = any($1::uuid[]) order by created_at, id", [[issueId, target.id]]);
      expect(events.map((event) => event.type).sort()).toEqual(['iss.issue.opened.v1', 'omni.conversation.converted.v1']);
    });

    it('counts only the issue a conversion made: one linked by hand does not stop the conversion, and the view tells the two apart', async () => {
      const target = await conversation();
      expect((await link(target.id, target.version, 'issue', issueId)).status).toBe(200);
      const done = await convert(target.id, target.version + 1, {});
      expect(done.status).toBe(201);
      const stored = await linksOf(target.id);
      expect(stored.map((entry) => [entry.resource_type, (entry as { converted?: boolean }).converted === true])).toEqual([['issue', false], ['issue', true], ['project', false]]);
      const view = await call('GET', `/resources/conversation/${target.id}`);
      expect(view.status).toBe(200);
      expect((view.json.resource_links as Array<{ resource_type: string; converted: boolean }>).map((entry) => [entry.resource_type, entry.converted])).toEqual([['issue', false], ['issue', true], ['project', false]]);
      expect(JSON.stringify(view.json.resource_links)).not.toContain('linked_by');
    });

    it('keeps the conversation within 20 links: a conversion that would add one too many is 422 on project_id, and nothing is made', async () => {
      const target = await conversation();
      const stamp = '2026-10-30T00:00:00Z';
      const fill = async (count: number): Promise<void> => {
        await rows(
          "update machvon.conversation set resource_links = (select coalesce(jsonb_agg(jsonb_build_object('resource_type', 'contract', 'resource_id', gen_random_uuid(), 'linked_at', $2::text, 'linked_by', $3::text)), '[]'::jsonb) from generate_series(1, $4::int)) where id = $1",
          [target.id, stamp, memberId(AGENT), count],
        );
      };
      await fill(19);
      const before = await versionOf(target.id);
      const refused = await convert(target.id, before, {});
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'project_id']);
      expect((await rows('select 1 from machvon.issue where description like $1', [`%${target.id}`])).length).toBe(0);
      await fill(18);
      expect((await convert(target.id, await versionOf(target.id), {})).status).toBe(201);
      expect(await linksOf(target.id)).toHaveLength(20);
    });

    it('is one issue for a conversation: a second conversion is 409 CONVERSATION_ALREADY_CONVERTED, and the same request again is the same answer', async () => {
      const target = await conversation();
      const key = `key-${randomUUID()}`;
      const first = await convert(target.id, target.version, {}, AGENT, key);
      const replay = await convert(target.id, target.version, {}, AGENT, key);
      expect([first.status, replay.status]).toEqual([201, 201]);
      expect(replay.json).toEqual(first.json);
      expect((await rows('select 1 from machvon.issue where description like $1', [`%${target.id}`])).length).toBe(1);
      const again = await convert(target.id, await versionOf(target.id), {});
      expect([again.status, again.json.code]).toEqual([409, 'CONVERSATION_ALREADY_CONVERTED']);
    });

    it('is refused as it should: a stale version, a closed conversation, a project that is not there, a category that is not defined, a date or a person, and one who may not convert', async () => {
      const target = await conversation();
      const stale = await convert(target.id, target.version + 4, {});
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const unknownProject = await convert(target.id, target.version, { project_id: randomUUID() }, SUPERVISOR);
      expect([unknownProject.status, unknownProject.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const unknownType = await convert(target.id, target.version, { issue_type: 'NO-SUCH-TYPE' });
      expect([unknownType.status, unknownType.json.code, unknownType.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'issue_type']);
      for (const [field, value] of [['due_date', '2026-12-01'], ['assignee_membership_id', memberId(SUPERVISOR)]] as const) {
        const refused = await convert(target.id, target.version, { [field]: value });
        expect([refused.status, refused.json.detail]).toEqual([422, field]);
      }
      expect((await convert(target.id, target.version, {}, READER)).status).toBe(403);
      await rows("update machvon.conversation set status = 'Resolved' where id = $1", [target.id]);
      await rows("update machvon.conversation set status = 'Closed' where id = $1", [target.id]);
      const closed = await convert(target.id, await versionOf(target.id), {});
      expect([closed.status, closed.json.code]).toEqual([409, 'CONVERSATION_STATE_INVALID']);
      // A conversation of another agent is not found for this one; and nothing was made.
      const other = await conversation(SUPERVISOR);
      expect((await convert(other.id, other.version, {})).status).toBe(404);
      expect((await rows("select 1 from machvon.issue where title = $1 and description like $2", [SUMMARY, `%${target.id}`])).length).toBe(0);
    });

    it('tells what the issue module refused, with its own code: a category with no SLA policy is 422 ISSUE_COMMAND_REJECTED', async () => {
      const target = await conversation();
      const refused = await convert(target.id, target.version, { issue_type: 'NOPOLICY' });
      expect([refused.status, refused.json.code]).toEqual([422, 'ISSUE_COMMAND_REJECTED']);
      expect(refused.json.issue_error_code).toBe('SLA_POLICY_MISSING');
      expect(await versionOf(target.id)).toBe(target.version);
      expect(await linksOf(target.id)).toEqual([]);
    });

    it('applies the scope before it cuts the list: an agent scoped to one project far down a tenant of more than 500 projects still finds it', async () => {
      await seedAdmin([
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           select $1, gen_random_uuid(), 'A-' || lpad(n::text, 5, '0'), 'Dự án ' || n, $2, $3, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B' from generate_series(1, 1100) n`,
          [TENANT_A, unitId(3), id(FAMILY, 22)],
        ],
      ]);
      try {
        const mine = await call('GET', '/conversation-conversion-options');
        expect((mine.json.projects as Array<{ code: string }>).map((project) => project.code)).toEqual(['P-01']);
        const all = await call('GET', '/conversation-conversion-options', { member: SUPERVISOR });
        expect((all.json.projects as unknown[]).length).toBe(500);
      } finally {
        await seedAdmin([["delete from machvon.project where code like 'A-%'", []]]);
      }
    });

    it('offers the projects the agent is scoped to and the categories of issues: P-09 is not among the choices of the agent, and the supervisor of the tenant has both', async () => {
      const mine = await call('GET', '/conversation-conversion-options');
      expect(mine.status).toBe(200);
      expect((mine.json.projects as Array<{ id: string; code: string }>).map((project) => project.code)).toEqual(['P-01']);
      expect((mine.json.issue_types as Array<{ code: string; label: string }>).map((type) => type.code)).toEqual(['LAND', 'NOPOLICY']);
      expect((mine.json.issue_types as Array<{ label: string }>)[0]?.label).toBe('Giải phóng mặt bằng');
      const all = await call('GET', '/conversation-conversion-options', { member: SUPERVISOR });
      expect((all.json.projects as Array<{ code: string }>).map((project) => project.code)).toEqual(['P-01', 'P-09']);
      expect((await call('GET', '/conversation-conversion-options', { member: READER })).status).toBe(403);
    });
  });

  describe('the links', () => {
    it('links a conversation to a project the agent may read, once, and records it on the trail; the same link again changes nothing', async () => {
      const target = await conversation();
      const done = await link(target.id, target.version, 'project', P01);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'LINKED', resource_version: target.version + 1 });
      expect(await linksOf(target.id)).toEqual([expect.objectContaining({ resource_type: 'project', resource_id: P01, linked_by: memberId(AGENT) })]);
      const again = await link(target.id, target.version + 1, 'project', P01);
      expect(again.status).toBe(200);
      expect(again.json.resource_version).toBe(target.version + 1);
      expect(await linksOf(target.id)).toHaveLength(1);
      const trail = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'conversation.linked' order by seq", [target.id]);
      // The repeat is on the trail too (a command always leaves one) but it carries the record it asked for, and nothing more changed.
      expect(trail).toEqual([{ safe_diff: { resource_type: 'project', resource_id: P01 } }, { safe_diff: { resource_type: 'project', resource_id: P01 } }]);
    });

    it('is 403 SCOPE_DENIED for a record the agent may not read, 404 for one that is not in the tenant, and 409 on a stale version or a closed conversation', async () => {
      const target = await conversation();
      const denied = await link(target.id, target.version, 'project', P09);
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const unknown = await link(target.id, target.version, 'issue', randomUUID());
      expect([unknown.status, unknown.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const stale = await link(target.id, target.version + 3, 'project', P01);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const bad = await call('POST', `/conversations/${target.id}/links`, { ifMatch: `"${target.version}"`, body: { resource_type: 'document', resource_id: P01 } });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(await linksOf(target.id)).toEqual([]);
      await rows("update machvon.conversation set status = 'Resolved' where id = $1", [target.id]);
      await rows("update machvon.conversation set status = 'Closed' where id = $1", [target.id]);
      const closed = await link(target.id, await versionOf(target.id), 'project', P01);
      expect([closed.status, closed.json.code]).toEqual([409, 'CONVERSATION_STATE_INVALID']);
    });

    it('links a contract by the place of its project: the agent scoped to P-01 may link the contract of P-01 and is 403 for the one of P-09', async () => {
      const target = await conversation();
      const done = await link(target.id, target.version, 'contract', CONTRACT_01);
      expect(done.status).toBe(200);
      expect(await linksOf(target.id)).toEqual([expect.objectContaining({ resource_type: 'contract', resource_id: CONTRACT_01 })]);
      const denied = await link(target.id, target.version + 1, 'contract', CONTRACT_09);
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await linksOf(target.id)).toHaveLength(1);
    });

    it('links the issue that was made, as the agent who may read it in its project, and no more than 20 records to one conversation', async () => {
      const target = await conversation();
      expect((await link(target.id, target.version, 'issue', issueId)).status).toBe(200);
      const many = await conversation(SUPERVISOR);
      let version = many.version;
      for (let index = 0; index < 20; index += 1) {
        const made = await rows<{ id: string }>(
          `insert into machvon.issue (tenant_id, id, code, project_id, category_version_id, severity, title, description, source_module, owner_unit_id, sla_policy_id, status, version, reported_by, opened_at, response_due_at, due_at, client_operation_id, client_request_hash, created_at, created_by, updated_at, updated_by)
           select tenant_id, gen_random_uuid(), 'VM-2026-' || lpad($2::text, 6, '0'), project_id, category_version_id, severity, title, description, source_module, owner_unit_id, sla_policy_id, status, version, reported_by, opened_at, response_due_at, due_at, gen_random_uuid(), 'h' || $2::text, created_at, created_by, updated_at, updated_by
             from machvon.issue where id = $1 returning id`,
          [issueId, 800_000 + index],
        );
        const done = await link(many.id, version, 'issue', made[0]?.id as string, SUPERVISOR);
        expect(done.status).toBe(200);
        version = Number(done.json.resource_version);
      }
      const extra = await link(many.id, version, 'project', P01, SUPERVISOR);
      expect([extra.status, extra.json.code, extra.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'resource_id']);
      expect(await linksOf(many.id)).toHaveLength(20);
    });
  });
});
