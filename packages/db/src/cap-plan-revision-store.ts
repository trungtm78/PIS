import { randomUUID } from 'node:crypto';
import { DomainError, addDecimal, subtractDecimal, versionConflict } from '@machvon/kernel';
import { assertYearsOpen } from './cap-fiscal-year-guard.ts';
import { CapPlanReads } from './cap-plan-reads.ts';
import type { PlanLineRow, PlanReadScope } from './cap-plan-reads.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const READ_PAGE = 200;
/** A plan read as of a date is returned whole; a plan with more lines than this in the caller's scope is cut and says so. */
const MAX_LINES = 5000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
/** Vietnam time has no daylight saving: a day ends at 23:59:59.999999 at UTC+7. */
const VIETNAM_END_OF_DAY = 'T23:59:59.999999+07:00';

export interface RevisionCreated {
  id: string;
  planCode: string;
  revision: number;
  supersedesId: string;
  status: 'DRAFT';
  version: number;
  projects: number;
  lines: number;
}

export interface AsOfLine {
  line: PlanLineRow;
  /** What the first revision that came into force gave this line (zero for a line a later revision added). */
  initialVnd: string;
  /** The line now as against the first revision: what the revisions added or took away. */
  adjustmentVnd: string;
  /** What was paid on this project against this appropriation up to the moment asked for. */
  disbursedVnd: string;
}

export interface PlanAsOf {
  capitalPlanId: string;
  planCode: string;
  revision: number;
  status: string;
  decisionDocumentId: string | null;
  effectiveAt: string;
  asOf: string;
  lines: AsOfLine[];
  /** True when the plan has more lines in the caller's scope than one answer carries. */
  truncated: boolean;
  totals: { amountVnd: string; initialVnd: string; adjustmentVnd: string; disbursedVnd: string };
}

interface SourcePlan {
  id: string;
  plan_code: string;
  plan_kind: string;
  plan_year: number | null;
  period_from_year: number;
  period_to_year: number;
  scope_unit_id: string;
  revision: number;
  status: string;
  version: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The moment a request names: an instant as written, or a day, which stands for the end of that day in Vietnam. */
export function momentOf(value: string | undefined, now: Date): string {
  if (value === undefined) return now.toISOString();
  if (DATE.test(value)) {
    const day = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) throw invalid('at');
    return new Date(`${value}${VIETNAM_END_OF_DAY}`).toISOString();
  }
  if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw invalid('at');
  return new Date(value).toISOString();
}

/**
 * The revision of a published capital plan and the reading of a plan as it stood on a date (ST-CAP-004, CAP 3.1 F3, BR-CAP-10).
 *
 * A revision is a new plan row of the same code with the next number, in DRAFT, that supersedes the revision in force and carries a copy of its
 * lines (each remembers the line it copied, `previous_line_id`). Copying changes no ceiling: the allocated total of an appropriation counts only
 * the difference between a revision and the one it replaces (docs/capital-balances.md, I6), and the planner's edits to the copy add exactly that.
 * Only one revision of a plan is in work at a time. Reading as of a date takes the revision with the largest `effective_at` up to that moment
 * among the published and the superseded ones, so a past report can always be explained.
 */
export class CapPlanRevisionStore {
  private readonly reads = new CapPlanReads();

  /** The size of a page of lines and the most lines one answer carries; the defaults are for production, a test narrows them to reach the bound. */
  private readonly bounds: { page: number; maxLines: number };

  constructor(bounds: { page: number; maxLines: number } = { page: READ_PAGE, maxLines: MAX_LINES }) {
    this.bounds = bounds;
  }

  /**
   * Opens revision n+1 of the plan, which must be the one in force. The plan row is locked first (the order every plan command uses); the
   * unit of the plan is judged by `authorize`, the year must be open, and no other revision may be in work.
   */
  async create(tx: TenantTx, planId: string, expectedVersion: number, actor: string, authorize: (unit: { id: string; path: string }) => void): Promise<RevisionCreated> {
    const rows = await tx.query<SourcePlan>(
      `select id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, version::text as version
         from machvon.capital_plan where id = $1::uuid for update`,
      [planId],
    );
    const source = rows[0];
    if (source === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const unit = (await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [source.scope_unit_id]))[0];
    if (unit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    authorize(unit);
    if (Number(source.version) !== expectedVersion) throw versionConflict(Number(source.version));
    if (source.status !== 'PUBLISHED') throw new DomainError('PLAN_NOT_PUBLISHED', 409, 'status');
    if (source.plan_year !== null) await assertYearsOpen(tx, [source.plan_year]);
    const pending = await tx.query("select 1 from machvon.capital_plan where plan_code = $1 and status in ('DRAFT', 'IN_REVIEW', 'APPROVED')", [source.plan_code]);
    if (pending.length > 0) throw new DomainError('REVISION_PENDING_EXISTS', 409, 'status');
    const next = (await tx.query<{ next: number }>('select max(revision) + 1 as next from machvon.capital_plan where plan_code = $1', [source.plan_code]))[0]?.next ?? source.revision + 1;

    const id = randomUUID();
    await tx.query('savepoint capital_plan_revision');
    try {
      await tx.query(
        `insert into machvon.capital_plan
           (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, supersedes_id, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::integer, $5::integer, $6::integer, $7::uuid, $8::integer, 'DRAFT', $9::uuid, $10::uuid, $10::uuid, 1)`,
        [id, source.plan_code, source.plan_kind, source.plan_year, source.period_from_year, source.period_to_year, source.scope_unit_id, next, source.id, actor],
      );
      await tx.query('release savepoint capital_plan_revision');
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      // Two planners asked at the same moment: the one who lost is told what the other one made.
      await tx.query('rollback to savepoint capital_plan_revision');
      throw new DomainError('REVISION_PENDING_EXISTS', 409, 'status');
    }

    // The versions (one per project) and the lines, copied in one statement; each copy names the line it came from.
    const copied = await tx.query<{ projects: string; lines: string }>(
      `with old as (
         select pv.id as old_id, pv.project_id, pv.fiscal_year, gen_random_uuid() as new_id
           from machvon.plan_version pv where pv.capital_plan_id = $1::uuid
       ), inserted_versions as (
         insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, created_by, updated_by, version)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, old.new_id, old.project_id, old.fiscal_year, $2::integer, 'DRAFT', $3::uuid, $4::uuid, $4::uuid, 1 from old
         returning id
       ), inserted_lines as (
         insert into machvon.allocation_line
           (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin,
            is_extended, extended_to, extension_document_id, program_master_version_id, previous_line_id, created_by, updated_by, version, taxonomy_pack)
         select al.tenant_id, gen_random_uuid(), old.new_id, al.fund_source_version_id, al.bucket, al.source_year, al.amount_vnd, al.ctmtqg_subset_vnd, al.appropriation_id, al.project_id,
                al.budget_level, al.origin, al.is_extended, al.extended_to, al.extension_document_id, al.program_master_version_id, al.id, $4::uuid, $4::uuid, 1, al.taxonomy_pack
           from machvon.allocation_line al join old on old.old_id = al.plan_version_id
         returning id
       )
       select (select count(*) from inserted_versions)::text as projects, (select count(*) from inserted_lines)::text as lines`,
      [source.id, next, id, actor],
    );
    return { id, planCode: source.plan_code, revision: next, supersedesId: source.id, status: 'DRAFT', version: 1, projects: Number(copied[0]?.projects ?? 0), lines: Number(copied[0]?.lines ?? 0) };
  }

  /**
   * The plan as it stood at `at` (an instant, or a day that stands for its end in Vietnam; now when absent): the revision of the plan's code with
   * the largest `effective_at` up to then among the published and the superseded ones, with the lines in the scope of the caller, what the first
   * revision gave each line and what was paid by then. undefined when the plan does not exist for the caller or nothing was in force yet.
   */
  async asOf(tx: TenantTx, planId: string, at: string | undefined, projectId: string | undefined, scope: PlanReadScope, now: Date = new Date()): Promise<PlanAsOf | undefined> {
    const moment = momentOf(at, now);
    const anchor = (await tx.query<{ plan_code: string }>('select plan_code from machvon.capital_plan where id = $1::uuid', [planId]))[0];
    if (anchor === undefined) return undefined;
    const effective = `to_char(cp.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const inForce = (
      await tx.query<{ id: string; revision: number; status: string; decision_document_id: string | null; effective_at: string }>(
        `select cp.id, cp.revision, cp.status, cp.decision_document_id, ${effective} as effective_at
           from machvon.capital_plan cp
          where cp.plan_code = $1 and cp.status in ('PUBLISHED', 'SUPERSEDED') and cp.effective_at <= $2::timestamptz
          order by cp.effective_at desc, cp.revision desc limit 1`,
        [anchor.plan_code, moment],
      )
    )[0];
    if (inForce === undefined) return undefined;

    const lines: PlanLineRow[] = [];
    let after: { code: string; id: string } | undefined;
    let truncated = false;
    for (;;) {
      const page = await this.reads.listLines(tx, { capitalPlanId: inForce.id, projectId }, scope, { limit: this.bounds.page + 1, after });
      const shown = page.slice(0, this.bounds.page);
      lines.push(...shown);
      const last = shown[shown.length - 1];
      if (page.length <= this.bounds.page || last === undefined) break;
      if (lines.length >= this.bounds.maxLines) {
        truncated = true;
        break;
      }
      after = { code: last.createdAtKey, id: last.id };
    }

    const projectIds = [...new Set(lines.map((line) => line.project.id))];
    const initial = await this.initialAmounts(tx, anchor.plan_code, projectIds);
    const disbursed = await this.disbursed(tx, projectIds, moment);
    const rows: AsOfLine[] = lines.map((line) => {
      const first = initial.get(lineKey(line.project.id, line.appropriation?.id ?? '', line.bucket, line.sourceYear)) ?? '0';
      return {
        line,
        initialVnd: first,
        adjustmentVnd: subtractDecimal(line.amountVnd, first),
        disbursedVnd: disbursed.get(`${line.project.id}:${line.appropriation?.id ?? ''}`) ?? '0',
      };
    });
    const paid = new Set<string>();
    const totals = rows.reduce(
      (sum, row) => {
        // What was paid is per project and appropriation, however many lines the pair has: it is counted once.
        const key = `${row.line.project.id}:${row.line.appropriation?.id ?? ''}`;
        const once = paid.has(key) ? '0' : row.disbursedVnd;
        paid.add(key);
        return {
          amountVnd: addDecimal(sum.amountVnd, row.line.amountVnd),
          initialVnd: addDecimal(sum.initialVnd, row.initialVnd),
          adjustmentVnd: addDecimal(sum.adjustmentVnd, row.adjustmentVnd),
          disbursedVnd: addDecimal(sum.disbursedVnd, once),
        };
      },
      { amountVnd: '0', initialVnd: '0', adjustmentVnd: '0', disbursedVnd: '0' },
    );
    return {
      capitalPlanId: inForce.id,
      planCode: anchor.plan_code,
      revision: inForce.revision,
      status: inForce.status,
      decisionDocumentId: inForce.decision_document_id,
      effectiveAt: inForce.effective_at,
      asOf: moment,
      lines: rows,
      truncated,
      totals,
    };
  }

  /** The amount each line was given by the first revision of the plan that came into force, by the identity of the line. */
  private async initialAmounts(tx: TenantTx, planCode: string, projectIds: readonly string[]): Promise<Map<string, string>> {
    const amounts = new Map<string, string>();
    if (projectIds.length === 0) return amounts;
    const rows = await tx.query<{ project_id: string; appropriation_id: string | null; bucket: string; source_year: number; amount_vnd: string }>(
      `select al.project_id, al.appropriation_id, al.bucket, al.source_year, al.amount_vnd::text as amount_vnd
         from machvon.allocation_line al
         join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
        where pv.capital_plan_id = (select cp.id from machvon.capital_plan cp where cp.plan_code = $1 and cp.status in ('PUBLISHED', 'SUPERSEDED')
                                     order by cp.effective_at asc, cp.revision asc limit 1)
          and al.project_id = any($2::uuid[])`,
      [planCode, [...projectIds]],
    );
    for (const row of rows) amounts.set(lineKey(row.project_id, row.appropriation_id ?? '', row.bucket, row.source_year), row.amount_vnd);
    return amounts;
  }

  /** What was paid up to a moment, per project and appropriation: the DISBURSE entries of the capital ledger that no reversal had undone by then. */
  private async disbursed(tx: TenantTx, projectIds: readonly string[], moment: string): Promise<Map<string, string>> {
    const paid = new Map<string, string>();
    if (projectIds.length === 0) return paid;
    const rows = await tx.query<{ project_id: string; appropriation_id: string; amount: string }>(
      `select e.project_id, e.appropriation_id, sum(e.amount_vnd)::text as amount
         from machvon.capital_ledger_entry e
        where e.entry_type = 'DISBURSE' and e.project_id = any($1::uuid[]) and e.posted_at <= $2::timestamptz
          and not exists (select 1 from machvon.capital_ledger_entry r where r.tenant_id = e.tenant_id and r.reversal_of_id = e.id and r.posted_at <= $2::timestamptz)
        group by e.project_id, e.appropriation_id`,
      [[...projectIds], moment],
    );
    for (const row of rows) paid.set(`${row.project_id}:${row.appropriation_id}`, row.amount);
    return paid;
  }
}

const lineKey = (projectId: string, appropriationId: string, bucket: string, sourceYear: number): string => `${projectId}:${appropriationId}:${bucket}:${sourceYear}`;
