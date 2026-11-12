import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { STATUSES, ageParts, healthyLabel, needsReason, parseMappingFields, reasonOk, refusalOf, stageLine, statusTone, tabAfterKey, vietnamDateTime, word } from './model';

describe('the model of the hub screens', () => {
  it('writes the word of a code the way the keys do', () => {
    expect(word('PENDING_EXTERNAL')).toBe('pendingExternal');
    expect(word('CONNECTOR_HUB_STALE')).toBe('connectorHubStale');
    expect(word('HEALTHY')).toBe('healthy');
  });

  it('gives every status a tone, and only a fault is red', () => {
    expect(STATUSES.map((status) => statusTone(status))).toEqual(['success', 'warning', 'danger', 'neutral', 'info', 'neutral']);
  });

  it('moves the selected tab by an arrow key, wraps at the ends, jumps with Home and End, and ignores any other key', () => {
    expect(tabAfterKey('overview', 'ArrowRight')).toBe('runs');
    expect(tabAfterKey('layouts', 'ArrowRight')).toBe('overview');
    expect(tabAfterKey('overview', 'ArrowLeft')).toBe('layouts');
    expect(tabAfterKey('mapping', 'ArrowLeft')).toBe('pipeline');
    expect(tabAfterKey('mapping', 'Home')).toBe('overview');
    expect(tabAfterKey('mapping', 'End')).toBe('layouts');
    expect(tabAfterKey('mapping', 'Enter')).toBeUndefined();
  });

  it('writes the age in hours under two days and in days after, and none for a connector that never succeeded', () => {
    expect(ageParts(10)).toEqual({ value: '10', unit: 'hours' });
    expect(ageParts(47.96)).toEqual({ value: '48', unit: 'hours' });
    expect(ageParts(72)).toEqual({ value: '3', unit: 'days' });
    expect(ageParts(null)).toBeNull();
  });

  it('writes the healthy share as "n of m" or a dash when nothing is monitored', () => {
    const base = { total: 3, monitored: 2, healthy: 1, healthy_percent: 50 } as never;
    expect(healthyLabel(base)).toEqual({ value: '50', of: '1/2' });
    expect(healthyLabel({ total: 3, monitored: 0, healthy: 0, healthy_percent: null } as never)).toEqual({ value: '–', of: '0/3' });
  });

  it('judges a reason by its trimmed length', () => {
    expect(reasonOk('too short')).toBe(false);
    expect(reasonOk('   long enough reason   ')).toBe(true);
  });

  it('reads a refusal and tells a missing reason from other validation faults', () => {
    const error = new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c', detail: 'reason', extensions: { reject_code: 'FORMAT_INVALID' } } as never);
    expect(refusalOf(error)).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason', rejectCode: 'FORMAT_INVALID' });
    expect(needsReason(error)).toBe(true);
    expect(needsReason(new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c', detail: 'enabled', extensions: {} } as never))).toBe(false);
    expect(refusalOf(new Error('x')).code).toBe('UNKNOWN');
  });

  it('accepts only a JSON array of objects as the fields of a mapping', () => {
    expect(parseMappingFields('[{"source":"a","target":"b"}]')).toEqual([{ source: 'a', target: 'b' }]);
    for (const text of ['', 'not json', '[]', '{"a":1}', '[1]', '[[1]]', '[null]']) expect(parseMappingFields(text)).toBeUndefined();
  });

  it('writes a date in the Vietnam time zone and a dash for none', () => {
    expect(vietnamDateTime('2026-11-08T03:00:00.000Z')).toBe('08/11/2026 10:00');
    expect(vietnamDateTime(null)).toBe('–');
    expect(vietnamDateTime('nonsense')).toBe('–');
  });

  it('writes the counts of a run as total, applied and rejected', () => {
    expect(stageLine({ rows_total: 10, rows_applied: 9, rows_rejected: 1 } as never)).toBe('10 / 9 / 1');
    expect(stageLine(null)).toBeNull();
  });
});
