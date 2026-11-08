import { DomainError } from '../src/errors';
import { OC4IDS_PROJECT_REQUIRED, PORTAL_DEFAULT_FIELDS, PORTAL_FIELDS, KeyedRateLimiter, assertPortalSlug, cutToAllowed, oc4idsPackage, portalDefaults, portalPolicyOf, projectPortalRecord, publishableProject, validateOc4idsPackage } from '../src/portal-fields';
import type { PortalProjectFacts, PublisherInput } from '../src/portal-fields';
import { accessCodeFrom, assertGiftClose, assertGiftInput, assertHandlerIndependent, assertWhistleInput, assertWhistleMove, giftDefaults, giftPolicyOf, giftReading, hashAccessCode, isAccessCode, nextWhistleStatus, normalizeAccessCode, whistleClock, whistleDefaults, whistlePolicyOf } from '../src/whistle';
import { assertPhotoFindingMove, findPhotoPairs, nextPhotoFindingStatus, photoIntegrityDefaults } from '../src/photo-findings';
import type { PhotoFact } from '../src/photo-findings';
import { auditStandingDefaults, isOverdueRecommendation, rankStandings, standingOf } from '../src/audit-standing';
import type { RecommendationFact } from '../src/audit-standing';
import { assertPeriodOpen, assertSignedForDelivery, assertSignerIsApprover, assertUnlock, eventLocks, mofFormOf, periodKeyOf, periodReportDefaults, periodReportPolicyOf } from '../src/period-report';
import { registerGov12Rules, builtInDefault, validateRuleParams } from '../src/governance-rules';
import { gov12RuleTypes } from '../src/gov12-rule-types';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

const FACTS: PortalProjectFacts = { code: 'DA-001', name: 'Road to the commune', status: 'IMPLEMENTATION', classification: 'PUBLIC', projectGroup: 'B', totalInvestmentVnd: '120000000000', startYear: 2025, endYear: 2027, authorityName: 'Provincial Board', updatedOn: '2026-11-01' };
const INPUT: PublisherInput = { summary: 'A road of 12 km that joins two communes.', sector: 'transport.road', projectType: 'construction', purpose: 'economic' };

describe('public portal allow-list (G4-9)', () => {
  it('shows only the allowed fields and never the ones a tenant did not choose', () => {
    const record = projectPortalRecord(FACTS, INPUT, PORTAL_DEFAULT_FIELDS);
    expect(Object.keys(record).sort()).toEqual([...PORTAL_DEFAULT_FIELDS].sort());
    const narrow = projectPortalRecord(FACTS, INPUT, ['project_code', 'title']);
    expect(narrow).toEqual({ project_code: 'DA-001', title: 'Road to the commune' });
  });

  it('cuts a stored record again on the way out: a field that is no longer allowed, or not in the catalogue, is dropped', () => {
    const stored = { project_code: 'DA-001', title: 'T', progress_pct: '5', internal_note: 'secret', created_by: 'u1', budget_vnd: { nested: true } };
    expect(cutToAllowed(stored, ['project_code', 'title', 'budget_vnd'])).toEqual({ project_code: 'DA-001', title: 'T' });
  });

  it('shows no project that is confidential, internal, an idea or rejected', () => {
    expect(publishableProject({ classification: 'PUBLIC', status: 'IMPLEMENTATION' })).toBe(true);
    for (const classification of ['INTERNAL', 'CONFIDENTIAL']) expect(publishableProject({ classification, status: 'IMPLEMENTATION' })).toBe(false);
    for (const status of ['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED']) expect(publishableProject({ classification: 'PUBLIC', status })).toBe(false);
    expect(codeOf(() => projectPortalRecord({ ...FACTS, classification: 'CONFIDENTIAL' }, INPUT, PORTAL_DEFAULT_FIELDS))).toBe('PORTAL_NOT_PUBLISHABLE');
  });

  it('refuses markup and unknown codes in what the publisher wrote', () => {
    expect(codeOf(() => projectPortalRecord(FACTS, { ...INPUT, summary: 'Click <a href="x">here</a> now please' }, PORTAL_DEFAULT_FIELDS))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => projectPortalRecord(FACTS, { ...INPUT, sector: 'mining' }, PORTAL_DEFAULT_FIELDS))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => projectPortalRecord(FACTS, { ...INPUT, summary: 'short' }, PORTAL_DEFAULT_FIELDS))).toBe('VALIDATION_FAILED');
  });

  it('keeps the catalogue free of anything that names a person, an internal id or a finding', () => {
    for (const field of PORTAL_FIELDS) expect(field).not.toMatch(/user|member|person|email|phone|account|bank|_id$|audit|flag|comment|path|key/);
  });

  it('reads the policy and always keeps the project code', () => {
    expect(portalPolicyOf({ allowed_fields: ['title'], rate_per_minute: 30, page_size_max: 50 })).toEqual({ allowed_fields: ['project_code', 'title'], rate_per_minute: 30, page_size_max: 50 });
    expect(codeOf(() => portalPolicyOf({ allowed_fields: ['title', 'password'], rate_per_minute: 30, page_size_max: 50 }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => portalPolicyOf({ allowed_fields: [], rate_per_minute: 30, page_size_max: 50 }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => portalPolicyOf({ allowed_fields: ['title'], rate_per_minute: 0, page_size_max: 50 }))).toBe('VALIDATION_FAILED');
    expect(portalDefaults().rate_per_minute).toBe(60);
    expect(codeOf(() => assertPortalSlug('Bad Slug'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertPortalSlug('cao-bang'))).toBe('NO_ERROR');
    expect(codeOf(() => assertPortalSlug('a--b'))).toBe('VALIDATION_FAILED');
  });
});

describe('OC4IDS export validated offline against the required fields of the standard', () => {
  const publish = (records: ReturnType<typeof projectPortalRecord>[]) => oc4idsPackage({ records, idPrefix: 'VN-CB', publisher: { name: 'Provincial Board' }, license: 'https://example.org/license', publicationPolicy: 'https://example.org/policy', publishedAt: new Date('2026-11-08T00:00:00Z') });

  it('holds every required project field when the default allow-list is used', () => {
    const exported = publish([projectPortalRecord(FACTS, INPUT, PORTAL_DEFAULT_FIELDS)]);
    expect(validateOc4idsPackage(exported)).toEqual([]);
    const [project] = exported.projects;
    for (const key of OC4IDS_PROJECT_REQUIRED) expect(project).toHaveProperty(key);
    expect(project).toMatchObject({ id: 'VN-CB-DA-001', status: 'implementation', sector: ['transport.road'], period: { startDate: '2025-01-01', endDate: '2027-12-31' }, budget: { amount: { amount: '120000000000', currency: 'VND' } }, publicAuthority: { name: 'Provincial Board' } });
  });

  it('says exactly which required field the allow-list took away, and invents nothing', () => {
    const exported = publish([projectPortalRecord(FACTS, INPUT, ['project_code', 'title', 'status', 'updated_on'])]);
    const issues = validateOc4idsPackage(exported).map((issue) => `${issue.path}:${issue.problem}`);
    expect(issues).toEqual(['projects[0].description:MISSING', 'projects[0].period:MISSING', 'projects[0].sector:MISSING', 'projects[0].purpose:MISSING', 'projects[0].type:MISSING', 'projects[0].budget:MISSING', 'projects[0].publicAuthority:MISSING']);
  });

  it('refuses a package with a missing envelope field, a wrong code or a wrong shape', () => {
    expect(validateOc4idsPackage({ projects: [] }).map((issue) => issue.path)).toEqual(['version', 'publisher', 'license', 'publicationPolicy', 'publishedDate']);
    const exported = publish([projectPortalRecord(FACTS, INPUT, PORTAL_DEFAULT_FIELDS)]);
    const broken = JSON.parse(JSON.stringify(exported)) as { projects: Array<Record<string, unknown>> };
    broken.projects[0] = { ...(broken.projects[0] as Record<string, unknown>), status: 'running', sector: ['mining'], budget: { amount: { amount: '1.5', currency: 'VND' } }, updated: '2026-11-01' };
    expect(validateOc4idsPackage(broken).map((issue) => `${issue.path}:${issue.problem}`)).toEqual(['projects[0].updated:WRONG_TYPE', 'projects[0].status:NOT_IN_CODELIST', 'projects[0].sector:NOT_IN_CODELIST', 'projects[0].budget.amount:WRONG_TYPE']);
    expect(validateOc4idsPackage('x')).toEqual([{ path: '$', problem: 'WRONG_TYPE' }]);
  });

  it('is the same text for the same records', () => {
    const records = [projectPortalRecord(FACTS, INPUT, PORTAL_DEFAULT_FIELDS)];
    expect(JSON.stringify(publish(records))).toBe(JSON.stringify(publish(records)));
  });
});

describe('the rate limiter that holds no identity', () => {
  it('refuses beyond the limit in a window, per key, and starts again after it', () => {
    let now = 0;
    const limiter = new KeyedRateLimiter({ limit: 2, windowSeconds: 60, now: () => now });
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.consume('b').allowed).toBe(true);
    now = 61_000;
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.size()).toBe(1);
  });

  it('is bounded by the number of keys', () => {
    const limiter = new KeyedRateLimiter({ limit: 1, windowSeconds: 60, maxKeys: 3, now: () => 0 });
    for (let index = 0; index < 50; index += 1) limiter.consume(`k${index}`);
    expect(limiter.size()).toBe(3);
  });
});

describe('anonymous channel and gifts register (G4-12)', () => {
  it('makes an access code from random bytes, shows no look-alike letters, and keeps only its hash', () => {
    const code = accessCodeFrom(Uint8Array.from({ length: 40 }, (_, index) => index * 7));
    expect(code).toHaveLength(32);
    expect(isAccessCode(code)).toBe(true);
    expect(code).not.toMatch(/[01OI]/);
    expect(normalizeAccessCode(`${code.slice(0, 8)}-${code.slice(8, 16).toLowerCase()} ${code.slice(16)}`)).toBe(code);
    expect(hashAccessCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAccessCode(code)).not.toBe(hashAccessCode(`${code.slice(1)}A`));
    expect(codeOf(() => accessCodeFrom(new Uint8Array(5)))).toBe('VALIDATION_FAILED');
  });

  it('accepts a category and a text and nothing about the person', () => {
    expect(codeOf(() => assertWhistleInput({ category: 'CORRUPTION', text: 'A payment was approved without a measurement record.' }))).toBe('NO_ERROR');
    expect(codeOf(() => assertWhistleInput({ category: 'GOSSIP', text: 'A payment was approved without a measurement record.' }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertWhistleInput({ category: 'WASTE_OF_FUNDS', text: 'too short' }))).toBe('VALIDATION_FAILED');
  });

  it('moves a report along its edges and asks words for a resolution', () => {
    expect(nextWhistleStatus('RECEIVED', 'ACKNOWLEDGE')).toBe('ACKNOWLEDGED');
    expect(nextWhistleStatus('ACKNOWLEDGED', 'INVESTIGATE')).toBe('INVESTIGATING');
    expect(nextWhistleStatus('INVESTIGATING', 'RESOLVE')).toBe('RESOLVED');
    expect(codeOf(() => nextWhistleStatus('RECEIVED', 'RESOLVE'))).toBe('WHISTLE_STATE_INVALID');
    expect(codeOf(() => nextWhistleStatus('RESOLVED', 'DISMISS'))).toBe('WHISTLE_STATE_INVALID');
    expect(codeOf(() => assertWhistleMove({ move: 'RESOLVE', note: null }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertWhistleMove({ move: 'ACKNOWLEDGE', note: null }))).toBe('NO_ERROR');
  });

  it('keeps two clocks and keeps an involved handler out', () => {
    const policy = whistleDefaults();
    expect(whistleClock({ receivedOn: '2026-05-01', acknowledgedOn: null, closedOn: null }, '2026-05-09', policy)).toMatchObject({ acknowledgeDueOn: '2026-05-08', acknowledgeState: 'OVERDUE', resolveState: 'WAITING', resolveDueOn: '2026-07-30' });
    expect(whistleClock({ receivedOn: '2026-05-01', acknowledgedOn: '2026-05-08', closedOn: '2026-08-05' }, '2026-09-01', policy)).toMatchObject({ acknowledgeState: 'DONE_ON_TIME', resolveState: 'DONE_LATE' });
    expect(codeOf(() => assertHandlerIndependent({ handlerUnitIds: ['u1', 'u2'], subjectUnitId: 'u2' }))).toBe('WHISTLE_HANDLER_INVOLVED');
    expect(codeOf(() => assertHandlerIndependent({ handlerUnitIds: ['u1'], subjectUnitId: 'u2' }))).toBe('NO_ERROR');
    expect(codeOf(() => assertHandlerIndependent({ handlerUnitIds: ['u1'], subjectUnitId: null }))).toBe('NO_ERROR');
    expect(codeOf(() => whistlePolicyOf({ acknowledge_days: 30, resolve_days: 30, rate_per_hour: 5 }))).toBe('VALIDATION_FAILED');
  });

  it('judges a gift by the declaration day, the review line and the keep line', () => {
    const policy = giftDefaults();
    const small = giftReading({ receivedOn: '2026-02-01', declaredOn: '2026-02-04', valueVnd: '150000' }, policy);
    expect(small).toEqual({ late: false, declareDueOn: '2026-02-06', needsReview: false, mayBeKept: true });
    const big = giftReading({ receivedOn: '2026-02-01', declaredOn: '2026-02-10', valueVnd: '3000000' }, policy);
    expect(big).toEqual({ late: true, declareDueOn: '2026-02-06', needsReview: true, mayBeKept: false });
    expect(codeOf(() => assertGiftClose({ outcome: 'KEPT', reading: big, recipientId: 'r', reviewerId: 'x', note: 'Reviewed with the unit head' }))).toBe('GIFT_OUTCOME_REFUSED');
    expect(codeOf(() => assertGiftClose({ outcome: 'RETURNED', reading: big, recipientId: 'r', reviewerId: 'r', note: 'Reviewed with the unit head' }))).toBe('SELF_APPROVAL_DENIED');
    expect(codeOf(() => assertGiftClose({ outcome: 'RETURNED', reading: big, recipientId: 'r', reviewerId: 'x', note: '' }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertGiftClose({ outcome: 'KEPT', reading: small, recipientId: 'r', reviewerId: 'x', note: 'Below the line' }))).toBe('NO_ERROR');
    expect(codeOf(() => assertGiftInput({ giverName: 'ACME', giverKind: 'CONTRACTOR', valueVnd: '10.5', receivedOn: '2026-02-01', declaredOn: '2026-02-02', description: 'A box of tea' }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => giftPolicyOf({ declare_within_days: 5, review_over_vnd: '2000000', keep_up_to_vnd: '1000000' }))).toBe('VALIDATION_FAILED');
  });
});

describe('site photo findings across projects (G4-12)', () => {
  const photo = (id: string, projectId: string, extra: Partial<PhotoFact> = {}): PhotoFact => ({ id, projectId, sha256: id.padEnd(64, '0'), diaryDay: null, takenAt: null, lat: null, lng: null, ...extra });
  const policy = photoIntegrityDefaults();

  it('pairs the same file in two projects and the same place and moment in two projects', () => {
    const shared = 'a'.repeat(64);
    const pairs = findPhotoPairs(
      [
        photo('p1', 'A', { sha256: shared }),
        photo('p2', 'B', { sha256: shared }),
        photo('p3', 'A', { takenAt: new Date('2026-06-10T08:00:00Z'), lat: 10.8, lng: 106.7 }),
        photo('p4', 'B', { takenAt: new Date('2026-06-10T08:05:00Z'), lat: 10.80005, lng: 106.70005 }),
        photo('p5', 'B', { takenAt: new Date('2026-06-10T09:30:00Z'), lat: 10.8, lng: 106.7 }),
        photo('p6', 'B', { takenAt: new Date('2026-06-10T08:05:00Z'), lat: 10.9, lng: 106.8 }),
      ],
      policy,
    );
    expect(pairs.map((pair) => `${pair.kind}:${pair.firstId}:${pair.secondId}`)).toEqual(['SAME_FILE_OTHER_PROJECT:p1:p2', 'SAME_PLACE_AND_MOMENT_OTHER_PROJECT:p3:p4']);
    expect(pairs[1]).toMatchObject({ metres: 8, minutes: 5 });
  });

  it('reports a pair once with the stronger kind, and the same file on another day of one project', () => {
    const shared = 'b'.repeat(64);
    const when = new Date('2026-06-10T08:00:00Z');
    const pairs = findPhotoPairs([photo('q1', 'A', { sha256: shared, takenAt: when, lat: 10.8, lng: 106.7 }), photo('q2', 'B', { sha256: shared, takenAt: when, lat: 10.8, lng: 106.7 }), photo('q3', 'A', { sha256: 'c'.repeat(64), diaryDay: '2026-06-01' }), photo('q4', 'A', { sha256: 'c'.repeat(64), diaryDay: '2026-06-02' })], policy);
    expect(pairs.map((pair) => pair.kind)).toEqual(['SAME_FILE_OTHER_PROJECT', 'SAME_FILE_OTHER_DAY']);
  });

  it('never turns a missing EXIF into a finding', () => {
    expect(findPhotoPairs([photo('r1', 'A'), photo('r2', 'B')], policy)).toEqual([]);
  });

  it('moves a finding through review and keeps the authors out of the explanation', () => {
    expect(nextPhotoFindingStatus('OPEN', 'TAKE')).toBe('IN_REVIEW');
    expect(nextPhotoFindingStatus('IN_REVIEW', 'EXPLAIN')).toBe('EXPLAINED');
    expect(nextPhotoFindingStatus('EXPLAINED', 'REOPEN')).toBe('IN_REVIEW');
    expect(codeOf(() => nextPhotoFindingStatus('OPEN', 'EXPLAIN'))).toBe('PHOTO_FINDING_STATE_INVALID');
    expect(codeOf(() => assertPhotoFindingMove({ move: 'EXPLAIN', reason: 'Same truck photographed at the junction of both sites', actorId: 'a', photoAuthorIds: ['a', 'b'] }))).toBe('SELF_APPROVAL_DENIED');
    expect(codeOf(() => assertPhotoFindingMove({ move: 'EXPLAIN', reason: 'short', actorId: 'c', photoAuthorIds: ['a'] }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertPhotoFindingMove({ move: 'TAKE', reason: null, actorId: 'a', photoAuthorIds: ['a'] }))).toBe('NO_ERROR');
  });
});

describe('audit standing of investor units (G4-10)', () => {
  const policy = auditStandingDefaults();
  const fact = (status: RecommendationFact['status'], dueOn: string | null, amount: string | null = null, recovered = '0'): RecommendationFact => ({ status, dueOn, amountVnd: amount, recoveredVnd: recovered });

  it('counts by state, the money still owed and the score', () => {
    const standing = standingOf({ unitId: 'u1', unitCode: 'CDT-1' }, [fact('IN_PROGRESS', '2026-01-01', '5000000000', '1000000000'), fact('DISPUTED', '2026-01-01'), fact('ASSIGNED', '2026-12-31'), fact('CLOSED', '2026-01-01', '100', '100'), fact('CANCELLED', null)], '2026-06-01', policy);
    expect(standing).toMatchObject({ total: 4, open: 2, overdue: 1, disputed: 1, closed: 1, owedVnd: '4000000000', closedPct: 25 });
    expect(standing.score).toBe(1 * 3 + 1 * 2 + 2 * 1 + 4 * 1);
    expect(isOverdueRecommendation(fact('DISPUTED', '2026-01-01'), '2026-06-01')).toBe(false);
    expect(isOverdueRecommendation(fact('OPEN', '2026-06-01'), '2026-06-01')).toBe(false);
    expect(isOverdueRecommendation(fact('OPEN', '2026-05-31'), '2026-06-01')).toBe(true);
  });

  it('orders the units for follow-up, leaves a clean unit unranked and never depends on the order of the rows', () => {
    const a = standingOf({ unitId: 'ua', unitCode: 'A' }, [fact('OPEN', '2026-01-01', '2000000000')], '2026-06-01', policy);
    const b = standingOf({ unitId: 'ub', unitCode: 'B' }, [fact('OPEN', '2026-01-01', '2000000000')], '2026-06-01', policy);
    const c = standingOf({ unitId: 'uc', unitCode: 'C' }, [fact('OPEN', '2026-01-01'), fact('OPEN', '2026-01-01')], '2026-06-01', policy);
    const clean = standingOf({ unitId: 'ud', unitCode: 'D' }, [fact('CLOSED', null)], '2026-06-01', policy);
    const none = standingOf({ unitId: 'ue', unitCode: 'E' }, [], '2026-06-01', policy);
    const ranked = rankStandings([clean, b, none, a, c]);
    expect(ranked.map((one) => `${one.unitCode}:${one.rank}`)).toEqual(['C:1', 'A:2', 'B:3', 'D:null', 'E:null']);
    expect(rankStandings([c, a, none, clean, b]).map((one) => one.unitCode)).toEqual(ranked.map((one) => one.unitCode));
  });
});

describe('period reports for the Ministry: signature and lock (G4-6)', () => {
  const policy = periodReportDefaults();
  const digest = 'd'.repeat(64);

  it('names the form and the period key of each kind', () => {
    expect(mofFormOf('MOF-DIS-QUARTERLY')?.periodKind).toBe('QUARTER');
    expect(mofFormOf('NOPE')).toBeUndefined();
    expect(periodKeyOf({ kind: 'MONTH', year: 2026, index: 3 })).toBe('MONTH:2026-03');
    expect(periodKeyOf({ kind: 'QUARTER', year: 2026, index: 1 })).toBe('QUARTER:2026-Q1');
    expect(periodKeyOf({ kind: 'YEAR', year: 2026 })).toBe('YEAR:2026');
    expect(periodKeyOf({ kind: 'AS_OF', year: 2026, day: '2026-11-06' })).toBe('AS_OF:2026-11-06');
    expect(codeOf(() => periodKeyOf({ kind: 'MONTH', year: 2026, index: 13 }))).toBe('VALIDATION_FAILED');
  });

  it('sends to the Ministry only a copy with a real signature over its own digest', () => {
    const run = (signature: Parameters<typeof assertSignedForDelivery>[0]['signature'], copyDigestSha256 = digest, receiver = 'MOF') => codeOf(() => assertSignedForDelivery({ receiver, policy, signature, copyDigestSha256 }));
    expect(run(null)).toBe('REPORT_SIGNATURE_REQUIRED');
    expect(run({ digestSha256: digest, provider: 'MOCK', signerId: 's' })).toBe('REPORT_SIGNATURE_REQUIRED');
    expect(run({ digestSha256: 'e'.repeat(64), provider: 'REMOTE_CA', signerId: 's' })).toBe('REPORT_SIGNATURE_REQUIRED');
    expect(run({ digestSha256: digest, provider: 'REMOTE_CA', signerId: 's' })).toBe('NO_ERROR');
    expect(run(null, digest, 'INTERNAL')).toBe('NO_ERROR');
  });

  it('lets only the approver sign', () => {
    expect(codeOf(() => assertSignerIsApprover({ signerId: 'a', approverId: 'a' }))).toBe('NO_ERROR');
    expect(codeOf(() => assertSignerIsApprover({ signerId: 'b', approverId: 'a' }))).toBe('SCOPE_DENIED');
  });

  it('locks a period on the event the policy names and unlocks only by a second person with a reason', () => {
    expect(eventLocks('SIGNED', policy)).toBe(true);
    expect(eventLocks('ACCEPTED', policy)).toBe(true);
    expect(eventLocks('SIGNED', { ...policy, lock_after: 'ACCEPTED' })).toBe(false);
    expect(codeOf(() => assertPeriodOpen({ lockedBy: 'a', unlockedAt: null }))).toBe('PERIOD_LOCKED');
    expect(codeOf(() => assertPeriodOpen({ lockedBy: 'a', unlockedAt: '2026-11-08T00:00:00Z' }))).toBe('NO_ERROR');
    expect(codeOf(() => assertPeriodOpen(null))).toBe('NO_ERROR');
    const lock = { lockedBy: 'a', unlockedAt: null };
    expect(codeOf(() => assertUnlock({ lock, actorId: 'a', reason: 'The Ministry asked for a correction' }, policy))).toBe('SELF_APPROVAL_DENIED');
    expect(codeOf(() => assertUnlock({ lock, actorId: 'b', reason: 'short' }, policy))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertUnlock({ lock, actorId: 'b', reason: 'The Ministry asked for a correction' }, policy))).toBe('NO_ERROR');
    expect(codeOf(() => assertUnlock({ lock: null, actorId: 'b', reason: 'The Ministry asked for a correction' }, policy))).toBe('PERIOD_LOCK_NOT_FOUND');
    expect(periodReportPolicyOf({ signature_required_receivers: ['MOF', 'KBNN'], lock_after: 'ACCEPTED', unlock_reason_min_chars: 20 }).signature_required_receivers).toEqual(['MOF', 'KBNN']);
    expect(codeOf(() => periodReportPolicyOf({ signature_required_receivers: ['bad receiver'], lock_after: 'ACCEPTED', unlock_reason_min_chars: 20 }))).toBe('VALIDATION_FAILED');
  });
});

describe('the governance rules of lane GOV-12', () => {
  it('registers eight types whose defaults pass their own schema and are flagged unverified with a source', () => {
    registerGov12Rules();
    const types = gov12RuleTypes();
    expect(types.map((type) => type.type)).toEqual(['COMMUNITY_MONITORING_RULE', 'DOC_TRANSMITTAL_RULE', 'PUBLIC_PORTAL_RULE', 'WHISTLE_RULE', 'GIFT_RULE', 'PHOTO_INTEGRITY_RULE', 'PERIOD_REPORT_RULE', 'AUDIT_STANDING_RULE']);
    for (const type of types) {
      expect(type.legalStatus).toBe('UNVERIFIED');
      expect(type.source).not.toBe('');
      const def = builtInDefault(type.type, 'DEFAULT');
      expect(def).toBeDefined();
      expect(() => validateRuleParams(type.type, def?.params)).not.toThrow();
    }
    expect(builtInDefault('COMMUNITY_MONITORING_RULE', 'DEFAULT')?.params).toMatchObject({ notice_days: 45 });
  });

  it('refuses a monitoring rule whose reminder is not shorter than its deadlines', () => {
    registerGov12Rules();
    expect(() => validateRuleParams('COMMUNITY_MONITORING_RULE', { notice_days: 10, response_days: 15, reminder_days: 12 })).toThrow();
    expect(() => validateRuleParams('GIFT_RULE', { declare_within_days: 5, review_over_vnd: '2000000', keep_up_to_vnd: '1000000' })).toThrow();
  });

  it('refuses in the rule what the policy would refuse later: a zero or padded money step, a field named twice (review of the lane)', () => {
    registerGov12Rules();
    const weights = { weight_overdue: 3, weight_disputed: 2, weight_open: 1, weight_money: 1 };
    expect(() => validateRuleParams('AUDIT_STANDING_RULE', { ...weights, money_step_vnd: '0' })).toThrow();
    expect(() => validateRuleParams('AUDIT_STANDING_RULE', { ...weights, money_step_vnd: '0007' })).toThrow();
    expect(() => validateRuleParams('AUDIT_STANDING_RULE', { ...weights, money_step_vnd: '1000000000' })).not.toThrow();
    expect(() => validateRuleParams('PUBLIC_PORTAL_RULE', { allowed_fields: ['title', 'title'], rate_per_minute: 60, page_size_max: 100 })).toThrow();
    expect(() => validateRuleParams('PUBLIC_PORTAL_RULE', { allowed_fields: ['title', 'summary'], rate_per_minute: 60, page_size_max: 100 })).not.toThrow();
  });

  it('answers a day that does not exist with VALIDATION_FAILED and not with a native error (review of the lane)', () => {
    expect(codeOf(() => periodKeyOf({ kind: 'AS_OF', year: 2026, day: '2026-13-01' }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => periodKeyOf({ kind: 'AS_OF', year: 2026, day: '2026-02-30' }))).toBe('VALIDATION_FAILED');
  });

  it('checks the types of the envelope of an OC4IDS package (review of the lane)', () => {
    const issues = validateOc4idsPackage({ version: null, publisher: null, license: 42, publicationPolicy: false, publishedDate: '2026-11-08T00:00:00Z', projects: [] }).map((issue) => issue.path + ':' + issue.problem);
    expect(issues).toEqual(['version:WRONG_TYPE', 'license:WRONG_TYPE', 'publicationPolicy:WRONG_TYPE', 'publisher:WRONG_TYPE']);
  });
});
