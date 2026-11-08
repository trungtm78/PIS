import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { describeRefusal, figureText, hasEvidence, isNotFound, newestFirst, toBoardPage, toEvidence, toPolicy, toProjectSignals, tracksOf } from './model';
import type { HistoryRow } from './model';

const refusal = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

const evidence = { indicators: { MILESTONE_SLIP_DAYS: 45, SPI_SHORTFALL_PCT: null, OPEN_CLAIMS: 2 }, drivers: [{ indicator: 'MILESTONE_SLIP_DAYS', value: 45, likelihood: 4 }], unknown: ['SPI_SHORTFALL_PCT'], facts: { milestones: 3, claim_register: true, nested: { a: 1 }, spi: null } };

describe('toEvidence', () => {
  it('keeps the figures in the order of the indicators, a figure that could not be known as null, and only plain facts', () => {
    const parsed = toEvidence(evidence);
    expect(parsed.readings.map((reading) => reading.indicator)).toEqual(['SPI_SHORTFALL_PCT', 'MILESTONE_SLIP_DAYS', 'OPEN_CLAIMS']);
    expect(parsed.readings[0]?.value).toBeNull();
    expect(parsed.readings[1]?.value).toBe(45);
    expect(parsed.drivers).toEqual([{ indicator: 'MILESTONE_SLIP_DAYS', value: 45, likelihood: 4 }]);
    expect(parsed.unknown).toEqual(['SPI_SHORTFALL_PCT']);
    expect(parsed.facts.map((fact) => fact.key)).toEqual(['milestones', 'claim_register', 'spi']);
    expect(hasEvidence(parsed)).toBe(true);
  });

  it('turns a figure named as unknown into null even when a stale number sits beside it, and adds one that has no reading', () => {
    const parsed = toEvidence({ indicators: { OPEN_CLAIMS: 7 }, unknown: ['OPEN_CLAIMS', 'FUNDING_GAP_PCT'] });
    expect(parsed.readings).toEqual([
      { indicator: 'OPEN_CLAIMS', value: null },
      { indicator: 'FUNDING_GAP_PCT', value: null },
    ]);
  });

  it('says there is no evidence for a risk entered by hand, and survives a payload that is not an object', () => {
    expect(hasEvidence(toEvidence({}))).toBe(false);
    expect(hasEvidence(toEvidence(null))).toBe(false);
    expect(toEvidence('x').readings).toEqual([]);
  });
});

describe('toPolicy', () => {
  it('reads the thresholds, the impacts and the lines of the rule, and the flag that it is not verified', () => {
    const policy = toPolicy({ name: 'RISK_SIGNAL_POLICY', code: 'DEFAULT', formula: 'F', source: 'S', as_of: '2026-11-08', legal_status: 'UNVERIFIED', unverified: true, version: 'built-in:1', owner: 'PRJ', params: { thresholds: { SPI_SHORTFALL_PCT: [5, 10, 20, 30], OTHER: [1] }, impact: { SCHEDULE_DELAY: 4, NOPE: 2 }, critical_score: 15, jump_points: 6, open_from_likelihood: 2 } });
    expect(policy.unverified).toBe(true);
    expect(policy.params.thresholds).toEqual({ SPI_SHORTFALL_PCT: [5, 10, 20, 30] });
    expect(policy.params.impact).toEqual({ SCHEDULE_DELAY: 4 });
    expect([policy.params.criticalScore, policy.params.jumpPoints, policy.params.openFromLikelihood]).toEqual([15, 6, 2]);
    expect(policy.formula).toBe('F');
    expect(policy.version).toBe('built-in:1');
  });

  it('treats a rule that does not say it is verified as not verified, and a missing line as null (never zero)', () => {
    const policy = toPolicy({});
    expect(policy.unverified).toBe(true);
    expect(policy.params.criticalScore).toBeNull();
    expect(policy.formula).toBeNull();
    expect(toPolicy({ unverified: false }).unverified).toBe(false);
  });
});

const item = (overrides: Record<string, unknown> = {}) => ({
  origin: 'SIGNAL',
  id: 'a1',
  project_id: 'p1',
  project_code: 'DA-1',
  project_name: 'Project one',
  kind: 'SCHEDULE_DELAY',
  title: null,
  likelihood: 4,
  impact: 4,
  score: 16,
  level: 'CRITICAL',
  previous_score: 12,
  trend: 'UP',
  scored_on: '2026-11-08',
  evidence,
  owner: { membership_id: 'm1', display_name: 'An' },
  alert_open: true,
  rule_unverified: true,
  ...overrides,
});

describe('toBoardPage', () => {
  it('keeps the score, the level and the trend as the server sent them and the counts of the head', () => {
    const page = toBoardPage({ items: [item(), item({ id: 'a2', origin: 'REGISTER', kind: 'REGISTER', title: 'Land', evidence: {}, owner: null, previous_score: null, trend: 'NEW', alert_open: false })], next_cursor: 'c2', counts: { total: 2, critical: 1, medium: 0, low: 1, open_alerts: 1 }, policy: { unverified: true }, as_of: '2026-11-08' });
    expect(page?.items).toHaveLength(2);
    expect(page?.items[0]).toMatchObject({ score: 16, level: 'CRITICAL', trend: 'UP', previousScore: 12, alertOpen: true, owner: { membershipId: 'm1', displayName: 'An' } });
    expect(page?.items[1]).toMatchObject({ origin: 'REGISTER', kind: 'REGISTER', title: 'Land', owner: null, previousScore: null, trend: 'NEW' });
    expect(page?.nextCursor).toBe('c2');
    expect(page?.counts).toEqual({ total: 2, critical: 1, medium: 0, low: 1, openAlerts: 1 });
  });

  it('drops a line without an id, a known kind or a score, and has no cursor on the last page', () => {
    const page = toBoardPage({ items: [item({ kind: 'MYSTERY' }), item({ id: '' }), item({ score: null }), item({ id: 'ok' })], next_cursor: null, counts: { total: 1 }, as_of: '2026-11-08' });
    expect(page?.items.map((row) => row.id)).toEqual(['ok']);
    expect(page?.nextCursor).toBeUndefined();
  });

  it('is undefined for an answer that has no items or no counts', () => {
    expect(toBoardPage(null)).toBeUndefined();
    expect(toBoardPage({ items: [] })).toBeUndefined();
    expect(toBoardPage({ counts: {} })).toBeUndefined();
  });
});

const historyRow = (overrides: Record<string, unknown> = {}) => ({ id: 'h1', subject_kind: 'SIGNAL', signal_id: 's1', risk_id: null, signal_kind: 'SCHEDULE_DELAY', source: 'JOB', scored_on: '2026-11-06', likelihood: 3, impact: 4, score: 12, level: 'MEDIUM', prior_score: null, status: 'ACTIVE', evidence, rule_version: '1', scored_at: '2026-11-06T01:00:00.000Z', ...overrides });

describe('toProjectSignals', () => {
  const raw = {
    project: { id: 'p1', code: 'DA-1', name: 'Project one', status: 'IMPLEMENTATION' },
    lines: [{ id: 's1', signal_kind: 'SCHEDULE_DELAY', status: 'ACTIVE', likelihood: 4, impact: 4, score: 16, evidence, rule_version: '1', rule_unverified: true, first_scored_on: '2026-11-01', last_scored_on: '2026-11-08', cleared_on: null, version: 3 }],
    history: [historyRow(), historyRow({ id: 'h2', scored_on: '2026-11-07', score: 16, level: 'CRITICAL', prior_score: 12, scored_at: '2026-11-07T01:00:00.000Z' })],
    alerts: [{ id: 'al1', alert_type: 'RISK_SCORE_JUMP', subject_kind: 'SIGNAL', signal_kind: 'SCHEDULE_DELAY', score: 16, prior_score: 8, threshold: 6, rule_version: '1', rule_unverified: true, status: 'OPEN', raised_on: '2026-11-07', acknowledged_at: null, acknowledge_note: null, resolved_on: null, version: 2 }],
    policy: { unverified: true },
    can: { acknowledge_alert: true },
    as_of: '2026-11-08',
  };

  it('keeps the lines, the history, the alerts, the version of each alert and what the caller may do', () => {
    const view = toProjectSignals(raw);
    expect(view?.project.code).toBe('DA-1');
    expect(view?.lines[0]).toMatchObject({ kind: 'SCHEDULE_DELAY', status: 'ACTIVE', score: 16, version: 3, clearedOn: null });
    expect(view?.history).toHaveLength(2);
    expect(view?.alerts[0]).toMatchObject({ type: 'RISK_SCORE_JUMP', status: 'OPEN', priorScore: 8, threshold: 6, version: 2 });
    expect(view?.canAcknowledge).toBe(true);
  });

  it('is not allowed to acknowledge unless the server says so, and is undefined without a project', () => {
    expect(toProjectSignals({ ...raw, can: {} })?.canAcknowledge).toBe(false);
    expect(toProjectSignals({ ...raw, can: { acknowledge_alert: 'yes' } })?.canAcknowledge).toBe(false);
    expect(toProjectSignals({ lines: [] })).toBeUndefined();
    expect(toProjectSignals(7)).toBeUndefined();
  });
});

describe('the history and the tracks of the chart', () => {
  const rows = (items: Array<Record<string, unknown>>): HistoryRow[] => toProjectSignals({ project: { id: 'p' }, history: items })?.history ?? [];

  it('orders the history newest first, and the same day by the moment it was written', () => {
    const ordered = newestFirst(rows([historyRow({ id: 'a' }), historyRow({ id: 'b', scored_on: '2026-11-07' }), historyRow({ id: 'c', scored_on: '2026-11-07', scored_at: '2026-11-07T09:00:00.000Z' })]));
    expect(ordered.map((row) => row.id)).toEqual(['c', 'b', 'a']);
  });

  it('makes one track a line with one point a day, oldest first, the last score of the day', () => {
    const tracks = tracksOf(
      rows([
        historyRow({ id: 'a', scored_on: '2026-11-07', score: 16, scored_at: '2026-11-07T01:00:00.000Z' }),
        historyRow({ id: 'b', scored_on: '2026-11-06', score: 12 }),
        historyRow({ id: 'c', scored_on: '2026-11-07', score: 20, scored_at: '2026-11-07T10:00:00.000Z' }),
        historyRow({ id: 'd', subject_kind: 'RISK', signal_id: null, risk_id: 'r1', signal_kind: null, score: 9 }),
      ]),
    );
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.points).toEqual([
      { day: '2026-11-06', score: 12 },
      { day: '2026-11-07', score: 20 },
    ]);
    expect(tracks[1]).toMatchObject({ kind: 'REGISTER', subjectKind: 'RISK' });
  });
});

describe('describeRefusal and isNotFound', () => {
  it.each([
    ['RISK_ALERT_STATE_INVALID', 'alertState'],
    ['VERSION_CONFLICT', 'versionConflict'],
    ['SCOPE_DENIED', 'denied'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['VALIDATION_FAILED', 'validation'],
    ['SESSION_EXPIRED', 'session'],
    ['SOMETHING_ELSE', 'general'],
  ])('words %s as %s', (code, expected) => {
    expect(describeRefusal(refusal(code))).toBe(expected);
  });

  it('words a failure that is not an answer of the server as general, and knows a 404', () => {
    expect(describeRefusal(new Error('x'))).toBe('general');
    expect(isNotFound(refusal('RESOURCE_NOT_FOUND', 404))).toBe(true);
    expect(isNotFound(refusal('RESOURCE_NOT_FOUND', 403))).toBe(false);
    expect(isNotFound(new Error('x'))).toBe(false);
  });
});

describe('figureText', () => {
  it('writes a figure as the reader of the locale does', () => {
    expect(figureText(1234.5, 'en')).toBe('1,234.5');
    expect(figureText(1234.5, 'vi')).toBe('1.234,5');
    expect(figureText(45, 'vi')).toBe('45');
  });
});
