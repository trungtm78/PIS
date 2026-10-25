import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { basisLabel, formProblemMessage, problemMessage, statusLabel } from './labels';
import { ASSET_STATUSES, VALUE_BASES } from './model';
import type { FormProblem, Problem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the assets', () => {
  it('has a word for every status and every basis of the value', () => {
    distinct(ASSET_STATUSES.map((status) => statusLabel(t, status)));
    distinct(VALUE_BASES.map((basis) => basisLabel(t, basis)));
  });

  it('has a sentence for every problem of a field', () => {
    const all: FormProblem[] = ['required', 'date', 'uuid', 'tooLong', 'amount', 'future'];
    distinct(all.map((problem) => formProblemMessage(t, problem)));
  });

  it('has a sentence for every refusal, and says what the assets would come to against the value of the contract', () => {
    const all: Problem[] = ['handoverState', 'valueExceeds', 'duplicate', 'assetState', 'handoverNotAccepted', 'notClean', 'versionConflict', 'validation', 'notFound', 'denied', 'session', 'general'];
    distinct(all.map((problem) => problemMessage(t, { problem, detail: undefined }, 'vi')));
    expect(problemMessage(t, { problem: 'valueExceeds', detail: { total: '10000000001', contract: '10000000000' } }, 'vi')).toBe(
      `${vi_['ast.asset.error.valueExceeds']} ${t('ast.asset.error.amounts', { total: new Intl.NumberFormat('vi').format(10000000001n), contract: new Intl.NumberFormat('vi').format(10000000000n) })}`,
    );
  });
});
