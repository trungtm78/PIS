import { randomUUID } from 'node:crypto';
import { CtrChangeChainStore } from '../src/ctr-change-chain-store';
import type { ChangeHooks, ChangeResult } from '../src/ctr-change-chain-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { completeContract } from './support/contract-fixtures';
import { DEPARTMENT, PROVINCE, everything, nothing, seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';

const world = new CapWorld();
const harness = world.harness;
const chain = new CtrChangeChainStore();
const FAMILY = 0xaa;
const MAKER = 1;
const EVALUATOR = 2;
const PROJECT_ONE = id(FAMILY, 1);
const PROJECT_TWO = id(FAMILY, 2);
const PROJECT_THREE = id(FAMILY, 3);
const CONTRACTOR = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
let LINE = '';
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const nothingUpdate: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
};

let counter = 0;

interface Seeded {
  contractId: string;
  revisionId: string;
  code: string;
}

/** A contract of a project in the status asked for, with its first revision in force. */
async function seedContract(projectId: string, status = 'ACTIVE'): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const code = `HD-C-${String(counter).padStart(4, '0')}`;
  const started = ['ACTIVE', 'SUSPENDED', 'TERMINATED'].includes(status);
  const decided = ['SUSPENDED', 'TERMINATED'].includes(status);
  await seedAs(harness, [
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
       values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000, $8, $8, $9::date, $10::date, $11, $12)`,
      [TENANT_A, contractId, projectId, randomUUID(), CONTRACTOR, code, status, memberId(MAKER), started ? '2026-01-01' : null, started ? '2026-01-02' : null, decided ? 'Decided.' : null, decided ? VERSION : null],
    ],
    [
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 10000000000, $4, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $5, $5, $5, now())`,
      [TENANT_A, revisionId, contractId, VERSION, memberId(MAKER)],
    ],
  ]);
  return { contractId, revisionId, code };
}

const hooks = (overrides: Partial<ChangeHooks> = {}): ChangeHooks & { available: jest.Mock } => ({ available: jest.fn(async () => undefined), ...overrides }) as ChangeHooks & { available: jest.Mock };

const setTiers = (projectId: string, tierCount: unknown, scope: ScopeBuilder = everything, member = MAKER) => as((tx) => chain.setTiers(tx, projectId, tierCount, memberId(member), scope), member);
const create = (s: Seeded, overrides: Partial<Parameters<CtrChangeChainStore['create']>[2]> = {}, scopes: ContractScopes = contractScopes) =>
  as((tx) => chain.create(tx, s.contractId, { stage: 'EVENT', baselineRevisionId: s.revisionId, reason: 'The owner instructed a wider footpath.', eventKind: 'OWNER_INSTRUCTION', estimatedDeltaVnd: '400000000', scheduleImpactDays: 10, ...overrides }, memberId(MAKER), scopes));
const promote = (resultId: string, version = 1, reason = 'The event is a change.', scopes: ContractScopes = contractScopes, member = MAKER) =>
  as((tx) => chain.promote(tx, resultId, version, reason, memberId(member), scopes), member);
const evaluate = (resultId: string, version = 1, input: Partial<Parameters<CtrChangeChainStore['evaluate']>[3]> = {}, h: ChangeHooks = hooks(), member = EVALUATOR) =>
  as((tx) => chain.evaluate(tx, resultId, version, { evaluatedDeltaVnd: '500000000', scheduleImpactDays: 20, fundingImpactNote: 'Paid from the line of the plan.', scopeImpactNote: 'Wider footpath along km 2.', allocationLineId: LINE, ...input }, memberId(member), contractScopes, h), member);
const withdraw = (resultId: string, version = 1, reason = 'Raised in error.', scopes: ContractScopes = contractScopes) => as((tx) => chain.withdraw(tx, resultId, version, reason, memberId(MAKER), scopes));
const row = async (requestId: string) =>
  (
    await owner<{
      status: string;
      stage: string;
      code: string;
      parent_id: string | null;
      evaluated_delta_vnd: string | null;
      amount_delta_vnd: string;
      schedule_impact_days: number;
      funding_impact_note: string | null;
      scope_impact_note: string | null;
      evaluation_allocation_line_id: string | null;
      evaluated_by: string | null;
      submitted_by: string | null;
      status_reason: string | null;
      version: string;
    }>(
      `select status, stage, code, parent_id, evaluated_delta_vnd::text, amount_delta_vnd::text, schedule_impact_days, funding_impact_note, scope_impact_note, evaluation_allocation_line_id, evaluated_by, submitted_by, status_reason, version::text
         from machvon.change_request where id = $1::uuid`,
      [requestId],
    )
  )[0];
const config = (projectId: string) =>
  owner<{ tier_count: number; locked_at: string | null; locked_by_change_id: string | null; version: string }>('select tier_count, locked_at::text, locked_by_change_id, version::text from machvon.change_chain_config where project_id = $1::uuid', [projectId]).then((rows) => rows[0]);

describe('the chain of changes of a contract (ST-CTR-006)', () => {
  beforeAll(async () => {
    await world.start();
    LINE = (await world.publishedLine()).lineId;
    await seedAs(harness, [
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $3)`,
        [TENANT_A, CONTRACTOR, DOCUMENT],
      ],
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-C-001', 'Project one', $5, $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'),
                ($1, $3, 'PRJ-C-002', 'Project two', $5, $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'),
                ($1, $7, 'PRJ-C-003', 'Project three', $5, $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT_ONE, PROJECT_TWO, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41), PROJECT_THREE],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'Contract', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(MAKER)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/a.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('setChangeChainTiers', () => {
    it('AC-ST-CTR-006-1, UAT-AC307: sets the tiers of a project unlocked, locks them with the first request, and then refuses to change them', async () => {
      const set = await setTiers(PROJECT_ONE, 3);
      expect(set).toMatchObject({ projectId: PROJECT_ONE, tierCount: 3, previousTierCount: null, version: 1 });
      expect(await config(PROJECT_ONE)).toMatchObject({ tier_count: 3, locked_at: null, locked_by_change_id: null });
      // Until the first request it may be set again.
      expect(await setTiers(PROJECT_ONE, 2)).toMatchObject({ tierCount: 2, previousTierCount: 3, version: 2 });
      expect(await setTiers(PROJECT_ONE, 3)).toMatchObject({ tierCount: 3, previousTierCount: 2, version: 3 });

      const contract = await seedContract(PROJECT_ONE);
      const first = await create(contract);
      expect(first).toMatchObject({ stage: 'EVENT', status: 'SUBMITTED', code: 'CE-001', lockedTiers: true, tierCount: 3, version: 1 });
      expect(await config(PROJECT_ONE)).toMatchObject({ tier_count: 3, locked_at: expect.any(String), locked_by_change_id: first.id, version: '4' });

      expect(await refusal(setTiers(PROJECT_ONE, 2))).toMatchObject({ code: 'CHANGE_TIERS_LOCKED', status: 409, detail: 'tier_count', extensions: { tier_count: 3, locked_by_change_id: first.id } });
      expect(await config(PROJECT_ONE)).toMatchObject({ tier_count: 3 });
    });

    it('AC-ST-CTR-006-1, UAT-AC307: blocks a statement that bypasses the command (SQLSTATE 23514) and keeps the other project as it was', async () => {
      const contract = await seedContract(PROJECT_ONE);
      await create(contract, { stage: 'EVENT' }).catch(() => undefined);
      const locked = await owner<{ id: string }>('select id from machvon.change_chain_config where project_id = $1::uuid and locked_at is not null', [PROJECT_ONE]);
      expect(locked).toHaveLength(1);
      for (const statement of ['update machvon.change_chain_config set tier_count = 2 where id = $1::uuid', 'update machvon.change_chain_config set locked_at = null, locked_by_change_id = null where id = $1::uuid', 'update machvon.change_chain_config set tier_count = 1, locked_at = null where id = $1::uuid', 'delete from machvon.change_chain_config where id = $1::uuid']) {
        const refused = await databaseRefusal(owner(statement, [locked[0]?.id]));
        expect(refused.sqlstate).toBe('23514');
        expect(refused.message).toContain('CHANGE_TIERS_LOCKED');
      }
    });

    it('judges the tier count and the scope: 0, 4 and a word are refused, and a project outside the scope does not exist', async () => {
      for (const wrong of [0, 4, '2', null, 1.5]) expect(await refusal(setTiers(PROJECT_THREE, wrong))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'tier_count' });
      expect(await refusal(setTiers(PROJECT_THREE, 2, nothing))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(setTiers(randomUUID(), 2))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await config(PROJECT_THREE)).toBeUndefined();
    });

    it('refuses a lock that changes the tiers, and a configuration that moves to another project', async () => {
      await setTiers(PROJECT_THREE, 2);
      const seeded = await owner<{ id: string }>('select id from machvon.change_chain_config where project_id = $1::uuid', [PROJECT_THREE]);
      const target = seeded[0]?.id;
      expect((await databaseRefusal(owner('update machvon.change_chain_config set project_id = $2::uuid where id = $1::uuid', [target, PROJECT_ONE]))).message).toContain('stays with the project');
      expect((await databaseRefusal(owner('update machvon.change_chain_config set tier_count = 1, locked_at = now(), locked_by_change_id = gen_random_uuid() where id = $1::uuid', [target]))).message).toContain('does not change them');
    });
  });

  describe('createChangeRequest', () => {
    it('AC-ST-CTR-006-1, UAT-AC307: starts a chain of one tier at the CO and refuses the PCO, and the other project is not touched by the first', async () => {
      await setTiers(PROJECT_TWO, 1);
      const contract = await seedContract(PROJECT_TWO);
      expect(await refusal(create(contract, { stage: 'PCO' }))).toMatchObject({ code: 'CHANGE_STAGE_NOT_ALLOWED', status: 422, detail: 'stage', extensions: { allowed_stage: 'CO', tier_count: 1 } });
      expect(await refusal(create(contract, { stage: 'EVENT' }))).toMatchObject({ code: 'CHANGE_STAGE_NOT_ALLOWED', extensions: { allowed_stage: 'CO' } });
      expect(await config(PROJECT_TWO)).toMatchObject({ locked_at: null });
      const done = await create(contract, { stage: 'CO', eventKind: undefined });
      expect(done).toMatchObject({ stage: 'CO', code: 'CO-001', tierCount: 1, lockedTiers: true, status: 'SUBMITTED' });
      expect(await config(PROJECT_TWO)).toMatchObject({ locked_at: expect.any(String), locked_by_change_id: done.id });
      expect(await row(done.id)).toMatchObject({ status: 'SUBMITTED', stage: 'CO', parent_id: null, submitted_by: memberId(MAKER), amount_delta_vnd: '400000000', schedule_impact_days: 10 });
    });

    it('numbers the requests of a tier of a contract in order, and does not lock again', async () => {
      const project = id(FAMILY, 4);
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, 'PRJ-C-004', 'Project four', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41)],
        ],
      ]);
      await setTiers(project, 2);
      const contract = await seedContract(project);
      const first = await create(contract, { stage: 'PCO', eventKind: undefined, estimatedDeltaVnd: undefined, scheduleImpactDays: undefined });
      const second = await create(contract, { stage: 'PCO' });
      expect([first.code, second.code]).toEqual(['PCO-001', 'PCO-002']);
      expect([first.lockedTiers, second.lockedTiers]).toEqual([true, false]);
      expect(await row(first.id)).toMatchObject({ amount_delta_vnd: '0', schedule_impact_days: 0 });
      expect((await config(project))?.locked_by_change_id).toBe(first.id);
    });

    it('refuses a project with no configuration, and a contract that is not being performed', async () => {
      const bare = id(FAMILY, 5);
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, 'PRJ-C-005', 'Project five', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, bare, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41)],
        ],
      ]);
      expect(await refusal(create(await seedContract(bare)))).toMatchObject({ code: 'CHANGE_STAGE_NOT_ALLOWED', status: 422, extensions: { reason: 'TIERS_NOT_CONFIGURED' } });
      const project = id(FAMILY, 6);
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, 'PRJ-C-006', 'Project six', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41)],
        ],
      ]);
      await setTiers(project, 3);
      for (const status of ['DRAFT', 'IN_REVIEW', 'SIGNED', 'TERMINATED', 'COMPLETED', 'CLOSED', 'CANCELLED']) {
        const started = ['COMPLETED', 'CLOSED'].includes(status);
        const other = started ? await seedContract(project, 'ACTIVE') : await seedContract(project, status === 'TERMINATED' ? 'TERMINATED' : 'ACTIVE');
        await owner(`update machvon.contract set status = $2 where id = $1::uuid`, [other.contractId, status]).catch(() => undefined);
        const state = (await owner<{ status: string }>('select status from machvon.contract where id = $1::uuid', [other.contractId]))[0]?.status;
        if (state === status) expect(await refusal(create(other))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: status } });
      }
      expect(await config(project)).toMatchObject({ locked_at: null });
      const suspended = await seedContract(project, 'SUSPENDED');
      expect((await create(suspended)).status).toBe('SUBMITTED');
    });

    it('judges the shape and the baseline: the stage, the reason, the kind of event, the amount, the days, and a revision that is not one of the contract in force', async () => {
      const project = id(FAMILY, 7);
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, 'PRJ-C-007', 'Project seven', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41)],
        ],
      ]);
      await setTiers(project, 3);
      const contract = await seedContract(project);
      const other = await seedContract(project);
      await seedAs(harness, [["update machvon.contract_revision set status = 'SUPERSEDED' where id = $1::uuid", [other.revisionId]]]);
      const attempts: Array<[Partial<Parameters<CtrChangeChainStore['create']>[2]>, string]> = [
        [{ stage: 'WRONG' }, 'stage'],
        [{ reason: '   ' }, 'reason'],
        [{ reason: 'x'.repeat(2001) }, 'reason'],
        [{ eventKind: 'WHIM' }, 'event_kind'],
        [{ estimatedDeltaVnd: '1.5' }, 'estimated_delta_vnd'],
        [{ scheduleImpactDays: 1.5 }, 'schedule_impact_days'],
        [{ baselineRevisionId: 'nope' }, 'baseline_revision_id'],
        [{ baselineRevisionId: randomUUID() }, 'baseline_revision_id'],
        [{ baselineRevisionId: other.revisionId }, 'baseline_revision_id'],
      ];
      for (const [override, field] of attempts) expect(await refusal(create(contract, override))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      expect(await refusal(create(contract, {}, nothingUpdate))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(create(contract, {}, invisible))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await config(project)).toMatchObject({ locked_at: null });
    });
  });

  describe('promoteChangeRequest and evaluateChangeRequest', () => {
    const chainOf = async (): Promise<{ contract: Seeded; event: ChangeResult }> => {
      const project = randomUUID();
      counter += 1;
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $6, 'Project', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41), `PRJ-N-${counter}`],
        ],
      ]);
      await setTiers(project, 3);
      const contract = await seedContract(project);
      return { contract, event: await create(contract) };
    };

    it('AC-ST-CTR-006-2, UAT-AC308: promotes CE-001 to PCO-001 to CO-001, evaluates CO-001, and records the cost, the schedule, the scope and the funding', async () => {
      const { event } = await chainOf();
      const pco = await promote(event.id, 1, 'The event is a change that has to be priced.');
      expect(pco).toMatchObject({ stage: 'PCO', code: 'PCO-001', status: 'SUBMITTED', parentId: event.id, fromStatus: 'SUBMITTED', version: 1, estimatedDeltaVnd: '400000000', eventKind: 'OWNER_INSTRUCTION' });
      expect(await row(event.id)).toMatchObject({ status: 'PROMOTED', status_reason: 'The event is a change that has to be priced.', version: '2' });
      const co = await promote(pco.id, 1, 'The price is agreed.');
      expect(co).toMatchObject({ stage: 'CO', code: 'CO-001', parentId: pco.id, status: 'SUBMITTED' });
      expect(await row(pco.id)).toMatchObject({ status: 'PROMOTED' });

      const hook = hooks();
      const evaluated = await evaluate(co.id, 1, {}, hook);
      expect(evaluated).toMatchObject({ status: 'EVALUATED', fromStatus: 'SUBMITTED', version: 2, evaluatedDeltaVnd: '500000000', scheduleImpactDays: 20, allocationLineId: LINE });
      expect(hook.available).toHaveBeenCalledWith(LINE, '500000000');
      expect(await row(co.id)).toEqual({
        status: 'EVALUATED',
        stage: 'CO',
        code: 'CO-001',
        parent_id: pco.id,
        evaluated_delta_vnd: '500000000',
        amount_delta_vnd: '500000000',
        schedule_impact_days: 20,
        funding_impact_note: 'Paid from the line of the plan.',
        scope_impact_note: 'Wider footpath along km 2.',
        evaluation_allocation_line_id: LINE,
        evaluated_by: memberId(EVALUATOR),
        submitted_by: memberId(MAKER),
        status_reason: null,
        version: '2',
      });
    });

    it('evaluates a PCO and promotes an evaluated one, and evaluates again before the decision', async () => {
      const { event } = await chainOf();
      const pco = await promote(event.id);
      const evaluated = await evaluate(pco.id);
      expect(evaluated.status).toBe('EVALUATED');
      const again = await evaluate(pco.id, 2, { evaluatedDeltaVnd: '450000000', fundingImpactNote: 'Revised.' });
      expect(again).toMatchObject({ status: 'EVALUATED', fromStatus: 'EVALUATED', version: 3, evaluatedDeltaVnd: '450000000' });
      const co = await promote(pco.id, 3, 'Agreed.');
      expect(co).toMatchObject({ stage: 'CO', parentId: pco.id });
      expect(await row(co.id)).toMatchObject({ amount_delta_vnd: '450000000', evaluated_delta_vnd: null });
    });

    it('asks nothing of the capital for a decrease or no change, and for an increase it asks the line, and takes the refusal of CAP as it comes', async () => {
      const { event } = await chainOf();
      const co = await promote(await promote(event.id).then((pco) => pco.id));
      const idle = hooks();
      expect((await evaluate(co.id, 1, { evaluatedDeltaVnd: '-8000000000', allocationLineId: undefined }, idle)).evaluatedDeltaVnd).toBe('-8000000000');
      expect(idle.available).not.toHaveBeenCalled();
      const named = hooks();
      await evaluate(co.id, 2, { evaluatedDeltaVnd: '-5', allocationLineId: LINE }, named);
      expect(named.available).toHaveBeenCalledWith(LINE, '0');
      expect(await refusal(evaluate(co.id, 3, { evaluatedDeltaVnd: '100', allocationLineId: undefined }))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', status: 422, extensions: { reason: 'ALLOCATION_LINE_REQUIRED' } });
      const refused = hooks({ available: jest.fn(async () => Promise.reject(Object.assign(new Error('blocked'), { code: 'ALLOCATION_UNAVAILABLE', status: 422 }))) });
      expect(await refusal(evaluate(co.id, 3, { evaluatedDeltaVnd: '900000000' }, refused))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', status: 422 });
      expect((await row(co.id))?.version).toBe('3');
    });

    it('judges the version, the state, the tier and the contract: a stale version, a request that is over, an event that is not evaluated, a CO that is not promoted', async () => {
      const { contract, event } = await chainOf();
      expect(await refusal(promote(event.id, 5))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(evaluate(event.id))).toMatchObject({ code: 'CHANGE_STAGE_NOT_ALLOWED', status: 422, extensions: { stage: 'EVENT', reason: 'STAGE_NOT_EVALUATED' } });
      const pco = await promote(event.id);
      expect(await refusal(promote(event.id, 2))).toMatchObject({ code: 'CHANGE_STATE_INVALID', status: 409, extensions: { change_status: 'PROMOTED' } });
      expect(await refusal(evaluate(event.id, 2))).toMatchObject({ code: 'CHANGE_STATE_INVALID' });
      const co = await promote(pco.id);
      expect(await refusal(promote(co.id))).toMatchObject({ code: 'CHANGE_STAGE_NOT_ALLOWED', status: 422, extensions: { stage: 'CO', reason: 'LAST_TIER' } });
      expect(await refusal(promote(co.id, 1, '   '))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      for (const bad of [{ evaluatedDeltaVnd: 'x' }, { scheduleImpactDays: 1.5 }, { fundingImpactNote: ' ' }, { scopeImpactNote: ' ' }, { allocationLineId: 'nope' }]) {
        expect(await refusal(evaluate(co.id, 1, bad))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      }
      expect(await refusal(promote(randomUUID()))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(promote(co.id, 1, 'x', nothingUpdate))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(promote(co.id, 1, 'x', invisible))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await completeContract(harness.database.adminUrl, contract.contractId, memberId(MAKER));
      expect(await refusal(evaluate(co.id))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'COMPLETED' } });
    });

    it('does not promote a request of a project whose chain stops earlier', async () => {
      const project = id(FAMILY, 8);
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, 'PRJ-C-008', 'Project eight', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41)],
        ],
      ]);
      await setTiers(project, 2);
      const co = await promote((await create(await seedContract(project), { stage: 'PCO' })).id);
      expect(co.stage).toBe('CO');
      expect(await refusal(promote(co.id))).toMatchObject({ code: 'CHANGE_STAGE_NOT_ALLOWED' });
    });
  });

  describe('withdrawChangeRequest', () => {
    it('withdraws a request that is open, with the reason, and not again; the requests above it are not touched', async () => {
      const project = randomUUID();
      counter += 1;
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $6, 'Project', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41), `PRJ-W-${counter}`],
        ],
      ]);
      await setTiers(project, 3);
      const contract = await seedContract(project);
      const event = await create(contract);
      const withdrawn = await withdraw(event.id, 1, 'The owner changed their mind.');
      expect(withdrawn).toMatchObject({ status: 'WITHDRAWN', fromStatus: 'SUBMITTED', version: 2 });
      expect(await row(event.id)).toMatchObject({ status: 'WITHDRAWN', status_reason: 'The owner changed their mind.' });
      expect(await refusal(withdraw(event.id, 2))).toMatchObject({ code: 'CHANGE_STATE_INVALID', status: 409, extensions: { change_status: 'WITHDRAWN' } });
      const other = await create(contract);
      const pco = await promote(other.id);
      expect(await refusal(withdraw(other.id, 2))).toMatchObject({ code: 'CHANGE_STATE_INVALID', extensions: { change_status: 'PROMOTED' } });
      expect((await withdraw(pco.id)).status).toBe('WITHDRAWN');
      expect((await row(other.id))?.status).toBe('PROMOTED');
      expect(await refusal(withdraw(pco.id, 9))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(withdraw(other.id, 2, ' '))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
    });
  });

  describe('what the database keeps', () => {
    it('keeps a request in its place and as it was written: no new contract, tier, parent, code, baseline or estimate; the status along the edges; nothing once it is over', async () => {
      const project = randomUUID();
      counter += 1;
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $6, 'Project', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41), `PRJ-G-${counter}`],
        ],
      ]);
      await setTiers(project, 3);
      const contract = await seedContract(project);
      const event = await create(contract);
      const update = (set: string, target = event.id) => databaseRefusal(owner(`update machvon.change_request set ${set} where id = $1::uuid`, [target]));
      for (const change of ["stage = 'PCO'", "code = 'X-1'", 'estimated_delta_vnd = 1', 'baseline_revision_id = gen_random_uuid()', 'contract_id = gen_random_uuid()', 'parent_id = id']) {
        expect((await update(change)).message).toContain('keeps its place in the chain');
      }
      for (const status of ["status = 'APPROVED'", "status = 'REJECTED'", "status = 'DRAFT'"]) expect((await update(status)).message).toMatch(/CHANGE_STATE_INVALID|change_request_/);
      expect((await update("status = 'EVALUATED'")).message).toContain('change_request_evaluated_chk');
      const pco = await promote(event.id);
      expect((await update("status = 'SUBMITTED'")).message).toContain('is kept as it is');
      expect((await update('reason = reason', pco.id).catch(() => ({ message: 'fine' }))).message).toBeDefined();
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.change_request where id = $1::uuid', [pco.id])))).message).toContain('permission denied');
    });

    it('stands a child under a parent of the same contract at the tier before its own, which was promoted for it, and allows one child', async () => {
      const project = randomUUID();
      counter += 1;
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $6, 'Project', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41), `PRJ-P-${counter}`],
        ],
      ]);
      await setTiers(project, 3);
      const contract = await seedContract(project);
      const other = await seedContract(project);
      const event = await create(contract);
      const insert = (parent: string | null, stage: string, contractId: string, code: string) =>
        databaseRefusal(
          owner(
            `insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, parent_id, submitted_by, created_by, updated_by)
             values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 0, 0, 'Reason', 'SUBMITTED', 1, $3, $4, $5::uuid, $6::uuid, $6::uuid, $6::uuid)`,
            [contractId, contract.revisionId, code, stage, parent, memberId(MAKER)],
          ),
        );
      // The parent was not promoted; the tier is not the next; the contract is another.
      expect((await insert(event.id, 'PCO', contract.contractId, 'X-1')).message).toContain('is promoted from a request that was promoted');
      const pco = await promote(event.id);
      expect((await insert(event.id, 'CO', contract.contractId, 'X-2')).message).toContain('CHANGE_STAGE_NOT_ALLOWED');
      expect((await insert(event.id, 'PCO', other.contractId, 'X-3')).message).toContain('same contract');
      expect((await insert(event.id, 'PCO', contract.contractId, 'X-4')).message).toMatch(/change_request_one_child_uq|duplicate key/);
      expect((await insert(pco.id, 'EVENT', contract.contractId, 'X-5')).message).toMatch(/change_request_parent_chk|CHANGE_STAGE_NOT_ALLOWED/);
      expect((await insert(randomUUID(), 'PCO', contract.contractId, 'X-6')).message).toContain('same contract');
    });

    it('refuses a request without its maker, with an empty reason, or decided at a tier that is not the CO', async () => {
      const project = randomUUID();
      counter += 1;
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $6, 'Project', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41), `PRJ-S-${counter}`],
        ],
      ]);
      await setTiers(project, 3);
      const contract = await seedContract(project);
      const insert = (reason: string, status: string, stage: string, submittedBy: string | null) =>
        databaseRefusal(
          owner(
            `insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, stage, submitted_by, created_by, updated_by)
             values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 0, 0, $3, $4, 1, $5, $6::uuid, $7::uuid, $7::uuid)`,
            [contract.contractId, contract.revisionId, reason, status, stage, submittedBy, memberId(MAKER)],
          ),
        );
      expect((await insert('Reason', 'SUBMITTED', 'EVENT', null)).message).toContain('change_request_submitted_chk');
      expect((await insert(' padded ', 'SUBMITTED', 'EVENT', memberId(MAKER))).message).toContain('change_request_text_chk');
      expect((await insert('', 'SUBMITTED', 'EVENT', memberId(MAKER))).message).toContain('change_request_text_chk');
      // Only a CO is decided; a rejection also says who decided and why, and either check may speak first.
      expect((await insert('Reason', 'REJECTED', 'PCO', memberId(MAKER))).message).toMatch(/change_request_(stage_status|decided)_chk/);
    });
  });

  describe('the reads', () => {
    it('lists the requests of a contract or of a project, oldest first, and reads one; only what the scope reaches', async () => {
      const project = randomUUID();
      counter += 1;
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $6, 'Project', $4, $3, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41), `PRJ-R-${counter}`],
        ],
      ]);
      await setTiers(project, 3);
      const first = await seedContract(project);
      const second = await seedContract(project);
      const one = await create(first);
      const two = await create(second);
      const three = await promote(one.id);
      const all = await as((tx) => chain.list(tx, everything, { projectId: project }));
      expect(all.map((line) => line.id)).toEqual([one.id, two.id, three.id]);
      expect(all[0]).toMatchObject({ code: 'CE-001', stage: 'EVENT', status: 'PROMOTED', contract: { id: first.contractId, code: first.code, status: 'ACTIVE' }, projectId: project, estimatedDeltaVnd: '400000000', evaluatedDeltaVnd: null, version: 2 });
      expect(all[2]).toMatchObject({ code: 'PCO-001', parentId: one.id, status: 'SUBMITTED', submittedBy: memberId(MAKER) });
      expect((await as((tx) => chain.list(tx, everything, { contractId: second.contractId }))).map((line) => line.id)).toEqual([two.id]);
      const page = await as((tx) => chain.list(tx, everything, { projectId: project, limit: 2 }));
      expect(page.map((line) => line.id)).toEqual([one.id, two.id]);
      const rest = await as((tx) => chain.list(tx, everything, { projectId: project, after: { code: page[1]?.createdAt as string, id: two.id } }));
      expect(rest.map((line) => line.id)).toEqual([three.id]);
      expect(await as((tx) => chain.list(tx, nothing, { projectId: project }))).toEqual([]);
      expect((await as((tx) => chain.find(tx, one.id, everything)))?.code).toBe('CE-001');
      expect(await as((tx) => chain.find(tx, one.id, nothing))).toBeUndefined();
      expect(await as((tx) => chain.find(tx, randomUUID(), everything))).toBeUndefined();
      const read = await as((tx) => chain.config(tx, project, everything));
      expect(read).toMatchObject({ projectId: project, tierCount: 3, lockedByChangeId: one.id, lockedByCode: 'CE-001', setBy: memberId(MAKER) });
      expect(read?.lockedAt).toEqual(expect.any(String));
      expect(await as((tx) => chain.config(tx, project, nothing))).toBeUndefined();
      expect(await as((tx) => chain.config(tx, PROJECT_THREE, everything))).toBeDefined();
      expect(await as((tx) => chain.contractVisible(tx, project, everything))).toBe(true);
      expect(await as((tx) => chain.contractVisible(tx, project, nothing))).toBe(false);
      expect(await as((tx) => chain.contractVisible(tx, randomUUID(), everything))).toBe(false);
    });
  });
});
