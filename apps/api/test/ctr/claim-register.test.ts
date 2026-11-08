import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ClaimController, ClaimReadsController, ClaimTermController } from '../../src/modules/ctr/claim.controller';
import { ContractController, ContractReadsController, ContractRevisionReadsController } from '../../src/modules/ctr/contract.controller';
import { ctrModule } from '../../src/modules/ctr';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedCtrWorld } from '../../../../packages/db/test/support/ctr-fixtures';
import type { CtrWorld } from '../../../../packages/db/test/support/ctr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const OFFICER = 1; // registers claims, records steps, proposes terms; holds the rights to approve, settle and bar too, to show that the four-eyes rule refuses the maker
const LEGAL = 2; // approves terms and settlements, declares a bar
const READER = 3; // claim.read only
const ELSEWHERE = 4; // claim.manage over another branch, claim.read over the tenant
const NOBODY = 5;
const GUEST = 6; // a guest of one contract
const B_OFFICER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0xc8;
const DAY = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

/** The Vietnam day `days` days from today (negative: in the past), which is the day the commands read as "today". */
const dayFromToday = (days: number): string => vietnamDateOf(new Date(Date.now() + days * DAY));

describe('the claim register and its terms (G1-9)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let world: CtrWorld;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const events = async (id: string): Promise<string[]> => (await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [id])).map((event) => event.type);
  const auditActions = async (id: string): Promise<string[]> => (await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [id])).map((event) => event.action);

  async function contract(code: string, activate = true): Promise<string> {
    const made = await call('POST', '/contracts', {
      member: OFFICER,
      body: { project_id: world.project, package_id: world.packageId, contractor_id: world.lead, code, title: 'Construction of the bridge', type: 'UNIT_PRICE', advance_category: 'CONSTRUCTION', contract_value_vnd: '10000000000', document_version_id: world.document },
    });
    expect(made.status).toBe(200);
    if (activate) {
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query('set session_replication_role = replica');
        await client.query("update machvon.contract set status = 'ACTIVE', signed_on = date '2026-01-01', effective_from = date '2026-01-01' where id = $1::uuid", [idOf(made)]);
      } finally {
        await client.end();
      }
    }
    return idOf(made);
  }

  const termBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ claimant_side: 'CONTRACTOR', notice_days: 28, particulars_days: 42, response_days: 14, settlement_days: 30, bar_effect: 'BARS_CLAIM', clause_reference: 'Clause 20.1 of the contract', ...extra });
  const claimBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return { claimant_side: 'CONTRACTOR', kind: 'EXTENSION_OF_TIME', title: `Late handover of the site ${counter}`, event_description: 'The site was handed over twenty days late.', event_on: dayFromToday(-45), awareness_on: dayFromToday(-40), claimed_days: 20, claimed_amount_vnd: '500000000', ...extra };
  };
  const proposeTerm = (member: number, contractId: string, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', `/contracts/${contractId}/claim-terms`, { member, body: termBody(extra), ...options });
  const decideTerm = (member: number, id: string, version: number | string, body: Record<string, unknown> = { decision: 'APPROVE', note: 'Checked against the signed contract.' }): Promise<Reply> => call('POST', `/claim-terms/${id}/decision`, { member, ifMatch: `"${version}"`, body });
  const approvedTerm = async (contractId: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const proposed = await proposeTerm(OFFICER, contractId, extra);
    expect(proposed.status).toBe(200);
    const decided = await decideTerm(LEGAL, idOf(proposed), 1);
    expect(decided.json).toMatchObject({ status: 'APPROVED' });
    return idOf(proposed);
  };
  const register = (member: number, contractId: string, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', `/contracts/${contractId}/claims`, { member, body: claimBody(extra), ...options });
  const step = (member: number, id: string, version: number | string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/claims/${id}/steps`, { member, ifMatch: `"${version}"`, body });
  const settle = (member: number, id: string, version: number | string, body: Record<string, unknown> = { decision: 'APPROVE', note: 'Settlement checked against the response.' }): Promise<Reply> => call('POST', `/claims/${id}/settlement-decision`, { member, ifMatch: `"${version}"`, body });
  const bar = (member: number, id: string, version: number | string, body: Record<string, unknown> = { reason: 'The notice was never served within the clause.' }): Promise<Reply> => call('POST', `/claims/${id}/bar`, { member, ifMatch: `"${version}"`, body });
  const get = (member: number, id: string, tenantId = TENANT_A): Promise<Reply> => call('GET', `/claims/${id}`, { member, tenantId });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      ]);
    }
    for (const n of [OFFICER, LEGAL, READER, ELSEWHERE, NOBODY, GUEST]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_OFFICER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'CLAIM_OFFICER', ['contract.create', 'contract.update', 'contract.read', 'claim.read', 'claim.manage', 'claim.term.propose', 'claim.term.approve', 'claim.settle', 'claim.bar'], 40);
    await harness.seedRole(TENANT_A, 2, 'LEGAL_COUNSEL', ['claim.read', 'claim.term.approve', 'claim.settle', 'claim.bar'], 50);
    await harness.seedRole(TENANT_A, 3, 'CLAIM_READER', ['claim.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'ELSEWHERE_OFFICER', ['claim.manage', 'claim.term.propose'], 30);
    await harness.seedRole(TENANT_A, 5, 'GUEST_CLAIM', ['claim.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'CLAIM_OFFICER', ['contract.create', 'claim.read', 'claim.manage', 'claim.term.propose'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'TENANT' },
      { n: 2, member: LEGAL, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: ELSEWHERE, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
      { n: 5, member: ELSEWHERE, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_OFFICER, role: 1, kind: 'TENANT' }]);
    world = await seedCtrWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, ROOT);
    await harness.owner(TENANT_A, [
      ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1 and tenant_id = $3", [memberId(GUEST), world.lead, TENANT_A]],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ContractController, ContractReadsController, ContractRevisionReadsController, ClaimTermController, ClaimController, ClaimReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of the contracts with its controllers', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([ClaimTermController, ClaimController, ClaimReadsController]));
  });

  describe('the term of a contract', () => {
    it('is proposed by one person and approved by another, replays a key, and never rests on a default', async () => {
      const contractId = await contract('HD-CL-001');
      const empty = await call('GET', `/contracts/${contractId}/claim-terms`, { member: OFFICER });
      expect(empty.json).toMatchObject({ items: [], can_propose: true, contract: { id: contractId, code: 'HD-CL-001' } });
      // The templates are examples, flagged unverified, and name no contract.
      const templates = empty.json.templates as Array<{ code: string; notice_days: number | null; rule: { unverified: boolean; source: string } }>;
      expect(templates.map((entry) => entry.code).sort()).toEqual(['FIDIC_2017_EXAMPLE', 'NEC4_EXAMPLE']);
      expect(templates.every((entry) => entry.rule.unverified && entry.rule.source === 'DEFAULT')).toBe(true);

      const key = `K-TERM-${randomUUID()}`;
      const proposed = await proposeTerm(OFFICER, contractId, {}, { key });
      expect(proposed).toMatchObject({ status: 200, json: { status: 'PROPOSED', resource_version: 1 } });
      const replay = await proposeTerm(OFFICER, contractId, {}, { key });
      expect(replay.json).toEqual(proposed.json);
      const conflict = await proposeTerm(OFFICER, contractId, { notice_days: 14 }, { key });
      expect([conflict.status, conflict.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      const id = idOf(proposed);

      const own = await decideTerm(OFFICER, id, 1);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const second = await proposeTerm(OFFICER, contractId, { notice_days: 21 });
      expect([second.status, second.json.code]).toEqual([409, 'CLAIM_TERM_PENDING']);
      const stale = await decideTerm(LEGAL, id, 5);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const rejectedWithoutWords = await decideTerm(LEGAL, id, 1, { decision: 'REJECT' });
      expect([rejectedWithoutWords.status, rejectedWithoutWords.json.code, rejectedWithoutWords.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'note']);
      const approved = await decideTerm(LEGAL, id, 1);
      expect(approved.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });

      const listed = await call('GET', `/contracts/${contractId}/claim-terms`, { member: LEGAL });
      const item = (listed.json.items as Array<Record<string, unknown>>)[0];
      expect(item).toMatchObject({ id, status: 'APPROVED', claimant_side: 'CONTRACTOR', notice_days: 28, particulars_days: 42, bar_effect: 'BARS_CLAIM', clause_reference: 'Clause 20.1 of the contract', can_decide: false });
      expect(listed.json.can_propose).toBe(false);
      expect(await events(id)).toEqual(['ctr.claim_term.proposed.v1', 'ctr.claim_term.decided.v1']);
      expect(await auditActions(id)).toEqual(['ctr.claim_term.proposed', 'ctr.claim_term.decided']);
    });

    it('refuses a term that gives no period or a bar without a period, and a contract the caller cannot change', async () => {
      const contractId = await contract('HD-CL-002');
      const none = await proposeTerm(OFFICER, contractId, { notice_days: undefined, particulars_days: undefined, response_days: undefined, settlement_days: undefined });
      expect([none.status, none.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const bare = await proposeTerm(OFFICER, contractId, { notice_days: undefined, particulars_days: undefined, settlement_days: undefined });
      expect([bare.status, bare.json.detail]).toEqual([422, 'bar_effect']);
      const elsewhere = await proposeTerm(ELSEWHERE, contractId);
      expect([elsewhere.status, elsewhere.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const nobody = await proposeTerm(NOBODY, contractId);
      expect(nobody.status).toBe(403);
      const foreign = await call('GET', `/contracts/${contractId}/claim-terms`, { member: B_OFFICER, tenantId: TENANT_B });
      expect(foreign.status).toBe(404);
    });
  });

  describe('a claim', () => {
    it('is registered, followed step by step with its clocks, and settled by somebody other than the proposer', async () => {
      const contractId = await contract('HD-CL-003');
      await approvedTerm(contractId);
      const registered = await register(OFFICER, contractId, { awareness_on: dayFromToday(-10), event_on: dayFromToday(-12) });
      expect(registered).toMatchObject({ status: 200, json: { status: 'EVENT_RECORDED', resource_version: 1 } });
      const id = idOf(registered);
      const fresh = (await get(OFFICER, id)).json;
      expect(fresh).toMatchObject({
        code: expect.stringMatching(/^CLM-\d{3}$/),
        claimant_side: 'CONTRACTOR',
        status: 'EVENT_RECORDED',
        claimed_days: 20,
        claimed_amount_vnd: '500000000',
        limitation: { status: 'RUNNING', code: 'NOTICE', due_on: dayFromToday(18), days_left: 18 },
        term: { status: 'APPROVED', notice_days: 28 },
        calendar_published: false,
        policy: { source: 'DEFAULT', unverified: true },
        allowed: { steps: ['NOTICE', 'WITHDRAWAL'], decide_settlement: false, declare_bar: false, link: true },
      });
      expect((fresh.deadlines as Record<string, { state: string }>).PARTICULARS?.state).toBe('NOT_STARTED');

      const served = await step(OFFICER, id, 1, { kind: 'NOTICE', occurred_on: dayFromToday(-8), note: 'Notice served by registered letter.' });
      expect(served.json).toMatchObject({ status: 'NOTICE_SERVED', resource_version: 2 });
      expect((await step(OFFICER, id, 2, { kind: 'PARTICULARS', occurred_on: dayFromToday(-6), note: 'Fully detailed claim with the programme.', claimed_amount_vnd: '400000000', claimed_days: 15 })).status).toBe(200);
      const responded = await step(OFFICER, id, 3, { kind: 'RESPONSE', occurred_on: dayFromToday(-4), note: 'The engineer accepted the claim in part.', decision: 'PARTLY_ACCEPTED' });
      expect(responded.json.status).toBe('RESPONDED');
      const tooMuch = await step(OFFICER, id, 4, { kind: 'SETTLEMENT_PROPOSAL', occurred_on: dayFromToday(-2), note: 'More than was asked for.', settled_amount_vnd: '400000001', granted_days: 5 });
      expect([tooMuch.status, tooMuch.json.code]).toEqual([422, 'CLAIM_SETTLEMENT_EXCEEDS_CLAIM']);
      const proposed = await step(OFFICER, id, 4, { kind: 'SETTLEMENT_PROPOSAL', occurred_on: dayFromToday(-2), note: 'Agreed in the meeting.', settled_amount_vnd: '300000000', granted_days: 10 });
      expect(proposed.json).toMatchObject({ status: 'SETTLEMENT_PROPOSED', resource_version: 5 });
      const proposedView = (await get(LEGAL, id)).json;
      expect(proposedView.allowed).toMatchObject({ steps: [], decide_settlement: true, declare_bar: false, link: false });
      expect(proposedView).toMatchObject({ settled_amount_vnd: '300000000', granted_days: 10 });
      // The officer holds the right to settle and proposed this settlement: the four-eyes rule refuses.
      const own = await settle(OFFICER, id, 5);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      // The words of the decision are required by the contract of the operation (400 for a body without them).
      expect((await settle(LEGAL, id, 5, { decision: 'APPROVE' })).status).toBe(400);
      const settled = await settle(LEGAL, id, 5);
      expect(settled.json).toMatchObject({ status: 'SETTLED', resource_version: 6 });

      const final = (await get(READER, id)).json;
      expect(final).toMatchObject({ status: 'SETTLED', settled_amount_vnd: '300000000', granted_days: 10, allowed: { steps: [], decide_settlement: false, declare_bar: false, link: false } });
      expect((final.steps as Array<{ kind: string; ordinal: number }>).map((entry) => entry.kind)).toEqual(['EVENT', 'NOTICE', 'PARTICULARS', 'RESPONSE', 'SETTLEMENT_PROPOSAL', 'SETTLEMENT_APPROVED']);
      expect(await auditActions(id)).toEqual(['ctr.claim.registered', 'ctr.claim.step_recorded', 'ctr.claim.step_recorded', 'ctr.claim.step_recorded', 'ctr.claim.step_recorded', 'ctr.claim.settlement_decided']);
      expect(new Set(await events(id))).toEqual(new Set(['ctr.claim.registered.v1', 'ctr.claim.updated.v1']));
      // The words of the people stay in the timeline: they are not in the events or the audit trail.
      const trail = await rows<{ safe_diff: unknown }>('select safe_diff from machvon.audit_event where resource_id = $1', [id]);
      const payloads = await rows<{ payload: unknown }>('select payload from machvon.outbox_event where aggregate_id = $1', [id]);
      for (const text of [JSON.stringify(trail), JSON.stringify(payloads)]) {
        expect(text).not.toContain('registered letter');
        expect(text).not.toContain('The site was handed over');
      }
    });

    it('declares a claim barred only when a limitation day passed and the term says that bars it, by somebody other than the registrant', async () => {
      const contractId = await contract('HD-CL-004');
      await approvedTerm(contractId);
      const missed = idOf(await register(OFFICER, contractId));
      const view = (await get(LEGAL, missed)).json;
      expect(view).toMatchObject({ limitation: { status: 'MISSED', missed: ['NOTICE'], bar_effect: 'BARS_CLAIM' }, allowed: { declare_bar: true } });
      const registrant = await bar(OFFICER, missed, 1);
      expect([registrant.status, registrant.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const refused = await bar(LEGAL, missed, 1, { reason: 'no' });
      expect([refused.status, refused.json.detail]).toEqual([422, 'reason']);
      const barred = await bar(LEGAL, missed, 1);
      expect(barred.json).toMatchObject({ status: 'TIME_BARRED', resource_version: 2 });
      expect((await get(READER, missed)).json).toMatchObject({ status: 'TIME_BARRED', limitation: { status: 'BARRED' }, closed_on: dayFromToday(0) });
      const again = await bar(LEGAL, missed, 2);
      expect([again.status, again.json.code]).toEqual([409, 'CTR_CLAIM_STATE_INVALID']);

      const early = idOf(await register(OFFICER, contractId, { awareness_on: dayFromToday(-3), event_on: dayFromToday(-4) }));
      const notDue = await bar(LEGAL, early, 1);
      expect([notDue.status, notDue.json.code]).toEqual([409, 'CLAIM_BAR_NOT_DUE']);
      // A contract with no term has no clock and no ground for a bar.
      const bare = await contract('HD-CL-005');
      const noTerm = idOf(await register(OFFICER, bare));
      expect((await get(READER, noTerm)).json).toMatchObject({ term: null, limitation: { status: 'NO_TERM', due_on: null }, calendar_published: false });
      expect((await bar(LEGAL, noTerm, 1)).json.code).toBe('CLAIM_BAR_NOT_DUE');
    });

    it('lists the register with totals and pages, filters by limitation, side and contract, and keeps the rest out of reach', async () => {
      const contractId = await contract('HD-CL-006');
      await approvedTerm(contractId);
      const a = idOf(await register(OFFICER, contractId, { title: 'Claim A: late handover' }));
      const b = idOf(await register(OFFICER, contractId, { title: 'Claim B: design change', awareness_on: dayFromToday(-5), event_on: dayFromToday(-6), claimed_amount_vnd: '100000000', claimed_days: 3 }));
      const page = await call('GET', `/claims?contract_id=${contractId}&limit=1`, { member: READER });
      expect(page.status).toBe(200);
      expect(page.json).toMatchObject({ totals: { count: 2, open: 2, without_term: 0, claimed_vnd: '600000000', by_limitation: { MISSED: 1, RUNNING: 1 } }, truncated: false, policy: { unverified: true } });
      expect(page.json.items).toHaveLength(1);
      const cursor = page.json.next_cursor as string;
      expect(typeof cursor).toBe('string');
      const next = await call('GET', `/claims?contract_id=${contractId}&limit=5&cursor=${cursor}`, { member: READER });
      expect(next.json.next_cursor).toBeNull();
      expect([(page.json.items as Array<{ id: string }>)[0]?.id, (next.json.items as Array<{ id: string }>)[0]?.id].sort()).toEqual([a, b].sort());
      const missed = await call('GET', `/claims?contract_id=${contractId}&limitation=MISSED`, { member: READER });
      expect((missed.json.items as Array<{ id: string; limitation: { status: string }; has_term: boolean }>).map((entry) => [entry.id, entry.limitation.status, entry.has_term])).toEqual([[a, 'MISSED', true]]);
      expect((await call('GET', `/claims?contract_id=${contractId}&claimant_side=OWNER`, { member: READER })).json.items).toEqual([]);
      expect((await call('GET', '/claims?limitation=SOON', { member: READER })).status).toBe(422);
      expect((await call('GET', '/claims?open=maybe', { member: READER })).status).toBe(422);
      expect((await call('GET', '/claims', { member: GUEST })).status).toBe(403);
      expect((await call('GET', '/claims', { member: NOBODY })).status).toBe(403);
      // Another tenant sees none of it, and a claim of this tenant is a 404 there.
      const foreign = await call('GET', '/claims?limit=200', { member: B_OFFICER, tenantId: TENANT_B });
      expect((foreign.json.items as unknown[]).length).toBe(0);
      expect((await get(B_OFFICER, a, TENANT_B)).status).toBe(404);
      // The branch the caller reads is the tenant, and the branch it changes is another one.
      expect((await step(ELSEWHERE, a, 1, { kind: 'NOTICE', occurred_on: dayFromToday(-2), note: 'Notice served by registered letter.' })).status).toBe(403);
    });

    it('links a change order and a payment request of the same contract, and refuses those of another', async () => {
      const contractId = await contract('HD-CL-007');
      const other = await contract('HD-CL-008');
      const claim = idOf(await register(OFFICER, contractId));
      const change = randomUUID();
      const foreign = randomUUID();
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query('set session_replication_role = replica');
        await client.query(
          "insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, submitted_by, created_by, updated_by) values ($1, $2, $3, gen_random_uuid(), 0, 5, 'Reason', 'SUBMITTED', 1, 'CR-CL-1', 'CO', $5, $5, $5), ($1, $4, $6, gen_random_uuid(), 0, 5, 'Reason', 'SUBMITTED', 1, 'CR-CL-2', 'CO', $5, $5, $5)",
          [TENANT_A, change, contractId, foreign, memberId(OFFICER), other],
        );
      } finally {
        await client.end();
      }
      const refused = await call('POST', `/claims/${claim}/links`, { member: OFFICER, ifMatch: '"1"', body: { change_request_id: foreign } });
      expect([refused.status, refused.json.detail]).toEqual([422, 'change_request_id']);
      const linked = await call('POST', `/claims/${claim}/links`, { member: OFFICER, ifMatch: '"1"', body: { change_request_id: change } });
      expect(linked.json).toMatchObject({ status: 'EVENT_RECORDED', resource_version: 2 });
      expect((await get(READER, claim)).json).toMatchObject({ change_request: { id: change, code: 'CR-CL-1' }, payment_request: null });
    });
  });
});
