import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { CtrClaimStore } from '../src/ctr-claim-store';
import { CtrClaimTermStore } from '../src/ctr-claim-term-store';
import type { ClaimTermProposal } from '../src/ctr-claim-term-store';
import { CtrContractStore, contractScope } from '../src/ctr-contract-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { HomeContractRegisterSources } from '../src/home-contract-register-sources';
import { DEFAULT_SEVERITY_RULES } from '../src/home-work-rules';
import type { SourceContext } from '../src/home-work-sources';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedCtrWorld } from './support/ctr-fixtures';
import type { CtrWorld } from './support/ctr-fixtures';

const harness = new AuthzHarness();
const contracts = new CtrContractStore();
const terms = new CtrClaimTermStore();
const claims = new CtrClaimStore();
const sources = new HomeContractRegisterSources();
const CLERK = 1; // registers claims and proposes terms
const LEGAL = 2; // approves terms, settlements and bars
const OUTSIDER = 3; // reads nothing of this contract
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0xa8;
const NOW = new Date('2026-06-20T03:00:00Z');
const day = (offset: number): Date => new Date(NOW.getTime() + offset * 86_400_000);
const TODAY_SCOPE_NOW = new Date();

let world: CtrWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = CLERK): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
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

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
}

const grant = (permission: string, scope: Scope, member = CLERK): EffectiveAccess => ({
  membershipId: memberId(member),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const scopesFor = (scope: Scope = { kind: 'TENANT' }, member = CLERK): ContractScopes => ({
  update: contractScope(grant('claim.manage', scope, member), 'claim.manage', TODAY_SCOPE_NOW),
  read: contractScope(grant('claim.read', { kind: 'TENANT' }, member), 'claim.read', TODAY_SCOPE_NOW),
});
const readScope = (scope: Scope = { kind: 'TENANT' }) => contractScope(grant('claim.read', scope), 'claim.read', TODAY_SCOPE_NOW);

async function activeContract(): Promise<string> {
  counter += 1;
  const created = await as((tx) =>
    contracts.create(
      tx,
      { projectId: world.project, packageId: world.packageId, contractorId: world.lead, code: `HD-CL-${String(counter).padStart(3, '0')}`, title: 'Construction of the bridge', type: 'UNIT_PRICE', advanceCategory: 'CONSTRUCTION', contractValueVnd: '10000000000', documentVersionId: world.document },
      memberId(CLERK),
      '2026-05-01',
    ),
  );
  await admin([["update machvon.contract set status = 'ACTIVE', signed_on = date '2026-06-01', effective_from = date '2026-06-01' where id = $1::uuid", [created.id]]]);
  return created.id;
}

const proposal = (extra: Partial<ClaimTermProposal> = {}): ClaimTermProposal => ({ claimant_side: 'CONTRACTOR', notice_days: 28, particulars_days: 42, response_days: 14, settlement_days: 30, bar_effect: 'BARS_CLAIM', clause_reference: 'Clause 20.1 of the contract', ...extra });
const propose = (contractId: string, extra: Partial<ClaimTermProposal> = {}, member = CLERK) => as((tx) => terms.propose(tx, contractId, proposal(extra), memberId(member), scopesFor(), ), TENANT_A, member);
const decideTerm = (id: string, version: number, decision: string, member = LEGAL, note: unknown = 'Checked against the signed contract.') => as((tx) => terms.decide(tx, id, version, decision, note, memberId(member), scopesFor({ kind: 'TENANT' }, member), NOW), TENANT_A, member);
const approvedTerm = async (contractId: string, extra: Partial<ClaimTermProposal> = {}) => {
  const proposed = await propose(contractId, extra);
  return decideTerm(proposed.id, 1, 'APPROVE');
};

const newClaim = (extra: Record<string, unknown> = {}) => ({ claimantSide: 'CONTRACTOR', kind: 'EXTENSION_OF_TIME', title: 'Late handover of the site', eventDescription: 'The site was handed over twenty days late.', eventOn: '2026-06-02', awarenessOn: '2026-06-05', claimedDays: 20, claimedAmountVnd: '500000000', ...extra });
const register = (contractId: string, extra: Record<string, unknown> = {}, now = NOW, member = CLERK) => as((tx) => claims.register(tx, contractId, newClaim(extra) as never, memberId(member), scopesFor({ kind: 'TENANT' }, member), now), TENANT_A, member);
const step = (id: string, version: number, input: Record<string, unknown>, now = NOW, member = CLERK) => as((tx) => claims.recordStep(tx, id, version, input as never, memberId(member), scopesFor({ kind: 'TENANT' }, member), now), TENANT_A, member);
const settle = (id: string, version: number, decision: string, member = LEGAL, note: unknown = 'Settlement checked against the response.', now = NOW) => as((tx) => claims.decideSettlement(tx, id, version, decision, note, memberId(member), scopesFor({ kind: 'TENANT' }, member), now), TENANT_A, member);
const bar = (id: string, version: number, now: Date, member = LEGAL, reason: unknown = 'The notice was never served within the clause.') => as((tx) => claims.declareBar(tx, id, version, reason, undefined, memberId(member), scopesFor({ kind: 'TENANT' }, member), now), TENANT_A, member);
const row = async (id: string) => (await owner<Record<string, unknown>>('select * from machvon.contract_claim where id = $1::uuid', [id]))[0];
const timeline = (id: string) => owner<{ ordinal: number; kind: string; occurred_on: string }>('select ordinal, kind, occurred_on::text as occurred_on from machvon.contract_claim_step where claim_id = $1::uuid order by ordinal', [id]);
const get = (id: string, now = NOW, read = readScope()) => as((tx) => claims.get(tx, id, read, now));

async function admin(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const sourceContext = (tx: TenantTx, now: Date, member = CLERK, view: 'mine' | 'scope' = 'scope'): SourceContext => ({
  tx,
  membershipId: memberId(member),
  now,
  today: now.toISOString().slice(0, 10),
  view,
  unitScope: () => ({ sql: 'true', params: [] }),
  projectScope: () => ({ sql: 'true', params: [] }),
  rules: DEFAULT_SEVERITY_RULES,
  counting: false,
});

describe('the claim register of a contract (G1-9: limitation per contract, no default from a form)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      for (const n of [CLERK, LEGAL]) await harness.seedMembership(tenant, n, PROVINCE);
      await harness.seedMembership(tenant, OUTSIDER, OTHER_BRANCH);
    }
    world = await seedCtrWorld(harness.database.adminUrl, TENANT_A, FAMILY, CLERK, DEPARTMENT, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the term of a contract', () => {
    it('is proposed by one person and approved by another; the clause is named and nothing is a default', async () => {
      const contract = await activeContract();
      expect(await as((tx) => terms.approved(tx, contract, 'CONTRACTOR'))).toBeUndefined();
      const proposed = await propose(contract);
      expect(proposed).toMatchObject({ status: 'PROPOSED', version: 1, claimantSide: 'CONTRACTOR', supersededId: null, boundClaimIds: [] });
      expect(await refusal(decideTerm(proposed.id, 1, 'APPROVE', CLERK))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decideTerm(proposed.id, 7, 'APPROVE'))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(decideTerm(proposed.id, 1, 'REJECT', LEGAL, null))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      expect(await refusal(decideTerm(proposed.id, 1, 'MAYBE'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision' });
      const approved = await decideTerm(proposed.id, 1, 'APPROVE');
      expect(approved).toMatchObject({ status: 'APPROVED', fromStatus: 'PROPOSED', version: 2 });
      const found = await as((tx) => terms.approved(tx, contract, 'CONTRACTOR'));
      expect(found?.term).toMatchObject({ noticeDays: 28, particularsDays: 42, responseDays: 14, settlementDays: 30, basis: 'CALENDAR_DAYS', barEffect: 'BARS_CLAIM', clauseReference: 'Clause 20.1 of the contract' });
      expect(found).toMatchObject({ proposedBy: memberId(CLERK), decidedBy: memberId(LEGAL) });
      // The other side of the same contract has none.
      expect(await as((tx) => terms.approved(tx, contract, 'OWNER'))).toBeUndefined();
    });

    it('allows one proposal per side at a time, supersedes the term in force when a new one is approved, and refuses a term it cannot understand', async () => {
      const contract = await activeContract();
      const first = await approvedTerm(contract);
      const second = await propose(contract, { notice_days: 14, particulars_days: undefined });
      expect(await refusal(propose(contract, { notice_days: 10 }))).toEqual({ code: 'CLAIM_TERM_PENDING', status: 409, detail: 'claimant_side' });
      // Another side is not in the way.
      await propose(contract, { claimant_side: 'OWNER', clause_reference: 'Clause 8.2 of the contract' });
      const approved = await decideTerm(second.id, 1, 'APPROVE');
      expect(approved.supersededId).toBe(first.id);
      const history = await as((tx) => terms.list(tx, contract, scopesFor()));
      expect(history.filter((entry) => entry.term.claimantSide === 'CONTRACTOR').map((entry) => entry.status).sort()).toEqual(['APPROVED', 'SUPERSEDED']);
      expect((await as((tx) => terms.approved(tx, contract, 'CONTRACTOR')))?.id).toBe(second.id);
      expect(await refusal(propose(contract, { claimant_side: 'OWNER', notice_days: 0 }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'notice_days' });
      expect(await refusal(propose(contract, { claimant_side: 'OWNER', notice_days: undefined, particulars_days: undefined, response_days: undefined, settlement_days: undefined }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(propose(contract, { claimant_side: 'OWNER', basisDocumentVersionId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'basis_document_version_id' });
    });

    it('keeps a term as it was written: the database refuses to edit it, to approve it by its proposer or to skip a state', async () => {
      const contract = await activeContract();
      const proposed = await propose(contract);
      expect(await databaseRefusal(owner('update machvon.contract_claim_term set notice_days = 99 where id = $1::uuid', [proposed.id]))).toBe('23514');
      expect(await databaseRefusal(owner("update machvon.contract_claim_term set status = 'APPROVED', decided_by = proposed_by, decided_at = now() where id = $1::uuid", [proposed.id]))).toBe('23514');
      expect(await databaseRefusal(owner("update machvon.contract_claim_term set status = 'SUPERSEDED' where id = $1::uuid", [proposed.id]))).toBe('23514');
    });

    it('is kept out of reach of a caller who cannot see the contract, and of a caller who can only read it', async () => {
      const contract = await activeContract();
      const outside = scopesFor({ kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] }, OUTSIDER);
      expect(await refusal(as((tx) => terms.propose(tx, contract, proposal(), memberId(OUTSIDER), { update: outside.update, read: readScope({ kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] }) }), TENANT_A, OUTSIDER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => terms.propose(tx, randomUUID(), proposal(), memberId(CLERK), scopesFor())))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => terms.list(tx, contract, scopesFor()), TENANT_B, CLERK))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('a claim', () => {
    it('is registered with the day of awareness, numbered per contract, with the event as the first step; without a term it has no clock', async () => {
      const contract = await activeContract();
      const first = await register(contract);
      const second = await register(contract, { claimantSide: 'OWNER', kind: 'DELAY_DAMAGES', title: 'Delay of the foundation works' });
      expect([first.code, second.code]).toEqual(['CLM-001', 'CLM-002']);
      expect(first).toMatchObject({ status: 'EVENT_RECORDED', version: 1, termId: null, step: 'EVENT', stepOrdinal: 1, claimedAmountVnd: '500000000', claimedDays: 20 });
      expect(await row(first.id)).toMatchObject({ registered_by: memberId(CLERK), responsible_membership_id: memberId(CLERK), step_count: 1 });
      expect(await timeline(first.id)).toEqual([{ ordinal: 1, kind: 'EVENT', occurred_on: '2026-06-05' }]);
      const detail = await get(first.id, day(40));
      expect(detail.term).toBeNull();
      expect(detail.limitation).toMatchObject({ status: 'NO_TERM', dueOn: null });
      expect(detail.deadlines.NOTICE).toMatchObject({ state: 'NOT_DEFINED', dueOn: null });
      expect(detail.allowed).toEqual({ steps: ['NOTICE', 'WITHDRAWAL'], decideSettlement: false, declareBar: false });
    });

    it('binds the approved term of its side at registration, and the approval of a term binds the open claims that had none, with a step each', async () => {
      const contract = await activeContract();
      const early = await register(contract);
      const done = await register(contract, { title: 'A claim that was withdrawn before the term' });
      await step(done.id, 1, { kind: 'WITHDRAWAL', occurredOn: '2026-06-10', note: 'Withdrawn by the contractor.' });
      const approved = await approvedTerm(contract);
      expect(approved.boundClaimIds).toEqual([early.id]);
      expect((await row(early.id))?.term_id).toBe(approved.id);
      expect((await row(done.id))?.term_id).toBeNull();
      expect((await timeline(early.id)).map((entry) => entry.kind)).toEqual(['EVENT', 'TERM_BOUND']);
      expect(Number((await row(early.id))?.version)).toBe(2);
      const later = await register(contract, { title: 'A claim registered after the term' });
      expect(later.termId).toBe(approved.id);
    });

    it('counts the limits from the day of awareness: running, approaching, missed, and met by the day the notice was served', async () => {
      const contract = await activeContract();
      const term = await approvedTerm(contract);
      const claim = await register(contract);
      const at = (offset: number) => get(claim.id, day(offset));
      // Awareness 2026-06-05, notice limit 28 days: 2026-07-03.
      expect((await at(0)).limitation).toMatchObject({ status: 'RUNNING', dueOn: '2026-07-03', code: 'NOTICE' });
      expect((await at(10)).limitation).toMatchObject({ status: 'APPROACHING', daysLeft: 3 });
      expect((await at(14)).limitation).toMatchObject({ status: 'MISSED', missed: ['NOTICE'] });
      expect((await at(14)).allowed.declareBar).toBe(true);
      const served = await step(claim.id, 1, { kind: 'NOTICE', occurredOn: '2026-07-01', note: 'Notice served by registered letter.' }, day(12));
      expect(served).toMatchObject({ status: 'NOTICE_SERVED', fromStatus: 'EVENT_RECORDED', step: 'NOTICE', stepOrdinal: 2, version: 2 });
      expect((await get(claim.id, day(14))).deadlines.NOTICE).toMatchObject({ state: 'MET', doneOn: '2026-07-01' });
      expect((await get(claim.id, day(14))).deadlines.PARTICULARS).toMatchObject({ state: 'RUNNING', startedOn: '2026-07-01', dueOn: '2026-08-12' });
      expect(term.id).toBeDefined();
    });

    it('walks notice, particulars, response, settlement proposal and approval, and settles only by somebody other than the proposer', async () => {
      const contract = await activeContract();
      await approvedTerm(contract);
      const claim = await register(contract);
      await step(claim.id, 1, { kind: 'NOTICE', occurredOn: '2026-06-08', note: 'Notice served by registered letter.' });
      await step(claim.id, 2, { kind: 'PARTICULARS', occurredOn: '2026-06-12', note: 'Fully detailed claim with the programme.', claimedAmountVnd: '400000000', claimedDays: 15 });
      expect(await row(claim.id)).toMatchObject({ claimed_amount_vnd: '400000000', claimed_days: 15, particulars_on: expect.anything() });
      await step(claim.id, 3, { kind: 'RESPONSE', occurredOn: '2026-06-15', note: 'The engineer accepted the claim in part.', decision: 'PARTLY_ACCEPTED' });
      const proposed = await step(claim.id, 4, { kind: 'SETTLEMENT_PROPOSAL', occurredOn: '2026-06-18', note: 'Agreed in the meeting of the 18th.', settledAmountVnd: '300000000', grantedDays: 10 });
      expect(proposed).toMatchObject({ status: 'SETTLEMENT_PROPOSED', settledAmountVnd: '300000000', grantedDays: 10, version: 5 });
      expect(await refusal(settle(claim.id, 5, 'APPROVE', CLERK))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await row(claim.id)).toMatchObject({ status: 'SETTLEMENT_PROPOSED' });
      const settled = await settle(claim.id, 5, 'APPROVE');
      expect(settled).toMatchObject({ status: 'SETTLED', fromStatus: 'SETTLEMENT_PROPOSED', step: 'SETTLEMENT_APPROVED', settledAmountVnd: '300000000', grantedDays: 10 });
      const final = await row(claim.id);
      expect(final).toMatchObject({ status: 'SETTLED', settlement_approved_by: memberId(LEGAL), settlement_proposed_by: memberId(CLERK), step_count: 6 });
      expect(final?.settled_on).not.toBeNull();
      expect((await timeline(claim.id)).map((entry) => entry.kind)).toEqual(['EVENT', 'NOTICE', 'PARTICULARS', 'RESPONSE', 'SETTLEMENT_PROPOSAL', 'SETTLEMENT_APPROVED']);
      // Nothing moves a claim that ended, and the database keeps a settlement from being rewritten.
      expect(await refusal(step(claim.id, 6, { kind: 'WITHDRAWAL', occurredOn: '2026-06-19', note: 'Too late to withdraw.' }))).toMatchObject({ code: 'CTR_CLAIM_STATE_INVALID', status: 409 });
      expect(await databaseRefusal(owner('update machvon.contract_claim set settled_amount_vnd = 1 where id = $1::uuid', [claim.id]))).toBe('23514');
      expect(await databaseRefusal(owner('update machvon.contract_claim_step set note = $2 where claim_id = $1::uuid', [claim.id, 'rewritten history']))).toBe('23514');
    });

    it('sends a rejected settlement back to the response with words, and asks for the words', async () => {
      const contract = await activeContract();
      const claim = await register(contract);
      await step(claim.id, 1, { kind: 'NOTICE', occurredOn: '2026-06-08', note: 'Notice served by registered letter.' });
      await step(claim.id, 2, { kind: 'RESPONSE', occurredOn: '2026-06-10', note: 'The engineer accepted the claim.', decision: 'ACCEPTED' });
      await step(claim.id, 3, { kind: 'SETTLEMENT_PROPOSAL', occurredOn: '2026-06-11', note: 'Proposed settlement from the meeting.', settledAmountVnd: '100', grantedDays: 1 });
      expect(await refusal(settle(claim.id, 4, 'REJECT', LEGAL, null))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      const rejected = await settle(claim.id, 4, 'REJECT', LEGAL, 'The amount does not match the response.');
      expect(rejected).toMatchObject({ status: 'RESPONDED', settledAmountVnd: null, grantedDays: null });
      expect(await row(claim.id)).toMatchObject({ status: 'RESPONDED', settled_amount_vnd: null, settlement_proposed_by: null });
      // The same person may propose again; a different one approves.
      await step(claim.id, 5, { kind: 'SETTLEMENT_PROPOSAL', occurredOn: '2026-06-20', note: 'A new proposal after the review.', settledAmountVnd: '90', grantedDays: 1 });
      expect((await settle(claim.id, 6, 'APPROVE')).status).toBe('SETTLED');
    });

    it('refuses a stale version, a step out of order, a day before the latest step, a settlement above the claim and a step on another state', async () => {
      const contract = await activeContract();
      const claim = await register(contract);
      expect(await refusal(step(claim.id, 9, { kind: 'NOTICE', occurredOn: '2026-06-08', note: 'Notice served by registered letter.' }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(step(claim.id, 1, { kind: 'PARTICULARS', occurredOn: '2026-06-08', note: 'Particulars before the notice.' }))).toMatchObject({ code: 'CTR_CLAIM_STATE_INVALID', status: 409 });
      expect(await refusal(step(claim.id, 1, { kind: 'NOTICE', occurredOn: '2026-06-04', note: 'Notice dated before the awareness.' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'occurred_on' });
      expect(await refusal(step(claim.id, 1, { kind: 'NOTICE', occurredOn: '2026-06-30', note: 'Notice dated in the future.' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'occurred_on' });
      await step(claim.id, 1, { kind: 'NOTICE', occurredOn: '2026-06-10', note: 'Notice served by registered letter.' });
      expect(await refusal(step(claim.id, 2, { kind: 'RESPONSE', occurredOn: '2026-06-09', note: 'A response dated before the notice.', decision: 'ACCEPTED' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'occurred_on' });
      await step(claim.id, 2, { kind: 'RESPONSE', occurredOn: '2026-06-12', note: 'The engineer accepted the claim.', decision: 'ACCEPTED' });
      expect(await refusal(step(claim.id, 3, { kind: 'SETTLEMENT_PROPOSAL', occurredOn: '2026-06-13', note: 'More than was ever asked for.', settledAmountVnd: '500000001', grantedDays: 1 }))).toEqual({ code: 'CLAIM_SETTLEMENT_EXCEEDS_CLAIM', status: 422, detail: 'settled_amount_vnd' });
      expect(await refusal(step(claim.id, 3, { kind: 'SETTLEMENT_PROPOSAL', occurredOn: '2026-06-13', note: 'More days than were asked for.', settledAmountVnd: '1', grantedDays: 21 }))).toEqual({ code: 'CLAIM_SETTLEMENT_EXCEEDS_CLAIM', status: 422, detail: 'granted_days' });
      expect(await row(claim.id)).toMatchObject({ status: 'RESPONDED', version: '3' });
      expect(await refusal(settle(claim.id, 3, 'APPROVE'))).toMatchObject({ code: 'CTR_CLAIM_STATE_INVALID', status: 409 });
    });

    it('declares a claim barred only when a limitation day passed, the term says that bars it, and by somebody other than the registrant', async () => {
      const contract = await activeContract();
      const claim = await register(contract, {}, NOW);
      // No term: no bar.
      expect(await refusal(bar(claim.id, 1, day(60)))).toEqual({ code: 'CLAIM_BAR_NOT_DUE', status: 409, detail: 'limitation' });
      await approvedTerm(contract);
      expect((await row(claim.id))?.version).toBe('2');
      // Before the day: nothing missed.
      expect(await refusal(bar(claim.id, 2, day(5)))).toEqual({ code: 'CLAIM_BAR_NOT_DUE', status: 409, detail: 'limitation' });
      // After the day, by the registrant: refused by the four-eyes rule.
      expect(await refusal(bar(claim.id, 2, day(30), CLERK))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(bar(claim.id, 2, day(30), LEGAL, 'no'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      const barred = await bar(claim.id, 2, day(30));
      expect(barred).toMatchObject({ status: 'TIME_BARRED', fromStatus: 'EVENT_RECORDED', step: 'BAR_DECLARED' });
      expect(await row(claim.id)).toMatchObject({ status: 'TIME_BARRED', closed_by: memberId(LEGAL) });
      expect((await get(claim.id, day(31))).limitation.status).toBe('BARRED');
      expect(await databaseRefusal(owner("update machvon.contract_claim set status = 'TIME_BARRED', closed_on = date '2026-07-30', closed_by = registered_by where id = $1::uuid", [(await register(contract)).id]))).toBe('23514');
    });

    it('does not declare a bar when the clause only reduces the relief, or says nothing of the effect', async () => {
      const contract = await activeContract();
      await approvedTerm(contract, { bar_effect: 'NOT_STATED' });
      const claim = await register(contract);
      const detail = await get(claim.id, day(30));
      expect(detail.limitation).toMatchObject({ status: 'MISSED', barEffect: 'NOT_STATED' });
      expect(detail.allowed.declareBar).toBe(false);
      expect(await refusal(bar(claim.id, 1, day(30)))).toEqual({ code: 'CLAIM_BAR_NOT_DUE', status: 409, detail: 'bar_effect' });
    });

    it('links a change order and a payment request of the same contract, never of another, and keeps the links when the claim ends', async () => {
      const contract = await activeContract();
      const other = await activeContract();
      const claim = await register(contract);
      const own = { change: randomUUID(), payment: randomUUID(), otherChange: randomUUID() };
      const revision = randomUUID();
      await admin([
        [`insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, submitted_by, created_by, updated_by) values ($1, $2, $3, $4, 0, 5, 'Reason', 'SUBMITTED', 1, 'CR-GOV8-1', 'CO', $5, $5, $5), ($1, $6, $7, $4, 0, 5, 'Reason', 'SUBMITTED', 1, 'CR-GOV8-2', 'CO', $5, $5, $5)`, [TENANT_A, own.change, contract, revision, memberId(CLERK), own.otherChange, other]],
        [`insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, claims_acceptance, request_no) values ($1, $2, $3, $4, gen_random_uuid(), 'VND', 300, 0, 0, 0, 300, 'SUBMITTED', 1, true, 'DNTT-GOV8-1')`, [TENANT_A, own.payment, world.project, contract]],
      ]);
      expect(await refusal(as((tx) => claims.link(tx, claim.id, 1, { changeRequestId: own.otherChange }, scopesFor())))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'change_request_id' });
      expect(await refusal(as((tx) => claims.link(tx, claim.id, 1, {}, scopesFor())))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(as((tx) => claims.link(tx, claim.id, 1, { paymentRequestId: randomUUID() }, scopesFor())))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'payment_request_id' });
      const linked = await as((tx) => claims.link(tx, claim.id, 1, { changeRequestId: own.change, paymentRequestId: own.payment }, scopesFor()));
      expect(linked).toMatchObject({ version: 2, step: null });
      const detail = await get(claim.id);
      expect(detail.row).toMatchObject({ changeRequestId: own.change, changeRequestCode: 'CR-GOV8-1', paymentRequestId: own.payment });
      expect(detail.payment).toEqual({ id: own.payment, status: 'SUBMITTED', grossVnd: '300', netVnd: '300' });
      await step(claim.id, 2, { kind: 'WITHDRAWAL', occurredOn: '2026-06-10', note: 'Withdrawn by the contractor.' });
      expect((await get(claim.id)).row.changeRequestId).toBe(own.change);
    });
  });

  describe('the register and the reports', () => {
    it('lists the claims of a filter with their limitation on the day, adds them up and pages by the same order', async () => {
      const contract = await activeContract();
      await approvedTerm(contract);
      const a = await register(contract, { title: 'Claim A: late handover' });
      const b = await register(contract, { title: 'Claim B: design change', awarenessOn: '2026-06-19' });
      await step(b.id, 1, { kind: 'WITHDRAWAL', occurredOn: '2026-06-19', note: 'Withdrawn by the contractor.' });
      const page = await as((tx) => claims.list(tx, { contractId: contract }, readScope(), { limit: 1 }, day(20)));
      expect(page.totals).toMatchObject({ count: 2, open: 1, withoutTerm: 0, claimedVnd: '1000000000', openClaimedVnd: '500000000', byLimitation: { MISSED: 1, CLOSED: 1 } });
      expect(page.rows).toHaveLength(1);
      expect(page.nextCursor).toBe(page.rows[0]?.id);
      expect(page.policy).toMatchObject({ source: 'DEFAULT', unverified: true });
      const next = await as((tx) => claims.list(tx, { contractId: contract }, readScope(), { limit: 5, after: page.nextCursor ?? undefined }, day(20)));
      expect(next.rows).toHaveLength(1);
      expect(next.nextCursor).toBeNull();
      expect([page.rows[0]?.id, next.rows[0]?.id].sort()).toEqual([a.id, b.id].sort());
      const missed = await as((tx) => claims.list(tx, { contractId: contract, limitation: 'MISSED' }, readScope(), { limit: 5 }, day(20)));
      expect(missed.rows.map((entry) => entry.id)).toEqual([a.id]);
      expect(missed.totals.count).toBe(2);
      const open = await as((tx) => claims.list(tx, { contractId: contract, open: true, claimantSide: 'CONTRACTOR' }, readScope(), { limit: 5 }, day(20)));
      expect(open.rows.map((entry) => entry.id)).toEqual([a.id]);
    });

    it('gives the reports the inputs of every claim in scope and nothing of another tenant or of a contract outside the scope', async () => {
      const contract = await activeContract();
      await register(contract);
      const inputs = await as((tx) => claims.reportInputs(tx, { contractId: contract }, readScope()));
      expect(inputs.inputs).toHaveLength(1);
      expect(inputs.inputs[0]).toMatchObject({ contractCode: expect.stringMatching(/^HD-CL-/), kind: 'EXTENSION_OF_TIME', claimedAmountVnd: '500000000', term: null });
      expect((await as((tx) => claims.reportInputs(tx, {}, readScope()), TENANT_B)).inputs).toEqual([]);
      const outside = await as((tx) => claims.reportInputs(tx, { contractId: contract }, readScope({ kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] })));
      expect(outside.inputs).toEqual([]);
      await expect(as((tx) => claims.get(tx, randomUUID(), readScope(), NOW))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('refuses a command on a claim of a contract the caller can read but not change, and hides a claim from another tenant', async () => {
      const contract = await activeContract();
      const claim = await register(contract);
      const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: readScope() };
      expect(await refusal(as((tx) => claims.recordStep(tx, claim.id, 1, { kind: 'NOTICE', occurredOn: '2026-06-08', note: 'Notice served by registered letter.' } as never, memberId(CLERK), readOnly, NOW)))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => claims.recordStep(tx, claim.id, 1, { kind: 'NOTICE', occurredOn: '2026-06-08', note: 'Notice served by registered letter.' } as never, memberId(CLERK), scopesFor(), NOW), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await row(claim.id)).toMatchObject({ status: 'EVENT_RECORDED', version: '1' });
    });
  });

  describe('the alert centre (the alerts CLAIM_*)', () => {
    it('shows the most pressing alert of a claim with a term, with its type, severity and consequence, and nothing for a claim without a term or one that ended', async () => {
      const contract = await activeContract();
      const noTerm = await register(contract, { title: 'A claim with no term yet' });
      const none = await as((tx) => sources.claims(sourceContext(tx, day(60))));
      expect(none.find((item) => item.id === noTerm.id)).toBeUndefined();
      await approvedTerm(contract);
      const claim = await register(contract, { title: 'A claim whose notice day passes' });
      // Awareness 2026-06-05: the contractor's notice day is 2026-07-03. Before the approaching window: nothing; the contractor owes it, so no early warning either; after the day: a decision for the owner.
      expect((await as((tx) => sources.claims(sourceContext(tx, day(12))))).find((item) => item.id === claim.id)).toBeUndefined();
      const missed = (await as((tx) => sources.claims(sourceContext(tx, day(14))))).find((item) => item.id === claim.id);
      expect(missed).toMatchObject({ kind: 'CLAIM_LIMITATION_MISSED', source: 'CONTRACT_CLAIM', severity: 'ACTION', status: 'MISSED', dueOn: '2026-07-03', target: { screen: 'CTR-33', id: claim.id }, lifecycle: 'NEW' });
      expect(missed?.consequence).toContain('lơ lửng');
      expect(missed?.startedAt).toBe('2026-07-03T17:00:00.000Z');
      const mine = await as((tx) => sources.claims(sourceContext(tx, day(14), CLERK, 'mine')));
      expect(mine.find((item) => item.id === claim.id)).toBeDefined();
      expect((await as((tx) => sources.claims(sourceContext(tx, day(14), LEGAL, 'mine')))).find((item) => item.id === claim.id)).toBeUndefined();
      await step(claim.id, 1, { kind: 'WITHDRAWAL', occurredOn: '2026-06-20', note: 'Withdrawn by the contractor.' });
      expect((await as((tx) => sources.claims(sourceContext(tx, day(14))))).find((item) => item.id === claim.id)).toBeUndefined();
    });

    it('raises a response overdue as urgent for a contractor claim, and a limitation day approaching only for the claim of the owner', async () => {
      const contract = await activeContract();
      await approvedTerm(contract);
      await approvedTerm(contract, { claimant_side: 'OWNER', clause_reference: 'Clause 8.2 of the contract', particulars_days: undefined, response_days: undefined, settlement_days: undefined });
      const contractor = await register(contract, { title: 'A contractor claim to answer' });
      await step(contractor.id, 1, { kind: 'NOTICE', occurredOn: '2026-06-06', note: 'Notice served by registered letter.' });
      await step(contractor.id, 2, { kind: 'PARTICULARS', occurredOn: '2026-06-10', note: 'Fully detailed claim with the programme.' });
      const own = await register(contract, { claimantSide: 'OWNER', kind: 'DELAY_DAMAGES', title: 'Our claim for delay damages' });
      const items = await as((tx) => sources.claims(sourceContext(tx, day(20))));
      // Response due 2026-06-24 (14 days after the particulars of 2026-06-10): on 2026-07-10 it is overdue.
      expect(items.find((item) => item.id === contractor.id)).toMatchObject({ kind: 'CLAIM_RESPONSE_DUE', severity: 'URGENT', status: 'OVERDUE' });
      // The owner's own notice day is 2026-07-03: on 2026-06-30 it is approaching (ACTION), on 2026-07-10 it is missed and urgent.
      const approaching = (await as((tx) => sources.claims(sourceContext(tx, day(10))))).find((item) => item.id === own.id);
      expect(approaching).toMatchObject({ kind: 'CLAIM_LIMITATION_APPROACHING', severity: 'ACTION' });
      expect(items.find((item) => item.id === own.id)).toMatchObject({ kind: 'CLAIM_LIMITATION_MISSED', severity: 'URGENT' });
    });
  });
});
