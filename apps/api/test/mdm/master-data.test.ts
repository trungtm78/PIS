import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { MasterCrosswalkController } from '../../src/modules/mdm/master-crosswalk.controller';
import { MasterDataController, MasterDataReadsController } from '../../src/modules/mdm/master-data.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const DECISION_DOCUMENT = id(0x70, 1);

// Members of tenant A.
const STEWARD = 1; // master.propose and master.read
const SECOND_STEWARD = 2; // the same: a second maker
const CHECKER = 3; // master.review and master.read
const PUBLISHER = 4; // master.publish and master.read
const READER = 5; // master.read
const NOBODY = 6;
const ALIAS_ADMIN = 8; // master.crosswalk.manage and master.read
const OTHER_TENANT_STEWARD = 1; // of tenant B

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

let counter = 0;
const nextKey = (): string => {
  counter += 1;
  return `MX-${counter}`;
};

describe('master data commands and reads (ST-MDM-001)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  async function call(
    method: 'GET' | 'POST',
    url: string,
    options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string },
  ): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const proposalBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    namespace: 'TENANT',
    master_type: 'SECTOR',
    business_key: nextKey(),
    label: 'Giao thông',
    attributes: { group: 'infrastructure' },
    valid_from: '2024-01-01',
    reason: 'Initial catalogue entry',
    ...overrides,
  });

  const propose = async (member: number, body: Record<string, unknown> = proposalBody(), options: { tenantId?: string; key?: string } = {}): Promise<Reply> => {
    const reply = await call('POST', '/master-records', { member, body, ...options });
    if (reply.status === 200) keyRows.set(reply.json.resource_id as string, body.business_key as string);
    return reply;
  };
  const submit = (member: number, changeId: string, version = 1): Promise<Reply> => call('POST', `/master-change-requests/${changeId}/submit`, { member, ifMatch: `"${version}"` });
  const decide = (member: number, changeId: string, decision: string, version: number): Promise<Reply> =>
    call('POST', `/master-change-requests/${changeId}/decision`, { member, ifMatch: `"${version}"`, body: { decision, reason: 'Checked against the decision' } });
  const publish = (member: number, recordId: string, version: number): Promise<Reply> =>
    call('POST', `/master-records/${recordId}/publish`, { member, ifMatch: `"${version}"`, body: { decision_document_id: DECISION_DOCUMENT } });
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const keyRows = new Map<string, string>();
  const proposalKeyOf = (reply: Reply): string => keyRows.get(idOf(reply)) ?? '';
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;

  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  /** The change request of a new record: its id (the record id is the resource of the proposal). */
  async function changeOf(recordId: string): Promise<{ id: string; version: number }> {
    const found = await rows<{ id: string; version: string }>('select id, version::text as version from machvon.master_change_request where master_record_id = $1 order by created_at desc limit 1', [recordId]);
    return { id: found[0]?.id ?? '', version: Number(found[0]?.version) };
  }

  /** A record in force: proposed by a steward, submitted, approved by the checker and published by the publisher. */
  async function inForce(overrides: Record<string, unknown> = {}): Promise<{ recordId: string; key: string }> {
    const body = proposalBody(overrides);
    const proposed = await propose(STEWARD, body);
    expect(proposed.status).toBe(200);
    const recordId = idOf(proposed);
    const change = await changeOf(recordId);
    const submitted = await submit(STEWARD, change.id, change.version);
    expect(submitted.status).toBe(200);
    expect((await decide(CHECKER, change.id, 'approve', versionOf(submitted))).status).toBe(200);
    const record = (await rows<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [recordId]))[0];
    const published = await publish(PUBLISHER, recordId, Number(record?.version));
    expect(published.status).toBe(200);
    return { recordId, key: body.business_key as string };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      await harness.owner(tenant, [
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'INCOMING', 'CV', 'Decision', 'INTERNAL', $3, $3)`,
          [tenant, DECISION_DOCUMENT, memberId(1)],
        ],
      ]);
    }
    // The SECTOR type of these tests is the tenant's own: a row of the control plane replaces the baseline of the platform for it.
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.owner(tenant, [["insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'SECTOR', 'TENANT_ONLY', $2)", [tenant, memberId(1)]]]);
    }
    for (const n of [STEWARD, SECOND_STEWARD, CHECKER, PUBLISHER, READER, NOBODY, ALIAS_ADMIN]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_STEWARD, 1);
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', ['master.propose', 'master.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_CHECKER', ['master.review', 'master.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'DATA_PUBLISHER', ['master.publish', 'master.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'DATA_READER', ['master.read', 'master_record_version.read'], 20);
    await harness.seedRole(TENANT_A, 6, 'ALIAS_ADMIN', ['master.crosswalk.manage', 'master.read'], 40);
    await harness.seedRole(TENANT_B, 1, 'DATA_STEWARD', ['master.propose', 'master.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: SECOND_STEWARD, role: 1, kind: 'TENANT' },
      { n: 3, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 4, member: PUBLISHER, role: 3, kind: 'TENANT' },
      { n: 5, member: READER, role: 4, kind: 'TENANT' },
      { n: 6, member: ALIAS_ADMIN, role: 6, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_STEWARD, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MasterDataController, MasterDataReadsController, MasterCrosswalkController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('proposeMasterRecord', () => {
    it('answers 200 with the record, writes the draft, the audit row and keeps the replay answer', async () => {
      const key = `key-${randomUUID()}`;
      const body = proposalBody();
      const first = await propose(STEWARD, body, { key });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const replay = await propose(STEWARD, body, { key });
      expect(replay.json.resource_id).toBe(first.json.resource_id);
      const stored = await rows<{ status: string; business_key: string }>('select status, business_key from machvon.master_record where id = $1', [idOf(first)]);
      expect(stored).toEqual([{ status: 'DRAFT', business_key: body.business_key }]);
      const audit = await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'master.proposed' and resource_id = $1", [idOf(first)]);
      expect(Number(audit[0]?.n)).toBe(1);
    });

    it('refuses the PLATFORM namespace with 403 POLICY_LOCKED, a duplicate key with 409 DUPLICATE_KEY (another tenant may use it), an unknown field with 400 (AC-ST-MDM-001-1)', async () => {
      expect((await propose(STEWARD, proposalBody({ namespace: 'PLATFORM' }))).json).toMatchObject({ code: 'POLICY_LOCKED' });
      const body = proposalBody();
      expect((await propose(STEWARD, body)).status).toBe(200);
      const duplicate = await propose(SECOND_STEWARD, body);
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'DUPLICATE_KEY']);
      expect((await propose(OTHER_TENANT_STEWARD, body, { tenantId: TENANT_B })).status).toBe(200);
      const unknown = await propose(STEWARD, proposalBody({ status: 'EFFECTIVE' }));
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const written = await rows<{ n: string }>("select count(*)::text as n from machvon.master_record where tenant_id = $1 and business_key = $2", [TENANT_A, body.business_key]);
      expect(Number(written[0]?.n)).toBe(1);
    });

    it('refuses a caller without master.propose with 403 and writes nothing', async () => {
      const body = proposalBody();
      expect((await propose(READER, body)).status).toBe(403);
      expect((await propose(NOBODY, body)).status).toBe(403);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.master_record where business_key = $1', [body.business_key]))[0]?.n)).toBe(0);
    });
  });

  describe('the change request flow', () => {
    it('walks propose, submit, decide and publish, with the audit rows and the events, and the entry is found in force (AC-ST-MDM-001-3)', async () => {
      const { recordId, key } = await inForce();
      const found = await call('GET', `/master-records?master_type=SECTOR&business_key=${key}`, { member: READER });
      expect(found.status).toBe(200);
      expect((found.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: recordId, status: 'EFFECTIVE', label: 'Giao thông', open_change_request_id: null });
      const actions = await rows<{ action: string }>('select action from machvon.audit_event where resource_id in ($1, (select id from machvon.master_change_request where master_record_id = $1)) order by seq', [recordId]);
      expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining(['master.proposed', 'master.change_submitted', 'master.change_approved', 'master.published']));
      const events = await rows<{ event_type: string }>("select type as event_type from machvon.outbox_event where aggregate_id = $1 or aggregate_id = (select id from machvon.master_change_request where master_record_id = $1)", [recordId]);
      expect(events.map((row) => row.event_type).sort()).toEqual(['master.change_submitted.v1', 'master.published.v1']);
    });

    it('refuses the proposer as the reviewer and as the publisher with 403 SELF_APPROVAL_DENIED', async () => {
      // A steward who also holds the review and publish permissions through a second role.
      await harness.seedRole(TENANT_A, 5, 'DATA_ALL', ['master.review', 'master.publish', 'master.propose', 'master.read'], 60);
      await harness.seedMembership(TENANT_A, 7, 1);
      await harness.seedGrants(TENANT_A, [{ n: 7, member: 7, role: 5, kind: 'TENANT' }]);
      const proposed = await propose(7);
      const change = await changeOf(idOf(proposed));
      const submitted = await submit(7, change.id);
      const selfDecision = await decide(7, change.id, 'approve', versionOf(submitted));
      expect([selfDecision.status, selfDecision.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await decide(CHECKER, change.id, 'approve', versionOf(submitted))).status).toBe(200);
      const record = (await rows<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [idOf(proposed)]))[0];
      const selfPublish = await publish(7, idOf(proposed), Number(record?.version));
      expect([selfPublish.status, selfPublish.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await publish(PUBLISHER, idOf(proposed), Number(record?.version))).status).toBe(200);
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT for a stale one, and 422 IMPACT_NOT_COMPUTED for a request without impact (AC-ST-MDM-001-4)', async () => {
      const proposed = await propose(STEWARD);
      const change = await changeOf(idOf(proposed));
      const noMatch = await call('POST', `/master-change-requests/${change.id}/submit`, { member: STEWARD });
      expect(noMatch.status).toBe(428);
      const stale = await submit(STEWARD, change.id, 9);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      await rows("update machvon.master_change_request set impact_json = null where id = $1", [change.id]);
      const missing = await submit(STEWARD, change.id);
      expect([missing.status, missing.json.code]).toEqual([422, 'IMPACT_NOT_COMPUTED']);
      expect((await rows<{ status: string }>('select status from machvon.master_change_request where id = $1', [change.id]))[0]?.status).toBe('DRAFT');
    });

    it('returns a request to its author and refuses a reviewer without master.review', async () => {
      const proposed = await propose(STEWARD);
      const change = await changeOf(idOf(proposed));
      const submitted = await submit(STEWARD, change.id);
      expect((await decide(STEWARD, change.id, 'return', versionOf(submitted))).status).toBe(403);
      const returned = await decide(CHECKER, change.id, 'return', versionOf(submitted));
      expect(returned.json).toMatchObject({ status: 'DRAFT' });
      expect((await submit(STEWARD, change.id, versionOf(returned))).status).toBe(200);
    });
  });

  describe('changes of an entry in force', () => {
    it('updates the label from a date, keeps the old label for earlier dates and shows the usage', async () => {
      const { recordId, key } = await inForce();
      const created = await call('POST', '/master-change-requests', {
        member: STEWARD,
        body: { change_kind: 'UPDATE', master_type: 'SECTOR', master_record_id: recordId, proposed: { label: 'Giao thông vận tải' }, effective_from: '2025-06-01', reason: 'Renamed by decision 12' },
      });
      expect(created.status).toBe(200);
      const changeId = idOf(created);
      const view = await call('GET', `/master-change-requests/${changeId}`, { member: READER });
      expect(view.json).toMatchObject({ change_kind: 'UPDATE', status: 'DRAFT', impact: { total: 0 }, effective_from: '2025-06-01' });
      const submitted = await submit(STEWARD, changeId);
      expect((await decide(CHECKER, changeId, 'approve', versionOf(submitted))).status).toBe(200);
      const record = (await rows<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [recordId]))[0];
      expect((await publish(PUBLISHER, recordId, Number(record?.version))).status).toBe(200);
      const before = await call('GET', `/master-records?business_key=${key}&as_of=2025-01-01`, { member: READER });
      const after = await call('GET', `/master-records?business_key=${key}`, { member: READER });
      expect((before.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ label: 'Giao thông' });
      expect((after.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ label: 'Giao thông vận tải' });
      const usages = await call('GET', `/master-records/${recordId}/usages`, { member: READER });
      expect(usages.json).toMatchObject({ master_record_id: recordId, total: 0, counts: {} });
    });

    it('judges the fields of a change that the contract leaves as a free object, and normalises the parent id', async () => {
      const { recordId } = await inForce();
      const update = (proposed: Record<string, unknown>): Promise<Reply> =>
        call('POST', '/master-change-requests', { member: STEWARD, body: { change_kind: 'UPDATE', master_type: 'SECTOR', master_record_id: recordId, proposed, effective_from: '2025-06-01', reason: 'Checking the fields' } });
      for (const [proposed, field] of [
        [{ valid_until: 'not-a-date' }, 'proposed.valid_until'],
        [{ valid_until: 7 }, 'proposed.valid_until'],
        [{ label: '' }, 'proposed.label'],
        [{ label: 5 }, 'proposed.label'],
        [{ attributes: [1] }, 'proposed.attributes'],
        [{ parent_record_id: 'nope' }, 'proposed.parent_record_id'],
        [{ legal_basis: 'x'.repeat(2001) }, 'proposed.legal_basis'],
      ] as const) {
        const reply = await update(proposed);
        expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      // The record cannot be its own parent, whatever the letter case of its id.
      const self = await update({ parent_record_id: recordId.toUpperCase() });
      expect([self.status, self.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.master_change_request where master_record_id = $1 and change_kind = \'UPDATE\'', [recordId]))[0]?.n)).toBe(0);
    });

    it('sends one event for each publication, also one that waits for its date and leaves the record version as it was', async () => {
      const { recordId } = await inForce();
      for (const label of ['A later change']) {
        const created = await call('POST', '/master-change-requests', {
          member: STEWARD,
          body: { change_kind: 'UPDATE', master_type: 'SECTOR', master_record_id: recordId, proposed: { label }, effective_from: '2998-01-01', reason: 'Later change' },
        });
        expect(created.status).toBe(200);
        const submitted = await submit(STEWARD, idOf(created));
        expect((await decide(CHECKER, idOf(created), 'approve', versionOf(submitted))).status).toBe(200);
        const record = (await rows<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [recordId]))[0];
        expect((await publish(PUBLISHER, recordId, Number(record?.version))).status).toBe(200);
      }
      const events = await rows<{ event_key: string }>("select event_key from machvon.outbox_event where type = 'master.published.v1' and aggregate_id = $1", [recordId]);
      expect(events).toHaveLength(2);
      expect(new Set(events.map((event) => event.event_key)).size).toBe(2);
    });

    it('refuses RESTRUCTURE and SUCCESSION until the succession step exists, a malformed date, and a record of another tenant', async () => {
      const { recordId } = await inForce();
      const restructure = await call('POST', '/master-change-requests', {
        member: STEWARD,
        body: { change_kind: 'RESTRUCTURE', master_type: 'SECTOR', master_record_id: recordId, proposed: {}, effective_from: '2025-06-01', reason: 'Not supported yet' },
      });
      expect([restructure.status, restructure.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await call('GET', '/master-records?as_of=2025-13-40', { member: READER })).status).toBe(422);
      const foreign = await call('POST', '/master-change-requests', {
        member: OTHER_TENANT_STEWARD,
        tenantId: TENANT_B,
        body: { change_kind: 'UPDATE', master_type: 'SECTOR', master_record_id: recordId, proposed: { label: 'Probe' }, effective_from: '2025-06-01', reason: 'Foreign probe' },
      });
      expect(foreign.status).toBe(404);
    });

    it('retires an entry and refuses to retire one that is in use without a successor (409 MASTER_IN_USE)', async () => {
      const used = await inForce();
      const versionRow = (await rows<{ id: string }>('select current_version_id as id from machvon.master_record where id = $1', [used.recordId]))[0];
      const admin = new Client({ connectionString: harness.database.adminUrl });
      await admin.connect();
      try {
        await admin.query('set session_replication_role = replica');
        await admin.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, sector_master_version_id, classification, total_investment_vnd, status, version)
           values ($1, $2, $3, 'Project', $4, $5, $6, 'INTERNAL', 1000, 'CONCEPT', 1)`,
          [TENANT_A, randomUUID(), `HTTP-${counter}`, unitId(1), randomUUID(), versionRow?.id],
        );
      } finally {
        await admin.end();
      }
      const retire = (recordId: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
        call('POST', '/master-change-requests', { member: STEWARD, body: { change_kind: 'RETIRE', master_type: 'SECTOR', master_record_id: recordId, proposed: {}, effective_from: '2025-06-01', reason: 'No longer used', ...extra } });
      const refused = await retire(used.recordId);
      expect([refused.status, refused.json.code]).toEqual([409, 'MASTER_IN_USE']);
      const usages = await call('GET', `/master-records/${used.recordId}/usages`, { member: READER });
      expect(usages.json).toMatchObject({ total: 1, counts: { 'project.sector_master_version_id': 1 } });
      const successor = await inForce();
      const accepted = await retire(used.recordId, { successor_record_id: successor.recordId });
      expect(accepted.status).toBe(200);
    });
  });

  describe('reads', () => {
    it('pages the search with a cursor and answers 404 for a record or change request of another tenant', async () => {
      const first = await inForce();
      await inForce();
      const page = await call('GET', '/master-records?master_type=SECTOR&limit=1', { member: READER });
      expect((page.json.items as unknown[]).length).toBe(1);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await call('GET', `/master-records?master_type=SECTOR&limit=1&cursor=${String(page.json.next_cursor)}`, { member: READER });
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((page.json.items as Array<{ id: string }>)[0]?.id);
      expect((await call('GET', '/master-records?cursor=not-a-cursor', { member: READER })).status).toBe(422);
      const change = await changeOf(first.recordId);
      expect((await call('GET', `/master-change-requests/${change.id}`, { member: OTHER_TENANT_STEWARD, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/master-records/${first.recordId}/usages`, { member: OTHER_TENANT_STEWARD, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/master-records/${randomUUID()}/usages`, { member: READER })).status).toBe(404);
    });

    it('lists the change requests by status for the approval queue, pages them and refuses an unknown status', async () => {
      const proposed = await propose(STEWARD, proposalBody({ master_type: 'QUEUE' }));
      const change = await changeOf(idOf(proposed));
      const submitted = await submit(STEWARD, change.id);
      expect(submitted.status).toBe(200);
      const queue = await call('GET', '/master-change-requests?status=IN_REVIEW&master_type=QUEUE', { member: CHECKER });
      expect(queue.status).toBe(200);
      expect((queue.json.items as Array<{ id: string; status: string; impact: unknown }>).map((item) => [item.id, item.status])).toEqual([[change.id, 'IN_REVIEW']]);
      expect((queue.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ business_key: proposalKeyOf(proposed), master_record_version: expect.any(Number), master_record_status: 'IN_REVIEW', master_record_namespace: 'TENANT' });
      expect(queue.json.next_cursor).toBeNull();
      const paged = await call('GET', '/master-change-requests?master_type=QUEUE&limit=1', { member: CHECKER });
      expect((paged.json.items as unknown[]).length).toBe(1);
      expect((await call('GET', '/master-change-requests?status=SOMETHING', { member: CHECKER })).status).toBe(422);
      expect((await call('GET', '/master-change-requests?master_type=QUEUE', { member: OTHER_TENANT_STEWARD, tenantId: TENANT_B })).json.items).toEqual([]);
      expect((await call('GET', '/master-change-requests', { member: NOBODY })).status).toBe(403);
    });

    it('refuses a type that only the platform publishes with 403 POLICY_LOCKED (AC-ST-MDM-002-2)', async () => {
      const locked = await propose(STEWARD, proposalBody({ master_type: 'ADMIN_UNIT' }));
      expect([locked.status, locked.json.code]).toEqual([403, 'POLICY_LOCKED']);
      const extension = await propose(STEWARD, proposalBody({ master_type: 'PROGRAM' }));
      expect([extension.status, extension.json.code]).toEqual([403, 'POLICY_LOCKED']);
    });

    it('AC-ST-MDM-002-2: FUND_SOURCE NSTW in the platform namespace is locked against a change of its code or name (403 POLICY_LOCKED) and takes only the alias of the tenant, for the label and the order', async () => {
      const platformId = randomUUID();
      await rows(
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'PLATFORM', 'FUND_SOURCE', 'NSTW-ALIAS', 'EFFECTIVE', $3, $3)`,
        [TENANT_A, platformId, memberId(1)],
      );
      await rows(
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $3, 'FUND_SOURCE', 'NSTW-ALIAS', 1, 'Ngân sách trung ương', '{"category":"NSTW","relation":"ADDITIVE"}'::jsonb, '2020-01-01', 'EFFECTIVE', 'PLATFORM', now(), $4, $4)`,
        [TENANT_A, randomUUID(), platformId, memberId(1)],
      );
      const rename = await propose(STEWARD, proposalBody({ master_type: 'FUND_SOURCE', business_key: 'NSTW-ALIAS', label: 'Tên khác của tenant' }));
      expect([rename.status, rename.json.code]).toEqual([403, 'POLICY_LOCKED']);
      const label = await call('POST', '/master-crosswalks', { member: ALIAS_ADMIN, body: { master_record_id: platformId, source_system: 'TENANT_ALIAS', external_type: 'LABEL', external_code: 'Vốn NSTW', valid_from: '2024-01-01', match_method: 'MANUAL' } });
      expect(label.status).toBe(200);
      const order = await call('POST', '/master-crosswalks', { member: ALIAS_ADMIN, body: { master_record_id: platformId, source_system: 'TENANT_ALIAS', external_type: 'ORDER', external_code: '2', valid_from: '2024-01-01', match_method: 'MANUAL' } });
      expect(order.status).toBe(200);
      const seen = await call('GET', '/master-records?master_type=FUND_SOURCE&business_key=NSTW-ALIAS', { member: READER });
      expect((seen.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({
        id: platformId,
        namespace: 'PLATFORM',
        business_key: 'NSTW-ALIAS',
        label: 'Ngân sách trung ương',
        alias_label: 'Vốn NSTW',
        alias_order: 2,
        display_label: 'Vốn NSTW',
        display_order: 2,
      });
      const second = await call('POST', '/master-crosswalks', { member: ALIAS_ADMIN, body: { master_record_id: platformId, source_system: 'TENANT_ALIAS', external_type: 'LABEL', external_code: 'Tên khác', valid_from: '2024-01-01', match_method: 'MANUAL' } });
      expect([second.status, second.json.code]).toEqual([409, 'CROSSWALK_DUPLICATE']);
      const code = await call('POST', '/master-crosswalks', { member: ALIAS_ADMIN, body: { master_record_id: platformId, source_system: 'TENANT_ALIAS', external_type: 'CODE', external_code: 'NSTW-2', valid_from: '2024-01-01', match_method: 'MANUAL' } });
      expect([code.status, code.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(await rows(`select code, label from machvon.master_record_version where master_record_id = $1::uuid`, [platformId])).toEqual([{ code: 'NSTW-ALIAS', label: 'Ngân sách trung ương' }]);
    });

    it('lists the policy of each type with the entries of each namespace, for anyone who may read master data', async () => {
      await inForce();
      const policies = await call('GET', '/master-type-policies', { member: READER });
      expect(policies.status).toBe(200);
      const items = policies.json.items as Array<Record<string, unknown>>;
      expect(items.find((item) => item.master_type === 'SECTOR')).toMatchObject({ scope: 'TENANT_ONLY', source: 'TENANT', locked: false, retire_requires_successor: false });
      expect((items.find((item) => item.master_type === 'SECTOR')?.tenant_records as number) >= 1).toBe(true);
      expect(items.find((item) => item.master_type === 'FUND_SOURCE')).toMatchObject({ scope: 'PLATFORM_ONLY', source: 'BASELINE', locked: true, retire_requires_successor: true });
      expect((await call('GET', '/master-type-policies', { member: NOBODY })).status).toBe(403);
      const other = await call('GET', '/master-type-policies', { member: OTHER_TENANT_STEWARD, tenantId: TENANT_B });
      expect(other.status).toBe(200);
      expect((other.json.items as Array<Record<string, unknown>>).every((item) => item.platform_records === 0)).toBe(true);
    });

    it('lists the versions through the generic scaffold and reads one by id', async () => {
      const listed = await call('GET', '/resources/master_record_version?limit=2', { member: READER });
      expect(listed.status).toBe(200);
      const items = listed.json.items as Array<{ id: string; master_type: string }>;
      expect(items.length).toBe(2);
      const one = await call('GET', `/resources/master_record_version/${items[0]?.id}`, { member: READER });
      expect(one.json).toMatchObject({ id: items[0]?.id });
      expect((await call('GET', `/resources/master_record_version/${randomUUID()}`, { member: READER })).status).toBe(404);
      const entry = await inForce();
      const history = await call('GET', `/resources/master_record_version?master_record_id=${entry.recordId}`, { member: READER });
      expect((history.json.items as Array<{ master_record_id: string }>).map((item) => item.master_record_id)).toEqual([entry.recordId]);
      expect((await call('GET', '/resources/master_record_version?master_record_id=not-a-uuid', { member: READER })).status).toBe(422);
      expect((await call('GET', '/master-records', { member: NOBODY })).status).toBe(403);
    });
  });
});
