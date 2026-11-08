import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ContractController, ContractReadsController, ContractRevisionReadsController } from '../../src/modules/ctr/contract.controller';
import { EarlyWarningController, EarlyWarningReadsController } from '../../src/modules/ctr/early-warning.controller';
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
const OFFICER = 1; // raises, assesses, agrees actions, records meetings, issues the register
const LEAD = 2; // answers for the warnings
const CLOSER = 3; // closes what the lead answers for
const RAISER = 4; // may only raise (a supervisor, a contractor's representative)
const READER = 5; // early_warning.read only
const ELSEWHERE = 6;
const NOBODY = 7;
const GUEST = 8;
const B_OFFICER = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0xd8;
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

const dayFromToday = (days: number): string => vietnamDateOf(new Date(Date.now() + days * DAY));

describe('the early-warning register of a contract (G1-15)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let world: CtrWorld;

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

  async function contract(code: string, effectiveFrom = '2026-01-01'): Promise<string> {
    const made = await call('POST', '/contracts', {
      member: OFFICER,
      body: { project_id: world.project, package_id: world.packageId, contractor_id: world.lead, code, title: 'Construction of the bridge', type: 'UNIT_PRICE', advance_category: 'CONSTRUCTION', contract_value_vnd: '10000000000', document_version_id: world.document },
    });
    expect(made.status).toBe(200);
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query("update machvon.contract set status = 'ACTIVE', signed_on = $2::date, effective_from = $2::date where id = $1::uuid", [idOf(made), effectiveFrom]);
    } finally {
      await client.end();
    }
    return idOf(made);
  }

  const warningBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ title: 'The crane may arrive late', description: 'The supplier says the crane arrives after the foundation pour.', category: 'TIME', raised_by_party: 'CONTRACTOR', raised_on: dayFromToday(-2), ...extra });
  const raise = (member: number, contractId: string, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', `/contracts/${contractId}/early-warnings`, { member, body: warningBody(extra), ...options });
  const assess = (member: number, id: string, version: number | string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/contract-early-warnings/${id}/assessment`, { member, ifMatch: `"${version}"`, body: { owner_membership_id: memberId(LEAD), likelihood: 'HIGH', expected_time_days: 14, expected_cost_vnd: '250000000', ...extra } });
  const addAction = (member: number, id: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/contract-early-warnings/${id}/actions`, { member, body: { description: 'Order the crane from the second supplier.', owner_membership_id: memberId(LEAD), due_on: dayFromToday(5), ...extra } });
  const complete = (member: number, id: string, version: number | string, body: Record<string, unknown> = { outcome: 'DONE', note: 'The crane was ordered on the 22nd.' }): Promise<Reply> =>
    call('POST', `/contract-early-warning-actions/${id}/completion`, { member, ifMatch: `"${version}"`, body });
  const close = (member: number, id: string, version: number | string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/contract-early-warnings/${id}/closure`, { member, ifMatch: `"${version}"`, body });
  const meeting = (member: number, contractId: string, reviews: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/contracts/${contractId}/early-warning-meetings`, { member, body: { held_on: dayFromToday(-1), attendees: 'Owner, contractor, supervisor', notes: 'The register was reviewed.', reviews, ...extra } });
  const issue = (member: number, contractId: string, body: Record<string, unknown> = {}): Promise<Reply> => call('POST', `/contracts/${contractId}/early-warning-issues`, { member, body });
  const registerOf = (member: number, contractId: string, tenantId = TENANT_A): Promise<Reply> => call('GET', `/contracts/${contractId}/early-warning-register`, { member, tenantId });
  const get = (member: number, id: string, tenantId = TENANT_A): Promise<Reply> => call('GET', `/contract-early-warnings/${id}`, { member, tenantId });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      ]);
    }
    for (const n of [OFFICER, LEAD, CLOSER, RAISER, READER, ELSEWHERE, NOBODY, GUEST]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_OFFICER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'EW_OFFICER', ['contract.create', 'contract.update', 'contract.read', 'early_warning.read', 'early_warning.raise', 'early_warning.manage'], 40);
    await harness.seedRole(TENANT_A, 2, 'EW_LEAD', ['early_warning.read', 'early_warning.manage'], 30);
    await harness.seedRole(TENANT_A, 3, 'EW_CLOSER', ['early_warning.read', 'early_warning.close'], 50);
    await harness.seedRole(TENANT_A, 4, 'EW_RAISER', ['early_warning.read', 'early_warning.raise'], 20);
    await harness.seedRole(TENANT_A, 5, 'EW_READER', ['early_warning.read'], 20);
    await harness.seedRole(TENANT_A, 6, 'EW_ELSEWHERE', ['early_warning.manage', 'early_warning.raise'], 30);
    await harness.seedRole(TENANT_A, 7, 'GUEST_EW', ['early_warning.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'EW_OFFICER', ['contract.create', 'early_warning.read', 'early_warning.raise', 'early_warning.manage'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'TENANT' },
      { n: 2, member: LEAD, role: 2, kind: 'TENANT' },
      { n: 3, member: CLOSER, role: 3, kind: 'TENANT' },
      { n: 4, member: RAISER, role: 4, kind: 'TENANT' },
      { n: 5, member: READER, role: 5, kind: 'TENANT' },
      { n: 6, member: ELSEWHERE, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
      { n: 7, member: ELSEWHERE, role: 5, kind: 'TENANT' },
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
      controllers: [ContractController, ContractReadsController, ContractRevisionReadsController, EarlyWarningController, EarlyWarningReadsController],
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
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([EarlyWarningController, EarlyWarningReadsController]));
  });

  it('lets a person who may only raise raise a warning, and nobody who may not; replays a key', async () => {
    const contractId = await contract('HD-EW-001');
    const key = `K-EW-${randomUUID()}`;
    const raised = await raise(RAISER, contractId, {}, { key });
    expect(raised).toMatchObject({ status: 200, json: { status: 'RAISED', resource_version: 1 } });
    expect((await raise(RAISER, contractId, {}, { key })).json).toEqual(raised.json);
    expect((await raise(RAISER, contractId, { title: 'Another title for the same key' }, { key })).json.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await raise(READER, contractId)).status).toBe(403);
    expect((await raise(ELSEWHERE, contractId)).json.code).toBe('SCOPE_DENIED');
    expect((await raise(OFFICER, contractId, { raised_on: dayFromToday(3) })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'raised_on' });
    expect((await raise(OFFICER, contractId, { raised_by_party: 'NOBODY' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'raised_by_party' });
    const id = idOf(raised);
    expect(await events(id)).toEqual(['ctr.early_warning.raised.v1']);
    expect(await auditActions(id)).toEqual(['ctr.early_warning.raised']);
    const view = (await get(READER, id)).json;
    expect(view).toMatchObject({ code: 'EW-001', status: 'RAISED', raised_by_party: 'CONTRACTOR', allowed: { assess: false, add_action: false, close: false }, actions: [], reviews: [] });
  });

  it('assesses with the impact stated, agrees actions, ends them, and closes as resolved only by somebody else', async () => {
    const contractId = await contract('HD-EW-002');
    const id = idOf(await raise(OFFICER, contractId));
    expect((await assess(OFFICER, id, 1, { expected_time_days: undefined, expected_cost_vnd: undefined })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'expected_time_days' });
    expect((await addAction(OFFICER, id)).json.code).toBe('EARLY_WARNING_STATE_INVALID');
    const assessed = await assess(OFFICER, id, 1);
    expect(assessed.json).toMatchObject({ status: 'ASSESSED', resource_version: 2 });
    const action = await addAction(OFFICER, id);
    expect(action.json).toMatchObject({ status: 'OPEN', resource_version: 1 });
    const view = (await get(LEAD, id)).json;
    expect(view).toMatchObject({ status: 'MITIGATING', owner_membership_id: memberId(LEAD), likelihood: 'HIGH', expected_time_days: 14, expected_cost_vnd: '250000000', allowed: { assess: true, add_action: true, close: false }, version: 3 });
    const reason = { outcome: 'RESOLVED', reason: 'The second supplier delivered on time.' };
    expect((await close(CLOSER, id, 3, reason)).json.code).toBe('EARLY_WARNING_ACTIONS_OPEN');
    expect((await complete(LEAD, idOf(action), 1, { outcome: 'DONE' })).status).toBe(400);
    expect((await complete(LEAD, idOf(action), 1)).json).toMatchObject({ status: 'DONE', resource_version: 2 });
    expect((await complete(LEAD, idOf(action), 2)).json.code).toBe('EARLY_WARNING_STATE_INVALID');
    // The owner of the mitigation holds no right to close; a closer who is the owner would be refused by the rule (db test), the officer lacks the right.
    expect((await close(OFFICER, id, 3, reason)).status).toBe(403);
    const closed = await close(CLOSER, id, 3, reason);
    expect(closed.json).toMatchObject({ status: 'CLOSED_RESOLVED', resource_version: 4 });
    expect((await get(READER, id)).json).toMatchObject({ status: 'CLOSED_RESOLVED', closed_reason: 'The second supplier delivered on time.', allowed: { assess: false, add_action: false, close: false } });
    expect((await close(CLOSER, id, 4, reason)).json.code).toBe('EARLY_WARNING_STATE_INVALID');
    expect(await events(id)).toEqual(expect.arrayContaining(['ctr.early_warning.raised.v1', 'ctr.early_warning.updated.v1', 'ctr.early_warning.closed.v1']));
    expect((await auditActions(id)).filter((action) => action.startsWith('ctr.early_warning.')).length).toBe(5);
    const trail = await rows<{ safe_diff: unknown }>('select safe_diff from machvon.audit_event where resource_id = $1', [id]);
    expect(JSON.stringify(trail)).not.toContain('second supplier');
  });

  it('reviews every open warning at a meeting, issues the register after it, and tells the rhythm on the day', async () => {
    const contractId = await contract('HD-EW-003', dayFromToday(-20));
    const a = idOf(await raise(OFFICER, contractId));
    const b = idOf(await raise(OFFICER, contractId, { title: 'The rebar delivery is below grade', category: 'QUALITY' }));
    await assess(OFFICER, a, 1);
    const before = (await registerOf(READER, contractId)).json;
    expect(before).toMatchObject({
      contract: { code: 'HD-EW-003', status: 'ACTIVE', effective_from: dayFromToday(-20) },
      clocks: { initial: { state: 'MISSED', due_on: dayFromToday(-13) }, meeting: { state: 'MISSED', due_on: dayFromToday(-6) }, reissue: null },
      policy: { rule: { unverified: true, source: 'DEFAULT' }, initial_issue_within_days: 7, meeting_every_days: 14, reissue_within_days_after_meeting: 7, basis: 'CALENDAR_DAYS' },
      summary: { total: 2, open: 2, unassessed: 1, exposure_cost_vnd: '250000000', exposure_time_days: 14 },
      allowed: { raise: false, record_meeting: false, issue_register: false },
    });
    expect((await registerOf(OFFICER, contractId)).json).toMatchObject({ allowed: { raise: true, record_meeting: true, issue_register: true } });
    const skipped = await meeting(OFFICER, contractId, [{ warning_id: a, outcome: 'ACTION_AGREED', note: 'Second supplier.' }]);
    expect([skipped.status, skipped.json.detail]).toEqual([422, 'reviews']);
    const held = await meeting(OFFICER, contractId, [{ warning_id: a, outcome: 'ACTION_AGREED', note: 'Second supplier.' }, { warning_id: b, outcome: 'NO_CHANGE' }]);
    expect(held).toMatchObject({ status: 200, json: { status: 'RECORDED' } });
    const first = await issue(OFFICER, contractId, { issued_on: dayFromToday(-10) });
    expect(first.json).toMatchObject({ status: 'INITIAL' });
    const after = await issue(OFFICER, contractId, { meeting_id: held.json.resource_id, issued_on: dayFromToday(0) });
    expect(after.json).toMatchObject({ status: 'AFTER_MEETING' });
    expect((await issue(OFFICER, contractId, { meeting_id: held.json.resource_id })).json.code).toBe('EARLY_WARNING_STATE_INVALID');
    const reread = (await registerOf(READER, contractId)).json as { clocks: Record<string, { state: string } | null>; meetings: Array<{ reissued_on: string | null; reviews: unknown[] }>; issues: Array<{ kind: string; content_hash: string; open_count: number }> };
    expect(reread.clocks.initial?.state).toBe('MET_LATE');
    expect(reread.clocks.reissue?.state).toBe('MET');
    expect(reread.meetings[0]).toMatchObject({ reissued_on: dayFromToday(0) });
    expect(reread.meetings[0]?.reviews).toHaveLength(2);
    expect(reread.issues.map((entry) => entry.kind)).toEqual(['AFTER_MEETING', 'INITIAL']);
    expect(reread.issues[0]?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(reread.issues[0]?.open_count).toBe(2);
    expect((await get(READER, a)).json.reviews).toEqual([expect.objectContaining({ outcome: 'ACTION_AGREED', status_at_meeting: 'ASSESSED' })]);
  });

  it('lists the warnings with the summary, filters them, and keeps the other tenant, the guest and the other branch out', async () => {
    const contractId = await contract('HD-EW-004');
    const a = idOf(await raise(OFFICER, contractId));
    const b = idOf(await raise(OFFICER, contractId, { title: 'The rebar delivery is below grade', category: 'QUALITY', raised_by_party: 'OWNER' }));
    await assess(OFFICER, a, 1);
    const page = await call('GET', `/contract-early-warnings?contract_id=${contractId}&limit=1`, { member: READER });
    expect(page.json).toMatchObject({ summary: { total: 2, open: 2, without_owner: 1, unassessed: 1, impact_unknown: 1 }, truncated: false });
    expect(page.json.items).toHaveLength(1);
    const next = await call('GET', `/contract-early-warnings?contract_id=${contractId}&limit=5&cursor=${page.json.next_cursor as string}`, { member: READER });
    expect(next.json.next_cursor).toBeNull();
    expect([(page.json.items as Array<{ id: string }>)[0]?.id, (next.json.items as Array<{ id: string }>)[0]?.id].sort()).toEqual([a, b].sort());
    expect(((await call('GET', `/contract-early-warnings?contract_id=${contractId}&category=QUALITY&open=true`, { member: READER })).json.items as Array<{ id: string }>).map((entry) => entry.id)).toEqual([b]);
    expect((await call('GET', '/contract-early-warnings?status=LOST', { member: READER })).status).toBe(422);
    expect((await call('GET', '/contract-early-warnings', { member: GUEST })).status).toBe(403);
    expect((await call('GET', '/contract-early-warnings', { member: NOBODY })).status).toBe(403);
    expect(((await call('GET', '/contract-early-warnings?limit=200', { member: B_OFFICER, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
    expect((await get(B_OFFICER, a, TENANT_B)).status).toBe(404);
    expect((await registerOf(B_OFFICER, contractId, TENANT_B)).status).toBe(404);
    expect((await assess(ELSEWHERE, a, 2)).json.code).toBe('SCOPE_DENIED');
  });

  it('names the change order or the claim a warning became, and refuses another contract', async () => {
    const contractId = await contract('HD-EW-005');
    const other = await contract('HD-EW-006');
    const id = idOf(await raise(OFFICER, contractId));
    await assess(OFFICER, id, 1);
    const change = randomUUID();
    const foreign = randomUUID();
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        "insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, submitted_by, created_by, updated_by) values ($1, $2, $3, gen_random_uuid(), 0, 5, 'Reason', 'SUBMITTED', 1, 'CR-EW-1', 'CO', $5, $5, $5), ($1, $4, $6, gen_random_uuid(), 0, 5, 'Reason', 'SUBMITTED', 1, 'CR-EW-2', 'CO', $5, $5, $5)",
        [TENANT_A, change, contractId, foreign, memberId(OFFICER), other],
      );
    } finally {
      await client.end();
    }
    const into = { outcome: 'MATERIALISED', reason: 'The delay happened and a change order was raised.', materialised_into: 'CHANGE_REQUEST' };
    expect((await close(CLOSER, id, 2, { ...into, materialised_id: foreign })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'materialised_id' });
    expect((await close(CLOSER, id, 2, { ...into, materialised_id: change })).json).toMatchObject({ status: 'CLOSED_MATERIALISED' });
    expect((await get(READER, id)).json).toMatchObject({ status: 'CLOSED_MATERIALISED', change_request_id: change, claim_id: null });
  });
});
