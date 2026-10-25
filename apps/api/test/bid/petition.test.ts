import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { BASELINE_PACK, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { PetitionController } from '../../src/modules/bid/petition.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedBidPackage, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const LOGGER = 1; // bid.petition.manage, bid.read over the tenant
const HANDLER = 2; // the same: a different person
const DEPARTMENT_LOGGER = 3; // the same over the unit tree of the department
const ELSEWHERE_LOGGER = 4; // the same over another branch
const READER = 5; // bid.read only
const NOBODY = 6;
const CONFLICTED = 7; // bid.petition.manage, bid.read, with a conflict of interest declared
const B_LOGGER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The Vietnam date `offset` days from today. */
const dayFromToday = (offset: number): string => new Date(Date.now() + 7 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);

describe('the petitions of contractors over HTTP (ST-BID-007)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string }>('select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const stored = async (petitionId: string) =>
    (await rows<{ status: string; due_on: string; days_applied: number; handled_by: string | null; resolution_document_id: string | null; version: string }>('select status, due_on::text, days_applied, handled_by, resolution_document_id, version::text from machvon.procurement_petition where id = $1::uuid', [petitionId]))[0];

  interface Setup {
    projectId: string;
    packageId: string;
    contractor: string;
  }

  const setup = async (options: { unit?: number } = {}): Promise<Setup> => {
    const seeded = await seedBidPackage(harness, options.unit === undefined ? {} : { unit: options.unit });
    return { projectId: seeded.projectId, packageId: seeded.packageId, contractor: await seedContractor(harness) };
  };

  const paper = async (): Promise<string> => {
    const documentId = randomUUID();
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CV', 'Paper', 'INTERNAL', $3, $3)`, [TENANT_A, documentId, memberId(LOGGER)]],
    ]);
    return documentId;
  };

  const receive = async (member: number, s: Setup, overrides: Record<string, unknown> = {}, extra: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/procurement-petitions', {
      member,
      ...extra,
      body: { package_id: s.packageId, contractor_id: s.contractor, petition_kind: 'PROCESS', received_on: dayFromToday(0), petition_document_id: await paper(), ...overrides },
    });
  const resolve = async (member: number, petitionId: string, version: number | string = 1, overrides: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/procurement-petitions/${petitionId}/resolution`, { member, ifMatch: `"${version}"`, body: { outcome: 'RESOLVED', resolution_document_id: await paper(), ...overrides } });
  const list = (member: number, query = '', tenantId?: string): Promise<Reply> => call('GET', `/procurement-petitions${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [LOGGER, HANDLER, DEPARTMENT_LOGGER, ELSEWHERE_LOGGER, READER, NOBODY, CONFLICTED]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_LOGGER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'BID_PETITION_MANAGER', ['bid.petition.manage', 'bid.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'BID_READER', ['bid.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'BID_PETITION_MANAGER', ['bid.petition.manage', 'bid.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LOGGER, role: 1, kind: 'TENANT' },
      { n: 2, member: HANDLER, role: 1, kind: 'TENANT' },
      { n: 3, member: DEPARTMENT_LOGGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 4, member: ELSEWHERE_LOGGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 5, member: READER, role: 2, kind: 'TENANT' },
      { n: 6, member: CONFLICTED, role: 1, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_LOGGER, role: 1, kind: 'TENANT' }]);
    // The deadline rules of the platform (7 calendar days, waiting for the confirmation CXN-BID-02) reach the tenant the way they do in a running system.
    await harness.tenants.withTenant(contextFor(TENANT_A, memberId(LOGGER)), (tx) => applyBaseline(tx, BASELINE_PACK, memberId(LOGGER), dayFromToday(0)));
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PetitionController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of BID', () => {
    expect(bidModule.controllers).toContain(PetitionController);
  });

  describe('receiveProcurementPetition', () => {
    it('logs a petition with the last day to answer from the rule data, its audit row and its event, and answers the same key once', async () => {
      const s = await setup();
      const documentId = await paper();
      const body = { package_id: s.packageId, contractor_id: s.contractor, petition_kind: 'PROCESS', received_on: dayFromToday(0), petition_document_id: documentId };
      const send = () => call('POST', '/procurement-petitions', { member: LOGGER, key: 'receive-once-for-this-key', body });
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'RECEIVED', resource_version: 1 } });
      expect(await send()).toEqual(first);
      const petitionId = first.json.resource_id as string;
      expect(await rows('select id from machvon.procurement_petition where package_id = $1::uuid', [s.packageId])).toHaveLength(1);
      expect(await stored(petitionId)).toMatchObject({ status: 'RECEIVED', due_on: dayFromToday(7), days_applied: 7, handled_by: null, resolution_document_id: null });
      const [audit] = await audits(petitionId, 'petition.received');
      expect(audit).toMatchObject({ actor_id: memberId(LOGGER), safe_diff: { package_id: s.packageId, contractor_id: s.contractor, petition_kind: 'PROCESS', due_on: dayFromToday(7), days_applied: 7, from_status: null, to_status: 'RECEIVED' } });
      const [event] = await events(petitionId, 'bid.petition.received.v1');
      expect(event?.payload).toMatchObject({ petition_id: petitionId, package_id: s.packageId, project_id: s.projectId, status: 'RECEIVED', version: 1, actor_id: memberId(LOGGER), due_on: dayFromToday(7) });
    });

    it('refuses a shape that is not one, a day that has not come (422 PETITION_OUT_OF_TIME), a petition about a result that does not exist, and a paper that lodges another petition', async () => {
      const s = await setup();
      expect(await receive(LOGGER, s, { received_on: dayFromToday(2) })).toMatchObject({ status: 422, json: { code: 'PETITION_OUT_OF_TIME', reason: 'FUTURE' } });
      expect(await receive(LOGGER, s, { petition_kind: 'RESULT' })).toMatchObject({ status: 422, json: { code: 'PETITION_OUT_OF_TIME', reason: 'NO_RESULT' } });
      expect(await receive(LOGGER, s, { petition_kind: 'OTHER' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await receive(LOGGER, s, { received_on: '2026-02-30' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await receive(LOGGER, s, { status: 'RESOLVED', due_on: '2026-01-01' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await receive(LOGGER, s, { petition_document_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const documentId = await paper();
      expect((await receive(LOGGER, s, { petition_document_id: documentId })).status).toBe(200);
      expect(await receive(LOGGER, s, { petition_document_id: documentId })).toMatchObject({ status: 409, json: { code: 'PETITION_STATE_INVALID', reason: 'DOCUMENT_ALREADY_LODGED' } });
      expect(await rows('select id from machvon.procurement_petition where package_id = $1::uuid', [s.packageId])).toHaveLength(1);
    });

    it('is for whoever holds the permission over the project: a package outside the scope does not exist', async () => {
      const s = await setup();
      expect((await receive(READER, s)).status).toBe(403);
      expect((await receive(NOBODY, s)).status).toBe(403);
      expect((await receive(ELSEWHERE_LOGGER, s)).status).toBe(404);
      expect((await receive(DEPARTMENT_LOGGER, s)).status).toBe(200);
      expect((await receive(B_LOGGER, s, {}, { tenantId: TENANT_B })).status).toBe(404);
      expect((await receive(LOGGER, { ...s, packageId: randomUUID() })).status).toBe(404);
    });
  });

  describe('resolveProcurementPetition', () => {
    it('AC-ST-BID-007-1, UAT-AC456: shows a petition overdue once its last day has passed, refuses an answer without a document (422), and with one the petition is RESOLVED', async () => {
      const s = await setup();
      const received = await receive(LOGGER, s, { received_on: dayFromToday(-20) });
      const petitionId = received.json.resource_id as string;
      expect(await stored(petitionId)).toMatchObject({ due_on: dayFromToday(-13) });
      const overdue = await list(READER, `?package_id=${s.packageId}`);
      expect((overdue.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: petitionId, status: 'RECEIVED', overdue: true, days_overdue: 13, due_on: dayFromToday(-13), days_applied: 7 });

      const withoutDocument = await call('POST', `/procurement-petitions/${petitionId}/resolution`, { member: HANDLER, ifMatch: '"1"', body: { outcome: 'RESOLVED' } });
      expect(withoutDocument.status).toBe(422);
      expect(withoutDocument.json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await resolve(HANDLER, petitionId, 1, { resolution_document_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await stored(petitionId))?.status).toBe('RECEIVED');

      const reply = await paper();
      const done = await resolve(HANDLER, petitionId, 1, { resolution_document_id: reply });
      expect(done).toMatchObject({ status: 200, json: { status: 'RESOLVED', resource_version: 2 } });
      expect(await stored(petitionId)).toMatchObject({ status: 'RESOLVED', handled_by: memberId(HANDLER), resolution_document_id: reply, version: '2' });
      const [audit] = await audits(petitionId, 'petition.resolved');
      expect(audit).toMatchObject({ actor_id: memberId(HANDLER), safe_diff: { from_status: 'RECEIVED', to_status: 'RESOLVED', late: true, resolution_document_id: reply } });
      const [event] = await events(petitionId, 'bid.petition.resolved.v1');
      expect(event?.payload).toMatchObject({ petition_id: petitionId, status: 'RESOLVED', from_status: 'RECEIVED', late: true, version: 2 });
      const after = await list(READER, `?package_id=${s.packageId}`);
      expect((after.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'RESOLVED', overdue: false, days_overdue: 0, handled_by: { membership_id: memberId(HANDLER) } });
    });

    it('AC-ST-BID-007-2, UAT-AC450: a person with a conflict of interest against the contractor does not answer, is told so on the list, and a different person does', async () => {
      const s = await setup();
      const petitionId = (await receive(LOGGER, s)).json.resource_id as string;
      await seedAs(harness, [
        [
          `insert into machvon.bid_conflict_declaration (tenant_id, id, package_id, user_id, has_conflict, relation_text, contractor_id, declared_at, created_by, updated_by, version)
           values ($1, $2, $3, $4, true, 'A relative', $5, now(), $4, $4, 1)`,
          [TENANT_A, randomUUID(), s.packageId, memberId(CONFLICTED), s.contractor],
        ],
      ]);
      const mine = await list(CONFLICTED, `?package_id=${s.packageId}`);
      expect((mine.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ viewer_in_conflict: true, actions: { resolve: false } });
      const theirs = await list(HANDLER, `?package_id=${s.packageId}`);
      expect((theirs.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ viewer_in_conflict: false, actions: { resolve: true } });

      expect(await resolve(CONFLICTED, petitionId)).toMatchObject({ status: 409, json: { code: 'CONFLICT_OF_INTEREST_BLOCKED', contractor_id: s.contractor, conflict_of: 'HANDLER' } });
      expect(await stored(petitionId)).toMatchObject({ status: 'RECEIVED', handled_by: null, version: '1' });
      expect(await resolve(HANDLER, petitionId)).toMatchObject({ status: 200, json: { status: 'RESOLVED' } });
    });

    it('passes a petition on to the level above, which is then answered, and refuses an answer from the wrong state or on a stale version', async () => {
      const s = await setup();
      const petitionId = (await receive(LOGGER, s)).json.resource_id as string;
      expect(await resolve(HANDLER, petitionId, 5)).toMatchObject({ status: 409 });
      expect(await resolve(HANDLER, petitionId, 1, { outcome: 'WITHDRAWN' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await resolve(HANDLER, petitionId, 1, { outcome: 'ESCALATED' })).toMatchObject({ status: 200, json: { status: 'ESCALATED', resource_version: 2 } });
      const [audit] = await audits(petitionId, 'petition.escalated');
      expect(audit).toMatchObject({ safe_diff: { from_status: 'RECEIVED', to_status: 'ESCALATED' } });
      expect((await events(petitionId, 'bid.petition.escalated.v1'))[0]?.payload).toMatchObject({ status: 'ESCALATED' });
      expect(await resolve(HANDLER, petitionId, 2, { outcome: 'ESCALATED' })).toMatchObject({ status: 409, json: { code: 'PETITION_STATE_INVALID', petition_status: 'ESCALATED' } });
      expect(await resolve(HANDLER, petitionId, 2)).toMatchObject({ status: 200, json: { status: 'RESOLVED', resource_version: 3 } });
      expect(await resolve(HANDLER, petitionId, 3)).toMatchObject({ status: 409, json: { code: 'PETITION_STATE_INVALID', petition_status: 'RESOLVED' } });
    });

    it('is for whoever holds the permission over the project', async () => {
      const s = await setup();
      const petitionId = (await receive(LOGGER, s)).json.resource_id as string;
      expect((await resolve(READER, petitionId)).status).toBe(403);
      expect((await resolve(NOBODY, petitionId)).status).toBe(403);
      expect((await resolve(ELSEWHERE_LOGGER, petitionId)).status).toBe(404);
      expect((await resolve(HANDLER, randomUUID())).status).toBe(404);
      expect((await stored(petitionId))?.status).toBe('RECEIVED');
    });
  });

  describe('listProcurementPetitions', () => {
    it('lists the petitions of the packages in the scope, the ones that wait first, optionally one package or only the overdue, with what the caller may do', async () => {
      const s = await setup();
      const late = (await receive(LOGGER, s, { received_on: dayFromToday(-20) })).json.resource_id as string;
      const fresh = (await receive(LOGGER, s)).json.resource_id as string;
      const done = (await receive(LOGGER, s, { received_on: dayFromToday(-3) })).json.resource_id as string;
      await resolve(HANDLER, done);
      const all = await list(HANDLER, `?package_id=${s.packageId}`);
      expect(all.status).toBe(200);
      expect((all.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([late, fresh, done]);
      expect((all.json.items as Array<Record<string, unknown>>).map((item) => (item.actions as Record<string, boolean>).resolve)).toEqual([true, true, false]);
      expect((all.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({
        package: { id: s.packageId },
        project_id: s.projectId,
        contractor: { id: s.contractor },
        petition_kind: 'PROCESS',
        status: 'RECEIVED',
        version: 1,
      });
      expect(Object.keys((all.json.items as Array<Record<string, unknown>>)[0] ?? {}).sort()).toEqual(
        ['actions', 'contractor', 'created_at', 'created_by', 'days_applied', 'days_overdue', 'due_on', 'handled_by', 'id', 'overdue', 'package', 'petition_document_id', 'petition_kind', 'project_id', 'received_on', 'resolution_document_id', 'resolved_at', 'status', 'version', 'viewer_in_conflict'].sort(),
      );
      const overdue = await list(HANDLER, `?package_id=${s.packageId}&overdue=true`);
      expect((overdue.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([late]);
      expect((await list(READER, `?package_id=${s.packageId}`)).json.items).toHaveLength(3);
      expect(((await list(READER, `?package_id=${s.packageId}`)).json.items as Array<Record<string, Record<string, boolean>>>).every((item) => item.actions?.resolve === false)).toBe(true);
      expect(await list(HANDLER, '?package_id=nope')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await list(HANDLER, '?overdue=maybe')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await list(NOBODY)).status).toBe(403);
      expect(((await list(ELSEWHERE_LOGGER, `?package_id=${s.packageId}`)).json.items as unknown[]).length).toBe(0);
      expect(((await list(B_LOGGER, `?package_id=${s.packageId}`, TENANT_B)).json.items as unknown[]).length).toBe(0);
    });
  });
});
