import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { MasterCrosswalkController, MasterCrosswalkReadsController } from '../../src/modules/mdm/master-crosswalk.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // master.crosswalk.manage and master.read
const READER = 2; // master.read
const OPERATOR = 3; // integration.cursor.reset and integration_cursor.read
const CURSOR_READER = 4; // integration_cursor.read
const NOBODY = 5;
const BRANCH_OPERATOR = 6; // integration.cursor.reset over the units under unit 1 only
const OTHER_TENANT_MANAGER = 1; // of tenant B

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('crosswalk and integration cursor commands and reads (ST-MDM-007)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const cursorId = id(0x71, 1);
  const otherCursorId = id(0x71, 2);

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  /** An entry that a code can be mapped to. */
  async function entry(tenant = TENANT_A): Promise<string> {
    counter += 1;
    const recordId = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
         values ($1, $2, 'TENANT', 'TREASURY_OFFICE', $3, 'EFFECTIVE', $4, $4)`,
        [tenant, recordId, `KB-${counter}-${recordId.slice(0, 6)}`, memberId(1)],
      ],
    ]);
    return recordId;
  }
  const body = (masterRecordId: string, code: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    master_record_id: masterRecordId,
    source_system: 'TREASURY',
    external_type: 'AGENCY_CODE',
    external_code: code,
    valid_from: '2024-01-01',
    match_method: 'MANUAL',
    ...extra,
  });
  const create = (member: number, payload: Record<string, unknown>, tenantId?: string): Promise<Reply> => call('POST', '/master-crosswalks', { member, body: payload, ...(tenantId === undefined ? {} : { tenantId }) });
  const retire = (member: number, crosswalkId: string, version: number, reason = 'Mapped to the wrong office'): Promise<Reply> =>
    call('POST', `/master-crosswalks/${crosswalkId}/retire`, { member, ifMatch: `"${version}"`, body: { reason } });
  const reset = (member: number, target: string, version: number, payload: Record<string, unknown>): Promise<Reply> =>
    call('POST', `/integration-cursors/${target}/reset`, { member, ifMatch: `"${version}"`, body: payload });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    }
    for (const n of [MANAGER, READER, OPERATOR, CURSOR_READER, NOBODY, BRANCH_OPERATOR]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_MANAGER, 1);
    await harness.seedRole(TENANT_A, 1, 'CROSSWALK_MANAGER', ['master.crosswalk.manage', 'master.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_READER', ['master.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'INTEGRATION_OPERATOR', ['integration.cursor.reset', 'integration_cursor.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'INTEGRATION_READER', ['integration_cursor.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'BRANCH_INTEGRATION_OPERATOR', ['integration.cursor.reset', 'integration_cursor.read'], 30);
    await harness.seedRole(TENANT_B, 1, 'CROSSWALK_MANAGER', ['master.crosswalk.manage', 'master.read', 'integration_cursor.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: OPERATOR, role: 3, kind: 'TENANT' },
      { n: 4, member: CURSOR_READER, role: 4, kind: 'TENANT' },
      { n: 5, member: BRANCH_OPERATOR, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_MANAGER, role: 1, kind: 'TENANT' }]);
    for (const [tenant, row] of [[TENANT_A, cursorId], [TENANT_B, otherCursorId]] as const) {
      await harness.owner(tenant, [
        [
          `insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status, last_error_code, last_file_sha256)
           values ($1, $2, 'TREASURY_STATEMENT_FILE', 'DEFAULT', '{"after_date":"2026-01-01"}'::jsonb, '1', 'PROPOSED', 'FAILED', 'FILE_REJECTED', repeat('b', 64))`,
          [tenant, row],
        ],
      ]);
    }
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MasterCrosswalkController, MasterCrosswalkReadsController],
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

  describe('createMasterCrosswalk and retireMasterCrosswalk', () => {
    it('UAT-AC273 maps a code, refuses a second ACTIVE mapping of it with 409 CROSSWALK_DUPLICATE, and frees it when the first is retired, the history keeping both rows with valid_from/valid_until (AC-ST-MDM-007-1)', async () => {
      const record = await entry();
      const first = await create(MANAGER, body(record, 'KB-AC1'));
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'ACTIVE', resource_version: 1 });
      const duplicate = await create(MANAGER, body(await entry(), 'KB-AC1'));
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'CROSSWALK_DUPLICATE']);
      expect(Number((await rows<{ n: string }>("select count(*)::text as n from machvon.master_crosswalk where external_code = 'KB-AC1' and status = 'ACTIVE'"))[0]?.n)).toBe(1);

      const retired = await retire(MANAGER, idOf(first), versionOf(first));
      expect(retired.json).toMatchObject({ status: 'RETIRED', resource_version: 2 });
      const again = await create(MANAGER, body(await entry(), 'KB-AC1'));
      expect(again.status).toBe(200);
      const history = await rows<{ id: string; status: string; valid_from: string; valid_until: string | null }>(
        "select id::text, status, valid_from::text, valid_until::text from machvon.master_crosswalk where external_code = 'KB-AC1' order by version desc, created_at",
      );
      expect(history).toHaveLength(2);
      const old = history.find((h) => h.id === idOf(first));
      const fresh = history.find((h) => h.id === idOf(again));
      expect(old).toMatchObject({ status: 'RETIRED', valid_from: '2024-01-01' });
      expect(old?.valid_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fresh).toMatchObject({ status: 'ACTIVE', valid_from: '2024-01-01', valid_until: null });
      const actions = await rows<{ action: string; reason: string | null }>("select action, reason from machvon.audit_event where resource_id = $1 order by occurred_at, id", [idOf(first)]);
      expect(actions).toEqual([
        { action: 'master.crosswalk_created', reason: null },
        { action: 'master.crosswalk_retired', reason: 'Mapped to the wrong office' },
      ]);
    });

    it('refuses what the contract or the entry does not allow', async () => {
      const record = await entry();
      expect((await create(MANAGER, { ...body(record, 'KB-X'), match_method: 'GUESS' })).status).toBe(422);
      expect((await create(MANAGER, { ...body(record, 'KB-X'), surprise: true })).status).toBe(400);
      expect((await create(MANAGER, body(record, 'KB-X', { valid_from: '2024-02-30' }))).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await create(MANAGER, body(record, 'KB-X', { confidence: 2 }))).status).toBe(422);
      expect((await create(MANAGER, body(randomUUID(), 'KB-X'))).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await create(MANAGER, body(await entry(TENANT_B), 'KB-X'))).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await create(MANAGER, body(record, 'KB-X', { master_record_id: 'not-a-uuid' }))).status).toBe(422);
    });

    it('needs master.crosswalk.manage, a reason to retire and the current version', async () => {
      const record = await entry();
      expect((await create(READER, body(record, 'KB-PERM'))).status).toBe(403);
      expect((await create(NOBODY, body(record, 'KB-PERM'))).status).toBe(403);
      const made = await create(MANAGER, body(record, 'KB-PERM'));
      expect((await retire(READER, idOf(made), 1)).status).toBe(403);
      expect((await retire(MANAGER, idOf(made), 1, 'no')).status).toBe(422);
      expect((await retire(MANAGER, idOf(made), 9)).json.code).toBe('VERSION_CONFLICT');
      expect((await retire(MANAGER, randomUUID(), 1)).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await retire(MANAGER, idOf(made), 1)).status).toBe(200);
      expect((await retire(MANAGER, idOf(made), 2)).json.code).toBe('STAGE_TRANSITION_DENIED');
    });
  });

  describe('listMasterCrosswalks', () => {
    it('lists the mappings by system, code, entry and status, in pages, to those who may read master data', async () => {
      const record = await entry();
      const system = `LST${randomUUID().slice(0, 6)}`;
      const made: string[] = [];
      for (const code of ['A', 'B', 'C']) made.push(idOf(await create(MANAGER, body(record, code, { source_system: system }))));
      await retire(MANAGER, made[0] as string, 1);
      const all = await call('GET', `/master-crosswalks?source_system=${system}`, { member: READER });
      expect(all.status).toBe(200);
      expect((all.json.items as Array<Record<string, unknown>>).map((item) => item.external_code)).toEqual(['C', 'B', 'A']);
      expect((all.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ master_record_id: record, master_type: 'TREASURY_OFFICE', status: 'ACTIVE', match_method: 'MANUAL', valid_from: '2024-01-01' });
      const active = await call('GET', `/master-crosswalks?source_system=${system}&status=ACTIVE&master_record_id=${record}&external_type=AGENCY_CODE`, { member: READER });
      expect((active.json.items as Array<Record<string, unknown>>).length).toBe(2);
      expect(((await call('GET', `/master-crosswalks?source_system=${system}&external_code=B`, { member: READER })).json.items as unknown[]).length).toBe(1);
      const page = await call('GET', `/master-crosswalks?source_system=${system}&limit=2`, { member: READER });
      expect((page.json.items as unknown[]).length).toBe(2);
      const next = await call('GET', `/master-crosswalks?source_system=${system}&limit=2&cursor=${page.json.next_cursor as string}`, { member: READER });
      expect((next.json.items as Array<Record<string, unknown>>).map((item) => item.external_code)).toEqual(['A']);
      expect(next.json.next_cursor).toBeNull();
      expect(((await call('GET', `/master-crosswalks?source_system=${system}`, { member: OTHER_TENANT_MANAGER, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
    });

    it('refuses a filter that is not well formed and a caller without master.read', async () => {
      expect((await call('GET', '/master-crosswalks?status=GONE', { member: READER })).status).toBe(422);
      expect((await call('GET', '/master-crosswalks?master_record_id=nope', { member: READER })).status).toBe(422);
      expect((await call('GET', '/master-crosswalks?source_system=', { member: READER })).status).toBe(422);
      expect((await call('GET', '/master-crosswalks', { member: NOBODY })).status).toBe(403);
    });
  });

  describe('resetIntegrationCursor and the reads of the connectors', () => {
    it('needs the permission on the whole tenant (MDM 2: the integration operator acts on the tenant): a grant over a branch moves nothing', async () => {
      const before = await rows('select cursor_json, status, version::int as version from machvon.integration_cursor where id = $1', [cursorId]);
      const refused = await reset(BRANCH_OPERATOR, cursorId, 1, { cursor_json: { after_date: '2026-04-01' }, reason: 'Re-read the statements of April' });
      expect([refused.status, refused.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select cursor_json, status, version::int as version from machvon.integration_cursor where id = $1', [cursorId])).toEqual(before);
      expect(await rows("select id from machvon.audit_event where action = 'integration.cursor_reset' and actor_id = $1", [memberId(BRANCH_OPERATOR)])).toEqual([]);
    });

    it('refuses a caller without the permission and a reset without a reason, then moves the position and audits the reason (AC-ST-MDM-007-2)', async () => {
      const payload = { reason: 'Re-read the statements of March', cursor_json: { after_date: '2026-03-01' } };
      expect((await reset(CURSOR_READER, cursorId, 1, payload)).status).toBe(403);
      expect((await reset(MANAGER, cursorId, 1, payload)).status).toBe(403);
      const noReason = await reset(OPERATOR, cursorId, 1, { cursor_json: { after_date: '2026-03-01' } });
      expect([noReason.status, noReason.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await reset(OPERATOR, cursorId, 1, { ...payload, reason: 'short' })).status).toBe(422);
      expect((await reset(OPERATOR, cursorId, 1, { ...payload, cursor_json: [] })).status).toBe(400);
      expect((await reset(OPERATOR, cursorId, 9, payload)).json.code).toBe('VERSION_CONFLICT');
      expect((await reset(OPERATOR, randomUUID(), 1, payload)).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await reset(OPERATOR, otherCursorId, 1, payload)).json.code).toBe('RESOURCE_NOT_FOUND');

      const done = await reset(OPERATOR, cursorId, 1, payload);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'ACTIVE', resource_version: 2 });
      const stored = await rows<{ cursor_json: unknown; reset_reason: string; status: string; last_error_code: string | null; adapter_status: string }>(
        'select cursor_json, reset_reason, status, last_error_code, adapter_status from machvon.integration_cursor where id = $1',
        [cursorId],
      );
      expect(stored).toEqual([{ cursor_json: { after_date: '2026-03-01' }, reset_reason: 'Re-read the statements of March', status: 'ACTIVE', last_error_code: null, adapter_status: 'PROPOSED' }]);
      const audit = await rows<{ action: string; reason: string }>('select action, reason from machvon.audit_event where resource_id = $1', [cursorId]);
      expect(audit).toEqual([{ action: 'integration.cursor_reset', reason: 'Re-read the statements of March' }]);
    });

    it('lists the connectors without their positions and gives a position only on the connector itself', async () => {
      const listed = await call('GET', '/resources/integration_cursor', { member: CURSOR_READER });
      expect(listed.status).toBe(200);
      const items = listed.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([cursorId]);
      expect(items[0]).toMatchObject({ connector_code: 'TREASURY_STATEMENT_FILE', adapter_status: 'PROPOSED' });
      expect(items[0]).not.toHaveProperty('cursor_json');
      const one = await call('GET', `/resources/integration_cursor/${cursorId}`, { member: CURSOR_READER });
      expect(one.json).toMatchObject({ id: cursorId, cursor_json: { after_date: '2026-03-01' }, version: 2 });
      expect((await call('GET', `/resources/integration_cursor/${randomUUID()}`, { member: CURSOR_READER })).status).toBe(404);
      expect((await call('GET', `/resources/integration_cursor/${otherCursorId}`, { member: CURSOR_READER })).status).toBe(404);
      expect((await call('GET', '/resources/integration_cursor', { member: READER })).status).toBe(403);
      expect(((await call('GET', '/resources/integration_cursor?limit=1', { member: CURSOR_READER })).json as { next_cursor: unknown }).next_cursor).toBeNull();
    });
  });
});
