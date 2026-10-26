import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { AudEngagementStore, engagementScope } from '../src/aud-engagement-store';
import type { EngagementRow, NewEngagement, ScopeTarget } from '../src/aud-engagement-store';
import { assertNotOnHold } from '../src/purge-guard';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new AudEngagementStore();

const COORDINATOR = 1;
const OTHER = 2;
const SUSPENDED = 3;
const FAMILY = 0x91;
const PROJECT = id(FAMILY, 1);
const PROJECT_ELSEWHERE = id(FAMILY, 2);
const CONTRACT = id(FAMILY, 3);
const FOREIGN_PROJECT = id(FAMILY, 4);
const DECISION = id(FAMILY, 10);
const DECISION_PENDING = id(FAMILY, 11);
const DECISION_ATTACHMENT = id(FAMILY, 12);
const DECISION_TO_RECALL = id(FAMILY, 13);
const DOSSIER = id(FAMILY, 20);
const DOSSIER_ELSEWHERE = id(FAMILY, 21);
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const WORKER = '00000000-0000-4000-8000-000000000000';
const TODAY = '2026-10-26';

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = COORDINATOR): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const grantOf = (permissions: readonly string[], scope: Scope): EffectiveAccess => ({
  membershipId: memberId(COORDINATOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'AUD', rank: 30, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const NOW = new Date('2026-10-26T03:00:00Z');
const everything = engagementScope(grantOf(['aud.read'], { kind: 'TENANT' }), 'aud.read', NOW);
const nothing = engagementScope(grantOf(['aud.read'], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] }), 'aud.read', NOW);
const branch = (unit: number, path: string) => engagementScope(grantOf(['aud.read'], { kind: 'UNIT_SUBTREE', refIds: [unitId(unit)], paths: [path] }), 'aud.read', NOW);

let counter = 0;
const request = (extra: Partial<NewEngagement> = {}): NewEngagement => {
  counter += 1;
  return {
    engagementCode: `TT-2026-${String(counter).padStart(3, '0')}`,
    engagementType: 'STATE_AUDIT',
    authorityKind: 'STATE_AUDIT_OFFICE',
    authorityName: 'State Audit Office, region 2',
    decisionDocumentId: DECISION,
    title: 'Audit of the investment in the bridge',
    periodFrom: '2025-01-01',
    periodTo: '2025-12-31',
    coordinatorId: memberId(COORDINATOR),
    scope: [
      { kind: 'PROJECT', id: PROJECT },
      { kind: 'CONTRACT', id: CONTRACT },
    ],
    ...extra,
  };
};

async function resolve(scope: readonly ScopeTarget[], tenant = TENANT_A) {
  return as((tx) => store.resolveTargets(tx, scope), tenant);
}

async function open(extra: Partial<NewEngagement> = {}): Promise<{ id: string; version: number }> {
  const data = request(extra);
  const targets = await resolve(data.scope);
  return as((tx) => store.create(tx, data, targets, memberId(COORDINATOR)));
}

/** The row of an engagement as a command locks it, from the point of view of the coordinator over the whole tenant. */
const lockIn = (tx: TenantTx, engagementId: string, version: number): Promise<EngagementRow> => store.lock(tx, engagementId, everything, everything, version);
const lock = (engagementId: string, version: number): Promise<EngagementRow> => as((tx) => store.lock(tx, engagementId, everything, everything, version));

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (projects, contracts, documents, dossiers) are seeded with the foreign keys they have to other modules switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

describe('AudEngagementStore (audit and inspection engagements, ST-AUD-001)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
        { n: ELSEWHERE, path: '/u3/' },
      ]);
    }
    for (const n of [COORDINATOR, OTHER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_A, SUSPENDED, ROOT, { status: 'Suspended' });
    await harness.seedMembership(TENANT_B, COORDINATOR, ROOT);
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-A-001', 'Bridge', $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $3, 'PRJ-A-002', 'Road', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, PROJECT_ELSEWHERE, unitId(DEPARTMENT), unitId(ELSEWHERE), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-B-001', 'Foreign bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_B, FOREIGN_PROJECT, unitId(DEPARTMENT), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version)
         values ($1, $2, $3, $4, $4, 'HD-A-001', 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
        [TENANT_A, CONTRACT, PROJECT, id(FAMILY, 31)],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/QD-KTNN', '2026-01-15', 'EFFECTIVE', 'INTERNAL', $5, $5),
                ($1, $3, 'REFERENCE', 'QD', 'A decision not yet in force', null, null, 'PENDING', 'INTERNAL', $5, $5),
                ($1, $4, 'ATTACHMENT', 'QD', 'An attachment, not a decision', null, null, 'EFFECTIVE', 'INTERNAL', $5, $5),
                ($1, $6, 'REFERENCE', 'QD', 'A decision that is withdrawn later', '14/QD-KTNN', '2026-01-17', 'EFFECTIVE', 'INTERNAL', $5, $5)`,
        [TENANT_A, DECISION, DECISION_PENDING, DECISION_ATTACHMENT, memberId(COORDINATOR), DECISION_TO_RECALL],
      ],
      [
        `insert into machvon.dossier (tenant_id, id, dossier_code, year, title, organization_unit_id, subject_module, subject_id, category_code, status, created_by, updated_by)
         values ($1, $2, 'HS-2026-01', 2026, 'Dossier of the bridge', $4, 'PRJ', $5, 'PROJECT', 'OPEN', $7, $7), ($1, $3, 'HS-2026-02', 2026, 'Dossier of the road', $6, 'PRJ', $8, 'PROJECT', 'OPEN', $7, $7)`,
        [TENANT_A, DOSSIER, DOSSIER_ELSEWHERE, unitId(DEPARTMENT), PROJECT, unitId(ELSEWHERE), memberId(COORDINATOR), PROJECT_ELSEWHERE],
      ],
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('registering', () => {
    it('stores the engagement PLANNED with its scope items, the decision and the coordinator, CONFIDENTIAL, at version 1', async () => {
      const created = await open();
      expect(created.version).toBe(1);
      const detail = await as((tx) => store.find(tx, created.id, everything));
      expect(detail).toMatchObject({
        status: 'PLANNED',
        engagementType: 'STATE_AUDIT',
        periodFrom: '2025-01-01',
        periodTo: '2025-12-31',
        coordinatorId: memberId(COORDINATOR),
        coordinatorName: 'User 1',
        legalHoldId: null,
        holdStatus: null,
        scopeCount: 2,
        classification: 'CONFIDENTIAL',
        startedOn: null,
        decision: { documentId: DECISION, title: 'Decision to audit the bridge', symbol: '12/QD-KTNN', issuedOn: '2026-01-15', effectStatus: 'EFFECTIVE' },
      });
      expect(detail?.scope).toEqual([
        { kind: 'CONTRACT', id: CONTRACT, code: 'HD-A-001', name: 'HD-A-001' },
        { kind: 'PROJECT', id: PROJECT, code: 'PRJ-A-001', name: 'Bridge' },
      ]);
    });

    it('refuses a code used before (409 ENGAGEMENT_CODE_DUPLICATE) and keeps the transaction usable', async () => {
      const first = request();
      const targets = await resolve(first.scope);
      await as((tx) => store.create(tx, first, targets, memberId(COORDINATOR)));
      const again = await refusal(as((tx) => store.create(tx, { ...first, title: 'Another title' }, targets, memberId(COORDINATOR))));
      expect(again).toMatchObject({ code: 'ENGAGEMENT_CODE_DUPLICATE', status: 409 });
    });

    it('refuses a decision that is not a received or reference document in force (not a pending one, an attachment or a missing one), with one answer for all of them (422 DECISION_DOCUMENT_NOT_EFFECTIVE)', async () => {
      for (const decisionDocumentId of [DECISION_PENDING, DECISION_ATTACHMENT, randomUUID()]) {
        const data = request({ decisionDocumentId });
        const targets = await resolve(data.scope);
        expect(await refusal(as((tx) => store.create(tx, data, targets, memberId(COORDINATOR))))).toMatchObject({ code: 'DECISION_DOCUMENT_NOT_EFFECTIVE', status: 422 });
      }
      expect((await owner<{ n: string }>('select count(*) as n from machvon.audit_engagement where engagement_code = $1', ['NEVER']))[0]?.n).toBe('0');
    });

    it('does not find a scope target that is not in the tenant (404), the project of another tenant included, and refuses a coordinator who is not an active member', async () => {
      for (const target of [{ kind: 'PROJECT', id: FOREIGN_PROJECT }, { kind: 'UNIT', id: randomUUID() }, { kind: 'CONTRACT', id: randomUUID() }] as const) {
        expect(await refusal(resolve([target]))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      }
      const data = request({ coordinatorId: memberId(SUSPENDED) });
      const targets = await resolve(data.scope);
      expect(await refusal(as((tx) => store.create(tx, data, targets, memberId(COORDINATOR))))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'coordinator_user_id' });
      const reversed = request({ periodFrom: '2025-12-31', periodTo: '2025-01-01' });
      expect(await refusal(as((tx) => store.create(tx, reversed, targets, memberId(COORDINATOR))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_to' });
    });

    it('keeps each scope item once, in any case of its id, and the database refuses a duplicate item', async () => {
      const created = await open({ scope: [{ kind: 'PROJECT', id: PROJECT }, { kind: 'PROJECT', id: PROJECT.toUpperCase() }, { kind: 'UNIT', id: unitId(DEPARTMENT) }] });
      expect((await as((tx) => store.find(tx, created.id, everything)))?.scopeCount).toBe(2);
      await expect(
        owner(
          `insert into machvon.audit_scope_item (tenant_id, id, engagement_id, scope_kind, project_id, added_by) values ($1, gen_random_uuid(), $2::uuid, 'PROJECT', $3::uuid, $4::uuid)`,
          [TENANT_A, created.id, PROJECT, memberId(COORDINATOR)],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('who sees an engagement (404 outside the scope)', () => {
    it('shows an engagement to a grant whose scope meets a scope item, by the owner unit of the project, by a grant that names the project or the contract, and to nobody else', async () => {
      const created = await open();
      const sees = async (scope: ReturnType<typeof branch>): Promise<boolean> => (await as((tx) => store.find(tx, created.id, scope))) !== undefined;
      expect(await sees(everything)).toBe(true);
      expect(await sees(branch(DEPARTMENT, '/u1/u2/'))).toBe(true);
      expect(await sees(branch(ROOT, '/u1/'))).toBe(true);
      expect(await sees(branch(ELSEWHERE, '/u3/'))).toBe(false);
      expect(await sees(nothing)).toBe(false);
      expect(await sees(engagementScope(grantOf(['aud.read'], { kind: 'PROJECT', refIds: [PROJECT] }), 'aud.read', NOW))).toBe(true);
      expect(await sees(engagementScope(grantOf(['aud.read'], { kind: 'PROJECT', refIds: [PROJECT_ELSEWHERE] }), 'aud.read', NOW))).toBe(false);
      expect(await sees(engagementScope(grantOf(['aud.read'], { kind: 'CONTRACT', refIds: [CONTRACT] }), 'aud.read', NOW))).toBe(true);
      expect(await sees(engagementScope(grantOf(['other.permission'], { kind: 'TENANT' }), 'aud.read', NOW))).toBe(false);
      // The same engagement is not there for another tenant, whatever its grants.
      expect(await as((tx) => store.find(tx, created.id, everything), TENANT_B)).toBeUndefined();
    });

    it('lists only the engagements in the scope, by code, in pages, and filters by status, type and project', async () => {
      const inDepartment = await open({ engagementType: 'SUPERVISORY_CHECK', authorityKind: 'INTERNAL', scope: [{ kind: 'UNIT', id: unitId(DEPARTMENT) }] });
      const elsewhere = await open({ scope: [{ kind: 'PROJECT', id: PROJECT_ELSEWHERE }] });
      const codes = async (scope: ReturnType<typeof branch>, extra: Record<string, unknown> = {}): Promise<string[]> =>
        (await as((tx) => store.list(tx, scope, { limit: 200, after: undefined, ...extra }))).map((line) => line.engagementCode);
      const all = await codes(everything);
      expect(all).toEqual([...all].sort());
      const departmentOnly = await codes(branch(DEPARTMENT, '/u1/u2/'));
      const elsewhereCode = (await as((tx) => store.find(tx, elsewhere.id, everything)))?.engagementCode as string;
      const departmentCode = (await as((tx) => store.find(tx, inDepartment.id, everything)))?.engagementCode as string;
      expect(departmentOnly).toContain(departmentCode);
      expect(departmentOnly).not.toContain(elsewhereCode);
      expect(await codes(nothing)).toEqual([]);
      expect(await codes(everything, { type: 'SUPERVISORY_CHECK' })).toEqual([departmentCode]);
      expect(await codes(everything, { projectId: PROJECT_ELSEWHERE })).toEqual([elsewhereCode]);
      expect((await codes(everything, { projectId: PROJECT })).length).toBeGreaterThan(0);
      expect(await codes(everything, { status: 'CLOSED' })).toEqual([]);
      const firstPage = await as((tx) => store.list(tx, everything, { limit: 2, after: undefined }));
      const last = firstPage[firstPage.length - 1] as { engagementCode: string; id: string };
      const secondPage = await as((tx) => store.list(tx, everything, { limit: 2, after: { code: last.engagementCode, id: last.id } }));
      expect(secondPage.every((line) => line.engagementCode > last.engagementCode)).toBe(true);
    });

    it('answers 404 to a command on an engagement out of sight, 403 to one that is seen but not for acting, and 409 to a stale version', async () => {
      const created = await open();
      expect(await refusal(as((tx) => store.lock(tx, created.id, nothing, everything, 1)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.lock(tx, randomUUID(), everything, everything, 1)))).toMatchObject({ status: 404 });
      expect(await refusal(as((tx) => store.lock(tx, created.id, everything, nothing, 1)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => store.lock(tx, created.id, everything, everything, 7)))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((await lock(created.id, 1)).status).toBe('PLANNED');
    });
  });

  describe('starting, with the legal hold (BR-AUD-10)', () => {
    it('AC-ST-AUD-001-1: starts the engagement ONGOING and places an Active INSPECTION hold on the scope that blocks the dossiers and records in it', async () => {
      const created = await open({ engagementType: 'SPECIALIZED_INSPECTION', authorityKind: 'PROVINCIAL_INSPECTORATE' });
      const started = await as((tx) => lockIn(tx, created.id, 1).then((row) => store.start(tx, row, { startedOn: '2026-10-20', placeLegalHold: true, today: TODAY }, memberId(COORDINATOR))));
      expect(started.version).toBe(2);
      expect(started.legalHoldId).not.toBeNull();
      const detail = await as((tx) => store.find(tx, created.id, everything));
      expect(detail).toMatchObject({ status: 'ONGOING', startedOn: '2026-10-20', legalHoldId: started.legalHoldId, holdStatus: 'Active', version: 2 });
      const [hold] = await owner<{ hold_kind: string; status: string; resource_scope: { kind: string; ids: string[] }; placed_by: string }>('select hold_kind, status, resource_scope, placed_by from machvon.legal_hold where id = $1', [started.legalHoldId]);
      expect(hold).toMatchObject({ hold_kind: 'INSPECTION', status: 'Active', placed_by: memberId(COORDINATOR) });
      expect(hold?.resource_scope.kind).toBe('RESOURCE');
      expect([...(hold?.resource_scope.ids ?? [])].sort()).toEqual([CONTRACT, PROJECT].sort());
      // What the scope contains cannot be disposed of: the project, its contract, and the dossier about the project; a dossier about another project is not held.
      for (const resource of [{ type: 'project', id: PROJECT }, { type: 'contract', id: CONTRACT }, { type: 'dossier', id: DOSSIER }]) {
        expect(await refusal(as((tx) => assertNotOnHold(tx, resource)))).toMatchObject({ code: 'LEGAL_HOLD_ACTIVE', status: 409 });
      }
      await as((tx) => assertNotOnHold(tx, { type: 'dossier', id: DOSSIER_ELSEWHERE }));
      await as((tx) => assertNotOnHold(tx, { type: 'project', id: PROJECT_ELSEWHERE }));
      // Release it so that the later cases of this file are not held by it.
      await as((tx) => store.releaseHold(tx, started.legalHoldId as string, WORKER, 'The test is over for this engagement.'));
    });

    it('holds as an AUDIT for an audit, and by the kind of the scope when it has one kind only (units hold the dossiers under them)', async () => {
      const created = await open({ scope: [{ kind: 'UNIT', id: unitId(DEPARTMENT) }] });
      const started = await as((tx) => lockIn(tx, created.id, 1).then((row) => store.start(tx, row, { startedOn: '2026-10-20', placeLegalHold: true, today: TODAY }, memberId(COORDINATOR))));
      const [hold] = await owner<{ hold_kind: string; resource_scope: { kind: string; ids: string[] } }>('select hold_kind, resource_scope from machvon.legal_hold where id = $1', [started.legalHoldId]);
      expect(hold).toMatchObject({ hold_kind: 'AUDIT', resource_scope: { kind: 'UNIT', ids: [unitId(DEPARTMENT)] } });
      expect(await refusal(as((tx) => assertNotOnHold(tx, { type: 'dossier', id: DOSSIER })))).toMatchObject({ code: 'LEGAL_HOLD_ACTIVE' });
      expect(await refusal(as((tx) => assertNotOnHold(tx, { type: 'project', id: PROJECT })))).toMatchObject({ code: 'LEGAL_HOLD_ACTIVE' });
      await as((tx) => assertNotOnHold(tx, { type: 'dossier', id: DOSSIER_ELSEWHERE }));
      await as((tx) => store.releaseHold(tx, started.legalHoldId as string, WORKER, 'The test is over for this engagement.'));
    });

    it('starts without a hold when none is asked for, refuses a start in the future, and starts once', async () => {
      const created = await open();
      expect(await refusal(as((tx) => lockIn(tx, created.id, 1).then((row) => store.start(tx, row, { startedOn: '2026-10-27', placeLegalHold: false, today: TODAY }, memberId(COORDINATOR)))))).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'started_on',
      });
      const started = await as((tx) => lockIn(tx, created.id, 1).then((row) => store.start(tx, row, { startedOn: '2026-10-20', placeLegalHold: false, today: TODAY }, memberId(COORDINATOR))));
      expect(started.legalHoldId).toBeNull();
      expect((await as((tx) => store.find(tx, created.id, everything)))?.holdStatus).toBeNull();
      expect(await refusal(as((tx) => lockIn(tx, created.id, 2).then((row) => store.start(tx, row, { startedOn: '2026-10-20', placeLegalHold: false, today: TODAY }, memberId(COORDINATOR)))))).toMatchObject({
        code: 'ENGAGEMENT_STATE_INVALID',
        status: 409,
      });
    });

    it('refuses to start on a decision that was recalled after the engagement was registered (422 DECISION_DOCUMENT_NOT_EFFECTIVE)', async () => {
      const created = await open({ decisionDocumentId: DECISION_TO_RECALL });
      await owner("update machvon.document set effect_status = 'RECALLED' where id = $1", [DECISION_TO_RECALL]);
      expect(await refusal(as((tx) => lockIn(tx, created.id, 1).then((row) => store.start(tx, row, { startedOn: '2026-10-20', placeLegalHold: true, today: TODAY }, memberId(COORDINATOR)))))).toMatchObject({
        code: 'DECISION_DOCUMENT_NOT_EFFECTIVE',
        status: 422,
      });
      expect((await owner<{ n: string }>("select count(*) as n from machvon.legal_hold where reason like '%' || $1 || '%'", [(await as((tx) => store.find(tx, created.id, everything)))?.engagementCode]))[0]?.n).toBe('0');
    });
  });

  describe('ending the fieldwork and cancelling', () => {
    async function started(placeLegalHold = true): Promise<{ id: string; legalHoldId: string | null }> {
      const created = await open();
      const done = await as((tx) => lockIn(tx, created.id, 1).then((row) => store.start(tx, row, { startedOn: '2026-10-20', placeLegalHold, today: TODAY }, memberId(COORDINATOR))));
      return { id: created.id, legalHoldId: done.legalHoldId };
    }

    it('ends the fieldwork on a day between the start and today, once, and only from ONGOING', async () => {
      const engagement = await started(false);
      for (const onDate of ['2026-10-19', '2026-10-27']) {
        expect(await refusal(as((tx) => lockIn(tx, engagement.id, 2).then((row) => store.endFieldwork(tx, row, { onDate, today: TODAY }, memberId(COORDINATOR)))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'on_date' });
      }
      const ended = await as((tx) => lockIn(tx, engagement.id, 2).then((row) => store.endFieldwork(tx, row, { onDate: '2026-10-25', today: TODAY }, memberId(COORDINATOR))));
      expect(ended.version).toBe(3);
      expect(await as((tx) => store.find(tx, engagement.id, everything))).toMatchObject({ status: 'AWAITING_CONCLUSION', fieldworkEndedOn: '2026-10-25' });
      expect(await refusal(as((tx) => lockIn(tx, engagement.id, 3).then((row) => store.endFieldwork(tx, row, { onDate: '2026-10-25', today: TODAY }, memberId(COORDINATOR)))))).toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID' });
    });

    it('AC-ST-AUD-001-3: cancels with a reason, releases the hold in the same transaction, and a start after the cancellation is 409', async () => {
      const engagement = await started(true);
      expect(await refusal(as((tx) => lockIn(tx, engagement.id, 2).then((row) => store.cancel(tx, row, { reason: 'short', releasedBy: WORKER }, memberId(COORDINATOR)))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const cancelled = await as((tx) => lockIn(tx, engagement.id, 2).then((row) => store.cancel(tx, row, { reason: 'The decision was withdrawn by the authority.', releasedBy: WORKER }, memberId(COORDINATOR))));
      expect(cancelled).toEqual({ version: 3, holdReleased: true });
      expect(await as((tx) => store.find(tx, engagement.id, everything))).toMatchObject({ status: 'CANCELLED', holdStatus: 'Released', cancelReason: 'The decision was withdrawn by the authority.' });
      const [hold] = await owner<{ status: string; released_by: string; release_reason: string }>('select status, released_by, release_reason from machvon.legal_hold where id = $1', [engagement.legalHoldId]);
      expect(hold).toMatchObject({ status: 'Released', released_by: WORKER });
      // What was held can be disposed of again.
      await as((tx) => assertNotOnHold(tx, { type: 'project', id: PROJECT }));
      expect(await refusal(as((tx) => lockIn(tx, engagement.id, 3).then((row) => store.start(tx, row, { startedOn: '2026-10-21', placeLegalHold: true, today: TODAY }, memberId(COORDINATOR)))))).toMatchObject({
        code: 'ENGAGEMENT_STATE_INVALID',
        status: 409,
      });
      expect(await refusal(as((tx) => lockIn(tx, engagement.id, 3).then((row) => store.cancel(tx, row, { reason: 'Once more, for good measure.', releasedBy: WORKER }, memberId(COORDINATOR)))))).toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID' });
    });

    it('cancels a PLANNED engagement that has no hold, and leaves alone a hold that was released already', async () => {
      const planned = await open();
      expect(await as((tx) => lockIn(tx, planned.id, 1).then((row) => store.cancel(tx, row, { reason: 'Registered by mistake, withdrawn.', releasedBy: WORKER }, memberId(COORDINATOR))))).toEqual({ version: 2, holdReleased: false });
      const engagement = await started(true);
      await as((tx) => store.releaseHold(tx, engagement.legalHoldId as string, WORKER, 'Released by the legal office first.'));
      expect(await as((tx) => lockIn(tx, engagement.id, 2).then((row) => store.cancel(tx, row, { reason: 'The decision was withdrawn by the authority.', releasedBy: WORKER }, memberId(COORDINATOR))))).toMatchObject({ holdReleased: false });
    });

    it('does not cancel an engagement that has a conclusion (409 CONCLUSION_EXISTS)', async () => {
      const engagement = await started(false);
      await seedReplica([
        [
          `insert into machvon.audit_conclusion (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, implementation_due_on, report_due_on, summary, total_financial_vnd, status, created_by, updated_by)
           values ($1, $2, $3, 'INSPECTION_CONCLUSION', $4, 1, '2026-10-24', '2026-10-25', '2027-01-25', '2027-02-25', 'A conclusion received before the cancellation', 0, 'RECEIVED', $5, $5)`,
          [TENANT_A, randomUUID(), engagement.id, DECISION, memberId(COORDINATOR)],
        ],
      ]);
      expect(await refusal(as((tx) => lockIn(tx, engagement.id, 2).then((row) => store.cancel(tx, row, { reason: 'The decision was withdrawn by the authority.', releasedBy: WORKER }, memberId(COORDINATOR)))))).toMatchObject({
        code: 'CONCLUSION_EXISTS',
        status: 409,
      });
    });

    it('keeps the dates of the engagement in step with its state in the database (a started engagement has a start day, the fieldwork does not end before it starts)', async () => {
      const created = await open();
      await expect(owner("update machvon.audit_engagement set status = 'ONGOING' where id = $1", [created.id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.audit_engagement set status = 'ONGOING', started_on = date '2026-10-20', fieldwork_ended_on = date '2026-10-01' where id = $1", [created.id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.audit_engagement set status = 'CANCELLED', cancel_reason = 'short' where id = $1", [created.id])).rejects.toMatchObject({ code: '23514' });
    });
  });
});
