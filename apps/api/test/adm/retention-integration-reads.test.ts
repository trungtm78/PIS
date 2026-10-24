import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { IntegrationConnectorReadsController, IntegrationInboxReadsController } from '../../src/modules/adm/integration-reads.controller';
import { RetentionPolicyReadsController, RetentionReviewReadsController } from '../../src/modules/adm/retention-reads.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const READER = 1; // adm.retention.read and adm.integration.read on the whole tenant
const SUBTREE_READER = 2; // the same on the subtree of unit 2 only
const NOBODY = 3;
const OTHER_TENANT_READER = 1; // of tenant B

interface Reply {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

interface Page {
  items: Array<Record<string, unknown>>;
  next_cursor: string | null;
}

describe('reads of retention policies, the review list, connectors and the inbox (ST-ADM-017, ST-ADM-018, ADM-09, ADM-10, ADM-12)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function get(url: string, member: number, tenantId = TENANT_A): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  }
  const pageOf = (reply: Reply): Page => reply.json as unknown as Page;
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function policy(recordClass: string, revision: number, status: 'Draft' | 'Published' | 'Superseded', tenant = TENANT_A): Promise<string> {
    const creator = randomUUID();
    const approver = status === 'Draft' ? null : randomUUID();
    const result = await rows<{ id: string }>(
      `insert into machvon.data_retention_policy
         (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by, approved_by, published_at)
       values ($1, gen_random_uuid(), $2, $3, 10, 'FROM_CLOSED', 'TT 10/2022/TT-BNV [CXN-RET-03]', 'REVIEW_FOR_DESTRUCTION', '2026-01-01', $4, $5::uuid, $6::uuid, case when $6::uuid is null then null else now() end)
       returning id`,
      [tenant, recordClass, revision, status, creator, approver],
      tenant,
    );
    return (result[0] as { id: string }).id;
  }

  async function reviewItem(dueOn: string, tenant = TENANT_A): Promise<string> {
    counter += 1;
    const result = await rows<{ id: string }>(
      `insert into machvon.retention_review_item (tenant_id, id, record_class, resource_type, resource_id, policy_id, basis_date, due_on, end_action)
       values ($1, gen_random_uuid(), 'project_dossier', 'project', gen_random_uuid(), gen_random_uuid(), '2015-01-01', $2::date, 'REVIEW_FOR_DESTRUCTION') returning id`,
      [tenant, dueOn],
      tenant,
    );
    return (result[0] as { id: string }).id;
  }

  async function connector(code: string, tenant = TENANT_A): Promise<string> {
    const result = await rows<{ id: string }>(
      `insert into machvon.integration_connector (tenant_id, id, connector_code, adapter_status, mode, config_json, credential_secret_ref, mapping_version, status, last_test_result)
       values ($1, gen_random_uuid(), $2, 'PROPOSED', 'FILE_IMPORT', '{"directory":"/inbox"}'::jsonb, 'secret://production/connectors/x', 'v1', 'Draft', 'NOT_TESTED') returning id`,
      [tenant, code],
      tenant,
    );
    return (result[0] as { id: string }).id;
  }

  async function inboxEvent(tenant = TENANT_A): Promise<string> {
    counter += 1;
    const result = await rows<{ id: string }>(
      `insert into machvon.integration_event_inbox
         (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id, attempts, error_code)
       values ($1, gen_random_uuid(), 'READ_TEST', $2, repeat('c', 64), $3, now() - interval '1 hour', 'FAILED', 'k1', 3, 'PROVIDER_DOWN') returning id`,
      [tenant, `evt-${counter}`, `tenants/${tenant}/webhook/RAW-PAYLOAD-${counter}`],
      tenant,
    );
    return (result[0] as { id: string }).id;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const [member, unit] of [[READER, 1], [SUBTREE_READER, 2], [NOBODY, 1]] as const) await harness.seedMembership(TENANT_A, member, unit);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_READER, 1);
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedRole(tenant, 1, 'ADM_READER', ['adm.retention.read', 'adm.integration.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: READER, role: 1, kind: 'TENANT' },
      { n: 2, member: SUBTREE_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_READER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [RetentionPolicyReadsController, RetentionReviewReadsController, IntegrationConnectorReadsController, IntegrationInboxReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('get_resources_data_retention_policy', () => {
    it('lists the versions by class with the newest revision first, in pages that continue without gaps (AC-ST-ADM-017-1)', async () => {
      const superseded = await policy('read_dossier_a', 1, 'Superseded');
      const published = await policy('read_dossier_a', 2, 'Published');
      const draft = await policy('read_dossier_b', 1, 'Draft');
      const first = await get('/resources/data_retention_policy?limit=2', READER);
      expect(first.status).toBe(200);
      expect(pageOf(first).items).toHaveLength(2);
      expect(pageOf(first).next_cursor).not.toBeNull();
      const second = await get(`/resources/data_retention_policy?limit=2&cursor=${encodeURIComponent(pageOf(first).next_cursor as string)}`, READER);
      const ids = [...pageOf(first).items, ...pageOf(second).items].map((item) => item.id);
      expect(ids).toEqual(expect.arrayContaining([superseded, published, draft]));
      expect(new Set(ids).size).toBe(ids.length);
      const classes = [...pageOf(first).items, ...pageOf(second).items].filter((item) => item.record_class === 'read_dossier_a').map((item) => item.revision);
      expect(classes).toEqual([2, 1]);
    });

    it('shows the facts of one version exactly as the contract names them and keeps the status of a draft without approver (AC-ST-ADM-017-1)', async () => {
      const draft = await policy('read_dossier_c', 1, 'Draft');
      const published = await policy('read_dossier_d', 1, 'Published');
      const one = await get(`/resources/data_retention_policy/${draft}`, READER);
      expect(one.status).toBe(200);
      expect(one.json).toEqual({
        id: draft,
        record_class: 'read_dossier_c',
        revision: 1,
        retention_years: 10,
        retention_basis: 'FROM_CLOSED',
        legal_basis_ref: 'TT 10/2022/TT-BNV [CXN-RET-03]',
        end_action: 'REVIEW_FOR_DESTRUCTION',
        effective_from: '2026-01-01',
        status: 'Draft',
        created_by: expect.any(String),
        approved_by: null,
        published_at: null,
        version: 1,
      });
      const done = await get(`/resources/data_retention_policy/${published}`, READER);
      expect(done.json).toMatchObject({ status: 'Published', approved_by: expect.any(String), published_at: expect.stringMatching(/Z$/) });
    });

    it('answers 404 for a version of another tenant, an unknown id and a subtree-only grant (an empty list), and 403 for a caller with no grant', async () => {
      const foreign = await policy('read_foreign', 1, 'Published', TENANT_B);
      expect((await get(`/resources/data_retention_policy/${foreign}`, READER)).status).toBe(404);
      expect((await get(`/resources/data_retention_policy/${randomUUID()}`, READER)).status).toBe(404);
      const own = await policy('read_own', 1, 'Draft');
      for (const [member, denied] of [[SUBTREE_READER, 404], [NOBODY, 403]] as const) {
        expect((await get(`/resources/data_retention_policy/${own}`, member)).status).toBe(denied);
        if (member === SUBTREE_READER) expect(pageOf(await get('/resources/data_retention_policy', member))).toEqual({ items: [], next_cursor: null });
        else expect((await get('/resources/data_retention_policy', member)).status).toBe(403);
      }
      const listed = pageOf(await get('/resources/data_retention_policy?limit=100', READER)).items.map((item) => item.record_class);
      expect(listed).not.toContain('read_foreign');
    });

    it('refuses a malformed id with 422 and a cursor that is not ours with a 4xx problem', async () => {
      expect((await get('/resources/data_retention_policy/not-a-uuid', READER)).status).toBe(422);
      expect((await get('/resources/data_retention_policy?cursor=%25%25', READER)).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('get_resources_retention_review_item', () => {
    it('lists the oldest due day first, pages without repeating an item, and reads one item (AC-ST-ADM-017-1)', async () => {
      const late = await reviewItem('2031-03-01');
      const early = await reviewItem('2030-01-15');
      const middle = await reviewItem('2030-06-30');
      const first = await get('/resources/retention_review_item?limit=2', READER);
      expect(first.status).toBe(200);
      expect(pageOf(first).items.map((item) => item.id)).toEqual([early, middle]);
      const second = await get(`/resources/retention_review_item?limit=2&cursor=${encodeURIComponent(pageOf(first).next_cursor as string)}`, READER);
      expect(pageOf(second).items.map((item) => item.id)).toEqual([late]);
      expect(pageOf(second).next_cursor).toBeNull();
      const one = await get(`/resources/retention_review_item/${early}`, READER);
      expect(one.json).toEqual({
        id: early,
        record_class: 'project_dossier',
        resource_type: 'project',
        resource_id: expect.any(String),
        basis_date: '2015-01-01',
        due_on: '2030-01-15',
        end_action: 'REVIEW_FOR_DESTRUCTION',
        status: 'PENDING_REVIEW',
      });
    });

    it('does not show an item of another tenant and gives a subtree-only grant nothing (404, empty list) and a caller with no grant 403', async () => {
      const foreign = await reviewItem('2029-01-01', TENANT_B);
      expect((await get(`/resources/retention_review_item/${foreign}`, READER)).status).toBe(404);
      expect(pageOf(await get('/resources/retention_review_item?limit=100', READER)).items.map((item) => item.id)).not.toContain(foreign);
      const own = (pageOf(await get('/resources/retention_review_item?limit=1', READER)).items[0] as { id: string }).id;
      for (const [member, denied] of [[SUBTREE_READER, 404], [NOBODY, 403]] as const) {
        expect((await get(`/resources/retention_review_item/${own}`, member)).status).toBe(denied);
        if (member === SUBTREE_READER) expect(pageOf(await get('/resources/retention_review_item', member))).toEqual({ items: [], next_cursor: null });
        else expect((await get('/resources/retention_review_item', member)).status).toBe(403);
      }
      expect((await get(`/resources/retention_review_item/${randomUUID()}`, READER)).status).toBe(404);
    });

    it('refuses a cursor whose day is not a date with 422 VALIDATION_FAILED', async () => {
      const cursor = Buffer.from(JSON.stringify({ code: 'yesterday', id: randomUUID() })).toString('base64url');
      const reply = await get(`/resources/retention_review_item?cursor=${cursor}`, READER);
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('get_resources_integration_connector', () => {
    it('lists the connectors by code with the honest adapter status, pages, and reads one (AC-ST-ADM-018-1)', async () => {
      const a = await connector('read-a');
      const b = await connector('read-b');
      const c = await connector('read-c');
      const first = await get('/resources/integration_connector?limit=2', READER);
      expect(first.status).toBe(200);
      expect(pageOf(first).items.map((item) => item.id)).toEqual([a, b]);
      const second = await get(`/resources/integration_connector?limit=2&cursor=${encodeURIComponent(pageOf(first).next_cursor as string)}`, READER);
      expect(pageOf(second).items.map((item) => item.id)).toEqual([c]);
      const one = await get(`/resources/integration_connector/${a}`, READER);
      expect(one.json).toEqual({
        id: a,
        connector_code: 'read-a',
        adapter_status: 'PROPOSED',
        mode: 'FILE_IMPORT',
        config: { directory: '/inbox' },
        credential_secret_ref: 'secret://production/connectors/x',
        mapping_version: 'v1',
        status: 'Draft',
        last_test_at: null,
        last_test_result: 'NOT_TESTED',
        version: 1,
      });
    });

    it('does not show a connector of another tenant and gives a subtree-only grant nothing (404, empty list) and a caller with no grant 403', async () => {
      const foreign = await connector('read-foreign', TENANT_B);
      expect((await get(`/resources/integration_connector/${foreign}`, READER)).status).toBe(404);
      expect(pageOf(await get('/resources/integration_connector?limit=100', READER)).items.map((item) => item.connector_code)).not.toContain('read-foreign');
      const own = await connector('read-own');
      for (const [member, denied] of [[SUBTREE_READER, 404], [NOBODY, 403]] as const) {
        expect((await get(`/resources/integration_connector/${own}`, member)).status).toBe(denied);
        if (member === SUBTREE_READER) expect(pageOf(await get('/resources/integration_connector', member))).toEqual({ items: [], next_cursor: null });
        else expect((await get('/resources/integration_connector', member)).status).toBe(403);
      }
      expect((await get(`/resources/integration_connector/${randomUUID()}`, READER)).status).toBe(404);
    });
  });

  describe('get_resources_integration_event_inbox', () => {
    it('lists the events without any payload or reference to it, in pages, and reads one (AC-ST-ADM-018-2)', async () => {
      const ids = [await inboxEvent(), await inboxEvent(), await inboxEvent()];
      const first = await get('/resources/integration_event_inbox?limit=2', READER);
      expect(first.status).toBe(200);
      expect(pageOf(first).items).toHaveLength(2);
      const second = await get(`/resources/integration_event_inbox?limit=2&cursor=${encodeURIComponent(pageOf(first).next_cursor as string)}`, READER);
      const seen = [...pageOf(first).items, ...pageOf(second).items].map((item) => item.id);
      expect(seen).toEqual(expect.arrayContaining(ids));
      expect(new Set(seen).size).toBe(seen.length);
      for (const reply of [first, second]) {
        expect(reply.text).not.toContain('RAW-PAYLOAD');
        expect(reply.text).not.toContain('payload_reference');
        expect(reply.text).not.toContain('payload_hash');
      }
      const one = await get(`/resources/integration_event_inbox/${ids[0]}`, READER);
      expect(one.text).not.toContain('RAW-PAYLOAD');
      expect(Object.keys(one.json).sort()).toEqual(
        ['attempts', 'error_code', 'event_key', 'id', 'next_attempt_at', 'payload_kept', 'processed_at', 'provider', 'provider_event_type', 'received_at', 'replay_count', 'status', 'version'].sort(),
      );
      expect(one.json).toMatchObject({ id: ids[0], provider: 'READ_TEST', status: 'FAILED', attempts: 3, error_code: 'PROVIDER_DOWN', payload_kept: true, replay_count: 0 });
    });

    it('does not show an event of another tenant and gives a subtree-only grant nothing (404, empty list) and a caller with no grant 403', async () => {
      const foreign = await inboxEvent(TENANT_B);
      expect((await get(`/resources/integration_event_inbox/${foreign}`, READER)).status).toBe(404);
      expect(pageOf(await get('/resources/integration_event_inbox?limit=100', READER)).items.map((item) => item.id)).not.toContain(foreign);
      const own = await inboxEvent();
      for (const [member, denied] of [[SUBTREE_READER, 404], [NOBODY, 403]] as const) {
        expect((await get(`/resources/integration_event_inbox/${own}`, member)).status).toBe(denied);
        if (member === SUBTREE_READER) expect(pageOf(await get('/resources/integration_event_inbox', member))).toEqual({ items: [], next_cursor: null });
        else expect((await get('/resources/integration_event_inbox', member)).status).toBe(403);
      }
      expect((await get(`/resources/integration_event_inbox/${randomUUID()}`, READER)).status).toBe(404);
    });
  });
});
