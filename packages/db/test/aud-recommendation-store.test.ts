import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { AudConclusionStore } from '../src/aud-conclusion-store';
import { AudEngagementStore, engagementScope } from '../src/aud-engagement-store';
import { AudRecommendationStore, assertOwner, recommendationScope } from '../src/aud-recommendation-store';
import type { RecommendationRow } from '../src/aud-recommendation-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const engagements = new AudEngagementStore();
const conclusions = new AudConclusionStore();
const store = new AudRecommendationStore();

const COORDINATOR = 1;
const OWNER = 2; // a person the recommendation is given to
const UNIT_MATE = 3; // another member of the owner unit, who executes there
const VERIFIER = 4;
const SUSPENDED = 5;
const STRANGER = 6;
const FAMILY = 0x95;
const PROJECT = id(FAMILY, 1);
const DECISION = id(FAMILY, 10);
const CONCLUSION_DOCUMENT = id(FAMILY, 11);
const EVIDENCE = id(FAMILY, 12);
const EVIDENCE_TWO = id(FAMILY, 13);
const EVIDENCE_PENDING = id(FAMILY, 14);
const EXPLANATION = id(FAMILY, 15);
const AUTHORITY_OPINION = id(FAMILY, 16);
const AUTHORITY_ATTACHMENT = id(FAMILY, 17);
const BASIS = id(FAMILY, 18);
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const TODAY = '2026-10-26';
const NOW = new Date('2026-10-26T03:00:00Z');
const TOTAL = '1250000000';

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = COORDINATOR): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const accessOf = (member: number, permissions: readonly string[], scope: Scope): EffectiveAccess => ({
  membershipId: memberId(member),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'AUD', rank: 30, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const READ = 'aud.read';
const EXECUTE = 'aud.recommendation.execute';
const everyone = (member: number): EffectiveAccess => accessOf(member, [READ, EXECUTE, 'aud.recommendation.verify', 'aud.recommendation.assign'], { kind: 'TENANT' });
const seenBy = (access: EffectiveAccess): ScopeBuilder => recommendationScope(access, READ, EXECUTE, NOW);
const everything = engagementScope(everyone(COORDINATOR), READ, NOW);
const nothing = engagementScope(accessOf(COORDINATOR, [READ], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] }), READ, NOW);
const seeAll = seenBy(everyone(COORDINATOR));

let counter = 0;
/** An engagement that is followed up with a conclusion of 1,250,000,000 (due 2026-12-31) and the recommendations asked for, as rows ready for a command. */
async function followed(
  recommendations: Array<{ type?: 'FINANCIAL_RECOVERY' | 'FINANCIAL_ADJUSTMENT' | 'PROCESS_CORRECTION' | 'REFERRAL'; amount?: string | undefined }> = [{ type: 'PROCESS_CORRECTION' }],
  deadline: string | null = '2026-12-31',
): Promise<{ engagementId: string; conclusionId: string; ids: string[] }> {
  counter += 1;
  const code = `RM-2026-${String(counter).padStart(3, '0')}`;
  const request = {
    engagementCode: code,
    engagementType: 'STATE_AUDIT' as const,
    authorityKind: 'STATE_AUDIT_OFFICE',
    authorityName: 'State Audit Office',
    decisionDocumentId: DECISION,
    title: 'Audit of the investment in the bridge',
    periodFrom: '2025-01-01',
    periodTo: '2025-12-31',
    coordinatorId: memberId(COORDINATOR),
    scope: [{ kind: 'PROJECT' as const, id: PROJECT }],
  };
  const targets = await as((tx) => engagements.resolveTargets(tx, request.scope));
  const created = await as((tx) => engagements.create(tx, request, targets, memberId(COORDINATOR)));
  await as((tx) => engagements.lock(tx, created.id, everything, everything, 1).then((row) => engagements.start(tx, row, { startedOn: '2026-10-20', placeLegalHold: false, today: TODAY }, memberId(COORDINATOR))));
  const row = await as((tx) => engagements.lock(tx, created.id, everything, everything, 2));
  const recorded = await as((tx) =>
    conclusions.record(
      tx,
      row,
      {
        conclusionKind: 'AUDIT_REPORT',
        conclusionDocumentId: CONCLUSION_DOCUMENT,
        issuedOn: '2026-10-10',
        receivedOn: '2026-10-15',
        implementationDueOn: deadline ?? undefined,
        reportDueOn: undefined,
        summary: 'The audit found payments above the approved volumes.',
        totalFinancialVnd: TOTAL,
        isPublic: false,
        supersedesId: undefined,
      },
      TODAY,
      memberId(COORDINATOR),
    ),
  );
  const ids: string[] = [];
  for (const item of recommendations) {
    counter += 1;
    const type = item.type ?? 'PROCESS_CORRECTION';
    const made = await as((tx) =>
      conclusions
        .lock(tx, recorded.id, everything, everything)
        .then((locked) =>
          conclusions.createRecommendation(
            tx,
            locked,
            { findingId: undefined, recCode: `R-${counter}`, recType: type, description: 'Recover what was paid above the volume.', amountVnd: type.startsWith('FINANCIAL') ? (item.amount ?? '400000000') : undefined, projectId: undefined },
            memberId(COORDINATOR),
          ),
        ),
    );
    ids.push(made.id);
  }
  return { engagementId: created.id, conclusionId: recorded.id, ids };
}

const lockAs = (recommendationId: string, member = COORDINATOR, scope: ScopeBuilder = seeAll, acts?: ScopeBuilder) =>
  as((tx) => store.lock(tx, recommendationId, scope, acts === undefined ? {} : { acts }), TENANT_A, member);
const row = (recommendationId: string): Promise<RecommendationRow> => lockAs(recommendationId);

/** Runs a store command on the recommendation locked in the same transaction, as the member. */
const run = <T>(recommendationId: string, member: number, command: (tx: TenantTx, locked: RecommendationRow) => Promise<T>): Promise<T> =>
  as((tx) => store.lock(tx, recommendationId, seeAll).then((locked) => command(tx, locked)), TENANT_A, member);

const assign = (recommendationId: string, extra: { ownerUserId?: string; dueOn?: string; ownerUnitId?: string } = {}) =>
  run(recommendationId, COORDINATOR, (tx, locked) =>
    store.assign(tx, locked, { ownerUnitId: extra.ownerUnitId ?? unitId(DEPARTMENT), ownerUserId: extra.ownerUserId, dueOn: extra.dueOn ?? '2026-12-01', today: TODAY }, memberId(COORDINATOR)),
  );
const plan = (recommendationId: string, code = 'A-1', member = OWNER) =>
  run(recommendationId, member, (tx, locked) => store.plan(tx, locked, { actionCode: code, description: 'Correct the process of payment.', plannedOn: '2026-11-15' }, memberId(member)));
const actionOf = (actionId: string) => as((tx) => store.lockAction(tx, actionId, seeAll));
const complete = (actionId: string, evidence = EVIDENCE, completedOn = '2026-10-24', member = OWNER) =>
  as((tx) => store.lockAction(tx, actionId, seeAll).then((action) => store.complete(tx, action, { completedOn, evidenceDocumentId: evidence, today: TODAY }, memberId(member))), TENANT_A, member);
const submit = (recommendationId: string, member = OWNER) => run(recommendationId, member, (tx, locked) => store.submit(tx, locked, memberId(member)));
const verify = (recommendationId: string, member: number, decision: 'CLOSE' | 'RETURN', extra: { basis?: string; comment?: string } = {}) =>
  run(recommendationId, member, (tx, locked) => store.verify(tx, locked, { decision, closureBasisDocumentId: extra.basis, comment: extra.comment }, memberId(member)));
const dispute = (recommendationId: string, documentId = EXPLANATION, reason = 'The volumes were accepted on site by the supervisor.', member = OWNER) =>
  run(recommendationId, member, (tx, locked) => store.dispute(tx, locked, { reason, documentId }, memberId(member)));
const decide = (recommendationId: string, outcome: 'ACCEPTED_BY_AUTHORITY' | 'REJECTED_BY_AUTHORITY', documentId = AUTHORITY_OPINION, member = VERIFIER) =>
  run(recommendationId, member, (tx, locked) => store.decide(tx, locked, { outcome, authorityDocumentId: documentId }, memberId(member)));

const field = async <T>(recommendationId: string, column: string): Promise<T> => ((await owner<Record<string, T>>(`select ${column} as value from machvon.audit_recommendation where id = $1`, [recommendationId]))[0] as { value: T }).value;
/** A recommendation given to a person of the owner unit and brought to IN_PROGRESS with one action planned. */
async function working(type: 'FINANCIAL_RECOVERY' | 'PROCESS_CORRECTION' = 'PROCESS_CORRECTION', amount?: string) {
  const made = await followed([{ type, amount }]);
  const recommendationId = made.ids[0] as string;
  await assign(recommendationId, { ownerUserId: memberId(OWNER) });
  const planned = await plan(recommendationId);
  return { ...made, recommendationId, actionId: planned.actionId };
}

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (projects, documents) are seeded with the foreign keys they have to other modules switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

describe('AudRecommendationStore (assignment, remediation, dispute and verification, ST-AUD-003)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
        { n: ELSEWHERE, path: '/u3/' },
      ]);
    }
    for (const n of [COORDINATOR, OWNER, UNIT_MATE, VERIFIER, STRANGER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_A, SUSPENDED, ROOT, { status: 'Suspended' });
    await harness.seedMembership(TENANT_B, COORDINATOR, ROOT);
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-A-001', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, unitId(DEPARTMENT), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, document_number, number_year, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/QD-KTNN', '2026-01-15', 'EFFECTIVE', 'INTERNAL', null, null, $11, $11),
                ($1, $3, 'INCOMING', 'KL', 'Audit report on the bridge', '88/BC-KTNN', '2026-10-10', 'EFFECTIVE', 'INTERNAL', 88, 2026, $11, $11),
                ($1, $4, 'ATTACHMENT', 'BC', 'Evidence of the correction', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $11, $11),
                ($1, $5, 'ATTACHMENT', 'BC', 'More evidence of the correction', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $11, $11),
                ($1, $6, 'ATTACHMENT', 'BC', 'Evidence not in force', null, null, 'PENDING', 'INTERNAL', null, null, $11, $11),
                ($1, $7, 'ATTACHMENT', 'BC', 'Explanation of the owner', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $11, $11),
                ($1, $8, 'INCOMING', 'KL', 'Opinion of the authority', '91/CV-KTNN', '2026-10-20', 'EFFECTIVE', 'INTERNAL', 91, 2026, $11, $11),
                ($1, $9, 'ATTACHMENT', 'BC', 'An attachment, not an opinion', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $11, $11),
                ($1, $10, 'ATTACHMENT', 'BC', 'Basis of closure', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $11, $11)`,
        [TENANT_A, DECISION, CONCLUSION_DOCUMENT, EVIDENCE, EVIDENCE_TWO, EVIDENCE_PENDING, EXPLANATION, AUTHORITY_OPINION, AUTHORITY_ATTACHMENT, BASIS, memberId(COORDINATOR)],
      ],
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('who sees a recommendation and who may act on it', () => {
    it('shows a recommendation to the engagement scope, to the person it was given to and to a unit that a grant of execute reaches, and to nobody else', async () => {
      const made = await followed();
      const recommendationId = made.ids[0] as string;
      await assign(recommendationId, { ownerUserId: memberId(OWNER) });
      const outsider = accessOf(STRANGER, [READ], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] });
      expect(await refusal(lockAs(recommendationId, STRANGER, seenBy(outsider)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      // the person it was given to, who has no grant over the engagement
      const mine = accessOf(OWNER, [EXECUTE], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] });
      expect((await lockAs(recommendationId, OWNER, seenBy(mine))).id).toBe(recommendationId);
      // a member of the owner unit sees it by the unit when no person was named, and by the unit only
      const unitless = await followed();
      await assign(unitless.ids[0] as string);
      const mate = accessOf(UNIT_MATE, [EXECUTE], { kind: 'UNIT_SUBTREE', refIds: [unitId(DEPARTMENT)], paths: ['/u1/u2/'] });
      expect((await lockAs(unitless.ids[0] as string, UNIT_MATE, seenBy(mate))).id).toBe(unitless.ids[0]);
      const elsewhere = accessOf(UNIT_MATE, [EXECUTE], { kind: 'UNIT_SUBTREE', refIds: [unitId(ELSEWHERE)], paths: ['/u3/'] });
      expect(await refusal(lockAs(unitless.ids[0] as string, UNIT_MATE, seenBy(elsewhere)))).toMatchObject({ status: 404 });
      // another tenant never finds it
      expect(await refusal(as((tx) => store.lock(tx, recommendationId, seeAll), TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('tells a caller who sees the recommendation but is outside the scope to act (403 SCOPE_DENIED), and leaves the version and the state to the command', async () => {
      const made = await followed();
      const recommendationId = made.ids[0] as string;
      expect(await refusal(lockAs(recommendationId, COORDINATOR, seeAll, nothing))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      const locked = await lockAs(recommendationId);
      store.assertVersion(locked, locked.version);
      expect(() => store.assertVersion(locked, locked.version + 1)).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: locked.version } }));
      await owner("update machvon.audit_engagement set status = 'CLOSED', closed_on = '2026-10-26' where id = $1", [made.engagementId]);
      expect(() => store.assertFollowedUp(locked)).not.toThrow();
      expect(() => store.assertFollowedUp({ ...locked, engagementStatus: 'CLOSED' })).toThrow(expect.objectContaining({ code: 'ENGAGEMENT_STATE_INVALID', status: 409 }));
    });

    it('makes the owner the person named, or whoever executes for the owner unit when none was named, and nobody else (422 NOT_OWNER)', async () => {
      const made = await followed();
      const recommendationId = made.ids[0] as string;
      await assign(recommendationId, { ownerUserId: memberId(OWNER) });
      const named = await row(recommendationId);
      const owns = accessOf(OWNER, [EXECUTE], { kind: 'TENANT' });
      expect(() => assertOwner(named, owns, EXECUTE, NOW)).not.toThrow();
      expect(() => assertOwner(named, accessOf(UNIT_MATE, [EXECUTE], { kind: 'TENANT' }), EXECUTE, NOW)).toThrow(expect.objectContaining({ code: 'NOT_OWNER', status: 422 }));
      const byUnit = await followed();
      await assign(byUnit.ids[0] as string);
      const unitOwned = await row(byUnit.ids[0] as string);
      expect(unitOwned.ownerUnitPath).toBe('/u1/u2/');
      expect(() => assertOwner(unitOwned, accessOf(UNIT_MATE, [EXECUTE], { kind: 'UNIT_SUBTREE', refIds: [unitId(DEPARTMENT)], paths: ['/u1/u2/'] }), EXECUTE, NOW)).not.toThrow();
      expect(() => assertOwner(unitOwned, accessOf(UNIT_MATE, [EXECUTE], { kind: 'UNIT_SUBTREE', refIds: [unitId(ELSEWHERE)], paths: ['/u3/'] }), EXECUTE, NOW)).toThrow(expect.objectContaining({ code: 'NOT_OWNER' }));
      expect(() => assertOwner(unitOwned, accessOf(UNIT_MATE, [READ], { kind: 'TENANT' }), EXECUTE, NOW)).toThrow(expect.objectContaining({ code: 'NOT_OWNER' }));
      // a recommendation that was never assigned has no owner
      const open = await row((await followed()).ids[0] as string);
      expect(() => assertOwner(open, owns, EXECUTE, NOW)).toThrow(expect.objectContaining({ code: 'NOT_OWNER' }));
    });
  });

  describe('assigning (AC-ST-AUD-003-1, UAT-AC435)', () => {
    it('gives an OPEN recommendation to a unit and a person with a day inside the deadline of the conclusion, and again before work begins', async () => {
      const made = await followed();
      const recommendationId = made.ids[0] as string;
      const first = await assign(recommendationId, { ownerUserId: memberId(OWNER), dueOn: '2026-12-31' });
      expect(first.version).toBe(2);
      expect(await owner(`select status, owner_unit_id, owner_user_id, due_on::text as due_on, is_overdue from machvon.audit_recommendation where id = $1`, [recommendationId])).toEqual([
        { status: 'ASSIGNED', owner_unit_id: unitId(DEPARTMENT), owner_user_id: memberId(OWNER), due_on: '2026-12-31', is_overdue: false },
      ]);
      // another owner, another day, the same status
      await assign(recommendationId, { ownerUnitId: unitId(ROOT), dueOn: '2026-11-30' });
      expect(await owner(`select status, owner_unit_id, owner_user_id, due_on::text as due_on from machvon.audit_recommendation where id = $1`, [recommendationId])).toEqual([
        { status: 'ASSIGNED', owner_unit_id: unitId(ROOT), owner_user_id: null, due_on: '2026-11-30' },
      ]);
    });

    it('AC-ST-AUD-003-1: a day after the deadline of the conclusion is 422 DUE_AFTER_CONCLUSION_DEADLINE with the deadline, a day in the past is a field problem, and a conclusion with no deadline leaves the day to the leader', async () => {
      const made = await followed();
      expect(await refusal(assign(made.ids[0] as string, { dueOn: '2027-01-01' }))).toMatchObject({ code: 'DUE_AFTER_CONCLUSION_DEADLINE', status: 422, extensions: { implementation_due_on: '2026-12-31' } });
      expect(await refusal(assign(made.ids[0] as string, { dueOn: '2026-10-25' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_on' });
      expect(await field(made.ids[0] as string, 'status')).toBe('OPEN');
      const free = await followed([{ type: 'PROCESS_CORRECTION' }], null);
      await assign(free.ids[0] as string, { dueOn: '2030-01-01' });
      expect(await field(free.ids[0] as string, 'status')).toBe('ASSIGNED');
    });

    it('does not find a unit of another tenant or one that does not exist (404), and refuses a person who is not an active member (422)', async () => {
      const made = await followed();
      const recommendationId = made.ids[0] as string;
      expect(await refusal(as((tx) => store.resolveUnit(tx, randomUUID())))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await as((tx) => store.resolveUnit(tx, unitId(DEPARTMENT)))).toEqual({ id: unitId(DEPARTMENT), path: '/u1/u2/' });
      expect(await refusal(assign(recommendationId, { ownerUserId: memberId(SUSPENDED) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owner_user_id' });
      expect(await refusal(assign(recommendationId, { ownerUserId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owner_user_id' });
    });

    it('refuses a recommendation that is already in progress, closed or cancelled (409 RECOMMENDATION_STATE_INVALID)', async () => {
      const work = await working();
      expect(await refusal(assign(work.recommendationId))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', status: 409, detail: 'IN_PROGRESS->assign' });
      const made = await followed();
      await owner("update machvon.audit_recommendation set status = 'CANCELLED' where id = $1", [made.ids[0]]);
      expect(await refusal(assign(made.ids[0] as string))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', status: 409 });
    });
  });

  describe('planning and completing an action (AC-ST-AUD-003-2, UAT-AC436)', () => {
    it('moves ASSIGNED to IN_PROGRESS with the first action and leaves it there for the next, each action once per code', async () => {
      const made = await followed();
      const recommendationId = made.ids[0] as string;
      await assign(recommendationId, { ownerUserId: memberId(OWNER) });
      const first = await plan(recommendationId, 'A-1');
      expect(first.status).toBe('IN_PROGRESS');
      const second = await plan(recommendationId, 'A-2');
      expect(second.status).toBe('IN_PROGRESS');
      expect(second.version).toBe(first.version + 1);
      expect(await refusal(plan(recommendationId, 'A-1'))).toMatchObject({ code: 'ACTION_CODE_DUPLICATE', status: 409 });
      expect(await owner('select action_code, status, reported_by, completed_on from machvon.audit_remediation_action where recommendation_id = $1 order by action_code', [recommendationId])).toEqual([
        { action_code: 'A-1', status: 'PLANNED', reported_by: memberId(OWNER), completed_on: null },
        { action_code: 'A-2', status: 'PLANNED', reported_by: memberId(OWNER), completed_on: null },
      ]);
    });

    it('refuses an action on a recommendation that is OPEN, disputed or closed (409), an empty code and a short description (422)', async () => {
      const made = await followed();
      expect(await refusal(plan(made.ids[0] as string))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', status: 409, detail: 'OPEN->plan' });
      const work = await working();
      expect(await refusal(run(work.recommendationId, OWNER, (tx, locked) => store.plan(tx, locked, { actionCode: ' ', description: 'Correct the process.', plannedOn: '2026-11-15' }, memberId(OWNER))))).toMatchObject({ detail: 'action_code' });
      expect(await refusal(run(work.recommendationId, OWNER, (tx, locked) => store.plan(tx, locked, { actionCode: 'A-9', description: 'no', plannedOn: '2026-11-15' }, memberId(OWNER))))).toMatchObject({ detail: 'description' });
      await dispute(work.recommendationId);
      expect(await refusal(plan(work.recommendationId, 'A-3'))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', detail: 'DISPUTED->plan' });
    });

    it('AC-ST-AUD-003-2: refuses a completion with no evidence in force (422 EVIDENCE_REQUIRED: a document that is pending, missing or of another tenant), then completes it with a document in force and keeps it as evidence', async () => {
      const work = await working();
      for (const evidence of [EVIDENCE_PENDING, randomUUID()]) {
        expect(await refusal(complete(work.actionId, evidence))).toMatchObject({ code: 'EVIDENCE_REQUIRED', status: 422, detail: 'evidence_document_id' });
      }
      expect(await owner('select status from machvon.audit_remediation_action where id = $1', [work.actionId])).toEqual([{ status: 'PLANNED' }]);
      const done = await complete(work.actionId, EVIDENCE, '2026-10-24');
      expect(done.version).toBe(2);
      expect(await owner('select status, completed_on::text as completed_on, evidence_document_id from machvon.audit_remediation_action where id = $1', [work.actionId])).toEqual([
        { status: 'DONE', completed_on: '2026-10-24', evidence_document_id: EVIDENCE },
      ]);
      expect(await owner('select owner_kind, document_id, attached_by from machvon.audit_evidence where owner_id = $1', [work.actionId])).toEqual([{ owner_kind: 'ACTION', document_id: EVIDENCE, attached_by: memberId(OWNER) }]);
      expect(await refusal(complete(work.actionId, EVIDENCE_TWO))).toMatchObject({ code: 'ACTION_STATE_INVALID', status: 409 });
    });

    it('refuses a completion in the future (422), on a recommendation that is no longer in progress (409), and does not find an action outside the scope of the caller (404)', async () => {
      const work = await working();
      expect(await refusal(complete(work.actionId, EVIDENCE, '2026-10-27'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'completed_on' });
      expect(await refusal(as((tx) => store.lockAction(tx, work.actionId, seenBy(accessOf(STRANGER, [READ], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] })))))).toMatchObject({ status: 404 });
      expect(await refusal(as((tx) => store.lockAction(tx, randomUUID(), seeAll)))).toMatchObject({ status: 404 });
      expect(await refusal(as((tx) => store.lockAction(tx, work.actionId, seeAll), TENANT_B))).toMatchObject({ status: 404 });
      const locked = await actionOf(work.actionId);
      expect(locked).toMatchObject({ id: work.actionId, actionCode: 'A-1', status: 'PLANNED', plannedOn: '2026-11-15', version: 1, recommendation: { id: work.recommendationId, status: 'IN_PROGRESS' } });
      await dispute(work.recommendationId);
      expect(await refusal(complete(work.actionId))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', status: 409, detail: 'DISPUTED->complete' });
    });

    it('keeps the code of an action and a cancelled action without a completion at the table', async () => {
      const work = await working();
      await expect(owner("update machvon.audit_remediation_action set status = 'DONE', completed_on = '2026-10-24' where id = $1", [work.actionId])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.audit_remediation_action set status = 'CANCELLED', completed_on = '2026-10-24' where id = $1", [work.actionId])).rejects.toMatchObject({ constraint: 'audit_remediation_action_cancel_chk' });
      await expect(owner("update machvon.audit_remediation_action set action_code = ' ' where id = $1", [work.actionId])).rejects.toMatchObject({ constraint: 'audit_remediation_action_code_chk' });
    });
  });

  describe('reporting the work and verifying it (AC-ST-AUD-003-2, BR-AUD-08)', () => {
    it('AC-ST-AUD-003-2: refuses the report while an action is planned or none is done (422 OPEN_ACTIONS_REMAIN), then PENDING_VERIFICATION once it is done; the owner cannot verify (403 SELF_APPROVAL_DENIED) and a verifier closes it with verified_by set', async () => {
      const work = await working();
      expect(await refusal(submit(work.recommendationId))).toMatchObject({ code: 'OPEN_ACTIONS_REMAIN', status: 422 });
      await complete(work.actionId);
      await plan(work.recommendationId, 'A-2');
      expect(await refusal(submit(work.recommendationId))).toMatchObject({ code: 'OPEN_ACTIONS_REMAIN', status: 422 });
      await owner("update machvon.audit_remediation_action set status = 'CANCELLED' where recommendation_id = $1 and action_code = 'A-2'", [work.recommendationId]);
      const submitted = await submit(work.recommendationId);
      expect(submitted.version).toBeGreaterThan(2);
      expect(await owner('select status, submitted_by from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([{ status: 'PENDING_VERIFICATION', submitted_by: memberId(OWNER) }]);
      for (const member of [OWNER]) expect(await refusal(verify(work.recommendationId, member, 'CLOSE'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const closed = await verify(work.recommendationId, VERIFIER, 'CLOSE', { comment: 'Checked on site.' });
      expect(closed.status).toBe('CLOSED');
      expect(await owner('select status, verified_by, verified_at is not null as verified, verification_note from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([
        { status: 'CLOSED', verified_by: memberId(VERIFIER), verified: true, verification_note: 'Checked on site.' },
      ]);
    });

    it('refuses the one who reported the work as the verifier even when the work was given to another person', async () => {
      const work = await working();
      await complete(work.actionId);
      await owner('update machvon.audit_recommendation set owner_user_id = $2 where id = $1', [work.recommendationId, memberId(UNIT_MATE)]);
      await submit(work.recommendationId, UNIT_MATE);
      expect(await refusal(verify(work.recommendationId, UNIT_MATE, 'CLOSE'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await verify(work.recommendationId, VERIFIER, 'CLOSE')).status).toBe('CLOSED');
    });

    it('sends the work back with the words of the verifier (422 without them), and the owner reports it again', async () => {
      const work = await working();
      await complete(work.actionId);
      await submit(work.recommendationId);
      expect(await refusal(verify(work.recommendationId, VERIFIER, 'RETURN', { comment: 'short' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'comment' });
      expect(await refusal(verify(work.recommendationId, VERIFIER, 'RETURN'))).toMatchObject({ detail: 'comment' });
      const returned = await verify(work.recommendationId, VERIFIER, 'RETURN', { comment: 'The evidence does not show the second payment.' });
      expect(returned.status).toBe('IN_PROGRESS');
      expect(await owner('select status, submitted_by, verified_by, verification_note from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([
        { status: 'IN_PROGRESS', submitted_by: null, verified_by: null, verification_note: 'The evidence does not show the second payment.' },
      ]);
      await submit(work.recommendationId);
      expect(await field(work.recommendationId, 'status')).toBe('PENDING_VERIFICATION');
    });

    it('refuses a verification of work that was not reported (409), and names a basis of closure only when it is in force (422 DOCUMENT_NOT_EFFECTIVE)', async () => {
      const work = await working();
      expect(await refusal(verify(work.recommendationId, VERIFIER, 'CLOSE'))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', status: 409, detail: 'IN_PROGRESS->verifyClose' });
      await complete(work.actionId);
      await submit(work.recommendationId);
      expect(await refusal(verify(work.recommendationId, VERIFIER, 'CLOSE', { basis: EVIDENCE_PENDING }))).toMatchObject({ code: 'DOCUMENT_NOT_EFFECTIVE', status: 422 });
      expect((await verify(work.recommendationId, VERIFIER, 'CLOSE', { basis: BASIS })).status).toBe('CLOSED');
      expect(await owner('select closure_basis_document_id from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([{ closure_basis_document_id: BASIS }]);
      expect(await owner("select note from machvon.audit_evidence where owner_id = $1 and document_id = $2", [work.recommendationId, BASIS])).toEqual([{ note: 'CLOSURE_BASIS' }]);
    });

    it('holds a financial recommendation until what was recommended is recovered (422 RECOVERY_INCOMPLETE with the figures), at the report and at the closure', async () => {
      const work = await working('FINANCIAL_RECOVERY', '400000000');
      await complete(work.actionId);
      await owner('update machvon.audit_recommendation set recovered_vnd = 300000000 where id = $1', [work.recommendationId]);
      expect(await refusal(submit(work.recommendationId))).toMatchObject({
        code: 'RECOVERY_INCOMPLETE',
        status: 422,
        extensions: { amount_vnd: '400000000', recovered_vnd: '300000000', remaining_vnd: '100000000' },
      });
      await owner('update machvon.audit_recommendation set recovered_vnd = 400000000 where id = $1', [work.recommendationId]);
      await submit(work.recommendationId);
      await owner('update machvon.audit_recommendation set recovered_vnd = 350000000 where id = $1', [work.recommendationId]);
      expect(await refusal(verify(work.recommendationId, VERIFIER, 'CLOSE'))).toMatchObject({ code: 'RECOVERY_INCOMPLETE' });
      await owner('update machvon.audit_recommendation set recovered_vnd = 400000000 where id = $1', [work.recommendationId]);
      expect((await verify(work.recommendationId, VERIFIER, 'CLOSE')).status).toBe('CLOSED');
    });

    it('keeps the separation of duties at the table: a closed recommendation is not verified by its owner, its reporter or the one who disputed it', async () => {
      const work = await working();
      await complete(work.actionId);
      await submit(work.recommendationId);
      await expect(
        owner("update machvon.audit_recommendation set status = 'CLOSED', verified_by = owner_user_id, verified_at = now() where id = $1", [work.recommendationId]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        owner("update machvon.audit_recommendation set status = 'CLOSED', verified_by = $2, verified_at = now(), disputed_by = $2 where id = $1", [work.recommendationId, memberId(VERIFIER)]),
      ).rejects.toMatchObject({ constraint: 'audit_recommendation_verifier_chk' });
      await expect(owner("update machvon.audit_recommendation set submitted_by = null where id = $1", [work.recommendationId])).rejects.toMatchObject({ constraint: 'audit_recommendation_pending_chk' });
    });
  });

  describe('disputing and the answer of the authority (AC-ST-AUD-003-3, UAT-AC441)', () => {
    it('AC-ST-AUD-003-3: closes a financial recommendation of 400,000,000 with 300,000,000 recovered once the authority accepted the dispute, and refuses the decision without a document of the authority in force', async () => {
      const work = await working('FINANCIAL_RECOVERY', '400000000');
      await owner('update machvon.audit_recommendation set recovered_vnd = 300000000 where id = $1', [work.recommendationId]);
      const disputed = await dispute(work.recommendationId);
      expect(disputed.version).toBeGreaterThan(2);
      expect(await owner('select status, dispute_reason, dispute_document_id, disputed_by, dispute_outcome from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([
        { status: 'DISPUTED', dispute_reason: 'The volumes were accepted on site by the supervisor.', dispute_document_id: EXPLANATION, disputed_by: memberId(OWNER), dispute_outcome: null },
      ]);
      for (const document of [AUTHORITY_ATTACHMENT, EVIDENCE_PENDING, randomUUID()]) {
        expect(await refusal(decide(work.recommendationId, 'ACCEPTED_BY_AUTHORITY', document))).toMatchObject({ code: 'DECISION_DOCUMENT_NOT_EFFECTIVE', status: 422 });
      }
      expect(await refusal(decide(work.recommendationId, 'ACCEPTED_BY_AUTHORITY', AUTHORITY_OPINION, OWNER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const accepted = await decide(work.recommendationId, 'ACCEPTED_BY_AUTHORITY');
      expect(accepted.status).toBe('PENDING_VERIFICATION');
      expect(await refusal(verify(work.recommendationId, OWNER, 'CLOSE'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await verify(work.recommendationId, VERIFIER, 'CLOSE')).status).toBe('CLOSED');
      expect(await owner('select status, recovered_vnd::text as recovered, dispute_outcome, closure_basis_document_id, verified_by from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([
        { status: 'CLOSED', recovered: '300000000', dispute_outcome: 'ACCEPTED_BY_AUTHORITY', closure_basis_document_id: AUTHORITY_OPINION, verified_by: memberId(VERIFIER) },
      ]);
      expect(await owner("select note from machvon.audit_evidence where owner_id = $1 and document_id = $2", [work.recommendationId, AUTHORITY_OPINION])).toEqual([{ note: 'DISPUTE_DECISION:ACCEPTED_BY_AUTHORITY' }]);
    });

    it('sends the recommendation back to work when the authority rejects the dispute, and the old day counts again', async () => {
      const work = await working();
      await dispute(work.recommendationId);
      const rejected = await decide(work.recommendationId, 'REJECTED_BY_AUTHORITY');
      expect(rejected.status).toBe('IN_PROGRESS');
      expect(await owner('select status, dispute_outcome, due_on::text as due_on, closure_basis_document_id from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([
        { status: 'IN_PROGRESS', dispute_outcome: 'REJECTED_BY_AUTHORITY', due_on: '2026-12-01', closure_basis_document_id: null },
      ]);
      // a financial one is then closed only on what was recovered: the rejected dispute does not excuse the difference
      const financial = await working('FINANCIAL_RECOVERY', '400000000');
      await complete(financial.actionId);
      await dispute(financial.recommendationId);
      await decide(financial.recommendationId, 'REJECTED_BY_AUTHORITY');
      expect(await refusal(submit(financial.recommendationId))).toMatchObject({ code: 'RECOVERY_INCOMPLETE' });
    });

    it('refuses an explanation that is short or has no document in force, and a dispute from OPEN, PENDING_VERIFICATION or CLOSED (409)', async () => {
      const work = await working();
      expect(await refusal(dispute(work.recommendationId, EXPLANATION, 'too short'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'dispute_reason' });
      for (const document of [EVIDENCE_PENDING, randomUUID()]) expect(await refusal(dispute(work.recommendationId, document))).toMatchObject({ code: 'DOCUMENT_NOT_EFFECTIVE', status: 422, detail: 'dispute_document_id' });
      const open = await followed();
      expect(await refusal(dispute(open.ids[0] as string))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', status: 409, detail: 'OPEN->dispute' });
      await complete(work.actionId);
      await submit(work.recommendationId);
      expect(await refusal(dispute(work.recommendationId))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', detail: 'PENDING_VERIFICATION->dispute' });
      expect(await refusal(decide(work.recommendationId, 'REJECTED_BY_AUTHORITY'))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', detail: 'PENDING_VERIFICATION->decideRejected' });
    });

    it('may be disputed while assigned, and a new dispute clears the answer to the old one', async () => {
      const made = await followed();
      const recommendationId = made.ids[0] as string;
      await assign(recommendationId, { ownerUserId: memberId(OWNER) });
      await dispute(recommendationId);
      await decide(recommendationId, 'REJECTED_BY_AUTHORITY');
      await plan(recommendationId);
      await dispute(recommendationId, EVIDENCE_TWO, 'A second explanation with a new document.');
      expect(await owner('select status, dispute_outcome, dispute_document_id from machvon.audit_recommendation where id = $1', [recommendationId])).toEqual([
        { status: 'DISPUTED', dispute_outcome: null, dispute_document_id: EVIDENCE_TWO },
      ]);
    });
  });

  describe('the table holds the edges and the money', () => {
    it('refuses a step the state machine does not know, whoever writes it', async () => {
      const made = await followed();
      const recommendationId = made.ids[0] as string;
      for (const to of ['CLOSED', 'IN_PROGRESS', 'PENDING_VERIFICATION', 'DISPUTED']) {
        await expect(owner('update machvon.audit_recommendation set status = $2 where id = $1', [recommendationId, to])).rejects.toMatchObject({ code: '23514', constraint: 'audit_recommendation_edges_guard' });
      }
      await owner("update machvon.audit_recommendation set status = 'CANCELLED' where id = $1", [recommendationId]);
      await expect(owner("update machvon.audit_recommendation set status = 'ASSIGNED' where id = $1", [recommendationId])).rejects.toMatchObject({ constraint: 'audit_recommendation_edges_guard' });
    });

    it('lets the system reopen a closed recommendation', async () => {
      const work = await working();
      await complete(work.actionId);
      await submit(work.recommendationId);
      await verify(work.recommendationId, VERIFIER, 'CLOSE');
      await owner("update machvon.audit_recommendation set status = 'IN_PROGRESS', verified_by = null, verified_at = null where id = $1", [work.recommendationId]);
      expect(await field(work.recommendationId, 'status')).toBe('IN_PROGRESS');
    });

    it('freezes the amount and the type of a recommendation once it is assigned (a change of amount needs an amended conclusion)', async () => {
      const made = await followed([{ type: 'FINANCIAL_RECOVERY', amount: '100000000' }]);
      const recommendationId = made.ids[0] as string;
      await owner('update machvon.audit_recommendation set amount_vnd = 120000000 where id = $1', [recommendationId]);
      await assign(recommendationId);
      await expect(owner('update machvon.audit_recommendation set amount_vnd = 130000000 where id = $1', [recommendationId])).rejects.toMatchObject({ code: '23514', constraint: 'audit_recommendation_frozen_guard' });
      await expect(owner("update machvon.audit_recommendation set rec_type = 'FINANCIAL_ADJUSTMENT' where id = $1", [recommendationId])).rejects.toMatchObject({ constraint: 'audit_recommendation_frozen_guard' });
      await owner('update machvon.audit_recommendation set recovered_vnd = 50000000 where id = $1', [recommendationId]);
      expect(await field(recommendationId, 'recovered_vnd::text')).toBe('50000000');
    });

    it('keeps the words and the document of a dispute together', async () => {
      const made = await followed();
      await expect(owner("update machvon.audit_recommendation set dispute_reason = 'only the words of an explanation' where id = $1", [made.ids[0]])).rejects.toMatchObject({ constraint: 'audit_recommendation_dispute_pair_chk' });
    });
  });

  describe('evidence', () => {
    it('puts a document in force in the register of an engagement, a finding, a recommendation or an action, once, and finds the owner only inside the scope of the caller', async () => {
      const work = await working();
      const finding = await as((tx) =>
        conclusions
          .lock(tx, work.conclusionId, everything, everything)
          .then((locked) =>
            conclusions.recordFinding(
              tx,
              locked,
              { findingCode: 'F-EVIDENCE', category: 'FINANCIAL', projectId: undefined, contractId: undefined, organizationUnitId: undefined, description: 'Payment above the volume accepted.', legalBasisCited: undefined, amountVnd: undefined, severity: 'HIGH' },
              memberId(COORDINATOR),
            ),
          ),
      );
      const scopes = { recommendations: seeAll, engagements: everything };
      for (const [ownerKind, ownerId] of [
        ['ENGAGEMENT', work.engagementId],
        ['FINDING', finding.id],
        ['RECOMMENDATION', work.recommendationId],
        ['ACTION', work.actionId],
      ] as const) {
        const located = await as((tx) => store.locateEvidenceOwner(tx, ownerKind, ownerId, scopes));
        expect(located).toEqual({ recommendationId: ownerKind === 'RECOMMENDATION' || ownerKind === 'ACTION' ? work.recommendationId : null, engagementId: work.engagementId });
        const first = await as((tx) => store.attachEvidence(tx, { ownerKind, ownerId, documentId: EVIDENCE, note: ' A working document. ' }, memberId(COORDINATOR)));
        const again = await as((tx) => store.attachEvidence(tx, { ownerKind, ownerId, documentId: EVIDENCE, note: undefined }, memberId(COORDINATOR)));
        expect(again.id).toBe(first.id);
        expect(await owner('select note, attached_by from machvon.audit_evidence where id = $1', [first.id])).toEqual([{ note: 'A working document.', attached_by: memberId(COORDINATOR) }]);
        const hidden = { recommendations: seenBy(accessOf(STRANGER, [READ], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] })), engagements: nothing };
        expect(await as((tx) => store.locateEvidenceOwner(tx, ownerKind, ownerId, hidden))).toBeUndefined();
        expect(await as((tx) => store.locateEvidenceOwner(tx, ownerKind, randomUUID(), scopes))).toBeUndefined();
        expect(await as((tx) => store.locateEvidenceOwner(tx, ownerKind, ownerId, scopes), TENANT_B)).toBeUndefined();
      }
    });

    it('refuses a document that is not in force or does not exist (422 DOCUMENT_NOT_EFFECTIVE) and stores an empty note as none', async () => {
      const work = await working();
      for (const documentId of [EVIDENCE_PENDING, randomUUID()]) {
        expect(await refusal(as((tx) => store.attachEvidence(tx, { ownerKind: 'ENGAGEMENT', ownerId: work.engagementId, documentId, note: undefined }, memberId(COORDINATOR))))).toMatchObject({ code: 'DOCUMENT_NOT_EFFECTIVE', status: 422 });
      }
      const attached = await as((tx) => store.attachEvidence(tx, { ownerKind: 'ENGAGEMENT', ownerId: work.engagementId, documentId: EVIDENCE_TWO, note: '   ' }, memberId(COORDINATOR)));
      expect(await owner('select note from machvon.audit_evidence where id = $1', [attached.id])).toEqual([{ note: null }]);
    });
  });

  describe('reading the recommendations', () => {
    it('lists them by code with the owner, the day, the dispute, the actions with their evidence and the count of evidence, a cursor and the filters of the screens', async () => {
      const made = await followed([{ type: 'PROCESS_CORRECTION' }, { type: 'REFERRAL' }, { type: 'FINANCIAL_RECOVERY', amount: '1000' }]);
      const [first, second, third] = made.ids as [string, string, string];
      await assign(first, { ownerUserId: memberId(OWNER), dueOn: '2026-12-01' });
      const planned = await plan(first, 'A-1');
      await complete(planned.actionId);
      await assign(second);
      await dispute(second);
      const page = (extra: Record<string, unknown> = {}, scope: ScopeBuilder = seeAll, tenant = TENANT_A) => as((tx) => store.list(tx, scope, { limit: 10, after: undefined, conclusionId: made.conclusionId, ...extra }), tenant);
      const lines = await page();
      expect(lines.map((line) => line.id)).toEqual([first, second, third].sort((a, b) => (lines.find((line) => line.id === a)?.recCode ?? '').localeCompare(lines.find((line) => line.id === b)?.recCode ?? '')));
      const byId = new Map(lines.map((line) => [line.id, line]));
      expect(byId.get(first)).toMatchObject({
        conclusionId: made.conclusionId,
        engagement: { id: made.engagementId },
        ownerUnit: { id: unitId(DEPARTMENT), name: expect.any(String) },
        ownerUser: { id: memberId(OWNER), name: 'User 2' },
        dueOn: '2026-12-01',
        status: 'IN_PROGRESS',
        isOverdue: false,
        evidenceCount: 1,
        actions: [{ id: planned.actionId, actionCode: 'A-1', status: 'DONE', completedOn: '2026-10-24', evidenceDocumentId: EVIDENCE, evidenceAttachedBy: { id: memberId(OWNER), name: 'User 2' }, evidenceAttachedAt: expect.any(String), version: 2 }],
      });
      expect(byId.get(second)).toMatchObject({ status: 'DISPUTED', disputeReason: 'The volumes were accepted on site by the supervisor.', disputedBy: memberId(OWNER), disputeOutcome: null, ownerUser: null, actions: [], evidenceCount: 1 });
      expect(byId.get(third)).toMatchObject({ status: 'OPEN', ownerUnit: null, amountVnd: '1000', recoveredVnd: '0', version: 1 });
      expect((await page({ status: 'ASSIGNED' })).length).toBe(0);
      expect((await page({ status: 'OPEN' })).map((line) => line.id)).toEqual([third]);
      expect((await page({ recType: 'REFERRAL' })).map((line) => line.id)).toEqual([second]);
      expect((await page({ ownerUnitId: unitId(DEPARTMENT) })).length).toBe(2);
      expect((await page({ overdue: false })).length).toBe(3);
      expect(await page({ overdue: true })).toEqual([]);
      const limited = await page({ limit: 2 });
      const last = limited[1] as { recCode: string; id: string };
      expect((await page({ after: { code: last.recCode, id: last.id } })).length).toBe(1);
      expect((await page({ engagementId: made.engagementId, conclusionId: undefined })).length).toBe(3);
      expect(await page({}, seenBy(accessOf(STRANGER, [READ], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] })))).toEqual([]);
      expect(await page({}, seeAll, TENANT_B)).toEqual([]);
    });

    it('shows an owner what was given to them without the engagement, and no other', async () => {
      const made = await followed([{ type: 'PROCESS_CORRECTION' }, { type: 'PROCESS_CORRECTION' }]);
      await assign(made.ids[0] as string, { ownerUserId: memberId(OWNER) });
      await assign(made.ids[1] as string, { ownerUserId: memberId(UNIT_MATE) });
      const mine = seenBy(accessOf(OWNER, [EXECUTE], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] }));
      const lines = await as((tx) => store.list(tx, mine, { limit: 10, after: undefined, conclusionId: made.conclusionId }), TENANT_A, OWNER);
      expect(lines.map((line) => line.id)).toEqual([made.ids[0]]);
    });
  });
});
