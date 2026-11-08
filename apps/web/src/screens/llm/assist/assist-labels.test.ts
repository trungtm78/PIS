import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import type { Locale } from '../../../i18n';
import enAll from '../../../i18n/en.json';
import viAll from '../../../i18n/vi.json';
import { basisHint, basisLabel, basisTone, checkKindLabel, codeText, completenessLabel, completenessNote, completenessTone, configStatusLabel, configStatusTone, decisionLabel, decisionTone, errorText, exceptionStatusLabel, exceptionStatusTone, kindHint, kindLabel, resultTone, reviewByLabel, reviewDetailText, reviewResultLabel, routingNote, runStatusLabel, runStatusTone, scoreStatusLabel, scoreStatusTone, sectionLabel, severityLabel, severityTone, sourceKindLabel, verdictLabel, verdictNote, verdictTone, verificationLabel, weightStateText } from './assist-labels';
import {
  CHECK_KINDS,
  COMPLETENESS,
  CONFIG_STATUSES,
  DECISIONS,
  EXCEPTION_STATUSES,
  FEASIBILITY_SECTIONS,
  KNOWN_CODES,
  PRESENTED_AS,
  REVIEW_BY,
  REVIEW_RESULTS,
  ROUTINGS,
  RUN_KINDS,
  RUN_STATUSES,
  SCORE_STATUSES,
  SEVERITIES,
  SOURCE_KINDS,
  VERDICTS,
  VERIFICATIONS,
  camelKey,
} from './assist-model';

// The keys of the assistant screens are the ones of the catalogues under these heads (the part file they were written in is folded away).
const ASSIST_KEYS = /^llm.(assist|review|evaluation|config|exceptions)./;
const only = (all: object): Record<string, string> => Object.fromEntries(Object.entries(all as Record<string, string>).filter(([key]) => ASSIST_KEYS.test(key)));
const vi = only(viAll);
const en = only(enAll);
const catalogues = { vi: vi as Record<string, string>, en: en as Record<string, string> };

/** A translator that throws for a key neither catalogue holds, so a label of an enumeration without its key fails here. */
const translatorOf = (locale: Locale) => createTranslator({ locale, catalogues, strict: true });

describe.each(['vi', 'en'] as const)('the labels of the assistant in %s', (locale) => {
  const t = translatorOf(locale).t;

  it('names every value of every enumeration of the contract', () => {
    for (const kind of RUN_KINDS) expect([kindLabel(t, kind), kindHint(t, kind)].every((text) => text !== '')).toBe(true);
    for (const kind of SOURCE_KINDS) expect(sourceKindLabel(t, kind)).not.toBe(kind);
    for (const basis of PRESENTED_AS) expect([basisLabel(t, basis), basisHint(t, basis)].every((text) => text !== '')).toBe(true);
    for (const verification of VERIFICATIONS) expect(verificationLabel(t, verification)).not.toBe('');
    for (const status of RUN_STATUSES) expect(runStatusLabel(t, status)).not.toBe('');
    for (const completeness of COMPLETENESS) expect([completenessLabel(t, completeness), completenessNote(t, completeness)].every((text) => text !== '')).toBe(true);
    for (const decision of DECISIONS) expect(decisionLabel(t, decision)).not.toBe('');
    for (const kind of CHECK_KINDS) expect(checkKindLabel(t, kind)).not.toBe('');
    for (const severity of SEVERITIES) expect(severityLabel(t, severity)).not.toBe('');
    for (const result of REVIEW_RESULTS) expect(reviewResultLabel(t, result)).not.toBe('');
    for (const by of REVIEW_BY) expect(reviewByLabel(t, by)).not.toBe('');
    for (const verdict of VERDICTS) expect([verdictLabel(t, verdict), verdictNote(t, verdict)].every((text) => text !== '')).toBe(true);
    for (const status of SCORE_STATUSES) expect(scoreStatusLabel(t, status)).not.toBe('');
    for (const section of FEASIBILITY_SECTIONS) expect(sectionLabel(t, section)).not.toBe(section);
    for (const status of CONFIG_STATUSES) expect(configStatusLabel(t, status)).not.toBe('');
    for (const status of EXCEPTION_STATUSES) expect(exceptionStatusLabel(t, status)).not.toBe('');
    for (const routing of ROUTINGS) expect(routingNote(t, routing)).not.toBe('');
    for (const state of ['COMPLETE', 'SHORT', 'OVER'] as const) expect(weightStateText(t, state, { total: '5' })).not.toBe('');
  });

  it('words every code of a refusal the screens name, and the generic cases', () => {
    for (const code of KNOWN_CODES) expect(codeText(t, code)).not.toContain('llm.assist.error');
    expect(codeText(t, 'SOMETHING_NEW')).toContain('SOMETHING_NEW');
    expect(errorText(t, new ApiError({ status: 422, code: 'BUDGET_EXCEEDED', correlationId: 'c' }))).toBe(codeText(t, 'BUDGET_EXCEEDED'));
    expect(errorText(t, new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c', detail: 'sources' }))).toContain('sources');
    expect(errorText(t, new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c' }))).toBe(t('llm.assist.error.validationFailed'));
    expect(errorText(t, new ApiError({ status: 403, code: 'FORBIDDEN_FOR_NOW', correlationId: 'c' }))).toBe(t('llm.assist.error.scopeDenied'));
    expect(errorText(t, new Error('boom'))).toBe(t('llm.assist.error.unknown'));
  });

  it('words the details of a review item, falling back to the text of the server', () => {
    expect(reviewDetailText(t, 'MISSING:budget|schedule')).toContain('budget, schedule');
    expect(reviewDetailText(t, 'WORDS:5<10')).toContain('5');
    for (const code of ['PATTERN_ABSENT', 'PATTERN_PRESENT', 'NOT_ANSWERED', 'PASS_WITHOUT_EVIDENCE', 'NOT_COMPUTABLE']) expect(reviewDetailText(t, code)).not.toContain('llm.review');
    expect(reviewDetailText(t, 'UNKNOWN_DETAIL')).toBe('UNKNOWN_DETAIL');
  });

  it('keeps the meaning of the five marks of a statement apart from one another', () => {
    const texts = new Set(PRESENTED_AS.map((basis) => basisLabel(t, basis)));
    expect(texts.size).toBe(PRESENTED_AS.length);
  });
});

describe('the tones: a state is never only a colour', () => {
  it('shows only a proven pass as a success, and an unsupported statement as a danger', () => {
    expect(resultTone('PASS')).toBe('success');
    expect(resultTone('UNKNOWN')).toBe('warning');
    expect(resultTone('FAIL')).toBe('danger');
    expect(basisTone('UNSUPPORTED')).toBe('danger');
    expect(basisTone('SOURCE')).toBe('success');
    expect(basisTone('ASSUMPTION')).toBe('warning');
    expect(basisTone('INFERENCE')).toBe('info');
  });

  it('gives each state of the other enumerations a tone', () => {
    expect(completenessTone('FULL')).toBe('success');
    expect(completenessTone('PARTIAL')).toBe('warning');
    expect(completenessTone('NONE')).toBe('danger');
    expect(runStatusTone('COMPLETED')).toBe('success');
    expect(runStatusTone('REFUSED')).toBe('warning');
    expect(runStatusTone('FAILED')).toBe('danger');
    expect(decisionTone('REJECTED')).toBe('neutral');
    expect(decisionTone('ACCEPTED')).toBe('success');
    expect(severityTone('BLOCKER')).toBe('danger');
    expect(severityTone('INFO')).toBe('info');
    expect(verdictTone('READY')).toBe('success');
    expect(verdictTone('NOT_READY')).toBe('danger');
    expect(scoreStatusTone('PROPOSED')).toBe('success');
    expect(scoreStatusTone('OUT_OF_SCALE')).toBe('danger');
    expect(scoreStatusTone('NEEDS_EVIDENCE')).toBe('warning');
    expect(configStatusTone('PUBLISHED')).toBe('success');
    expect(configStatusTone('DRAFT')).toBe('info');
    expect(exceptionStatusTone('APPROVED', true)).toBe('success');
    expect(exceptionStatusTone('APPROVED', false)).toBe('neutral');
    expect(exceptionStatusTone('REJECTED', false)).toBe('danger');
    expect(exceptionStatusTone('REQUESTED', false)).toBe('info');
  });
});

describe('the two parts of the catalogue', () => {
  it('hold the same keys, none of them empty', () => {
    expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(vi)) {
      expect(text.trim(), key).not.toBe('');
      expect((en[key] ?? '').trim(), key).not.toBe('');
    }
  });

  it('use the same placeholders in both languages', () => {
    const holes = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
    for (const [key, text] of Object.entries(vi)) expect(holes(text), key).toEqual(holes(en[key] ?? ''));
  });

  it('keep the keys in the shape of the catalogue: three to five lower camel case segments', () => {
    for (const key of Object.keys(vi)) expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){2,4}$/);
  });

  it('write the Vietnamese part with diacritics', () => {
    const plain = Object.entries(vi).filter(([, text]) => [...text].every((char) => char.charCodeAt(0) < 128) && /[a-z]{4}/.test(text));
    // A handful of texts are codes or example values; every sentence has a letter outside plain ASCII.
    expect(plain.map(([key]) => key)).toEqual([]);
  });

  it('give every enumeration value a key in the family the labels read', () => {
    const families: Record<string, readonly string[]> = {
      'llm.assist.kind': RUN_KINDS,
      'llm.assist.kindHint': RUN_KINDS,
      'llm.assist.sourceKind': SOURCE_KINDS,
      'llm.assist.basis': PRESENTED_AS,
      'llm.assist.basisHint': PRESENTED_AS,
      'llm.assist.verification': VERIFICATIONS,
      'llm.assist.runStatus': RUN_STATUSES,
      'llm.assist.completeness': COMPLETENESS,
      'llm.assist.completenessNote': COMPLETENESS,
      'llm.assist.decision': DECISIONS,
      'llm.assist.checkKind': CHECK_KINDS,
      'llm.assist.severity': SEVERITIES,
      'llm.assist.reviewResult': REVIEW_RESULTS,
      'llm.assist.reviewBy': REVIEW_BY,
      'llm.assist.verdict': VERDICTS,
      'llm.assist.verdictNote': VERDICTS,
      'llm.assist.scoreStatus': SCORE_STATUSES,
      'llm.assist.section': FEASIBILITY_SECTIONS,
      'llm.assist.configStatus': CONFIG_STATUSES,
      'llm.assist.exceptionStatus': EXCEPTION_STATUSES,
      'llm.assist.routing': ROUTINGS,
      'llm.assist.error': KNOWN_CODES,
    };
    for (const [family, values] of Object.entries(families)) for (const value of values) expect(`${family}.${camelKey(value)}` in vi, `${family}.${camelKey(value)}`).toBe(true);
  });
});
