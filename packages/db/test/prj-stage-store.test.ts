import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import type { MasterRules, NationalCodeRule } from '../src/master-rules';
import { PrjProjectStore, projectScope } from '../src/prj-project-store';
import type { ProjectStatus } from '../src/prj-project-store';
import { PLAN_PUBLISHED_EVENT, STAGE_COMMANDS, STAGE_TRANSITIONS } from '../src/prj-stage-machine';
import type { StageCommand } from '../src/prj-stage-machine';
import { PrjStageStore, SqlProjectObligations, stageChangeRecord } from '../src/prj-stage-store';
import type { OpenObligations, ProjectObligationsPort, StageInput } from '../src/prj-stage-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const ACTOR = 1;
const OTHER_ACTOR = 2;
const WORKER = '00000000-0000-4000-8000-000000000000';
const TODAY = vietnamDateOf(new Date());
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const NO_OBLIGATIONS: OpenObligations = { committedVnd: '0', disbursedVnd: '0', activeReservations: 0 };

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(ACTOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const subtree = (permission: string, unit: number, path: string): ScopeBuilder => projectScope(grant(permission, { kind: 'UNIT_SUBTREE', refIds: [unitId(unit)], paths: [path] }), permission, new Date());

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

const sqlState = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
};

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

async function document(options: { status?: string } = {}, tenant = TENANT_A): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
    [tenant, id, `QD-${id.slice(0, 8)}/2026`, options.status ?? 'EFFECTIVE', memberId(ACTOR)],
    tenant,
  );
  return id;
}

interface Seeded {
  id: string;
  code: string;
  version: number;
}

/** A project of the register moved straight to a stage by the owner, the way the stories that come before this one will leave it. */
async function project(
  status: ProjectStatus,
  options: { code?: string; nationalCode?: string | null; group?: string | null; score?: string | null; unit?: number; changedAt?: string; tenant?: string } = {},
): Promise<Seeded> {
  counter += 1;
  const tenant = options.tenant ?? TENANT_A;
  const code = options.code ?? `ST-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as(
    (tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(options.unit ?? DEPARTMENT), areaMasterVersionId: tenant === TENANT_A ? areaVersion : areaVersionB, totalInvestmentVnd: '500000000000' }, memberId(ACTOR), TODAY),
    tenant,
  );
  await owner(
    `update machvon.project set status = $2, project_group = $3, national_project_code = $4, appraisal_score = $5::numeric, status_changed_at = coalesce($6::timestamptz, status_changed_at) where id = $1::uuid`,
    [created.id, status, options.group === undefined ? 'B' : options.group, options.nationalCode === undefined ? String(7000000 + counter) : options.nationalCode, options.score ?? null, options.changedAt ?? null],
    tenant,
  );
  return { id: created.id, code, version: 1 };
}

const row = async (projectId: string) => (await owner<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [projectId]))[0];
const history = (projectId: string) =>
  owner<Record<string, unknown>>('select project_version::text as project_version, from_stage, to_stage, operation, actor_kind, actor_id, decision_document_id, reason, effective_date::text as effective_date, source_event_id from machvon.project_stage_change where project_id = $1::uuid order by project_version', [projectId]);

const portOf = (open: Partial<OpenObligations> = {}): ProjectObligationsPort => ({ openObligations: async () => ({ ...NO_OBLIGATIONS, ...open }) });
const stage = new PrjStageStore(undefined, portOf());

async function move(command: StageCommand, target: Seeded, input: Partial<StageInput> = {}, options: { store?: PrjStageStore; version?: number; act?: ScopeBuilder; read?: ScopeBuilder; actor?: number } = {}) {
  return as(
    (tx) =>
      (options.store ?? stage).transition(tx, {
        command,
        projectId: target.id,
        expectedVersion: options.version ?? target.version,
        actor: memberId(options.actor ?? ACTOR),
        scopes: { act: options.act ?? everything, read: options.read ?? everything },
        input: { reason: 'A reason for the move', ...input },
        today: TODAY,
      }),
    TENANT_A,
    options.actor ?? ACTOR,
  );
}

/** The documents a command takes, supplied. */
async function grounds(command: StageCommand): Promise<Partial<StageInput>> {
  const id = await document();
  return command === 'startProjectImplementation' ? { investmentDecisionDocumentId: id } : { decisionDocumentId: id };
}

interface FundedPlan {
  planId: string;
  documentId: string;
  lines: Record<string, string>;
}

/** A capital plan with one line per project; the plan is PUBLISHED unless said otherwise and a line carries the amount it is given. */
async function plan(lines: ReadonlyArray<{ project: Seeded; amount: string }>, status = 'PUBLISHED'): Promise<FundedPlan> {
  counter += 1;
  const planId = randomUUID();
  const documentId = await document();
  await owner(
    `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
     values ($1, $2, $3, 'ANNUAL', 2026, 2026, 2026, $4, 1, $5, $6, now(), $7, $7)`,
    [TENANT_A, planId, `CP-${counter}-${planId.slice(0, 6)}`, unitId(PROVINCE), status, documentId, memberId(ACTOR)],
  );
  const created: Record<string, string> = {};
  for (const line of lines) {
    const versionId = randomUUID();
    const lineId = randomUUID();
    created[line.project.id] = lineId;
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id, created_by, updated_by)
         values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now(), $5, $6, $6)`,
        [TENANT_A, versionId, line.project.id, randomUUID(), planId, memberId(ACTOR)],
      ],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, created_by, updated_by)
         values ($1, $2, $3, $4, 'CURRENT_YEAR', 2026, $5::numeric, 0, $6, $7, $7)`,
        [TENANT_A, lineId, versionId, areaVersion, line.amount, line.project.id, memberId(ACTOR)],
      ],
    ]);
  }
  return { planId, documentId, lines: created };
}

const consume = (funded: FundedPlan, projectIds: readonly string[], eventId = randomUUID(), tenant = TENANT_A) =>
  as((tx) => stage.budgetFromPublishedPlan(tx, { capitalPlanId: funded.planId, projectIds, eventId, actor: WORKER }), tenant);

jest.setTimeout(120_000);

describe('PrjStageStore (guarded PIMA lifecycle transitions, ST-PRJ-002)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, ACTOR, PROVINCE);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    await harness.seedMembership(TENANT_A, OTHER_ACTOR, DEPARTMENT);
    areaVersion = await seedArea(TENANT_A);
    areaVersionB = await seedArea(TENANT_B);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the pairs of stages', () => {
    it('refuses to start implementation and to close a CONCEPT project with 409 STAGE_TRANSITION_DENIED and leaves it as it was (AC-ST-PRJ-002-1)', async () => {
      const concept = await project('CONCEPT');
      const before = await row(concept.id);
      expect(await refusal(move('startProjectImplementation', concept, await grounds('startProjectImplementation')))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      expect(await refusal(move('closeProject', concept))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      expect(await row(concept.id)).toEqual(before);
      expect(await history(concept.id)).toEqual([]);
    });

    it('refuses every command from every stage the table does not give it, terminal stages included, and moves nothing (AC-ST-PRJ-002-2)', async () => {
      const stages: ProjectStatus[] = ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED'];
      let refused = 0;
      for (const from of stages) {
        const target = await project(from);
        const before = await row(target.id);
        for (const command of STAGE_COMMANDS) {
          if (STAGE_TRANSITIONS.some((edge) => edge.by === command && edge.from === from)) continue;
          expect(await refusal(move(command, target, await grounds(command)))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
          refused += 1;
        }
        expect(await row(target.id)).toEqual(before);
        expect(await history(target.id)).toEqual([]);
      }
      // Eleven stages times six commands is 66 attempts, and the table gives the commands of the module 9 edges between them.
      expect(refused).toBe(66 - STAGE_TRANSITIONS.filter((edge) => (STAGE_COMMANDS as readonly string[]).includes(edge.by)).length);
    });

    it('makes every pair the table gives a command, bumps the version and writes one row of history for each (AC-ST-PRJ-002-2)', async () => {
      for (const edge of STAGE_TRANSITIONS.filter((candidate) => (STAGE_COMMANDS as readonly string[]).includes(candidate.by))) {
        const command = edge.by as StageCommand;
        const target = await project(edge.from);
        const given = await grounds(command);
        const change = await move(command, target, given);
        expect(change).toMatchObject({ projectId: target.id, from: edge.from, to: edge.to, version: 2, operation: command, actorKind: 'USER', actorId: memberId(ACTOR), reason: 'A reason for the move' });
        expect(await row(target.id)).toMatchObject({ status: edge.to, version: '2', updated_by: memberId(ACTOR) });
        expect(await history(target.id)).toEqual([
          {
            project_version: '2',
            from_stage: edge.from,
            to_stage: edge.to,
            operation: command,
            actor_kind: 'USER',
            actor_id: memberId(ACTOR),
            decision_document_id: given.investmentDecisionDocumentId ?? given.decisionDocumentId ?? null,
            reason: 'A reason for the move',
            effective_date: null,
            source_event_id: null,
          },
        ]);
      }
    });

    it('walks a project through the whole life cycle with the system moves in between, one version per move', async () => {
      const walked = await project('BUDGETED');
      let version = 1;
      const step = async (command: StageCommand): Promise<ProjectStatus> => {
        const change = await move(command, { ...walked, version }, await grounds(command));
        version = change.version;
        return change.to;
      };
      expect(await step('startProjectImplementation')).toBe('IMPLEMENTATION');
      expect(await step('suspendProject')).toBe('SUSPENDED');
      expect(await step('resumeProject')).toBe('IMPLEMENTATION');
      expect(await step('completeProject')).toBe('COMPLETED');
      // Settlement is the system's move (PAY, ST-PRJ-011); the owner stands in for it here.
      await owner(`update machvon.project set status = 'SETTLED', version = version + 1 where id = $1::uuid`, [walked.id]);
      version += 1;
      expect(await step('closeProject')).toBe('CLOSED');
      expect(await refusal(move('cancelProject', { ...walked, version }, await grounds('cancelProject')))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      expect((await history(walked.id)).map((entry) => `${entry.from_stage}>${entry.to_stage}`)).toEqual([
        'BUDGETED>IMPLEMENTATION',
        'IMPLEMENTATION>SUSPENDED',
        'SUSPENDED>IMPLEMENTATION',
        'IMPLEMENTATION>COMPLETED',
        'SETTLED>CLOSED',
      ]);
    });
  });

  describe('the guards of a command', () => {
    it('needs the investment decision to start implementation: absent, of another tenant, recalled or unknown is 422 DECISION_REQUIRED', async () => {
      const budgeted = await project('BUDGETED');
      const refused = { code: 'DECISION_REQUIRED', status: 422, detail: 'investment_decision_document_id' };
      expect(await refusal(move('startProjectImplementation', budgeted))).toEqual(refused);
      expect(await refusal(move('startProjectImplementation', budgeted, { investmentDecisionDocumentId: await document({}, TENANT_B) }))).toEqual(refused);
      expect(await refusal(move('startProjectImplementation', budgeted, { investmentDecisionDocumentId: await document({ status: 'RECALLED' }) }))).toEqual(refused);
      expect(await refusal(move('startProjectImplementation', budgeted, { investmentDecisionDocumentId: randomUUID() }))).toEqual(refused);
      expect(await refusal(move('startProjectImplementation', budgeted, { investmentDecisionDocumentId: 'not-a-uuid' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'investment_decision_document_id' });
      expect(await row(budgeted.id)).toMatchObject({ status: 'BUDGETED', version: '1', investment_decision_document_id: null });
    });

    it('stores the investment decision with the project and carries it into the history, lower-cased, when implementation starts', async () => {
      const budgeted = await project('BUDGETED');
      const decision = await document({ status: 'PENDING' });
      const change = await move('startProjectImplementation', budgeted, { investmentDecisionDocumentId: decision.toUpperCase(), effectiveDate: '2026-11-01' });
      expect(change).toMatchObject({ to: 'IMPLEMENTATION', decisionDocumentId: decision, effectiveDate: '2026-11-01' });
      expect(await row(budgeted.id)).toMatchObject({ investment_decision_document_id: decision });
      expect(await history(budgeted.id)).toMatchObject([{ decision_document_id: decision, effective_date: '2026-11-01' }]);
    });

    it('requires the national project code by the rule of the day: missing is 422 NATIONAL_CODE_REQUIRED, a code of the wrong shape is 422 NATIONAL_CODE_FORMAT_INVALID', async () => {
      const missing = await project('BUDGETED', { nationalCode: null });
      expect(await refusal(move('startProjectImplementation', missing, await grounds('startProjectImplementation')))).toEqual({ code: 'NATIONAL_CODE_REQUIRED', status: 422, detail: 'national_project_code' });
      const malformed = await project('BUDGETED', { nationalCode: 'ABC-1' });
      expect(await refusal(move('startProjectImplementation', malformed, await grounds('startProjectImplementation')))).toEqual({ code: 'NATIONAL_CODE_FORMAT_INVALID', status: 422, detail: 'national_project_code' });
      for (const refused of [missing, malformed]) expect(await row(refused.id)).toMatchObject({ status: 'BUDGETED', version: '1' });
      expect((await move('startProjectImplementation', await project('BUDGETED'), await grounds('startProjectImplementation'))).to).toBe('IMPLEMENTATION');
    });

    it('lets a rule in WARN mode through and says so, lets a project through when no rule is in force or the rule starts at a later stage, and reads an unknown stage as required', async () => {
      const ruleOf = (overrides: Partial<NationalCodeRule>): MasterRules =>
        ({ nationalCode: async () => ({ mode: 'BLOCK', fromStageKey: 'PIPELINE', format: null, reading: {}, ...overrides }) as NationalCodeRule }) as unknown as MasterRules;
      const none = { nationalCode: async () => undefined } as unknown as MasterRules;
      const startWith = async (rules: MasterRules, code: string | null) => {
        const budgeted = await project('BUDGETED', { nationalCode: code });
        return refusal(move('startProjectImplementation', budgeted, await grounds('startProjectImplementation'), { store: new PrjStageStore(rules, portOf()) })).catch(() => 'went through');
      };
      expect(await startWith(none, null)).toBe('went through');
      expect(await startWith(ruleOf({ fromStageKey: 'COMPLETED' }), null)).toBe('went through');
      expect(await startWith(ruleOf({ fromStageKey: 'NO_SUCH_STAGE' }), null)).toMatchObject({ code: 'NATIONAL_CODE_REQUIRED' });
      expect(await startWith(ruleOf({ mode: 'BLOCK' }), null)).toMatchObject({ code: 'NATIONAL_CODE_REQUIRED' });
      const warned = await project('BUDGETED', { nationalCode: null });
      const change = await move('startProjectImplementation', warned, await grounds('startProjectImplementation'), { store: new PrjStageStore(ruleOf({ mode: 'WARN' }), portOf()) });
      expect(change).toMatchObject({ to: 'IMPLEMENTATION', nationalCodeWarning: true });
      expect(stageChangeRecord(change, TENANT_A, new Date()).audit.diff).toMatchObject({ national_code_warning: true });
    });

    it('needs the document of suspension, completion and cancellation, takes one on resumption and closure when it is given, and refuses a document sent to a command that does not take it', async () => {
      const running = await project('IMPLEMENTATION');
      expect(await refusal(move('suspendProject', running))).toEqual({ code: 'DECISION_REQUIRED', status: 422, detail: 'decision_document_id' });
      expect(await refusal(move('completeProject', running))).toEqual({ code: 'DECISION_REQUIRED', status: 422, detail: 'decision_document_id' });
      expect(await refusal(move('suspendProject', running, { investmentDecisionDocumentId: await document() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'investment_decision_document_id' });
      expect(await refusal(move('suspendProject', running, { ...(await grounds('suspendProject')), policyProposalDocumentId: await document() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'policy_proposal_document_id' });
      const budgeted = await project('BUDGETED');
      expect(await refusal(move('startProjectImplementation', budgeted, { ...(await grounds('startProjectImplementation')), decisionDocumentId: await document() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision_document_id' });
      const suspended = await project('SUSPENDED');
      expect((await move('resumeProject', suspended)).decisionDocumentId).toBeNull();
      const again = await project('SUSPENDED');
      const named = await document();
      expect((await move('resumeProject', again, { decisionDocumentId: named })).decisionDocumentId).toBe(named);
      const settled = await project('SETTLED');
      expect((await move('closeProject', settled, { decisionDocumentId: named })).decisionDocumentId).toBe(named);
    });

    it('refuses to cancel while capital is committed or paid or a reservation is active, and to close while it is committed or reserved, 409 OPEN_OBLIGATIONS_EXIST', async () => {
      const refused = { code: 'OPEN_OBLIGATIONS_EXIST', status: 409 };
      const cancelWith = async (open: Partial<OpenObligations>, from: ProjectStatus = 'BUDGETED') => {
        const target = await project(from);
        return { target, outcome: await refusal(move('cancelProject', target, await grounds('cancelProject'), { store: new PrjStageStore(undefined, portOf(open)) })).catch(() => 'cancelled') };
      };
      for (const open of [{ committedVnd: '1' }, { disbursedVnd: '5000' }, { activeReservations: 1 }]) {
        const { target, outcome } = await cancelWith(open);
        expect(outcome).toEqual(refused);
        expect(await row(target.id)).toMatchObject({ status: 'BUDGETED', version: '1' });
      }
      expect((await cancelWith({ committedVnd: '0.00' })).outcome).toBe('cancelled');
      const closeWith = async (open: Partial<OpenObligations>) => {
        const target = await project('SETTLED');
        return refusal(move('closeProject', target, {}, { store: new PrjStageStore(undefined, portOf(open)) })).catch(() => 'closed');
      };
      expect(await closeWith({ committedVnd: '10' })).toEqual(refused);
      expect(await closeWith({ activeReservations: 2 })).toEqual(refused);
      // Money that was paid is what a settled project is made of: it does not keep the project open.
      expect(await closeWith({ disbursedVnd: '500000000000' })).toBe('closed');
    });

    it('reads the obligations from the allocation balances and the reservations of CAP', async () => {
      const funded = await project('BUDGETED');
      const real = new PrjStageStore(undefined, new SqlProjectObligations());
      expect((await move('cancelProject', funded, await grounds('cancelProject'), { store: real })).to).toBe('CANCELLED');

      const holder = await project('BUDGETED');
      const lines = await plan([{ project: holder, amount: '1000' }]);
      await owner(`insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, committed_vnd, disbursed_vnd) values ($1, $2, $3, 1000, 0, 400)`, [TENANT_A, randomUUID(), lines.lines[holder.id]]);
      const port = new SqlProjectObligations();
      expect(await as((tx) => port.openObligations(tx, holder.id))).toEqual({ committedVnd: '0', disbursedVnd: '400', activeReservations: 0 });
      expect(await refusal(move('cancelProject', holder, await grounds('cancelProject'), { store: real }))).toEqual({ code: 'OPEN_OBLIGATIONS_EXIST', status: 409 });

      const reserved = await project('SETTLED');
      const reservedPlan = await plan([{ project: reserved, amount: '1000' }]);
      const reserve = (status: string, releaseReason: string | null) =>
        owner(
          `insert into machvon.fund_reservation (tenant_id, id, allocation_line_id, project_id, purpose, amount_vnd, expires_at, status, release_reason, created_by, updated_by)
           values ($1, $2, $3, $4, 'OTHER', 10, now() + interval '1 day', $5, $6, $7, $7)`,
          [TENANT_A, randomUUID(), reservedPlan.lines[reserved.id], reserved.id, status, releaseReason, memberId(ACTOR)],
        );
      await reserve('ACTIVE', null);
      await reserve('RELEASED', 'Not needed any more');
      expect(await as((tx) => port.openObligations(tx, reserved.id))).toEqual({ committedVnd: '0', disbursedVnd: '0', activeReservations: 1 });
      expect(await refusal(move('closeProject', reserved, {}, { store: real }))).toEqual({ code: 'OPEN_OBLIGATIONS_EXIST', status: 409 });
      await owner(`update machvon.fund_reservation set status = 'CONSUMED' where project_id = $1::uuid`, [reserved.id]);
      expect((await move('closeProject', reserved, {}, { store: real })).to).toBe('CLOSED');
    });
  });

  describe('the request', () => {
    it('refuses a stale version with 409 VERSION_CONFLICT before it looks at the stage, and a second caller on the same version after the first moved it', async () => {
      const budgeted = await project('BUDGETED');
      const given = await grounds('startProjectImplementation');
      const stale = await refusal(move('startProjectImplementation', { ...budgeted, version: 7 }, given));
      expect(stale).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      const results = await Promise.allSettled([move('startProjectImplementation', budgeted, given), move('startProjectImplementation', budgeted, given)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await history(budgeted.id)).toHaveLength(1);
    });

    it('keeps the reason as typed after trimming, with its line breaks, and refuses one that is short, long or has a control character', async () => {
      const running = await project('IMPLEMENTATION');
      const given = await grounds('suspendProject');
      for (const reason of ['  ', 'four', 'x'.repeat(2001), 'bell\u0007here ok']) {
        expect(await refusal(move('suspendProject', running, { ...given, reason }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      }
      const change = await move('suspendProject', running, { ...given, reason: '  Weather stops the works.\nResumes in spring.  ' });
      expect(change.reason).toBe('Weather stops the works.\nResumes in spring.');
      expect(await history(running.id)).toMatchObject([{ reason: 'Weather stops the works.\nResumes in spring.' }]);
    });

    it('checks the effective date as a real calendar date', async () => {
      const running = await project('IMPLEMENTATION');
      const given = await grounds('suspendProject');
      for (const effectiveDate of ['2026-02-30', '26-01-01', '2026-13-01', 'tomorrow']) {
        expect(await refusal(move('suspendProject', running, { ...given, effectiveDate }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_date' });
      }
      expect((await move('suspendProject', running, { ...given, effectiveDate: '2028-02-29' })).effectiveDate).toBe('2028-02-29');
    });

    it('judges the scope of the command: a project out of sight is 404, one that can be read but not acted on is 403', async () => {
      const inDepartment = await project('IMPLEMENTATION', { unit: DEPARTMENT });
      const elsewhere = await project('IMPLEMENTATION', { unit: OTHER_BRANCH });
      const given = await grounds('suspendProject');
      const act = subtree('project.stage.suspend', DEPARTMENT, '/u1/u2/');
      const read = subtree('project.read', DEPARTMENT, '/u1/u2/');
      expect(await refusal(move('suspendProject', elsewhere, given, { act, read }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(move('suspendProject', elsewhere, given, { act: nothing, read: everything }))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(move('suspendProject', { ...inDepartment, id: randomUUID() }, given, { act, read }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await move('suspendProject', inDepartment, given, { act, read })).to).toBe('SUSPENDED');
      expect(await row(elsewhere.id)).toMatchObject({ status: 'IMPLEMENTATION', version: '1' });
    });

    it('does not see a project of another tenant', async () => {
      const foreign = await project('IMPLEMENTATION', { tenant: TENANT_B });
      expect(await refusal(move('suspendProject', foreign, await grounds('suspendProject')))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await owner('select status from machvon.project where id = $1::uuid', [foreign.id], TENANT_B)).toEqual([{ status: 'IMPLEMENTATION' }]);
    });
  });

  describe('capital.plan_published.v1 (AC-ST-PRJ-002-3)', () => {
    it('makes a funded project of the pipeline BUDGETED once, by the system, on the decision of the plan, and does nothing for a repeated event', async () => {
      const waiting = await project('PIPELINE');
      const funded = await plan([{ project: waiting, amount: '1000000' }]);
      const eventId = randomUUID();
      const first = await consume(funded, [waiting.id, waiting.id], eventId);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ projectId: waiting.id, from: 'PIPELINE', to: 'BUDGETED', version: 2, actorKind: 'SYSTEM', actorId: WORKER, decisionDocumentId: funded.documentId, reason: null, sourceEventId: eventId, operation: PLAN_PUBLISHED_EVENT });
      expect(await consume(funded, [waiting.id], eventId)).toEqual([]);
      expect(await consume(funded, [waiting.id])).toEqual([]);
      expect(await row(waiting.id)).toMatchObject({ status: 'BUDGETED', version: '2', updated_by: WORKER });
      expect(await history(waiting.id)).toMatchObject([{ from_stage: 'PIPELINE', to_stage: 'BUDGETED', actor_kind: 'SYSTEM', actor_id: WORKER, source_event_id: eventId, reason: null, decision_document_id: funded.documentId }]);
    });

    it('leaves alone a project that is in another stage, has a line of nothing, is not in the plan, or belongs to another tenant', async () => {
      const inConcept = await project('CONCEPT');
      const unfunded = await project('PIPELINE');
      const absent = await project('PIPELINE');
      const funded = await project('PIPELINE');
      const foreign = await project('PIPELINE', { tenant: TENANT_B });
      const published = await plan([
        { project: inConcept, amount: '10' },
        { project: unfunded, amount: '0' },
        { project: funded, amount: '10' },
      ]);
      const changed = await consume(published, [inConcept.id, unfunded.id, absent.id, funded.id, foreign.id]);
      expect(changed.map((change) => change.projectId)).toEqual([funded.id]);
      for (const untouched of [inConcept, unfunded, absent]) expect(await row(untouched.id)).toMatchObject({ version: '1' });
      expect(await owner('select status from machvon.project where id = $1::uuid', [foreign.id], TENANT_B)).toEqual([{ status: 'PIPELINE' }]);
    });

    it('moves nothing for a plan that is not published, does not exist, or names no project', async () => {
      const target = await project('PIPELINE');
      const draft = await plan([{ project: target, amount: '10' }], 'APPROVED');
      expect(await consume(draft, [target.id])).toEqual([]);
      expect(await consume({ ...draft, planId: randomUUID() }, [target.id])).toEqual([]);
      const published = await plan([{ project: target, amount: '10' }]);
      expect(await consume(published, [])).toEqual([]);
      expect(await row(target.id)).toMatchObject({ status: 'PIPELINE', version: '1' });
    });
  });

  describe('the history of the database', () => {
    it('keeps a stage change for good: neither the guard nor the grants let the runtime role change or delete it', async () => {
      const target = await project('IMPLEMENTATION');
      await move('suspendProject', target, await grounds('suspendProject'));
      expect(await sqlState(as((tx) => tx.query(`update machvon.project_stage_change set reason = 'rewritten' where project_id = $1::uuid`, [target.id])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.project_stage_change where project_id = $1::uuid', [target.id])))).toBe('42501');
      expect(await sqlState(owner(`update machvon.project_stage_change set reason = 'rewritten' where project_id = $1::uuid`, [target.id]))).toBe('23514');
      expect(await sqlState(owner('delete from machvon.project_stage_change where project_id = $1::uuid', [target.id]))).toBe('23514');
      expect(await history(target.id)).toMatchObject([{ reason: 'A reason for the move' }]);
    });

    it('holds the shape of a row: a member explains the move, the system names its event, a terminal stage leads nowhere, one move per version', async () => {
      const target = await project('IMPLEMENTATION');
      const insert = (overrides: Record<string, unknown>) => {
        const values = { from: 'IMPLEMENTATION', to: 'SUSPENDED', kind: 'USER', reason: 'why', event: null, version: 2, ...overrides };
        return owner(
          `insert into machvon.project_stage_change (tenant_id, id, project_id, project_version, from_stage, to_stage, operation, actor_kind, actor_id, reason, source_event_id)
           values ($1, $2, $3, $4, $5, $6, 'x', $7, $8, $9, $10)`,
          [TENANT_A, randomUUID(), target.id, values.version, values.from, values.to, values.kind, memberId(ACTOR), values.reason, values.event],
        );
      };
      expect(await sqlState(insert({ reason: null }))).toBe('23514');
      expect(await sqlState(insert({ kind: 'SYSTEM', reason: null }))).toBe('23514');
      expect(await sqlState(insert({ event: randomUUID() }))).toBe('23514');
      expect(await sqlState(insert({ from: 'CLOSED', to: 'CONCEPT' }))).toBe('23514');
      expect(await sqlState(insert({ to: 'IMPLEMENTATION' }))).toBe('23514');
      expect(await sqlState(insert({ to: 'LIMBO' }))).toBe('23514');
      expect(await sqlState(insert({ version: 1 }))).toBe('23514');
      await insert({});
      expect(await sqlState(insert({}))).toBe('23505');
    });
  });

  describe('the lifecycle of a project', () => {
    it('answers the history with who moved the project and on what ground, and the moves it may make with the state of their guards', async () => {
      const budgeted = await project('PIPELINE', { nationalCode: null });
      const funded = await plan([{ project: budgeted, amount: '10' }]);
      await consume(funded, [budgeted.id]);
      const read = await as((tx) => stage.lifecycle(tx, budgeted.id, { read: everything, act: Object.fromEntries(STAGE_COMMANDS.map((command) => [command, everything])) as Record<StageCommand, ScopeBuilder> }, TODAY));
      expect(read).toMatchObject({ projectId: budgeted.id, status: 'BUDGETED', version: 2, projectGroup: 'B', nationalProjectCode: null });
      expect(read?.history).toMatchObject([{ from: 'PIPELINE', to: 'BUDGETED', version: 2, operation: PLAN_PUBLISHED_EVENT, actorKind: 'SYSTEM', actorName: null, decisionDocumentId: funded.documentId, reason: null }]);
      expect(read?.next).toEqual([
        { operation: 'startProjectImplementation', to: 'IMPLEMENTATION', allowed: true, guards: [{ key: 'INVESTMENT_DECISION_DOCUMENT', state: 'INPUT_REQUIRED' }, { key: 'NATIONAL_CODE', state: 'UNMET' }] },
        { operation: 'cancelProject', to: 'CANCELLED', allowed: true, guards: [{ key: 'DECISION_DOCUMENT', state: 'INPUT_REQUIRED' }, { key: 'OPEN_OBLIGATIONS', state: 'MET' }] },
      ]);
    });

    it('names the member who made a move and marks the commands the caller may not make', async () => {
      const target = await project('IMPLEMENTATION', { unit: DEPARTMENT });
      await move('suspendProject', target, await grounds('suspendProject'), { actor: OTHER_ACTOR });
      const acts = { ...Object.fromEntries(STAGE_COMMANDS.map((command) => [command, nothing])), resumeProject: everything } as Record<StageCommand, ScopeBuilder>;
      const read = await as((tx) => stage.lifecycle(tx, target.id, { read: everything, act: acts }, TODAY));
      expect(read?.history).toMatchObject([{ from: 'IMPLEMENTATION', to: 'SUSPENDED', actorKind: 'USER', actorName: 'User 2', reason: 'A reason for the move' }]);
      expect(read?.history[0]?.decisionDocumentId).toEqual(expect.any(String));
      expect(read?.next).toEqual([{ operation: 'resumeProject', to: 'IMPLEMENTATION', allowed: true, guards: [] }]);
      const closed = await project('CLOSED');
      const none = await as((tx) => stage.lifecycle(tx, closed.id, { read: everything, act: acts }, TODAY));
      expect(none).toMatchObject({ status: 'CLOSED', history: [], next: [] });
      const cancelled = await project('CANCELLED');
      const blocked = await as((tx) => stage.lifecycle(tx, cancelled.id, { read: everything, act: acts }, TODAY));
      expect(blocked?.next).toEqual([]);
      const cannotAct = await as((tx) => stage.lifecycle(tx, target.id, { read: everything, act: { ...acts, resumeProject: nothing } }, TODAY));
      expect(cannotAct?.next).toEqual([{ operation: 'resumeProject', to: 'IMPLEMENTATION', allowed: false, guards: [] }]);
    });

    it('is not there for a project out of the scope of the caller or of another tenant', async () => {
      const elsewhere = await project('IMPLEMENTATION', { unit: OTHER_BRANCH });
      const acts = Object.fromEntries(STAGE_COMMANDS.map((command) => [command, everything])) as Record<StageCommand, ScopeBuilder>;
      expect(await as((tx) => stage.lifecycle(tx, elsewhere.id, { read: subtree('project.read', DEPARTMENT, '/u1/u2/'), act: acts }, TODAY))).toBeUndefined();
      expect(await as((tx) => stage.lifecycle(tx, elsewhere.id, { read: everything, act: acts }, TODAY), TENANT_B)).toBeUndefined();
      expect(await as((tx) => stage.lifecycle(tx, randomUUID(), { read: everything, act: acts }, TODAY))).toBeUndefined();
    });
  });

  describe('the project bank', () => {
    const page = (filter: Parameters<PrjStageStore['pipeline']>[2], scope: ScopeBuilder = everything, limit = 50, after?: { code: string; id: string }) =>
      as((tx) => stage.pipeline(tx, scope, filter, { limit, after }, TODAY));

    it('ranks the cards by appraisal score, then by milestones done, then by the time in the stage, and a card without a score comes last (BR-PRJ-06)', async () => {
      const group = 'C';
      const old = '2026-01-01T00:00:00Z';
      const recent = '2026-06-01T00:00:00Z';
      const withMilestones = await project('PIPELINE', { group, score: '72.50', changedAt: recent });
      const later = await project('PIPELINE', { group, score: '72.50', changedAt: recent });
      const earlier = await project('PIPELINE', { group, score: '72.50', changedAt: old });
      const best = await project('PIPELINE', { group, score: '88.00', changedAt: recent });
      const unscored = await project('PIPELINE', { group, score: null, changedAt: old });
      const perfect = await project('PIPELINE', { group, score: '100.00', changedAt: recent });
      await owner(
        `insert into machvon.project_milestone (tenant_id, id, project_id, code, name, baseline_date, planned_date, actual_date, status, created_by, updated_by)
         values ($1, $2, $3, 'M1', 'Land cleared', '2026-02-01', '2026-02-01', '2026-02-02', 'DONE', $4, $4), ($1, $5, $3, 'M2', 'Permit', '2026-03-01', '2026-03-01', null, 'PLANNED', $4, $4)`,
        [TENANT_A, randomUUID(), withMilestones.id, memberId(ACTOR), randomUUID()],
      );
      const read = await page({ stage: 'PIPELINE', projectGroup: group });
      const order = read.cards.map((card) => card.id);
      expect(order).toEqual([perfect.id, best.id, withMilestones.id, earlier.id, later.id, unscored.id]);
      expect(read.total).toBe(6);
      expect(read.cards[0]).toMatchObject({ code: perfect.code, status: 'PIPELINE', appraisalScore: '100.00', totalInvestmentVnd: '500000000000', projectGroup: 'C', nationalProjectCode: expect.stringMatching(/^7[0-9]{6}$/), capitalReady: true, leader: null });
    });

    it('pages with the cursor of the last card and sees every card once; total counts the filter, not the page', async () => {
      const group = 'QTQG';
      const made: string[] = [];
      for (const score of ['10.00', '20.00', '30.00', '40.00', '50.00']) made.push((await project('PIPELINE', { group, score })).id);
      const first = await page({ stage: 'PIPELINE', projectGroup: group }, everything, 2);
      expect(first.total).toBe(5);
      expect(first.cards.map((card) => card.id)).toEqual([made[4], made[3]]);
      const seen = [...first.cards];
      let last = first.cards[first.cards.length - 1];
      while (last !== undefined) {
        const next = await page({ stage: 'PIPELINE', projectGroup: group }, everything, 2, { code: last.codeKey, id: last.id });
        seen.push(...next.cards);
        last = next.cards[next.cards.length - 1];
      }
      expect(seen.map((card) => card.id)).toEqual([...made].reverse());
    });

    it('shows a pipeline project as ready for capital only when it has the national code the rule requires', async () => {
      const group = 'A';
      const ready = await project('PIPELINE', { group, score: '61.00' });
      const noCode = await project('PIPELINE', { group, score: '62.00', nationalCode: null });
      const budgeted = await project('BUDGETED', { group, score: '64.00' });
      const read = await page({ projectGroup: group }, everything, 200);
      const byId = new Map(read.cards.map((card) => [card.id, card.capitalReady]));
      expect([byId.get(ready.id), byId.get(noCode.id), byId.get(budgeted.id)]).toEqual([true, false, null]);
    });

    it('filters by stage and by group, and refuses a stage or a group that does not exist', async () => {
      const read = await page({ stage: 'SETTLED' });
      expect(read.cards.every((card) => card.status === 'SETTLED')).toBe(true);
      expect(read.total).toBeGreaterThan(0);
      expect(await refusal(page({ stage: 'PIPELINE', projectGroup: 'NO' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_group' });
      expect(await refusal(page({ stage: 'LIMBO' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'stage' });
    });

    it('shows only the projects in the scope of the caller, and counts only those', async () => {
      const group = 'B';
      const here = await project('COMPLETED', { group, unit: DEPARTMENT });
      const there = await project('COMPLETED', { group, unit: OTHER_BRANCH });
      const scoped = await page({ stage: 'COMPLETED', projectGroup: group }, subtree('project.read', DEPARTMENT, '/u1/u2/'));
      expect(scoped.cards.map((card) => card.id)).toContain(here.id);
      expect(scoped.cards.map((card) => card.id)).not.toContain(there.id);
      const all = await page({ stage: 'COMPLETED', projectGroup: group });
      expect(all.total).toBe(scoped.total + 1);
      expect(await page({ stage: 'COMPLETED' }, nothing)).toMatchObject({ cards: [], total: 0 });
      expect((await as((tx) => stage.pipeline(tx, everything, { stage: 'COMPLETED' }, { limit: 50, after: undefined }, TODAY), TENANT_B)).cards).toEqual([]);
    });

    it('names the leader in charge of a card', async () => {
      const led = await project('PIPELINE', { group: 'A', score: '5.00' });
      await owner(
        `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'LEADER_IN_CHARGE', '2026-01-01', 'ACTIVE', $5, $5)`,
        [TENANT_A, randomUUID(), led.id, memberId(OTHER_ACTOR), memberId(ACTOR)],
      );
      const card = (await page({ stage: 'PIPELINE', projectGroup: 'A' }, everything, 200)).cards.find((candidate) => candidate.id === led.id);
      expect(card?.leader).toEqual({ membershipId: memberId(OTHER_ACTOR), displayName: 'User 2' });
    });
  });

  describe('the audit row and the event of a move', () => {
    it('are written from the stored values and carry the stages and the ground of the move, no free text in the event', async () => {
      const target = await project('IMPLEMENTATION');
      const change = await move('suspendProject', target, { ...(await grounds('suspendProject')), reason: 'Works stopped for a flood' });
      const occurredAt = new Date('2026-10-24T01:00:00Z');
      const record = stageChangeRecord(change, TENANT_A, occurredAt);
      expect(record.audit).toMatchObject({
        action: 'project.stage_changed',
        resourceType: 'project',
        resourceId: target.id,
        classification: 'INTERNAL',
        reason: 'Works stopped for a flood',
        diff: { code: target.code, from: 'IMPLEMENTATION', to: 'SUSPENDED', operation: 'suspendProject', decision_document_id: change.decisionDocumentId, effective_date: null, national_code_warning: false },
      });
      expect(record.event).toEqual({
        aggregateType: 'project',
        aggregateId: target.id,
        aggregateVersion: 2,
        type: 'project.stage_changed.v1',
        schemaVersion: 1,
        payload: { tenant_id: TENANT_A, project_id: target.id, version: 2, actor_id: memberId(ACTOR), occurred_at: occurredAt.toISOString(), from: 'IMPLEMENTATION', to: 'SUSPENDED', decision_document_id: change.decisionDocumentId, operation: 'suspendProject' },
        eventKey: `project:${target.id}:2`,
      });
      expect(JSON.stringify(record.event)).not.toContain('flood');
      const system = stageChangeRecord({ ...change, actorKind: 'SYSTEM', reason: null }, TENANT_A, occurredAt);
      expect('reason' in system.audit).toBe(false);
    });
  });
});
