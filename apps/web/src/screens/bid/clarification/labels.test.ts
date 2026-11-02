import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { formProblemMessage, problemMessage, statusLabel, statusTone } from './labels';
import { CLARIFICATION_STATUSES } from './model';
import type { FormProblem, Problem } from './model';

const t = (key: string): string => (vi_ as Record<string, string>)[key] ?? `missing:${key}`;

describe('the words of the clarification requests', () => {
  it('has a different word for every status, and a tone that tells good news from a failure', () => {
    const words = CLARIFICATION_STATUSES.map((status) => statusLabel(t, status));
    expect(words.join()).not.toContain('missing:');
    expect(new Set(words).size).toBe(CLARIFICATION_STATUSES.length);
    expect(statusTone('ANSWERED')).toBe('ok');
    expect(statusTone('EXPIRED')).toBe('danger');
    expect(statusTone('SENT')).toBe('warning');
    expect(statusTone('DRAFT')).toBe('warning');
  });

  it('has a sentence for every problem of a field and every refusal of the server', () => {
    const fields: FormProblem[] = ['required', 'uuid', 'tooShort', 'tooLong', 'moment', 'past'];
    const refusals: Problem[] = ['dueInPast', 'proposalNotOpen', 'undeclared', 'expired', 'answered', 'versionConflict', 'documentUsed', 'validation', 'notFound', 'denied', 'session', 'general'];
    const fieldWords = fields.map((problem) => formProblemMessage(t, problem));
    const refusalWords = refusals.map((problem) => problemMessage(t, problem));
    expect([...fieldWords, ...refusalWords].join()).not.toContain('missing:');
    expect(new Set(fieldWords).size).toBe(fields.length);
    expect(new Set(refusalWords).size).toBe(refusals.length);
  });
});
