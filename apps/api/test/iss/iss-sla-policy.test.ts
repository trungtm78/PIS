import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { IssSlaPolicyController } from '../../src/modules/iss/iss-sla-policy.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // issue.sla.manage
const READER = 2; // issue.read only
const NOBODY = 3;
const UNIT_MANAGER = 4; // issue.sla.manage on one subtree only
const OTHER_TENANT_MANAGER = 1; // of tenant B
const DAY_MS = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The Vietnam date `days` days from today: a policy may not begin in the past, and the controller reads the real clock. */
const inDays = (days: number): string => vietnamDateOf(new Date(Date.now() + days * DAY_MS));

describe('SLA policy commands (ST-ISS-001)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function post(url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = {
      [TENANT_HEADER]: tokenOf(options.member, options.tenantId),
      'content-type': 'application/json',
      'idempotency-key': options.key ?? `key-${randomUUID()}`,
    };
    const response = await fetch(`${app.baseUrl}${url}`, { method: 'POST', headers, body: JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  /** An issue category in force, as the version a policy is written against. */
  async function category(tenant = TENANT_A): Promise<string> {
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
    return versionId;
  }

  const payload = (categoryVersionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    code: `SLA-${randomUUID().slice(0, 8)}`,
    category_version_id: categoryVersionId,
    severity: 'HIGH',
    calendar_code: 'WORKDAY_VN',
    response_hours: 4,
    resolve_hours: 16,
    valid_from: inDays(2),
    ...extra,
  });
  const publish = (member: number, body: Record<string, unknown>, tenantId?: string): Promise<Reply> =>
    post('/issue-sla-policies', { member, body, ...(tenantId === undefined ? {} : { tenantId }) });
  const retire = (member: number, policyId: string, validUntil: string, tenantId?: string): Promise<Reply> =>
    post(`/issue-sla-policies/${policyId}/retire`, { member, body: { valid_until: validUntil }, ...(tenantId === undefined ? {} : { tenantId }) });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      // A policy may begin in the days to come, so the calendars of this year and of the next one are published.
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
    for (const n of [MANAGER, READER, NOBODY, UNIT_MANAGER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_MANAGER, 1);
    await harness.seedRole(TENANT_A, 1, 'SLA_MANAGER', ['issue.sla.manage', 'issue.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'ISSUE_READER', ['issue.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'SLA_MANAGER', ['issue.sla.manage'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: UNIT_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_MANAGER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [IssSlaPolicyController],
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

  describe('upsertIssueSlaPolicy', () => {
    it('publishes a policy and returns the id of the version, audited and announced in the same transaction (AC-ST-ISS-001-1)', async () => {
      const version = await category();
      const body = payload(version, { code: 'SLA-GPMB-HIGH', response_hours: 4, resolve_hours: 16 });
      const reply = await publish(MANAGER, body);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'ACTIVE', resource_version: 1 });
      const stored = await rows<{ code: string; revision: number; resolve_hours: number; status: string; valid_from: string; created_by: string }>(
        'select code, revision, resolve_hours, status, valid_from::text, created_by from machvon.issue_sla_policy where id = $1::uuid',
        [idOf(reply)],
      );
      expect(stored).toEqual([{ code: 'SLA-GPMB-HIGH', revision: 1, resolve_hours: 16, status: 'ACTIVE', valid_from: inDays(2), created_by: memberId(MANAGER) }]);
      const audit = await rows<{ action: string }>("select action from machvon.audit_event where resource_id = $1::uuid and action = 'iss.sla_policy_published'", [idOf(reply)]);
      expect(audit).toHaveLength(1);
      const events = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = $1::uuid and type = 'iss.sla_policy.published.v1'", [idOf(reply)]);
      expect(events).toHaveLength(1);
    });

    it('replaces a policy with the next revision from a later date and keeps the earlier revision for the issues created under it', async () => {
      const version = await category();
      const first = await publish(MANAGER, payload(version, { code: 'SLA-REV', resolve_hours: 72, valid_from: inDays(1) }));
      const second = await publish(MANAGER, payload(version, { code: 'SLA-REV', resolve_hours: 48, valid_from: inDays(10) }));
      expect([first.status, second.status]).toEqual([200, 200]);
      const stored = await rows<{ id: string; revision: number; resolve_hours: number; status: string; valid_until: string | null }>(
        'select id, revision, resolve_hours, status, valid_until::text from machvon.issue_sla_policy where code = $1 order by revision',
        ['SLA-REV'],
      );
      expect(stored).toEqual([
        { id: idOf(first), revision: 1, resolve_hours: 72, status: 'RETIRED', valid_until: inDays(10) },
        { id: idOf(second), revision: 2, resolve_hours: 48, status: 'ACTIVE', valid_until: null },
      ]);
    });

    it('rejects a second policy for the same category, severity and unit with 409 SLA_POLICY_OVERLAP and changes nothing (AC-ST-ISS-001-2)', async () => {
      const version = await category();
      const first = await publish(MANAGER, payload(version, { code: 'SLA-ONE' }));
      const second = await publish(MANAGER, payload(version, { code: 'SLA-TWO' }));
      expect([second.status, second.json.code]).toEqual([409, 'SLA_POLICY_OVERLAP']);
      expect(await rows('select id from machvon.issue_sla_policy where code = $1', ['SLA-TWO'])).toEqual([]);
      expect(await rows<{ status: string; version: string }>('select status, version::text from machvon.issue_sla_policy where id = $1::uuid', [idOf(first)])).toEqual([{ status: 'ACTIVE', version: '1' }]);
    });

    it('answers a retry with the same key with the first answer and writes once', async () => {
      const version = await category();
      const body = payload(version, { code: 'SLA-REPLAY' });
      const key = `key-${randomUUID()}`;
      const first = await post('/issue-sla-policies', { member: MANAGER, body, key });
      const again = await post('/issue-sla-policies', { member: MANAGER, body, key });
      expect([again.status, again.json.resource_id]).toEqual([200, idOf(first)]);
      expect(await rows('select id from machvon.issue_sla_policy where code = $1', ['SLA-REPLAY'])).toHaveLength(1);
      const different = await post('/issue-sla-policies', { member: MANAGER, body: { ...body, resolve_hours: 20 }, key });
      expect([different.status, different.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('refuses what the contract does not allow and what the rules do not allow, naming the field', async () => {
      const version = await category();
      const unknownField = await publish(MANAGER, { ...payload(version), tenant_id: TENANT_A });
      expect([unknownField.status, unknownField.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const withoutCalendar = payload(version);
      delete withoutCalendar.calendar_code;
      const missing = await publish(MANAGER, withoutCalendar);
      expect([missing.status, missing.json.code]).toEqual([400, 'INVALID_REQUEST']);
      const tooLong = await publish(MANAGER, payload(version, { resolve_hours: 3000 }));
      expect([tooLong.status, tooLong.json.code, tooLong.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'resolve_hours']);
      const past = await publish(MANAGER, payload(version, { valid_from: inDays(-3) }));
      expect([past.status, past.json.code, past.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'valid_from']);
      const noCalendar = await publish(MANAGER, payload(version, { calendar_code: 'NO_SUCH_CALENDAR' }));
      expect([noCalendar.status, noCalendar.json.code, noCalendar.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'calendar_code']);
    });

    it('refuses a caller without issue.sla.manage and a category of another tenant', async () => {
      const version = await category();
      expect((await publish(READER, payload(version))).status).toBe(403);
      expect((await publish(NOBODY, payload(version))).status).toBe(403);
      const foreign = await publish(MANAGER, payload(await category(TENANT_B)));
      expect([foreign.status, foreign.json.code, foreign.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'category_version_id']);
      expect(await rows('select id from machvon.issue_sla_policy where created_by = $1::uuid and code like $2', [memberId(READER), 'SLA-%'])).toEqual([]);
    });
  });

  describe('scope of the SLA policy commands (ISS 2: issue.sla.manage is held on the whole tenant)', () => {
    it('refuses a caller who holds issue.sla.manage only on a subtree, for the default of the tenant and for a unit, and writes nothing', async () => {
      const version = await category();
      const tenantDefault = await publish(UNIT_MANAGER, payload(version, { code: 'SLA-SUBTREE-DEFAULT' }));
      expect([tenantDefault.status, tenantDefault.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const forUnit = await publish(UNIT_MANAGER, payload(version, { code: 'SLA-SUBTREE-UNIT', owner_unit_id: unitId(1) }));
      expect([forUnit.status, forUnit.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select id from machvon.issue_sla_policy where code like $1', ['SLA-SUBTREE-%'])).toEqual([]);
    });

    it('refuses to retire a policy for a caller who holds issue.sla.manage only on a subtree', async () => {
      const created = await publish(MANAGER, payload(await category(), { code: 'SLA-SUBTREE-RETIRE' }));
      const reply = await retire(UNIT_MANAGER, idOf(created), inDays(30));
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows<{ status: string }>('select status from machvon.issue_sla_policy where id = $1::uuid', [idOf(created)])).toEqual([{ status: 'ACTIVE' }]);
    });
  });

  describe('retireIssueSlaPolicy', () => {
    it('ends a policy from a date and keeps the row as it was, then refuses to end it again', async () => {
      const version = await category();
      const created = await publish(MANAGER, payload(version, { code: 'SLA-RETIRE', resolve_hours: 24 }));
      const until = inDays(30);
      const reply = await retire(MANAGER, idOf(created), until);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'RETIRED', resource_version: 2, resource_id: idOf(created) });
      const stored = await rows<{ status: string; valid_until: string; resolve_hours: number; version: string }>(
        'select status, valid_until::text, resolve_hours, version::text from machvon.issue_sla_policy where id = $1::uuid',
        [idOf(created)],
      );
      expect(stored).toEqual([{ status: 'RETIRED', valid_until: until, resolve_hours: 24, version: '2' }]);
      const again = await retire(MANAGER, idOf(created), inDays(40));
      expect([again.status, again.json.code]).toEqual([409, 'SLA_POLICY_STATE_INVALID']);
      const events = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = $1::uuid and type = 'iss.sla_policy.retired.v1'", [idOf(created)]);
      expect(events).toHaveLength(1);
      const audit = await rows<{ action: string }>("select action from machvon.audit_event where resource_id = $1::uuid and action = 'iss.sla_policy_retired'", [idOf(created)]);
      expect(audit).toHaveLength(1);
    });

    it('refuses an end date before the policy begins, a policy that is not there, a policy of another tenant and a caller without the permission', async () => {
      const version = await category();
      const created = await publish(MANAGER, payload(version, { code: 'SLA-GUARDS', valid_from: inDays(20) }));
      const early = await retire(MANAGER, idOf(created), inDays(10));
      expect([early.status, early.json.code, early.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'valid_until']);
      expect((await retire(MANAGER, randomUUID(), inDays(40))).status).toBe(404);
      expect((await retire(OTHER_TENANT_MANAGER, idOf(created), inDays(40), TENANT_B)).status).toBe(404);
      expect((await retire(READER, idOf(created), inDays(40))).status).toBe(403);
      expect((await post(`/issue-sla-policies/not-a-uuid/retire`, { member: MANAGER, body: { valid_until: inDays(40) } })).status).toBe(422);
      expect(await rows<{ status: string }>('select status from machvon.issue_sla_policy where id = $1::uuid', [idOf(created)])).toEqual([{ status: 'ACTIVE' }]);
    });
  });
});
