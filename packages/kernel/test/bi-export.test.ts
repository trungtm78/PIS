import { BI_EXPORT_ROW_CAP, buildBiExportDocument, knownTimeZone, nextFire, parseCron, scheduleDue } from '../src/bi-export.ts';
import { csvOf } from '../src/dis-export.ts';

const at = (iso: string): Date => new Date(iso);

describe('the cron of an export schedule (BI 3 F7)', () => {
  it('reads the five fields with lists, ranges and steps, and refuses anything else naming the field', () => {
    const cron = parseCron('*/15 8-10 1,15 * 1-5');
    expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...cron.hours]).toEqual([8, 9, 10]);
    expect([...cron.days]).toEqual([1, 15]);
    expect(cron.months.size).toBe(12);
    expect([...cron.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('0 0 * * 7').weekdays.has(0)).toBe(true);
    for (const [text, field] of [
      ['0 0 * *', 'expression'],
      ['0 0 * * * *', 'expression'],
      ['60 0 * * *', 'minute'],
      ['0 24 * * *', 'hour'],
      ['0 0 0 * *', 'day'],
      ['0 0 * 13 *', 'month'],
      ['0 0 * * 8', 'weekday'],
      ['5-1 0 * * *', 'minute'],
      ['*/0 0 * * *', 'minute'],
      ['a 0 * * *', 'minute'],
      ['1-2-3 0 * * *', 'minute'],
      [',, 0 * * *', 'minute'],
      ['1/2/3 0 * * *', 'minute'],
    ] as const) {
      expect(() => parseCron(text)).toThrow(expect.objectContaining({ code: 'CRON_INVALID', status: 409, detail: field }));
    }
  });

  it('finds the next time in the zone of the schedule: Monday 08:00 in Hanoi is Monday 01:00 UTC', () => {
    const weekly = parseCron('0 8 * * 1');
    // 2026-11-01 is a Sunday; the next Monday is the 2nd.
    expect(nextFire(weekly, at('2026-11-01T10:00:00Z'))?.toISOString()).toBe('2026-11-02T01:00:00.000Z');
    expect(nextFire(weekly, at('2026-11-02T01:00:00Z'))?.toISOString()).toBe('2026-11-09T01:00:00.000Z');
    expect(nextFire(weekly, at('2026-11-02T00:59:59Z'))?.toISOString()).toBe('2026-11-02T01:00:00.000Z');
    expect(nextFire(parseCron('30 23 * * *'), at('2026-11-01T00:00:00Z'), 'UTC')?.toISOString()).toBe('2026-11-01T23:30:00.000Z');
    expect(nextFire(parseCron('0 0 1 * *'), at('2026-11-15T00:00:00Z'))?.toISOString()).toBe('2026-11-30T17:00:00.000Z');
  });

  it('fires on the day of the month or the weekday when both are written, as cron does, and never for a day that does not come', () => {
    const either = parseCron('0 0 13 * 5');
    expect(nextFire(either, at('2026-11-01T00:00:00Z'), 'UTC')?.toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(nextFire(parseCron('0 0 31 2 *'), at('2026-01-01T00:00:00Z'), 'UTC')).toBeUndefined();
    // A field that begins with a star is a wildcard even with a step: every day of the month, narrowed by the weekday alone (Mondays), not every day.
    const mondays = parseCron('0 8 */1 * 1');
    expect(mondays.dayRestricted).toBe(false);
    expect(nextFire(mondays, at('2026-11-02T01:00:00Z'))?.toISOString()).toBe('2026-11-09T01:00:00.000Z');
    expect(parseCron('0 8 1 * */2').weekdayRestricted).toBe(false);
    expect(parseCron('0 8 1-5 * 1').dayRestricted).toBe(true);
  });

  it('says a schedule is due once its next time after the last run has come, and knows the zones it can use', () => {
    const daily = parseCron('0 8 * * *');
    expect(scheduleDue(daily, at('2026-11-01T01:00:00Z'), at('2026-11-02T00:59:00Z'))).toBe(false);
    expect(scheduleDue(daily, at('2026-11-01T01:00:00Z'), at('2026-11-02T01:00:00Z'))).toBe(true);
    expect(scheduleDue(parseCron('0 0 31 2 *'), at('2026-01-01T00:00:00Z'), at('2030-01-01T00:00:00Z'), 'UTC')).toBe(false);
    expect(knownTimeZone('Asia/Ho_Chi_Minh')).toBe(true);
    expect(knownTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('the file of a BI export (BI 3 F7)', () => {
  const figure = (value: string | null, nullReason: string | null = null) => ({ value, numerator: value, denominator: null, nullReason });
  const document = buildBiExportDocument({
    metricCode: 'disbursed',
    metricRevision: 3,
    unit: 'VND',
    dimension: { code: 'unit', label: 'Đơn vị' },
    asOfPeriod: '2026-10',
    datasetVersionId: '00000000-0000-4000-8000-0000000000d1',
    scopeDescription: 'toàn tỉnh',
    generatedAt: at('2026-11-01T01:00:00Z'),
    rows: [
      { key: 'u1', label: 'Sở A', ...figure('4000') },
      { key: null, label: null, ...figure(null, 'NO_DATA') },
      { key: 'u3', label: '=cmd', ...figure('9') },
    ],
    total: figure('4009'),
  });

  it('states what the figures are in the header: the metric by its revision, the scope, the period, the snapshot and when', () => {
    expect(document.header.map((entry) => [entry.key, entry.value])).toEqual([
      ['metric', 'disbursed (bản 3, VND)'],
      ['scope', 'toàn tỉnh'],
      ['as_of_period', '2026-10'],
      ['snapshot', '00000000-0000-4000-8000-0000000000d1'],
      ['dimension', 'Đơn vị'],
      ['generated_at', '2026-11-01T01:00:00.000Z'],
    ]);
  });

  it('writes a group with no figure as empty with its reason, never as zero, adds the total, and quotes what begins like a formula', () => {
    expect(document.rows).toEqual([
      ['u1', 'Sở A', '4000', '4000', '', ''],
      ['', 'Chưa phân loại', '', '', '', 'NO_DATA'],
      ['u3', '=cmd', '9', '9', '', ''],
      ['', 'Tổng', '4009', '4009', '', ''],
    ]);
    const csv = csvOf(document);
    expect(csv).toContain("u3,'=cmd,9,9,,");
    expect(csv).toContain('Phạm vi,toàn tỉnh');
    const single = buildBiExportDocument({
      metricCode: 'x',
      metricRevision: 1,
      unit: 'VND',
      dimension: undefined,
      asOfPeriod: '2026-10',
      datasetVersionId: 'v',
      scopeDescription: 's',
      generatedAt: at('2026-11-01T00:00:00Z'),
      rows: [],
      total: figure('1'),
    });
    expect(single.header.some((entry) => entry.key === 'dimension')).toBe(false);
    expect(single.rows).toEqual([['', 'Tổng', '1', '1', '', '']]);
    expect(BI_EXPORT_ROW_CAP).toBe(100_000);
  });
});
