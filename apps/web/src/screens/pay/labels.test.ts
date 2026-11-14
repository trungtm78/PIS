import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import vi from '../../i18n/vi.json';
import {
  adapterStatusLabel,
  answerMessage,
  connectorStatusLabel,
  differenceLabel,
  fieldErrorMessage,
  fieldLabel,
  fileErrorMessage,
  missingText,
  importStatusLabel,
  itemStatusLabel,
  outcomeLabel,
  problemMessage,
  rowErrorLabel,
  sourceKindLabel,
} from './labels';
import type { ProblemReason } from './model';

// A translator that answers the key it was given: the test judges which key each case picks, and that both languages have it.
const t = ((key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key}|${JSON.stringify(params)}`)) as unknown as Parameters<typeof outcomeLabel>[0];
const keyOf = (text: string): string => text.split('|')[0] ?? '';
const known = (text: string): void => {
  expect(Object.keys(vi)).toContain(keyOf(text));
  expect(Object.keys(en)).toContain(keyOf(text));
};

describe('the words of the Treasury import screen (UI-PAY-13)', () => {
  it('names the kinds of source, the statuses and the outcomes, each with its own key', () => {
    const labels = [sourceKindLabel(t, 'STATEMENT_FILE'), sourceKindLabel(t, 'EXPORT_FILE'), importStatusLabel(t, 'APPLIED'), importStatusLabel(t, 'PARTIALLY_APPLIED'), itemStatusLabel(t, 'OPEN'), itemStatusLabel(t, 'RESOLVED')];
    labels.forEach(known);
    expect(new Set(labels).size).toBe(labels.length);
    const outcomes = (['NEW', 'DUPLICATE', 'CONFLICT', 'ERROR'] as const).map((outcome) => outcomeLabel(t, outcome));
    outcomes.forEach(known);
    expect(new Set(outcomes).size).toBe(4);
  });

  it('names the verdicts on an adapter and the states of a connector, and shows one it does not know as it came', () => {
    const verdicts = ['PROPOSED', 'VERIFIED', 'MOCK', 'MISSING'].map((status) => adapterStatusLabel(t, status));
    verdicts.forEach(known);
    expect(new Set(verdicts).size).toBe(4);
    expect(adapterStatusLabel(t, 'ODD')).toBe('ODD');
    const states = ['ACTIVE', 'PAUSED', 'FAILED'].map((status) => connectorStatusLabel(t, status));
    states.forEach(known);
    expect(new Set(states).size).toBe(3);
    expect(connectorStatusLabel(t, 'ODD')).toBe('ODD');
  });

  it('gives every reason a row can be quarantined for its own sentence, and the unknown one the code', () => {
    const codes = [
      'MISSING_DOCUMENT_NO',
      'DOCUMENT_NO_INVALID',
      'DOCUMENT_DATE_INVALID',
      'PROJECT_CODE_INVALID',
      'OFFICE_CODE_INVALID',
      'AMOUNT_INVALID',
      'CONFIRMED_AT_INVALID',
      'DIRECTION_INVALID',
      'REFUND_UNSUPPORTED',
      'CROSSWALK_MISSING',
      'CROSSWALK_TARGET_INVALID',
      'PROJECT_NOT_FOUND',
      'BUSINESS_KEY_INVALID',
      'MEASURE_INVALID',
    ];
    const labels = codes.map((code) => rowErrorLabel(t, code));
    labels.forEach(known);
    expect(new Set(labels).size).toBe(codes.length);
    expect(rowErrorLabel(t, 'SOMETHING')).toContain('"code":"SOMETHING"');
    expect(rowErrorLabel(t, null)).toContain('"code":""');
    known(rowErrorLabel(t, 'SOMETHING'));
  });

  it('gives every difference its own sentence, and the unknown one the code', () => {
    const codes = ['DUPLICATE_CONFLICT', 'CROSSWALK_MISSING', 'CROSSWALK_TARGET_INVALID', 'PROJECT_NOT_FOUND'];
    const labels = codes.map((code) => differenceLabel(t, code));
    labels.forEach(known);
    expect(new Set(labels).size).toBe(codes.length);
    expect(differenceLabel(t, 'ODD')).toContain('"code":"ODD"');
    known(differenceLabel(t, 'ODD'));
  });

  it('names every field of a row, and shows an unknown one as it came', () => {
    const fields = ['document_no', 'document_date', 'project_code', 'treasury_office_code', 'amount_vnd', 'confirmed_at', 'direction', 'payee_account'];
    const labels = fields.map((field) => fieldLabel(t, field));
    labels.forEach(known);
    expect(new Set(labels).size).toBe(fields.length);
    expect(fieldLabel(t, 'other')).toBe('other');
  });

  it('tells what an import did in the words of its result, with the figures', () => {
    const counts = { total: 6, new: 3, duplicate: 1, conflict: 1, error: 1 };
    const messages = (['APPLIED', 'PARTIALLY_APPLIED', 'ALREADY_IMPORTED'] as const).map((result) => answerMessage(t, result, counts));
    messages.forEach(known);
    expect(new Set(messages).size).toBe(3);
    expect(messages[1]).toContain('"conflict":1');
  });

  it('says what is wrong with a field and what went wrong with the call, with a sentence for every reason', () => {
    known(fieldErrorMessage(t, 'required'));
    known(fieldErrorMessage(t, 'invalid'));
    expect(fieldErrorMessage(t, 'required')).not.toBe(fieldErrorMessage(t, 'invalid'));
    expect(missingText(t, ['document_no', 'amount_vnd'])).toBe([fieldLabel(t, 'document_no'), fieldLabel(t, 'amount_vnd')].join(', '));
    const file = [fileErrorMessage(t, 'required', []), fileErrorMessage(t, 'layout', ['document_no'])];
    file.forEach(known);
    expect(new Set(file).size).toBe(2);
    expect(file[1]).toContain('"columns"');
    const reasons: ProblemReason[] = ['hashMismatch', 'schemaInvalid', 'fileNotClean', 'scanPending', 'notFound', 'denied', 'connectorStopped', 'validation', 'fileType', 'tooLarge', 'general'];
    const messages = reasons.map((reason) => problemMessage(t, { reason, field: undefined }));
    messages.forEach(known);
    expect(new Set(messages).size).toBe(reasons.length);
    expect(problemMessage(t, { reason: 'validation', field: 'file_sha256' })).toContain('"field":"file_sha256"');
    known(problemMessage(t, { reason: 'validation', field: 'file_sha256' }));
  });
});
