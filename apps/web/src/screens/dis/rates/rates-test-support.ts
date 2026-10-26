import { ApiError } from '@machvon/api-client';

export const SNAPSHOT = '00000000-0000-4000-8000-0000000000d1';
export const OTHER_SNAPSHOT = '00000000-0000-4000-8000-0000000000d2';
export const UNIT = '00000000-0000-4000-8000-000000000051';

/** The figures of one row of the answer of the two rates, FX-DIS-004 by default: 600 million over 1 billion given by the Prime Minister and 250 million added, 60% and 48%. */
export const figures = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  projects: 1,
  numerator_disbursed_vnd: '600000000',
  plan_pm_assigned_vnd: '1000000000',
  plan_local_added_vnd: '250000000',
  plan_total_vnd: '1250000000',
  rate_pm_pct: '60.0000',
  rate_total_pct: '48.0000',
  rate_null_reason: null,
  treasury_coverage: 'COMPLETE',
  reported_vnd: '420000000',
  ctmtqg_subset_vnd: '40000000',
  ...over,
});

export const groupRecord = (code: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: `00000000-0000-4000-8000-00000000${code.slice(-4).padStart(4, '0')}`, code, name: `Tên ${code}`, ...figures(), ...over });

export const ratesRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  snapshot_id: SNAPSHOT,
  snapshot_kind: 'PERIOD_CLOSE',
  snapshot_status: 'FROZEN',
  as_of_date: '2027-01-10',
  treasury_cutoff_date: '2027-01-10',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  basis: 'CURRENT_YEAR',
  scope: {},
  legal_confirmation_refs: ['CXN-03'],
  groups: [],
  ...figures(),
  ...over,
});

/** The answer for a query: the groups of the grouped read are those of `groups`, the whole read carries none. */
export const answerFor =
  (whole: Record<string, unknown>, groups: Array<Record<string, unknown>>) =>
  (query: Record<string, unknown>): unknown =>
    query.group_by === undefined ? { ...whole, groups: [] } : { ...whole, groups };

export const notFound = (): ApiError => new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
