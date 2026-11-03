import { DomainError, assertEvaluationReportState } from '@machvon/kernel';
import type { EvaluationReportStatus } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** What the consumer of DOC's answers needs of a report, with its row locked. */
export interface ReportHead {
  id: string;
  packageId: string;
  status: EvaluationReportStatus;
  payloadSha256: string | null;
  reportDocumentId: string | null;
  /** The event that asked DOC for the minutes; null before the request. */
  issueEventId: string | null;
  issueRequestedAt: string | null;
  recalledAt: string | null;
  version: number;
}

interface HeadSql {
  id: string;
  package_id: string;
  status: EvaluationReportStatus;
  payload_sha256: string | null;
  report_document_id: string | null;
  issue_event_id: string | null;
  issue_requested_at: string | null;
  recalled_at: string | null;
  version: string;
}

export interface Moved {
  id: string;
  version: number;
}

/**
 * What DOC answers to the request for the minutes of an evaluation report (ST-BID-012, DOC 9, BR-DOC-17): the report is ISSUED only when DOC says so, with the document, SUPERSEDED when a later report is issued,
 * and back to SIGNED_OFF when DOC refuses. This module never marks a report issued by itself.
 */
export class BidReportIssueStore {
  /** The report DOC's answer names, locked; undefined when the tenant has none of that id. */
  async lockHead(tx: TenantTx, id: string): Promise<ReportHead | undefined> {
    const rows = await tx.query<HeadSql>(
      `select id, package_id, status, payload_sha256, report_document_id, issue_event_id,
              to_char(issue_requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issue_requested_at, recalled_at::text as recalled_at, version::text as version
         from machvon.evaluation_report where id = $1::uuid for update`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      packageId: row.package_id,
      status: row.status,
      payloadSha256: row.payload_sha256,
      reportDocumentId: row.report_document_id,
      issueEventId: row.issue_event_id,
      issueRequestedAt: row.issue_requested_at,
      recalledAt: row.recalled_at,
      version: Number(row.version),
    };
  }

  /** DOC issued the minutes: the report is ISSUED with the document (409 REPORT_STATE_INVALID when it is not waiting for DOC). */
  async markIssued(tx: TenantTx, head: ReportHead, input: { documentId: string; issuedAt: string }): Promise<Moved> {
    assertEvaluationReportState(head.status, ['ISSUE_REQUESTED']);
    return this.update(tx, head.id, `status = 'ISSUED', report_document_id = $2::uuid, issued_at = $3::timestamptz`, [input.documentId, input.issuedAt]);
  }

  /** The reports of the package that were issued before are SUPERSEDED by the one just issued; they stay as they were issued. */
  async supersedeEarlier(tx: TenantTx, head: ReportHead): Promise<Moved[]> {
    const rows = await tx.query<{ id: string; version: string }>(
      `update machvon.evaluation_report set status = 'SUPERSEDED', updated_at = now(), version = version + 1
        where package_id = $1::uuid and status = 'ISSUED' and id <> $2::uuid returning id, version::text as version`,
      [head.packageId, head.id],
    );
    return rows.map((row) => ({ id: row.id, version: Number(row.version) }));
  }

  /** DOC refused to issue it: the report is SIGNED_OFF again, with its signatures, and the cause is mended. */
  async markIssueRejected(tx: TenantTx, head: ReportHead): Promise<Moved> {
    assertEvaluationReportState(head.status, ['ISSUE_REQUESTED']);
    return this.update(tx, head.id, `status = 'SIGNED_OFF'`, []);
  }

  /** DOC recalled what it issued: the report keeps its state and its document with the moment it was recalled. */
  async markRecalled(tx: TenantTx, head: ReportHead, at: string): Promise<Moved> {
    // DOC can take back what it issued whatever has become of it since, a report that a later one superseded included.
    assertEvaluationReportState(head.status, ['ISSUED', 'SUPERSEDED']);
    return this.update(tx, head.id, 'recalled_at = $2::timestamptz', [at]);
  }

  private async update(tx: TenantTx, id: string, assignments: string, params: unknown[]): Promise<Moved> {
    const rows = await tx.query<{ version: string }>(`update machvon.evaluation_report set ${assignments}, updated_at = now(), version = version + 1 where id = $1::uuid returning version::text as version`, [id, ...params]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { id, version: Number(rows[0].version) };
  }
}
