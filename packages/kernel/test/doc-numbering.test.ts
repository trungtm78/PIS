import { DomainError } from '../src/errors.ts';
import { buildSymbol, formatRegisterNumber, signingTimeText, validateSymbolPattern, vietnamDateOf, vietnamYearOf } from '../src/doc-numbering.ts';

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof DomainError ? error.code : 'NOT_A_DOMAIN_ERROR';
  }
}

describe('formatRegisterNumber (BR-DOC-06)', () => {
  it.each([
    [1, '01'],
    [9, '09'],
    [10, '10'],
    [43, '43'],
    [123, '123'],
  ])('shows %i as %s', (value, expected) => {
    expect(formatRegisterNumber(value)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects %p', (value) => {
    expect(() => formatRegisterNumber(value)).toThrow(RangeError);
  });
});

describe('validateSymbolPattern (BR-DOC-03, BR-DOC-05)', () => {
  it.each(['{number}/QD-{agency}', '{number}/{type}-{agency}', '{number}/{agency}-{unit}'])('accepts %s', (pattern) => {
    expect(codeOf(() => validateSymbolPattern(pattern))).toBeUndefined();
  });

  it.each([
    ['QD-{agency}', 'no number token'],
    ['{number}/{number}-{agency}', 'two number tokens'],
    ['{number}/{other}-{agency}', 'unknown token'],
    ['{number}a/QD-{agency}', 'letter suffix a on the number'],
    ['{number}B/QD-{agency}', 'letter suffix b on the number'],
    ['{number}{type}/QD-{agency}', 'a token right behind the number, which could add a suffix'],
    ['{number}{agency}', 'a token right behind the number'],
    ['{number}đ/QD-{agency}', 'a non-ASCII letter suffix on the number'],
    ['{number}/QD-{agency', 'unbalanced brace'],
    ['', 'empty'],
    ['{number}/' + 'X'.repeat(200), 'longer than 200 characters'],
    ['{number}/QD\n{agency}', 'control character'],
  ])('rejects %s (%s) with SYMBOL_PATTERN_INVALID', (pattern) => {
    expect(codeOf(() => validateSymbolPattern(pattern))).toBe('SYMBOL_PATTERN_INVALID');
  });
});

describe('buildSymbol (suffix bypass)', () => {
  it('never lets a substituted value become a suffix of the number', () => {
    expect(codeOf(() => buildSymbol('{number}{type}/QD-{agency}', { number: 12, type: 'a', agency: 'UBND' }))).toBe('SYMBOL_PATTERN_INVALID');
    expect(buildSymbol('{number}/{type}-{agency}', { number: 12, type: 'a', agency: 'UBND' })).toBe('12/a-UBND');
  });
});

describe('buildSymbol', () => {
  it('pads numbers below ten to two digits', () => {
    expect(buildSymbol('{number}/QD-{agency}', { number: 5, agency: 'UBND' })).toBe('05/QD-UBND');
  });

  it('keeps larger numbers as they are and fills every token', () => {
    expect(buildSymbol('{number}/{agency}-{unit}', { number: 678, agency: 'SKHDT', unit: 'QLDT' })).toBe('678/SKHDT-QLDT');
    expect(buildSymbol('{number}/{type}-{agency}', { number: 45, type: 'TTr', agency: 'SKHDT' })).toBe('45/TTr-SKHDT');
  });

  it('keeps Vietnamese abbreviations exactly', () => {
    expect(buildSymbol('{number}/{type}-{agency}', { number: 12, type: 'BC', agency: 'UBND' })).toBe('12/BC-UBND');
    expect(buildSymbol('{number}/QĐ-{agency}', { number: 3, agency: 'SKHĐT' })).toBe('03/QĐ-SKHĐT');
  });

  it('refuses a token without a value with SYMBOL_FORMAT_INVALID', () => {
    expect(codeOf(() => buildSymbol('{number}/{type}-{agency}', { number: 1, agency: 'UBND' }))).toBe('SYMBOL_FORMAT_INVALID');
  });

  it('refuses a value that carries a slash, a space or a brace', () => {
    expect(codeOf(() => buildSymbol('{number}/QD-{agency}', { number: 1, agency: 'U/BND' }))).toBe('SYMBOL_FORMAT_INVALID');
    expect(codeOf(() => buildSymbol('{number}/QD-{agency}', { number: 1, agency: 'U BND' }))).toBe('SYMBOL_FORMAT_INVALID');
    expect(codeOf(() => buildSymbol('{number}/QD-{agency}', { number: 1, agency: '{unit}' }))).toBe('SYMBOL_FORMAT_INVALID');
  });

  it('validates the pattern first', () => {
    expect(codeOf(() => buildSymbol('QD-{agency}', { number: 1, agency: 'UBND' }))).toBe('SYMBOL_PATTERN_INVALID');
  });
});

describe('Vietnam calendar (BR-DOC-02: Asia/Ho_Chi_Minh, UTC+7 without daylight saving)', () => {
  it('starts a new year at 00:00 on 1 January Vietnam time', () => {
    expect(vietnamYearOf(new Date('2026-12-31T16:59:59.999Z'))).toBe(2026);
    expect(vietnamYearOf(new Date('2026-12-31T17:00:00.000Z'))).toBe(2027);
    expect(vietnamDateOf(new Date('2026-12-31T17:00:10.000Z'))).toBe('2027-01-01');
    expect(vietnamDateOf(new Date('2026-12-31T16:59:59.999Z'))).toBe('2026-12-31');
  });

  it('writes the moment of a signature as ISO 8601 in the zone of Vietnam (BR-DOC-13)', () => {
    expect(signingTimeText(new Date('2026-10-22T02:15:30.900Z'))).toBe('2026-10-22T09:15:30+07:00');
    expect(signingTimeText(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01T00:00:00+07:00');
  });

  it('is independent of the process time zone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Honolulu';
      expect(vietnamDateOf(new Date('2027-03-01T20:00:00Z'))).toBe('2027-03-02');
      process.env.TZ = 'Asia/Tokyo';
      expect(vietnamDateOf(new Date('2027-03-01T20:00:00Z'))).toBe('2027-03-02');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('rejects an invalid date', () => {
    expect(() => vietnamDateOf(new Date(Number.NaN))).toThrow(RangeError);
  });
});
