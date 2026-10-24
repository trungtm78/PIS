import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
import { PrjTaskForceStore, memberAddedRecord, taskForceCreatedRecord, taskForceDissolvedRecord, taskForceScope } from '../src/prj-task-force-store';
import type { TaskForceChange } from '../src/prj-task-force-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const store = new PrjTaskForceStore();
const TODAY = vietnamDateOf(new Date());
const TOMORROW = vietnamDateOf(new Date(Date.now() + 86_400_000));
const LAST_YEAR = '2025-03-01';
const WORKER = '00000000-0000-4000-8000-000000000000';

const ACTOR = 1;
const LEAD = 2;
const ABOVE = 3;
const BELOW_ONLY = 4;
const BELOW_SUBTREE = 5;
const ELSEWHERE = 6;
const NO_GRANT = 7;
const SUSPENDED = 8;
const PROJECT_IN = 9;
const PROJECT_OUT = 10;
const ANCESTOR_ONLY = 11;
const TENANT_WIDE = 12;
const CONTRACT_ONLY = 13;
const B_MEMBER = 14;
const ROOT = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const SECTION = 4;

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

let counter = 0;
let areaVersion = '';
let areaVersionB = '';
const projectsAt: Record<string, string> = {};

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

async function project(unit: number, tenant = TENANT_A): Promise<string> {
  counter += 1;
  const code = `TF-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as(
    (tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: tenant === TENANT_A ? areaVersion : areaVersionB, totalInvestmentVnd: '500000000000' }, memberId(ACTOR), TODAY),
    tenant,
  );
  return created.id;
}

async function document(status = 'EFFECTIVE', tenant = TENANT_A): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A founding decision', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
    [tenant, id, `QD-${id.slice(0, 8)}/2026`, status, memberId(ACTOR)],
    tenant,
  );
  return id;
}

interface CreateInput {
  code?: string;
  name?: string;
  purpose?: string;
  lead?: number;
  unit?: number;
  validFrom?: string;
  document?: string;
}

const create = (input: CreateInput = {}, tenant = TENANT_A): Promise<TaskForceChange> => {
  counter += 1;
  return as(
    (tx) =>
      store.create(tx, {
        code: input.code ?? `TF-${counter}-${randomUUID().slice(0, 6)}`,
        name: input.name ?? 'Disbursement task force of the department',
        purpose: input.purpose ?? 'Press the disbursement of the slow projects of the department',
        leadMembershipId: memberId(input.lead ?? LEAD),
        scopeUnitId: unitId(input.unit ?? DEPARTMENT),
        validFrom: input.validFrom ?? LAST_YEAR,
        ...(input.document === undefined ? {} : { establishmentDocumentId: input.document }),
        actor: memberId(ACTOR),
        today: TODAY,
        now: new Date(),
      }),
    tenant,
  );
};

interface AddInput {
  member?: number;
  role?: string;
  project?: string;
  validFrom?: string;
}

const add = (force: { id: string }, input: AddInput = {}) =>
  as((tx) =>
    store.addMember(tx, {
      taskForceId: force.id,
      membershipId: memberId(input.member ?? ABOVE),
      role: input.role ?? 'MEMBER',
      ...(input.project === undefined ? {} : { projectId: input.project }),
      validFrom: input.validFrom ?? LAST_YEAR,
      actor: memberId(ACTOR),
      today: TODAY,
      now: new Date(),
    }),
  );

const dissolve = (force: { id: string }, version: number, reason = 'The disbursement target was met') =>
  as((tx) => store.dissolve(tx, { taskForceId: force.id, expectedVersion: version, reason, actor: memberId(ACTOR), today: TODAY }));

const forceRow = async (id: string) =>
  (await owner<Record<string, unknown>>('select code, status, valid_from::text as valid_from, valid_until::text as valid_until, version::text as version, lead_membership_id, scope_unit_id from machvon.task_force where id = $1::uuid', [id]))[0];
const termsOf = (id: string) =>
  owner<Record<string, unknown>>('select membership_id, member_role, project_id, valid_from::text as valid_from, valid_until::text as valid_until from machvon.task_force_member where task_force_id = $1::uuid order by created_at, id', [id]);

jest.setTimeout(120_000);

describe('PrjTaskForceStore (task forces with scoped members, ST-PRJ-005)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
        { n: OTHER_BRANCH, path: '/u3/' },
        { n: SECTION, path: '/u1/u2/u4/', parent: DEPARTMENT },
      ]);
      await harness.seedMembership(tenant, ACTOR, ROOT);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    for (const member of [LEAD, ABOVE, BELOW_ONLY, BELOW_SUBTREE, ELSEWHERE, NO_GRANT, PROJECT_IN, PROJECT_OUT, ANCESTOR_ONLY, TENANT_WIDE, CONTRACT_ONLY]) await harness.seedMembership(TENANT_A, member, ROOT);
    await harness.seedMembership(TENANT_A, SUSPENDED, ROOT, { status: 'Suspended' });
    await harness.seedMembership(TENANT_B, B_MEMBER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'FIELD_STAFF', ['project.read'], 20);
    areaVersion = await seedArea(TENANT_A);
    areaVersionB = await seedArea(TENANT_B);
    projectsAt.inside = await project(DEPARTMENT);
    projectsAt.section = await project(SECTION);
    projectsAt.outside = await project(OTHER_BRANCH);
    projectsAt.foreign = await project(DEPARTMENT, TENANT_B);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEAD, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 2, member: ABOVE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 3, member: BELOW_ONLY, role: 1, kind: 'UNIT_ONLY', refs: [unitId(SECTION)] },
      { n: 4, member: BELOW_SUBTREE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(SECTION)] },
      { n: 5, member: ELSEWHERE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
      { n: 6, member: SUSPENDED, role: 1, kind: 'TENANT' },
      { n: 7, member: PROJECT_IN, role: 1, kind: 'PROJECT', refs: [projectsAt.inside] },
      { n: 8, member: PROJECT_OUT, role: 1, kind: 'PROJECT', refs: [projectsAt.outside] },
      { n: 9, member: ANCESTOR_ONLY, role: 1, kind: 'UNIT_ONLY', refs: [unitId(ROOT)] },
      { n: 10, member: TENANT_WIDE, role: 1, kind: 'TENANT' },
      { n: 11, member: CONTRACT_ONLY, role: 1, kind: 'CONTRACT', refs: [randomUUID()] },
    ]);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('founding a task force', () => {
    it('founds a force with its lead as the first member and the purpose, the scope and the document as stored', async () => {
      const decision = await document();
      const made = await create({ code: ' TF-FOUND ', name: '  Task force of the department  ', document: decision });
      expect(made).toMatchObject({ code: 'TF-FOUND', scopeUnitId: unitId(DEPARTMENT), leadMembershipId: memberId(LEAD), status: 'ACTIVE', validFrom: LAST_YEAR, validUntil: null, establishmentDocumentId: decision, version: 1, openMembers: 1 });
      expect(await forceRow(made.id)).toMatchObject({ code: 'TF-FOUND', status: 'ACTIVE', valid_until: null, version: '1' });
      expect(await termsOf(made.id)).toEqual([{ membership_id: memberId(LEAD), member_role: 'LEAD', project_id: null, valid_from: LAST_YEAR, valid_until: null }]);
    });

    it('refuses a code that is used already with 409 TASK_FORCE_CODE_DUPLICATE, also when two forces with it are founded at once', async () => {
      await create({ code: 'TF-ONCE' });
      expect(await refusal(create({ code: 'TF-ONCE' }))).toEqual({ code: 'TASK_FORCE_CODE_DUPLICATE', status: 409, detail: 'code' });
      const raced = await Promise.allSettled([create({ code: 'TF-RACE' }), create({ code: 'TF-RACE' })]);
      expect(raced.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(((raced.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code).toBe('TASK_FORCE_CODE_DUPLICATE');
      expect(await owner("select count(*)::int as n from machvon.task_force where code = 'TF-RACE'")).toEqual([{ n: 1 }]);
    });

    it('refuses a lead outside the scope, not in force or without a grant with 422 MEMBER_OUT_OF_SCOPE, and knows no lead of another tenant (404)', async () => {
      for (const lead of [ELSEWHERE, NO_GRANT, SUSPENDED, ANCESTOR_ONLY, CONTRACT_ONLY, PROJECT_OUT]) {
        expect(await refusal(create({ lead }))).toEqual({ code: 'MEMBER_OUT_OF_SCOPE', status: 422, detail: 'lead_membership_id' });
      }
      expect(await refusal(create({ lead: B_MEMBER }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('takes a lead whose grant meets the scope from above, from below, on a unit, on a project or on the whole tenant', async () => {
      for (const lead of [ABOVE, BELOW_ONLY, BELOW_SUBTREE, PROJECT_IN, TENANT_WIDE]) expect((await create({ lead })).leadMembershipId).toBe(memberId(lead));
    });

    it('checks the fields, the day, the unit and the document before it writes', async () => {
      expect(await refusal(create({ code: '   ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'code' });
      expect(await refusal(create({ code: 'C'.repeat(31) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'code' });
      expect(await refusal(create({ name: 'ab' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'name' });
      expect(await refusal(create({ purpose: 'too short' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'purpose' });
      expect(await refusal(create({ purpose: 'A purpose with a control \u0007 character in it' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'purpose' });
      expect(await refusal(create({ validFrom: TOMORROW }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_from' });
      expect(await refusal(create({ document: await document('RECALLED') }))).toEqual({ code: 'DECISION_REQUIRED', status: 422, detail: 'establishment_document_id' });
      expect(await refusal(as((tx) => store.create(tx, { code: 'TF-X', name: 'A name', purpose: 'A purpose long enough', leadMembershipId: memberId(LEAD), scopeUnitId: randomUUID(), validFrom: LAST_YEAR, actor: memberId(ACTOR), today: TODAY, now: new Date() })))).toEqual({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
      expect(await owner("select count(*)::int as n from machvon.task_force where code in ('TF-X', '   ')")).toEqual([{ n: 0 }]);
    });

    it('keeps a purpose with line breaks and refuses a unit of another tenant (404)', async () => {
      const made = await create({ purpose: 'First line of the purpose\nSecond line of the purpose' });
      expect((await owner<{ purpose: string }>('select purpose from machvon.task_force where id = $1::uuid', [made.id]))[0]?.purpose).toContain('\n');
      await harness.seedUnits(TENANT_B, [{ n: 9, path: '/b9/' }]);
      expect(await refusal(as((tx) => store.create(tx, { code: 'TF-FOREIGN', name: 'A name', purpose: 'A purpose long enough', leadMembershipId: memberId(LEAD), scopeUnitId: unitId(9), validFrom: LAST_YEAR, actor: memberId(ACTOR), today: TODAY, now: new Date() })))).toEqual({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('members and the projects they follow (AC-ST-PRJ-005-2)', () => {
    it('seats a member in the scope, for a project of the scope, and raises the version of the force', async () => {
      const force = await create();
      const added = await add(force, { member: ABOVE, role: 'SECRETARY', project: projectsAt.section });
      expect(added).toMatchObject({ taskForceId: force.id, membershipId: memberId(ABOVE), role: 'SECRETARY', projectId: projectsAt.section, validFrom: LAST_YEAR, taskForceVersion: 2 });
      expect((await forceRow(force.id))?.version).toBe('2');
      expect((await termsOf(force.id)).map((term) => [term.membership_id, term.member_role, term.project_id])).toEqual([
        [memberId(LEAD), 'LEAD', null],
        [memberId(ABOVE), 'SECRETARY', projectsAt.section],
      ]);
      expect((await add(force, { member: ABOVE })).taskForceVersion).toBe(3);
    });

    it('refuses a member outside the scope of the force with 422 MEMBER_OUT_OF_SCOPE, and a member of another tenant with 404 (AC-ST-PRJ-005-2)', async () => {
      const force = await create();
      for (const member of [ELSEWHERE, NO_GRANT, SUSPENDED, ANCESTOR_ONLY, CONTRACT_ONLY, PROJECT_OUT]) {
        expect(await refusal(add(force, { member }))).toEqual({ code: 'MEMBER_OUT_OF_SCOPE', status: 422, detail: 'membership_id' });
      }
      expect(await refusal(add(force, { member: B_MEMBER }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await termsOf(force.id)).toHaveLength(1);
      expect((await forceRow(force.id))?.version).toBe('1');
    });

    it('refuses a project outside the scope (422) and a project of another tenant (404)', async () => {
      const force = await create();
      expect(await refusal(add(force, { project: projectsAt.outside }))).toEqual({ code: 'MEMBER_OUT_OF_SCOPE', status: 422, detail: 'project_id' });
      expect(await refusal(add(force, { project: projectsAt.foreign }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(add(force, { project: 'not-an-id' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_id' });
    });

    it('refuses the same member for the same project twice at once with 409 DUPLICATE_KEY, but lets the member follow other projects', async () => {
      const force = await create();
      await add(force, { project: projectsAt.inside });
      expect(await refusal(add(force, { project: projectsAt.inside }))).toEqual({ code: 'DUPLICATE_KEY', status: 409, detail: 'membership_id' });
      expect((await add(force, { project: projectsAt.section })).projectId).toBe(projectsAt.section);
      expect((await add(force)).projectId).toBeNull();
      expect(await refusal(add(force))).toEqual({ code: 'DUPLICATE_KEY', status: 409, detail: 'membership_id' });
      expect(await refusal(add(force, { member: LEAD }))).toEqual({ code: 'DUPLICATE_KEY', status: 409, detail: 'membership_id' });
    });

    it('checks the role, the day and the identifier: the lead sits from the foundation and takes no second seat as LEAD', async () => {
      const force = await create();
      expect(await refusal(add(force, { role: 'LEAD' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'member_role' });
      expect(await refusal(add(force, { role: 'CHAIR' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'member_role' });
      expect(await refusal(add(force, { validFrom: TOMORROW }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_from' });
      expect(await refusal(add(force, { validFrom: '2025-02-28' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_from' });
      expect(await refusal(add(force, { validFrom: '2025-02-30' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_from' });
      expect(await refusal(as((tx) => store.addMember(tx, { taskForceId: force.id, membershipId: 'nope', role: 'MEMBER', validFrom: LAST_YEAR, actor: memberId(ACTOR), today: TODAY, now: new Date() })))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'membership_id',
      });
      expect(await refusal(as((tx) => store.addMember(tx, { taskForceId: randomUUID(), membershipId: memberId(ABOVE), role: 'MEMBER', validFrom: LAST_YEAR, actor: memberId(ACTOR), today: TODAY, now: new Date() })))).toEqual({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
      expect(await termsOf(force.id)).toHaveLength(1);
    });
  });

  describe('dissolving a task force (AC-ST-PRJ-005-2)', () => {
    it('ends the force and every open term in the same transaction, and keeps the history (AC-ST-PRJ-005-2)', async () => {
      const force = await create();
      await add(force, { member: ABOVE, project: projectsAt.inside });
      const second = await add(force, { member: TENANT_WIDE });
      const done = await dissolve(force, second.taskForceVersion);
      expect(done).toMatchObject({ id: force.id, status: 'DISSOLVED', validUntil: TODAY, version: 4, openMembers: 0, endedMembers: 3, reason: 'The disbursement target was met' });
      expect(await forceRow(force.id)).toMatchObject({ status: 'DISSOLVED', valid_until: TODAY, version: '4' });
      expect((await termsOf(force.id)).map((term) => term.valid_until)).toEqual([TODAY, TODAY, TODAY]);
    });

    it('leaves the terms that ended earlier as they were', async () => {
      const force = await create();
      await add(force, { member: ABOVE });
      await owner(`update machvon.task_force_member set valid_until = '2025-06-30' where task_force_id = $1::uuid and member_role = 'MEMBER'`, [force.id]);
      const done = await dissolve(force, 2);
      expect(done.endedMembers).toBe(1);
      expect((await termsOf(force.id)).map((term) => term.valid_until)).toEqual([TODAY, '2025-06-30']);
    });

    it('refuses a stale version with 409 VERSION_CONFLICT, a force that is dissolved already with 409 TASK_FORCE_DISSOLVED, and a short reason', async () => {
      const force = await create();
      await add(force);
      expect(await refusal(dissolve(force, 1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(dissolve(force, 2, 'no'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      const done = await dissolve(force, 2);
      expect(await refusal(dissolve(force, done.version))).toEqual({ code: 'TASK_FORCE_DISSOLVED', status: 409 });
      expect(await refusal(dissolve({ id: randomUUID() }, 1))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(dissolve({ id: 'nope' }, 1))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'id' });
    });

    it('takes no member after the dissolution, in the command (409 TASK_FORCE_DISSOLVED) and in the database', async () => {
      const force = await create();
      await dissolve(force, 1);
      expect(await refusal(add(force))).toEqual({ code: 'TASK_FORCE_DISSOLVED', status: 409 });
      const written = await sqlState(
        owner(
          `insert into machvon.task_force_member (tenant_id, id, task_force_id, membership_id, member_role, valid_from, created_by, updated_by)
           values ($1, $2, $3, $4, 'MEMBER', '2025-03-01', $5, $5)`,
          [TENANT_A, randomUUID(), force.id, memberId(ABOVE), memberId(ACTOR)],
        ),
      );
      expect(written.code).toBe('23514');
    });

    it('does not dissolve the force of another tenant (404)', async () => {
      const force = await create();
      expect(await refusal(as((tx) => store.dissolve(tx, { taskForceId: force.id, expectedVersion: 1, reason: 'Not mine to dissolve', actor: memberId(B_MEMBER), today: TODAY }), TENANT_B, B_MEMBER))).toEqual({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('the audit row and the event', () => {
    it('are written from the stored values: the code, the scope, the version and one key per version', async () => {
      const made = await create({ code: ' TF-AUDIT ' });
      const occurredAt = new Date('2026-10-24T01:00:00Z');
      const createdRecord = taskForceCreatedRecord(made, TENANT_A, memberId(ACTOR), occurredAt);
      expect(createdRecord.audit).toMatchObject({ action: 'taskforce.created', resourceType: 'task_force', resourceId: made.id });
      expect(createdRecord.audit.diff).toEqual({ code: 'TF-AUDIT', scope_unit_id: unitId(DEPARTMENT), lead_membership_id: memberId(LEAD), valid_from: LAST_YEAR, establishment_document_id: null });
      expect(createdRecord.event).toMatchObject({ aggregateType: 'task_force', aggregateId: made.id, aggregateVersion: 1, type: 'taskforce.created.v1', schemaVersion: 1 });
      expect(createdRecord.event.payload).toMatchObject({ tenant_id: TENANT_A, task_force_id: made.id, version: 1, actor_id: memberId(ACTOR), occurred_at: occurredAt.toISOString(), code: 'TF-AUDIT' });
      const added = await add(made, { member: ABOVE, project: projectsAt.inside });
      expect(memberAddedRecord(added)).toMatchObject({ action: 'taskforce.member_added', resourceId: made.id, diff: { membership_id: memberId(ABOVE), member_role: 'MEMBER', project_id: projectsAt.inside } });
      const done = await dissolve(made, added.taskForceVersion, '  Target met  ');
      const dissolvedRecord = taskForceDissolvedRecord(done, TENANT_A, memberId(ACTOR), occurredAt);
      expect(dissolvedRecord.audit).toMatchObject({ action: 'taskforce.dissolved', reason: 'Target met' });
      expect(dissolvedRecord.audit.diff).toMatchObject({ ended_members: 2, valid_until: TODAY });
      expect(dissolvedRecord.event.eventKey).not.toBe(createdRecord.event.eventKey);
      expect(dissolvedRecord.event.type).toBe('taskforce.dissolved.v1');
    });
  });

  describe('the list of task forces', () => {
    const grantOf = (permission: string, scope: Scope): EffectiveAccess => ({
      membershipId: memberId(ACTOR),
      scopeVersion: 1,
      membershipActive: true,
      grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
    });

    it('lists the forces whose scope unit lies in the scope, by code, with their terms and the names, a page after an anchor', async () => {
      const first = await create({ code: 'LIST-A', unit: DEPARTMENT });
      const second = await create({ code: 'LIST-B', unit: OTHER_BRANCH, lead: ELSEWHERE });
      await add(first, { member: ABOVE, project: projectsAt.inside });
      const everything = taskForceScope(grantOf('taskforce.read', { kind: 'TENANT' }), 'taskforce.read', new Date());
      const lines = await as((tx) => store.list(tx, everything, {}, { limit: 500, after: undefined }));
      const ours = lines.filter((line) => line.code.startsWith('LIST-'));
      expect(ours.map((line) => line.code)).toEqual(['LIST-A', 'LIST-B']);
      expect(ours[0]).toMatchObject({ id: first.id, status: 'ACTIVE', version: 2, lead: { membershipId: memberId(LEAD), displayName: 'User 2' }, scopeUnit: { id: unitId(DEPARTMENT), code: 'U2', name: 'Unit 2' } });
      expect(ours[0]?.members.map((member) => [member.displayName, member.role, member.project?.id ?? null])).toEqual([
        ['User 2', 'LEAD', null],
        ['User 3', 'MEMBER', projectsAt.inside],
      ]);
      expect(ours[1]?.id).toBe(second.id);
      const after = await as((tx) => store.list(tx, everything, {}, { limit: 500, after: { code: 'LIST-A', id: first.id } }));
      expect(after.map((line) => line.code).filter((code) => code.startsWith('LIST-'))).toEqual(['LIST-B']);
      const narrow = taskForceScope(grantOf('taskforce.read', { kind: 'UNIT_SUBTREE', refIds: [unitId(DEPARTMENT)], paths: ['/u1/u2/'] }), 'taskforce.read', new Date());
      const inDepartment = await as((tx) => store.list(tx, narrow, {}, { limit: 500, after: undefined }));
      expect(inDepartment.map((line) => line.code)).toContain('LIST-A');
      expect(inDepartment.map((line) => line.code)).not.toContain('LIST-B');
    });

    it('filters by status, shows the open terms first and shows nothing of another tenant', async () => {
      const force = await create({ code: 'LIST-C' });
      await add(force, { member: ABOVE });
      await owner(`update machvon.task_force_member set valid_until = '2025-06-30' where task_force_id = $1::uuid and member_role = 'MEMBER'`, [force.id]);
      const everything = taskForceScope(grantOf('taskforce.read', { kind: 'TENANT' }), 'taskforce.read', new Date());
      const lines = await as((tx) => store.list(tx, everything, { status: 'ACTIVE' }, { limit: 500, after: undefined }));
      expect(lines.find((line) => line.code === 'LIST-C')?.members.map((member) => member.validUntil)).toEqual([null, '2025-06-30']);
      await dissolve(force, 2);
      expect((await as((tx) => store.list(tx, everything, { status: 'DISSOLVED' }, { limit: 500, after: undefined }))).map((line) => line.code)).toContain('LIST-C');
      expect((await as((tx) => store.list(tx, everything, { status: 'ACTIVE' }, { limit: 500, after: undefined }))).map((line) => line.code)).not.toContain('LIST-C');
      expect(await as((tx) => store.list(tx, everything, {}, { limit: 500, after: undefined }), TENANT_B, B_MEMBER)).toEqual([]);
    });
  });

  describe('the guards of the database', () => {
    it('never changes the code, the scope or the lead of a force, nor a force that is dissolved, and the runtime role cannot delete one', async () => {
      const force = await create();
      expect(await sqlState(owner(`update machvon.task_force set code = 'RENAMED' where id = $1::uuid`, [force.id]))).toMatchObject({ code: '23514' });
      expect(await sqlState(owner('update machvon.task_force set scope_unit_id = $2::uuid where id = $1::uuid', [force.id, unitId(OTHER_BRANCH)]))).toMatchObject({ code: '23514' });
      expect(await sqlState(owner('update machvon.task_force set lead_membership_id = $2::uuid where id = $1::uuid', [force.id, memberId(ABOVE)]))).toMatchObject({ code: '23514' });
      await dissolve(force, 1);
      expect(await sqlState(owner(`update machvon.task_force set version = 99 where id = $1::uuid`, [force.id]))).toMatchObject({ code: '23514' });
      expect(await sqlState(as((tx) => tx.query('delete from machvon.task_force where id = $1::uuid', [force.id])))).toMatchObject({ code: '42501' });
      expect(await sqlState(as((tx) => tx.query('delete from machvon.task_force_member where task_force_id = $1::uuid', [force.id])))).toMatchObject({ code: '42501' });
    });

    it('never changes who sits in a force, in which role or since when, nor a term that has ended', async () => {
      const force = await create();
      const [lead] = await termsOf(force.id);
      expect(await sqlState(owner(`update machvon.task_force_member set member_role = 'SECRETARY' where task_force_id = $1::uuid`, [force.id]))).toMatchObject({ code: '23514' });
      expect(await sqlState(owner(`update machvon.task_force_member set valid_from = '2020-01-01' where task_force_id = $1::uuid`, [force.id]))).toMatchObject({ code: '23514' });
      expect(await sqlState(owner(`update machvon.task_force_member set valid_until = '2025-01-01' where task_force_id = $1::uuid`, [force.id]))).toMatchObject({ constraint: 'task_force_member_window_chk' });
      await owner(`update machvon.task_force_member set valid_until = '2025-06-30' where task_force_id = $1::uuid`, [force.id]);
      expect(await sqlState(owner(`update machvon.task_force_member set valid_until = '2025-07-31' where task_force_id = $1::uuid`, [force.id]))).toMatchObject({ code: '23514' });
      expect(lead?.membership_id).toBe(memberId(LEAD));
    });

    it('keeps a force that is active without an end, a dissolved one with an end, and a code without blanks', async () => {
      const insert = (status: string, until: string | null, code: string) =>
        sqlState(
          owner(
            `insert into machvon.task_force (tenant_id, id, code, name, purpose, lead_membership_id, scope_unit_id, valid_from, valid_until, status, created_by, updated_by)
             values ($1, $2, $3, 'A name', 'A purpose long enough', $4, $5, '2025-03-01', $6::date, $7, $8, $8)`,
            [TENANT_A, randomUUID(), code, memberId(LEAD), unitId(DEPARTMENT), until, status, memberId(ACTOR)],
          ),
        );
      expect((await insert('ACTIVE', '2025-04-01', 'TF-CHK-1')).constraint).toBe('task_force_status_window_chk');
      expect((await insert('DISSOLVED', null, 'TF-CHK-2')).constraint).toBe('task_force_status_window_chk');
      expect((await insert('ACTIVE', null, ' TF-CHK-3')).constraint).toBe('task_force_code_chk');
      expect((await insert('DISSOLVED', '2025-02-01', 'TF-CHK-4')).constraint).toBe('task_force_window_chk');
    });
  });
});
