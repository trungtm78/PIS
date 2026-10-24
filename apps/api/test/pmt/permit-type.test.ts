import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { PermitTypeController, PermitTypeReadsController } from '../../src/modules/pmt/permit-type.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // permit.catalogue.manage on the whole tenant
const READER = 2; // permit.read only
const NOBODY = 3;
const SUBTREE_MANAGER = 4; // permit.catalogue.manage on one unit subtree only
const OTHER_TENANT_MANAGER = 1; // of tenant B
const DAY_MS = 86_400_000;
const DOSSIER = id(0x92, 1);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The Vietnam date `days` days from today: a later revision may not begin in the past, and the controller reads the real clock. */
const inDays = (days: number): string => vietnamDateOf(new Date(Date.now() + days * DAY_MS));

describe('permit type commands (ST-PMT-001)', () => {
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

  async function get(url: string, options: { member: number; tenantId?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId) };
    const response = await fetch(`${app.baseUrl}${url}`, { headers });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const freshCode = (): string => {
    counter += 1;
    return `API_PERMIT_${counter}`;
  };

  const payload = (code: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    code,
    name: 'Building permit',
    category: 'CONSTRUCTION_PERMIT',
    authority_text: 'The authority the regulation names',
    legal_basis: 'Construction Law 135/2025 [CXN-EXE-02]',
    effective_from: '2026-01-01',
    applies_to_rule: {},
    ...extra,
  });
  const publish = (member: number, body: Record<string, unknown>, tenantId?: string): Promise<Reply> =>
    post('/permit-types', { member, body, ...(tenantId === undefined ? {} : { tenantId }) });
  const retire = (member: number, typeId: string, until: string, tenantId?: string): Promise<Reply> =>
    post(`/permit-types/${typeId}/retire`, { member, body: { effective_until: until }, ...(tenantId === undefined ? {} : { tenantId }) });

  async function seedPermit(typeId: string, status: string, expectedDecisionOn: string | null): Promise<void> {
    const issued = status === 'ISSUED';
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, status, expected_decision_on, permit_no, issued_on, valid_from, no_expiry, document_version_id, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, $3, $4, $5::date, $7, $8::date, $8::date, $9, $10, $6, $6)`,
        // An issued permit carries its number, its day and its scan (permit_issued_chk).
        [TENANT_A, DOSSIER, typeId, status, expectedDecisionOn, memberId(MANAGER), issued ? randomUUID().slice(0, 8) : null, issued ? '2026-02-01' : null, issued, issued ? randomUUID() : null],
      );
    } finally {
      await admin.end();
    }
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [MANAGER, READER, NOBODY, SUBTREE_MANAGER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_MANAGER, 1);
    await harness.seedRole(TENANT_A, 1, 'LEGAL_COUNSEL', ['permit.catalogue.manage', 'permit.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'PERMIT_READER', ['permit.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'LEGAL_COUNSEL', ['permit.catalogue.manage', 'permit.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: SUBTREE_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_MANAGER, role: 1, kind: 'TENANT' }]);
    // The rows around a permit (the project, the dossier) are not what is under test.
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query('insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5)', [
        TENANT_A,
        DOSSIER,
        id(0x91, 1),
        unitId(1),
        memberId(MANAGER),
      ]);
    } finally {
      await admin.end();
    }
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PermitTypeController, PermitTypeReadsController],
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

  describe('publishPermitType', () => {
    it('publishes a version and returns its id, audited and announced in the same transaction (AC-ST-PMT-001-1)', async () => {
      const code = freshCode();
      const reply = await publish(MANAGER, payload(code, { cxn_ref: 'CXN-EXE-02', default_validity_months: 24, exemption_allowed: true }));
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'PUBLISHED', resource_version: 1 });
      const stored = await rows<{ code: string; revision: number; status: string; cxn_ref: string; effective_from: string; exemption_allowed: boolean; created_by: string }>(
        'select code, revision, status, cxn_ref, effective_from::text, exemption_allowed, created_by from machvon.permit_type where id = $1::uuid',
        [idOf(reply)],
      );
      expect(stored).toEqual([{ code, revision: 1, status: 'PUBLISHED', cxn_ref: 'CXN-EXE-02', effective_from: '2026-01-01', exemption_allowed: true, created_by: memberId(MANAGER) }]);
      const audit = await rows<{ action: string }>("select action from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_type_published'", [idOf(reply)]);
      expect(audit).toHaveLength(1);
      const events = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit_type.published.v1'", [idOf(reply)]);
      expect(events).toHaveLength(1);
    });

    it.each([
      ['absent', undefined],
      ['empty', ''],
      ['blank', '   '],
    ])('rejects a version whose legal basis is %s with 422 LEGAL_BASIS_REQUIRED and stores nothing (UAT-AC371, AC-ST-PMT-001-1)', async (_name, legalBasis) => {
      const code = freshCode();
      const body = payload(code);
      if (legalBasis === undefined) delete body.legal_basis;
      else body.legal_basis = legalBasis;
      const reply = await publish(MANAGER, body);
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'LEGAL_BASIS_REQUIRED', 'legal_basis']);
      expect(await rows('select id from machvon.permit_type where code = $1', [code])).toEqual([]);
    });

    it('takes the next revision over from its first day, rejects overlapping periods and keeps what is in use unchanged (UAT-AC371, AC-ST-PMT-001-1)', async () => {
      const code = freshCode();
      const first = await publish(MANAGER, payload(code, { effective_from: '2026-01-01' }));
      await seedPermit(idOf(first), 'IN_APPRAISAL', inDays(400));
      const takeOver = inDays(30);
      const second = await publish(MANAGER, payload(code, { effective_from: takeOver, legal_basis: 'Decree 217/2026, article 3' }));
      expect([second.status, second.json.resource_version]).toEqual([200, 1]);
      const stored = await rows<{ id: string; revision: number; status: string; effective_until: string | null; legal_basis: string }>(
        'select id, revision, status, effective_until::text, legal_basis from machvon.permit_type where code = $1 order by revision',
        [code],
      );
      const dayBefore = vietnamDateOf(new Date(Date.parse(`${takeOver}T00:00:00Z`) - DAY_MS));
      expect(stored).toEqual([
        { id: idOf(first), revision: 1, status: 'RETIRED', effective_until: dayBefore, legal_basis: 'Construction Law 135/2025 [CXN-EXE-02]' },
        { id: idOf(second), revision: 2, status: 'PUBLISHED', effective_until: null, legal_basis: 'Decree 217/2026, article 3' },
      ]);
      // The permit written under the first revision still names it.
      expect(await rows<{ permit_type_id: string }>('select permit_type_id from machvon.permit where permit_type_id = $1::uuid', [idOf(first)])).toHaveLength(1);
      const overlapping = await publish(MANAGER, payload(code, { effective_from: inDays(10) }));
      expect([overlapping.status, overlapping.json.code]).toEqual([409, 'PERMIT_TYPE_OVERLAP']);
      expect(await rows('select id from machvon.permit_type where code = $1', [code])).toHaveLength(2);
    });

    it('answers a retry with the same key with the first answer and writes once', async () => {
      const code = freshCode();
      const body = payload(code);
      const key = `key-${randomUUID()}`;
      const first = await post('/permit-types', { member: MANAGER, body, key });
      const again = await post('/permit-types', { member: MANAGER, body, key });
      expect([again.status, again.json.resource_id]).toEqual([200, idOf(first)]);
      expect(await rows('select id from machvon.permit_type where code = $1', [code])).toHaveLength(1);
      const different = await post('/permit-types', { member: MANAGER, body: { ...body, name: 'Another name' }, key });
      expect([different.status, different.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('refuses what the contract does not allow and what the rules do not allow, naming the field', async () => {
      const unknownField = await publish(MANAGER, { ...payload(freshCode()), status: 'RETIRED' });
      expect([unknownField.status, unknownField.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const withoutName = payload(freshCode());
      delete withoutName.name;
      const missing = await publish(MANAGER, withoutName);
      expect([missing.status, missing.json.code]).toEqual([400, 'INVALID_REQUEST']);
      const badCategory = await publish(MANAGER, payload(freshCode(), { category: 'MISC' }));
      expect([badCategory.status, badCategory.json.code, badCategory.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'category']);
      const badRule = await publish(MANAGER, payload(freshCode(), { applies_to_rule: { colour: 'red' } }));
      expect([badRule.status, badRule.json.code, badRule.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'applies_to_rule']);
      const endBeforeStart = await publish(MANAGER, payload(freshCode(), { effective_until: '2025-12-31' }));
      expect([endBeforeStart.status, endBeforeStart.json.code, endBeforeStart.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'effective_until']);
    });

    it('refuses a caller without the permission, one whose grant covers a subtree only, and keeps the catalogue of each tenant apart', async () => {
      const code = freshCode();
      expect((await publish(READER, payload(code))).status).toBe(403);
      expect((await publish(NOBODY, payload(code))).status).toBe(403);
      const subtree = await publish(SUBTREE_MANAGER, payload(code));
      expect([subtree.status, subtree.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select id from machvon.permit_type where code = $1', [code])).toEqual([]);
      const mine = await publish(MANAGER, payload(code));
      const theirs = await publish(OTHER_TENANT_MANAGER, payload(code, { legal_basis: 'Another tenant basis' }), TENANT_B);
      expect([mine.status, theirs.status]).toEqual([200, 200]);
      expect(await rows('select id from machvon.permit_type where code = $1', [code], TENANT_B)).toHaveLength(1);
      expect(await rows<{ revision: number }>('select revision from machvon.permit_type where code = $1', [code])).toEqual([{ revision: 1 }]);
    });
  });

  describe('retirePermitType', () => {
    it('ends a version on its last day and keeps the row and what is written under it (UAT-AC371, AC-ST-PMT-001-1)', async () => {
      const first = await publish(MANAGER, payload(freshCode()));
      await seedPermit(idOf(first), 'ISSUED', null);
      const until = inDays(60);
      const reply = await retire(MANAGER, idOf(first), until);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'RETIRED', resource_version: 2, resource_id: idOf(first) });
      expect(await rows<{ status: string; effective_until: string; name: string; version: string }>('select status, effective_until::text, name, version::text from machvon.permit_type where id = $1::uuid', [idOf(first)])).toEqual([
        { status: 'RETIRED', effective_until: until, name: 'Building permit', version: '2' },
      ]);
      expect(await rows('select id from machvon.permit where permit_type_id = $1::uuid and status = $2', [idOf(first), 'ISSUED'])).toHaveLength(1);
      const events = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit_type.retired.v1'", [idOf(first)]);
      expect(events).toHaveLength(1);
      expect(await rows("select id from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_type_retired'", [idOf(first)])).toHaveLength(1);
    });

    it('refuses with 422 PERMIT_TYPE_IN_USE while a permit of the version is still on its way past the last day, and changes nothing (UAT-AC371, AC-ST-PMT-001-1)', async () => {
      const first = await publish(MANAGER, payload(freshCode()));
      await seedPermit(idOf(first), 'PLANNED', null);
      const reply = await retire(MANAGER, idOf(first), inDays(60));
      expect([reply.status, reply.json.code]).toEqual([422, 'PERMIT_TYPE_IN_USE']);
      expect(await rows<{ status: string; effective_until: string | null }>('select status, effective_until::text from machvon.permit_type where id = $1::uuid', [idOf(first)])).toEqual([
        { status: 'PUBLISHED', effective_until: null },
      ]);
    });

    it('answers the end a version already has with 200, no new version and no event, and audits that nothing changed', async () => {
      const code = freshCode();
      const first = await publish(MANAGER, payload(code));
      const takeOver = inDays(30);
      await publish(MANAGER, payload(code, { effective_from: takeOver }));
      const lastDay = vietnamDateOf(new Date(Date.parse(`${takeOver}T00:00:00Z`) - DAY_MS));
      const reply = await retire(MANAGER, idOf(first), lastDay);
      expect([reply.status, reply.json.resource_version]).toEqual([200, 2]);
      expect(await rows<{ changed: boolean }>("select (safe_diff->>'changed')::boolean as changed from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_type_retired'", [idOf(first)])).toEqual([
        { changed: false },
      ]);
      expect(await rows("select id from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit_type.retired.v1'", [idOf(first)])).toEqual([]);
    });

    it('refuses an end that is not after the first day, a later end, a bad date, a version that is not there, another tenant and a caller without the grant', async () => {
      const code = freshCode();
      const first = await publish(MANAGER, payload(code, { effective_from: '2026-01-01' }));
      const early = await retire(MANAGER, idOf(first), '2026-01-01');
      expect([early.status, early.json.code, early.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'effective_until']);
      const bad = await retire(MANAGER, idOf(first), '2026-02-30');
      expect([bad.status, bad.json.code, bad.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'effective_until']);
      expect((await retire(MANAGER, randomUUID(), inDays(40))).status).toBe(404);
      expect((await retire(OTHER_TENANT_MANAGER, idOf(first), inDays(40), TENANT_B)).status).toBe(404);
      expect((await retire(READER, idOf(first), inDays(40))).status).toBe(403);
      expect([(await retire(SUBTREE_MANAGER, idOf(first), inDays(40))).json.code]).toEqual(['SCOPE_DENIED']);
      expect((await post('/permit-types/not-a-uuid/retire', { member: MANAGER, body: { effective_until: inDays(40) } })).status).toBe(422);
      const ended = await retire(MANAGER, idOf(first), inDays(40));
      const later = await retire(MANAGER, idOf(first), inDays(80));
      expect([ended.status, later.status, later.json.code, later.json.detail]).toEqual([200, 422, 'VALIDATION_FAILED', 'effective_until']);
    });
  });

  describe('get_resources_permit_type and get_resources_permit_type_id', () => {
    it('lists the versions of the tenant newest first in the shape of the read model, and pages them by keyset (AC-ST-PMT-001-1)', async () => {
      const code = freshCode();
      const first = await publish(MANAGER, payload(code, { cxn_ref: 'CXN-EXE-03', applies_to_rule: { work_types: ['ROAD'] }, default_validity_months: 12 }));
      const second = await publish(MANAGER, payload(code, { effective_from: inDays(20) }));
      const all = await get('/resources/permit_type?limit=200', { member: MANAGER });
      expect(all.status).toBe(200);
      const items = all.json.items as Array<Record<string, unknown>>;
      const ids = items.map((item) => item.id);
      expect(ids.indexOf(idOf(second))).toBeLessThan(ids.indexOf(idOf(first)));
      expect(items.find((item) => item.id === idOf(first))).toEqual({
        id: idOf(first),
        code,
        revision: 1,
        name: 'Building permit',
        category: 'CONSTRUCTION_PERMIT',
        authority_text: 'The authority the regulation names',
        legal_basis: 'Construction Law 135/2025 [CXN-EXE-02]',
        cxn_ref: 'CXN-EXE-03',
        effective_from: '2026-01-01',
        effective_until: inDays(19),
        applies_to_rule: { work_types: ['ROAD'] },
        default_validity_months: 12,
        default_processing_days: null,
        exemption_allowed: false,
        status: 'RETIRED',
        supersedes_id: null,
        version: 2,
      });
      expect(all.json.next_cursor).toBeNull();
      const page = await get('/resources/permit_type?limit=1', { member: MANAGER });
      expect((page.json.items as unknown[]).length).toBe(1);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await get(`/resources/permit_type?limit=1&cursor=${page.json.next_cursor as string}`, { member: MANAGER });
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((page.json.items as Array<{ id: string }>)[0]?.id);
    });

    it('reads one version by id, for a holder of permit.read on any scope, and refuses everyone else', async () => {
      const created = await publish(MANAGER, payload(freshCode()));
      const byReader = await get(`/resources/permit_type/${idOf(created)}`, { member: READER });
      expect([byReader.status, byReader.json.id, byReader.json.status]).toEqual([200, idOf(created), 'PUBLISHED']);
      expect((await get('/resources/permit_type', { member: READER })).status).toBe(200);
      expect((await get(`/resources/permit_type/${idOf(created)}`, { member: NOBODY })).status).toBe(403);
      expect((await get('/resources/permit_type', { member: NOBODY })).status).toBe(403);
    });

    it('answers a version of another tenant and one that is not there with 404, and a malformed id or cursor with 422', async () => {
      const created = await publish(MANAGER, payload(freshCode()));
      expect((await get(`/resources/permit_type/${idOf(created)}`, { member: OTHER_TENANT_MANAGER, tenantId: TENANT_B })).status).toBe(404);
      expect((await get(`/resources/permit_type/${randomUUID()}`, { member: MANAGER })).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await get('/resources/permit_type/not-a-uuid', { member: MANAGER })).status).toBe(422);
      expect((await get('/resources/permit_type?cursor=bad', { member: MANAGER })).status).toBe(422);
      expect((await get('/resources/permit_type?limit=0', { member: MANAGER })).status).toBe(422);
    });
  });
});
