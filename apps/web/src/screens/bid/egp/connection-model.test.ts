import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { connection, health, neverHealth, rule, staleHealth, unusedConnection } from './test/connection-test-support';
import { dayText, failureCode, failureDetail, isFirstUse, isUnverified, numberText, orderedPositions, recordRows, recordTotal, reasonProblem, sampleKind, severityOf, switchBlock, toConnection, vietnamStamp } from './connection-model';
import type { Connection } from './connection-model';

const typed = (over: Record<string, unknown> = {}): Connection => toConnection(connection(over));

describe('toConnection', () => {
  it('accepts the answer of the API', () => {
    expect(typed().connector_code).toBe('egp.muasamcong');
  });

  it('refuses a wrong shape instead of drawing an empty screen', () => {
    expect(() => toConnection(null)).toThrow('unexpected connection');
    expect(() => toConnection([])).toThrow('unexpected connection');
    expect(() => toConnection({ ...connection(), positions: undefined })).toThrow('unexpected connection');
    expect(() => toConnection({ ...connection(), health: undefined })).toThrow('unexpected connection');
    expect(() => toConnection({ ...connection(), health: { ...health(), rule: null } })).toThrow('unexpected connection');
    expect(() => toConnection({ ...connection(), actions: 'yes' })).toThrow('unexpected connection');
  });
});

describe('time and numbers', () => {
  it('writes an instant in Vietnam time, and leaves an unreadable value as it came', () => {
    expect(vietnamStamp('2026-11-08T03:00:00.000Z')).toBe('08/11/2026 10:00');
    expect(vietnamStamp('2026-11-08T20:30:00.000Z')).toBe('09/11/2026 03:30');
    expect(vietnamStamp('not a time')).toBe('not a time');
    expect(vietnamStamp(null)).toBe('');
  });

  it('writes a day from a day or from an instant', () => {
    expect(dayText('2026-11-08')).toBe('08/11/2026');
    expect(dayText('2026-11-08T20:30:00.000Z')).toBe('09/11/2026');
    expect(dayText(null)).toBe('');
  });

  it('keeps one decimal at most and uses the digits of the locale', () => {
    expect(numberText(26.54, 'en')).toBe('26.5');
    expect(numberText(1200, 'en')).toBe('1,200');
    expect(numberText(1200, 'vi')).toBe('1.200');
  });
});

describe('health', () => {
  it('knows the three severities and nothing else', () => {
    expect(severityOf('URGENT')).toBe('URGENT');
    expect(severityOf('ACTION')).toBe('ACTION');
    expect(severityOf('WATCH')).toBe('WATCH');
    expect(severityOf('LOW')).toBeNull();
    expect(severityOf(null)).toBeNull();
  });

  it('says a rule is unverified by the flag or by its legal status', () => {
    expect(isUnverified(typed({ health: health({ rule: rule({ unverified: true }) }) }))).toBe(true);
    expect(isUnverified(typed({ health: health({ rule: rule({ unverified: false, legal_status: 'UNVERIFIED' }) }) }))).toBe(true);
    expect(isUnverified(typed({ health: health({ rule: rule({ unverified: false, legal_status: 'VERIFIED' }) }) }))).toBe(false);
  });

  it('says a tenant that never used the connection is at its first use, a stale one is not', () => {
    expect(isFirstUse(toConnection(unusedConnection()))).toBe(true);
    expect(isFirstUse(typed({ health: staleHealth() }))).toBe(false);
    expect(isFirstUse(typed({ health: neverHealth(), registered: true }))).toBe(false);
  });
});

describe('what the caller may do', () => {
  it('offers the switch only when the server gives the command and the workspace is not read-only', () => {
    expect(switchBlock(typed(), 'FULL')).toBeNull();
    expect(switchBlock(typed(), undefined)).toBeNull();
    expect(switchBlock(typed(), 'READ_ONLY')).toBe('MODE');
    expect(switchBlock(toConnection(connection({}, { set_state: false })), 'FULL')).toBe('RIGHT');
  });

  it('refuses an empty or short reason and takes one of ten characters after trimming', () => {
    expect(reasonProblem('')).toBe('EMPTY');
    expect(reasonProblem('    ')).toBe('EMPTY');
    expect(reasonProblem('too short')).toBe('SHORT');
    expect(reasonProblem('   123456789   ')).toBe('SHORT');
    expect(reasonProblem('1234567890')).toBeNull();
  });
});

describe('the numbers', () => {
  it('lists the five kinds in order and any other kind after them', () => {
    expect(recordRows({ RESTRICTION: 1, KHLCNT: 5, ZZZ: 2 })).toEqual([
      { kind: 'KHLCNT', count: 5 },
      { kind: 'TBMT', count: 0 },
      { kind: 'RESULT', count: 0 },
      { kind: 'CONTRACTOR', count: 0 },
      { kind: 'RESTRICTION', count: 1 },
      { kind: 'ZZZ', count: 2 },
    ]);
    expect(recordTotal({ KHLCNT: 5, TBMT: 2 })).toBe(7);
    expect(recordTotal({})).toBe(0);
  });

  it('orders the positions by the five kinds', () => {
    const positions = [...typed().positions].reverse();
    expect(orderedPositions(positions).map((position) => position.kind)).toEqual(['KHLCNT', 'TBMT', 'RESULT', 'CONTRACTOR', 'RESTRICTION']);
  });

  it('finds the kind a sample is the sample of', () => {
    expect(sampleKind('SAMPLE_TBMT')).toBe('TBMT');
    expect(sampleKind('API_SPECIFICATION')).toBeNull();
  });
});

describe('a failed command', () => {
  const problem = (code: string, status: number, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

  it('reads the code and the detail of a problem, and nothing from another error', () => {
    expect(failureCode(problem('VERSION_CONFLICT', 409))).toBe('VERSION_CONFLICT');
    expect(failureDetail(problem('VALIDATION_FAILED', 422, 'reason'))).toBe('reason');
    expect(failureDetail(problem('VALIDATION_FAILED', 422))).toBeUndefined();
    expect(failureCode(new Error('x'))).toBeUndefined();
    expect(failureDetail(new Error('x'))).toBeUndefined();
  });
});
