import { createHash, randomUUID } from 'node:crypto';
import { AuditWriter, DocIncomingStore, DocInteropStore, DocumentStore, IntegrationConnectorStore, NIL_RESOURCE_ID } from '@machvon/db';
import type { ConnectorRow, DistributionRecord, InteropRecord, OutgoingDocumentRecord, TenantDatabase } from '@machvon/db';
import { DomainError, INTEROP_SIGNATURE_SCHEME, NOOP_METRICS, interopSignedPayload, stateSecretMarking, verifyProviderCallback, vietnamDateOf } from '@machvon/kernel';
import type { InteropAdapterStatus, MetricsSink } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import type { WebhookSecretResolver } from '../../notifications/delivery/webhook-support';
import type { FileService } from '../files';
import { assertPdf, pageCountOf } from './external-signature';
import type { DocumentFilePort } from './file-port';
import { announceIncoming, takeInLetter } from './incoming-intake';
import type { InteropCodec } from './interop-port';

/** The mode of the connector of the agency's LGSP gateway (ADM-09) and the code of the adapter that speaks to it. */
export const LGSP_CONNECTOR_MODE = 'LGSP';
export const LGSP_ADAPTER_CODE = 'LGSP_EDXML';
/** The envelope is kept in the object store of the platform under this kind, by its digest. */
const ENVELOPE_KIND = 'interop-envelope';
const ENVELOPE_CONTENT_TYPE = 'application/json';
const RESOURCE_TYPE = 'doc_interop_message';
const CLASSIFICATION = 'INTERNAL';
/** The reason written on a letter that arrived again under another envelope: the same wording on every tenant, as the clerk would write it. */
export const REPEATED_LETTER_REASON = 'Received again through the LGSP under another envelope';
export const INTEROP_METRIC = 'doc_interop_message_total';

/** What the connector of the LGSP says about where and as whom the system calls: all of it in `config` (a credential is only a reference to the vault). */
export interface LgspSettings {
  endpoint: string | undefined;
  /** The hosts the system may call; none listed allows none. */
  egressAllowlist: unknown[];
  /** The code of this agency on the LGSP: the sender of what leaves. */
  agencyCode: string | null;
}

export function lgspSettingsOf(connector: ConnectorRow | undefined): LgspSettings {
  const config = connector?.config ?? {};
  const code = typeof config.agency_code === 'string' && config.agency_code.trim() !== '' ? config.agency_code.trim() : null;
  return { endpoint: typeof config.endpoint === 'string' ? config.endpoint : undefined, egressAllowlist: Array.isArray(config.egress_allowlist) ? config.egress_allowlist : [], agencyCode: code };
}

/** What the monitor and the audit know of the adapter that carries a message: the words of the connector, and MISSING when the tenant declared none. */
export const adapterStatusOf = (connector: ConnectorRow | undefined): InteropAdapterStatus => connector?.adapterStatus ?? 'MISSING';

export interface InteropServiceDeps {
  database: TenantDatabase;
  files: Pick<FileService, 'download' | 'storeGenerated'>;
  stored: DocumentFilePort;
  secrets: WebhookSecretResolver;
  codec: InteropCodec;
  metrics?: MetricsSink | undefined;
}

export interface ReceivedMessage {
  message: InteropRecord;
  incomingDocumentId: string;
  documentId: string;
}

/**
 * The two doors of the interoperability of documents that belong to a request (ST-DOC-021, DOC.md F13): queueing the envelope of a distribution on the LGSP channel, and taking in a message that the LGSP delivers.
 * The sending itself, with its waits and its end as DEAD, is the job (`interop-sender.ts`); nothing here calls the gateway.
 */
export class DocInteropService {
  private readonly messages = new DocInteropStore();
  private readonly connectors = new IntegrationConnectorStore();
  private readonly documents = new DocumentStore();
  private readonly incoming = new DocIncomingStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: InteropServiceDeps) {
    this.audit = new AuditWriter(deps.database);
    this.metrics = deps.metrics ?? NOOP_METRICS;
  }

  /**
   * Queues the document of a distribution for the LGSP: the adapter builds the envelope around the sealed PDF, it is kept by its digest, and the message is written QUEUED (the same message when the distribution is queued
   * again). Nothing leaves the system here: the call runs inside the transaction of the command, which may still roll back.
   */
  async enqueue(scope: Pick<CommandScope, 'tx' | 'tenant'>, input: { document: OutgoingDocumentRecord; distribution: DistributionRecord; objectKey: string }): Promise<{ message: InteropRecord; created: boolean }> {
    const { document, distribution } = input;
    if (distribution.recipientCode === null) throw new DomainError('RECIPIENT_INVALID', 422, 'recipients', { extensions: { reason: 'CODE_REQUIRED_FOR_LGSP' } });
    const pdf = await this.deps.stored.get(input.objectKey);
    if (pdf === undefined) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'version');
    const connector = await this.connectors.primaryOfMode(scope.tx, LGSP_CONNECTOR_MODE);
    const settings = lgspSettingsOf(connector);
    const messageId = randomUUID();
    const envelope = this.deps.codec.encode({
      messageId,
      senderCode: settings.agencyCode,
      receiverCode: distribution.recipientCode,
      symbol: document.symbol ?? '',
      issuedOn: document.issuedOn ?? '',
      title: document.title,
      docTypeCode: document.docTypeCode,
      urgency: document.urgency,
      pdf: pdf.bytes,
    });
    const sha256 = createHash('sha256').update(envelope).digest('hex');
    const objectKey = await this.deps.files.storeGenerated(scope.tenant, ENVELOPE_KIND, sha256, envelope, ENVELOPE_CONTENT_TYPE);
    const written = await this.messages.insertOutbound(
      scope.tx,
      {
        id: messageId,
        documentId: document.documentId,
        distributionId: distribution.id,
        adapterCode: LGSP_ADAPTER_CODE,
        adapterStatus: adapterStatusOf(connector),
        senderCode: settings.agencyCode,
        receiverCode: distribution.recipientCode,
        envelopeSha256: sha256,
        envelopeObjectKey: objectKey,
      },
      scope.tenant.membershipId,
    );
    this.metrics.increment(INTEROP_METRIC, { direction: 'outbound', outcome: 'queued' });
    return { message: written.record, created: written.created };
  }

  /**
   * Takes in a message the LGSP delivers (the webhook `receiveInteropMessage`): the signature of the message is checked with the key it names, before anything of it is read (422 SIGNATURE_KEY_UNKNOWN for a key the
   * connector does not hold, 401 SIGNATURE_INVALID for a signature that does not verify); the envelope is read from the object store and must be the bytes whose digest was signed; a message whose digest or id was received
   * before is 409 ENVELOPE_DUPLICATE and changes nothing; otherwise the message is written, the letter is made exactly as a clerk would take it in (a letter marked as state secret is refused, one that looks like a letter
   * already there is taken in with the reason) and the message is PROCESSED, all in this transaction.
   */
  async receive(scope: CommandScope, body: Schemas['DocInteropInbound'], now: Date): Promise<ReceivedMessage> {
    const connector = await this.connectors.primaryOfMode(scope.tx, LGSP_CONNECTOR_MODE);
    // A tenant that has not put its gateway to work (the adapter is PROPOSED until the specification exists) takes nothing in.
    if (connector === undefined || connector.status !== 'Active') throw new DomainError('PROVIDER_UNAVAILABLE', 503);
    const fields = { externalMessageId: body.external_message_id, senderCode: body.sender_code, envelopeSha256: body.envelope_sha256, envelopeObjectKey: body.envelope_object_key, signatureKeyId: body.signature_key_id };
    const keys = connector.credentialSecretRef === null ? [] : await this.deps.secrets.resolve(connector.credentialSecretRef);
    const key = keys.find((candidate) => candidate.keyId === body.signature_key_id);
    if (key === undefined) {
      this.metrics.increment(INTEROP_METRIC, { direction: 'inbound', outcome: 'key_unknown' });
      throw new DomainError('SIGNATURE_KEY_UNKNOWN', 422, 'signature_key_id');
    }
    // The message carries no time of its own under the signature: a message that comes twice is stopped by its digest, not by a window.
    verifyProviderCallback({ provider: 'lgsp', rawBody: interopSignedPayload(fields), signature: body.signature, timestampSeconds: 0, keys: [key], scheme: INTEROP_SIGNATURE_SCHEME, replayWindowSeconds: Number.MAX_SAFE_INTEGER, metrics: this.metrics });

    const stored = await this.deps.files.download(scope.tenant, body.envelope_object_key);
    const bytes = Buffer.from(stored.bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== body.envelope_sha256) throw new DomainError('VALIDATION_FAILED', 422, 'envelope_sha256');
    const letter = this.deps.codec.decode(bytes);
    await this.refuseStateSecret(scope, letter);
    assertPdf(letter.pdf);
    const checksum = createHash('sha256').update(letter.pdf).digest('hex');
    const pages = await pageCountOf(letter.pdf);

    const written = await this.messages.insertInbound(
      scope.tx,
      { adapterCode: LGSP_ADAPTER_CODE, adapterStatus: adapterStatusOf(connector), externalMessageId: body.external_message_id, senderCode: body.sender_code, envelopeSha256: body.envelope_sha256, envelopeObjectKey: body.envelope_object_key },
      scope.tenant.membershipId,
    );
    if (!written.created) {
      this.metrics.increment(INTEROP_METRIC, { direction: 'inbound', outcome: 'duplicate' });
      throw new DomainError('ENVELOPE_DUPLICATE', 409, 'envelope_sha256', { extensions: { interop_message_id: written.record.id, incoming_document_id: written.record.incomingDocumentId } });
    }
    if ((await this.documents.docTypeFor(scope.tx, letter.docTypeCode, vietnamDateOf(now))) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'doc_type_code');
    const senderName = letter.senderName ?? body.sender_code;
    const duplicate = await this.incoming.duplicateOf(scope.tx, { senderName, originalSymbol: letter.originalSymbol, originalIssuedOn: letter.originalIssuedOn });
    const taken = await takeInLetter(
      scope.tx,
      scope.tenant.tenantId,
      { documents: this.documents, incoming: this.incoming, stored: this.deps.stored },
      {
        title: letter.title,
        docTypeCode: letter.docTypeCode,
        classification: 'INTERNAL',
        file: { bytes: letter.pdf, checksum, pages },
        channel: 'LGSP',
        receivedAt: now,
        receivedBy: scope.tenant.membershipId,
        originalSymbol: letter.originalSymbol,
        originalIssuedOn: letter.originalIssuedOn,
        senderName,
        urgency: letter.urgency,
        duplicateOfId: duplicate?.id,
        duplicateOverrideReason: duplicate === undefined ? undefined : REPEATED_LETTER_REASON,
        interopMessageId: written.record.id,
      },
    );
    const processed = await this.messages.markProcessed(scope.tx, written.record, { documentId: taken.documentId, at: now }, scope.tenant.membershipId);
    await announceIncoming(scope, {
      id: taken.letterId,
      documentId: taken.documentId,
      status: 'RECEIVED',
      version: 1,
      action: 'incoming_document.received',
      type: 'doc.incoming_received.v1',
      now,
      facts: { channel: 'LGSP', urgency: letter.urgency, duplicate_of_id: duplicate?.id ?? null, page_count: pages, interop_message_id: processed.id },
    });
    // The audit row names the parties by their codes and the message by its ids, never the words of the letter.
    await scope.audit({
      action: 'doc_interop_message.receive',
      resourceType: RESOURCE_TYPE,
      resourceId: processed.id,
      classification: CLASSIFICATION,
      diff: { sender_code: body.sender_code, signature_key_id: body.signature_key_id, envelope_sha256: body.envelope_sha256, incoming_document_id: taken.letterId, to_status: processed.status },
    });
    this.metrics.increment(INTEROP_METRIC, { direction: 'inbound', outcome: 'processed' });
    return { message: processed, incomingDocumentId: taken.letterId, documentId: taken.documentId };
  }

  /** BR-DOC-20: a letter marked with a level of state secret is not kept here, whatever door it comes through; the refusal is audited as DENIED (it survives the rollback) and nothing is created. */
  private async refuseStateSecret(scope: CommandScope, letter: { title: string; originalSymbol: string | undefined; senderName: string | undefined }): Promise<void> {
    for (const [field, value] of [
      ['title', letter.title],
      ['original_symbol', letter.originalSymbol],
      ['sender_name', letter.senderName],
    ] as const) {
      if (value !== undefined && stateSecretMarking(value)) {
        await this.audit.recordDenied(scope.tenant, { action: 'doc_interop_message.receive', resourceType: RESOURCE_TYPE, resourceId: NIL_RESOURCE_ID, diff: { reason: 'STATE_SECRET_NOT_SUPPORTED', field }, correlationId: scope.correlationId, requestId: scope.requestId });
        throw new DomainError('STATE_SECRET_NOT_SUPPORTED', 422, field);
      }
    }
  }
}
