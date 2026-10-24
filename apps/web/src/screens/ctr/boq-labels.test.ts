import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import vi from '../../i18n/vi.json';
import { faultLabel, fieldLabel, fileProblemMessage, importProblemMessage, modeLabel, roundingLabel } from './boq-labels';
import type { FileProblem, ImportMode, ImportProblem, ImportReason, RoundingRule } from './boq-model';

// A translator that answers the key it was given: the test judges which key each case picks, and that both languages have it.
const t = ((key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key}|${JSON.stringify(params)}`)) as unknown as Parameters<typeof roundingLabel>[0];
const keyOf = (text: string): string => text.split('|')[0] ?? '';
const known = (text: string): void => {
  expect(Object.keys(vi)).toContain(keyOf(text));
  expect(Object.keys(en)).toContain(keyOf(text));
};

const problem = (overrides: Partial<ImportProblem>): ImportProblem => ({ reason: 'general', field: undefined, faults: [], faultRows: 0, figures: undefined, duplicateRows: [], ...overrides });

describe('the words of the BOQ screen (UI-CTR-04)', () => {
  it('names every rounding rule and import mode with a key both languages have', () => {
    const rules: RoundingRule[] = ['HALF_UP', 'DOWN', 'UP'];
    const labels = rules.map((rule) => roundingLabel(t, rule));
    labels.forEach(known);
    expect(new Set(labels).size).toBe(3);
    const modes: ImportMode[] = ['REPLACE', 'APPEND'];
    const names = modes.map((mode) => modeLabel(t, mode));
    names.forEach(known);
    expect(new Set(names).size).toBe(2);
  });

  it('names every field of a line, and shows an unknown one as the server named it', () => {
    const fields = ['business_key', 'description', 'unit_code', 'quantity', 'unit_price', 'rounding_rule', 'retention_pct', 'milestone_code', 'milestone_due_on', 'party_contractor_id', 'row'];
    const labels = fields.map((field) => fieldLabel(t, field));
    labels.forEach(known);
    expect(new Set(labels).size).toBe(fields.length);
    expect(fieldLabel(t, 'something_else')).toBe('something_else');
  });

  it('gives each fault of a row its own sentence and the general one to a reason it does not know', () => {
    const reasons = ['notAnObject', 'notAllowed', 'required', 'tooLong', 'invalidText', 'invalidNumber', 'tooPrecise', 'tooLarge', 'invalidRounding', 'invalidPercent', 'invalidDate', 'invalidId', 'duplicateKey', 'amountTooLarge', 'unitUnknown', 'unitChanged', 'partyUnknown'];
    const labels = reasons.map((reason) => faultLabel(t, reason));
    labels.forEach(known);
    expect(new Set(labels).size).toBe(reasons.length);
    expect(faultLabel(t, 'never-heard-of-it')).toBe('ctr.boq.fault.general.error');
  });

  it('says why a file cannot be read, naming the column where there is one', () => {
    const problems: FileProblem[] = ['empty', 'unreadable', 'tooLarge', 'tooMany', 'notCsv', 'unknownColumn', 'missingColumn'];
    const messages = problems.map((item) => fileProblemMessage(t, item, 'unit_code'));
    messages.forEach(known);
    expect(new Set(messages.map(keyOf)).size).toBe(problems.length);
    expect(fileProblemMessage(t, 'unknownColumn', 'unit_code')).toContain('"column":"unit_code"');
    expect(fileProblemMessage(t, 'missingColumn')).toContain('"column":""');
  });

  it('answers every reason an import is refused, with the figures when the server gave them', () => {
    const reasons: ImportReason[] = ['rows', 'totalMismatch', 'duplicate', 'notDraft', 'stateInvalid', 'versionConflict', 'fileNotClean', 'fileType', 'tooLarge', 'validation', 'notFound', 'denied', 'general'];
    const messages = reasons.map((reason) => importProblemMessage(t, problem({ reason, faultRows: 3, duplicateRows: [2, 5] })));
    messages.forEach(known);
    expect(new Set(messages.map(keyOf)).size).toBe(reasons.length);
    expect(importProblemMessage(t, problem({ reason: 'rows', faultRows: 3 }))).toContain('"count":3');
    expect(importProblemMessage(t, problem({ reason: 'duplicate', duplicateRows: [2, 5] }))).toContain('2, 5');
    const figures = { linesTotal: '1200', revisionAmount: '1000', difference: '-200' };
    expect(importProblemMessage(t, problem({ reason: 'totalMismatch', figures }), (amount) => `~${amount}`)).toContain('"lines":"~1200","value":"~1000"');
    expect(importProblemMessage(t, problem({ reason: 'totalMismatch', figures }))).toContain('"lines":"1200"');
    expect(keyOf(importProblemMessage(t, problem({ reason: 'totalMismatch' })))).toBe('ctr.boq.problem.totalMismatchUnknown.error');
    expect(keyOf(importProblemMessage(t, problem({ reason: 'validation', field: 'mode' })))).toBe('ctr.boq.problem.validationField.error');
    expect(keyOf(importProblemMessage(t, problem({ reason: 'validation' })))).toBe('ctr.boq.problem.validation.error');
  });
});
