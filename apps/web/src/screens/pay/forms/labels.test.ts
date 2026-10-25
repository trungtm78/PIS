import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { formName, formStatusLabel, refusalMessage } from './labels';
import { FORM_CODES } from './model';
import type { FormStatus, Problem } from './model';

const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? `missing:${key}`);

const distinct = (words: string[]): void => {
  expect(new Set(words).size).toBe(words.length);
  expect(words.join()).not.toContain('missing:');
};

describe('the words of the Treasury forms', () => {
  it('has a different word for every status of a form and every form', () => {
    const statuses: FormStatus[] = ['REQUESTED', 'GENERATED', 'FAILED', 'SUPERSEDED'];
    distinct(statuses.map((status) => formStatusLabel(t, status)));
    distinct(FORM_CODES.map((code) => formName(t, code)));
    expect(formName(t, '99/XX')).toBe('99/XX');
  });

  it('has a sentence for every refusal, naming the form or the forms that are lacking', () => {
    const problems: Problem[] = ['unconfirmed', 'notEffective', 'formsMissing', 'paymentState', 'unavailable', 'versionConflict', 'validation', 'notFound', 'denied', 'session', 'general'];
    distinct(problems.map((problem) => refusalMessage(t, { problem, formCode: '05.a/TT', missing: ['04.a/TT', '04.b/TT'] })));
    expect(refusalMessage(t, { problem: 'unconfirmed', formCode: '05.a/TT', missing: [] })).toContain('05.a/TT');
    expect(refusalMessage(t, { problem: 'formsMissing', formCode: null, missing: ['04.a/TT', '04.b/TT'] })).toContain('04.a/TT, 04.b/TT');
  });
});
