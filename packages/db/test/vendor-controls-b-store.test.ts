import { randomUUID } from 'node:crypto';
import { VendorPackageControlStore } from '../src/vendor-package-control-store';
import { VendorSecurityGate, VendorSecurityStore, securityForfeitCount, securityFigures } from '../src/vendor-security-store';
import { VendorSubcontractStore, subcontractBreachCount, subcontractFigures } from '../src/vendor-subcontract-store';
import type { TenantTx } from '../src/tenant-database';
import { betaVendorAlerts } from '../src/home-vendor-beta-sources';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';
import { seedAs, seedBidPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const securities = new VendorSecurityStore();
const subcontracts = new VendorSubcontractStore();
const controls = new VendorPackageControlStore();
const gate = new VendorSecurityGate();

const [M1, M2, M3] = [1, 2, 3];
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = M1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
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

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the database to refuse');
};

async function document(): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)`,
    [TENANT_A, id, memberId(M1)],
  );
  return id;
}

let counter = 0;
async function contractor(name: string): Promise<string> {
  counter += 1;
  const id = randomUUID();
  const profile = await document();
  await owner(
    `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis)
     values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, $8, $9, 'EVIDENCE_DOCUMENT')`,
    [TENANT_A, id, `07${String(counter).padStart(8, '0')}`, name, profile, memberId(M1), memberId(M2), new Date().toISOString(), await document()],
  );
  return id;
}

/** A contract of 10,000,000 for the package, with its revision and its sole party. */
async function contract(packageId: string, projectId: string, contractorId: string): Promise<string> {
  counter += 1;
  const id = randomUUID();
  const revision = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by, signed_on, effective_from, current_revision_id)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'OTHER', false, false, 10000000, $7, $7, date '2026-01-01', date '2026-01-02', $8)`,
      [TENANT_A, id, projectId, packageId, contractorId, `HD-B-${counter}`, memberId(M1), revision],
    ],
    [
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 10000000, $4, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $5, $5, $5, now())`,
      [TENANT_A, revision, id, randomUUID(), memberId(M1)],
    ],
    [
      `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, $3, 'SOLE', 100, 10000000, 'ACTIVE', date '2026-01-02', $4, $4)`,
      [TENANT_A, id, contractorId, memberId(M1)],
    ],
  ]);
  return id;
}

async function settledRequest(contractId: string, projectId: string, paidOn: string): Promise<string> {
  const id = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, claims_acceptance, treasury_paid_on, settled_transaction_id, settled_by, settled_at)
       values ($1, $2, $3, $4, $5, 'VND', 1000, 0, 0, 0, 1000, 'SETTLED', 1, true, $6::date, $7, $8, now())`,
      [TENANT_A, id, projectId, contractId, randomUUID(), paidOn, randomUUID(), memberId(M1)],
    ],
  ]);
  return id;
}

const NOW = new Date('2026-11-09T03:00:00Z');
const TODAY = '2026-11-09';

describe('the bid security register and the subcontracts (VND-2, V10 and V11)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    for (const member of [M1, M2, M3]) await harness.seedMembership(TENANT_A, member, 1);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the bid security', () => {
    it('receives, confirms by another person once, and judges what was lodged against the amount the package asks', async () => {
      const bid = await seedBidPackage(harness);
      const firm = await contractor('Cty Security A');
      await as((tx) => controls.set(tx, bid.packageId, { securityBaseAmount: 1000, bidValidUntil: '2026-12-31' }, memberId(M1)));
      const received = await as((tx) => securities.receive(tx, { packageId: bid.packageId, contractorId: firm, kind: 'BANK_GUARANTEE', issuer: 'Vietcombank', securityNo: 'BL-001', amount: 1000, issuedOn: '2026-11-01', validUntil: '2027-02-01' }, memberId(M1), NOW));
      expect(received).toMatchObject({ state: 'RECEIVED', requiredAmount: 1000, factorApplied: 1, version: 1, confirmedBy: null });
      expect((await as((tx) => securities.standing(tx, bid.packageId, firm, TODAY)))?.assessment).toMatchObject({ satisfied: false, gaps: ['NOT_CONFIRMED'], enforcement: 'BLOCK' });
      expect(await refusal(as((tx) => gate.assertAllowed(tx, { packageId: bid.packageId, contractorId: firm, today: TODAY })))).toMatchObject({ code: 'BID_SECURITY_NOT_VALID', status: 422, extensions: { gaps: ['NOT_CONFIRMED'] } });
      expect((await refusal(as((tx) => securities.confirm(tx, received.id, 1, 'VCB-REF-77', memberId(M1), NOW)))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await refusal(as((tx) => securities.confirm(tx, received.id, 5, 'VCB-REF-77', memberId(M2), NOW), M2))).code).toBe('VERSION_CONFLICT');
      const confirmed = await as((tx) => securities.confirm(tx, received.id, 1, 'VCB-REF-77', memberId(M2), NOW), M2);
      expect(confirmed).toMatchObject({ state: 'CONFIRMED', confirmedBy: memberId(M2), issuerReference: 'VCB-REF-77', version: 2 });
      expect((await refusal(as((tx) => securities.confirm(tx, received.id, 2, 'VCB-REF-78', memberId(M3), NOW), M3))).code).toBe('STAGE_TRANSITION_DENIED');
      expect((await as((tx) => securities.standing(tx, bid.packageId, firm, TODAY)))?.assessment).toMatchObject({ satisfied: true, enforcement: 'NONE' });
      await as((tx) => gate.assertAllowed(tx, { packageId: bid.packageId, contractorId: firm, today: TODAY }));
      expect((await as((tx) => securities.events(tx, received.id))).map((one) => one.move)).toEqual(['RECEIVE', 'CONFIRM']);
      expect(await databaseRefusal(owner('update machvon.vendor_bid_security set amount = 5 where id = $1', [received.id]))).toMatch(/not rewritten/);
      expect(await databaseRefusal(owner('delete from machvon.vendor_bid_security_event where security_id = $1', [received.id]))).toMatch(/append-only|never deleted|permission/);
      expect(await databaseRefusal(owner('update machvon.vendor_bid_security_event set note = $2 where security_id = $1', [received.id, 'x']))).toMatch(/append-only/);
    });

    it('asks no security of a package that sets none and three times the amount of a contractor with a posted event', async () => {
      const bid = await seedBidPackage(harness);
      const firm = await contractor('Cty Security Factor');
      await as((tx) => gate.assertAllowed(tx, { packageId: bid.packageId, contractorId: firm, today: TODAY }));
      expect(await as((tx) => securities.standing(tx, bid.packageId, firm, TODAY))).toBeNull();
      await as((tx) => controls.set(tx, bid.packageId, { securityBaseAmount: 1000, bidValidUntil: '2026-12-31' }, memberId(M1)));
      await owner(
        `insert into machvon.contractor_reputation_event (tenant_id, id, contractor_id, behaviour_code, event_on, description, status, recorded_by, post_due_at, deadline_policy_version, posted_by, posted_at, posting_ref)
         values ($1, gen_random_uuid(), $2, 'WITHDRAWING_AFTER_CLOSING', date '2026-03-01', 'Withdrew the bid after the closing', 'POSTED', $3, now(), 'builtin', $4, '2026-03-05T03:00:00Z', 'BN-001')`,
        [TENANT_A, firm, memberId(M1), memberId(M2)],
      );
      const required = await as((tx) => securities.requiredFor(tx, bid.packageId, firm, TODAY));
      expect(required).toMatchObject({ amount: 3000, factor: 3, mustHoldUntil: '2027-01-30' });
      const low = await as((tx) => securities.receive(tx, { packageId: bid.packageId, contractorId: firm, kind: 'BANK_GUARANTEE', issuer: 'Agribank', securityNo: 'BL-LOW', amount: 1000, issuedOn: '2026-11-01', validUntil: '2027-03-01' }, memberId(M1), NOW));
      expect(low).toMatchObject({ requiredAmount: 3000, factorApplied: 3 });
      await as((tx) => securities.confirm(tx, low.id, 1, 'AGR-REF-1', memberId(M2), NOW), M2);
      expect(await refusal(as((tx) => gate.assertAllowed(tx, { packageId: bid.packageId, contractorId: firm, today: TODAY })))).toMatchObject({ code: 'BID_SECURITY_NOT_VALID', extensions: { gaps: ['AMOUNT_BELOW'], shortfall: 2000, factor: 3 } });
      const enough = await as((tx) => securities.receive(tx, { packageId: bid.packageId, contractorId: firm, kind: 'CASH_DEPOSIT', issuer: 'Treasury', securityNo: 'CD-1', amount: 3000, issuedOn: '2026-11-01', validUntil: '2027-03-01' }, memberId(M1), NOW));
      await as((tx) => securities.confirm(tx, enough.id, 1, 'TRE-REF-1', memberId(M2), NOW), M2);
      await as((tx) => gate.assertAllowed(tx, { packageId: bid.packageId, contractorId: firm, today: TODAY }));
    });

    it('moves a forfeiture through a proposal and the decision of another person on a paper, and keeps it final', async () => {
      const bid = await seedBidPackage(harness);
      const firm = await contractor('Cty Security Forfeit');
      const received = await as((tx) => securities.receive(tx, { packageId: bid.packageId, contractorId: firm, kind: 'INSURANCE_BOND', issuer: 'Bao Viet', securityNo: 'BV-9', amount: 500, issuedOn: '2026-11-01', validUntil: '2027-02-01' }, memberId(M1), NOW));
      const confirmed = await as((tx) => securities.confirm(tx, received.id, 1, 'BV-REF-9', memberId(M2), NOW), M2);
      expect((await refusal(as((tx) => securities.proposeForfeiture(tx, confirmed.id, 2, 'BECAUSE', 'The winner refused to sign the contract', memberId(M1), NOW)))).detail).toBe('reason_code');
      expect((await refusal(as((tx) => securities.proposeForfeiture(tx, confirmed.id, 2, 'REFUSED_TO_SIGN', 'short', memberId(M1), NOW)))).code).toBe('REASON_REQUIRED');
      const proposed = await as((tx) => securities.proposeForfeiture(tx, confirmed.id, 2, 'REFUSED_TO_SIGN', 'The winner refused to sign the contract in the window', memberId(M1), NOW));
      expect(proposed).toMatchObject({ state: 'FORFEIT_PROPOSED', forfeitProposedBy: memberId(M1), forfeitReasonCode: 'REFUSED_TO_SIGN' });
      const decision = await document();
      expect((await refusal(as((tx) => securities.decideForfeiture(tx, proposed.id, 3, { decision: 'FORFEIT', reason: 'The decision of the head of the board', decisionDocumentId: decision }, memberId(M1), NOW)))).code).toBe('SELF_APPROVAL_DENIED');
      expect(await refusal(as((tx) => securities.decideForfeiture(tx, proposed.id, 3, { decision: 'FORFEIT', reason: 'The decision of the head of the board' }, memberId(M2), NOW), M2))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      const refused = await as((tx) => securities.decideForfeiture(tx, proposed.id, 3, { decision: 'REFUSE', reason: 'The winner signed on the last day, no forfeiture' }, memberId(M2), NOW), M2);
      expect(refused).toMatchObject({ state: 'CONFIRMED', forfeitDecidedBy: null });
      const again = await as((tx) => securities.proposeForfeiture(tx, refused.id, 4, 'NO_PERFORMANCE_SECURITY', 'No performance security was lodged in 28 days', memberId(M1), NOW));
      const withdrawn = await as((tx) => securities.withdrawForfeiture(tx, again.id, 5, memberId(M1), NOW));
      expect(withdrawn.state).toBe('CONFIRMED');
      const third = await as((tx) => securities.proposeForfeiture(tx, withdrawn.id, 6, 'NO_PERFORMANCE_SECURITY', 'No performance security was lodged in 28 days', memberId(M1), NOW));
      const forfeited = await as((tx) => securities.decideForfeiture(tx, third.id, 7, { decision: 'FORFEIT', reason: 'Confirmed against the contract file by the board', decisionDocumentId: decision }, memberId(M2), NOW), M2);
      expect(forfeited).toMatchObject({ state: 'FORFEITED', forfeitDecidedBy: memberId(M2), forfeitDecisionDocumentId: decision, conductBehaviour: 'NO_PERFORMANCE_SECURITY' });
      expect((await refusal(as((tx) => securities.release(tx, forfeited.id, forfeited.version, 'Released by mistake', false, memberId(M1), NOW)))).code).toBe('STAGE_TRANSITION_DENIED');
      expect(await databaseRefusal(owner("update machvon.vendor_bid_security set state = 'CONFIRMED' where id = $1", [forfeited.id]))).toMatch(/stays so/);
      expect((await as((tx) => securities.events(tx, forfeited.id))).map((one) => one.move)).toEqual(['RECEIVE', 'CONFIRM', 'PROPOSE_FORFEIT', 'REFUSE_FORFEIT', 'PROPOSE_FORFEIT', 'WITHDRAW_FORFEIT', 'PROPOSE_FORFEIT', 'DECIDE_FORFEIT']);
      expect(await as((tx) => securityForfeitCount(tx, firm))).toBe(1);
      expect((await as((tx) => securityFigures(tx, NOW)))[0]).toMatchObject({ code: 'VENDOR_SECURITY_CONFIRMED' });
    });

    it('rejects a security, releases one, and warns before the last day of one that is still open', async () => {
      const bid = await seedBidPackage(harness);
      const firm = await contractor('Cty Security Expiry');
      const rejected = await as((tx) => securities.receive(tx, { packageId: bid.packageId, contractorId: firm, kind: 'BANK_GUARANTEE', issuer: 'Bank X', securityNo: 'BX-1', amount: 100, issuedOn: '2026-11-01', validUntil: '2027-02-01' }, memberId(M1), NOW));
      expect((await refusal(as((tx) => securities.reject(tx, rejected.id, 1, 'Not known to the issuer, no such letter', memberId(M1), NOW)))).code).toBe('SELF_APPROVAL_DENIED');
      expect(await as((tx) => securities.reject(tx, rejected.id, 1, 'Not known to the issuer, no such letter', memberId(M2), NOW), M2)).toMatchObject({ state: 'REJECTED' });
      const open = await as((tx) => securities.receive(tx, { packageId: bid.packageId, contractorId: firm, kind: 'BANK_GUARANTEE', issuer: 'Bank Y', securityNo: 'BY-1', amount: 100, issuedOn: '2026-11-01', validUntil: '2026-11-23' }, memberId(M1), NOW));
      const confirmed = await as((tx) => securities.confirm(tx, open.id, 1, 'BY-REF-1', memberId(M2), NOW), M2);
      expect((await as((tx) => securities.find(tx, confirmed.id, TODAY)))?.expiryFacet).toBe('FIRST');
      expect((await as((tx) => securities.find(tx, confirmed.id, '2026-11-17')))?.expiryFacet).toBe('SECOND');
      expect((await as((tx) => securities.find(tx, confirmed.id, '2026-11-24')))?.expiryFacet).toBe('EXPIRED');
      expect((await as((tx) => securities.alertable(tx, '2026-11-24'))).some((row) => row.id === confirmed.id)).toBe(true);
      expect((await as((tx) => securities.alertable(tx, '2026-11-24'))).some((row) => row.id === rejected.id)).toBe(false);
      const released = await as((tx) => securities.release(tx, confirmed.id, 2, 'The contract was signed with another bidder', false, memberId(M1), NOW));
      expect(released).toMatchObject({ state: 'RELEASED', expiryFacet: null });
      expect((await as((tx) => securities.list(tx, { packageId: bid.packageId, state: 'REJECTED' }, TODAY))).map((row) => row.id)).toEqual([rejected.id]);
    });

    it('is invisible to another tenant', async () => {
      const bid = await seedBidPackage(harness);
      const firm = await contractor('Cty Security Tenant');
      const one = await as((tx) => securities.receive(tx, { packageId: bid.packageId, contractorId: firm, kind: 'BANK_GUARANTEE', issuer: 'Bank Z', securityNo: 'BZ-1', amount: 100, issuedOn: '2026-11-01', validUntil: '2027-02-01' }, memberId(M1), NOW));
      const other = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_B, memberId(1)), work);
      expect(await other((tx) => securities.find(tx, one.id, TODAY))).toBeUndefined();
      expect(await other((tx) => securities.list(tx, {}, TODAY))).toEqual([]);
    });
  });

  describe('the subcontracts', () => {
    it('assesses a proposal against the declaration of the bid, approves by another person and asks an exception for what the bid did not name', async () => {
      const bid = await seedBidPackage(harness);
      const prime = await contractor('Cty Prime A');
      const named = await contractor('Cty Sub Named');
      const unnamed = await contractor('Cty Sub Unnamed');
      const contractId = await contract(bid.packageId, bid.projectId, prime);
      const declared = await as((tx) => subcontracts.declare(tx, { packageId: bid.packageId, contractorId: prime, declaredSharePct: '30', subcontractorIds: [named] }, memberId(M1)));
      expect(declared).toMatchObject({ declaredSharePct: 30, subcontractorIds: [named] });
      const first = await as((tx) => subcontracts.propose(tx, { contractId, subcontractorId: named, scope: 'Earth works of the north wing', value: 2_000_000, sharePct: '20' }, memberId(M1)));
      expect(first).toMatchObject({ state: 'PROPOSED', declaredInBid: true });
      expect((await refusal(as((tx) => subcontracts.approve(tx, first.id, 1, undefined, memberId(M1), NOW)))).code).toBe('SELF_APPROVAL_DENIED');
      const approved = await as((tx) => subcontracts.approve(tx, first.id, 1, undefined, memberId(M2), NOW), M2);
      expect(approved).toMatchObject({ state: 'APPROVED', approvedBy: memberId(M2), exceptionApproved: false, assessment: { findings: [], total_share_pct: 20, prime_share_pct: 80 } });
      expect((await refusal(as((tx) => subcontracts.approve(tx, first.id, 2, undefined, memberId(M3), NOW), M3))).code).toBeDefined();
      const second = await as((tx) => subcontracts.propose(tx, { contractId, subcontractorId: unnamed, scope: 'Painting of the facades', value: 1_000_000, sharePct: '10' }, memberId(M1)));
      expect(second.declaredInBid).toBe(false);
      expect((await refusal(as((tx) => subcontracts.approve(tx, second.id, 1, undefined, memberId(M2), NOW), M2))).code).toBe('REASON_REQUIRED');
      const exception = await as((tx) => subcontracts.approve(tx, second.id, 1, 'The investor agreed to the extra subcontractor in writing', memberId(M2), NOW), M2);
      expect(exception).toMatchObject({ state: 'APPROVED', exceptionApproved: true, assessment: { findings: ['NOT_NAMED_IN_BID'], total_share_pct: 30 } });
      const listing = await as((tx) => subcontracts.list(tx, contractId, NOW));
      expect(listing).toMatchObject({ contractValue: 10_000_000, totalSharePct: 30, primeSharePct: 70, primeContractorId: prime });
      expect(listing.declaration?.declaredSharePct).toBe(30);
      expect(listing.policy).toMatchObject({ unverified: true });
      const breaches = await as((tx) => subcontracts.breaches(tx, TODAY));
      expect(breaches.filter((row) => row.contractId === contractId).map((row) => row.kind)).toEqual(['EXCEPTION']);
      expect(await as((tx) => subcontractBreachCount(tx, prime, TODAY))).toBe(1);
    });

    it('blocks the prime below its floor, a repeated subcontractor, a value that does not match its share and a subcontractor under a restriction', async () => {
      const bid = await seedBidPackage(harness);
      const prime = await contractor('Cty Prime B');
      const big = await contractor('Cty Sub Big');
      const mismatch = await contractor('Cty Sub Mismatch');
      const banned = await contractor('Cty Sub Banned');
      const contractId = await contract(bid.packageId, bid.projectId, prime);
      await as((tx) => subcontracts.declare(tx, { packageId: bid.packageId, contractorId: prime, declaredSharePct: '90', subcontractorIds: [big, mismatch, banned] }, memberId(M1)));
      const floor = await as((tx) => subcontracts.propose(tx, { contractId, subcontractorId: big, scope: 'Most of the structure works', value: 5_000_000, sharePct: '50' }, memberId(M1)));
      expect(await refusal(as((tx) => subcontracts.approve(tx, floor.id, 1, 'The investor agreed in writing to this part', memberId(M2), NOW), M2))).toMatchObject({ code: 'SUBCONTRACT_LIMIT_EXCEEDED', status: 422, extensions: { findings: ['PRIME_SHARE_BELOW_MINIMUM'] } });
      expect((await refusal(as((tx) => subcontracts.propose(tx, { contractId, subcontractorId: big, scope: 'Again the structure works', value: 1_000_000, sharePct: '10' }, memberId(M1))))).code).toBe('SUBCONTRACT_LIMIT_EXCEEDED');
      const wrong = await as((tx) => subcontracts.propose(tx, { contractId, subcontractorId: mismatch, scope: 'Electrical works of the site', value: 5_000_000, sharePct: '10' }, memberId(M1)));
      expect(await refusal(as((tx) => subcontracts.approve(tx, wrong.id, 1, undefined, memberId(M2), NOW), M2))).toMatchObject({ code: 'SUBCONTRACT_LIMIT_EXCEEDED', extensions: { findings: ['VALUE_SHARE_MISMATCH'] } });
      const decision = await document();
      await owner(
        `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, effective_until, decision_document_id, created_by, updated_by) values ($1, gen_random_uuid(), $2, 'DEBARMENT', 'DECISION', date '2026-01-01', date '2030-01-01', $3, $4, $4)`,
        [TENANT_A, banned, decision, memberId(M1)],
      );
      const restricted = await as((tx) => subcontracts.propose(tx, { contractId, subcontractorId: banned, scope: 'Plumbing works of the site', value: 1_000_000, sharePct: '10' }, memberId(M1)));
      expect(await refusal(as((tx) => subcontracts.approve(tx, restricted.id, 1, undefined, memberId(M2), NOW), M2))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED', status: 422, extensions: { action: 'SUBCONTRACT' } });
      // The proposer withdraws, another person rejects: both end the proposal and it is final.
      const withdrawn = await as((tx) => subcontracts.reject(tx, restricted.id, 1, 'Withdrawn, the subcontractor is banned', memberId(M1)));
      expect(withdrawn).toMatchObject({ state: 'REJECTED', decidedBy: memberId(M1) });
      const rejected = await as((tx) => subcontracts.reject(tx, floor.id, 1, 'Over the share the prime has to keep', memberId(M2)), M2);
      expect(rejected.state).toBe('REJECTED');
      expect((await refusal(as((tx) => subcontracts.reject(tx, floor.id, 2, 'Rejected a second time over', memberId(M2)), M2))).code).toBe('STAGE_TRANSITION_DENIED');
      expect(await databaseRefusal(owner('update machvon.vendor_subcontract set value = 1 where id = $1', [floor.id]))).toMatch(/not rewritten/);
    });

    it('clocks what the prime paid, flags a payment past the value, and ends a subcontract by termination', async () => {
      const bid = await seedBidPackage(harness);
      const prime = await contractor('Cty Prime C');
      const sub = await contractor('Cty Sub Paid');
      const contractId = await contract(bid.packageId, bid.projectId, prime);
      await as((tx) => subcontracts.declare(tx, { packageId: bid.packageId, contractorId: prime, declaredSharePct: '20', subcontractorIds: [sub] }, memberId(M1)));
      const proposed = await as((tx) => subcontracts.propose(tx, { contractId, subcontractorId: sub, scope: 'Roofing works of all the halls', value: 2_000_000, sharePct: '20' }, memberId(M1)));
      const request = await settledRequest(contractId, bid.projectId, '2030-01-01');
      expect((await refusal(as((tx) => subcontracts.recordPayment(tx, proposed.id, { paymentRequestId: request, paidAmount: 100, paidOn: '2030-01-02', reference: 'UNC-001' }, memberId(M1), NOW)))).code).toBe('SUBCONTRACT_STATE_INVALID');
      const approved = await as((tx) => subcontracts.approve(tx, proposed.id, 1, undefined, memberId(M2), NOW), M2);
      const early = await as((tx) => subcontracts.list(tx, contractId, new Date('2030-01-13T00:00:00Z')));
      expect(early.pending).toEqual([expect.objectContaining({ subcontractId: approved.id, paymentRequestId: request, paidOn: '2030-01-01', clock: 'DUE_SOON' })]);
      expect((await as((tx) => subcontracts.pending(tx, new Date('2030-01-20T00:00:00Z')))).find((row) => row.subcontractId === approved.id)?.clock).toBe('OVERDUE');
      const alerts = await as((tx) =>
        betaVendorAlerts({ tx, now: new Date('2030-01-20T00:00:00Z'), today: '2030-01-20', rules: undefined, holds: () => true } as unknown as Parameters<typeof betaVendorAlerts>[0]),
      );
      expect(alerts.filter((row) => row.kind === 'VENDOR_SUB_PAYMENT_CONFIRM' && row.id.startsWith(approved.id))).toHaveLength(1);
      expect(await refusal(as((tx) => subcontracts.recordPayment(tx, approved.id, { paymentRequestId: randomUUID(), paidAmount: 100, paidOn: '2030-01-02', reference: 'UNC-001' }, memberId(M1), NOW)))).toMatchObject({ detail: 'payment_request_id' });
      expect(await refusal(as((tx) => subcontracts.recordPayment(tx, approved.id, { paymentRequestId: request, paidAmount: 0, paidOn: '2030-01-02', reference: 'UNC-001' }, memberId(M1), NOW)))).toMatchObject({ detail: 'paid_amount' });
      const paid = await as((tx) => subcontracts.recordPayment(tx, approved.id, { paymentRequestId: request, paidAmount: 1_500_000, paidOn: '2030-01-03', reference: 'UNC-001' }, memberId(M1), new Date('2030-01-04T00:00:00Z')));
      expect(paid).toMatchObject({ paidAmount: 1_500_000, confirmedBySubcontractor: false });
      expect((await refusal(as((tx) => subcontracts.recordPayment(tx, approved.id, { paymentRequestId: request, paidAmount: 10, paidOn: '2030-01-03', reference: 'UNC-002' }, memberId(M1), NOW)))).detail).toBe('payment_request_id');
      const after = await as((tx) => subcontracts.list(tx, contractId, new Date('2030-01-20T00:00:00Z')));
      expect(after.pending).toEqual([]);
      expect(after.items[0]).toMatchObject({ paidTotal: 1_500_000, overPaid: 0 });
      await as((tx) => subcontracts.recordPayment(tx, approved.id, { paidAmount: 600_000, paidOn: '2030-01-10', reference: 'UNC-003' }, memberId(M1), NOW));
      const over = await as((tx) => subcontracts.list(tx, contractId, new Date('2030-01-20T00:00:00Z')));
      expect(over.items[0]).toMatchObject({ paidTotal: 2_100_000, overPaid: 100_000 });
      expect((await as((tx) => subcontracts.breaches(tx, TODAY))).filter((row) => row.contractId === contractId).map((row) => row.kind)).toEqual(['OVER_PAID']);
      expect(await databaseRefusal(owner('update machvon.vendor_subcontract_payment set paid_amount = 1 where id = $1', [paid.id]))).toMatch(/not rewritten/);
      expect((await as((tx) => subcontractFigures(tx, new Date('2030-01-20T00:00:00Z'))))[0]).toMatchObject({ code: 'VENDOR_SUB_PAYMENT_CONFIRMED', numerator: 1, denominator: 1 });
      const ended = await as((tx) => subcontracts.terminate(tx, approved.id, 2, 'The subcontract ended with the roofing works', memberId(M1)));
      expect(ended.state).toBe('TERMINATED');
      expect((await refusal(as((tx) => subcontracts.recordPayment(tx, approved.id, { paidAmount: 10, paidOn: '2030-01-11', reference: 'UNC-004' }, memberId(M1), NOW)))).code).toBe('SUBCONTRACT_STATE_INVALID');
    });

    it('supersedes a declaration instead of editing it and keeps another tenant out', async () => {
      const bid = await seedBidPackage(harness);
      const prime = await contractor('Cty Prime D');
      const sub = await contractor('Cty Sub D');
      const one = await as((tx) => subcontracts.declare(tx, { packageId: bid.packageId, contractorId: prime, declaredSharePct: '15.5', subcontractorIds: [sub] }, memberId(M1)));
      const two = await as((tx) => subcontracts.declare(tx, { packageId: bid.packageId, contractorId: prime, declaredSharePct: '0', subcontractorIds: [] }, memberId(M1)));
      expect(two.id).not.toBe(one.id);
      expect((await as((tx) => subcontracts.declaration(tx, bid.packageId, prime)))?.declaredSharePct).toBe(0);
      const rows = await owner<{ superseded_by: string | null }>('select superseded_by from machvon.vendor_bid_declaration where id = $1', [one.id]);
      expect(rows[0]?.superseded_by).toBe(two.id);
      expect(await databaseRefusal(owner('update machvon.vendor_bid_declaration set declared_share_pct = 50 where id = $1', [one.id]))).toMatch(/not rewritten/);
      expect(await refusal(as((tx) => subcontracts.declare(tx, { packageId: bid.packageId, contractorId: prime, declaredSharePct: '101', subcontractorIds: [sub] }, memberId(M1))))).toMatchObject({ detail: 'declared_share_pct' });
      expect(await refusal(as((tx) => subcontracts.declare(tx, { packageId: bid.packageId, contractorId: prime, declaredSharePct: '10', subcontractorIds: [] }, memberId(M1))))).toMatchObject({ detail: 'subcontractor_ids' });
      const other = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_B, memberId(1)), work);
      expect(await other((tx) => subcontracts.declaration(tx, bid.packageId, prime))).toBeNull();
    });
  });
});
