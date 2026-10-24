import { CORRECTION_SUFFIX, LIMITING_FEATURE, PLAN_FEATURE_CODES, USAGE_METERS, usageMeterOf, usageWindowOf } from '../src/index';

describe('the usage meter catalogue', () => {
  it('has every base meter with its correction, and nothing else', () => {
    const codes = USAGE_METERS.map((meter) => meter.code).sort();
    expect(codes).toEqual(
      [
        'ai.tokens',
        'ai.tokens_correction',
        'bi.query',
        'bi.query_correction',
        'notification.email',
        'notification.email_correction',
        'notification.sms',
        'notification.sms_correction',
        'notification.zns',
        'notification.zns_correction',
        'storage.gb_day',
        'storage.gb_day_correction',
      ].sort(),
    );
  });

  it('adds with a base meter and takes away with its correction, on the same counter and in the same unit', () => {
    for (const meter of USAGE_METERS.filter((entry) => entry.code.endsWith(CORRECTION_SUFFIX))) {
      const base = usageMeterOf(meter.code.slice(0, -CORRECTION_SUFFIX.length));
      expect(meter.direction).toBe('SUBTRACT');
      expect(base?.direction).toBe('ADD');
      expect([meter.counter, meter.unit]).toEqual([base?.counter, base?.unit]);
    }
  });

  it('feeds every message channel into one counter', () => {
    expect(['notification.zns', 'notification.sms', 'notification.email'].map((code) => usageMeterOf(code)?.counter)).toEqual(Array(3).fill('notification.messages'));
  });

  it('knows no meter that is not in the catalogue', () => {
    expect(usageMeterOf('notification.pigeon')).toBeUndefined();
    expect(usageMeterOf('')).toBeUndefined();
    expect(usageMeterOf('toString')).toBeUndefined();
    expect(usageMeterOf('__proto__')).toBeUndefined();
  });

  it('holds a counter against a feature that the plan can sell', () => {
    for (const feature of Object.values(LIMITING_FEATURE)) expect(PLAN_FEATURE_CODES.has(feature)).toBe(true);
    for (const counter of Object.keys(LIMITING_FEATURE)) expect(USAGE_METERS.some((meter) => meter.counter === counter)).toBe(true);
  });
});

describe('usageWindowOf', () => {
  it('is the calendar month in UTC', () => {
    expect(usageWindowOf(new Date('2026-10-25T06:18:00Z'))).toEqual({ start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') });
  });

  it('puts the first and the last instant of a month in the same window and the next instant in the next', () => {
    const first = usageWindowOf(new Date('2026-02-01T00:00:00.000Z'));
    const last = usageWindowOf(new Date('2026-02-28T23:59:59.999Z'));
    const next = usageWindowOf(new Date('2026-03-01T00:00:00.000Z'));
    expect(last).toEqual(first);
    expect(next.start).toEqual(first.end);
  });

  it('crosses the end of the year and leap days', () => {
    expect(usageWindowOf(new Date('2026-12-31T23:59:59Z'))).toEqual({ start: new Date('2026-12-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') });
    expect(usageWindowOf(new Date('2028-02-29T12:00:00Z'))).toEqual({ start: new Date('2028-02-01T00:00:00Z'), end: new Date('2028-03-01T00:00:00Z') });
  });
});
