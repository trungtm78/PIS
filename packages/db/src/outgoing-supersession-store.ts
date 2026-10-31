import { DomainError, normalisePayload, payloadSha256 } from '@machvon/kernel';
import { DocumentStore } from './document-store.ts';
import type { TemplateRecord } from './document-store.ts';
import { OutgoingDocumentStore } from './outgoing-document-store.ts';
import type { OutgoingDocumentRecord, OutgoingStatus } from './outgoing-document-store.ts';
import { OutgoingDraftStore } from './outgoing-draft-store.ts';
import type { DraftRecipient, SigningMode } from './outgoing-draft-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The states in which an issued document can be replaced or corrected: it is in force (a corrected one still is). */
export const SUPERSEDABLE_STATUSES: readonly OutgoingStatus[] = ['ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED', 'ARCHIVED', 'CORRECTED'];
/** The states of a replacing or correcting document that has not been issued yet: while one is in them the replacement or the correction is open. */
const OPEN_STATUSES: readonly OutgoingStatus[] = ['DRAFT', 'IN_REVIEW', 'SUBMITTED', 'SIGNED', 'NUMBERED', 'SEALED'];

export type SupersessionKind = 'REPLACES' | 'CORRECTS';

export interface ReplacementInput {
  title: string | undefined;
  reason: string;
  actor: string;
  /** The day in Vietnam: the template of the new draft must be in force on it. */
  today: string;
}

export interface CorrectionInput {
  correctionText: string;
  reason: string;
  actor: string;
  today: string;
}

export interface SupersessionDraft {
  draft: OutgoingDocumentRecord;
  relationId: string;
}

/** What issuing a document did to the documents it replaces or corrects. */
export interface TakenEffect {
  kind: SupersessionKind;
  target: OutgoingDocumentRecord;
  from: OutgoingStatus;
}

export interface DocumentRelationView {
  id: string;
  kind: string;
  /** `OUT`: this document is the one that replaces, corrects or recalls; `IN`: another document does it to this one. */
  direction: 'OUT' | 'IN';
  documentId: string;
  outgoingDocumentId: string | null;
  title: string;
  symbol: string | null;
  status: string | null;
  note: string | null;
  createdAt: string;
}

/** A template code with no revision in force is not an error here: the template of the type is tried next. */
function notInForce(error: unknown): undefined {
  if (error instanceof DomainError && error.code === 'TEMPLATE_NOT_EFFECTIVE') return undefined;
  throw error;
}

interface CopySql {
  urgency: string;
  circulation: string;
  signing_mode: SigningMode;
  recipients: DraftRecipient[];
}

interface RelationSql {
  id: string;
  relation_kind: string;
  direction: 'OUT' | 'IN';
  document_id: string;
  outgoing_document_id: string | null;
  title: string;
  symbol: string | null;
  status: string | null;
  note: string | null;
  created_at: string;
}

/**
 * Replacing and correcting an issued document (ST-DOC-015, DOC.md F9, BR-DOC-21). The command makes a new draft that carries the relation REPLACES or CORRECTS to the issued document; nothing happens to the issued
 * document until the new one is issued: then the system, in the transaction of the issue, makes the old one REPLACED (it is no longer in force: other modules can no longer rely on it) or CORRECTED (it is still in force,
 * with its correction). The number of the old document stays taken either way. One replacement and one correction can be open at a time (409 REPLACEMENT_ALREADY_OPEN, 409 CORRECTION_ALREADY_OPEN).
 */
export class OutgoingSupersessionStore {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly documents = new DocumentStore();

  /** A new draft of the same type, template, recipients and content, that replaces the issued document once it is issued. */
  async createReplacement(tx: TenantTx, document: OutgoingDocumentRecord, input: ReplacementInput): Promise<SupersessionDraft> {
    await this.assertSupersedable(tx, document, 'REPLACES');
    return this.draftFrom(tx, document, 'REPLACES', input.title ?? document.title, {}, input.reason, input.actor, input.today);
  }

  /** A new draft that corrects the issued document once it is issued; the text of the correction is in the content of the draft. */
  async createCorrection(tx: TenantTx, document: OutgoingDocumentRecord, input: CorrectionInput): Promise<SupersessionDraft> {
    await this.assertSupersedable(tx, document, 'CORRECTS');
    const title = `Correction of ${document.title}`.slice(0, 500);
    return this.draftFrom(tx, document, 'CORRECTS', title, { correction: { text: input.correctionText, reason: input.reason, corrects_document_id: document.documentId } }, input.reason, input.actor, input.today);
  }

  /**
   * A document that was just issued takes effect on the documents it replaces and corrects: the replaced one ends REPLACED (its effect too), the corrected one CORRECTED and in force. A target that is no longer in
   * force (it was recalled in the meantime) is left as it is.
   */
  async takeEffect(tx: TenantTx, issued: OutgoingDocumentRecord, actor: string): Promise<TakenEffect[]> {
    const relations = await tx.query<{ relation_kind: SupersessionKind; to_document_id: string }>(
      "select relation_kind, to_document_id from machvon.document_relation where from_document_id = $1::uuid and relation_kind in ('REPLACES', 'CORRECTS') order by created_at, id",
      [issued.documentId],
    );
    const taken: TakenEffect[] = [];
    for (const relation of relations) {
      const seen = await this.outgoing.findByDocument(tx, relation.to_document_id);
      if (seen === undefined) continue;
      // The target is locked and read again before its state is judged: a recall or another issue that committed meanwhile is seen, not overwritten.
      const target = await this.outgoing.lock(tx, seen.id);
      if (target === undefined || !SUPERSEDABLE_STATUSES.includes(target.status)) continue;
      const to = relation.relation_kind === 'REPLACES' ? 'REPLACED' : 'CORRECTED';
      // A document that is already corrected stays CORRECTED when it is corrected again; one that is replaced after a correction ends REPLACED.
      await tx.query("update machvon.outgoing_document set status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [target.id, to, actor]);
      await tx.query("update machvon.document set effect_status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid and effect_status in ('EFFECTIVE', 'CORRECTED')", [target.documentId, to, actor]);
      const changed = await this.outgoing.find(tx, target.id);
      if (changed === undefined) throw new Error('outgoing document vanished while it was superseded');
      taken.push({ kind: relation.relation_kind, target: changed, from: target.status });
      await this.drafts.appendEvent(tx, {
        outgoingDocumentId: target.id,
        kind: to,
        fromStatus: target.status,
        toStatus: to,
        actor,
        documentVersion: changed.version,
        occurredAt: new Date(),
        details: { by_document_id: issued.documentId, by_outgoing_document_id: issued.id, by_symbol: issued.symbol },
      });
    }
    return taken;
  }

  /**
   * The documents that replace, correct, recall or are based on this one and those it does so to, newest first: the timeline of DOC-19. The other document is shown only to a reader who can read it (the scope of the
   * caller over the unit that drafted it); a related document the reader cannot see, or that is no outgoing document, is left out with its title, its symbol, its state and the note.
   */
  async relationsOf(tx: TenantTx, documentId: string, scope: ScopeBuilder): Promise<DocumentRelationView[]> {
    const rows = await tx.query<RelationSql>(
      `select r.id, r.relation_kind,
              case when r.from_document_id = $1::uuid then 'OUT' else 'IN' end as direction,
              d.id as document_id, o.id as outgoing_document_id, d.title, d.symbol, o.status, r.note,
              to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
         from machvon.document_relation r
         join machvon.document d on d.tenant_id = r.tenant_id and d.id = case when r.from_document_id = $1::uuid then r.to_document_id else r.from_document_id end
         left join machvon.outgoing_document o on o.tenant_id = d.tenant_id and o.document_id = d.id
        where r.from_document_id = $1::uuid or r.to_document_id = $1::uuid
        order by r.created_at desc, r.id desc`,
      [documentId],
    );
    const visible: RelationSql[] = [];
    for (const row of rows) {
      if (row.outgoing_document_id !== null && (await this.outgoing.find(tx, row.outgoing_document_id, scope)) !== undefined) visible.push(row);
    }
    return visible.map((row) => ({
      id: row.id,
      kind: row.relation_kind,
      direction: row.direction,
      documentId: row.document_id,
      outgoingDocumentId: row.outgoing_document_id,
      title: row.title,
      symbol: row.symbol,
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
    }));
  }

  /** A document in force, whose replacement (or correction) is not already on its way. */
  private async assertSupersedable(tx: TenantTx, document: OutgoingDocumentRecord, kind: SupersessionKind): Promise<void> {
    if (!SUPERSEDABLE_STATUSES.includes(document.status)) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const open = await tx.query<{ id: string }>(
      `select r.id from machvon.document_relation r join machvon.outgoing_document o on o.tenant_id = r.tenant_id and o.document_id = r.from_document_id
        where r.to_document_id = $1::uuid and r.relation_kind = $2 and o.status = any($3::text[]) limit 1`,
      [document.documentId, kind, [...OPEN_STATUSES]],
    );
    if (open.length > 0) throw new DomainError(kind === 'REPLACES' ? 'REPLACEMENT_ALREADY_OPEN' : 'CORRECTION_ALREADY_OPEN', 409, 'status');
  }

  /**
   * The template of the new draft: the one the old document was drawn from if it is still in force, else the revision of the same template that is, else the template of its type that is (an externally registered
   * document has no template of its own). A draft cannot leave the draft state without a template in force, so none at all is 422 TEMPLATE_NOT_EFFECTIVE here, before the draft exists.
   */
  private async templateFor(tx: TenantTx, document: OutgoingDocumentRecord, today: string): Promise<TemplateRecord> {
    const pinned = document.templateId === null ? undefined : await this.documents.templateInForce(tx, document.templateId, today);
    if (pinned !== undefined) return pinned;
    const [code] = document.templateId === null ? [] : await tx.query<{ template_code: string }>('select template_code from machvon.document_template where id = $1::uuid', [document.templateId]);
    const revision = code === undefined ? undefined : await this.documents.templateFor(tx, { templateCode: code.template_code }, today).catch(notInForce);
    const template = revision ?? (await this.documents.templateForDocType(tx, document.docTypeCode, today));
    if (template === undefined) throw new DomainError('TEMPLATE_NOT_EFFECTIVE', 422, 'template_id');
    return template;
  }

  private async draftFrom(
    tx: TenantTx,
    document: OutgoingDocumentRecord,
    kind: SupersessionKind,
    title: string,
    extraPayload: Record<string, unknown>,
    reason: string,
    actor: string,
    today: string,
  ): Promise<SupersessionDraft> {
    const content = await this.drafts.contentOf(tx, document.id);
    if (content === undefined) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const template = await this.templateFor(tx, document, today);
    const [copy] = await tx.query<CopySql>('select urgency, circulation, signing_mode, recipients from machvon.outgoing_document where id = $1::uuid', [document.id]);
    if (copy === undefined) throw new Error('outgoing document vanished while it was superseded');
    // The words of a correction are stored as a draft stores any text (BR-DOC-11): normalised, and hashed as they are kept.
    const payload = normalisePayload({ ...content.payload, ...extraPayload }) as Record<string, unknown>;
    const draft = await this.drafts.createDraft(tx, {
      docTypeCode: document.docTypeCode,
      title,
      draftingUnitId: document.draftingUnitId,
      templateId: template.id,
      layoutProfileId: template.layoutProfileId,
      urgency: copy.urgency as never,
      circulation: copy.circulation as never,
      classification: document.classification as never,
      payload,
      payloadSha256: payloadSha256(payload),
      recipients: copy.recipients,
      // A delegation belongs to the document it was given for: the new draft is signed in person, by the signer of the old one when that was in person too, and the drafter chooses a delegation again if one is needed.
      signerUserId: copy.signing_mode === 'DIRECT' ? document.signerUserId : null,
      signerTitle: copy.signing_mode === 'DIRECT' ? document.signerTitle : null,
      signingMode: 'DIRECT',
      delegationId: null,
      subjectModule: content.subjectModule,
      subjectId: content.subjectId,
      replyToIncomingId: null,
      reviewDueOn: null,
      actor,
    });
    const [relation] = await tx.query<{ id: string }>(
      `insert into machvon.document_relation (tenant_id, id, from_document_id, to_document_id, relation_kind, note, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::uuid, $5::uuid) returning id`,
      [draft.documentId, document.documentId, kind, reason, actor],
    );
    if (relation === undefined) throw new Error('document relation insert returned no row');
    return { draft, relationId: relation.id };
  }
}
