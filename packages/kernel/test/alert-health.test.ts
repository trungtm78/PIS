import { DomainError } from '../src/errors';
import { KPI_CODES, computeAlertHealth, healthTargetDefaults, healthTargetsOf, judgeFigure, percentile } from '../src/alert-health';
import type { HealthInput, HealthItem, HealthNotice } from '../src/alert-health';
import { builtInDefault, validateRuleParams } from '../src/governance-rules';
import type { WorkCalendarSource } from '../src/working-time';

const targets = healthTargetDefaults();
const CALENDAR: WorkCalendarSource = {
  forYear: (year) => (year === 2027 ? { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code 2019' } : undefined),
};
const at = (iso: string): Date => new Date(iso);
// The window is the week of Monday 2027-10-11 to Monday 2027-10-18 (Vietnam), the clock is Friday 2027-10-15 at 17:00 (10:00 UTC).
const FROM = at('2027-10-10T17:00:00Z');
const TO = at('2027-10-17T17:00:00Z');
const NOW = at('2027-10-15T10:00:00Z');
const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const item = (over: Partial<HealthItem> = {}): HealthItem => ({
  source: 'ISSUE',
  typeCode: 'ISSUE_SLA_BREACH',
  severity: 'ACTION',
  ownerId: 'p1',
  unitId: 'u1',
  startedAt: at('2027-10-12T01:00:00Z'),
  firstSeenAt: at('2027-10-12T01:00:00Z'),
  firstClaimAt: null,
  state: 'OPEN',
  closedAt: null,
  dueAt: null,
  lastChangeAt: at('2027-10-12T01:00:00Z'),
  maxEscalationLevel: 0,
  levelsConfigured: 2,
  snoozeCount: 0,
  pauses: [],
  ...over,
});

const input = (over: Partial<HealthInput> = {}): HealthInput => ({
  from: FROM,
  to: TO,
  now: NOW,
  items: [],
  notices: [],
  gaps: [],
  coverage: null,
  delivery: null,
  calendars: CALENDAR,
  lastPassAt: at('2027-10-15T09:50:00Z'),
  targets,
  ...over,
});

const kpiOf = (health: ReturnType<typeof computeAlertHealth>, code: string): ReturnType<typeof computeAlertHealth>['kpis'][number] => {
  const found = health.kpis.find((one) => one.code === code);
  if (found === undefined) throw new Error(`no ${code}`);
  return found;
};

describe('the targets of the health of the alert system (G2-10)', () => {
  it('are the built-in default of the rule type, flagged unverified, and pass their own schema and parser', () => {
    const found = builtInDefault('ALERT_HEALTH_TARGETS', 'DEFAULT');
    expect(found?.unverified).toBe(true);
    expect(healthTargetsOf(found?.params)).toEqual(targets);
    expect(validateRuleParams('ALERT_HEALTH_TARGETS', found?.params)).toEqual(found?.params);
  });

  it('refuse targets that are not whole or contradict themselves', () => {
    expect(refusal(() => healthTargetsOf({ ...targets, on_time_min_pct: 120 })).detail).toBe('on_time_min_pct');
    expect(refusal(() => healthTargetsOf({ ...targets, stale_after_days: { first: 30, second: 7 } })).detail).toBe('stale_after_days.second');
    expect(refusal(() => healthTargetsOf({ ...targets, mtta_working_hours: { URGENT: 4, ACTION: 8 } })).detail).toBe('mtta_working_hours.WATCH');
    expect(refusal(() => healthTargetsOf(undefined)).detail).toBe('params');
  });
});

describe('judging a figure (G2-10)', () => {
  it('is OK within the target, a WATCH within a fifth beyond it and a BREACH further; a target of zero has no slack', () => {
    expect(judgeFigure(20, 20, 'MAX')).toBe('OK');
    expect(judgeFigure(24, 20, 'MAX')).toBe('WATCH');
    expect(judgeFigure(24.1, 20, 'MAX')).toBe('BREACH');
    expect(judgeFigure(0, 0, 'MAX')).toBe('OK');
    expect(judgeFigure(1, 0, 'MAX')).toBe('BREACH');
    expect(judgeFigure(90, 90, 'MIN')).toBe('OK');
    expect(judgeFigure(72, 90, 'MIN')).toBe('WATCH');
    expect(judgeFigure(71.9, 90, 'MIN')).toBe('BREACH');
  });

  it('has the nearest-rank percentile of a list, and none of an empty one', () => {
    expect(percentile([], 0.9)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([10, 1, 9], 0.5)).toBe(9);
  });
});

describe('the fourteen indicators (G2-10)', () => {
  it('has all fourteen, each with a formula, a source and a status, and every figure without records is NO_DATA, never zero', () => {
    const health = computeAlertHealth(input());
    expect(health.kpis.map((one) => one.code)).toEqual([...KPI_CODES]);
    expect(KPI_CODES).toHaveLength(14);
    for (const one of health.kpis) {
      expect(one.formula.length).toBeGreaterThan(20);
      expect(one.source.length).toBeGreaterThan(10);
      if (one.code !== 'ORPHAN' && one.code !== 'URGENT_DELIVERY') expect(one.status).toBe('NO_DATA');
      if (one.code !== 'ORPHAN') expect(one.value).toBeNull();
    }
    expect(kpiOf(health, 'URGENT_DELIVERY')).toMatchObject({ status: 'NO_SOURCE', note: 'NO_DELIVERY_RECEIPTS', value: null });
    // The orphans are counted from the gaps, and no gap is zero orphans.
    expect(kpiOf(health, 'ORPHAN')).toMatchObject({ value: 0, status: 'OK' });
    expect(health.items).toEqual({ inWindow: 0, open: 0 });
  });

  it('says the recording job is old when it did not run within two passes, or never', () => {
    expect(computeAlertHealth(input()).stale).toBe(false);
    expect(computeAlertHealth(input({ lastPassAt: at('2027-10-15T09:00:00Z') })).stale).toBe(true);
    expect(computeAlertHealth(input({ lastPassAt: null }))).toMatchObject({ stale: true, lastPassAt: null });
  });

  it('computes the time to take up and to resolve in working hours, less the pauses, and judges each severity against its own target', () => {
    // Started Tuesday 08:00 and taken up Tuesday 10:00 (two working hours); another started Tuesday 15:00 and taken up Wednesday 09:00 (3 working hours).
    const items = [
      item({ severity: 'URGENT', startedAt: at('2027-10-12T01:00:00Z'), firstClaimAt: at('2027-10-12T03:00:00Z') }),
      item({ severity: 'URGENT', startedAt: at('2027-10-12T08:00:00Z'), firstClaimAt: at('2027-10-13T02:00:00Z') }),
      item({ severity: 'ACTION', startedAt: at('2027-10-12T01:00:00Z'), firstClaimAt: at('2027-10-13T10:00:00Z') }),
      // Resolved after 16 working hours from Tuesday 08:00 (Wednesday 17:00), with the whole of Wednesday paused: 8 working hours.
      item({ state: 'RESOLVED', closedAt: at('2027-10-13T10:00:00Z'), startedAt: at('2027-10-12T01:00:00Z'), pauses: [{ from: at('2027-10-13T01:00:00Z'), until: at('2027-10-13T10:00:00Z') }] }),
    ];
    const health = computeAlertHealth(input({ items }));
    const mtta = kpiOf(health, 'MTTA');
    expect(mtta.parts.find((part) => part.key === 'URGENT')).toMatchObject({ value: 2.5, sample: 2, status: 'OK', target: 4 });
    expect(mtta.parts.find((part) => part.key === 'ACTION')).toMatchObject({ value: 16, sample: 1, status: 'BREACH', target: 8 });
    expect(mtta.status).toBe('BREACH');
    expect(mtta.sample).toBe(3);
    expect(mtta.lowSample).toBe(true);
    expect(kpiOf(health, 'MTTR')).toMatchObject({ value: 8, sample: 1, unit: 'HOURS', target: null });
  });

  it('does not guess the working hours when a year is not published: the figure says so', () => {
    const items = [item({ firstClaimAt: at('2027-10-12T03:00:00Z') })];
    const health = computeAlertHealth(input({ items, calendars: undefined }));
    expect(kpiOf(health, 'MTTA')).toMatchObject({ value: null, status: 'NO_DATA', note: 'CALENDAR_UNAVAILABLE' });
  });

  it('counts the closed items that met their time, leaves out the ones without a time and says so', () => {
    const closed = (over: Partial<HealthItem>): HealthItem => item({ state: 'RESOLVED', closedAt: at('2027-10-14T03:00:00Z'), dueAt: at('2027-10-14T10:00:00Z'), ...over });
    const health = computeAlertHealth(input({ items: [closed({}), closed({}), closed({ closedAt: at('2027-10-14T11:00:00Z') }), closed({ dueAt: null }), closed({ state: 'CLEARED' })] }));
    expect(kpiOf(health, 'ON_TIME')).toMatchObject({ value: 75, sample: 4, status: 'WATCH', note: 'WITHOUT_TIME_LEFT_OUT' });
    // An item that closed before the window is not counted.
    expect(kpiOf(computeAlertHealth(input({ items: [closed({ closedAt: at('2027-10-01T03:00:00Z') })] })), 'ON_TIME').value).toBeNull();
  });

  it('counts the items that went up, and went to the last level, of those that began in the window', () => {
    const items = [item(), item({ maxEscalationLevel: 1 }), item({ maxEscalationLevel: 2 }), item({ maxEscalationLevel: 2, levelsConfigured: 3 }), item({ firstSeenAt: at('2027-09-01T00:00:00Z'), maxEscalationLevel: 2 })];
    const health = computeAlertHealth(input({ items }));
    expect(kpiOf(health, 'ESCALATED')).toMatchObject({ value: 75, sample: 4, target: 20, status: 'BREACH' });
    expect(kpiOf(health, 'LAST_LEVEL')).toMatchObject({ value: 25, sample: 4, status: 'BREACH' });
  });

  it('takes the 90th percentile of the alerts a person gets in a day, for the days they got any, and splits out the urgent ones', () => {
    const day = (n: number, over: Partial<HealthItem> = {}): HealthItem => item({ firstSeenAt: at(`2027-10-1${n}T03:00:00Z`), startedAt: at(`2027-10-1${n}T03:00:00Z`), ...over });
    const items = [day(2), day(2, { severity: 'URGENT' }), day(2, { severity: 'URGENT' }), day(3), day(4, { ownerId: 'p2' }), day(4, { ownerId: null })];
    const health = computeAlertHealth(input({ items }));
    const per = kpiOf(health, 'ALERTS_PER_PERSON');
    expect(per).toMatchObject({ value: 3, sample: 3, unit: 'COUNT' });
    expect(per.parts.find((part) => part.key === 'URGENT')).toMatchObject({ value: 2, target: 1, status: 'BREACH' });
    expect(per.parts.find((part) => part.key === 'TOTAL')).toMatchObject({ value: 3, status: 'OK' });
  });

  it('counts the interrupting notices of a person in a day and the ones that broke the quiet hours without the allowance', () => {
    const notice = (over: Partial<HealthNotice> = {}): HealthNotice => ({ memberId: 'p1', day: '2027-10-12', channel: 'PUSH', decision: 'SEND_NOW', severity: 'ACTION', inQuiet: false, bypass: null, ...over });
    const notices = [notice(), notice(), notice({ memberId: 'p2' }), notice({ decision: 'HOLD_QUIET' }), notice({ decision: 'SEND_GROUPED', inQuiet: true, bypass: 'URGENT_UNCLAIMED', severity: 'URGENT' }), notice({ inQuiet: true })];
    const health = computeAlertHealth(input({ notices }));
    expect(kpiOf(health, 'PUSH_PER_PERSON')).toMatchObject({ value: 4, sample: 2, status: 'OK' });
    const off = kpiOf(health, 'OFF_HOURS');
    expect(off).toMatchObject({ value: 1, sample: 5, status: 'BREACH', target: 0 });
    expect(off.parts.map((part) => [part.key, part.value])).toEqual([['ALLOWED', 1], ['UNJUSTIFIED', 1]]);
  });

  it('counts the open items that did not change for more than the days of the two lines, and by unit', () => {
    const old = (days: number, over: Partial<HealthItem> = {}): HealthItem => item({ lastChangeAt: new Date(NOW.getTime() - days * 86_400_000), ...over });
    const items = [old(1), old(8), old(9, { unitId: 'u2' }), old(31), old(40, { state: 'RESOLVED', closedAt: at('2027-10-14T03:00:00Z') })];
    const health = computeAlertHealth(input({ items }));
    const stale = kpiOf(health, 'STALE');
    expect(stale).toMatchObject({ value: 75, sample: 4, status: 'BREACH' });
    expect(stale.parts.map((part) => [part.key, part.value])).toEqual([['OVER_7_DAYS', 3], ['OVER_30_DAYS', 1]]);
    expect(health.staleByUnit).toEqual([{ unitId: 'u1', count: 2 }, { unitId: 'u2', count: 1 }]);
    expect(health.items.open).toBe(4);
  });

  it('weighs the ten largest types and the rate of items put off by type', () => {
    const typed = (typeCode: string, count: number, snoozed = 0): HealthItem[] => Array.from({ length: count }, (_, index) => item({ typeCode, snoozeCount: index < snoozed ? 1 : 0 }));
    const items = [...typed('A', 6, 3), ...typed('B', 3), ...typed('C', 1)];
    const health = computeAlertHealth(input({ items }));
    expect(health.topTypes).toEqual([
      { typeCode: 'A', count: 6, sharePct: 60, snoozed: 3, snoozeRatePct: 50 },
      { typeCode: 'B', count: 3, sharePct: 30, snoozed: 0, snoozeRatePct: null },
      { typeCode: 'C', count: 1, sharePct: 10, snoozed: 0, snoozeRatePct: null },
    ]);
    // Three types hold all of it: the ten largest weigh a hundred percent.
    expect(kpiOf(health, 'TOP10_SHARE')).toMatchObject({ value: 100, status: 'BREACH' });
    const snooze = kpiOf(health, 'SNOOZE_RATE');
    expect(snooze).toMatchObject({ value: 30, sample: 10, note: 'UNHELPFUL_FEEDBACK_NOT_BUILT' });
    // A type with fewer items than the minimum sample is not judged by itself.
    expect(snooze.parts.map((part) => part.key)).toEqual(['A']);
    expect(snooze.parts[0]).toMatchObject({ value: 50, status: 'BREACH' });
  });

  it('counts the orphaned alerts that are open now and the mean time to reroute the ones closed in the window', () => {
    const health = computeAlertHealth(
      input({
        gaps: [
          { kind: 'ABSENT_NO_COVER', itemCount: 3, openedAt: at('2027-10-14T01:00:00Z'), closedAt: null },
          { kind: 'OWNER_INACTIVE', itemCount: 1, openedAt: at('2027-10-13T01:00:00Z'), closedAt: at('2027-10-13T03:00:00Z') },
          { kind: 'OWNER_INACTIVE', itemCount: 1, openedAt: at('2027-10-13T01:00:00Z'), closedAt: at('2027-10-13T01:30:00Z') },
          { kind: 'OWNER_INACTIVE', itemCount: 1, openedAt: at('2027-08-13T01:00:00Z'), closedAt: at('2027-08-13T03:00:00Z') },
        ],
      }),
    );
    const orphan = kpiOf(health, 'ORPHAN');
    expect(orphan).toMatchObject({ value: 3, status: 'BREACH' });
    expect(orphan.parts.find((part) => part.key === 'REROUTE_HOURS')).toMatchObject({ value: 1.25, sample: 2, status: 'BREACH', target: 1 });
  });

  it('computes the delivery of urgent notices only when the platform has receipts, and the coverage of positions from the summary', () => {
    const delivered = computeAlertHealth(input({ delivery: { sent: 200, deliveredWithin: 199 } }));
    expect(kpiOf(delivered, 'URGENT_DELIVERY')).toMatchObject({ value: 99.5, status: 'OK' });
    expect(kpiOf(computeAlertHealth(input({ delivery: { sent: 0, deliveredWithin: 0 } })), 'URGENT_DELIVERY')).toMatchObject({ value: null, status: 'NO_DATA' });
    const covered = computeAlertHealth(input({ coverage: { positions: [], backedUp: 3, total: 4, percent: 75 } }));
    expect(kpiOf(covered, 'DELEGATION_COVERAGE')).toMatchObject({ value: 75, status: 'BREACH', sample: 4 });
    expect(kpiOf(computeAlertHealth(input({ coverage: { positions: [], backedUp: 0, total: 0, percent: null } })), 'DELEGATION_COVERAGE')).toMatchObject({ value: null, status: 'NO_DATA', note: 'NO_POSITIONS' });
  });
});
