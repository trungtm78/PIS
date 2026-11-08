import { DomainError } from '../src/errors';
import {
  DEBARMENT_POLICY_DEFAULTS,
  DUPLICATE_PARAM_DEFAULTS,
  EXPIRY_WARNING_DEFAULTS,
  GATE_CHECKS_BY_ACTION,
  GATE_POLICY_DEFAULTS,
  PAYEE_ACCOUNT_DEFAULTS,
  REPUTATION_POLICY_DEFAULTS,
  VENDOR_PROFILE_DEFAULTS,
  assertBanPeriod,
  assertOwnersCoherent,
  assertValidityPeriod,
  assertVentureShares,
  assertWithinLimitation,
  banLastDay,
  banMonthsRange,
  bankChangeProgress,
  bidSecurityFactor,
  builtInDefault,
  checkTaxCode,
  clockAlertFacet,
  deadlineClock,
  debarmentPolicyOf,
  duplicatePairOf,
  duplicateSuggestionMove,
  duplicateWeightsOf,
  dueFrom,
  effectiveAfterOf,
  escalationSuggestion,
  expiryPolicyOf,
  expiryState,
  foldForMatch,
  gatePolicyOf,
  holderMatchesLegalName,
  matchKeyOf,
  moveBankChange,
  moveReputationEvent,
  moveRestrictionCase,
  normaliseAccountNumber,
  normaliseAddress,
  normaliseEmail,
  normalisePhoneNumber,
  payeeAccountPolicyOf,
  payeeVerdict,
  profileCoverage,
  qualificationFindings,
  reputationPolicyOf,
  scoreDuplicate,
  validateRuleParams,
  vendorProfilePolicyOf,
  ventureMembersReached,
} from '../src/index';
import type { BankChangeFacts, DebarmentPeriod, DuplicateFacts, HeldQualification, PayeeAccountFacts, RestrictionCaseFacts } from '../src/index';
import type { WorkCalendarContent } from '../src/working-time.ts';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};
const codeOf = (run: () => unknown): string => {
  const error = refusal(run);
  return error.detail === undefined ? error.code : `${error.code}:${error.detail}`;
};

const calendar = (year: number, holidays: string[] = []): WorkCalendarContent => ({ calendar_code: 'VN', year, working_days: [1, 2, 3, 4, 5], holidays: holidays.map((date) => ({ date, name: 'Holiday' })), legal_basis_ref: 'test' });
const calendars = { forYear: (year: number): WorkCalendarContent | undefined => (year === 2026 ? calendar(2026, ['2026-11-09']) : year === 2027 ? calendar(2027) : undefined) };

describe('the tax code and the normal forms', () => {
  it('judges the form decisively and the check digit as a signal only', () => {
    expect(checkTaxCode('0101234567')).toMatchObject({ format: 'VALID', normalised: '0101234567', head: '0101234567', branch: null, checksumLegalStatus: 'UNVERIFIED' });
    expect(checkTaxCode('0101234567001')).toMatchObject({ format: 'VALID', normalised: '0101234567-001', branch: '001' });
    expect(checkTaxCode(' 0101 234 567-001 ').normalised).toBe('0101234567-001');
    expect(checkTaxCode('12345')).toMatchObject({ format: 'INVALID', normalised: null, checksum: 'NOT_CHECKED' });
    // 0100109106: sum 0*31 + 1*29 + 0 + 0 + 1*17 + 0 + 9*13 + 1*7 + 0 + 6*0 -> the check is a plain computation both ways.
    const matches = ['0100109106', '0101234567', '0300000000'].map((code) => checkTaxCode(code).checksum);
    expect(matches.every((value) => value === 'MATCH' || value === 'MISMATCH')).toBe(true);
    expect(checkTaxCode('0101234567').checksum).toBe('MATCH');
    expect(checkTaxCode('0101234568').checksum).toBe('MISMATCH');
  });

  it('folds texts, addresses, numbers and addresses of e-mail to one form', () => {
    expect(foldForMatch('  CÔNG TY ĐẦU TƯ, Ltd. ')).toBe('cong ty dau tu ltd');
    expect(normaliseAddress('12 Le Loi, Quan 1')).toBe('12 le loi quan 1');
    expect(normaliseAddress('Q1')).toBeNull();
    expect(normalisePhoneNumber('+84 912 345 678')).toBe('0912345678');
    expect(normalisePhoneNumber('0912.345.678')).toBe('0912345678');
    expect(normalisePhoneNumber('12')).toBeNull();
    expect(normaliseEmail(' Contact@Firm.VN ')).toEqual({ address: 'contact@firm.vn', domain: 'firm.vn' });
    expect(normaliseEmail('not an address')).toBeNull();
    expect(matchKeyOf('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(matchKeyOf('abc')).toBe(matchKeyOf('abc'));
  });
});

describe('the completeness of a profile and the owners', () => {
  const complete = { legalRepName: 'Nguyen Van A', registeredAddress: '1 Le Loi', phone: '0912345678', email: null, businessRegistrationNo: null, ownerCount: 1, ownershipDeclaration: null } as const;

  it('counts the fields the policy asks for and says which are missing', () => {
    const required = VENDOR_PROFILE_DEFAULTS.required_before_bid;
    expect(profileCoverage(complete, required)).toMatchObject({ complete: true, coveragePct: 100, missing: [] });
    const partial = profileCoverage({ ...complete, legalRepName: null, ownerCount: 0 }, required);
    expect(partial).toMatchObject({ complete: false, coveragePct: 50, missing: ['LEGAL_REPRESENTATIVE', 'OWNERSHIP'] });
    expect(profileCoverage({ ...complete, ownerCount: 0, ownershipDeclaration: 'NO_OWNER_ABOVE_THRESHOLD' }, required).complete).toBe(true);
    expect(profileCoverage({ ...complete, phone: null, email: 'a@b.vn' }, required).complete).toBe(true);
    expect(profileCoverage({ ...complete, phone: null }, required).missing).toEqual(['CONTACT']);
    expect(profileCoverage({ ...complete, legalRepName: null }, []).coveragePct).toBe(100);
  });

  it('refuses owners that do not make sense as a set', () => {
    const owner = { kind: 'PERSON', name: 'Tran Thi B', sharePct: '60', beneficialOwner: true, controlBasis: null } as const;
    expect(() => assertOwnersCoherent([owner, { ...owner, name: 'Le C', sharePct: '40' }])).not.toThrow();
    expect(codeOf(() => assertOwnersCoherent([owner, { ...owner, name: 'Le C', sharePct: '45' }]))).toBe('VALIDATION_FAILED:owners.share_pct');
    expect(codeOf(() => assertOwnersCoherent([{ ...owner, sharePct: '101' }]))).toBe('VALIDATION_FAILED:owners[0].share_pct');
    expect(codeOf(() => assertOwnersCoherent([{ ...owner, sharePct: null }]))).toBe('VALIDATION_FAILED:owners[0].control_basis');
    expect(() => assertOwnersCoherent([{ ...owner, sharePct: null, controlBasis: 'APPOINTS_MANAGEMENT' }])).not.toThrow();
    expect(codeOf(() => assertOwnersCoherent([{ ...owner, name: ' ' }]))).toBe('VALIDATION_FAILED:owners[0].name');
  });
});

describe('the signals that two contractors are one party', () => {
  const base: DuplicateFacts = { taxHead: '0101234567', name: 'Cong ty A', addressKey: 'a1', phoneKey: 'p1', emailKey: null, legalRepKey: 'r1', ownerKeys: ['o1'], bankAccountKeys: ['b1'] };
  const weights = duplicateWeightsOf(DUPLICATE_PARAM_DEFAULTS);

  it('adds the weights of the signals found and suggests a merge from the line', () => {
    expect(scoreDuplicate(base, { ...base, name: 'Another firm', addressKey: 'x', phoneKey: 'y', legalRepKey: 'z', ownerKeys: [], bankAccountKeys: [] }, weights)).toMatchObject({ signals: ['TAX_HEAD'], suggested: true });
    const hint = scoreDuplicate(base, { taxHead: '0999999999', name: 'Beta', addressKey: 'a1', phoneKey: null, emailKey: null, legalRepKey: null, ownerKeys: [], bankAccountKeys: [] }, weights);
    expect(hint).toMatchObject({ signals: ['ADDRESS'], score: 40, suggested: false });
    const two = scoreDuplicate(base, { taxHead: '0999999999', name: 'Beta', addressKey: 'a1', phoneKey: 'p1', emailKey: null, legalRepKey: null, ownerKeys: [], bankAccountKeys: [] }, weights);
    expect(two).toMatchObject({ signals: ['ADDRESS', 'PHONE'], score: 75, suggested: true });
    expect(scoreDuplicate(base, { ...base, taxHead: '0999999999', name: 'Zeta', addressKey: null, phoneKey: null, legalRepKey: null, ownerKeys: [], bankAccountKeys: ['b1'] }, weights).signals).toEqual(['BANK_ACCOUNT']);
    expect(scoreDuplicate(base, { ...base, taxHead: null, addressKey: null, phoneKey: null, legalRepKey: null, ownerKeys: [], bankAccountKeys: [], name: 'Cong ty A' }, weights).signals).toEqual(['NAME']);
  });

  it('never matches two empty keys and keeps a pair in one order', () => {
    const empty: DuplicateFacts = { taxHead: null, name: 'x', addressKey: null, phoneKey: null, emailKey: null, legalRepKey: null, ownerKeys: [], bankAccountKeys: [] };
    expect(scoreDuplicate(empty, { ...empty, name: 'y' }, weights)).toMatchObject({ score: 0, signals: [], suggested: false });
    expect(duplicatePairOf('b', 'a')).toEqual(['a', 'b']);
    expect(duplicatePairOf('a', 'b')).toEqual(['a', 'b']);
  });

  it('decides a suggestion once', () => {
    expect(() => duplicateSuggestionMove('OPEN', 'DISMISSED')).not.toThrow();
    expect(codeOf(() => duplicateSuggestionMove('DISMISSED', 'MERGE_REQUESTED'))).toBe('STAGE_TRANSITION_DENIED:status');
  });

  it('reads its params and refuses a missing weight', () => {
    expect(weights.suggest_from).toBe(60);
    expect(weights.name_similarity_from).toBe(0.8);
    expect(codeOf(() => duplicateWeightsOf({ ...DUPLICATE_PARAM_DEFAULTS, weight_owner: 101 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:weight_owner');
  });
});

describe('the accounts a contractor is paid into', () => {
  const policy = PAYEE_ACCOUNT_DEFAULTS;
  const t0 = new Date('2026-11-02T08:00:00Z');
  const open: BankChangeFacts = { state: 'REQUESTED', requestedBy: 'req', requestedAt: t0, expiresAt: new Date('2026-12-02T08:00:00Z'), contractMatchBy: null, accountMatchBy: null, callbackBy: null, callbackOutcome: null, nameMatch: true };
  const call = (by: string, extra: Partial<{ outcome: 'CONFIRMED' | 'NOT_CONFIRMED'; usedNumberOnFile: boolean; numberMatchesFile: boolean; numberOnFileSince: Date | null; at: Date }> = {}) =>
    ({ move: 'CALLBACK', by, at: extra.at ?? new Date('2026-11-03T08:00:00Z'), outcome: extra.outcome ?? 'CONFIRMED', usedNumberOnFile: extra.usedNumberOnFile ?? true, numberMatchesFile: extra.numberMatchesFile ?? true, numberOnFileSince: extra.numberOnFileSince === undefined ? new Date('2026-01-01T00:00:00Z') : extra.numberOnFileSince }) as const;

  it('compares the holder with the legal name and normalises the number', () => {
    expect(holderMatchesLegalName('CONG TY TNHH  A', 'Cong ty TNHH A')).toBe(true);
    expect(holderMatchesLegalName('Nguyen Van A', 'Cong ty TNHH A')).toBe(false);
    expect(holderMatchesLegalName('', '')).toBe(false);
    expect(normaliseAccountNumber(' 0011 0022-3344 ')).toBe('001100223344');
    expect(codeOf(() => normaliseAccountNumber('12'))).toBe('VALIDATION_FAILED:account_number');
  });

  it('activates only when two people in two roles and a call have confirmed, in any order', () => {
    let step = moveBankChange(open, { move: 'APPROVE', role: 'ACCOUNT_MATCH', by: 'acc', at: t0 }, policy);
    expect(step.activated).toBe(false);
    expect(bankChangeProgress(step.facts)).toEqual(['CONTRACT_MATCH', 'CALLBACK']);
    step = moveBank(step.facts, call('caller'));
    expect(step.activated).toBe(false);
    step = moveBank(step.facts, { move: 'APPROVE', role: 'CONTRACT_MATCH', by: 'con', at: t0 });
    expect(step).toMatchObject({ activated: true, autoRejected: false });
    expect(step.facts.state).toBe('ACTIVATED');
    expect(bankChangeProgress(step.facts)).toEqual([]);
  });

  function moveBank(facts: BankChangeFacts, move: Parameters<typeof moveBankChange>[1]) {
    return moveBankChange(facts, move, policy);
  }

  it('refuses the requester in every role and the same person in both roles', () => {
    expect(refusal(() => moveBank(open, { move: 'APPROVE', role: 'CONTRACT_MATCH', by: 'req', at: t0 })).code).toBe('SELF_APPROVAL_DENIED');
    expect(refusal(() => moveBank(open, call('req'))).code).toBe('SELF_APPROVAL_DENIED');
    const first = moveBank(open, { move: 'APPROVE', role: 'CONTRACT_MATCH', by: 'a', at: t0 }).facts;
    expect(refusal(() => moveBank(first, { move: 'APPROVE', role: 'ACCOUNT_MATCH', by: 'a', at: t0 })).code).toBe('SELF_APPROVAL_DENIED');
    expect(codeOf(() => moveBank(first, { move: 'APPROVE', role: 'CONTRACT_MATCH', by: 'b', at: t0 }))).toBe('BANK_CHANGE_STATE_INVALID:status');
    expect(refusal(() => moveBank(open, { move: 'CANCEL', by: 'other', at: t0, reason: 'x' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(moveBank(open, { move: 'CANCEL', by: 'req', at: t0, reason: 'asked by mistake' }).facts.state).toBe('CANCELLED');
  });

  it('accepts a call only to the number on file, old enough, and rejects the request when it is not confirmed', () => {
    expect(codeOf(() => moveBank(open, call('c', { usedNumberOnFile: false })))).toBe('BANK_CHANGE_CALLBACK_INVALID:called_number');
    expect(refusal(() => moveBank(open, call('c', { numberMatchesFile: false }))).extensions).toMatchObject({ reason: 'NUMBER_NOT_ON_FILE' });
    expect(refusal(() => moveBank(open, call('c', { numberOnFileSince: new Date('2026-11-01T00:00:00Z') }))).extensions).toMatchObject({ reason: 'NUMBER_TOO_RECENT', min_age_days: 7 });
    expect(refusal(() => moveBank(open, call('c', { numberOnFileSince: null }))).extensions).toMatchObject({ reason: 'NUMBER_TOO_RECENT' });
    const refused = moveBank(open, call('c', { outcome: 'NOT_CONFIRMED' }));
    expect(refused).toMatchObject({ autoRejected: true, activated: false });
    expect(refused.facts.state).toBe('REJECTED');
  });

  it('refuses a move after the request ran out, except cancel and reject, and on a request that is closed', () => {
    const late = new Date('2026-12-03T08:00:00Z');
    expect(codeOf(() => moveBank(open, { move: 'APPROVE', role: 'CONTRACT_MATCH', by: 'a', at: late }))).toBe('BANK_CHANGE_STATE_INVALID:status');
    expect(moveBank(open, { move: 'REJECT', by: 'a', at: late, reason: 'ran out' }).facts.state).toBe('REJECTED');
    expect(codeOf(() => moveBank({ ...open, state: 'ACTIVATED' }, { move: 'REJECT', by: 'a', at: t0, reason: 'x' }))).toBe('BANK_CHANGE_STATE_INVALID:status');
  });

  it('blocks a payment while the account is not valid, and says why', () => {
    const now = new Date('2026-11-10T08:00:00Z');
    const old: PayeeAccountFacts = { id: 'old', state: 'SUPERSEDED', effectiveAfter: new Date('2026-01-01T00:00:00Z'), supersededById: 'new', supersededAt: new Date('2026-11-09T08:00:00Z') };
    const fresh: PayeeAccountFacts = { id: 'new', state: 'ACTIVE', effectiveAfter: effectiveAfterOf(new Date('2026-11-09T08:00:00Z'), policy), supersededById: null, supersededAt: null };
    expect(effectiveAfterOf(new Date('2026-11-09T08:00:00Z'), policy).toISOString()).toBe('2026-11-12T08:00:00.000Z');
    expect(payeeVerdict([old, fresh], false, now, policy)).toMatchObject({ allowed: false, reason: 'IN_WAITING_PERIOD', validFrom: '2026-11-12' });
    expect(payeeVerdict([old, fresh], false, now, { ...policy, old_account_pays_during_wait: true })).toMatchObject({ allowed: true, accountId: 'old' });
    expect(payeeVerdict([old, fresh], false, new Date('2026-11-12T08:00:00Z'), policy)).toMatchObject({ allowed: true, accountId: 'new' });
    expect(payeeVerdict([old, fresh], true, new Date('2026-11-12T09:00:00Z'), policy).warnings).toEqual(['PAYEE_CHANGE_PENDING']);
    expect(payeeVerdict([{ ...old, state: 'CLOSED' }], false, now, policy)).toMatchObject({ allowed: false, reason: 'NO_VALID_ACCOUNT' });
  });

  it('warns about a contractor that never had an account unless the policy requires one', () => {
    const now = new Date('2026-11-10T08:00:00Z');
    expect(payeeVerdict([], false, now, PAYEE_ACCOUNT_DEFAULTS)).toMatchObject({ allowed: true, warnings: ['PAYEE_ACCOUNT_NOT_REGISTERED'], accountId: null });
    expect(payeeVerdict([], false, now, { ...PAYEE_ACCOUNT_DEFAULTS, require_registered_account: true })).toMatchObject({ allowed: false, reason: 'NO_ACCOUNT_REGISTERED' });
  });

  it('reads the params of its rule', () => {
    expect(payeeAccountPolicyOf(PAYEE_ACCOUNT_DEFAULTS)).toEqual(PAYEE_ACCOUNT_DEFAULTS);
    expect(codeOf(() => payeeAccountPolicyOf({ ...PAYEE_ACCOUNT_DEFAULTS, name_match: 'MAYBE' }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:name_match');
    expect(codeOf(() => payeeAccountPolicyOf({ ...PAYEE_ACCOUNT_DEFAULTS, waiting_hours: -1 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:waiting_hours');
  });
});

describe('certificates and key staff', () => {
  const policy = EXPIRY_WARNING_DEFAULTS;
  const held = (patch: Partial<HeldQualification> = {}): HeldQualification => ({ id: 'q1', kind: 'CONSTRUCTION_ACTIVITY', grade: 'II', scope: 'Civil and industrial works', period: { issuedOn: '2025-01-01', expiresOn: '2027-01-31', revoked: false }, verified: true, ...patch });

  it('moves through the warnings 60 and 30 days before the end and on the day after', () => {
    const period = { issuedOn: '2025-01-01', expiresOn: '2026-12-31', revoked: false };
    expect(expiryState(period, '2026-10-01', policy)).toBe('VALID');
    expect(expiryState(period, '2026-11-01', policy)).toBe('EXPIRING_FIRST');
    expect(expiryState(period, '2026-12-01', policy)).toBe('EXPIRING_SECOND');
    expect(expiryState(period, '2026-12-31', policy)).toBe('EXPIRING_SECOND');
    expect(expiryState(period, '2027-01-01', policy)).toBe('EXPIRED');
    expect(expiryState({ ...period, expiresOn: null }, '2030-01-01', policy)).toBe('VALID');
    expect(expiryState({ ...period, issuedOn: '2027-01-01' }, '2026-12-01', policy)).toBe('NOT_STARTED');
    expect(expiryState({ ...period, revoked: true }, '2026-10-01', policy)).toBe('REVOKED');
  });

  it('finds what a requirement lacks: missing, not verified, expired, low grade, scope', () => {
    const need = { kind: 'CONSTRUCTION_ACTIVITY', minGrade: 'II', scopeKeyword: 'civil' } as const;
    const today = '2026-11-08';
    expect(qualificationFindings([need], [held()], today, policy)).toEqual([]);
    expect(qualificationFindings([need], [], today, policy)).toEqual([{ kind: 'CONSTRUCTION_ACTIVITY', gap: 'MISSING', qualificationId: null }]);
    expect(qualificationFindings([need], [held({ verified: false })], today, policy)[0]?.gap).toBe('NOT_VERIFIED');
    expect(qualificationFindings([need], [held({ period: { issuedOn: '2024-01-01', expiresOn: '2026-06-30', revoked: false } })], today, policy)[0]?.gap).toBe('EXPIRED');
    expect(qualificationFindings([need], [held({ grade: 'III' })], today, policy)[0]?.gap).toBe('GRADE_LOW');
    expect(qualificationFindings([need], [held({ grade: null })], today, policy)[0]?.gap).toBe('GRADE_LOW');
    expect(qualificationFindings([need], [held({ scope: 'Road works' })], today, policy)[0]?.gap).toBe('SCOPE_NOT_COVERED');
    expect(qualificationFindings([need], [held({ scope: 'Road works', id: 'a' }), held({ id: 'b', verified: false })], today, policy)[0]).toMatchObject({ qualificationId: 'a', gap: 'SCOPE_NOT_COVERED' });
    expect(qualificationFindings([{ kind: 'SAFETY_CERTIFICATE', minGrade: null, scopeKeyword: null }], [held()], today, policy)[0]?.gap).toBe('MISSING');
    expect(qualificationFindings([need], [held({ grade: 'I' })], today, policy)).toEqual([]);
  });

  it('writes a period whose end is not before its start and reads its params', () => {
    expect(() => assertValidityPeriod('2026-01-01', null)).not.toThrow();
    expect(codeOf(() => assertValidityPeriod('2026-02-30', null))).toBe('VALIDATION_FAILED:issued_on');
    expect(codeOf(() => assertValidityPeriod('2026-01-02', '2026-01-01'))).toBe('VALIDATION_FAILED:expires_on');
    expect(expiryPolicyOf(policy)).toEqual(policy);
    expect(codeOf(() => expiryPolicyOf({ first_warning_days: 10, second_warning_days: 30 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:second_warning_days');
  });
});

describe('the debarment case', () => {
  const received = new Date('2026-11-04T09:00:00+07:00');
  const fresh: RestrictionCaseFacts = { state: 'PROPOSED', proposedBy: 'maker', receivedAt: received, notifiedAt: null, responseDueAt: null, responseOutcome: null, decision: null, decidedBy: null, effectiveFrom: null, banMonths: null };
  const periods: Record<string, DebarmentPeriod> = { GROUP_1: { min_months: 36, max_months: 60, behaviours: 'a' }, GROUP_2: { min_months: 12, max_months: 36, behaviours: 'b' }, GROUP_3: { min_months: 6, max_months: 12, behaviours: 'c' } };

  it('goes from proposal to the end of the ban, one state at a time', () => {
    const due = new Date('2026-11-20T17:00:00+07:00');
    let facts = moveRestrictionCase(fresh, { move: 'SEND_NOTICE', by: 'maker', at: new Date('2026-11-05T09:00:00+07:00'), responseDueAt: due });
    expect(facts).toMatchObject({ state: 'NOTICE_SENT', responseDueAt: due });
    facts = moveRestrictionCase(facts, { move: 'RECORD_RESPONSE', by: 'maker', at: new Date('2026-11-10T09:00:00+07:00') });
    expect(facts).toMatchObject({ state: 'RESPONSE_RECEIVED', responseOutcome: 'RESPONDED' });
    facts = moveRestrictionCase(facts, { move: 'DECIDE', by: 'authority', at: new Date('2026-11-12T09:00:00+07:00'), decision: 'BAN', effectiveFrom: '2026-12-01', banMonths: 36 });
    expect(facts).toMatchObject({ state: 'DECIDED', decision: 'BAN', decidedBy: 'authority', effectiveFrom: '2026-12-01', banMonths: 36 });
    expect(codeOf(() => moveRestrictionCase(facts, { move: 'PUT_INTO_EFFECT', by: 'authority', at: received, today: '2026-11-30' }))).toBe('RESTRICTION_NOT_YET_EFFECTIVE:effective_from');
    facts = moveRestrictionCase(facts, { move: 'PUT_INTO_EFFECT', by: 'authority', at: received, today: '2026-12-01' });
    expect(facts.state).toBe('EFFECTIVE');
    expect(codeOf(() => moveRestrictionCase(facts, { move: 'EXPIRE', by: 'job', at: received, today: '2029-11-30', effectiveUntil: '2029-11-30' }))).toBe('RESTRICTION_NOT_YET_ENDED:effective_until');
    expect(moveRestrictionCase(facts, { move: 'EXPIRE', by: 'job', at: received, today: '2029-12-01', effectiveUntil: '2029-11-30' }).state).toBe('EXPIRED');
    expect(moveRestrictionCase(facts, { move: 'LIFT', by: 'authority', at: received }).state).toBe('LIFTED');
  });

  it('keeps the person who decides apart from the person who proposed, and refuses a move from the wrong state', () => {
    const waiting = { ...fresh, state: 'RESPONSE_RECEIVED' } as RestrictionCaseFacts;
    expect(refusal(() => moveRestrictionCase(waiting, { move: 'DECIDE', by: 'maker', at: received, decision: 'BAN', effectiveFrom: '2026-12-01', banMonths: 12 })).code).toBe('SELF_APPROVAL_DENIED');
    expect(codeOf(() => moveRestrictionCase(fresh, { move: 'DECIDE', by: 'authority', at: received, decision: 'DISMISS', effectiveFrom: null, banMonths: null }))).toBe('RESTRICTION_CASE_STATE_INVALID:status');
    expect(codeOf(() => moveRestrictionCase(fresh, { move: 'LIFT', by: 'x', at: received }))).toBe('RESTRICTION_CASE_STATE_INVALID:status');
  });

  it('closes an absent answer only after it was due, and checks the decision it takes', () => {
    const sent = moveRestrictionCase(fresh, { move: 'SEND_NOTICE', by: 'maker', at: received, responseDueAt: new Date('2026-11-14T17:00:00+07:00') });
    expect(codeOf(() => moveRestrictionCase(sent, { move: 'CLOSE_NO_RESPONSE', by: 'maker', at: new Date('2026-11-14T16:00:00+07:00') }))).toBe('RESTRICTION_RESPONSE_WINDOW_OPEN:status');
    expect(moveRestrictionCase(sent, { move: 'CLOSE_NO_RESPONSE', by: 'maker', at: new Date('2026-11-15T09:00:00+07:00') })).toMatchObject({ state: 'RESPONSE_RECEIVED', responseOutcome: 'NO_RESPONSE' });
    expect(codeOf(() => moveRestrictionCase(fresh, { move: 'SEND_NOTICE', by: 'maker', at: received, responseDueAt: received }))).toBe('VALIDATION_FAILED:response_due_at');
    const waiting = { ...fresh, state: 'RESPONSE_RECEIVED' } as RestrictionCaseFacts;
    expect(codeOf(() => moveRestrictionCase(waiting, { move: 'DECIDE', by: 'a', at: received, decision: 'BAN', effectiveFrom: '2026-12-01', banMonths: null }))).toBe('VALIDATION_FAILED:ban_months');
    expect(codeOf(() => moveRestrictionCase(waiting, { move: 'DECIDE', by: 'a', at: received, decision: 'BAN', effectiveFrom: null, banMonths: 12 }))).toBe('VALIDATION_FAILED:effective_from');
    expect(moveRestrictionCase(waiting, { move: 'DECIDE', by: 'a', at: received, decision: 'DISMISS', effectiveFrom: null, banMonths: null }).state).toBe('DISMISSED');
    expect(moveRestrictionCase(fresh, { move: 'WITHDRAW', by: 'maker', at: received }).state).toBe('DISMISSED');
  });

  it('counts the last day of a ban and keeps it inside the range of its groups', () => {
    expect(banLastDay('2026-12-01', 36)).toBe('2029-11-30');
    expect(banLastDay('2026-01-31', 1)).toBe('2026-02-27');
    expect(banMonthsRange(['GROUP_3'], periods, DEBARMENT_POLICY_DEFAULTS)).toEqual({ min: 6, max: 12 });
    expect(banMonthsRange(['GROUP_1', 'GROUP_2'], periods, DEBARMENT_POLICY_DEFAULTS)).toEqual({ min: 36, max: 60 });
    expect(() => assertBanPeriod(36, ['GROUP_1'], periods, DEBARMENT_POLICY_DEFAULTS)).not.toThrow();
    expect(refusal(() => assertBanPeriod(24, ['GROUP_1'], periods, DEBARMENT_POLICY_DEFAULTS)).extensions).toEqual({ min_months: 36, max_months: 60 });
    expect(refusal(() => assertBanPeriod(61, ['GROUP_1'], periods, DEBARMENT_POLICY_DEFAULTS)).code).toBe('RESTRICTION_BAN_PERIOD_INVALID');
    expect(codeOf(() => banMonthsRange([], periods, DEBARMENT_POLICY_DEFAULTS))).toBe('VALIDATION_FAILED:violation_groups');
    expect(codeOf(() => banMonthsRange(['GROUP_9'], periods, DEBARMENT_POLICY_DEFAULTS))).toBe('VALIDATION_FAILED:violation_groups');
  });

  it('applies the limitation and suggests the wider ban from the counts', () => {
    expect(() => assertWithinLimitation('2016-11-08', '2026-11-08', 10)).not.toThrow();
    expect(refusal(() => assertWithinLimitation('2016-11-07', '2026-11-08', 10)).extensions).toEqual({ limit_on: '2026-11-07' });
    expect(escalationSuggestion(2, DEBARMENT_POLICY_DEFAULTS)).toBe('NONE');
    expect(escalationSuggestion(3, DEBARMENT_POLICY_DEFAULTS)).toBe('PROVINCE');
    expect(escalationSuggestion(5, DEBARMENT_POLICY_DEFAULTS)).toBe('NATIONWIDE');
  });

  it('reaches every member of a joint venture unless the violation is of a group the policy excepts', () => {
    const members = [{ contractorId: 'a', sharePct: '60', lead: true }, { contractorId: 'b', sharePct: '40', lead: false }];
    expect(ventureMembersReached(members, ['GROUP_1'], [], DEBARMENT_POLICY_DEFAULTS)).toEqual(['a', 'b']);
    const except = { jv_exception_groups: ['GROUP_3'] };
    expect(ventureMembersReached(members, ['GROUP_1', 'GROUP_3'], [], except)).toEqual(['a', 'b']);
    expect(ventureMembersReached(members, ['GROUP_3'], ['b'], except)).toEqual(['b']);
    expect(codeOf(() => ventureMembersReached(members, ['GROUP_3'], [], except))).toBe('VALIDATION_FAILED:culpable_member_ids');
    expect(codeOf(() => ventureMembersReached(members, ['GROUP_3'], ['z'], except))).toBe('VALIDATION_FAILED:culpable_member_ids');
  });

  it('checks the shares of a joint venture', () => {
    const ok = [{ contractorId: 'a', sharePct: '60.5', lead: true }, { contractorId: 'b', sharePct: '39.5', lead: false }];
    expect(() => assertVentureShares(ok)).not.toThrow();
    const reason = (members: Parameters<typeof assertVentureShares>[0]): unknown => refusal(() => assertVentureShares(members)).extensions;
    expect(reason([ok[0] as (typeof ok)[number]])).toEqual({ reason: 'AT_LEAST_TWO_MEMBERS' });
    expect(reason([ok[0] as (typeof ok)[number], { ...ok[0], lead: false } as (typeof ok)[number]])).toEqual({ reason: 'DUPLICATE_MEMBER' });
    expect(reason([ok[0] as (typeof ok)[number], { ...ok[1], lead: true } as (typeof ok)[number]])).toEqual({ reason: 'ONE_LEAD' });
    expect(reason([ok[0] as (typeof ok)[number], { ...ok[1], sharePct: '30' } as (typeof ok)[number]])).toEqual({ reason: 'SHARES_NOT_100', total_pct: '90.50' });
    expect(reason([ok[0] as (typeof ok)[number], { ...ok[1], sharePct: '0' } as (typeof ok)[number]])).toEqual({ reason: 'SHARE_RANGE' });
  });
});

describe('the clocks of the register on the working calendar', () => {
  it('counts the decision in calendar days and a posting in working days', () => {
    // Proposal received Wednesday 4 November: 15 calendar days is Thursday 19 November, a working day: the end of that office day.
    expect(dueFrom('CALENDAR_DAYS', DEBARMENT_POLICY_DEFAULTS.decide_within_days, new Date('2026-11-04T15:00:00+07:00'), calendars).toISOString()).toBe('2026-11-19T10:00:00.000Z');
    // Seven working days from the same day skip the weekend and the holiday of 9 November: the 16th.
    expect(dueFrom('WORKING_DAYS', 7, new Date('2026-11-04T15:00:00+07:00'), calendars).toISOString()).toBe('2026-11-16T10:00:00.000Z');
    expect(codeOf(() => dueFrom('WORKING_DAYS', 400, new Date('2026-11-04T15:00:00+07:00'), calendars))).toBe('CALENDAR_NOT_EFFECTIVE:year');
  });

  it('says where a limit stands and when it raises an alert', () => {
    const dueAt = new Date('2026-11-19T10:00:00Z');
    const at = (iso: string): Date => new Date(iso);
    expect(deadlineClock({ dueAt, doneAt: null, now: at('2026-11-10T00:00:00Z'), remindBeforeDays: 3 })).toBe('ON_TIME');
    expect(deadlineClock({ dueAt, doneAt: null, now: at('2026-11-17T00:00:00Z'), remindBeforeDays: 3 })).toBe('DUE_SOON');
    expect(deadlineClock({ dueAt, doneAt: null, now: at('2026-11-19T10:00:01Z'), remindBeforeDays: 3 })).toBe('OVERDUE');
    expect(deadlineClock({ dueAt, doneAt: at('2026-11-19T10:00:00Z'), now: at('2026-12-01T00:00:00Z'), remindBeforeDays: 3 })).toBe('MET');
    expect(deadlineClock({ dueAt, doneAt: at('2026-11-20T00:00:00Z'), now: at('2026-12-01T00:00:00Z'), remindBeforeDays: 3 })).toBe('MET_LATE');
    expect(clockAlertFacet('DUE_SOON')).toBe('DUE_SOON');
    expect(clockAlertFacet('OVERDUE')).toBe('OVERDUE');
    expect(clockAlertFacet('MET_LATE')).toBeNull();
    expect(clockAlertFacet('ON_TIME')).toBeNull();
  });
});

describe('the ledger of events of bid conduct', () => {
  it('is posted or retracted once, by somebody other than the person who recorded it', () => {
    expect(moveReputationEvent('RECORDED', { move: 'POST', by: 'poster', at: new Date(), recordedBy: 'maker', receipt: 'MSC-0001' })).toBe('POSTED');
    expect(moveReputationEvent('RECORDED', { move: 'RETRACT', by: 'checker', at: new Date(), recordedBy: 'maker', reason: 'entered against the wrong contractor' })).toBe('RETRACTED');
    expect(refusal(() => moveReputationEvent('RECORDED', { move: 'POST', by: 'maker', at: new Date(), recordedBy: 'maker', receipt: 'MSC-0001' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(codeOf(() => moveReputationEvent('POSTED', { move: 'POST', by: 'poster', at: new Date(), recordedBy: 'maker', receipt: 'MSC-0001' }))).toBe('STAGE_TRANSITION_DENIED:status');
    expect(codeOf(() => moveReputationEvent('RECORDED', { move: 'POST', by: 'poster', at: new Date(), recordedBy: 'maker', receipt: 'x' }))).toBe('VALIDATION_FAILED:receipt');
    expect(codeOf(() => moveReputationEvent('RECORDED', { move: 'RETRACT', by: 'checker', at: new Date(), recordedBy: 'maker', reason: 'wrong' }))).toBe('VALIDATION_FAILED:reason');
  });

  it('multiplies the bid security for two years from the day of the latest posting', () => {
    const policy = REPUTATION_POLICY_DEFAULTS;
    expect(bidSecurityFactor([], '2026-11-08', policy)).toEqual({ multiplier: 1, until: null, eventIds: [] });
    const events = [
      { id: 'e1', state: 'POSTED', postedOn: '2025-01-10' },
      { id: 'e2', state: 'POSTED', postedOn: '2026-03-05' },
      { id: 'e3', state: 'RETRACTED', postedOn: '2026-05-05' },
      { id: 'e4', state: 'RECORDED', postedOn: null },
    ] as const;
    expect(bidSecurityFactor(events, '2026-11-08', policy)).toEqual({ multiplier: 3, until: '2028-03-05', eventIds: ['e1', 'e2'] });
    expect(bidSecurityFactor(events, '2028-03-06', policy)).toEqual({ multiplier: 1, until: null, eventIds: [] });
    expect(bidSecurityFactor(events.slice(0, 1), '2027-01-10', policy)).toMatchObject({ multiplier: 3, until: '2027-01-10' });
  });
});

describe('the gates and the rules of the register', () => {
  it('asks the restriction everywhere and the account only when money moves', () => {
    for (const action of ['BID_SUBMISSION', 'RESULT', 'CONTRACT_ACTIVATION', 'SUBCONTRACT', 'PAYMENT'] as const) expect(GATE_CHECKS_BY_ACTION[action]).toContain('RESTRICTION');
    expect(GATE_CHECKS_BY_ACTION.PAYMENT).toContain('PAYEE');
    expect(GATE_CHECKS_BY_ACTION.BID_SUBMISSION).not.toContain('PAYEE');
    expect(GATE_CHECKS_BY_ACTION.CONTRACT_ACTIVATION).toContain('QUALIFICATION');
    expect(gatePolicyOf(GATE_POLICY_DEFAULTS)).toEqual(GATE_POLICY_DEFAULTS);
    expect(codeOf(() => gatePolicyOf({ profile_enforcement: 'OFF', qualification_enforcement: 'WARN' }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:profile_enforcement');
  });

  it('registers every rule with its source, as-of day and legal status flagged unverified', () => {
    for (const [type, code] of [
      ['VENDOR_PROFILE', 'DEFAULT'],
      ['VENDOR_DUPLICATE_SIGNALS', 'DEFAULT'],
      ['VENDOR_PAYEE_ACCOUNT', 'DEFAULT'],
      ['VENDOR_EXPIRY_WARNING', 'QUALIFICATION'],
      ['VENDOR_EXPIRY_WARNING', 'KEY_STAFF'],
      ['VENDOR_DEBARMENT', 'DEFAULT'],
      ['VENDOR_DEBARMENT_PERIOD', 'GROUP_1'],
      ['VENDOR_DEBARMENT_PERIOD', 'GROUP_3'],
      ['VENDOR_REPUTATION', 'DEFAULT'],
      ['VENDOR_GATE', 'DEFAULT'],
    ] as const) {
      const found = builtInDefault(type, code);
      expect(found?.unverified).toBe(true);
      expect(found?.source).toMatch(/NĐ 214/);
      expect(validateRuleParams(type, found?.params)).toEqual(found?.params);
    }
    expect(vendorProfilePolicyOf(builtInDefault('VENDOR_PROFILE', 'DEFAULT')?.params)).toEqual(VENDOR_PROFILE_DEFAULTS);
    expect(debarmentPolicyOf(builtInDefault('VENDOR_DEBARMENT', 'DEFAULT')?.params)).toEqual(DEBARMENT_POLICY_DEFAULTS);
    expect(reputationPolicyOf(builtInDefault('VENDOR_REPUTATION', 'DEFAULT')?.params)).toEqual(REPUTATION_POLICY_DEFAULTS);
    expect(codeOf(() => validateRuleParams('VENDOR_DEBARMENT', { ...DEBARMENT_POLICY_DEFAULTS, national_threshold: 2 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:national_threshold');
    expect(codeOf(() => validateRuleParams('VENDOR_PROFILE', { ...VENDOR_PROFILE_DEFAULTS, required_before_bid: ['SHOE_SIZE'] }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:required_before_bid[0]');
  });

  it('gives each alert type an owner, an expected action and a consequence, and each KPI its definition', () => {
    for (const code of ['VENDOR_RESTRICTED_EXPOSURE', 'VENDOR_REPUTATION_POST', 'VENDOR_DEBARMENT_DECISION', 'VENDOR_PAYEE_ACCOUNT', 'VENDOR_QUALIFICATION_EXPIRY']) {
      const params = builtInDefault('ALERT_TYPE', code)?.params as Record<string, unknown>;
      expect(params).toMatchObject({ source: 'VENDOR', enabled: true });
      expect(String(params.owner)).not.toBe('');
      expect(String(params.expected_action).length).toBeGreaterThan(10);
      expect(String(params.consequence).length).toBeGreaterThan(10);
    }
    for (const code of ['VENDOR_PROFILE_COVERAGE', 'VENDOR_DEBARMENT_IN_TIME', 'VENDOR_REPUTATION_POSTED_IN_TIME', 'VENDOR_ACCOUNT_CHANGES']) {
      const found = builtInDefault('KPI_DEFINITION', code);
      expect(found?.unverified).toBe(true);
      expect(found?.params).toMatchObject({ period: 'AS_OF_NOW' });
      expect(String(found?.params.numerator).length).toBeGreaterThan(5);
    }
  });
});
