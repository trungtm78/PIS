import { randomUUID } from 'node:crypto';
import { DomainError, MNE_CORRECTABLE_STATUSES, MNE_ISSUED_STATUSES, assertReportState, decidedMneReport, mneReportPayload, mneReportSourceRef, payloadSha256, versionConflict } from '@machvon/kernel';
import type { MneDecision, MneReportStatus } from '@machvon/kernel';
import { DocumentStore } from './document-store.ts';
import { MneReportStore } from './mne-report-store.ts';
import type { MneReportRow } from './mne-report-store.ts';
import { idOf } from './prj-accountability-support.ts';
import { invalid } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';


export interface DecideInput {
  id: string;
  expectedVersion: number;
  decision: MneDecision;
  reason: string;
  actor: string;
  now: Date;
  unitScope: ScopeBuilder;
}

export interface IssueRequestInput {
  id: string;
  expectedVersion: number;
  actor: string;
  now: Date;
  tenantId: string;
  unitScope: ScopeBuilder;
}

export type IssueRequest =
  /** The template the form names is not in the library of DOC: nothing was written. */
  | { kind: 'TEMPLATE_MISSING'; row: MneReportRow; templateCode: string }
  | { kind: 'REQUESTED'; row: MneReportRow; previousStatus: MneReportStatus; templateCode: string; payload: Record<string, string> | null; payloadSha256: string; payloadRef: string; eventId: string; sourceRef: string };

/** What the consumer of DOC's answers needs of a report, with its row locked. */
export interface MneReportHead {
  id: string;
  revision: number;
  status: MneReportStatus;
  payloadSha256: string | null;
  docDocumentId: string | null;
  decidedAt: string | null;
  recalledAt: string | null;
  /** The event that asked DOC for the issue now in hand (or the last one asked); null before the first. */
  issueEventId: string | null;
  formCode: string;
  scopeUnitId: string;
  periodLabel: string;
  /** The revision this one corrects; null for a first revision. */
  supersedesId: string | null;
  version: number;
}

/**
 * Where the payload of a report is kept: under the prefix of the tenant, which is where DOC reads a payload from. The hash is in the key, because an object is written once: bytes written by a request whose transaction
 * did not commit stay in the store, and a later request that builds other bytes (a unit renamed meanwhile) must not meet them under its key.
 */
export const mnePayloadRef = (tenantId: string, reportId: string, revision: number, sha256: string): string => `tenants/${tenantId}/mne/reports/${reportId}/r${revision}-${sha256}.json`;

const headOf = (row: MneReportRow): MneReportHead => ({
  id: row.id,
  revision: row.revision,
  status: row.status,
  payloadSha256: row.payloadSha256,
  docDocumentId: row.docDocumentId,
  decidedAt: row.decidedAt,
  recalledAt: row.recalledAt,
  issueEventId: row.issueEventId,
  formCode: row.formCode,
  scopeUnitId: row.scopeUnitId,
  periodLabel: row.periodLabel,
  supersedesId: row.supersedesId,
  version: row.version,
});

/**
 * Review, approval and issue of the monitoring report (ST-MNE-003, MNE 3.1 F3, DOC 9): a person other than the one who wrote it and the one who handed it in approves it or sends it back with the reason; an approved
 * report is frozen as a payload with its hash and DOC is asked to issue it; it is ISSUED only when DOC says so, with the document and the hash it was asked for (the consumer of this module), and DOC's refusal puts it
 * back to APPROVED. This module never marks a report issued by itself.
 */
export class MneReportIssueStore {
  private readonly reports = new MneReportStore();
  private readonly documents = new DocumentStore();

  /** Approves a report in review (403 SELF_APPROVAL_DENIED for who wrote it or handed it in) or returns it to its preparer as a draft, with the reason (422 VALIDATION_FAILED when it is too short). */
  async decide(tx: TenantTx, input: DecideInput): Promise<{ row: MneReportRow; previousStatus: MneReportStatus }> {
    const current = await this.reports.lock(tx, input.id);
    await this.reports.assertUnitInScope(tx, current.scopeUnitId, input.unitScope);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    const reason = input.reason.trim();
    if (reason.length < 5 || reason.length > 2000) throw invalid('reason');
    const next = decidedMneReport(current.status, input.decision);
    if (input.decision === 'approve' && (input.actor === current.createdBy || input.actor === current.submittedBy)) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await tx.query(
      `update machvon.mne_report
          set status = $2, approved_by = $3::uuid, decided_by = $4::uuid, decided_at = $5::timestamptz, decision_reason = $6, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [current.id, next, input.decision === 'approve' ? input.actor : null, input.actor, input.now.toISOString(), reason],
    );
    return { row: await this.read(tx, current.id), previousStatus: current.status };
  }

  /**
   * Freezes an approved report as the payload DOC prints and asks for its issue: the report is ISSUING with the hash, where the payload is kept and the event that asks. The template the form names must be in the
   * library of DOC (422 DOC_TEMPLATE_MISSING is the caller's to answer, after it has recorded what it found: the report stays APPROVED and nothing here is written). The caller writes the payload to the file store.
   */
  async requestIssue(tx: TenantTx, input: IssueRequestInput): Promise<IssueRequest> {
    const current = await this.reports.lock(tx, input.id);
    await this.reports.assertUnitInScope(tx, current.scopeUnitId, input.unitScope);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    assertReportState(current.status, ['APPROVED']);
    if (!(await this.documents.templateCodeExists(tx, current.formDocTemplateCode))) return { kind: 'TEMPLATE_MISSING', row: current, templateCode: current.formDocTemplateCode };
    const eventId = randomUUID();
    const sourceRef = mneReportSourceRef(current.id, current.revision);
    if (current.payloadSha256 !== null && current.payloadRef !== null) {
      // DOC refused an earlier request: the payload that was frozen, and kept in the file store, is the one that is asked for again. It is not built again from the unit or the form, which may have changed since.
      await tx.query(
        `update machvon.mne_report set status = 'ISSUING', issue_event_id = $2::uuid, issue_requested_at = $3::timestamptz, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
        [current.id, eventId, input.now.toISOString(), input.actor],
      );
      return { kind: 'REQUESTED', row: await this.read(tx, current.id), previousStatus: current.status, templateCode: current.formDocTemplateCode, payload: null, payloadSha256: current.payloadSha256, payloadRef: current.payloadRef, eventId, sourceRef };
    }
    const payload = mneReportPayload({
      title: current.formTitle,
      periodLabel: current.periodLabel,
      unitCode: current.unitCode,
      unitName: current.unitName,
      dueDate: current.dueDate,
      asOfDate: typeof current.payload.meta.as_of_date === 'string' ? current.payload.meta.as_of_date : null,
      cells: current.schema.fields.map((field) => {
        const value = field.source === null ? current.payload.narrative[field.key] : current.payload.values[field.key];
        return { label: field.label, kind: field.kind, value: typeof value === 'string' || typeof value === 'number' ? value : null };
      }),
    });
    const hash = payloadSha256(payload);
    const payloadRef = mnePayloadRef(input.tenantId, current.id, current.revision, hash);
    await tx.query(
      `update machvon.mne_report
          set status = 'ISSUING', payload_sha256 = $2, payload_ref = $3, issue_event_id = $4::uuid, issue_requested_at = $5::timestamptz, updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [current.id, hash, payloadRef, eventId, input.now.toISOString(), input.actor],
    );
    return {
      kind: 'REQUESTED',
      row: await this.read(tx, current.id),
      previousStatus: current.status,
      templateCode: current.formDocTemplateCode,
      payload,
      payloadSha256: hash,
      payloadRef,
      eventId,
      sourceRef,
    };
  }

  /** The report DOC's answer names, with its row locked; undefined when the tenant has none of that id. */
  async lockHead(tx: TenantTx, id: string): Promise<MneReportHead | undefined> {
    const found = await tx.query<{ id: string }>('select id from machvon.mne_report where id = $1::uuid for update', [idOf(id, 'id')]);
    return found[0] === undefined ? undefined : headOf(await this.read(tx, id));
  }

  /** DOC issued the document: the report is ISSUED with it (409 REPORT_STATE_INVALID when it is not waiting for DOC). */
  async markIssued(tx: TenantTx, head: MneReportHead, input: { documentId: string; issuedAt: string }): Promise<{ version: number }> {
    assertReportState(head.status, ['ISSUING']);
    return this.update(tx, head.id, `status = 'ISSUED', doc_document_id = $2::uuid, issued_at = $3::timestamptz`, [input.documentId, input.issuedAt]);
  }

  /** The revision that a revision just issued corrects becomes SUPERSEDED (it stays as it was issued, and downloadable); undefined when there is none or it is not in a state to be. */
  async supersede(tx: TenantTx, supersededId: string): Promise<{ id: string; version: number; previousStatus: MneReportStatus } | undefined> {
    const [before] = await tx.query<{ status: MneReportStatus }>('select status from machvon.mne_report where id = $1::uuid for update', [supersededId]);
    if (before === undefined || !MNE_CORRECTABLE_STATUSES.includes(before.status)) return undefined;
    // A report that was never filed stays open for the calendar (late by today) until the correction is filed: the filing settles it (`settleSuperseded`).
    const done = await this.update(tx, supersededId, `status = 'SUPERSEDED'`, []);
    return { id: supersededId, version: done.version, previousStatus: before.status };
  }

  /** DOC refused to issue it: the report is APPROVED again, to be asked for again once the cause is mended. */
  async markIssueRejected(tx: TenantTx, head: MneReportHead): Promise<{ version: number }> {
    assertReportState(head.status, ['ISSUING']);
    return this.update(tx, head.id, `status = 'APPROVED'`, []);
  }

  /** DOC recalled what it issued: the report stays what it is, with the day it was recalled, and needs a correction. */
  async markRecalled(tx: TenantTx, head: MneReportHead, at: string): Promise<{ version: number }> {
    // DOC can take back what it issued whatever has become of it since, a revision that a correction superseded included.
    assertReportState(head.status, MNE_ISSUED_STATUSES);
    return this.update(tx, head.id, 'recalled_at = $2::timestamptz', [at]);
  }

  /** The state of the document DOC drafted for the report, as DOC keeps it; null while DOC has not made one. */
  async documentState(tx: TenantTx, row: Pick<MneReportRow, 'id' | 'revision'>): Promise<string | null> {
    const [found] = await tx.query<{ status: string }>(`select status from machvon.outgoing_document where source_module = 'MNE' and source_ref = $1 order by created_at desc limit 1`, [mneReportSourceRef(row.id, row.revision)]);
    return found?.status ?? null;
  }

  private async update(tx: TenantTx, id: string, assignments: string, params: unknown[]): Promise<{ version: number }> {
    const [row] = await tx.query<{ version: string }>(`update machvon.mne_report set ${assignments}, updated_at = now(), version = version + 1 where id = $1::uuid returning version::text as version`, [id, ...params]);
    return { version: Number((row as { version: string }).version) };
  }

  private async read(tx: TenantTx, id: string): Promise<MneReportRow> {
    const row = await this.reports.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }
}
