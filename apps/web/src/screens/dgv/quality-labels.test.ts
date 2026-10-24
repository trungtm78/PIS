import { describe, expect, it } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import {
  actionLabel,
  comparatorLabel,
  dimensionLabel,
  durationLabel,
  failureLabel,
  operatorLabel,
  overallLabel,
  qualityProblemMessage,
  resultLabel,
  resultTone,
  ruleErrorLabel,
  ruleProblemMessage,
  ruleStatusLabel,
  runProblemMessage,
  runStatusLabel,
  severityLabel,
  triggerLabel,
} from './quality-labels';
import { ACTIONS, COMPARATORS, DIMENSIONS, OPERATORS, SEVERITIES } from './quality-model';
import type { QualityProblemReason, RuleProblem, RuleResult, RuleStatus, RunStatus, Trigger } from './quality-model';

const make = (catalogue: Record<string, string>) => (key: string, params?: Record<string, string | number>): string => {
  const template = catalogue[key];
  if (template === undefined) throw new Error(`missing key ${key}`);
  return Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), template);
};
const t = make(vi_ as Record<string, string>);
const english = make(en_ as Record<string, string>);

describe('labels of the quality screens', () => {
  it('words every enumeration of the quality model in both languages, each value differently', () => {
    for (const translate of [t, english]) {
      const sets: string[][] = [
        DIMENSIONS.map((item) => dimensionLabel(translate, item)),
        ACTIONS.map((item) => actionLabel(translate, item)),
        SEVERITIES.map((item) => severityLabel(translate, item)),
        COMPARATORS.map((item) => comparatorLabel(translate, item)),
        OPERATORS.map((item) => operatorLabel(translate, item)),
        (['DRAFT', 'APPROVED', 'SUPERSEDED'] as RuleStatus[]).map((item) => ruleStatusLabel(translate, item)),
        (['RUNNING', 'COMPLETED', 'FAILED'] as RunStatus[]).map((item) => runStatusLabel(translate, item)),
        (['SNAPSHOT_FROZEN', 'IMPORT_BATCH', 'SCHEDULE', 'MANUAL'] as Trigger[]).map((item) => triggerLabel(translate, item)),
        (['PASS', 'WARN', 'FAIL', 'ERROR'] as RuleResult[]).map((item) => resultLabel(translate, item)),
        (['PASSED', 'WARNING', 'FAILED'] as const).map((item) => overallLabel(translate, item)),
      ];
      for (const labels of sets) expect(new Set(labels).size).toBe(labels.length);
    }
    expect(DIMENSIONS.map((item) => dimensionLabel(t, item))).toEqual(['Đầy đủ', 'Duy nhất', 'Hợp lệ', 'Nhất quán', 'Kịp thời', 'Chính xác', 'Toàn vẹn']);
  });

  it('colours a rule that could not be measured neutral, never green or red', () => {
    expect(resultTone('ERROR')).toBe('gray');
    expect(resultTone('PASS')).toBe('green');
    expect(resultTone('FAIL')).toBe('red');
    expect(resultTone('WARN')).toBe('warn');
  });

  it('words why a run or a rule could not be measured, and a reason it does not know', () => {
    const codes = ['SNAPSHOT_CHANGED', 'SNAPSHOT_INCOMPLETE', 'SOURCE_NOT_SUPPORTED', 'NO_RULE_MEASURED', 'EXECUTION_FAILED', 'OTHER', null];
    expect(new Set(codes.map((code) => failureLabel(t, code))).size).toBe(6);
    expect(failureLabel(t, null)).toBe(failureLabel(t, 'OTHER'));
    expect(['NO_ROWS_EVALUATED', 'EVALUATION_FAILED', 'OTHER', null].map((code) => ruleErrorLabel(t, code))).toEqual([
      vi_['dgv.quality.ruleError.noRows.text'],
      vi_['dgv.quality.ruleError.evaluationFailed.text'],
      vi_['dgv.quality.ruleError.unknown.text'],
      vi_['dgv.quality.ruleError.unknown.text'],
    ]);
  });

  it('writes a length of time in the unit it fills', () => {
    expect([172_800, 49 * 3600, 5_400, 59].map((seconds) => durationLabel(t, seconds))).toEqual(['2 ngày', '2 ngày', '1 giờ', '59 giây']);
    expect([7_200, 600].map((seconds) => durationLabel(t, seconds))).toEqual(['2 giờ', '10 phút']);
  });

  it('words every field problem and every refusal, each differently', () => {
    const problems: RuleProblem[] = ['required', 'tooShort', 'tooLong', 'invalidNumber', 'invalidRate', 'invalidList', 'warnNotBelowMin'];
    expect(new Set(problems.map((item) => ruleProblemMessage(t, item))).size).toBe(problems.length);
    expect(runProblemMessage(t, 'required')).not.toBe(runProblemMessage(t, 'invalidId'));
    const reasons: QualityProblemReason[] = [
      'expressionNotAllowed',
      'thresholdInvalid',
      'selfApproval',
      'snapshotNotFound',
      'snapshotNotFrozen',
      'alreadyRunning',
      'versionConflict',
      'notDraft',
      'validation',
      'notFound',
      'denied',
      'general',
    ];
    expect(new Set(reasons.map((reason) => qualityProblemMessage(t, { reason, field: undefined }))).size).toBe(reasons.length);
    expect(qualityProblemMessage(t, { reason: 'validation', field: 'title' })).toBe('Dữ liệu nhập chưa hợp lệ ở trường title.');
  });

  it('has every key of the quality screens in both languages (the catalogues stay in step)', () => {
    const keys = Object.keys(vi_).filter((key) => key.startsWith('dgv.'));
    expect(keys.filter((key) => !(key in en_))).toEqual([]);
    expect(Object.keys(en_).filter((key) => key.startsWith('dgv.') && !(key in vi_))).toEqual([]);
  });
});
