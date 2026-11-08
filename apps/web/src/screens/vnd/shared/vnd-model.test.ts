import { describe, expect, it } from 'vitest';
import {
  CASE_STATUSES,
  PATHS,
  banLastDay,
  banRange,
  camel,
  caseMoves,
  caseSteps,
  countdown,
  coverageWidth,
  daysBetween,
  initialsOf,
  isDay,
  isFinalStatus,
  isProposer,
  isUuid,
  maskedAccount,
  paramNumber,
  percentText,
  periodsOf,
  profileUpdateBody,
  requirementFindings,
  resourceId,
  shareValue,
  textProblem,
  ventureProblems,
  ventureTotal,
  vietnamDay,
} from './vnd-model';
import type { Profile, Qualification, Requirement } from './vnd-model';
import { profile, qualification } from './test/vnd-test-support';

const periods = { GROUP_1: { min_months: 36, max_months: 60, behaviours: 'a' }, GROUP_2: { min_months: 12, max_months: 36, behaviours: 'b' }, GROUP_3: { min_months: 6, max_months: 12, behaviours: 'c' } };

describe('camel', () => {
  it('turns the codes of the contract into the segments of a catalogue key', () => {
    expect(camel('NOT_COMPARING_DOCUMENTS')).toBe('notComparingDocuments');
    expect(camel('QUALITY_MANAGEMENT_ISO9001')).toBe('qualityManagementIso9001');
    expect(camel('key-staff')).toBe('keyStaff');
    expect(camel('GROUP_1')).toBe('group1');
    expect(camel('III')).toBe('iii');
    expect(camel('OTHER')).toBe('other');
  });
});

describe('days and the countdown', () => {
  it('reads the Vietnam day of an instant (seven hours ahead)', () => {
    expect(vietnamDay('2026-11-08T20:00:00.000Z')).toBe('2026-11-09');
    expect(vietnamDay('2026-11-08')).toBe('2026-11-08');
    expect(vietnamDay(null)).toBe('');
    expect(vietnamDay('not a date')).toBe('');
  });

  it('counts whole days between two days', () => {
    expect(daysBetween('2026-11-08', '2026-11-12')).toBe(4);
    expect(daysBetween('2026-11-08', '2026-11-01')).toBe(-7);
  });

  it('counts what is left against the answer, never against the clock of the machine', () => {
    expect(countdown('2026-11-12T03:00:00.000Z', '2026-11-08T03:00:00.000Z')).toEqual({ done: false, days: 4, hours: 0 });
    expect(countdown('2026-11-09T09:30:00.000Z', '2026-11-08T03:00:00.000Z')).toEqual({ done: false, days: 1, hours: 7 });
    expect(countdown('2026-11-08T03:00:00.000Z', '2026-11-08T03:00:00.000Z')).toEqual({ done: true, days: 0, hours: 0 });
    expect(countdown('2026-11-01T00:00:00.000Z', '2026-11-08T03:00:00.000Z').done).toBe(true);
    expect(countdown('garbage', '2026-11-08T03:00:00.000Z').done).toBe(true);
  });

  it('checks calendar days', () => {
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('08/11/2026')).toBe(false);
  });
});

describe('the case: steps, moves, ban period', () => {
  it('puts a running case on its step and leaves the later ones upcoming', () => {
    const steps = caseSteps({ status: 'NOTICE_SENT' }, [{ to_status: 'PROPOSED' }, { to_status: 'NOTICE_SENT' }]);
    expect(steps.map((step) => `${step.code}:${step.status}`)).toEqual(['PROPOSED:done', 'NOTICE_SENT:current', 'RESPONSE_RECEIVED:upcoming', 'DECIDED:upcoming', 'EFFECTIVE:upcoming', 'END:upcoming']);
  });

  it('marks the steps a dismissed case never reached as skipped and the end as the step it is at', () => {
    const steps = caseSteps({ status: 'DISMISSED' }, [{ to_status: 'PROPOSED' }, { to_status: 'DISMISSED' }]);
    expect(steps.map((step) => `${step.code}:${step.status}`)).toEqual(['PROPOSED:done', 'NOTICE_SENT:skipped', 'RESPONSE_RECEIVED:skipped', 'DECIDED:skipped', 'EFFECTIVE:skipped', 'END:current']);
  });

  it('shows every step of an expired ban as done', () => {
    const events = ['PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED', 'EFFECTIVE', 'EXPIRED'].map((to_status) => ({ to_status }));
    expect(caseSteps({ status: 'EXPIRED' }, events).map((step) => step.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
  });

  it('offers only the moves the status allows', () => {
    expect(caseMoves('PROPOSED')).toEqual(['SEND_NOTICE', 'WITHDRAW']);
    expect(caseMoves('NOTICE_SENT')).toEqual(['RECORD_RESPONSE', 'CLOSE_NO_RESPONSE', 'WITHDRAW']);
    expect(caseMoves('RESPONSE_RECEIVED')).toEqual(['WITHDRAW']);
    for (const status of ['DECIDED', 'EFFECTIVE', 'EXPIRED', 'LIFTED', 'DISMISSED'] as const) expect(caseMoves(status)).toEqual([]);
    expect(CASE_STATUSES.filter(isFinalStatus)).toEqual(['EXPIRED', 'LIFTED', 'DISMISSED']);
  });

  it('works the ban range from the longest of the shortest to the sum of the longest, cut at the cumulative maximum', () => {
    expect(banRange(['GROUP_2'], periods, undefined)).toEqual({ min: 12, max: 36 });
    expect(banRange(['GROUP_2', 'GROUP_3'], periods, undefined)).toEqual({ min: 12, max: 48 });
    expect(banRange(['GROUP_1', 'GROUP_2'], periods, 60)).toEqual({ min: 36, max: 60 });
    expect(banRange(['GROUP_9'], periods, undefined)).toBeNull();
    expect(banRange([], periods, undefined)).toBeNull();
  });

  it('works the last day of a ban', () => {
    expect(banLastDay('2026-01-01', 12)).toBe('2026-12-31');
    expect(banLastDay('2026-01-31', 1)).toBe('2026-02-27');
    expect(banLastDay('2026-03-15', 6)).toBe('2026-09-14');
  });

  it('reads the periods and the numbers of the rule defensively', () => {
    expect(periodsOf({ GROUP_1: { min_months: 36, max_months: 60, behaviours: 'x' }, BAD: { min_months: 'a' }, ALSO_BAD: 3 })).toEqual({ GROUP_1: { min_months: 36, max_months: 60, behaviours: 'x' } });
    expect(periodsOf(null)).toEqual({});
    expect(paramNumber({ params: { decide_within_days: 15, other: 'x' } } as never, 'decide_within_days')).toBe(15);
    expect(paramNumber({ params: { other: 'x' } } as never, 'other')).toBeUndefined();
    expect(paramNumber(undefined, 'x')).toBeUndefined();
  });

  it('takes the proposer for the signed-in person only when the names are the same', () => {
    expect(isProposer({ proposed_by_name: 'Lê Thị Hoa' }, ' Lê Thị Hoa ')).toBe(true);
    expect(isProposer({ proposed_by_name: 'Lê Thị Hoa' }, 'Nguyễn Văn An')).toBe(false);
    expect(isProposer({ proposed_by_name: null }, 'Nguyễn Văn An')).toBe(false);
    expect(isProposer({ proposed_by_name: 'Lê Thị Hoa' }, undefined)).toBe(false);
    expect(isProposer({ proposed_by_name: 'Lê Thị Hoa' }, '')).toBe(false);
  });
});

describe('the account number is only ever masked', () => {
  it('keeps a masked number as it is and cuts a bare number to its last four digits', () => {
    expect(maskedAccount('••••6789')).toBe('••••6789');
    expect(maskedAccount('****6789')).toBe('****6789');
    expect(maskedAccount('1234567890123')).toBe('••••0123');
    expect(maskedAccount('VCB 12345678')).toBe('VCB ••••5678');
    expect(maskedAccount('1234')).toBe('1234');
  });
});

describe('certificates against the requirements', () => {
  const req = (over: Partial<Requirement> = {}): Requirement => ({ kind: 'CONSTRUCTION_ACTIVITY', min_grade: null, scope_keyword: null, ...over });
  const cert = (over: Record<string, unknown> = {}): Qualification => qualification(1, over) as unknown as Qualification;

  it('is met by a checked certificate in force of the kind', () => {
    expect(requirementFindings([req()], [cert()])).toEqual([{ kind: 'CONSTRUCTION_ACTIVITY', gap: null, qualificationId: cert().id }]);
  });

  it('names the gap of the certificate nearest to meeting the requirement', () => {
    expect(requirementFindings([req()], [])[0]?.gap).toBe('MISSING');
    expect(requirementFindings([req()], [cert({ verified_at: null, verified_by_name: null })])[0]?.gap).toBe('NOT_VERIFIED');
    expect(requirementFindings([req()], [cert({ state: 'EXPIRED', days_left: -3 })])[0]?.gap).toBe('EXPIRED');
    expect(requirementFindings([req()], [cert({ state: 'REVOKED' })])[0]?.gap).toBe('REVOKED');
    expect(requirementFindings([req()], [cert({ state: 'NOT_STARTED' })])[0]?.gap).toBe('NOT_STARTED');
    expect(requirementFindings([req({ min_grade: 'I' })], [cert({ grade: 'II' })])[0]?.gap).toBe('GRADE_LOW');
    expect(requirementFindings([req({ min_grade: 'II' })], [cert({ grade: null })])[0]?.gap).toBe('GRADE_LOW');
    expect(requirementFindings([req({ scope_keyword: 'thủy lợi' })], [cert()])[0]?.gap).toBe('SCOPE_NOT_COVERED');
  });

  it('takes a higher grade and a scope that names the keyword (any case) as met', () => {
    expect(requirementFindings([req({ min_grade: 'III' })], [cert({ grade: 'I' })])[0]?.gap).toBeNull();
    expect(requirementFindings([req({ scope_keyword: 'GIAO THÔNG' })], [cert()])[0]?.gap).toBeNull();
  });

  it('prefers a certificate that meets the requirement to one that falls short', () => {
    const bad = cert({ state: 'EXPIRED', days_left: -3 });
    const good = qualification(2, { id: '00000000-0000-4000-8000-000600000099' }) as unknown as Qualification;
    expect(requirementFindings([req()], [bad, good])[0]).toEqual({ kind: 'CONSTRUCTION_ACTIVITY', gap: null, qualificationId: good.id });
  });

  it('reports the nearest gap when several certificates fall short', () => {
    const unchecked = cert({ verified_at: null, verified_by_name: null });
    const expired = qualification(2, { state: 'EXPIRED', days_left: -3, id: '00000000-0000-4000-8000-000600000098' }) as unknown as Qualification;
    expect(requirementFindings([req()], [expired, unchecked])[0]?.gap).toBe('NOT_VERIFIED');
  });
});

describe('joint ventures', () => {
  const member = (contractorId: string, share: string, lead = false) => ({ contractorId, share, lead });
  const A = '00000000-0000-4000-8000-000000000001';
  const B = '00000000-0000-4000-8000-000000000002';
  const C = '00000000-0000-4000-8000-000000000003';

  it('reads shares in hundredths so thirds add up to exactly 100', () => {
    expect(shareValue('33.33')).toBe(3333);
    expect(shareValue('33,34')).toBe(3334);
    expect(shareValue('60')).toBe(6000);
    expect(shareValue('abc')).toBeNaN();
    expect(shareValue('1.234')).toBeNaN();
    expect(ventureTotal([member(A, '33.33', true), member(B, '33.33'), member(C, '33.34')])).toBe(100);
  });

  it('accepts a plan of two members, one lead, shares totalling 100', () => {
    expect(ventureProblems([member(A, '60', true), member(B, '40')])).toEqual([]);
    expect(ventureProblems([member(A, '33.33', true), member(B, '33.33'), member(C, '33.34')])).toEqual([]);
  });

  it('names what is wrong with a plan', () => {
    expect(ventureProblems([member(A, '100', true)])).toContain('MEMBERS');
    expect(ventureProblems([member(A, '60', true), member('x', '40')])).toContain('MEMBERS');
    expect(ventureProblems([member(A, '60', true), member(A, '40')])).toContain('DUPLICATE');
    expect(ventureProblems([member(A, '60'), member(B, '40')])).toContain('LEAD');
    expect(ventureProblems([member(A, '60', true), member(B, '40', true)])).toContain('LEAD');
    expect(ventureProblems([member(A, '60', true), member(B, '30')])).toContain('TOTAL');
    expect(ventureProblems([member(A, '0', true), member(B, '100')])).toContain('SHARE');
    expect(ventureProblems([member(A, 'x', true), member(B, '40')])).toContain('SHARE');
  });
});

describe('the body of a profile update', () => {
  const original = profile() as unknown as Profile;

  it('carries only the fields that changed, and null for a field that was emptied', () => {
    expect(profileUpdateBody(original, { legal_rep_name: 'Nguyễn Văn An', legal_rep_position: 'Giám đốc', registered_address: '12 Phố Huế, Hà Nội', phone: '0901234567', email: 'lienhe@example.vn', business_registration_no: '0101234561' })).toEqual({});
    expect(profileUpdateBody(original, { legal_rep_name: ' Trần Văn B ', phone: '', registered_address: '12 Phố Huế, Hà Nội', legal_rep_position: 'Giám đốc', email: 'lienhe@example.vn', business_registration_no: '0101234561' })).toEqual({ legal_rep_name: 'Trần Văn B', phone: null });
  });

  it('treats a field the profile never had as unchanged when it stays empty', () => {
    const bare = { ...original, email: null } as Profile;
    expect(profileUpdateBody(bare, { email: '' })).not.toHaveProperty('email');
    expect(profileUpdateBody(bare, { email: 'a@b.vn' })).toEqual({ email: 'a@b.vn', legal_rep_name: null, legal_rep_position: null, registered_address: null, phone: null, business_registration_no: null });
  });
});

describe('small helpers', () => {
  it('measures a text by its trimmed length', () => {
    expect(textProblem('', 5, 10)).toBe('EMPTY');
    expect(textProblem('', 5, 10, false)).toBeNull();
    expect(textProblem('  abc ', 5, 10)).toBe('SHORT');
    expect(textProblem('abcde', 5, 10)).toBeNull();
    expect(textProblem('a'.repeat(11), 5, 10)).toBe('LONG');
  });

  it('knows an identifier, a name by its initials and a result id', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(initialsOf('Lê Thị Hoa')).toBe('TH');
    expect(initialsOf('Hoa')).toBe('H');
    expect(initialsOf(null)).toBe('?');
    expect(resourceId({ resource_id: 'abc' })).toBe('abc');
    expect(resourceId({})).toBeUndefined();
    expect(resourceId(null)).toBeUndefined();
  });

  it('writes percents and widths for the strip and the bar', () => {
    expect(percentText(null, 'vi')).toBe('–');
    expect(percentText(66.67, 'en')).toBe('66.7%');
    expect(coverageWidth({ coverage_pct: 140 } as never)).toBe(100);
    expect(coverageWidth({ coverage_pct: -5 } as never)).toBe(0);
  });

  it('builds the addresses the alert centre and the screens link by', () => {
    expect(PATHS.profile('a b')).toBe('/vnd/vnd-02?contractor=a%20b');
    expect(PATHS.caseOf('c1')).toBe('/vnd/vnd-03?case=c1');
    expect(PATHS.payee()).toBe('/vnd/vnd-04');
    expect(PATHS.payee('c1')).toBe('/vnd/vnd-04?contractor=c1');
    expect(PATHS.certificates('c1')).toBe('/vnd/vnd-05?contractor=c1');
    expect(PATHS.reputation('e1')).toBe('/vnd/vnd-06?event=e1');
  });
});
