import { DocIssueRequestStore, OutgoingDocumentStore, OutgoingDraftStore } from '@machvon/db';
import type { OutgoingDocumentRecord } from '@machvon/db';
import type { CommandScope } from '../../command-scope';

const OUTGOING_TYPE = 'outgoing_document';

export interface IssuedFile {
  /** The version of the file that is the issued document, and its SHA-256. */
  versionId: string;
  fileSha256: string;
}

/** The written reason of a person who may confirm templates, for issuing a document whose template is not yet confirmed (BR-DOC-10). */
export interface TemplateOverride {
  reason: string;
  by: string;
}

/**
 * The step that makes a sealed document the issued one (DOC.md F7, state ISSUED): the document is in force, the request of the source module (if it came
 * from one) is ISSUED, the status history gets its row and `doc.issued.v1` goes out once, carrying the number, the symbol, the hash of the content and the
 * hash of the file. The source module marks its own record issued only after that event, matching its reference and its hash (BR-DOC-17). The checks that
 * decide whether a document may be issued (both signatures verified, the chain trusted) belong to the command that calls this; the external registration
 * (ST-DOC-009) writes its document already ISSUED and uses `announce`.
 */
export class OutgoingIssuance {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly requests = new DocIssueRequestStore();

  /** SEALED to ISSUED in the transaction of the command; `override` is kept with the document when its template is not yet confirmed. */
  async issue(scope: CommandScope, document: OutgoingDocumentRecord, file: IssuedFile, now: Date, override?: TemplateOverride): Promise<OutgoingDocumentRecord> {
    const actor = scope.tenant.membershipId;
    const issued = await this.outgoing.markIssued(scope.tx, document.id, { expectedVersion: document.version, issuedAt: now, actor, override });
    await this.requests.markIssued(scope.tx, document.id, actor);
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: document.id,
      kind: 'ISSUED',
      fromStatus: 'SEALED',
      toStatus: 'ISSUED',
      actor,
      documentVersion: issued.version,
      occurredAt: now,
      details: { number: issued.documentNumber, symbol: issued.symbol, file_sha256: file.fileSha256, version_id: file.versionId, ...(override === undefined ? {} : { template_override: true }) },
    });
    await this.announce(scope, issued, file, now);
    return issued;
  }

  /** The audit row and the event of an issued document, for the two ways a document becomes issued. */
  async announce(scope: CommandScope, issued: OutgoingDocumentRecord, file: IssuedFile, now: Date): Promise<void> {
    await scope.audit({
      action: 'outgoing_document.issue',
      resourceType: OUTGOING_TYPE,
      resourceId: issued.id,
      diff: {
        route: issued.route,
        number: issued.documentNumber,
        symbol: issued.symbol,
        issued_on: issued.issuedOn,
        file_sha256: file.fileSha256,
        version_id: file.versionId,
        // The reason is the legal record of why a document with a watermark went out (BR-DOC-10): the audit row keeps it as written.
        ...(issued.unconfirmedOverrideReason === null ? {} : { unconfirmed_override_reason: issued.unconfirmedOverrideReason, unconfirmed_override_by: issued.unconfirmedOverrideBy }),
      },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: issued.id,
      aggregateVersion: issued.version,
      type: 'doc.issued.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        document_id: issued.documentId,
        outgoing_document_id: issued.id,
        version: issued.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        source_module: issued.sourceModule,
        source_ref: issued.sourceRef,
        payload_sha256: issued.payloadSha256,
        document_number: issued.documentNumber,
        symbol: issued.symbol,
        issued_on: issued.issuedOn,
        document_version_id: file.versionId,
        file_sha256: file.fileSha256,
        route: issued.route,
        // A reference copy: the template was not confirmed when the document was issued (the file keeps its watermark).
        template_unconfirmed: issued.unconfirmedOverrideReason !== null,
      },
      // One issue, one event: a retry that reaches this point again emits nothing new.
      eventKey: `${OUTGOING_TYPE}:${issued.id}:issued`,
    });
  }
}
