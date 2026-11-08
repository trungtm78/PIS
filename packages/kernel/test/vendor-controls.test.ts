import { DomainError } from '../src/errors';
import {
  BID_SECURITY_POLICY_DEFAULTS,
  CAPACITY_POLICY_DEFAULTS,
  FINANCE_POLICY_DEFAULTS,
  INDEPENDENCE_POLICY_DEFAULTS,
  PERFORMANCE_POLICY_DEFAULTS,
  RISK_FACTORS,
  RISK_POLICY_DEFAULTS,
  SUBCONTRACT_POLICY_DEFAULTS,
  assertFinancialPeriod,
  assertFindingDecision,
  assertForfeiture,
  assertPublication,
  assertRiskDecision,
  assertSecurityEntry,
  assertSubcontractApproval,
  assertSubcontractPayment,
  assessCapacity,
  assessFinance,
  assessSecurity,
  assessSubcontract,
  averageRevenue,
  bidSecurityPolicyOf,
  builtInDefault,
  capacityPolicyOf,
  decisionFitsFinding,
  detectBidderLinks,
  detectIndependence,
  detectOwnerLinks,
  detectPersonLinks,
  financePolicyOf,
  gradeRisk,
  independenceGate,
  independencePolicyOf,
  moveSecurity,
  moveSubcontract,
  nextReviewOn,
  paidExcess,
  paymentConfirmationState,
  performancePolicyOf,
  poorStreak,
  publicationClock,
  publicationDueOn,
  ratiosOf,
  requiredSecurity,
  responseReviewClock,
  riskParamsOf,
  riskPolicyOf,
  securityExpiryFacet,
  streakSuggestion,
  subcontractPolicyOf,
  ventureFinance,
  withinRetrospect,
  yearlyValue,
  ruleTypeDefinitions,
} from '../src/index';
import type { FinancialPeriod, OwnerKeys, PartyFacts, IndependencePerson, RiskInputs } from '../src/index';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (failure) {
    if (failure instanceof DomainError) return failure;
    throw failure;
  }
  throw new Error('expected a refusal');
};

const owner = (nameKey: string, over: Partial<OwnerKeys> = {}): OwnerKeys => ({ nameKey, identityKey: null, taxHead: null, sharePct: null, ...over });
const party = (id: string, over: Partial<PartyFacts> = {}): PartyFacts => ({ contractorId: id, taxHead: null, addressKey: null, phoneKey: null, emailKey: null, legalRepKey: null, owners: [], bankAccountKeys: [], ...over });
const person = (id: string, over: Partial<IndependencePerson> = {}): IndependencePerson => ({ membershipId: id, role: 'EVALUATOR', nameKey: `name-${id}`, identityKey: null, interests: [], ...over });

describe('independence (V5)', () => {
  const policy = INDEPENDENCE_POLICY_DEFAULTS;

  it('finds the tax head, the account and the representative as strong links and an address as a medium one, in a fixed order', () => {
    const a = party('a', { taxHead: '0100', addressKey: 'addr', legalRepKey: 'rep', bankAccountKeys: ['bank1'] });
    const b = party('b', { taxHead: '0100', addressKey: 'addr', legalRepKey: 'rep', bankAccountKeys: ['bank1'] });
    const found = detectBidderLinks([a, b], policy);
    expect(found.map((one) => `${one.kind}:${one.strength}`)).toEqual(['BIDDERS_SHARE_TAX_HEAD:STRONG', 'BIDDERS_SHARE_ADDRESS:MEDIUM', 'BIDDERS_SHARE_REPRESENTATIVE:STRONG', 'BIDDERS_SHARE_BANK_ACCOUNT:STRONG']);
    expect(found[0]?.fingerprint).toBe('BIDDERS_SHARE_TAX_HEAD|CONTRACTOR:a|CONTRACTOR:b');
    // The same pair looked at the other way round gives the same fingerprints.
    expect(detectBidderLinks([b, a], policy).map((one) => one.fingerprint)).toEqual(found.map((one) => one.fingerprint));
  });

  it('finds nothing between parties that share no key, and never compares a party with itself', () => {
    expect(detectBidderLinks([party('a', { taxHead: '1' }), party('b', { taxHead: '2' })], policy)).toEqual([]);
    expect(detectBidderLinks([party('a', { taxHead: '1' }), party('a', { taxHead: '1' })], policy)).toEqual([]);
  });

  it('finds cross ownership between bidders only above the limit (20 percent), strictly', () => {
    const holder = party('h', { taxHead: 'HEAD-H' });
    const atLimit = party('x', { owners: [owner('n', { taxHead: 'HEAD-H', sharePct: 20 })] });
    const above = party('y', { owners: [owner('n', { taxHead: 'HEAD-H', sharePct: 20.01 })] });
    expect(detectBidderLinks([holder, atLimit], policy)).toEqual([]);
    const found = detectBidderLinks([holder, above], policy);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'BIDDERS_CROSS_OWNERSHIP', strength: 'STRONG', evidence: { share_pct: 20.01, limit_pct: 20, holder: 'h' } });
  });

  it('finds the owner of one bidder who also owns another by identity or by tax head', () => {
    const a = party('a', { owners: [owner('p', { identityKey: 'id-1' })] });
    const b = party('b', { owners: [owner('q', { identityKey: 'id-1' })] });
    expect(detectBidderLinks([a, b], policy).map((one) => one.kind)).toEqual(['BIDDERS_SHARE_OWNER']);
    const c = party('c', { owners: [owner('p'), owner('q')] });
    const d = party('d', { owners: [owner('p')] });
    // A name alone is never an identity: nothing is found without a key.
    expect(detectBidderLinks([c, d], policy)).toEqual([]);
  });

  it('finds the bidder that is the owner organisation, and cross ownership with the owner above 30 percent', () => {
    const investor = { taxHead: 'INV', ownerKeys: [owner('state', { taxHead: 'STATE', sharePct: 100 })] };
    expect(detectOwnerLinks(investor, [party('a', { taxHead: 'INV' })], policy).map((one) => one.kind)).toEqual(['BIDDER_IS_OWNER_ORGANISATION']);
    const heldBy = party('b', { taxHead: 'BID', owners: [owner('org', { taxHead: 'INV', sharePct: 30.01 })] });
    expect(detectOwnerLinks(investor, [heldBy], policy).map((one) => one.kind)).toEqual(['BIDDER_CROSS_OWNERSHIP_WITH_OWNER']);
    const atLimit = party('c', { taxHead: 'BID2', owners: [owner('org', { taxHead: 'INV', sharePct: 30 })] });
    expect(detectOwnerLinks(investor, [atLimit], policy)).toEqual([]);
    const holdsInvestor = { taxHead: 'INV', ownerKeys: [owner('org', { taxHead: 'BID3', sharePct: 45 })] };
    expect(detectOwnerLinks(holdsInvestor, [party('d', { taxHead: 'BID3' })], policy).map((one) => one.kind)).toEqual(['BIDDER_CROSS_OWNERSHIP_WITH_OWNER']);
  });

  it('finds an evaluator who represents or owns a bidder, strong by identity and medium by name', () => {
    const bidder = party('b', { legalRepKey: 'name-e1', owners: [owner('name-e2', { identityKey: 'id-e2', sharePct: 10 })] });
    const people = [person('e1'), person('e2', { identityKey: 'id-e2' }), person('e3', { identityKey: 'id-other', nameKey: 'name-e2' })];
    const found = detectPersonLinks(people, [bidder], policy, '2026-11-08');
    expect(found.map((one) => `${one.parties.find((side) => side.kind === 'PERSON')?.id}:${one.kind}:${one.strength}`).sort()).toEqual([
      'e1:PERSON_REPRESENTS_BIDDER:MEDIUM',
      'e2:PERSON_OWNS_BIDDER:STRONG',
      'e3:PERSON_OWNS_BIDDER:MEDIUM',
    ]);
  });

  it('finds a declared relative of the representative or an owner, and a declared holding, advice or a former employment inside its months', () => {
    const bidder = party('b', { taxHead: 'TAX-B', legalRepKey: 'rel-key', owners: [owner('own-name', { identityKey: 'own-id' })] });
    const interest = (over: Partial<IndependencePerson['interests'][number]>): IndependencePerson['interests'][number] => ({ id: 'i1', kind: 'RELATIVE', relatedNameKey: null, relatedIdentityKey: null, contractorId: null, taxHead: null, sharePct: null, endedOn: null, ...over });
    const cases: Array<[Partial<IndependencePerson['interests'][number]>, string]> = [
      [{ relatedNameKey: 'rel-key' }, 'RELATIVE_REPRESENTS_BIDDER:MEDIUM'],
      [{ relatedIdentityKey: 'own-id' }, 'RELATIVE_OWNS_BIDDER:STRONG'],
      [{ relatedNameKey: 'own-name' }, 'RELATIVE_OWNS_BIDDER:MEDIUM'],
      [{ kind: 'SHAREHOLDING', contractorId: 'b', sharePct: 5 }, 'PERSON_HOLDS_SHARES_IN_BIDDER:STRONG'],
      [{ kind: 'ADVISORY', taxHead: 'TAX-B' }, 'ADVISER_OF_BIDDER:STRONG'],
      [{ kind: 'FORMER_EMPLOYMENT', contractorId: 'b', endedOn: '2026-01-31' }, 'FORMER_OFFICIAL_OF_BIDDER:STRONG'],
    ];
    for (const [over, expected] of cases) {
      const found = detectPersonLinks([person('e1', { interests: [interest(over)] })], [bidder], policy, '2026-11-08');
      expect(found.map((one) => `${one.kind}:${one.strength}`)).toEqual([expected]);
    }
  });

  it('lets a former employment lapse after the months of the rule and a share that ended stop counting', () => {
    const bidder = party('b');
    const former = (endedOn: string): IndependencePerson => person('e1', { interests: [{ id: 'f', kind: 'FORMER_EMPLOYMENT', relatedNameKey: null, relatedIdentityKey: null, contractorId: 'b', taxHead: null, sharePct: null, endedOn }] });
    // 12 months: left on 2025-11-08 is exactly 12 months before 2026-11-08, no longer inside the window.
    expect(detectPersonLinks([former('2025-11-08')], [bidder], policy, '2026-11-08')).toEqual([]);
    expect(detectPersonLinks([former('2025-11-09')], [bidder], policy, '2026-11-08')).toHaveLength(1);
    const ended = person('e1', { interests: [{ id: 's', kind: 'SHAREHOLDING', relatedNameKey: null, relatedIdentityKey: null, contractorId: 'b', taxHead: null, sharePct: 10, endedOn: '2026-01-01' }] });
    expect(detectPersonLinks([ended], [bidder], policy, '2026-11-08')).toEqual([]);
  });

  it('merges the three detections without a repeated fingerprint and keeps the strongest', () => {
    const a = party('a', { taxHead: 'T', owners: [owner('p', { identityKey: 'id-1' })] });
    const b = party('b', { taxHead: 'T', owners: [owner('q', { identityKey: 'id-1' })] });
    const all = detectIndependence({ bidders: [a, b], people: [], owner: { taxHead: 'T', ownerKeys: [] }, today: '2026-11-08' }, policy);
    expect(new Set(all.map((one) => one.fingerprint)).size).toBe(all.length);
    expect(all.map((one) => one.kind)).toEqual(['BIDDERS_SHARE_OWNER', 'BIDDERS_SHARE_TAX_HEAD', 'BIDDER_IS_OWNER_ORGANISATION', 'BIDDER_IS_OWNER_ORGANISATION']);
  });

  it('judges the decision: another person, a reason of 20 characters, once, and a kind that fits', () => {
    const ok = { decision: 'CLEARED', reason: 'the shared office is a co-working space', decidedBy: 'u2', ranBy: 'u1', alreadyDecided: false };
    expect(assertFindingDecision(ok)).toBe('CLEARED');
    expect(refusal(() => assertFindingDecision({ ...ok, decidedBy: 'u1' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(refusal(() => assertFindingDecision({ ...ok, reason: 'too short' })).code).toBe('REASON_REQUIRED');
    expect(refusal(() => assertFindingDecision({ ...ok, alreadyDecided: true })).code).toBe('STAGE_TRANSITION_DENIED');
    expect(refusal(() => assertFindingDecision({ ...ok, decision: 'IGNORED' })).code).toBe('VALIDATION_FAILED');
    expect(decisionFitsFinding('PERSON_OWNS_BIDDER', 'RECUSED')).toBe(true);
    expect(decisionFitsFinding('PERSON_OWNS_BIDDER', 'BLOCKED')).toBe(false);
    expect(decisionFitsFinding('BIDDERS_SHARE_TAX_HEAD', 'BLOCKED')).toBe(true);
    expect(decisionFitsFinding('BIDDERS_SHARE_TAX_HEAD', 'RECUSED')).toBe(false);
  });

  it('opens the gate only when no finding is blocked and no strong one is undecided (by the rule)', () => {
    expect(independenceGate([], policy).open).toBe(true);
    expect(independenceGate([{ strength: 'MEDIUM', decision: null }], policy)).toMatchObject({ open: true, undecided: 1, undecidedStrong: 0 });
    expect(independenceGate([{ strength: 'STRONG', decision: null }], policy).open).toBe(false);
    expect(independenceGate([{ strength: 'STRONG', decision: null }], { ...policy, undecided_strong_blocks_award: false }).open).toBe(true);
    expect(independenceGate([{ strength: 'STRONG', decision: 'BLOCKED' }], { ...policy, undecided_strong_blocks_award: false }).open).toBe(false);
    expect(independenceGate([{ strength: 'STRONG', decision: 'CLEARED' }, { strength: 'MEDIUM', decision: 'RECUSED' }], policy)).toMatchObject({ open: true, cleared: 1, recused: 1 });
  });

  it('reads the rule strictly', () => {
    expect(independencePolicyOf({ ...policy })).toEqual(policy);
    expect(refusal(() => independencePolicyOf({ ...policy, cross_ownership_investor_pct: 0 })).detail).toBe('cross_ownership_investor_pct');
    expect(refusal(() => independencePolicyOf({ ...policy, undecided_strong_blocks_award: 'yes' })).detail).toBe('undecided_strong_blocks_award');
  });
});

const period = (year: number, over: Partial<FinancialPeriod> = {}): FinancialPeriod => ({ year, revenue: 100_000, totalAssets: 200_000, currentAssets: 120_000, currentLiabilities: 80_000, totalDebt: 100_000, equity: 100_000, ebit: 30_000, interestExpense: 10_000, verified: true, ...over });

describe('finance (V7)', () => {
  const policy = FINANCE_POLICY_DEFAULTS;

  it('computes the ratios with two decimals and null where nothing can be divided', () => {
    expect(ratiosOf(period(2025))).toEqual({ currentRatio: 1.5, debtToAssetsPct: 50, interestCover: 3, equityToAssetsPct: 50 });
    expect(ratiosOf(period(2025, { currentLiabilities: 0, interestExpense: 0, totalAssets: 0, currentAssets: 0 }))).toEqual({ currentRatio: null, debtToAssetsPct: null, interestCover: null, equityToAssetsPct: null });
    expect(ratiosOf(period(2025, { currentAssets: 100_000, currentLiabilities: 300_000 })).currentRatio).toBe(0.33);
  });

  it('counts the latest verified years only and averages over the years there are', () => {
    const list = [period(2022, { revenue: 10 }), period(2023, { revenue: 20 }), period(2024, { revenue: 30 }), period(2025, { revenue: 90, verified: false }), period(2026, { revenue: 40 })];
    expect(averageRevenue(list, 3)).toBe(30);
    expect(averageRevenue(list, 1)).toBe(40);
    expect(averageRevenue([period(2025, { verified: false })], 3)).toBeNull();
  });

  it('judges a contractor that meets the lines and states the requirement of the package', () => {
    const periods = [period(2024), period(2025), period(2023)];
    const result = assessFinance(periods, policy, { packageValue: 40_000, durationMonths: 12 });
    expect(result).toMatchObject({ overall: 'MEETS', requiredRevenue: 80_000, averageRevenue: 100_000, verifiedYears: 3 });
    // The same contractor against a package of 120000 a year: 2 x 120000 = 240000 is required and the revenue test fails.
    const big = assessFinance(periods, policy, { packageValue: 120_000, durationMonths: 12 });
    expect(big.overall).toBe('BELOW');
    expect(big.results.find((one) => one.test === 'AVERAGE_REVENUE')).toMatchObject({ status: 'FAIL', value: 100_000, threshold: 240_000 });
  });

  it('puts every test in order and passes a ratio that cannot be computed because it is unlimited', () => {
    const result = assessFinance([period(2024, { currentLiabilities: 0, interestExpense: 0 }), period(2025, { currentLiabilities: 0, interestExpense: 0 })], policy, { packageValue: 100_000, durationMonths: 12 });
    expect(result.results.map((one) => `${one.test}:${one.status}`)).toEqual(['CURRENT_RATIO:PASS', 'DEBT_TO_ASSETS:PASS', 'INTEREST_COVER:PASS', 'AVERAGE_REVENUE:FAIL']);
    const none = assessFinance([period(2025, { currentLiabilities: 0, interestExpense: 0 }), period(2024)], policy, null);
    expect(none.results[3]).toMatchObject({ test: 'AVERAGE_REVENUE', status: 'NO_DATA' });
    expect(none.overall).toBe('MEETS');
  });

  it('fails each ratio on its own line and never passes on too little data', () => {
    const weak = period(2025, { currentAssets: 50_000, currentLiabilities: 100_000, totalDebt: 190_000, ebit: 5_000 });
    const result = assessFinance([weak, period(2024)], policy, null);
    expect(result.results.filter((one) => one.status === 'FAIL').map((one) => one.test)).toEqual(['CURRENT_RATIO', 'DEBT_TO_ASSETS', 'INTEREST_COVER']);
    expect(result.overall).toBe('BELOW');
    const one = assessFinance([period(2025)], policy, null);
    expect(one.overall).toBe('INSUFFICIENT_DATA');
    expect(assessFinance([], policy, { packageValue: 1, durationMonths: 12 })).toMatchObject({ overall: 'INSUFFICIENT_DATA', verifiedYears: 0, averageRevenue: null, requiredRevenue: 2 });
    expect(assessFinance([period(2025, { verified: false })], policy, null).verifiedYears).toBe(0);
  });

  it('puts the yearly value of a package from its months and counts less than a month as a month', () => {
    expect(yearlyValue({ packageValue: 600, durationMonths: 24 })).toBe(300);
    expect(yearlyValue({ packageValue: 600, durationMonths: 0 })).toBe(7200);
  });

  it('adds the shares of the members of a joint venture year by year and refuses shares that do not make a whole', () => {
    const lead = { sharePct: 60, periods: [period(2024, { revenue: 1000 }), period(2025, { revenue: 2000 })] };
    const member = { sharePct: 40, periods: [period(2025, { revenue: 500 }), period(2023, { revenue: 9 })] };
    const combined = ventureFinance([lead, member]);
    expect(combined.map((one) => one.year)).toEqual([2025]);
    expect(combined[0]?.revenue).toBe(1400);
    expect(refusal(() => ventureFinance([{ sharePct: 60, periods: [] }, { sharePct: 30, periods: [] }])).detail).toBe('share_pct');
    expect(ventureFinance([{ sharePct: 100, periods: [period(2025, { verified: false })] }])).toEqual([]);
  });

  it('checks a period as it is entered', () => {
    const { verified: _verified, ...entry } = period(2025);
    expect(() => assertFinancialPeriod(entry)).not.toThrow();
    expect(refusal(() => assertFinancialPeriod({ ...entry, year: 1800 })).detail).toBe('fiscal_year');
    expect(refusal(() => assertFinancialPeriod({ ...entry, revenue: -1 })).detail).toBe('revenue');
    expect(refusal(() => assertFinancialPeriod({ ...entry, currentAssets: 300_000 })).detail).toBe('current_assets');
    expect(refusal(() => assertFinancialPeriod({ ...entry, ebit: 1.5 })).detail).toBe('ebit');
    expect(() => assertFinancialPeriod({ ...entry, ebit: -5000, equity: -1 })).not.toThrow();
  });

  it('reads the rule strictly', () => {
    expect(financePolicyOf({ ...policy })).toEqual(policy);
    expect(refusal(() => financePolicyOf({ ...policy, revenue_years: 0 })).detail).toBe('revenue_years');
  });
});

describe('load (V9)', () => {
  const policy = CAPACITY_POLICY_DEFAULTS;
  const facts = { openContractValue: 300, openContractCount: 2, lateContractCount: 0, pendingAwardValue: 100, pendingAwardCount: 1, averageAnnualRevenue: 200 };

  it('compares open work and awards not yet signed with the revenue', () => {
    expect(assessCapacity(facts, policy)).toEqual({ load: 400, loadMultiple: 2, limitMultiple: 3, signals: [], status: 'WITHIN' });
    expect(assessCapacity({ ...facts, openContractValue: 600 }, policy)).toMatchObject({ load: 700, loadMultiple: 3.5, signals: ['LOAD_OVER_REVENUE'], status: 'OVER' });
    expect(assessCapacity({ ...facts, openContractValue: 500 }, policy)).toMatchObject({ loadMultiple: 3, status: 'WITHIN' });
  });

  it('weights the awards not yet signed and counts late contracts', () => {
    expect(assessCapacity({ ...facts, pendingAwardValue: 400 }, { ...policy, pending_award_weight_pct: 50 }).load).toBe(500);
    expect(assessCapacity({ ...facts, lateContractCount: 3 }, policy)).toMatchObject({ signals: ['LATE_CONTRACTS'], status: 'OVER' });
    expect(assessCapacity({ ...facts, lateContractCount: 2 }, policy).status).toBe('WITHIN');
  });

  it('says there is no data rather than within when no revenue is known and nothing else is over', () => {
    expect(assessCapacity({ ...facts, averageAnnualRevenue: null }, policy)).toMatchObject({ loadMultiple: null, signals: ['NO_REVENUE_DATA'], status: 'NO_DATA' });
    expect(assessCapacity({ ...facts, averageAnnualRevenue: 0 }, policy).status).toBe('NO_DATA');
    expect(assessCapacity({ ...facts, averageAnnualRevenue: null, lateContractCount: 9 }, policy)).toMatchObject({ signals: ['NO_REVENUE_DATA', 'LATE_CONTRACTS'], status: 'OVER' });
  });

  it('reads the rule strictly', () => {
    expect(capacityPolicyOf({ ...policy })).toEqual(policy);
    expect(refusal(() => capacityPolicyOf({ ...policy, max_load_multiple_x100: 5 })).detail).toBe('max_load_multiple_x100');
  });
});

describe('bid security (V10)', () => {
  const policy = BID_SECURITY_POLICY_DEFAULTS;
  const reputation = { bid_security_multiplier: 3, multiplier_years: 2, award_confirmation_working_days: 3 };

  it('asks three times the base for a contractor with a posted event and holds the security past the validity of the bid', () => {
    const plain = requiredSecurity({ baseAmount: 1_000, bidValidUntil: '2026-12-31' }, [], '2026-11-08', reputation, policy);
    expect(plain).toMatchObject({ amount: 1_000, factor: 1, mustHoldUntil: '2027-01-30' });
    const posted = requiredSecurity({ baseAmount: 1_000, bidValidUntil: '2026-12-31' }, [{ id: 'e1', state: 'POSTED', postedOn: '2025-01-01' }], '2026-11-08', reputation, policy);
    expect(posted).toMatchObject({ amount: 3_000, factor: 3 });
    const old = requiredSecurity({ baseAmount: 1_000, bidValidUntil: '2026-12-31' }, [{ id: 'e1', state: 'POSTED', postedOn: '2024-11-07' }], '2026-11-08', reputation, policy);
    expect(old.factor).toBe(1);
    expect(refusal(() => requiredSecurity({ baseAmount: -1, bidValidUntil: '2026-12-31' }, [], '2026-11-08', reputation, policy)).detail).toBe('base_amount');
    expect(refusal(() => requiredSecurity({ baseAmount: 1, bidValidUntil: '2026-02-30' }, [], '2026-11-08', reputation, policy)).detail).toBe('bid_valid_until');
  });

  it('moves a security by the machine with the second person where it matters', () => {
    const context = { actor: 'u2', receivedBy: 'u1', forfeitProposedBy: null };
    expect(moveSecurity('RECEIVED', 'CONFIRM', context)).toBe('CONFIRMED');
    expect(refusal(() => moveSecurity('RECEIVED', 'CONFIRM', { ...context, actor: 'u1' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(moveSecurity('RECEIVED', 'REJECT', context)).toBe('REJECTED');
    expect(moveSecurity('CONFIRMED', 'PROPOSE_FORFEIT', context)).toBe('FORFEIT_PROPOSED');
    expect(moveSecurity('FORFEIT_PROPOSED', 'WITHDRAW_FORFEIT', context)).toBe('CONFIRMED');
    expect(refusal(() => moveSecurity('FORFEIT_PROPOSED', 'DECIDE_FORFEIT', { ...context, actor: 'u3', forfeitProposedBy: 'u3' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(moveSecurity('FORFEIT_PROPOSED', 'DECIDE_FORFEIT', { ...context, forfeitProposedBy: 'u3' })).toBe('FORFEITED');
    expect(moveSecurity('CONFIRMED', 'RELEASE', context)).toBe('RELEASED');
    expect(moveSecurity('CONFIRMED', 'EXPIRE', context)).toBe('EXPIRED');
    for (const state of ['FORFEITED', 'RELEASED', 'EXPIRED', 'REJECTED'] as const) expect(refusal(() => moveSecurity(state, 'RELEASE', context)).code).toBe('STAGE_TRANSITION_DENIED');
    expect(refusal(() => moveSecurity('CONFIRMED', 'CONFIRM', context)).code).toBe('STAGE_TRANSITION_DENIED');
    expect(refusal(() => moveSecurity('RECEIVED', 'PROPOSE_FORFEIT', context)).code).toBe('STAGE_TRANSITION_DENIED');
  });

  it('asks a paper, a reason of 20 characters and a reason of the law for a forfeiture', () => {
    expect(assertForfeiture({ reason: 'REFUSED_TO_SIGN', text: 'the winner refused to sign the contract', documentId: 'doc' })).toBe('REFUSED_TO_SIGN');
    expect(refusal(() => assertForfeiture({ reason: 'BECAUSE', text: 'the winner refused to sign the contract', documentId: 'doc' })).detail).toBe('reason_code');
    expect(refusal(() => assertForfeiture({ reason: 'REFUSED_TO_SIGN', text: 'short', documentId: 'doc' })).code).toBe('REASON_REQUIRED');
    expect(refusal(() => assertForfeiture({ reason: 'REFUSED_TO_SIGN', text: 'the winner refused to sign the contract', documentId: undefined })).detail).toBe('decision_document_id');
  });

  it('judges what was lodged against what is required, softening only the amount by the rule', () => {
    const required = requiredSecurity({ baseAmount: 1_000, bidValidUntil: '2026-12-31' }, [], '2026-11-08', reputation, policy);
    const good = { id: 's1', state: 'CONFIRMED' as const, amount: 1_000, validUntil: '2027-02-01', confirmed: true };
    expect(assessSecurity(required, [good], '2026-11-08', policy)).toEqual({ satisfied: true, gaps: [], enforcement: 'NONE', shortfall: 0 });
    expect(assessSecurity(required, [], '2026-11-08', policy)).toMatchObject({ gaps: ['MISSING'], enforcement: 'BLOCK', shortfall: 1_000 });
    expect(assessSecurity(required, [{ ...good, state: 'REJECTED' }], '2026-11-08', policy).gaps).toEqual(['REJECTED']);
    expect(assessSecurity(required, [{ ...good, confirmed: false, state: 'RECEIVED' }], '2026-11-08', policy).gaps).toEqual(['NOT_CONFIRMED']);
    expect(assessSecurity(required, [{ ...good, amount: 900 }], '2026-11-08', policy)).toMatchObject({ gaps: ['AMOUNT_BELOW'], enforcement: 'BLOCK', shortfall: 100 });
    expect(assessSecurity(required, [{ ...good, amount: 900 }], '2026-11-08', { ...policy, amount_below_enforcement: 'WARN' }).enforcement).toBe('WARN');
    expect(assessSecurity(required, [{ ...good, validUntil: '2027-01-29' }], '2026-11-08', policy).gaps).toEqual(['VALIDITY_SHORT']);
    expect(assessSecurity(required, [{ ...good, state: 'FORFEITED' }], '2026-11-08', policy).gaps).toEqual(['FORFEITED']);
    expect(assessSecurity(required, [{ ...good, validUntil: '2026-11-01' }], '2026-11-08', policy).gaps).toEqual(['EXPIRED', 'VALIDITY_SHORT']);
    // The best of several is what counts; confirmation can be switched off by the rule.
    expect(assessSecurity(required, [{ ...good, amount: 10 }, good], '2026-11-08', policy).satisfied).toBe(true);
    expect(assessSecurity(required, [{ ...good, confirmed: false }], '2026-11-08', { ...policy, require_confirmation: false }).satisfied).toBe(true);
  });

  it('warns before the end of a security that still matters', () => {
    const at = (validUntil: string, state: 'CONFIRMED' | 'RELEASED' = 'CONFIRMED') => securityExpiryFacet({ state, validUntil }, '2026-11-08', policy);
    expect(at('2026-11-23')).toBe('FIRST');
    expect(at('2026-11-24')).toBeNull();
    expect(at('2026-11-15')).toBe('SECOND');
    expect(at('2026-11-08')).toBe('SECOND');
    expect(at('2026-11-07')).toBe('EXPIRED');
    expect(at('2026-11-07', 'RELEASED')).toBeNull();
  });

  it('checks a security as it is received and reads the rule strictly', () => {
    const entry = { kind: 'BANK_GUARANTEE', amount: 1_000, issuer: 'Bank', number: 'G-1', issuedOn: '2026-11-01', validUntil: '2027-02-01' };
    expect(() => assertSecurityEntry(entry)).not.toThrow();
    expect(refusal(() => assertSecurityEntry({ ...entry, kind: 'PROMISE' })).detail).toBe('kind');
    expect(refusal(() => assertSecurityEntry({ ...entry, amount: 0 })).detail).toBe('amount');
    expect(refusal(() => assertSecurityEntry({ ...entry, validUntil: '2026-10-31' })).detail).toBe('valid_until');
    expect(refusal(() => assertSecurityEntry({ ...entry, issuer: ' ' })).detail).toBe('issuer');
    expect(bidSecurityPolicyOf({ ...policy })).toEqual(policy);
    expect(refusal(() => bidSecurityPolicyOf({ ...policy, second_warning_days: 99 })).detail).toBe('second_warning_days');
    expect(refusal(() => bidSecurityPolicyOf({ ...policy, amount_below_enforcement: 'MAYBE' })).detail).toBe('amount_below_enforcement');
  });
});

describe('subcontracts (V11)', () => {
  const policy = SUBCONTRACT_POLICY_DEFAULTS;
  const approved = (id: string, contractorId: string, sharePct: number) => ({ id, contractorId, value: sharePct * 10, sharePct, state: 'APPROVED' as const, exceptionApproved: false });
  const declaration = { declaredContractorIds: ['s1', 's2'], declaredSharePct: 30 };

  it('moves by the machine and asks another person to approve', () => {
    expect(moveSubcontract('PROPOSED', 'APPROVE', 'u2', 'u1')).toBe('APPROVED');
    expect(moveSubcontract('PROPOSED', 'REJECT', 'u2', 'u1')).toBe('REJECTED');
    expect(refusal(() => moveSubcontract('PROPOSED', 'APPROVE', 'u1', 'u1')).code).toBe('SELF_APPROVAL_DENIED');
    expect(moveSubcontract('PROPOSED', 'WITHDRAW', 'u1', 'u1')).toBe('REJECTED');
    expect(moveSubcontract('APPROVED', 'TERMINATE', 'u2', 'u1')).toBe('TERMINATED');
    expect(refusal(() => moveSubcontract('APPROVED', 'APPROVE', 'u2', 'u1')).code).toBe('STAGE_TRANSITION_DENIED');
    expect(refusal(() => moveSubcontract('TERMINATED', 'TERMINATE', 'u2', 'u1')).code).toBe('STAGE_TRANSITION_DENIED');
    expect(refusal(() => moveSubcontract('PROPOSED', 'TERMINATE', 'u2', 'u1')).code).toBe('STAGE_TRANSITION_DENIED');
  });

  it('accepts a named subcontractor within the declared share and keeps the prime above its floor', () => {
    const input = { contractValue: 1_000, primeContractorIds: ['p'], approved: [approved('a', 's2', 10)], proposal: { contractorId: 's1', value: 200, sharePct: 20 }, declaration };
    expect(assessSubcontract(input, policy)).toEqual({ findings: [], totalSharePct: 30, primeSharePct: 70, blocked: false, needsException: false });
    expect(assertSubcontractApproval(assessSubcontract(input, policy), undefined)).toEqual({ exception: false });
  });

  it('asks an exception for a share over the declaration or a subcontractor the bid did not name, and blocks when the rule says so', () => {
    const base = { contractValue: 1_000, primeContractorIds: ['p'], approved: [approved('a', 's2', 10)], declaration };
    const over = assessSubcontract({ ...base, proposal: { contractorId: 's1', value: 250, sharePct: 25 } }, policy);
    expect(over).toMatchObject({ findings: ['OVER_DECLARED_SHARE'], needsException: true, blocked: false, totalSharePct: 35 });
    expect(refusal(() => assertSubcontractApproval(over, 'too short')).code).toBe('REASON_REQUIRED');
    expect(assertSubcontractApproval(over, 'the owner agreed to the extra part in writing')).toEqual({ exception: true });
    const unnamed = assessSubcontract({ ...base, proposal: { contractorId: 'x', value: 100, sharePct: 10 } }, policy);
    expect(unnamed.findings).toEqual(['NOT_NAMED_IN_BID']);
    expect(assessSubcontract({ ...base, proposal: { contractorId: 'x', value: 100, sharePct: 10 } }, { ...policy, undeclared_subcontractor: 'BLOCK' }).blocked).toBe(true);
    expect(refusal(() => assertSubcontractApproval(assessSubcontract({ ...base, proposal: { contractorId: 'x', value: 100, sharePct: 10 } }, { ...policy, undeclared_subcontractor: 'BLOCK' }), 'a long reason that is enough for the rule')).code).toBe('SUBCONTRACT_LIMIT_EXCEEDED');
    expect(assessSubcontract({ ...base, proposal: { contractorId: 's1', value: 250, sharePct: 25 } }, { ...policy, over_declared: 'BLOCK' }).blocked).toBe(true);
    expect(assessSubcontract({ ...base, declaration: null, proposal: { contractorId: 's1', value: 100, sharePct: 10 } }, policy).findings).toEqual(['NOT_NAMED_IN_BID', 'OVER_DECLARED_SHARE']);
  });

  it('blocks the prime as its own subcontractor, a repeated subcontractor, a value that does not match the share and a prime below its floor', () => {
    const base = { contractValue: 1_000, primeContractorIds: ['p'], approved: [approved('a', 's2', 10)], declaration: { declaredContractorIds: ['p', 's2', 's1'], declaredSharePct: 90 } };
    expect(assessSubcontract({ ...base, proposal: { contractorId: 'p', value: 100, sharePct: 10 } }, policy)).toMatchObject({ findings: ['SAME_AS_PRIME'], blocked: true });
    expect(assessSubcontract({ ...base, proposal: { contractorId: 's2', value: 100, sharePct: 10 } }, policy).findings).toEqual(['DUPLICATE_SUBCONTRACTOR']);
    expect(assessSubcontract({ ...base, proposal: { contractorId: 's1', value: 500, sharePct: 10 } }, policy).findings).toEqual(['VALUE_SHARE_MISMATCH']);
    const floor = assessSubcontract({ ...base, proposal: { contractorId: 's1', value: 400, sharePct: 40 } }, policy);
    expect(floor).toMatchObject({ findings: ['PRIME_SHARE_BELOW_MINIMUM'], primeSharePct: 50, blocked: true });
    expect(refusal(() => assertSubcontractApproval(floor, undefined)).code).toBe('SUBCONTRACT_LIMIT_EXCEEDED');
  });

  it('clocks the record of what the prime paid and checks it', () => {
    const state = (requestPaidOn: string | null, recordedAt: Date | null, now: string, subcontractApproved = true) => paymentConfirmationState({ requestPaidOn, recordedAt, now: new Date(now), subcontractApproved }, policy);
    expect(state(null, null, '2026-11-08T00:00:00Z')).toBe('NOT_REQUIRED');
    expect(state('2026-11-01', null, '2026-11-08T00:00:00Z', false)).toBe('NOT_REQUIRED');
    expect(state('2026-11-01', null, '2026-11-05T00:00:00Z')).toBe('ON_TIME');
    expect(state('2026-11-01', null, '2026-11-13T00:00:00Z')).toBe('DUE_SOON');
    expect(state('2026-11-01', null, '2026-11-16T00:00:00Z')).toBe('OVERDUE');
    expect(state('2026-11-01', new Date('2026-11-10T00:00:00Z'), '2026-11-30T00:00:00Z')).toBe('MET');
    expect(state('2026-11-01', new Date('2026-11-20T00:00:00Z'), '2026-11-30T00:00:00Z')).toBe('MET_LATE');
    expect(() => assertSubcontractPayment({ paidAmount: 10, paidOn: '2026-11-01', reference: 'UNC-1' })).not.toThrow();
    expect(refusal(() => assertSubcontractPayment({ paidAmount: 0, paidOn: '2026-11-01', reference: 'UNC-1' })).detail).toBe('paid_amount');
    expect(refusal(() => assertSubcontractPayment({ paidAmount: 1, paidOn: '2026-13-01', reference: 'UNC-1' })).detail).toBe('paid_on');
    expect(refusal(() => assertSubcontractPayment({ paidAmount: 1, paidOn: '2026-11-01', reference: 'x' })).detail).toBe('reference');
    expect(paidExcess(100, [60, 50])).toBe(10);
    expect(paidExcess(100, [60])).toBe(0);
    expect(subcontractPolicyOf({ ...policy })).toEqual(policy);
    expect(refusal(() => subcontractPolicyOf({ ...policy, over_declared: 'ALLOW' })).detail).toBe('over_declared');
  });
});

describe('risk grade (V13)', () => {
  const policy = RISK_POLICY_DEFAULTS;
  const clean: RiskInputs = { profileCoveragePct: 100, restrictionsInForce: 0, restrictionsPast: 0, reputationEventsPosted: 0, qualificationsLapsed: 0, payeeAlerts: 0, poorRatingsConsecutive: 0, financeStatus: 'MEETS', loadStatus: 'WITHIN', openStrongFindings: 0, subcontractBreaches: 0, securityForfeits: 0 };

  it('grades a clean contractor LOW with no reason and the review months of its tier', () => {
    const grade = gradeRisk(clean, policy);
    expect(grade).toMatchObject({ score: 0, tier: 'LOW', scoreTier: 'LOW', floored: false, reasons: [], reviewMonths: 24, dualCheck: false });
    expect(grade.factors).toHaveLength(RISK_FACTORS.length);
  });

  it('adds the points of each factor by its own rule, golden', () => {
    const grade = gradeRisk({ ...clean, profileCoveragePct: 50, reputationEventsPosted: 2, qualificationsLapsed: 1, payeeAlerts: 3, poorRatingsConsecutive: 2, financeStatus: 'INSUFFICIENT_DATA', loadStatus: 'OVER', openStrongFindings: 1, subcontractBreaches: 3, securityForfeits: 1 }, policy);
    const points = Object.fromEntries(grade.factors.map((one) => [one.factor, one.points]));
    expect(points).toEqual({ PROFILE_GAP: 5, RESTRICTION: 0, REPUTATION_EVENTS: 10, QUALIFICATION_LAPSE: 3, PAYEE_ALERT: 10, POOR_PERFORMANCE: 13, FINANCE_BELOW: 5, LOAD_OVER: 5, OPEN_FINDINGS: 5, SUBCONTRACT_BREACH: 10, SECURITY_FORFEIT: 5 });
    expect(grade.score).toBe(71);
    expect(grade).toMatchObject({ tier: 'CRITICAL', reviewMonths: 3, dualCheck: true });
    expect(grade.reasons[0]).toBe('POOR_PERFORMANCE');
  });

  it('counts an unknown coverage as a gap and a past restriction as a third of its weight', () => {
    expect(gradeRisk({ ...clean, profileCoveragePct: null }, policy).score).toBe(10);
    expect(gradeRisk({ ...clean, restrictionsPast: 2 }, policy).score).toBe(13);
  });

  it('sets the tiers at the cut points', () => {
    const at = (score: number) => gradeRisk({ ...clean, profileCoveragePct: 100 - score * 10 }, { ...policy, weights: { ...policy.weights, PROFILE_GAP: 10 } }).scoreTier;
    expect(at(0)).toBe('LOW');
    const withScore = (points: number) => gradeRisk({ ...clean, restrictionsPast: 0 }, { ...policy, medium_from: 20, high_from: 45, critical_from: 70, weights: { ...policy.weights, PROFILE_GAP: 100 } }).tier && gradeRisk({ ...clean, profileCoveragePct: 100 - points }, { ...policy, weights: { ...policy.weights, PROFILE_GAP: 100 } });
    expect(withScore(19)).toMatchObject({ score: 19, tier: 'LOW' });
    expect(withScore(20)).toMatchObject({ score: 20, tier: 'MEDIUM' });
    expect(withScore(44)).toMatchObject({ score: 44, tier: 'MEDIUM', dualCheck: false });
    expect(withScore(45)).toMatchObject({ score: 45, tier: 'HIGH', dualCheck: true });
    expect(withScore(70)).toMatchObject({ score: 70, tier: 'CRITICAL' });
  });

  it('keeps the floor of a restriction in force whatever the score', () => {
    const grade = gradeRisk({ ...clean, restrictionsInForce: 1 }, { ...policy, weights: { ...policy.weights, RESTRICTION: 5 } });
    expect(grade).toMatchObject({ score: 5, scoreTier: 'LOW', tier: 'HIGH', floored: true, reviewMonths: 6, dualCheck: true });
    expect(gradeRisk({ ...clean, restrictionsInForce: 1 }, { ...policy, restriction_floor: 'CRITICAL' }).tier).toBe('CRITICAL');
  });

  it('asks a second person to confirm a grade that needs a dual check and a reason to reject', () => {
    const ok = { decision: 'CONFIRM' as const, reason: undefined, decidedBy: 'u2', assessedBy: 'u1', dualCheck: true, state: 'PROPOSED' as const };
    expect(() => assertRiskDecision(ok)).not.toThrow();
    expect(refusal(() => assertRiskDecision({ ...ok, decidedBy: 'u1' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(() => assertRiskDecision({ ...ok, decidedBy: 'u1', dualCheck: false })).not.toThrow();
    expect(refusal(() => assertRiskDecision({ ...ok, decision: 'REJECT' })).code).toBe('REASON_REQUIRED');
    expect(() => assertRiskDecision({ ...ok, decision: 'REJECT', reason: 'the licence data were from the wrong year' })).not.toThrow();
    expect(refusal(() => assertRiskDecision({ ...ok, state: 'CONFIRMED' as never })).code).toBe('STAGE_TRANSITION_DENIED');
  });

  it('puts the next review day by months, clamped to a short month and backwards for a window', () => {
    expect(nextReviewOn('2026-11-08', 6)).toBe('2027-05-08');
    expect(nextReviewOn('2026-08-31', 6)).toBe('2027-02-28');
    expect(nextReviewOn('2027-08-31', 6)).toBe('2028-02-29');
    expect(nextReviewOn('2026-11-08', -36)).toBe('2023-11-08');
  });

  it('round trips the flat params of the registry and refuses weak orders', () => {
    expect(riskPolicyOf(riskParamsOf(policy))).toEqual(policy);
    expect(refusal(() => riskPolicyOf({ ...riskParamsOf(policy), high_from: 10 })).detail).toBe('high_from');
    expect(refusal(() => riskPolicyOf({ ...riskParamsOf(policy), restriction_floor: 'NONE' })).detail).toBe('restriction_floor');
    expect(refusal(() => riskPolicyOf({ ...riskParamsOf(policy), weight_profile_gap: 101 })).detail).toBe('weight_profile_gap');
  });
});

describe('performance (V4)', () => {
  const policy = PERFORMANCE_POLICY_DEFAULTS;

  it('counts six months from the end of the contract and keeps the due day in time', () => {
    expect(publicationDueOn('2026-03-31', policy)).toBe('2026-09-30');
    expect(publicationClock({ dueOn: '2026-09-30', postedOn: null, today: '2026-09-30' }, policy)).toBe('DUE_SOON');
    expect(publicationClock({ dueOn: '2026-09-30', postedOn: null, today: '2026-10-01' }, policy)).toBe('OVERDUE');
    expect(publicationClock({ dueOn: '2026-09-30', postedOn: null, today: '2026-08-31' }, policy)).toBe('DUE_SOON');
    expect(publicationClock({ dueOn: '2026-09-30', postedOn: null, today: '2026-08-30' }, policy)).toBe('ON_TIME');
    expect(publicationClock({ dueOn: '2026-09-30', postedOn: '2026-09-30', today: '2026-12-01' }, policy)).toBe('MET');
    expect(publicationClock({ dueOn: '2026-09-30', postedOn: '2026-10-02', today: '2026-12-01' }, policy)).toBe('MET_LATE');
  });

  it('gives the investor 20 days to examine an answer, from the day it was received', () => {
    const at = (answeredOn: string | null, adopted: boolean, today: string) => responseReviewClock({ answeredOn, adopted, today }, policy);
    expect(at(null, false, '2026-11-08')).toBe('NOT_ANSWERED');
    expect(at('2026-11-01', false, '2026-11-08')).toBe('WITHIN_REVIEW');
    expect(at('2026-11-01', false, '2026-11-16')).toBe('DUE_SOON');
    expect(at('2026-11-01', false, '2026-11-21')).toBe('DUE_SOON');
    expect(at('2026-11-01', false, '2026-11-22')).toBe('OVERDUE');
    expect(at('2026-11-01', true, '2026-12-30')).toBe('CLOSED');
  });

  it('counts consecutive poor ratings from the latest and suggests, never acts', () => {
    const rated = (day: string, rating: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR', id = day) => ({ contractId: id, adoptedOn: day, rating, score: null, construction: true });
    expect(poorStreak([])).toBe(0);
    expect(poorStreak([rated('2024-01-01', 'POOR'), rated('2025-01-01', 'GOOD'), rated('2026-01-01', 'POOR')])).toBe(1);
    expect(poorStreak([rated('2025-01-01', 'GOOD'), rated('2026-01-01', 'POOR'), rated('2026-06-01', 'POOR'), rated('2026-09-01', 'POOR')])).toBe(3);
    expect(streakSuggestion(1, policy)).toBe('NONE');
    expect(streakSuggestion(2, policy)).toBe('REMEDY_PLAN');
    expect(streakSuggestion(3, policy)).toBe('PROPOSE_RESTRICTION');
  });

  it('looks back 3 years, 6 for construction', () => {
    const history = [
      { contractId: 'a', adoptedOn: '2023-11-08', rating: 'GOOD' as const, score: null, construction: false },
      { contractId: 'b', adoptedOn: '2023-11-07', rating: 'GOOD' as const, score: null, construction: false },
      { contractId: 'c', adoptedOn: '2020-11-08', rating: 'GOOD' as const, score: null, construction: true },
      { contractId: 'd', adoptedOn: '2020-11-07', rating: 'GOOD' as const, score: null, construction: true },
    ];
    expect(withinRetrospect(history, '2026-11-08', policy).map((one) => one.contractId)).toEqual(['a', 'c']);
  });

  it('asks another person to post, with a receipt, and reads the rule strictly', () => {
    expect(assertPublication({ kind: 'INITIAL', receipt: 'BN-2026-0001', postedBy: 'u2', adoptedBy: 'u1' })).toBe('INITIAL');
    expect(refusal(() => assertPublication({ kind: 'INITIAL', receipt: 'BN-1', postedBy: 'u1', adoptedBy: 'u1' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(refusal(() => assertPublication({ kind: 'INITIAL', receipt: 'x', postedBy: 'u2', adoptedBy: 'u1' })).detail).toBe('receipt');
    expect(refusal(() => assertPublication({ kind: 'LATER', receipt: 'BN-1', postedBy: 'u2', adoptedBy: 'u1' })).detail).toBe('kind');
    expect(performancePolicyOf({ ...policy })).toEqual(policy);
    expect(refusal(() => performancePolicyOf({ ...policy, poor_streak_restriction: 1 })).detail).toBe('poor_streak_restriction');
  });
});

describe('rule registry of VND-2', () => {
  it('registers the seven rule types with provenance and every default flagged unverified', () => {
    const types = ruleTypeDefinitions().filter((one) => ['VENDOR_INDEPENDENCE', 'VENDOR_FINANCE', 'VENDOR_CAPACITY', 'VENDOR_BID_SECURITY', 'VENDOR_SUBCONTRACT', 'VENDOR_RISK', 'VENDOR_PERFORMANCE'].includes(one.type));
    expect(types.map((one) => one.type).sort()).toEqual(['VENDOR_BID_SECURITY', 'VENDOR_CAPACITY', 'VENDOR_FINANCE', 'VENDOR_INDEPENDENCE', 'VENDOR_PERFORMANCE', 'VENDOR_RISK', 'VENDOR_SUBCONTRACT']);
    for (const one of types) {
      expect(one.legalStatus).toBe('UNVERIFIED');
      expect(one.formula.length).toBeGreaterThan(20);
      expect(one.source).toContain('Điều');
      expect(one.defaults.DEFAULT?.unverified).toBe(true);
    }
  });

  it('keeps each built-in default equal to the kernel default it spreads', () => {
    expect(builtInDefault('VENDOR_INDEPENDENCE', 'DEFAULT')?.params).toEqual(INDEPENDENCE_POLICY_DEFAULTS);
    expect(builtInDefault('VENDOR_FINANCE', 'DEFAULT')?.params).toEqual(FINANCE_POLICY_DEFAULTS);
    expect(builtInDefault('VENDOR_CAPACITY', 'DEFAULT')?.params).toEqual(CAPACITY_POLICY_DEFAULTS);
    expect(builtInDefault('VENDOR_BID_SECURITY', 'DEFAULT')?.params).toEqual(BID_SECURITY_POLICY_DEFAULTS);
    expect(builtInDefault('VENDOR_SUBCONTRACT', 'DEFAULT')?.params).toEqual(SUBCONTRACT_POLICY_DEFAULTS);
    expect(builtInDefault('VENDOR_PERFORMANCE', 'DEFAULT')?.params).toEqual(PERFORMANCE_POLICY_DEFAULTS);
    expect(riskPolicyOf(builtInDefault('VENDOR_RISK', 'DEFAULT')?.params)).toEqual(RISK_POLICY_DEFAULTS);
  });

  it('registers the alert types with owner, expected action and consequence and the indicators with their numerator', () => {
    const codes = ['VENDOR_INDEPENDENCE_FINDING', 'VENDOR_SECURITY_EXPIRY', 'VENDOR_SUBCONTRACT_BREACH', 'VENDOR_SUB_PAYMENT_CONFIRM', 'VENDOR_PERFORMANCE_PUBLISH', 'VENDOR_PERFORMANCE_RESPONSE', 'VENDOR_POOR_STREAK', 'VENDOR_CAPACITY_FINANCE', 'VENDOR_RISK_REVIEW'];
    for (const code of codes) {
      const params = builtInDefault('ALERT_TYPE', code)?.params as Record<string, unknown>;
      expect(params.source).toBe('VENDOR');
      expect(String(params.owner).length).toBeGreaterThan(3);
      expect(String(params.expected_action).length).toBeGreaterThan(20);
      expect(String(params.consequence).length).toBeGreaterThan(20);
    }
    for (const code of ['VENDOR_INDEPENDENCE_CHECKED', 'VENDOR_RISK_REVIEW_IN_TIME', 'VENDOR_HIGH_RISK_CONTRACTORS', 'VENDOR_PERFORMANCE_PUBLISHED_IN_TIME', 'VENDOR_RESPONSE_REVIEWED_IN_TIME', 'VENDOR_SECURITY_CONFIRMED', 'VENDOR_SUB_PAYMENT_CONFIRMED']) {
      const one = builtInDefault('KPI_DEFINITION', code);
      expect(one?.unverified).toBe(true);
      expect(String((one?.params as Record<string, unknown>).numerator).length).toBeGreaterThan(5);
    }
  });
});
