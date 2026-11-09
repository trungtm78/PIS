import { randomUUID } from 'node:crypto';
import { DomainError, IMPORT_FAULTS, assertReportableStage, faultedRowsOf, versionConflict } from '@machvon/kernel';
import type { ImportRow, ParsedImport, RowFault } from '@machvon/kernel';
import { DisPeriodStore } from './dis-period-store.ts';
import type { PeriodRow } from './dis-period-store.ts';
import { DisReportStore } from './dis-report-store.ts';
import type { PlanFacts, RevisionHead } from './dis-report-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

/** The resource type of the audit rows of an import. */
export const IMPORT_RESOURCE = 'report_import_batch';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type ImportStatus = 'DRY_RUN' | 'VALIDATED' | 'APPLIED' | 'FAILED' | 'CANCELLED';

/** A batch of the bulk import of weekly reports as it is kept: the file, the layout, what was found in every row, and what the apply did. */
export interface ImportBatchRow {
  id: string;
  periodId: string;
  fileObjectKey: string;
  fileSha256: string;
  mappingVersion: string;
  status: ImportStatus;
  totalRows: number;
  validRows: number;
  errorRows: number;
  faults: RowFault[];
  draftsCreated: number;
  draftsUpdated: number;
  appliedAt: string | null;
  appliedBy: string | null;
  createdAt: string;
  createdBy: string;
  version: number;
}

interface BatchSql {
  id: string;
  period_id: string;
  file_object_key: string;
  file_sha256: string;
  mapping_version: string;
  status: ImportStatus;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  errors_json: Array<{ line: number; project_code: string | null; field: string; code: string }>;
  drafts_created: number;
  drafts_updated: number;
  applied_at: string | null;
  applied_by: string | null;
  created_at: string;
  created_by: string;
  version: string;
}

const BATCH_COLUMNS = `b.id, b.period_id, b.file_object_key, b.file_sha256, b.mapping_version, b.status, b.total_rows, b.valid_rows, b.error_rows, b.errors_json, b.drafts_created, b.drafts_updated,
  ${iso('b.applied_at')} as applied_at, b.applied_by, ${iso('b.created_at')} as created_at, b.created_by, b.version::text as version`;

const toBatch = (row: BatchSql): ImportBatchRow => ({
  id: row.id,
  periodId: row.period_id,
  fileObjectKey: row.file_object_key,
  fileSha256: row.file_sha256,
  mappingVersion: row.mapping_version,
  status: row.status,
  totalRows: row.total_rows,
  validRows: row.valid_rows,
  errorRows: row.error_rows,
  faults: row.errors_json.map((fault) => ({ line: fault.line, projectCode: fault.project_code, field: fault.field, code: fault.code })),
  draftsCreated: row.drafts_created,
  draftsUpdated: row.drafts_updated,
  appliedAt: row.applied_at,
  appliedBy: row.applied_by,
  createdAt: row.created_at,
  createdBy: row.created_by,
  version: Number(row.version),
});

/** A row of the file that is in order and that the report of the project can take: what the apply does with it is known. */
export interface JudgedRow extends ImportRow {
  projectId: string;
  plan: PlanFacts;
  /** The live draft of the project in the period that the row brings up to date; none when the row makes the draft. */
  draft: RevisionHead | undefined;
}

export interface Judgement {
  rows: JudgedRow[];
  /** The faults of the file as it was read and the ones the register adds (an unknown project, a locked period, a report that was handed in), by line. */
  faults: RowFault[];
}

export interface ImportScope {
  /** The projects the caller may import for (the permission `report.import`). */
  scope: ScopeBuilder;
  actor: string;
  now: Date;
}

/**
 * The bulk import of weekly reports (ST-DIS-008, DIS 3 F1). The file is read and judged row by row, and every refusal is kept with its line, its column and a code: nothing is skipped without
 * being told. A batch that has errors is never applied; one without any is applied in one transaction, every row making the draft of its project (or bringing up to date the draft it has),
 * source IMPORT, never handed in. A file is applied once for a period (the table says so), so a repeat adds nothing and a row that was refused never reaches the totals.
 */
export class DisImportStore {
  private readonly reports = new DisReportStore();
  private readonly periods = new DisPeriodStore();

  async find(tx: TenantTx, id: string, lock = false): Promise<ImportBatchRow | undefined> {
    const [row] = await tx.query<BatchSql>(`select ${BATCH_COLUMNS} from machvon.report_import_batch b where b.id = $1::uuid${lock ? ' for update of b' : ''}`, [id]);
    return row === undefined ? undefined : toBatch(row);
  }

  /** The batch that applied this file to this period, if there is one. */
  async appliedFor(tx: TenantTx, periodId: string, fileSha256: string): Promise<ImportBatchRow | undefined> {
    const [row] = await tx.query<BatchSql>(`select ${BATCH_COLUMNS} from machvon.report_import_batch b where b.period_id = $1::uuid and b.file_sha256 = $2 and b.status = 'APPLIED'`, [periodId, fileSha256]);
    return row === undefined ? undefined : toBatch(row);
  }

  /**
   * Judges every row that is in order against the register, and adds the faults to the ones of the file: a project the caller may not report on is indistinguishable from one that does not exist
   * (PROJECT_NOT_FOUND), a project in a stage that does not report, a period that takes no report from the project, no plan version in force, a report that was handed in or a draft that was
   * deleted. The faults come back by line.
   */
  async judge(tx: TenantTx, parsed: ParsedImport, period: PeriodRow, context: ImportScope): Promise<Judgement> {
    const faults: RowFault[] = [...parsed.faults];
    const rows: JudgedRow[] = [];
    for (const row of parsed.rows) {
      const fault = (code: string): void => void faults.push({ line: row.line, projectCode: row.projectCode, field: 'project_code', code });
      const visible = context.scope(2);
      const [project] = await tx.query<{ id: string; status: string }>(`select p.id, p.status from ${SCOPE_FROM} where p.code = $1 and ${visible.sql}`, [row.projectCode, ...visible.params]);
      if (project === undefined) {
        fault(IMPORT_FAULTS.projectNotFound);
        continue;
      }
      try {
        assertReportableStage(project.status);
      } catch {
        fault(IMPORT_FAULTS.projectStage);
        continue;
      }
      if (await this.periods.closedFor(tx, period.id, project.id, context.now)) {
        fault('PERIOD_LOCKED');
        continue;
      }
      const plan = await this.reports.effectivePlan(tx, project.id, period.fiscalYear, period.endDate);
      if (plan === undefined) {
        fault(IMPORT_FAULTS.planNotEffective);
        continue;
      }
      const latest = await this.reports.latestFor(tx, project.id, period.id);
      if (latest !== undefined && (latest.status !== 'DRAFT' || latest.deleted)) {
        fault(IMPORT_FAULTS.reportExists);
        continue;
      }
      rows.push({ ...row, projectId: project.id, plan, draft: latest });
    }
    faults.sort((a, b) => a.line - b.line);
    return { rows, faults };
  }

  /** Keeps the dry run: the file, the layout and every row's fault; ready to be applied when there is none. */
  async record(tx: TenantTx, input: { periodId: string; fileObjectKey: string; fileSha256: string; mappingVersion: string; totalRows: number; faults: readonly RowFault[]; actor: string }): Promise<ImportBatchRow> {
    const errorRows = faultedRowsOf(input.faults);
    const id = randomUUID();
    const [row] = await tx.query<BatchSql>(
      `with inserted as (
         insert into machvon.report_import_batch
           (tenant_id, id, period_id, file_object_key, file_sha256, mapping_version, status, total_rows, valid_rows, error_rows, errors_json, created_by, updated_by, version)
         values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, $7::int, $8::int, $9::int, $10::jsonb, $11::uuid, $11::uuid, 1) returning *)
       select ${BATCH_COLUMNS} from inserted b`,
      [id, input.periodId, input.fileObjectKey, input.fileSha256, input.mappingVersion, errorRows === 0 ? 'VALIDATED' : 'DRY_RUN', input.totalRows, input.totalRows - errorRows, errorRows, JSON.stringify(input.faults.map((fault) => ({ line: fault.line, project_code: fault.projectCode, field: fault.field, code: fault.code }))), input.actor],
    );
    return toBatch(row as BatchSql);
  }

  /**
   * Locks a batch of the person who made it for its apply: every judged row makes the draft of its project, or brings the draft it has up to date, with source IMPORT and this batch; nothing is handed in. The batch
   * is then APPLIED with who and when and what it did. A batch is locked first, so two applies of it at once give one winner; a file that was applied already is 409
   * `IMPORT_FILE_ALREADY_APPLIED`, a batch that still has errors 422 `IMPORT_HAS_ERRORS`.
   */
  async lockForApply(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<ImportBatchRow> {
    const batch = await this.find(tx, id, true);
    // A batch names the projects of the scope of the person who made it, so it is theirs alone: for anyone else it is not there.
    if (batch === undefined || batch.createdBy !== actor) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (batch.version !== expectedVersion) throw versionConflict(batch.version);
    if (batch.status === 'APPLIED') throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409, 'file_sha256', { extensions: { import_id: batch.id } });
    if (batch.status === 'DRY_RUN') throw new DomainError('IMPORT_HAS_ERRORS', 422, 'file', { extensions: { error_rows: batch.errorRows } });
    if (batch.status !== 'VALIDATED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { import_status: batch.status } });
    // Two batches of the same file for the same period take turns: the one that comes second finds the file applied, whatever it was told when it was made.
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`report-import:${batch.periodId}:${batch.fileSha256}`]);
    const applied = await this.appliedFor(tx, batch.periodId, batch.fileSha256);
    if (applied !== undefined) throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409, 'file_sha256', { extensions: { import_id: applied.id } });
    return batch;
  }

  async apply(tx: TenantTx, batch: ImportBatchRow, judgement: Judgement, period: PeriodRow, context: ImportScope): Promise<{ batch: ImportBatchRow; drafts: Array<{ id: string; projectCode: string; action: 'CREATED' | 'UPDATED'; version: number }> }> {
    const drafts: Array<{ id: string; projectCode: string; action: 'CREATED' | 'UPDATED'; version: number }> = [];
    for (const row of judgement.rows) {
      if (row.draft === undefined) {
        const made = await this.reports.createDraft(
          tx,
          {
            projectId: row.projectId,
            periodId: period.id,
            planVersionId: row.plan.id,
            reportType: 'WEEKLY',
            measurementBasis: 'YTD',
            cells: row.cells,
            negativeDeltaExplanation: row.explanation,
            progress: row.progress ?? null,
            narrative: null,
            attachments: [],
            asOfDate: period.endDate,
            clientOperationId: undefined,
            allocations: await this.reports.allocations(tx, row.plan.id),
            importBatchId: batch.id,
          },
          context.actor,
        );
        drafts.push({ id: made.id, projectCode: row.projectCode, action: 'CREATED', version: made.version });
      } else {
        const head = await this.reports.lock(tx, row.draft.id, context.scope, context.scope, row.draft.version);
        // The layout carries the cumulative of the six cells, on the basis of the year to date, and no registration for next month: the registration the draft holds (DIS-05) and the year of the
        // source of each cell stay, and a draft on another basis is brought to the basis of the file with its volumes.
        const held = await this.reports.find(tx, head.id, context.scope);
        const kept = new Map((held?.lines ?? []).map((line) => [`${line.bucket}/${line.budgetLevel}`, line]));
        const cells = row.cells.map((cell) => {
          const before = kept.get(`${cell.bucket}/${cell.budgetLevel}`);
          return before === undefined ? cell : { ...cell, nextMonthVnd: before.nextMonthVnd, nextMonthCtmtqgVnd: before.nextMonthCtmtqgVnd, sourceYear: before.sourceYear };
        });
        await this.reports.saveDraft(tx, head, { measurementBasis: 'YTD', cells, negativeDeltaExplanation: row.explanation, progress: row.progress, narrative: undefined, attachments: undefined }, period.endDate, context.actor);
        const version = await this.reports.markImported(tx, head.id, batch.id);
        drafts.push({ id: head.id, projectCode: row.projectCode, action: 'UPDATED', version });
      }
    }
    const created = drafts.filter((draft) => draft.action === 'CREATED').length;
    return { batch: await this.markApplied(tx, batch.id, context, created, drafts.length - created), drafts };
  }

  /** Closes a validated batch as applied, once for the file (the table says so): the counts of the drafts it made and of the ones it brought up to date. */
  async markApplied(tx: TenantTx, batchId: string, context: Pick<ImportScope, 'actor' | 'now'>, created: number, updated: number): Promise<ImportBatchRow> {
    const [row] = await withUniqueClaim(tx, { constraint: 'report_import_applied_uq', code: 'IMPORT_FILE_ALREADY_APPLIED' }, () =>
      tx.query<BatchSql>(
        `with updated as (
           update machvon.report_import_batch
              set status = 'APPLIED', applied_at = $2::timestamptz, applied_by = $3::uuid, drafts_created = $4::int, drafts_updated = $5::int, updated_at = now(), updated_by = $3::uuid, version = version + 1
            where id = $1::uuid and status = 'VALIDATED' returning *)
         select ${BATCH_COLUMNS} from updated b`,
        [batchId, context.now.toISOString(), context.actor, created, updated],
      ),
    );
    if (row === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    return toBatch(row);
  }
}
