import { CODE, arrayOf, codeProblem, numberOf, numberProblem, numberText, oneOf, recordOf, textOf, wholeProblem } from './rule-model';
import type { RuleProblem, RuleProblems } from './rule-model';

/** The pure side of the editor of the scoring policy (PWF-10): how the scores of the tasks of a person are gathered into the score of the period, who is rated and who is not, the bands, the calibration and the response window. */

export const POLICY_RULE_TYPE = 'STAFF_SCORING_POLICY';
export const DEFAULT_POLICY_CODE = 'DEFAULT';

export const PERIOD_KINDS = ['MONTH', 'QUARTER', 'YEAR'] as const;
export const CANCEL_CHOICES = ['COUNT_AS_MISSED', 'IGNORE'] as const;
export const ROLES = ['RESPONSIBLE', 'ACCOUNTABLE', 'CONSULTED', 'INFORMED'] as const;
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export const MAX_BANDS = 8;
export const MIN_BANDS = 2;

export interface BandRow {
  code: string;
  minScore: string;
}

export interface PolicyForm {
  periodKind: (typeof PERIOD_KINDS)[number];
  roleFactors: Record<(typeof ROLES)[number], string>;
  priorityWeights: Record<(typeof PRIORITIES)[number], string>;
  weightByPlannedDays: boolean;
  cancelledUnapproved: (typeof CANCEL_CHOICES)[number];
  minRatedTasks: string;
  minEffectiveWeight: string;
  bands: BandRow[];
  maxAdjustment: string;
  minReason: string;
  secondApprover: boolean;
  responseWindow: string;
  retention: string;
}

export const blankForm = (): PolicyForm => ({
  periodKind: 'QUARTER',
  roleFactors: { RESPONSIBLE: '', ACCOUNTABLE: '', CONSULTED: '', INFORMED: '' },
  priorityWeights: { LOW: '', NORMAL: '', HIGH: '', CRITICAL: '' },
  weightByPlannedDays: true,
  cancelledUnapproved: 'COUNT_AS_MISSED',
  minRatedTasks: '',
  minEffectiveWeight: '',
  bands: [
    { code: '', minScore: '' },
    { code: '', minScore: '0' },
  ],
  maxAdjustment: '',
  minReason: '',
  secondApprover: true,
  responseWindow: '',
  retention: '',
});

export function formOf(params: unknown): PolicyForm {
  const raw = recordOf(params);
  const roles = recordOf(raw.role_factors);
  const priorities = recordOf(raw.priority_weights);
  const calibration = recordOf(raw.calibration);
  const bands = arrayOf(raw.bands).map((band): BandRow => ({ code: textOf(recordOf(band).code), minScore: numberText(recordOf(band).min_score) }));
  return {
    periodKind: oneOf(PERIOD_KINDS, raw.period_kind, 'QUARTER'),
    roleFactors: { RESPONSIBLE: numberText(roles.RESPONSIBLE), ACCOUNTABLE: numberText(roles.ACCOUNTABLE), CONSULTED: numberText(roles.CONSULTED), INFORMED: numberText(roles.INFORMED) },
    priorityWeights: { LOW: numberText(priorities.LOW), NORMAL: numberText(priorities.NORMAL), HIGH: numberText(priorities.HIGH), CRITICAL: numberText(priorities.CRITICAL) },
    weightByPlannedDays: raw.weight_by_planned_days !== false,
    cancelledUnapproved: oneOf(CANCEL_CHOICES, raw.cancelled_unapproved, 'COUNT_AS_MISSED'),
    minRatedTasks: numberText(raw.min_rated_tasks),
    minEffectiveWeight: numberText(raw.min_effective_weight),
    bands: bands.length === 0 ? blankForm().bands : bands,
    maxAdjustment: numberText(calibration.max_adjustment_points),
    minReason: numberText(calibration.min_reason_length),
    secondApprover: calibration.requires_second_approver !== false,
    responseWindow: numberText(raw.response_window_days),
    retention: numberText(raw.retention_months),
  };
}

const numbers = <K extends string>(values: Record<K, string>): Record<K, number> => Object.fromEntries(Object.entries<string>(values).map(([key, value]) => [key, numberOf(value)])) as Record<K, number>;

/** The params the rule store keeps; call it only for a form with no problem. */
export function paramsOf(form: PolicyForm): Record<string, unknown> {
  return {
    period_kind: form.periodKind,
    role_factors: numbers(form.roleFactors),
    priority_weights: numbers(form.priorityWeights),
    weight_by_planned_days: form.weightByPlannedDays,
    cancelled_unapproved: form.cancelledUnapproved,
    min_rated_tasks: Number(form.minRatedTasks),
    min_effective_weight: numberOf(form.minEffectiveWeight),
    bands: form.bands.map((band) => ({ code: band.code.trim(), min_score: numberOf(band.minScore) })),
    calibration: { max_adjustment_points: Number(form.maxAdjustment), min_reason_length: Number(form.minReason), requires_second_approver: form.secondApprover },
    response_window_days: Number(form.responseWindow),
    retention_months: Number(form.retention),
  };
}

export const addBand = (form: PolicyForm): PolicyForm => (form.bands.length >= MAX_BANDS ? form : { ...form, bands: [...form.bands.slice(0, -1), { code: '', minScore: '' }, ...form.bands.slice(-1)] });
export const removeBand = (form: PolicyForm, index: number): PolicyForm => (form.bands.length <= MIN_BANDS ? form : { ...form, bands: form.bands.filter((_, at) => at !== index) });
export const updateBand = (form: PolicyForm, index: number, patch: Partial<BandRow>): PolicyForm => ({ ...form, bands: form.bands.map((band, at) => (at === index ? { ...band, ...patch } : band)) });

/** What can be found wrong before the form is sent (the same limits the rule type states; the server judges again). */
export function problemsOf(form: PolicyForm): RuleProblems {
  const out: RuleProblem[] = [];
  const push = (problem: RuleProblem | undefined): void => {
    if (problem !== undefined) out.push(problem);
  };
  for (const role of ROLES) push(numberProblem(`role_factors.${role}`, form.roleFactors[role], 0, 1));
  for (const priority of PRIORITIES) push(numberProblem(`priority_weights.${priority}`, form.priorityWeights[priority], 0.1, 10));
  push(wholeProblem('min_rated_tasks', form.minRatedTasks, 1, 100));
  push(numberProblem('min_effective_weight', form.minEffectiveWeight, 0, 1000));
  push(wholeProblem('calibration.max_adjustment_points', form.maxAdjustment, 0, 30));
  push(wholeProblem('calibration.min_reason_length', form.minReason, 20, 500));
  push(wholeProblem('response_window_days', form.responseWindow, 1, 60));
  push(wholeProblem('retention_months', form.retention, 12, 120));
  if (form.bands.length < MIN_BANDS || form.bands.length > MAX_BANDS) out.push({ path: 'bands', kind: 'listSize', min: MIN_BANDS, max: MAX_BANDS });
  const seen = new Set<string>();
  form.bands.forEach((band, at) => {
    const code = band.code.trim();
    push(codeProblem(`bands[${at}].code`, band.code));
    if (code !== '' && CODE.test(code)) {
      if (seen.has(code)) out.push({ path: `bands[${at}].code`, kind: 'duplicate' });
      seen.add(code);
    }
    push(numberProblem(`bands[${at}].min_score`, band.minScore, 0, 100));
    const before = form.bands[at - 1];
    if (before !== undefined && numberProblem('x', band.minScore, 0, 100) === undefined && numberProblem('x', before.minScore, 0, 100) === undefined && numberOf(band.minScore) >= numberOf(before.minScore)) {
      out.push({ path: `bands[${at}].min_score`, kind: 'order' });
    }
  });
  // Every score has a band: the last one starts at 0.
  const last = form.bands[form.bands.length - 1];
  if (last !== undefined && numberProblem('x', last.minScore, 0, 100) === undefined && numberOf(last.minScore) !== 0 && !out.some((one) => one.path === `bands[${form.bands.length - 1}].min_score`)) {
    out.push({ path: `bands[${form.bands.length - 1}].min_score`, kind: 'lastBand' });
  }
  return out;
}
