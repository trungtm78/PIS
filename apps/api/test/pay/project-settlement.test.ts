import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PayLedgerStore, TenantDatabase } from '@machvon/db';
import { addCalendarDays, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { ProjectSettlementController, ProjectSettlementReadsController } from '../../src/modules/pay/project-settlement.controller';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const OPENER = 51; // settlement.open, settlement.submit, settlement.verify, settlement_revision.read: the settlement officer
const SENDER = 52; // the same role: another officer, who sends it
const VERIFIER = 53; // the same role: a third, who verifies it
const CHIEF = 54; // settlement.exception.approve and settlement_revision.read: the chief accountant
const LEADER = 55; // settlement.close, settlement.exception.approve and settlement_revision.read: the approver
const READER = 56; // settlement_revision.read only
const AUDITOR = 57; // settlement_revision.read and aud.read
const OFFICER_CHIEF = 58; // the officer role and the chief role in one person: the four-eyes rule is what stops them
const MEMBERS = [OPENER, SENDER, VERIFIER, CHIEF, LEADER, READER, AUDITOR, OFFICER_CHIEF];
const SUBMITTED_ON = '2026-07-01';

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

describe('the settlement of a project over HTTP (ST-PAY-009)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  const ledgers = new PayLedgerStore();
  let app: RunningApp;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string | null; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined && options.ifMatch !== null) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: response.headers };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const row = async (id: string) =>
    (await rows<{ status: string; version: string; due: string | null; days: number | null; outstanding: string; exception_by: string | null }>(
      'select status, version::text, verification_due_on::text as due, deadline_days as days, outstanding_vnd::text as outstanding, exception_approved_by as exception_by from machvon.settlement_revision where id = $1::uuid',
      [id],
    ))[0];
  const audits = (id: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by seq', [id, action]);
  const events = (id: string, type: string) => rows<{ payload: Record<string, unknown>; event_key: string }>('select payload, event_key from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [id, type]);

  /** Runs a statement as the superuser with the triggers off, to put a row in a state that only another story could. */
  async function admin(sql: string, params: unknown[] = []): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  async function project(options: { status?: string; group?: string } = {}): Promise<{ projectId: string; lineId: string }> {
    const line = await fixtures.world.publishedLine({ allocated: '10000000000000', appropriationAmount: '20000000000000', group: options.group ?? 'B' });
    await admin('update machvon.project set status = $2, project_group = $3 where id = $1::uuid', [line.projectId, options.status ?? 'COMPLETED', options.group ?? 'B']);
    return { projectId: line.projectId, lineId: line.lineId };
  }

  /** A project that owes: an acceptance of 100m approved and recognised on the ledger of one of its contracts. */
  async function owingProject(group = 'B'): Promise<{ projectId: string }> {
    const target = await project({ group });
    const contract = await fixtures.seedContract({ projectId: target.projectId, lineId: target.lineId });
    const approved = await fixtures.approve(contract, [{ item: 0, quantity: '100' }]);
    await fixtures.as((tx) => ledgers.recognize(tx, { acceptanceId: approved.acceptance.id, requestId: randomUUID(), actor: memberId(OPENER) }), OPENER);
    return target;
  }

  const open = (target: { projectId: string }, body: Record<string, unknown> = {}, member = OPENER) => call('POST', '/settlements', { member, body: { project_id: target.projectId, settlement_scope: 'PROJECT', ...body } });
  const command = async (member: number, id: string, action: string, body: Record<string, unknown>, options: { version?: string | null; key?: string } = {}) => {
    const version = options.version === undefined ? (await row(id))?.version : options.version;
    return call('POST', `/settlements/${id}/${action}`, { member, body, ifMatch: version === null ? null : `"${version}"`, ...(options.key === undefined ? {} : { key: options.key }) });
  };
  const idOf = (reply: Reply): string => String(reply.json.resource_id);
  const opened = async (target: { projectId: string }, body: Record<string, unknown> = {}): Promise<string> => {
    const reply = await open(target, body);
    expect(reply.status).toBe(200);
    return idOf(reply);
  };
  const submit = (id: string, day = SUBMITTED_ON, member = SENDER) => command(member, id, 'submit', { submitted_on: day });
  const verifiedSettlement = async (target: { projectId: string }, member = OPENER): Promise<string> => {
    const reply = await open(target, {}, member);
    expect(reply.status).toBe(200);
    const id = idOf(reply);
    expect((await submit(id)).status).toBe(200);
    expect((await command(VERIFIER, id, 'verification', { outcome: 'VERIFYING', findings: 'Taken up.' })).status).toBe(200);
    expect((await command(VERIFIER, id, 'verification', { outcome: 'VERIFIED', findings: 'The figures agree with the ledgers.' })).status).toBe(200);
    return id;
  };

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 401, 'SETTLEMENT_OFFICER', ['settlement.open', 'settlement.submit', 'settlement.verify', 'settlement_revision.read'], 30);
    await harness.seedRole(TENANT_A, 402, 'SETTLEMENT_CHIEF', ['settlement.exception.approve', 'settlement_revision.read'], 40);
    await harness.seedRole(TENANT_A, 403, 'SETTLEMENT_LEADER', ['settlement.close', 'settlement.exception.approve', 'settlement_revision.read'], 50);
    await harness.seedRole(TENANT_A, 404, 'SETTLEMENT_READER', ['settlement_revision.read'], 10);
    await harness.seedRole(TENANT_A, 405, 'SETTLEMENT_AUDITOR', ['settlement_revision.read', 'aud.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OPENER, role: 401, kind: 'TENANT' },
      { n: 2, member: SENDER, role: 401, kind: 'TENANT' },
      { n: 3, member: VERIFIER, role: 401, kind: 'TENANT' },
      { n: 4, member: CHIEF, role: 402, kind: 'TENANT' },
      { n: 5, member: LEADER, role: 403, kind: 'TENANT' },
      { n: 6, member: READER, role: 404, kind: 'TENANT' },
      { n: 7, member: AUDITOR, role: 405, kind: 'TENANT' },
      { n: 8, member: OFFICER_CHIEF, role: 401, kind: 'TENANT' },
      { n: 9, member: OFFICER_CHIEF, role: 402, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProjectSettlementController, ProjectSettlementReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  it('is registered in the module of PAY', () => {
    expect(payModule.controllers).toEqual(expect.arrayContaining([ProjectSettlementController, ProjectSettlementReadsController]));
  });

  it('opens a settlement, reads it back with what the caller may do, and leaves its audit row and its event', async () => {
    const target = await owingProject();
    const reply = await open(target);
    expect(reply).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
    const id = idOf(reply);

    const found = await call('GET', `/resources/settlement_revision/${id}`, { member: OPENER });
    expect(found.status).toBe(200);
    expect(found.json).toMatchObject({
      id,
      settlement_scope: 'PROJECT',
      status: 'DRAFT',
      revision: 1,
      fiscal_year: null,
      contract: null,
      settled_amount_vnd: '0',
      project_group: null,
      verification_due_on: null,
      version: 1,
      actions: { refresh: true, submit: true, take_up: false, verify: false, return: false, approve_exception: false, close: false },
    });
    expect(BigInt(String(found.json.outstanding_vnd))).toBeGreaterThan(0n);
    expect((found.json.project as { id: string }).id).toBe(target.projectId);
    // A reader sees the settlement and can do nothing with it.
    expect((await call('GET', `/resources/settlement_revision/${id}`, { member: READER })).json).toMatchObject({ actions: { refresh: false, submit: false } });

    const trail = await audits(id, 'settlement_revision.opened');
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actor_id: memberId(OPENER), safe_diff: { project_id: target.projectId, settlement_scope: 'PROJECT', to_status: 'DRAFT', revision: 1 } });
    const told = await events(id, 'pay.settlement.opened.v1');
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toMatchObject({ settlement_id: id, project_id: target.projectId, settlement_scope: 'PROJECT', actor_id: memberId(OPENER) });

    // A second one for the same project is refused; the same key with the same body answers the first answer without a second settlement.
    expect(await open(target)).toMatchObject({ status: 409, json: { code: 'SETTLEMENT_OPEN_EXISTS' } });
    const key = `open-once-${randomUUID()}`;
    const again = await call('POST', '/settlements', { member: OPENER, key, body: { project_id: (await project()).projectId, settlement_scope: 'PROJECT' } });
    const replay = await call('POST', '/settlements', { member: OPENER, key, body: { project_id: String((await rows<{ project_id: string }>('select project_id from machvon.settlement_revision where id = $1::uuid', [idOf(again)]))[0]?.project_id), settlement_scope: 'PROJECT' } });
    expect(replay.json.resource_id).toBe(again.json.resource_id);
    expect(await events(idOf(again), 'pay.settlement.opened.v1')).toHaveLength(1);
  });

  it('refuses a body that does not fit the scope, a project that is not at the stage, one that is not there, and a caller without the permission', async () => {
    const target = await project();
    expect(await open(target, { settlement_scope: 'CONTRACT' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await open(target, { settlement_scope: 'ANNUAL' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await open(target, { settlement_scope: 'WHOLE' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await open({ projectId: randomUUID() })).toMatchObject({ status: 404 });
    const building = await project({ status: 'IMPLEMENTATION' });
    expect(await open(building)).toMatchObject({ status: 422, json: { code: 'PROJECT_STAGE_INVALID' } });
    expect(await open(target, {}, READER)).toMatchObject({ status: 403 });
    expect(await open(target, {}, LEADER)).toMatchObject({ status: 403 });
    expect((await open(building, { settlement_scope: 'ANNUAL', fiscal_year: 2026 })).status).toBe(200);
  });

  it('UAT-AC339: gives the deadline of the group of the project from the day of the submission, refuses a rule that is not in force, and keeps the deadline it gave', async () => {
    const expected: Array<[string, number]> = [['QTQG', 270], ['A', 270], ['B', 180], ['C', 120]];
    for (const [group, days] of expected) {
      const id = await opened(await project({ group }));
      const sent = await submit(id);
      expect(sent).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 2 } });
      expect(await row(id)).toMatchObject({ status: 'SUBMITTED', due: addCalendarDays(SUBMITTED_ON, days), days });
      // The person who sent it is not offered the verification of it; another officer is.
      const read = await call('GET', `/resources/settlement_revision/${id}`, { member: SENDER });
      expect(read.json).toMatchObject({ project_group: group, submitted_on: SUBMITTED_ON, verification_due_on: addCalendarDays(SUBMITTED_ON, days), deadline_days: days, deadline_rule_awaiting_confirmation: true });
      expect((read.json.actions as Record<string, boolean>).take_up).toBe(false);
      expect(((await call('GET', `/resources/settlement_revision/${id}`, { member: VERIFIER })).json.actions as Record<string, boolean>).take_up).toBe(true);
    }
    const sent = await opened(await project({ group: 'B' }));
    await submit(sent);
    expect((await row(sent))?.due).toBe(addCalendarDays(SUBMITTED_ON, 180));
    expect((await events(sent, 'pay.settlement.submitted.v1'))[0]?.payload).toMatchObject({ project_group: 'B', submitted_on: SUBMITTED_ON, verification_due_on: addCalendarDays(SUBMITTED_ON, 180), deadline_days: 180 });

    // The rule is switched off: the next submission is refused as unconfirmed; the deadline already given stays.
    const [rule] = await rows<{ id: string }>(`select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where r.master_type = 'PAY_SETTLEMENT_DEADLINE' order by v.revision desc limit 1`);
    await admin('update machvon.master_record_version set valid_until = valid_from + 1 where id = $1::uuid', [rule?.id]);
    try {
      const draft = await opened(await project({ group: 'C' }));
      expect(await submit(draft)).toMatchObject({ status: 422, json: { code: 'DEADLINE_RULE_UNCONFIRMED' } });
      expect((await row(sent))?.due).toBe(addCalendarDays(SUBMITTED_ON, 180));
    } finally {
      await admin('update machvon.master_record_version set valid_until = null where id = $1::uuid', [rule?.id]);
    }
    // A project that has lost its group cannot send the settlement.
    const orphan = await project();
    const orphanId = await opened(orphan);
    await admin("update machvon.project set status = 'CANCELLED', project_group = null where id = $1::uuid", [orphan.projectId]);
    expect(await submit(orphanId)).toMatchObject({ status: 422, json: { code: 'PROJECT_GROUP_MISSING' } });
    // The same day twice, a day to come, and a settlement that was sent already.
    const draft = await opened(await project());
    expect(await submit(draft, '2099-01-01')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await submit(sent)).toMatchObject({ status: 409, json: { code: 'SETTLEMENT_STATE_INVALID' } });
  });

  it('asks for the version of the settlement, refuses a stale one and a person without the right over the project', async () => {
    const id = await opened(await project());
    expect(await command(SENDER, id, 'submit', { submitted_on: SUBMITTED_ON }, { version: null })).toMatchObject({ status: 428 });
    expect(await command(SENDER, id, 'submit', { submitted_on: SUBMITTED_ON }, { version: '9' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await command(READER, id, 'submit', { submitted_on: SUBMITTED_ON })).toMatchObject({ status: 403 });
    expect(await command(SENDER, randomUUID(), 'submit', { submitted_on: SUBMITTED_ON }, { version: '1' })).toMatchObject({ status: 404 });
    expect(await command(SENDER, id, 'refresh', { note: '  ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await command(SENDER, id, 'refresh', { note: 'After July.' })).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2 } });
    expect((await audits(id, 'settlement_revision.figures_refreshed'))[0]).toMatchObject({ actor_id: memberId(SENDER), reason: 'After July.' });
  });

  it('takes a verification only from someone other than the sender, with the findings, and reads the conclusions of AUD only for who may read AUD', async () => {
    const id = await opened(await project());
    await submit(id);
    expect(await command(SENDER, id, 'verification', { outcome: 'VERIFYING', findings: 'Mine.' })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await command(VERIFIER, id, 'verification', { outcome: 'VERIFIED', findings: 'Too early.' })).toMatchObject({ status: 409, json: { code: 'SETTLEMENT_STATE_INVALID' } });
    expect(await command(VERIFIER, id, 'verification', { outcome: 'VERIFYING' })).toMatchObject({ status: 400, json: { code: 'INVALID_REQUEST' } });
    expect(await command(READER, id, 'verification', { outcome: 'VERIFYING', findings: 'No right.' })).toMatchObject({ status: 403 });
    expect((await command(VERIFIER, id, 'verification', { outcome: 'VERIFYING', findings: 'Taken up.' })).status).toBe(200);
    expect(await events(id, 'pay.settlement.verified.v1')).toHaveLength(0);
    const refs = [randomUUID(), randomUUID()];
    expect(await command(VERIFIER, id, 'verification', { outcome: 'VERIFIED', findings: 'No finding.', audit_finding_refs: refs })).toMatchObject({ status: 200, json: { status: 'VERIFIED' } });
    expect(await events(id, 'pay.settlement.verified.v1')).toHaveLength(1);
    expect((await audits(id, 'settlement_revision.verification_verified'))[0]).toMatchObject({ actor_id: memberId(VERIFIER), reason: 'No finding.' });
    expect((await call('GET', `/resources/settlement_revision/${id}`, { member: AUDITOR })).json.audit_finding_refs).toEqual(refs);
    expect((await call('GET', `/resources/settlement_revision/${id}`, { member: READER })).json.audit_finding_refs).toBeNull();
    // A returned settlement tells ISS nothing and tells the other modules once.
    const back = await opened(await project());
    await submit(back);
    expect(await command(VERIFIER, back, 'verification', { outcome: 'RETURNED', findings: 'The report is missing.' })).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
    expect(await events(back, 'pay.settlement.returned.v1')).toHaveLength(1);
    expect((await command(OPENER, back, 'refresh', { note: 'With the report.' })).json.status).toBe('DRAFT');
  });

  it('UAT-AC66: closes a settlement that owes only after an exception approved by someone else, and the figures stay as they were', async () => {
    const id = await verifiedSettlement(await owingProject(), OFFICER_CHIEF);
    const before = await row(id);
    expect(BigInt(before?.outstanding ?? '0')).toBeGreaterThan(0n);
    const decision = (await fixtures.documentVersion()).id;
    const paper = (await fixtures.documentVersion()).id;
    const read = await call('GET', `/resources/settlement_revision/${id}`, { member: LEADER });
    expect(read.json).toMatchObject({ status: 'VERIFIED', actions: { approve_exception: true, close: false } });

    // 1: the close with something owed and no exception.
    const closeBody = { decision: 'approve', reason: 'Approved by decision 10/QTDA.', evidence_ids: [], decision_document_version_id: decision };
    expect(await command(LEADER, id, 'close', closeBody)).toMatchObject({ status: 422, json: { code: 'SETTLEMENT_HAS_OUTSTANDING', outstanding_vnd: before?.outstanding } });
    // 2: the person who opened the settlement holds the right to approve exceptions and is refused all the same; a person who holds no such right is refused too.
    const exception = { reason: 'Công nợ chờ bảo lãnh bảo hành theo biên bản 05/BB', approval_document_version_id: paper };
    expect(await command(OFFICER_CHIEF, id, 'exception-approval', exception)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await command(OPENER, id, 'exception-approval', exception)).toMatchObject({ status: 403 });
    // 3: someone else approves it, once.
    expect(await command(CHIEF, id, 'exception-approval', exception, { version: before?.version })).toMatchObject({ status: 200 });
    expect(await row(id)).toMatchObject({ exception_by: memberId(CHIEF), outstanding: before?.outstanding });
    expect(await command(LEADER, id, 'exception-approval', exception)).toMatchObject({ status: 409, json: { code: 'SETTLEMENT_STATE_INVALID' } });
    // 4: the close, by the approver, with the exception in hand.
    expect((await call('GET', `/resources/settlement_revision/${id}`, { member: LEADER })).json).toMatchObject({ actions: { approve_exception: false, close: true }, exception_approved_by: memberId(CHIEF) });
    expect(await command(OPENER, id, 'close', closeBody)).toMatchObject({ status: 403 });
    expect(await command(LEADER, id, 'close', { ...closeBody, decision: 'reject' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await command(LEADER, id, 'close', { ...closeBody, decision_document_version_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
    const closed = await command(LEADER, id, 'close', closeBody);
    expect(closed).toMatchObject({ status: 200, json: { status: 'CLOSED' } });
    expect(await row(id)).toMatchObject({ status: 'CLOSED', outstanding: before?.outstanding });
    expect(await command(LEADER, id, 'close', closeBody)).toMatchObject({ status: 409, json: { code: 'SETTLEMENT_STATE_INVALID' } });

    const told = await events(id, 'pay.settlement.closed.v1');
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toMatchObject({ settlement_id: id, with_exception: true, exception_approved_by: memberId(CHIEF), decision_document_version_id: decision, outstanding_vnd: before?.outstanding });
    expect(JSON.stringify(told[0]?.payload)).not.toContain('Công nợ');
    expect((await audits(id, 'settlement_revision.exception_approved'))[0]).toMatchObject({ actor_id: memberId(CHIEF), reason: 'Công nợ chờ bảo lãnh bảo hành theo biên bản 05/BB' });
    expect((await audits(id, 'settlement_revision.closed'))[0]).toMatchObject({ actor_id: memberId(LEADER), safe_diff: { with_exception: true } });
  });

  it('closes a settlement that owes nothing without an exception, and refuses the exception for it', async () => {
    const id = await verifiedSettlement(await project());
    const decision = (await fixtures.documentVersion()).id;
    const paper = (await fixtures.documentVersion()).id;
    expect(await command(CHIEF, id, 'exception-approval', { reason: 'Not needed.', approval_document_version_id: paper })).toMatchObject({ status: 422, json: { code: 'NO_OUTSTANDING_TO_EXCEPT' } });
    expect(await command(LEADER, id, 'close', { decision: 'approve', reason: 'Nothing is owed.', evidence_ids: [], decision_document_version_id: decision })).toMatchObject({ status: 200, json: { status: 'CLOSED' } });
    // The next revision of the same settlement supersedes the closed one.
    const target = (await rows<{ project_id: string }>('select project_id from machvon.settlement_revision where id = $1::uuid', [id]))[0];
    const next = await open({ projectId: String(target?.project_id) });
    expect(next).toMatchObject({ status: 200, json: { status: 'DRAFT' } });
    expect((await call('GET', `/resources/settlement_revision/${id}`, { member: READER })).json).toMatchObject({ status: 'SUPERSEDED' });
    expect((await call('GET', `/resources/settlement_revision/${idOf(next)}`, { member: READER })).json).toMatchObject({ revision: 2, supersedes_id: id });
  });

  it('lists the settlements by status and project with a cursor, and answers 404 for one that is not there', async () => {
    const target = await project();
    const first = await opened(target);
    const second = await opened(target, { settlement_scope: 'ANNUAL', fiscal_year: 2040 });
    const page = await call('GET', `/resources/settlement_revision?project_id=${target.projectId}&limit=1`, { member: READER });
    expect(page.status).toBe(200);
    expect((page.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second]);
    expect(typeof page.json.next_cursor).toBe('string');
    const next = await call('GET', `/resources/settlement_revision?project_id=${target.projectId}&limit=1&cursor=${encodeURIComponent(String(page.json.next_cursor))}`, { member: READER });
    expect((next.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([first]);
    expect(next.json.next_cursor).toBeNull();
    expect((await call('GET', `/resources/settlement_revision?project_id=${target.projectId}&status=SUBMITTED`, { member: READER })).json.items).toEqual([]);
    expect(await call('GET', `/resources/settlement_revision?project_id=nope`, { member: READER })).toMatchObject({ status: 422 });
    expect(await call('GET', `/resources/settlement_revision?status=${encodeURIComponent('A')}`, { member: READER })).toMatchObject({ status: 422 });
    expect(await call('GET', `/resources/settlement_revision/${randomUUID()}`, { member: READER })).toMatchObject({ status: 404 });
    expect(await call('GET', `/resources/settlement_revision`, { member: CHIEF })).toMatchObject({ status: 200 });
  });
});
