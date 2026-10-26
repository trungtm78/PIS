import { randomUUID } from 'node:crypto';
import { DomainError, FUNDING_CELLS, RESTORE_WINDOW_DAYS, assertFourEyes, decisionOutcome, deleteRefusal, deltaOf, draftHash, fundingTotals, restoreRefusal, versionConflict, withdrawRefusal } from '@machvon/kernel';
import type { AttachmentRef, DecisionInput, BudgetLevel, FundingBucket, FundingInput, FundingTotals, MeasurementBasis, NarrativeInput, ProgressInput, ReportType, RevisionStatus } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

/** The resource type of the audit rows and the events of a report. */
export const REPORT_RESOURCE = 'report_revision';
/** The metric of a decision of a reviewer, by what it led to, and the one of a correction that was started (DIS 9). */
export const DIS_DECISION_METRIC = 'dis_report_decision_total';
export const decisionLabels = (outcome: string): { decision: string } => ({ decision: outcome });
export const DIS_CORRECTION_METRIC = 'dis_report_correction_total';
/** The metric of a report that was taken back by its maker. */
export const DIS_WITHDRAWAL_METRIC = 'dis_report_withdrawal_total';

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
  submittedBy: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  returnedReason: string | null;
  /** The revision this one corrects, and why (revision 2 and after). */
  supersedesId: string | null;
  amendmentReason: string | null;
  /** Who took the report back, when and why (WITHDRAWN). */
  withdrawnBy: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  payloadHash: string;
  negativeDeltaExplanation: string | null;
  clientOperationId: string | null;
  deleted: boolean;
  /** When and why a draft was deleted (soft); restored within the window of the restore. */
  deletedAt: string | null;
  deletedReason: string | null;
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
  /** The drafts that were deleted and can still be restored, instead of the reports that stand. */
  deleted?: boolean | undefined;
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
  /** The batch of the bulk import that makes the draft (source IMPORT); none for a draft that a person starts. */
  importBatchId?: string | undefined;
}

/** A correction: a draft that is the next revision of a report that was handed in, with the report it corrects and why. */
export interface NewCorrection extends NewDraft {
  revision: number;
  supersedesId: string;
  amendmentReason: string;
}

/** A decision of a reviewer as it was kept (DIS 3 F2). */
export interface DecisionRow {
  id: string;
  decision: 'ACCEPTED' | 'RETURNED' | 'AMENDMENT_REQUESTED';
  reason: string;
  evidenceIds: string[];
  returnItems: string[];
  dueAt: string | null;
  decidedBy: string;
  decidedAt: string;
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
  submitted_by: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  returned_reason: string | null;
  supersedes_id: string | null;
  amendment_reason: string | null;
  withdrawn_by: string | null;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  payload_hash: string;
  negative_delta_explanation: string | null;
  client_operation_id: string | null;
  deleted: boolean;
  deleted_at: string | null;
  deleted_reason: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

const HEAD_COLUMNS = `r.id, r.project_id, r.period_id, r.plan_version_id, r.revision, r.status, r.is_current, r.version::text as version, r.report_type, r.measurement_basis, r.is_late,
  ${iso('r.submitted_at')} as submitted_at, r.submitted_by, ${iso('r.accepted_at')} as accepted_at, r.accepted_by, r.returned_reason, r.supersedes_id, r.amendment_reason, r.withdrawn_by, ${iso('r.withdrawn_at')} as withdrawn_at, r.withdrawn_reason, r.payload_hash, r.negative_delta_explanation, r.client_operation_id, (r.deleted_at is not null) as deleted,
  ${iso('r.deleted_at')} as deleted_at, r.deleted_reason,
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
  submittedBy: row.submitted_by,
  acceptedAt: row.accepted_at,
  acceptedBy: row.accepted_by,
  returnedReason: row.returned_reason,
  supersedesId: row.supersedes_id,
  amendmentReason: row.amendment_reason,
  withdrawnBy: row.withdrawn_by,
  withdrawnAt: row.withdrawn_at,
  withdrawnReason: row.withdrawn_reason,
  payloadHash: row.payload_hash,
  negativeDeltaExplanation: row.negative_delta_explanation,
  clientOperationId: row.client_operation_id,
  deleted: row.deleted,
  deletedAt: row.deleted_at,
  deletedReason: row.deleted_reason,
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
           where r.project_id = $1::uuid and r.is_current and r.status in ('ACCEPTED', 'AMENDMENT_REQUESTED') and rp.period_type = $2 and rp.fiscal_year = $3 and rp.end_date < $4::date
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
    await this.writeContent(tx, id, input, actor);
    return { id, version: 1 };
  }

  /**
   * Writes the revision that corrects another (ST-DIS-006): the next number of the report of the project in the period, a DRAFT that names the revision it corrects and the reason, with the cells,
   * the volumes, the narrative and the files the caller carried over. One live draft of a project and a period is the rule of the table: a second one is 409 `REVISION_PENDING_EXISTS`.
   */
  async createCorrection(tx: TenantTx, input: NewCorrection, actor: string): Promise<{ id: string; version: number; revision: number }> {
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
    await this.insertRevision(tx, { id, hash, input, actor }, { revision: input.revision, supersedesId: input.supersedesId, amendmentReason: input.amendmentReason });
    await this.writeContent(tx, id, input, actor);
    return { id, version: 1, revision: input.revision };
  }

  private async writeContent(tx: TenantTx, id: string, input: NewDraft, actor: string): Promise<void> {
    for (const cell of input.cells) {
      await this.insertCell(tx, id, cell, input.allocations.get(cellKey(cell.bucket, cell.budgetLevel)));
    }
    if (input.progress !== null) await this.writeProgress(tx, id, input.progress, input.asOfDate, input.measurementBasis);
    if (input.narrative !== null) await this.writeNarrative(tx, id, input.narrative, actor);
    await this.writeAttachments(tx, id, input.attachments, actor);
  }

  private async insertRevision(
    tx: TenantTx,
    row: { id: string; hash: string; input: NewDraft; actor: string },
    lineage?: { revision: number; supersedesId: string; amendmentReason: string },
  ): Promise<void> {
    const { id, hash, input, actor } = row;
    const claim = { constraint: ['report_revision_draft_uq', 'report_revision_number'], code: lineage === undefined ? 'DRAFT_EXISTS' : 'REVISION_PENDING_EXISTS' };
    await withUniqueClaim(tx, claim, async () => {
      await tx.query(
        `insert into machvon.report_revision
           (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, report_type, measurement_basis, negative_delta_explanation,
            client_operation_id, source_kind, import_batch_id, supersedes_id, amendment_reason, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $11::int, 'DRAFT', false, 1, $5, $6, $7, $8, $9::uuid, case when $14::uuid is null then 'MANUAL' else 'IMPORT' end, $14::uuid, $12::uuid, $13, $10::uuid, $10::uuid)`,
        [
          id,
          input.projectId,
          input.periodId,
          input.planVersionId,
          hash,
          input.reportType,
          input.measurementBasis,
          input.negativeDeltaExplanation,
          input.clientOperationId ?? null,
          actor,
          lineage?.revision ?? 1,
          lineage?.supersedesId ?? null,
          lineage?.amendmentReason ?? null,
          input.importBatchId ?? null,
        ],
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

  /** The hash of the content a draft holds now, as a save seals it: the identity of the report, the basis, the six cells, the explanation, the volumes, the notes and the files. */
  hashOf(detail: RevisionDetail): string {
    return draftHash({
      projectId: detail.projectId,
      periodId: detail.periodId,
      planVersionId: detail.planVersionId,
      reportType: detail.reportType,
      measurementBasis: detail.measurementBasis,
      cells: detail.lines.map((line) => ({
        bucket: line.bucket,
        budgetLevel: line.budgetLevel,
        cumulativeVnd: line.cumulativeVnd,
        ctmtqgVnd: line.ctmtqgVnd,
        nextMonthVnd: line.nextMonthVnd,
        nextMonthCtmtqgVnd: line.nextMonthCtmtqgVnd,
        sourceYear: line.sourceYear,
      })),
      negativeDeltaExplanation: detail.negativeDeltaExplanation,
      progress: detail.progress === null ? null : { constructionVnd: detail.progress.constructionVnd, acceptanceVnd: detail.progress.acceptanceVnd, treasurySubmittedVnd: detail.progress.treasurySubmittedVnd, preparingDossierVnd: detail.progress.preparingDossierVnd, physicalProgressPct: detail.progress.physicalProgressPct },
      narrative: detail.narrative,
      attachments: detail.attachments,
    });
  }

  /** The approval workflow of the review that is published for a kind of business, newest revision first; undefined when none is (the report then goes without one). */
  async workflowVersionFor(tx: TenantTx, businessType: string): Promise<string | undefined> {
    const [row] = await tx.query<{ id: string }>("select id from machvon.workflow_version where business_type = $1 and kind = 'APPROVAL' and status = 'Published' order by revision desc, id limit 1", [businessType]);
    return row?.id;
  }

  /**
   * Hands a live draft in: SUBMITTED, with who did it, the time the server took, whether it was late by the calendar of its period, the hash of what it holds and the workflow it goes through; the
   * version moves once. The report stays not current until the review accepts it.
   */
  async submit(tx: TenantTx, head: RevisionHead, input: { actor: string; at: Date; late: boolean; payloadHash: string; workflowVersionId: string | undefined }): Promise<{ version: number }> {
    this.assertEditable(head);
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.report_revision
          set status = 'SUBMITTED', submitted_by = $2::uuid, submitted_at = $3::timestamptz, is_late = $4, payload_hash = $5, workflow_version_id = $6::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1
        where id = $1::uuid and status = 'DRAFT' and deleted_at is null returning version::text as version`,
      [head.id, input.actor, input.at.toISOString(), input.late, input.payloadHash, input.workflowVersionId ?? null],
    );
    if (updated === undefined) throw new DomainError('REVISION_IMMUTABLE', 409, 'status', { extensions: { report_status: head.status } });
    return { version: Number(updated.version) };
  }

  /**
   * Takes a decision on a report that was handed in (DIS 3 F2): the report moves along the graph (409 `REPORT_STATE_INVALID` off it), the person who handed it in is not the one who decides (403
   * `SELF_APPROVAL_DENIED`), and the decision is kept as it was taken. An approval makes the report the current one and the revision that was current before it SUPERSEDED, in this step; a return keeps
   * the reason on the report; a request for an amendment leaves the accepted report current until the corrected one is accepted. The version moves once.
   */
  async decide(tx: TenantTx, head: RevisionHead, input: DecisionInput, actor: string, at: Date): Promise<{ version: number; supersededId: string | null; decisionId: string }> {
    const next = decisionOutcome(head.status, input.decision);
    if (head.submittedBy !== null) assertFourEyes(head.submittedBy, actor);
    let supersededId: string | null = null;
    if (next === 'ACCEPTED') {
      const [previous] = await tx.query<{ id: string }>(
        `update machvon.report_revision set status = 'SUPERSEDED', is_current = false, updated_at = now(), updated_by = $3::uuid, version = version + 1
          where project_id = $1::uuid and period_id = $2::uuid and is_current and id <> $4::uuid returning id`,
        [head.projectId, head.periodId, actor, head.id],
      );
      supersededId = previous?.id ?? null;
    }
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.report_revision
          set status = $2, is_current = case when $2 = 'ACCEPTED' then true else is_current end,
              accepted_by = case when $2 = 'ACCEPTED' then $3::uuid else accepted_by end, accepted_at = case when $2 = 'ACCEPTED' then $4::timestamptz else accepted_at end,
              returned_reason = case when $2 = 'ACCEPTED' then returned_reason else $5 end, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid and status = $6 and deleted_at is null returning version::text as version`,
      [head.id, next, actor, at.toISOString(), input.reason, head.status],
    );
    if (updated === undefined) throw new DomainError('REPORT_STATE_INVALID', 409, 'status', { extensions: { report_status: head.status } });
    const decisionId = randomUUID();
    await tx.query(
      `insert into machvon.report_decision (tenant_id, id, report_revision_id, decision, reason, evidence_ids, return_items, due_at, decided_by, decided_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::uuid[], $6::text[], $7::timestamptz, $8::uuid, $9::timestamptz)`,
      [decisionId, head.id, next, input.reason, input.evidenceIds, input.returnItems, input.dueAt?.toISOString() ?? null, actor, at.toISOString()],
    );
    return { version: Number(updated.version), supersededId, decisionId };
  }

  /**
   * Takes back a report that was handed in and is not being reviewed (ST-DIS-007, DIS 3 F3): WITHDRAWN with who, when and why, the version moves once. The table keeps the graph (a report under
   * review, or one that was decided on, cannot move to it) and the three facts together with the status.
   */
  async withdraw(tx: TenantTx, head: RevisionHead, reason: string, actor: string, at: Date): Promise<{ version: number }> {
    const refusal = withdrawRefusal(head.status, head.deleted);
    if (refusal !== undefined) throw refusal;
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.report_revision
          set status = 'WITHDRAWN', withdrawn_by = $2::uuid, withdrawn_at = $3::timestamptz, withdrawn_reason = $4, updated_at = now(), updated_by = $2::uuid, version = version + 1
        where id = $1::uuid and status = 'SUBMITTED' and deleted_at is null returning version::text as version`,
      [head.id, actor, at.toISOString(), reason],
    );
    if (updated === undefined) throw new DomainError('REPORT_STATE_INVALID', 409, 'status', { extensions: { report_status: head.status } });
    return { version: Number(updated.version) };
  }

  /** Deletes a draft softly, with the reason and the instant (409 `REPORT_NOT_EDITABLE` for anything that was handed in): it leaves the lists and is restored within the window. */
  async softDelete(tx: TenantTx, head: RevisionHead, reason: string, actor: string, at: Date): Promise<{ version: number }> {
    const refusal = deleteRefusal(head.status, head.deleted);
    if (refusal !== undefined) throw refusal;
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.report_revision
          set deleted_at = $3::timestamptz, deleted_reason = $4, updated_at = now(), updated_by = $2::uuid, version = version + 1
        where id = $1::uuid and status = 'DRAFT' and deleted_at is null returning version::text as version`,
      [head.id, actor, at.toISOString(), reason],
    );
    if (updated === undefined) throw new DomainError('REPORT_NOT_EDITABLE', 409, 'status', { extensions: { report_status: head.status } });
    return { version: Number(updated.version) };
  }

  /** Brings back a draft that was deleted, within the window of the restore (422 `RESTORE_WINDOW_EXPIRED` after it); the draft is as it was. */
  async restore(tx: TenantTx, head: RevisionHead, actor: string, now: Date): Promise<{ version: number }> {
    const refusal = restoreRefusal(head, now);
    if (refusal !== undefined) throw refusal;
    const [updated] = await withUniqueClaim(tx, { constraint: 'report_revision_draft_uq', code: 'DRAFT_EXISTS' }, () =>
      tx.query<{ version: string }>(
        `update machvon.report_revision
            set deleted_at = null, deleted_reason = null, updated_at = now(), updated_by = $2::uuid, version = version + 1
          where id = $1::uuid and status = 'DRAFT' and deleted_at is not null returning version::text as version`,
        [head.id, actor],
      ),
    );
    if (updated === undefined) throw new DomainError('REPORT_STATE_INVALID', 409, 'status', { extensions: { report_status: head.status } });
    return { version: Number(updated.version) };
  }

  /** A draft that a bulk import brought up to date is of that batch from then on (source IMPORT); the version is the one the save left. */
  async markImported(tx: TenantTx, id: string, batchId: string): Promise<number> {
    const [row] = await tx.query<{ version: string }>("update machvon.report_revision set source_kind = 'IMPORT', import_batch_id = $2::uuid where id = $1::uuid and status = 'DRAFT' and deleted_at is null returning version::text as version", [id, batchId]);
    if (row === undefined) throw new DomainError('REPORT_NOT_EDITABLE', 409, 'status');
    return Number(row.version);
  }

  /** The decisions taken on a report, the first first. */
  async decisionsOf(tx: TenantTx, reportId: string): Promise<DecisionRow[]> {
    const rows = await tx.query<{ id: string; decision: DecisionRow['decision']; reason: string; evidence_ids: string[]; return_items: string[]; due_at: string | null; decided_by: string; decided_at: string }>(
      `select id, decision, reason, evidence_ids::text[] as evidence_ids, return_items, ${iso('due_at')} as due_at, decided_by, ${iso('decided_at')} as decided_at
         from machvon.report_decision where report_revision_id = $1::uuid order by decided_at, created_at, id`,
      [reportId],
    );
    return rows.map((row) => ({
      id: row.id,
      decision: row.decision,
      reason: row.reason,
      evidenceIds: row.evidence_ids,
      returnItems: row.return_items,
      dueAt: row.due_at,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
    }));
  }

  /** A revision of the project in the period, other than the one named, that is still on its way: a live draft, or one that was handed in and has not been decided on. */
  async pendingFor(tx: TenantTx, projectId: string, periodId: string, exceptId: string): Promise<RevisionHead | undefined> {
    const [row] = await tx.query<HeadSql>(
      `select ${HEAD_COLUMNS} from machvon.report_revision r
        where r.project_id = $1::uuid and r.period_id = $2::uuid and r.id <> $3::uuid and r.deleted_at is null and r.status in ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW')
        order by r.revision desc limit 1`,
      [projectId, periodId, exceptId],
    );
    return row === undefined ? undefined : toHead(row);
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
    const predicate = scope(12);
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
        where ($1::timestamptz is null or (r.created_at, r.id) < ($1::timestamptz, $2::uuid))
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
    const predicate = scope(9);
    const [row] = await tx.query<{ reports: string; projects: string; cumulative: string; ctmtqg: string }>(
      `select count(*)::text as reports, count(distinct r.project_id)::text as projects,
              coalesce(sum((select sum(l.disbursed_cumulative_vnd) from machvon.funding_snapshot_line l where l.tenant_id = r.tenant_id and l.report_revision_id = r.id)), 0)::text as cumulative,
              coalesce(sum((select sum(l.ctmtqg_subset_vnd) from machvon.funding_snapshot_line l where l.tenant_id = r.tenant_id and l.report_revision_id = r.id)), 0)::text as ctmtqg
         from ${REPORT_FROM}
         join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
        where ${filterSql(1)} and ${predicate.sql}`,
      [...filterParams(filter), ...predicate.params],
    );
    const found = row as { reports: string; projects: string; cumulative: string; ctmtqg: string };
    return { reports: Number(found.reports), projects: Number(found.projects), cumulativeVnd: found.cumulative, ctmtqgVnd: found.ctmtqg };
  }
}

/**
 * The filters of the list as conditions over eight consecutive parameters from `first`: a filter that is not given lets everything through. The last one tells what is listed: the reports that stand (the
 * default: a draft that was deleted is not among them) or the drafts that were deleted and can still be restored.
 */
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
    `(case when ${at(7)}::boolean then r.deleted_at is not null and r.deleted_at > now() - make_interval(days => ${RESTORE_WINDOW_DAYS}) else r.deleted_at is null end)`,
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
  filter.deleted === true,
];
