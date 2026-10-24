import { ApiError } from '@machvon/api-client';
import { isVnd, sumVnd, vndOfMillions } from './model';
import type { AppropriationLine } from './model';

/** The permissions that gate the buttons of the planning screens; the server decides again on every request. */
export const PLAN_VERSION_READ_PERMISSION = 'plan_version.read';
export const PLAN_DRAFT_PERMISSION = 'capital.plan.draft';

export const PLAN_LIST_PATH = '/cap/cap-01';
export const PROPOSAL_PATH = '/cap/cap-02';
export const ANNUAL_PLAN_PATH = '/cap/cap-03';
export const ALLOCATION_GRID_PATH = '/cap/cap-06';

export const PLAN_KINDS = ['ANNUAL', 'MEDIUM_TERM'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const PLAN_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const BUCKETS = ['CURRENT_YEAR', 'CARRYOVER', 'OTHER'] as const;
export type Bucket = (typeof BUCKETS)[number];

export const PLAN_CODE_MAX = 50;
export const MIN_YEAR = 1990;
export const MAX_YEAR = 2100;
const YEAR = /^\d{4}$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const amountText = (value: unknown): string => (typeof value === 'string' && /^-?\d+$/.test(value) ? value : '0');

// ---- what the API answers ----------------------------------------------------------------------------------------------

export interface FundSourceLabel {
  versionId: string;
  businessKey: string;
  label: string;
}

export interface PlanTotals {
  lineCount: number;
  allocatedVnd: string;
  ctmtqgSubsetVnd: string;
  ceilingVnd: string;
}

/** A revision of a capital plan as the list and the plan screens show it. */
export interface PlanSummary {
  id: string;
  planCode: string;
  planKind: PlanKind;
  planYear: number | null;
  periodFromYear: number;
  periodToYear: number;
  scopeUnit: { id: string; name: string };
  revision: number;
  status: PlanStatus;
  decisionId: string | null;
  decisionSymbol: string | null;
  decisionIssuedOn: string | null;
  /** The revision this one replaces (a revision made from a published one), and the reason of the last decision on a revision in work. */
  supersedesId: string | null;
  decisionReason: string | null;
  effectiveAt: string | null;
  publishedAt: string | null;
  totals: PlanTotals;
  fundSources: FundSourceLabel[];
  version: number;
}

export interface LineAppropriation {
  id: string;
  planYear: number;
  amountVnd: string;
  allocatedTotalVnd: string;
  remainingVnd: string;
}

/** One line of a plan: a project's share of one appropriation. Amounts are exact decimal strings of whole VND. */
export interface PlanLine {
  id: string;
  project: { id: string; code: string; name: string };
  fundSource: FundSourceLabel & { category: string | null };
  appropriation: LineAppropriation | null;
  bucket: Bucket;
  sourceYear: number;
  amountVnd: string;
  ctmtqgSubsetVnd: string;
  isExtended: boolean;
  extendedTo: string | null;
  extensionDocument: { id: string; symbol: string | null; issuedOn: string | null } | null;
  committedVnd: string | null;
  reservedVnd: string | null;
  disbursedVnd: string | null;
  version: number;
}

export interface PlanLines {
  plan: PlanSummary;
  lines: PlanLine[];
  totals: { lineCount: number; allocatedVnd: string; ctmtqgSubsetVnd: string };
  nextCursor: string | null;
}

function fundSourceOf(value: unknown): (FundSourceLabel & { category: string | null }) | undefined {
  const row = asRecord(value);
  const versionId = text(row?.version_id);
  const businessKey = text(row?.business_key);
  if (row === undefined || versionId === undefined || businessKey === undefined) return undefined;
  return { versionId, businessKey, label: text(row.label) ?? businessKey, category: nullableText(row.category) };
}

function totalsOf(value: unknown): PlanTotals {
  const row = asRecord(value) ?? {};
  return { lineCount: whole(row.line_count) ?? 0, allocatedVnd: amountText(row.allocated_vnd), ctmtqgSubsetVnd: amountText(row.ctmtqg_subset_vnd), ceilingVnd: amountText(row.ceiling_vnd) };
}

export function toPlan(raw: unknown): PlanSummary | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const planCode = text(row?.plan_code);
  const kind = text(row?.plan_kind);
  const status = text(row?.status);
  const unit = asRecord(row?.scope_unit);
  const version = whole(row?.version);
  const from = whole(row?.period_from_year);
  const to = whole(row?.period_to_year);
  if (row === undefined || id === undefined || planCode === undefined || kind === undefined || !(PLAN_KINDS as readonly string[]).includes(kind)) return undefined;
  if (status === undefined || !(PLAN_STATUSES as readonly string[]).includes(status) || version === undefined || from === undefined || to === undefined) return undefined;
  const decision = asRecord(row.decision_document);
  return {
    id,
    planCode,
    planKind: kind as PlanKind,
    planYear: whole(row.plan_year) ?? null,
    periodFromYear: from,
    periodToYear: to,
    scopeUnit: { id: text(unit?.id) ?? '', name: text(unit?.name) ?? '' },
    revision: whole(row.revision) ?? 1,
    status: status as PlanStatus,
    decisionId: nullableText(decision?.id),
    decisionSymbol: nullableText(decision?.symbol),
    decisionIssuedOn: nullableText(decision?.issued_on),
    supersedesId: nullableText(row.supersedes_id),
    decisionReason: nullableText(row.decision_reason),
    effectiveAt: nullableText(row.effective_at),
    publishedAt: nullableText(row.published_at),
    totals: totalsOf(row.totals),
    fundSources: (Array.isArray(row.fund_sources) ? row.fund_sources : []).flatMap((source: unknown) => {
      const found = fundSourceOf(source);
      return found === undefined ? [] : [{ versionId: found.versionId, businessKey: found.businessKey, label: found.label }];
    }),
    version,
  };
}

export function toPlanLine(raw: unknown): PlanLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const project = asRecord(row?.project);
  const projectId = text(project?.id);
  const fundSource = fundSourceOf(row?.fund_source);
  const bucket = text(row?.bucket);
  const sourceYear = whole(row?.source_year);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || projectId === undefined || fundSource === undefined || bucket === undefined || !(BUCKETS as readonly string[]).includes(bucket)) return undefined;
  if (sourceYear === undefined || version === undefined) return undefined;
  const appropriation = asRecord(row.appropriation);
  const appropriationId = text(appropriation?.id);
  const extension = asRecord(row.extension_document);
  const extensionId = text(extension?.id);
  return {
    id,
    project: { id: projectId, code: text(project?.code) ?? '', name: text(project?.name) ?? '' },
    fundSource,
    appropriation:
      appropriation === undefined || appropriationId === undefined
        ? null
        : {
            id: appropriationId,
            planYear: whole(appropriation.plan_year) ?? sourceYear,
            amountVnd: amountText(appropriation.amount_vnd),
            allocatedTotalVnd: amountText(appropriation.allocated_total_vnd),
            remainingVnd: amountText(appropriation.remaining_vnd),
          },
    bucket: bucket as Bucket,
    sourceYear,
    amountVnd: amountText(row.amount_vnd),
    ctmtqgSubsetVnd: amountText(row.ctmtqg_subset_vnd),
    isExtended: row.is_extended === true,
    extendedTo: nullableText(row.extended_to),
    extensionDocument: extensionId === undefined ? null : { id: extensionId, symbol: nullableText(extension?.symbol), issuedOn: nullableText(extension?.issued_on) },
    committedVnd: typeof row.committed_vnd === 'string' ? row.committed_vnd : null,
    reservedVnd: typeof row.reserved_vnd === 'string' ? row.reserved_vnd : null,
    disbursedVnd: typeof row.disbursed_vnd === 'string' ? row.disbursed_vnd : null,
    version,
  };
}

/** The answer of `listCapitalPlanLines`: the plan, one page of its lines and the total of all of them in the scope of the caller. */
export function toPlanLines(raw: unknown): PlanLines | undefined {
  const row = asRecord(raw);
  const plan = toPlan(row?.plan);
  if (row === undefined || plan === undefined) return undefined;
  const totals = asRecord(row.totals) ?? {};
  return {
    plan,
    lines: (Array.isArray(row.items) ? row.items : []).flatMap((item: unknown) => toPlanLine(item) ?? []),
    totals: { lineCount: whole(totals.line_count) ?? 0, allocatedVnd: amountText(totals.allocated_vnd), ctmtqgSubsetVnd: amountText(totals.ctmtqg_subset_vnd) },
    nextCursor: nullableText(row.next_cursor),
  };
}

export interface ProjectOption {
  id: string;
  code: string;
  name: string;
  status: string;
}

export function toProjectOption(raw: unknown): ProjectOption | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  if (row === undefined || id === undefined || code === undefined) return undefined;
  return { id, code, name: text(row.name) ?? code, status: text(row.status) ?? '' };
}

export interface UnitOption {
  id: string;
  code: string;
  name: string;
}

export function toUnitOption(raw: unknown): UnitOption | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  if (row === undefined || id === undefined || code === undefined) return undefined;
  return { id, code, name: text(row.name) ?? code };
}

// ---- the plans ---------------------------------------------------------------------------------------------------------

/** Whether the caller may change plans: the permission to draft (a session that does not list permissions is judged by the server), and the tenant not frozen. */
export const canDraft = (permissions: readonly string[] | undefined, mode: string | undefined): boolean => (permissions === undefined || permissions.includes(PLAN_DRAFT_PERMISSION)) && mode !== 'READ_ONLY';

/** A revision is edited only while it is a draft. */
export const isDraft = (plan: PlanSummary): boolean => plan.status === 'DRAFT';

/** The years a plan covers, as the screens write them: the year of an annual plan, or the period of a medium-term one. */
export function periodOf(plan: PlanSummary): string {
  return plan.planKind === 'ANNUAL' || plan.periodFromYear === plan.periodToYear ? String(plan.periodFromYear) : `${plan.periodFromYear} - ${plan.periodToYear}`;
}

/** The plans of one kind, newest first as the API lists them. */
export const plansOfKind = (plans: readonly PlanSummary[], kind: PlanKind): PlanSummary[] => plans.filter((plan) => plan.planKind === kind);

/**
 * The appropriations that a plan can draw on: published, and in the years of the plan (the year of an annual plan, any year of the period of
 * a medium-term one). Only these are offered; the server judges the same rule again.
 */
export function appropriationsFor(plan: PlanSummary, lines: readonly AppropriationLine[]): AppropriationLine[] {
  return lines.filter((line) => line.status === 'PUBLISHED' && line.planYear >= plan.periodFromYear && line.planYear <= plan.periodToYear);
}

// ---- signed amounts ----------------------------------------------------------------------------------------------------

const big = (value: string): bigint => (/^-?\d+$/.test(value) ? BigInt(value) : 0n);

/** The exact difference of two amounts of whole VND, which may be negative. */
export const differenceVnd = (a: string, b: string): string => (big(a) - big(b)).toString();

/** Whether an amount of whole VND (possibly signed) is below zero. */
export const isNegativeVnd = (value: string): boolean => big(value) < 0n;

// ---- the form of a proposal (CAP-02) -----------------------------------------------------------------------------------

export interface ProposalForm {
  projectId: string;
  appropriationId: string;
  bucket: Bucket;
  /** Millions of dong as typed. */
  amount: string;
  /** The part of the amount that belongs to a national target programme, in millions of dong as typed; empty means none. */
  ctmtqg: string;
}

export type ProposalField = keyof ProposalForm;
export type ProposalProblem = 'required' | 'invalidAmount' | 'subsetExceeds' | 'exceedsRemaining';

export const EMPTY_PROPOSAL: ProposalForm = { projectId: '', appropriationId: '', bucket: 'CURRENT_YEAR', amount: '', ctmtqg: '' };

/** The bucket a line takes by default: carried-over capital goes in the carry-over bucket, everything else in the year's. */
export const defaultBucket = (appropriation: AppropriationLine | undefined): Bucket => (appropriation?.origin === 'CARRYOVER' ? 'CARRYOVER' : 'CURRENT_YEAR');

/** What is wrong with a proposal before anything is sent; the server judges the same rules again under the lock. */
export function validateProposal(form: ProposalForm, appropriation: AppropriationLine | undefined, locale: string): Partial<Record<ProposalField, ProposalProblem>> {
  const problems: Partial<Record<ProposalField, ProposalProblem>> = {};
  if (form.projectId === '') problems.projectId = 'required';
  if (form.appropriationId === '' || appropriation === undefined) problems.appropriationId = 'required';
  const amount = form.amount.trim() === '' ? undefined : vndOfMillions(form.amount, locale);
  if (form.amount.trim() === '') problems.amount = 'required';
  else if (amount === undefined) problems.amount = 'invalidAmount';
  else if (appropriation !== undefined && isNegativeVnd(differenceVnd(appropriation.remainingVnd, amount))) problems.amount = 'exceedsRemaining';
  if (form.ctmtqg.trim() !== '') {
    const subset = vndOfMillions(form.ctmtqg, locale);
    if (subset === undefined) problems.ctmtqg = 'invalidAmount';
    else if (amount !== undefined && isNegativeVnd(differenceVnd(amount, subset))) problems.ctmtqg = 'subsetExceeds';
  }
  return problems;
}

/** The body of `draftCapitalAllocation` for a proposal that passed `validateProposal`: the amounts are sent as exact VND. */
export function proposalBody(form: ProposalForm, appropriation: AppropriationLine, locale: string) {
  const subset = form.ctmtqg.trim() === '' ? undefined : vndOfMillions(form.ctmtqg, locale);
  return {
    lines: [
      {
        project_id: form.projectId,
        appropriation_id: appropriation.id,
        bucket: form.bucket,
        source_year: appropriation.sourceYear,
        amount_vnd: vndOfMillions(form.amount, locale) as string,
        ...(subset === undefined ? {} : { ctmtqg_subset_vnd: subset }),
      },
    ],
  };
}

export type DraftBody = ReturnType<typeof proposalBody> | GridBody;

// ---- the form of a plan (CAP-01) ---------------------------------------------------------------------------------------

export interface PlanForm {
  planCode: string;
  planKind: PlanKind;
  planYear: string;
  periodFrom: string;
  periodTo: string;
  scopeUnitId: string;
}

export type PlanField = keyof PlanForm;
export type PlanFormProblem = 'required' | 'invalidYear' | 'tooLong' | 'periodOrder';

export const EMPTY_PLAN_FORM: PlanForm = { planCode: '', planKind: 'MEDIUM_TERM', planYear: '', periodFrom: '', periodTo: '', scopeUnitId: '' };

const yearOf = (value: string): number | undefined => (YEAR.test(value.trim()) && Number(value) >= MIN_YEAR && Number(value) <= MAX_YEAR ? Number(value) : undefined);

export function validatePlanForm(form: PlanForm): Partial<Record<PlanField, PlanFormProblem>> {
  const problems: Partial<Record<PlanField, PlanFormProblem>> = {};
  const code = form.planCode.trim();
  if (code === '') problems.planCode = 'required';
  else if (code.length > PLAN_CODE_MAX) problems.planCode = 'tooLong';
  if (form.scopeUnitId === '') problems.scopeUnitId = 'required';
  if (form.planKind === 'ANNUAL') {
    if (form.planYear.trim() === '') problems.planYear = 'required';
    else if (yearOf(form.planYear) === undefined) problems.planYear = 'invalidYear';
    return problems;
  }
  const from = yearOf(form.periodFrom);
  const to = yearOf(form.periodTo);
  if (form.periodFrom.trim() === '') problems.periodFrom = 'required';
  else if (from === undefined) problems.periodFrom = 'invalidYear';
  if (form.periodTo.trim() === '') problems.periodTo = 'required';
  else if (to === undefined) problems.periodTo = 'invalidYear';
  else if (from !== undefined && from >= to) problems.periodTo = 'periodOrder';
  return problems;
}

/** The body of `createCapitalPlan` for a form that passed `validatePlanForm`. */
export function planBody(form: PlanForm) {
  const annual = form.planKind === 'ANNUAL';
  const year = Number(form.planYear.trim());
  return {
    plan_code: form.planCode.trim(),
    plan_kind: form.planKind,
    ...(annual ? { plan_year: year } : {}),
    period_from_year: annual ? year : Number(form.periodFrom.trim()),
    period_to_year: annual ? year : Number(form.periodTo.trim()),
    scope_unit_id: form.scopeUnitId.toLowerCase(),
  };
}

export type CreatePlanBody = ReturnType<typeof planBody>;

// ---- the grid (CAP-06) -------------------------------------------------------------------------------------------------

/** What the planner typed for one line: millions of dong as typed, and whether the line is to be removed. */
export interface GridEdit {
  amount: string;
  ctmtqg: string;
  remove: boolean;
}

export type GridEdits = Readonly<Record<string, GridEdit>>;
export type GridProblem = 'invalidAmount' | 'subsetExceeds';

export interface GridRow {
  line: PlanLine;
  edit: GridEdit;
  nextAmountVnd: string | undefined;
  nextCtmtqgVnd: string | undefined;
  problem: GridProblem | undefined;
  changed: boolean;
}

export interface CeilingState {
  appropriationId: string;
  /** What the appropriation has left once the edits are saved; negative when they do not fit. */
  remainingVnd: string;
  exceeded: boolean;
}

export interface DraftLine {
  project_id: string;
  appropriation_id: string;
  bucket: Bucket;
  source_year: number;
  amount_vnd: string;
  ctmtqg_subset_vnd?: string;
}

export interface GridBody {
  lines: DraftLine[];
  remove_line_ids?: string[];
}

/** The text a line starts with in the grid: its amounts in millions of dong, exactly. */
export function startEdit(line: PlanLine, toMillions: (vnd: string) => string): GridEdit {
  return { amount: toMillions(line.amountVnd), ctmtqg: line.ctmtqgSubsetVnd === '0' ? '' : toMillions(line.ctmtqgSubsetVnd), remove: false };
}

/** Each line of the plan with what the planner made of it: the exact amounts the text stands for, whether it changed, and what is wrong with it. */
export function gridRows(lines: readonly PlanLine[], edits: GridEdits, locale: string, toMillions: (vnd: string) => string): GridRow[] {
  return lines.map((line) => {
    const edit = edits[line.id] ?? startEdit(line, toMillions);
    // A line that draws on no appropriation (written before the register existed) can be removed but not changed: there is no ceiling to judge it by.
    if (line.appropriation === null && !edit.remove) return { line, edit, nextAmountVnd: undefined, nextCtmtqgVnd: undefined, problem: undefined, changed: false };
    if (edit.remove) return { line, edit, nextAmountVnd: undefined, nextCtmtqgVnd: undefined, problem: undefined, changed: true };
    const amount = vndOfMillions(edit.amount, locale);
    const subset = edit.ctmtqg.trim() === '' ? '0' : vndOfMillions(edit.ctmtqg, locale);
    let problem: GridProblem | undefined;
    if (amount === undefined || subset === undefined) problem = 'invalidAmount';
    else if (isNegativeVnd(differenceVnd(amount, subset))) problem = 'subsetExceeds';
    const changed = amount !== line.amountVnd || (subset ?? line.ctmtqgSubsetVnd) !== line.ctmtqgSubsetVnd;
    return { line, edit, nextAmountVnd: amount, nextCtmtqgVnd: subset, problem, changed };
  });
}

/**
 * What each appropriation of the grid has left once the edits are saved: its remaining amount less what the edits add (a smaller amount or a
 * removal gives capital back). A line with an amount that is not valid counts as unchanged. This is the live ceiling of CAP-06; the server
 * judges it again under the lock.
 */
export function ceilingStates(rows: readonly GridRow[]): CeilingState[] {
  const remaining = new Map<string, bigint>();
  for (const { line, edit, nextAmountVnd } of rows) {
    if (line.appropriation === null) continue;
    const start = remaining.get(line.appropriation.id) ?? big(line.appropriation.remainingVnd);
    const next = edit.remove ? 0n : nextAmountVnd === undefined ? big(line.amountVnd) : big(nextAmountVnd);
    remaining.set(line.appropriation.id, start - (next - big(line.amountVnd)));
  }
  return [...remaining.entries()].map(([appropriationId, value]) => ({ appropriationId, remainingVnd: value.toString(), exceeded: value < 0n }));
}

export type GridOutcome = { ok: true; body: GridBody } | { ok: false; reason: 'nothing' | 'invalid' | 'exceeded' };

/**
 * The body of `draftCapitalAllocation` for the edits of the grid: the lines that changed and the lines to remove. A command that only
 * removes lines sends an empty `lines` (CR-CAP-01); removing every line of a plan is allowed and leaves the plan empty.
 */
export function gridBody(rows: readonly GridRow[]): GridOutcome {
  const changed = rows.filter((row) => row.changed);
  if (changed.length === 0) return { ok: false, reason: 'nothing' };
  if (rows.some((row) => row.problem !== undefined)) return { ok: false, reason: 'invalid' };
  if (ceilingStates(rows).some((state) => state.exceeded)) return { ok: false, reason: 'exceeded' };
  const line = (row: GridRow): DraftLine => ({
    project_id: row.line.project.id,
    appropriation_id: row.line.appropriation?.id ?? '',
    bucket: row.line.bucket,
    source_year: row.line.sourceYear,
    amount_vnd: row.nextAmountVnd ?? row.line.amountVnd,
    ...((row.nextCtmtqgVnd ?? row.line.ctmtqgSubsetVnd) === '0' ? {} : { ctmtqg_subset_vnd: row.nextCtmtqgVnd ?? row.line.ctmtqgSubsetVnd }),
  });
  const upserts = changed.filter((row) => !row.edit.remove).map(line);
  const removals = changed.filter((row) => row.edit.remove).map((row) => row.line.id);
  return { ok: true, body: { lines: upserts, ...(removals.length === 0 ? {} : { remove_line_ids: removals }) } };
}

/** The exact total of the plan as the grid will leave it, for the footer; CTMTQG is part of the lines and is not added. */
export function nextTotal(rows: readonly GridRow[]): string {
  return sumVnd(rows.map((row) => (row.edit.remove ? '0' : (row.nextAmountVnd ?? row.line.amountVnd))));
}

// ---- refusals ----------------------------------------------------------------------------------------------------------

export type PlanProblemReason =
  | 'ceilingExceeded'
  | 'subsetExceeds'
  | 'planNotDraft'
  | 'yearLocked'
  | 'stageInvalid'
  | 'appropriationNotPublished'
  | 'planCodeDuplicate'
  | 'versionConflict'
  | 'notAllowed'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

export interface PlanProblemView {
  reason: PlanProblemReason;
  field: string | undefined;
  /** What the appropriation had left when the draft was refused, an exact amount of whole VND. */
  availableVnd: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, PlanProblemReason>> = {
  APPROPRIATION_EXCEEDED: 'ceilingExceeded',
  SUBSET_EXCEEDS_PARENT: 'subsetExceeds',
  PLAN_NOT_DRAFT: 'planNotDraft',
  FISCAL_YEAR_LOCKED: 'yearLocked',
  PROJECT_STAGE_INVALID: 'stageInvalid',
  APPROPRIATION_NOT_PUBLISHED: 'appropriationNotPublished',
  PLAN_CODE_DUPLICATE: 'planCodeDuplicate',
  VERSION_CONFLICT: 'versionConflict',
  FIELD_NOT_ALLOWED: 'notAllowed',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the failure of a command of the planning screens to what they show; an unknown failure is the general message. */
export function describePlanProblem(error: unknown): PlanProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, availableVnd: undefined };
  if (error.status === 403) return { reason: 'denied', field: undefined, availableVnd: undefined };
  const available = error.extensions.available_vnd;
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, availableVnd: typeof available === 'string' && isVnd(available) ? available : undefined };
}
