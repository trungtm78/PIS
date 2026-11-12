import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { DgvCatalogController, DgvDatasetController } from '../../src/modules/dgv/dgv-dataset.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const STEWARD = 1; // data.catalog.manage and data.catalog.read
const OWNER = 2; // a member who owns datasets; reads the catalogue
const READER = 3; // data.catalog.read only
const LND_READER = 4; // data.catalog.read through the role LND
const NOBODY = 5;
const OTHER_TENANT_STEWARD = 6; // of tenant B

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('dataset catalogue commands and search (ST-DGV-001)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  let counter = 0;
  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return {
      dataset_code: `DS-API-${counter}-${randomUUID().slice(0, 5)}`.toUpperCase(),
      title: `Dataset ${counter}`,
      domain: 'TREASURY',
      grain: 'one row per payment order',
      producer_module: 'PAY',
      owner_user_id: memberId(OWNER),
      steward_user_id: memberId(STEWARD),
      classification: 'INTERNAL',
      is_critical: false,
      freshness_slo_seconds: 86_400,
      ...extra,
    };
  };
  const register = (member: number, payload: Record<string, unknown>, tenantId?: string): Promise<Reply> => call('POST', '/dgv/datasets', { member, body: payload, ...(tenantId === undefined ? {} : { tenantId }) });
  const reassign = (member: number, datasetId: string, version: number | string, payload: Record<string, unknown>, tenantId?: string): Promise<Reply> =>
    call('POST', `/dgv/datasets/${datasetId}/ownership`, { member, ifMatch: `"${version}"`, body: payload, ...(tenantId === undefined ? {} : { tenantId }) });
  const catalog = (member: number, query = '', tenantId?: string): Promise<Reply> => call('GET', `/dgv/catalog${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const codesOf = (reply: Reply): string[] => (reply.json.items as Array<{ dataset_code: string }>).map((item) => item.dataset_code);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [STEWARD, OWNER, READER, LND_READER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_STEWARD, 1);
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', ['data.catalog.manage', 'data.catalog.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_OWNER', ['data.catalog.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'DATA_READER', ['data.catalog.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'LND', ['data.catalog.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'DATA_STEWARD', ['data.catalog.manage', 'data.catalog.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: LND_READER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_STEWARD, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [DgvDatasetController, DgvCatalogController],
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

  describe('registerDataset', () => {
    it('UAT-AC483: answers 422 OWNER_STEWARD_SAME for a critical dataset with one person in both seats, 200 DRAFT for a valid pair and 409 DATASET_CODE_DUPLICATE for the same code (AC-ST-DGV-001-1)', async () => {
      const same = await register(STEWARD, body({ dataset_code: 'DS-TREASURY', is_critical: true, owner_user_id: memberId(STEWARD), steward_user_id: memberId(STEWARD) }));
      expect([same.status, same.json.code]).toEqual([422, 'OWNER_STEWARD_SAME']);
      expect(await rows('select id from machvon.dataset where dataset_code = $1', ['DS-TREASURY'])).toEqual([]);

      const valid = body({ dataset_code: 'DS-TREASURY', is_critical: true, owner_user_id: memberId(OWNER), steward_user_id: memberId(STEWARD) });
      const created = await register(STEWARD, valid);
      expect(created.status).toBe(200);
      expect(created.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      expect(await rows('select status, is_critical, created_by from machvon.dataset where id = $1', [idOf(created)])).toEqual([{ status: 'DRAFT', is_critical: true, created_by: memberId(STEWARD) }]);

      const duplicate = await register(STEWARD, valid);
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'DATASET_CODE_DUPLICATE']);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.dataset where dataset_code = $1', ['DS-TREASURY']))[0]?.n)).toBe(1);
    });

    it('writes the audit row and the outbox event of the registration, and replays an identical request without a second dataset', async () => {
      const payload = body({ classification: 'CONFIDENTIAL' });
      const key = `key-${randomUUID()}`;
      const first = await call('POST', '/dgv/datasets', { member: STEWARD, body: payload, key });
      const replay = await call('POST', '/dgv/datasets', { member: STEWARD, body: payload, key });
      expect(replay).toEqual(first);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.dataset where dataset_code = $1', [payload.dataset_code]))[0]?.n)).toBe(1);

      const audit = await rows<{ action: string; classification: string; actor_id: string }>('select action, classification, actor_id from machvon.audit_event where resource_id = $1', [idOf(first)]);
      expect(audit).toEqual([{ action: 'dgv.dataset_registered', classification: 'CONFIDENTIAL', actor_id: memberId(STEWARD) }]);
      const events = await rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1', [idOf(first)]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'dgv.dataset.registered.v1', payload: { dataset_id: idOf(first), dataset_code: payload.dataset_code, classification: 'CONFIDENTIAL' } });
    });

    it('records a dataset of the fifth class in the audit trail as CONFIDENTIAL', async () => {
      const created = await register(STEWARD, body({ classification: 'IMPORTANT_CORE' }));
      expect((await rows<{ classification: string }>('select classification from machvon.audit_event where resource_id = $1', [idOf(created)]))[0]?.classification).toBe('CONFIDENTIAL');
    });

    it('refuses what the contract does not allow: a person without the permission, an unknown field, a missing field, an owner who is not a member', async () => {
      expect((await register(READER, body())).status).toBe(403);
      expect((await register(NOBODY, body())).status).toBe(403);
      const unknown = await register(STEWARD, body({ status: 'ACTIVE' }));
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const incomplete = body();
      delete incomplete.title;
      const missing = await register(STEWARD, incomplete);
      expect([missing.status, missing.json.code]).toEqual([400, 'INVALID_REQUEST']);
      const stranger = await register(STEWARD, body({ owner_user_id: randomUUID() }));
      expect([stranger.status, stranger.json.code, stranger.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'owner_user_id']);
      const otherTenant = await register(STEWARD, body({ owner_user_id: memberId(OTHER_TENANT_STEWARD) }));
      expect([otherTenant.status, otherTenant.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });
  });

  describe('searchCatalog', () => {
    it('returns zero results and a zero total to a reader who may not see a PERSONAL dataset allowed only to the LND role (AC-ST-DGV-001-2)', async () => {
      const created = await register(STEWARD, body({ dataset_code: 'DS-LND-HOUSEHOLD', classification: 'PERSONAL', producer_module: 'LND' }));
      await rows("update machvon.dataset set allowed_role_codes = array['LND'] where id = $1", [idOf(created)]);

      const blind = await catalog(READER, '?q=household');
      expect(blind.status).toBe(200);
      expect(blind.json).toMatchObject({ items: [], total: 0, next_cursor: null });
      const sighted = await catalog(LND_READER, '?q=household');
      expect(codesOf(sighted)).toEqual(['DS-LND-HOUSEHOLD']);
      expect(sighted.json.total).toBe(1);
      // The registrant sees the dataset it registered.
      expect(codesOf(await catalog(STEWARD, '?q=household'))).toEqual(['DS-LND-HOUSEHOLD']);
    });

    it('does not count hidden datasets in the total of an unfiltered search', async () => {
      const prefix = `CNT${randomUUID().slice(0, 4).toUpperCase()}`;
      await register(STEWARD, body({ dataset_code: `${prefix}-1`, classification: 'PUBLIC' }));
      await register(STEWARD, body({ dataset_code: `${prefix}-2`, classification: 'PERSONAL' }));
      await register(STEWARD, body({ dataset_code: `${prefix}-3`, classification: 'IMPORTANT_CORE' }));
      const reader = await catalog(READER, `?q=${prefix}`);
      expect(codesOf(reader)).toEqual([`${prefix}-1`]);
      expect(reader.json.total).toBe(1);
      const steward = await catalog(STEWARD, `?q=${prefix}`);
      expect(steward.json.total).toBe(3);
    });

    it('shows only the datasets of its own tenant and treats a dataset of another tenant as unknown (AC-ST-DGV-001-3)', async () => {
      const a = await register(STEWARD, body({ dataset_code: 'DS-ISO', classification: 'PUBLIC' }));
      const b = await register(OTHER_TENANT_STEWARD, body({ dataset_code: 'DS-ISO', classification: 'PUBLIC', owner_user_id: memberId(OTHER_TENANT_STEWARD), steward_user_id: memberId(OTHER_TENANT_STEWARD) }), TENANT_B);
      expect(b.status).toBe(200);

      const seen = await catalog(OTHER_TENANT_STEWARD, '?q=DS-ISO', TENANT_B);
      expect((seen.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([idOf(b)]);
      expect(seen.json.total).toBe(1);
      const foreign = await reassign(OTHER_TENANT_STEWARD, idOf(a), 1, { owner_user_id: memberId(OTHER_TENANT_STEWARD), steward_user_id: memberId(OTHER_TENANT_STEWARD), reason: 'Isolation attempt on a foreign dataset' }, TENANT_B);
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await rows<{ owner_user_id: string }>('select owner_user_id from machvon.dataset where id = $1', [idOf(a)]))[0]?.owner_user_id).toBe(memberId(OWNER));
    });

    it('shows the owner and the steward by name, the contract revision and the quality badge, filters by domain and classification, and pages', async () => {
      const prefix = `PG${randomUUID().slice(0, 4).toUpperCase()}`;
      for (const [index, domain] of ['TREASURY', 'LAND', 'TREASURY'].entries()) await register(STEWARD, body({ dataset_code: `${prefix}-${index}`, domain, classification: index === 0 ? 'PUBLIC' : 'INTERNAL' }));
      const first = await catalog(READER, `?q=${prefix}&limit=2`);
      expect(codesOf(first)).toEqual([`${prefix}-0`, `${prefix}-1`]);
      expect(first.json.total).toBe(3);
      expect(first.json.items).toEqual([
        expect.objectContaining({ owner_name: 'User 2', steward_name: 'User 1', contract_revision: null, quality_badge: 'NOT_ASSESSED', status: 'DRAFT', version: 1 }),
        expect.anything(),
      ]);
      const second = await catalog(READER, `?q=${prefix}&limit=2&cursor=${first.json.next_cursor as string}`);
      expect(codesOf(second)).toEqual([`${prefix}-2`]);
      expect(second.json.next_cursor).toBeNull();
      expect(codesOf(await catalog(READER, `?q=${prefix}&domain=LAND`))).toEqual([`${prefix}-1`]);
      expect(codesOf(await catalog(READER, `?q=${prefix}&classification=PUBLIC`))).toEqual([`${prefix}-0`]);
    });

    it.each([
      ['an unknown classification', '?classification=SECRET', 'classification'],
      ['an empty text', '?q=', 'q'],
      ['a limit of zero', '?limit=0', 'limit'],
      ['a cursor that was not issued', '?cursor=abc', 'cursor'],
    ])('refuses %s with 422 naming the parameter', async (_name, query, parameter) => {
      const reply = await catalog(READER, query);
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', parameter]);
    });

    it('is closed to a person without the read permission', async () => {
      expect((await catalog(NOBODY)).status).toBe(403);
    });
  });

  describe('assignDatasetOwnership', () => {
    const newPair = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ owner_user_id: memberId(READER), steward_user_id: memberId(OWNER), reason: 'The owner moved to another directorate', ...extra });

    it('gives the dataset a new pair against the version read, with the reason in the audit trail and an event', async () => {
      const created = await register(STEWARD, body({ is_critical: true }));
      const done = await reassign(STEWARD, idOf(created), 1, newPair());
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'DRAFT', resource_version: 2, resource_id: idOf(created) });
      expect(await rows('select owner_user_id, steward_user_id, version::text as version from machvon.dataset where id = $1', [idOf(created)])).toEqual([
        { owner_user_id: memberId(READER), steward_user_id: memberId(OWNER), version: '2' },
      ]);
      const audit = await rows<{ action: string; reason: string; safe_diff: { before: Record<string, string>; after: Record<string, string> } }>(
        "select action, reason, safe_diff from machvon.audit_event where resource_id = $1 and action = 'dgv.dataset_ownership_changed'",
        [idOf(created)],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ reason: 'The owner moved to another directorate', safe_diff: { before: { owner_user_id: memberId(OWNER), steward_user_id: memberId(STEWARD) }, after: { owner_user_id: memberId(READER), steward_user_id: memberId(OWNER) } } });
      const events = await rows<{ type: string }>("select type from machvon.outbox_event where aggregate_id = $1 and type = 'dgv.dataset.ownership_changed.v1'", [idOf(created)]);
      expect(events).toHaveLength(1);
    });

    it('answers 409 VERSION_CONFLICT for a stale version and 422 OWNER_STEWARD_SAME for a critical dataset given one person', async () => {
      const created = await register(STEWARD, body({ is_critical: true }));
      const stale = await reassign(STEWARD, idOf(created), 4, newPair());
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const same = await reassign(STEWARD, idOf(created), 1, newPair({ owner_user_id: memberId(READER), steward_user_id: memberId(READER) }));
      expect([same.status, same.json.code]).toEqual([422, 'OWNER_STEWARD_SAME']);
      expect((await rows<{ version: string }>('select version::text as version from machvon.dataset where id = $1', [idOf(created)]))[0]?.version).toBe('1');
    });

    it('requires the version, the reason and the permission, and cannot reach a dataset the caller may not see', async () => {
      const hidden = await register(STEWARD, body({ classification: 'PERSONAL' }));
      const noVersion = await call('POST', `/dgv/datasets/${idOf(hidden)}/ownership`, { member: STEWARD, body: newPair() });
      expect(noVersion.status).toBeGreaterThanOrEqual(400);
      const noReason = await reassign(STEWARD, idOf(hidden), 1, { owner_user_id: memberId(READER), steward_user_id: memberId(OWNER) });
      expect([noReason.status, noReason.json.code]).toEqual([400, 'INVALID_REQUEST']);
      expect((await reassign(READER, idOf(hidden), 1, newPair())).status).toBe(403);
      const missing = await reassign(STEWARD, randomUUID(), 1, newPair());
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      // A manager who is neither owner, steward nor registrant of a PERSONAL dataset cannot see it, so cannot change it.
      await rows('update machvon.dataset set created_by = $2, owner_user_id = $2, steward_user_id = $2 where id = $1', [idOf(hidden), memberId(OWNER)]);
      const concealed = await reassign(STEWARD, idOf(hidden), 1, newPair());
      expect([concealed.status, concealed.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });
});
