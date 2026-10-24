import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjAccountabilityStore, assignmentEndedRecord, assignmentMadeRecord } from '../src/prj-accountability-store';
import type { AssignmentChange } from '../src/prj-accountability-store';
import { PrjProjectStore, projectScope } from '../src/prj-project-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const store = new PrjAccountabilityStore();
const TODAY = vietnamDateOf(new Date());
const YESTERDAY = vietnamDateOf(new Date(Date.now() - 86_400_000));
const TOMORROW = vietnamDateOf(new Date(Date.now() + 86_400_000));
const LAST_YEAR = '2025-03-01';
const WORKER = '00000000-0000-4000-8000-000000000000';

const ACTOR = 1;
const SUBTREE_READER = 2;
const TENANT_READER = 3;
const NO_GRANT = 4;
const ELSEWHERE_READER = 5;
const SUSPENDED = 6;
const SERVICE_ACCOUNT = 7;
const PROJECT_READER = 8;
const LAPSED_GRANT = 9;
const INVESTOR_READER = 10;
const B_MEMBER = 11;
const ROOT = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = ACTOR): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
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

const sqlState = async (work: Promise<unknown>): Promise<{ code: string; constraint?: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    return { code: e.code ?? '', ...(e.constraint === undefined ? {} : { constraint: e.constraint }) };
  }
  throw new Error('expected the database to refuse');
};

const grantOf = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(ACTOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const subtree = (permission: string, unit: number, path: string): ScopeBuilder => projectScope(grantOf(permission, { kind: 'UNIT_SUBTREE', refIds: [unitId(unit)], paths: [path] }), permission, new Date());

let counter = 0;
let areaVersion = '';
let areaVersionB = '';

async function seedArea(tenant: string): Promise<string> {
  const recordId = randomUUID();
  const versionId = randomUUID();
  await harness.owner(tenant, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', $3, 'EFFECTIVE', $4, $4)`, [tenant, recordId, `AREA-${tenant.slice(-1)}`, memberId(ACTOR)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', $3, 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $4, now(), $5, $5)`,
      [tenant, versionId, `AREA-${tenant.slice(-1)}`, recordId, memberId(ACTOR)],
    ],
  ]);
  return versionId;
}

async function project(options: { unit?: number; investor?: number; tenant?: string } = {}): Promise<{ id: string; code: string }> {
  counter += 1;
  const tenant = options.tenant ?? TENANT_A;
  const code = `AC-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as(
    (tx) =>
      projects.create(
        tx,
        {
          code,
          name: `Project ${code}`,
          ownerUnitId: unitId(options.unit ?? DEPARTMENT),
          ...(options.investor === undefined ? {} : { investorUnitId: unitId(options.investor) }),
          areaMasterVersionId: tenant === TENANT_A ? areaVersion : areaVersionB,
          totalInvestmentVnd: '500000000000',
        },
        memberId(ACTOR),
        TODAY,
      ),
    tenant,
  );
  return { id: created.id, code };
}

async function document(status = 'EFFECTIVE', tenant = TENANT_A): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'An assignment decision', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
    [tenant, id, `QD-${id.slice(0, 8)}/2026`, status, memberId(ACTOR)],
    tenant,
  );
  return id;
}

interface AssignInput {
  project: { id: string };
  leader?: number;
  role?: string;
  validFrom?: string;
  document?: string;
  scopes?: { act: ScopeBuilder; read: ScopeBuilder };
}

const assign = (input: AssignInput, tenant = TENANT_A): Promise<AssignmentChange> =>
  as(
    (tx) =>
      store.assign(tx, {
        projectId: input.project.id,
        leaderMembershipId: memberId(input.leader ?? SUBTREE_READER),
        role: input.role ?? 'LEADER_IN_CHARGE',
        validFrom: input.validFrom ?? LAST_YEAR,
        ...(input.document === undefined ? {} : { assignmentDocumentId: input.document }),
        actor: memberId(ACTOR),
        scopes: input.scopes ?? { act: everything, read: everything },
        today: TODAY,
        now: new Date(),
      }),
    tenant,
  );

const end = (assignmentId: string, version: number, extra: { validUntil?: string; reason?: string; scopes?: { act: ScopeBuilder; read: ScopeBuilder } } = {}): Promise<AssignmentChange> =>
  as((tx) =>
    store.end(tx, {
      assignmentId,
      expectedVersion: version,
      validUntil: extra.validUntil ?? TODAY,
      endReason: extra.reason ?? 'Reassigned to another leader',
      actor: memberId(ACTOR),
      scopes: extra.scopes ?? { act: everything, read: everything },
      today: TODAY,
    }),
  );

const assignments = (projectId: string) =>
  owner<Record<string, unknown>>(
    'select leader_membership_id, accountability_role, assignment_document_id, valid_from::text as valid_from, valid_until::text as valid_until, status, end_reason, version::text as version from machvon.project_accountability where project_id = $1::uuid order by valid_from, created_at',
    [projectId],
  );

jest.setTimeout(120_000);

describe('PrjAccountabilityStore (leader in charge, ST-PRJ-005)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, ACTOR, ROOT);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    for (const member of [SUBTREE_READER, TENANT_READER, NO_GRANT, ELSEWHERE_READER, SERVICE_ACCOUNT, PROJECT_READER, LAPSED_GRANT, INVESTOR_READER]) await harness.seedMembership(TENANT_A, member, ROOT);
    await harness.seedMembership(TENANT_A, SUSPENDED, ROOT, { status: 'Suspended' });
    await harness.seedMembership(TENANT_B, B_MEMBER, ROOT);
    await owner("update machvon.membership set membership_type = 'SERVICE_ACCOUNT' where id = $1::uuid", [memberId(SERVICE_ACCOUNT)]);
    await harness.seedRole(TENANT_A, 1, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'PROJECT_READER', ['project.read'], 20);
    areaVersion = await seedArea(TENANT_A);
    areaVersionB = await seedArea(TENANT_B);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('who may answer for a project', () => {
    it('assigns a leader who can read the project, with the document, and keeps the project as it was (AC-ST-PRJ-005-1)', async () => {
      await harness.seedGrants(TENANT_A, [
        { n: 1, member: SUBTREE_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
        { n: 2, member: TENANT_READER, role: 1, kind: 'TENANT' },
      ]);
      const target = await project();
      const before = (await owner<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [target.id]))[0];
      const decision = await document();
      const made = await assign({ project: target, document: decision });
      expect(made).toMatchObject({ projectId: target.id, projectCode: target.code, leaderMembershipId: memberId(SUBTREE_READER), role: 'LEADER_IN_CHARGE', validFrom: LAST_YEAR, validUntil: null, status: 'ACTIVE', assignmentDocumentId: decision, version: 1 });
      expect(await assignments(target.id)).toEqual([
        { leader_membership_id: memberId(SUBTREE_READER), accountability_role: 'LEADER_IN_CHARGE', assignment_document_id: decision, valid_from: LAST_YEAR, valid_until: null, status: 'ACTIVE', end_reason: null, version: '1' },
      ]);
      expect((await owner<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [target.id]))[0]).toEqual(before);
    });

    it('accepts a leader whose grant reaches the investor unit of the project, one on the whole tenant and one on the project itself', async () => {
      await harness.seedGrants(TENANT_A, [{ n: 3, member: INVESTOR_READER, role: 1, kind: 'UNIT_ONLY', refs: [unitId(OTHER_BRANCH)] }]);
      const invested = await project({ unit: DEPARTMENT, investor: OTHER_BRANCH });
      expect((await assign({ project: invested, leader: INVESTOR_READER })).status).toBe('ACTIVE');
      expect((await assign({ project: await project(), leader: TENANT_READER })).status).toBe('ACTIVE');
      const named = await project();
      await harness.seedGrants(TENANT_A, [{ n: 4, member: PROJECT_READER, role: 1, kind: 'PROJECT', refs: [named.id] }]);
      expect((await assign({ project: named, leader: PROJECT_READER })).status).toBe('ACTIVE');
    });

    it('refuses a person who cannot read the project, is not in force, is not on the staff or holds a lapsed grant with 422 LEADER_NOT_ELIGIBLE', async () => {
      await harness.seedGrants(TENANT_A, [
        { n: 5, member: ELSEWHERE_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
        { n: 6, member: SUSPENDED, role: 1, kind: 'TENANT' },
        { n: 7, member: SERVICE_ACCOUNT, role: 1, kind: 'TENANT' },
        { n: 8, member: LAPSED_GRANT, role: 1, kind: 'TENANT', from: '2020-01-01T00:00:00Z', until: '2021-01-01T00:00:00Z' },
      ]);
      const target = await project();
      for (const leader of [NO_GRANT, ELSEWHERE_READER, SUSPENDED, SERVICE_ACCOUNT, LAPSED_GRANT]) {
        expect(await refusal(assign({ project: target, leader }))).toEqual({ code: 'LEADER_NOT_ELIGIBLE', status: 422, detail: 'leader_membership_id' });
      }
      expect(await assignments(target.id)).toEqual([]);
    });

    it('does not know a member of another tenant, nor a project of another tenant (404)', async () => {
      const target = await project();
      const foreign = await project({ tenant: TENANT_B });
      expect(await refusal(assign({ project: target, leader: B_MEMBER }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(assign({ project: foreign }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(assign({ project: { id: randomUUID() } }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await assignments(target.id)).toEqual([]);
    });

    it('answers 403 SCOPE_DENIED for a project the caller reads but may not act on, and 404 for one out of sight', async () => {
      const target = await project({ unit: OTHER_BRANCH });
      const act = subtree('project.accountability.assign', DEPARTMENT, '/u1/u2/');
      const read = subtree('project.read', OTHER_BRANCH, '/u3/');
      expect(await refusal(assign({ project: target, scopes: { act, read } }))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(assign({ project: target, scopes: { act: nothing, read: nothing } }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('checks the role, the day, the leader and the document before it writes', async () => {
      const target = await project();
      expect(await refusal(assign({ project: target, role: 'CHIEF' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'accountability_role' });
      expect(await refusal(assign({ project: target, validFrom: '2026-02-30' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_from' });
      expect(await refusal(assign({ project: target, validFrom: TOMORROW }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_from' });
      expect(await refusal(as((tx) => store.assign(tx, { projectId: target.id, leaderMembershipId: 'not-an-id', role: 'LEADER_IN_CHARGE', validFrom: LAST_YEAR, actor: memberId(ACTOR), scopes: { act: everything, read: everything }, today: TODAY, now: new Date() })))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'leader_membership_id',
      });
      expect(await refusal(assign({ project: target, document: await document('REPLACED') }))).toEqual({ code: 'DECISION_REQUIRED', status: 422, detail: 'assignment_document_id' });
      expect(await refusal(assign({ project: target, document: await document('EFFECTIVE', TENANT_B) }))).toEqual({ code: 'DECISION_REQUIRED', status: 422, detail: 'assignment_document_id' });
      expect(await assignments(target.id)).toEqual([]);
    });
  });

  describe('one leader in charge (AC-ST-PRJ-005-1)', () => {
    it('refuses a second leader in charge while the first is active with 409 LEADER_ALREADY_ASSIGNED, and accepts it once the first has ended (AC-ST-PRJ-005-1)', async () => {
      const target = await project();
      const first = await assign({ project: target });
      expect(await refusal(assign({ project: target, leader: TENANT_READER, validFrom: YESTERDAY }))).toEqual({ code: 'LEADER_ALREADY_ASSIGNED', status: 409, detail: 'accountability_role' });
      expect(await assignments(target.id)).toHaveLength(1);
      await end(first.id, first.version, { validUntil: YESTERDAY });
      const second = await assign({ project: target, leader: TENANT_READER, validFrom: TODAY });
      expect(second.status).toBe('ACTIVE');
      expect((await assignments(target.id)).map((row) => [row.leader_membership_id, row.status, row.valid_from, row.valid_until])).toEqual([
        [memberId(SUBTREE_READER), 'ENDED', LAST_YEAR, YESTERDAY],
        [memberId(TENANT_READER), 'ACTIVE', TODAY, null],
      ]);
    });

    it('lets two requests race for the leader in charge: one wins, the other is told 409, and exactly one row is active', async () => {
      const target = await project();
      const outcomes = await Promise.allSettled([assign({ project: target, leader: SUBTREE_READER }), assign({ project: target, leader: TENANT_READER })]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const lost = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect((lost?.reason as { code?: string; status?: number }).code).toBe('LEADER_ALREADY_ASSIGNED');
      expect((lost?.reason as { status?: number }).status).toBe(409);
      expect((await assignments(target.id)).filter((row) => row.status === 'ACTIVE')).toHaveLength(1);
    });

    it('tells the loser of a race that slipped past the check 409 LEADER_ALREADY_ASSIGNED, and any other fault of the write as it is', async () => {
      const target = await project();
      await assign({ project: target });
      // A writer that does not take the lock of the project (a consumer, a later feature) commits between the check and the write: the rules of the database decide.
      const check = jest.spyOn(store as unknown as { assertFree: () => Promise<void> }, 'assertFree').mockResolvedValueOnce(undefined);
      expect(await refusal(assign({ project: target, leader: TENANT_READER, validFrom: YESTERDAY }))).toEqual({ code: 'LEADER_ALREADY_ASSIGNED', status: 409, detail: 'accountability_role' });
      check.mockRestore();
      const failing = (error: object) => (tx: TenantTx): TenantTx => ({
        ...tx,
        query: ((sql: string, params?: unknown[]) => (sql.includes('insert into machvon.project_accountability') ? Promise.reject(Object.assign(new Error('write failed'), error)) : tx.query(sql, params))) as TenantTx['query'],
      });
      const other = await project();
      const attempt = (error: object) =>
        as((tx) => store.assign(failing(error)(tx), { projectId: other.id, leaderMembershipId: memberId(TENANT_READER), role: 'LEADER_IN_CHARGE', validFrom: LAST_YEAR, actor: memberId(ACTOR), scopes: { act: everything, read: everything }, today: TODAY, now: new Date() }));
      await expect(attempt({ code: '23514' })).rejects.toMatchObject({ code: '23514' });
      await expect(attempt({ code: '23505', constraint: 'some_other_uq' })).rejects.toMatchObject({ code: '23505', constraint: 'some_other_uq' });
      expect(await assignments(other.id)).toEqual([]);
    });

    it('is enforced by the database itself: a second ACTIVE leader in charge written around the commands breaks the partial unique index', async () => {
      const target = await project();
      await assign({ project: target });
      const second = await sqlState(
        owner(
          `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
           values ($1, $2, $3, $4, 'LEADER_IN_CHARGE', '2024-01-01', 'ACTIVE', $5, $5)`,
          [TENANT_A, randomUUID(), target.id, memberId(TENANT_READER), memberId(ACTOR)],
        ),
      );
      expect(second).toEqual({ code: '23505', constraint: 'project_accountability_leader_uq' });
    });

    it('keeps the periods of one role from overlapping, for the other roles too, and lets different roles run together (BR-PRJ-10)', async () => {
      const target = await project();
      const deputy = await assign({ project: target, role: 'DEPUTY_LEADER', validFrom: '2025-01-01' });
      await assign({ project: target, role: 'FOCAL_OFFICER', leader: TENANT_READER, validFrom: '2025-01-01' });
      expect(await refusal(assign({ project: target, role: 'DEPUTY_LEADER', leader: TENANT_READER, validFrom: '2025-06-01' }))).toEqual({ code: 'LEADER_ALREADY_ASSIGNED', status: 409, detail: 'accountability_role' });
      await end(deputy.id, deputy.version, { validUntil: '2025-12-31' });
      // A period that starts inside a period that has ended is still an overlap; one that starts after it is not.
      expect(await refusal(assign({ project: target, role: 'DEPUTY_LEADER', leader: TENANT_READER, validFrom: '2025-12-31' }))).toEqual({ code: 'LEADER_ALREADY_ASSIGNED', status: 409, detail: 'accountability_role' });
      expect((await assign({ project: target, role: 'DEPUTY_LEADER', leader: TENANT_READER, validFrom: '2026-01-01' })).status).toBe('ACTIVE');
      const overlap = await sqlState(
        owner(
          `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, valid_until, status, end_reason, created_by, updated_by)
           values ($1, $2, $3, $4, 'DEPUTY_LEADER', '2025-03-01', '2025-04-01', 'ENDED', 'written around', $5, $5)`,
          [TENANT_A, randomUUID(), target.id, memberId(TENANT_READER), memberId(ACTOR)],
        ),
      );
      expect(overlap).toEqual({ code: '23P01', constraint: 'project_accountability_no_overlap' });
    });
  });

  describe('ending an assignment', () => {
    it('ends it with a day and a reason, under the version the caller saw, and bumps the version', async () => {
      const target = await project();
      const made = await assign({ project: target });
      const ended = await end(made.id, made.version, { validUntil: YESTERDAY, reason: '  Moved to the ministry  ' });
      expect(ended).toMatchObject({ id: made.id, status: 'ENDED', validUntil: YESTERDAY, endReason: 'Moved to the ministry', version: 2 });
      expect((await assignments(target.id))[0]).toMatchObject({ status: 'ENDED', valid_until: YESTERDAY, end_reason: 'Moved to the ministry', version: '2' });
    });

    it('refuses a stale version with 409 VERSION_CONFLICT carrying the current one, and an assignment that has ended with 409 STAGE_TRANSITION_DENIED', async () => {
      const target = await project();
      const made = await assign({ project: target });
      const stale = await refusal(end(made.id, 7));
      expect(stale).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const done = await end(made.id, made.version);
      expect(await refusal(end(made.id, done.version))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
    });

    it('refuses a day before the start or after today, a short reason and an unknown id', async () => {
      const target = await project();
      const made = await assign({ project: target, validFrom: '2025-05-05' });
      expect(await refusal(end(made.id, 1, { validUntil: '2025-05-04' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_until' });
      expect(await refusal(end(made.id, 1, { validUntil: TOMORROW }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_until' });
      expect(await refusal(end(made.id, 1, { validUntil: 'soon' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_until' });
      expect(await refusal(end(made.id, 1, { reason: 'no' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'end_reason' });
      expect(await refusal(end(randomUUID(), 1))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(end('nope', 1))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'id' });
      expect((await assignments(target.id))[0]).toMatchObject({ status: 'ACTIVE', valid_until: null });
    });

    it('answers 403 SCOPE_DENIED to a caller who reads the project but may not act on it, and 404 to one who cannot see it', async () => {
      const target = await project({ unit: OTHER_BRANCH });
      const made = await assign({ project: target, leader: TENANT_READER });
      const act = subtree('project.accountability.assign', DEPARTMENT, '/u1/u2/');
      const read = subtree('project.read', OTHER_BRANCH, '/u3/');
      expect(await refusal(end(made.id, 1, { scopes: { act, read } }))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(end(made.id, 1, { scopes: { act: nothing, read: nothing } }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('does not end the assignment of another tenant (404)', async () => {
      const target = await project();
      const made = await assign({ project: target });
      expect(await refusal(as((tx) => store.end(tx, { assignmentId: made.id, expectedVersion: 1, validUntil: TODAY, endReason: 'Not mine to end', actor: memberId(B_MEMBER), scopes: { act: everything, read: everything }, today: TODAY }), TENANT_B, B_MEMBER))).toEqual({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('the audit row and the event', () => {
    it('are written from the stored values: trimmed reason, lower-case ids, the project version and one key per assignment version', async () => {
      const target = await project();
      const made = await assign({ project: target });
      const occurredAt = new Date('2026-10-24T01:00:00Z');
      const madeRecord = assignmentMadeRecord(made, TENANT_A, memberId(ACTOR), occurredAt);
      expect(madeRecord.audit).toMatchObject({ action: 'project.leader_assigned', resourceType: 'project', resourceId: target.id, classification: 'INTERNAL' });
      expect(madeRecord.audit.diff).toEqual({
        assignment_id: made.id,
        code: target.code,
        leader_membership_id: memberId(SUBTREE_READER),
        accountability_role: 'LEADER_IN_CHARGE',
        valid_from: LAST_YEAR,
        assignment_document_id: null,
      });
      expect(madeRecord.event).toMatchObject({ aggregateType: 'project', aggregateId: target.id, aggregateVersion: made.projectVersion, type: 'project.leader_assigned.v1', schemaVersion: 1 });
      expect(madeRecord.event.payload).toMatchObject({ tenant_id: TENANT_A, project_id: target.id, version: made.projectVersion, actor_id: memberId(ACTOR), occurred_at: occurredAt.toISOString(), assignment_id: made.id });
      const ended = await end(made.id, made.version, { reason: '  Reassigned to another leader  ' });
      const endedRecord = assignmentEndedRecord(ended, TENANT_A, memberId(ACTOR), occurredAt);
      expect(endedRecord.audit).toMatchObject({ action: 'project.leader_unassigned', reason: 'Reassigned to another leader' });
      expect(endedRecord.event.type).toBe('project.leader_unassigned.v1');
      expect(endedRecord.event.eventKey).not.toBe(madeRecord.event.eventKey);
    });
  });

  describe('the register of assignments', () => {
    it('lists the assignments of the projects in the scope, a project first and its latest period first, with the name of the leader and the page after an anchor', async () => {
      const target = await project();
      const first = await assign({ project: target, validFrom: '2024-01-01' });
      await end(first.id, first.version, { validUntil: '2024-12-31' });
      await assign({ project: target, leader: TENANT_READER, validFrom: '2025-01-01' });
      const lines = await as((tx) => store.list(tx, everything, { projectId: target.id }, { limit: 10, after: undefined }));
      expect(lines.map((line) => [line.leader.displayName, line.status, line.validFrom, line.validUntil])).toEqual([
        ['User 3', 'ACTIVE', '2025-01-01', null],
        ['User 2', 'ENDED', '2024-01-01', '2024-12-31'],
      ]);
      expect(lines[1]).toMatchObject({ projectId: target.id, projectCode: target.code, endReason: 'Reassigned to another leader', version: 2 });
      const next = await as((tx) => store.list(tx, everything, { projectId: target.id }, { limit: 10, after: { code: lines[0]?.codeKey ?? '', id: lines[0]?.id ?? '' } }));
      expect(next.map((line) => line.id)).toEqual([lines[1]?.id]);
      const active = await as((tx) => store.list(tx, everything, { projectId: target.id, status: 'ACTIVE' }, { limit: 10, after: undefined }));
      expect(active).toHaveLength(1);
    });

    it('shows nothing of a project outside the scope or of another tenant', async () => {
      const target = await project({ unit: OTHER_BRANCH });
      await assign({ project: target, leader: TENANT_READER });
      const narrow = subtree('project.read', DEPARTMENT, '/u1/u2/');
      expect(await as((tx) => store.list(tx, narrow, { projectId: target.id }, { limit: 10, after: undefined }))).toEqual([]);
      expect(await as((tx) => store.list(tx, everything, { projectId: target.id }, { limit: 10, after: undefined }), TENANT_B, B_MEMBER)).toEqual([]);
    });
  });

  describe('the guards of the database', () => {
    it('never changes who holds a role, nor an assignment that has ended, and the runtime role cannot delete one', async () => {
      const target = await project();
      const made = await assign({ project: target });
      expect(await sqlState(owner('update machvon.project_accountability set leader_membership_id = $2::uuid where id = $1::uuid', [made.id, memberId(TENANT_READER)]))).toMatchObject({ code: '23514' });
      expect(await sqlState(owner(`update machvon.project_accountability set valid_from = '2020-01-01' where id = $1::uuid`, [made.id]))).toMatchObject({ code: '23514' });
      await end(made.id, made.version);
      expect(await sqlState(owner(`update machvon.project_accountability set end_reason = 'rewritten history' where id = $1::uuid`, [made.id]))).toMatchObject({ code: '23514' });
      expect(await sqlState(as((tx) => tx.query('delete from machvon.project_accountability where id = $1::uuid', [made.id])))).toMatchObject({ code: '42501' });
    });

    it('refuses an end that is before the start, an active row with an end and an ended row without a reason', async () => {
      const target = await project();
      const insert = (status: string, from: string, until: string | null, reason: string | null) =>
        sqlState(
          owner(
            `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, valid_until, status, end_reason, created_by, updated_by)
             values ($1, $2, $3, $4, 'FOCAL_OFFICER', $5::date, $6::date, $7, $8, $9, $9)`,
            [TENANT_A, randomUUID(), target.id, memberId(TENANT_READER), from, until, status, reason, memberId(ACTOR)],
          ),
        );
      expect((await insert('ENDED', '2025-05-05', '2025-05-04', 'time runs backwards')).constraint).toBe('project_accountability_window_chk');
      expect((await insert('ACTIVE', '2025-05-05', '2025-06-01', null)).constraint).toBe('project_accountability_active_open_chk');
      expect((await insert('ENDED', '2025-05-05', '2025-06-01', null)).constraint).toBe('project_accountability_end_chk');
    });
  });
});
