import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { pmtModule } from '../../src/modules/pmt';
import { PermitGateController } from '../../src/modules/pmt/gate.controller';
import { PermitGateWaiverController } from '../../src/modules/pmt/gate-waiver.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const OFFICER = 1; // made the decision documents and answers for the dossier: permit.manage on the department
const LEADER = 2; // permit.gate.waive and permit.read on the department
const TENANT_LEADER = 3; // permit.gate.waive and permit.read on the whole tenant
const ELSEWHERE_LEADER = 4; // permit.gate.waive and permit.read on another branch
const READER = 5; // permit.read on the department only
const NOBODY = 6;
const B_LEADER = 1; // of tenant B
const FAMILY = 0x98;
const DAY_MS = 86_400_000;
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);

const PROJECT = id(FAMILY, 1);
const PROJECT_BRANCH = id(FAMILY, 2);
const FOREIGN_PROJECT = id(FAMILY, 3);
const TYPE_BUILDING = id(FAMILY, 31);
const TYPE_ENV = id(FAMILY, 32);
const BASIS = 'Luật Xây dựng 135/2025, điều 41';
const REASON = 'The authority allowed the work to begin while the permit is being finished';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the waivers of the permit gates over HTTP (ST-PMT-005)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const itemsOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A decision document version made by `creator` (the officer unless told otherwise). */
  async function decision(creator = OFFICER, tenant = TENANT_A): Promise<string> {
    const documentId = randomUUID();
    const versionId = randomUUID();
    await rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`, [tenant, documentId, memberId(creator)], tenant);
    await rows(
      `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
       values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
      [tenant, versionId, documentId, `tenants/pmt/${versionId}.pdf`],
      tenant,
    );
    return versionId;
  }

  const body = async (overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> => ({
    project_id: PROJECT,
    gate_code: 'START_CONSTRUCTION',
    permit_type_id: TYPE_BUILDING,
    reason: REASON,
    decision_document_version_id: await decision(),
    valid_until: inDays(30),
    ...overrides,
  });
  const grant = (payload: Record<string, unknown>, member = LEADER, options: { key?: string; tenantId?: string } = {}) =>
    call('POST', '/permit-gate-waivers', { member, body: payload, ...(options.key === undefined ? {} : { key: options.key }), ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }) });
  const revoke = (waiverId: string, reason: unknown = 'The permit was issued', member = LEADER) => call('POST', `/permit-gate-waivers/${waiverId}/revoke`, { member, body: { reason } });
  const clear = () => harness.owner(TENANT_A, [['update machvon.permit_gate_waiver set status = $1 where status = $2', ['EXPIRED', 'ACTIVE']]]);
  /** Every waiver there is, ended ones too: a waiver is never deleted, so a test counts against what it found. */
  const total = async (): Promise<number> => (await rows('select 1 from machvon.permit_gate_waiver')).length;
  const events = async (waiverId: string): Promise<string[]> => (await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [waiverId])).map((event) => event.type);
  const auditOf = (waiverId: string) => rows<{ action: string; actor_id: string; reason: string | null; diff: Record<string, unknown> }>('select action, actor_id, reason, safe_diff as diff from machvon.audit_event where resource_id = $1 order by occurred_at, id', [waiverId]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: '/u1/' },
        { n: 2, path: '/u1/u2/', parent: 1 },
        { n: 3, path: '/u3/' },
      ]);
    }
    for (const n of [OFFICER, LEADER, TENANT_LEADER, ELSEWHERE_LEADER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, B_LEADER, 1);
    await harness.seedRole(TENANT_A, 1, 'PERMIT_OFFICER', ['permit.manage', 'permit.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'WAIVER_LEADER', ['permit.gate.waive', 'permit.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'PERMIT_READER', ['permit.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'WAIVER_LEADER', ['permit.gate.waive', 'permit.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 2, member: LEADER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 3, member: TENANT_LEADER, role: 2, kind: 'TENANT' },
      { n: 4, member: ELSEWHERE_LEADER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(3)] },
      { n: 5, member: READER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_LEADER, role: 1, kind: 'TENANT' }]);
    await seedAs([
      ...([[PROJECT, 'PRJ-W-001', 2, TENANT_A], [PROJECT_BRANCH, 'PRJ-W-002', 3, TENANT_A], [FOREIGN_PROJECT, 'PRJ-W-FOREIGN', 2, TENANT_B]] as const).map(
        ([projectId, code, owner, tenant]): [string, unknown[]] => [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, 'B')`,
          [tenant, projectId, code, `Name of ${code}`, unitId(owner), unitId(1), id(FAMILY, 90)],
        ],
      ),
      ...([[TYPE_BUILDING, 'BUILDING'], [TYPE_ENV, 'ENV_PERMIT']] as const).map(([typeId, code]): [string, unknown[]] => [
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'OTHER', 'The authority', $5, date '2025-01-01', '{}'::jsonb, 'PUBLISHED', $6, $6)`,
        [TENANT_A, typeId, code, `Name of ${code}`, BASIS, memberId(OFFICER)],
      ]),
      [
        `insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, owner_membership_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5, $5)`,
        [TENANT_A, id(FAMILY, 11), PROJECT, unitId(2), memberId(OFFICER)],
      ],
      [
        `insert into machvon.permit_gate_rule (tenant_id, id, gate_code, permit_type_id, permit_type_code, requirement, applies_to_rule, legal_basis, effective_from, revision, status, created_by, updated_by)
         values ($1, $2, 'START_CONSTRUCTION', $3, 'BUILDING', 'VALID_PERMIT', '{}'::jsonb, $4, date '2026-01-01', 1, 'PUBLISHED', $5, $5)`,
        [TENANT_A, id(FAMILY, 21), TYPE_BUILDING, BASIS, memberId(OFFICER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PermitGateController, PermitGateWaiverController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  beforeEach(async () => {
    await clear();
  });

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of PMT', () => {
    expect(pmtModule.controllers).toContain(PermitGateWaiverController);
  });

  describe('grantPermitGateWaiver and revokePermitGateWaiver', () => {
    it('grants a waiver that lets the gate pass until it is revoked, with the audit rows and the events (AC-ST-PMT-005-1)', async () => {
      const blocked = await call('GET', `/projects/${PROJECT}/permit-gates?gate_code=START_CONSTRUCTION`, { member: LEADER });
      expect((blocked.json.gates as Array<Record<string, unknown>>)[0]?.status).toBe('BLOCKED');
      const granted = await grant(await body());
      expect(granted.status).toBe(200);
      expect(granted.json).toMatchObject({ status: 'ACTIVE', resource_version: 1 });
      const waiverId = idOf(granted);
      expect(await rows('select status, permit_type_code, created_by, approved_by, valid_until::text as valid_until from machvon.permit_gate_waiver where id = $1', [waiverId])).toEqual([
        { status: 'ACTIVE', permit_type_code: 'BUILDING', created_by: memberId(OFFICER), approved_by: memberId(LEADER), valid_until: inDays(30) },
      ]);
      const passed = await call('GET', `/projects/${PROJECT}/permit-gates?gate_code=START_CONSTRUCTION`, { member: LEADER });
      expect((passed.json.gates as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'PASSED_WITH_WAIVER', rules: [{ outcome: 'WAIVED', waiver: { id: waiverId, valid_until: inDays(30) } }] });

      const done = await revoke(waiverId, '  The permit was issued  ');
      expect(done.json).toMatchObject({ status: 'REVOKED', resource_version: 2 });
      const again = await call('GET', `/projects/${PROJECT}/permit-gates?gate_code=START_CONSTRUCTION`, { member: LEADER });
      expect((again.json.gates as Array<Record<string, unknown>>)[0]?.status).toBe('BLOCKED');
      expect(await events(waiverId)).toEqual(['pmt.gate_waiver.granted.v1', 'pmt.gate_waiver.revoked.v1']);
      const audits = await auditOf(waiverId);
      expect(audits.map((audit) => audit.action)).toEqual(['pmt.gate_waiver_granted', 'pmt.gate_waiver_revoked']);
      expect(audits[0]).toMatchObject({ actor_id: memberId(LEADER), reason: REASON, diff: { project_id: PROJECT, gate_code: 'START_CONSTRUCTION', permit_type_code: 'BUILDING', valid_until: inDays(30), days: 31 } });
      expect(audits[1]).toMatchObject({ reason: 'The permit was issued', diff: { from_status: 'ACTIVE', to_status: 'REVOKED' } });
      const event = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'pmt.gate_waiver.granted.v1'", [waiverId]);
      expect(event[0]?.payload).toMatchObject({ gate_waiver_id: waiverId, project_id: PROJECT, gate_code: 'START_CONSTRUCTION', permit_type_code: 'BUILDING', valid_until: inDays(30) });
      expect(JSON.stringify(event[0]?.payload)).not.toContain(REASON);
    });

    it('refuses a waiver of 91 days with the longest, and one approved by whoever asked for it (AC-ST-PMT-005-1)', async () => {
      const longer = await grant(await body({ valid_until: inDays(90) }));
      expect([longer.status, longer.json.code]).toEqual([422, 'WAIVER_TOO_LONG']);
      expect(longer.json).toMatchObject({ max_days: 90, requested_days: 91, latest_day: inDays(89) });
      expect((await grant(await body({ valid_until: inDays(89) }))).status).toBe(200);
      await clear();
      // The officer who made the decision is also a leader of the department here: they cannot approve what they asked for.
      const asker = await grant(await body(), TENANT_LEADER);
      expect(asker.status).toBe(200);
      await clear();
      const own = await grant(await body({ decision_document_version_id: await decision(TENANT_LEADER) }), TENANT_LEADER);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await rows('select 1 from machvon.permit_gate_waiver where created_by = $1', [memberId(TENANT_LEADER)])).toEqual([]);
    });

    it('takes only the fields of the contract, and refuses what is not valid', async () => {
      const before = await total();
      for (const extra of [{ status: 'ACTIVE' }, { approved_by: memberId(LEADER) }, { created_by: memberId(OFFICER) }, { tenant_id: TENANT_B }]) {
        const reply = await grant(await body(extra));
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      for (const [change, field] of [
        [{ gate_code: 'ANY_GATE' }, 'gate_code'],
        [{ valid_until: 'next week' }, 'valid_until'],
        [{ valid_until: inDays(-1) }, 'valid_until'],
        [{ reason: '   ' }, 'reason'],
        [{ permit_type_id: randomUUID() }, 'permit_type_id'],
      ] as const) {
        const reply = await grant(await body(change));
        expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      const noDecision = await grant(await body({ decision_document_version_id: randomUUID() }));
      expect([noDecision.status, noDecision.json.code]).toEqual([422, 'DECISION_DOCUMENT_REQUIRED']);
      expect((await grant({ project_id: PROJECT })).status).toBe(400);
      expect(await total()).toBe(before);
    });

    it('lets one waiver be in force for a project, a gate and a permit type, and answers a repeated request with the first answer', async () => {
      const key = `key-${randomUUID()}`;
      const payload = await body();
      const first = await grant(payload, LEADER, { key });
      const replay = await grant(payload, LEADER, { key });
      expect(replay.json.resource_id).toBe(first.json.resource_id);
      const second = await grant(await body());
      expect([second.status, second.json.code, second.json.active_waiver_id]).toEqual([409, 'WAIVER_STATE_INVALID', idOf(first)]);
      expect((await grant(await body({ gate_code: 'HANDOVER' }))).status).toBe(200);
      expect(await rows("select 1 from machvon.permit_gate_waiver where status = 'ACTIVE'")).toHaveLength(2);
    });

    it('needs the right to waive, over the project of the waiver', async () => {
      const before = await total();
      for (const member of [OFFICER, READER, NOBODY]) {
        const reply = await grant(await body(), member);
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      const elsewhere = await grant(await body(), ELSEWHERE_LEADER);
      expect([elsewhere.status, elsewhere.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const foreign = await grant(await body({ project_id: FOREIGN_PROJECT }), B_LEADER, { tenantId: TENANT_B });
      expect([foreign.status, foreign.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const crossTenant = await grant(await body({ project_id: FOREIGN_PROJECT }));
      expect([crossTenant.status, crossTenant.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(await total()).toBe(before);
    });

    it('revokes only a waiver in force, with a reason, within the scope of the caller', async () => {
      const waiverId = idOf(await grant(await body()));
      const blank = await revoke(waiverId, '   ');
      expect([blank.status, blank.json.code, blank.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
      expect((await revoke(waiverId, 'x', READER)).status).toBe(403);
      expect((await revoke(waiverId, 'x', ELSEWHERE_LEADER)).status).toBe(404);
      expect((await revoke(randomUUID())).status).toBe(404);
      expect((await call('POST', `/permit-gate-waivers/${waiverId}/revoke`, { member: LEADER, body: { reason: 'x', status: 'ACTIVE' } })).status).toBe(400);
      expect((await revoke(waiverId)).status).toBe(200);
      const twice = await revoke(waiverId);
      expect([twice.status, twice.json.code, twice.json.waiver_status]).toEqual([409, 'WAIVER_STATE_INVALID', 'REVOKED']);
      expect((await call('POST', '/permit-gate-waivers/not-an-id/revoke', { member: LEADER, body: { reason: 'x' } })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('the list of the waivers (PMT-06)', () => {
    it('lists the waivers newest first with the project, the permit type and the dates, without who asked or who approved', async () => {
      const first = idOf(await grant(await body()));
      await revoke(first, 'The permit was issued');
      const second = idOf(await grant(await body({ gate_code: 'HANDOVER', permit_type_id: TYPE_ENV, valid_until: inDays(10) })));
      const reply = await call('GET', `/resources/permit_gate_waiver?project_id=${PROJECT}`, { member: LEADER });
      expect(reply.status).toBe(200);
      expect(itemsOf(reply).slice(0, 2).map((item) => [item.id, item.status])).toEqual([
        [second, 'ACTIVE'],
        [first, 'REVOKED'],
      ]);
      expect(itemsOf(reply)[0]).toMatchObject({
        project: { id: PROJECT, code: 'PRJ-W-001' },
        gate_code: 'HANDOVER',
        permit_type_code: 'ENV_PERMIT',
        permit_type_name: 'Name of ENV_PERMIT',
        reason: REASON,
        valid_until: inDays(10),
        granted_on: inDays(0),
        revoked_on: null,
        version: 1,
      });
      expect(itemsOf(reply)[1]).toMatchObject({ revoked_on: inDays(0), revoked_reason: 'The permit was issued', version: 2 });
      expect(JSON.stringify(reply.json)).not.toContain(memberId(LEADER));
      expect(JSON.stringify(reply.json)).not.toContain(memberId(OFFICER));
      const active = await call('GET', '/resources/permit_gate_waiver?status=ACTIVE&gate_code=HANDOVER', { member: TENANT_LEADER });
      expect(itemsOf(active).map((item) => item.id)).toEqual([second]);
      const page1 = await call('GET', `/resources/permit_gate_waiver?project_id=${PROJECT}&limit=1`, { member: LEADER });
      expect(itemsOf(page1)).toHaveLength(1);
      const page2 = await call('GET', `/resources/permit_gate_waiver?project_id=${PROJECT}&limit=1&cursor=${encodeURIComponent(page1.json.next_cursor as string)}`, { member: LEADER });
      expect(itemsOf(page2).map((item) => item.id)).toEqual([first]);
      expect(typeof page2.json.next_cursor).toBe('string');
    });

    it('keeps to the scope and the tenant of the caller, and refuses a filter that is not valid', async () => {
      const waiverId = idOf(await grant(await body()));
      expect(itemsOf(await call('GET', '/resources/permit_gate_waiver?status=ACTIVE', { member: READER })).map((item) => item.id)).toEqual([waiverId]);
      expect(itemsOf(await call('GET', '/resources/permit_gate_waiver?status=ACTIVE', { member: ELSEWHERE_LEADER }))).toEqual([]);
      expect(itemsOf(await call('GET', '/resources/permit_gate_waiver?status=ACTIVE', { member: B_LEADER, tenantId: TENANT_B }))).toEqual([]);
      expect((await call('GET', '/resources/permit_gate_waiver', { member: NOBODY })).status).toBe(403);
      for (const query of ['status=OPEN', 'gate_code=ANY', 'project_id=not-an-id', 'limit=0']) {
        expect((await call('GET', `/resources/permit_gate_waiver?${query}`, { member: LEADER })).status).toBe(422);
      }
    });
  });
});
