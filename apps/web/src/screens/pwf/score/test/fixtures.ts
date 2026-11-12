import { AS_OF, ME, OTHER, uuid } from '../../test/fixtures';
import type { Adjustment, Comparison, Contribution, KpiResultItem, MyScore, PeriodPage, PeriodPreview, ScoreLine, ScoreLineRow, ScorePeriod, ScoreResponse, SignalPage } from '../model';

export { ALL_PERMISSIONS, AS_OF, ME, OTHER, READ_ONLY, refusal, routeOf, serve, text, uuid } from '../../test/fixtures';

export const SCORE_ALL: readonly string[] = ['staff_score.read_own', 'staff_score.read_unit', 'staff_score.read_hr', 'staff_score.manage', 'staff_score.adjust', 'staff_score.approve', 'staff_score.review', 'staff_score.export', 'pwf.read', 'adm.governance.read', 'adm.governance.manage', 'adm.governance.approve'];
export const OWN_ONLY: readonly string[] = ['staff_score.read_own'];
export const UNIT = uuid(60);
export const PERIOD_ID = uuid(5000);
export const LINE_ID = uuid(5100);
export const HASH = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';

export const period = (over: Partial<ScorePeriod> = {}): ScorePeriod => ({
  id: PERIOD_ID,
  scope_unit_id: UNIT,
  period_kind: 'QUARTER',
  period_from: '2026-10-01',
  period_to: '2026-12-31',
  status: 'LOCKED',
  policy_code: 'DEFAULT',
  policy_rule_id: uuid(5200),
  policy_version: 2,
  snapshot_hash: HASH,
  locked_by: OTHER,
  locked_at: '2027-01-05T02:00:00.000Z',
  response_until: '2027-01-15',
  official_at: null,
  supersedes_period_id: null,
  line_count: 3,
  open_response_count: 1,
  version: 4,
  as_of: AS_OF,
  ...over,
});

export const contribution = (n: number, over: Partial<Contribution> = {}): Contribution => ({
  task_code: `T${n}`,
  task_id: uuid(1000 + n),
  name: `Công việc ${n}`,
  fraction: 0.5,
  weight: 2.5,
  score: 82.5,
  spans: [{ role: 'RESPONSIBLE', valid_from: '2026-10-01', valid_to: null, share_pct: 50 }],
  ...over,
});

export const adjustment = (n: number, over: Partial<Adjustment> = {}): Adjustment => ({
  id: uuid(5300 + n),
  line_id: LINE_ID,
  points: 3,
  reason: 'Việc phát sinh ngoài kế hoạch được giao thêm',
  evidence_ref: null,
  status: 'REQUESTED',
  requested_by: uuid(71),
  decided_by: null,
  decided_at: null,
  version: 2,
  ...over,
});

export const response = (n: number, over: Partial<ScoreResponse> = {}): ScoreResponse => ({
  id: uuid(5400 + n),
  line_id: LINE_ID,
  body: 'Tôi đề nghị xem lại việc T2 vì bị trả lại do thiếu hồ sơ của đơn vị khác',
  status: 'OPEN',
  submitted_at: '2027-01-06T03:00:00.000Z',
  handled_by: null,
  handled_at: null,
  conclusion: null,
  approval_instance_id: null,
  ...over,
});

export const line = (over: Partial<ScoreLine> = {}): ScoreLine => ({
  id: LINE_ID,
  period_id: PERIOD_ID,
  membership_id: ME,
  display_name: 'Nguyễn Văn An',
  unit_id_at_period: UNIT,
  score_computed: 82.5,
  score_adjusted: null,
  rating: 'GOOD',
  state: 'RATED',
  rated_task_count: 6,
  effective_weight: 14.5,
  period_status: 'LOCKED',
  contributions: [contribution(1), contribution(2, { task_id: null, name: '', score: 60 })],
  excluded: [{ task_code: 'T9', reason: 'NO_SHARE' }],
  flags: [],
  adjustments: [],
  responses: [],
  basis: { policy_code: 'DEFAULT', policy_version: 2, snapshot_hash: HASH },
  can_request_adjustment: false,
  can_respond: true,
  version: 3,
  as_of: AS_OF,
  ...over,
});

export const myScore = (over: Partial<MyScore> = {}): MyScore => ({ period: period(), line: line(), ...over });

export const row = (n: number, over: Partial<ScoreLineRow> = {}): ScoreLineRow => ({
  id: uuid(5100 + n),
  period_id: PERIOD_ID,
  membership_id: uuid(80 + n),
  display_name: `Người ${n}`,
  unit_id_at_period: UNIT,
  score_computed: 80 - n,
  score_adjusted: null,
  rating: 'GOOD',
  state: 'RATED',
  rated_task_count: 6,
  effective_weight: 12,
  has_adjustment: false,
  has_open_response: false,
  ...over,
});

export const periodPage = (items: ScorePeriod[] = [period()], over: Partial<PeriodPage> = {}): PeriodPage => ({ items, next_cursor: null, total: items.length, as_of: AS_OF, ...over });

export const linePage = (items: ScoreLineRow[], over: Partial<{ next_cursor: string | null; total: number }> = {}) => ({ items, next_cursor: null, total: items.length, as_of: AS_OF, ...over });

export const comparison = (over: Partial<Comparison> = {}): Comparison => ({
  membership_id: ME,
  points: [
    { period_id: uuid(5001), period_from: '2026-07-01', period_to: '2026-09-30', period_status: 'OFFICIAL', score_computed: 70, score_adjusted: null, rating: 'FAIR', state: 'RATED', rated_task_count: 6, effective_weight: 10 },
    { period_id: PERIOD_ID, period_from: '2026-10-01', period_to: '2026-12-31', period_status: 'LOCKED', score_computed: 82.5, score_adjusted: 85.5, rating: 'GOOD', state: 'RATED', rated_task_count: 6, effective_weight: 14.5 },
  ],
  sample_sizes_differ: false,
  as_of: AS_OF,
  ...over,
});

export const preview = (over: Partial<PeriodPreview> = {}): PeriodPreview => ({ period: period({ status: 'DRAFT', snapshot_hash: null, locked_at: null, locked_by: null, response_until: null, open_response_count: 0 }), rated_count: 5, small_sample_count: 1, not_rated_count: 0, signal_count: 2, excluded_task_count: 3, preview_hash: HASH, as_of: AS_OF, ...over });

export const signals = (over: Partial<SignalPage> = {}): SignalPage => ({
  items: [{ membership_id: uuid(81), display_name: 'Người 1', flags: [{ code: 'CANCELLED_SHARE_HIGH', task_codes: ['T4', 'T5'] }] }],
  next_cursor: null,
  as_of: AS_OF,
  ...over,
});

export const kpiResult = (n: number, over: Partial<KpiResultItem> = {}): KpiResultItem => ({
  id: uuid(5500 + n),
  kpi_code: 'PWF_TASK_DEVIATION_DAYS',
  operation: 'DAYS_DEVIATION',
  kpi_set_rule_id: null,
  kpi_set_version: 0,
  state: 'OK',
  value: 2,
  score: 80,
  weight: 40,
  inputs_hash: HASH,
  inputs: { baselineDueFirst: '2026-12-08', actualFinish: '2026-12-10' },
  computed_at: AS_OF,
  supersedes_id: null,
  ...over,
});

export const kpiOperations = () => ({
  items: [
    { code: 'DAYS_DEVIATION', unit: 'DAYS', good_direction: 'LOWER_IS_BETTER', required_facts: ['baselineDueFirst', 'actualFinish'], params: [{ name: 'unit', type: 'string', required: false }, { name: 'against', type: 'string', required: false }] },
    { code: 'ON_TIME_RATE', unit: 'PERCENT', good_direction: 'HIGHER_IS_BETTER', required_facts: ['baselineDueFirst'], params: [{ name: 'grace_days', type: 'integer', required: false }] },
    { code: 'AMOUNT_VARIANCE_PCT', unit: 'PERCENT', good_direction: 'LOWER_IS_BETTER', required_facts: ['estimateVnd', 'actualVnd'], params: [] },
    { code: 'RETURN_COUNT', unit: 'COUNT', good_direction: 'LOWER_IS_BETTER', required_facts: ['returnCount'], params: [] },
    { code: 'EVIDENCE_COMPLETENESS', unit: 'PERCENT', good_direction: 'HIGHER_IS_BETTER', required_facts: ['requiredEvidence', 'providedEvidence'], params: [] },
    { code: 'RESCHEDULE_COUNT', unit: 'COUNT', good_direction: 'LOWER_IS_BETTER', required_facts: ['rescheduleCount'], params: [] },
  ],
  as_of: AS_OF,
});

const KPI_CODES = ['PWF_TASK_DEVIATION_DAYS', 'PWF_ON_TIME_RATE', 'PWF_AMOUNT_VARIANCE_PCT', 'PWF_RETURN_COUNT', 'PWF_EVIDENCE_COMPLETENESS', 'PWF_RESCHEDULE_COUNT'];

/** A catalogue as the rule store answers it, with the registers the editors point at. */
export const catalogue = () => ({
  items: [
    { rule_type: 'KPI_DEFINITION', registered: true, owner_module: 'BI', modules: [], formula: null, source: null, as_of: null, legal_status: null, codes: KPI_CODES.map((code) => ({ code, has_default: true, unverified: true, stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 })) },
    { rule_type: 'RAG_THRESHOLDS', registered: true, owner_module: 'BI', modules: [], formula: null, source: null, as_of: null, legal_status: null, codes: [{ code: 'PWF_SCORE', has_default: true, unverified: true, stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 }] },
    { rule_type: 'PROJECT_WORKFLOW_TEMPLATE', registered: true, owner_module: 'PWF', modules: [], formula: null, source: null, as_of: null, legal_status: null, codes: [{ code: 'PUBLIC_INVESTMENT', has_default: true, unverified: true, stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 }] },
    { rule_type: 'WORKFLOW_KPI_SET', registered: true, owner_module: 'PWF', modules: [], formula: null, source: null, as_of: null, legal_status: null, codes: [{ code: 'DEFAULT_PROJECT_WORKFLOW', has_default: true, unverified: true, stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 }] },
    { rule_type: 'STAFF_SCORING_POLICY', registered: true, owner_module: 'PWF', modules: [], formula: null, source: null, as_of: null, legal_status: null, codes: [{ code: 'DEFAULT', has_default: true, unverified: true, stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 }] },
  ],
});

export const effective = (ruleType: string, code: string, params: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ rule_type: ruleType, code, as_of: '2026-11-12', params, version: 0, source: 'DEFAULT', rule_id: null, unit_id: null, unverified: true, provenance: { formula: 'f', source: 's', as_of: '2026-11-12', legal_status: 'UNVERIFIED' }, ...over });
