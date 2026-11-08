import { DomainError } from './errors.ts';
import { CTR_INDICATORS, analyticsPercent, indicatorRatio } from './ctr-analytics.ts';
import type { IndicatorCode, IndicatorResult, NotApplicableReason } from './ctr-analytics.ts';
import { daysLateOfFact, healthOfFact, indicatorsOfFact } from './ctr-reports.ts';
import type { CellValue, ColumnKind, ContractFact, ReportTotals } from './ctr-reports.ts';
import type { ContractHealth } from './ctr-analytics.ts';
import type { ExportColumn, ExportDocument, ExportHeaderEntry } from './dis-export.ts';
import { message, messagesUnder } from './messages.ts';

/**
 * The register reports of the contract portfolio (CA-3): claims and limitation, quality defects, obstacles, audit findings and recoveries, the rating of the contractor and the colour of the contract. They keep the shape
 * of the reports of CA-1 and CA-2 (columns, rows, a totals row made from the same rows, breakdowns whose groups are totals of their own rows, definitions with their "i"), but a row here is a RECORD of a register (a claim,
 * a defect, an issue, a finding) or a contract. Every ratio is the sum of the numerators over the sum of the denominators of the rows, never the mean of the ratios; what cannot be known is empty with a named reason, never 0.
 * Pure: the same records give the same report.
 */

export const REGISTER_REPORT_CODES = ['claims-limitation', 'quality-defects', 'obstacles', 'audit-findings', 'performance-rating', 'contract-health'] as const;
export type RegisterReportCode = (typeof REGISTER_REPORT_CODES)[number];
export const isRegisterReportCode = (value: unknown): value is RegisterReportCode => typeof value === 'string' && (REGISTER_REPORT_CODES as readonly string[]).includes(value);

/** The reports whose rows are read from registers that keep no frozen copy: they are live readings of today only. */
export const LIVE_ONLY_REPORTS: readonly RegisterReportCode[] = ['claims-limitation', 'quality-defects', 'obstacles', 'audit-findings', 'performance-rating'];

export interface RegisterColumn {
  key: string;
  kind: ColumnKind;
  /** The figure is money of the ledger (or of the audit): a reader without `ledger.read` over the contract gets no figure and the total leaves the record out. */
  ledger: boolean;
  indicator: IndicatorCode | null;
  total: 'SUM' | 'RATIO' | 'MAX' | 'MIN' | null;
}

const col = (key: string, kind: ColumnKind, extra: Partial<Omit<RegisterColumn, 'key' | 'kind'>> = {}): RegisterColumn => ({ key, kind, ledger: false, indicator: null, total: null, ...extra });
const sum = (key: string, kind: ColumnKind = 'COUNT', extra: Partial<Omit<RegisterColumn, 'key' | 'kind'>> = {}): RegisterColumn => col(key, kind, { total: 'SUM', ...extra });
const ledgerMoney = (key: string): RegisterColumn => sum(key, 'MONEY', { ledger: true });
const ratio = (key: string, kind: ColumnKind, indicator: IndicatorCode, extra: Partial<Omit<RegisterColumn, 'key' | 'kind'>> = {}): RegisterColumn => col(key, kind, { total: 'RATIO', indicator, ...extra });

const identity = (first: string, withTitle: boolean): RegisterColumn[] => [
  col(first, 'TEXT'),
  col('contract_code', 'TEXT'),
  ...(withTitle ? [col('record_title', 'TEXT')] : []),
  col('project_code', 'TEXT'),
  col('contractor_name', 'TEXT'),
  col('unit_name', 'TEXT'),
  col('contract_status', 'TEXT'),
];

const CONTRACT_IDENTITY: RegisterColumn[] = [col('code', 'TEXT'), col('title', 'TEXT'), col('project_code', 'TEXT'), col('contractor_name', 'TEXT'), col('unit_name', 'TEXT'), col('contract_status', 'TEXT')];

export const REGISTER_COLUMNS: Readonly<Record<RegisterReportCode, readonly RegisterColumn[]>> = {
  'claims-limitation': [
    ...identity('claim_code', true),
    col('claim_source', 'TEXT'),
    col('claim_kind', 'TEXT'),
    col('claim_status', 'TEXT'),
    col('filed_on', 'DATE'),
    col('age_days', 'DAYS', { total: 'MAX' }),
    sum('claimed_amount_vnd', 'MONEY'),
    sum('granted_amount_vnd', 'MONEY'),
    sum('claimed_days', 'DAYS'),
    sum('granted_days', 'DAYS'),
    ratio('settlement_pct', 'PERCENT', 'CLAIM_SETTLEMENT_RATE'),
    col('limitation_on', 'DATE'),
    col('limitation_status', 'TEXT'),
    col('limitation_days_left', 'DAYS', { total: 'MIN' }),
    ratio('limitation_risk', 'FLAG', 'CLAIM_LIMITATION_RISK'),
  ],
  'quality-defects': [
    ...identity('ncr_no', true),
    col('severity', 'TEXT'),
    col('ncr_status', 'TEXT'),
    col('detected_on', 'DATE'),
    col('due_on', 'DATE'),
    col('age_days', 'DAYS', { total: 'MAX' }),
    col('days_overdue', 'DAYS', { total: 'MAX' }),
    sum('reopen_count'),
    col('blocks_acceptance', 'FLAG'),
    ratio('closed', 'FLAG', 'DEFECT_CLOSURE_RATE'),
    ratio('overdue', 'FLAG', 'DEFECT_OVERDUE_RATE'),
    ratio('reopened', 'FLAG', 'DEFECT_REOPEN_RATE'),
  ],
  obstacles: [
    ...identity('issue_code', true),
    col('severity', 'TEXT'),
    col('issue_status', 'TEXT'),
    col('source_module', 'TEXT'),
    col('opened_on', 'DATE'),
    col('due_on', 'DATE'),
    col('age_days', 'DAYS', { total: 'MAX' }),
    col('days_overdue', 'DAYS', { total: 'MAX' }),
    col('escalation_level', 'COUNT', { total: 'MAX' }),
    sum('extension_count'),
    sum('reopen_count'),
    ratio('overdue', 'FLAG', 'OBSTACLE_OVERDUE_RATE'),
    ratio('escalated', 'FLAG', 'OBSTACLE_ESCALATION_RATE'),
  ],
  'audit-findings': [
    ...identity('finding_code', false),
    col('finding_category', 'TEXT'),
    col('severity', 'TEXT'),
    col('engagement_code', 'TEXT'),
    ledgerMoney('finding_amount_vnd'),
    ledgerMoney('recommended_vnd'),
    ledgerMoney('recovered_vnd'),
    ledgerMoney('outstanding_vnd'),
    ratio('recovery_pct', 'PERCENT', 'AUDIT_RECOVERY_RATE', { ledger: true }),
    sum('recommendation_count'),
    sum('open_recommendation_count'),
    sum('overdue_recommendation_count'),
    ratio('overdue_recommendation_pct', 'PERCENT', 'AUDIT_OVERDUE_RECOMMENDATION_RATE'),
  ],
  'performance-rating': [
    ...CONTRACT_IDENTITY,
    col('rating_kind', 'TEXT'),
    col('score_quality', 'INDEX'),
    col('score_schedule', 'INDEX'),
    col('score_safety_env', 'INDEX'),
    col('score_cooperation', 'INDEX'),
    col('score_financial', 'INDEX'),
    col('overall_score', 'INDEX'),
    col('proposed_rating', 'TEXT'),
    col('criteria_covered', 'COUNT'),
    ratio('scored', 'FLAG', 'RATING_COVERAGE'),
    col('rating_status', 'TEXT'),
    col('response_due_on', 'DATE'),
    col('response_days_left', 'DAYS', { total: 'MIN' }),
    ratio('responded_in_time', 'FLAG', 'RATING_RESPONSE_RATE'),
    col('official_rating', 'TEXT'),
    col('official_score', 'INDEX'),
  ],
  'contract-health': [
    ...CONTRACT_IDENTITY,
    col('health', 'RAG'),
    col('health_driver', 'TEXT'),
    col('days_late', 'DAYS', { total: 'MAX', indicator: 'DAYS_LATE' }),
    ratio('change_growth_pct', 'PERCENT', 'CHANGE_GROWTH'),
    ratio('guarantee_coverage_pct', 'PERCENT', 'GUARANTEE_COVERAGE'),
    ratio('paid_to_accepted_pct', 'PERCENT', 'PAID_TO_ACCEPTED', { ledger: true }),
    sum('open_ncr_count'),
    col('project_open_issue_count', 'COUNT'),
    ratio('red', 'FLAG', 'CONTRACT_RED_SHARE'),
  ],
};

/** The reports of the register catalogue: the reference in the plan, the groups it is broken down by, the indicators it states. */
export const REGISTER_CATALOGUE: Readonly<Record<RegisterReportCode, { ref: string; breakdowns: readonly string[]; indicators: readonly IndicatorCode[]; severityColumn: string | null; stateColumn: string | null; idColumn: string }>> = {
  'claims-limitation': { ref: 'R8', breakdowns: ['claim_status', 'limitation_status'], indicators: ['CLAIM_SETTLEMENT_RATE', 'CLAIM_LIMITATION_RISK'], severityColumn: null, stateColumn: 'claim_status', idColumn: 'claim_code' },
  'quality-defects': { ref: 'R9', breakdowns: ['severity', 'ncr_status'], indicators: ['DEFECT_CLOSURE_RATE', 'DEFECT_OVERDUE_RATE', 'DEFECT_REOPEN_RATE'], severityColumn: 'severity', stateColumn: 'ncr_status', idColumn: 'ncr_no' },
  obstacles: { ref: 'R10', breakdowns: ['severity', 'issue_status'], indicators: ['OBSTACLE_OVERDUE_RATE', 'OBSTACLE_ESCALATION_RATE'], severityColumn: 'severity', stateColumn: 'issue_status', idColumn: 'issue_code' },
  'audit-findings': { ref: 'R11', breakdowns: ['severity', 'finding_category'], indicators: ['AUDIT_RECOVERY_RATE', 'AUDIT_OVERDUE_RECOMMENDATION_RATE'], severityColumn: 'severity', stateColumn: null, idColumn: 'finding_code' },
  'performance-rating': { ref: 'R13', breakdowns: ['proposed_rating', 'rating_status'], indicators: ['RATING_COVERAGE', 'RATING_RESPONSE_RATE'], severityColumn: null, stateColumn: 'rating_status', idColumn: 'code' },
  'contract-health': { ref: 'R16', breakdowns: ['health', 'contract_status'], indicators: ['CONTRACT_RED_SHARE', 'DAYS_LATE', 'CHANGE_GROWTH', 'GUARANTEE_COVERAGE', 'PAID_TO_ACCEPTED'], severityColumn: null, stateColumn: null, idColumn: 'code' },
};

export const indicatorsOfRegisterColumn = (report: RegisterReportCode, key: string): IndicatorCode | null => REGISTER_COLUMNS[report].find((column) => column.key === key)?.indicator ?? null;

// ---- the records ------------------------------------------------------------------------------------------------------------------------------------------------

/** The contract a record belongs to, with the names a person reads; `ledgerOk` says whether the reader holds `ledger.read` over it. */
export interface RegisterContract {
  id: string;
  code: string;
  title: string | null;
  projectCode: string;
  contractorName: string | null;
  unitName: string;
  status: string;
  ledgerOk: boolean;
}

export interface RatioPart {
  num: bigint;
  den: bigint;
}

/** One row of a register report: the cells, why a cell is empty, and what each ratio column is made of (the totals add these, never the cells). */
export interface RegisterRow {
  id: string;
  contractId: string;
  cells: Record<string, CellValue>;
  na: Record<string, string>;
  parts: Record<string, RatioPart>;
  /** The group of the row in each breakdown. */
  groups: Record<string, string>;
  ledgerOk: boolean;
  health?: ContractHealth | undefined;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;

function dayNumber(value: string, field: string): number {
  const found = DAY.exec(value);
  if (found === null) throw new DomainError('VALIDATION_FAILED', 422, field);
  return Math.round(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])) / 86_400_000);
}

export function addDays(day: string, days: number): string {
  return new Date((dayNumber(day, 'day') + days) * 86_400_000).toISOString().slice(0, 10);
}

const between = (from: string, to: string): number => dayNumber(to, 'to') - dayNumber(from, 'from');
const dayOf = (value: string | null): string | null => (value === null ? null : value.slice(0, 10));

function newRow(contract: RegisterContract, id: string): RegisterRow {
  return { id, contractId: contract.id, cells: {}, na: {}, parts: {}, groups: {}, ledgerOk: contract.ledgerOk };
}

function put(row: RegisterRow, key: string, value: CellValue, reason: string | null = null): void {
  row.cells[key] = value;
  if (value === null && reason !== null) row.na[key] = reason;
}

function putIdentity(row: RegisterRow, contract: RegisterContract, first: string, firstValue: string, title: string | null | undefined): void {
  put(row, first, firstValue);
  put(row, 'contract_code', contract.code);
  if (title !== undefined) put(row, 'record_title', title);
  put(row, 'project_code', contract.projectCode);
  put(row, 'contractor_name', contract.contractorName);
  put(row, 'unit_name', contract.unitName);
  put(row, 'contract_status', contract.status);
}

function putContractIdentity(row: RegisterRow, contract: RegisterContract): void {
  put(row, 'code', contract.code);
  put(row, 'title', contract.title);
  put(row, 'project_code', contract.projectCode);
  put(row, 'contractor_name', contract.contractorName);
  put(row, 'unit_name', contract.unitName);
  put(row, 'contract_status', contract.status);
}

/** A flag column: 1 or 0 and the part it adds to its ratio; or empty with the reason. */
function putFlag(row: RegisterRow, key: string, flag: boolean | null, reason: string): void {
  if (flag === null) {
    put(row, key, null, reason);
    return;
  }
  put(row, key, flag ? 1 : 0);
  row.parts[key] = { num: flag ? 1n : 0n, den: 1n };
}

function putPercent(row: RegisterRow, key: string, part: RatioPart | null, reason: string): void {
  if (part === null || part.den === 0n) {
    put(row, key, null, reason);
    return;
  }
  put(row, key, analyticsPercent(part.num, part.den));
  row.parts[key] = part;
}

const big = (value: string | null): bigint => (value === null ? 0n : BigInt(value));

// ---- claims and limitation ----------------------------------------------------------------------------------------------------------------------------------------

export const CLAIM_LIMITATION_RULE = 'CONTRACT_CLAIM_LIMITATION';

/** The params of the rule `CONTRACT_CLAIM_LIMITATION`: the days a variation or a claim may wait for a decision, and how many days before its limitation day it is "near". Provisional, not law (unverified until a lawyer signs). */
export interface ClaimLimitationParams {
  decision_window_days: number;
  near_days: number;
}

export const claimLimitationDefaults = (): ClaimLimitationParams => ({ decision_window_days: 28, near_days: 7 });

export function claimLimitationParams(raw: unknown): ClaimLimitationParams {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('params');
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== 'decision_window_days' && key !== 'near_days') throw bad(key);
  const window = record.decision_window_days;
  const near = record.near_days;
  if (typeof window !== 'number' || !Number.isInteger(window) || window < 1 || window > 3650) throw bad('decision_window_days');
  if (typeof near !== 'number' || !Number.isInteger(near) || near < 0 || near > 365) throw bad('near_days');
  return { decision_window_days: window, near_days: near };
}

export type ClaimState = 'OPEN' | 'GRANTED' | 'PARTLY_GRANTED' | 'REJECTED' | 'WITHDRAWN';
export type ClaimLimitation = { basis: 'WARRANTY_END'; on: string } | { basis: 'CLAIM_TERM'; on: string } | { basis: 'DECISION_WINDOW'; startOn: string } | null;

/** A claim in its normal form: whatever register it comes from (variation events, warranty claims, the claim register of GOV-8) is mapped to this and judged by the same functions. */
export interface ClaimRecord {
  id: string;
  contract: RegisterContract;
  source: string;
  code: string;
  kind: string;
  title: string | null;
  state: ClaimState;
  filedOn: string | null;
  decidedOn: string | null;
  claimedAmountVnd: string | null;
  grantedAmountVnd: string | null;
  claimedDays: number | null;
  grantedDays: number | null;
  limitation: ClaimLimitation;
}

export type LimitationStatus = 'IN_TIME' | 'OUT_OF_TIME' | 'RUNNING' | 'NEAR' | 'LAPSED' | 'NOT_JUDGED';

/** The limitation day of a claim, and where the claim stands against it on the as-of day. A claim that is filed late or decided late stays so; an open one runs, comes near, and lapses. */
export function limitationOf(record: Pick<ClaimRecord, 'state' | 'filedOn' | 'decidedOn' | 'limitation'>, asOf: string, params: ClaimLimitationParams): { on: string | null; status: LimitationStatus; daysLeft: number | null } {
  const term = record.limitation;
  if (term === null) return { on: null, status: 'NOT_JUDGED', daysLeft: null };
  const on = term.basis === 'DECISION_WINDOW' ? addDays(term.startOn, params.decision_window_days) : term.on;
  if (term.basis === 'WARRANTY_END') {
    if (record.filedOn === null) return { on, status: 'NOT_JUDGED', daysLeft: null };
    return { on, status: record.filedOn <= on ? 'IN_TIME' : 'OUT_OF_TIME', daysLeft: null };
  }
  if (record.state !== 'OPEN') {
    const decided = record.decidedOn ?? asOf;
    return { on, status: decided <= on ? 'IN_TIME' : 'OUT_OF_TIME', daysLeft: null };
  }
  if (asOf > on) return { on, status: 'LAPSED', daysLeft: null };
  const left = between(asOf, on);
  return { on, status: left <= params.near_days ? 'NEAR' : 'RUNNING', daysLeft: left };
}

export function claimRow(record: ClaimRecord, asOf: string, params: ClaimLimitationParams): RegisterRow {
  const row = newRow(record.contract, record.id);
  putIdentity(row, record.contract, 'claim_code', record.code, record.title);
  put(row, 'claim_source', record.source);
  put(row, 'claim_kind', record.kind);
  put(row, 'claim_status', record.state);
  put(row, 'filed_on', record.filedOn, 'NO_DATE');
  put(row, 'age_days', record.filedOn === null ? null : Math.max(0, between(record.filedOn, record.state === 'OPEN' ? asOf : (record.decidedOn ?? asOf))), 'NO_DATE');
  put(row, 'claimed_amount_vnd', record.claimedAmountVnd, 'NO_AMOUNT_CLAIMED');
  put(row, 'granted_amount_vnd', record.state === 'OPEN' ? null : record.grantedAmountVnd, record.state === 'OPEN' ? 'NOT_DECIDED' : 'NO_AMOUNT_CLAIMED');
  put(row, 'claimed_days', record.claimedDays, 'NO_AMOUNT_CLAIMED');
  put(row, 'granted_days', record.state === 'OPEN' ? null : record.grantedDays, record.state === 'OPEN' ? 'NOT_DECIDED' : 'NO_AMOUNT_CLAIMED');
  const decided = record.state !== 'OPEN' && record.state !== 'WITHDRAWN';
  const money = decided && record.claimedAmountVnd !== null && big(record.claimedAmountVnd) > 0n;
  putPercent(row, 'settlement_pct', money ? { num: big(record.state === 'REJECTED' ? '0' : record.grantedAmountVnd), den: big(record.claimedAmountVnd) } : null, decided ? 'NO_AMOUNT_CLAIMED' : 'NOT_DECIDED');
  const limit = limitationOf(record, asOf, params);
  put(row, 'limitation_on', limit.on, 'NO_LIMITATION_TERM');
  put(row, 'limitation_status', limit.status);
  put(row, 'limitation_days_left', limit.daysLeft, limit.status === 'NOT_JUDGED' ? 'NO_LIMITATION_TERM' : limit.status === 'LAPSED' ? 'LIMITATION_PASSED' : 'NOT_OPEN');
  const judged = record.state === 'OPEN' && limit.status !== 'NOT_JUDGED';
  putFlag(row, 'limitation_risk', judged ? limit.status === 'NEAR' || limit.status === 'LAPSED' : null, record.state !== 'OPEN' ? 'NOT_OPEN' : 'NO_LIMITATION_TERM');
  row.groups.claim_status = record.state;
  row.groups.limitation_status = limit.status;
  return row;
}

// ---- quality defects ----------------------------------------------------------------------------------------------------------------------------------------------

export interface DefectRecord {
  id: string;
  contract: RegisterContract;
  ncrNo: string;
  title: string | null;
  severity: string;
  status: string;
  detectedOn: string | null;
  dueOn: string | null;
  closedOn: string | null;
  reopenCount: number;
  blocksAcceptance: boolean;
}

export const defectIsOpen = (status: string): boolean => status !== 'VERIFIED' && status !== 'CLOSED';

export function defectRow(record: DefectRecord, asOf: string): RegisterRow {
  const row = newRow(record.contract, record.id);
  putIdentity(row, record.contract, 'ncr_no', record.ncrNo, record.title);
  const open = defectIsOpen(record.status);
  put(row, 'severity', record.severity);
  put(row, 'ncr_status', record.status);
  put(row, 'detected_on', record.detectedOn, 'NO_DATE');
  put(row, 'due_on', record.dueOn, 'NO_DUE_DAY');
  put(row, 'age_days', record.detectedOn === null ? null : Math.max(0, between(record.detectedOn, open ? asOf : (record.closedOn ?? asOf))), 'NO_DATE');
  const overdue = open && record.dueOn !== null ? record.dueOn < asOf : null;
  put(row, 'days_overdue', open && record.dueOn !== null ? Math.max(0, between(record.dueOn, asOf)) : null, open ? 'NO_DUE_DAY' : 'NOT_OPEN');
  put(row, 'reopen_count', record.reopenCount);
  put(row, 'blocks_acceptance', record.blocksAcceptance ? 1 : 0);
  putFlag(row, 'closed', !open, 'NO_DEFECT');
  putFlag(row, 'overdue', overdue, open ? 'NO_DUE_DAY' : 'NOT_OPEN');
  putFlag(row, 'reopened', record.reopenCount > 0, 'NO_DEFECT');
  row.groups.severity = record.severity;
  row.groups.ncr_status = record.status;
  return row;
}

// ---- obstacles --------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ObstacleRecord {
  id: string;
  contract: RegisterContract;
  code: string;
  title: string | null;
  severity: string;
  status: string;
  sourceModule: string | null;
  openedOn: string | null;
  dueOn: string | null;
  closedOn: string | null;
  escalationLevel: number;
  extensionCount: number;
  reopenCount: number;
}

export const obstacleIsOpen = (status: string): boolean => status !== 'CLOSED';

export function obstacleRow(record: ObstacleRecord, asOf: string): RegisterRow {
  const row = newRow(record.contract, record.id);
  putIdentity(row, record.contract, 'issue_code', record.code, record.title);
  const open = obstacleIsOpen(record.status);
  put(row, 'severity', record.severity);
  put(row, 'issue_status', record.status);
  put(row, 'source_module', record.sourceModule, 'NO_DATE');
  put(row, 'opened_on', record.openedOn, 'NO_DATE');
  put(row, 'due_on', record.dueOn, 'NO_DUE_DAY');
  put(row, 'age_days', record.openedOn === null ? null : Math.max(0, between(record.openedOn, open ? asOf : (record.closedOn ?? asOf))), 'NO_DATE');
  put(row, 'days_overdue', open && record.dueOn !== null ? Math.max(0, between(record.dueOn, asOf)) : null, open ? 'NO_DUE_DAY' : 'NOT_OPEN');
  put(row, 'escalation_level', record.escalationLevel);
  put(row, 'extension_count', record.extensionCount);
  put(row, 'reopen_count', record.reopenCount);
  putFlag(row, 'overdue', open && record.dueOn !== null ? record.dueOn < asOf : null, open ? 'NO_DUE_DAY' : 'NOT_OPEN');
  putFlag(row, 'escalated', open ? record.escalationLevel > 0 : null, 'NOT_OPEN');
  row.groups.severity = record.severity;
  row.groups.issue_status = record.status;
  return row;
}

// ---- audit findings ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface FindingRecord {
  id: string;
  contract: RegisterContract;
  findingCode: string;
  category: string;
  severity: string | null;
  engagementCode: string;
  amountVnd: string | null;
  /** Of the financial recommendations of the finding: what was asked to be recovered and what was. */
  recommendedVnd: string;
  recoveredVnd: string;
  financialRecommendationCount: number;
  recommendationCount: number;
  openRecommendationCount: number;
  overdueRecommendationCount: number;
}

export function findingRow(record: FindingRecord): RegisterRow {
  const row = newRow(record.contract, record.id);
  putIdentity(row, record.contract, 'finding_code', record.findingCode, undefined);
  put(row, 'finding_category', record.category);
  put(row, 'severity', record.severity, 'NO_DATE');
  put(row, 'engagement_code', record.engagementCode);
  const visible = record.contract.ledgerOk;
  const hidden = (key: string): void => put(row, key, null, 'LEDGER_DENIED');
  const financial = record.financialRecommendationCount > 0;
  if (!visible) {
    for (const key of ['finding_amount_vnd', 'recommended_vnd', 'recovered_vnd', 'outstanding_vnd', 'recovery_pct']) hidden(key);
  } else {
    put(row, 'finding_amount_vnd', record.amountVnd, 'NO_AMOUNT_CLAIMED');
    put(row, 'recommended_vnd', financial ? record.recommendedVnd : null, 'NO_FINANCIAL_RECOMMENDATION');
    put(row, 'recovered_vnd', financial ? record.recoveredVnd : null, 'NO_FINANCIAL_RECOMMENDATION');
    put(row, 'outstanding_vnd', financial ? (big(record.recommendedVnd) - big(record.recoveredVnd)).toString() : null, 'NO_FINANCIAL_RECOMMENDATION');
    putPercent(row, 'recovery_pct', financial ? { num: big(record.recoveredVnd), den: big(record.recommendedVnd) } : null, 'NO_FINANCIAL_RECOMMENDATION');
  }
  put(row, 'recommendation_count', record.recommendationCount);
  put(row, 'open_recommendation_count', record.openRecommendationCount);
  put(row, 'overdue_recommendation_count', record.overdueRecommendationCount);
  putPercent(row, 'overdue_recommendation_pct', record.openRecommendationCount > 0 ? { num: BigInt(record.overdueRecommendationCount), den: BigInt(record.openRecommendationCount) } : null, 'NO_OPEN_RECOMMENDATION');
  row.groups.severity = record.severity ?? 'UNKNOWN';
  row.groups.finding_category = record.category;
  return row;
}

// ---- the health of the contract ---------------------------------------------------------------------------------------------------------------------------------

export function healthRow(fact: ContractFact, contract: RegisterContract, asOf: string, ragParams: unknown): RegisterRow {
  const row = newRow(contract, fact.id);
  putContractIdentity(row, contract);
  // The colour reads the ledger (paid over accepted): a reader who may not see it is shown the colour of what they may see.
  const seen = fact.ledgerOk ? fact : { ...fact, requestedVnd: '0', acceptedVnd: '0', paidVnd: '0' };
  const health = healthOfFact(seen, asOf, ragParams);
  const found = indicatorsOfFact(fact);
  const late = daysLateOfFact(fact, asOf);
  row.health = health;
  put(row, 'health', health.level, 'NO_COLOURED_CONTRACT');
  put(row, 'health_driver', health.drivers[0] ?? null, health.level === null ? 'NO_COLOURED_CONTRACT' : 'NOT_OPEN');
  put(row, 'days_late', late.value, late.reason);
  putPercent(row, 'change_growth_pct', found.growth.status === 'OK' ? { num: big(found.growth.numerator), den: big(found.growth.denominator) } : null, 'ZERO_DENOMINATOR');
  putPercent(row, 'guarantee_coverage_pct', found.guarantee.status === 'OK' ? { num: big(found.guarantee.numerator), den: big(found.guarantee.denominator) } : null, 'NO_GUARANTEE_REQUIRED');
  if (fact.ledgerOk) putPercent(row, 'paid_to_accepted_pct', found.paidToAccepted.status === 'OK' ? { num: big(found.paidToAccepted.numerator), den: big(found.paidToAccepted.denominator) } : null, 'ZERO_DENOMINATOR');
  else put(row, 'paid_to_accepted_pct', null, 'LEDGER_DENIED');
  put(row, 'open_ncr_count', fact.openNcrCount);
  put(row, 'project_open_issue_count', fact.projectOpenIssueCount);
  putFlag(row, 'red', health.level === null ? null : health.level === 'RED', 'NO_COLOURED_CONTRACT');
  row.groups.health = health.level ?? 'NONE';
  row.groups.contract_status = contract.status;
  return row;
}

// ---- totals, breakdowns, order and pages ------------------------------------------------------------------------------------------------------------------

const ZERO_REASON: Readonly<Partial<Record<IndicatorCode, NotApplicableReason>>> = {
  CLAIM_SETTLEMENT_RATE: 'NO_DECIDED_CLAIM',
  CLAIM_LIMITATION_RISK: 'NO_OPEN_CLAIM',
  DEFECT_CLOSURE_RATE: 'NO_DEFECT',
  DEFECT_OVERDUE_RATE: 'NO_OPEN_DEFECT',
  DEFECT_REOPEN_RATE: 'NO_DEFECT',
  OBSTACLE_OVERDUE_RATE: 'NO_OPEN_OBSTACLE',
  OBSTACLE_ESCALATION_RATE: 'NO_OPEN_OBSTACLE',
  AUDIT_RECOVERY_RATE: 'NO_FINANCIAL_RECOMMENDATION',
  AUDIT_OVERDUE_RECOMMENDATION_RATE: 'NO_OPEN_RECOMMENDATION',
  RATING_COVERAGE: 'NO_RATABLE_CONTRACT',
  RATING_RESPONSE_RATE: 'NO_RESPONSE_JUDGED',
  CONTRACT_RED_SHARE: 'NO_COLOURED_CONTRACT',
  CHANGE_GROWTH: 'ZERO_DENOMINATOR',
  GUARANTEE_COVERAGE: 'NO_GUARANTEE_REQUIRED',
  PAID_TO_ACCEPTED: 'ZERO_DENOMINATOR',
};

const isNumeric = (kind: ColumnKind): boolean => kind === 'MONEY' || kind === 'COUNT' || kind === 'DAYS';

/** The totals row of a list of rows, made from the very rows: sums are the sums of the cells, the largest and the smallest are of the cells, a ratio is of the sums of its parts. A column nobody may see says so. */
export function registerTotals(code: RegisterReportCode, rows: readonly RegisterRow[]): ReportTotals {
  const cells: Record<string, CellValue> = {};
  const na: Record<string, string> = {};
  const indicators: IndicatorResult[] = [];
  const ledgerless = rows.length > 0 && rows.every((row) => !row.ledgerOk);
  for (const column of REGISTER_COLUMNS[code]) {
    if (column.total === null) continue;
    const key = column.key;
    const present = rows.filter((row) => row.cells[key] !== null && row.cells[key] !== undefined);
    const empty = (reason: string): void => {
      cells[key] = null;
      na[key] = reason;
    };
    if (column.ledger && ledgerless) {
      empty('LEDGER_DENIED');
      continue;
    }
    if (column.total === 'RATIO') {
      const num = rows.reduce((acc, row) => acc + (row.parts[key]?.num ?? 0n), 0n);
      const den = rows.reduce((acc, row) => acc + (row.parts[key]?.den ?? 0n), 0n);
      const indicator = column.indicator as IndicatorCode;
      const result = indicatorRatio(indicator, num, den, ZERO_REASON[indicator] ?? 'ZERO_DENOMINATOR');
      cells[key] = result.value;
      if (result.value === null && result.reason !== null) na[key] = result.reason;
      indicators.push(result);
      continue;
    }
    if (present.length === 0) {
      empty(rows.length === 0 ? 'NO_ROWS' : (rows.map((row) => row.na[key]).find((reason) => reason !== undefined) ?? 'NO_ROWS'));
      continue;
    }
    if (column.kind === 'MONEY') {
      cells[key] = present.reduce((acc, row) => acc + BigInt(String(row.cells[key])), 0n).toString();
      continue;
    }
    const numbers = present.map((row) => Number(row.cells[key]));
    cells[key] = column.total === 'SUM' ? numbers.reduce((a, b) => a + b, 0) : column.total === 'MAX' ? Math.max(...numbers) : Math.min(...numbers);
  }
  return { rows: rows.length, ledgerRows: rows.filter((row) => row.ledgerOk).length, cells, na: na as ReportTotals['na'], indicators };
}

export interface RegisterBreakdown {
  dimension: string;
  groups: Array<{ key: string; totals: ReportTotals }>;
}

const GROUP_ORDER: Readonly<Record<string, readonly string[]>> = {
  claim_status: ['OPEN', 'GRANTED', 'PARTLY_GRANTED', 'REJECTED', 'WITHDRAWN'],
  limitation_status: ['LAPSED', 'NEAR', 'RUNNING', 'OUT_OF_TIME', 'IN_TIME', 'NOT_JUDGED'],
  severity: ['CRITICAL', 'HIGH', 'MAJOR', 'MEDIUM', 'MINOR', 'LOW', 'UNKNOWN'],
  ncr_status: ['OPEN', 'REOPENED', 'ACTION_ASSIGNED', 'ACTION_SUBMITTED', 'VERIFIED', 'CLOSED'],
  proposed_rating: ['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'NONE'],
  rating_status: ['NONE', 'PROPOSED', 'NOTIFIED', 'RESPONDED', 'ADOPTED', 'WITHDRAWN'],
  health: ['RED', 'AMBER', 'GREEN', 'NONE'],
};

/** Every breakdown of a report: the groups that have rows, in the order the dimension has, then by key; the totals of a group are made from its own rows by the same function as the total. */
export function registerBreakdowns(code: RegisterReportCode, rows: readonly RegisterRow[]): RegisterBreakdown[] {
  return REGISTER_CATALOGUE[code].breakdowns.map((dimension) => {
    const keys = [...new Set(rows.map((row) => row.groups[dimension] ?? 'NONE'))];
    const order = GROUP_ORDER[dimension] ?? [];
    keys.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return ia !== -1 || ib !== -1 ? (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) : a < b ? -1 : a > b ? 1 : 0;
    });
    return { dimension, groups: keys.map((key) => ({ key, totals: registerTotals(code, rows.filter((row) => (row.groups[dimension] ?? 'NONE') === key)) })) };
  });
}

function compareCells(kind: ColumnKind, a: CellValue, b: CellValue): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  if (kind === 'MONEY') return BigInt(String(a)) === BigInt(String(b)) ? 0 : BigInt(String(a)) < BigInt(String(b)) ? -1 : 1;
  if (isNumeric(kind) || kind === 'PERCENT' || kind === 'INDEX' || kind === 'FLAG') return Number(a) === Number(b) ? 0 : Number(a) < Number(b) ? -1 : 1;
  return String(a) === String(b) ? 0 : String(a) < String(b) ? -1 : 1;
}

export interface RegisterPageRequest {
  sort: string;
  direction: 'asc' | 'desc';
  limit: number;
  after?: { value: string; id: string } | undefined;
}

/** The sort keys of a report: its own columns (a missing figure sorts first, then by id, so the order is the same on every run). */
export const registerSortKeys = (code: RegisterReportCode): string[] => REGISTER_COLUMNS[code].map((column) => column.key);

export function sortRegisterRows(code: RegisterReportCode, rows: readonly RegisterRow[], sort: string, direction: 'asc' | 'desc'): RegisterRow[] {
  const column = REGISTER_COLUMNS[code].find((one) => one.key === sort);
  if (column === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'sort');
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => factor * compareCells(column.kind, a.cells[sort] ?? null, b.cells[sort] ?? null) || factor * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The text of the sort cell of a row, the value a cursor carries (empty for a missing figure). */
export const cursorValueOf = (row: RegisterRow, sort: string): string => String(row.cells[sort] ?? '');

/** One page of sorted rows: the rows after the cursor (keyset on the sort cell and the id), and whether more follow. */
export function registerPage(code: RegisterReportCode, sorted: readonly RegisterRow[], request: RegisterPageRequest): { items: RegisterRow[]; more: boolean } {
  const column = REGISTER_COLUMNS[code].find((one) => one.key === request.sort);
  if (column === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'sort');
  const factor = request.direction === 'asc' ? 1 : -1;
  const after = request.after;
  const start =
    after === undefined
      ? 0
      : sorted.findIndex((row) => {
          const value = row.cells[request.sort] ?? null;
          const cursor: CellValue = after.value === '' ? null : after.value;
          const order = factor * compareCells(column.kind, value, cursor) || factor * (row.id < after.id ? -1 : row.id > after.id ? 1 : 0);
          return order > 0;
        });
  if (start === -1) return { items: [], more: false };
  const items = sorted.slice(start, start + request.limit);
  return { items, more: start + request.limit < sorted.length };
}

/** The rows that match the filters of a register report (the contract filters were applied by the database): the severity and the state of the record, both lists of words. */
export function filterRegisterRows(code: RegisterReportCode, rows: readonly RegisterRow[], filter: { severity?: readonly string[] | undefined; state?: readonly string[] | undefined }): RegisterRow[] {
  const catalogue = REGISTER_CATALOGUE[code];
  return rows.filter((row) => {
    if (filter.severity !== undefined && (catalogue.severityColumn === null || !filter.severity.includes(String(row.cells[catalogue.severityColumn] ?? '')))) return false;
    if (filter.state !== undefined && (catalogue.stateColumn === null || !filter.state.includes(String(row.cells[catalogue.stateColumn] ?? '')))) return false;
    return true;
  });
}

// ---- the file of a register report -----------------------------------------------------------------------------------------------------------------------

export interface RegisterDocumentInput {
  code: RegisterReportCode;
  scopeDescription: string;
  periodLabel: string;
  asOf: string;
  cutoffDate: string;
  snapshotId: string;
  snapshotRevision: string;
  stale: boolean;
  generatedAt: Date;
  filterText: string;
  rows: readonly RegisterRow[];
  totals: ReportTotals;
}

const TEXT_KINDS: readonly ColumnKind[] = ['TEXT', 'DATE', 'RAG'];
const WORDED = new Set(['claim_source', 'claim_kind', 'claim_status', 'limitation_status', 'severity', 'ncr_status', 'issue_status', 'source_module', 'rating_kind', 'proposed_rating', 'rating_status', 'official_rating', 'health', 'health_driver']);

/** The word of a code in a file: a file is read by people who were not given the list of codes (a code with no word is written as it is). */
function fileCell(column: RegisterColumn, value: CellValue): string {
  if (value === null) return '';
  const text = String(value);
  if (column.kind === 'FLAG') return text === '1' ? message('ctr.report.flag.yes') : message('ctr.report.flag.no');
  if (!WORDED.has(column.key)) return text;
  return messagesUnder(`ctr.report.value.${column.key}`)[text] ?? text;
}

/** The document of a register report for CSV, XLSX and PDF: the header says what the figures are (scope, day, unit, freshness), the table has the totals row, an absent figure is an empty cell. */
export function registerDocumentOf(input: RegisterDocumentInput): ExportDocument {
  const columns = REGISTER_COLUMNS[input.code];
  const entry = (key: string, text: string): ExportHeaderEntry => ({ key, label: message(`ctr.report.header.${key}`), value: text });
  const exportColumns: ExportColumn[] = columns.map((column) => ({ key: column.key, label: message(`ctr.report.column.${column.key}`), numeric: !TEXT_KINDS.includes(column.kind) }));
  const rows = input.rows.map((row) => columns.map((column) => fileCell(column, row.cells[column.key] ?? null)));
  rows.push(columns.map((column, index) => (index === 0 ? message('ctr.report.total_label') : column.total === null ? '' : fileCell(column, input.totals.cells[column.key] ?? null))));
  const title = message(`ctr.report.title.${input.code}`);
  return {
    title,
    header: [
      entry('report', `${REGISTER_CATALOGUE[input.code].ref} ${title}`),
      entry('scope', input.scopeDescription),
      entry('period', input.periodLabel),
      entry('as_of', input.asOf),
      entry('cutoff_date', input.cutoffDate),
      entry('currency_unit', 'VND'),
      entry('snapshot_id', input.snapshotId),
      entry('snapshot_revision', input.snapshotRevision),
      entry('freshness', message(input.stale ? 'ctr.report.freshness.stale' : input.snapshotId === '' ? 'ctr.report.freshness.live' : 'ctr.report.freshness.latest')),
      entry('filters', input.filterText),
      entry('generated_at', input.generatedAt.toISOString()),
      entry('row_count', String(input.rows.length)),
    ],
    columns: exportColumns,
    rows,
    notice: null,
  };
}

/** The meaning of an indicator for the "i" of a screen: the one definition. */
export const registerIndicatorDefinition = (code: IndicatorCode): (typeof CTR_INDICATORS)[IndicatorCode] => CTR_INDICATORS[code];

export { dayOf as registerDayOf };

/** The building blocks of a row, for the reports that are built in other files (the rating of the contractor). */
export { newRow as newRegisterRow, put as putRegisterCell, putContractIdentity as putRegisterContractIdentity, putFlag as putRegisterFlag };
