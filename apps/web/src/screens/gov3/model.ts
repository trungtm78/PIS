import { ApiError } from '@machvon/api-client';
export { asOfText, idFrom, vnd } from '../gov4/model';

/*
 * Lane B1 (governance deepening G1-2 .. G1-5): the baseline of a project (PRJ-26), the earned value and the S-curve (PRJ-27) and the precondition of a disbursement (PAY-19).
 * Every parser keeps only the fields it lists (an allowlist: a field the server adds later is not shown until it is listed here), keeps money as the string of whole dong it came as
 * and keeps a missing figure as null: a figure that cannot be known is never written as zero.
 */

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const bool = (value: unknown): boolean => value === true;
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const num = (value: unknown): number => numOrNull(value) ?? 0;
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const rec = (value: unknown): Raw => (isRecord(value) ? value : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** Today in Vietnam (UTC+7), the day the "view at" date may not pass. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export const isCalendarDay = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
};

/** A calendar day as the reader of Vietnam writes it; text that is not a day is shown as it came. */
export function dayText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match === null ? value : `${match[3]}/${match[2]}/${match[1]}`;
}

// ---- PRJ-26: the baseline ---------------------------------------------------------------------------------------------------

export interface BaselineLine {
  componentId: string;
  code: string;
  name: string;
  bacVnd: string;
  plannedStart: string;
  plannedFinish: string;
}

export interface BaselineVersion {
  id: string;
  version: number;
  kind: 'V0' | 'REVISION';
  basis: string;
  totalInvestmentVnd: string;
  bacVnd: string;
  plannedStart: string;
  plannedFinish: string;
  sourceRevisionId: string | null;
  takenBy: string;
  takenAt: string;
  lines: BaselineLine[];
}

export interface MilestoneSlip {
  code: string;
  baselineDate: string;
  plannedDate: string;
  slipDays: number | null;
  moves: number;
}

export interface Deviation {
  costVnd: string;
  costPct: string | null;
  bacVnd: string;
  bacPct: string | null;
  finishSlipDays: number | null;
  forecastFinish: string | null;
  milestones: MilestoneSlip[];
}

export interface RescheduleEvent {
  id: string;
  source: 'MILESTONE' | 'REVISION';
  milestoneCode: string | null;
  fromDate: string;
  toDate: string;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

export interface GovernanceAlert {
  id: string;
  projectCode: string;
  alertType: string;
  audience: string;
  subjectKind: 'MILESTONE' | 'PROJECT';
  subjectCode: string | null;
  moveCount: number;
  threshold: number;
  ruleVersion: string;
  status: 'OPEN' | 'ACKNOWLEDGED';
  raisedAt: string;
  acknowledgedAt: string | null;
  acknowledgeNote: string | null;
  version: number;
}

export interface Reappraisal {
  id: string;
  status: 'OPEN' | 'STARTED' | 'WAIVED';
  reasons: Array<'COST' | 'SLIP'>;
  costPct: string | null;
  finishSlipDays: number | null;
  thresholdCostPct: string;
  thresholdSlipDays: number | null;
  ruleVersion: string;
  triggeredBy: 'REVISION' | 'MILESTONE';
  requestedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export interface BaselinePolicy {
  version: string;
  /** `BUILT_IN` is the starting value nobody approved: the screen says it is not confirmed. */
  source: string;
  costPct: number | null;
  slipDays: number | null;
  rescheduleAlertCount: number | null;
}

export interface BaselineView {
  projectId: string;
  projectCode: string;
  projectStatus: string;
  hasBaseline: boolean;
  versions: BaselineVersion[];
  current: { totalInvestmentVnd: string; bacVnd: string; forecastFinish: string | null };
  deviation: Deviation | null;
  reasons: Array<'COST' | 'SLIP'>;
  reschedule: { count: number; projectMoves: number; perMilestone: Array<{ milestoneId: string; code: string; moves: number }>; events: RescheduleEvent[] };
  alerts: GovernanceAlert[];
  reappraisals: Reappraisal[];
  policy: BaselinePolicy;
  actions: { capture: boolean; decideReappraisal: boolean; acknowledgeAlert: boolean };
  asOf: string;
}

const reasonsOf = (value: unknown): Array<'COST' | 'SLIP'> => strings(value).filter((item): item is 'COST' | 'SLIP' => item === 'COST' || item === 'SLIP');

function toDeviation(raw: unknown): Deviation | null {
  if (!isRecord(raw)) return null;
  return {
    costVnd: str(raw.cost_vnd),
    costPct: strOrNull(raw.cost_pct),
    bacVnd: str(raw.bac_vnd),
    bacPct: strOrNull(raw.bac_pct),
    finishSlipDays: numOrNull(raw.finish_slip_days),
    forecastFinish: strOrNull(raw.forecast_finish),
    milestones: list(raw.milestones).map((item) => ({ code: str(item.code), baselineDate: str(item.baseline_date), plannedDate: str(item.planned_date), slipDays: numOrNull(item.slip_days), moves: num(item.moves) })),
  };
}

export function toBaselineView(raw: unknown): BaselineView | undefined {
  if (!isRecord(raw) || str(raw.project_id) === '') return undefined;
  const current = rec(raw.current);
  const reschedule = rec(raw.reschedule);
  const policy = rec(raw.policy);
  const actions = rec(raw.actions);
  return {
    projectId: str(raw.project_id),
    projectCode: str(raw.project_code),
    projectStatus: str(raw.project_status),
    hasBaseline: bool(raw.has_baseline),
    versions: list(raw.versions).map((item) => ({
      id: str(item.id),
      version: num(item.version),
      kind: item.kind === 'REVISION' ? 'REVISION' : 'V0',
      basis: str(item.basis),
      totalInvestmentVnd: str(item.total_investment_vnd),
      bacVnd: str(item.bac_vnd),
      plannedStart: str(item.planned_start),
      plannedFinish: str(item.planned_finish),
      sourceRevisionId: strOrNull(item.source_revision_id),
      takenBy: str(item.taken_by),
      takenAt: str(item.taken_at),
      lines: list(item.lines).map((line) => ({ componentId: str(line.component_id), code: str(line.code), name: str(line.name), bacVnd: str(line.bac_vnd), plannedStart: str(line.planned_start), plannedFinish: str(line.planned_finish) })),
    })),
    current: { totalInvestmentVnd: str(current.total_investment_vnd), bacVnd: str(current.bac_vnd), forecastFinish: strOrNull(current.forecast_finish) },
    deviation: toDeviation(raw.deviation),
    reasons: reasonsOf(raw.reasons),
    reschedule: {
      count: num(reschedule.count),
      projectMoves: num(reschedule.project_moves),
      perMilestone: list(reschedule.per_milestone).map((item) => ({ milestoneId: str(item.milestone_id), code: str(item.code), moves: num(item.moves) })),
      events: list(reschedule.events).map((item) => ({
        id: str(item.id),
        source: item.source === 'REVISION' ? 'REVISION' : 'MILESTONE',
        milestoneCode: strOrNull(item.milestone_code),
        fromDate: str(item.from_date),
        toDate: str(item.to_date),
        reason: str(item.reason),
        recordedBy: str(item.recorded_by),
        recordedAt: str(item.recorded_at),
      })),
    },
    alerts: list(raw.alerts).map((item) => ({
      id: str(item.id),
      projectCode: str(item.project_code),
      alertType: str(item.alert_type),
      audience: str(item.audience),
      subjectKind: item.subject_kind === 'PROJECT' ? 'PROJECT' : 'MILESTONE',
      subjectCode: strOrNull(item.subject_code),
      moveCount: num(item.move_count),
      threshold: num(item.threshold),
      ruleVersion: str(item.rule_version),
      status: item.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : 'OPEN',
      raisedAt: str(item.raised_at),
      acknowledgedAt: strOrNull(item.acknowledged_at),
      acknowledgeNote: strOrNull(item.acknowledge_note),
      version: num(item.version),
    })),
    reappraisals: list(raw.reappraisals).map((item) => ({
      id: str(item.id),
      status: item.status === 'STARTED' ? 'STARTED' : item.status === 'WAIVED' ? 'WAIVED' : 'OPEN',
      reasons: reasonsOf(item.reasons),
      costPct: strOrNull(item.cost_pct),
      finishSlipDays: numOrNull(item.finish_slip_days),
      thresholdCostPct: str(item.threshold_cost_pct),
      thresholdSlipDays: numOrNull(item.threshold_slip_days),
      ruleVersion: str(item.rule_version),
      triggeredBy: item.triggered_by === 'REVISION' ? 'REVISION' : 'MILESTONE',
      requestedAt: str(item.requested_at),
      decidedAt: strOrNull(item.decided_at),
      decisionReason: strOrNull(item.decision_reason),
      version: num(item.version),
    })),
    policy: { version: str(policy.version), source: str(policy.source), costPct: numOrNull(policy.cost_pct), slipDays: numOrNull(policy.slip_days), rescheduleAlertCount: numOrNull(policy.reschedule_alert_count) },
    actions: { capture: bool(actions.capture), decideReappraisal: bool(actions.decide_reappraisal), acknowledgeAlert: bool(actions.acknowledge_alert) },
    asOf: str(raw.as_of),
  };
}

/** The tone of a deviation against the threshold of the policy: red above it, amber from three quarters of it, neutral when there is nothing to compare. */
export function deviationTone(value: string | number | null, limit: number | null): 'default' | 'warning' | 'danger' {
  if (value === null || limit === null || limit <= 0) return 'default';
  const size = Math.abs(typeof value === 'number' ? value : Number(value));
  if (!Number.isFinite(size)) return 'default';
  return size > limit ? 'danger' : size >= limit * 0.75 ? 'warning' : 'default';
}

// ---- PRJ-27: earned value ---------------------------------------------------------------------------------------------------

export const EVM_METRICS = ['pv', 'ev', 'ac', 'bac', 'cpi', 'spi', 'eac', 'etc', 'vac', 'tcpi'] as const;
export type EvmMetricName = (typeof EVM_METRICS)[number];
export type Rag = 'GREEN' | 'AMBER' | 'RED';
const ragOf = (value: unknown): Rag | null => (value === 'GREEN' || value === 'AMBER' || value === 'RED' ? value : null);

export interface EvmFigures {
  status: 'OK' | 'INSUFFICIENT';
  asOf: string;
  eacMethod: string;
  bacVnd: string | null;
  pvVnd: string | null;
  evVnd: string | null;
  acVnd: string | null;
  cpi: string | null;
  spi: string | null;
  eacVnd: string | null;
  etcVnd: string | null;
  vacVnd: string | null;
  tcpi: string | null;
  /** Why a figure is empty (a division by zero is not an index of zero), by metric. */
  unavailable: Partial<Record<EvmMetricName, string>>;
  /** Why the whole answer is "not enough data". */
  missing: string[];
  ragCpi: Rag | null;
  ragSpi: Rag | null;
}

function toFigures(raw: unknown): EvmFigures {
  const figures = rec(raw);
  const unavailable: Partial<Record<EvmMetricName, string>> = {};
  const given = rec(figures.unavailable);
  for (const metric of EVM_METRICS) if (typeof given[metric] === 'string') unavailable[metric] = given[metric] as string;
  return {
    status: figures.status === 'OK' ? 'OK' : 'INSUFFICIENT',
    asOf: str(figures.as_of),
    eacMethod: str(figures.eac_method),
    bacVnd: strOrNull(figures.bac_vnd),
    pvVnd: strOrNull(figures.pv_vnd),
    evVnd: strOrNull(figures.ev_vnd),
    acVnd: strOrNull(figures.ac_vnd),
    cpi: strOrNull(figures.cpi),
    spi: strOrNull(figures.spi),
    eacVnd: strOrNull(figures.eac_vnd),
    etcVnd: strOrNull(figures.etc_vnd),
    vacVnd: strOrNull(figures.vac_vnd),
    tcpi: strOrNull(figures.tcpi),
    unavailable,
    missing: strings(figures.missing),
    ragCpi: ragOf(figures.rag_cpi),
    ragSpi: ragOf(figures.rag_spi),
  };
}

export interface EvmRow {
  key: string;
  code: string;
  name: string;
  bacVnd: string;
  pvVnd: string;
  evVnd: string | null;
  acVnd: string | null;
  cpi: string | null;
  spi: string | null;
  ragCpi: Rag | null;
  ragSpi: Rag | null;
  missing: string[];
  contracts: Array<{ contractId: string; code: string; valueVnd: string }>;
}

export interface EvmPolicy {
  version: string;
  source: string;
  eacMethod: string;
  amberBelow: number | null;
  redBelow: number | null;
}

const toPolicy = (raw: unknown): EvmPolicy => {
  const policy = rec(raw);
  return { version: str(policy.version), source: str(policy.source), eacMethod: str(policy.eac_method), amberBelow: numOrNull(policy.amber_below), redBelow: numOrNull(policy.red_below) };
};

export type Selection = 'CURRENT' | 'V0';

export interface EvmView {
  projectId: string;
  projectCode: string;
  scope: 'PROJECT' | 'COMPONENT' | 'CONTRACT';
  ref: string | null;
  asOf: string;
  source: 'LIVE' | 'FROZEN';
  snapshotId: string | null;
  frozenAt: string | null;
  payloadSha256: string | null;
  baseline: { version: number | null; selection: Selection };
  figures: EvmFigures;
  eacAgainstTotal: { overVnd: string; overPct: string | null } | null;
  totalInvestmentVnd: string;
  rows: EvmRow[];
  policy: EvmPolicy;
}

const scopeOf = (value: unknown): 'PROJECT' | 'COMPONENT' | 'CONTRACT' => (value === 'COMPONENT' || value === 'CONTRACT' ? value : 'PROJECT');
const baselineOf = (value: unknown): { version: number | null; selection: Selection } => {
  const baseline = rec(value);
  return { version: numOrNull(baseline.version), selection: baseline.selection === 'V0' ? 'V0' : 'CURRENT' };
};

export function toEvmView(raw: unknown): EvmView | undefined {
  if (!isRecord(raw) || str(raw.project_id) === '' || !isRecord(raw.figures)) return undefined;
  const against = isRecord(raw.eac_against_total) ? raw.eac_against_total : undefined;
  return {
    projectId: str(raw.project_id),
    projectCode: str(raw.project_code),
    scope: scopeOf(raw.scope),
    ref: strOrNull(raw.ref),
    asOf: str(raw.as_of),
    source: raw.source === 'FROZEN' ? 'FROZEN' : 'LIVE',
    snapshotId: strOrNull(raw.snapshot_id),
    frozenAt: strOrNull(raw.frozen_at),
    payloadSha256: strOrNull(raw.payload_sha256),
    baseline: baselineOf(raw.baseline),
    figures: toFigures(raw.figures),
    eacAgainstTotal: against === undefined ? null : { overVnd: str(against.over_vnd), overPct: strOrNull(against.over_pct) },
    totalInvestmentVnd: str(raw.total_investment_vnd),
    rows: list(raw.rows).map((row) => ({
      key: str(row.key),
      code: str(row.code),
      name: str(row.name),
      bacVnd: str(row.bac_vnd),
      pvVnd: str(row.pv_vnd),
      evVnd: strOrNull(row.ev_vnd),
      acVnd: strOrNull(row.ac_vnd),
      cpi: strOrNull(row.cpi),
      spi: strOrNull(row.spi),
      ragCpi: ragOf(row.rag_cpi),
      ragSpi: ragOf(row.rag_spi),
      missing: strings(row.missing),
      contracts: list(row.contracts).map((contract) => ({ contractId: str(contract.contract_id), code: str(contract.code), valueVnd: str(contract.value_vnd) })),
    })),
    policy: toPolicy(raw.policy),
  };
}

export interface CurvePoint {
  day: string;
  pvV0Vnd: string;
  pvCurrentVnd: string;
  evVnd: string | null;
  acVnd: string | null;
}

export interface SCurveView {
  projectId: string;
  projectCode: string;
  scope: 'PROJECT' | 'COMPONENT' | 'CONTRACT';
  ref: string | null;
  asOf: string;
  baseline: { version: number | null; selection: Selection };
  points: CurvePoint[];
  figures: EvmFigures;
  missing: string[];
  source: 'LIVE' | 'FROZEN';
  policy: EvmPolicy;
}

export function toSCurveView(raw: unknown): SCurveView | undefined {
  if (!isRecord(raw) || str(raw.project_id) === '' || !Array.isArray(raw.points)) return undefined;
  return {
    projectId: str(raw.project_id),
    projectCode: str(raw.project_code),
    scope: scopeOf(raw.scope),
    ref: strOrNull(raw.ref),
    asOf: str(raw.as_of),
    baseline: baselineOf(raw.baseline),
    points: list(raw.points).map((point) => ({ day: str(point.day), pvV0Vnd: str(point.pv_v0_vnd), pvCurrentVnd: str(point.pv_current_vnd), evVnd: strOrNull(point.ev_vnd), acVnd: strOrNull(point.ac_vnd) })),
    figures: toFigures(raw.figures),
    missing: strings(raw.missing),
    source: raw.source === 'FROZEN' ? 'FROZEN' : 'LIVE',
    policy: toPolicy(raw.policy),
  };
}

export interface ComponentLink {
  id: string;
  componentId: string | null;
  componentCode: string | null;
  contractId: string;
  contractCode: string;
  contractValueVnd: string;
  linkedAt: string;
}

export function toComponentLinks(raw: unknown): ComponentLink[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  return list(raw.items).map((item) => ({ id: str(item.id), componentId: strOrNull(item.component_id), componentCode: strOrNull(item.component_code), contractId: str(item.contract_id), contractCode: str(item.contract_code), contractValueVnd: str(item.contract_value_vnd), linkedAt: str(item.linked_at) }));
}

export interface ExportFile {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  contentBase64: string;
  asOf: string;
}

export function toExportFile(raw: unknown): ExportFile | undefined {
  if (!isRecord(raw) || str(raw.content_base64) === '' || str(raw.file_name) === '') return undefined;
  return { fileName: str(raw.file_name), contentType: str(raw.content_type) || 'application/octet-stream', sizeBytes: num(raw.size_bytes), sha256: str(raw.sha256), contentBase64: str(raw.content_base64), asOf: str(raw.as_of) };
}

/** The bytes of a file that travelled as base64, exactly. */
export function bytesOfBase64(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The chart wants numbers: the money is turned into billions of dong for the picture only (the figures in the table and the tiles stay the strings that came). A value that is not whole dong is not drawn.
 */
export function billions(value: string | null): number | null {
  if (value === null || !/^-?\d{1,24}$/.test(value)) return null;
  return Number(BigInt(value)) / 1e9;
}

/** At most `limit` points of the curve for the picture, always the first, the last and the day of the view; the table keeps every point. */
export function chartPoints(points: readonly CurvePoint[], asOf: string, limit: number): CurvePoint[] {
  if (points.length <= limit) return [...points];
  const keep = new Set<number>([0, points.length - 1]);
  const asOfIndex = points.findIndex((point) => point.day === asOf);
  if (asOfIndex >= 0) keep.add(asOfIndex);
  const step = (points.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) keep.add(Math.round(index * step));
  const ordered = [...keep].sort((a, b) => a - b);
  // Drop the neighbours of the day of the view until the picture is within the limit: the day itself stays.
  while (ordered.length > limit) {
    const victim = ordered.findIndex((index, position) => position > 0 && position < ordered.length - 1 && index !== asOfIndex);
    if (victim < 0) break;
    ordered.splice(victim, 1);
  }
  return ordered.flatMap((index) => points[index] ?? []);
}

// ---- PAY-19: the precondition of a disbursement -----------------------------------------------------------------------------

export type DisbursementRefusalCode = 'DISBURSEMENT_PROJECT_NOT_LISTED' | 'DISBURSEMENT_NO_APPROVED_PLAN';
export type DisbursementFixCode = 'COMPLETE_STAGE_TRANSITION' | 'ENTER_APPROVED_PLAN';

export interface DisbursementCheck {
  projectId: string;
  projectCode: string;
  allowed: boolean;
  refusal: DisbursementRefusalCode | null;
  fix: DisbursementFixCode | null;
  cause: { projectStatus: string; allocatedVnd: string };
  warnings: string[];
  policyVersion: string;
  asOf: string;
}

export function toDisbursementCheck(raw: unknown): DisbursementCheck | undefined {
  if (!isRecord(raw) || str(raw.project_id) === '' || typeof raw.allowed !== 'boolean') return undefined;
  const cause = rec(raw.cause);
  return {
    projectId: str(raw.project_id),
    projectCode: str(raw.project_code),
    allowed: raw.allowed,
    refusal: raw.refusal === 'DISBURSEMENT_PROJECT_NOT_LISTED' || raw.refusal === 'DISBURSEMENT_NO_APPROVED_PLAN' ? raw.refusal : null,
    fix: raw.fix === 'COMPLETE_STAGE_TRANSITION' || raw.fix === 'ENTER_APPROVED_PLAN' ? raw.fix : null,
    cause: { projectStatus: str(cause.project_status), allocatedVnd: str(cause.allocated_vnd) },
    warnings: strings(raw.warnings),
    policyVersion: str(raw.policy_version),
    asOf: str(raw.as_of),
  };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------

export type Refusal =
  | 'noWbs'
  | 'incomplete'
  | 'alreadyTaken'
  | 'selfApproval'
  | 'reappraisalState'
  | 'alertState'
  | 'versionConflict'
  | 'componentUnchanged'
  | 'baselineMissing'
  | 'notFound'
  | 'denied'
  | 'validation'
  | 'session'
  | 'general';

/** The refusal of the server as the screen words it (the words are in `labels.ts`). */
export function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'BASELINE_NO_WBS':
      return 'noWbs';
    case 'BASELINE_INCOMPLETE':
      return 'incomplete';
    case 'BASELINE_ALREADY_TAKEN':
      return 'alreadyTaken';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'REAPPRAISAL_STATE_INVALID':
      return 'reappraisalState';
    case 'GOVERNANCE_ALERT_STATE_INVALID':
      return 'alertState';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'COMPONENT_CONTRACT_UNCHANGED':
      return 'componentUnchanged';
    case 'BASELINE_MISSING':
      return 'baselineMissing';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}

/** The components that stop a capture (BASELINE_INCOMPLETE names each one): code of the component and what is wrong with it. */
export function incompleteIssues(error: unknown): Array<{ componentCode: string; problem: 'NO_FINISH_DATE' | 'FINISH_BEFORE_START' | 'OTHER' }> {
  if (!(error instanceof ApiError) || error.code !== 'BASELINE_INCOMPLETE') return [];
  return list(error.extensions.issues).map((issue) => ({
    componentCode: str(issue.component_code),
    problem: issue.code === 'NO_FINISH_DATE' || issue.code === 'FINISH_BEFORE_START' ? issue.code : 'OTHER',
  }));
}
