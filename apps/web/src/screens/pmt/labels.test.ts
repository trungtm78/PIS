import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import vi_ from '../../i18n/vi.json';
import en_ from '../../i18n/en.json';
import { applicabilityText, categoryLabel, fieldProblemMessage, phaseLabel, problemMessage } from './labels';
import { CATEGORIES } from './model';
import type { FieldProblem, Phase, ProblemReason } from './model';

const PHASES: readonly Phase[] = ['draft', 'scheduled', 'inForce', 'ended'];
const FIELD_PROBLEMS: readonly FieldProblem[] = [
  'required',
  'invalidCode',
  'tooLong',
  'invalidReference',
  'invalidDate',
  'past',
  'untilOrder',
  'laterEnd',
  'invalidNumber',
  'invalidKeys',
  'invalidAmount',
  'amountOrder',
  'rejected',
];
const REASONS: readonly ProblemReason[] = ['overlap', 'inUse', 'legalBasis', 'validation', 'denied', 'notFound', 'general'];

describe('the words of the permit screens', () => {
  it('has a distinct message for every category, phase, field problem and refusal', () => {
    const categories = CATEGORIES.map((category) => categoryLabel(t, category));
    const phases = PHASES.map((phase) => phaseLabel(t, phase));
    const fields = FIELD_PROBLEMS.map((problem) => fieldProblemMessage(t, problem));
    const reasons = REASONS.map((reason) => problemMessage(t, { reason, field: undefined }));
    for (const group of [categories, phases, fields, reasons]) {
      expect(new Set(group).size).toBe(group.length);
      expect(group.every((message) => message !== '' && !message.startsWith('pmt.'))).toBe(true);
    }
  });

  it('keeps the two catalogues in step for every key of the module', () => {
    const keysOf = (catalogue: Record<string, string>): string[] => Object.keys(catalogue).filter((key) => key.startsWith('pmt.')).sort();
    expect(keysOf(en_)).toEqual(keysOf(vi_));
    expect(keysOf(vi_).length).toBeGreaterThan(80);
  });

  it('describes a condition by every part it has, joined, and as every project when it has none', () => {
    expect(applicabilityText(t, { projectGroupKeys: [], workTypes: [], minTotalInvestmentVnd: null, maxTotalInvestmentVnd: null })).toBe(vi_['pmt.type.applies.all.text']);
    expect(applicabilityText(t, { projectGroupKeys: ['A'], workTypes: ['ROAD', 'BRIDGE'], minTotalInvestmentVnd: '1', maxTotalInvestmentVnd: '9' })).toBe(
      'Nhóm dự án: A · Loại công trình: ROAD, BRIDGE · Tổng mức đầu tư từ 1 đồng · Tổng mức đầu tư đến 9 đồng',
    );
  });
});
