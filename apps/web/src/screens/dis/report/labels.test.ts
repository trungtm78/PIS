import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { basisLabel, cellLabel, cellProblemMessage, findingMessage, formProblemMessage, reportProblemMessage, reportStatusLabel, stepLabel, volumeProblemMessage } from './labels';
import { BASES, CELLS, REPORT_STATUSES } from './model';
import type { CellProblem, FormProblem, ReportProblem } from './model';
import { STEPS } from './step-model';
import type { VolumeProblem } from './step-model';

const CELL_PROBLEMS: CellProblem[] = ['required', 'invalid', 'exceeds', 'notAllowed'];
const FORM_PROBLEMS: FormProblem[] = ['tooShort', 'tooLong', 'invalid'];
const VOLUME_PROBLEMS: VolumeProblem[] = ['required', 'invalid', 'range'];
const PROBLEMS: ReportProblem[] = [
  'draftExists',
  'reportExists',
  'periodLocked',
  'planNotEffective',
  'stageInvalid',
  'subsetExceeds',
  'immutable',
  'versionConflict',
  'scopeDenied',
  'validation',
  'notFound',
  'fileInfected',
  'fileType',
  'fileTooLarge',
  'scanPending',
  'hashMismatch',
  'general',
];
const finding = (code: string, field: string, values: Record<string, string | null> = {}) => ({ code, field, values });
const FINDINGS = [
  finding('REVISION_IMMUTABLE', 'status'),
  finding('PERIOD_LOCKED', 'period'),
  finding('PLAN_VERSION_NOT_EFFECTIVE', 'plan_version'),
  finding('SUBSET_EXCEEDS_PARENT', 'funding_lines[0].ctmtqg_subset_vnd', { parent_vnd: '100', subset_vnd: '120' }),
  finding('SUBSET_EXCEEDS_PARENT', 'funding_lines[0].next_month_ctmtqg_subset_vnd', { parent_vnd: '100', subset_vnd: '120' }),
  finding('NEGATIVE_DELTA_EXPLANATION_REQUIRED', 'negative_delta_explanation'),
  finding('VALIDATION_FAILED', 'progress'),
  finding('VOLUME_EXCEEDS_ALLOCATION', 'progress.construction_vnd', { construction_vnd: '2038000000', allocated_vnd: '1000000000', ratio_pct: '203.8' }),
  finding('VOLUME_EXCEEDS_ALLOCATION', 'progress.construction_vnd', { construction_vnd: '5', allocated_vnd: '0', ratio_pct: null }),
  finding('TREASURY_GAP', 'funding_lines', { reported_vnd: '1000', treasury_vnd: '900', gap_pct: '11.1' }),
  finding('TREASURY_GAP', 'funding_lines', { reported_vnd: '1000', treasury_vnd: '0', gap_pct: null }),
  finding('NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT', 'funding_lines', { remaining_vnd: '80000000' }),
  finding('SOMETHING_NEW', 'x'),
];

describe('the words of the screens of the weekly report (UI-DIS-01, UI-DIS-04, UI-DIS-06)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every status, cell, basis, step and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(REPORT_STATUSES.map((status) => reportStatusLabel(t, status)));
      distinct(CELLS.map((cell) => cellLabel(t, cell)));
      distinct(BASES.map((basis) => basisLabel(t, basis)));
      distinct(CELL_PROBLEMS.map((problem) => cellProblemMessage(t, problem)));
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(VOLUME_PROBLEMS.map((problem) => volumeProblemMessage(t, problem)));
      distinct(PROBLEMS.map((problem) => reportProblemMessage(t, problem)));
      distinct(STEPS.map((step) => stepLabel(t, step.key)));
    });

    it(`write every finding of the review in ${locale} with its figures and no placeholder left`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const messages = FINDINGS.map((entry) => findingMessage(t, entry));
      expect(new Set(messages).size).toBe(messages.length);
      for (const message of messages) expect(message).not.toMatch(/[{}]/);
    });
  }

  it('names the cells as the paper form does', () => {
    const { t } = createTranslator({ locale: 'vi', catalogues: { vi: vi_, en }, strict: true });
    expect(CELLS.map((cell) => cellLabel(t, cell))).toEqual(['Vốn năm NSTW', 'Vốn năm NSĐP', 'Kéo dài NSTW', 'Kéo dài NSĐP', 'Vốn khác NSTW', 'Vốn khác NSĐP']);
  });

  it('writes the figures of a finding with dots, the cell it is about, and the percent', () => {
    const { t } = createTranslator({ locale: 'vi', catalogues: { vi: vi_, en }, strict: true });
    expect(findingMessage(t, FINDINGS[3] as never)).toBe('CTMTQG 120 đồng lớn hơn 100 đồng của ô Vốn năm NSTW.');
    expect(findingMessage(t, FINDINGS[7] as never)).toBe('Khối lượng thi công 2.038.000.000 đồng bằng 203.8% vốn đã giao (1.000.000.000 đồng).');
    expect(findingMessage(t, FINDINGS[11] as never)).toContain('80.000.000 đồng');
    expect(findingMessage(t, FINDINGS[12] as never)).toBe('Mã SOMETHING_NEW.');
  });
});
