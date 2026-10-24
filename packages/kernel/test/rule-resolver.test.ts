import type { DomainError } from '../src/errors';
import { assertRuleVersions, resolveRule, ruleOfRevision } from '../src/rule-resolver';
import type { DatedRule } from '../src/rule-resolver';

const rate = (revision: number, validFrom: string, validUntil: string | null, percent: number, confirmation: DatedRule<unknown>['confirmation'] = 'CONFIRMED'): DatedRule<{ percent: number }> => ({
  code: 'PAY-ADVANCE-RATE',
  revision,
  validFrom,
  validUntil,
  legalBasis: `Decree ${revision}/2026`,
  confirmation,
  payload: { percent },
});

const failure = (work: () => void): { code: string; status: number; detail?: string; extensions?: Record<string, unknown> } => {
  try {
    work();
  } catch (error) {
    const found = error as DomainError;
    return { code: found.code, status: found.status, ...(found.detail === undefined ? {} : { detail: found.detail }), ...(found.extensions === undefined ? {} : { extensions: found.extensions }) };
  }
  throw new Error('expected a refusal');
};

describe('resolveRule: the rule that governed a date (AC-ST-KERNEL-060-1, UAT-NFR-LEGAL-02)', () => {
  const v1 = rate(1, '2026-01-01', '2026-07-01', 80);
  const v2 = rate(2, '2026-07-01', null, 70);

  it('keeps a request made under version 1 on version 1 when version 2 takes effect later, and gives a new request version 2', () => {
    // PAY-REQ-A-0003 was made on 30 June under version 1 at 80 percent and bound to the revision it used.
    const made = resolveRule([v1], 'PAY-ADVANCE-RATE', '2026-06-30');
    expect(made?.rule.payload.percent).toBe(80);
    const bound = made?.rule.revision as number;
    // Version 2 is published afterwards, effective from 1 July: the old request still reads the revision it was bound to.
    const rules = [v1, v2];
    expect(ruleOfRevision(rules, 'PAY-ADVANCE-RATE', bound)?.payload.percent).toBe(80);
    // A request made on 1 July uses version 2.
    expect(resolveRule(rules, 'PAY-ADVANCE-RATE', '2026-07-01')?.rule.payload.percent).toBe(70);
    // And asking again for the day of the old request still answers version 1: a law change does not rewrite history.
    expect(resolveRule(rules, 'PAY-ADVANCE-RATE', '2026-06-30')?.rule.payload.percent).toBe(80);
  });

  it('answers with the legal basis, and watermarks what rests on a rule that nobody confirmed', () => {
    const awaiting = rate(3, '2027-01-01', null, 60, 'AWAITING_CONFIRMATION');
    expect(resolveRule([v1, v2, awaiting], 'PAY-ADVANCE-RATE', '2027-02-01')).toMatchObject({ watermarked: true, legalBasis: 'Decree 3/2026' });
    expect(resolveRule([v1], 'PAY-ADVANCE-RATE', '2026-02-01')).toMatchObject({ watermarked: false, legalBasis: 'Decree 1/2026' });
  });

  it('answers nothing before the first version, at the end of the last, or for another code, and refuses a date that is not a day', () => {
    expect(resolveRule([v1], 'PAY-ADVANCE-RATE', '2025-12-31')).toBeUndefined();
    expect(resolveRule([v1], 'PAY-ADVANCE-RATE', '2026-07-01')).toBeUndefined();
    expect(resolveRule([v1], 'OTHER-RATE', '2026-02-01')).toBeUndefined();
    expect(failure(() => resolveRule([v1], 'PAY-ADVANCE-RATE', '2026-02-30'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'as_of' });
    expect(failure(() => resolveRule([v1], 'PAY-ADVANCE-RATE', 'soon'))).toMatchObject({ detail: 'as_of' });
    expect(ruleOfRevision([v1], 'PAY-ADVANCE-RATE', 9)).toBeUndefined();
  });
});

describe('resolveRule over the revisions of a template (AC-ST-KERNEL-060-2, UAT-AC423)', () => {
  const template = (revision: number, validFrom: string, validUntil: string | null): DatedRule<{ layout: string }> => ({
    code: 'QD-DEFAULT',
    revision,
    validFrom,
    validUntil,
    legalBasis: 'Decree 30/2020/ND-CP',
    confirmation: 'CONFIRMED',
    payload: { layout: `layout-${revision}` },
  });

  it('renders 31 December 2026 with revision 1 and 1 January 2027 with revision 2', () => {
    const revisions = [template(1, '2026-01-01', '2027-01-01'), template(2, '2027-01-01', null)];
    expect(resolveRule(revisions, 'QD-DEFAULT', '2026-12-31')?.rule).toMatchObject({ revision: 1, payload: { layout: 'layout-1' } });
    expect(resolveRule(revisions, 'QD-DEFAULT', '2027-01-01')?.rule).toMatchObject({ revision: 2, payload: { layout: 'layout-2' } });
  });
});

describe('assertRuleVersions', () => {
  it('takes versions that follow one another, in any order, and different codes that cover the same days', () => {
    expect(() => assertRuleVersions([rate(2, '2026-07-01', null, 70), rate(1, '2026-01-01', '2026-07-01', 80), { ...rate(1, '2026-01-01', null, 5), code: 'OTHER' }])).not.toThrow();
  });

  it('refuses two versions of one code that cover the same day, naming them', () => {
    expect(failure(() => assertRuleVersions([rate(1, '2026-01-01', '2026-08-01', 80), rate(2, '2026-07-01', null, 70)]))).toEqual({
      code: 'RULE_RANGE_OVERLAP',
      status: 409,
      detail: 'valid_from',
      extensions: { rule_code: 'PAY-ADVANCE-RATE', rule_revision: 2, overlaps_revision: 1 },
    });
    expect(failure(() => assertRuleVersions([rate(1, '2026-01-01', null, 80), rate(2, '2027-01-01', null, 70)]))).toMatchObject({ code: 'RULE_RANGE_OVERLAP' });
  });

  it('refuses a range that ends before it starts, a day that is not a day and a rule with no legal basis', () => {
    expect(failure(() => assertRuleVersions([rate(1, '2026-07-01', '2026-07-01', 80)]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'valid_until' });
    expect(failure(() => assertRuleVersions([rate(1, '2026-13-01', null, 80)]))).toMatchObject({ detail: 'valid_from' });
    expect(failure(() => assertRuleVersions([rate(1, '2026-01-01', '2026-02-30', 80)]))).toMatchObject({ detail: 'valid_until' });
    expect(failure(() => assertRuleVersions([{ ...rate(1, '2026-01-01', null, 80), legalBasis: '  ' }]))).toMatchObject({ detail: 'legal_basis' });
  });
});
