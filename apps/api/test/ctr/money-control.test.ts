import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { capModule } from '../../src/modules/cap';
import { ContractAvcController } from '../../src/modules/cap/contract-avc.controller';
import { CapitalCommitments } from '../../src/modules/cap/commitment.port';
import { ChangeChainController, ChangeRequestReadsController } from '../../src/modules/ctr/change.controller';
import { AdvanceRecoveryReadsController } from '../../src/modules/pay/advance-recovery.controller';
import { prjModule } from '../../src/modules/prj';
import { ProjectReserveController, ProjectReserveReadsController } from '../../src/modules/prj/reserve.controller';
import { CapWorld, money } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb5;
const ROOT = 1;
const OFFICER = 12; // change.manage, change.read, project.reserve.*: raises and promotes the change, asks for the drawdown
const EVALUATOR = 13; // change.evaluate, change.read
const APPROVER = 20; // contract.change.approve, change.read, contract.read, project.reserve.approve, project.reserve.read: decides
const CLEARER = 21; // change.adjustment.clear, change.read: clears the check of the project adjustment
const READER = 22; // capital.read, advance.read, project.reserve.read, change.read: reads
const NOBODY = 23;
const MEMBERS = [OFFICER, EVALUATOR, APPROVER, CLEARER, READER, NOBODY];
const REASON = 'The owner instructed a wider footpath.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the money control over HTTP (governance deepening, lane B2: G1-6, G1-7, G1-8, G1-11)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';
  let version = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 and outcome = $3 order by occurred_at', [resourceId, action, 'SUCCESS']);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);

  interface Capital {
    lineId: string;
    projectId: string;
  }
  interface Contract {
    id: string;
    revisionId: string;
    projectId: string;
  }

  async function project(): Promise<Capital> {
    const line = await world.publishedLine({ allocated: money(60), appropriationAmount: money(80) });
    await world.owner("update machvon.project set status = 'IMPLEMENTATION' where id = $1::uuid", [line.projectId]);
    return { lineId: line.lineId, projectId: line.projectId };
  }

  async function contract(of: Capital): Promise<Contract> {
    counter += 1;
    const contractId = randomUUID();
    const revisionId = randomUUID();
    const code = `HD-M-${String(counter).padStart(4, '0')}`;
    const packageId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, allocation_line_id) values ($1, $2, $3, $4, 100000000000, 'OPEN', 1, 'AWARDED', $5)`,
        [TENANT_A, packageId, of.projectId, `PKG-${code}`, of.lineId],
      ],
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000, $7, $7, date '2026-01-01', date '2026-01-02')`,
        [TENANT_A, contractId, of.projectId, packageId, contractor, code, memberId(OFFICER)],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, 10000000000, $4, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
        [TENANT_A, revisionId, contractId, version, memberId(OFFICER), memberId(APPROVER)],
      ],
    ]);
    return { id: contractId, revisionId, projectId: of.projectId };
  }

  /** A CO assessed through the API at the delta asked for (an increase names the line of capital): the evaluator classifies it. */
  async function assessed(of: Capital, delta: string): Promise<{ target: Contract; request: string; version: number; evaluated: Reply }> {
    const target = await contract(of);
    expect((await call('POST', `/projects/${of.projectId}/change-chain-config`, { member: APPROVER, body: { tier_count: 3 } })).status).toBe(200);
    const opened = await call('POST', `/contracts/${target.id}/change-requests`, { member: OFFICER, body: { stage: 'EVENT', baseline_revision_id: target.revisionId, event_kind: 'OWNER_INSTRUCTION', reason: REASON, estimated_delta_vnd: delta, schedule_impact_days: 5 } });
    expect(opened.status).toBe(200);
    const pco = (await call('POST', `/change-requests/${opened.json.resource_id as string}/promote`, { member: OFFICER, ifMatch: '"1"', body: { reason: 'It is a change.' } })).json.resource_id as string;
    const co = (await call('POST', `/change-requests/${pco}/promote`, { member: OFFICER, ifMatch: '"1"', body: { reason: 'Priced.' } })).json.resource_id as string;
    const evaluated = await call('POST', `/change-requests/${co}/evaluate`, {
      member: EVALUATOR,
      ifMatch: '"1"',
      body: { evaluated_delta_vnd: delta, schedule_impact_days: 5, funding_impact_note: 'Paid from the plan.', ...(BigInt(delta) > 0n ? { allocation_line_id: of.lineId } : {}) },
    });
    expect(evaluated.status).toBe(200);
    return { target, request: co, version: evaluated.json.resource_version as number, evaluated };
  }

  const decide = (request: string, requestVersion: number) =>
    call('POST', `/contract-changes/${request}/decision`, {
      member: APPROVER,
      ifMatch: `"${requestVersion}"`,
      body: { decision: 'approve', reason: 'Within the plan.', evidence_ids: [], effective_on: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10), decision_document_version_id: version },
    });

  async function risk(projectId: string): Promise<string> {
    const riskId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.project_risk (tenant_id, id, project_id, code, category_master_version_id, title, description, likelihood, impact, owner_membership_id, mitigation, due_date, status, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 'Risk', 'Description', 3, 3, $6, 'Mitigation', date '2027-01-01', 'OPEN', $6, $6)`,
        [TENANT_A, riskId, projectId, `R-${randomUUID().slice(0, 8)}`, randomUUID(), memberId(OFFICER)],
      ],
    ]);
    return riskId;
  }

  beforeAll(async () => {
    await world.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'MC_OFFICER', ['change.manage', 'change.read', 'project.reserve.fund', 'project.reserve.request', 'project.reserve.read', 'project.risk.manage'], 30],
      [2, 'MC_EVALUATOR', ['change.evaluate', 'change.read'], 30],
      [3, 'MC_APPROVER', ['contract.change.approve', 'change.read', 'contract.read', 'project.reserve.approve', 'project.reserve.read', 'change.tiers.configure'], 50],
      [4, 'MC_CLEARER', ['change.adjustment.clear', 'change.read'], 50],
      [5, 'MC_READER', ['capital.read', 'advance.read', 'project.reserve.read', 'change.read', 'change_request.read', 'contract.read'], 10],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 90 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number) => ({ n, member, role: 90 + role, kind: 'TENANT' as const });
    await harness.seedGrants(TENANT_A, [grant(1, OFFICER, 1), grant(2, EVALUATOR, 2), grant(3, APPROVER, 3), grant(4, CLEARER, 4), grant(5, READER, 5)]);
    contractor = await seedContractor(harness);
    version = id(FAMILY, 10);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(READER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/decision.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, version, id(FAMILY, 11)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ChangeChainController, ChangeRequestReadsController, ProjectReserveController, ProjectReserveReadsController, ContractAvcController, AdvanceRecoveryReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
        CapitalCommitments,
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the modules of CAP, PRJ and PAY', () => {
    expect(capModule.controllers).toEqual(expect.arrayContaining([ContractAvcController]));
    expect(prjModule.controllers).toEqual(expect.arrayContaining([ProjectReserveController, ProjectReserveReadsController]));
  });

  describe('the reserve of a project (G1-7)', () => {
    it('fills the contingency on a document, audits it, replays the same key once, and refuses a kind that is not one, a missing document and whoever lacks the right', async () => {
      const of = await project();
      const body = { kind: 'CONTINGENCY', amount_vnd: '3000000000', authority_document_version_id: version, reason: 'Allotted by the decision on the investment.' };
      const key = `fund-${randomUUID()}`;
      const filled = await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: OFFICER, body, key });
      expect(filled).toMatchObject({ status: 200, json: { status: 'FUNDED', balance_vnd: '3000000000' } });
      const fundId = filled.json.resource_id as string;
      const again = await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: OFFICER, body, key });
      expect(again).toMatchObject({ status: 200, json: { resource_id: fundId, balance_vnd: '3000000000' } });
      expect((await rows<{ balance_vnd: string }>('select balance_vnd::text from machvon.reserve_fund where id = $1::uuid', [fundId]))[0]?.balance_vnd).toBe('3000000000');
      expect((await audits(fundId, 'project.reserve_funded'))[0]).toMatchObject({ actor_id: memberId(OFFICER), reason: body.reason, safe_diff: { project_id: of.projectId, kind: 'CONTINGENCY', amount_vnd: '3000000000' } });
      expect((await events(fundId, 'project.reserve_funded.v1'))[0]?.payload).toMatchObject({ project_id: of.projectId, kind: 'CONTINGENCY', amount_vnd: '3000000000', actor_id: memberId(OFFICER) });

      expect((await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: OFFICER, body: { ...body, kind: 'SLUSH' } })).status).toBeGreaterThanOrEqual(400);
      expect(await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: OFFICER, body: { ...body, authority_document_version_id: randomUUID() } })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
      expect(await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: OFFICER, body: { ...body, tenant_id: TENANT_A } })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect((await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: NOBODY, body })).status).toBe(403);
      expect((await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: EVALUATOR, body })).status).toBe(403);
      expect(await call('POST', `/projects/${randomUUID()}/reserve-funds`, { member: OFFICER, body })).toMatchObject({ status: 404 });
    });

    it('a drawdown is for one risk or one change order and decided by someone else; the management reserve is never open without a band for it', async () => {
      const of = await project();
      const riskId = await risk(of.projectId);
      for (const kind of ['CONTINGENCY', 'MGMT_RESERVE']) {
        expect((await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: OFFICER, body: { kind, amount_vnd: '2000000000', authority_document_version_id: version, reason: 'Allotted.' } })).status).toBe(200);
      }
      const ask = (body: Record<string, unknown>, member = OFFICER) => call('POST', `/projects/${of.projectId}/reserve-drawdowns`, { member, body });
      expect(await ask({ kind: 'CONTINGENCY', amount_vnd: '100', reason: 'No link.' })).toMatchObject({ status: 422, json: { code: 'RESERVE_LINK_REQUIRED' } });
      expect(await ask({ kind: 'CONTINGENCY', amount_vnd: '100', risk_id: riskId, change_request_id: randomUUID(), reason: 'Both.' })).toMatchObject({ status: 422, json: { code: 'RESERVE_LINK_REQUIRED' } });
      expect(await ask({ kind: 'CONTINGENCY', amount_vnd: '2000000001', risk_id: riskId, reason: 'Too much.' })).toMatchObject({ status: 422, json: { code: 'RESERVE_BALANCE_INSUFFICIENT' } });
      expect((await ask({ kind: 'CONTINGENCY', amount_vnd: '100', risk_id: riskId, reason: 'x' }, NOBODY)).status).toBe(403);

      const asked = await ask({ kind: 'CONTINGENCY', amount_vnd: '500000000', risk_id: riskId, reason: 'The foundation is wetter than the survey said.' });
      expect(asked).toMatchObject({ status: 200, json: { status: 'REQUESTED', resource_version: 1 } });
      const drawdown = asked.json.resource_id as string;
      const decision = (member: number, resource = drawdown, ifMatch = '"1"', decisionName = 'approve') => call('POST', `/reserve-drawdowns/${resource}/decision`, { member, ifMatch, body: { decision: decisionName, reason: 'Confirmed by the supervisor.' } });
      expect(await decision(OFFICER)).toMatchObject({ status: 403 });
      expect(await decision(NOBODY)).toMatchObject({ status: 403 });
      expect(await decision(APPROVER, drawdown, '"9"')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const done = await decision(APPROVER);
      expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2, balance_vnd: '1500000000' } });
      expect((await audits(drawdown, 'project.reserve_drawdown_approved'))[0]).toMatchObject({ actor_id: memberId(APPROVER), safe_diff: { risk_id: riskId, amount_vnd: '500000000', kind: 'CONTINGENCY' } });
      expect(await decision(APPROVER, drawdown, '"2"')).toMatchObject({ status: 409, json: { code: 'RESERVE_DRAWDOWN_STATE_INVALID' } });

      // The management reserve belongs to the level above: with no band configured for it, nobody draws it.
      const mgmt = await ask({ kind: 'MGMT_RESERVE', amount_vnd: '100000000', risk_id: riskId, reason: 'Unknown risk.' });
      expect(mgmt.status).toBe(200);
      expect(await decision(APPROVER, mgmt.json.resource_id as string)).toMatchObject({ status: 422, json: { code: 'DOA_RULE_NOT_FOUND' } });
      expect((await rows<{ balance_vnd: string }>("select balance_vnd::text from machvon.reserve_fund where project_id = $1::uuid and kind = 'MGMT_RESERVE'", [of.projectId]))[0]?.balance_vnd).toBe('2000000000');
    });

    it('sets what a risk would cost, and reads the funds, the ledger, the risks and the cover; a project out of reach does not exist', async () => {
      const of = await project();
      const riskId = await risk(of.projectId);
      await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: OFFICER, body: { kind: 'CONTINGENCY', amount_vnd: '400000000', authority_document_version_id: version, reason: 'Allotted.' } });
      expect(await call('POST', `/project-risks/${riskId}/exposure`, { member: OFFICER, body: { probability_pct: '50', cost_impact_vnd: '2000000000' } })).toMatchObject({ status: 200, json: { status: 'SET', resource_version: 1 } });
      expect(await call('POST', `/project-risks/${riskId}/exposure`, { member: OFFICER, body: { probability_pct: '120', cost_impact_vnd: '1' } })).toMatchObject({ status: 422 });
      expect((await call('POST', `/project-risks/${riskId}/exposure`, { member: NOBODY, body: { probability_pct: '1', cost_impact_vnd: '1' } })).status).toBe(403);

      const view = await call('GET', `/projects/${of.projectId}/reserve`, { member: READER });
      expect(view.status).toBe(200);
      expect(view.json).toMatchObject({ project_id: of.projectId, expected_value_vnd: '1000000000', unassessed_risk_count: 0, contingency_cover: { covered: false, shortfall_vnd: '600000000', balance_vnd: '400000000' }, policy: { source: 'DEFAULT', version: null } });
      expect((view.json.funds as Array<{ kind: string; entries: unknown[] }>)[0]).toMatchObject({ kind: 'CONTINGENCY', entries: [expect.objectContaining({ entry_kind: 'FUND', balance_after_vnd: '400000000' })] });
      expect(view.json.actions).toMatchObject({ fund: false, decide_drawdown: false });
      expect((await call('GET', `/projects/${of.projectId}/reserve`, { member: OFFICER })).json.actions).toMatchObject({ fund: true, request_drawdown: true, set_exposure: true });
      expect((await call('GET', `/projects/${of.projectId}/reserve`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/projects/${randomUUID()}/reserve`, { member: READER })).status).toBe(404);
    });
  });

  describe('the tier of a change order (G1-8)', () => {
    it('raises the check of the project adjustment at the evaluation, tells the audit, refuses the approval until someone outside the chain clears it, then approves', async () => {
      const of = await project();
      const { target, request, version: requestVersion, evaluated } = await assessed(of, '1100000000');
      expect(evaluated.status).toBe(200);
      const tier = await call('GET', `/change-requests/${request}/tier`, { member: READER });
      expect(tier).toMatchObject({ status: 200, json: { tier: 3, cumulative_pct: '11.00', forces_adjustment: true, authority_amount_vnd: '1100000000', check: { status: 'REQUIRED', threshold_pct: '10.00' }, policy: { source: 'DEFAULT', version: null, project_adjustment_pct: '10' } } });
      expect(tier.json.funding).toMatchObject({ needs_cover: true, covered: false, shortfall_vnd: '1100000000' });
      const checkId = (tier.json.check as { id: string }).id;
      expect((await audits(checkId, 'change.adjustment_check_required'))[0]).toMatchObject({ actor_id: memberId(EVALUATOR), safe_diff: { change_request_id: request, cumulative_pct: '11.00', tier: 3 } });
      expect((await events(checkId, 'ctr.change.adjustment_check_required.v1'))[0]?.payload).toMatchObject({ change_request_id: request, project_id: of.projectId, cumulative_pct: '11.00' });
      const board = await call('GET', `/resources/change_request/${request}`, { member: READER });
      expect(board.json).toMatchObject({ tier: 3, cumulative_variation_pct: '11.00' });

      expect(await decide(request, requestVersion)).toMatchObject({ status: 422, json: { code: 'PROJECT_ADJUSTMENT_CHECK_REQUIRED' } });
      const clear = (member: number, ifMatch = `"${requestVersion}"`, document: string = version) => call('POST', `/change-requests/${request}/adjustment-check`, { member, ifMatch, body: { basis: 'The investment decision was adjusted by the resolution.', decision_document_version_id: document } });
      expect((await clear(NOBODY)).status).toBe(403);
      expect((await clear(OFFICER)).status).toBe(403);
      expect(await clear(CLEARER, '"99"')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await clear(CLEARER, `"${requestVersion}"`, randomUUID())).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
      const cleared = await clear(CLEARER);
      expect(cleared).toMatchObject({ status: 200, json: { status: 'CLEARED', change_request_id: request } });
      expect((await audits(checkId, 'change.adjustment_check_cleared'))[0]).toMatchObject({ actor_id: memberId(CLEARER), safe_diff: { change_request_id: request, cumulative_pct: '11.00' } });
      expect((await events(checkId, 'ctr.change.adjustment_check_cleared.v1')).length).toBe(1);
      expect((await call('GET', `/change-requests/${request}/tier`, { member: READER })).json).toMatchObject({ check: { status: 'CLEARED' }, funding: { covered: true, covered_by: 'PROJECT_ADJUSTMENT' }, actions: { clear_adjustment: false } });

      expect(await decide(request, requestVersion)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
      expect((await rows<{ tier: number }>('select tier from machvon.change_request where id = $1::uuid', [request]))[0]?.tier).toBe(3);
      expect(target.id).toBeTruthy();
    });

    it('an increase below the threshold needs a source: refused with the shortfall, then approved once the reserve was drawn for this change order', async () => {
      const of = await project();
      const { request, version: requestVersion } = await assessed(of, '200000000');
      expect((await call('GET', `/change-requests/${request}/tier`, { member: READER })).json).toMatchObject({ tier: 1, forces_adjustment: false, check: null, actions: { clear_adjustment: false } });
      expect(await call('POST', `/change-requests/${request}/adjustment-check`, { member: CLEARER, ifMatch: `"${requestVersion}"`, body: { basis: 'Not needed.', decision_document_version_id: version } })).toMatchObject({ status: 409, json: { code: 'ADJUSTMENT_CHECK_NOT_REQUIRED' } });
      const refused = await decide(request, requestVersion);
      expect(refused).toMatchObject({ status: 422, json: { code: 'CHANGE_FUNDING_REQUIRED', shortfall_vnd: '200000000' } });

      await call('POST', `/projects/${of.projectId}/reserve-funds`, { member: OFFICER, body: { kind: 'CONTINGENCY', amount_vnd: '300000000', authority_document_version_id: version, reason: 'Allotted.' } });
      const asked = await call('POST', `/projects/${of.projectId}/reserve-drawdowns`, { member: OFFICER, body: { kind: 'CONTINGENCY', amount_vnd: '200000000', change_request_id: request, reason: 'The change order is paid from the contingency.' } });
      expect(asked.status).toBe(200);
      expect(await call('POST', `/reserve-drawdowns/${asked.json.resource_id as string}/decision`, { member: APPROVER, ifMatch: '"1"', body: { decision: 'approve', reason: 'Covered.' } })).toMatchObject({ status: 200, json: { balance_vnd: '100000000' } });
      expect((await call('GET', `/change-requests/${request}/tier`, { member: READER })).json.funding).toMatchObject({ covered: true, covered_by: 'RESERVE', approved_drawdown_vnd: '200000000' });
      expect(await decide(request, requestVersion)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    });

    it('reads nothing outside the scope: a request that does not exist, and a reader without the right', async () => {
      expect((await call('GET', `/change-requests/${randomUUID()}/tier`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/change-requests/${randomUUID()}/tier`, { member: NOBODY })).status).toBe(403);
    });
  });

  describe('the contract, the estimate and the advance (G1-6, G1-11)', () => {
    it('shows the contract against its price in force with its change orders against the capital line, and the estimate against the approved total', async () => {
      const of = await project();
      const { target, request } = await assessed(of, '700000000');
      await rows('update machvon.contract set accepted_total_vnd = 4000000000, requested_total_vnd = 4000000000, paid_total_vnd = 3000000000, advance_paid_vnd = 1000000000, advance_recovered_vnd = 400000000 where id = $1::uuid', [target.id]);
      const statement = await call('GET', `/contracts/${target.id}/availability`, { member: READER });
      expect(statement.status).toBe(200);
      expect(statement.json).toMatchObject({
        contract: { id: target.id, status: 'ACTIVE', project_id: of.projectId },
        money: { current_price_vnd: '10000000000', pending_increase_vnd: '700000000', remaining_payable_vnd: '6000000000', advance_outstanding_vnd: '600000000', within_price: true, requested_pct: '40.00' },
        line: { allocation_line_id: of.lineId },
      });
      expect((statement.json.change_orders as Array<{ id: string; delta_vnd: string }>)[0]).toMatchObject({ id: request, delta_vnd: '700000000' });
      expect((await call('GET', `/contracts/${target.id}/availability`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/contracts/${randomUUID()}/availability`, { member: READER })).status).toBe(404);

      await rows('update machvon.project set total_investment_vnd = 1000 where id = $1::uuid', [of.projectId]);
      const over = await call('GET', `/projects/${of.projectId}/eac-control`, { member: READER });
      expect(over).toMatchObject({ status: 200, json: { project_id: of.projectId, verdict: 'OVER', raises_alert: true, method: 'CONTRACT_PRICES_PLUS_PENDING', approved_total_vnd: '1000', policy: { source: 'DEFAULT' } } });
      expect(BigInt(over.json.over_by_vnd as string)).toBeGreaterThan(0n);
      expect((await call('GET', `/projects/${randomUUID()}/eac-control`, { member: READER })).status).toBe(404);
    });

    it('shows the advance of a contract against what is left to pay, the recovery table and the policy as data', async () => {
      const of = await project();
      const target = await contract(of);
      await rows('update machvon.contract set accepted_total_vnd = 9800000000, requested_total_vnd = 9800000000, advance_paid_vnd = 500000000, advance_recovered_vnd = 100000000 where id = $1::uuid', [target.id]);
      const partyId = randomUUID();
      const advanceId = randomUUID();
      await seedAs(harness, [
        [`insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by) values ($1, $2, $3, $4, 'LEAD', 100, 10000000000, 'ACTIVE', date '2026-01-02', $5, $5)`, [TENANT_A, partyId, target.id, contractor, memberId(OFFICER)]],
        [
          `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, recovered_vnd, paid_on, recovery_deadline, recovery_threshold_pct, created_by, updated_by)
           values ($1, $2, $3, $4, 1, 'GPMB', 500000000, 500000000, 'RECOVERING', 500000000, 100000000, date '2026-03-01', date '2026-04-01', 80, $5, $5)`,
          [TENANT_A, advanceId, target.id, partyId, memberId(OFFICER)],
        ],
      ]);
      const position = await call('GET', `/contracts/${target.id}/advance-position`, { member: READER });
      expect(position).toMatchObject({ status: 200, json: { contract_id: target.id, outstanding_vnd: '400000000', remaining_payable_vnd: '200000000', exceeds_remaining: true, unrecoverable_vnd: '200000000', final_payment_requires_full_recovery: true, policy: { source: 'DEFAULT' } } });
      const table = await call('GET', `/advances/${advanceId}/recovery-table`, { member: READER });
      expect(table.status).toBe(200);
      expect(table.json).toMatchObject({ advance: { id: advanceId, outstanding_vnd: '400000000' }, position: { exceeds_remaining: true } });
      expect((table.json.rows as Array<{ kind: string }>).some((row) => row.kind === 'PLANNED')).toBe(true);
      expect((await call('GET', `/advances/${advanceId}/recovery-table`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/contracts/${randomUUID()}/advance-position`, { member: READER })).status).toBe(404);

      const policy = await call('GET', '/advance-policy?as_of=2026-07-01', { member: READER });
      expect(policy).toMatchObject({ status: 200, json: { as_of: '2026-07-01', items: expect.any(Array) } });
      expect((await call('GET', '/advance-policy?as_of=tomorrow', { member: READER })).status).toBe(422);
    });
  });
});
