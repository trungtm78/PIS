import { randomUUID } from 'node:crypto';
import { DomainError, FUNDING_CELLS, deltaOf, draftHash, fundingTotals, versionConflict } from '@machvon/kernel';
import type { AttachmentRef, BudgetLevel, FundingBucket, FundingInput, FundingTotals, MeasurementBasis, NarrativeInput, ProgressInput, ReportType, RevisionStatus } from '@machvon/kernel';
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

/** The volumes of a report as they are kept: the date is the last day of the period, the basis the one of the report. */
export interface ProgressRow extends ProgressInput {
  asOfDate: string;
  measurementBasis: MeasurementBasis;
}

/** A file attached to a report as the upload door answered it, in the order it was attached. */
export interface AttachmentFile extends AttachmentRef {
  contentType: string;
  sizeBytes: number;
}

export interface AttachmentRow extends AttachmentFile {
  id: string;
  position: number;
  createdAt: string;
  createdBy: string;
}

export interface RevisionDetail extends RevisionHead {
  project: ReportProject;
  period: ReportPeriodFacts;
  plan: PlanFacts;
  lines: FundingLineRow[];
  totals: FundingTotals & { allocatedVnd: string };
  progress: ProgressRow | null;
  narrative: NarrativeInput | null;
  attachments: AttachmentRow[];
}

/** What the Treasury paid for a project in a window of days (reversals taken off), and in how many transactions. */
export interface TreasuryFigure {
  totalVnd: string;
  transactions: number;
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
  progress: ProgressInput | null;
  narrative: NarrativeInput | null;
  attachments: readonly AttachmentFile[];
  /** The last day of the period: the date the volumes are as of. */
  asOfDate: string;
  clientOperationId: string | undefined;
  allocations: ReadonlyMap<string, Allocation>;
}

/**
 * What a save enters. The basis, the cells and the explanation are the whole of those; the volumes, the narrative and the files are replaced when the request names them and kept as they are when
 * it does not (undefined), so that each screen of the draft saves what it shows and nothing it does not.
 */
export interface DraftContent {
  measurementBasis: MeasurementBasis;
  cells: readonly FundingInput[];
  negativeDeltaExplanation: string | null;
  progress: ProgressInput | undefined;
  narrative: NarrativeInput | null | undefined;
  attachments: readonly AttachmentFile[] | undefined;
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
      progress: input.progress,
      narrative: input.narrative,
      attachments: input.attachments,
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
    if (input.progress !== null) await this.writeProgress(tx, id, input.progress, input.asOfDate, input.measurementBasis);
    if (input.narrative !== null) await this.writeNarrative(tx, id, input.narrative, actor);
    await this.writeAttachments(tx, id, input.attachments, actor);
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

  /**
   * Saves the entries of a live draft: the cells and the basis are replaced, the amounts the plan allocated stay; the volumes, the narrative and the files are replaced when the save names them and kept
   * when it does not. The hash is of what the draft holds after the save, and the version moves once.
   */
  async saveDraft(tx: TenantTx, head: RevisionHead, content: DraftContent, asOfDate: string, actor: string): Promise<{ version: number; payloadHash: string }> {
    this.assertEditable(head);
    const progress = content.progress === undefined ? ((await this.progressOf(tx, head.id))?.progress ?? null) : content.progress;
    const narrative = content.narrative === undefined ? await this.narrativeOf(tx, head.id) : content.narrative;
    const attachments = content.attachments ?? (await this.attachmentsOf(tx, head.id));
    const hash = draftHash({
      projectId: head.projectId,
      periodId: head.periodId,
      planVersionId: head.planVersionId,
      reportType: head.reportType,
      measurementBasis: content.measurementBasis,
      cells: content.cells,
      negativeDeltaExplanation: content.negativeDeltaExplanation,
      progress,
      narrative,
      attachments,
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
    // The volumes are read on the basis of the report: a new basis moves them with it, even when the save does not name them.
    if (progress !== null) await this.writeProgress(tx, head.id, progress, asOfDate, content.measurementBasis);
    if (content.narrative !== undefined) await this.writeNarrative(tx, head.id, content.narrative, actor);
    if (content.attachments !== undefined) await this.writeAttachments(tx, head.id, content.attachments, actor);
    return { version: Number((updated as { version: string }).version), payloadHash: hash };
  }

  /** The volumes of a report with the date and the basis they are kept with; undefined when none were entered. */
  async progressOf(tx: TenantTx, reportId: string): Promise<{ progress: ProgressInput; asOfDate: string; measurementBasis: MeasurementBasis } | undefined> {
    const [row] = await tx.query<{ construction: string; acceptance: string; treasury: string; preparing: string; pct: string | null; as_of: string; basis: MeasurementBasis }>(
      `select construction_value_vnd::text as construction, acceptance_value_vnd::text as acceptance, treasury_submitted_value_vnd::text as treasury, preparing_dossier_value_vnd::text as preparing,
              physical_progress_pct::text as pct, as_of_date::text as as_of, measurement_basis as basis
         from machvon.progress_snapshot where report_revision_id = $1::uuid`,
      [reportId],
    );
    if (row === undefined) return undefined;
    return {
      progress: { constructionVnd: row.construction, acceptanceVnd: row.acceptance, treasurySubmittedVnd: row.treasury, preparingDossierVnd: row.preparing, physicalProgressPct: row.pct },
      asOfDate: row.as_of,
      measurementBasis: row.basis,
    };
  }

  /** The narrative of a report; null when none was written. */
  async narrativeOf(tx: TenantTx, reportId: string): Promise<NarrativeInput | null> {
    const [row] = await tx.query<{ results: string | null; causes: string | null; solutions: string | null; proposals: string | null; issues: string[] | null }>(
      'select results_text as results, causes_text as causes, solutions_text as solutions, proposals_text as proposals, linked_issue_ids as issues from machvon.report_narrative where report_revision_id = $1::uuid',
      [reportId],
    );
    return row === undefined ? null : { resultsText: row.results, causesText: row.causes, solutionsText: row.solutions, proposalsText: row.proposals, linkedIssueIds: row.issues ?? [] };
  }

  /** The issues among the ones named that do not exist or are not issues of the project; empty when every one is. */
  async issuesOutside(tx: TenantTx, projectId: string, issueIds: readonly string[]): Promise<string[]> {
    const found = await tx.query<{ id: string }>('select id from machvon.issue where project_id = $1::uuid and id = any($2::uuid[])', [projectId, [...issueIds]]);
    const present = new Set(found.map((row) => row.id));
    return issueIds.filter((id) => !present.has(id));
  }

  /** The files attached to a report, in the order they were attached. */
  async attachmentsOf(tx: TenantTx, reportId: string): Promise<AttachmentRow[]> {
    const rows = await tx.query<{ id: string; file_object_id: string; file_sha256: string; file_name: string; content_type: string; size_bytes: string; position: number; created_at: string; created_by: string }>(
      `select id, file_object_id, file_sha256, file_name, content_type, size_bytes::text as size_bytes, position, ${iso('created_at')} as created_at, created_by
         from machvon.report_attachment where report_revision_id = $1::uuid order by position`,
      [reportId],
    );
    return rows.map((row) => ({
      id: row.id,
      fileObjectId: row.file_object_id,
      fileSha256: row.file_sha256,
      fileName: row.file_name,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      position: row.position,
      createdAt: row.created_at,
      createdBy: row.created_by,
    }));
  }

  private async writeProgress(tx: TenantTx, reportId: string, progress: ProgressInput, asOfDate: string, basis: MeasurementBasis): Promise<void> {
    await tx.query(
      `insert into machvon.progress_snapshot
         (tenant_id, id, report_revision_id, construction_value_vnd, acceptance_value_vnd, treasury_submitted_value_vnd, preparing_dossier_value_vnd, measurement_basis, as_of_date, physical_progress_pct)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::numeric, $3::numeric, $4::numeric, $5::numeric, $6, $7::date, $8::numeric)
       on conflict (tenant_id, report_revision_id) do update
         set construction_value_vnd = excluded.construction_value_vnd, acceptance_value_vnd = excluded.acceptance_value_vnd, treasury_submitted_value_vnd = excluded.treasury_submitted_value_vnd,
             preparing_dossier_value_vnd = excluded.preparing_dossier_value_vnd, measurement_basis = excluded.measurement_basis, as_of_date = excluded.as_of_date,
             physical_progress_pct = excluded.physical_progress_pct`,
      [reportId, progress.constructionVnd, progress.acceptanceVnd, progress.treasurySubmittedVnd, progress.preparingDossierVnd, basis, asOfDate, progress.physicalProgressPct],
    );
  }

  /** The narrative is written whole: the row is replaced, and removed when the save leaves none. */
  private async writeNarrative(tx: TenantTx, reportId: string, narrative: NarrativeInput | null, actor: string): Promise<void> {
    if (narrative === null) {
      await tx.query('delete from machvon.report_narrative where report_revision_id = $1::uuid', [reportId]);
      return;
    }
    await tx.query(
      `insert into machvon.report_narrative
         (tenant_id, id, report_revision_id, results_text, causes_text, solutions_text, proposals_text, linked_issue_ids, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::uuid[], $7::uuid, $7::uuid)
       on conflict (tenant_id, report_revision_id) do update
         set results_text = excluded.results_text, causes_text = excluded.causes_text, solutions_text = excluded.solutions_text, proposals_text = excluded.proposals_text,
             linked_issue_ids = excluded.linked_issue_ids, updated_at = now(), updated_by = excluded.updated_by, version = machvon.report_narrative.version + 1`,
      [reportId, narrative.resultsText, narrative.causesText, narrative.solutionsText, narrative.proposalsText, [...narrative.linkedIssueIds], actor],
    );
  }

  /** The files are written as the whole list: the ones no longer named are unlinked, the ones that stay keep their row, the new ones are added at their place. */
  private async writeAttachments(tx: TenantTx, reportId: string, files: readonly AttachmentFile[], actor: string): Promise<void> {
    await tx.query('delete from machvon.report_attachment where report_revision_id = $1::uuid and not (file_object_id = any($2::uuid[]))', [reportId, files.map((file) => file.fileObjectId)]);
    for (const [index, file] of files.entries()) {
      await tx.query(
        `insert into machvon.report_attachment (tenant_id, id, report_revision_id, file_object_id, file_sha256, file_name, content_type, size_bytes, position, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6::bigint, $7, $8::uuid)
         on conflict (tenant_id, report_revision_id, file_object_id) do update set file_name = excluded.file_name, position = excluded.position`,
        [reportId, file.fileObjectId, file.fileSha256, file.fileName, file.contentType, file.sizeBytes, index + 1, actor],
      );
    }
  }

  /**
   * What the Treasury paid for the project from `from` to `to` (Vietnam days, `from` null for no start), the reversals taken off (BR-DIS-06: a payment counts on the day the Treasury booked it);
   * undefined when it booked nothing in the window, which is not the same as zero (BR-DIS-08).
   */
  async treasuryFigure(tx: TenantTx, projectId: string, window: { from: string | null; to: string }): Promise<TreasuryFigure | undefined> {
    const [row] = await tx.query<{ total: string; n: string }>(
      `select coalesce(sum(case when t.reversal_of_id is not null then -t.amount_vnd else t.amount_vnd end), 0)::text as total, count(*)::text as n
         from machvon.treasury_transaction t
        where t.project_id = $1::uuid and (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date <= $3::date
          and ($2::date is null or (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date >= $2::date)`,
      [projectId, window.from, window.to],
    );
    const found = row as { total: string; n: string };
    return Number(found.n) === 0 ? undefined : { totalVnd: found.total, transactions: Number(found.n) };
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
    const volumes = await this.progressOf(tx, id);
    return {
      ...head,
      project: { id: head.projectId, code: row.p_code, name: row.p_name, status: row.p_status },
      period,
      plan: { id: head.planVersionId, projectId: row.pv_project, fiscalYear: row.pv_year, revision: row.pv_revision, status: row.pv_status },
      lines,
      totals: { ...totals, allocatedVnd: allocated.toString() },
      progress: volumes === undefined ? null : { ...volumes.progress, asOfDate: volumes.asOfDate, measurementBasis: volumes.measurementBasis },
      narrative: await this.narrativeOf(tx, id),
      attachments: await this.attachmentsOf(tx, id),
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
