import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { dossierStatusLabel, permitFieldMessage, permitProblemMessage, permitStatusLabel, remainingText, stepLabel } from './dossier-labels';
import { DOSSIER_STATUSES, MILESTONE_STEPS, PERMIT_STATUSES } from './dossier-model';
import type { FieldProblem, ProblemReason } from './dossier-model';

/** A translator that returns the catalogue text of a key, with `{name}` filled from the parameters. */
const translate = (catalogue: Record<string, string>) => (key: string, params?: Record<string, string | number>): string => {
  const text = catalogue[key];
  if (text === undefined) throw new Error(`no text for ${key}`);
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match));
};

const FIELD_PROBLEMS: FieldProblem[] = ['required', 'invalidDate', 'future', 'past', 'tooLong', 'invalidId', 'dateOrder', 'endOrExpiry', 'scanRequired', 'notAllowed'];
const REASONS: ProblemReason[] = ['stateInvalid', 'versionConflict', 'numberDuplicate', 'alreadyCurrent', 'documentRequired', 'typeNotEffective', 'dossierExists', 'validation', 'denied', 'notFound', 'general'];

describe.each([
  ['vi', vi_ as Record<string, string>],
  ['en', en as Record<string, string>],
])('the labels of PMT-01 and PMT-02 in %s', (_locale, catalogue) => {
  const t = translate(catalogue);

  it('has a distinct word for every permit status, dossier status and milestone step', () => {
    for (const labels of [PERMIT_STATUSES.map((status) => permitStatusLabel(t, status)), DOSSIER_STATUSES.map((status) => dossierStatusLabel(t, status)), MILESTONE_STEPS.map((step) => stepLabel(t, step))]) {
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('has a message for every field problem and every refusal', () => {
    expect(new Set(FIELD_PROBLEMS.map((problem) => permitFieldMessage(t, problem))).size).toBe(FIELD_PROBLEMS.length);
    expect(new Set(REASONS.map((reason) => permitProblemMessage(t, { reason, field: undefined }))).size).toBe(REASONS.length);
  });

  it('says the time left on a permit in days, on its last day, past it, or without an end', () => {
    expect(remainingText(t, 12)).toContain('12');
    expect(remainingText(t, -3)).toContain('3');
    expect(new Set([remainingText(t, 12), remainingText(t, 0), remainingText(t, -3), remainingText(t, null)]).size).toBe(4);
  });
});
