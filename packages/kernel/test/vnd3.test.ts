import { DomainError } from '../src/errors';
import { builtInDefault } from '../src/governance-rules';
import { registerAllGovernanceRules } from '../src/governance-rules';
import {
  INVESTIGATION_POLICY_DEFAULTS,
  LINK_PARAM_DEFAULTS,
  OCDS_EXPORT_DEFAULTS,
  PORTAL_CLOCK_DEFAULTS,
  PORTAL_FORBIDDEN_FIELDS,
  PORTAL_PROFILE_FIELDS,
  PORTAL_REQUEST_KINDS,
  REMEDIATION_POLICY_DEFAULTS,
  RIGGING_PARAM_DEFAULTS,
  SCREENING_PARAM_DEFAULTS,
  VND3_ALERT_CODES,
  VND3_FACET_SEVERITY,
  VND3_TEXT,
  addMonths,
  buildLinks,
  clusterKeyOf,
  clustersOf,
  combinedStrength,
  disputeStats,
  dismissalExpired,
  holdsContractor,
  investigationPolicyOf,
  isHit,
  leadKeyOf,
  leadPrecision,
  leadRank,
  linkPolicyOf,
  matchEntry,
  matchNameOf,
  nextHitStatus,
  nextLeadStatus,
  nextPortalRequestStatus,
  nextReconfirmationDue,
  nextRemediationStatus,
  ocdsExportPolicyOf,
  ocdsParty,
  portalClockPolicyOf,
  projectPortalProfile,
  radialLayout,
  reconfirmationAlertFacet,
  reconfirmationPolicyOf,
  reconfirmationState,
  remediationPolicyOf,
  reopensDismissed,
  requestClock,
  restrictedAffiliates,
  riggingPolicyOf,
  screenAll,
  screenBuyer,
  screenContractor,
  screenPackage,
  screeningPolicyOf,
  taxHeadOf,
  traceCoverage,
  vnd3Fill,
} from '../src/index';
import type { PartyKeys, RiggingBid, RiggingPackage } from '../src/index';

const LINK = linkPolicyOf({ ...LINK_PARAM_DEFAULTS });
const RIG = riggingPolicyOf({ ...RIGGING_PARAM_DEFAULTS });
const SCREEN = screeningPolicyOf({ ...SCREENING_PARAM_DEFAULTS });
const key = (seed: string): string => seed.repeat(64).slice(0, 64);

const party = (id: string, extra: Partial<PartyKeys> = {}): PartyKeys => ({ contractorId: id, taxHead: null, bankAccountKeys: [], legalRepKey: null, ownerKeys: [], addressKey: null, phoneKey: null, emailKey: null, originKeys: [], deviceKeys: [], fileAuthorKeys: [], ...extra });

describe('link graph (V6)', () => {
  it('combines independent evidences as one minus the product of what each leaves unexplained', () => {
    expect(combinedStrength([90])).toBe(90);
    expect(combinedStrength([40, 40])).toBe(64);
    expect(combinedStrength([35, 40, 40])).toBe(77);
    expect(combinedStrength([])).toBe(0);
  });

  it('links two parties that share a bank account and keeps the evidence as a fingerprint, not the key', () => {
    const { links } = buildLinks([party('a', { bankAccountKeys: [key('1')] }), party('b', { bankAccountKeys: [key('1')] }), party('c', { bankAccountKeys: [key('2')] })], LINK);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ a: 'a', b: 'b', strength: 95 });
    expect(links[0]?.evidence).toEqual([{ kind: 'BANK_ACCOUNT', fingerprint: '11111111', weight: 95 }]);
    expect(JSON.stringify(links)).not.toContain(key('1'));
  });

  it('drops a link weaker than link_from: an address alone is not enough, address with telephone is', () => {
    const alone = buildLinks([party('a', { addressKey: key('3') }), party('b', { addressKey: key('3') })], LINK);
    expect(alone.links).toEqual([]);
    const both = buildLinks([party('a', { addressKey: key('3'), phoneKey: key('4') }), party('b', { addressKey: key('3'), phoneKey: key('4') })], LINK);
    expect(both.links).toHaveLength(1);
    expect(both.links[0]?.strength).toBe(61);
  });

  it('ignores a key that more contractors share than the policy allows and says so', () => {
    const many = Array.from({ length: 7 }, (_, index) => party(`p${index}`, { addressKey: key('5'), taxHead: null }));
    const result = buildLinks(many, LINK);
    expect(result.links).toEqual([]);
    expect(result.ignored).toEqual([{ kind: 'ADDRESS', fingerprint: '55555555', size: 7 }]);
  });

  it('puts the smaller id first and never links a party to itself', () => {
    const { links } = buildLinks([party('z', { legalRepKey: key('6'), ownerKeys: [key('7')] }), party('m', { legalRepKey: key('6'), ownerKeys: [key('7')] })], LINK);
    expect(links).toHaveLength(1);
    expect([links[0]?.a, links[0]?.b]).toEqual(['m', 'z']);
    expect(links[0]?.strength).toBe(93);
  });

  it('switches a kind off with weight 0', () => {
    const off = linkPolicyOf({ ...LINK_PARAM_DEFAULTS, weight_bank_account: 0 });
    expect(buildLinks([party('a', { bankAccountKeys: [key('1')] }), party('b', { bankAccountKeys: [key('1')] })], off).links).toEqual([]);
  });

  it('clusters the connected parties and raises the score with the size of the ring', () => {
    const parties = [party('a', { bankAccountKeys: [key('1')] }), party('b', { bankAccountKeys: [key('1')], legalRepKey: key('2') }), party('c', { legalRepKey: key('2'), ownerKeys: [key('9')] }), party('d', { ownerKeys: [key('9')] }), party('x')];
    const { links } = buildLinks(parties, LINK);
    const clusters = clustersOf(links, LINK);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual(['a', 'b', 'c', 'd']);
    expect(clusters[0]?.score).toBe(Math.min(100, 95 + 2 * 5));
    expect(clusterKeyOf(['d', 'a', 'c', 'b'])).toBe('a,b,c,d');
  });

  it('names the new companies of a banned party', () => {
    expect(restrictedAffiliates({ members: ['a', 'b', 'c'] }, new Set(['a']))).toEqual({ restricted: ['a'], affiliates: ['b', 'c'] });
    expect(restrictedAffiliates({ members: ['a', 'b'] }, new Set())).toEqual({ restricted: [], affiliates: [] });
  });

  it('lays a cluster out deterministically with the focus at the centre', () => {
    const links = buildLinks([party('a', { bankAccountKeys: [key('1')] }), party('b', { bankAccountKeys: [key('1')] }), party('c', { bankAccountKeys: [key('1')] })], LINK).links;
    const one = radialLayout(['a', 'b', 'c'], links, 'a', 400, 300);
    expect(one[0]).toEqual({ id: 'a', x: 200, y: 150 });
    expect(radialLayout(['a', 'b', 'c'], links, 'a', 400, 300)).toEqual(one);
    expect(one).toHaveLength(3);
    expect(radialLayout(['a', 'b'], [], null, 400, 300)).toHaveLength(2);
  });

  it('refuses a policy whose cluster line is below the link line', () => {
    expect(() => linkPolicyOf({ ...LINK_PARAM_DEFAULTS, cluster_from: 10 })).toThrow(DomainError);
    expect(() => linkPolicyOf({})).toThrow(DomainError);
  });
});

const bid = (contractorId: string, priceVnd: string | null, extra: Partial<RiggingBid> = {}): RiggingBid => ({ contractorId, priceVnd, withdrawn: false, submittedAt: null, originKey: null, deviceKey: null, fileKeys: [], ...extra });
const pkg = (packageId: string, bids: RiggingBid[], winnerId: string | null, extra: Partial<RiggingPackage> = {}): RiggingPackage => ({ packageId, code: packageId.toUpperCase(), buyerKey: 'unit-1', closedOn: '2026-01-01', winnerId, bids, ...extra });

describe('bid rigging signals (V6)', () => {
  it('finds a cover bid: two prices close at the bottom and the others far above', () => {
    const found = screenPackage(pkg('p1', [bid('a', '1000000000'), bid('b', '1003000000'), bid('c', '1300000000'), bid('d', '1400000000')], 'a'), RIG);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'COVER_BID', packageIds: ['p1'], contractorIds: ['a', 'b', 'c', 'd'] });
    expect(found[0]?.evidence).toMatchObject({ close_gap_bp: 30, nearest_far_gap_bp: 2961 });
    expect(found[0]?.score).toBe(75);
  });

  it('does not call a cover bid when one other bid is near or the prices are all spread', () => {
    expect(screenPackage(pkg('p1', [bid('a', '1000000000'), bid('b', '1003000000'), bid('c', '1050000000')], 'a'), RIG)).toEqual([]);
    expect(screenPackage(pkg('p1', [bid('a', '1000000000'), bid('b', '1100000000'), bid('c', '1300000000')], 'a'), RIG)).toEqual([]);
    expect(screenPackage(pkg('p1', [bid('a', '1000000000'), bid('b', '1003000000')], 'a'), RIG)).toEqual([]);
  });

  it('finds identical prices from different bidders and prices that rise in equal steps', () => {
    const same = screenPackage(pkg('p1', [bid('a', '500000000'), bid('b', '500000000'), bid('c', '900000000')], 'a'), RIG);
    expect(same.find((signal) => signal.code === 'PRICE_PATTERN')).toMatchObject({ contractorIds: ['a', 'b'], evidence: { pattern: 'IDENTICAL_PRICE' } });
    const steps = screenPackage(pkg('p2', [bid('a', '1000000000'), bid('b', '1050000000'), bid('c', '1100000000'), bid('d', '1150000000')], 'a'), RIG);
    expect(steps.find((signal) => signal.code === 'PRICE_PATTERN')).toMatchObject({ evidence: { pattern: 'EQUAL_STEPS', step_vnd: '50000000' } });
    expect(screenPackage(pkg('p3', [bid('a', '1000000000'), bid('b', '1060000000'), bid('c', '1100000000')], 'a'), RIG)).toEqual([]);
  });

  it('a withdrawn bid and a bid with no price are never priced', () => {
    expect(screenPackage(pkg('p1', [bid('a', '500000000'), bid('b', '500000000', { withdrawn: true }), bid('c', null)], 'a'), RIG)).toEqual([]);
  });

  it('finds the same file fingerprint and the same origin inside the window, and only when it was recorded', () => {
    const files = screenPackage(pkg('p1', [bid('a', '1', { fileKeys: [key('a'), key('b')] }), bid('b', '2', { fileKeys: [key('b')] })], 'a'), RIG);
    expect(files[0]).toMatchObject({ code: 'FILE_METADATA', contractorIds: ['a', 'b'], evidence: { shared_files: 1, fingerprints: ['bbbbbbbb'] } });
    const origin = screenPackage(pkg('p1', [bid('a', '1', { originKey: key('c'), submittedAt: '2026-01-01T08:00:00Z' }), bid('b', '2', { originKey: key('c'), submittedAt: '2026-01-01T08:30:00Z' })], 'a'), RIG);
    expect(origin[0]).toMatchObject({ code: 'SHARED_ORIGIN', contractorIds: ['a', 'b'] });
    const far = screenPackage(pkg('p1', [bid('a', '1', { originKey: key('c'), submittedAt: '2026-01-01T08:00:00Z' }), bid('b', '2', { originKey: key('c'), submittedAt: '2026-01-03T08:00:00Z' })], 'a'), RIG);
    expect(far).toEqual([]);
    expect(screenPackage(pkg('p1', [bid('a', '1'), bid('b', '2')], 'a'), RIG)).toEqual([]);
    expect(traceCoverage([pkg('p1', [bid('a', '1', { originKey: key('c') }), bid('b', '2', { fileKeys: [key('a')] }), bid('c', '3')], 'a')])).toEqual({ bids: 3, withOrigin: 1, withFiles: 1 });
  });

  it('finds winners that take turns among the same bidders (rotation)', () => {
    const turn = (id: string, winner: string, day: string): RiggingPackage => pkg(id, [bid('a', '100'), bid('b', '101'), bid('c', '102')], winner, { closedOn: day });
    const packages = [turn('p1', 'a', '2026-01-01'), turn('p2', 'b', '2026-02-01'), turn('p3', 'c', '2026-03-01'), turn('p4', 'a', '2026-04-01'), turn('p5', 'b', '2026-05-01')];
    const found = screenBuyer(packages, RIG);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'ROTATING_WINNERS', packageIds: ['p1', 'p2', 'p3', 'p4', 'p5'], contractorIds: ['a', 'b', 'c'] });
    expect(found[0]?.evidence).toMatchObject({ packages: 5, winners: 3, outsider_wins: 0 });
    expect(found[0]?.score).toBe(80);
  });

  it('is not rotation when one bidder wins nearly everything or an outsider wins', () => {
    const same = (id: string, winner: string): RiggingPackage => pkg(id, [bid('a', '100'), bid('b', '101')], winner);
    expect(screenBuyer([same('p1', 'a'), same('p2', 'a'), same('p3', 'a'), same('p4', 'a'), same('p5', 'b')], RIG)).toEqual([]);
    const outsider = [same('p1', 'a'), same('p2', 'b'), pkg('p3', [bid('a', '1'), bid('b', '2'), bid('z', '3')], 'z'), pkg('p4', [bid('a', '1'), bid('b', '2'), bid('z', '3')], 'z'), same('p5', 'a')];
    expect(screenBuyer(outsider, RIG)).toEqual([]);
    expect(screenBuyer([same('p1', 'a'), same('p2', 'b')], RIG)).toEqual([]);
  });

  it('finds a bidder that withdraws for the same winner more than once', () => {
    const w = (id: string): RiggingPackage => pkg(id, [bid('a', '100'), bid('b', null, { withdrawn: true })], 'a');
    const found = screenBuyer([w('p1'), w('p2'), w('p3')], RIG);
    expect(found.find((signal) => signal.code === 'WITHDRAWAL_FOR_WINNER')).toMatchObject({ packageIds: ['p1', 'p2', 'p3'], contractorIds: ['a', 'b'], score: 70 });
    expect(screenBuyer([w('p1')], RIG)).toEqual([]);
  });

  it('screenAll ranks the signals, keeps only leads, and a lead key is stable', () => {
    const all = screenAll([pkg('p1', [bid('a', '1000000000'), bid('b', '1003000000'), bid('c', '1300000000')], 'a'), pkg('p2', [bid('a', '500000000'), bid('b', '500000000'), bid('c', '900000000')], 'a')], RIG);
    expect(all.map((signal) => signal.code).sort()).toEqual(['COVER_BID', 'COVER_BID', 'PRICE_PATTERN']);
    expect(all.map(leadKeyOf)).toContain('PRICE_PATTERN:p2:a,b');
    const low = riggingPolicyOf({ ...RIGGING_PARAM_DEFAULTS, lead_from: 90 });
    expect(screenAll([pkg('p1', [bid('a', '1000000000'), bid('b', '1003000000'), bid('c', '1300000000')], 'a')], low)).toEqual([]);
    expect(leadRank([60, 80], 2)).toBe(85);
    expect(leadRank([], 0)).toBe(0);
    expect(leadRank([98], 3)).toBe(100);
  });

  it('refuses a policy whose far gap is not above the close gap', () => {
    expect(() => riggingPolicyOf({ ...RIGGING_PARAM_DEFAULTS, cover_far_gap_bp: 10 })).toThrow(DomainError);
  });
});

describe('lead review (G4-3 manner)', () => {
  const actor = 'auditor-1';
  it('moves take, propose dismissal, confirm by a different auditor', () => {
    expect(nextLeadStatus('NEW', 'TAKE', { actor, proposer: null })).toBe('IN_REVIEW');
    expect(nextLeadStatus('IN_REVIEW', 'PROPOSE_DISMISS', { actor, proposer: null, reason: 'the shared address is a public office' })).toBe('DISMISS_PROPOSED');
    expect(nextLeadStatus('DISMISS_PROPOSED', 'CONFIRM_DISMISS', { actor: 'auditor-2', proposer: actor })).toBe('DISMISSED');
    expect(() => nextLeadStatus('DISMISS_PROPOSED', 'CONFIRM_DISMISS', { actor, proposer: actor })).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
    expect(nextLeadStatus('DISMISS_PROPOSED', 'REJECT_DISMISS', { actor: 'auditor-2', proposer: actor, reason: 'the link is real' })).toBe('IN_REVIEW');
  });
  it('confirms a signal as right or refers it, with a reason, and refuses a move from the wrong status', () => {
    expect(nextLeadStatus('IN_REVIEW', 'CONFIRM_SIGNAL', { actor, proposer: null, reason: 'same author in three files' })).toBe('CONFIRMED');
    expect(nextLeadStatus('CONFIRMED', 'REFER', { actor, proposer: null, reason: 'send to the inspectorate' })).toBe('REFERRED');
    expect(() => nextLeadStatus('NEW', 'REFER', { actor, proposer: null, reason: 'send to the inspectorate' })).toThrow(expect.objectContaining({ code: 'LEAD_STATE_INVALID', status: 409 }));
    expect(() => nextLeadStatus('IN_REVIEW', 'CONFIRM_SIGNAL', { actor, proposer: null })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
  it('reopens a dismissed lead only when the rank rises enough or a new kind of evidence appears', () => {
    expect(reopensDismissed({ rank: 60, evidenceKinds: ['ADDRESS'] }, { rank: 70, evidenceKinds: ['ADDRESS'] }, 15)).toBe(false);
    expect(reopensDismissed({ rank: 60, evidenceKinds: ['ADDRESS'] }, { rank: 75, evidenceKinds: ['ADDRESS'] }, 15)).toBe(true);
    expect(reopensDismissed({ rank: 60, evidenceKinds: ['ADDRESS'] }, { rank: 60, evidenceKinds: ['ADDRESS', 'PHONE'] }, 15)).toBe(true);
  });
  it('measures the precision over the decided leads and says none when nothing was decided', () => {
    expect(leadPrecision({ confirmed: 3, referred: 1, dismissed: 4 })).toBe(50);
    expect(leadPrecision({ confirmed: 0, referred: 0, dismissed: 0 })).toBeNull();
    expect(investigationPolicyOf({ ...INVESTIGATION_POLICY_DEFAULTS })).toEqual(INVESTIGATION_POLICY_DEFAULTS);
    expect(() => investigationPolicyOf({ reopen_rise: 0, window_days: 90, alert_from: 70 })).toThrow(DomainError);
  });
});

describe('screening (V14)', () => {
  const contractor = { id: 'c1', taxIdentifier: '0312345678', legalName: 'Cong ty TNHH Xay dung Thanh Cong' };
  const entry = (extra: Partial<Parameters<typeof matchEntry>[1]> = {}): Parameters<typeof matchEntry>[1] => ({ source: 'NATIONAL_DEBARMENT', ref: 'r1', name: null, taxCode: null, validFrom: '2026-01-01', validUntil: '2027-12-31', rowHash: key('a'), ...extra });
  const today = '2026-11-08';

  it('a tax code match is decisive and holds when the entry is in force', () => {
    const match = matchEntry(contractor, entry({ taxCode: '0312345678' }), today, SCREEN);
    expect(match).toMatchObject({ score: 100, basis: ['TAX_CODE'], inForce: true, hold: true });
  });
  it('a branch is found by the head of its tax code', () => {
    const match = matchEntry({ ...contractor, taxIdentifier: '0312345678-001' }, entry({ taxCode: '0312345678' }), today, SCREEN);
    expect(match).toMatchObject({ score: 90, basis: ['TAX_HEAD'], hold: true });
    expect(taxHeadOf('0312345678-001')).toBe('0312345678');
    expect(taxHeadOf('12345')).toBeNull();
  });
  it('a name alone never puts a hold and is below a decisive match', () => {
    const match = matchEntry(contractor, entry({ name: 'XAY DUNG THANH CONG' }), today, SCREEN);
    expect(match.basis).toEqual(['NAME']);
    expect(match.score).toBe(60);
    expect(match.hold).toBe(false);
    expect(isHit(match, SCREEN)).toBe(true);
    expect(matchEntry(contractor, entry({ name: 'Xay dung Hoa Binh' }), today, SCREEN).score).toBe(0);
    expect(matchNameOf('Cong ty Co phan ABC')).toBe('abc');
  });
  it('an entry not yet in force alerts but does not hold, unless the rule says so', () => {
    const future = entry({ taxCode: '0312345678', validFrom: '2027-01-01' });
    expect(matchEntry(contractor, future, today, SCREEN)).toMatchObject({ score: 100, inForce: false, hold: false });
    const strict = screeningPolicyOf({ ...SCREENING_PARAM_DEFAULTS, hold_not_yet_in_force: true });
    expect(matchEntry(contractor, future, today, strict).hold).toBe(true);
    expect(matchEntry(contractor, entry({ taxCode: '0312345678', validUntil: '2026-11-07' }), today, SCREEN).hold).toBe(false);
  });
  it('screenContractor lists the hits strongest first', () => {
    const hits = screenContractor(contractor, [entry({ ref: 'n', name: 'Xay dung Thanh Cong' }), entry({ ref: 't', taxCode: '0312345678' }), entry({ ref: 'x', taxCode: '0999999999', name: 'Other' })], today, SCREEN);
    expect(hits.map((hit) => hit.entry.ref)).toEqual(['t', 'n']);
  });
  it('a hit is decided by a person: confirm, or dismiss with a reason of twenty characters; the system resolves and reopens', () => {
    expect(nextHitStatus('PENDING', 'CONFIRM')).toBe('CONFIRMED');
    expect(nextHitStatus('PENDING', 'DISMISS', 'not the same company: other founder and address')).toBe('DISMISSED');
    expect(() => nextHitStatus('PENDING', 'DISMISS', 'no')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => nextHitStatus('DISMISSED', 'CONFIRM')).toThrow(expect.objectContaining({ code: 'SCREENING_HIT_STATE_INVALID' }));
    expect(nextHitStatus('CONFIRMED', 'RESOLVE')).toBe('RESOLVED');
    expect(nextHitStatus('DISMISSED', 'REOPEN')).toBe('PENDING');
  });
  it('a pending or confirmed hit with a hold holds; a dismissed or resolved one does not', () => {
    expect(holdsContractor({ status: 'PENDING', hold: true })).toBe(true);
    expect(holdsContractor({ status: 'CONFIRMED', hold: true })).toBe(true);
    expect(holdsContractor({ status: 'DISMISSED', hold: true })).toBe(false);
    expect(holdsContractor({ status: 'PENDING', hold: false })).toBe(false);
  });
  it('a dismissal is asked again when the entry changed or the dismissal ran out', () => {
    expect(dismissalExpired({ rowHash: 'a', decidedOn: '2026-01-01' }, 'a', '2026-06-01', 365)).toBe(false);
    expect(dismissalExpired({ rowHash: 'a', decidedOn: '2026-01-01' }, 'b', '2026-06-01', 365)).toBe(true);
    expect(dismissalExpired({ rowHash: 'a', decidedOn: '2026-01-01' }, 'a', '2027-01-01', 365)).toBe(true);
  });
  it('refuses a policy in which a name alone could hold', () => {
    expect(() => screeningPolicyOf({ ...SCREENING_PARAM_DEFAULTS, weight_name: 95 })).toThrow(DomainError);
    expect(() => screeningPolicyOf({ ...SCREENING_PARAM_DEFAULTS, hold_from: 10 })).toThrow(DomainError);
  });
});

describe('portal (V15)', () => {
  it('shows a contractor only the whitelisted fields of its profile, whatever the source carries', () => {
    const source: Record<string, unknown> = { id: 'c1', legal_name: 'ABC', tax_identifier: '0312345678', phone: '0901234567', version: 3 };
    for (const field of PORTAL_FORBIDDEN_FIELDS) source[field] = 'secret';
    const projected = projectPortalProfile(source);
    expect(Object.keys(projected).sort()).toEqual(['id', 'legal_name', 'phone', 'tax_identifier', 'version']);
    for (const field of PORTAL_FORBIDDEN_FIELDS) expect(Object.keys(projected)).not.toContain(field);
    for (const field of PORTAL_PROFILE_FIELDS) expect(PORTAL_FORBIDDEN_FIELDS).not.toContain(field);
  });

  it('a request is answered by the contractor and accepted, returned or cancelled by staff', () => {
    expect(nextPortalRequestStatus('OPEN', 'RESPOND', 'CONTRACTOR')).toBe('RESPONDED');
    expect(nextPortalRequestStatus('RESPONDED', 'ACCEPT', 'STAFF')).toBe('ACCEPTED');
    expect(nextPortalRequestStatus('RESPONDED', 'RETURN', 'STAFF', 'please attach the signed page')).toBe('OPEN');
    expect(nextPortalRequestStatus('OPEN', 'CANCEL', 'STAFF', 'asked by mistake')).toBe('CANCELLED');
    expect(() => nextPortalRequestStatus('OPEN', 'ACCEPT', 'STAFF')).toThrow(expect.objectContaining({ code: 'PORTAL_REQUEST_STATE_INVALID' }));
    expect(() => nextPortalRequestStatus('OPEN', 'RESPOND', 'STAFF')).toThrow(expect.objectContaining({ code: 'SCOPE_DENIED' }));
    expect(() => nextPortalRequestStatus('ACCEPTED', 'RESPOND', 'CONTRACTOR')).toThrow(DomainError);
    expect(() => nextPortalRequestStatus('RESPONDED', 'RETURN', 'STAFF')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('the clock of a request: on time, due soon, overdue, answered, answered late (a late answer is never refused)', () => {
    const dueAt = new Date('2026-11-20T00:00:00Z');
    const base = { dueAt, remindBeforeDays: 5, respondedAt: null };
    expect(requestClock({ ...base, now: new Date('2026-11-01T00:00:00Z') })).toBe('ON_TIME');
    expect(requestClock({ ...base, now: new Date('2026-11-17T00:00:00Z') })).toBe('DUE_SOON');
    expect(requestClock({ ...base, now: new Date('2026-11-21T00:00:00Z') })).toBe('OVERDUE');
    expect(requestClock({ ...base, now: new Date('2026-11-21T00:00:00Z'), respondedAt: new Date('2026-11-19T00:00:00Z') })).toBe('ANSWERED');
    expect(requestClock({ ...base, now: new Date('2026-11-25T00:00:00Z'), respondedAt: new Date('2026-11-22T00:00:00Z') })).toBe('ANSWERED_LATE');
  });

  it('the starting clocks hold the 20 days of an evaluation and validate as rules', () => {
    expect(PORTAL_CLOCK_DEFAULTS.EVALUATION_RESPONSE.response_days).toBe(20);
    for (const kind of PORTAL_REQUEST_KINDS) expect(portalClockPolicyOf(PORTAL_CLOCK_DEFAULTS[kind])).toEqual(PORTAL_CLOCK_DEFAULTS[kind]);
    expect(() => portalClockPolicyOf({ response_days: 0, day_unit: 'CALENDAR_DAYS', remind_before_days: 1 })).toThrow(DomainError);
    expect(() => portalClockPolicyOf({ response_days: 5, day_unit: 'HOURS', remind_before_days: 1 })).toThrow(DomainError);
  });

  it('adds months and keeps a month end a month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-11-08', 12)).toBe('2027-11-08');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(nextReconfirmationDue('2026-11-08', { interval_months: 12 })).toBe('2027-11-08');
  });

  it('the re-confirmation: current, due soon, overdue within grace, lapsed beyond; never when no day is set', () => {
    const policy = { remind_days: 30, grace_days: 30 };
    expect(reconfirmationState(null, '2026-11-08', policy)).toBe('NEVER');
    expect(reconfirmationState('2027-01-31', '2026-11-08', policy)).toBe('CURRENT');
    expect(reconfirmationState('2026-12-01', '2026-11-08', policy)).toBe('DUE_SOON');
    expect(reconfirmationState('2026-11-08', '2026-11-08', policy)).toBe('DUE_SOON');
    expect(reconfirmationState('2026-11-07', '2026-11-08', policy)).toBe('OVERDUE');
    expect(reconfirmationState('2026-10-09', '2026-11-08', policy)).toBe('OVERDUE');
    expect(reconfirmationState('2026-10-08', '2026-11-08', policy)).toBe('LAPSED');
    expect(reconfirmationAlertFacet('CURRENT')).toBeNull();
    expect(reconfirmationAlertFacet('NEVER')).toBeNull();
    expect(reconfirmationAlertFacet('LAPSED')).toBe('OVERDUE');
    expect(reconfirmationAlertFacet('DUE_SOON')).toBe('DUE_SOON');
  });

  it('validates the re-confirmation and remediation and export rules', () => {
    const rule = builtInDefault('VENDOR_RECONFIRMATION', 'DEFAULT');
    expect(reconfirmationPolicyOf(rule?.params)).toMatchObject({ interval_months: 12, declaration_version: 'V1' });
    expect(() => reconfirmationPolicyOf({ interval_months: 12, remind_days: 1, grace_days: 1, declaration_version: 'V1', declaration_text: 'short' })).toThrow(DomainError);
    expect(remediationPolicyOf({ ...REMEDIATION_POLICY_DEFAULTS })).toEqual(REMEDIATION_POLICY_DEFAULTS);
    expect(ocdsExportPolicyOf({ ...OCDS_EXPORT_DEFAULTS })).toEqual({ include_owners: false, include_contact: false });
    expect(() => ocdsExportPolicyOf({ include_owners: 'yes', include_contact: false })).toThrow(DomainError);
  });

  it('a remediation plan: agreed by the contractor with actions, completed only when every action is verified', () => {
    expect(nextRemediationStatus('PROPOSED', 'AGREE', { actions: ['OPEN'] })).toBe('AGREED');
    expect(() => nextRemediationStatus('PROPOSED', 'AGREE', { actions: [] })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(nextRemediationStatus('AGREED', 'START', { actions: ['OPEN'] })).toBe('IN_PROGRESS');
    expect(() => nextRemediationStatus('IN_PROGRESS', 'COMPLETE', { actions: ['VERIFIED', 'DONE'] })).toThrow(expect.objectContaining({ code: 'REMEDIATION_STATE_INVALID' }));
    expect(nextRemediationStatus('IN_PROGRESS', 'COMPLETE', { actions: ['VERIFIED'] })).toBe('COMPLETED');
    expect(nextRemediationStatus('IN_PROGRESS', 'FAIL', { actions: ['OPEN'], reason: 'the contractor stopped answering' })).toBe('FAILED');
    expect(() => nextRemediationStatus('COMPLETED', 'CANCEL', { actions: [], reason: 'too late to cancel' })).toThrow(expect.objectContaining({ code: 'REMEDIATION_STATE_INVALID' }));
  });
});

describe('disputes and export (V16, V18)', () => {
  it('counts the disputes and the share upheld among the decided ones', () => {
    const stats = disputeStats([
      { kind: 'PETITION', outcome: 'UPHELD', openedOn: '2026-01-01', closedOn: '2026-01-11' },
      { kind: 'PETITION', outcome: 'REJECTED', openedOn: '2026-02-01', closedOn: '2026-02-04' },
      { kind: 'CLAIM', outcome: 'REJECTED', openedOn: '2026-03-01', closedOn: '2026-03-04' },
      { kind: 'CLAIM', outcome: 'OPEN', openedOn: '2026-04-01', closedOn: null },
      { kind: 'PETITION', outcome: 'WITHDRAWN', openedOn: '2026-05-01', closedOn: '2026-05-03' },
    ]);
    expect(stats).toEqual({ total: 5, open: 1, upheld: 1, rejected: 2, withdrawn: 1, upheldPct: 33, meanDaysToClose: 4.5 });
    expect(disputeStats([])).toEqual({ total: 0, open: 0, upheld: 0, rejected: 0, withdrawn: 0, upheldPct: null, meanDaysToClose: null });
  });

  it('builds an OCDS party with the tax code as identifier and owners and contact only when asked', () => {
    const source = { id: 'internal', legalName: 'ABC Co', taxIdentifier: '0312345678', registeredAddress: '1 Le Loi', phone: '0901234567', email: 'a@abc.vn', legalRepName: 'Nguyen A', roles: ['tenderer'] as const, owners: [{ name: 'Tran B', sharePct: '60.00', kind: 'PERSON' as const }] };
    const bare = ocdsParty(source, { includeOwners: false, includeContact: false });
    expect(bare).toEqual({ id: 'VN-MST-0312345678', name: 'ABC Co', identifier: { scheme: 'VN-MST', id: '0312345678', legalName: 'ABC Co' }, address: { streetAddress: '1 Le Loi', countryName: 'Viet Nam' }, roles: ['tenderer'] });
    expect(JSON.stringify(bare)).not.toContain('internal');
    const full = ocdsParty(source, { includeOwners: true, includeContact: true });
    expect(full.beneficialOwners).toEqual([{ name: 'Tran B', type: 'person', share: '60.00' }]);
    expect(full.contactPoint).toEqual({ name: 'Nguyen A', telephone: '0901234567', email: 'a@abc.vn' });
  });
});

describe('registration', () => {
  it('registers the rule types, the alert types and the indicators of the lane', () => {
    registerAllGovernanceRules();
    for (const type of ['VENDOR_LINK_RULE', 'VENDOR_BID_RIGGING', 'VENDOR_INVESTIGATION', 'VENDOR_SCREENING', 'VENDOR_RECONFIRMATION', 'VENDOR_REMEDIATION', 'VENDOR_OCDS_EXPORT']) {
      const found = builtInDefault(type, 'DEFAULT');
      expect(found?.legalStatus).toBe('UNVERIFIED');
    }
    for (const kind of PORTAL_REQUEST_KINDS) expect(builtInDefault('VENDOR_PORTAL', kind)?.legalStatus).toBe('UNVERIFIED');
    for (const code of VND3_ALERT_CODES) {
      const alert = builtInDefault('ALERT_TYPE', code);
      expect(alert?.params).toMatchObject({ source: 'VENDOR' });
      expect(String(alert?.params.consequence).length).toBeGreaterThan(10);
      expect(String(alert?.params.expected_action).length).toBeGreaterThan(10);
    }
    for (const code of ['VENDOR_LEAD_PRECISION', 'VENDOR_LEADS_OPEN', 'VENDOR_SCREENING_IN_TIME', 'VENDOR_PORTAL_RESPONSE_IN_TIME', 'VENDOR_RECONFIRMATION_CURRENT']) {
      expect(builtInDefault('KPI_DEFINITION', code)?.params).toMatchObject({ numerator: expect.any(String), denominator: expect.any(String), source: expect.any(String) });
    }
    expect(Object.keys(VND3_FACET_SEVERITY).length).toBeGreaterThan(5);
  });

  it('fills the places of a text and fails loudly on a missing value', () => {
    expect(vnd3Fill(VND3_TEXT.home.reconfirm_title, { name: 'ABC' })).toContain('ABC');
    expect(() => vnd3Fill(VND3_TEXT.home.reconfirm_title, {})).toThrow();
  });
});
