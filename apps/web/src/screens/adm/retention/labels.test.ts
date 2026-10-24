import { describe, expect, it } from 'vitest';
import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import { createTranslator } from '../../../i18n';
import { basisLabel, endActionLabel, findingMessage, holdKindLabel, holdScopeLabel, kindLabel, problemMessage, problemOfDraft, statusLabel, statusPill } from './labels';
import type { DraftProblem, EndAction, FindingCode, HoldKind, HoldScopeKind, PolicyStatus, ProblemReason, RetentionBasis } from './model';

const strict = (locale: 'vi' | 'en') => createTranslator({ locale, catalogues: { vi, en }, strict: true }).t;

const DRAFT_PROBLEMS: DraftProblem[] = ['required', 'classUnknown', 'classFormat', 'endAction', 'basis', 'yearsRequired', 'yearsNotAllowed', 'yearsRange', 'legalBasis', 'date'];
const FINDINGS: FindingCode[] = ['CLASS_FORMAT', 'CLASS_UNKNOWN', 'END_ACTION_NOT_ALLOWED', 'BASIS_NOT_ALLOWED', 'YEARS_REQUIRED', 'YEARS_NOT_ALLOWED', 'YEARS_RANGE', 'LEGAL_BASIS_REQUIRED', 'DATE_INVALID', 'DATE_FUTURE', 'BELOW_PLATFORM_BASELINE'];
const REASONS: ProblemReason[] = ['invalid', 'conflict', 'selfApproval', 'notFound', 'denied', 'session', 'general'];
const BASES: RetentionBasis[] = ['FROM_CREATED', 'FROM_CLOSED', 'FROM_CONTRACT_END', 'PERMANENT'];
const ACTIONS: EndAction[] = ['REVIEW_FOR_DESTRUCTION', 'ARCHIVE_TRANSFER', 'AUTO_PURGE_TECHNICAL'];
const STATUSES: PolicyStatus[] = ['Draft', 'Published', 'Superseded'];
const HOLD_KINDS: HoldKind[] = ['INSPECTION', 'AUDIT', 'LITIGATION', 'INVESTIGATION', 'CONTRACT_END'];
const HOLD_SCOPES: HoldScopeKind[] = ['TENANT', 'UNIT', 'PROJECT', 'CONTRACT', 'RESOURCE'];

describe.each(['vi', 'en'] as const)('the words of ADM-12 in %s', (locale) => {
  const t = strict(locale);

  it('has a sentence of its own for every value, and a server finding is worded as the form is', () => {
    const everything = [
      ...DRAFT_PROBLEMS.map((value) => problemOfDraft(t, value)),
      ...FINDINGS.map((value) => findingMessage(t, value)),
      ...REASONS.map((reason) => problemMessage(t, { reason, findings: [] })),
      ...BASES.map((value) => basisLabel(t, value)),
      ...ACTIONS.map((value) => endActionLabel(t, value)),
      ...STATUSES.map((value) => statusLabel(t, value)),
      ...HOLD_KINDS.map((value) => holdKindLabel(t, value)),
      ...HOLD_SCOPES.map((value) => holdScopeLabel(t, value)),
      kindLabel(t, 'BUSINESS'),
      kindLabel(t, 'TECHNICAL'),
      kindLabel(t, undefined),
    ];
    expect(everything.every((text) => text !== '' && !text.startsWith('adm.retention.'))).toBe(true);
    expect(new Set([...BASES.map((value) => basisLabel(t, value))]).size).toBe(BASES.length);
    expect(findingMessage(t, 'END_ACTION_NOT_ALLOWED')).toBe(problemOfDraft(t, 'endAction'));
    expect(findingMessage(t, 'YEARS_NOT_ALLOWED')).toBe(problemOfDraft(t, 'yearsNotAllowed'));
  });
});

describe('statusPill', () => {
  it('makes a draft amber, the version in force plain and a replaced one grey', () => {
    expect(statusPill('Draft')).toBe('pill warn');
    expect(statusPill('Published')).toBe('pill');
    expect(statusPill('Superseded')).toBe('pill gray');
  });
});
