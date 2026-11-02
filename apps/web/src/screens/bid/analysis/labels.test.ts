import { describe, expect, it } from 'vitest';
import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import {
  classificationLabel,
  confidenceLabel,
  evidenceKindLabel,
  failureMessage,
  findingStatusLabel,
  formProblemMessage,
  problemMessage,
  reasonProblemMessage,
  routeLabel,
  runStatusLabel,
  runTone,
  stepLabel,
  stepStateLabel,
} from './labels';
import { CLASSIFICATIONS, CONFIDENCE_TYPES, EVIDENCE_KINDS, FINDING_STATUSES, ROUTES, RUN_STATUSES, STEPS, STEP_STATES } from './model';
import type { FailureKind, FormProblem, Problem, ReasonProblem } from './model';

/** A translator that answers the key it was asked for: a label is the key of the catalogue entry it names, and every key must be in both catalogues. */
const t = (key: string): string => key;
const known = (key: string): boolean => (vi as Record<string, string>)[key] !== undefined && (en as Record<string, string>)[key] !== undefined;

const FAILURES: FailureKind[] = ['routeExhausted', 'noCitation', 'outputInvalid', 'routeNotAllowed', 'costAboveLimit', 'budget', 'killSwitch', 'invalidJson', 'other'];
const FORM_PROBLEMS: FormProblem[] = ['proposal', 'criteria', 'profile', 'cost'];
const REASON_PROBLEMS: ReasonProblem[] = ['tooShort', 'tooLong'];
const PROBLEMS: Problem[] = ['undeclared', 'ocrPending', 'ocrNotRecorded', 'criteriaState', 'profile', 'tools', 'routeNotAllowed', 'budget', 'killSwitch', 'validation', 'notFound', 'state', 'conflict', 'denied', 'session', 'general'];

describe('the labels of the analysis screens', () => {
  it('names every status, step, class, route, signal and kind of evidence by an entry of both catalogues', () => {
    const keys = [
      ...RUN_STATUSES.map((value) => runStatusLabel(t, value)),
      ...FINDING_STATUSES.map((value) => findingStatusLabel(t, value)),
      ...STEPS.map((value) => stepLabel(t, value)),
      ...STEP_STATES.map((value) => stepStateLabel(t, value)),
      ...CLASSIFICATIONS.map((value) => classificationLabel(t, value)),
      ...[...ROUTES, null].map((value) => routeLabel(t, value)),
      ...CONFIDENCE_TYPES.map((value) => confidenceLabel(t, value)),
      ...EVIDENCE_KINDS.map((value) => evidenceKindLabel(t, value)),
      ...FAILURES.map((value) => failureMessage(t, value)),
      ...FORM_PROBLEMS.map((value) => formProblemMessage(t, value)),
      ...REASON_PROBLEMS.map((value) => reasonProblemMessage(t, value)),
      ...PROBLEMS.map((value) => problemMessage(t, value)),
    ];
    expect(keys.every(known)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives a run the look of how it ended', () => {
    expect(RUN_STATUSES.map((status) => runTone(status))).toEqual(['warning', 'warning', 'ok', 'ok', 'danger', 'warning', 'danger']);
  });
});
