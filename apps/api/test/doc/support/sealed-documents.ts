import { createHash } from 'node:crypto';
import { LEADER, TENANT_A, memberId, unitId } from '../doc-app';
import type { FlowWorld } from './flow-world';
import { payloadOf } from './flow-world';

export const INTERNAL_RECIPIENT = { kind: 'INTERNAL_UNIT', name: 'Planning Division', unit_id: unitId(2) } as const;
export const EXTERNAL_RECIPIENT = { kind: 'EXTERNAL_AGENCY', name: 'Department of Finance', code: 'SKHDT' } as const;
export const THIRD_RECIPIENT = { kind: 'EXTERNAL_AGENCY', name: 'State Treasury', code: 'KBNN' } as const;

export interface Sealed {
  id: string;
  documentId: string;
  /** The version of the outgoing document after the seal. */
  version: number;
  /** The sealed file version. */
  versionId: string;
  objectKey: string;
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A document taken over the HTTP routes from a draft to SEALED: reviewed, signed by the leader, numbered and sealed by the organisation. */
export async function sealedDocument(flow: FlowWorld, overrides: Record<string, unknown> = {}): Promise<Sealed> {
  const made = await flow.create({
    doc_type_code: 'QD',
    template_code: 'QD-DEFAULT',
    title: 'Decision to be issued',
    drafting_unit_id: unitId(2),
    payload: payloadOf(),
    recipients: [INTERNAL_RECIPIENT, EXTERNAL_RECIPIENT],
    signer_user_id: memberId(LEADER),
    ...overrides,
  });
  if (made.status !== 200) throw new Error(`the draft was refused: ${JSON.stringify(made.json)}`);
  const id = made.json.resource_id as string;
  const documentId = made.json.document_id as string;
  const submitted = await flow.submit(id, 1);
  if (submitted.status !== 200) throw new Error(`the review request was refused: ${JSON.stringify(submitted.json)}`);
  const approved = await flow.approve(id, 2);
  if (approved.status !== 200) throw new Error(`the review was refused: ${JSON.stringify(approved.json)}`);
  const version = await flow.sealFrom(id, approved.json.resource_version as number, await flow.openRegister());
  const [file] = await flow.app.harness.owner<{ id: string; object_key: string }>(TENANT_A, [
    ["select v.id, v.object_key from machvon.document_version v where v.document_id = $1 and v.stage = 'ORG_SEALED'", [documentId]],
  ]);
  if (file === undefined) throw new Error('the sealed file is missing');
  return { id, documentId, version, versionId: file.id, objectKey: file.object_key };
}

let replacements = 0;

/**
 * Points the sealed version at another stored file (objects are written once, so the new bytes go under a new key). The checksum of the version follows the
 * bytes unless `keepChecksum` is set, which is what a file swapped in storage behind the back of the database looks like.
 */
export async function replaceSealedFile(flow: FlowWorld, sealed: Sealed, bytes: Buffer, options: { keepChecksum?: boolean } = {}): Promise<void> {
  replacements += 1;
  const key = `${sealed.objectKey}.replacement-${replacements}`;
  await flow.app.files.put(key, bytes, 'application/pdf');
  await flow.app.harness.owner(TENANT_A, [
    options.keepChecksum === true
      ? ['update machvon.document_version set object_key = $2 where id = $1', [sealed.versionId, key]]
      : ['update machvon.document_version set object_key = $2, checksum = $3, byte_length = $4 where id = $1', [sealed.versionId, key, sha256(bytes), bytes.length]],
  ]);
  sealed.objectKey = key;
}

export async function sealedBytes(flow: FlowWorld, sealed: Sealed): Promise<Buffer> {
  const file = await flow.app.files.get(sealed.objectKey);
  if (file === undefined) throw new Error('the sealed file is missing');
  return Buffer.from(file.bytes);
}
