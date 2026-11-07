import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AlertTypeReadsController, GovernanceRuleReadsController, GovernanceRulesController } from '../../src/modules/adm/governance-rule.controller';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;

// Members of tenant A.
const MAKER = 1; // adm.governance.manage on the whole tenant
const SUBMITTER = 2; // adm.governance.manage on the whole tenant (a colleague who submits the draft of the maker)
const CHECKER = 3; // adm.governance.approve on the whole tenant (the third person)
const OWNER = 4; // manage, approve and read on the whole tenant (the tenant owner holds all three)
const UNIT_ADMIN = 5; // manage, approve and read on the subtree of unit 2 only
const NOBODY = 6; // holds a role without the permissions
const READER = 7; // adm.governance.read on the whole tenant
const SECOND_CHECKER = 8; // approve and read on the whole tenant

const PROVINCE = unitId(1);
const DEPARTMENT = unitId(2);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The business day in Vietnam, `offset` days from today (the database decides today the same way). */
const day = (offset: number): string => new Date(Date.now() + 7 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);

const reminder = (urgent: number, action = 8, watch = 40): Record<string, unknown> => ({
  every_working_hours: { URGENT: urgent, ACTION: action, WATCH: watch },
  max_per_item: { URGENT: 40, ACTION: 20, WATCH: 8 },
});

const alertOverride = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: 'APPROVAL',
  owner: 'APPROVER',
  expected_action: 'Xem hồ sơ, quyết định trong ngày làm việc.',
  consequence: 'Hồ sơ chờ duyệt bị dừng; quá hạn sẽ báo lên lãnh đạo.',
  response_hours: 24,
  default_severity: 'ACTION',
  reason_to_exist: 'Quyết định chậm là điểm nghẽn của quy trình duyệt.',
  review_on: day(180),
  enabled: true,
  ...overrides,
});

describe('governance rule commands and reads (G0-1, G0-3)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const nextCode = (): string => `GOV_CODE_${(counter += 1)}`;

  async function call(method: 'POST', url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json', 'idempotency-key': options.key ?? `key-${randomUUID()}` };
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function read(url: string, member: number): Promise<Reply> {
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: token } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const draft = (member: number, body: Record<string, unknown>, key?: string): Promise<Reply> => call('POST', '/governance-rules', { member, body, ...(key === undefined ? {} : { key }) });
  const rule = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rule_type: 'REMINDER_POLICY',
    code: 'DEFAULT',
    params: reminder(2),
    effective_from: day(1),
    reason: 'Rút ngắn nhịp nhắc việc',
    ...overrides,
  });
  const submit = (member: number, id: string, ifMatch = '"1"'): Promise<Reply> => call('POST', `/governance-rules/${id}/submit`, { member, ifMatch, body: { reason: 'Sẵn sàng cho người kiểm' } });
  const withdraw = (member: number, id: string, ifMatch = '"2"'): Promise<Reply> => call('POST', `/governance-rules/${id}/withdraw`, { member, ifMatch, body: { reason: 'Cần sửa lại bản này' } });
  const approve = (member: number, id: string, ifMatch = '"2"'): Promise<Reply> => call('POST', `/governance-rules/${id}/approve`, { member, ifMatch, body: { reason: 'Đã đối chiếu với quy định' } });
  const retire = (member: number, id: string, ifMatch: string, body: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/governance-rules/${id}/retire`, { member, ifMatch, body: { reason: 'Không còn áp dụng nữa', ...body } });
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const countOf = async (sql: string, params: unknown[] = []): Promise<number> => Number((await harness.owner<{ n: string }>(TENANT_A, [[sql, params]]))[0]?.n);
  /** Drafts, submits (by a colleague) and approves (by the checker) a version; returns its id. */
  async function approved(body: Record<string, unknown>): Promise<string> {
    const created = await draft(MAKER, body);
    expect(created.status).toBe(201);
    const id = idOf(created);
    expect((await submit(SUBMITTER, id)).status).toBe(200);
    const decided = await approve(CHECKER, id);
    expect(decided.status).toBe(200);
    return id;
  }
  const effective = (code: string, asOf: string, extra = ''): Promise<Reply> => read(`/governance-rules/effective?rule_type=REMINDER_POLICY&code=${code}&as_of=${asOf}${extra}`, READER);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: path(1) },
      { n: 2, path: path(1, 2), parent: 1 },
    ]);
    for (const n of [MAKER, SUBMITTER, CHECKER, OWNER, UNIT_ADMIN, NOBODY, READER, SECOND_CHECKER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 11, 'GOV_MANAGER', ['adm.governance.manage'], 60);
    await harness.seedRole(TENANT_A, 12, 'GOV_APPROVER', ['adm.governance.approve'], 60);
    await harness.seedRole(TENANT_A, 13, 'GOV_ALL', ['adm.governance.manage', 'adm.governance.approve', 'adm.governance.read'], 60);
    await harness.seedRole(TENANT_A, 14, 'UNRELATED', ['adm.security.read'], 20);
    await harness.seedRole(TENANT_A, 15, 'GOV_READER', ['adm.governance.read'], 20);
    await harness.seedRole(TENANT_A, 16, 'GOV_APPROVER_READER', ['adm.governance.approve', 'adm.governance.read'], 60);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 11, kind: 'TENANT' },
      { n: 2, member: SUBMITTER, role: 11, kind: 'TENANT' },
      { n: 3, member: CHECKER, role: 12, kind: 'TENANT' },
      { n: 4, member: OWNER, role: 13, kind: 'TENANT' },
      { n: 5, member: UNIT_ADMIN, role: 13, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 6, member: NOBODY, role: 14, kind: 'TENANT' },
      { n: 7, member: READER, role: 15, kind: 'TENANT' },
      { n: 8, member: SECOND_CHECKER, role: 16, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [GovernanceRulesController, GovernanceRuleReadsController, AlertTypeReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    await harness.owner(TENANT_A, [
      ['delete from machvon.governance_rule', []],
      ["delete from machvon.audit_event where resource_type = 'governance_rule'", []],
      ["delete from machvon.outbox_event where aggregate_type = 'governance_rule'", []],
    ]);
  });

  describe('createGovernanceRuleDraft', () => {
    it('writes a draft, version 1, and audits it; the next one of the same code is version 2', async () => {
      const code = nextCode();
      const first = await draft(MAKER, rule({ code }));
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      expect(await countOf("select count(*) as n from machvon.governance_rule where id = $1 and status = 'DRAFT' and version = 1 and created_by = $2 and unit_id is null", [idOf(first), memberId(MAKER)])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'governance_rule.drafted' and resource_id = $1", [idOf(first)])).toBe(1);
      const second = await draft(MAKER, rule({ code, params: reminder(3) }));
      expect(await countOf('select version as n from machvon.governance_rule where id = $1', [idOf(second)])).toBe(2);
      const forUnit = await draft(MAKER, rule({ code, unit_id: DEPARTMENT }));
      expect(await countOf('select version as n from machvon.governance_rule where id = $1', [idOf(forUnit)])).toBe(1);
    });

    it('answers a retry with the same key with the first answer and writes one version', async () => {
      const key = `key-${randomUUID()}`;
      const code = nextCode();
      const first = await draft(MAKER, rule({ code }), key);
      const again = await draft(MAKER, rule({ code }), key);
      expect(again.status).toBe(first.status);
      expect(idOf(again)).toBe(idOf(first));
      expect(await countOf('select count(*) as n from machvon.governance_rule where code = $1', [code])).toBe(1);
      const changed = await draft(MAKER, rule({ code, params: reminder(5) }), key);
      expect(changed.status).toBe(409);
      expect(changed.json.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('refuses params that break the schema of the type, naming the field (422 GOVERNANCE_RULE_PARAMS_INVALID) and storing nothing', async () => {
      const unknownField = await draft(MAKER, rule({ params: { ...reminder(2), surprise: 1 } }));
      expect(unknownField.status).toBe(422);
      expect(unknownField.json.code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
      expect(String(unknownField.json.detail)).toContain('surprise');
      const outOfRange = await draft(MAKER, rule({ params: reminder(9999) }));
      expect(outOfRange.json.code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
      expect(String(outOfRange.json.detail)).toContain('every_working_hours.URGENT');
      // The lane's own parser judges too: URGENT can never be put off.
      const parser = await draft(MAKER, { rule_type: 'SNOOZE_POLICY', code: 'DEFAULT', effective_from: day(1), reason: 'Cho phép hoãn việc khẩn', params: { reasons: ['OTHER'], max_days_by_severity: { URGENT: 1, ACTION: 3, WATCH: 14 }, max_consecutive: 2 } });
      expect(parser.json.code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
      expect(await countOf('select count(*) as n from machvon.governance_rule')).toBe(0);
    });

    it('refuses a type nobody registered, a malformed code, an inverted period, a short reason and an unknown unit', async () => {
      expect((await draft(MAKER, rule({ rule_type: 'NOT_A_REGISTERED_TYPE' }))).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await draft(MAKER, rule({ code: 'lower_case' }))).status).toBeGreaterThanOrEqual(400);
      const inverted = await draft(MAKER, rule({ effective_from: day(5), effective_to: day(5) }));
      expect(inverted.json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await draft(MAKER, rule({ reason: 'ngắn' }))).status).toBeGreaterThanOrEqual(400);
      const unit = await draft(MAKER, rule({ unit_id: randomUUID() }));
      expect(unit.json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await draft(MAKER, { ...rule(), surprise: true })).status).toBe(400);
      expect(await countOf('select count(*) as n from machvon.governance_rule')).toBe(0);
    });

    it('refuses a caller without the permission, a caller who only approves and a caller who holds it only on a subtree (403, audited as DENIED)', async () => {
      for (const member of [NOBODY, CHECKER, READER]) expect((await draft(member, rule())).status).toBe(403);
      const unitAdmin = await draft(UNIT_ADMIN, rule());
      expect(unitAdmin.status).toBe(403);
      expect(unitAdmin.json.code).toBe('SCOPE_DENIED');
      expect(await countOf("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action like '%createGovernanceRuleDraft%'")).toBeGreaterThanOrEqual(1);
      expect(await countOf('select count(*) as n from machvon.governance_rule')).toBe(0);
    });
  });

  describe('submit, withdraw and approve: maker is not checker', () => {
    it('walks a version from draft to approved, audits every move and announces the approval in the outbox', async () => {
      const code = nextCode();
      const id = idOf(await draft(MAKER, rule({ code })));
      const submitted = await submit(SUBMITTER, id);
      expect(submitted.json).toMatchObject({ status: 'SUBMITTED', resource_version: 2 });
      const withdrawn = await withdraw(MAKER, id);
      expect(withdrawn.json).toMatchObject({ status: 'DRAFT', resource_version: 3 });
      expect(await countOf('select count(*) as n from machvon.governance_rule where id = $1 and submitted_by is null and submitted_at is null', [id])).toBe(1);
      expect((await submit(SUBMITTER, id, '"3"')).json).toMatchObject({ status: 'SUBMITTED', resource_version: 4 });
      const decided = await approve(CHECKER, id, '"4"');
      expect(decided.status).toBe(200);
      expect(decided.json).toMatchObject({ status: 'APPROVED', resource_version: 5 });
      expect(await countOf("select count(*) as n from machvon.governance_rule where id = $1 and status = 'APPROVED' and approved_by = $2 and approved_at is not null", [id, memberId(CHECKER)])).toBe(1);
      for (const action of ['drafted', 'submitted', 'withdrawn', 'submitted', 'approved']) {
        expect(await countOf('select count(*) as n from machvon.audit_event where resource_id = $1 and action = $2', [id, `governance_rule.${action}`])).toBe(action === 'submitted' ? 2 : 1);
      }
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'adm.governance_rule.approved.v1' and aggregate_id = $1", [id])).toBe(1);
      const payload = (await harness.owner<{ payload: Record<string, unknown> }>(TENANT_A, [["select payload from machvon.outbox_event where type = 'adm.governance_rule.approved.v1' and aggregate_id = $1", [id]]]))[0]?.payload;
      expect(payload).toMatchObject({ rule_id: id, rule_type: 'REMINDER_POLICY', code, version: 1, effective_from: day(1), superseded_id: null });
    });

    it('refuses the maker and the submitter approving their own version (403 SELF_APPROVAL_DENIED), changes nothing, and lets a third person approve', async () => {
      // The owner holds both permissions: as the maker, and then as the submitter, the owner is still not the checker.
      const own = idOf(await draft(OWNER, rule()));
      await submit(SUBMITTER, own);
      const byMaker = await approve(OWNER, own);
      expect(byMaker.status).toBe(403);
      expect(byMaker.json.code).toBe('SELF_APPROVAL_DENIED');
      const sent = idOf(await draft(MAKER, rule({ code: nextCode() })));
      await submit(OWNER, sent);
      const bySubmitter = await approve(OWNER, sent);
      expect(bySubmitter.status).toBe(403);
      expect(bySubmitter.json.code).toBe('SELF_APPROVAL_DENIED');
      expect(await countOf("select count(*) as n from machvon.governance_rule where id = any($1::uuid[]) and status = 'SUBMITTED' and approved_by is null", [[own, sent]])).toBe(2);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'governance_rule.approved' and resource_id = any($1::uuid[])", [[own, sent]])).toBe(0);
      expect((await approve(CHECKER, own)).status).toBe(200);
      expect((await approve(SECOND_CHECKER, sent)).status).toBe(200);
    });

    it('refuses the approval of a version that is not submitted, and a stale or missing If-Match', async () => {
      const id = idOf(await draft(MAKER, rule()));
      const early = await approve(CHECKER, id, '"1"');
      expect(early.status).toBe(409);
      expect(early.json.code).toBe('GOVERNANCE_RULE_STATE_INVALID');
      await submit(SUBMITTER, id);
      const stale = await approve(CHECKER, id, '"1"');
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      const missing = await call('POST', `/governance-rules/${id}/approve`, { member: CHECKER, body: { reason: 'Đã đối chiếu với quy định' } });
      expect(missing.status).toBe(428);
      expect((await approve(CHECKER, randomUUID())).status).toBe(404);
      const again = await approve(CHECKER, id);
      expect(again.status).toBe(200);
      expect((await approve(SECOND_CHECKER, id, '"3"')).json.code).toBe('GOVERNANCE_RULE_STATE_INVALID');
    });

    it('lets only a holder of the approve permission on the whole tenant approve, and a manager only draft, submit and withdraw', async () => {
      const id = idOf(await draft(MAKER, rule()));
      await submit(SUBMITTER, id);
      expect((await approve(SUBMITTER, id)).status).toBe(403);
      const subtree = await approve(UNIT_ADMIN, id);
      expect(subtree.status).toBe(403);
      expect(subtree.json.code).toBe('SCOPE_DENIED');
      expect((await approve(NOBODY, id)).status).toBe(403);
      expect(await countOf("select count(*) as n from machvon.governance_rule where id = $1 and status = 'SUBMITTED'", [id])).toBe(1);
      expect((await submit(CHECKER, id, '"2"')).status).toBe(403);
    });

    it('refuses to approve a version whose first day is already past (a rule never governed a day that is gone)', async () => {
      const id = idOf(await draft(MAKER, rule({ effective_from: day(-1) })));
      await submit(SUBMITTER, id);
      const late = await approve(CHECKER, id);
      expect(late.status).toBe(422);
      expect(late.json.code).toBe('VALIDATION_FAILED');
      expect(String(late.json.detail)).toContain('effective_from');
      expect(await countOf("select count(*) as n from machvon.governance_rule where id = $1 and status = 'SUBMITTED'", [id])).toBe(1);
    });

    it('judges the params again at submission and at approval (a rule that cannot be read is never approved)', async () => {
      const id = idOf(await draft(MAKER, rule()));
      await harness.owner(TENANT_A, [[`update machvon.governance_rule set params = '{"every_working_hours": 1}'::jsonb where id = $1`, [id]]]);
      const refused = await submit(SUBMITTER, id);
      expect(refused.status).toBe(422);
      expect(refused.json.code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
    });
  });

  describe('the takeover and the overlap guard', () => {
    it('ends the version in force the day its successor begins and reads each on its own days', async () => {
      // The code DEFAULT has a built-in default, which answers the days no version governs.
      const code = 'DEFAULT';
      const first = await approved(rule({ code, effective_from: day(1), params: reminder(2) }));
      const secondDraft = await draft(MAKER, rule({ code, effective_from: day(11), params: reminder(3) }));
      const second = idOf(secondDraft);
      await submit(SUBMITTER, second);
      expect((await approve(CHECKER, second)).status).toBe(200);
      expect(await countOf('select count(*) as n from machvon.governance_rule where id = $1 and effective_to = $2::date and status = $3', [first, day(11), 'APPROVED'])).toBe(1);
      const event = (await harness.owner<{ payload: Record<string, unknown> }>(TENANT_A, [["select payload from machvon.outbox_event where type = 'adm.governance_rule.approved.v1' and aggregate_id = $1", [second]]]))[0]?.payload;
      expect(event).toMatchObject({ superseded_id: first });
      expect((await effective(code, day(0))).json).toMatchObject({ source: 'DEFAULT', version: 0 });
      expect((await effective(code, day(1))).json).toMatchObject({ source: 'RULE', version: 1, rule_id: first });
      expect((await effective(code, day(10))).json).toMatchObject({ version: 1 });
      expect((await effective(code, day(11))).json).toMatchObject({ version: 2, rule_id: second });
      expect((await effective(code, day(400))).json).toMatchObject({ version: 2 });
    });

    it('refuses an approval that overlaps a version it cannot take over from (409 GOVERNANCE_RULE_PERIOD_OVERLAP)', async () => {
      const code = nextCode();
      await approved(rule({ code, effective_from: day(5) }));
      const before = idOf(await draft(MAKER, rule({ code, effective_from: day(2), params: reminder(3) })));
      await submit(SUBMITTER, before);
      const clash = await approve(CHECKER, before);
      expect(clash.status).toBe(409);
      expect(clash.json.code).toBe('GOVERNANCE_RULE_PERIOD_OVERLAP');
      const inside = idOf(await draft(MAKER, rule({ code, effective_from: day(8), effective_to: day(9), params: reminder(4) })));
      await submit(SUBMITTER, inside);
      expect((await approve(CHECKER, inside)).json.code).toBe('GOVERNANCE_RULE_PERIOD_OVERLAP');
      const same = idOf(await draft(MAKER, rule({ code, effective_from: day(5), params: reminder(5) })));
      await submit(SUBMITTER, same);
      expect((await approve(CHECKER, same)).json.code).toBe('GOVERNANCE_RULE_PERIOD_OVERLAP');
      expect(await countOf("select count(*) as n from machvon.governance_rule where code = $1 and status = 'APPROVED'", [code])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.governance_rule where code = $1 and status = 'APPROVED' and effective_to is not null", [code])).toBe(0);
    });

    it('lets a unit have its own override, and the nearest unit wins in the effective read', async () => {
      const code = nextCode();
      const tenantWide = await approved(rule({ code, params: reminder(2) }));
      const province = await approved(rule({ code, unit_id: PROVINCE, params: reminder(3) }));
      const department = await approved(rule({ code, unit_id: DEPARTMENT, params: reminder(4) }));
      expect((await effective(code, day(2))).json).toMatchObject({ rule_id: tenantWide, unit_id: null });
      expect((await effective(code, day(2), `&unit_id=${PROVINCE}`)).json).toMatchObject({ rule_id: province, unit_id: PROVINCE });
      expect((await effective(code, day(2), `&unit_id=${DEPARTMENT}`)).json).toMatchObject({ rule_id: department, unit_id: DEPARTMENT });
      expect((await effective(code, day(2), `&unit_id=${randomUUID()}`)).status).toBe(422);
    });
  });

  describe('retireGovernanceRule', () => {
    it('discards a draft or a submitted version: it has an empty period and governs nothing', async () => {
      const id = idOf(await draft(MAKER, rule()));
      const gone = await retire(MAKER, id, '"1"');
      expect(gone.json).toMatchObject({ status: 'RETIRED', resource_version: 2 });
      expect(await countOf('select count(*) as n from machvon.governance_rule where id = $1 and effective_to = effective_from and retired_by = $2', [id, memberId(MAKER)])).toBe(1);
      expect((await retire(MAKER, id, '"2"')).json.code).toBe('GOVERNANCE_RULE_STATE_INVALID');
      const withDay = idOf(await draft(MAKER, rule()));
      expect((await retire(MAKER, withDay, '"1"', { effective_to: day(30) })).json.code).toBe('VALIDATION_FAILED');
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'adm.governance_rule.retired.v1'")).toBe(0);
    });

    it('takes an approved version out of force from a day, needs the approve permission, and the default answers again', async () => {
      const code = 'DEFAULT';
      const id = await approved(rule({ code, effective_from: day(0), params: reminder(2) }));
      expect((await effective(code, day(3))).json).toMatchObject({ version: 1 });
      const manager = await retire(MAKER, id, '"3"');
      expect(manager.status).toBe(403);
      expect(manager.json.code).toBe('SCOPE_DENIED');
      const past = await retire(OWNER, id, '"3"', { effective_to: day(-1) });
      expect(past.json.code).toBe('VALIDATION_FAILED');
      const done = await retire(OWNER, id, '"3"', { effective_to: day(5) });
      expect(done.json).toMatchObject({ status: 'RETIRED', resource_version: 4 });
      expect(await countOf('select count(*) as n from machvon.governance_rule where id = $1 and effective_to = $2::date and retired_by = $3', [id, day(5), memberId(OWNER)])).toBe(1);
      expect((await effective(code, day(4))).json).toMatchObject({ source: 'RULE', version: 1 });
      expect((await effective(code, day(5))).json).toMatchObject({ source: 'DEFAULT', version: 0 });
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'adm.governance_rule.retired.v1' and aggregate_id = $1", [id])).toBe(1);
      expect((await retire(OWNER, id, '"4"')).json.code).toBe('GOVERNANCE_RULE_STATE_INVALID');
    });

    it('makes a version that has not begun empty, and never ends one before today or after the day it would have ended', async () => {
      const code = 'DEFAULT';
      const future = await approved(rule({ code, effective_from: day(20), effective_to: day(40) }));
      expect((await retire(OWNER, future, '"3"', { effective_to: day(41) })).json.code).toBe('VALIDATION_FAILED');
      const done = await retire(OWNER, future, '"3"');
      expect(done.status).toBe(200);
      expect(await countOf('select count(*) as n from machvon.governance_rule where id = $1 and effective_to = effective_from', [future])).toBe(1);
      expect((await effective(code, day(25))).json).toMatchObject({ source: 'DEFAULT' });
    });
  });

  describe('reads', () => {
    it('lists the versions newest first with filters, a page size and a cursor, and says where each stands (phase)', async () => {
      const code = nextCode();
      const a = await approved(rule({ code, effective_from: day(1), params: reminder(2) }));
      const b = idOf(await draft(MAKER, rule({ code, effective_from: day(9), params: reminder(3) })));
      const page = await read(`/governance-rules?rule_type=REMINDER_POLICY&code=${code}&limit=1`, READER);
      expect(page.status).toBe(200);
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id: b, version: 2, status: 'DRAFT', phase: 'DRAFT', resource_version: 1 });
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await read(`/governance-rules?rule_type=REMINDER_POLICY&code=${code}&limit=1&cursor=${page.json.next_cursor as string}`, READER);
      expect((next.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: a, version: 1, status: 'APPROVED', phase: 'SCHEDULED' });
      expect(next.json.next_cursor).toBeNull();
      const approvedOnly = await read(`/governance-rules?code=${code}&status=APPROVED`, READER);
      expect((approvedOnly.json.items as unknown[]).length).toBe(1);
      expect((await read('/governance-rules?status=NOPE', READER)).status).toBe(422);
      expect((await read('/governance-rules?rule_type=lower', READER)).status).toBe(422);
      expect((await read('/governance-rules?limit=0', READER)).status).toBe(422);
      expect((await read('/governance-rules?cursor=garbage', READER)).status).toBe(422);
    });

    it('answers every read with 403 to a caller without the read permission on the whole tenant, never with an empty list', async () => {
      for (const url of ['/governance-rules', '/governance-rules/catalog', '/alert-types', `/governance-rules/${randomUUID()}`, '/governance-rules/effective?rule_type=REMINDER_POLICY&code=DEFAULT']) {
        for (const member of [NOBODY, UNIT_ADMIN]) expect((await read(url, member)).status).toBe(403);
      }
    });

    it('reads one version, 404 for one that is not there, and the versions of a code', async () => {
      const code = nextCode();
      const id = idOf(await draft(MAKER, rule({ code })));
      const one = await read(`/governance-rules/${id}`, READER);
      expect(one.json).toMatchObject({ id, rule_type: 'REMINDER_POLICY', code, version: 1, status: 'DRAFT', unit_id: null, effective_from: day(1), effective_to: null, params: reminder(2) });
      expect((await read(`/governance-rules/${randomUUID()}`, READER)).status).toBe(404);
      expect((await read('/governance-rules/not-a-uuid', READER)).status).toBe(422);
      await draft(MAKER, rule({ code, params: reminder(3) }));
      const versions = await read(`/governance-rules/versions?rule_type=REMINDER_POLICY&code=${code}`, READER);
      expect((versions.json.items as Array<{ version: number }>).map((entry) => entry.version)).toEqual([2, 1]);
      expect((await read('/governance-rules/versions?rule_type=REMINDER_POLICY', READER)).status).toBe(422);
    });

    it('gives the effective rule of a code, or the built-in default with its provenance, and 404 when there is neither', async () => {
      const fallback = await read('/governance-rules/effective?rule_type=REMINDER_POLICY&code=DEFAULT', READER);
      expect(fallback.status).toBe(200);
      expect(fallback.json).toMatchObject({ source: 'DEFAULT', version: 0, rule_id: null, unverified: true, provenance: { legal_status: 'UNVERIFIED' } });
      const none = await read('/governance-rules/effective?rule_type=REMINDER_POLICY&code=NOT_A_CODE', READER);
      expect(none.status).toBe(404);
      expect(none.json.code).toBe('GOVERNANCE_RULE_NOT_FOUND');
      expect((await read('/governance-rules/effective?rule_type=NOT_A_REGISTERED_TYPE&code=DEFAULT', READER)).status).toBe(422);
      expect((await read('/governance-rules/effective?rule_type=REMINDER_POLICY&code=DEFAULT&as_of=2026-02-30', READER)).status).toBe(422);
    });

    it('compares a version with the one before it, with the built-in default when it is the first, and with a chosen version', async () => {
      const code = 'DEFAULT';
      const first = idOf(await draft(MAKER, rule({ code, params: reminder(2) })));
      const second = idOf(await draft(MAKER, rule({ code, params: reminder(3) })));
      const diff = await read(`/governance-rules/${second}/diff`, READER);
      expect(diff.json).toMatchObject({ from: { id: first, version: 1, source: 'RULE' }, to: { id: second, version: 2 }, changes: [{ path: 'every_working_hours.URGENT', before: 2, after: 3 }] });
      const against = await read(`/governance-rules/${first}/diff?against=${second}`, READER);
      expect(against.json).toMatchObject({ changes: [{ path: 'every_working_hours.URGENT', before: 3, after: 2 }] });
      const defaulted = await read(`/governance-rules/${first}/diff`, READER);
      expect(defaulted.json).toMatchObject({ from: { id: null, version: 0, source: 'DEFAULT' } });
      expect((defaulted.json.changes as Array<{ path: string }>).map((entry) => entry.path)).toContain('every_working_hours.URGENT');
      expect((await read(`/governance-rules/${randomUUID()}/diff`, READER)).status).toBe(404);
      expect((await read(`/governance-rules/${first}/diff?against=${randomUUID()}`, READER)).status).toBe(404);
    });

    it('lists the catalog: every type the platform registers with its schema, provenance and codes, and what governs today', async () => {
      const code = nextCode();
      await approved(rule({ code, effective_from: day(0) }));
      const catalog = await read('/governance-rules/catalog', READER);
      expect(catalog.status).toBe(200);
      const items = catalog.json.items as Array<{ rule_type: string; registered: boolean; owner_module: string; schema: unknown; legal_status: string; codes: Array<{ code: string; in_force: string; stored_versions: number; has_default: boolean; provenance: unknown }> }>;
      const types = items.map((entry) => entry.rule_type);
      expect(types).toEqual(expect.arrayContaining(['ALERT_TYPE', 'CLOCK_POLICY', 'EVM_POLICY', 'CHANGE_ORDER_TIER', 'PAYMENT_INTEGRITY', 'CONTRACT_HEALTH_RAG', 'EGP_POSTING_DEADLINES', 'DIRECTIVE_POLICY']));
      expect(items.length).toBeGreaterThanOrEqual(28);
      const reminders = items.find((entry) => entry.rule_type === 'REMINDER_POLICY');
      expect(reminders).toMatchObject({ registered: true, owner_module: 'HOME', legal_status: 'UNVERIFIED' });
      expect(reminders?.schema).toBeTruthy();
      expect(reminders?.codes.find((entry) => entry.code === 'DEFAULT')).toMatchObject({ has_default: true, in_force: 'DEFAULT', stored_versions: 0 });
      expect(reminders?.codes.find((entry) => entry.code === code)).toMatchObject({ has_default: false, in_force: 'RULE', stored_versions: 1, provenance: null });
    });

    it('lists a type that is stored but nobody registers, so that it is never hidden', async () => {
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by)
           values ($1, gen_random_uuid(), 'STRAY_TYPE_NOBODY_KNOWS', 'DEFAULT', 1, 'DRAFT', '{}'::jsonb, date '2999-01-01', 'Một loại lạ trong sổ', $2)`,
          [TENANT_A, memberId(MAKER)],
        ],
      ]);
      const items = (await read('/governance-rules/catalog', READER)).json.items as Array<{ rule_type: string; registered: boolean; schema: unknown }>;
      expect(items.find((entry) => entry.rule_type === 'STRAY_TYPE_NOBODY_KNOWS')).toMatchObject({ registered: false, schema: null });
    });
  });

  describe('the alert type registry (G0-3)', () => {
    it('lists every alert type with owner, expected action, consequence, response time, reason and review day', async () => {
      const reply = await read('/alert-types', READER);
      expect(reply.status).toBe(200);
      const items = reply.json.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThanOrEqual(30);
      const approval = items.find((entry) => entry.code === 'APPROVAL');
      expect(approval).toMatchObject({ source: 'APPROVAL', owner: 'APPROVER', response_hours: 72, default_severity: 'ACTION', rule_source: 'DEFAULT', version: 0, review_overdue: false, enabled: true });
      expect(String(approval?.consequence).length).toBeGreaterThan(10);
      expect(String(approval?.expected_action).length).toBeGreaterThan(10);
      for (const entry of items) {
        expect(entry.owner).toBeTruthy();
        expect(entry.consequence).toBeTruthy();
        expect(entry.response_hours).toBeGreaterThan(0);
        expect(entry.review_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(entry.provenance).toBeTruthy();
      }
      expect(items.map((entry) => entry.code)).toEqual(expect.arrayContaining(['EAC_EXCEEDS_TMDT', 'PAYMENT_INTEGRITY_BLOCKED', 'DIRECTIVE_OVERDUE', 'EGP_POSTING_OVERDUE']));
    });

    it('shows what an approved override of a type says from its first day, with the version, and flags a type past its review day', async () => {
      const id = await approved({ rule_type: 'ALERT_TYPE', code: 'APPROVAL', params: alertOverride({ response_hours: 12, review_on: '2020-01-01' }), effective_from: day(2), reason: 'Rút ngắn thời hạn đáp ứng' });
      const before = await read(`/alert-types/APPROVAL?as_of=${day(1)}`, READER);
      expect(before.json).toMatchObject({ response_hours: 72, rule_source: 'DEFAULT', version: 0 });
      const after = await read(`/alert-types/APPROVAL?as_of=${day(2)}`, READER);
      expect(after.json).toMatchObject({ response_hours: 12, rule_source: 'RULE', version: 1, rule_id: id, review_overdue: true, unverified: false });
      expect((after.json.versions as unknown[]).length).toBe(1);
      const list = await read(`/alert-types?as_of=${day(2)}`, READER);
      expect((list.json.items as Array<Record<string, unknown>>).find((entry) => entry.code === 'APPROVAL')).toMatchObject({ response_hours: 12, rule_source: 'RULE' });
      expect((await read('/alert-types/NOT_AN_ALERT_TYPE', READER)).json.code).toBe('GOVERNANCE_RULE_NOT_FOUND');
      expect((await read('/alert-types/lower', READER)).status).toBe(422);
    });

    it('refuses an alert type with no expected action that is not only to be watched, and one whose consequence is empty', async () => {
      const silent = await draft(MAKER, { rule_type: 'ALERT_TYPE', code: 'NEW_ALERT_TYPE', params: alertOverride({ expected_action: '', default_severity: 'URGENT' }), effective_from: day(1), reason: 'Loại cảnh báo mới không có hành động' });
      expect(silent.json).toMatchObject({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' });
      expect(String(silent.json.detail)).toContain('default_severity');
      const noConsequence = await draft(MAKER, { rule_type: 'ALERT_TYPE', code: 'NEW_ALERT_TYPE', params: alertOverride({ consequence: '' }), effective_from: day(1), reason: 'Loại cảnh báo mới không có hậu quả' });
      expect(String(noConsequence.json.detail)).toContain('consequence');
      const watchOnly = await draft(MAKER, { rule_type: 'ALERT_TYPE', code: 'NEW_ALERT_TYPE', params: alertOverride({ expected_action: '', default_severity: 'WATCH' }), effective_from: day(1), reason: 'Loại cảnh báo chỉ để theo dõi' });
      expect(watchOnly.status).toBe(201);
    });
  });
});
