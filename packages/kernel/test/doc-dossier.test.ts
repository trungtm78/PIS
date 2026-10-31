import { DomainError } from '../src/errors';
import { DISPOSAL_FROM, addMonths, assertDisposable, canMoveDossier, disposalBlocker, planRetention, selectRetentionRule } from '../src/doc-dossier';
import type { RetentionRuleView } from '../src/doc-dossier';

const rule = (overrides: Partial<RetentionRuleView> = {}): RetentionRuleView => ({
  id: 'r1',
  ruleSet: 'TT74_2025_BTC',
  categoryCode: 'PROJECT_INVESTMENT',
  classCode: 'Y70',
  retentionYears: 70,
  startBasis: 'FROM_CLOSED',
  handoverMonths: 12,
  confirmationStatus: 'CONFIRMED',
  precedence: 100,
  effectiveFrom: '2025-01-01',
  effectiveUntil: null,
  status: 'PUBLISHED',
  ...overrides,
});

describe('selectRetentionRule (BR-DOC-22)', () => {
  it('takes only the published rules of the category that are in force on the day of closing', () => {
    const rules = [rule({ id: 'draft', status: 'DRAFT' }), rule({ id: 'other', categoryCode: 'OTHER' }), rule({ id: 'future', effectiveFrom: '2027-01-01' }), rule({ id: 'ended', effectiveUntil: '2026-12-31' }), rule({ id: 'ok' })];
    expect(selectRetentionRule(rules, 'PROJECT_INVESTMENT', '2026-12-31')?.id).toBe('ok');
    expect(selectRetentionRule(rules.filter((entry) => entry.id !== 'ok'), 'PROJECT_INVESTMENT', '2026-12-31')).toBeUndefined();
  });

  it('UAT-AC422: a rule in force until the last day of the year no longer applies on the first day of the next (the end is exclusive)', () => {
    const old = rule({ id: 'R-old', classCode: 'Y20', retentionYears: 20, effectiveUntil: '2027-01-01' });
    const next = rule({ id: 'R-new', effectiveFrom: '2027-01-01' });
    expect(selectRetentionRule([old, next], 'PROJECT_INVESTMENT', '2026-12-31')?.id).toBe('R-old');
    expect(selectRetentionRule([old, next], 'PROJECT_INVESTMENT', '2027-01-02')?.id).toBe('R-new');
    expect(selectRetentionRule([old, next], 'PROJECT_INVESTMENT', '2027-01-01')?.id).toBe('R-new');
  });

  it('prefers a confirmed rule, then the lowest precedence, then the rule set of the tenant', () => {
    const pending = rule({ id: 'pending', confirmationStatus: 'PENDING_CONFIRMATION', precedence: 1 });
    const confirmedLate = rule({ id: 'late', precedence: 50, ruleSet: 'TT10_2022_BNV' });
    const confirmedEarly = rule({ id: 'early', precedence: 10, ruleSet: 'TT10_2022_BNV' });
    expect(selectRetentionRule([pending, confirmedLate, confirmedEarly], 'PROJECT_INVESTMENT', '2026-10-01')?.id).toBe('early');
    const sameA = rule({ id: 'a', ruleSet: 'TT10_2022_BNV', precedence: 10 });
    const sameB = rule({ id: 'b', ruleSet: 'TT74_2025_BTC', precedence: 10 });
    expect(selectRetentionRule([sameA, sameB], 'PROJECT_INVESTMENT', '2026-10-01')?.id).toBe('b');
    expect(selectRetentionRule([sameA, sameB], 'PROJECT_INVESTMENT', '2026-10-01', ['TT10_2022_BNV', 'TT74_2025_BTC'])?.id).toBe('a');
    // Nothing confirmed: the best of the unconfirmed comes back, so that the caller sees that it does not count.
    expect(selectRetentionRule([pending], 'PROJECT_INVESTMENT', '2026-10-01')?.id).toBe('pending');
  });
});

describe('addMonths', () => {
  it('adds whole months and keeps to the end of a short month', () => {
    expect(addMonths('2026-10-29', 12)).toBe('2027-10-29');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2027-12-31', 2)).toBe('2028-02-29');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2026-10-29', 0)).toBe('2026-10-29');
    expect(addMonths('2026-10-29', 840)).toBe('2096-10-29');
  });

  it('refuses what is not a day or a whole number', () => {
    expect(() => addMonths('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addMonths('26-10-29', 1)).toThrow(RangeError);
    expect(() => addMonths('2026-10-29', -1)).toThrow(RangeError);
    expect(() => addMonths('2026-10-29', 1.5)).toThrow(RangeError);
  });
});

describe('planRetention (BR-DOC-22)', () => {
  it('AC-ST-DOC-013-1: UAT-AC421 keeps a dossier for ever, provisionally, when no rule is confirmed', () => {
    const plan = { ruleId: null, classCode: 'PERMANENT', provisional: true, endsOn: null, handoverDueOn: null };
    expect(planRetention({ rule: undefined, closedOn: '2026-10-29' })).toEqual(plan);
    expect(planRetention({ rule: rule({ confirmationStatus: 'PENDING_CONFIRMATION' }), closedOn: '2026-10-29' })).toEqual(plan);
  });

  it('AC-ST-DOC-013-2: UAT-AC421 applies a confirmed rule: its class, its end and the handover its months after closing', () => {
    expect(planRetention({ rule: rule({ id: 'TT74' }), closedOn: '2026-10-29' })).toEqual({ ruleId: 'TT74', classCode: 'Y70', provisional: false, endsOn: '2096-10-29', handoverDueOn: '2027-10-29' });
    expect(planRetention({ rule: rule({ classCode: 'PERMANENT', retentionYears: null, handoverMonths: 0 }), closedOn: '2026-10-29' })).toMatchObject({ classCode: 'PERMANENT', provisional: false, endsOn: null, handoverDueOn: '2026-10-29' });
  });

  it('starts the years from the day the rule names', () => {
    const settlement = rule({ startBasis: 'FROM_SETTLEMENT', retentionYears: 10, classCode: 'Y10' });
    expect(planRetention({ rule: settlement, closedOn: '2026-10-29', settlementClosedOn: '2026-06-30' }).endsOn).toBe('2036-06-30');
    expect(() => planRetention({ rule: settlement, closedOn: '2026-10-29' })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'settlement_closed_on' }));
    expect(() => planRetention({ rule: settlement, closedOn: '2026-10-29', settlementClosedOn: '2026-13-01' })).toThrow(DomainError);
    const issued = rule({ startBasis: 'FROM_ISSUED', retentionYears: 5, classCode: 'Y5' });
    expect(planRetention({ rule: issued, closedOn: '2026-10-29', latestIssuedOn: '2026-03-15' }).endsOn).toBe('2031-03-15');
    expect(planRetention({ rule: issued, closedOn: '2026-10-29' }).endsOn).toBe('2031-10-29');
  });
});

describe('disposalBlocker (BR-DOC-23)', () => {
  const base = { status: 'CLOSED' as const, provisional: false, retentionEndsOn: '2026-01-01', holdActive: false, today: '2026-10-29' };

  it('AC-ST-DOC-013-1: UAT-AC421 stops a provisional dossier first, then a legal hold even when the retention is over, then a retention that has not ended', () => {
    expect(disposalBlocker({ ...base, provisional: true, retentionEndsOn: null, holdActive: true })).toBe('RETENTION_PROVISIONAL');
    expect(disposalBlocker({ ...base, holdActive: true })).toBe('LEGAL_HOLD_ACTIVE');
    expect(disposalBlocker({ ...base, retentionEndsOn: '2026-10-30' })).toBe('RETENTION_NOT_EXPIRED');
    expect(disposalBlocker({ ...base, retentionEndsOn: null })).toBe('RETENTION_NOT_EXPIRED');
    expect(disposalBlocker({ ...base, status: 'OPEN' })).toBe('DOSSIER_NOT_CLOSED');
    expect(disposalBlocker({ ...base, retentionEndsOn: '2026-10-29' })).toBeUndefined();
  });

  it('refuses with 422 RETENTION_PROVISIONAL, 409 LEGAL_HOLD_ACTIVE and 422 RETENTION_NOT_EXPIRED', () => {
    const refusal = (input: Parameters<typeof assertDisposable>[0]) => {
      try {
        assertDisposable(input);
      } catch (error) {
        return error instanceof DomainError ? [error.code, error.status] : error;
      }
      return undefined;
    };
    expect(refusal({ ...base, provisional: true })).toEqual(['RETENTION_PROVISIONAL', 422]);
    expect(refusal({ ...base, holdActive: true })).toEqual(['LEGAL_HOLD_ACTIVE', 409]);
    expect(refusal({ ...base, retentionEndsOn: '2027-01-01' })).toEqual(['RETENTION_NOT_EXPIRED', 422]);
    expect(refusal({ ...base, status: 'OPEN' })).toEqual(['DOSSIER_NOT_CLOSED', 422]);
    expect(refusal(base)).toBeUndefined();
  });
});

describe('canMoveDossier', () => {
  it('follows the chain of F11 and never back', () => {
    expect(canMoveDossier('OPEN', 'CLOSED')).toBe(true);
    expect(canMoveDossier('CLOSED', 'HANDED_OVER')).toBe(true);
    expect(canMoveDossier('HANDED_OVER', 'ARCHIVED')).toBe(true);
    expect(canMoveDossier('DISPOSAL_PROPOSED', 'DISPOSED')).toBe(true);
    expect(canMoveDossier('CLOSED', 'OPEN')).toBe(false);
    expect(canMoveDossier('OPEN', 'HANDED_OVER')).toBe(false);
    expect(canMoveDossier('DISPOSED', 'CLOSED')).toBe(false);
  });

  it('sends a dossier whose disposal is rejected back to the state it was proposed from, and to no other', () => {
    expect(canMoveDossier('DISPOSAL_PROPOSED', 'CLOSED', 'CLOSED')).toBe(true);
    expect(canMoveDossier('DISPOSAL_PROPOSED', 'ARCHIVED', 'ARCHIVED')).toBe(true);
    expect(canMoveDossier('DISPOSAL_PROPOSED', 'ARCHIVED', 'CLOSED')).toBe(false);
    expect(canMoveDossier('DISPOSAL_PROPOSED', 'CLOSED')).toBe(false);
    expect(canMoveDossier('CLOSED', 'CLOSED', 'CLOSED')).toBe(false);
    expect(DISPOSAL_FROM).toEqual(['CLOSED', 'HANDED_OVER', 'ARCHIVED']);
  });
});
