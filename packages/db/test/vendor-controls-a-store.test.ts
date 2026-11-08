import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCipher, foldForMatch, matchKeyOf, staticKeyProvider } from '@machvon/kernel';
import { VendorFinanceStore } from '../src/vendor-finance-store';
import { VendorIndependenceGate, VendorIndependenceStore } from '../src/vendor-independence-store';
import { VendorPackageControlStore } from '../src/vendor-package-control-store';
import { VendorPolicyReader } from '../src/vendor-policy';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';
import { seedBidPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
const independence = new VendorIndependenceStore();
const gate = new VendorIndependenceGate();
const finance = new VendorFinanceStore();
const controls = new VendorPackageControlStore();
const policies = new VendorPolicyReader();

const [M1, M2, M3, M4] = [1, 2, 3, 4];
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = M1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const identityKeyOf = (value: string): string => cipher.blindIndex(TENANT_A, 'owner-identity', value);
const nameKey = (name: string): string => matchKeyOf(foldForMatch(name));
const TODAY = '2026-11-09';

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
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
  const docId = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Paper', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)`,
    [TENANT_A, docId, memberId(M1)],
  );
  return docId;
}

let counter = 0;
async function contractor(name: string, keys: { address?: string; rep?: string; tax?: string } = {}): Promise<string> {
  counter += 1;
  const contractorId = randomUUID();
  const profile = await document();
  await owner(
    `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, address_key, legal_rep_key)
     values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $5, $8, $9)`,
    [TENANT_A, contractorId, keys.tax ?? `04${String(counter).padStart(8, '0')}`, name, profile, memberId(M1), memberId(M2), keys.address === undefined ? null : nameKey(keys.address), keys.rep === undefined ? null : nameKey(keys.rep)],
  );
  return contractorId;
}

async function projectAndPackage(): Promise<{ projectId: string; packageId: string }> {
  const seeded = await seedBidPackage(harness, { budgetVnd: '1200000', status: 'PLANNED' });
  return { projectId: seeded.projectId, packageId: seeded.packageId };
}

async function bid(projectId: string, packageId: string, contractorId: string): Promise<void> {
  await owner(
    `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, access_released_at, created_by)
     values ($1, $2, $3, $4, $5, '[]'::jsonb, 1, 'RECEIVED', now(), now() + interval '1 day', $6)`,
    [TENANT_A, randomUUID(), projectId, packageId, contractorId, memberId(M1)],
  );
}

const periodInput = (year: number, over: Partial<Parameters<VendorFinanceStore['record']>[2]> = {}): Parameters<VendorFinanceStore['record']>[2] => ({ fiscalYear: year, revenue: 1_000_000, totalAssets: 2_000_000, currentAssets: 1_200_000, currentLiabilities: 800_000, totalDebt: 900_000, equity: 1_100_000, ebit: 300_000, interestExpense: 100_000, ...over });

describe('the controls of contractors: independence, finance and load (VND-2, alpha)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    for (const member of [M1, M2, M3, M4]) await harness.seedMembership(TENANT_A, member, 1);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the controls of a package', () => {
    it('keeps one row for a package under a version, falls back to the budget and refuses a stale write', async () => {
      const { packageId } = await projectAndPackage();
      const fresh = await as((tx) => controls.get(tx, packageId));
      expect(fresh).toMatchObject({ version: 0, securityBaseAmount: null, budgetVnd: 1_200_000 });
      const first = await as((tx) => controls.set(tx, packageId, { securityBaseAmount: 50_000, bidValidUntil: '2026-12-31', estimatedValue: 1_000_000, durationMonths: 12 }, memberId(M1)));
      expect(first).toMatchObject({ version: 1, securityBaseAmount: 50_000, bidValidUntil: '2026-12-31', estimatedValue: 1_000_000, durationMonths: 12 });
      expect((await refusal(as((tx) => controls.set(tx, packageId, { securityBaseAmount: 1 }, memberId(M1), 0)))).code).toBe('VERSION_CONFLICT');
      const second = await as((tx) => controls.set(tx, packageId, { securityBaseAmount: 60_000, bidValidUntil: '2026-12-31' }, memberId(M2), 1));
      expect(second).toMatchObject({ version: 2, securityBaseAmount: 60_000, estimatedValue: null });
      expect(await refusal(as((tx) => controls.set(tx, packageId, { bidValidUntil: '2026-13-01' }, memberId(M1), 2)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'bid_valid_until' });
      expect(await refusal(as((tx) => controls.set(tx, packageId, { securityBaseAmount: -1 }, memberId(M1), 2)))).toMatchObject({ detail: 'security_base_amount' });
      expect((await refusal(as((tx) => controls.get(tx, randomUUID())))).status).toBe(404);
    });
  });

  describe('independence', () => {
    it('finds the links among bidders and a panel member, decides each once by another person, and carries a decision to the next run', async () => {
      const { projectId, packageId } = await projectAndPackage();
      const a = await contractor('Cty Doc Lap A', { address: '1 Le Loi', rep: 'Tran Van B' });
      const b = await contractor('Cty Doc Lap B', { address: '1 Le Loi', rep: 'Tran Van B' });
      const c = await contractor('Cty Doc Lap C');
      for (const one of [a, b, c]) await bid(projectId, packageId, one);
      const policy = await as((tx) => policies.independence(tx, TODAY));
      expect(policy.unverified).toBe(true);

      // A member of the panel declares a relative who holds the contractor C's identity number as an owner.
      const interest = await as((tx) => independence.declare(tx, { membershipId: memberId(M3), kind: 'RELATIVE', relatedName: 'Le Thi C', relatedIdentityNumber: '012345678901', relation: 'sister' }, memberId(M3), identityKeyOf, TODAY), M3);
      expect(interest).toMatchObject({ kind: 'RELATIVE', hasRelatedIdentity: true, memberName: 'User 3', version: 1 });
      const stored = await owner<{ related_identity_key: string }>('select related_identity_key from machvon.vendor_person_interest where id = $1', [interest.id]);
      expect(stored[0]?.related_identity_key).toBe(identityKeyOf('012345678901'));
      expect(await refusal(as((tx) => independence.declare(tx, { membershipId: memberId(M3), kind: 'SHAREHOLDING', contractorId: c }, memberId(M3), identityKeyOf, TODAY), M3))).toMatchObject({ detail: 'share_pct' });
      expect(await refusal(as((tx) => independence.declare(tx, { membershipId: randomUUID(), kind: 'ADVISORY', contractorId: c }, memberId(M3), identityKeyOf, TODAY), M3))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await owner('insert into machvon.contractor_owner (tenant_id, id, contractor_id, owner_kind, owner_name, name_key, identity_key, share_pct, beneficial_owner, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, 40, true, $8, $8)', [TENANT_A, randomUUID(), c, 'PERSON', 'Le Thi C', nameKey('Le Thi C'), identityKeyOf('012345678901'), memberId(M1)]);

      const run = await as((tx) => independence.run(tx, packageId, { panelMembershipIds: [memberId(M3)], staffMembershipIds: [] }, memberId(M1), identityKeyOf, TODAY, policy));
      expect(run.created).toBe(true);
      expect(run.view.check).toMatchObject({ biddersCount: 3, panelIds: [memberId(M3)], ruleUnverified: true });
      const kinds = run.view.findings.map((one) => `${one.kind}:${one.strength}`).sort();
      expect(kinds).toEqual(['BIDDERS_SHARE_ADDRESS:MEDIUM', 'BIDDERS_SHARE_REPRESENTATIVE:STRONG', 'RELATIVE_OWNS_BIDDER:STRONG']);
      expect(run.view.gate).toMatchObject({ open: false, undecidedStrong: 2, undecided: 3 });
      expect(run.view.findings.find((one) => one.kind === 'RELATIVE_OWNS_BIDDER')?.partyNames).toContain('User 3');

      // A replay over the same facts changes nothing.
      const again = await as((tx) => independence.run(tx, packageId, { panelMembershipIds: [memberId(M3)], staffMembershipIds: [] }, memberId(M1), identityKeyOf, TODAY, policy));
      expect(again.created).toBe(false);
      expect(again.view.check.id).toBe(run.view.check.id);

      // The gate: closed, so an award is refused; a package never checked is not blocked.
      expect((await refusal(as((tx) => gate.assertOpen(tx, packageId, policy)))).code).toBe('INDEPENDENCE_FINDING_OPEN');
      const other = await projectAndPackage();
      await as((tx) => gate.assertOpen(tx, other.packageId, policy));

      const rep = run.view.findings.find((one) => one.kind === 'BIDDERS_SHARE_REPRESENTATIVE') as NonNullable<typeof run.view.findings[number]>;
      const reason = 'the two companies share a representative named in two registrations';
      expect((await refusal(as((tx) => independence.decide(tx, rep.id, rep.version, 'BLOCKED', reason, memberId(M1))))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await refusal(as((tx) => independence.decide(tx, rep.id, rep.version, 'BLOCKED', 'short', memberId(M2)), M2))).code).toBe('REASON_REQUIRED');
      expect((await refusal(as((tx) => independence.decide(tx, rep.id, rep.version, 'RECUSED', reason, memberId(M2)), M2))).code).toBe('INDEPENDENCE_DECISION_INVALID');
      expect((await refusal(as((tx) => independence.decide(tx, rep.id, rep.version + 5, 'BLOCKED', reason, memberId(M2)), M2))).code).toBe('VERSION_CONFLICT');
      const decided = await as((tx) => independence.decide(tx, rep.id, rep.version, 'BLOCKED', reason, memberId(M2)), M2);
      expect(decided).toMatchObject({ decision: 'BLOCKED', decidedBy: memberId(M2), version: 2 });
      expect((await refusal(as((tx) => independence.decide(tx, rep.id, 2, 'CLEARED', reason, memberId(M3)), M3))).code).toBe('STAGE_TRANSITION_DENIED');
      expect(await databaseRefusal(owner("update machvon.vendor_independence_finding set decision = 'CLEARED' where id = $1", [rep.id]))).toContain('stays as it was made');
      expect(await databaseRefusal(owner('delete from machvon.vendor_independence_finding where id = $1', [rep.id]))).toMatch(/never deleted|permission denied/);

      const person = run.view.findings.find((one) => one.kind === 'RELATIVE_OWNS_BIDDER') as NonNullable<typeof run.view.findings[number]>;
      expect((await refusal(as((tx) => independence.decide(tx, person.id, person.version, 'BLOCKED', reason, memberId(M2)), M2))).code).toBe('INDEPENDENCE_DECISION_INVALID');
      await as((tx) => independence.decide(tx, person.id, person.version, 'RECUSED', reason, memberId(M2)), M2);
      const address = run.view.findings.find((one) => one.kind === 'BIDDERS_SHARE_ADDRESS') as NonNullable<typeof run.view.findings[number]>;
      await as((tx) => independence.decide(tx, address.id, address.version, 'CLEARED', reason, memberId(M4)), M4);
      const closed = await as((tx) => independence.gate(tx, packageId, policy));
      expect(closed).toMatchObject({ checked: true, open: false, blocked: 1, cleared: 1, recused: 1 });

      // A new run (another person on the panel) carries the decisions: nobody is asked twice.
      const next = await as((tx) => independence.run(tx, packageId, { panelMembershipIds: [memberId(M3), memberId(M4)], staffMembershipIds: [] }, memberId(M4), identityKeyOf, TODAY, policy), M4);
      expect(next.created).toBe(true);
      expect(next.view.findings).toHaveLength(3);
      for (const one of next.view.findings) {
        expect(one.decision).not.toBeNull();
        expect(one.carriedFromId).not.toBeNull();
      }
      expect(next.view.findings.find((one) => one.kind === 'BIDDERS_SHARE_REPRESENTATIVE')).toMatchObject({ decision: 'BLOCKED', decidedBy: memberId(M2) });
      expect(await as((tx) => independence.openFindings(tx))).toEqual(expect.not.arrayContaining([expect.objectContaining({ packageId })]));
      // The decision of an older check cannot be made again.
      expect((await refusal(as((tx) => independence.decide(tx, address.id, 2, 'BLOCKED', reason, memberId(M2)), M2))).code).toMatch(/STAGE_TRANSITION_DENIED|VERSION_CONFLICT/);

      // The interest ends once.
      const ended = await as((tx) => independence.end(tx, interest.id, 1, 'the relative left the company', TODAY, memberId(M3)), M3);
      expect(ended).toMatchObject({ endedOn: TODAY, version: 2 });
      expect((await refusal(as((tx) => independence.end(tx, interest.id, 2, 'again and again', TODAY, memberId(M3)), M3))).code).toBe('STAGE_TRANSITION_DENIED');
      expect((await as((tx) => independence.interests(tx, { membershipId: memberId(M3), activeOnly: true }))).length).toBe(0);
    });

    it('recognises cross ownership of an organisation owner through its tax code and the owner organisation of the package', async () => {
      const { projectId, packageId } = await projectAndPackage();
      const holder = await contractor('Cty Me', { tax: '0501234567' });
      const held = await contractor('Cty Con', { tax: '0507654321' });
      await bid(projectId, packageId, holder);
      await bid(projectId, packageId, held);
      await owner('insert into machvon.contractor_owner (tenant_id, id, contractor_id, owner_kind, owner_name, name_key, identity_key, share_pct, beneficial_owner, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, 35, false, $8, $8)', [TENANT_A, randomUUID(), held, 'ORGANISATION', 'Cty Me', nameKey('Cty Me'), identityKeyOf('0501234567'), memberId(M1)]);
      const policy = await as((tx) => policies.independence(tx, TODAY));
      const run = await as((tx) => independence.run(tx, packageId, { panelMembershipIds: [], staffMembershipIds: [], ownerTaxCode: '0501234567' }, memberId(M1), identityKeyOf, TODAY, policy));
      expect(run.view.findings.map((one) => one.kind).sort()).toEqual(['BIDDERS_CROSS_OWNERSHIP', 'BIDDER_CROSS_OWNERSHIP_WITH_OWNER', 'BIDDER_IS_OWNER_ORGANISATION']);
      expect(run.view.check.ownerTaxHead).toBe('0501234567');
      expect(await refusal(as((tx) => independence.run(tx, packageId, { panelMembershipIds: [randomUUID()], staffMembershipIds: [] }, memberId(M1), identityKeyOf, TODAY, policy)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'membership_ids' });
      expect(await refusal(as((tx) => independence.run(tx, packageId, { panelMembershipIds: [], staffMembershipIds: [], ownerTaxCode: '12' }, memberId(M1), identityKeyOf, TODAY, policy)))).toMatchObject({ detail: 'owner_tax_code' });
      const figures = await as((tx) => independence.figures(tx, new Date(`${TODAY}T03:00:00Z`)));
      expect(figures[0]).toMatchObject({ code: 'VENDOR_INDEPENDENCE_CHECKED', asOf: TODAY });
      expect(figures[0]?.numerator).toBeGreaterThanOrEqual(2);
      expect(figures[0]?.denominator).toBeGreaterThanOrEqual(figures[0]?.numerator ?? 0);
    });
  });

  describe('finance and load', () => {
    it('records a year, verifies it by another person with a paper, supersedes a corrected year and refuses a duplicate', async () => {
      const id1 = await contractor('Cty Tai Chinh');
      const paper = await document();
      const row = await as((tx) => finance.record(tx, id1, periodInput(2025, { documentId: paper }), memberId(M1)));
      expect(row).toMatchObject({ year: 2025, verified: false, version: 1, ratios: { currentRatio: 1.5, debtToAssetsPct: 45, interestCover: 3 } });
      expect((await refusal(as((tx) => finance.record(tx, id1, periodInput(2025, { documentId: paper }), memberId(M1))))).code).toBe('FINANCIAL_PERIOD_DUPLICATE');
      expect((await refusal(as((tx) => finance.verify(tx, row.id, 1, memberId(M1))))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await refusal(as((tx) => finance.verify(tx, row.id, 7, memberId(M2)), M2))).code).toBe('VERSION_CONFLICT');
      const verified = await as((tx) => finance.verify(tx, row.id, 1, memberId(M2)), M2);
      expect(verified).toMatchObject({ verified: true, verifiedBy: memberId(M2), version: 2 });
      expect((await refusal(as((tx) => finance.verify(tx, row.id, 2, memberId(M3)), M3))).code).toBe('STAGE_TRANSITION_DENIED');
      const noPaper = await as((tx) => finance.record(tx, id1, periodInput(2024), memberId(M1)));
      expect(await refusal(as((tx) => finance.verify(tx, noPaper.id, 1, memberId(M2)), M2))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_id' });
      expect(await refusal(as((tx) => finance.record(tx, id1, periodInput(2023, { currentAssets: 5_000_000 }), memberId(M1))))).toMatchObject({ detail: 'current_assets' });

      // A correction of 2025 supersedes the verified row: the year has one active row, and it does not count until verified.
      const corrected = await as((tx) => finance.record(tx, id1, periodInput(2025, { revenue: 1_100_000, documentId: paper }), memberId(M1)));
      const all = await as((tx) => finance.periods(tx, id1, true));
      expect(all.filter((one) => one.year === 2025)).toHaveLength(2);
      expect((await as((tx) => finance.periods(tx, id1))).filter((one) => one.year === 2025).map((one) => one.id)).toEqual([corrected.id]);
      expect(await databaseRefusal(owner('update machvon.vendor_financial_period set revenue = 1 where id = $1', [corrected.id]))).toContain('not rewritten');
      await as((tx) => finance.verify(tx, corrected.id, 1, memberId(M3)), M3);
    });

    it('judges the ratios and the revenue against the rule and the package, with too little data never a pass', async () => {
      const cid = await contractor('Cty Chi Tieu');
      const paper = await document();
      const { packageId } = await projectAndPackage();
      await as((tx) => controls.set(tx, packageId, { estimatedValue: 200_000, durationMonths: 12 }, memberId(M1)));
      const policy = await as((tx) => policies.finance(tx, TODAY));
      const none = await as((tx) => finance.assessFor(tx, cid, packageId, policy));
      expect(none.assessment.overall).toBe('INSUFFICIENT_DATA');
      expect(none.requirement).toMatchObject({ packageValue: 200_000, durationMonths: 12, valueFrom: 'ESTIMATED_VALUE' });
      for (const year of [2024, 2025]) {
        const period = await as((tx) => finance.record(tx, cid, periodInput(year, { documentId: paper }), memberId(M1)));
        await as((tx) => finance.verify(tx, period.id, 1, memberId(M2)), M2);
      }
      const meets = await as((tx) => finance.assessFor(tx, cid, packageId, policy));
      expect(meets.assessment).toMatchObject({ overall: 'MEETS', verifiedYears: 2, averageRevenue: 1_000_000, requiredRevenue: 400_000 });
      await as((tx) => controls.set(tx, packageId, { estimatedValue: 900_000, durationMonths: 12 }, memberId(M1), 1));
      const below = await as((tx) => finance.assessFor(tx, cid, packageId, policy));
      expect(below.assessment.overall).toBe('BELOW');
      expect(below.assessment.results.find((one) => one.test === 'AVERAGE_REVENUE')).toMatchObject({ status: 'FAIL', threshold: 1_800_000 });
      expect((await refusal(as((tx) => finance.assessFor(tx, randomUUID(), undefined, policy)))).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('counts the remaining value of open contracts, the late ones and the awards not yet signed against the average revenue', async () => {
      const cid = await contractor('Cty Tai Trong');
      const paper = await document();
      for (const year of [2024, 2025]) {
        const period = await as((tx) => finance.record(tx, cid, periodInput(year, { documentId: paper, revenue: 500_000 }), memberId(M1)));
        await as((tx) => finance.verify(tx, period.id, 1, memberId(M2)), M2);
      }
      const first = await projectAndPackage();
      const second = await projectAndPackage();
      const third = await projectAndPackage();
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, accepted_total_vnd, signed_on, effective_from, completion_due)
           values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', 'ACTIVE', 1, 1000000, 400000, date '2026-01-01', date '2026-01-01', date '2026-10-01'), ($1, $7, $8, $9, $5, $10, 'LUMP_SUM', 'VND', 'DRAFT', 1, 9000000, 0, null, null, null)`,
          [TENANT_A, randomUUID(), first.projectId, first.packageId, cid, `HD-${randomUUID().slice(0, 8)}`, randomUUID(), second.projectId, second.packageId, `HD-${randomUUID().slice(0, 8)}`],
        ],
        [
          `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, outcome, status, submitted_by, created_by, updated_by, evaluation_minutes_document_id)
           values ($1, $2, $3, $4, 700000, 'AWARDED', 'SUBMITTED', $5, $5, $5, $6)`,
          [TENANT_A, randomUUID(), third.packageId, cid, memberId(M1), paper],
        ],
      ]);
      const financePolicy = await as((tx) => policies.finance(tx, TODAY));
      const capacityPolicy = await as((tx) => policies.capacity(tx, TODAY));
      const reading = await as((tx) => finance.capacity(tx, cid, TODAY, financePolicy, capacityPolicy));
      expect(reading.facts).toEqual({ openContractValue: 600_000, openContractCount: 1, lateContractCount: 1, pendingAwardValue: 700_000, pendingAwardCount: 1, averageAnnualRevenue: 500_000 });
      expect(reading.assessment).toMatchObject({ load: 1_300_000, loadMultiple: 2.6, status: 'WITHIN' });
      const lonely = await contractor('Cty Khong So Lieu');
      const noData = await as((tx) => finance.capacity(tx, lonely, TODAY, financePolicy, capacityPolicy));
      expect(noData.assessment.status).toBe('NO_DATA');
    });
  });
});
