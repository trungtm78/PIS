import { describe, expect, it } from 'vitest';
import { decodeBase64, defaultPeriod, indexLimit, kindWord, periodBody, shortHash, statusWord, vietnamDateTime } from './model';

describe('the model of the report screens', () => {
  it('builds the period the server takes only from a whole period', () => {
    expect(periodBody({ kind: 'MONTH', year: '2026', index: '10', day: '' })).toEqual({ kind: 'MONTH', year: 2026, index: 10 });
    expect(periodBody({ kind: 'MONTH', year: '2026', index: '13', day: '' })).toBeUndefined();
    expect(periodBody({ kind: 'MONTH', year: '2026', index: '', day: '' })).toBeUndefined();
    expect(periodBody({ kind: 'QUARTER', year: '2026', index: '4', day: '' })).toEqual({ kind: 'QUARTER', year: 2026, index: 4 });
    expect(periodBody({ kind: 'QUARTER', year: '2026', index: '5', day: '' })).toBeUndefined();
    expect(periodBody({ kind: 'HALF_YEAR', year: '2026', index: '2', day: '' })).toEqual({ kind: 'HALF_YEAR', year: 2026, index: 2 });
    expect(periodBody({ kind: 'YEAR', year: '2026', index: '', day: '' })).toEqual({ kind: 'YEAR', year: 2026 });
    expect(periodBody({ kind: 'YEAR', year: '26', index: '', day: '' })).toBeUndefined();
    expect(periodBody({ kind: 'AS_OF', year: '2026', index: '', day: '2026-10-18' })).toEqual({ kind: 'AS_OF', year: 2026, day: '2026-10-18' });
    expect(periodBody({ kind: 'AS_OF', year: '2026', index: '', day: '2027-01-02' })).toBeUndefined();
    expect(periodBody({ kind: 'AS_OF', year: '2026', index: '', day: '2026-02-30' })).toBeUndefined();
    expect(periodBody({ kind: 'AS_OF', year: '2026', index: '', day: '18/10/2026' })).toBeUndefined();
  });

  it('opens a form on the period that ended last, across the year end', () => {
    const november = new Date('2026-11-08T03:00:00Z');
    const january = new Date('2027-01-15T03:00:00Z');
    expect(defaultPeriod('MONTH', november)).toMatchObject({ year: '2026', index: '10' });
    expect(defaultPeriod('MONTH', january)).toMatchObject({ year: '2026', index: '12' });
    expect(defaultPeriod('QUARTER', november)).toMatchObject({ year: '2026', index: '3' });
    expect(defaultPeriod('QUARTER', january)).toMatchObject({ year: '2026', index: '4' });
    expect(defaultPeriod('HALF_YEAR', november)).toMatchObject({ year: '2026', index: '1' });
    expect(defaultPeriod('HALF_YEAR', new Date('2026-03-01T00:00:00Z'))).toMatchObject({ year: '2025', index: '2' });
    expect(defaultPeriod('YEAR', november)).toMatchObject({ year: '2025' });
    expect(defaultPeriod('AS_OF', november)).toMatchObject({ year: '2026', day: '2026-11-08' });
  });

  it('names the words of the keys and the sizes of the kinds', () => {
    expect([kindWord('MONTH'), kindWord('HALF_YEAR'), kindWord('AS_OF')]).toEqual(['month', 'halfYear', 'asOf']);
    expect([statusWord('PENDING_EXTERNAL'), statusWord('NOT_A_NUMBER'), statusWord('HPM_PUSH')]).toEqual(['pendingExternal', 'notANumber', 'hpmPush']);
    expect([indexLimit('MONTH'), indexLimit('QUARTER'), indexLimit('HALF_YEAR'), indexLimit('YEAR'), indexLimit('AS_OF')]).toEqual([12, 4, 2, 0, 0]);
  });

  it('keeps both ends of a hash and writes the time of the Vietnam calendar', () => {
    expect(shortHash('0123456789abcdef'.repeat(4))).toBe('0123456789ab…abcdef');
    expect(vietnamDateTime('2026-11-07T20:30:00.000Z')).toBe('08/11/2026 03:30');
    expect(vietnamDateTime(null)).toBe('–');
    expect(vietnamDateTime('not a time')).toBe('–');
  });

  it('decodes base64 into the bytes of the file', () => {
    expect([...decodeBase64(btoa('PK\u0003\u0004'))]).toEqual([0x50, 0x4b, 3, 4]);
  });
});
