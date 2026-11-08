import { cumulativeAt, neededOf, outlookOf, sameDayLastYear } from '../src/ana-forecast';
import type { ForecastParams, OutlookInput, OutlookPoint } from '../src/ana-forecast';

const M = 1_000_000;
const params: ForecastParams = { windowMinWeeks: 4, windowMaxWeeks: 8, central: 'MEDIAN', seasonality: true, pointToleranceDays: 3, attentionBelowPct: 90 };
const point = (asOfDate: string, millions: number): OutlookPoint => ({ asOfDate, cumulativeVnd: String(millions * M) });
const weeks = ['2027-09-05', '2027-09-12', '2027-09-19', '2027-09-26', '2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24', '2027-10-31'];
const series = (values: number[]): OutlookPoint[] => values.map((value, index) => point(weeks[index] as string, value));
const STEADY = series([400, 410, 420, 430, 440, 450, 460, 470, 480]);
const ACCELERATING = series([400, 405, 410, 415, 425, 435, 450, 470, 490]);
const PRIOR = [point('2026-09-05', 300), point('2026-10-03', 380), point('2026-10-31', 460), point('2026-12-31', 1000)];
const input = (over: Partial<OutlookInput> = {}): OutlookInput => ({ planTotalVnd: String(1000 * M), points: STEADY, priorPoints: [], planYearEnd: '2027-12-31', params, ...over });

describe('the year-end outlook of the disbursement (G3-5)', () => {
  it('golden: a steady pace of 10M a week gives one straight-line value for every window', () => {
    // 61 days from 31 October to 31 December; window of 4 weeks: 40M over 28 days, 40M * 61 / 28 = 87,142,857.14 -> 87,142,857; every window has the same pace.
    const outlook = outlookOf(input());
    expect(outlook.nullReason).toBeNull();
    expect(outlook.remainingDays).toBe(61);
    expect(outlook.windows.map((window) => window.weeks)).toEqual([4, 5, 6, 7, 8]);
    expect(outlook.linear).toEqual({ lowVnd: '567142857', centralVnd: '567142857', highVnd: '567142857' });
    expect(outlook.linearRatioPct).toEqual({ low: '56.7', central: '56.7', high: '56.7' });
    expect(outlook.gapVnd).toBe(String(567_142_857 - 1000 * M));
    expect(outlook.attention).toBe(true);
    // Needed: 520M * 7 / 61 = 59,672,131.15 -> 59,672,131 a week, 5.97 times the 10M pace.
    expect(outlook.needed).toMatchObject({ status: 'NEEDED', remainingVnd: String(520 * M), perWeekVnd: '59672131', speedVnd: String(10 * M), multiple: '5.97' });
    expect(outlook.seasonalNullReason).toBe('NO_PRIOR_YEAR');
    expect(outlook.seasonal).toBeNull();
  });

  it('golden: an accelerating series keeps the five windows and the band runs from the slowest to the fastest', () => {
    const outlook = outlookOf(input({ points: ACCELERATING }));
    expect(outlook.windows.map((window) => window.linearYearEndVnd)).toEqual(['631607143', '620714286', '606190476', '595816327', '588035714']);
    expect(outlook.windows.map((window) => window.weeklySpeedVnd)).toEqual(['16250000', '15000000', '13333333', '12142857', '11250000']);
    expect(outlook.linear).toEqual({ lowVnd: '588035714', centralVnd: '606190476', highVnd: '631607143' });
    expect(outlook.linearRatioPct).toEqual({ low: '58.8', central: '60.6', high: '63.2' });
    // Needed 510M * 7 / 61 = 58,524,590.16; the central pace is 13,333,333 a week: 4.39 times.
    expect(outlook.needed).toMatchObject({ perWeekVnd: '58524590', speedVnd: '13333333', multiple: '4.39' });
  });

  it('the mean is available as the central choice', () => {
    const outlook = outlookOf(input({ points: ACCELERATING, params: { ...params, central: 'MEAN' } }));
    // (631,607,143 + 620,714,286 + 606,190,476 + 595,816,327 + 588,035,714) / 5 = 608,472,789.2
    expect(outlook.linear?.centralVnd).toBe('608472789');
  });

  it('golden: the seasonal projection scales the remainder of the year before by the pace ratio', () => {
    // Prior year paid 460M by 31 Oct and 1,000M at the year end; in the 4 week window it paid 80M (380M at 3 Oct), this year 40M: 480M + 540M * 40 / 80 = 750M, the same for every window of a steady year.
    const outlook = outlookOf(input({ priorPoints: PRIOR }));
    expect(outlook.seasonalNullReason).toBeNull();
    expect(outlook.windows.map((window) => window.seasonalYearEndVnd)).toEqual(Array(5).fill(String(750 * M)));
    expect(outlook.seasonal).toEqual({ lowVnd: String(750 * M), centralVnd: String(750 * M), highVnd: String(750 * M) });
    expect(outlook.seasonalRatioPct?.central).toBe('75.0');
  });

  it('says why the seasonal reading is missing and never invents a curve', () => {
    expect(outlookOf(input({ priorPoints: PRIOR.slice(0, 3) })).seasonalNullReason).toBe('PRIOR_YEAR_TOO_SHORT');
    expect(outlookOf(input({ priorPoints: PRIOR, params: { ...params, seasonality: false } })).seasonalNullReason).toBe('SEASONALITY_OFF');
    // The year before paid nothing in the window: the ratio does not exist.
    const flat = [point('2026-09-05', 300), point('2026-12-31', 300)];
    const priorFlat = outlookOf(input({ priorPoints: [point('2026-01-10', 300), ...flat.slice(1)] }));
    expect(priorFlat.seasonalNullReason).not.toBeNull();
    expect(priorFlat.seasonal).toBeNull();
  });

  it('skips a window with a negative delta and a window with no week point, and keeps the rest', () => {
    const corrected = series([400, 410, 420, 430, 440, 450, 460, 470, 480]);
    corrected[4] = point('2027-10-03', 500); // the week 4 weeks back is higher than today: window 4 is a negative delta
    const outlook = outlookOf(input({ points: corrected }));
    expect(outlook.skipped).toContainEqual({ weeks: 4, reason: 'NEGATIVE_DELTA' });
    expect(outlook.windows.map((window) => window.weeks)).toEqual([5, 6, 7, 8]);
    const sparse = outlookOf(input({ points: [point('2027-10-24', 470), point('2027-10-31', 480)] }));
    expect(sparse.nullReason).toBe('TOO_FEW_WEEKS');
    expect(sparse.skipped).toHaveLength(5);
    expect(sparse.linear).toBeNull();
    // The needed amount does not depend on the pace.
    expect(sparse.needed).toMatchObject({ status: 'NEEDED', perWeekVnd: '59672131', multiple: null, multipleNullReason: 'NO_SPEED' });
  });

  it('is N/A with a reason for no plan, no data and a year that has ended; never zero', () => {
    expect(outlookOf(input({ planTotalVnd: null })).nullReason).toBe('NO_PLAN');
    expect(outlookOf(input({ planTotalVnd: '0' })).needed.status).toBe('NA');
    const none = outlookOf(input({ points: [] }));
    expect(none).toMatchObject({ nullReason: 'NO_TREASURY_DATA', cumulativeVnd: null, linear: null });
    const ended = outlookOf(input({ planYearEnd: '2027-10-31' }));
    expect(ended.nullReason).toBe('YEAR_ENDED');
    expect(ended.needed.status).toBe('NA');
  });

  it('reaches the plan: nothing more is needed', () => {
    const outlook = outlookOf(input({ planTotalVnd: String(480 * M) }));
    expect(outlook.needed).toMatchObject({ status: 'REACHED', perWeekVnd: '0', remainingVnd: '0', multiple: '0.00' });
    expect(outlook.attention).toBe(false);
  });

  it('a zero pace gives no multiple', () => {
    const flat = series([480, 480, 480, 480, 480, 480, 480, 480, 480]);
    const outlook = outlookOf(input({ points: flat }));
    expect(outlook.needed).toMatchObject({ speedVnd: '0', multiple: null, multipleNullReason: 'ZERO_SPEED' });
    expect(outlook.linear?.centralVnd).toBe(String(480 * M));
  });

  it('uses the same answer whatever the order or duplicates of the points', () => {
    const shuffled = [...STEADY].reverse().concat(STEADY[3] as OutlookPoint);
    expect(outlookOf(input({ points: shuffled }))).toEqual(outlookOf(input()));
  });

  it('an invariant: the band is ordered and the central value lies inside it, for many seeded series', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 60; round += 1) {
      let cumulative = 100 * M;
      const points = weeks.map((day) => {
        cumulative += (next() % 30) * M;
        return point(day, cumulative / M);
      });
      const outlook = outlookOf(input({ points, planTotalVnd: String(2000 * M) }));
      if (outlook.linear === null) continue;
      const { lowVnd, centralVnd, highVnd } = outlook.linear;
      expect(BigInt(lowVnd) <= BigInt(centralVnd) && BigInt(centralVnd) <= BigInt(highVnd)).toBe(true);
      expect(BigInt(lowVnd) >= BigInt(outlook.cumulativeVnd as string)).toBe(true);
    }
  });
});

describe('the helpers of the outlook', () => {
  it('reads the cumulative of a day by interpolation and starts the year at zero', () => {
    expect(cumulativeAt(PRIOR, '2026-09-26')?.toString()).toBe(String(360 * M));
    expect(cumulativeAt(PRIOR, '2026-01-01')?.toString()).toBe('0');
    expect(cumulativeAt(PRIOR, '2026-02-01')?.toString()).toBe(String(Math.round((300 * M * 31) / 247)));
    expect(cumulativeAt(PRIOR, '2027-01-02')).toBeNull();
  });

  it('moves a day one year back, 29 February to 28 February', () => {
    expect(sameDayLastYear('2028-02-29')).toBe('2027-02-28');
    expect(sameDayLastYear('2027-10-31')).toBe('2026-10-31');
  });

  it('rounds the needed amount half up and refuses nothing it can compute', () => {
    // 10 dong over 3 days: 10 * 7 / 3 = 23.33 -> 23 a week; a pace of 7 gives 3.29 times.
    expect(neededOf(100n, 90n, 3, 7n, null)).toMatchObject({ perWeekVnd: '23', multiple: '3.29' });
  });
});
