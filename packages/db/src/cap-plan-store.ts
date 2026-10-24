import { randomUUID } from 'node:crypto';
import { DomainError, VND_SCALE, addDecimal, asUuid, compareDecimal, requirePositiveAmount, subtractDecimal, versionConflict, vietnamDateOf } from '@machvon/kernel';
import { CapAppropriationStore } from './cap-appropriation-store.ts';
import type { AppropriationOrigin, BudgetLevel } from './cap-appropriation-store.ts';
import { CapPlanReads, LINE_BUCKETS, PLAN_KINDS } from './cap-plan-reads.ts';
import type { LineBucket, PlanKind, PlanReadScope, PlanStatus } from './cap-plan-reads.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const PLAN_REVISION_INDEX = 'capital_plan_rev_uq';
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;
const MAX_PLAN_CODE = 50;
const MAX_LINES_PER_COMMAND = 200;
/** The transaction setting that the allocation command raises to change the allocated total of an appropriation (see V1360). */
const ALLOCATION_WRITE_SETTING = 'app.cap_allocation_write';
/** A project takes capital only from the pipeline to the end of implementation (PRJ 3.1: PIPELINE, BUDGETED, IMPLEMENTATION, SUSPENDED). */
export const DRAFTABLE_PROJECT_STATUSES: readonly string[] = ['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED'];

export interface NewPlan {
  planCode: string;
  planKind: PlanKind;
  planYear?: number | undefined;
  periodFromYear: number;
  periodToYear: number;
  scopeUnitId: string;
}

export interface CreatedPlan {
  id: string;
  planCode: string;
  planKind: PlanKind;
  planYear: number | null;
  periodFromYear: number;
  periodToYear: number;
  scopeUnitId: string;
  status: 'DRAFT';
  version: number;
  revision: number;
}

export interface LineInput {
  projectId: string;
  appropriationId: string;
  bucket: LineBucket;
  sourceYear: number;
  amountVnd: string;
  ctmtqgSubsetVnd?: string | undefined;
  programMasterVersionId?: string | undefined;
  previousLineId?: string | undefined;
}

export interface DraftInput {
  lines: readonly LineInput[];
  removeLineIds?: readonly string[] | undefined;
}

/** The scopes a draft is judged by: the one of `capital.plan.draft` over the projects decides, the one of `capital.read` shapes the safe diff of a conflict. */
export interface DraftScopes {
  write: ScopeBuilder;
  read: PlanReadScope;
}

export type LineChangeKind = 'ADDED' | 'CHANGED' | 'REMOVED';

/** One change of the draft as it was stored (normalised): what the audit row keeps. */
export interface LineChange {
  kind: LineChangeKind;
  lineId: string;
  projectId: string;
  appropriationId: string | null;
  bucket: LineBucket;
  sourceYear: number;
  fromVnd: string | null;
  toVnd: string | null;
  ctmtqgFromVnd: string | null;
  ctmtqgToVnd: string | null;
}

export interface AppropriationMove {
  id: string;
  amountVnd: string;
  allocatedBeforeVnd: string;
  allocatedAfterVnd: string;
}

export interface DraftResult {
  planId: string;
  status: 'DRAFT';
  /** The version of the plan after the draft; unchanged when the request changed nothing. */
  version: number;
  changes: LineChange[];
  appropriations: AppropriationMove[];
}

/** What the publication of a plan tells the other modules: the facts of the event `capital.plan_published.v1` (CAP 3.1 section 9). */
export interface PublicationFacts {
  capitalPlanId: string;
  revision: number;
  planYear: number | null;
  effectiveAt: string;
  decisionDocumentId: string;
  /** The projects that have a line of more than nothing in the plan. */
  projectIds: string[];
}

/** An appropriation whose allocated total is not the sum of the lines of the live plans that draw on it. */
export interface AllocatedDrift {
  appropriationId: string;
  allocatedTotalVnd: string;
  linesTotalVnd: string;
}

interface PlanLock {
  id: string;
  planCode: string;
  planKind: PlanKind;
  planYear: number | null;
  periodFromYear: number;
  periodToYear: number;
  revision: number;
  status: PlanStatus;
  version: number;
  updatedAt: string;
}

interface PlanLockSql {
  id: string;
  plan_code: string;
  plan_kind: PlanKind;
  plan_year: number | null;
  period_from_year: number;
  period_to_year: number;
  revision: number;
  status: PlanStatus;
  version: string;
  updated_at: string;
}

interface LineSql {
  id: string;
  plan_version_id: string;
  project_id: string;
  appropriation_id: string | null;
  bucket: LineBucket;
  source_year: number;
  amount_vnd: string;
  ctmtqg_subset_vnd: string;
  program_master_version_id: string | null;
  previous_line_id: string | null;
}

interface ExistingLine {
  id: string;
  planVersionId: string;
  projectId: string;
  appropriationId: string | null;
  bucket: LineBucket;
  sourceYear: number;
  amountVnd: string;
  ctmtqgSubsetVnd: string;
  programMasterVersionId: string | null;
  previousLineId: string | null;
}

interface AppropriationLock {
  id: string;
  status: string;
  planYear: number;
  sourceYear: number;
  origin: AppropriationOrigin;
  budgetLevel: BudgetLevel;
  amountVnd: string;
  allocatedTotalVnd: string;
  fundSourceVersionId: string;
  programMasterVersionId: string | null;
  isExtended: boolean;
  extendedTo: string | null;
  extensionDocumentId: string | null;
}

interface AppropriationLockSql {
  id: string;
  status: string;
  plan_year: number;
  source_year: number;
  origin: AppropriationOrigin;
  budget_level: BudgetLevel;
  amount_vnd: string;
  allocated_total_vnd: string;
  fund_source_version_id: string;
  program_master_version_id: string | null;
  is_extended: boolean;
  extended_to: string | null;
  extension_document_id: string | null;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const toExisting = (row: LineSql): ExistingLine => ({
  id: row.id,
  planVersionId: row.plan_version_id,
  projectId: row.project_id,
  appropriationId: row.appropriation_id,
  bucket: row.bucket,
  sourceYear: row.source_year,
  amountVnd: row.amount_vnd,
  ctmtqgSubsetVnd: row.ctmtqg_subset_vnd,
  programMasterVersionId: row.program_master_version_id,
  previousLineId: row.previous_line_id,
});

const LINE_COLUMNS = `al.id, al.plan_version_id, al.project_id, al.appropriation_id, al.bucket, al.source_year, al.amount_vnd::text as amount_vnd,
  al.ctmtqg_subset_vnd::text as ctmtqg_subset_vnd, al.program_master_version_id, al.previous_line_id`;

function uuidOf(value: unknown, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw invalid(field);
  return id;
}

function yearOf(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_YEAR || value > MAX_YEAR) throw invalid(field);
  return value;
}

/** An amount of whole VND above zero that the column holds; the digits of the string are exactly what is stored. */
function amountOf(value: unknown, field: string): string {
  try {
    return requirePositiveAmount(value as string, VND_SCALE);
  } catch (error) {
    if (error instanceof DomainError) throw invalid(field);
    throw error;
  }
}

/** A part of a line: zero or a whole amount of VND, never more than the line (BR-CAP-03). */
function subsetOf(value: unknown, amount: string): string {
  if (value === undefined) return '0';
  if (value === '0') return '0';
  const subset = amountOf(value, 'ctmtqg_subset_vnd');
  if (compareDecimal(subset, amount) > 0) throw new DomainError('SUBSET_EXCEEDS_PARENT', 422, 'ctmtqg_subset_vnd');
  return subset;
}

function planCodeOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (text.length < 1 || text.length > MAX_PLAN_CODE || /[\u0000-\u001f\u007f]/.test(text)) throw invalid('plan_code');
  return text;
}

const keyOf = (line: { projectId: string; appropriationId: string | null; bucket: string; sourceYear: number }): string => `${line.projectId}|${line.appropriationId ?? ''}|${line.bucket}|${line.sourceYear}`;

interface CheckedLine {
  projectId: string;
  appropriationId: string;
  bucket: LineBucket;
  sourceYear: number;
  amountVnd: string;
  ctmtqgSubsetVnd: string;
  programMasterVersionId: string | undefined;
  previousLineId: string | undefined;
}

interface CheckedDraft {
  lines: CheckedLine[];
  removeLineIds: string[];
}

/** The shape of a draft as the plan stores it: lower-case ids, whole amounts, a key that appears once. Nothing here reads the database. */
function checkedDraft(input: DraftInput): CheckedDraft {
  const removeLineIds = [...new Set((input.removeLineIds ?? []).map((id) => uuidOf(id, 'remove_line_ids')))];
  if (input.lines.length + removeLineIds.length === 0 || input.lines.length > MAX_LINES_PER_COMMAND || removeLineIds.length > MAX_LINES_PER_COMMAND) throw invalid('lines');
  const seen = new Set<string>();
  const lines = input.lines.map((line): CheckedLine => {
    if (!LINE_BUCKETS.includes(line.bucket)) throw invalid('bucket');
    const amountVnd = amountOf(line.amountVnd, 'amount_vnd');
    const checked: CheckedLine = {
      projectId: uuidOf(line.projectId, 'project_id'),
      appropriationId: uuidOf(line.appropriationId, 'appropriation_id'),
      bucket: line.bucket,
      sourceYear: yearOf(line.sourceYear, 'source_year'),
      amountVnd,
      ctmtqgSubsetVnd: subsetOf(line.ctmtqgSubsetVnd, amountVnd),
      programMasterVersionId: line.programMasterVersionId === undefined ? undefined : uuidOf(line.programMasterVersionId, 'program_master_version_id'),
      previousLineId: line.previousLineId === undefined ? undefined : uuidOf(line.previousLineId, 'previous_line_id'),
    };
    const key = keyOf(checked);
    if (seen.has(key)) throw invalid('lines');
    seen.add(key);
    return checked;
  });
  return { lines, removeLineIds };
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * The drafting of the capital plan (ST-CAP-002, CAP 3.1 F2): a planner creates a plan revision (annual or medium-term) and proposes lines for
 * projects, each drawn on one appropriation. A line never takes more than the appropriation has left (BR-CAP-02): the appropriation rows are
 * locked `FOR UPDATE` in the order of their ids, after the plan row, and the allocated total moves with the line in the same transaction, so
 * two plans that draw on one ceiling at the same moment cannot both pass. A part of a line that belongs to a national target programme is
 * inside the line, never added (BR-CAP-03). The allocated total is written only here and by the publication of a revision of the appropriation.
 */
export class CapPlanStore {
  private readonly reads = new CapPlanReads();
  private readonly register: CapAppropriationStore;

  constructor(register: CapAppropriationStore = new CapAppropriationStore()) {
    this.register = register;
  }

  /**
   * Creates a plan as revision 1 in DRAFT. The unit it belongs to must exist in the tenant and `authorize` decides whether the caller may plan
   * for it; an annual plan names its year, which must not be locked, and a medium-term plan a period of more than one year.
   */
  async createPlan(tx: TenantTx, input: NewPlan, actor: string, authorize: (unit: { id: string; path: string }) => void): Promise<CreatedPlan> {
    const planCode = planCodeOf(input.planCode);
    if (!PLAN_KINDS.includes(input.planKind)) throw invalid('plan_kind');
    const from = yearOf(input.periodFromYear, 'period_from_year');
    const to = yearOf(input.periodToYear, 'period_to_year');
    let planYear: number | null = null;
    if (input.planKind === 'ANNUAL') {
      planYear = yearOf(input.planYear, 'plan_year');
      if (from !== planYear || to !== planYear) throw invalid('period_from_year');
    } else {
      if (input.planYear !== undefined) throw invalid('plan_year');
      if (from >= to) throw invalid('period_to_year');
    }
    const scopeUnitId = uuidOf(input.scopeUnitId, 'scope_unit_id');
    const unit = (await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [scopeUnitId]))[0];
    // A unit of another tenant is indistinguishable from one that does not exist.
    if (unit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    authorize(unit);
    if (planYear !== null) await this.assertYearsOpen(tx, [planYear]);
    const id = randomUUID();
    await tx.query('savepoint capital_plan_create');
    try {
      await tx.query(
        `insert into machvon.capital_plan
           (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::integer, $5::integer, $6::integer, $7::uuid, 1, 'DRAFT', $8::uuid, $8::uuid, 1)`,
        [id, planCode, input.planKind, planYear, from, to, unit.id, actor],
      );
      await tx.query('release savepoint capital_plan_create');
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== UNIQUE_VIOLATION) throw error;
      // The savepoint keeps the transaction usable, so the loser of a race on the code gets the refusal that was meant for it.
      await tx.query('rollback to savepoint capital_plan_create');
      if (failure.constraint === PLAN_REVISION_INDEX) throw new DomainError('PLAN_CODE_DUPLICATE', 409, 'plan_code');
      throw error;
    }
    return { id, planCode, planKind: input.planKind, planYear, periodFromYear: from, periodToYear: to, scopeUnitId: unit.id, status: 'DRAFT', version: 1, revision: 1 };
  }

  /**
   * Adds, changes and removes lines of a DRAFT plan revision. Everything is judged under the locks: the plan row, then the appropriations in
   * the order of their ids. The command is all or nothing; a line is the same line when its project, appropriation, bucket and source year are
   * the same, and then the amount is replaced. Order of refusals: shape (422), plan (404, 409 VERSION_CONFLICT, 409 PLAN_NOT_DRAFT), locked
   * year (409), project (404 outside the scope, 422 PROJECT_STAGE_INVALID), appropriation, then the ceiling (422 APPROPRIATION_EXCEEDED).
   */
  async draft(tx: TenantTx, planId: string, expectedVersion: number, input: DraftInput, actor: string, scopes: DraftScopes, today: string = vietnamDateOf(new Date())): Promise<DraftResult> {
    const request = checkedDraft(input);
    const plan = await this.lockPlan(tx, planId);
    if (plan.version !== expectedVersion) throw versionConflict(plan.version, await this.conflictDiff(tx, plan, scopes.read));
    if (plan.status !== 'DRAFT') throw new DomainError('PLAN_NOT_DRAFT', 409, 'status');
    if (plan.planYear !== null) await this.assertYearsOpen(tx, [plan.planYear]);

    const peeked = await this.removedLines(tx, plan.id, request.removeLineIds);
    const stages = await this.projectsInScope(tx, unique([...request.lines.map((line) => line.projectId), ...peeked.map((line) => line.projectId)]), scopes.write);
    for (const line of request.lines) {
      if (!DRAFTABLE_PROJECT_STATUSES.includes(stages.get(line.projectId) ?? '')) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id');
    }

    const appropriations = await this.lockAppropriations(tx, unique([...request.lines.map((line) => line.appropriationId), ...peeked.flatMap((line) => (line.appropriationId === null ? [] : [line.appropriationId]))]));
    // A revision of an appropriation published meanwhile moved the lines to itself: read them again under the locks, and stop if they moved.
    const removed = await this.removedLines(tx, plan.id, request.removeLineIds);
    if (removed.some((line, index) => line.appropriationId !== peeked[index]?.appropriationId)) throw versionConflict(plan.version, await this.conflictDiff(tx, plan, scopes.read));
    const existing = await this.existingLines(tx, plan.id, unique(request.lines.map((line) => line.projectId)));
    const existingByKey = new Map(existing.map((line) => [keyOf(line), line]));
    const removedIds = new Set(removed.map((line) => line.id));
    if (request.lines.some((line) => removedIds.has(existingByKey.get(keyOf(line))?.id ?? ''))) throw invalid('remove_line_ids');

    await this.assertYearsOpen(tx, unique([...request.lines, ...removed].flatMap((line) => (line.appropriationId === null ? [] : [appropriations.get(line.appropriationId)?.planYear ?? plan.periodFromYear]))));

    const delta = new Map<string, string>();
    const bump = (appropriationId: string, amount: string): void => void delta.set(appropriationId, addDecimal(delta.get(appropriationId) ?? '0', amount));
    const changes: LineChange[] = [];
    const writes: Array<() => Promise<void>> = [];
    const versionIds = new Map(existing.map((line) => [line.projectId, line.planVersionId]));

    for (const line of request.lines) {
      const appropriation = appropriations.get(line.appropriationId);
      if (appropriation === undefined) throw invalid('appropriation_id');
      const program = await this.checkLine(tx, plan, line, appropriation, today);
      const earlier = existingByKey.get(keyOf(line));
      if (line.previousLineId !== undefined) await this.assertPreviousLine(tx, line.previousLineId, line.projectId);
      const programId = program ?? earlier?.programMasterVersionId ?? appropriation.programMasterVersionId;
      const previousId = line.previousLineId ?? earlier?.previousLineId ?? null;
      if (earlier === undefined) {
        const lineId = randomUUID();
        bump(appropriation.id, line.amountVnd);
        changes.push({ kind: 'ADDED', lineId, projectId: line.projectId, appropriationId: appropriation.id, bucket: line.bucket, sourceYear: line.sourceYear, fromVnd: null, toVnd: line.amountVnd, ctmtqgFromVnd: null, ctmtqgToVnd: line.ctmtqgSubsetVnd });
        writes.push(async () => {
          const versionId = versionIds.get(line.projectId) ?? (await this.createPlanVersion(tx, plan, line.projectId, actor));
          versionIds.set(line.projectId, versionId);
          await this.insertLine(tx, { id: lineId, planVersionId: versionId, line, appropriation, programId, previousId, actor });
        });
        continue;
      }
      const same = compareDecimal(earlier.amountVnd, line.amountVnd) === 0 && compareDecimal(earlier.ctmtqgSubsetVnd, line.ctmtqgSubsetVnd) === 0 && earlier.programMasterVersionId === programId && earlier.previousLineId === previousId;
      if (same) continue;
      bump(appropriation.id, subtractDecimal(line.amountVnd, earlier.amountVnd));
      changes.push({ kind: 'CHANGED', lineId: earlier.id, projectId: line.projectId, appropriationId: appropriation.id, bucket: line.bucket, sourceYear: line.sourceYear, fromVnd: earlier.amountVnd, toVnd: line.amountVnd, ctmtqgFromVnd: earlier.ctmtqgSubsetVnd, ctmtqgToVnd: line.ctmtqgSubsetVnd });
      writes.push(() => this.updateLine(tx, earlier.id, { amount: line.amountVnd, subset: line.ctmtqgSubsetVnd, programId, previousId, actor }));
    }
    for (const line of removed) {
      if (line.appropriationId !== null) bump(line.appropriationId, subtractDecimal('0', line.amountVnd));
      changes.push({ kind: 'REMOVED', lineId: line.id, projectId: line.projectId, appropriationId: line.appropriationId, bucket: line.bucket, sourceYear: line.sourceYear, fromVnd: line.amountVnd, toVnd: null, ctmtqgFromVnd: line.ctmtqgSubsetVnd, ctmtqgToVnd: null });
    }

    const moves = this.ceilings(appropriations, delta);
    if (changes.length === 0) return { planId: plan.id, status: 'DRAFT', version: plan.version, changes, appropriations: [] };
    for (const write of writes) await write();
    if (removed.length > 0) await this.removeLines(tx, plan.id, removed.map((line) => line.id));
    await this.moveAllocatedTotals(tx, moves, actor);
    await tx.query('update machvon.capital_plan set version = version + 1, updated_at = now(), updated_by = $2::uuid where id = $1::uuid', [plan.id, actor]);
    return { planId: plan.id, status: 'DRAFT', version: plan.version + 1, changes, appropriations: moves };
  }

  /** The facts of the event of a PUBLISHED plan; undefined when the plan is not published. */
  async publicationFacts(tx: TenantTx, planId: string): Promise<PublicationFacts | undefined> {
    const plans = await tx.query<{ id: string; revision: number; plan_year: number | null; effective_at: string; decision_document_id: string }>(
      `select id, revision, plan_year, to_char(effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_at, decision_document_id
         from machvon.capital_plan where id = $1::uuid and status = 'PUBLISHED'`,
      [planId],
    );
    const plan = plans[0];
    if (plan === undefined) return undefined;
    const projects = await tx.query<{ project_id: string }>(
      `select distinct al.project_id from machvon.allocation_line al join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
        where pv.capital_plan_id = $1::uuid and al.amount_vnd > 0 and al.project_id is not null order by al.project_id`,
      [planId],
    );
    return {
      capitalPlanId: plan.id,
      revision: plan.revision,
      planYear: plan.plan_year,
      effectiveAt: plan.effective_at,
      decisionDocumentId: plan.decision_document_id,
      projectIds: projects.map((row) => row.project_id),
    };
  }

  /**
   * The appropriations whose allocated total is not the sum of the lines of the live plans (DRAFT, IN_REVIEW, APPROVED, PUBLISHED) that draw on
   * them. It is what the nightly balance reconciliation and the tests of this slice read; an empty list is the invariant of BR-CAP-02.
   */
  async allocatedDrift(tx: TenantTx, appropriationIds?: readonly string[]): Promise<AllocatedDrift[]> {
    const rows = await tx.query<{ id: string; allocated: string; total: string }>(
      `select a.id, a.allocated_total_vnd::text as allocated, coalesce(s.total, 0)::text as total
         from machvon.appropriation a
         left join (
           select al.appropriation_id, sum(al.amount_vnd) as total
             from machvon.allocation_line al
             join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
             join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id
            where cp.status in ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED')
            group by al.appropriation_id
         ) s on s.appropriation_id = a.id
        where a.status = 'PUBLISHED' and a.allocated_total_vnd <> coalesce(s.total, 0) and ($1::uuid[] is null or a.id = any($1::uuid[]))
        order by a.id`,
      [appropriationIds === undefined ? null : [...appropriationIds]],
    );
    return rows.map((row) => ({ appropriationId: row.id, allocatedTotalVnd: row.allocated, linesTotalVnd: row.total }));
  }

  private async lockPlan(tx: TenantTx, planId: string): Promise<PlanLock> {
    const rows = await tx.query<PlanLockSql>(
      `select id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, revision, status, version::text as version,
              to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at
         from machvon.capital_plan where id = $1::uuid for update`,
      [planId],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      id: row.id,
      planCode: row.plan_code,
      planKind: row.plan_kind,
      planYear: row.plan_year,
      periodFromYear: row.period_from_year,
      periodToYear: row.period_to_year,
      revision: row.revision,
      status: row.status,
      version: Number(row.version),
      updatedAt: row.updated_at,
    };
  }

  /** What the loser of a version conflict is told about the plan: its state and how much it holds in the caller's own scope, never a line of another unit. */
  private async conflictDiff(tx: TenantTx, plan: PlanLock, scope: PlanReadScope): Promise<Record<string, unknown>> {
    const totals = await this.reads.lineTotals(tx, { capitalPlanId: plan.id }, scope);
    return { status: plan.status, updated_at: plan.updatedAt, line_count: totals.lineCount, allocated_vnd: totals.allocatedVnd };
  }

  /** A year that is locked takes no new capital (the year control is kept by ST-CAP-008; a year without a control row is open). */
  private async assertYearsOpen(tx: TenantTx, years: readonly number[]): Promise<void> {
    if (years.length === 0) return;
    const locked = await tx.query("select 1 from machvon.fiscal_year_control where plan_year = any($1::integer[]) and status = 'LOCKED'", [[...years]]);
    if (locked.length > 0) throw new DomainError('FISCAL_YEAR_LOCKED', 409, 'plan_year');
  }

  /** The lines of the plan that a draft removes, in the order they were named; one that is not a line of this plan does not exist for the caller. */
  private async removedLines(tx: TenantTx, planId: string, ids: readonly string[]): Promise<ExistingLine[]> {
    if (ids.length === 0) return [];
    const rows = await tx.query<LineSql>(
      `select ${LINE_COLUMNS} from machvon.allocation_line al join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
        where pv.capital_plan_id = $1::uuid and al.id = any($2::uuid[])`,
      [planId, [...ids]],
    );
    if (rows.length !== ids.length) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const byId = new Map(rows.map((row) => [row.id, toExisting(row)]));
    return ids.map((id) => byId.get(id) as ExistingLine);
  }

  private async existingLines(tx: TenantTx, planId: string, projectIds: readonly string[]): Promise<ExistingLine[]> {
    if (projectIds.length === 0) return [];
    const rows = await tx.query<LineSql>(
      `select ${LINE_COLUMNS} from machvon.allocation_line al join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
        where pv.capital_plan_id = $1::uuid and al.project_id = any($2::uuid[])`,
      [planId, [...projectIds]],
    );
    return rows.map(toExisting);
  }

  /** The stage of each project, for the projects in the scope of the write; a project outside it, or of another tenant, does not exist. */
  private async projectsInScope(tx: TenantTx, projectIds: readonly string[], scope: ScopeBuilder): Promise<Map<string, string>> {
    if (projectIds.length === 0) return new Map();
    const predicate = scope(2);
    const rows = await tx.query<{ id: string; status: string }>(`select p.id, p.status from ${SCOPE_FROM} where p.id = any($1::uuid[]) and ${predicate.sql}`, [[...projectIds], ...predicate.params]);
    if (rows.length !== projectIds.length) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  /** Locks the appropriations in the order of their ids, whichever order the lines name them in, so two drafts never wait for each other in a cycle. */
  private async lockAppropriations(tx: TenantTx, ids: readonly string[]): Promise<Map<string, AppropriationLock>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.query<AppropriationLockSql>(
      `select id, status, plan_year, source_year, origin, budget_level, amount_vnd::text as amount_vnd, allocated_total_vnd::text as allocated_total_vnd,
              fund_source_version_id, program_master_version_id, is_extended, extended_to::text as extended_to, extension_document_id
         from machvon.appropriation where id = any($1::uuid[]) order by id for update`,
      [[...ids]],
    );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          status: row.status,
          planYear: row.plan_year,
          sourceYear: row.source_year,
          origin: row.origin,
          budgetLevel: row.budget_level,
          amountVnd: row.amount_vnd,
          allocatedTotalVnd: row.allocated_total_vnd,
          fundSourceVersionId: row.fund_source_version_id,
          programMasterVersionId: row.program_master_version_id,
          isExtended: row.is_extended,
          extendedTo: row.extended_to,
          extensionDocumentId: row.extension_document_id,
        },
      ]),
    );
  }

  /**
   * Judges a line against the appropriation it draws on: it must be published, in the years of the plan, of the same source year, and a
   * carried-over appropriation takes the carry-over bucket only. Returns the program entry the line names, when it names one.
   */
  private async checkLine(tx: TenantTx, plan: PlanLock, line: CheckedLine, appropriation: AppropriationLock, today: string): Promise<string | undefined> {
    if (appropriation.status !== 'PUBLISHED') throw new DomainError('APPROPRIATION_NOT_PUBLISHED', 422, 'appropriation_id');
    const inPlan = plan.planKind === 'ANNUAL' ? appropriation.planYear === plan.planYear : appropriation.planYear >= plan.periodFromYear && appropriation.planYear <= plan.periodToYear;
    if (!inPlan) throw invalid('appropriation_id');
    if (line.sourceYear !== appropriation.sourceYear) throw invalid('source_year');
    if ((appropriation.origin === 'CARRYOVER') !== (line.bucket === 'CARRYOVER')) throw invalid('bucket');
    if (line.programMasterVersionId === undefined) return undefined;
    const program = await this.register.masterInForce(tx, 'program_master_version_id', line.programMasterVersionId, ['PROGRAM'], today);
    if (appropriation.programMasterVersionId !== null) {
      const own = await tx.query<{ master_record_id: string }>('select master_record_id from machvon.master_record_version where id = $1::uuid', [appropriation.programMasterVersionId]);
      if (own[0]?.master_record_id !== program.recordId) throw invalid('program_master_version_id');
    }
    return line.programMasterVersionId;
  }

  private async assertPreviousLine(tx: TenantTx, previousLineId: string, projectId: string): Promise<void> {
    const rows = await tx.query('select 1 from machvon.allocation_line where id = $1::uuid and project_id = $2::uuid', [previousLineId, projectId]);
    if (rows.length === 0) throw invalid('previous_line_id');
  }

  /** The ceiling of BR-CAP-02 under the locks: what the lines add to an appropriation must fit in what it has left. */
  private ceilings(appropriations: ReadonlyMap<string, AppropriationLock>, delta: ReadonlyMap<string, string>): AppropriationMove[] {
    const moves: AppropriationMove[] = [];
    for (const appropriation of [...appropriations.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const change = delta.get(appropriation.id) ?? '0';
      if (compareDecimal(change, '0') === 0) continue;
      const after = addDecimal(appropriation.allocatedTotalVnd, change);
      if (compareDecimal(after, appropriation.amountVnd) > 0) {
        const available = subtractDecimal(appropriation.amountVnd, appropriation.allocatedTotalVnd);
        throw new DomainError('APPROPRIATION_EXCEEDED', 422, 'amount_vnd', { extensions: { available_vnd: available, appropriation_id: appropriation.id } });
      }
      moves.push({ id: appropriation.id, amountVnd: appropriation.amountVnd, allocatedBeforeVnd: appropriation.allocatedTotalVnd, allocatedAfterVnd: after });
    }
    return moves;
  }

  private async createPlanVersion(tx: TenantTx, plan: PlanLock, projectId: string, actor: string): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::integer, $4::integer, 'DRAFT', $5::uuid, $6::uuid, $6::uuid, 1)`,
      [id, projectId, plan.planYear ?? plan.periodFromYear, plan.revision, plan.id, actor],
    );
    return id;
  }

  private async insertLine(
    tx: TenantTx,
    row: { id: string; planVersionId: string; line: CheckedLine; appropriation: AppropriationLock; programId: string | null; previousId: string | null; actor: string },
  ): Promise<void> {
    const { line, appropriation } = row;
    await tx.query(
      `insert into machvon.allocation_line
         (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin,
          is_extended, extended_to, extension_document_id, program_master_version_id, previous_line_id, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::integer, $6::numeric, $7::numeric, $8::uuid, $9::uuid, $10, $11,
               $12::boolean, $13::date, $14::uuid, $15::uuid, $16::uuid, $17::uuid, $17::uuid, 1)`,
      [
        row.id,
        row.planVersionId,
        appropriation.fundSourceVersionId,
        line.bucket,
        line.sourceYear,
        line.amountVnd,
        line.ctmtqgSubsetVnd,
        appropriation.id,
        line.projectId,
        appropriation.budgetLevel,
        appropriation.origin,
        appropriation.isExtended,
        appropriation.extendedTo,
        appropriation.extensionDocumentId,
        row.programId,
        row.previousId,
        row.actor,
      ],
    );
  }

  private async updateLine(tx: TenantTx, id: string, change: { amount: string; subset: string; programId: string | null; previousId: string | null; actor: string }): Promise<void> {
    await tx.query(
      `update machvon.allocation_line
          set amount_vnd = $2::numeric, ctmtqg_subset_vnd = $3::numeric, program_master_version_id = $4::uuid, previous_line_id = $5::uuid,
              updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [id, change.amount, change.subset, change.programId, change.previousId, change.actor],
    );
  }

  /** Removes draft lines, and the version of a project that is left with none. */
  private async removeLines(tx: TenantTx, planId: string, lineIds: readonly string[]): Promise<void> {
    await tx.query('delete from machvon.allocation_line where id = any($1::uuid[])', [[...lineIds]]);
    await tx.query(
      `delete from machvon.plan_version pv where pv.capital_plan_id = $1::uuid
          and not exists (select 1 from machvon.allocation_line al where al.tenant_id = pv.tenant_id and al.plan_version_id = pv.id)`,
      [planId],
    );
  }

  /** Writes the allocated totals under the setting that V1360 asks for, and drops the setting at once. */
  private async moveAllocatedTotals(tx: TenantTx, moves: readonly AppropriationMove[], actor: string): Promise<void> {
    if (moves.length === 0) return;
    await tx.query('select set_config($1, $2, true)', [ALLOCATION_WRITE_SETTING, 'on']);
    for (const move of moves) {
      await tx.query('update machvon.appropriation set allocated_total_vnd = $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [
        move.id,
        move.allocatedAfterVnd,
        actor,
      ]);
    }
    await tx.query('select set_config($1, $2, true)', [ALLOCATION_WRITE_SETTING, 'off']);
  }
}
