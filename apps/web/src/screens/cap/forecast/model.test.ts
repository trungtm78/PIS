import { describe, expect, it } from 'vitest';
import * as labels from './labels';
import { EMPTY_FORECAST, estimatesOf, forecastBody, formOf, linkTo, mayRead, planRows, planTotals, signedMillions, toScheduleLine, validateForecast } from './model';
import type { ForecastForm, ScheduleLine } from './model';
import { lineRow, millions } from './test-support';

const lines = (...raw: Array<Record<string, unknown>>): ScheduleLine[] => raw.flatMap((one) => toScheduleLine(one) ?? []);
const t = (key: string, values?: Record<string, string | number>): string => (values === undefined ? key : `${key}:${Object.values(values).join(',')}`);
const form = (overrides: Partial<ForecastForm> = {}): ForecastForm => ({ ...EMPTY_FORECAST, month: '11', amount: '150', assumption: 'Nghiệm thu đợt 3', ...overrides });

describe('mayRead and linkTo', () => {
  it('holds when the permission is listed or the permissions are not yet known', () => {
    expect(mayRead(undefined, 'x')).toBe(true);
    expect(mayRead(['x'], 'x')).toBe(true);
    expect(mayRead(['y'], 'x')).toBe(false);
  });

  it('carries the project and the year to the other screen', () => {
    expect(linkTo('/cap/cap-13', 'p-1', '2026')).toBe('/cap/cap-13?project=p-1&year=2026');
  });
});

describe('toScheduleLine', () => {
  it('reads a registration with what was paid, and an estimate with its assumption', () => {
    const [registered, forecast] = lines(
      lineRow(10, 'REGISTERED', 'CURRENT_YEAR', millions(800), { achievement: { disbursed_vnd: millions(300), rate: '0.3750' } }),
      lineRow(10, 'FORECAST', 'OTHER', millions(5), { budget_level: 'LOCAL' }),
    );
    expect(registered).toMatchObject({ kind: 'REGISTERED', month: 10, bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amountVnd: millions(800), disbursedVnd: millions(300), assumption: null });
    expect(forecast).toMatchObject({ kind: 'FORECAST', bucket: 'OTHER', budgetLevel: 'LOCAL', disbursedVnd: null, assumption: 'Nghiệm thu khối lượng đợt 3' });
  });

  it('counts a registration without a payment as nothing paid', () => {
    expect(lines(lineRow(10, 'REGISTERED', 'CURRENT_YEAR', '5', { achievement: null }))[0]?.disbursedVnd).toBe('0');
  });

  it('leaves out what is not a monthly line in force', () => {
    const bad: Array<Record<string, unknown>> = [
      lineRow(10, 'WEEKLY_COMMITMENT', 'CURRENT_YEAR', '5'),
      lineRow(10, 'FORECAST', 'CURRENT_YEAR', '5', { granularity: 'WEEK' }),
      lineRow(10, 'FORECAST', 'CURRENT_YEAR', '5', { is_current: false }),
      lineRow(0, 'FORECAST', 'CURRENT_YEAR', '5', { month: 0 }),
      lineRow(14, 'FORECAST', 'CURRENT_YEAR', '5', { month: 14 }),
      lineRow(10, 'FORECAST', 'CURRENT_YEAR', '5', { month: 1.5 }),
      lineRow(10, 'FORECAST', 'NOWHERE', '5'),
      lineRow(10, 'FORECAST', 'CURRENT_YEAR', '5', { budget_level: 'REGION' }),
      lineRow(10, 'FORECAST', 'CURRENT_YEAR', '-5'),
      lineRow(10, 'FORECAST', 'CURRENT_YEAR', '5', { revision: '1' }),
      lineRow(10, 'FORECAST', 'CURRENT_YEAR', '5', { id: 7 }),
    ];
    expect(lines(...bad)).toEqual([]);
    expect(toScheduleLine('x')).toBeUndefined();
    expect(toScheduleLine(null)).toBeUndefined();
    expect(toScheduleLine([])).toBeUndefined();
  });
});

describe('planRows and planTotals (CAP-12)', () => {
  const rows = planRows(
    lines(
      lineRow(10, 'REGISTERED', 'CURRENT_YEAR', millions(800), { achievement: { disbursed_vnd: millions(300), rate: '0.3750' } }),
      lineRow(10, 'FORECAST', 'CURRENT_YEAR', millions(600)),
      lineRow(11, 'FORECAST', 'CURRENT_YEAR', millions(100)),
      lineRow(11, 'FORECAST', 'CARRYOVER', millions(50)),
      lineRow(12, 'FORECAST', 'CURRENT_YEAR', '0'),
    ),
  );

  it('gives the thirteen months, each figure the exact sum of its lines and null where nothing was entered', () => {
    expect(rows).toHaveLength(13);
    expect(rows[9]).toEqual({ month: 10, forecastVnd: millions(600), registeredVnd: millions(800), actualVnd: millions(300), differenceVnd: millions(-200) });
    expect(rows[10]).toEqual({ month: 11, forecastVnd: millions(150), registeredVnd: null, actualVnd: null, differenceVnd: null });
    expect(rows[11]?.forecastVnd).toBe('0');
    expect(rows[0]).toEqual({ month: 1, forecastVnd: null, registeredVnd: null, actualVnd: null, differenceVnd: null });
  });

  it('adds the year without inventing a figure for a column no month has', () => {
    expect(planTotals(rows)).toEqual({ forecastVnd: millions(750), registeredVnd: millions(800), actualVnd: millions(300), differenceVnd: millions(-50) });
    expect(planTotals(planRows([]))).toEqual({ forecastVnd: null, registeredVnd: null, actualVnd: null, differenceVnd: null });
  });
});

describe('signedMillions', () => {
  it('writes a negative amount with its minus and keeps the rest exact', () => {
    expect(signedMillions(millions(-200), 'vi')).toBe('-200');
    expect(signedMillions('1500000', 'en')).toBe('1.5');
    expect(signedMillions('0', 'vi')).toBe('0');
  });
});

describe('estimatesOf (CAP-13)', () => {
  it('keeps the estimates by month, source group and budget level', () => {
    const found = estimatesOf(
      lines(
        lineRow(12, 'FORECAST', 'CURRENT_YEAR', '1'),
        lineRow(11, 'FORECAST', 'OTHER', '2'),
        lineRow(11, 'FORECAST', 'CARRYOVER', '3', { budget_level: 'LOCAL' }),
        lineRow(11, 'FORECAST', 'CARRYOVER', '4'),
        lineRow(11, 'REGISTERED', 'CURRENT_YEAR', '5'),
      ),
    );
    expect(found.map((line) => `${line.month}:${line.bucket}:${line.budgetLevel}`)).toEqual(['11:CARRYOVER:CENTRAL', '11:CARRYOVER:LOCAL', '11:OTHER:CENTRAL', '12:CURRENT_YEAR:CENTRAL']);
  });
});

describe('validateForecast', () => {
  it('passes a complete estimate, and an estimate of zero', () => {
    expect(validateForecast(form(), 'vi')).toEqual({});
    expect(validateForecast(form({ amount: '0' }), 'vi')).toEqual({});
  });

  it('asks for the month, the amount and the assumption', () => {
    expect(validateForecast(EMPTY_FORECAST, 'vi')).toEqual({ month: 'required', amount: 'required', assumption: 'required' });
    expect(validateForecast(form({ month: '14', assumption: '   ' }), 'vi')).toEqual({ month: 'required', assumption: 'required' });
  });

  it('refuses an amount that is not one, an assumption that is too long or holds a control character, and a reason that is too long', () => {
    expect(validateForecast(form({ amount: '1.5' }), 'vi').amount).toBe('invalidAmount');
    expect(validateForecast(form({ amount: '-3' }), 'vi').amount).toBe('invalidAmount');
    expect(validateForecast(form({ assumption: 'x'.repeat(2001) }), 'vi').assumption).toBe('tooLong');
    expect(validateForecast(form({ assumption: 'a\u0000b' }), 'vi').assumption).toBe('invalidText');
    expect(validateForecast(form({ assumption: 'a\u007fb' }), 'vi').assumption).toBe('invalidText');
    expect(validateForecast(form({ assumption: 'dòng một\n\tdòng hai\r' }), 'vi')).toEqual({});
    expect(validateForecast(form({ reason: 'x'.repeat(2001) }), 'vi').reason).toBe('tooLong');
  });
});

describe('forecastBody and formOf', () => {
  it('builds the monthly estimate with exact VND, the trimmed assumption and the reason only when given', () => {
    expect(forecastBody(form({ amount: '150,5', bucket: 'CARRYOVER', budgetLevel: 'LOCAL', assumption: ' Nghiệm thu ', reason: ' Điều chỉnh ' }), 'p-1', 2026, 'vi')).toEqual({
      project_id: 'p-1',
      plan_year: 2026,
      granularity: 'MONTH',
      month: 11,
      kind: 'FORECAST',
      bucket: 'CARRYOVER',
      budget_level: 'LOCAL',
      amount_vnd: '150500000',
      assumption: 'Nghiệm thu',
      revision_reason: 'Điều chỉnh',
    });
    expect(forecastBody(form({ amount: '0' }), 'p-1', 2026, 'vi')).not.toHaveProperty('revision_reason');
    expect(forecastBody(form({ amount: '0' }), 'p-1', 2026, 'vi').amount_vnd).toBe('0');
  });

  it('offers an estimate in force as a form to change', () => {
    const [line] = lines(lineRow(11, 'FORECAST', 'OTHER', '2500000', { budget_level: 'LOCAL' }));
    expect(formOf(line as ScheduleLine, 'vi')).toEqual({ month: '11', bucket: 'OTHER', budgetLevel: 'LOCAL', amount: '2,5', assumption: 'Nghiệm thu khối lượng đợt 3', reason: '' });
    const [bare] = lines(lineRow(11, 'FORECAST', 'OTHER', '1000000', { assumption: null }));
    expect(formOf(bare as ScheduleLine, 'vi').assumption).toBe('');
  });
});

describe('labels', () => {
  it('says every problem of an assumption in its own sentence', () => {
    for (const problem of ['required', 'tooLong', 'invalidText'] as const) expect(labels.assumptionMessage(t, problem)).toMatch(/^cap\.estimate\.assumption\./);
  });
});
