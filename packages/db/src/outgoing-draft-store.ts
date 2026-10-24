import { DomainError, versionConflict } from '@machvon/kernel';
import { OutgoingDocumentStore } from './outgoing-document-store.ts';
import type { OutgoingDocumentRecord, OutgoingStatus } from './outgoing-document-store.ts';
import type { TenantTx } from './tenant-database.ts';

export type Urgency = 'NORMAL' | 'KHAN' | 'THUONG_KHAN' | 'HOA_TOC';
export type Circulation = 'PUBLIC' | 'INTERNAL_CIRCULATION';
export type SigningMode = 'DIRECT' | 'KT' | 'TM' | 'TL' | 'TUQ';
export type DocumentClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL';

/** One recipient of a document ("Noi nhan"): the shape the distribution of the document later works from. */
export interface DraftRecipient {
  kind: 'INTERNAL_UNIT' | 'EXTERNAL_AGENCY' | 'PERSON';
  name: string;
  code?: string;
  unit_id?: string;
}

export interface NewOutgoingDraft {
  docTypeCode: string;
  title: string;
  draftingUnitId: string;
  templateId: string;
  layoutProfileId: string;
  urgency: Urgency;
  circulation: Circulation;
  classification: DocumentClassification;
  /** The normalised payload (BR-DOC-11) and its SHA-256: the stored values, never the raw request. */
  payload: Record<string, unknown>;
  payloadSha256: string;
  recipients: readonly DraftRecipient[];
  signerUserId: string | null;
  signerTitle: string | null;
  signingMode: SigningMode;
  delegationId: string | null;
  subjectModule: string | null;
  subjectId: string | null;
  replyToIncomingId: string | null;
  reviewDueOn: string | null;
  /** Set only for a draft that a source module asked for (BR-DOC-17): the document is created by the issue request, never by a person. */
  source?: { module: string; ref: string; issueRequestId: string } | undefined;
  actor: string;
}

/** What a draft edit changes; a member that is `undefined` stays as it was. */
export interface DraftPatch {
  title?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  payloadSha256?: string | undefined;
  recipients?: readonly DraftRecipient[] | undefined;
  urgency?: Urgency | undefined;
  signerUserId?: string | undefined;
  signerTitle?: string | null | undefined;
  signingMode?: SigningMode | undefined;
  delegationId?: string | null | undefined;
  reviewDueOn?: string | null | undefined;
}

export interface DraftContent {
  payload: Record<string, unknown>;
  payloadSha256: string | null;
  subjectModule: string | null;
  subjectId: string | null;
  replyToIncomingId: string | null;
}

export interface NewOutgoingEvent {
  outgoingDocumentId: string;
  kind: string;
  fromStatus: OutgoingStatus | null;
  toStatus: OutgoingStatus;
  actor: string;
  comment?: string | null | undefined;
  details?: Record<string, unknown> | undefined;
  documentVersion: number;
  occurredAt: Date;
}

export interface OutgoingEventRecord {
  id: string;
  seq: number;
  kind: string;
  fromStatus: OutgoingStatus | null;
  toStatus: OutgoingStatus;
  actorId: string;
  comment: string | null;
  details: Record<string, unknown>;
  documentVersion: number;
  occurredAt: Date;
}

/** A signing session that was open when its document went back to the draft or was cancelled: the provider is told to stop. */
export interface CancelledSession {
  id: string;
  adapterCode: string;
  providerTxnRef: string | null;
  expiresAt: Date;
}

interface EventRow {
  id: string;
  seq: string;
  kind: string;
  from_status: OutgoingStatus | null;
  to_status: OutgoingStatus;
  actor_id: string;
  comment: string | null;
  details: Record<string, unknown>;
  document_version: string;
  occurred_at: Date;
}

const OPEN_SESSION_STATUSES = ['CREATED', 'HASH_READY', 'AWAITING_SIGNER', 'SIGNED'];

const toEvent = (row: EventRow): OutgoingEventRecord => ({
  id: row.id,
  seq: Number(row.seq),
  kind: row.kind,
  fromStatus: row.from_status,
  toStatus: row.to_status,
  actorId: row.actor_id,
  comment: row.comment,
  details: row.details,
  documentVersion: Number(row.document_version),
  occurredAt: row.occurred_at,
});

/**
 * The draft of an outgoing document and the steps up to the lock of its final PDF (ST-DOC-007, DOC.md F1 and F3). Every query runs
 * inside the caller's tenant transaction. A step names the states it may start from and the version the caller saw; the database
 * trigger of V1221 holds the other half of the rule (the content is fixed once the document leaves the draft).
 */
export class OutgoingDraftStore {
  private readonly outgoing = new OutgoingDocumentStore();

  /** Writes the document anchor (PENDING) and the outgoing document (DRAFT) together. */
  async createDraft(tx: TenantTx, input: NewOutgoingDraft): Promise<OutgoingDocumentRecord> {
    const [anchor] = await tx.query<{ id: string }>(
      `insert into machvon.document
         (tenant_id, id, doc_kind, doc_type_code, title, classification, issuer_unit_id, subject_module, subject_id, source_ref, payload_sha256, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'OUTGOING', $1, $2, $3, $4::uuid, $5, $6::uuid, $7, $8, $9::uuid, $9::uuid)
       returning id`,
      [
        input.docTypeCode,
        input.title,
        input.classification,
        input.draftingUnitId,
        input.subjectModule,
        input.subjectId,
        input.source?.ref ?? null,
        input.source === undefined ? null : input.payloadSha256,
        input.actor,
      ],
    );
    if (anchor === undefined) throw new Error('document insert returned no row');
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.outgoing_document
         (tenant_id, id, document_id, template_id, layout_profile_id, status, urgency, circulation, drafting_unit_id, drafter_user_id, signer_user_id,
          signer_title, signing_mode, delegation_id, recipients, payload_json, payload_sha256, source_module, source_ref, issue_request_id,
          reply_to_incoming_id, review_due_on, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'DRAFT', $4, $5, $6::uuid, $7::uuid, $8::uuid,
          $9, $10, $11::uuid, $12::jsonb, $13::jsonb, $14, $15, $16, $17::uuid, $18::uuid, $19::date, $7::uuid, $7::uuid)
       returning id`,
      [
        anchor.id,
        input.templateId,
        input.layoutProfileId,
        input.urgency,
        input.circulation,
        input.draftingUnitId,
        input.actor,
        input.signerUserId,
        input.signerTitle,
        input.signingMode,
        input.delegationId,
        JSON.stringify(input.recipients),
        JSON.stringify(input.payload),
        input.payloadSha256,
        input.source?.module ?? null,
        input.source?.ref ?? null,
        input.source?.issueRequestId ?? null,
        input.replyToIncomingId,
        input.reviewDueOn,
      ],
    );
    if (row === undefined) throw new Error('outgoing document insert returned no row');
    return this.reload(tx, row.id);
  }

  /** The payload and the references of a document, which the list and the header of the screens do not carry. */
  async contentOf(tx: TenantTx, id: string): Promise<DraftContent | undefined> {
    const [row] = await tx.query<{
      payload_json: Record<string, unknown> | null;
      payload_sha256: string | null;
      subject_module: string | null;
      subject_id: string | null;
      reply_to_incoming_id: string | null;
    }>(
      `select o.payload_json, o.payload_sha256, d.subject_module, d.subject_id, o.reply_to_incoming_id
         from machvon.outgoing_document o join machvon.document d on d.tenant_id = o.tenant_id and d.id = o.document_id where o.id = $1::uuid`,
      [id],
    );
    if (row === undefined) return undefined;
    return {
      payload: row.payload_json ?? {},
      payloadSha256: row.payload_sha256,
      subjectModule: row.subject_module,
      subjectId: row.subject_id,
      replyToIncomingId: row.reply_to_incoming_id,
    };
  }

  /** Edits a draft. Only a DRAFT can be edited (409 DOCUMENT_STATE_INVALID); a stale version is 409 VERSION_CONFLICT. */
  async updateDraft(tx: TenantTx, id: string, input: { expectedVersion: number; patch: DraftPatch; actor: string }): Promise<OutgoingDocumentRecord> {
    const current = await this.lockStatus(tx, id, input.expectedVersion);
    if (current !== 'DRAFT') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const { patch } = input;
    const assignments: string[] = [];
    const values: unknown[] = [id, input.actor];
    const set = (column: string, value: unknown, cast = ''): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.payload !== undefined) set('payload_json', JSON.stringify(patch.payload), '::jsonb');
    if (patch.payloadSha256 !== undefined) set('payload_sha256', patch.payloadSha256);
    if (patch.recipients !== undefined) set('recipients', JSON.stringify(patch.recipients), '::jsonb');
    if (patch.urgency !== undefined) set('urgency', patch.urgency);
    if (patch.signerUserId !== undefined) set('signer_user_id', patch.signerUserId, '::uuid');
    if (patch.signerTitle !== undefined) set('signer_title', patch.signerTitle);
    if (patch.signingMode !== undefined) set('signing_mode', patch.signingMode);
    if (patch.delegationId !== undefined) set('delegation_id', patch.delegationId, '::uuid');
    if (patch.reviewDueOn !== undefined) set('review_due_on', patch.reviewDueOn, '::date');
    await tx.query(`update machvon.outgoing_document set ${assignments.join(', ')}${assignments.length > 0 ? ',' : ''} updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, values);
    if (patch.title !== undefined) {
      await tx.query(
        `update machvon.document set title = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = (select document_id from machvon.outgoing_document where id = $1::uuid)`,
        [id, patch.title, input.actor],
      );
    }
    return this.reload(tx, id);
  }

  /** DRAFT to IN_REVIEW. */
  submit(tx: TenantTx, id: string, input: { expectedVersion: number; actor: string }): Promise<OutgoingDocumentRecord> {
    return this.move(tx, id, input.expectedVersion, ['DRAFT'], "status = 'IN_REVIEW'", [], input.actor);
  }

  /** IN_REVIEW to SUBMITTED: the final PDF is locked (the caller wrote its version first). */
  approve(tx: TenantTx, id: string, input: { expectedVersion: number; actor: string }): Promise<OutgoingDocumentRecord> {
    return this.move(tx, id, input.expectedVersion, ['IN_REVIEW'], "status = 'SUBMITTED'", [], input.actor);
  }

  /**
   * IN_REVIEW or SUBMITTED back to DRAFT. From SUBMITTED the final PDF stops being the current file of the document (its version stays in
   * the history), and the signing sessions that were still open end CANCELLED; they are returned so the provider can be told.
   */
  async returnToDraft(tx: TenantTx, id: string, input: { expectedVersion: number; actor: string }): Promise<{ document: OutgoingDocumentRecord; cancelled: CancelledSession[]; from: OutgoingStatus }> {
    const from = await this.lockStatus(tx, id, input.expectedVersion);
    if (from !== 'IN_REVIEW' && from !== 'SUBMITTED') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    await this.setStatus(tx, id, "status = 'DRAFT'", [], input.actor);
    let cancelled: CancelledSession[] = [];
    if (from === 'SUBMITTED') {
      cancelled = await this.cancelOpenSessions(tx, id, input.actor);
      await tx.query(
        `update machvon.document set current_version_id = null, updated_at = now(), updated_by = $2::uuid, version = version + 1
          where id = (select document_id from machvon.outgoing_document where id = $1::uuid)`,
        [id, input.actor],
      );
    }
    return { document: await this.reload(tx, id), cancelled, from };
  }

  /**
   * DRAFT up to SIGNED to CANCELLED, with the reason; the anchor of the document becomes EXPIRED so the source it came from may ask again.
   * A number already given (NUMBERED, SEALED) is 409 NUMBER_ALREADY_ALLOCATED: such a document ends by voiding its number.
   */
  async cancel(tx: TenantTx, id: string, input: { expectedVersion: number; reason: string; actor: string }): Promise<{ document: OutgoingDocumentRecord; cancelled: CancelledSession[]; from: OutgoingStatus }> {
    const from = await this.lockStatus(tx, id, input.expectedVersion);
    if (from === 'NUMBERED' || from === 'SEALED') throw new DomainError('NUMBER_ALREADY_ALLOCATED', 409, 'status');
    if (!['DRAFT', 'IN_REVIEW', 'SUBMITTED', 'SIGNED'].includes(from)) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    await this.setStatus(tx, id, "status = 'CANCELLED', cancel_reason = $3", [input.reason], input.actor);
    await tx.query(
      `update machvon.document set effect_status = 'EXPIRED', updated_at = now(), updated_by = $2::uuid, version = version + 1
        where id = (select document_id from machvon.outgoing_document where id = $1::uuid)`,
      [id, input.actor],
    );
    const cancelled = await this.cancelOpenSessions(tx, id, input.actor);
    return { document: await this.reload(tx, id), cancelled, from };
  }

  /** The issue request a source module made ends CANCELLED when the draft it produced is cancelled (BR-DOC-17). */
  async cancelIssueRequest(tx: TenantTx, id: string, actor: string): Promise<void> {
    await tx.query(
      `update machvon.doc_issue_request set status = 'CANCELLED', updated_at = now(), updated_by = $2::uuid, version = version + 1
        where id = $1::uuid and status = 'ACCEPTED'`,
      [id, actor],
    );
  }

  /** One row of the status history of a document. */
  async appendEvent(tx: TenantTx, input: NewOutgoingEvent): Promise<void> {
    await tx.query(
      `insert into machvon.outgoing_document_event
         (tenant_id, id, outgoing_document_id, kind, from_status, to_status, actor_id, comment, details, document_version, occurred_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4, $5::uuid, $6, $7::jsonb, $8, $9::timestamptz)`,
      [input.outgoingDocumentId, input.kind, input.fromStatus, input.toStatus, input.actor, input.comment ?? null, JSON.stringify(input.details ?? {}), input.documentVersion, input.occurredAt.toISOString()],
    );
  }

  async eventsOf(tx: TenantTx, outgoingDocumentId: string): Promise<OutgoingEventRecord[]> {
    const rows = await tx.query<EventRow>(
      `select id, seq::text as seq, kind, from_status, to_status, actor_id, comment, details, document_version::text as document_version, occurred_at
         from machvon.outgoing_document_event where outgoing_document_id = $1::uuid order by seq`,
      [outgoingDocumentId],
    );
    return rows.map(toEvent);
  }

  /** The latest event of the given kinds: the review comment and the checklist the drafter and the approver read. */
  async latestEvent(tx: TenantTx, outgoingDocumentId: string, kinds: readonly string[]): Promise<OutgoingEventRecord | undefined> {
    const [row] = await tx.query<EventRow>(
      `select id, seq::text as seq, kind, from_status, to_status, actor_id, comment, details, document_version::text as document_version, occurred_at
         from machvon.outgoing_document_event where outgoing_document_id = $1::uuid and kind = any($2::text[]) order by seq desc limit 1`,
      [outgoingDocumentId, kinds],
    );
    return row === undefined ? undefined : toEvent(row);
  }

  private async lockStatus(tx: TenantTx, id: string, expectedVersion: number): Promise<OutgoingStatus> {
    const [current] = await tx.query<{ status: OutgoingStatus; version: string }>('select status, version::text as version from machvon.outgoing_document where id = $1::uuid for update', [id]);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(current.version) !== expectedVersion) throw versionConflict(Number(current.version));
    return current.status;
  }

  private async setStatus(tx: TenantTx, id: string, assignments: string, values: readonly unknown[], actor: string): Promise<void> {
    // $1 is the id and $2 the actor; the values of the transition follow from $3.
    await tx.query(`update machvon.outgoing_document set ${assignments}, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [id, actor, ...values]);
  }

  private async move(tx: TenantTx, id: string, expectedVersion: number, from: readonly OutgoingStatus[], assignments: string, values: readonly unknown[], actor: string): Promise<OutgoingDocumentRecord> {
    const status = await this.lockStatus(tx, id, expectedVersion);
    if (!from.includes(status)) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    await this.setStatus(tx, id, assignments, values, actor);
    return this.reload(tx, id);
  }

  /** Ends the signing sessions of a document that are still open (CANCELLED); returns them so the provider can be told. */
  async cancelOpenSessions(tx: TenantTx, outgoingDocumentId: string, actor: string): Promise<CancelledSession[]> {
    const rows = await tx.query<{ id: string; adapter_code: string; provider_txn_ref: string | null; expires_at: Date }>(
      `update machvon.doc_signing_session set status = 'CANCELLED', updated_at = now(), updated_by = $2::uuid, version = version + 1
        where outgoing_document_id = $1::uuid and status = any($3::text[])
        returning id, adapter_code, provider_txn_ref, expires_at`,
      [outgoingDocumentId, actor, OPEN_SESSION_STATUSES],
    );
    return rows.map((row) => ({ id: row.id, adapterCode: row.adapter_code, providerTxnRef: row.provider_txn_ref, expiresAt: row.expires_at }));
  }

  private async reload(tx: TenantTx, id: string): Promise<OutgoingDocumentRecord> {
    const found = await this.outgoing.find(tx, id);
    if (found === undefined) throw new Error('outgoing document vanished while it was locked');
    return found;
  }
}
