import { randomUUID } from 'node:crypto';
import { DomainError, FUNDING_CELLS, deltaOf, draftHash, fundingTotals, versionConflict } from '@machvon/kernel';
import type { BudgetLevel, FundingBucket, FundingInput, FundingTotals, MeasurementBasis, ReportType, RevisionStatus } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

/** The resource type of the audit rows and the events of a report. */
export const REPORT_RESOURCE = 'report_revision';

const NOT_FOUND = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);
const cellKey = (bucket: string, level: string): string => `${bucket}/${level}`;
/** A report with the project it is about, through the owner and the investor unit of the project: the tables the scope of a grant is judged on (aliases `r`, `p`, `ou`, `iu`). */
const REPORT_FROM = `machvon.report_revision r
  join machvon.project p on p.tenant_id = r.tenant_id and p.id = r.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The project a report is about, as the report shows it. */
export interface ReportProject {
  id: string;
  code: string;
  name: string;
  status: string;
}

export interface ReportPeriodFacts {
  id: string;
  code: string;
  periodType: string;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  status: string;
}

export interface PlanFacts {
  id: string;
  projectId: string;
  fiscalYear: number;
  revision: number;
  status: string;
}

/** What the plan allocated to a cell: the sum of its lines, and the one line when there is only one (its source and its year are then the cell's). */
export interface Allocation {
  allocatedVnd: string;
  allocationLineId: string | null;
  fundSourceVersionId: string | null;
  sourceYear: number | null;
}

export interface RevisionHead {
  id: string;
  projectId: string;
  periodId: string;
  planVersionId: string;
  revision: number;
  status: RevisionStatus;
  isCurrent: boolean;
  version: number;
  reportType: ReportType;
  measurementBasis: MeasurementBasis;
  isLate: boolean;
  submittedAt: string | null;
  acceptedAt: string | null;
  payloadHash: string;
  negativeDeltaExplanation: string | null;
  clientOperationId: string | null;
  deleted: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** A cell of a report with what the plan allocated to it and what the period before it had reached (BR-DIS-03). */
export interface FundingLineRow {
  bucket: FundingBucket;
  budgetLevel: BudgetLevel;
  allocatedVnd: string;
  cumulativeVnd: string;
  ctmtqgVnd: string | null;
  nextMonthVnd: string;
  nextMonthCtmtqgVnd: string | null;
  sourceYear: number | null;
  previousCumulativeVnd: string | null;
  deltaVnd: string | null;
}

export interface RevisionDetail extends RevisionHead {
  project: ReportProject;
  period: ReportPeriodFacts;
  plan: PlanFacts;
  lines: FundingLineRow[];
  totals: FundingTotals & { allocatedVnd: string };
}

export interface RevisionLine {
  id: string;
  project: { id: string; code: string; name: string };
  period: { id: string; code: string; endDate: string; fiscalYear: number; status: string };
  planVersionId: string;
  revision: number;
  status: RevisionStatus;
  reportType: ReportType;
  isLate: boolean;
  version: number;
  cumulativeVnd: string;
  ctmtqgVnd: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportFilter {
  fiscalYear?: number | undefined;
  periodId?: string | undefined;
  planVersionId?: string | undefined;
  /** The annual plan (the capital plan) the plan version of the report belongs to. */
  planId?: string | undefined;
  projectId?: string | undefined;
  status?: string | undefined;
  reportType?: string | undefined;
}

/** A figure of the list with the words that say what it is a total of (SRC-01/02: a filtered table and the whole scope are not the same number). */
export interface ReportKpi {
  reports: number;
  projects: number;
  cumulativeVnd: string;
  ctmtqgVnd: string;
}

export interface NewDraft {
  projectId: string;
  periodId: string;
  planVersionId: string;
  reportType: ReportType;
  measurementBasis: MeasurementBasis;
  cells: readonly FundingInput[];
  negativeDeltaExplanation: string | null;
  clientOperationId: string | undefined;
  allocations: ReadonlyMap<string, Allocation>;
}

export interface DraftContent {
  measurementBasis: MeasurementBasis;
  cells: readonly FundingInput[];
  negativeDeltaExplanation: string | null;
}

interface HeadSql {
  id: string;
  project_id: string;
  period_id: string;
  plan_version_id: string;
  revision: number;
  status: RevisionStatus;
  is_current: boolean;
  version: string;
  report_type: ReportType;
  measurement_basis: MeasurementBasis;
  is_late: boolean;
  submitted_at: string | null;
  accepted_at: string | null;
  payload_hash: string;
  negative_delta_explanation: string | null;
  client_operation_id: string | null;
  deleted: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

const HEAD_COLUMNS = `r.id, r.project_id, r.period_id, r.plan_version_id, r.revision, r.status, r.is_current, r.version::text as version, r.report_type, r.measurement_basis, r.is_late,
  ${iso('r.submitted_at')} as submitted_at, ${iso('r.accepted_at')} as accepted_at, r.payload_hash, r.negative_delta_explanation, r.client_operation_id, (r.deleted_at is not null) as deleted,
  ${iso('r.created_at')} as created_at, r.created_by, ${iso('r.updated_at')} as updated_at, r.updated_by`;

const toHead = (row: HeadSql): RevisionHead => ({
  id: row.id,
  projectId: row.project_id,
  periodId: row.period_id,
  planVersionId: row.plan_version_id,
  revision: row.revision,
  status: row.status,
  isCurrent: row.is_current,
  version: Number(row.version),
  reportType: row.report_type,
  measurementBasis: row.measurement_basis,
  isLate: row.is_late,
  submittedAt: row.submitted_at,
  acceptedAt: row.accepted_at,
  payloadHash: row.payload_hash,
  negativeDeltaExplanation: row.negative_delta_explanation,
  clientOperationId: row.client_operation_id,
  deleted: row.deleted,
  createdAt: row.created_at,
  createdBy: row.created_by,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

/**
 * The weekly report draft (ST-DIS-003, DIS 3 F1): a project's report for a period starts as revision 1 in DRAFT with the plan version that was in force at the end of the period, the six
 * cells of cumulative disbursement (BR-DIS-01) with what the plan allocated to each, and is saved with the version the screen showed. A report is found through the project it is about: the
 * owner unit, the investor unit or the project itself in a scope of a grant that carries the permission. What was handed in is not edited: the table says so (`report_revision_guard`).
 */
export class DisReportStore {
  /**
   * The project of a report in the scope of the caller: 404 when it does not exist or lies outside the scope (the same answer, BR-IAM-01), 403 when the caller sees it and may not act on it.
   * The second scope is checked after the first so that the answer does not depend on timing.
   */
  async project(tx: TenantTx, projectId: string, seen: ScopeBuilder, acts: ScopeBuilder): Promise<ReportProject> {
    const visible = seen(2);
    const [row] = await tx.query<{ id: string; code: string; name: string; status: string }>(`select p.id, p.code, p.name, p.status from ${SCOPE_FROM} where p.id = $1::uuid and ${visible.sql}`, [projectId, ...visible.params]);
    if (row === undefined) throw NOT_FOUND();
    const own = acts(2);
    const [allowed] = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${own.sql}`, [projectId, ...own.params]);
    if (allowed === undefined) throw new DomainError('SCOPE_DENIED', 403);
    return row;
  }

  /** The plan version of the project in force for a period: the newest version published up to the last day of the period, in the fiscal year of the period. */
  async effectivePlan(tx: TenantTx, projectId: string, fiscalYear: number, endDate: string): Promise<PlanFacts | undefined> {
    const [row] = await tx.query<{ id: string; project_id: string; fiscal_year: number; revision: number; status: string }>(
      `select id, project_id, fiscal_year, revision, status from machvon.plan_version
        where project_id = $1::uuid and fiscal_year = $2 and status in ('PUBLISHED', 'SUPERSEDED') and (effective_at at time zone 'Asia/Ho_Chi_Minh')::date <= $3::date
        order by effective_at desc, revision desc limit 1`,
      [projectId, fiscalYear, endDate],
    );
    return row === undefined ? undefined : { id: row.id, projectId: row.project_id, fiscalYear: row.fiscal_year, revision: row.revision, status: row.status };
  }

  /** What the plan version allocated to each of the six cells (read only on the report). */
  async allocations(tx: TenantTx, planVersionId: string): Promise<Map<string, Allocation>> {
    const lines = await tx.query<{ id: string; bucket: string; budget_level: string | null; amount_vnd: string; fund_source_version_id: string | null; source_year: number | null }>(
      'select id, bucket, budget_level, amount_vnd::text as amount_vnd, fund_source_version_id, source_year from machvon.allocation_line where plan_version_id = $1::uuid order by id',
      [planVersionId],
    );
    const grouped = new Map<string, typeof lines>();
    for (const line of lines) {
      if (line.budget_level === null) continue;
      const key = cellKey(line.bucket, line.budget_level);
      grouped.set(key, [...(grouped.get(key) ?? []), line]);
    }
    const result = new Map<string, Allocation>();
    for (const cell of FUNDING_CELLS) {
      const key = cellKey(cell.bucket, cell.budgetLevel);
      const members = grouped.get(key) ?? [];
      const total = members.reduce((sum, line) => sum + BigInt(line.amount_vnd), 0n);
      const only = members.length === 1 ? members[0] : undefined;
      result.set(key, { allocatedVnd: total.toString(), allocationLineId: only?.id ?? null, fundSourceVersionId: only?.fund_source_version_id ?? null, sourceYear: only?.source_year ?? null });
    }
    return result;
  }

  /**
   * What the period before this one had reached in each cell, for the comparison of BR-DIS-03: the accepted, current revision of the project in the latest earlier period of the same type and
   * fiscal year. A period with none before it (the first of the year, or one nothing was accepted in) has no comparison.
   */
  async previousCumulative(tx: TenantTx, projectId: string, period: ReportPeriodFacts): Promise<Map<string, string>> {
    const lines = await tx.query<{ bucket: string; budget_level: string; cumulative: string }>(
      `select l.bucket, l.budget_level, l.disbursed_cumulative_vnd::text as cumulative
         from machvon.funding_snapshot_line l
        where l.report_revision_id = (
          select r.id from machvon.report_revision r join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
           where r.project_id = $1::uuid and r.is_current and r.status = 'ACCEPTED' and rp.period_type = $2 and rp.fiscal_year = $3 and rp.end_date < $4::date
           order by rp.end_date desc, r.revision desc limit 1)`,
      [projectId, period.periodType, period.fiscalYear, period.startDate],
    );
    return new Map(lines.map((line) => [cellKey(line.bucket, line.budget_level), line.cumulative]));
  }

  /** The newest revision of a project in a period, whatever its status; undefined when none was ever made. */
  async latestFor(tx: TenantTx, projectId: string, periodId: string): Promise<RevisionHead | undefined> {
    const [row] = await tx.query<HeadSql>(`select ${HEAD_COLUMNS} from machvon.report_revision r where r.project_id = $1::uuid and r.period_id = $2::uuid order by r.revision desc limit 1`, [projectId, periodId]);
    return row === undefined ? undefined : toHead(row);
  }

  /** The revision a client operation made earlier (a mobile command sent again), if any. */
  async byClientOperation(tx: TenantTx, clientOperationId: string): Promise<RevisionHead | undefined> {
    const [row] = await tx.query<HeadSql>(`select ${HEAD_COLUMNS} from machvon.report_revision r where r.client_operation_id = $1::uuid`, [clientOperationId]);
    return row === undefined ? undefined : toHead(row);
  }

  /** A revision is edited while it is a live draft; one that was handed in, or deleted, is not (409 `REVISION_IMMUTABLE`, naming its status). */
  assertEditable(head: RevisionHead): void {
    if (head.status !== 'DRAFT' || head.deleted) throw new DomainError('REVISION_IMMUTABLE', 409, 'status', { extensions: { report_status: head.status } });
  }

  /**
   * Writes revision 1 as a DRAFT with its six cells. A project has one revision per period to begin with: a live draft is 409 `DRAFT_EXISTS` naming it, any other earlier revision is 409
   * `REPORT_STATE_INVALID` (a later revision is a correction, DIS-006). The hash is the one of the canonical content, so a replay of the same entries is recognised.
   */
  async createDraft(tx: TenantTx, input: NewDraft, actor: string): Promise<{ id: string; version: number }> {
    const earlier = await this.latestFor(tx, input.projectId, input.periodId);
    if (earlier !== undefined) {
      const live = earlier.status === 'DRAFT' && !earlier.deleted;
      throw new DomainError(live ? 'DRAFT_EXISTS' : 'REPORT_STATE_INVALID', 409, 'period_id', { extensions: { report_id: earlier.id, revision: earlier.revision, report_status: earlier.status } });
    }
    const id = randomUUID();
    const hash = draftHash({
      projectId: input.projectId,
      periodId: input.periodId,
      planVersionId: input.planVersionId,
      reportType: input.reportType,
      measurementBasis: input.measurementBasis,
      cells: input.cells,
      negativeDeltaExplanation: input.negativeDeltaExplanation,
    });
    try {
      await this.insertRevision(tx, { id, hash, input, actor });
    } catch (error) {
      // A client operation names one report for good: the same id for another report is a mistake of the client, not a second draft.
      if ((error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'report_revision_client_op_uq') throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'client_operation_id');
      throw error;
    }
    for (const cell of input.cells) {
      await this.insertCell(tx, id, cell, input.allocations.get(cellKey(cell.bucket, cell.budgetLevel)));
    }
    return { id, version: 1 };
  }

  private async insertRevision(tx: TenantTx, row: { id: string; hash: string; input: NewDraft; actor: string }): Promise<void> {
    const { id, hash, input, actor } = row;
    await withUniqueClaim(tx, { constraint: ['report_revision_draft_uq', 'report_revision_number'], code: 'DRAFT_EXISTS' }, async () => {
      await tx.query(
        `insert into machvon.report_revision
           (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, report_type, measurement_basis, negative_delta_explanation,
            client_operation_id, source_kind, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'DRAFT', false, 1, $5, $6, $7, $8, $9::uuid, 'MANUAL', $10::uuid, $10::uuid)`,
        [id, input.projectId, input.periodId, input.planVersionId, hash, input.reportType, input.measurementBasis, input.negativeDeltaExplanation, input.clientOperationId ?? null, actor],
      );
    });
  }

  private async insertCell(tx: TenantTx, reportId: string, cell: FundingInput, allocation: Allocation | undefined): Promise<void> {
    await tx.query(
      `insert into machvon.funding_snapshot_line
         (tenant_id, id, report_revision_id, bucket, budget_level, disbursed_cumulative_vnd, ctmtqg_subset_vnd, next_month_registered_vnd, next_month_ctmtqg_subset_vnd, allocated_vnd,
          source_year, fund_source_version_id, allocation_line_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, $10::uuid, $11::uuid)`,
      [
        reportId,
        cell.bucket,
        cell.budgetLevel,
        cell.cumulativeVnd,
        cell.ctmtqgVnd,
        cell.nextMonthVnd,
        cell.nextMonthCtmtqgVnd,
        allocation?.allocatedVnd ?? '0',
        cell.sourceYear ?? allocation?.sourceYear ?? null,
        allocation?.fundSourceVersionId ?? null,
        allocation?.allocationLineId ?? null,
      ],
    );
  }

  /**
   * Locks a revision for a command in the scope of the caller (404 outside it, 403 when the caller sees it and may not act on it). The version must be the one the screen showed (409
   * `VERSION_CONFLICT`); a revision that is no longer a live draft is not edited (409 `REVISION_IMMUTABLE`).
   */
  async lock(tx: TenantTx, id: string, seen: ScopeBuilder, acts: ScopeBuilder, expectedVersion: number): Promise<RevisionHead> {
    const visible = seen(2);
    const [located] = await tx.query<{ id: string }>(`select r.id from ${REPORT_FROM} where r.id = $1::uuid and ${visible.sql}`, [id, ...visible.params]);
    if (located === undefined) throw NOT_FOUND();
    const [row] = await tx.query<HeadSql>(`select ${HEAD_COLUMNS} from machvon.report_revision r where r.id = $1::uuid for update of r`, [id]);
    if (row === undefined) throw NOT_FOUND();
    const own = acts(2);
    const [allowed] = await tx.query<{ id: string }>(`select r.id from ${REPORT_FROM} where r.id = $1::uuid and ${own.sql}`, [id, ...own.params]);
    if (allowed === undefined) throw new DomainError('SCOPE_DENIED', 403);
    const head = toHead(row);
    if (head.version !== expectedVersion) throw versionConflict(head.version);
    return head;
  }

  /** Saves the entries of a live draft: the cells and the basis are replaced, the amounts the plan allocated stay, and the hash and the version move. */
  async saveDraft(tx: TenantTx, head: RevisionHead, content: DraftContent, actor: string): Promise<{ version: number; payloadHash: string }> {
    this.assertEditable(head);
    const hash = draftHash({
      projectId: head.projectId,
      periodId: head.periodId,
      planVersionId: head.planVersionId,
      reportType: head.reportType,
      measurementBasis: content.measurementBasis,
      cells: content.cells,
      negativeDeltaExplanation: content.negativeDeltaExplanation,
    });
    for (const cell of content.cells) {
      await tx.query(
        `update machvon.funding_snapshot_line
            set disbursed_cumulative_vnd = $3::numeric, ctmtqg_subset_vnd = $4::numeric, next_month_registered_vnd = $5::numeric, next_month_ctmtqg_subset_vnd = $6::numeric,
                source_year = coalesce($7, source_year)
          where report_revision_id = $1::uuid and bucket = $2 and budget_level = $8`,
        [head.id, cell.bucket, cell.cumulativeVnd, cell.ctmtqgVnd, cell.nextMonthVnd, cell.nextMonthCtmtqgVnd, cell.sourceYear, cell.budgetLevel],
      );
    }
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.report_revision
          set measurement_basis = $2, negative_delta_explanation = $3, payload_hash = $4, updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [head.id, content.measurementBasis, content.negativeDeltaExplanation, hash, actor],
    );
    return { version: Number((updated as { version: string }).version), payloadHash: hash };
  }

  /** One report in the scope of the caller with its project, its period, its plan version and its cells; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, id: string, seen: ScopeBuilder): Promise<RevisionDetail | undefined> {
    const visible = seen(2);
    const [row] = await tx.query<
      HeadSql & {
        p_code: string;
        p_name: string;
        p_status: string;
        rp_code: string;
        rp_type: string;
        rp_year: number;
        rp_start: string;
        rp_end: string;
        rp_status: string;
        pv_year: number;
        pv_revision: number;
        pv_status: string;
        pv_project: string;
      }
    >(
      `select ${HEAD_COLUMNS}, p.code as p_code, p.name as p_name, p.status as p_status, rp.code as rp_code, rp.period_type as rp_type, rp.fiscal_year as rp_year,
              rp.start_date::text as rp_start, rp.end_date::text as rp_end, rp.status as rp_status, pv.fiscal_year as pv_year, pv.revision as pv_revision, pv.status as pv_status, pv.project_id as pv_project
         from ${REPORT_FROM}
         join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
         join machvon.plan_version pv on pv.tenant_id = r.tenant_id and pv.id = r.plan_version_id
        where r.id = $1::uuid and ${visible.sql}`,
      [id, ...visible.params],
    );
    if (row === undefined) return undefined;
    const head = toHead(row);
    const period: ReportPeriodFacts = { id: row.period_id, code: row.rp_code, periodType: row.rp_type, fiscalYear: row.rp_year, startDate: row.rp_start, endDate: row.rp_end, status: row.rp_status };
    const stored = await tx.query<{
      bucket: FundingBucket;
      budget_level: BudgetLevel;
      allocated: string | null;
      cumulative: string;
      ctmtqg: string | null;
      next_month: string;
      next_month_ctmtqg: string | null;
      source_year: number | null;
    }>(
      `select bucket, budget_level, allocated_vnd::text as allocated, disbursed_cumulative_vnd::text as cumulative, ctmtqg_subset_vnd::text as ctmtqg,
              next_month_registered_vnd::text as next_month, next_month_ctmtqg_subset_vnd::text as next_month_ctmtqg, source_year
         from machvon.funding_snapshot_line where report_revision_id = $1::uuid`,
      [id],
    );
    const previous = await this.previousCumulative(tx, head.projectId, period);
    const byCell = new Map(stored.map((line) => [cellKey(line.bucket, line.budget_level), line]));
    const lines: FundingLineRow[] = FUNDING_CELLS.flatMap((cell): FundingLineRow[] => {
      const line = byCell.get(cellKey(cell.bucket, cell.budgetLevel));
      if (line === undefined) return [];
      const before = previous.get(cellKey(cell.bucket, cell.budgetLevel)) ?? null;
      return [
        {
          bucket: cell.bucket,
          budgetLevel: cell.budgetLevel,
          allocatedVnd: line.allocated ?? '0',
          cumulativeVnd: line.cumulative,
          ctmtqgVnd: line.ctmtqg,
          nextMonthVnd: line.next_month,
          nextMonthCtmtqgVnd: line.next_month_ctmtqg,
          sourceYear: line.source_year,
          previousCumulativeVnd: before,
          deltaVnd: deltaOf(before, line.cumulative),
        },
      ];
    });
    const totals = fundingTotals(lines);
    const allocated = lines.reduce((sum, line) => sum + BigInt(line.allocatedVnd), 0n);
    return {
      ...head,
      project: { id: head.projectId, code: row.p_code, name: row.p_name, status: row.p_status },
      period,
      plan: { id: head.planVersionId, projectId: row.pv_project, fiscalYear: row.pv_year, revision: row.pv_revision, status: row.pv_status },
      lines,
      totals: { ...totals, allocatedVnd: allocated.toString() },
    };
  }

  /** The reports in the scope of the caller, newest first; the cursor is the instant the report was made and its id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: ReportFilter, request: { limit: number; after: { createdAt: string; id: string } | undefined }): Promise<RevisionLine[]> {
    const predicate = scope(11);
    const rows = await tx.query<{
      id: string;
      project_id: string;
      p_code: string;
      p_name: string;
      period_id: string;
      rp_code: string;
      rp_end: string;
      rp_year: number;
      rp_status: string;
      plan_version_id: string;
      revision: number;
      status: RevisionStatus;
      report_type: ReportType;
      is_late: boolean;
      version: string;
      cumulative: string;
      ctmtqg: string;
      created_at: string;
      updated_at: string;
    }>(
      `select r.id, r.project_id, p.code as p_code, p.name as p_name, r.period_id, rp.code as rp_code, rp.end_date::text as rp_end, rp.fiscal_year as rp_year, rp.status as rp_status,
              r.plan_version_id, r.revision, r.status, r.report_type, r.is_late, r.version::text as version,
              coalesce((select sum(l.disbursed_cumulative_vnd) from machvon.funding_snapshot_line l where l.tenant_id = r.tenant_id and l.report_revision_id = r.id), 0)::text as cumulative,
              coalesce((select sum(l.ctmtqg_subset_vnd) from machvon.funding_snapshot_line l where l.tenant_id = r.tenant_id and l.report_revision_id = r.id), 0)::text as ctmtqg,
              ${iso('r.created_at')} as created_at, ${iso('r.updated_at')} as updated_at
         from ${REPORT_FROM}
         join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
        where r.deleted_at is null and ($1::timestamptz is null or (r.created_at, r.id) < ($1::timestamptz, $2::uuid))
          and ${filterSql(4)} and ${predicate.sql}
        order by r.created_at desc, r.id desc limit $3`,
      [request.after?.createdAt ?? null, request.after?.id ?? null, request.limit, ...filterParams(filter), ...predicate.params],
    );
    return rows.map((row) => ({
      id: row.id,
      project: { id: row.project_id, code: row.p_code, name: row.p_name },
      period: { id: row.period_id, code: row.rp_code, endDate: row.rp_end, fiscalYear: row.rp_year, status: row.rp_status },
      planVersionId: row.plan_version_id,
      revision: row.revision,
      status: row.status,
      reportType: row.report_type,
      isLate: row.is_late,
      version: Number(row.version),
      cumulativeVnd: row.cumulative,
      ctmtqgVnd: row.ctmtqg,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * What the reports of a filter add up to, for the figures above the list (SRC-01/02): the number of reports and of projects, the cumulative disbursement and the CTMTQG inside it. The same
   * reports are counted whatever page is shown; the totals of two filters are two figures, and the screen says which filter each belongs to.
   */
  async kpi(tx: TenantTx, scope: ScopeBuilder, filter: ReportFilter): Promise<ReportKpi> {
    const predicate = scope(8);
    const [row] = await tx.query<{ reports: string; projects: string; cumulative: string; ctmtqg: string }>(
      `select count(*)::text as reports, count(distinct r.project_id)::text as projects,
              coalesce(sum((select sum(l.disbursed_cumulative_vnd) from machvon.funding_snapshot_line l where l.tenant_id = r.tenant_id and l.report_revision_id = r.id)), 0)::text as cumulative,
              coalesce(sum((select sum(l.ctmtqg_subset_vnd) from machvon.funding_snapshot_line l where l.tenant_id = r.tenant_id and l.report_revision_id = r.id)), 0)::text as ctmtqg
         from ${REPORT_FROM}
         join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
        where r.deleted_at is null and ${filterSql(1)} and ${predicate.sql}`,
      [...filterParams(filter), ...predicate.params],
    );
    const found = row as { reports: string; projects: string; cumulative: string; ctmtqg: string };
    return { reports: Number(found.reports), projects: Number(found.projects), cumulativeVnd: found.cumulative, ctmtqgVnd: found.ctmtqg };
  }
}

/** The seven filters of the list as conditions over seven consecutive parameters from `first`: a filter that is not given lets everything through. */
function filterSql(first: number): string {
  const at = (offset: number): string => '$' + String(first + offset);
  return [
    `(${at(0)}::int is null or rp.fiscal_year = ${at(0)}::int)`,
    `(${at(1)}::uuid is null or r.period_id = ${at(1)}::uuid)`,
    `(${at(2)}::uuid is null or r.plan_version_id = ${at(2)}::uuid)`,
    `(${at(3)}::uuid is null or r.project_id = ${at(3)}::uuid)`,
    `(${at(4)}::text is null or r.status = ${at(4)}::text)`,
    `(${at(5)}::text is null or r.report_type = ${at(5)}::text)`,
    `(${at(6)}::uuid is null or exists (select 1 from machvon.plan_version pv where pv.tenant_id = r.tenant_id and pv.id = r.plan_version_id and pv.capital_plan_id = ${at(6)}::uuid))`,
  ].join(' and ');
}

const filterParams = (filter: ReportFilter): unknown[] => [
  filter.fiscalYear ?? null,
  filter.periodId ?? null,
  filter.planVersionId ?? null,
  filter.projectId ?? null,
  filter.status ?? null,
  filter.reportType ?? null,
  filter.planId ?? null,
];
