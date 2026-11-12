import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, RetentionJob, RetentionPolicyStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { CommandModule } from '../src/command.module';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { LegalHoldReadsController, LegalHoldsController } from '../src/modules/adm/legal-holds.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;
const PROJECT = id(0x50, 1);
// A unit id that contains hex letters, so its upper-case spelling differs from what PostgreSQL returns.
const LETTERED_UNIT = 0xab;

// Members of tenant A.
const OFFICER = 1; // legal_hold.manage and read on the whole tenant
const SECOND_OFFICER = 2; // the same: the second person that a release needs
const READER = 3; // legal_hold.read on the whole tenant: the authority reference stays masked
const UNIT_MANAGER = 4; // legal_hold.manage and read on the subtree of unit 2 only
const NOBODY = 5; // no grant

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

describe('legal hold commands and reads (ST-ADM-003)', () => {
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
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const scopeBody = (kind: string, ids: string[] = []): Record<string, unknown> => ({
    hold_kind: 'INSPECTION',
    resource_scope: { kind, ids },
    authority_reference: 'Decision 12/QD-TTCP',
    reason: 'Inspection of the project files',
  });

  const place = (member: number, body: Record<string, unknown> = scopeBody('TENANT')): Promise<Reply> => call('POST', '/legal-holds', { member, body });
  const release = (member: number, holdId: string, options: { ifMatch?: string; reason?: string } = {}): Promise<Reply> =>
    call('POST', `/legal-holds/${holdId}/release`, { member, ifMatch: options.ifMatch ?? '"1"', body: { reason: options.reason ?? 'Inspection closed by decision' } });
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  const countOf = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await harness.owner<{ n: string }>(TENANT_A, [[sql, params]]))[0]?.n);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: path(1) },
      { n: 2, path: path(1, 2), parent: 1 },
      { n: LETTERED_UNIT, path: path(1, LETTERED_UNIT), parent: 1 },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: path(1) }]);
    for (const n of [OFFICER, SECOND_OFFICER, READER, UNIT_MANAGER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'LEGAL_OFFICER', ['legal_hold.manage', 'legal_hold.read'], 60);
    await harness.seedRole(TENANT_A, 2, 'HOLD_READER', ['legal_hold.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'TENANT' },
      { n: 2, member: SECOND_OFFICER, role: 1, kind: 'TENANT' },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
      { n: 4, member: UNIT_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
         values ($1, $2, 'P1', 'Project 1', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1)`,
        [TENANT_A, PROJECT, unitId(2), id(0x52, 1)],
      );
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
      controllers: [LegalHoldsController, LegalHoldReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    await harness.owner(TENANT_A, [
      ['delete from machvon.legal_hold', []],
      ["delete from machvon.audit_event where resource_type = 'legal_hold'", []],
    ]);
  });

  describe('placeLegalHold', () => {
    it('places a tenant hold, audits it with the authority reference redacted and announces it', async () => {
      const reply = await place(OFFICER);
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'PLACED', resource_version: 1 });
      const holdId = idOf(reply);
      const audit = await harness.owner<{ safe_diff: Record<string, unknown>; outcome: string }>(TENANT_A, [
        ["select safe_diff, outcome from machvon.audit_event where action = 'legal_hold.place' and resource_id = $1", [holdId]],
      ]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.outcome).toBe('SUCCESS');
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('Decision 12');
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'platform.legal_hold.placed.v1' and aggregate_id = $1", [holdId])).toBe(1);
    });

    it('places a project hold after resolving the project in the tenant', async () => {
      const reply = await place(OFFICER, scopeBody('PROJECT', [PROJECT]));
      expect(reply.status).toBe(201);
    });

    it('accepts an id written in upper case, stores it in lower case and drops the duplicate spelling', async () => {
      const reply = await place(OFFICER, scopeBody('UNIT', [unitId(LETTERED_UNIT).toUpperCase(), unitId(LETTERED_UNIT)]));
      expect(reply.status).toBe(201);
      const [row] = await harness.owner<{ resource_scope: { ids: string[] } }>(TENANT_A, [['select resource_scope from machvon.legal_hold where id = $1', [idOf(reply)]]]);
      expect(row?.resource_scope.ids).toEqual([unitId(LETTERED_UNIT)]);
    });

    it.each([
      ['a unit hold without ids', scopeBody('UNIT')],
      ['a tenant hold that lists ids', scopeBody('TENANT', [PROJECT])],
      ['a project hold for a project that does not exist', scopeBody('PROJECT', [id(0x70, 9)])],
      ['a resource hold without ids', scopeBody('RESOURCE')],
    ])('refuses %s with 422 VALIDATION_FAILED and places nothing', async (_label, body) => {
      const reply = await place(OFFICER, body);
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('VALIDATION_FAILED');
      expect(await countOf('select count(*) as n from machvon.legal_hold')).toBe(0);
    });

    it('refuses a reason shorter than ten characters and an authority reference shorter than five', async () => {
      const short = await place(OFFICER, { ...scopeBody('TENANT'), reason: 'short' });
      expect(short.status).toBeGreaterThanOrEqual(400);
      const reference = await place(OFFICER, { ...scopeBody('TENANT'), authority_reference: 'ab' });
      expect(reference.status).toBeGreaterThanOrEqual(400);
      expect(await countOf('select count(*) as n from machvon.legal_hold')).toBe(0);
    });

    it('refuses a caller without the permission (403) and one whose authority covers only a unit subtree (403 SCOPE_DENIED, audited as DENIED)', async () => {
      expect((await place(NOBODY)).status).toBe(403);
      expect((await place(READER)).status).toBe(403);
      const unitManager = await place(UNIT_MANAGER);
      expect(unitManager.status).toBe(403);
      expect(unitManager.json.code).toBe('SCOPE_DENIED');
      expect(await countOf("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action like '%placeLegalHold%'")).toBeGreaterThanOrEqual(1);
      expect(await countOf('select count(*) as n from machvon.legal_hold')).toBe(0);
    });
  });

  describe('releaseLegalHold', () => {
    it('lets a second person release with a reason, and audits and announces it (AC-ST-ADM-003-1)', async () => {
      const holdId = idOf(await place(OFFICER));
      const reply = await release(SECOND_OFFICER, holdId);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'RELEASED', resource_version: 2 });
      expect(await countOf("select count(*) as n from machvon.legal_hold where id = $1 and status = 'Released'", [holdId])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'legal_hold.release' and resource_id = $1", [holdId])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'platform.legal_hold.released.v1' and aggregate_id = $1", [holdId])).toBe(1);
    });

    it('refuses the person who placed the hold with 403 SELF_APPROVAL_DENIED and leaves the hold Active (AC-ST-ADM-003-1)', async () => {
      const holdId = idOf(await place(OFFICER));
      const reply = await release(OFFICER, holdId);
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SELF_APPROVAL_DENIED');
      expect(await countOf("select count(*) as n from machvon.legal_hold where id = $1 and status = 'Active'", [holdId])).toBe(1);
    });

    it('refuses a short reason, a missing If-Match (428), a stale one (409) and a second release (409 LEGAL_HOLD_STATE_INVALID)', async () => {
      const holdId = idOf(await place(OFFICER));
      expect((await release(SECOND_OFFICER, holdId, { reason: 'too short' })).status).toBeGreaterThanOrEqual(400);
      const missing = await call('POST', `/legal-holds/${holdId}/release`, { member: SECOND_OFFICER, body: { reason: 'Inspection closed by decision' } });
      expect(missing.status).toBe(428);
      const stale = await release(SECOND_OFFICER, holdId, { ifMatch: '"5"' });
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      expect((await release(SECOND_OFFICER, holdId)).status).toBe(200);
      const again = await release(SECOND_OFFICER, holdId, { ifMatch: '"2"' });
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('LEGAL_HOLD_STATE_INVALID');
    });

    it('answers 404 for a hold that is not there and for a hold of another tenant', async () => {
      const holdId = idOf(await place(OFFICER));
      expect((await release(SECOND_OFFICER, id(0x70, 8))).status).toBe(404);
      await harness.seedMembership(TENANT_B, 1, 1);
      await harness.seedRole(TENANT_B, 1, 'LEGAL_OFFICER', ['legal_hold.manage', 'legal_hold.read'], 60);
      await harness.seedGrants(TENANT_B, [{ n: 1, member: 1, role: 1, kind: 'TENANT' }]);
      const foreign = await call('POST', `/legal-holds/${holdId}/release`, { member: 1, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: 'Inspection closed by decision' } });
      expect(foreign.status).toBe(404);
    });

    it('refuses a caller whose authority covers only a unit subtree, and one without the permission', async () => {
      const holdId = idOf(await place(OFFICER));
      const unitManager = await release(UNIT_MANAGER, holdId);
      expect(unitManager.status).toBe(403);
      expect(unitManager.json.code).toBe('SCOPE_DENIED');
      expect((await release(NOBODY, holdId)).status).toBe(403);
    });
  });

  describe('reads', () => {
    it('shows the authority reference to a caller who can manage holds and masks it for one who only reads', async () => {
      const holdId = idOf(await place(OFFICER));
      const managed = await call('GET', '/resources/legal_hold', { member: OFFICER });
      expect(managed.status).toBe(200);
      const [managedItem] = managed.json.items as Array<Record<string, unknown>>;
      expect(managedItem).toMatchObject({ id: holdId, status: 'Active', hold_kind: 'INSPECTION', authority_reference: 'Decision 12/QD-TTCP', placed_by: memberId(OFFICER) });
      const masked = await call('GET', `/resources/legal_hold/${holdId}`, { member: READER });
      expect(masked.status).toBe(200);
      expect(masked.json.authority_reference).toBe('***');
      expect(JSON.stringify(masked.json)).not.toContain('Decision 12');
    });

    it('lists the active holds first, pages with an opaque cursor and refuses a cursor it did not issue', async () => {
      const first = idOf(await place(OFFICER));
      const second = idOf(await place(OFFICER, scopeBody('RESOURCE', [id(0x70, 1)])));
      expect((await release(SECOND_OFFICER, first)).status).toBe(200);
      const page = await call('GET', '/resources/legal_hold?limit=1', { member: OFFICER });
      expect((page.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second]);
      const cursor = page.json.next_cursor as string;
      expect(cursor).toEqual(expect.any(String));
      const rest = await call('GET', `/resources/legal_hold?limit=5&cursor=${cursor}`, { member: OFFICER });
      expect((rest.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([first]);
      expect(rest.json.next_cursor).toBeNull();
      expect((await call('GET', '/resources/legal_hold?cursor=not-a-cursor', { member: OFFICER })).status).toBe(422);
    });

    it('shows nothing to a caller whose authority covers only a unit subtree: holds are tenant administration (404 for one hold)', async () => {
      const holdId = idOf(await place(OFFICER));
      const list = await call('GET', '/resources/legal_hold', { member: UNIT_MANAGER });
      expect(list.status).toBe(200);
      expect(list.json.items).toEqual([]);
      expect((await call('GET', `/resources/legal_hold/${holdId}`, { member: UNIT_MANAGER })).status).toBe(404);
    });

    it('never shows the hold of one tenant to another and refuses a caller without the read permission', async () => {
      const holdId = idOf(await place(OFFICER));
      expect((await call('GET', '/resources/legal_hold', { member: NOBODY })).status).toBe(403);
      await harness.seedMembership(TENANT_B, 2, 1);
      await harness.seedRole(TENANT_B, 2, 'HOLD_READER', ['legal_hold.read'], 20);
      await harness.seedGrants(TENANT_B, [{ n: 2, member: 2, role: 2, kind: 'TENANT' }]);
      const foreign = await call('GET', `/resources/legal_hold/${holdId}`, { member: 2, tenantId: TENANT_B });
      expect(foreign.status).toBe(404);
      const list = await call('GET', '/resources/legal_hold', { member: 2, tenantId: TENANT_B });
      expect(list.json.items).toEqual([]);
    });
  });

  describe('the retention job and a hold (ADM-12, UAT-AC141)', () => {
    it('UAT-AC141 the job skips a dossier under a hold, the placer cannot release the hold (403 SELF_APPROVAL_DENIED), a second person releases it with a reason, and the next run puts the dossier on the review list without deleting it', async () => {
      const admin = async (sql: string, params: unknown[] = []): Promise<void> => {
        const client = new Client({ connectionString: harness.database.adminUrl });
        await client.connect();
        try {
          await client.query('set session_replication_role = replica');
          await client.query(sql, params);
        } finally {
          await client.end();
        }
      };
      // The dossier of project P1 is a year and more old and its period of retention has ended (REVIEW_FOR_DESTRUCTION, one year from creation).
      await admin("update machvon.project set created_at = '2024-03-15T03:00:00Z', status_changed_at = '2024-03-15T03:00:00Z' where id = $1", [PROJECT]);
      const policies = new RetentionPolicyStore();
      const today = new Date().toISOString().slice(0, 10);
      const draftRow = (
        await harness.tenants.withTenant(contextFor(TENANT_A, memberId(OFFICER)), (tx) =>
          policies.createDraft(tx, { record_class: 'project_dossier', retention_years: 1, retention_basis: 'FROM_CREATED', legal_basis_ref: 'Placeholder until CXN-RET-03 is confirmed', end_action: 'REVIEW_FOR_DESTRUCTION', effective_from: '2026-01-01' }, memberId(OFFICER)),
        )
      ).row;
      await harness.tenants.withTenant(contextFor(TENANT_A, memberId(SECOND_OFFICER)), async (tx) => policies.publish(tx, await policies.lockDraft(tx, draftRow.id, draftRow.version), memberId(SECOND_OFFICER), today));
      const job = new RetentionJob(harness.tenants as TenantDatabase);
      const worker = { tenantId: TENANT_A, membershipId: '00000000-0000-4000-8000-000000000000', scopeVersion: 0 };
      const reviewItems = (): Promise<Array<{ resource_id: string; status: string; end_action: string }>> =>
        harness.owner(TENANT_A, [["select resource_id, status, end_action from machvon.retention_review_item where resource_id = $1", [PROJECT]]]);
      const projects = (): Promise<Array<{ n: string }>> => harness.owner(TENANT_A, [['select count(*) as n from machvon.project where id = $1', [PROJECT]]]);

      // The owner of the hold places it on the project (an audit hold, with its authority).
      const placed = await place(OFFICER, { hold_kind: 'AUDIT', resource_scope: { kind: 'PROJECT', ids: [PROJECT] }, authority_reference: 'Kết luận Thanh tra số 12/KL-TTT', reason: 'The inspection holds the project dossier' });
      expect(placed.status).toBe(201);
      const holdId = idOf(placed);
      // Run 1: the dossier is skipped because of the hold: nothing is listed and nothing is deleted.
      const first = await job.run(worker, new Date());
      expect(first).toMatchObject({ listed: {}, skippedHeld: { project_dossier: 1 } });
      expect(await reviewItems()).toEqual([]);
      // Step 2: the person who placed the hold cannot release it.
      const own = await release(OFFICER, holdId, { reason: 'I close my own hold now' });
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await countOf("select count(*) as n from machvon.legal_hold where id = $1 and status = 'Active'", [holdId])).toBe(1);
      // Step 3: the second person releases it with the reason.
      const released = await release(SECOND_OFFICER, holdId, { reason: 'Đã có kết luận khắc phục' });
      expect(released).toMatchObject({ status: 200, json: { status: 'RELEASED' } });
      expect(await countOf("select count(*) as n from machvon.legal_hold where id = $1 and status = 'Released' and release_reason = 'Đã có kết luận khắc phục'", [holdId])).toBe(1);
      // Run 2: the dossier goes to the list of the council that decides on destruction; the job does not delete it.
      const second = await job.run(worker, new Date());
      expect(second).toMatchObject({ listed: { project_dossier: 1 }, skippedHeld: {} });
      expect(await reviewItems()).toEqual([{ resource_id: PROJECT, status: 'PENDING_REVIEW', end_action: 'REVIEW_FOR_DESTRUCTION' }]);
      const remaining = await projects();
      expect(remaining).toEqual([{ n: '1' }]);
      // The negative control: a check that wants the dossier deleted after the release must fail on what was read.
      expect(() => expect(Number(remaining[0]?.n)).toBe(0)).toThrow();
    });
  });
});
