import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CapitalCommitments } from '../../src/modules/cap/commitment.port';
import { ctrModule } from '../../src/modules/ctr';
import { ChangeChainController, ChangeRequestReadsController } from '../../src/modules/ctr/change.controller';
import { CapWorld, money } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { asSuperuser } from '../../../../packages/db/test/support/ncr-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { coverChange } from './reserve-cover';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xa9;
const ROOT = 1;
const OWNER = 11; // change.tiers.configure, change.read
const OFFICER = 12; // change.manage, change.read
const EVALUATOR = 13; // change.evaluate, change.read
const READER = 14; // change.read, change_request.read
const NOBODY = 15;
const ELSEWHERE = 16; // the rights of OFFICER over another branch
const GUEST = 17; // the contractor of the contracts, reading the one it was invited to
const ALL = 18; // every right of the chain
const GUEST_OF_ONE = 19; // a guest of the same contractor, invited to the contract the resource test reads
const APPROVER = 20; // contract.change.approve, change.read, contract.read: decides a CO, rank 50
const MEMBERS = [OWNER, OFFICER, EVALUATOR, READER, NOBODY, ELSEWHERE, GUEST, ALL, GUEST_OF_ONE, APPROVER];
const OTHER_BRANCH = 5;
const REASON = 'The owner instructed a wider footpath.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the chain of changes over HTTP (ST-CTR-006)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';
  let cleanVersion = '';

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
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const requestRow = async (requestId: string) =>
    (await rows<{ status: string; stage: string; version: string; code: string }>('select status, stage, version::text, code from machvon.change_request where id = $1::uuid', [requestId]))[0];
  const configOf = async (projectId: string) =>
    (await rows<{ tier_count: number; locked_at: string | null; version: string }>('select tier_count, locked_at::text, version::text from machvon.change_chain_config where project_id = $1::uuid', [projectId]))[0];

  interface Capital {
    lineId: string;
    projectId: string;
  }
  interface Contract {
    id: string;
    code: string;
    revisionId: string;
    projectId: string;
  }

  /** A project with a line of capital of 60 billion in force. */
  async function project(): Promise<Capital> {
    const line = await world.publishedLine({ allocated: money(60), appropriationAmount: money(80) });
    await world.owner("update machvon.project set status = 'IMPLEMENTATION' where id = $1::uuid", [line.projectId]);
    return { lineId: line.lineId, projectId: line.projectId };
  }

  /** A contract of the project in the status asked for, with its first revision in force. */
  async function contract(of: Capital, status = 'ACTIVE'): Promise<Contract> {
    counter += 1;
    const contractId = randomUUID();
    const revisionId = randomUUID();
    const code = `HD-X-${String(counter).padStart(4, '0')}`;
    const started = ['ACTIVE', 'SUSPENDED'].includes(status);
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000, $8, $8, $9::date, $10::date, $11, $12)`,
        [TENANT_A, contractId, of.projectId, randomUUID(), contractor, code, status, memberId(OFFICER), started ? '2026-01-01' : null, started ? '2026-01-02' : null, status === 'SUSPENDED' ? 'Decided.' : null, status === 'SUSPENDED' ? cleanVersion : null],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, 10000000000, $4, date '2026-01-02', $5, 'BASE', 1, $6, $6, $7, $8)`,
        [TENANT_A, revisionId, contractId, cleanVersion, started ? 'EFFECTIVE' : 'DRAFT', memberId(OFFICER), started ? memberId(OWNER) : null, started ? new Date().toISOString() : null],
      ],
    ]);
    return { id: contractId, code, revisionId, projectId: of.projectId };
  }

  const setTiers = (member: number, projectId: string, tierCount: unknown) => call('POST', `/projects/${projectId}/change-chain-config`, { member, body: { tier_count: tierCount } });
  const open = (member: number, target: Contract, overrides: Record<string, unknown> = {}) =>
    call('POST', `/contracts/${target.id}/change-requests`, { member, body: { stage: 'EVENT', baseline_revision_id: target.revisionId, event_kind: 'OWNER_INSTRUCTION', reason: REASON, estimated_delta_vnd: '400000000', schedule_impact_days: 10, ...overrides } });
  const promote = (member: number, requestId: string, version: number | string = 1, reason: unknown = 'The event is a change.') => call('POST', `/change-requests/${requestId}/promote`, { member, ifMatch: `"${version}"`, body: { reason } });
  const evaluate = (member: number, requestId: string, version: number | string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/change-requests/${requestId}/evaluate`, {
      member,
      ifMatch: `"${version}"`,
      body: { evaluated_delta_vnd: '500000000', schedule_impact_days: 20, funding_impact_note: 'Paid from the line of the plan.', scope_impact_note: 'Wider footpath along km 2.', ...overrides },
    });
  const withdraw = (member: number, requestId: string, version: number | string = 1, reason = 'Raised in error.') => call('POST', `/change-requests/${requestId}/withdraw`, { member, ifMatch: `"${version}"`, body: { reason } });
  const chainOf = (member: number, projectId: string, query = '') => call('GET', `/projects/${projectId}/change-chain${query}`, { member });

  const decide = (member: number, requestId: string, version: number | string, body: Record<string, unknown>) =>
    call('POST', `/contract-changes/${requestId}/decision`, { member, ifMatch: `"${version}"`, body });
  const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const approval = (overrides: Record<string, unknown> = {}) => ({ decision: 'approve', reason: 'Within the plan.', evidence_ids: [], effective_on: inTenDays, decision_document_version_id: cleanVersion, ...overrides });

  /** A CO that was assessed: raised and promoted by the officer, assessed by the evaluator (an increase names the line of capital). */
  async function assessed(delta = '500000000'): Promise<{ of: Capital; target: Contract; request: string; version: number }> {
    const { of, target, first } = await started(3);
    const pco = (await promote(OFFICER, first)).json.resource_id as string;
    const co = (await promote(OFFICER, pco)).json.resource_id as string;
    const done = await evaluate(EVALUATOR, co, 1, BigInt(delta) > 0n ? { evaluated_delta_vnd: delta, allocation_line_id: of.lineId } : { evaluated_delta_vnd: delta });
    expect(done.status).toBe(200);
    // An increase is approved only with a source (lane B2, G1-8): the contingency of the project is drawn for exactly this change order.
    if (BigInt(delta) > 0n) await coverChange(rows, { tenantId: TENANT_A, projectId: of.projectId, changeId: co, amountVnd: delta, authorityDocumentVersionId: cleanVersion, requester: memberId(OFFICER), approver: memberId(OWNER) });
    return { of, target, request: co, version: done.json.resource_version as number };
  }
  const revisionsOf = (contractId: string) =>
    rows<{ id: string; revision: number; status: string; kind: string; amount_vnd: string; valid_from: string; change_request_id: string | null }>(
      'select id, revision, status, kind, amount_vnd::text, valid_from::text, change_request_id from machvon.contract_revision where contract_id = $1::uuid order by revision',
      [contractId],
    );

  /** A project of three tiers with an active contract and its first request. */
  async function started(tiers = 3): Promise<{ of: Capital; target: Contract; first: string }> {
    const of = await project();
    const target = await contract(of);
    expect((await setTiers(OWNER, of.projectId, tiers)).status).toBe(200);
    const done = await open(OFFICER, target, tiers === 3 ? {} : { stage: tiers === 2 ? 'PCO' : 'CO' });
    expect(done.status).toBe(200);
    return { of, target, first: done.json.resource_id as string };
  }

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'CHG_OWNER', ['change.tiers.configure', 'change.read'], 40],
      [2, 'CHG_OFFICER', ['change.manage', 'change.read'], 30],
      [3, 'CHG_EVALUATOR', ['change.evaluate', 'change.read'], 30],
      [4, 'CHG_READER', ['change.read', 'change_request.read'], 10],
      [5, 'CHG_ALL', ['change.tiers.configure', 'change.manage', 'change.evaluate', 'change.read', 'change_request.read', 'contract.change.approve'], 50],
      [6, 'CHG_APPROVER', ['contract.change.approve', 'change.read', 'contract.read'], 50],
      [7, 'CHG_BOSS', ['change.read'], 70],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 80 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number, extra: { kind?: 'TENANT' | 'UNIT_SUBTREE' | 'CONTRACT'; refs?: string[] } = {}) => ({ n, member, role: 80 + role, kind: extra.kind ?? 'TENANT', ...(extra.refs === undefined ? {} : { refs: extra.refs }) });
    await harness.seedGrants(TENANT_A, [
      grant(1, OWNER, 1),
      grant(2, OFFICER, 2),
      grant(3, EVALUATOR, 3),
      grant(4, READER, 4),
      grant(5, ALL, 5),
      grant(6, ELSEWHERE, 2, { kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] }),
      grant(7, APPROVER, 6),
    ]);
    contractor = await seedContractor(harness);
    cleanVersion = id(FAMILY, 10);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'Contract', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(OFFICER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/contract.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, cleanVersion, id(FAMILY, 11)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ChangeChainController, ChangeRequestReadsController],
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

  it('is registered in the module of CTR', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([ChangeChainController, ChangeRequestReadsController]));
  });

  describe('setChangeChainTiers (AC-ST-CTR-006-1, UAT-AC307)', () => {
    it('sets the tiers of a project until its first request, audits and tells the world, and refuses a number that is not 1, 2 or 3', async () => {
      const of = await project();
      const done = await setTiers(OWNER, of.projectId, 3);
      expect(done).toMatchObject({ status: 200, json: { status: 'CONFIGURED', resource_version: 1 } });
      const configId = done.json.resource_id as string;
      expect(await configOf(of.projectId)).toMatchObject({ tier_count: 3, locked_at: null });
      expect(await setTiers(OWNER, of.projectId, 2)).toMatchObject({ status: 200, json: { resource_version: 2, resource_id: configId } });
      const [audit] = await audits(configId, 'change.tiers_configured');
      expect(audit).toMatchObject({ actor_id: memberId(OWNER), safe_diff: { project_id: of.projectId, tier_count: 3, previous_tier_count: null } });
      expect((await audits(configId, 'change.tiers_configured'))[1]?.safe_diff).toMatchObject({ tier_count: 2, previous_tier_count: 3 });
      const [event] = await events(configId, 'ctr.change_chain.configured.v1');
      expect(event?.payload).toMatchObject({ project_id: of.projectId, tier_count: 3, previous_tier_count: null, version: 1, actor_id: memberId(OWNER) });
      for (const wrong of [0, 4, '2', 1.5]) {
        const refused = await setTiers(OWNER, of.projectId, wrong);
        expect([400, 422]).toContain(refused.status);
        expect(refused.json.code).toMatch(/^(VALIDATION_FAILED|INVALID_REQUEST)$/);
      }
      expect(await configOf(of.projectId)).toMatchObject({ tier_count: 2 });
    });

    it('locks with the first request: 409 CHANGE_TIERS_LOCKED afterwards, and PRJ-A-002 with one tier starts at the CO', async () => {
      const first = await started(3);
      expect(await configOf(first.of.projectId)).toMatchObject({ tier_count: 3, locked_at: expect.any(String) });
      const locked = await setTiers(OWNER, first.of.projectId, 2);
      expect(locked).toMatchObject({ status: 409, json: { code: 'CHANGE_TIERS_LOCKED' } });
      expect(await configOf(first.of.projectId)).toMatchObject({ tier_count: 3 });

      const of = await project();
      const target = await contract(of);
      await setTiers(OWNER, of.projectId, 1);
      expect(await open(OFFICER, target, { stage: 'PCO' })).toMatchObject({ status: 422, json: { code: 'CHANGE_STAGE_NOT_ALLOWED' } });
      expect(await configOf(of.projectId)).toMatchObject({ locked_at: null });
      expect(await open(OFFICER, target, { stage: 'CO', event_kind: undefined })).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
    });

    it('is for whoever holds the permission in the scope of the project', async () => {
      const of = await project();
      expect((await setTiers(OFFICER, of.projectId, 2)).status).toBe(403);
      expect((await setTiers(NOBODY, of.projectId, 2)).status).toBe(403);
      expect((await setTiers(ELSEWHERE, of.projectId, 2)).status).toBe(403);
      expect(await setTiers(OWNER, randomUUID(), 2)).toMatchObject({ status: 404 });
      expect(await configOf(of.projectId)).toBeUndefined();
    });
  });

  describe('createChangeRequest', () => {
    it('raises the first request of a chain on a contract in force, with its audit row and its event', async () => {
      const of = await project();
      const target = await contract(of);
      await setTiers(OWNER, of.projectId, 3);
      expect(await open(OFFICER, target, { stage: 'PCO' })).toMatchObject({ status: 422, json: { code: 'CHANGE_STAGE_NOT_ALLOWED' } });
      const done = await open(OFFICER, target);
      expect(done).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 1 } });
      const requestId = done.json.resource_id as string;
      expect(await requestRow(requestId)).toMatchObject({ status: 'SUBMITTED', stage: 'EVENT', code: 'CE-001' });
      const [audit] = await audits(requestId, 'change.opened');
      expect(audit).toMatchObject({ actor_id: memberId(OFFICER), safe_diff: { code: 'CE-001', stage: 'EVENT', contract_id: target.id, from_status: null, to_status: 'SUBMITTED', estimated_delta_vnd: '400000000', locked_tiers: true } });
      const [event] = await events(requestId, 'ctr.change.opened.v1');
      expect(event?.payload).toMatchObject({ change_request_id: requestId, contract_id: target.id, project_id: of.projectId, code: 'CE-001', stage: 'EVENT', status: 'SUBMITTED', version: 1, actor_id: memberId(OFFICER) });
      expect(JSON.stringify(event?.payload)).not.toContain(REASON);
      expect(await open(OFFICER, target)).toMatchObject({ status: 200 });
      expect((await rows<{ code: string }>("select code from machvon.change_request where contract_id = $1::uuid order by created_at", [target.id])).map((r) => r.code)).toEqual(['CE-001', 'CE-002']);
    });

    it('answers the same request with the same key once', async () => {
      const of = await project();
      const target = await contract(of);
      await setTiers(OWNER, of.projectId, 3);
      const send = () => call('POST', `/contracts/${target.id}/change-requests`, { member: OFFICER, key: 'open-once-for-this-key', body: { stage: 'EVENT', baseline_revision_id: target.revisionId, reason: REASON } });
      const first = await send();
      expect(await send()).toEqual(first);
      expect(await rows('select id from machvon.change_request where contract_id = $1::uuid', [target.id])).toHaveLength(1);
    });

    it('judges the project, the contract and the baseline: no tiers, a contract not being performed, a revision of another contract, a body that says more', async () => {
      const bare = await project();
      expect(await open(OFFICER, await contract(bare))).toMatchObject({ status: 422, json: { code: 'CHANGE_STAGE_NOT_ALLOWED' } });
      const of = await project();
      await setTiers(OWNER, of.projectId, 3);
      expect(await open(OFFICER, await contract(of, 'DRAFT'))).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
      expect((await open(OFFICER, await contract(of, 'SUSPENDED'))).status).toBe(200);
      const target = await contract(of);
      const other = await contract(of);
      expect(await open(OFFICER, target, { baseline_revision_id: other.revisionId })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await open(OFFICER, target, { status: 'APPROVED', tenant_id: TENANT_A })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await open(OFFICER, target, { reason: '  ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    });

    it('is for whoever holds the permission over the contract: a contract outside the scope does not exist', async () => {
      const of = await project();
      const target = await contract(of);
      await setTiers(OWNER, of.projectId, 3);
      expect((await open(READER, target)).status).toBe(403);
      expect((await open(NOBODY, target)).status).toBe(403);
      expect((await open(ELSEWHERE, target)).status).toBe(404);
      expect((await open(OFFICER, { ...target, id: randomUUID() })).status).toBe(404);
      expect(await rows('select id from machvon.change_request where contract_id = $1::uuid', [target.id])).toEqual([]);
    });
  });

  describe('promoteChangeRequest and evaluateChangeRequest (AC-ST-CTR-006-2, UAT-AC308)', () => {
    it('takes CE-001 to PCO-001 to CO-001 and evaluates CO-001, and each move is audited and told', async () => {
      const { of, target, first } = await started(3);
      const toPco = await promote(OFFICER, first);
      expect(toPco).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 1 } });
      const pco = toPco.json.resource_id as string;
      expect(await requestRow(first)).toMatchObject({ status: 'PROMOTED', version: '2' });
      expect(await requestRow(pco)).toMatchObject({ stage: 'PCO', code: 'PCO-001', status: 'SUBMITTED' });
      const [promoted] = await audits(first, 'change.promoted');
      expect(promoted).toMatchObject({ reason: 'The event is a change.', safe_diff: { from_status: 'SUBMITTED', to_status: 'PROMOTED', promoted_to_id: pco, promoted_to_stage: 'PCO' } });
      const [opened] = await events(pco, 'ctr.change.promoted.v1');
      expect(opened?.payload).toMatchObject({ change_request_id: pco, promoted_from_id: first, stage: 'PCO', contract_id: target.id });

      const toCo = await promote(OFFICER, pco, 1, 'The price is agreed.');
      const co = toCo.json.resource_id as string;
      expect(await requestRow(pco)).toMatchObject({ status: 'PROMOTED' });
      expect(await requestRow(co)).toMatchObject({ stage: 'CO', code: 'CO-001' });

      const done = await evaluate(EVALUATOR, co, 1, { allocation_line_id: of.lineId });
      expect(done).toMatchObject({ status: 200, json: { status: 'EVALUATED', resource_version: 2 } });
      expect(await requestRow(co)).toMatchObject({ status: 'EVALUATED', version: '2' });
      const stored = (await rows<{ evaluated_delta_vnd: string; schedule_impact_days: number; funding_impact_note: string; scope_impact_note: string; evaluated_by: string }>(
        'select evaluated_delta_vnd::text, schedule_impact_days, funding_impact_note, scope_impact_note, evaluated_by from machvon.change_request where id = $1::uuid',
        [co],
      ))[0];
      expect(stored).toEqual({ evaluated_delta_vnd: '500000000', schedule_impact_days: 20, funding_impact_note: 'Paid from the line of the plan.', scope_impact_note: 'Wider footpath along km 2.', evaluated_by: memberId(EVALUATOR) });
      const [audit] = await audits(co, 'change.evaluated');
      expect(audit).toMatchObject({ actor_id: memberId(EVALUATOR), safe_diff: { from_status: 'SUBMITTED', to_status: 'EVALUATED', evaluated_delta_vnd: '500000000', schedule_impact_days: 20 } });
      expect((await events(co, 'ctr.change.evaluated.v1'))[0]?.aggregate_version).toBe('2');
    });

    it('asks CAP for an increase: a line that cannot take it is 422 ALLOCATION_UNAVAILABLE and nothing is recorded, and an increase needs a line', async () => {
      const { of, first } = await started(2);
      const co = (await promote(OFFICER, first)).json.resource_id as string;
      expect(await evaluate(EVALUATOR, co, 1, { evaluated_delta_vnd: '100000000' })).toMatchObject({ status: 422, json: { code: 'ALLOCATION_UNAVAILABLE' } });
      expect(await evaluate(EVALUATOR, co, 1, { evaluated_delta_vnd: money(70), allocation_line_id: of.lineId })).toMatchObject({ status: 422, json: { code: 'ALLOCATION_UNAVAILABLE' } });
      expect(await evaluate(EVALUATOR, co, 1, { evaluated_delta_vnd: '1', allocation_line_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'ALLOCATION_UNAVAILABLE' } });
      expect(await requestRow(co)).toMatchObject({ status: 'SUBMITTED', version: '1' });
      // A decrease asks nothing of the capital.
      expect(await evaluate(EVALUATOR, co, 1, { evaluated_delta_vnd: '-3000000' })).toMatchObject({ status: 200, json: { status: 'EVALUATED' } });
      expect(await evaluate(EVALUATOR, co, 2, { evaluated_delta_vnd: '9000000', allocation_line_id: of.lineId })).toMatchObject({ status: 200, json: { resource_version: 3 } });
    });

    it('judges the version, the tier and the state of the request', async () => {
      const { first } = await started(3);
      expect(await promote(OFFICER, first, 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await evaluate(EVALUATOR, first, 1)).toMatchObject({ status: 422, json: { code: 'CHANGE_STAGE_NOT_ALLOWED' } });
      expect(await promote(OFFICER, first, 1, '')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const pco = (await promote(OFFICER, first)).json.resource_id as string;
      expect(await promote(OFFICER, first, 2)).toMatchObject({ status: 409, json: { code: 'CHANGE_STATE_INVALID' } });
      const co = (await promote(OFFICER, pco)).json.resource_id as string;
      expect(await promote(OFFICER, co)).toMatchObject({ status: 422, json: { code: 'CHANGE_STAGE_NOT_ALLOWED' } });
      expect(await evaluate(EVALUATOR, co, 1, { evaluated_delta_vnd: 'x' })).toMatchObject({ status: 422, json: { code: expect.stringMatching(/^(VALIDATION_FAILED|INVALID_REQUEST)$/) } });
      expect(await evaluate(EVALUATOR, co, 1, { evaluated_delta_vnd: '1.5' })).toMatchObject({ status: 422, json: { code: expect.stringMatching(/^(VALIDATION_FAILED|INVALID_REQUEST)$/) } });
      expect(await evaluate(EVALUATOR, co, 1, { allocation_line_id: undefined, evaluated_delta_vnd: '0' })).toMatchObject({ status: 200 });
    });

    it('is for whoever holds the permission: an officer promotes and does not evaluate, an evaluator the reverse; outside the scope the request does not exist', async () => {
      const { first } = await started(3);
      expect((await promote(EVALUATOR, first)).status).toBe(403);
      expect((await promote(READER, first)).status).toBe(403);
      expect((await promote(ELSEWHERE, first)).status).toBe(404);
      const pco = (await promote(OFFICER, first)).json.resource_id as string;
      expect((await evaluate(OFFICER, pco, 1)).status).toBe(403);
      expect((await evaluate(NOBODY, pco, 1)).status).toBe(403);
      expect((await promote(OFFICER, randomUUID())).status).toBe(404);
      expect(await requestRow(pco)).toMatchObject({ status: 'SUBMITTED', version: '1' });
    });

    it('stops at a contract that is no longer being performed', async () => {
      const { target, first } = await started(3);
      // The completion names the minutes of the acceptance and the person who completed it; the minutes are not part of this test, so the foreign key is switched off.
      await asSuperuser(world.harness.database.adminUrl, "update machvon.contract set status = 'COMPLETED', completed_on = date '2027-08-01', completion_quality_acceptance_id = gen_random_uuid(), completed_by = $2::uuid where id = $1::uuid", [target.id, memberId(OFFICER)]);
      expect(await promote(OFFICER, first)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
    });
  });

  describe('withdrawChangeRequest', () => {
    it('withdraws an open request with its reason, audited and told, and not again', async () => {
      const { first } = await started(3);
      const done = await withdraw(OFFICER, first, 1, 'The owner changed their mind.');
      expect(done).toMatchObject({ status: 200, json: { status: 'WITHDRAWN', resource_version: 2 } });
      expect(await requestRow(first)).toMatchObject({ status: 'WITHDRAWN' });
      expect((await audits(first, 'change.withdrawn'))[0]).toMatchObject({ reason: 'The owner changed their mind.', safe_diff: { from_status: 'SUBMITTED', to_status: 'WITHDRAWN' } });
      expect((await events(first, 'ctr.change.withdrawn.v1'))[0]?.payload).toMatchObject({ status: 'WITHDRAWN', from_status: 'SUBMITTED' });
      expect(await withdraw(OFFICER, first, 2)).toMatchObject({ status: 409, json: { code: 'CHANGE_STATE_INVALID' } });
      expect(await withdraw(OFFICER, first, 1)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await withdraw(EVALUATOR, first, 2)).status).toBe(403);
      expect((await withdraw(ELSEWHERE, first, 2)).status).toBe(404);
    });
  });

  describe('getChangeChain (CTR-19, CTR-07, CTR-20)', () => {
    it('reads the tiers, the requests and what the caller may do: the owner configures, the officer opens and promotes, the evaluator evaluates, the reader only reads', async () => {
      const { of, target, first } = await started(3);
      const pco = (await promote(OFFICER, first)).json.resource_id as string;
      const board = await chainOf(ALL, of.projectId);
      expect(board.status).toBe(200);
      expect(board.json).toMatchObject({
        project_id: of.projectId,
        config: { tier_count: 3, stages: ['EVENT', 'PCO', 'CO'], locked: true, locked_by_change: { id: first, code: 'CE-001' }, set_by: memberId(OWNER), version: 2 },
        actions: { configure: true, open: true },
      });
      const requests = board.json.requests as Array<Record<string, unknown>>;
      expect(requests.map((r) => r.code)).toEqual(['CE-001', 'PCO-001']);
      expect(requests[0]).toMatchObject({ id: first, stage: 'EVENT', status: 'PROMOTED', contract: { id: target.id, code: target.code, status: 'ACTIVE' }, estimated_delta_vnd: '400000000', actions: { promote: false, evaluate: false, withdraw: false } });
      expect(requests[1]).toMatchObject({ id: pco, parent_id: first, status: 'SUBMITTED', actions: { promote: true, evaluate: true, withdraw: true } });
      expect(typeof board.json.as_of).toBe('string');

      const officer = await chainOf(OFFICER, of.projectId);
      expect(officer.json).toMatchObject({ actions: { configure: false, open: true } });
      expect((officer.json.requests as Array<Record<string, unknown>>)[1]).toMatchObject({ actions: { promote: true, evaluate: false, withdraw: true } });
      expect(((await chainOf(EVALUATOR, of.projectId)).json.requests as Array<Record<string, unknown>>)[1]).toMatchObject({ actions: { promote: false, evaluate: true, withdraw: false } });
      expect(await chainOf(OWNER, of.projectId)).toMatchObject({ json: { actions: { configure: true, open: false } } });
      const reader = await chainOf(READER, of.projectId);
      expect(reader.json).toMatchObject({ actions: { configure: false, open: false } });
      expect((reader.json.requests as Array<Record<string, unknown>>)[1]).toMatchObject({ actions: { promote: false, evaluate: false, withdraw: false } });
    });

    it('narrows to a contract, says nothing of a project that has no tiers yet but lets the owner set them, and refuses what is not a contract id', async () => {
      const { of, target, first } = await started(3);
      const second = await contract(of);
      const other = (await open(OFFICER, second)).json.resource_id as string;
      const only = await chainOf(ALL, of.projectId, `?contract_id=${second.id}`);
      expect((only.json.requests as Array<Record<string, unknown>>).map((r) => r.id)).toEqual([other]);
      expect(((await chainOf(ALL, of.projectId, `?contract_id=${target.id}`)).json.requests as Array<Record<string, unknown>>).map((r) => r.id)).toEqual([first]);
      expect(await chainOf(ALL, of.projectId, '?contract_id=nope')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const bare = await project();
      const empty = await chainOf(ALL, bare.projectId);
      expect(empty.status).toBe(200);
      expect(empty.json).toMatchObject({ project_id: bare.projectId, requests: [], actions: { configure: true, open: true } });
      expect(empty.json).not.toHaveProperty('config');
    });

    it('does not show a project to a caller who does not reach it, whether or not the project exists', async () => {
      const { of } = await started(3);
      expect((await chainOf(NOBODY, of.projectId)).status).toBe(403);
      expect((await chainOf(ELSEWHERE, of.projectId)).status).toBe(404);
      expect((await chainOf(ALL, randomUUID())).status).toBe(404);
    });

    it('shows a guest contractor the tier and the status of the requests of its own contract, and nothing of the assessment', async () => {
      const { of, target, first } = await started(3);
      const second = await contract(of);
      await open(OFFICER, second);
      await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST), contractor]);
      await harness.seedGrants(TENANT_A, [{ n: 41, member: GUEST, role: 84, kind: 'CONTRACT', refs: [target.id] }]);
      const guest = await chainOf(GUEST, of.projectId);
      expect(guest.status).toBe(200);
      expect(guest.json).not.toHaveProperty('config');
      expect(guest.json).toMatchObject({ actions: { configure: false, open: false } });
      const requests = guest.json.requests as Array<Record<string, unknown>>;
      expect(requests.map((r) => r.id)).toEqual([first]);
      expect(Object.keys(requests[0] ?? {}).sort()).toEqual(['code', 'contract', 'created_at', 'id', 'parent_id', 'project_id', 'stage', 'status', 'version']);
      expect(JSON.stringify(guest.json)).not.toContain(REASON);
      // The contract of another is absent, not forbidden.
      expect((await call('GET', `/resources/change_request/${(await rows<{ id: string }>('select id from machvon.change_request where contract_id = $1::uuid', [second.id]))[0]?.id}`, { member: GUEST })).status).toBe(404);
    });
  });

  describe('the resource /resources/change_request', () => {
    it('lists the requests in the scope of the caller a page at a time, oldest first, and reads one', async () => {
      const { of, first } = await started(3);
      const pco = (await promote(OFFICER, first)).json.resource_id as string;
      const mine = new Set([first, pco]);
      const all: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Reply = await call('GET', `/resources/change_request?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`, { member: READER });
        expect(page.status).toBe(200);
        all.push(...(page.json.items as Array<Record<string, unknown>>));
        cursor = page.json.next_cursor as string | null;
        pages += 1;
      } while (cursor !== null && pages < 100);
      const ours = all.filter((item) => mine.has(item.id as string));
      expect(ours.map((item) => item.code)).toEqual(['CE-001', 'PCO-001']);
      expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
      expect(ours[0]).toMatchObject({ project_id: of.projectId, reason: REASON, estimated_delta_vnd: '400000000' });
      const one = await call('GET', `/resources/change_request/${pco}`, { member: READER });
      expect(one).toMatchObject({ status: 200, json: { id: pco, stage: 'PCO', parent_id: first } });
      expect((await call('GET', `/resources/change_request/${pco}`, { member: ELSEWHERE })).status).toBe(403);
      expect((await call('GET', `/resources/change_request/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', '/resources/change_request?limit=0', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/change_request', { member: NOBODY })).status).toBe(403);
    });

    it('shows a guest contractor only the tier and the status', async () => {
      const { first } = await started(3);
      await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST_OF_ONE), contractor]);
      await harness.seedGrants(TENANT_A, [{ n: 42, member: GUEST_OF_ONE, role: 84, kind: 'CONTRACT', refs: [(await rows<{ contract_id: string }>('select contract_id from machvon.change_request where id = $1::uuid', [first]))[0]?.contract_id as string] }]);
      const one = await call('GET', `/resources/change_request/${first}`, { member: GUEST_OF_ONE });
      expect(one.status).toBe(200);
      expect(one.json).toMatchObject({ id: first, stage: 'EVENT', status: 'SUBMITTED', code: 'CE-001' });
      for (const hidden of ['reason', 'estimated_delta_vnd', 'evaluated_delta_vnd', 'funding_impact_note', 'submitted_by', 'actions']) expect(one.json).not.toHaveProperty(hidden);
    });
  });

  describe('post_contract_changes_id_decision (AC-ST-CTR-007-1, AC-ST-CTR-007-2, UAT-AC308)', () => {
    it('AC-ST-CTR-007-1, UAT-AC308: the maker is refused, the approver makes revision 2 pending with the new value, and tells the world with ids and amounts only', async () => {
      const { target, request, version } = await assessed('500000000');
      // Whoever raised and promoted the chain is refused even when they hold the right.
      const own = await started(3);
      const ownPco = (await promote(ALL, own.first)).json.resource_id as string;
      const ownCo = (await promote(ALL, ownPco)).json.resource_id as string;
      const ownDone = await evaluate(ALL, ownCo, 1, { evaluated_delta_vnd: '-1000' });
      expect(await decide(ALL, ownCo, ownDone.json.resource_version as number, approval())).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await requestRow(ownCo))?.status).toBe('EVALUATED');

      expect(await decide(APPROVER, request, version, approval({ decision_document_version_id: undefined }))).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
      const done = await decide(APPROVER, request, version, approval({ reason: ' Within the plan. ' }));
      expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_id: request, resource_version: version + 1 } });
      expect(await revisionsOf(target.id)).toMatchObject([
        { revision: 1, status: 'EFFECTIVE', kind: 'BASE' },
        { revision: 2, status: 'PENDING_EFFECTIVE', kind: 'CHANGE_ORDER', amount_vnd: '10500000000', valid_from: inTenDays, change_request_id: request },
      ]);
      const [revision] = (await revisionsOf(target.id)).slice(1);
      const [approved] = await audits(request, 'change.approved');
      expect(approved).toMatchObject({ actor_id: memberId(APPROVER), reason: 'Within the plan.', safe_diff: { from_status: 'EVALUATED', to_status: 'APPROVED', approved_delta_vnd: '500000000', effective_on: inTenDays, to_value_vnd: '10500000000', revision_id: revision?.id } });
      expect((await audits(revision?.id ?? '', 'contract.revision_created'))[0]?.safe_diff).toMatchObject({ contract_id: target.id, revision: 2, amount_vnd: '10500000000', status: 'PENDING_EFFECTIVE', change_request_id: request });
      const [approvedEvent] = await events(request, 'ctr.change.approved.v1');
      expect(approvedEvent?.payload).toMatchObject({ change_request_id: request, contract_id: target.id, approved_delta_vnd: '500000000', effective_on: inTenDays, revision_id: revision?.id, to_status: 'APPROVED', actor_id: memberId(APPROVER) });
      expect(JSON.stringify(approvedEvent?.payload)).not.toContain('Within the plan');
      expect((await events(revision?.id ?? '', 'ctr.contract_revision.created.v1'))[0]?.payload).toMatchObject({ revision: 2, kind: 'CHANGE_ORDER', supersedes_id: (await revisionsOf(target.id))[0]?.id });
      // It is over: a second decision is refused.
      expect(await decide(APPROVER, request, version + 1, approval())).toMatchObject({ status: 409, json: { code: 'CHANGE_STATE_INVALID' } });
    });

    it('offers the decision on the board to someone who may take it, and shows the revision it made afterwards', async () => {
      const { of, request, version } = await assessed('100000000');
      const board = async (member: number) => ((await chainOf(member, of.projectId)).json.requests as Array<Record<string, unknown>>).find((r) => r.id === request);
      expect((await board(APPROVER))?.actions).toMatchObject({ decide: true });
      expect((await board(ALL))?.actions).toMatchObject({ decide: true });
      expect((await board(OFFICER))?.actions).toMatchObject({ decide: false });
      expect((await board(EVALUATOR))?.actions).toMatchObject({ decide: false });
      expect((await board(READER))?.actions).toMatchObject({ decide: false });
      expect(await decide(APPROVER, request, version, approval())).toMatchObject({ status: 200 });
      const after = await board(APPROVER);
      expect(after).toMatchObject({ status: 'APPROVED', approved_delta_vnd: '100000000', effective_on: inTenDays, actions: { decide: false } });
      expect(typeof after?.resulting_revision_id).toBe('string');
    });

    it('gives the change back to be assessed again, and rejects it, each with its reason, its audit row and its event', async () => {
      const { request, version } = await assessed('100000000');
      const back = await decide(APPROVER, request, version, { decision: 'return', reason: 'The funding note is thin.', evidence_ids: [] });
      expect(back).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: version + 1 } });
      expect((await audits(request, 'change.returned'))[0]).toMatchObject({ reason: 'The funding note is thin.', safe_diff: { from_status: 'EVALUATED', to_status: 'SUBMITTED', decision: 'return' } });
      expect((await events(request, 'ctr.change.returned.v1'))[0]?.payload).toMatchObject({ to_status: 'SUBMITTED', decision: 'return' });
      const again = await evaluate(EVALUATOR, request, version + 1, { evaluated_delta_vnd: '90000000', allocation_line_id: (await rows<{ evaluation_allocation_line_id: string }>('select evaluation_allocation_line_id from machvon.change_request where id = $1::uuid', [request]))[0]?.evaluation_allocation_line_id });
      expect(again.status).toBe(200);
      const rejected = await decide(APPROVER, request, again.json.resource_version as number, { decision: 'reject', reason: 'Not needed.', evidence_ids: [] });
      expect(rejected).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect((await requestRow(request))?.status).toBe('REJECTED');
      expect((await audits(request, 'change.rejected'))[0]).toMatchObject({ reason: 'Not needed.' });
      expect((await events(request, 'ctr.change.rejected.v1'))[0]?.payload).toMatchObject({ to_status: 'REJECTED', decision: 'reject' });
    });

    it('judges the day, the value, the BOQ and the version, and writes nothing when it refuses', async () => {
      const { target, request, version } = await assessed('100000000');
      expect(await decide(APPROVER, request, version, approval({ effective_on: '2020-01-01' }))).toMatchObject({ status: 422, json: { code: 'RETROACTIVE_NOT_ALLOWED' } });
      expect(await decide(APPROVER, request, version, approval({ effective_on: '2026-01-02' }))).toMatchObject({ status: 422, json: { code: 'RETROACTIVE_NOT_ALLOWED' } });
      expect(await decide(APPROVER, request, version, approval({ approved_delta_vnd: '-9999999999999' }))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await decide(APPROVER, request, version, approval({ boq_lines: [{ business_key: 'X' }] }))).toMatchObject({ status: 422 });
      expect(await decide(APPROVER, request, version + 3, approval())).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await decide(APPROVER, request, version, approval({ decision: 'maybe' }))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await decide(APPROVER, request, version, approval({ tenant_id: TENANT_A, status: 'APPROVED' }))).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await revisionsOf(target.id)).toHaveLength(1);
      expect((await requestRow(request))?.status).toBe('EVALUATED');
      // The accepted value is a floor.
      await world.owner('update machvon.contract set accepted_total_vnd = 9000000000 where id = $1::uuid', [target.id]);
      const lower = await started(3);
      const lowerPco = (await promote(OFFICER, lower.first)).json.resource_id as string;
      const lowerCo = (await promote(OFFICER, lowerPco)).json.resource_id as string;
      const assessedLower = await evaluate(EVALUATOR, lowerCo, 1, { evaluated_delta_vnd: '-2000000000' });
      await world.owner('update machvon.contract set accepted_total_vnd = 9000000000 where id = $1::uuid', [lower.target.id]);
      expect(await decide(APPROVER, lowerCo, assessedLower.json.resource_version as number, approval())).toMatchObject({ status: 422, json: { code: 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT' } });
    });

    it('is for whoever holds the right over the contract: others are refused, a contract out of reach does not exist, a request that is no CO is not decided', async () => {
      const { request, version } = await assessed('100000000');
      for (const member of [OFFICER, EVALUATOR, READER, NOBODY, OWNER]) expect((await decide(member, request, version, approval())).status).toBe(403);
      expect((await decide(ELSEWHERE, request, version, approval())).status).toBe(403);
      expect((await decide(APPROVER, randomUUID(), 1, approval())).status).toBe(404);
      const { first } = await started(3);
      expect(await decide(APPROVER, first, 1, approval())).toMatchObject({ status: 422, json: { code: 'CHANGE_STAGE_NOT_ALLOWED' } });
      expect((await requestRow(request))?.status).toBe('EVALUATED');
    });

    it('answers the same request with the same key once', async () => {
      const { target, request, version } = await assessed('100000000');
      const send = () => call('POST', `/contract-changes/${request}/decision`, { member: APPROVER, ifMatch: `"${version}"`, key: 'decide-once-for-this-key', body: approval() });
      const first = await send();
      expect(await send()).toEqual(first);
      expect(await revisionsOf(target.id)).toHaveLength(2);
    });
  });

  describe('the delegation limit of a change order', () => {
    it('limits the approval to the bands the tenant configured: a change above the band of the approver is 403 SCOPE_DENIED, one within it goes through', async () => {
      const matrix = id(FAMILY, 21);
      await world.owner(
        `insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version)
         values ($1, $2, 901, 'Draft', date '2020-01-01', 'Fixture regulation on the approval of change orders', $3, $3, 1)`,
        [TENANT_A, matrix, memberId(OWNER)],
      );
      await world.owner(
        `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, position)
         values ($1, $2, $3, 'CTR_CHANGE', $4, true, 0, 600000000, $5, 0), ($1, $6, $3, 'CTR_CHANGE', $4, true, 600000000, null, $7, 1)`,
        [TENANT_A, id(FAMILY, 22), matrix, unitId(ROOT), roleId(86), id(FAMILY, 23), roleId(87)],
      );
      await world.owner("update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrix]);
      await world.owner("update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [matrix, memberId(READER)]);
      const small = await assessed('500000000');
      const large = await assessed('700000000');
      expect(await decide(APPROVER, large.request, large.version, approval())).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await requestRow(large.request))?.status).toBe('EVALUATED');
      expect(await decide(APPROVER, small.request, small.version, approval())).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    });
  });
});
