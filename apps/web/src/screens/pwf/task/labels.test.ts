import { describe, expect, it } from 'vitest';
import { text } from '../test/fixtures';
import { exceptionStatusWord, historyWord, kpiFormula, kpiStateWord } from './labels';

const t = (key: string, params?: Record<string, string | number>) => text(key, params);

describe('PWF-04 words', () => {
  it('has a word for every status of an exception, every state and every operation of a KPI result', () => {
    const words = [
      ...(['REQUESTED', 'APPROVED', 'REJECTED', 'USED'] as const).map((one) => exceptionStatusWord(t, one)),
      ...(['OK', 'NOT_APPLICABLE', 'EXCLUDED', 'MISSING_FACT'] as const).map((one) => kpiStateWord(t, one)),
      ...(['DAYS_DEVIATION', 'ON_TIME_RATE', 'AMOUNT_VARIANCE_PCT', 'RETURN_COUNT', 'EVIDENCE_COMPLETENESS', 'RESCHEDULE_COUNT'] as const).map((one) => kpiFormula(t, one)),
    ];
    expect(words.every((word) => word !== '' && !word.startsWith('pwf.'))).toBe(true);
    expect(new Set(words).size).toBe(14);
  });

  it('has a word for each kind of the log it knows and shows any other kind as its code', () => {
    const known = ['START', 'COMPLETE_REQUESTED', 'COMPLETED', 'APPROVED', 'RETURNED', 'PAUSE_APPROVED', 'RESUMED', 'CANCELLED'].map((kind) => historyWord(t, kind));
    expect(known.every((word) => !word.startsWith('pwf.') && !/^[A-Z_]+$/.test(word))).toBe(true);
    expect(new Set(known).size).toBe(8);
    expect(historyWord(t, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
