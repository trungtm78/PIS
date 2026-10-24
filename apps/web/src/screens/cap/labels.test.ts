import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { categoryLabel, fieldProblemMessage, levelLabel, originLabel, problemMessage, statusLabel } from './labels';
import { CATEGORIES, ORIGINS } from './model';
import type { AppropriationStatus, FieldProblem, ProblemReason } from './model';

const STATUSES: AppropriationStatus[] = ['DRAFT', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED'];
const FIELD_PROBLEMS: FieldProblem[] = ['required', 'invalidYear', 'invalidAmount', 'invalidId', 'invalidDate', 'tooShort', 'tooLong', 'sourceYear'];
const REASONS: ProblemReason[] = [
  'belowAllocated',
  'decisionRequired',
  'extensionRequired',
  'duplicate',
  'revisionPending',
  'selfApproval',
  'versionConflict',
  'stateInvalid',
  'yearLocked',
  'masterNotEffective',
  'subsetSource',
  'notAllowed',
  'validation',
  'notFound',
  'denied',
  'general',
];

describe('the words of the appropriation screens', () => {
  it('has a distinct sentence in both languages for every origin, level, status, category, field problem and refusal', () => {
    const words = [
      ...ORIGINS.map((origin) => originLabel(t, origin)),
      levelLabel(t, 'CENTRAL'),
      levelLabel(t, 'LOCAL'),
      ...STATUSES.map((status) => statusLabel(t, status)),
      ...CATEGORIES.map((category) => categoryLabel(t, category)),
      ...FIELD_PROBLEMS.map((problem) => fieldProblemMessage(t, problem)),
      ...REASONS.map((reason) => problemMessage(t, { reason, field: undefined })),
      problemMessage(t, { reason: 'masterNotEffective', field: 'fund_source_version_id' }),
      problemMessage(t, { reason: 'validation', field: 'amount_vnd' }),
    ];
    expect(words.every((word) => word.length > 0 && !word.startsWith('cap.'))).toBe(true);
    expect(new Set(words).size).toBe(words.length);
    expect(problemMessage(t, { reason: 'validation', field: 'amount_vnd' })).toContain('amount_vnd');
    expect(problemMessage(t, { reason: 'masterNotEffective', field: 'fund_source_version_id' })).toContain('fund_source_version_id');
  });
});
