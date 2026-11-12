import { effectiveBody, uuid, version } from '../../../adm/governance/test/fixtures';
import { AS_OF } from '../../test/fixtures';
import type { BandPreview } from '../../model';

export { uuid };

const TYPE = 'DEADLINE_BAND_POLICY';

export const POLICY = { unit: 'WORKING', green_days: 5, yellow_days: 2, red_days: 0, overrides: [], reminder_days: [5, 2, 0, -1], escalate_after_overdue_days: 3 };

/** The rule in force of a source: the policy of the tenant (`source` RULE) or the default of the system (`source` DEFAULT). */
export const bandEffective = (code = 'PROJECT_TASK', over: Record<string, unknown> = {}) => effectiveBody({ rule_type: TYPE, code, params: POLICY, version: 1, source: 'RULE', rule_id: uuid(102), ...over });

export const bandVersion = (n: number, over: Record<string, unknown> = {}) => version(n, { rule_type: TYPE, code: 'PROJECT_TASK', params: POLICY, status: 'APPROVED', phase: 'IN_FORCE', effective_from: '2026-12-01', ...over });

export const bandPreview = (over: Partial<BandPreview> = {}): BandPreview => ({
  unit: 'WORKING',
  thresholds: { green_days: 5, yellow_days: 2, red_days: 0 },
  examples: [
    { remaining_days: 6, band: 'NONE' },
    { remaining_days: 5, band: 'GREEN' },
    { remaining_days: 2, band: 'YELLOW' },
    { remaining_days: 0, band: 'RED' },
    { remaining_days: -1, band: 'RED' },
  ],
  as_of: AS_OF,
  ...over,
});
