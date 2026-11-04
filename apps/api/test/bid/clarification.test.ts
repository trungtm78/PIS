import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { ClarificationController } from '../../src/modules/bid/clarification.controller';
import { ConflictController } from '../../src/modules/bid/conflict.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAnalysisProfile, seedCriteria } from '../../../../packages/db/test/support/bid-analysis-fixtures';
import { hoursFromNow, onProjects, seedAs, seedBidPackage, seedContractor, seedProposal } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import type { SeededPackage } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { seedAnalysedProposal } from '../../../../packages/db/test/support/bid-review-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { asObject, asObjects } from '../support/json';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const E1 = 1; // bid.evaluate and the reading of requests: declared that no conflict stands
const E2 = 2; // the same: never declares
const E3 = 3; // the same: recused from NT-1
const CLERK = 4; // reads and records the answers over the tenant, evaluates nothing
const GUEST1 = 5; // a guest of NT-1
const GUEST2 = 6; // a guest of NT-2
const READER = 7; // bid.read only
const SENDER = 8; // bid.evaluate without the reading of requests
const AUTHORITY = 9; // decides the conflicts
const ELSEWHERE_CLERK = 10; // the same as the clerk over another branch
const GUEST_EVALUATOR = 11; // a guest of NT-1 who holds bid.evaluate: a guest never asks
const B_EVALUATOR = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const QUESTION = 'Giải trình đơn giá của hạng mục 7 trong bảng khối lượng.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the clarification requests to contractors over HTTP (ST-BID-011)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string | null }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== null && options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string }>('select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const stored = async (id: string) =>
    (await rows<{ status: string; version: string; answer_document_id: string | null; answered_by: string | null; answered_as_guest: boolean | null }>('select status, version::text, answer_document_id, answered_by, answered_as_guest from machvon.bid_clarification where id = $1::uuid', [id]))[0];

  interface World {
    seeded: SeededPackage;
    nt1: { contractor: string; proposal: string };
    nt2: { contractor: string; proposal: string };
  }

  const declare = (member: number, packageId: string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/procurement-packages/${packageId}/conflict-declarations`, { member, body });

  /** A package with two proposals whose bids are open (NT-1 and NT-2), a guest for each contractor, and E1 who declared that no conflict stands. */
  async function world(): Promise<World> {
    const seeded = await seedBidPackage(harness);
    expect((await declare(E1, seeded.packageId, { has_conflict: false })).status).toBe(200);
    const bidder = async (name: string, guest: number) => {
      const contractor = await seedContractor(harness, { name });
      const proposal = await seedProposal(harness, seeded, contractor, { releasedAt: hoursFromNow(-1) });
      await harness.owner(TENANT_A, [["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(guest), contractor]]]);
      return { contractor, proposal: proposal.id };
    };
    const nt1 = await bidder('NT-1', GUEST1);
    await harness.owner(TENANT_A, [["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST_EVALUATOR), nt1.contractor]]]);
    return { seeded, nt1, nt2: await bidder('NT-2', GUEST2) };
  }

  const send = (w: World, overrides: Record<string, unknown> = {}, options: { member?: number; key?: string; tenantId?: string; proposal?: string } = {}): Promise<Reply> =>
    call('POST', '/bid-clarifications', {
      member: options.member ?? E1,
      key: options.key,
      tenantId: options.tenantId,
      body: { proposal_id: options.proposal ?? w.nt1.proposal, question: QUESTION, due_at: hoursFromNow(5), ...overrides },
    });
  /** A document of DOC made by the member who names it, as the guest or the clerk who took the letter holds it. */
  const paper = async (member: number): Promise<string> => {
    const id = randomUUID();
    await seedAs(harness, [[`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CV', 'Reply', 'INTERNAL', $3, $3)`, [TENANT_A, id, memberId(member)]]]);
    return id;
  };
  const answer = async (id: string, version: number | null, member: number, overrides: Record<string, unknown> = {}, extra: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', `/bid-clarifications/${id}/answer`, { member, ...extra, ifMatch: version === null ? null : `"${version}"`, body: { answer_document_id: await paper(member), ...overrides } });
  const list = (member: number, query = '', tenantId?: string): Promise<Reply> => call('GET', `/bid-clarifications${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const read = (member: number, id: string, tenantId?: string): Promise<Reply> => call('GET', `/bid-clarifications/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [E1, E2, E3, CLERK, GUEST1, GUEST2, READER, SENDER, AUTHORITY, ELSEWHERE_CLERK, GUEST_EVALUATOR]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_EVALUATOR, ROOT);
    await harness.seedRole(TENANT_A, 1, 'BID_EVALUATOR', ['bid.evaluate', 'bid.clarification.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'BID_CLARIFICATION_CLERK', ['bid.clarification.read', 'bid.clarification.answer'], 20);
    await harness.seedRole(TENANT_A, 3, 'BID_READER', ['bid.read'], 10);
    await harness.seedRole(TENANT_A, 4, 'BID_SENDER', ['bid.evaluate'], 30);
    await harness.seedRole(TENANT_A, 5, 'BID_AUTHORITY', ['bid.conflict.decide', 'bid.read'], 40);
    await harness.seedRole(TENANT_A, 6, 'BID_GUEST_EVALUATOR', ['bid.evaluate', 'bid.clarification.read', 'bid.clarification.answer'], 30);
    await harness.seedRole(TENANT_B, 1, 'BID_EVALUATOR', ['bid.evaluate', 'bid.clarification.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: E1, role: 1, kind: 'TENANT' },
      { n: 2, member: E2, role: 1, kind: 'TENANT' },
      { n: 3, member: E3, role: 1, kind: 'TENANT' },
      { n: 4, member: CLERK, role: 2, kind: 'TENANT' },
      // A guest holds their role over contracts, not over the project of the package: what they answer is judged by their contractor.
      { n: 5, member: GUEST1, role: 2, kind: 'CONTRACT', refs: [randomUUID()] },
      { n: 6, member: GUEST2, role: 2, kind: 'TENANT' },
      { n: 7, member: READER, role: 3, kind: 'TENANT' },
      { n: 8, member: SENDER, role: 4, kind: 'TENANT' },
      { n: 9, member: AUTHORITY, role: 5, kind: 'TENANT' },
      { n: 10, member: ELSEWHERE_CLERK, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 11, member: GUEST_EVALUATOR, role: 6, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_EVALUATOR, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ClarificationController, ConflictController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of BID', () => {
    expect(bidModule.controllers).toContain(ClarificationController);
  });

  describe('sendBidClarification', () => {
    it('sends a request SENT at version 1 with its letter, answers the same key once, and writes the audit row and the event without the words of the question', async () => {
      const w = await world();
      const dueAt = hoursFromNow(30);
      const first = await send(w, { due_at: dueAt }, { key: 'send-once-for-this-key' });
      expect(first).toMatchObject({ status: 200, json: { status: 'SENT', resource_version: 1 } });
      expect(await send(w, { due_at: dueAt }, { key: 'send-once-for-this-key' })).toEqual(first);
      const id = first.json.resource_id as string;
      expect(await rows('select id from machvon.bid_clarification where package_id = $1::uuid', [w.seeded.packageId])).toHaveLength(1);
      const [row] = await rows<{ sent_document_id: string | null; due_at: Date }>('select question, status, created_by, sent_document_id, due_at from machvon.bid_clarification where id = $1::uuid', [id]);
      expect(row).toMatchObject({ question: QUESTION, status: 'SENT', created_by: memberId(E1) });
      expect(row?.due_at.toISOString()).toBe(new Date(dueAt).toISOString());
      const [audit] = await audits(id, 'bid.clarification_sent');
      expect(audit).toMatchObject({ actor_id: memberId(E1), safe_diff: { from_status: null, to_status: 'SENT', package_id: w.seeded.packageId, proposal_id: w.nt1.proposal, contractor_id: w.nt1.contractor, sent_document_id: row?.sent_document_id, due_at: new Date(dueAt).toISOString() } });
      const [event] = await events(id, 'bid.clarification.sent.v1');
      expect(event?.payload).toMatchObject({ clarification_id: id, package_id: w.seeded.packageId, proposal_id: w.nt1.proposal, contractor_id: w.nt1.contractor, status: 'SENT', version: 1, actor_id: memberId(E1) });
      expect(JSON.stringify([audit, event])).not.toContain('đơn giá');
    });

    it('refuses what the story names: a deadline that is not ahead (422 DUE_IN_PAST), a proposal that is not open (409 PROPOSAL_NOT_OPEN), a question that is too short (422), and a field nobody may write (400)', async () => {
      const w = await world();
      expect(await send(w, { due_at: hoursFromNow(-1) })).toMatchObject({ status: 422, json: { code: 'DUE_IN_PAST' } });
      expect(await send(w, { question: 'short' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await send(w, { due_at: 'tomorrow' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await send(w, { status: 'ANSWERED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await send(w, { basis_finding_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const old = await seedProposal(harness, w.seeded, await seedContractor(harness, { name: 'Old bid' }), { releasedAt: hoursFromNow(-2), status: 'SUPERSEDED' });
      expect(await send(w, {}, { proposal: old.id })).toMatchObject({ status: 409, json: { code: 'PROPOSAL_NOT_OPEN' } });
      expect(await rows('select id from machvon.bid_clarification where package_id = $1::uuid', [w.seeded.packageId])).toEqual([]);
    });

    it('is for the evaluation team over the project: the proposal does not exist for the others, and the declaration comes first', async () => {
      const w = await world();
      expect((await send(w, {}, { member: READER })).status).toBe(403);
      expect((await send(w, {}, { member: CLERK })).status).toBe(403);
      // A guest holds no right to ask whatever the role says: without the permission the door is shut, and with it the command refuses.
      expect((await send(w, {}, { member: GUEST1 })).status).toBe(403);
      expect(await send(w, {}, { member: GUEST_EVALUATOR })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await send(w, {}, { member: E2 })).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      expect((await send(w, {}, { member: SENDER })).status).toBe(403);
      expect(await send(w, {}, { member: B_EVALUATOR, tenantId: TENANT_B })).toMatchObject({ status: 404 });
      const sealed = await seedProposal(harness, w.seeded, await seedContractor(harness, { name: 'Sealed' }), { releasedAt: hoursFromNow(48) });
      expect((await send(w, {}, { proposal: sealed.id })).status).toBe(404);
      expect((await send(w, {}, { proposal: randomUUID() })).status).toBe(404);
      expect(await rows('select id from machvon.bid_clarification where package_id = $1::uuid', [w.seeded.packageId])).toEqual([]);
    });

    it('does not show a recused member the proposal of the contractor they are recused from', async () => {
      const w = await world();
      const made = await declare(E3, w.seeded.packageId, { has_conflict: true, relation_text: 'The director of NT-1 is my cousin.', contractor_id: w.nt1.contractor });
      expect(made.status).toBe(200);
      expect((await send(w, {}, { member: E3 })).status).toBe(404);
      const decided = await call('POST', `/bid-conflict-declarations/${made.json.resource_id}/decision`, {
        member: AUTHORITY,
        ifMatch: '"1"',
        body: { decision: 'RECUSED', decision_reason: 'The relation was examined by the authority and recorded.' },
      });
      expect(decided.status).toBe(200);
      expect((await send(w, {}, { member: E3 })).status).toBe(404);
      expect((await send(w, {}, { member: E3, proposal: w.nt2.proposal })).status).toBe(200);
    });
  });

  describe('recordClarificationAnswer (AC-ST-BID-011-1, UAT-AC452)', () => {
    it('AC-ST-BID-011-1, UAT-AC452: NT-2 gets 404 for reading and answering; NT-1 answers in time and it is ANSWERED with the document; the second answer after the deadline is 409 CLARIFICATION_EXPIRED and nothing changes', async () => {
      const w = await world();
      const sent = await send(w, { due_at: hoursFromNow(4) });
      const id = sent.json.resource_id as string;

      expect((await read(GUEST2, id)).status).toBe(404);
      expect(await answer(id, 1, GUEST2)).toMatchObject({ status: 404 });
      expect((await list(GUEST2)).json.items).toEqual([]);
      expect(await stored(id)).toMatchObject({ status: 'SENT', version: '1', answer_document_id: null });

      const reply = await paper(GUEST1);
      const done = await answer(id, 1, GUEST1, { answer_document_id: reply }, { key: 'answer-once-for-this-key' });
      expect(done).toMatchObject({ status: 200, json: { status: 'ANSWERED', resource_version: 2, resource_id: id } });
      expect(await answer(id, 1, GUEST1, { answer_document_id: reply }, { key: 'answer-once-for-this-key' })).toEqual(done);
      expect(await stored(id)).toMatchObject({ status: 'ANSWERED', version: '2', answer_document_id: reply, answered_by: memberId(GUEST1), answered_as_guest: true });
      const [audit] = await audits(id, 'bid.clarification_answered');
      expect(audit).toMatchObject({ actor_id: memberId(GUEST1), safe_diff: { from_status: 'SENT', to_status: 'ANSWERED', answer_document_id: reply, answered_as_guest: true } });
      const [event] = await events(id, 'bid.clarification.answered.v1');
      expect(event?.payload).toMatchObject({ clarification_id: id, status: 'ANSWERED', from_status: 'SENT', version: 2, answered_as_guest: true, actor_id: memberId(GUEST1) });

      // The next day: the deadline is behind, the request has been answered, and the answer is refused as late without any change.
      await harness.owner(TENANT_A, [["update machvon.bid_clarification set created_at = now() - interval '5 hours', due_at = now() - interval '1 hour', answered_at = now() - interval '2 hours' where id = $1::uuid", [id]]]);
      for (const version of [2, 1]) expect(await answer(id, version, GUEST1)).toMatchObject({ status: 409, json: { code: 'CLARIFICATION_EXPIRED' } });
      expect(await stored(id)).toMatchObject({ status: 'ANSWERED', version: '2', answer_document_id: reply });
    });

    it('is refused for a request that does not wait for an answer or a version that is not the current one, and needs the version of the request and a key', async () => {
      const w = await world();
      const id = (await send(w)).json.resource_id as string;
      expect(await answer(id, null, GUEST1)).toMatchObject({ status: 428 });
      expect(await answer(id, 5, GUEST1)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT', current_version: 1 } });
      expect((await answer(id, 1, GUEST1)).status).toBe(200);
      expect(await answer(id, 2, GUEST1)).toMatchObject({ status: 409, json: { code: 'CLARIFICATION_STATE_INVALID' } });
      expect(await answer(id, 2, GUEST1, { status: 'EXPIRED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await answer(id, 2, GUEST1, { answer_document_id: 'not-an-id' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    });

    it('lets the clerk who took the letter record the answer over the project, as staff, and not one whose scope lies elsewhere', async () => {
      const w = await world();
      const id = (await send(w)).json.resource_id as string;
      expect(await answer(id, 1, ELSEWHERE_CLERK)).toMatchObject({ status: 404 });
      expect((await answer(id, 1, READER)).status).toBe(403);
      expect((await answer(id, 1, E1)).status).toBe(403);
      const done = await answer(id, 1, CLERK);
      expect(done).toMatchObject({ status: 200, json: { status: 'ANSWERED' } });
      expect(await stored(id)).toMatchObject({ answered_by: memberId(CLERK), answered_as_guest: false });
    });

    it('does not take the answer of another tenant for a request here, and the letter of the request is not an answer', async () => {
      const w = await world();
      const id = (await send(w)).json.resource_id as string;
      expect(await answer(id, 1, B_EVALUATOR, {}, { tenantId: TENANT_B })).toMatchObject({ status: 403 });
      const [letter] = await rows<{ sent_document_id: string }>('select sent_document_id from machvon.bid_clarification where id = $1::uuid', [id]);
      expect(await answer(id, 1, CLERK, { answer_document_id: letter?.sent_document_id })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await stored(id)).toMatchObject({ status: 'SENT', version: '1' });
    });
  });

  describe('listBidClarifications and getBidClarification', () => {
    it('shows a contractor only what asks them, without who asked or the finding it rests on, and the staff by the project, the newest first', async () => {
      const w = await world();
      const first = (await send(w, { due_at: hoursFromNow(10) })).json.resource_id as string;
      const second = (await send(w, { due_at: hoursFromNow(20) }, { proposal: w.nt2.proposal })).json.resource_id as string;

      const mine = await list(GUEST1);
      expect(mine.status).toBe(200);
      expect(mine.json.as_of).toEqual(expect.any(String));
      const items = asObjects(mine.json.items).filter((item) => asObject(item.package).id === w.seeded.packageId);
      expect(items.map((item) => item.id)).toEqual([first]);
      expect(items[0]).toEqual({
        id: first,
        package: { id: w.seeded.packageId, code: w.seeded.packageCode },
        project_id: w.seeded.projectId,
        proposal_id: w.nt1.proposal,
        contractor: { id: w.nt1.contractor, legal_name: 'NT-1' },
        question: QUESTION,
        basis_finding: null,
        due_at: expect.any(String),
        status: 'SENT',
        sent_document_id: expect.any(String),
        answer_document_id: null,
        answered_at: null,
        answered_by: null,
        answered_as_guest: null,
        asked_by: null,
        created_at: expect.any(String),
        actions: { answer: true },
        version: 1,
      });
      expect((await read(GUEST1, first)).json).toMatchObject({ id: first, asked_by: null, actions: { answer: true } });
      expect((await read(GUEST1, second)).status).toBe(404);

      const staff = await list(CLERK, `?package_id=${w.seeded.packageId}`);
      expect(asObjects(staff.json.items).map((item) => item.id)).toEqual([second, first]);
      expect(asObjects(staff.json.items)[1]).toMatchObject({ asked_by: { membership_id: memberId(E1) }, actions: { answer: true } });
      expect(asObjects((await list(CLERK, `?proposal_id=${w.nt2.proposal}`)).json.items).map((item) => item.id)).toEqual([second]);
      expect((await list(E1, `?package_id=${w.seeded.packageId}`)).json.items).toHaveLength(2);
      expect((await list(ELSEWHERE_CLERK, `?package_id=${w.seeded.packageId}`)).json.items).toEqual([]);
      expect((await read(ELSEWHERE_CLERK, first)).status).toBe(404);
      // The evaluator reads and asks but does not answer: no action offered.
      expect((await read(E1, first)).json.actions).toEqual({ answer: false });
    });

    it('names the finding a question rests on for the staff and never to the contractor', async () => {
      const seeded = await seedBidPackage(harness);
      expect((await declare(E1, seeded.packageId, { has_conflict: false })).status).toBe(200);
      const criteria = await seedCriteria(harness, seeded.packageId, { codes: ['C1', 'C2', 'C3'] });
      const profile = await seedAnalysisProfile(harness);
      const run = await seedAnalysedProposal(
        harness,
        { seeded, profileId: profile.id, evaluator: { membershipId: memberId(E1), evaluate: onProjects(seeded.projectId), receive: () => ({ sql: 'false', params: [] }), now: new Date() }, member: E1 },
        'NT-3',
        criteria.id,
      );
      await harness.owner(TENANT_A, [["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST1), run.contractorId]]]);
      const finding = run.findings.get('C2') as string;
      const sent = await call('POST', '/bid-clarifications', { member: E1, body: { proposal_id: run.proposalId, question: QUESTION, due_at: hoursFromNow(5), basis_finding_id: finding } });
      expect(sent.status).toBe(200);
      const id = sent.json.resource_id as string;
      expect((await read(CLERK, id)).json.basis_finding).toEqual({ id: finding, criterion_code: 'C2' });
      expect((await read(GUEST1, id)).json).toMatchObject({ basis_finding: null, asked_by: null, actions: { answer: true } });
      expect(asObjects((await list(GUEST1)).json.items).find((item) => item.id === id)).toMatchObject({ basis_finding: null });
      expect((await audits(id, 'bid.clarification_sent'))[0]?.safe_diff).toMatchObject({ basis_finding_id: finding });
    });

    it('shows a request nobody answered by its deadline as EXPIRED without changing it, and offers no answer', async () => {
      const w = await world();
      const id = (await send(w, { due_at: hoursFromNow(2) })).json.resource_id as string;
      await harness.owner(TENANT_A, [["update machvon.bid_clarification set created_at = now() - interval '5 hours', due_at = now() - interval '1 hour' where id = $1::uuid", [id]]]);
      expect((await read(CLERK, id)).json).toMatchObject({ status: 'EXPIRED', actions: { answer: false } });
      expect(await answer(id, 1, GUEST1)).toMatchObject({ status: 409, json: { code: 'CLARIFICATION_EXPIRED' } });
      expect(await stored(id)).toMatchObject({ status: 'SENT', version: '1' });
    });

    it('asks the declaration of a member of the evaluation team before it shows anything, and refuses a caller without the permission or from another tenant', async () => {
      const w = await world();
      const id = (await send(w)).json.resource_id as string;
      expect(await list(E2)).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      expect(await read(E2, id)).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      expect((await list(READER)).status).toBe(403);
      expect((await read(SENDER, id)).status).toBe(403);
      expect((await read(B_EVALUATOR, id, TENANT_B)).status).toBe(404);
      expect((await list(B_EVALUATOR, '', TENANT_B)).json.items).toEqual([]);
      expect((await read(CLERK, randomUUID())).status).toBe(404);
      expect(await list(CLERK, '?package_id=nope')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await list(CLERK, '?proposal_id=nope')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    });
  });
});
