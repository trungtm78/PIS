/** A starting scenario of the platform (the shape of the kernel's FIN_DEFAULT_SCENARIOS, which the web reads as data only). */
interface FinScenarioInput {
  code: string;
  label: string;
  deltas: object;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const bool = (value: unknown): boolean => value === true;
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const rec = (value: unknown): Raw => (isRecord(value) ? value : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

/** The route of the workbench of an appraisal (PRJ-24). */
export const workbenchPath = (id: string): string => `/prj/prj-24?appraisal=${id}`;
export const LIST_PATH = '/prj/prj-23';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const idFrom = (value: string | null): string | undefined => (value !== null && UUID.test(value) ? value.toLowerCase() : undefined);
export const isId = (value: string): boolean => UUID.test(value.trim());

/**
 * A decimal text as the reader of the locale writes it, digit for digit: nothing is turned into a float, so no cent is lost and no figure is rounded again. Text that is not a decimal is shown as it came
 * (never turned into zero).
 */
export function decimalText(value: string | null | undefined, locale: string): string {
  if (value === null || value === undefined || value === '') return '';
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) return value;
  const group = locale === 'en' ? ',' : '.';
  const point = locale === 'en' ? '.' : ',';
  const whole = (match[2] as string).replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${match[1]}${whole}${match[3] === undefined ? '' : `${point}${match[3]}`}`;
}

export const asOfText = (value: string | null | undefined): string => (value === null || value === undefined ? '' : value.replace('T', ' ').slice(0, 16));

// ---- The measures -------------------------------------------------------------------------------------------------------------------

export interface Measure {
  code: string;
  status: 'OK' | 'NOT_APPLICABLE';
  value: string | null;
  reason: string | null;
  detail: Raw;
  formula: string;
  inputs: Record<string, string>;
  assumptions: Array<{ code: string; text: string }>;
}

function toMeasure(raw: unknown): Measure {
  const row = rec(raw);
  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec(row.inputs))) if (typeof value === 'string') inputs[key] = value;
  return {
    code: str(row.code),
    status: row.status === 'OK' ? 'OK' : 'NOT_APPLICABLE',
    value: typeof row.value === 'string' ? row.value : null,
    reason: strOrNull(row.reason),
    detail: rec(row.detail),
    formula: str(row.formula),
    inputs,
    assumptions: list(row.assumptions).map((entry) => ({ code: str(entry.code), text: str(entry.text) })),
  };
}

export interface Tco {
  nominalTotal: string;
  presentValueTotal: string;
  equivalentPerPeriod: string | null;
  capexSharePct: string | null;
  byKind: Array<{ kind: string; nominal: string; presentValue: string }>;
}

function toTco(raw: unknown): Tco | null {
  const row = rec(raw);
  if (!isRecord(row.value)) return null;
  const value = row.value;
  return {
    nominalTotal: str(value.nominalTotal),
    presentValueTotal: str(value.presentValueTotal),
    equivalentPerPeriod: strOrNull(value.equivalentPerPeriod),
    capexSharePct: strOrNull(value.capexSharePct),
    byKind: Object.entries(rec(value.byKind)).map(([kind, figures]) => ({ kind, nominal: str(rec(figures).nominal), presentValue: str(rec(figures).presentValue) })),
  };
}

export interface TableRow {
  period: number;
  benefit: string;
  capex: string;
  opex: string;
  maintenance: string;
  residual: string;
  net: string;
  factor: string | null;
  presentValue: string | null;
  cumulativeNet: string;
  cumulativePresentValue: string | null;
}

const toRow = (raw: Raw): TableRow => ({
  period: num(raw.period),
  benefit: str(raw.benefit),
  capex: str(raw.capex),
  opex: str(raw.opex),
  maintenance: str(raw.maintenance),
  residual: str(raw.residual),
  net: str(raw.net),
  factor: strOrNull(raw.factor),
  presentValue: strOrNull(raw.presentValue),
  cumulativeNet: str(raw.cumulativeNet),
  cumulativePresentValue: strOrNull(raw.cumulativePresentValue),
});

export interface Headline {
  npv: string | null;
  irrPct: string | null;
  irrReason: string | null;
  paybackPeriods: string | null;
  paybackReason: string | null;
  discountedPaybackPeriods: string | null;
  discountedPaybackReason: string | null;
  bcr: string | null;
  bcrReason: string | null;
  tcoPresentValue: string | null;
}

const toHeadline = (raw: unknown): Headline => {
  const row = rec(raw);
  return {
    npv: strOrNull(row.npv),
    irrPct: strOrNull(row.irrPct),
    irrReason: strOrNull(row.irrReason),
    paybackPeriods: strOrNull(row.paybackPeriods),
    paybackReason: strOrNull(row.paybackReason),
    discountedPaybackPeriods: strOrNull(row.discountedPaybackPeriods),
    discountedPaybackReason: strOrNull(row.discountedPaybackReason),
    bcr: strOrNull(row.bcr),
    bcrReason: strOrNull(row.bcrReason),
    tcoPresentValue: strOrNull(row.tcoPresentValue),
  };
};

export interface ScenarioResult {
  code: string;
  label: string;
  deltas: Record<string, string>;
  headline: Headline;
}

export interface TornadoBar {
  parameter: string;
  low: { delta: string; npv: string | null };
  high: { delta: string; npv: string | null };
  swing: string | null;
}

export interface Criteria {
  category: string;
  weightedScore: string;
  indexPct: string;
  formula: string;
  lines: Array<{ key: string; label: string; weightPct: string; score: number; contribution: string; evidence: string }>;
}

export interface Report {
  formulaVersion: string;
  table: TableRow[];
  npv: Measure;
  irr: Measure;
  payback: Measure;
  discountedPayback: Measure;
  bcr: Measure;
  tco: Measure;
  tcoValue: Tco | null;
  scenarios: ScenarioResult[];
  oneWay: Array<{ parameter: string; points: Array<{ delta: string; headline: Headline }> }>;
  twoWay: { x: string; y: string; xPoints: string[]; yPoints: string[]; npv: Array<Array<string | null>> };
  tornado: TornadoBar[];
  switching: Array<{ parameter: string; status: string; pct: string | null; reason: string | null }>;
}

export interface Results {
  report: Report | null;
  criteria: Criteria | null;
}

function toReport(raw: unknown): Report | null {
  if (!isRecord(raw)) return null;
  const analysis = rec(raw.analysis);
  const two = rec(raw.twoWay);
  return {
    formulaVersion: str(raw.formulaVersion),
    table: list(analysis.table).map(toRow),
    npv: toMeasure(analysis.npv),
    irr: toMeasure(analysis.irr),
    payback: toMeasure(analysis.payback),
    discountedPayback: toMeasure(analysis.discountedPayback),
    bcr: toMeasure(analysis.bcr),
    tco: toMeasure(analysis.tco),
    tcoValue: toTco(analysis.tco),
    scenarios: list(raw.scenarios).map((entry) => ({ code: str(entry.code), label: str(entry.label), deltas: Object.fromEntries(Object.entries(rec(entry.deltas)).filter((pair): pair is [string, string] => typeof pair[1] === 'string')), headline: toHeadline(entry.headline) })),
    oneWay: list(raw.oneWay).map((table) => ({ parameter: str(table.parameter), points: list(table.points).map((point) => ({ delta: str(point.delta), headline: toHeadline(point.headline) })) })),
    twoWay: { x: str(two.x), y: str(two.y), xPoints: strings(two.xPoints), yPoints: strings(two.yPoints), npv: Array.isArray(two.npv) ? two.npv.map((row) => (Array.isArray(row) ? row.map((cell) => (typeof cell === 'string' ? cell : null)) : [])) : [] },
    tornado: list(raw.tornado).map((bar) => ({ parameter: str(bar.parameter), low: { delta: str(rec(bar.low).delta), npv: strOrNull(rec(bar.low).npv) }, high: { delta: str(rec(bar.high).delta), npv: strOrNull(rec(bar.high).npv) }, swing: strOrNull(bar.swing) })),
    switching: list(raw.switching).map((entry) => ({ parameter: str(entry.parameter), status: str(entry.status), pct: strOrNull(entry.pct), reason: strOrNull(entry.reason) })),
  };
}

function toCriteria(raw: unknown): Criteria | null {
  if (!isRecord(raw)) return null;
  return {
    category: str(raw.category),
    weightedScore: str(raw.weightedScore),
    indexPct: str(raw.indexPct),
    formula: str(raw.formula),
    lines: list(raw.lines).map((line) => ({ key: str(line.key), label: str(line.label), weightPct: str(line.weightPct), score: num(line.score), contribution: str(line.contribution), evidence: str(line.evidence) })),
  };
}

// ---- The appraisal ------------------------------------------------------------------------------------------------------------------

export type Status = 'DRAFT' | 'SUBMITTED' | 'APPROVED';
export type Kind = 'FINANCIAL' | 'NON_FINANCIAL';

export interface Person {
  id: string;
  name: string | null;
}

export interface Link {
  id: string;
  code: string;
}

export interface LineView {
  period: number;
  benefit: string;
  capex: string;
  opex: string;
  maintenance: string;
  residual: string;
}

export interface AssumptionView {
  key: string;
  value: string;
  unit: string;
  sourceKind: string;
  source: string;
  ownerId: string;
  ownerName: string | null;
}

export interface CriterionView {
  key: string;
  label: string;
  weightPct: string;
}

export interface Appraisal {
  id: string;
  code: string;
  revision: number;
  supersedesId: string | null;
  title: string;
  kind: Kind;
  status: Status;
  version: number;
  ownerUnit: { id: string; code: string; name: string };
  project: Link | null;
  package: Link | null;
  contract: Link | null;
  periodUnit: string;
  discountRatePct: string;
  convention: string;
  criteriaCategory: string | null;
  lines: LineView[];
  assumptions: AssumptionView[];
  scenarios: Array<{ code: string; label: string; deltas: Record<string, string> }>;
  scores: Array<{ key: string; score: number; evidence: string }>;
  requiredAssumptions: string[];
  missingAssumptions: string[];
  results: Results | null;
  resultHash: string | null;
  formulaVersion: string | null;
  computedAt: string | null;
  resultsFresh: boolean;
  frozen: boolean;
  criteriaUsed: { source: string; version: number; criteria: CriterionView[] } | null;
  criteriaInForce: { category: string; source: string; version: number; unverified: boolean; criteria: CriterionView[] } | null;
  createdBy: Person;
  updatedBy: Person;
  submittedBy: Person | null;
  approvedBy: Person | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  actions: { updateInputs: boolean; run: boolean; submit: boolean; approve: boolean; return: boolean; export: boolean; revise: boolean };
  asOf: string;
}

const person = (raw: unknown): Person | null => (isRecord(raw) && str(raw.id) !== '' ? { id: str(raw.id), name: strOrNull(raw.name) } : null);
const link = (raw: unknown): Link | null => (isRecord(raw) && str(raw.id) !== '' ? { id: str(raw.id), code: str(raw.code) } : null);
const criterion = (raw: Raw): CriterionView => ({ key: str(raw.key), label: str(raw.label), weightPct: str(raw.weight_pct) });

export function toAppraisal(raw: unknown): Appraisal | undefined {
  if (!isRecord(raw) || str(raw.id) === '' || !isRecord(raw.owner_unit)) return undefined;
  const actions = rec(raw.actions);
  const results = isRecord(raw.results) ? { report: toReport(raw.results.report), criteria: toCriteria(raw.results.criteria) } : null;
  const used = isRecord(raw.criteria_used) ? raw.criteria_used : undefined;
  const inForce = isRecord(raw.criteria_in_force) ? raw.criteria_in_force : undefined;
  return {
    id: str(raw.id),
    code: str(raw.code),
    revision: num(raw.revision),
    supersedesId: strOrNull(raw.supersedes_id),
    title: str(raw.title),
    kind: raw.kind === 'NON_FINANCIAL' ? 'NON_FINANCIAL' : 'FINANCIAL',
    status: raw.status === 'APPROVED' ? 'APPROVED' : raw.status === 'SUBMITTED' ? 'SUBMITTED' : 'DRAFT',
    version: num(raw.version),
    ownerUnit: { id: str(raw.owner_unit.id), code: str(raw.owner_unit.code), name: str(raw.owner_unit.name) },
    project: link(raw.project),
    package: link(raw.package),
    contract: link(raw.contract),
    periodUnit: str(raw.period_unit),
    discountRatePct: str(raw.discount_rate_pct),
    convention: str(raw.convention),
    criteriaCategory: strOrNull(raw.criteria_category),
    lines: list(raw.lines).map((line) => ({ period: num(line.period), benefit: str(line.benefit), capex: str(line.capex), opex: str(line.opex), maintenance: str(line.maintenance), residual: str(line.residual) })),
    assumptions: list(raw.assumptions).map((entry) => ({ key: str(entry.key), value: str(entry.value), unit: str(entry.unit), sourceKind: str(entry.source_kind), source: str(entry.source), ownerId: str(entry.owner_id), ownerName: strOrNull(entry.owner_name) })),
    scenarios: list(raw.scenarios).map((entry) => ({ code: str(entry.code), label: str(entry.label), deltas: Object.fromEntries(Object.entries(rec(entry.deltas)).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) })),
    scores: list(raw.scores).map((entry) => ({ key: str(entry.key), score: num(entry.score), evidence: str(entry.evidence) })),
    requiredAssumptions: strings(raw.required_assumptions),
    missingAssumptions: strings(raw.missing_assumptions),
    results,
    resultHash: strOrNull(raw.result_hash),
    formulaVersion: strOrNull(raw.formula_version),
    computedAt: strOrNull(raw.computed_at),
    resultsFresh: bool(raw.results_fresh),
    frozen: bool(raw.frozen),
    criteriaUsed: used === undefined ? null : { source: str(used.source), version: num(used.version), criteria: list(used.criteria).map(criterion) },
    criteriaInForce: inForce === undefined ? null : { category: str(inForce.category), source: str(inForce.source), version: num(inForce.version), unverified: bool(inForce.unverified), criteria: list(inForce.criteria).map(criterion) },
    createdBy: person(raw.created_by) ?? { id: '', name: null },
    updatedBy: person(raw.updated_by) ?? { id: '', name: null },
    submittedBy: person(raw.submitted_by),
    approvedBy: person(raw.approved_by),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    submittedAt: strOrNull(raw.submitted_at),
    approvedAt: strOrNull(raw.approved_at),
    decisionReason: strOrNull(raw.decision_reason),
    actions: {
      updateInputs: bool(actions.update_inputs),
      run: bool(actions.run),
      submit: bool(actions.submit),
      approve: bool(actions.approve),
      return: bool(actions.return),
      export: bool(actions.export),
      revise: bool(actions.revise),
    },
    asOf: str(raw.as_of),
  };
}

export interface ListItem {
  id: string;
  code: string;
  revision: number;
  title: string;
  kind: Kind;
  status: Status;
  version: number;
  ownerUnit: { id: string; code: string; name: string };
  project: Link | null;
  package: Link | null;
  contract: Link | null;
  resultState: 'FROZEN' | 'COMPUTED' | 'NONE';
  npv: string | null;
  irrPct: string | null;
  paybackPeriods: string | null;
  indexPct: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  updatedAt: string;
}

export interface AppraisalList {
  items: ListItem[];
  total: number;
  canCreate: boolean;
  asOf: string;
}

export function toList(raw: unknown): AppraisalList | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  return {
    items: list(raw.items).map(
      (item): ListItem => ({
        id: str(item.id),
        code: str(item.code),
        revision: num(item.revision),
        title: str(item.title),
        kind: item.kind === 'NON_FINANCIAL' ? 'NON_FINANCIAL' : 'FINANCIAL',
        status: item.status === 'APPROVED' ? 'APPROVED' : item.status === 'SUBMITTED' ? 'SUBMITTED' : 'DRAFT',
        version: num(item.version),
        ownerUnit: { id: str(rec(item.owner_unit).id), code: str(rec(item.owner_unit).code), name: str(rec(item.owner_unit).name) },
        project: link(item.project),
        package: link(item.package),
        contract: link(item.contract),
        resultState: item.result_state === 'FROZEN' ? 'FROZEN' : item.result_state === 'COMPUTED' ? 'COMPUTED' : 'NONE',
        npv: strOrNull(item.npv),
        irrPct: strOrNull(item.irr_pct),
        paybackPeriods: strOrNull(item.payback_periods),
        indexPct: strOrNull(item.index_pct),
        createdByName: strOrNull(item.created_by_name),
        approvedByName: strOrNull(item.approved_by_name),
        updatedAt: str(item.updated_at),
      }),
    ),
    total: num(raw.total),
    canCreate: bool(rec(raw.actions).create),
    asOf: str(raw.as_of),
  };
}

// ---- The draft of the inputs the person is typing ------------------------------------------------------------------------------------------

export const LINE_KINDS = ['benefit', 'capex', 'opex', 'maintenance', 'residual'] as const;
export type LineKind = (typeof LINE_KINDS)[number];
export const DELTA_KEYS = ['benefitPct', 'capexPct', 'opexPct', 'maintenancePct', 'residualPct', 'discountRatePp', 'benefitDelayPeriods'] as const;
export const SOURCE_KINDS = ['DOCUMENT', 'ESTIMATE', 'MARKET', 'STANDARD', 'LAW', 'OTHER'] as const;
export const CATEGORIES = ['SAFETY', 'COMPLIANCE', 'MAINTENANCE'] as const;

export interface DraftLine {
  period: string;
  benefit: string;
  capex: string;
  opex: string;
  maintenance: string;
  residual: string;
}

export interface DraftAssumption {
  key: string;
  value: string;
  unit: string;
  sourceKind: string;
  source: string;
  ownerId: string;
}

export interface DraftScenario {
  code: string;
  label: string;
  deltas: Record<string, string>;
}

export interface DraftScore {
  key: string;
  score: string;
  evidence: string;
}

export interface Draft {
  title: string;
  periodUnit: string;
  discountRatePct: string;
  convention: string;
  lines: DraftLine[];
  assumptions: DraftAssumption[];
  scenarios: DraftScenario[];
  criteriaCategory: string;
  scores: DraftScore[];
}

const plain = (value: string): string => (value === '0' ? '' : value);

/** The draft the person edits, from what the server holds (zero amounts are left blank, so that the grid shows only what was entered). */
export function draftOf(appraisal: Appraisal): Draft {
  return {
    title: appraisal.title,
    periodUnit: appraisal.periodUnit,
    discountRatePct: appraisal.discountRatePct,
    convention: appraisal.convention,
    lines: appraisal.lines.map((line) => ({ period: String(line.period), benefit: plain(line.benefit), capex: plain(line.capex), opex: plain(line.opex), maintenance: plain(line.maintenance), residual: plain(line.residual) })),
    assumptions: appraisal.assumptions.map((entry) => ({ key: entry.key, value: entry.value, unit: entry.unit, sourceKind: entry.sourceKind, source: entry.source, ownerId: entry.ownerId })),
    scenarios: appraisal.scenarios.map((entry) => ({ code: entry.code, label: entry.label, deltas: { ...entry.deltas } })),
    criteriaCategory: appraisal.criteriaCategory ?? '',
    scores: appraisal.scores.map((entry) => ({ key: entry.key, score: String(entry.score), evidence: entry.evidence })),
  };
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/;
const RATE = /^-?(0|[1-9][0-9]*)(\.[0-9]{1,4})?$/;
const SIGNED_PCT = /^-?(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/;
const SCENARIO_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

/** What is wrong with a draft before it is sent: the first fields, as keys of the screen (the server judges everything again). */
export function draftProblems(draft: Draft): string[] {
  const problems: string[] = [];
  if (draft.title.trim() === '') problems.push('title');
  if (!RATE.test(draft.discountRatePct.trim())) problems.push('rate');
  const periods = new Set<string>();
  draft.lines.forEach((line, index) => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(line.period) || Number(line.period) > 100 || periods.has(line.period)) problems.push(`line.${index}.period`);
    periods.add(line.period);
    for (const kind of LINE_KINDS) if (line[kind] !== '' && !DECIMAL.test(line[kind])) problems.push(`line.${index}.${kind}`);
  });
  const codes = new Set<string>();
  draft.scenarios.forEach((scenario, index) => {
    if (!SCENARIO_CODE.test(scenario.code) || scenario.code === 'BASE' || codes.has(scenario.code)) problems.push(`scenario.${index}.code`);
    codes.add(scenario.code);
    if (scenario.label.trim() === '') problems.push(`scenario.${index}.label`);
    for (const [key, value] of Object.entries(scenario.deltas)) {
      if (value === '') continue;
      const ok = key === 'benefitDelayPeriods' ? /^(0|[1-9][0-9]{0,2})$/.test(value) : key === 'discountRatePp' ? RATE.test(value) : SIGNED_PCT.test(value);
      if (!ok) problems.push(`scenario.${index}.${key}`);
    }
  });
  draft.assumptions.forEach((entry, index) => {
    if (entry.value.trim() === '' || entry.unit.trim() === '' || entry.source.trim() === '' || !isId(entry.ownerId)) problems.push(`assumption.${index}`);
  });
  draft.scores.forEach((entry, index) => {
    // A row nobody touched is not a score; one that is half written is a problem.
    if (entry.score === '' && entry.evidence.trim() === '') return;
    if (!/^[1-5]$/.test(entry.score) || entry.evidence.trim() === '') problems.push(`score.${index}`);
  });
  return problems;
}

/** The body of the command that replaces the inputs; it carries no result. */
export function inputsBody(draft: Draft): Record<string, unknown> {
  return {
    title: draft.title.trim(),
    period_unit: draft.periodUnit,
    discount_rate_pct: draft.discountRatePct.trim(),
    convention: draft.convention,
    lines: draft.lines.map((line) => {
      const out: Record<string, unknown> = { period: Number(line.period) };
      for (const kind of LINE_KINDS) if (line[kind] !== '') out[kind] = line[kind];
      return out;
    }),
    assumptions: draft.assumptions.map((entry) => ({ key: entry.key, value: entry.value.trim(), unit: entry.unit.trim(), source_kind: entry.sourceKind, source: entry.source.trim(), owner_id: entry.ownerId.trim().toLowerCase() })),
    scenarios: draft.scenarios.map((scenario) => ({ code: scenario.code, label: scenario.label.trim(), deltas: Object.fromEntries(Object.entries(scenario.deltas).filter(([, value]) => value !== '')) })),
    criteria_category: draft.criteriaCategory === '' ? null : draft.criteriaCategory,
    scores: draft.criteriaCategory === '' ? [] : draft.scores.filter((entry) => entry.score !== '').map((entry) => ({ key: entry.key, score: Number(entry.score), evidence: entry.evidence.trim() })),
  };
}

/** The same draft as the one the server holds (so the Save button is off until something changed). */
export const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The scenarios of the platform for the person to start from (read by the same function as the server). */
export const startScenarios = (defaults: readonly FinScenarioInput[], taken: readonly string[]): DraftScenario[] =>
  defaults.filter((scenario) => !taken.includes(scenario.code)).map((scenario) => ({ code: scenario.code, label: scenario.label, deltas: { ...(scenario.deltas as Record<string, string>) } }));

/** The assumptions still to be answered for: a row with the person who opens the appraisal as its owner, never an invented source. */
export function blankAssumption(key: string, owner: string): DraftAssumption {
  return { key, value: '', unit: '', sourceKind: 'DOCUMENT', source: '', ownerId: owner };
}

/** Saves a file that the server sent (the export of an appraisal) through the browser. */
export function saveFile(fileName: string, mediaType: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
