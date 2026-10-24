import { ApiError } from '@machvon/api-client';

/** The permissions that gate the buttons of the plan screens; the server decides again on every request. */
export const MANAGE_PLAN_PERMISSION = 'bid.plan.manage';
export const APPROVE_PLAN_PERMISSION = 'bid.plan.approve';

export const PACKAGES_PATH = '/bid/bid-03';
export const PLANS_PATH = '/bid/bid-15';
export const EDITOR_PATH = '/bid/bid-16';

export const PLAN_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED', 'CANCELLED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const SELECTION_METHODS = ['OPEN_BIDDING', 'LIMITED_BIDDING', 'DIRECT_APPOINTMENT', 'COMPETITIVE_QUOTATION', 'DIRECT_PURCHASE', 'SELF_EXECUTION', 'COMMUNITY_PARTICIPATION', 'SPECIAL_CASE'] as const;
export type SelectionMethod = (typeof SELECTION_METHODS)[number];
export const CONTRACT_TYPES = ['LUMP_SUM', 'FIXED_UNIT_PRICE', 'ADJUSTABLE_UNIT_PRICE', 'TIME_BASED', 'MIXED'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const BIDDING_FORMS = ['ONLINE', 'OFFLINE'] as const;
export type BiddingForm = (typeof BIDDING_FORMS)[number];
export const DECISIONS = ['APPROVE', 'RETURN', 'REJECT'] as const;
export type PlanDecision = (typeof DECISIONS)[number];
/** The stages of a project that take a procurement plan (the server refuses the others with PROJECT_STAGE_INVALID). */
export const PLANNABLE_STAGES: readonly string[] = ['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED'];

export const TITLE_MIN = 3;
export const TITLE_MAX = 500;
export const BASIS_MAX = 2000;
export const CODE_MAX = 50;
export const COMMENT_MAX = 2000;
export const MAX_DURATION = 3650;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(Q[1-4]|0[1-9]|1[0-2])$/;
const AMOUNT = /^[1-9]\d{0,23}$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <Value extends string>(list: readonly Value[], value: unknown): Value | undefined => list.find((candidate) => candidate === value);

export interface ProjectRef {
  id: string;
  code: string;
  name: string;
  status: string;
}

export interface LastDecision {
  decision: string;
  comment: string | null;
  decidedAt: string;
}

/** One line of the plans (BID-15). */
export interface PlanLine {
  id: string;
  project: ProjectRef;
  revision: number;
  title: string;
  legalBasis: string;
  totalVnd: string;
  status: PlanStatus;
  decisionSymbol: string | null;
  decisionIssuedOn: string | null;
  approvedAt: string | null;
  packageCount: number;
  lastDecision: LastDecision | null;
  version: number;
}

/** One line of the packages (BID-03, and the lines of BID-15 and BID-16). */
export interface PackageLine {
  id: string;
  code: string;
  title: string | null;
  project: ProjectRef;
  planId: string | null;
  planRevision: number | null;
  planStatus: PlanStatus | null;
  budgetVnd: string;
  method: string;
  contractType: ContractType | null;
  biddingForm: BiddingForm | null;
  allocationLineId: string | null;
  fundSourceLabel: string | null;
  plannedStartPeriod: string | null;
  durationDays: number | null;
  status: string;
}

/** A line of capital as the editor offers it as a suggestion: a published line of the project. */
export interface LineOption {
  id: string;
  projectId: string;
  label: string;
}

function toProject(raw: unknown): ProjectRef | undefined {
  const record = asRecord(raw);
  const id = text(record?.id);
  const code = text(record?.code);
  const name = text(record?.name);
  if (record === undefined || id === undefined || code === undefined || name === undefined) return undefined;
  return { id, code, name, status: text(record.status) ?? '' };
}

export function toProjectRef(raw: unknown): ProjectRef | undefined {
  return toProject(raw);
}

export function toPlanLine(raw: unknown): PlanLine | undefined {
  const record = asRecord(raw);
  const id = text(record?.id);
  const project = toProject(record?.project);
  const status = oneOf(PLAN_STATUSES, record?.status);
  const revision = whole(record?.revision);
  const version = whole(record?.version);
  const title = text(record?.title);
  const totalVnd = text(record?.total_value_vnd);
  if (record === undefined || id === undefined || project === undefined || status === undefined || revision === undefined || version === undefined || title === undefined || totalVnd === undefined) return undefined;
  const decision = asRecord(record.decision_document);
  const last = asRecord(record.last_decision);
  const lastKind = text(last?.decision);
  const lastAt = text(last?.decided_at);
  return {
    id,
    project,
    revision,
    title,
    legalBasis: text(record.legal_basis) ?? '',
    totalVnd,
    status,
    decisionSymbol: nullableText(decision?.symbol),
    decisionIssuedOn: nullableText(decision?.issued_on),
    approvedAt: nullableText(record.approved_at),
    packageCount: whole(record.package_count) ?? 0,
    lastDecision: lastKind === undefined || lastAt === undefined ? null : { decision: lastKind, comment: nullableText(last?.comment), decidedAt: lastAt },
    version,
  };
}

export function toPackageLine(raw: unknown): PackageLine | undefined {
  const record = asRecord(raw);
  const id = text(record?.id);
  const code = text(record?.code);
  const project = toProject(record?.project);
  const budgetVnd = text(record?.budget_vnd);
  if (record === undefined || id === undefined || code === undefined || project === undefined || budgetVnd === undefined) return undefined;
  const plan = asRecord(record.plan);
  const fund = asRecord(record.fund_source);
  return {
    id,
    code,
    title: nullableText(record.title),
    project,
    planId: nullableText(plan?.id),
    planRevision: whole(plan?.revision) ?? null,
    planStatus: oneOf(PLAN_STATUSES, plan?.status) ?? null,
    budgetVnd,
    method: text(record.method) ?? '',
    contractType: oneOf(CONTRACT_TYPES, record.contract_type) ?? null,
    biddingForm: oneOf(BIDDING_FORMS, record.bidding_form) ?? null,
    allocationLineId: nullableText(record.allocation_line_id),
    fundSourceLabel: nullableText(fund?.label),
    plannedStartPeriod: nullableText(record.planned_start_period),
    durationDays: whole(record.duration_days) ?? null,
    status: text(record.status) ?? '',
  };
}

/** A published line of capital from the read of the allocation lines; undefined for anything else. */
export function toLineOption(raw: unknown): LineOption | undefined {
  const record = asRecord(raw);
  const id = text(record?.id);
  const project = toProject(record?.project);
  const amount = text(record?.amount_vnd);
  if (record === undefined || id === undefined || project === undefined || amount === undefined || record.plan_status !== 'PUBLISHED') return undefined;
  const fund = asRecord(record.fund_source);
  return { id, projectId: project.id, label: `${text(fund?.label) ?? ''} ${whole(record.source_year) ?? ''} ${formatVnd(amount)}`.replace(/\s+/g, ' ').trim() };
}

/** Whole VND with thousands separators for the eye; the value that travels is always the exact digit string. */
export function formatVnd(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function planLink(id: string): string {
  return `${PLANS_PATH}?plan=${id}`;
}

export function reviseLink(planId: string): string {
  return `${EDITOR_PATH}?revise=${planId}`;
}

// ---- filtering --------------------------------------------------------------------------------------------------------

export interface PackageFilter {
  query: string;
  planStatus: PlanStatus | '';
}
export const EMPTY_PACKAGE_FILTER: PackageFilter = { query: '', planStatus: '' };

export function filterPackages(packages: readonly PackageLine[], filter: PackageFilter): PackageLine[] {
  const needle = filter.query.trim().toLowerCase();
  return packages.filter(
    (item) =>
      (needle === '' || `${item.code} ${item.title ?? ''} ${item.project.code} ${item.project.name}`.toLowerCase().includes(needle)) &&
      (filter.planStatus === '' || item.planStatus === filter.planStatus),
  );
}

/** The budget of a group of packages, added as exact digit strings (no float). */
export function sumVnd(values: readonly string[]): string {
  return values.reduce((total, value) => (BigInt(total) + BigInt(value === '' ? '0' : value)).toString(), '0');
}

// ---- the editor -------------------------------------------------------------------------------------------------------

export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidId' | 'invalidAmount' | 'invalidPeriod' | 'invalidDuration' | 'duplicateCode';

export interface PackageRow {
  key: string;
  code: string;
  title: string;
  budget: string;
  method: SelectionMethod;
  contractType: ContractType;
  biddingForm: BiddingForm;
  allocationLineId: string;
  period: string;
  duration: string;
}

export interface PlanForm {
  projectId: string;
  title: string;
  legalBasis: string;
  rows: PackageRow[];
}

let rowCounter = 0;
export function emptyRow(): PackageRow {
  rowCounter += 1;
  return { key: `row-${rowCounter}`, code: '', title: '', budget: '', method: 'OPEN_BIDDING', contractType: 'LUMP_SUM', biddingForm: 'ONLINE', allocationLineId: '', period: '', duration: '' };
}

export const EMPTY_PLAN_FORM = (): PlanForm => ({ projectId: '', title: '', legalBasis: '', rows: [emptyRow()] });

/** The rows of a plan in force as the start of its revision. */
export function rowsOf(packages: readonly PackageLine[]): PackageRow[] {
  return packages.map((item) => ({
    ...emptyRow(),
    code: item.code,
    title: item.title ?? '',
    budget: item.budgetVnd,
    method: oneOf(SELECTION_METHODS, item.method) ?? 'OPEN_BIDDING',
    contractType: item.contractType ?? 'LUMP_SUM',
    biddingForm: item.biddingForm ?? 'ONLINE',
    allocationLineId: item.allocationLineId ?? '',
    period: item.plannedStartPeriod ?? '',
    duration: item.durationDays === null ? '' : String(item.durationDays),
  }));
}

export interface PlanErrors {
  projectId?: FieldProblem;
  title?: FieldProblem;
  legalBasis?: FieldProblem;
  rows?: FieldProblem;
  /** By row key, then by field. */
  packages: Record<string, Partial<Record<'code' | 'title' | 'budget' | 'allocationLineId' | 'period' | 'duration', FieldProblem>>>;
}

function checkLength(value: string, min: number, max: number): FieldProblem | undefined {
  const length = value.trim().length;
  if (length === 0) return 'required';
  if (length < min) return 'tooShort';
  return length > max ? 'tooLong' : undefined;
}

export function validatePlan(form: PlanForm): PlanErrors {
  const errors: PlanErrors = { packages: {} };
  if (form.projectId.trim() === '') errors.projectId = 'required';
  else if (!UUID.test(form.projectId.trim())) errors.projectId = 'invalidId';
  errors.title = checkLength(form.title, TITLE_MIN, TITLE_MAX);
  errors.legalBasis = checkLength(form.legalBasis, TITLE_MIN, BASIS_MAX);
  if (form.rows.length === 0) errors.rows = 'required';
  const seen = new Set<string>();
  for (const row of form.rows) {
    const found: PlanErrors['packages'][string] = {};
    const code = row.code.trim();
    const codeProblem = checkLength(row.code, 1, CODE_MAX) ?? (seen.has(code) ? 'duplicateCode' : undefined);
    seen.add(code);
    if (codeProblem !== undefined) found.code = codeProblem;
    const title = checkLength(row.title, TITLE_MIN, TITLE_MAX);
    if (title !== undefined) found.title = title;
    if (row.budget.trim() === '') found.budget = 'required';
    else if (!AMOUNT.test(row.budget.trim())) found.budget = 'invalidAmount';
    if (row.allocationLineId.trim() === '') found.allocationLineId = 'required';
    else if (!UUID.test(row.allocationLineId.trim())) found.allocationLineId = 'invalidId';
    if (!PERIOD.test(row.period.trim())) found.period = row.period.trim() === '' ? 'required' : 'invalidPeriod';
    const days = Number(row.duration);
    if (row.duration.trim() === '') found.duration = 'required';
    else if (!Number.isInteger(days) || days < 1 || days > MAX_DURATION) found.duration = 'invalidDuration';
    if (Object.keys(found).length > 0) errors.packages[row.key] = found;
  }
  return errors;
}

export function hasErrors(errors: PlanErrors): boolean {
  return errors.projectId !== undefined || errors.title !== undefined || errors.legalBasis !== undefined || errors.rows !== undefined || Object.keys(errors.packages).length > 0;
}

/** The body of createProcurementPlan: the allowlist of the contract, amounts as digit strings. */
export function planBody(form: PlanForm): { project_id: string; title: string; legal_basis: string; packages: Array<Record<string, unknown>> } {
  return {
    project_id: form.projectId.trim().toLowerCase(),
    title: form.title.trim(),
    legal_basis: form.legalBasis.trim(),
    packages: form.rows.map((row) => ({
      code: row.code.trim(),
      title: row.title.trim(),
      budget_vnd: row.budget.trim(),
      method: row.method,
      contract_type: row.contractType,
      bidding_form: row.biddingForm,
      allocation_line_id: row.allocationLineId.trim().toLowerCase(),
      planned_start_period: row.period.trim(),
      duration_days: Number(row.duration),
    })),
  };
}

export interface DecisionForm {
  decision: PlanDecision;
  documentId: string;
  comment: string;
}
export const EMPTY_DECISION_FORM: DecisionForm = { decision: 'APPROVE', documentId: '', comment: '' };
export type DecisionField = 'documentId' | 'comment';

export function validateDecision(form: DecisionForm): Partial<Record<DecisionField, FieldProblem>> {
  const errors: Partial<Record<DecisionField, FieldProblem>> = {};
  if (form.decision === 'APPROVE') {
    if (form.documentId.trim() === '') errors.documentId = 'required';
    else if (!UUID.test(form.documentId.trim())) errors.documentId = 'invalidId';
  } else if (form.comment.trim() === '') errors.comment = 'required';
  if (form.comment.trim().length > COMMENT_MAX) errors.comment = 'tooLong';
  return errors;
}

export function decisionBody(form: DecisionForm): { decision: PlanDecision; decision_document_id?: string; comment?: string } {
  const comment = form.comment.trim();
  return {
    decision: form.decision,
    ...(form.decision === 'APPROVE' ? { decision_document_id: form.documentId.trim().toLowerCase() } : {}),
    ...(comment === '' ? {} : { comment }),
  };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'budgetExceeds'
  | 'lineInvalid'
  | 'stageInvalid'
  | 'stateInvalid'
  | 'codeDuplicate'
  | 'selfApproval'
  | 'decisionNotEffective'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  PACKAGE_BUDGET_EXCEEDS_ALLOCATION: 'budgetExceeds',
  ALLOCATION_LINE_INVALID: 'lineInvalid',
  PROJECT_STAGE_INVALID: 'stageInvalid',
  PLAN_STATE_INVALID: 'stateInvalid',
  PACKAGE_CODE_DUPLICATE: 'codeDuplicate',
  SELF_APPROVAL_DENIED: 'selfApproval',
  DECISION_DOCUMENT_NOT_EFFECTIVE: 'decisionNotEffective',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
};

/** A line of capital that the packages cost too much for: what it was given and what the packages ask. */
export interface ExcessLine {
  allocationLineId: string;
  allocatedVnd: string;
  packagesVnd: string;
  excessVnd: string;
}

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  lines: ExcessLine[];
}

function excessLines(error: ApiError): ExcessLine[] {
  const lines = error.extensions.lines;
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((raw) => {
    const record = asRecord(raw);
    const allocationLineId = text(record?.allocation_line_id);
    const allocatedVnd = text(record?.allocated_vnd);
    const packagesVnd = text(record?.packages_vnd);
    const excessVnd = text(record?.excess_vnd);
    return allocationLineId === undefined || allocatedVnd === undefined || packagesVnd === undefined || excessVnd === undefined ? [] : [{ allocationLineId, allocatedVnd, packagesVnd, excessVnd }];
  });
}

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, lines: [] };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, lines: excessLines(error) };
}
