import { DomainError } from '@machvon/kernel';
import type { IssuedCopyMarks } from '@machvon/kernel';
import { ReportStore } from '@machvon/db';
import type { ReportIssueRow, TenantTx } from '@machvon/db';

/** The channel and the receiver under which a push to HPM appears in the delivery log of the report engine (RPT-1). */
export const HPM_DELIVERY_CHANNEL = 'HPM_PUSH';
export const HPM_DELIVERY_RECEIVER = 'HPM';

/** An issued copy of the report engine as the push reads it: what identifies it, the files that go out with it, and the newest revision of its series. */
export interface IssuedReport {
  issueId: string;
  layoutCode: string;
  period: string;
  revision: number;
  sha256: string;
  snapshot: { snapshotId: string; revision: number; cutoff: string } | null;
  marks: IssuedCopyMarks;
  /** The files of the copy, the workbook first; a copy whose file is no longer in the store is not found. */
  files: ReadonlyArray<{ name: string; bytes: Uint8Array }>;
  /** The newest revision issued for the series: a push of an older copy is stale. */
  headRevision: number;
}

/**
 * The only thing the push knows of the report engine (RPT-1c, issued copies): to read an issued copy with its files and the head of its series, and to write the delivery and the answer of the receiver into the delivery log
 * the report engine keeps. The default adapter reads the engine's own store; the tables of the engine are not read here.
 */
export interface IssuedReportPort {
  load(tx: TenantTx, issueId: string): Promise<IssuedReport | undefined>;
  /** The copy was handed to HPM (the package was written). A copy the log already shows as delivered to HPM is left as it is. */
  delivered(tx: TenantTx, issueId: string, by: string, reference: string): Promise<void>;
  /** HPM accepted or rejected the copy (a person recorded its receipt). */
  answered(tx: TenantTx, issueId: string, event: 'ACCEPTED' | 'REJECTED', by: string, reference: string, note: string | null): Promise<void>;
}

const absent = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404, 'issue_id');

/** The adapter over `ReportStore`. */
export class ReportStoreIssuedReports implements IssuedReportPort {
  private readonly reports = new ReportStore();

  private async filesOf(tx: TenantTx, row: ReportIssueRow): Promise<Array<{ name: string; bytes: Uint8Array }>> {
    const workbook = await this.reports.outputBytes(tx, row.xlsxSha256);
    if (workbook === undefined) return [];
    const files = [{ name: row.xlsxName, bytes: workbook.bytes }];
    if (row.docxSha256 !== null && row.docxName !== null) {
      const document = await this.reports.outputBytes(tx, row.docxSha256);
      if (document !== undefined) files.push({ name: row.docxName, bytes: document.bytes });
    }
    return files;
  }

  async load(tx: TenantTx, issueId: string): Promise<IssuedReport | undefined> {
    const row = await this.reports.findIssue(tx, issueId);
    if (row === undefined) return undefined;
    const files = await this.filesOf(tx, row);
    if (files.length === 0) return undefined;
    return {
      issueId: row.id,
      layoutCode: row.layoutCode,
      period: row.periodCode,
      revision: row.revision,
      sha256: row.sha256,
      snapshot: row.snapshotRef === null ? null : { snapshotId: row.snapshotRef.snapshotId, revision: row.snapshotRef.revision, cutoff: row.snapshotRef.cutoff },
      marks: { formStatus: row.formStatus, demoMark: row.demoMark },
      files,
      headRevision: await this.reports.headRevision(tx, row.layoutCode, row.periodCode),
    };
  }

  async delivered(tx: TenantTx, issueId: string, by: string, reference: string): Promise<void> {
    const row = await this.reports.findIssue(tx, issueId);
    if (row === undefined) throw absent();
    try {
      await this.reports.deliver(tx, row, { receiver: HPM_DELIVERY_RECEIVER, channel: HPM_DELIVERY_CHANNEL, reference, note: null, by });
    } catch (error) {
      // A second try of the same key finds the delivery already in the log: that is the repeat the log is meant to recognise, not a failure of the push.
      if (!(error instanceof DomainError && error.code === 'ALREADY_DELIVERED')) throw error;
    }
  }

  async answered(tx: TenantTx, issueId: string, event: 'ACCEPTED' | 'REJECTED', by: string, reference: string, note: string | null): Promise<void> {
    const row = await this.reports.findIssue(tx, issueId);
    if (row === undefined) throw absent();
    await this.reports.answer(tx, row, event, { receiver: HPM_DELIVERY_RECEIVER, channel: HPM_DELIVERY_CHANNEL, reference, note, by });
  }
}
