import { DocIssueRequestStore, OutgoingDocumentStore, OutgoingDraftStore, OutgoingSupersessionStore } from '@machvon/db';
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
  private readonly supersessions = new OutgoingSupersessionStore();

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
        // What the source module asked for: the draft's own hash changes when its place of issue is completed.
        ...(await this.requests.sourceOf(scope.tx, issued.id)),
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
    await this.supersede(scope, issued, now);
  }

  /**
   * A document that replaces or corrects another one takes effect when it is issued (DOC.md F9, BR-DOC-21): the system, in the same transaction, makes the old document REPLACED (no longer in force) or CORRECTED (in
   * force, with its correction), keeps the history row, and tells the modules through `doc.replaced.v1` and `doc.corrected.v1`, each once.
   */
  private async supersede(scope: CommandScope, issued: OutgoingDocumentRecord, now: Date): Promise<void> {
    const actor = scope.tenant.membershipId;
    for (const taken of await this.supersessions.takeEffect(scope.tx, issued, actor)) {
      const replaced = taken.kind === 'REPLACES';
      await scope.audit({
        action: replaced ? 'outgoing_document.replaced' : 'outgoing_document.corrected',
        resourceType: OUTGOING_TYPE,
        resourceId: taken.target.id,
        diff: { from_status: taken.from, by_document_id: issued.documentId, by_outgoing_document_id: issued.id, by_symbol: issued.symbol, number: taken.target.documentNumber, symbol: taken.target.symbol },
      });
      await scope.emit({
        aggregateType: OUTGOING_TYPE,
        aggregateId: taken.target.id,
        aggregateVersion: taken.target.version,
        type: replaced ? 'doc.replaced.v1' : 'doc.corrected.v1',
        schemaVersion: 1,
        payload: {
          tenant_id: scope.tenant.tenantId,
          document_id: taken.target.documentId,
          outgoing_document_id: taken.target.id,
          version: taken.target.version,
          actor_id: actor,
          occurred_at: now.toISOString(),
          source_module: taken.target.sourceModule,
          source_ref: taken.target.sourceRef,
          payload_sha256: taken.target.payloadSha256,
          document_number: taken.target.documentNumber,
          symbol: taken.target.symbol,
          effect_status: replaced ? 'REPLACED' : 'CORRECTED',
          by_document_id: issued.documentId,
          by_outgoing_document_id: issued.id,
          by_symbol: issued.symbol,
        },
        // A document is replaced once, and corrected once by each correction.
        eventKey: `${OUTGOING_TYPE}:${taken.target.id}:${replaced ? 'replaced' : 'corrected'}:${issued.id}`,
      });
    }
  }
}
