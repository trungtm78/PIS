import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { executorKindLabel, fieldProblemMessage, modeLabel, problemMessage, stageLabel, stageStatusLabel } from './labels';
import { EXECUTOR_KINDS, STAGE_CODES, STAGE_MODES, STAGE_STATUSES } from './model';
import type { FieldProblem, Problem } from './model';

const t = (key: string): string => {
  const text = (vi_ as Record<string, string>)[key];
  if (text === undefined) throw new Error(`the key ${key} is not defined`);
  return text;
};

const FIELD_PROBLEMS: FieldProblem[] = ['required', 'count', 'exceeds', 'date', 'order', 'future', 'endNeedsAll', 'evidenceRequired', 'evidenceInvalid', 'tooLong'];
const PROBLEMS: Problem[] = ['exceeds', 'nativeReadonly', 'documentNotClean', 'validation', 'denied', 'notFound', 'session', 'general'];

describe('the words of LND-01 and LND-11 (ST-LND-010)', () => {
  it('has words for every stage, executor, mode and status, each different from the next', () => {
    for (const [list, label] of [
      [STAGE_CODES, stageLabel],
      [EXECUTOR_KINDS, executorKindLabel],
      [STAGE_MODES, modeLabel],
      [STAGE_STATUSES, stageStatusLabel],
    ] as const) {
      const words = (list as readonly string[]).map((code) => (label as (translate: typeof t, value: string) => string)(t, code));
      expect(new Set(words).size).toBe(list.length);
      for (const word of words) expect(word.length).toBeGreaterThan(0);
    }
  });

  it('has a message for every problem of a field and every refusal of the server', () => {
    expect(new Set(FIELD_PROBLEMS.map((problem) => fieldProblemMessage(t, problem))).size).toBe(FIELD_PROBLEMS.length);
    expect(new Set(PROBLEMS.map((problem) => problemMessage(t, problem))).size).toBe(PROBLEMS.length);
  });
});
