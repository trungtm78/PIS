import { randomUUID } from 'node:crypto';
import { DomainError, nextReportStatus, reportSourceRef } from '@machvon/kernel';
import type { ReportRecommendation, ReportStatus, ReportTotals } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

/** The engagement and the conclusion a report is made of, and the units the engagement is about (one of them drafts the report when the caller does not say which). */
export interface ReportContext {
  engagement: { id: string; code: string; title: string; authorityName: string; status: string };
  conclusion: { id: string; status: string; receivedOn: string; issuedOn: string; symbol: string | null };
  scopeUnitIds: string[];
}

export interface NewReport {
  engagementId: string;
  conclusionId: string;
  asOfDate: string;
  totals: ReportTotals;
  draftingUnitId: string;
  /** The hash of the payload the report asks DOC to issue, and the key of the file that holds it. */
  payloadSha256: string;
  issueEventId: string;
}

export interface ReportLine {
  id: string;
  engagementId: string;
  conclusionId: string;
  conclusionSymbol: string | null;
  asOfDate: string;
  revision: number;
  status: ReportStatus;
  totals: ReportTotals;
  payloadSha256: string;
  sourceRef: string;
  reportDocumentId: string | null;
  rejectCode: string | null;
  requestedBy: { id: string; displayName: string };
  approvedBy: { id: string; displayName: string } | null;
  requestedAt: string;
  issuedAt: string | null;
  version: number;
}

/** A report as DOC's events find it: enough to match the hash and decide the edge. */
export interface ReportHead {
  id: string;
  engagementId: string;
  revision: number;
  status: ReportStatus;
  payloadSha256: string;
  createdBy: string;
  reportDocumentId: string | null;
  version: number;
}

interface LineSql {
  id: string;
  engagement_id: string;
  conclusion_id: string;
  conclusion_symbol: string | null;
  as_of_date: string;
  revision: number;
  status: ReportStatus;
  totals_json: ReportTotals;
  payload_sha256: string;
  report_document_id: string | null;
  reject_code: string | null;
  created_by: string;
  created_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  created_at: string;
  issued_at: string | null;
  version: string;
}

const LINE_SQL = `select r.id, r.engagement_id, r.conclusion_id, doc.symbol as conclusion_symbol, r.as_of_date::text as as_of_date, r.revision, r.status, r.totals_json, r.payload_sha256,
         r.report_document_id, r.reject_code, r.created_by, cu.display_name as created_by_name, r.approved_by, au.display_name as approved_by_name, r.created_at::text as created_at,
         r.issued_at::text as issued_at, r.version::text as version
    from machvon.audit_follow_up_report r
    join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
    left join machvon.document doc on doc.tenant_id = c.tenant_id and doc.id = c.conclusion_document_id
    left join machvon.tenant_user_directory cu on cu.tenant_id = r.tenant_id and cu.membership_id = r.created_by
    left join machvon.tenant_user_directory au on au.tenant_id = r.tenant_id and au.membership_id = r.approved_by`;

const toLine = (row: LineSql): ReportLine => ({
  id: row.id,
  engagementId: row.engagement_id,
  conclusionId: row.conclusion_id,
  conclusionSymbol: row.conclusion_symbol,
  asOfDate: row.as_of_date,
  revision: row.revision,
  status: row.status,
  totals: row.totals_json,
  payloadSha256: row.payload_sha256,
  sourceRef: reportSourceRef(row.id, row.revision),
  reportDocumentId: row.report_document_id,
  rejectCode: row.reject_code,
  requestedBy: { id: row.created_by, displayName: row.created_by_name ?? '' },
  approvedBy: row.approved_by === null ? null : { id: row.approved_by, displayName: row.approved_by_name ?? '' },
  requestedAt: row.created_at,
  issuedAt: row.issued_at,
  version: Number(row.version),
});

const NOT_FOUND = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);

/** Where the payload of a report is kept: under the prefix of the tenant, which is where DOC reads a payload from. */
export const reportPayloadRef = (tenantId: string, reportId: string, revision: number): string => `tenants/${tenantId}/aud/follow-up-reports/${reportId}/r${revision}.json`;

/**
 * The report of the results of the recommendations (ST-AUD-005, AUD 3.6): its figures are frozen on the day it asks DOC to issue it, and DOC's answer moves it to ISSUED, REJECTED or
 * RECALLED. The table refuses to change what was frozen and to delete a report; the store keeps the edges in step with the kernel's.
 */
export class AudReportStore {
  /** The engagement and the conclusion of a report; undefined when the conclusion is not one of the engagement. */
  async context(tx: TenantTx, engagementId: string, conclusionId: string): Promise<ReportContext | undefined> {
    const [row] = await tx.query<{
      code: string;
      title: string;
      authority_name: string;
      engagement_status: string;
      conclusion_status: string;
      received_on: string;
      issued_on: string;
      symbol: string | null;
    }>(
      `select e.engagement_code as code, e.title, e.authority_name, e.status as engagement_status, c.status as conclusion_status, c.received_on::text as received_on, c.issued_on::text as issued_on, doc.symbol
         from machvon.audit_engagement e
         join machvon.audit_conclusion c on c.tenant_id = e.tenant_id and c.engagement_id = e.id and c.id = $2::uuid
         left join machvon.document doc on doc.tenant_id = c.tenant_id and doc.id = c.conclusion_document_id
        where e.id = $1::uuid`,
      [engagementId, conclusionId],
    );
    if (row === undefined) return undefined;
    const units = await tx.query<{ id: string }>("select organization_unit_id as id from machvon.audit_scope_item where engagement_id = $1::uuid and scope_kind = 'UNIT' order by organization_unit_id", [engagementId]);
    return {
      engagement: { id: engagementId, code: row.code, title: row.title, authorityName: row.authority_name, status: row.engagement_status },
      conclusion: { id: conclusionId, status: row.conclusion_status, receivedOn: row.received_on, issuedOn: row.issued_on, symbol: row.symbol },
      scopeUnitIds: units.map((unit) => unit.id),
    };
  }

  /** The recommendations of a conclusion as they stood on a day: when each was given and closed (Vietnam days) and what the ledger had recovered of it by then. */
  async recommendationsAsOf(tx: TenantTx, conclusionId: string, asOf: string): Promise<ReportRecommendation[]> {
    const rows = await tx.query<{ rec_type: string; status: string; amount_vnd: string | null; created_on: string; closed_on: string | null; recovered_vnd: string }>(
      `select r.rec_type, r.status, r.amount_vnd::text as amount_vnd,
              (r.created_at at time zone 'Asia/Ho_Chi_Minh')::date::text as created_on,
              case when r.status = 'CLOSED' then (r.verified_at at time zone 'Asia/Ho_Chi_Minh')::date::text end as closed_on,
              coalesce((select sum(l.amount_vnd) from machvon.audit_recovery_link l where l.tenant_id = r.tenant_id and l.recommendation_id = r.id and l.recorded_on <= $2::date), 0)::text as recovered_vnd
         from machvon.audit_recommendation r where r.conclusion_id = $1::uuid order by r.rec_code, r.id`,
      [conclusionId, asOf],
    );
    return rows.map((row) => ({ type: row.rec_type, status: row.status, amountVnd: row.amount_vnd, createdOn: row.created_on, closedOn: row.closed_on, recoveredVnd: row.recovered_vnd }));
  }

  /** The report of the conclusion and day that is waiting for DOC or issued, if there is one. */
  async live(tx: TenantTx, conclusionId: string, asOf: string): Promise<{ id: string; revision: number; status: ReportStatus } | undefined> {
    const [row] = await tx.query<{ id: string; revision: number; status: ReportStatus }>(
      "select id, revision, status from machvon.audit_follow_up_report where conclusion_id = $1::uuid and as_of_date = $2::date and status in ('DRAFT', 'ISSUE_REQUESTED', 'ISSUED')",
      [conclusionId, asOf],
    );
    return row;
  }

  /**
   * Writes the report in ISSUE_REQUESTED with the figures and the hash of the payload it asks DOC to issue. The revision is the next one for the conclusion and the day, under a lock on
   * them, so two requests cannot take the same number; a report that is waiting or issued for them is 409 `FOLLOW_UP_REPORT_EXISTS` with its id.
   */
  async create(tx: TenantTx, input: NewReport, actor: string): Promise<{ id: string; revision: number; payloadRef: string }> {
    const tenantId = await this.tenantId(tx);
    await tx.query("select pg_advisory_xact_lock(hashtextextended('aud_follow_up_report:' || current_setting('app.tenant_id') || ':' || $1::text || ':' || $2::text, 0))", [input.conclusionId, input.asOfDate]);
    const live = await this.live(tx, input.conclusionId, input.asOfDate);
    if (live !== undefined) throw new DomainError('FOLLOW_UP_REPORT_EXISTS', 409, 'as_of_date', { extensions: { report_id: live.id, revision: live.revision, report_status: live.status } });
    const [latest] = await tx.query<{ revision: number | null }>('select max(revision) as revision from machvon.audit_follow_up_report where conclusion_id = $1::uuid and as_of_date = $2::date', [input.conclusionId, input.asOfDate]);
    const revision = (latest?.revision ?? 0) + 1;
    const id = randomUUID();
    const payloadRef = reportPayloadRef(tenantId, id, revision);
    // The first state is DRAFT and the request moves it on, as the kernel's edges say: the table never holds a report that was not asked for.
    const status = nextReportStatus('DRAFT', 'request');
    await withUniqueClaim(tx, { constraint: 'audit_follow_up_report_live_uq', code: 'FOLLOW_UP_REPORT_EXISTS' }, async () => {
      await tx.query(
        `insert into machvon.audit_follow_up_report
           (tenant_id, id, engagement_id, conclusion_id, as_of_date, revision, totals_json, payload_sha256, status, payload_ref, issue_event_id, drafting_unit_id, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6::jsonb, $7, $8, $9, $10::uuid, $11::uuid, $12::uuid, $12::uuid, 1)`,
        [id, input.engagementId, input.conclusionId, input.asOfDate, revision, JSON.stringify(input.totals), input.payloadSha256, status, payloadRef, input.issueEventId, input.draftingUnitId, actor],
      );
    });
    return { id, revision, payloadRef };
  }

  /** The reports of an engagement, the newest day first and the newest revision first. */
  async list(tx: TenantTx, engagementId: string): Promise<ReportLine[]> {
    const rows = await tx.query<LineSql>(`${LINE_SQL} where r.engagement_id = $1::uuid order by r.as_of_date desc, r.revision desc, r.id`, [engagementId]);
    return rows.map(toLine);
  }

  async findLine(tx: TenantTx, id: string): Promise<ReportLine | undefined> {
    const [row] = await tx.query<LineSql>(`${LINE_SQL} where r.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toLine(row);
  }

  /** The report DOC's event names, locked for the change it brings. */
  async lockHead(tx: TenantTx, id: string): Promise<ReportHead | undefined> {
    const [row] = await tx.query<{ id: string; engagement_id: string; revision: number; status: ReportStatus; payload_sha256: string; created_by: string; report_document_id: string | null; version: string }>(
      'select id, engagement_id, revision, status, payload_sha256, created_by, report_document_id, version::text as version from machvon.audit_follow_up_report where id = $1::uuid for update',
      [id],
    );
    return row === undefined
      ? undefined
      : { id: row.id, engagementId: row.engagement_id, revision: row.revision, status: row.status, payloadSha256: row.payload_sha256, createdBy: row.created_by, reportDocumentId: row.report_document_id, version: Number(row.version) };
  }

  /**
   * DOC issued the document: the report is ISSUED with it. The person who approved it is the signer DOC names, kept only when that is not the person who asked for the report (the table says
   * so): then `approved` is false and the report is issued all the same, because the document exists and is in force; the consumer raises it.
   */
  async markIssued(tx: TenantTx, head: ReportHead, input: { documentId: string; approvedBy: string | null; issuedAt: string }): Promise<{ version: number; approved: boolean }> {
    const status = nextReportStatus(head.status, 'issue');
    const approved = input.approvedBy !== null && input.approvedBy !== head.createdBy;
    const [row] = await tx.query<{ version: string }>(
      `update machvon.audit_follow_up_report
          set status = $2, report_document_id = $3::uuid, approved_by = $4::uuid, issued_at = $5::timestamptz, updated_at = now(), version = version + 1
        where id = $1::uuid returning version::text as version`,
      [head.id, status, input.documentId, approved ? input.approvedBy : null, input.issuedAt],
    );
    return { version: Number((row as { version: string }).version), approved };
  }

  async markRejected(tx: TenantTx, head: ReportHead, rejectCode: string): Promise<{ version: number }> {
    const status = nextReportStatus(head.status, 'reject');
    const [row] = await tx.query<{ version: string }>(
      'update machvon.audit_follow_up_report set status = $2, reject_code = $3, updated_at = now(), version = version + 1 where id = $1::uuid returning version::text as version',
      [head.id, status, rejectCode],
    );
    return { version: Number((row as { version: string }).version) };
  }

  async markRecalled(tx: TenantTx, head: ReportHead): Promise<{ version: number }> {
    const status = nextReportStatus(head.status, 'recall');
    const [row] = await tx.query<{ version: string }>('update machvon.audit_follow_up_report set status = $2, updated_at = now(), version = version + 1 where id = $1::uuid returning version::text as version', [head.id, status]);
    return { version: Number((row as { version: string }).version) };
  }

  /** What stands in the way of closing an engagement: recommendations that are not over, and conclusions that stand without a report DOC issued. */
  async closureFacts(tx: TenantTx, engagementId: string): Promise<{ openRecommendations: number; conclusionsWithoutReport: number }> {
    const [open] = await tx.query<{ open: string }>(
      `select count(*)::text as open from machvon.audit_recommendation r join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
        where c.engagement_id = $1::uuid and r.status not in ('CLOSED', 'CANCELLED')`,
      [engagementId],
    );
    const [missing] = await tx.query<{ missing: string }>(
      `select count(*)::text as missing from machvon.audit_conclusion c
        where c.engagement_id = $1::uuid and c.status <> 'SUPERSEDED'
          and not exists (select 1 from machvon.audit_follow_up_report r where r.tenant_id = c.tenant_id and r.conclusion_id = c.id and r.status = 'ISSUED')`,
      [engagementId],
    );
    return { openRecommendations: Number((open as { open: string }).open), conclusionsWithoutReport: Number((missing as { missing: string }).missing) };
  }

  /** The name of the unit of the tenant, or undefined: the unit that drafts the report must exist (404 for one of another tenant, as everywhere) and is the agency in its head. */
  async unitName(tx: TenantTx, unitId: string): Promise<string | undefined> {
    const [row] = await tx.query<{ name: string }>('select name from machvon.organization_unit where id = $1::uuid', [unitId]);
    return row?.name;
  }

  private async tenantId(tx: TenantTx): Promise<string> {
    const [row] = await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id");
    if (row?.tenant_id === undefined || row.tenant_id === null) throw NOT_FOUND();
    return row.tenant_id;
  }
}
