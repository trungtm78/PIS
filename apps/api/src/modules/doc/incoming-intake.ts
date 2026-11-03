import type { Classification, DocIncomingStore, DocumentStore, TenantTx } from '@machvon/db';
import type { IncomingChannel, IncomingStatus, IncomingUrgency } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import type { DocumentFilePort } from './file-port';

export const PDF_MIME = 'application/pdf';

/** The PDF of a letter that arrived: the bytes, their digest and the number of their pages, all judged by the caller. */
export interface LetterFile {
  bytes: Buffer;
  checksum: string;
  pages: number;
}

export interface LetterIntake {
  title: string;
  docTypeCode: string;
  classification: Classification;
  file: LetterFile;
  channel: IncomingChannel;
  receivedAt: Date;
  receivedBy: string;
  originalSymbol: string | undefined;
  originalIssuedOn: string | undefined;
  senderName: string;
  urgency: IncomingUrgency;
  duplicateOfId: string | undefined;
  duplicateOverrideReason: string | undefined;
  /** The interoperability message the letter came with, when it came through the LGSP. */
  interopMessageId?: string | undefined;
}

export interface TakenLetter {
  letterId: string;
  documentId: string;
  versionId: string;
}

/**
 * Writes a letter that arrived (ST-DOC-011): the document, its file in the store the documents are served from (under a key that holds its digest, so a step that is repeated writes the same object), the version that is
 * clean by the verdict the caller already holds, and the incoming letter, RECEIVED. What the caller must have judged first is everything else: the secret marking, the duplicate, the type of document, the file.
 */
export async function takeInLetter(tx: TenantTx, tenantId: string, stores: { documents: DocumentStore; incoming: DocIncomingStore; stored: DocumentFilePort }, input: LetterIntake): Promise<TakenLetter> {
  const document = await stores.documents.insertDocument(tx, { docKind: 'INCOMING', docTypeCode: input.docTypeCode, title: input.title, classification: input.classification, createdBy: input.receivedBy });
  const objectKey = `tenants/${tenantId}/documents/${document.id}-${input.file.checksum}.pdf`;
  await stores.stored.put(objectKey, input.file.bytes, PDF_MIME);
  const version = await stores.documents.appendVersion(tx, {
    documentId: document.id,
    objectKey,
    checksum: input.file.checksum,
    mime: PDF_MIME,
    pageCount: input.file.pages,
    classification: input.classification,
    stage: 'RECEIVED_SCAN',
    byteLength: input.file.bytes.length,
    createdBy: input.receivedBy,
  });
  await stores.documents.setScanResult(tx, version.id, 'CLEAN');
  const letter = await stores.incoming.insert(tx, {
    documentId: document.id,
    channel: input.channel,
    receivedAt: input.receivedAt,
    receivedBy: input.receivedBy,
    originalSymbol: input.originalSymbol,
    originalIssuedOn: input.originalIssuedOn,
    senderName: input.senderName,
    urgency: input.urgency,
    duplicateOfId: input.duplicateOfId,
    duplicateOverrideReason: input.duplicateOverrideReason,
    interopMessageId: input.interopMessageId,
  });
  return { letterId: letter.id, documentId: document.id, versionId: version.id };
}

export const INCOMING_RESOURCE_TYPE = 'incoming_document';
const INCOMING_CLASSIFICATION = 'INTERNAL';

/** The audit row and the event of a step of an incoming letter: ids, the states and the facts of the step; never the words of the letter. */
export async function announceIncoming(
  scope: Pick<CommandScope, 'tenant' | 'audit' | 'emit'>,
  step: { id: string; documentId: string; status: IncomingStatus; version: number; action: string; type: string; now: Date; facts: Record<string, unknown>; reason?: string },
): Promise<void> {
  await scope.audit({
    action: step.action,
    resourceType: INCOMING_RESOURCE_TYPE,
    resourceId: step.id,
    classification: INCOMING_CLASSIFICATION,
    ...(step.reason === undefined ? {} : { reason: step.reason }),
    diff: { to_status: step.status, ...step.facts },
  });
  await scope.emit({
    aggregateType: INCOMING_RESOURCE_TYPE,
    aggregateId: step.id,
    aggregateVersion: step.version,
    type: step.type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, document_id: step.documentId, incoming_document_id: step.id, version: step.version, status: step.status, ...step.facts, actor_id: scope.tenant.membershipId, occurred_at: step.now.toISOString() },
    eventKey: `${INCOMING_RESOURCE_TYPE}:${step.id}:${step.version}`,
  });
}
