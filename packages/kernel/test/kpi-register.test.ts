import type { DomainError } from '../src/errors';
import type { GovernanceRuleVersion, ResolvedGovernanceRule } from '../src/governance-rules';
import {
  CERT_STATUSES,
  CERT_SUBJECTS,
  KPI_RULE_TYPE,
  currentCertification,
  displayKpiValue,
  figureFlags,
  isCertStatus,
  isCertSubject,
  kpiDefinitionOf,
  kpiInfoOf,
  leaderGate,
  nextCertification,
  ragOfValue,
  resolveKpi,
  roundDecimalText,
  yearPacePct,
} from '../src/kpi-register';
import type { CertLine, FigureFacts } from '../src/kpi-register';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const rule = (params: Record<string, unknown>, over: Partial<GovernanceRuleVersion> = {}): GovernanceRuleVersion => ({
  id: 'rule-1',
  type: KPI_RULE_TYPE,
  code: 'X_RATE',
  version: 4,
  status: 'APPROVED',
  params,
  effectiveFrom: '2026-02-01',
  effectiveTo: '2027-01-01',
  unitId: null,
  ...over,
});

const full = {
  name: 'Tỷ lệ X',
  formula: 'A chia B nhân 100',
  numerator: 'A',
  denominator: 'B',
  exclusions: ['Loại 1', 'Loại 2'],
  unit: 'PERCENT',
  period: 'YEAR_TO_DATE',
  source: 'Phân hệ DIS',
  owner: 'CAPITAL_PLANNER',
  decimals: 2,
  refresh_hours: 12,
  allowed_lag_days: 8,
  rag_code: 'DISBURSEMENT_RATIO',
};

describe('the definition of an indicator (G0-4)', () => {
  it('is read out of the approved rule in force, with its version and the days of that version', () => {
    const definition = resolveKpi([rule(full)], 'X_RATE', '2026-06-01');
    expect(definition).toEqual({
      code: 'X_RATE',
      name: 'Tỷ lệ X',
      formula: 'A chia B nhân 100',
      numerator: 'A',
      denominator: 'B',
      exclusions: ['Loại 1', 'Loại 2'],
      unit: 'PERCENT',
      period: 'YEAR_TO_DATE',
      source: 'Phân hệ DIS',
      owner: 'CAPITAL_PLANNER',
      decimals: 2,
      refreshHours: 12,
      allowedLagDays: 8,
      ragCode: 'DISBURSEMENT_RATIO',
      version: 4,
      effectiveFrom: '2026-02-01',
      effectiveTo: '2027-01-01',
      origin: 'RULE',
      unverified: false,
      ruleId: 'rule-1',
    });
  });

  it('is the built-in default, marked as one nobody confirmed, with no version and no days, when the tenant approved no rule', () => {
    const definition = resolveKpi([], 'DISBURSEMENT_RATE_PM', '2026-06-01');
    expect(definition).toMatchObject({ code: 'DISBURSEMENT_RATE_PM', origin: 'DEFAULT', version: 0, unverified: true, effectiveFrom: null, effectiveTo: null, ruleId: null });
    expect(definition?.formula).not.toBe('');
    expect(definition?.source).not.toBe('');
  });

  it('is nothing for a code nobody defined: a figure with no definition is not shown as an indicator', () => {
    expect(resolveKpi([], 'NOT_A_KPI', '2026-06-01')).toBeUndefined();
  });

  it('does not use a rule of another day: a past decision is read with the definition that governed it', () => {
    const rules = [rule(full, { effectiveTo: '2026-07-01' }), rule({ ...full, name: 'Tỷ lệ X mới' }, { id: 'rule-2', version: 5, effectiveFrom: '2026-07-01', effectiveTo: null })];
    expect(resolveKpi(rules, 'X_RATE', '2026-06-30')?.version).toBe(4);
    expect(resolveKpi(rules, 'X_RATE', '2026-07-01')).toMatchObject({ version: 5, name: 'Tỷ lệ X mới', effectiveFrom: '2026-07-01', effectiveTo: null });
  });

  it('fills what the rule lacks with the plain values, not with a guess: a unit that is not known is a count, an empty text is no numerator, exclusions keep only texts', () => {
    const definition = resolveKpi([rule({ name: 'N', formula: 'F', unit: 'FURLONGS', numerator: '', denominator: 5, exclusions: ['a', 3, null, 'b'], period: 7 })], 'X_RATE', '2026-06-01');
    expect(definition).toMatchObject({ unit: 'COUNT', numerator: null, denominator: null, exclusions: ['a', 'b'], decimals: 0, refreshHours: 24, allowedLagDays: 0, ragCode: null, source: '', owner: '' });
    expect(resolveKpi([rule({ exclusions: 'all' })], 'X_RATE', '2026-06-01')?.exclusions).toEqual([]);
  });

  it('refuses a rule of another type: it is a mistake of the caller, not a figure', () => {
    const resolved: ResolvedGovernanceRule = { type: 'RAG_THRESHOLDS', code: 'X', params: {}, version: 1, source: 'RULE', ruleId: null, unitId: null, unverified: false, provenance: null };
    expect(refusal(() => kpiDefinitionOf(resolved)).detail).toBe('rule_type');
  });
});

describe('the "i" of a figure', () => {
  it('opens on the formula, the source and the time it is as of, from the definition and nowhere else, and not on the housekeeping of the rule', () => {
    const definition = resolveKpi([rule(full)], 'X_RATE', '2026-06-01');
    if (definition === undefined) throw new Error('no definition');
    const info = kpiInfoOf(definition, { asOf: '2026-05-31', snapshotId: 'snap-9' });
    expect(info).toMatchObject({ code: 'X_RATE', formula: 'A chia B nhân 100', numerator: 'A', denominator: 'B', source: 'Phân hệ DIS', owner: 'CAPITAL_PLANNER', allowedLagDays: 8, version: 4, origin: 'RULE', unverified: false, asOf: '2026-05-31', snapshotId: 'snap-9' });
    for (const hidden of ['ruleId', 'refreshHours', 'ragCode', 'decimals']) expect(info).not.toHaveProperty(hidden);
    expect(kpiInfoOf(definition, { asOf: '2026-05-31', snapshotId: null }).snapshotId).toBeNull();
  });
  it('shows a default as a default, so a reader knows the numbers are not confirmed', () => {
    const definition = resolveKpi([], 'DISBURSEMENT_RATE_PM', '2026-06-01');
    if (definition === undefined) throw new Error('no definition');
    expect(kpiInfoOf(definition, { asOf: '2026-06-01', snapshotId: null })).toMatchObject({ origin: 'DEFAULT', unverified: true, version: 0 });
  });
});

describe('one way to write a figure', () => {
  it('rounds half away from zero by whole numbers, so the web, the phone and the file cannot differ by a last digit', () => {
    expect(roundDecimalText('12.345', 2)).toBe('12.35');
    expect(roundDecimalText('12.344', 2)).toBe('12.34');
    expect(roundDecimalText('0.995', 2)).toBe('1.00');
    expect(roundDecimalText('9.999', 2)).toBe('10.00');
    expect(roundDecimalText('-12.345', 2)).toBe('-12.35');
    expect(roundDecimalText('-0.005', 2)).toBe('-0.01');
    expect(roundDecimalText('5.5', 0)).toBe('6');
    expect(roundDecimalText('-0.5', 0)).toBe('-1');
    expect(roundDecimalText('0.4', 0)).toBe('0');
  });
  it('pads with zeros to the places asked and keeps small values with their leading zeros', () => {
    expect(roundDecimalText('1.5', 3)).toBe('1.500');
    expect(roundDecimalText('5', 2)).toBe('5.00');
    expect(roundDecimalText('0.05', 2)).toBe('0.05');
    expect(roundDecimalText('0', 4)).toBe('0.0000');
  });
  it('has no negative zero', () => {
    expect(roundDecimalText('-0.004', 2)).toBe('0.00');
    expect(roundDecimalText('-0', 0)).toBe('0');
    expect(roundDecimalText('-0.4', 0)).toBe('0');
  });
  it('is exact beyond what a double holds', () => {
    expect(roundDecimalText('12345678901234567890.5', 0)).toBe('12345678901234567891');
    expect(roundDecimalText('9007199254740993.125', 2)).toBe('9007199254740993.13');
  });
  it('refuses what is not a plain decimal or a number of places from 0 to 6', () => {
    for (const bad of ['', '1e3', '01', '.5', '5.', '+5', '1,5', 'abc', ' 5', '--5']) expect(refusal(() => roundDecimalText(bad, 2)).code).toBe('VALIDATION_FAILED');
    for (const places of [-1, 7, 1.5, Number.NaN]) expect(refusal(() => roundDecimalText('5', places)).detail).toBe('value');
  });

  it('writes a percent, a ratio and days with the places of the definition, and money and counts whole', () => {
    expect(displayKpiValue('61.5049', { unit: 'PERCENT', decimals: 2 })).toBe('61.50');
    expect(displayKpiValue('0.95', { unit: 'RATIO', decimals: 3 })).toBe('0.950');
    expect(displayKpiValue('12.5', { unit: 'DAYS', decimals: 1 })).toBe('12.5');
    expect(displayKpiValue('1234.5', { unit: 'VND', decimals: 2 })).toBe('1235');
    expect(displayKpiValue('7.4', { unit: 'COUNT', decimals: 3 })).toBe('7');
  });
  it('writes no value for no value, never "0", and a real zero as 0', () => {
    expect(displayKpiValue(null, { unit: 'PERCENT', decimals: 2 })).toBeNull();
    expect(displayKpiValue(null, { unit: 'VND', decimals: 0 })).toBeNull();
    expect(displayKpiValue('0', { unit: 'VND', decimals: 0 })).toBe('0');
    expect(displayKpiValue('0', { unit: 'PERCENT', decimals: 2 })).toBe('0.00');
  });
});

describe('the colour of one figure', () => {
  const higher = { direction: 'HIGHER_IS_BETTER' as const, green: 0.95, amber: 0.85 };
  const lower = { direction: 'LOWER_IS_BETTER' as const, green: 0, amber: 2 };
  it('is green at the line and on the better side, amber between, red past amber, when higher is better', () => {
    expect(ragOfValue(higher, 0.95)).toBe('GREEN');
    expect(ragOfValue(higher, 1.2)).toBe('GREEN');
    expect(ragOfValue(higher, 0.9499)).toBe('AMBER');
    expect(ragOfValue(higher, 0.85)).toBe('AMBER');
    expect(ragOfValue(higher, 0.8499)).toBe('RED');
  });
  it('is the same the other way round when lower is better', () => {
    expect(ragOfValue(lower, 0)).toBe('GREEN');
    expect(ragOfValue(lower, 1)).toBe('AMBER');
    expect(ragOfValue(lower, 2)).toBe('AMBER');
    expect(ragOfValue(lower, 2.01)).toBe('RED');
    expect(ragOfValue(lower, -5)).toBe('GREEN');
  });
  it('has no colour for a figure that is not there, and a real zero has one', () => {
    expect(ragOfValue(higher, null)).toBeNull();
    expect(ragOfValue(higher, Number.NaN)).toBeNull();
    expect(ragOfValue(higher, Number.POSITIVE_INFINITY)).toBeNull();
    expect(ragOfValue(higher, 0)).toBe('RED');
  });
});

describe('the pace of the year a disbursement is read against', () => {
  it('is the day of the year over the days of the year, in percent, both ends counting', () => {
    expect(yearPacePct('2026-01-01')).toBeCloseTo(100 / 365, 10);
    expect(yearPacePct('2026-07-02')).toBeCloseTo((183 / 365) * 100, 10);
    expect(yearPacePct('2026-12-31')).toBe(100);
  });
  it('knows a leap year has one more day', () => {
    expect(yearPacePct('2028-03-01')).toBeCloseTo((61 / 366) * 100, 10);
    expect(yearPacePct('2028-12-31')).toBe(100);
    expect(yearPacePct('2028-01-01')).toBeCloseTo(100 / 366, 10);
  });
  it('refuses a day that is not a day', () => {
    expect(refusal(() => yearPacePct('2026-02-30')).detail).toBe('as_of');
    expect(refusal(() => yearPacePct('2026-2-3')).code).toBe('VALIDATION_FAILED');
  });
});

describe('the life of a certification (G3-1)', () => {
  const at = '2026-11-08T09:00:00Z';
  const confirmed: CertLine = { status: 'CONFIRMED', actor: 'alice', confirmedBy: 'alice', at, note: null };

  it('names two subjects and four states and recognises only them', () => {
    expect([...CERT_SUBJECTS]).toEqual(['KPI', 'DATASET']);
    expect([...CERT_STATUSES]).toEqual(['DRAFT', 'CONFIRMED', 'CERTIFIED', 'OBSOLETE']);
    expect(isCertSubject('KPI')).toBe(true);
    expect(isCertSubject('kpi')).toBe(false);
    expect(isCertStatus('CERTIFIED')).toBe(true);
    expect(isCertStatus('DONE')).toBe(false);
    expect(isCertStatus(undefined)).toBe(false);
  });

  it('starts at Nháp: a version with no line is confirmed by one person, who is then the one who confirmed it', () => {
    expect(nextCertification(undefined, 'CONFIRMED', { actor: 'alice', at })).toEqual({ status: 'CONFIRMED', actor: 'alice', confirmedBy: 'alice', at, note: null });
  });
  it('is certified by someone else, who keeps who confirmed it', () => {
    expect(nextCertification(confirmed, 'CERTIFIED', { actor: 'bob', at })).toEqual({ status: 'CERTIFIED', actor: 'bob', confirmedBy: 'alice', at, note: null });
  });
  it('refuses a certificate from the person who confirmed it, a second pair of eyes being the point (403 SELF_APPROVAL_DENIED)', () => {
    const error = refusal(() => nextCertification(confirmed, 'CERTIFIED', { actor: 'alice', at }));
    expect([error.code, error.status]).toEqual(['SELF_APPROVAL_DENIED', 403]);
    // the person who made the last line is not the one who confirmed: both are out
    const handed: CertLine = { status: 'CONFIRMED', actor: 'carol', confirmedBy: 'alice', at, note: null };
    expect(refusal(() => nextCertification(handed, 'CERTIFIED', { actor: 'alice', at })).code).toBe('SELF_APPROVAL_DENIED');
    expect(refusal(() => nextCertification(handed, 'CERTIFIED', { actor: 'carol', at })).code).toBe('SELF_APPROVAL_DENIED');
    expect(nextCertification(handed, 'CERTIFIED', { actor: 'dave', at }).actor).toBe('dave');
  });
  it('cannot skip a step or go back where it may not (409 STAGE_TRANSITION_DENIED)', () => {
    const denied = (current: CertLine | undefined, to: Parameters<typeof nextCertification>[1]) => refusal(() => nextCertification(current, to, { actor: 'bob', at, note: 'đủ năm chữ' }));
    expect(denied(undefined, 'CERTIFIED').code).toBe('STAGE_TRANSITION_DENIED');
    expect(denied(undefined, 'DRAFT').status).toBe(409);
    expect(denied(undefined, 'OBSOLETE').code).toBe('STAGE_TRANSITION_DENIED');
    expect(denied(confirmed, 'OBSOLETE').code).toBe('STAGE_TRANSITION_DENIED');
    const certified: CertLine = { status: 'CERTIFIED', actor: 'bob', confirmedBy: 'alice', at, note: null };
    expect(denied(certified, 'CONFIRMED').code).toBe('STAGE_TRANSITION_DENIED');
    expect(denied(certified, 'DRAFT').code).toBe('STAGE_TRANSITION_DENIED');
    const obsolete: CertLine = { ...certified, status: 'OBSOLETE' };
    for (const to of CERT_STATUSES) expect(denied(obsolete, to).code).toBe('STAGE_TRANSITION_DENIED');
  });
  it('needs the reason in words, five to five hundred characters, to send a version back to Nháp or make it Lỗi thời', () => {
    const certified: CertLine = { status: 'CERTIFIED', actor: 'bob', confirmedBy: 'alice', at, note: null };
    const back = (note: string | undefined) => refusal(() => nextCertification(confirmed, 'DRAFT', { actor: 'bob', at, note }));
    expect(back(undefined).detail).toBe('note');
    expect(back('    ').detail).toBe('note');
    expect(back('abcd').detail).toBe('note');
    expect(back('x'.repeat(501)).detail).toBe('note');
    expect(nextCertification(confirmed, 'DRAFT', { actor: 'bob', at, note: 'abcde' })).toEqual({ status: 'DRAFT', actor: 'bob', confirmedBy: null, at, note: 'abcde' });
    expect(refusal(() => nextCertification(certified, 'OBSOLETE', { actor: 'bob', at })).detail).toBe('note');
    expect(nextCertification(certified, 'OBSOLETE', { actor: 'bob', at, note: 'thay bằng bản mới' })).toMatchObject({ status: 'OBSOLETE', confirmedBy: 'alice', note: 'thay bằng bản mới' });
  });
  it('lets a move that needs no reason carry one, up to five hundred characters', () => {
    expect(nextCertification(undefined, 'CONFIRMED', { actor: 'alice', at, note: 'đã đối chiếu' }).note).toBe('đã đối chiếu');
    expect(refusal(() => nextCertification(undefined, 'CONFIRMED', { actor: 'alice', at, note: 'x'.repeat(501) })).detail).toBe('note');
  });
  it('keeps the reason trimmed and in the composed form', () => {
    expect(nextCertification(confirmed, 'DRAFT', { actor: 'bob', at, note: '  Của bạn  ' }).note).toBe('Của bạn');
  });
  it('says the transition is wrong before it says the reason is missing, and the reason before the self-approval', () => {
    expect(refusal(() => nextCertification(undefined, 'DRAFT', { actor: 'a', at })).code).toBe('STAGE_TRANSITION_DENIED');
    expect(refusal(() => nextCertification(confirmed, 'CERTIFIED', { actor: 'alice', at, note: 'x'.repeat(501) })).code).toBe('VALIDATION_FAILED');
  });

  it('is what the latest line of a version says, and Nháp-by-absence has none', () => {
    const lines = [
      { version: 1, ...confirmed },
      { version: 2, ...confirmed, actor: 'zed' },
      { version: 1, status: 'CERTIFIED' as const, actor: 'bob', confirmedBy: 'alice', at, note: null },
    ];
    expect(currentCertification(lines, 1)?.status).toBe('CERTIFIED');
    expect(currentCertification(lines, 2)?.actor).toBe('zed');
    expect(currentCertification(lines, 3)).toBeUndefined();
  });
});

describe('the flags on a number (G3-1)', () => {
  const good: FigureFacts = { hasValue: true, certification: 'CERTIFIED', ageDays: 3, allowedLagDays: 8, coveragePct: 100, unverifiedDefinition: false };

  it('has none for a figure that is certified, fresh, complete and defined by someone', () => {
    expect(figureFlags(good)).toEqual([]);
  });
  it('says NO_DATA for a figure with no value, so it never reads as 0', () => {
    expect(figureFlags({ ...good, hasValue: false })).toEqual(['NO_DATA']);
  });
  it('says OBSOLETE for a made-obsolete version, not "not certified", and NOT_CERTIFIED for the others', () => {
    expect(figureFlags({ ...good, certification: 'OBSOLETE' })).toEqual(['OBSOLETE']);
    for (const certification of ['DRAFT', 'CONFIRMED'] as const) expect(figureFlags({ ...good, certification })).toEqual(['NOT_CERTIFIED']);
  });
  it('says STALE only when the figure is older than the lag its definition allows', () => {
    expect(figureFlags({ ...good, ageDays: 8 })).toEqual([]);
    expect(figureFlags({ ...good, ageDays: 9 })).toEqual(['STALE']);
    expect(figureFlags({ ...good, ageDays: null })).toEqual([]);
    expect(figureFlags({ ...good, ageDays: 1, allowedLagDays: 0 })).toEqual(['STALE']);
  });
  it('says PARTIAL_COVERAGE below a whole of the data, and nothing when the coverage is not known', () => {
    expect(figureFlags({ ...good, coveragePct: 99.9 })).toEqual(['PARTIAL_COVERAGE']);
    expect(figureFlags({ ...good, coveragePct: 0 })).toEqual(['PARTIAL_COVERAGE']);
    expect(figureFlags({ ...good, coveragePct: null })).toEqual([]);
  });
  it('says UNVERIFIED_DEFINITION for a default nobody confirmed', () => {
    expect(figureFlags({ ...good, unverifiedDefinition: true })).toEqual(['UNVERIFIED_DEFINITION']);
  });
  it('lists them in the order of how much they matter', () => {
    expect(figureFlags({ hasValue: false, certification: 'DRAFT', ageDays: 30, allowedLagDays: 1, coveragePct: 10, unverifiedDefinition: true })).toEqual(['NO_DATA', 'NOT_CERTIFIED', 'STALE', 'PARTIAL_COVERAGE', 'UNVERIFIED_DEFINITION']);
  });
  it('lets a leader see only a certified version, and says what stops the others', () => {
    expect(leaderGate('CERTIFIED')).toBeNull();
    expect(leaderGate('OBSOLETE')).toBe('OBSOLETE');
    expect(leaderGate('DRAFT')).toBe('NOT_CERTIFIED');
    expect(leaderGate('CONFIRMED')).toBe('NOT_CERTIFIED');
  });
});
