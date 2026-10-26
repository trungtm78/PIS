import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { rejectReasonLabel, reportProblemMessage, reportStatusLabel } from './labels';
import { REJECT_CODES, REPORT_STATUSES } from './model';
import type { ReportProblem } from './model';

const PROBLEMS: ReportProblem[] = [
  'exists',
  'engagementState',
  'conclusionReplaced',
  'templateMissing',
  'providerUnavailable',
  'openRecommendations',
  'reportMissing',
  'versionConflict',
  'scopeDenied',
  'validation',
  'notFound',
  'general',
];

describe('the words of the screen of the report and the closure (UI-AUD-10)', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`name every status, reason of DOC and refusal in ${locale}, each differently`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      const distinct = (values: string[]): void => expect(new Set(values).size).toBe(values.length);
      distinct(REPORT_STATUSES.map((status) => reportStatusLabel(t, status)));
      distinct([...REJECT_CODES.map((code) => rejectReasonLabel(t, code)), rejectReasonLabel(t, 'SOURCE_WITHDRAWN')]);
      distinct(PROBLEMS.map((problem) => reportProblemMessage(t, problem, 3)));
    });

    it(`says how many recommendations are open in ${locale}, and none when the server did not say`, () => {
      const { t } = createTranslator({ locale, catalogues: { vi: vi_, en }, strict: true });
      expect(reportProblemMessage(t, 'openRecommendations', 3)).toContain('3');
      expect(reportProblemMessage(t, 'openRecommendations')).toContain('0');
    });
  }
});
