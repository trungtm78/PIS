import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { BidClarificationStore } from '../src/bid-clarification-store';
import type { ClarificationViewer, SenderViewer } from '../src/bid-clarification-store';
import { BidConflictStore } from '../src/bid-conflict-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';
import { seedAnalysisProfile, seedCriteria } from './support/bid-analysis-fixtures';
import { DEPARTMENT, OTHER_PROJECT_UNIT, PROVINCE, everything, hoursFromNow, nothing, onProjects, seedAs, seedBidPackage, seedContractor, seedProposal } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';
import { seedAnalysedProposal } from './support/bid-review-fixtures';
import type { AnalysedProposal } from './support/bid-review-fixtures';

jest.setTimeout(120_000);

const harness = new AuthzHarness();
const store = new BidClarificationStore();
const conflicts = new BidConflictStore();
const E1 = 2;
const E2 = 3;
const E3 = 4;
const CLERK = 5;
const GUEST1 = 6;
const GUEST2 = 7;
const APPROVER = 8;
const QUESTION = 'Explain the unit price of item 7 of the bill of quantities.';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = E1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const rows = <R extends object>(sql: string, params: unknown[] = []) => harness.owner<R>(TENANT_A, [[sql, params]]);
const sender = (member: number, evaluate: ScopeBuilder): SenderViewer => ({ membershipId: memberId(member), evaluate });

interface Refusal {
  code?: string;
  status?: number;
  detail?: string;
  extensions?: Record<string, unknown>;
  message: string;
}
const failure = async (work: Promise<unknown>): Promise<Refusal> => {
  try {
    await work;
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('expected a refusal');
};

describe('the clarification requests to contractors (ST-BID-011, BID 3 F6, BR-BID-03)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
      { n: OTHER_PROJECT_UNIT, path: '/u3/' },
    ]);
    for (const n of [1, E1, E2, E3, CLERK, GUEST1, GUEST2, APPROVER]) await harness.seedMembership(TENANT_A, n, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  interface World {
    seeded: SeededPackage;
    nt1: AnalysedProposal;
    nt2: AnalysedProposal;
    sendNt1: SenderViewer;
    /** The staff clerk who takes the letters of the contractors: reaches the project, evaluates nothing. */
    clerk: ClarificationViewer;
    guest1: ClarificationViewer;
    guest2: ClarificationViewer;
    evaluator: ClarificationViewer;
  }

  /** A package with two analysed proposals (NT-1 and NT-2), E1 who declared that no conflict stands, a clerk and one guest of each contractor. */
  async function world(): Promise<World> {
    const seeded = await seedBidPackage(harness);
    await as((tx) => conflicts.declare(tx, { packageId: seeded.packageId, hasConflict: false }, memberId(E1), everything));
    const criteria = await seedCriteria(harness, seeded.packageId, { codes: ['C1', 'C2', 'C3'] });
    const profile = await seedAnalysisProfile(harness);
    const base = { seeded, profileId: profile.id, evaluator: { membershipId: memberId(E1), evaluate: onProjects(seeded.projectId), receive: nothing, now: new Date() }, member: E1 };
    const nt1 = await seedAnalysedProposal(harness, base, 'NT-1', criteria.id);
    const nt2 = await seedAnalysedProposal(harness, base, 'NT-2', criteria.id);
    const guest = async (member: number, contractorId: string): Promise<ClarificationViewer> => {
      await harness.owner(TENANT_A, [["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(member), contractorId]]]);
      return { membershipId: memberId(member), guestContractorId: contractorId, reach: nothing, evaluate: nothing };
    };
    return {
      seeded,
      nt1,
      nt2,
      sendNt1: sender(E1, onProjects(seeded.projectId)),
      clerk: { membershipId: memberId(CLERK), guestContractorId: null, reach: onProjects(seeded.projectId), evaluate: nothing },
      guest1: await guest(GUEST1, nt1.contractorId),
      guest2: await guest(GUEST2, nt2.contractorId),
      evaluator: { membershipId: memberId(E1), guestContractorId: null, reach: onProjects(seeded.projectId), evaluate: onProjects(seeded.projectId) },
    };
  }

  const dueIn = (hours: number): string => hoursFromNow(hours);
  const send = (w: World, proposalId = w.nt1.proposalId, overrides: Partial<{ question: unknown; basisFindingId: string; dueAt: unknown }> = {}, viewer: SenderViewer = w.sendNt1, member = E1, now = new Date()) =>
    as((tx) => store.send(tx, { proposalId, question: QUESTION, dueAt: dueIn(5), ...overrides }, viewer, memberId(member), now), member);

  /** A document of DOC as a guest or a clerk would hold it: made by the member who names it. */
  async function paper(member: number, options: { subject?: string } = {}): Promise<string> {
    const id = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, subject_module, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CV', 'Reply', 'INTERNAL', $4, $3, $3)`,
        [TENANT_A, id, memberId(member), options.subject ?? null],
      ],
    ]);
    return id;
  }

  const answer = (w: World, id: string, version: number, documentId: string, viewer: ClarificationViewer, member: number, now = new Date()) =>
    as((tx) => store.answer(tx, id, version, { answerDocumentId: documentId }, viewer, now), member);
  const stored = async (id: string) =>
    (await rows<{ status: string; version: string; answer_document_id: string | null; answered_by: string | null; answered_as_guest: boolean | null; answered_at: string | null }>(
      'select status, version::text, answer_document_id, answered_by, answered_as_guest, answered_at::text from machvon.bid_clarification where id = $1::uuid',
      [id],
    ))[0];
  const count = async (w: World): Promise<number> => (await rows<{ n: number }>('select count(*)::int as n from machvon.bid_clarification where package_id = $1::uuid', [w.seeded.packageId]))[0]?.n ?? -1;
  const documents = async (w: World): Promise<number> => (await rows<{ n: number }>("select count(*)::int as n from machvon.document where subject_module = 'BID_CLARIFICATION' and title = $1", [`Clarification request ${w.seeded.packageCode}`]))[0]?.n ?? -1;

  describe('sending a request', () => {
    it('writes a request that is SENT at version 1 with its letter, a confidential document of DOC about it, and keeps the words trimmed', async () => {
      const w = await world();
      const due = dueIn(30);
      const sent = await send(w, w.nt1.proposalId, { question: `   ${QUESTION}  `, dueAt: due });
      expect(sent).toMatchObject({ packageId: w.seeded.packageId, packageCode: w.seeded.packageCode, projectId: w.seeded.projectId, proposalId: w.nt1.proposalId, contractorId: w.nt1.contractorId, status: 'SENT', fromStatus: null, version: 1, basisFindingId: null, answerDocumentId: null });
      expect(sent.dueAt).toBe(new Date(due).toISOString());
      const [row] = await rows<{ question: string; status: string; created_by: string; sent_document_id: string; basis_finding_id: string | null; due_at: Date; version: string }>(
        'select question, status, created_by, sent_document_id, basis_finding_id, due_at, version::text from machvon.bid_clarification where id = $1::uuid',
        [sent.id],
      );
      expect(row).toMatchObject({ question: QUESTION, status: 'SENT', created_by: memberId(E1), sent_document_id: sent.sentDocumentId, basis_finding_id: null, version: '1' });
      expect(row?.due_at.toISOString()).toBe(sent.dueAt);
      expect(await rows('select doc_kind, doc_type_code, classification, subject_module, subject_id, created_by, effect_status, title from machvon.document where id = $1::uuid', [sent.sentDocumentId])).toEqual([
        { doc_kind: 'REFERENCE', doc_type_code: 'BID-CLARIFICATION', classification: 'CONFIDENTIAL', subject_module: 'BID_CLARIFICATION', subject_id: sent.id, created_by: memberId(E1), effect_status: 'PENDING', title: `Clarification request ${w.seeded.packageCode}` },
      ]);
    });

    it('names the finding the question rests on when it is a finding of the same proposal (422 for the finding of another proposal or one that does not exist)', async () => {
      const w = await world();
      const finding = w.nt1.findings.get('C2') as string;
      const sent = await send(w, w.nt1.proposalId, { basisFindingId: finding });
      expect(sent.basisFindingId).toBe(finding);
      expect(await rows('select basis_finding_id from machvon.bid_clarification where id = $1::uuid', [sent.id])).toEqual([{ basis_finding_id: finding }]);
      const before = await count(w);
      for (const other of [w.nt2.findings.get('C2') as string, randomUUID()]) {
        expect(await failure(send(w, w.nt1.proposalId, { basisFindingId: other }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'basis_finding_id' });
      }
      expect(await failure(send(w, w.nt1.proposalId, { basisFindingId: 'not-an-id' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'basis_finding_id' });
      expect(await count(w)).toBe(before);
    });

    it('refuses a question that is too short or a deadline that is not ahead (422), and writes nothing for a refusal', async () => {
      const w = await world();
      const before = [await count(w), await documents(w)];
      expect(await failure(send(w, w.nt1.proposalId, { question: 'short' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'question' });
      expect(await failure(send(w, w.nt1.proposalId, { dueAt: dueIn(-1) }))).toMatchObject({ code: 'DUE_IN_PAST', status: 422, detail: 'due_at' });
      expect(await failure(send(w, w.nt1.proposalId, { dueAt: 'tomorrow' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_at' });
      expect(await failure(send(w, 'not-an-id'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'proposal_id' });
      expect([await count(w), await documents(w)]).toEqual(before);
    });

    it('refuses a proposal that does not exist for the caller with 404: the project they do not evaluate, the bids not opened yet, another tenant\'s id', async () => {
      const w = await world();
      expect(await failure(send(w, randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await failure(send(w, w.nt1.proposalId, {}, sender(E1, nothing)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await failure(send(w, w.nt1.proposalId, {}, sender(E1, onProjects(randomUUID()))))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const sealed = await seedProposal(harness, w.seeded, await seedContractor(harness, { name: 'NT-3' }), { releasedAt: hoursFromNow(48) });
      expect(await failure(send(w, sealed.id))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await count(w)).toBe(0);
    });

    it('asks the declaration first (403 CONFLICT_UNDECLARED), and a recused member does not see the proposal of that contractor (404)', async () => {
      const w = await world();
      const undeclared = sender(E2, onProjects(w.seeded.projectId));
      expect(await failure(send(w, w.nt1.proposalId, {}, undeclared, E2))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });

      const made = await as((tx) => conflicts.declare(tx, { packageId: w.seeded.packageId, hasConflict: true, relationText: 'The director of NT-1 is my cousin.', contractorId: w.nt1.contractorId }, memberId(E3), everything), E3);
      const recused = sender(E3, onProjects(w.seeded.projectId));
      // Waiting for the decision, and once recused: NT-1 does not exist for them; NT-2 does.
      expect(await failure(send(w, w.nt1.proposalId, {}, recused, E3))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await as((tx) => conflicts.decide(tx, made.id, 1, 'RECUSED', 'The relation was examined and decided by the authority.', memberId(APPROVER), everything), APPROVER);
      expect(await failure(send(w, w.nt1.proposalId, {}, recused, E3))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await send(w, w.nt2.proposalId, {}, recused, E3)).contractorId).toBe(w.nt2.contractorId);
      expect(await count(w)).toBe(1);
    });

    it('refuses a proposal that was replaced or withdrawn with 409 PROPOSAL_NOT_OPEN, and writes nothing', async () => {
      const w = await world();
      for (const status of ['SUPERSEDED', 'WITHDRAWN']) {
        const old = await seedProposal(harness, w.seeded, await seedContractor(harness, { name: `Old ${status}` }), { releasedAt: hoursFromNow(-2), status: 'SUPERSEDED' });
        if (status === 'WITHDRAWN') await seedAs(harness, [["update machvon.proposal set status = 'WITHDRAWN', withdrawn_reason = 'The contractor withdrew the bid.' where id = $1::uuid", [old.id]]]);
        expect(await failure(send(w, old.id))).toMatchObject({ code: 'PROPOSAL_NOT_OPEN', status: 409, extensions: { proposal_status: status } });
      }
      expect(await count(w)).toBe(0);
      expect(await documents(w)).toBe(0);
    });
  });

  describe('answering a request (AC-ST-BID-011-1, UAT-AC452)', () => {
    it('AC-ST-BID-011-1: the guest of NT-1 answers in time with a document and the request is ANSWERED; NT-2 does not see it; the same guest answering after the deadline gets 409 CLARIFICATION_EXPIRED and nothing changes', async () => {
      const w = await world();
      const sent = await send(w, w.nt1.proposalId, { dueAt: dueIn(3) });
      const reply = await paper(GUEST1);

      // NT-2, a guest of another contractor, neither reads nor answers it: it does not exist for them.
      expect(await as((tx) => store.find(tx, sent.id, w.guest2), GUEST2)).toEqual({ kind: 'HIDDEN' });
      expect(await failure(answer(w, sent.id, 1, await paper(GUEST2), w.guest2, GUEST2))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await stored(sent.id)).toMatchObject({ status: 'SENT', version: '1', answer_document_id: null });

      const at = new Date(Date.now() + 3_600_000);
      const answered = await answer(w, sent.id, 1, reply, w.guest1, GUEST1, at);
      expect(answered).toMatchObject({ id: sent.id, status: 'ANSWERED', fromStatus: 'SENT', version: 2, answerDocumentId: reply, answeredAsGuest: true, answeredAt: at.toISOString(), contractorId: w.nt1.contractorId });
      expect(await stored(sent.id)).toMatchObject({ status: 'ANSWERED', version: '2', answer_document_id: reply, answered_by: memberId(GUEST1), answered_as_guest: true });

      // The next day: the time is up, whatever version the caller names, and the request stays as it was answered.
      const nextDay = new Date(Date.now() + 26 * 3_600_000);
      const again = await paper(GUEST1);
      for (const version of [1, 2]) {
        expect(await failure(answer(w, sent.id, version, again, w.guest1, GUEST1, nextDay))).toMatchObject({ code: 'CLARIFICATION_EXPIRED', status: 409 });
      }
      expect(await stored(sent.id)).toMatchObject({ status: 'ANSWERED', version: '2', answer_document_id: reply });
    });

    it('answers once when two answers come at the same time: the second waits for the first and finds the request answered (409), never a failure of the database', async () => {
      const w = await world();
      const sent = await send(w);
      const [one, other] = [await paper(GUEST1), await paper(CLERK)];
      const waiting = async (): Promise<number> =>
        (await rows<{ n: number }>("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%machvon.bid_clarification%'"))[0]?.n ?? 0;
      let second: Promise<Refusal> | undefined;
      // The first answer holds its request until it commits; the second is started while it does and is let to wait on it.
      const first = await as(async (tx) => {
        const done = await store.answer(tx, sent.id, 1, { answerDocumentId: one }, w.guest1, new Date());
        second = failure(answer(w, sent.id, 1, other, w.clerk, CLERK));
        for (let attempt = 0; attempt < 200 && (await waiting()) === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
        return done;
      }, GUEST1);
      expect(first).toMatchObject({ status: 'ANSWERED', version: 2 });
      expect(await second).toMatchObject({ code: 'CLARIFICATION_STATE_INVALID', status: 409 });
      expect(await stored(sent.id)).toMatchObject({ status: 'ANSWERED', version: '2', answer_document_id: one });
    });

    it('lets the clerk who took the letter record the answer for the contractor (as staff, not as a guest)', async () => {
      const w = await world();
      const sent = await send(w);
      const reply = await paper(CLERK);
      const answered = await answer(w, sent.id, 1, reply, w.clerk, CLERK);
      expect(answered).toMatchObject({ status: 'ANSWERED', answeredAsGuest: false });
      expect(await stored(sent.id)).toMatchObject({ status: 'ANSWERED', answered_by: memberId(CLERK), answered_as_guest: false });
    });

    it('refuses a staff caller who does not reach the project, a recused evaluator and one who owes the declaration, as the request does not exist for them (404, 403)', async () => {
      const w = await world();
      const sent = await send(w);
      const reply = await paper(CLERK);
      const outside: ClarificationViewer = { ...w.clerk, reach: onProjects(randomUUID()) };
      expect(await failure(answer(w, sent.id, 1, reply, outside, CLERK))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const undeclared: ClarificationViewer = { membershipId: memberId(E2), guestContractorId: null, reach: onProjects(w.seeded.projectId), evaluate: onProjects(w.seeded.projectId) };
      expect(await failure(answer(w, sent.id, 1, await paper(E2), undeclared, E2))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });
      const made = await as((tx) => conflicts.declare(tx, { packageId: w.seeded.packageId, hasConflict: true, relationText: 'The director of NT-1 is my cousin.', contractorId: w.nt1.contractorId }, memberId(E3), everything), E3);
      await as((tx) => conflicts.decide(tx, made.id, 1, 'RECUSED', 'The relation was examined and decided by the authority.', memberId(APPROVER), everything), APPROVER);
      const recused: ClarificationViewer = { membershipId: memberId(E3), guestContractorId: null, reach: onProjects(w.seeded.projectId), evaluate: onProjects(w.seeded.projectId) };
      expect(await failure(answer(w, sent.id, 1, await paper(E3), recused, E3))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await stored(sent.id)).toMatchObject({ status: 'SENT', version: '1' });
      expect(await failure(answer(w, randomUUID(), 1, reply, w.clerk, CLERK))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('refuses an answer to a request that was answered already in time (409 CLARIFICATION_STATE_INVALID), a stale version (409 VERSION_CONFLICT) and a deadline that passed (409 CLARIFICATION_EXPIRED)', async () => {
      const w = await world();
      const sent = await send(w);
      expect(await failure(answer(w, sent.id, 7, await paper(GUEST1), w.guest1, GUEST1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      await answer(w, sent.id, 1, await paper(GUEST1), w.guest1, GUEST1);
      expect(await failure(answer(w, sent.id, 2, await paper(GUEST1), w.guest1, GUEST1))).toMatchObject({ code: 'CLARIFICATION_STATE_INVALID', status: 409, extensions: { status: 'ANSWERED' } });
      const second = await send(w);
      expect(await failure(answer(w, second.id, 1, await paper(GUEST1), w.guest1, GUEST1, new Date(Date.now() + 6 * 3_600_000)))).toMatchObject({ code: 'CLARIFICATION_EXPIRED', status: 409 });
      expect(await stored(second.id)).toMatchObject({ status: 'SENT', version: '1' });
    });

    it('takes the answer only on a document that exists, is not the letter, answers or asks no other request, is not about a sealed proposal, and that a guest made themselves (422)', async () => {
      const w = await world();
      const first = await send(w);
      const second = await send(w);
      expect(await failure(answer(w, first.id, 1, randomUUID(), w.guest1, GUEST1))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'answer_document_id' });
      expect(await failure(answer(w, first.id, 1, 'not-an-id', w.guest1, GUEST1))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'answer_document_id' });
      // The letter of the very request is refused as such, not as a paper some other request holds.
      const asLetter = await failure(answer(w, first.id, 1, first.sentDocumentId, w.guest1, GUEST1));
      expect(asLetter).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'answer_document_id' });
      expect(asLetter.extensions).toBeUndefined();
      expect(await failure(answer(w, first.id, 1, second.sentDocumentId, w.guest1, GUEST1))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'answer_document_id', extensions: { reason: 'DOCUMENT_ALREADY_USED' } });
      expect(await failure(answer(w, first.id, 1, await paper(CLERK), w.guest1, GUEST1))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'answer_document_id' });
      expect(await failure(answer(w, first.id, 1, await paper(GUEST1, { subject: 'BID_PROPOSAL' }), w.guest1, GUEST1))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'answer_document_id' });
      expect(await stored(first.id)).toMatchObject({ status: 'SENT', version: '1' });

      const reply = await paper(GUEST1);
      await answer(w, first.id, 1, reply, w.guest1, GUEST1);
      expect(await failure(answer(w, second.id, 1, reply, w.guest1, GUEST1))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'answer_document_id', extensions: { reason: 'DOCUMENT_ALREADY_USED' } });
      // The staff may name a paper of anyone of the tenant (the clerk registers the letters that come in).
      expect((await answer(w, second.id, 1, await paper(GUEST1), w.clerk, CLERK)).status).toBe('ANSWERED');
    });
  });

  describe('reading the requests', () => {
    it('shows a guest only the requests of their own contractor, without the names of the evaluators and the finding the question rests on, and the staff by the project', async () => {
      const w = await world();
      const first = await send(w, w.nt1.proposalId, { basisFindingId: w.nt1.findings.get('C2') as string, dueAt: dueIn(10) });
      const second = await send(w, w.nt2.proposalId, { dueAt: dueIn(20) });
      const reply = await paper(GUEST1);
      await answer(w, first.id, 1, reply, w.guest1, GUEST1);

      const mine = await as((tx) => store.list(tx, w.guest1, {}), GUEST1);
      expect(mine.owed).toBe(false);
      expect(mine.lines.map((line) => line.id)).toEqual([first.id]);
      const theirs = await as((tx) => store.list(tx, w.guest2, {}), GUEST2);
      expect(theirs.lines.map((line) => line.id)).toEqual([second.id]);

      const all = await as((tx) => store.list(tx, w.clerk, {}), CLERK);
      expect(all.lines.map((line) => line.id)).toEqual([second.id, first.id]);
      expect(all.lines.find((line) => line.id === first.id)).toMatchObject({
        package: { id: w.seeded.packageId, code: w.seeded.packageCode },
        project: { id: w.seeded.projectId },
        proposalId: w.nt1.proposalId,
        contractor: { id: w.nt1.contractorId, legalName: 'NT-1' },
        question: QUESTION,
        basisFinding: { id: w.nt1.findings.get('C2'), criterionCode: 'C2' },
        status: 'ANSWERED',
        sentDocumentId: first.sentDocumentId,
        answerDocumentId: reply,
        answeredBy: { membershipId: memberId(GUEST1) },
        answeredAsGuest: true,
        askedBy: { membershipId: memberId(E1) },
        version: 2,
      });
      expect(all.lines.find((line) => line.id === second.id)).toMatchObject({ status: 'SENT', answerDocumentId: null, answeredBy: null, answeredAsGuest: null, answeredAt: null, basisFinding: null, version: 1 });

      expect(await as((tx) => store.list(tx, { ...w.clerk, reach: nothing }, {}), CLERK)).toEqual({ lines: [], owed: false });
      expect((await as((tx) => store.list(tx, w.clerk, { packageId: w.seeded.packageId, proposalId: w.nt2.proposalId }), CLERK)).lines.map((line) => line.id)).toEqual([second.id]);
      expect((await as((tx) => store.list(tx, w.clerk, { packageId: randomUUID() }), CLERK)).lines).toEqual([]);

      expect(await as((tx) => store.find(tx, first.id, w.guest1), GUEST1)).toMatchObject({ kind: 'SEEN', line: { id: first.id } });
      expect(await as((tx) => store.find(tx, first.id, w.guest2), GUEST2)).toEqual({ kind: 'HIDDEN' });
      expect(await as((tx) => store.find(tx, first.id, { ...w.clerk, reach: onProjects(randomUUID()) }), CLERK)).toEqual({ kind: 'HIDDEN' });
      expect(await as((tx) => store.find(tx, randomUUID(), w.clerk), CLERK)).toEqual({ kind: 'HIDDEN' });
    });

    it('holds a member of the evaluation team to the declaration of conflicts: owed until made, hidden while a conflict with the contractor stands, shown once it is allowed', async () => {
      const w = await world();
      const nt1 = await send(w, w.nt1.proposalId);
      const nt2 = await send(w, w.nt2.proposalId);
      const undeclared: ClarificationViewer = { ...w.evaluator, membershipId: memberId(E2) };
      expect(await as((tx) => store.list(tx, undeclared, {}), E2)).toEqual({ lines: [], owed: true });
      expect(await as((tx) => store.find(tx, nt1.id, undeclared), E2)).toEqual({ kind: 'DECLARATION_REQUIRED' });

      const made = await as((tx) => conflicts.declare(tx, { packageId: w.seeded.packageId, hasConflict: true, relationText: 'The director of NT-1 is my cousin.', contractorId: w.nt1.contractorId }, memberId(E3), everything), E3);
      const member: ClarificationViewer = { ...w.evaluator, membershipId: memberId(E3) };
      expect(await as((tx) => store.find(tx, nt1.id, member), E3)).toEqual({ kind: 'HIDDEN' });
      expect((await as((tx) => store.list(tx, member, {}), E3)).lines.map((line) => line.id)).toEqual([nt2.id]);
      await as((tx) => conflicts.decide(tx, made.id, 1, 'ALLOWED', 'The relation was examined and decided by the authority.', memberId(APPROVER), everything), APPROVER);
      expect((await as((tx) => store.list(tx, member, {}), E3)).lines.map((line) => line.id).sort()).toEqual([nt1.id, nt2.id].sort());
    });
  });

  describe('the list when the page of the newest requests is hidden from the caller', () => {
    it('keeps reading older requests until it holds as many as the caller may see, so those the conflict shuts out never crowd the others out', async () => {
      const w = await world();
      const visible = await send(w, w.nt2.proposalId);
      for (let n = 0; n < 3; n++) await send(w, w.nt1.proposalId);
      await as((tx) => conflicts.declare(tx, { packageId: w.seeded.packageId, hasConflict: true, relationText: 'The director of NT-1 is my cousin.', contractorId: w.nt1.contractorId }, memberId(E3), everything), E3);
      const member: ClarificationViewer = { ...w.evaluator, membershipId: memberId(E3) };
      const narrow = new BidClarificationStore(2);
      expect((await as((tx) => narrow.list(tx, member, {}), E3)).lines.map((line) => line.id)).toEqual([visible.id]);
    });

    it('stops at the limit when the caller may see more than it', async () => {
      const w = await world();
      for (let n = 0; n < 3; n++) await send(w, w.nt2.proposalId);
      const narrow = new BidClarificationStore(2);
      expect((await as((tx) => narrow.list(tx, w.clerk, {}), CLERK)).lines).toHaveLength(2);
    });
  });

  describe('what the database holds (V1353)', () => {
    it('keeps what was asked: the words, the deadline and the letter never change, a request is never deleted, and an answered one is kept as it is', async () => {
      const w = await world();
      const sent = await send(w);
      for (const change of ["question = 'A different question, asked later.'", "due_at = due_at + interval '1 day'", 'sent_document_id = gen_random_uuid()', 'package_id = gen_random_uuid()', "created_by = '00000000-0000-4000-8000-000000000001'"]) {
        await expect(as((tx) => tx.query(`update machvon.bid_clarification set ${change} where id = $1::uuid`, [sent.id]))).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|23503)$/) });
      }
      await expect(as((tx) => tx.query('delete from machvon.bid_clarification where id = $1::uuid', [sent.id]))).rejects.toThrow();
      await expect(as((tx) => tx.query('truncate machvon.bid_clarification'))).rejects.toThrow();
      await answer(w, sent.id, 1, await paper(GUEST1), w.guest1, GUEST1);
      await expect(as((tx) => tx.query("update machvon.bid_clarification set status = 'WITHDRAWN' where id = $1::uuid", [sent.id]))).rejects.toMatchObject({ code: '23514' });
      // A request that was withdrawn is kept as it is: it takes no answer afterwards.
      const withdrawn = await send(w);
      await as((tx) => tx.query("update machvon.bid_clarification set status = 'WITHDRAWN', updated_at = now(), version = version + 1 where id = $1::uuid", [withdrawn.id]));
      const afterwards = await paper(GUEST1);
      await expect(as((tx) => tx.query("update machvon.bid_clarification set status = 'ANSWERED', answer_document_id = $2::uuid, answered_at = now(), answered_by = $3::uuid, answered_as_guest = true where id = $1::uuid", [withdrawn.id, afterwards, memberId(GUEST1)]))).rejects.toMatchObject({ code: '23514' });
      expect(await stored(withdrawn.id)).toMatchObject({ status: 'WITHDRAWN', answer_document_id: null });
      expect(await stored(sent.id)).toMatchObject({ status: 'ANSWERED', version: '2' });
    });

    it('writes a request only as SENT with a confidential letter about it, and an answer only before the deadline and never on the letter of a request', async () => {
      const w = await world();
      const sent = await send(w);
      const insert = (status: string, letter: string | null, id = randomUUID()) =>
        as((tx) =>
          tx.query(
            `insert into machvon.bid_clarification (tenant_id, id, package_id, proposal_id, question, due_at, status, sent_document_id, created_by, updated_by, version)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, now() + interval '1 hour', $5, $6::uuid, $7::uuid, $7::uuid, 1)`,
            [id, w.seeded.packageId, w.nt1.proposalId, QUESTION, status, letter, memberId(E1)],
          ),
        );
      await expect(insert('DRAFT', null)).rejects.toMatchObject({ code: '23514' });
      // The deadline lies after the moment the question was asked, and the words fit a letter (the letter is the confidential document about this very request).
      const written = async (question: string, due: string, status = 'SENT', version = 1): Promise<void> => {
        const id = randomUUID();
        const letter = randomUUID();
        await harness.owner(TENANT_A, [
          [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, subject_module, subject_id, created_by, updated_by) values ($1, $2, 'REFERENCE', 'BID-CLARIFICATION', 'Letter', 'CONFIDENTIAL', 'BID_CLARIFICATION', $3, $4, $4)`, [TENANT_A, letter, id, memberId(E1)]],
        ]);
        await as((tx) =>
          tx.query(
            `insert into machvon.bid_clarification (tenant_id, id, package_id, proposal_id, question, due_at, status, sent_document_id, created_by, updated_by, version)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $8, $6::uuid, $7::uuid, $7::uuid, $9::bigint)`,
            [id, w.seeded.packageId, w.nt1.proposalId, question, due, letter, memberId(E1), status, version],
          ),
        );
      };
      await expect(written(QUESTION, new Date(Date.now() - 3_600_000).toISOString())).rejects.toMatchObject({ code: '23514' });
      await expect(written('short', new Date(Date.now() + 3_600_000).toISOString())).rejects.toMatchObject({ code: '23514' });
      // Written as it is sent: at version 1, and not as a draft or as an answer already given.
      await expect(written(QUESTION, new Date(Date.now() + 3_600_000).toISOString(), 'DRAFT')).rejects.toMatchObject({ code: '23514' });
      await expect(written(QUESTION, new Date(Date.now() + 3_600_000).toISOString(), 'SENT', 2)).rejects.toMatchObject({ code: '23514' });
      await written(QUESTION, new Date(Date.now() + 3_600_000).toISOString());
      await expect(insert('SENT', null)).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|23502)$/) });
      // A paper that is not the confidential letter of this very request cannot stand for one.
      await expect(insert('SENT', await paper(E1))).rejects.toMatchObject({ code: '23514' });
      // ... nor can the confidential letter of another request, or a confidential document about something else.
      const stray = randomUUID();
      const elsewhere = randomUUID();
      await harness.owner(TENANT_A, [
        [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, subject_module, subject_id, created_by, updated_by) values ($1, $2, 'REFERENCE', 'BID-CLARIFICATION', 'Letter', 'CONFIDENTIAL', 'BID_CLARIFICATION', $3, $4, $4)`, [TENANT_A, stray, randomUUID(), memberId(E1)]],
        [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, subject_module, created_by, updated_by) values ($1, $2, 'REFERENCE', 'BID-CLARIFICATION', 'Letter', 'CONFIDENTIAL', 'BID_PROPOSAL', $3, $3)`, [TENANT_A, elsewhere, memberId(E1)]],
      ]);
      await expect(insert('SENT', stray)).rejects.toMatchObject({ code: '23514' });
      await expect(insert('SENT', elsewhere)).rejects.toMatchObject({ code: '23514' });
      // The answer on the letter of another request, or after the deadline, is refused by the database too.
      const other = await send(w);
      const [late, partial, bare] = [await paper(GUEST1), await paper(GUEST1), await paper(GUEST1)];
      await expect(as((tx) => tx.query("update machvon.bid_clarification set status = 'ANSWERED', answer_document_id = $2::uuid, answered_at = now(), answered_by = $3::uuid, answered_as_guest = true where id = $1::uuid", [sent.id, other.sentDocumentId, memberId(GUEST1)]))).rejects.toThrow();
      await expect(as((tx) => tx.query("update machvon.bid_clarification set status = 'ANSWERED', answer_document_id = $2::uuid, answered_at = due_at + interval '1 minute', answered_by = $3::uuid, answered_as_guest = true where id = $1::uuid", [sent.id, late, memberId(GUEST1)]))).rejects.toMatchObject({ code: '23514' });
      // An answer says who gave it; a request that was not answered carries no part of one.
      await expect(as((tx) => tx.query("update machvon.bid_clarification set status = 'ANSWERED', answer_document_id = $2::uuid, answered_at = now() where id = $1::uuid", [sent.id, partial]))).rejects.toMatchObject({ code: '23514' });
      await expect(as((tx) => tx.query('update machvon.bid_clarification set answer_document_id = $2::uuid where id = $1::uuid', [sent.id, bare]))).rejects.toMatchObject({ code: '23514' });
      // The checks of the table hold for the owner of the schema too, whom the guard does not hold: a request nobody answered carries nothing of an answer, an answer is in time, on a paper that is not the letter, and says who gave it.
      const owner = (sql: string, ...params: unknown[]) => harness.owner(TENANT_A, [[sql, [sent.id, ...params]]]);
      const answering = "update machvon.bid_clarification set status = 'ANSWERED', answer_document_id = $2::uuid, answered_at = now(), answered_by = $3::uuid, answered_as_guest = true where id = $1::uuid";
      await expect(owner(answering, sent.sentDocumentId, memberId(GUEST1))).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.bid_clarification set status = 'ANSWERED', answer_document_id = $2::uuid, answered_at = due_at + interval '1 minute', answered_by = $3::uuid, answered_as_guest = true where id = $1::uuid", late, memberId(GUEST1))).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.bid_clarification set status = 'ANSWERED', answer_document_id = $2::uuid, answered_at = now(), answered_as_guest = true where id = $1::uuid", partial)).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.bid_clarification set status = 'ANSWERED', answer_document_id = $2::uuid, answered_at = now(), answered_by = $3::uuid where id = $1::uuid", partial, memberId(GUEST1))).rejects.toMatchObject({ code: '23514' });
      await expect(owner('update machvon.bid_clarification set answered_by = $2::uuid where id = $1::uuid', memberId(GUEST1))).rejects.toMatchObject({ code: '23514' });
      await expect(owner('update machvon.bid_clarification set answered_as_guest = true where id = $1::uuid')).rejects.toMatchObject({ code: '23514' });
      await expect(owner('update machvon.bid_clarification set sent_document_id = null where id = $1::uuid')).rejects.toMatchObject({ code: '23514' });
      expect(await stored(sent.id)).toMatchObject({ status: 'SENT', version: '1' });
    });

    it('is not deleted or truncated by anyone who is not the owner of the schema, a superuser included', async () => {
      const w = await world();
      const sent = await send(w);
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await expect(client.query('delete from machvon.bid_clarification where id = $1::uuid', [sent.id])).rejects.toMatchObject({ code: '23514' });
        await expect(client.query('truncate machvon.bid_clarification')).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.end();
      }
      expect(await stored(sent.id)).toMatchObject({ status: 'SENT' });
    });

    it('is closed to the tenants and to the runtime role for the rows of another tenant', async () => {
      const w = await world();
      const sent = await send(w);
      expect(await harness.tenants.withTenant(contextFor(TENANT_B, memberId(E1)), (tx) => tx.query('select id from machvon.bid_clarification where id = $1::uuid', [sent.id]))).toEqual([]);
    });
  });
});
