import type { KpiOperationEntry } from '../model';
import { CODE, arrayOf, codeList, codeProblem, numberOf, numberProblem, numberText, oneOf, problemAt, recordOf, stringsOf, textOf, wholeProblem } from './rule-model';
import type { RuleProblem, RuleProblems } from './rule-model';

/** The pure side of the editor of a KPI set (PWF-09): a set only picks operations of the closed catalogue and points at the register of KPIs and of RAG lines; it never types a formula (R37). */

export const KPI_SET_RULE_TYPE = 'WORKFLOW_KPI_SET';
export const KPI_DEFINITION_TYPE = 'KPI_DEFINITION';
export const RAG_THRESHOLDS_TYPE = 'RAG_THRESHOLDS';
export const WORKFLOW_TEMPLATE_TYPE = 'PROJECT_WORKFLOW_TEMPLATE';
export const DEFAULT_KPI_SET_CODE = 'DEFAULT_PROJECT_WORKFLOW';

export const OPERATIONS = ['DAYS_DEVIATION', 'ON_TIME_RATE', 'AMOUNT_VARIANCE_PCT', 'RETURN_COUNT', 'EVIDENCE_COMPLETENESS', 'RESCHEDULE_COUNT'] as const;
export type OperationCode = (typeof OPERATIONS)[number];
export const UNIT_CHOICES = ['', 'WORKING', 'CALENDAR'] as const;
export const AGAINST_CHOICES = ['', 'FIRST_BASELINE', 'CURRENT_BASELINE'] as const;
export const KINDS = ['TASK', 'MILESTONE'] as const;
export const MAX_ITEMS = 20;
export const MAX_STEPS = 10;
const BOUND = 1_000_000_000;

export interface StepForm {
  bound: string;
  score: string;
}

export interface ScaleForm {
  kind: 'LINEAR' | 'STEPPED';
  worst: string;
  best: string;
  mode: 'AT_MOST' | 'AT_LEAST';
  steps: StepForm[];
  otherwise: string;
}

export interface ItemForm {
  kpiCode: string;
  operation: OperationCode;
  unit: (typeof UNIT_CHOICES)[number];
  against: (typeof AGAINST_CHOICES)[number];
  grace: string;
  kinds: (typeof KINDS)[number][];
  phases: string;
  tasks: string;
  weight: string;
  scale: ScaleForm;
  ragCode: string;
}

export interface KpiSetForm {
  templateCode: string;
  items: ItemForm[];
}

export const blankScale = (): ScaleForm => ({ kind: 'LINEAR', worst: '', best: '', mode: 'AT_MOST', steps: [{ bound: '', score: '' }], otherwise: '0' });
export const blankItem = (): ItemForm => ({ kpiCode: '', operation: 'DAYS_DEVIATION', unit: '', against: '', grace: '', kinds: [], phases: '', tasks: '', weight: '', scale: blankScale(), ragCode: '' });
export const blankForm = (): KpiSetForm => ({ templateCode: '', items: [blankItem()] });

// ---- reading and writing the params ----------------------------------------------------------------------------------------------------------------------------------

function scaleOf(raw: Record<string, unknown>): ScaleForm {
  if (raw.kind === 'STEPPED') {
    const steps = arrayOf(raw.steps).map((step): StepForm => ({ bound: numberText(recordOf(step).bound), score: numberText(recordOf(step).score) }));
    return { kind: 'STEPPED', worst: '', best: '', mode: oneOf(['AT_MOST', 'AT_LEAST'] as const, raw.mode, 'AT_MOST'), steps: steps.length === 0 ? [{ bound: '', score: '' }] : steps, otherwise: numberText(raw.otherwise_score) };
  }
  return { ...blankScale(), worst: numberText(raw.worst), best: numberText(raw.best) };
}

/** Reads the params of a `WORKFLOW_KPI_SET` rule into the text a form holds; what is not there is left empty. */
export function formOf(params: unknown): KpiSetForm {
  const raw = recordOf(params);
  const items = arrayOf(raw.items).map((entry): ItemForm => {
    const one = recordOf(entry);
    const op = recordOf(one.operation_params);
    const applies = recordOf(one.applies_to);
    return {
      kpiCode: textOf(one.kpi_code),
      operation: oneOf(OPERATIONS, one.operation, 'DAYS_DEVIATION'),
      unit: oneOf(UNIT_CHOICES, op.unit, ''),
      against: oneOf(AGAINST_CHOICES, op.against, ''),
      grace: numberText(op.grace_days),
      kinds: arrayOf(applies.task_kinds).filter((kind): kind is (typeof KINDS)[number] => kind === 'TASK' || kind === 'MILESTONE'),
      phases: stringsOf(applies.phases),
      tasks: stringsOf(applies.tasks),
      weight: numberText(one.weight),
      scale: scaleOf(recordOf(one.scale)),
      ragCode: textOf(one.rag_code),
    };
  });
  return { templateCode: textOf(raw.template_code), items: items.length === 0 ? [blankItem()] : items };
}

function scaleParams(scale: ScaleForm): Record<string, unknown> {
  if (scale.kind === 'LINEAR') return { kind: 'LINEAR', worst: numberOf(scale.worst), best: numberOf(scale.best) };
  return { kind: 'STEPPED', mode: scale.mode, steps: scale.steps.map((step) => ({ bound: numberOf(step.bound), score: numberOf(step.score) })), otherwise_score: numberOf(scale.otherwise) };
}

/** The params the rule store keeps; call it only for a form with no problem. */
export function paramsOf(form: KpiSetForm): Record<string, unknown> {
  return {
    template_code: form.templateCode.trim(),
    items: form.items.map((item) => {
      const operationParams: Record<string, unknown> = {};
      if (item.unit !== '') operationParams.unit = item.unit;
      if (item.against !== '') operationParams.against = item.against;
      if (item.grace.trim() !== '') operationParams.grace_days = Number(item.grace);
      const applies: Record<string, unknown> = {};
      if (item.kinds.length > 0) applies.task_kinds = item.kinds;
      if (codeList(item.phases).length > 0) applies.phases = codeList(item.phases);
      if (codeList(item.tasks).length > 0) applies.tasks = codeList(item.tasks);
      return {
        kpi_code: item.kpiCode.trim(),
        operation: item.operation,
        ...(Object.keys(operationParams).length === 0 ? {} : { operation_params: operationParams }),
        ...(Object.keys(applies).length === 0 ? {} : { applies_to: applies }),
        weight: Number(item.weight),
        scale: scaleParams(item.scale),
        ...(item.ragCode.trim() === '' ? {} : { rag_code: item.ragCode.trim() }),
      };
    }),
  };
}

export const addItem = (form: KpiSetForm): KpiSetForm => (form.items.length >= MAX_ITEMS ? form : { ...form, items: [...form.items, blankItem()] });
export const removeItem = (form: KpiSetForm, index: number): KpiSetForm => ({ ...form, items: form.items.filter((_, at) => at !== index) });
export const updateItem = (form: KpiSetForm, index: number, patch: Partial<ItemForm>): KpiSetForm => ({ ...form, items: form.items.map((item, at) => (at === index ? { ...item, ...patch } : item)) });
export const updateScale = (form: KpiSetForm, index: number, patch: Partial<ScaleForm>): KpiSetForm => updateItem(form, index, { scale: { ...(form.items[index] as ItemForm).scale, ...patch } });

export function addStep(form: KpiSetForm, index: number): KpiSetForm {
  const scale = (form.items[index] as ItemForm).scale;
  return scale.steps.length >= MAX_STEPS ? form : updateScale(form, index, { steps: [...scale.steps, { bound: '', score: '' }] });
}

export const removeStep = (form: KpiSetForm, index: number, step: number): KpiSetForm => {
  const scale = (form.items[index] as ItemForm).scale;
  return scale.steps.length <= 1 ? form : updateScale(form, index, { steps: scale.steps.filter((_, at) => at !== step) });
};

export const updateStep = (form: KpiSetForm, index: number, step: number, patch: Partial<StepForm>): KpiSetForm => {
  const scale = (form.items[index] as ItemForm).scale;
  return updateScale(form, index, { steps: scale.steps.map((one, at) => (at === step ? { ...one, ...patch } : one)) });
};

// ---- the checks ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface References {
  /** The codes of the KPI register, the RAG lines and the workflow templates the tenant knows; undefined when the register could not be read (nothing is then refused for a reference). */
  kpiCodes: readonly string[] | undefined;
  ragCodes: readonly string[] | undefined;
  templateCodes: readonly string[] | undefined;
}

export const NO_REFERENCES: References = { kpiCodes: undefined, ragCodes: undefined, templateCodes: undefined };

const known = (codes: readonly string[] | undefined, code: string): boolean => codes === undefined || codes.includes(code);

function scaleProblems(prefix: string, scale: ScaleForm): RuleProblem[] {
  const out: RuleProblem[] = [];
  const push = (problem: RuleProblem | undefined): void => {
    if (problem !== undefined) out.push(problem);
  };
  if (scale.kind === 'LINEAR') {
    push(numberProblem(`${prefix}.worst`, scale.worst, -BOUND, BOUND));
    push(numberProblem(`${prefix}.best`, scale.best, -BOUND, BOUND));
    if (out.length === 0 && numberOf(scale.worst) === numberOf(scale.best)) out.push({ path: `${prefix}.best`, kind: 'sameValue' });
    return out;
  }
  scale.steps.forEach((step, at) => {
    push(numberProblem(`${prefix}.steps[${at}].bound`, step.bound, -BOUND, BOUND));
    push(numberProblem(`${prefix}.steps[${at}].score`, step.score, 0, 100));
  });
  push(numberProblem(`${prefix}.otherwise`, scale.otherwise, 0, 100));
  // The bounds climb for AT_MOST and fall for AT_LEAST: the first step the value reaches is the one that counts.
  scale.steps.forEach((step, at) => {
    const before = scale.steps[at - 1];
    if (before === undefined || out.some((one) => one.path.startsWith(`${prefix}.steps[${at}].bound`) || one.path.startsWith(`${prefix}.steps[${at - 1}].bound`))) return;
    const rising = numberOf(step.bound) > numberOf(before.bound);
    if (scale.mode === 'AT_MOST' ? !rising : rising || numberOf(step.bound) === numberOf(before.bound)) out.push({ path: `${prefix}.steps[${at}].bound`, kind: 'order' });
  });
  return out;
}

/** What can be found wrong with the form before it is sent; the server judges again, and `governance:check` the references (R37). */
export function problemsOf(form: KpiSetForm, references: References = NO_REFERENCES, operations: readonly KpiOperationEntry[] | undefined = undefined): RuleProblems {
  const out: RuleProblem[] = [];
  const push = (problem: RuleProblem | undefined): void => {
    if (problem !== undefined) out.push(problem);
  };
  push(codeProblem('template_code', form.templateCode));
  if (out.length === 0 && !known(references.templateCodes, form.templateCode.trim())) out.push({ path: 'template_code', kind: 'unknownRef' });
  if (form.items.length < 1 || form.items.length > MAX_ITEMS) out.push({ path: 'items', kind: 'listSize', min: 1, max: MAX_ITEMS });
  const seen = new Set<string>();
  form.items.forEach((item, at) => {
    const prefix = `items[${at}]`;
    const before = out.length;
    push(codeProblem(`${prefix}.kpi_code`, item.kpiCode));
    if (out.length === before) {
      const code = item.kpiCode.trim();
      if (seen.has(code)) out.push({ path: `${prefix}.kpi_code`, kind: 'duplicate' });
      else if (!known(references.kpiCodes, code)) out.push({ path: `${prefix}.kpi_code`, kind: 'unknownRef' });
      seen.add(code);
    }
    if (operations !== undefined && !operations.some((entry) => entry.code === item.operation)) out.push({ path: `${prefix}.operation`, kind: 'unknownRef' });
    push(wholeProblem(`${prefix}.weight`, item.weight, 1, 100));
    push(wholeProblem(`${prefix}.grace`, item.grace, 0, 30, true));
    push(codeProblem(`${prefix}.rag_code`, item.ragCode, true));
    if (item.ragCode.trim() !== '' && !problemAt(out, `${prefix}.rag_code`) && !known(references.ragCodes, item.ragCode.trim())) out.push({ path: `${prefix}.rag_code`, kind: 'unknownRef' });
    codeList(item.phases).forEach((phase) => {
      if (!CODE.test(phase) && !problemAt(out, `${prefix}.phases`)) out.push({ path: `${prefix}.phases`, kind: 'pattern' });
    });
    codeList(item.tasks).forEach((task) => {
      if (!CODE.test(task) && !problemAt(out, `${prefix}.tasks`)) out.push({ path: `${prefix}.tasks`, kind: 'pattern' });
    });
    out.push(...scaleProblems(`${prefix}.scale`, item.scale));
  });
  return out;
}

// ---- the conversion curve ---------------------------------------------------------------------------------------------------------------------------------------------

/** The score of a value on a scale, as the platform converts it (0 to 100 with two decimals); undefined for a scale that cannot be read yet. Tested against the kernel so that the picture never says a different number. */
export function convert(value: number, scale: ScaleForm): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (scale.kind === 'LINEAR') {
    const worst = numberOf(scale.worst);
    const best = numberOf(scale.best);
    if (!Number.isFinite(worst) || !Number.isFinite(best) || worst === best) return undefined;
    return Math.round((Math.min(1, Math.max(0, (value - worst) / (best - worst))) * 100 + Number.EPSILON) * 100) / 100;
  }
  const steps = scale.steps.map((step) => ({ bound: numberOf(step.bound), score: numberOf(step.score) }));
  if (steps.some((step) => !Number.isFinite(step.bound) || !Number.isFinite(step.score))) return undefined;
  const otherwise = numberOf(scale.otherwise);
  if (!Number.isFinite(otherwise)) return undefined;
  const hit = steps.find((step) => (scale.mode === 'AT_MOST' ? value <= step.bound : value >= step.bound));
  return hit === undefined ? otherwise : hit.score;
}

export interface CurvePoint {
  value: number;
  score: number;
}

/** Samples of the curve across the range the scale talks about (a little beyond its ends), for the picture and for the list that says the same in words. */
export function curveOf(scale: ScaleForm, count = 7): CurvePoint[] {
  const ends =
    scale.kind === 'LINEAR'
      ? [numberOf(scale.worst), numberOf(scale.best)]
      : scale.steps.map((step) => numberOf(step.bound));
  if (ends.some((end) => !Number.isFinite(end)) || ends.length === 0) return [];
  const low = Math.min(...ends);
  const high = Math.max(...ends);
  const pad = high === low ? 1 : (high - low) * 0.2;
  const from = low - pad;
  const to = high + pad;
  const points: CurvePoint[] = [];
  for (let at = 0; at < count; at += 1) {
    const value = Math.round((from + ((to - from) * at) / (count - 1)) * 100) / 100;
    const score = convert(value, scale);
    if (score === undefined) return [];
    points.push({ value, score });
  }
  return points;
}

/** The operation of the catalogue an item uses, for the unit and the direction shown next to its scale. */
export const operationOf = (operations: readonly KpiOperationEntry[] | undefined, code: string): KpiOperationEntry | undefined => operations?.find((entry) => entry.code === code);

/** The parameters the catalogue says an operation takes. */
export const paramNames = (entry: KpiOperationEntry | undefined, fallback: readonly string[] = []): readonly string[] => entry?.params.map((param) => param.name) ?? fallback;
