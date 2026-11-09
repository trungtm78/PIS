import { NARRATIVE_IMPORT_FAULTS, NARRATIVE_PACK_ENTERPRISE } from '@machvon/kernel';
import type { EnterpriseNarrative, NarrativeInput, NarrativeRowFault, ParsedNarrativeImport } from '@machvon/kernel';
import { PACK_SELECT, enterpriseBlockOf } from './ent-narrative-codec.ts';
import type { PackColumns } from './ent-narrative-codec.ts';
import { DisImportStore } from './dis-import-store.ts';
import type { ImportBatchRow } from './dis-import-store.ts';
import { DisPeriodStore } from './dis-period-store.ts';
import { DisReportStore } from './dis-report-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The enterprise narrative of a report (ENT-3b): the enterprise block of a report revision, the previous report of a project (for the inheritance), the standard
 * causes (the list MDM-17, the issue categories in use) and the judgement and the apply of the rows of an Excel file. The row of the table is the one `DisReportStore` writes for the public sections; the pack
 * columns are written in the same statement, so a report revision has one narrative and one history.
 */

/** The standard cause of the list: its code (the business key of the entry) and its name. */
export interface CauseEntry {
  code: string;
  label: string;
}

/** The previous report of the same project that has an enterprise narrative, with that narrative. */
export interface PreviousNarrative {
  reportId: string;
  periodId: string;
  periodCode: string;
  status: string;
  block: EnterpriseNarrative;
}

export interface NarrativeImportTarget {
  line: number;
  projectCode: string;
  reportId: string;
  reportVersion: number;
  block: EnterpriseNarrative;
}

export interface NarrativeJudgement {
  faults: NarrativeRowFault[];
  targets: NarrativeImportTarget[];
}

/** Who judges and applies a file: the projects the caller may report on, the caller and the day. */
export interface NarrativeImportContext {
  scope: ScopeBuilder;
  actor: string;
  now: Date;
}

export class EntNarrativeStore {
  private readonly reports = new DisReportStore();
  private readonly periods = new DisPeriodStore();
  private readonly imports = new DisImportStore();

  /** The enterprise block of a report revision; undefined when it has none. */
  async blockOf(tx: TenantTx, reportId: string): Promise<EnterpriseNarrative | undefined> {
    const [row] = await tx.query<PackColumns>(`select ${PACK_SELECT} from machvon.report_narrative n where n.report_revision_id = $1::uuid`, [reportId]);
    return row === undefined ? undefined : enterpriseBlockOf(row);
  }

  /**
   * The most recent report of the same project, in an earlier period of the same kind, that was handed in (submitted, under review or accepted) and has an enterprise narrative. A report still being drafted
   * is not what a period says about itself, so it is never copied; undefined when the project has none.
   */
  async previousOf(tx: TenantTx, reportId: string): Promise<PreviousNarrative | undefined> {
    const [row] = await tx.query<PackColumns & { id: string; period_id: string; period_code: string; status: string }>(
      `select r.id, r.period_id, rp.code as period_code, r.status, ${PACK_SELECT}
         from machvon.report_revision cur
         join machvon.reporting_period cp on cp.tenant_id = cur.tenant_id and cp.id = cur.period_id
         join machvon.report_revision r on r.tenant_id = cur.tenant_id and r.project_id = cur.project_id and r.id <> cur.id
         join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id and rp.period_type = cp.period_type and rp.end_date < cp.start_date
         join machvon.report_narrative n on n.tenant_id = r.tenant_id and n.report_revision_id = r.id and n.pack_code = $2
        where cur.id = $1::uuid and r.is_current and r.deleted_at is null and r.status in ('SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED')
        order by rp.end_date desc, r.revision desc
        limit 1`,
      [reportId, NARRATIVE_PACK_ENTERPRISE],
    );
    if (row === undefined) return undefined;
    const block = enterpriseBlockOf(row);
    return block === undefined ? undefined : { reportId: row.id, periodId: row.period_id, periodCode: row.period_code, status: row.status, block };
  }

  /**
   * The standard causes in use: the entries of the list MDM-17 (issue categories) that are effective, by code. A tenant that has not filled the list has an empty picklist and writes its causes in words;
   * a code that is not on the list is refused by `unknownCodes`.
   */
  async causes(tx: TenantTx): Promise<CauseEntry[]> {
    return tx.query<CauseEntry>(
      `select r.business_key as code, v.label
         from machvon.master_record r
         join machvon.master_record_version v on v.tenant_id = r.tenant_id and v.id = r.current_version_id
        where r.master_type = 'ISSUE_CATEGORY' and r.status = 'EFFECTIVE'
        order by r.business_key`,
    );
  }

  /** The codes among the ones named that are not an effective entry of the list. */
  async unknownCodes(tx: TenantTx, codes: readonly string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const found = await tx.query<{ code: string }>(
      `select r.business_key as code from machvon.master_record r where r.master_type = 'ISSUE_CATEGORY' and r.status = 'EFFECTIVE' and r.business_key = any($1::text[])`,
      [[...codes]],
    );
    const present = new Set(found.map((row) => row.code));
    return codes.filter((code) => !present.has(code));
  }

  /** The names of the causes by code, in the order given (a code that left the list keeps its code as its name). */
  async labelsOf(tx: TenantTx, codes: readonly string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const names = new Map((await this.causes(tx)).map((entry) => [entry.code, entry.label]));
    return codes.map((code) => names.get(code) ?? code);
  }

  /**
   * Judges the rows of a file against the register and adds the faults to the ones of the file: a project the caller may not report on is indistinguishable from one that does not exist, a period that takes
   * no entry from the project, no live draft of the period (a file never makes a report: the funding lines of a report are not in this template), a cause code that is not on the list. Nothing is written.
   */
  async judge(tx: TenantTx, parsed: ParsedNarrativeImport, periodId: string, context: NarrativeImportContext): Promise<NarrativeJudgement> {
    const faults: NarrativeRowFault[] = [...parsed.faults];
    const targets: NarrativeImportTarget[] = [];
    const named = new Set<string>();
    for (const row of parsed.rows) for (const code of row.block.causeCodes) named.add(code);
    const outside = new Set(await this.unknownCodes(tx, [...named]));
    for (const row of parsed.rows) {
      const fault = (field: string, code: string): void => void faults.push({ line: row.line, projectCode: row.projectCode, field, code });
      const visible = context.scope(2);
      const [project] = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.code = $1 and ${visible.sql}`, [row.projectCode, ...visible.params]);
      if (project === undefined) {
        fault('project_code', NARRATIVE_IMPORT_FAULTS.projectNotFound);
        continue;
      }
      if (await this.periods.closedFor(tx, periodId, project.id, context.now)) {
        fault('period', NARRATIVE_IMPORT_FAULTS.periodLocked);
        continue;
      }
      const latest = await this.reports.latestFor(tx, project.id, periodId);
      if (latest === undefined || latest.status !== 'DRAFT' || latest.deleted) {
        fault('project_code', NARRATIVE_IMPORT_FAULTS.reportDraftMissing);
        continue;
      }
      if (row.block.causeCodes.some((code) => outside.has(code))) {
        fault('cause_codes', NARRATIVE_IMPORT_FAULTS.causeCodeUnknown);
        continue;
      }
      targets.push({ line: row.line, projectCode: row.projectCode, reportId: latest.id, reportVersion: latest.version, block: row.block });
    }
    faults.sort((a, b) => a.line - b.line || a.field.localeCompare(b.field, 'en'));
    return { faults, targets };
  }

  /**
   * Applies a validated batch: the enterprise block of every judged draft is replaced by the one of its row (the public sections of the narrative, the directives that were rolled up and the trace of an
   * inheritance are kept), the draft moves to the next version with its new hash, and the batch is closed as applied with the number of drafts it brought up to date.
   */
  async apply(tx: TenantTx, batch: ImportBatchRow, judgement: NarrativeJudgement, context: NarrativeImportContext): Promise<{ batch: ImportBatchRow; drafts: Array<{ id: string; projectCode: string; version: number }> }> {
    const drafts: Array<{ id: string; projectCode: string; version: number }> = [];
    for (const target of judgement.targets) {
      const head = await this.reports.lock(tx, target.reportId, context.scope, context.scope, target.reportVersion);
      const held = await this.reports.narrativeOf(tx, head.id);
      const kept = held?.enterprise?.inheritance;
      const narrative: NarrativeInput = {
        resultsText: held?.resultsText ?? null,
        causesText: held?.causesText ?? null,
        solutionsText: held?.solutionsText ?? null,
        proposalsText: held?.proposalsText ?? null,
        linkedIssueIds: held?.linkedIssueIds ?? [],
        enterprise: { ...target.block, directiveRefs: held?.enterprise?.directiveRefs ?? [], ...(kept === undefined ? {} : { inheritance: kept }) },
      };
      const saved = await this.reports.saveNarrative(tx, head, narrative, context.actor);
      drafts.push({ id: head.id, projectCode: target.projectCode, version: saved.version });
    }
    return { batch: await this.imports.markApplied(tx, batch.id, context, 0, drafts.length), drafts };
  }
}
