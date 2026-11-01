import { describe, expect, it } from 'vitest';
import { toIncomingLine } from '../incoming/model';
import type { IncomingLine } from '../incoming/model';
import { holds, lettersToHandle, numberOf } from './model';
import { actions, letter } from './test-support';

const line = (n: number, overrides: Record<string, unknown> = {}): IncomingLine => toIncomingLine(letter(n, overrides)) as IncomingLine;
const ME = '00000000-0000-4000-8000-000000000001';

describe('DOC-23 model', () => {
  it('keeps the assigned and the processing letters that are the caller, and no others', () => {
    const lines = [
      line(1),
      line(2, { status: 'PROCESSING', actions: actions({ resolve: true }), assignee: null }),
      line(3, { status: 'REGISTERED' }),
      line(4, { assignee: { user_id: 'x', display_name: 'Khác' }, actions: actions() }),
      line(5, { assignee: { user_id: ME, display_name: 'Tôi' }, actions: actions() }),
    ];
    expect(lettersToHandle(lines, ME).map((entry) => entry.title)).toEqual(['Công văn số 5', 'Công văn số 2', 'Công văn số 1']);
    expect(lettersToHandle(lines, undefined).map((entry) => entry.title)).toEqual(['Công văn số 2', 'Công văn số 1']);
  });

  it('puts the most days late first, then the nearest deadline, a letter with no deadline last, and the newest received first among equals', () => {
    const lines = [
      line(1, { due_on: null }),
      line(2, { due_on: '2026-10-30' }),
      line(3, { due_on: '2026-10-29', overdue_days: 2 }),
      line(4, { due_on: '2026-10-28', overdue_days: 5 }),
      line(5, { due_on: '2026-10-30', received_at: '2026-10-25T09:00:00.000Z' }),
    ];
    expect(lettersToHandle(lines, ME).map((entry) => entry.title)).toEqual(['Công văn số 4', 'Công văn số 3', 'Công văn số 5', 'Công văn số 2', 'Công văn số 1']);
  });

  it('writes the number with its symbol when there is one', () => {
    expect(numberOf({ number: null, symbol: '1/A' })).toBeNull();
    expect(numberOf({ number: 12, symbol: null })).toBe('12');
    expect(numberOf({ number: 12, symbol: '12/REG' })).toBe('12 · 12/REG');
  });

  it('holds a permission, or is not told the permissions yet', () => {
    expect(holds(undefined, 'x')).toBe(true);
    expect(holds(['x'], 'x')).toBe(true);
    expect(holds([], 'x')).toBe(false);
  });
});
