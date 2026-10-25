import { MAX_OVERRIDE_DAYS, MAX_OVERRIDE_LEAD_DAYS, overrideIssues } from '../src/index';
import type { OverrideRequest } from '../src/index';

const NOW = new Date('2026-10-25T06:00:00Z');
const DAY = 86_400_000;
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);

const request = (overrides: Partial<OverrideRequest> = {}): OverrideRequest => ({
  featureCode: 'ai.analysis',
  enabled: false,
  validFrom: NOW,
  validUntil: at(30),
  reason: 'Tạm dừng do vượt ngân sách AI',
  ...overrides,
});

const issuesOf = (value: OverrideRequest): string[] => overrideIssues(value, NOW).map((issue) => `${issue.field}:${issue.reason}`);

describe('overrideIssues', () => {
  it('accepts the override of UAT-AC157: AI off for 30 days with a reason', () => {
    expect(overrideIssues(request(), NOW)).toEqual([]);
  });

  it('accepts a feature switched on with a limit, and one switched on without', () => {
    expect(issuesOf(request({ featureCode: 'member.seats', enabled: true, limitValue: '150' }))).toEqual([]);
    expect(issuesOf(request({ featureCode: 'export', enabled: true }))).toEqual([]);
    expect(issuesOf(request({ featureCode: 'member.seats', enabled: true, limitValue: '12.5' }))).toEqual([]);
  });

  it('refuses a feature that no plan sells', () => {
    expect(issuesOf(request({ featureCode: 'ai.magic' }))).toEqual(['feature_code:FEATURE_UNKNOWN']);
  });

  it.each(['-1', '1e3', '1.1234567', '', 'abc'])('refuses the limit %p', (limitValue) => {
    expect(issuesOf(request({ enabled: true, limitValue }))).toEqual(['limit_value:LIMIT_INVALID']);
  });

  it('refuses a limit on a feature that is switched off', () => {
    expect(issuesOf(request({ enabled: false, limitValue: '5' }))).toEqual(['limit_value:LIMIT_NEEDS_ENABLED']);
  });

  it('refuses a window that ends before it starts or where it starts, and a date that is not one', () => {
    expect(issuesOf(request({ validFrom: at(10), validUntil: at(5) }))).toEqual(['valid_until:WINDOW_INVALID']);
    expect(issuesOf(request({ validFrom: at(10), validUntil: at(10) }))).toEqual(['valid_until:WINDOW_INVALID']);
    expect(issuesOf(request({ validUntil: new Date('nope') }))).toEqual(['valid_until:WINDOW_INVALID']);
  });

  it('refuses a window that has already ended', () => {
    expect(issuesOf(request({ validFrom: at(-10), validUntil: at(-1) }))).toEqual(['valid_until:ALREADY_ENDED']);
    expect(issuesOf(request({ validFrom: at(-10), validUntil: NOW }))).toEqual(['valid_until:ALREADY_ENDED']);
    expect(issuesOf(request({ validFrom: at(-10), validUntil: new Date(NOW.getTime() + 1) }))).toEqual([]);
  });

  it('allows a window of a year and no more', () => {
    expect(issuesOf(request({ validUntil: at(MAX_OVERRIDE_DAYS) }))).toEqual([]);
    expect(issuesOf(request({ validUntil: new Date(at(MAX_OVERRIDE_DAYS).getTime() + 1) }))).toEqual(['valid_until:TOO_LONG']);
  });

  it('allows a start up to 90 days ahead and no further', () => {
    expect(issuesOf(request({ validFrom: at(MAX_OVERRIDE_LEAD_DAYS), validUntil: at(MAX_OVERRIDE_LEAD_DAYS + 5) }))).toEqual([]);
    expect(issuesOf(request({ validFrom: new Date(at(MAX_OVERRIDE_LEAD_DAYS).getTime() + 1), validUntil: at(MAX_OVERRIDE_LEAD_DAYS + 5) }))).toEqual(['valid_from:STARTS_TOO_FAR_AHEAD']);
  });

  it.each([
    ['short', 'reason:REASON_LENGTH'],
    ['         x         ', 'reason:REASON_LENGTH'],
    ['y'.repeat(2001), 'reason:REASON_LENGTH'],
  ])('refuses the reason %#', (reason, expected) => {
    expect(issuesOf(request({ reason }))).toEqual([expected]);
  });

  it('accepts a reason of exactly 10 and of exactly 2000 characters once trimmed', () => {
    expect(issuesOf(request({ reason: 'x'.repeat(10) }))).toEqual([]);
    expect(issuesOf(request({ reason: `  ${'x'.repeat(2000)}  ` }))).toEqual([]);
  });

  it('reports every problem in the order of the form', () => {
    expect(issuesOf(request({ featureCode: 'nope', enabled: false, limitValue: '5', validFrom: at(-10), validUntil: at(-1), reason: 'no' }))).toEqual([
      'feature_code:FEATURE_UNKNOWN',
      'limit_value:LIMIT_NEEDS_ENABLED',
      'valid_until:ALREADY_ENDED',
      'reason:REASON_LENGTH',
    ]);
  });
});
