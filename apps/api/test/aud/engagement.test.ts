import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { audModule } from '../../src/modules/aud';
import { AuditEngagementController, AuditEngagementReadsController } from '../../src/modules/aud/engagement.controller';
import { MODULES } from '../../src/modules/registry';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // aud.engagement.manage and aud.read over the whole tenant
const DEPARTMENT_MANAGER = 2; // the same over the subtree of unit 2
const OUTSIDER = 3; // the same over another branch, where the engagement is not
const READER = 4; // aud.read over the whole tenant, nothing more
const NOBODY = 5;
const COORDINATOR = 6;
const B_MANAGER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x93;
const PROJECT = id(FAMILY, 1);
const CONTRACT = id(FAMILY, 2);
const DECISION = id(FAMILY, 10);
const PENDING_DECISION = id(FAMILY, 11);
const DOSSIER = id(FAMILY, 20);
const WORKER = '00000000-0000-4000-8000-000000000000';
const PERIOD = { period_from: '2025-01-01', period_to: '2025-12-31' };

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

describe('audit and inspection engagements over HTTP (ST-AUD-001, AUD-02, AUD-03)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // The projects, contracts, documents and dossiers belong to other modules: the superuser seeds them with the foreign keys switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return {
      engagement_code: `TTCP-2026-${String(counter).padStart(3, '0')}`,
      engagement_type: 'ADMINISTRATIVE_INSPECTION',
      authority_kind: 'PROVINCIAL_INSPECTORATE',
      authority_name: 'Provincial Inspectorate',
      decision_document_id: DECISION,
      title: 'Inspection of the investment in the bridge',
      ...PERIOD,
      coordinator_user_id: memberId(COORDINATOR),
      scope: [
        { kind: 'PROJECT', id: PROJECT },
        { kind: 'CONTRACT', id: CONTRACT },
      ],
      ...extra,
    };
  };
  const create = (member: number, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', '/audit-engagements', { member, body: body(extra), ...options });
  const command = (member: number, engagementId: string, action: string, version: number | string, payload: Record<string, unknown>, key?: string): Promise<Reply> =>
    call('POST', `/audit-engagements/${engagementId}/${action}`, { member, ifMatch: `"${version}"`, body: payload, ...(key === undefined ? {} : { key }) });
  const start = (member: number, engagementId: string, version: number | string, extra: Record<string, unknown> = {}, key?: string) =>
    command(member, engagementId, 'start', version, { started_on: '2026-10-20', place_legal_hold: true, ...extra }, key);
  const audits = (engagementId: string): Promise<Array<{ action: string; classification: string; safe_diff: Record<string, unknown> }>> =>
    rows('select action, classification, safe_diff from machvon.audit_event where resource_id = $1 order by occurred_at, id', [engagementId]);
  const events = (engagementId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> =>
    rows('select type, payload from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [engagementId]);
  const holdOf = async (engagementId: string) =>
    (await rows<{ hold_kind: string; status: string; resource_scope: { kind: string; ids: string[] }; released_by: string | null }>(
      'select h.hold_kind, h.status, h.resource_scope, h.released_by from machvon.legal_hold h join machvon.audit_engagement e on e.legal_hold_id = h.id where e.id = $1',
      [engagementId],
    ))[0];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MANAGER, DEPARTMENT_MANAGER, OUTSIDER, READER, NOBODY, COORDINATOR]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'AUD_MANAGER', ['aud.engagement.manage', 'aud.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'AUD_READER', ['aud.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'AUD_MANAGER', ['aud.engagement.manage', 'aud.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: OUTSIDER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: READER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    await seedAs([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-A-001', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, unitId(DEPARTMENT), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version)
         values ($1, $2, $3, $4, $4, 'C-01', 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
        [TENANT_A, CONTRACT, PROJECT, id(FAMILY, 31)],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to inspect the bridge', '12/QD-TTCP', '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4),
                ($1, $3, 'REFERENCE', 'QD', 'A decision not yet in force', null, null, 'PENDING', 'INTERNAL', $4, $4)`,
        [TENANT_A, DECISION, PENDING_DECISION, memberId(MANAGER)],
      ],
      [
        `insert into machvon.dossier (tenant_id, id, dossier_code, year, title, organization_unit_id, subject_module, subject_id, category_code, status, created_by, updated_by)
         values ($1, $2, 'HS-2026-01', 2026, 'Dossier of the bridge', $3, 'PRJ', $4, 'PROJECT', 'OPEN', $5, $5)`,
        [TENANT_A, DOSSIER, unitId(DEPARTMENT), PROJECT, memberId(MANAGER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AuditEngagementController, AuditEngagementReadsController],
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

  it('is registered once in the module registry with the controllers of the engagements', () => {
    expect(MODULES.filter((module) => module.code === 'AUD')).toHaveLength(1);
    expect(audModule.controllers).toEqual([AuditEngagementController, AuditEngagementReadsController]);
  });

  describe('createAuditEngagement and startAuditEngagement', () => {
    it('AC-ST-AUD-001-1 / UAT-AC433: registers the engagement with two scope items, starts it ONGOING with an Active INSPECTION hold on the scope, and refuses a duplicate code', async () => {
      const made = await create(MANAGER, { engagement_code: 'TTCP-AC1' });
      expect(made).toMatchObject({ status: 200, json: { status: 'PLANNED', resource_version: 1 } });
      const engagementId = idOf(made);
      const planned = await call('GET', `/audit-engagements/${engagementId}`, { member: MANAGER });
      expect(planned.json).toMatchObject({ status: 'PLANNED', scope_count: 2, legal_hold: null, classification: 'CONFIDENTIAL', decision: { symbol: '12/QD-TTCP', effect_status: 'EFFECTIVE' } });
      expect((planned.json.scope as Array<{ kind: string; code: string }>).map((item) => [item.kind, item.code])).toEqual([
        ['CONTRACT', 'C-01'],
        ['PROJECT', 'P-A-001'],
      ]);

      const started = await start(MANAGER, engagementId, 1);
      expect(started).toMatchObject({ status: 200, json: { status: 'ONGOING', resource_version: 2 } });
      const ongoing = await call('GET', `/audit-engagements/${engagementId}`, { member: MANAGER });
      expect(ongoing.json).toMatchObject({ status: 'ONGOING', started_on: '2026-10-20', legal_hold: { status: 'Active' }, version: 2 });
      const hold = await holdOf(engagementId);
      expect(hold).toMatchObject({ hold_kind: 'INSPECTION', status: 'Active' });
      expect([...(hold?.resource_scope.ids ?? [])].sort()).toEqual([CONTRACT, PROJECT].sort());
      // What the scope contains is held: the dossier about the project cannot be disposed of.
      const [held] = await rows<{ held: boolean }>("select machvon.legal_hold_blocks('dossier', $1::uuid) as held", [DOSSIER]);
      expect(held?.held).toBe(true);

      const duplicate = await create(MANAGER, { engagement_code: 'TTCP-AC1' });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'ENGAGEMENT_CODE_DUPLICATE']);
      expect((await rows<{ n: string }>("select count(*) as n from machvon.audit_engagement where engagement_code = 'TTCP-AC1'"))[0]?.n).toBe('1');
    });

    it('starts without a hold when none is asked for, and holds as an AUDIT for an audit', async () => {
      const plain = idOf(await create(MANAGER));
      expect(await start(MANAGER, plain, 1, { place_legal_hold: false })).toMatchObject({ status: 200, json: { status: 'ONGOING' } });
      expect(await holdOf(plain)).toBeUndefined();
      const audit = idOf(await create(MANAGER, { engagement_type: 'STATE_AUDIT', authority_kind: 'STATE_AUDIT_OFFICE' }));
      await start(MANAGER, audit, 1);
      expect((await holdOf(audit))?.hold_kind).toBe('AUDIT');
      await rows('update machvon.legal_hold set status = \'Released\', released_at = now(), released_by = $1, release_reason = \'The test is over for this engagement.\' where status = \'Active\' and id in (select legal_hold_id from machvon.audit_engagement where id = $2)', [WORKER, audit]);
    });

    it('answers a replay with the first body, refuses the same key with another body, and the second start is a conflict of state', async () => {
      const key = `create-${randomUUID()}`;
      const payload = body();
      const first = await call('POST', '/audit-engagements', { member: MANAGER, body: payload, key });
      const again = await call('POST', '/audit-engagements', { member: MANAGER, body: payload, key });
      expect(again.json).toEqual(first.json);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      const other = await call('POST', '/audit-engagements', { member: MANAGER, body: { ...payload, title: 'Another title for the same key' }, key });
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      const engagementId = idOf(first);
      expect((await rows<{ n: string }>('select count(*) as n from machvon.audit_engagement where id = $1', [engagementId]))[0]?.n).toBe('1');
      expect(await events(engagementId)).toHaveLength(1);
      const startKey = `start-${randomUUID()}`;
      const started = await start(MANAGER, engagementId, 1, { place_legal_hold: false }, startKey);
      expect((await start(MANAGER, engagementId, 1, { place_legal_hold: false }, startKey)).json).toEqual(started.json);
      const second = await start(MANAGER, engagementId, 2, { place_legal_hold: false });
      expect([second.status, second.json.code]).toEqual([409, 'ENGAGEMENT_STATE_INVALID']);
      expect((await audits(engagementId)).filter((entry) => entry.action === 'aud.engagement_started')).toHaveLength(1);
    });

    it('refuses what the register cannot take: a decision that is not in force, a scope that is not in the tenant or is of nothing, a coordinator who is not a member, and a bad window', async () => {
      const refusals: Array<[Record<string, unknown>, number, string]> = [
        [{ decision_document_id: PENDING_DECISION }, 422, 'DECISION_DOCUMENT_NOT_EFFECTIVE'],
        [{ decision_document_id: randomUUID() }, 422, 'DECISION_DOCUMENT_NOT_EFFECTIVE'],
        [{ scope: [{ kind: 'PROJECT', id: randomUUID() }] }, 404, 'RESOURCE_NOT_FOUND'],
        [{ scope: [] }, 422, 'VALIDATION_FAILED'],
        [{ scope: [{ kind: 'ROOM', id: PROJECT }] }, 422, 'VALIDATION_FAILED'],
        [{ scope: [{ kind: 'PROJECT' }] }, 422, 'VALIDATION_FAILED'],
        [{ coordinator_user_id: randomUUID() }, 422, 'VALIDATION_FAILED'],
        [{ period_from: '2025-12-31', period_to: '2025-01-01' }, 422, 'VALIDATION_FAILED'],
      ];
      for (const [extra, status, code] of refusals) {
        const reply = await create(MANAGER, extra);
        expect([reply.status, reply.json.code]).toEqual([status, code]);
      }
      const missing = await call('POST', '/audit-engagements', { member: MANAGER, body: { engagement_code: 'TTCP-MISSING' } });
      expect(missing.status).toBeGreaterThanOrEqual(400);
      const noKey = await fetch(`${app.baseUrl}/audit-engagements`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(MANAGER), 'content-type': 'application/json' }, body: JSON.stringify(body()) });
      expect(noKey.status).toBe(400);
    });

    it('lets the caller register and start only what they manage: a department manager takes the department, an outsider is refused (403), a reader and nobody cannot write', async () => {
      expect((await create(DEPARTMENT_MANAGER)).status).toBe(200);
      expect(await create(OUTSIDER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await create(READER)).status).toBe(403);
      expect((await create(NOBODY)).status).toBe(403);
      const engagementId = idOf(await create(MANAGER));
      expect((await start(READER, engagementId, 1)).status).toBe(403);
      expect((await start(NOBODY, engagementId, 1)).status).toBe(403);
      expect(await start(OUTSIDER, engagementId, 1)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await start(MANAGER, engagementId, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await start(MANAGER, engagementId, 'abc')).status).toBeGreaterThanOrEqual(400);
      expect((await rows<{ status: string }>('select status from machvon.audit_engagement where id = $1', [engagementId]))[0]?.status).toBe('PLANNED');
    });

    it('writes an audit row and an event for each command that name codes and ids and carry neither the title nor the authority', async () => {
      const made = await create(MANAGER, { engagement_code: 'TTCP-TRAIL', title: 'A secret title of the inspection', authority_name: 'A secret authority' });
      const engagementId = idOf(made);
      await start(MANAGER, engagementId, 1);
      await command(MANAGER, engagementId, 'fieldwork-end', 2, { on_date: '2026-10-21' });
      const trail = await audits(engagementId);
      expect(trail.map((entry) => entry.action)).toEqual(['aud.engagement_created', 'aud.engagement_started', 'aud.engagement_fieldwork_ended']);
      expect(trail.every((entry) => entry.classification === 'CONFIDENTIAL')).toBe(true);
      const told = await events(engagementId);
      expect(told.map((event) => event.type)).toEqual(['aud.engagement.created.v1', 'aud.engagement.started.v1', 'aud.engagement.fieldwork_ended.v1']);
      expect(told[1]?.payload).toMatchObject({ engagement_id: engagementId, engagement_code: 'TTCP-TRAIL', started_on: '2026-10-20', actor_id: memberId(MANAGER) });
      const everything = JSON.stringify([trail, told]);
      for (const secret of ['A secret title', 'A secret authority']) expect(everything).not.toContain(secret);
    });
  });

  describe('endAuditFieldwork and cancelAuditEngagement', () => {
    it('ends the fieldwork once, inside the days of the engagement, and keeps the order of the states', async () => {
      const engagementId = idOf(await create(MANAGER));
      expect(await command(MANAGER, engagementId, 'fieldwork-end', 1, { on_date: '2026-10-21' })).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
      await start(MANAGER, engagementId, 1, { place_legal_hold: false });
      expect(await command(MANAGER, engagementId, 'fieldwork-end', 2, { on_date: '2026-10-19' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await command(MANAGER, engagementId, 'fieldwork-end', 2, { on_date: '2999-01-01' })).toMatchObject({ status: 422 });
      expect(await command(MANAGER, engagementId, 'fieldwork-end', 2, { on_date: '2026-10-21' })).toMatchObject({ status: 200, json: { status: 'AWAITING_CONCLUSION', resource_version: 3 } });
      expect(await command(MANAGER, engagementId, 'fieldwork-end', 3, { on_date: '2026-10-22' })).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
    });

    it('AC-ST-AUD-001-3 / UAT-AC443: cancels a started engagement, releases its hold, and a start after the cancellation is 409 ENGAGEMENT_STATE_INVALID', async () => {
      const engagementId = idOf(await create(MANAGER, { engagement_code: 'TTCP-AC3' }));
      await start(MANAGER, engagementId, 1);
      expect((await holdOf(engagementId))?.status).toBe('Active');
      expect(await command(MANAGER, engagementId, 'cancellation', 2, { on_date: '2026-10-21', reason: 'short' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await command(MANAGER, engagementId, 'cancellation', 2, { on_date: '2026-10-21', reason: 'The authority withdrew its decision.' })).toMatchObject({ status: 200, json: { status: 'CANCELLED', resource_version: 3 } });
      const cancelled = await call('GET', `/audit-engagements/${engagementId}`, { member: MANAGER });
      expect(cancelled.json).toMatchObject({ status: 'CANCELLED', cancel_reason: 'The authority withdrew its decision.', legal_hold: { status: 'Released' } });
      expect(await holdOf(engagementId)).toMatchObject({ status: 'Released', released_by: WORKER });
      const [held] = await rows<{ held: boolean }>("select machvon.legal_hold_blocks('dossier', $1::uuid) as held", [DOSSIER]);
      // Other engagements of this file may still hold the project; this one no longer does.
      expect(typeof held?.held).toBe('boolean');
      expect(await start(MANAGER, engagementId, 3)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
      expect(await command(MANAGER, engagementId, 'cancellation', 3, { on_date: '2026-10-21', reason: 'Cancelled for a second time.' })).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
      const trail = await audits(engagementId);
      expect(trail.at(-1)).toMatchObject({ action: 'aud.engagement_cancelled', safe_diff: { to_status: 'CANCELLED', legal_hold_released: true } });
    });

    it('cancels a PLANNED engagement without any hold', async () => {
      const engagementId = idOf(await create(MANAGER));
      expect(await command(MANAGER, engagementId, 'cancellation', 1, { on_date: '2026-10-21', reason: 'Registered by mistake, withdrawn.' })).toMatchObject({ status: 200, json: { status: 'CANCELLED' } });
      expect(await holdOf(engagementId)).toBeUndefined();
    });
  });

  describe('reads: an engagement outside the scope is not there (404)', () => {
    let engagementId = '';

    beforeAll(async () => {
      engagementId = idOf(await create(MANAGER, { engagement_code: 'TTCP-READ', engagement_type: 'SPECIALIZED_INSPECTION' }));
    });

    it('AC-ST-AUD-001-2 / UAT-AC442: answers 404 to a coordinator of another tenant and to a user of this tenant outside the scope, and lists nothing for them', async () => {
      const otherTenant = await call('GET', `/audit-engagements/${engagementId}`, { member: B_MANAGER, tenantId: TENANT_B });
      const outside = await call('GET', `/audit-engagements/${engagementId}`, { member: OUTSIDER });
      expect([otherTenant.status, otherTenant.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect([outside.status, outside.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(JSON.stringify([otherTenant.json, outside.json])).not.toContain('TTCP-READ');
      for (const [member, tenantId] of [[B_MANAGER, TENANT_B], [OUTSIDER, TENANT_A]] as const) {
        const list = await call('GET', '/audit-engagements?limit=200', { member, tenantId });
        expect(list.status).toBe(200);
        expect(list.json.items).toEqual([]);
        expect(JSON.stringify(list.json)).not.toContain('TTCP-READ');
      }
      expect((await call('GET', `/audit-engagements/${randomUUID()}`, { member: MANAGER })).status).toBe(404);
      expect((await call('GET', '/audit-engagements/not-a-uuid', { member: MANAGER })).status).toBe(422);
    });

    it('shows the engagement to the department that owns the project, to the whole-tenant reader, and refuses a caller without the right to read (403)', async () => {
      for (const member of [DEPARTMENT_MANAGER, READER, MANAGER]) expect((await call('GET', `/audit-engagements/${engagementId}`, { member })).status).toBe(200);
      expect((await call('GET', `/audit-engagements/${engagementId}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/audit-engagements', { member: NOBODY })).status).toBe(403);
    });

    it('pages the list by code, filters by status, type and project, and bounds the page', async () => {
      const all = await call('GET', '/audit-engagements?limit=200', { member: MANAGER });
      const items = all.json.items as Array<{ id: string; engagement_code: string; status: string; engagement_type: string }>;
      expect(items.map((item) => item.engagement_code)).toEqual(items.map((item) => item.engagement_code).sort());
      expect(items.length).toBeGreaterThan(3);
      const first = await call('GET', '/audit-engagements?limit=2', { member: MANAGER });
      expect((first.json.items as unknown[]).length).toBe(2);
      expect(typeof first.json.next_cursor).toBe('string');
      const next = await call('GET', `/audit-engagements?limit=2&cursor=${first.json.next_cursor as string}`, { member: MANAGER });
      const firstCodes = (first.json.items as Array<{ engagement_code: string }>).map((item) => item.engagement_code);
      expect((next.json.items as Array<{ engagement_code: string }>).every((item) => item.engagement_code > (firstCodes[1] as string))).toBe(true);
      const specialised = await call('GET', '/audit-engagements?engagement_type=SPECIALIZED_INSPECTION&limit=200', { member: MANAGER });
      expect((specialised.json.items as Array<{ engagement_code: string }>).map((item) => item.engagement_code)).toEqual(['TTCP-READ']);
      expect(((await call('GET', '/audit-engagements?status=CANCELLED&limit=200', { member: MANAGER })).json.items as Array<{ status: string }>).every((item) => item.status === 'CANCELLED')).toBe(true);
      expect(((await call('GET', `/audit-engagements?project_id=${PROJECT}&limit=200`, { member: MANAGER })).json.items as unknown[]).length).toBeGreaterThan(3);
      expect((await call('GET', `/audit-engagements?project_id=${randomUUID()}&limit=200`, { member: MANAGER })).json.items).toEqual([]);
      expect((await call('GET', '/audit-engagements?project_id=nope', { member: MANAGER })).status).toBe(422);
      expect((await call('GET', '/audit-engagements?limit=0', { member: MANAGER })).status).toBeGreaterThanOrEqual(400);
    });

    it('commands on an engagement outside the scope are 404, never 403, and change nothing', async () => {
      const before = await audits(engagementId);
      expect(await start(OUTSIDER, engagementId, 1)).toMatchObject({ status: 404 });
      expect(await command(OUTSIDER, engagementId, 'cancellation', 1, { on_date: '2026-10-21', reason: 'An outsider tries to cancel it.' })).toMatchObject({ status: 404 });
      expect(await call('POST', `/audit-engagements/${engagementId}/fieldwork-end`, { member: B_MANAGER, tenantId: TENANT_B, ifMatch: '"1"', body: { on_date: '2026-10-21' } })).toMatchObject({ status: 404 });
      expect(await audits(engagementId)).toEqual(before);
    });
  });
});
