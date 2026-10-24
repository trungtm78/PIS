import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { MasterDataController, MasterDataReadsController } from '../../src/modules/mdm/master-data.controller';
import { MasterSuccessionController, MasterSuccessionReadsController } from '../../src/modules/mdm/master-succession.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const DECISION_DOCUMENT = id(0x70, 1);
const REFORM = '2025-07-01';
const BASIS = 'Resolution 202/2025/QH15 (working assumption awaiting CXN-34)';

const STEWARD = 1; // master.propose and master.read
const CHECKER = 2; // master.review and master.read
const PUBLISHER = 3; // master.publish and master.read
const READER = 4; // master.read
const NOBODY = 5;
const OTHER_TENANT_STEWARD = 1; // of tenant B

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Entry {
  recordId: string;
  key: string;
}

describe('administrative succession commands and reads (ST-MDM-009)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;

  /** An area in force (proposed, approved by a second person and published by a third), with the validity and parent the reform needs. */
  async function area(overrides: Record<string, unknown> = {}): Promise<Entry> {
    counter += 1;
    const key = `AR-${counter}-${randomUUID().slice(0, 6)}`;
    const proposed = await call('POST', '/master-records', {
      member: STEWARD,
      body: { namespace: 'TENANT', master_type: 'AREA', business_key: key, label: `Area ${counter}`, attributes: { level: 'COMMUNE' }, valid_from: '2020-01-01', reason: 'Initial catalogue entry', ...overrides },
    });
    expect(proposed.status).toBe(200);
    const recordId = idOf(proposed);
    const change = (await rows<{ id: string; version: string }>('select id, version::text as version from machvon.master_change_request where master_record_id = $1', [recordId]))[0];
    const submitted = await call('POST', `/master-change-requests/${change?.id}/submit`, { member: STEWARD, ifMatch: `"${change?.version}"` });
    expect((await call('POST', `/master-change-requests/${change?.id}/decision`, { member: CHECKER, ifMatch: `"${versionOf(submitted)}"`, body: { decision: 'approve', reason: 'Checked against the decision' } })).status).toBe(200);
    const record = (await rows<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [recordId]))[0];
    expect((await call('POST', `/master-records/${recordId}/publish`, { member: PUBLISHER, ifMatch: `"${record?.version}"`, body: { decision_document_id: DECISION_DOCUMENT } })).status).toBe(200);
    return { recordId, key };
  }

  const succession = (predecessor: Entry, successor: Entry, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    predecessor_record_id: predecessor.recordId,
    successor_record_id: successor.recordId,
    succession_kind: 'MERGE',
    effective_date: REFORM,
    legal_basis: BASIS,
    reason: 'Recorded after the 2025 administrative reform',
    ...overrides,
  });
  const record = (member: number, body: Record<string, unknown>, options: { tenantId?: string; key?: string } = {}): Promise<Reply> => call('POST', '/master-successions', { member, body, ...options });
  const asOf = (member: number, recordId: string, date?: string, tenantId?: string): Promise<Reply> =>
    call('GET', `/master-records/${recordId}/as-of${date === undefined ? '' : `?date=${date}`}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const successorsOf = (member: number, recordId: string, date?: string): Promise<Reply> => call('GET', `/master-records/${recordId}/successors${date === undefined ? '' : `?date=${date}`}`, { member });

  /** Takes a recorded succession through submit, decision and publication, as the steward, the checker and the publisher. */
  async function putInForce(predecessor: Entry, recorded: Reply): Promise<void> {
    const submitted = await call('POST', `/master-change-requests/${idOf(recorded)}/submit`, { member: STEWARD, ifMatch: `"${versionOf(recorded)}"` });
    expect(submitted.status).toBe(200);
    expect((await call('POST', `/master-change-requests/${idOf(recorded)}/decision`, { member: CHECKER, ifMatch: `"${versionOf(submitted)}"`, body: { decision: 'approve', reason: 'Checked against the decision' } })).status).toBe(200);
    const current = (await rows<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [predecessor.recordId]))[0];
    const published = await call('POST', `/master-records/${predecessor.recordId}/publish`, { member: PUBLISHER, ifMatch: `"${current?.version}"`, body: { decision_document_id: DECISION_DOCUMENT } });
    expect(published.status).toBe(200);
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
        // The AREA type of these tests is the tenant's own: a row of the control plane replaces the baseline of the platform for it.
        ["insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'AREA', 'TENANT_ONLY', $2)", [tenant, memberId(1)]],
      ]);
    }
    for (const n of [STEWARD, CHECKER, PUBLISHER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_STEWARD, 1);
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', ['master.propose', 'master.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_CHECKER', ['master.review', 'master.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'DATA_PUBLISHER', ['master.publish', 'master.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'DATA_READER', ['master.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'DATA_STEWARD', ['master.propose', 'master.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: PUBLISHER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_STEWARD, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MasterDataController, MasterDataReadsController, MasterSuccessionController, MasterSuccessionReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('recordMasterSuccession', () => {
    it('opens a SUCCESSION change request in DRAFT, audits it with the reason, and keeps the replay answer (AC-ST-MDM-009-1)', async () => {
      const [from, to] = [await area(), await area()];
      const key = `key-${randomUUID()}`;
      const first = await record(STEWARD, succession(from, to), { key });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const replay = await record(STEWARD, succession(from, to), { key });
      expect(replay.json.resource_id).toBe(idOf(first));
      const change = await call('GET', `/master-change-requests/${idOf(first)}`, { member: READER });
      expect(change.json).toMatchObject({
        change_kind: 'SUCCESSION',
        status: 'DRAFT',
        master_record_id: from.recordId,
        business_key: from.key,
        effective_from: REFORM,
        proposed: { succession_kind: 'MERGE', effective_date: REFORM, legal_basis: BASIS, edges: [{ successor_record_id: to.recordId, share_pct: null }] },
      });
      const audit = await rows<{ action: string; reason: string | null }>("select action, reason from machvon.audit_event where resource_id = $1 and action = 'master.succession_recorded'", [idOf(first)]);
      expect(audit).toEqual([{ action: 'master.succession_recorded', reason: 'Recorded after the 2025 administrative reform' }]);
      // Nothing is a fact before the publication: the edge is not read, and the entry is still in force.
      expect((await asOf(READER, from.recordId, REFORM)).json).toMatchObject({ state: 'IN_FORCE' });
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.master_succession where predecessor_record_id = $1', [from.recordId]))[0]?.n)).toBe(0);
    });

    it('is refused without master.propose, for an unknown field, a missing field and bad values, and writes nothing', async () => {
      const [from, to] = [await area(), await area()];
      expect((await record(READER, succession(from, to))).status).toBe(403);
      expect((await record(NOBODY, succession(from, to))).status).toBe(403);
      const unknown = await record(STEWARD, succession(from, to, { status: 'APPLIED' }));
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const withoutBasis = succession(from, to);
      delete withoutBasis.legal_basis;
      expect((await record(STEWARD, withoutBasis)).status).toBe(400);
      const failures: Array<[Record<string, unknown>, string]> = [
        [succession(from, to, { effective_date: '2025-13-40' }), 'effective_date'],
        [succession(from, to, { share_pct: '50' }), 'share_pct'],
        [succession(from, to, { succession_kind: 'SPLIT' }), 'share_pct'],
        [succession(from, to, { successor_record_id: randomUUID() }), 'successor_record_id'],
      ];
      for (const [body, detail] of failures) {
        const reply = await record(STEWARD, body);
        expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', detail]);
      }
      expect((await record(STEWARD, succession(from, to, { predecessor_record_id: randomUUID() }))).status).toBe(404);
      expect(Number((await rows<{ n: string }>("select count(*)::text as n from machvon.master_change_request where master_record_id = $1 and change_kind = 'SUCCESSION'", [from.recordId]))[0]?.n)).toBe(0);
    });

    it('does not see the entries of another tenant', async () => {
      const [from, to] = [await area(), await area()];
      const reply = await record(OTHER_TENANT_STEWARD, succession(from, to), { tenantId: TENANT_B });
      expect([reply.status, reply.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await asOf(OTHER_TENANT_STEWARD, from.recordId, REFORM, TENANT_B)).status).toBe(404);
    });
  });

  describe('the district abolished and two communes merged (FX-MDM-001)', () => {
    it('reads the old structure before 2025-07-01 and the merged commune after it, over the API (AC-ST-MDM-009-1, UAT-AC277)', async () => {
      const district = await area({ attributes: { level: 'DISTRICT' } });
      const province = await area({ attributes: { level: 'PROVINCE' } });
      const communeA = await area({ parent_record_id: district.recordId });
      const communeB = await area({ parent_record_id: district.recordId });
      const merged = await area({ parent_record_id: province.recordId, valid_from: REFORM, label: 'Merged commune' });
      for (const commune of [communeA, communeB]) await putInForce(commune, await record(STEWARD, succession(commune, merged)));
      await putInForce(district, await record(STEWARD, succession(district, province, { succession_kind: 'ABOLISH_LEVEL' })));

      for (const entry of [district, communeA, communeB]) {
        const before = await asOf(READER, entry.recordId, '2025-06-30');
        expect(before.status).toBe(200);
        expect(before.json).toMatchObject({ master_record_id: entry.recordId, business_key: entry.key, as_of: '2025-06-30', state: 'IN_FORCE', version: { revision: 1 } });
      }
      const afterA = await asOf(READER, communeA.recordId, REFORM);
      expect(afterA.json).toMatchObject({ state: 'SUCCEEDED', version: null, structure_date: REFORM });
      expect(afterA.json.targets).toEqual([expect.objectContaining({ record_id: merged.recordId, business_key: merged.key, succession_kind: 'MERGE', share_pct: '100.00', in_force: true })]);
      expect((afterA.json.successors as unknown[]).length).toBe(1);
      const afterMerged = await asOf(READER, merged.recordId, REFORM);
      expect(afterMerged.json).toMatchObject({ state: 'IN_FORCE', version: { label: 'Merged commune', parent_record_id: province.recordId } });
      expect((afterMerged.json.predecessors as Array<{ predecessor_key: string }>).map((edge) => edge.predecessor_key).sort()).toEqual([communeA.key, communeB.key].sort());
      expect((await asOf(READER, merged.recordId, '2025-06-30')).json).toMatchObject({ state: 'NOT_STARTED' });

      const converted = await successorsOf(READER, communeA.recordId, '2025-08-01');
      expect(converted.status).toBe(200);
      expect(converted.json).toMatchObject({ master_record_id: communeA.recordId, as_of: '2025-08-01' });
      expect((converted.json.targets as Array<{ business_key: string }>).map((target) => target.business_key)).toEqual([merged.key]);
      expect((converted.json.edges as unknown[]).length).toBe(1);
      expect(((await successorsOf(READER, communeA.recordId, '2025-06-30')).json.edges as unknown[]).length).toBe(0);
      // Without a date the structure of today is read.
      expect(((await successorsOf(READER, communeA.recordId)).json.targets as Array<{ business_key: string }>)[0]?.business_key).toBe(merged.key);
      expect((await asOf(READER, communeA.recordId)).json).toMatchObject({ state: 'SUCCEEDED' });
    });

    it('answers 404 for an unknown entry and 422 for a date that is not a date, and needs master.read', async () => {
      const entry = await area();
      expect((await asOf(READER, randomUUID(), REFORM)).status).toBe(404);
      expect((await successorsOf(READER, randomUUID(), REFORM)).status).toBe(404);
      const bad = await asOf(READER, entry.recordId, '2025-02-30');
      expect([bad.status, bad.json.code, bad.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'date']);
      expect((await successorsOf(READER, entry.recordId, 'tomorrow')).status).toBe(422);
      expect((await asOf(NOBODY, entry.recordId, REFORM)).status).toBe(403);
      expect((await successorsOf(NOBODY, entry.recordId, REFORM)).status).toBe(403);
    });
  });

  describe('two provinces merged into one', () => {
    it('keeps the two provinces apart before the date and combines them after it, each tagged with its structure date (AC-ST-MDM-009-2, UAT-AC278)', async () => {
      const [keep, absorbed] = [await area({ attributes: { level: 'PROVINCE' } }), await area({ attributes: { level: 'PROVINCE' } })];
      await putInForce(absorbed, await record(STEWARD, succession(absorbed, keep)));

      const [pBefore, qBefore] = [await asOf(READER, keep.recordId, '2025-06-30'), await asOf(READER, absorbed.recordId, '2025-06-30')];
      expect([pBefore.json.state, qBefore.json.state]).toEqual(['IN_FORCE', 'IN_FORCE']);
      expect([pBefore.json.structure_date, qBefore.json.structure_date]).toEqual(['2020-01-01', '2020-01-01']);
      expect((pBefore.json.targets as Array<{ business_key: string }>).map((target) => target.business_key)).toEqual([keep.key]);
      expect((qBefore.json.targets as Array<{ business_key: string }>).map((target) => target.business_key)).toEqual([absorbed.key]);

      const [pAfter, qAfter] = [await asOf(READER, keep.recordId, REFORM), await asOf(READER, absorbed.recordId, REFORM)];
      expect(pAfter.json).toMatchObject({ state: 'IN_FORCE', structure_date: REFORM });
      expect((pAfter.json.predecessors as Array<{ predecessor_key: string }>).map((edge) => edge.predecessor_key)).toEqual([absorbed.key]);
      expect(qAfter.json).toMatchObject({ state: 'SUCCEEDED', structure_date: REFORM });
      expect((qAfter.json.targets as Array<{ business_key: string }>).map((target) => target.business_key)).toEqual([keep.key]);
    });
  });

  describe('a cycle and the shares of a split', () => {
    it('answers 422 SUCCESSION_CYCLE for a ring, and refuses a split that does not add up to 100 (AC-ST-MDM-009-3, UAT-PLAN-55)', async () => {
      const [first, second] = [await area(), await area()];
      await putInForce(first, await record(STEWARD, succession(first, second)));
      const ring = await record(STEWARD, succession(second, first, { effective_date: '2025-08-01' }));
      expect([ring.status, ring.json.code]).toEqual([422, 'SUCCESSION_CYCLE']);

      const [source, left, right] = [await area(), await area(), await area()];
      const open = await record(STEWARD, succession(source, left, { succession_kind: 'SPLIT', share_pct: '70' }));
      expect(open.status).toBe(200);
      const over = await record(STEWARD, succession(source, right, { succession_kind: 'SPLIT', share_pct: '40' }));
      expect([over.status, over.json.code, over.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'share_pct']);
      const second20 = await record(STEWARD, succession(source, right, { succession_kind: 'SPLIT', share_pct: '20' }));
      expect(idOf(second20)).toBe(idOf(open));
      expect(versionOf(second20)).toBe(2);
      const short = await call('POST', `/master-change-requests/${idOf(open)}/submit`, { member: STEWARD, ifMatch: `"${versionOf(second20)}"` });
      expect([short.status, short.json.code, short.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'share_pct']);
      const rest = await area();
      const whole = await record(STEWARD, succession(source, rest, { succession_kind: 'SPLIT', share_pct: '10' }));
      await putInForce(source, whole);
      const converted = await successorsOf(READER, source.recordId, '2025-08-01');
      expect((converted.json.targets as Array<{ business_key: string; share_pct: string }>).map((target) => [target.business_key, target.share_pct]).sort()).toEqual(
        [[left.key, '70.00'], [right.key, '20.00'], [rest.key, '10.00']].sort(),
      );
    });
  });

  describe('four-eyes', () => {
    it('lets the proposer neither decide nor publish the request, and the publication needs the second person first', async () => {
      const [from, to] = [await area(), await area()];
      const recorded = await record(STEWARD, succession(from, to));
      const submitted = await call('POST', `/master-change-requests/${idOf(recorded)}/submit`, { member: STEWARD, ifMatch: `"${versionOf(recorded)}"` });
      const self = await call('POST', `/master-change-requests/${idOf(recorded)}/decision`, { member: STEWARD, ifMatch: `"${versionOf(submitted)}"`, body: { decision: 'approve', reason: 'Approving my own request' } });
      expect(self.status).toBe(403);
      const record1 = (await rows<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [from.recordId]))[0];
      const early = await call('POST', `/master-records/${from.recordId}/publish`, { member: PUBLISHER, ifMatch: `"${record1?.version}"`, body: { decision_document_id: DECISION_DOCUMENT } });
      expect([early.status, early.json.code]).toEqual([409, 'CHANGE_NOT_APPROVED']);
      expect((await call('POST', `/master-change-requests/${idOf(recorded)}/decision`, { member: CHECKER, ifMatch: `"${versionOf(submitted)}"`, body: { decision: 'approve', reason: 'Checked against the decision' } })).status).toBe(200);
      const own = await call('POST', `/master-records/${from.recordId}/publish`, { member: STEWARD, ifMatch: `"${record1?.version}"`, body: { decision_document_id: DECISION_DOCUMENT } });
      expect(own.status).toBe(403);
      expect((await call('POST', `/master-records/${from.recordId}/publish`, { member: PUBLISHER, ifMatch: `"${record1?.version}"`, body: { decision_document_id: DECISION_DOCUMENT } })).status).toBe(200);
      const edges = await rows<{ succession_kind: string; created_by: string }>('select succession_kind, created_by from machvon.master_succession where predecessor_record_id = $1', [from.recordId]);
      expect(edges).toEqual([{ succession_kind: 'MERGE', created_by: memberId(STEWARD) }]);
    });
  });
});
