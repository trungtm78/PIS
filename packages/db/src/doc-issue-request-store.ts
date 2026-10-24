import type { TenantTx } from './tenant-database.ts';

export type IssueRequestStatus = 'RECEIVED' | 'ACCEPTED' | 'REJECTED' | 'ISSUED' | 'CANCELLED' | 'RECALLED';
export const REJECT_CODES = ['DOC_TEMPLATE_MISSING', 'TEMPLATE_NOT_EFFECTIVE', 'PAYLOAD_HASH_MISMATCH', 'PAYLOAD_SCHEMA_INVALID', 'STATE_SECRET_NOT_SUPPORTED'] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

/** A request of a source module to issue a state document (`doc_issue_request`, DOC.md F2). */
export interface IssueRequestRecord {
  id: string;
  sourceModule: string;
  sourceRef: string;
  templateCode: string;
  templateId: string | null;
  payloadSha256: string;
  payloadRef: string;
  eventId: string;
  signerHint: Record<string, unknown> | null;
  recipientsHint: unknown;
  status: IssueRequestStatus;
  rejectCode: RejectCode | null;
  outgoingDocumentId: string | null;
  requestedBy: string;
  completedAt: Date | null;
  createdAt: Date;
  version: number;
}

export interface NewIssueRequest {
  sourceModule: string;
  sourceRef: string;
  templateCode: string;
  payloadSha256: string;
  payloadRef: string;
  eventId: string;
  signerHint: Record<string, unknown> | null;
  recipientsHint: readonly unknown[] | null;
  requestedBy: string;
}

/** What inserting a request found: the new row, or the request that was there first (the same event again, or the same content still open). */
export type IssueRequestInsertion =
  | { outcome: 'INSERTED'; request: IssueRequestRecord }
  | { outcome: 'DUPLICATE_EVENT'; request: IssueRequestRecord }
  | { outcome: 'ALREADY_OPEN'; request: IssueRequestRecord };

interface Row {
  id: string;
  source_module: string;
  source_ref: string;
  template_code: string;
  template_id: string | null;
  payload_sha256: string;
  payload_ref: string;
  event_id: string;
  signer_hint: Record<string, unknown> | null;
  recipients_hint: unknown;
  status: IssueRequestStatus;
  reject_code: RejectCode | null;
  outgoing_document_id: string | null;
  requested_by: string;
  completed_at: Date | null;
  created_at: Date;
  version: string;
}

const COLUMNS = `id, source_module, source_ref, template_code, template_id, payload_sha256, payload_ref, event_id, signer_hint, recipients_hint, status, reject_code,
  outgoing_document_id, requested_by, completed_at, created_at, version::text as version`;
const UNIQUE_VIOLATION = '23505';
const EVENT_CONSTRAINT = 'doc_issue_request_event_uq';
const OPEN_CONSTRAINT = 'doc_issue_request_open_uq';
const SAVEPOINT = 'issue_request_claim';

const toRecord = (row: Row): IssueRequestRecord => ({
  id: row.id,
  sourceModule: row.source_module,
  sourceRef: row.source_ref,
  templateCode: row.template_code,
  templateId: row.template_id,
  payloadSha256: row.payload_sha256,
  payloadRef: row.payload_ref,
  eventId: row.event_id,
  signerHint: row.signer_hint,
  recipientsHint: row.recipients_hint,
  status: row.status,
  rejectCode: row.reject_code,
  outgoingDocumentId: row.outgoing_document_id,
  requestedBy: row.requested_by,
  completedAt: row.completed_at,
  createdAt: row.created_at,
  version: Number(row.version),
});

/**
 * The issue requests that source modules send to DOC (ST-DOC-008, BR-DOC-17). One event is one request, and a request for content that is
 * still open is answered with the one that is open: both rules are held by unique indexes, so two requests that race get one winner and
 * the loser is told who won. The state moves along the machine of DOC.md section 4 (the trigger of V1222 holds it).
 */
export class DocIssueRequestStore {
  async find(tx: TenantTx, id: string): Promise<IssueRequestRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from machvon.doc_issue_request where id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  async findByEvent(tx: TenantTx, sourceModule: string, eventId: string): Promise<IssueRequestRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from machvon.doc_issue_request where source_module = $1 and event_id = $2::uuid`, [sourceModule, eventId]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The request for the same content that has not ended (RECEIVED, ACCEPTED or ISSUED). */
  async findOpen(tx: TenantTx, sourceModule: string, sourceRef: string, payloadSha256: string): Promise<IssueRequestRecord | undefined> {
    const [row] = await tx.query<Row>(
      `select ${COLUMNS} from machvon.doc_issue_request
        where source_module = $1 and source_ref = $2 and payload_sha256 = $3 and status in ('RECEIVED', 'ACCEPTED', 'ISSUED')`,
      [sourceModule, sourceRef, payloadSha256],
    );
    return row === undefined ? undefined : toRecord(row);
  }

  /** Writes the request as RECEIVED; a request that lost a race to an equal one gets the winner instead (inside a savepoint, so the transaction stays usable). */
  async insertReceived(tx: TenantTx, input: NewIssueRequest): Promise<IssueRequestInsertion> {
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      const [row] = await tx.query<Row>(
        `insert into machvon.doc_issue_request
           (tenant_id, id, source_module, source_ref, template_code, payload_sha256, payload_ref, event_id, signer_hint, recipients_hint, status, requested_by, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::jsonb, 'RECEIVED', $9::uuid, $9::uuid, $9::uuid)
         returning ${COLUMNS}`,
        [
          input.sourceModule,
          input.sourceRef,
          input.templateCode,
          input.payloadSha256,
          input.payloadRef,
          input.eventId,
          input.signerHint === null ? null : JSON.stringify(input.signerHint),
          input.recipientsHint === null ? null : JSON.stringify(input.recipientsHint),
          input.requestedBy,
        ],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
      if (row === undefined) throw new Error('issue request insert returned no row');
      return { outcome: 'INSERTED', request: toRecord(row) };
    } catch (error) {
      const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
      if (code !== UNIQUE_VIOLATION || (constraint !== EVENT_CONSTRAINT && constraint !== OPEN_CONSTRAINT)) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      if (constraint === EVENT_CONSTRAINT) {
        const first = await this.findByEvent(tx, input.sourceModule, input.eventId);
        if (first === undefined) throw error;
        return { outcome: 'DUPLICATE_EVENT', request: first };
      }
      const open = await this.findOpen(tx, input.sourceModule, input.sourceRef, input.payloadSha256);
      if (open === undefined) throw error;
      return { outcome: 'ALREADY_OPEN', request: open };
    }
  }

  /** RECEIVED to ACCEPTED: the template that was chosen and the draft that came of it. */
  async markAccepted(tx: TenantTx, id: string, input: { templateId: string; outgoingDocumentId: string; actor: string }): Promise<IssueRequestRecord> {
    const [row] = await tx.query<Row>(
      `update machvon.doc_issue_request set status = 'ACCEPTED', template_id = $2::uuid, outgoing_document_id = $3::uuid, completed_at = now(), updated_at = now(),
              updated_by = $4::uuid, version = version + 1
        where id = $1::uuid and status = 'RECEIVED' returning ${COLUMNS}`,
      [id, input.templateId, input.outgoingDocumentId, input.actor],
    );
    if (row === undefined) throw new Error('only a request that was received can be accepted');
    return toRecord(row);
  }

  /** RECEIVED to REJECTED, with the reason the source module is told. */
  async markRejected(tx: TenantTx, id: string, input: { code: RejectCode; templateId: string | null; actor: string }): Promise<IssueRequestRecord> {
    const [row] = await tx.query<Row>(
      `update machvon.doc_issue_request set status = 'REJECTED', reject_code = $2, template_id = $3::uuid, completed_at = now(), updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid and status = 'RECEIVED' returning ${COLUMNS}`,
      [id, input.code, input.templateId, input.actor],
    );
    if (row === undefined) throw new Error('only a request that was received can be rejected');
    return toRecord(row);
  }

  /** ACCEPTED to ISSUED, when the document it produced is issued; undefined when no accepted request names the document. */
  async markIssued(tx: TenantTx, outgoingDocumentId: string, actor: string): Promise<IssueRequestRecord | undefined> {
    const [row] = await tx.query<Row>(
      `update machvon.doc_issue_request set status = 'ISSUED', updated_at = now(), updated_by = $2::uuid, version = version + 1
        where outgoing_document_id = $1::uuid and status = 'ACCEPTED' returning ${COLUMNS}`,
      [outgoingDocumentId, actor],
    );
    return row === undefined ? undefined : toRecord(row);
  }
}
