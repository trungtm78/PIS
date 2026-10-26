import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { basisLabel, cellLabel, cellProblemMessage, formProblemMessage, reportProblemMessage, reportStatusLabel } from './labels';
import { BASES, CELLS, REPORT_STATUSES } from './model';
import type { CellProblem, FormProblem, ReportProblem } from './model';

const CELL_PROBLEMS: CellProblem[] = ['required', 'invalid', 'exceeds', 'notAllowed'];
const FORM_PROBLEMS: FormProblem[] = ['tooShort', 'tooLong', 'invalid'];
const PROBLEMS: ReportProblem[] = ['draftExists', 'reportExists', 'periodLocked', 'planNotEffective', 'stageInvalid', 'subsetExceeds', 'immutable', 'versionConflict', 'scopeDenied', 'validation', 'notFound', 'general'];

describe('the words of the screens of the weekly report (UI-DIS-01, UI-DIS-04)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every status, cell, basis and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(REPORT_STATUSES.map((status) => reportStatusLabel(t, status)));
      distinct(CELLS.map((cell) => cellLabel(t, cell)));
      distinct(BASES.map((basis) => basisLabel(t, basis)));
      distinct(CELL_PROBLEMS.map((problem) => cellProblemMessage(t, problem)));
      distinct(FORM_PROBLEMS.map((problem) => formProblemMessage(t, problem)));
      distinct(PROBLEMS.map((problem) => reportProblemMessage(t, problem)));
    });
  }

  it('names the cells as the paper form does', () => {
    const { t } = createTranslator({ locale: 'vi', catalogues: { vi: vi_, en }, strict: true });
    expect(CELLS.map((cell) => cellLabel(t, cell))).toEqual(['Vốn năm NSTW', 'Vốn năm NSĐP', 'Kéo dài NSTW', 'Kéo dài NSĐP', 'Vốn khác NSTW', 'Vốn khác NSĐP']);
  });
});
