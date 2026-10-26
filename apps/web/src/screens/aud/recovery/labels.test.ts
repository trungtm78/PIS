import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { exceptionKindLabel, recoveryProblemMessage, sourceKindLabel } from './labels';
import { EXCEPTION_KINDS, SOURCE_KINDS } from './model';
import type { RecoveryProblem } from './model';

const PROBLEMS: RecoveryProblem[] = ['exceeds', 'sourceLinked', 'notFinancial', 'evidenceRequired', 'alreadyReversed', 'recommendationState', 'engagementState', 'versionConflict', 'scopeDenied', 'validation', 'notFound', 'general'];

describe('the words of the screens of the ledger (UI-AUD-01, UI-AUD-08)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every source, exception and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(SOURCE_KINDS.map((kind) => sourceKindLabel(t, kind)));
      distinct(EXCEPTION_KINDS.map((kind) => exceptionKindLabel(t, kind)));
      distinct(PROBLEMS.map((problem) => recoveryProblemMessage(t, problem, '20000000')));
    });

    it(`says what is left to recover in dong in ${locale}, and nothing is left when the server did not say`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      expect(recoveryProblemMessage(t, 'exceeds', '20000000')).toContain('20.000.000');
      expect(recoveryProblemMessage(t, 'exceeds')).toContain('0');
    });
  }
});
