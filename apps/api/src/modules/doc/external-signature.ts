import { createHash } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import { PDFDocument } from 'pdf-lib';
import type { SignatureReport, SignatureResult } from '@machvon/kernel';
import { verifyPdfSignatures } from './pades-verifier';
import { describePdf } from './pdf-incremental';
import { dictionaryOf, textOf } from './pdf-objects';
import { NUMBER_FIELD_NAMES } from './pdf-revisions';
import type { TrustStoreProvider } from './trust-anchors';

const PDF_HEADER = '%PDF-';
const BOM_BYTE_ONE = 0xfe;
const BOM_BYTE_TWO = 0xff;

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The number of pages of a PDF; a file the reader cannot open is not a PDF for the purposes of DOC (UPLOAD_NOT_PDF). */
export async function pageCountOf(bytes: Uint8Array): Promise<number> {
  try {
    return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  } catch {
    throw new DomainError('UPLOAD_NOT_PDF', 422, 'file_object_key');
  }
}

/** UPLOAD_NOT_PDF: a file is a PDF by its first bytes, whatever its name or the type its sender declared. */
export function assertPdf(bytes: Uint8Array): void {
  if (Buffer.from(bytes.subarray(0, PDF_HEADER.length)).toString('latin1') !== PDF_HEADER) throw new DomainError('UPLOAD_NOT_PDF', 422, 'file_object_key');
}

export interface VerifiedSignatures {
  report: SignatureReport;
  signatures: SignatureResult[];
  /** The proven instants of the first and the last signature of the file, never later than `now`. */
  firstSignedAt: Date;
  lastSignedAt: Date;
}

const CHAIN_FINDINGS: readonly string[] = ['CHAIN_UNTRUSTED', 'CHAIN_INCOMPLETE'];

/**
 * The refusal that fits what the verifier found, strictest first: a signature that cannot be relied on (a broken digest, a tampered file, a certificate
 * that was expired or revoked at signing, changes after the signature) is SIGNATURE_INVALID; a chain that does not end at a trust anchor of the tenant is
 * CERTIFICATE_CHAIN_UNTRUSTED; a signing time nobody proved is SIGNING_TIME_UNPROVEN. The findings go in the answer so the screen can say which.
 */
function refusalOf(report: SignatureReport): DomainError | undefined {
  const findings = [...new Set(report.signatures.flatMap((signature) => signature.findings))];
  const extensions = { findings, signatures: report.signatures.map((signature) => ({ index: signature.index, role: signature.role, status: signature.status, findings: signature.findings })) };
  const hard = findings.filter((finding) => !CHAIN_FINDINGS.includes(finding) && finding !== 'SIGNING_TIME_UNPROVEN' && finding !== 'REVOCATION_UNKNOWN');
  if (report.signatures.some((signature) => signature.status === 'INVALID') && hard.length > 0) return new DomainError('SIGNATURE_INVALID', 422, 'file_object_key', { extensions });
  if (findings.some((finding) => CHAIN_FINDINGS.includes(finding))) return new DomainError('CERTIFICATE_CHAIN_UNTRUSTED', 422, 'file_object_key', { extensions });
  if (findings.includes('SIGNING_TIME_UNPROVEN')) return new DomainError('SIGNING_TIME_UNPROVEN', 422, 'file_object_key', { extensions });
  if (report.overall !== 'VALID') return new DomainError('SIGNATURE_INVALID', 422, 'file_object_key', { extensions });
  return undefined;
}

/**
 * Verifies the signatures of a file that was signed outside the system (DOC.md F5): every signature must be intact, its chain must end at a trust anchor of
 * the tenant, its signing time must be proven by a timestamp (a time the signer declared is not enough: STRICT) and nothing may have been changed after it.
 * Revocation is not asked (no OCSP or CRL adapter exists); the report then says NOT_CHECKED.
 */
export async function verifyExternalSignatures(bytes: Uint8Array, trust: TrustStoreProvider, tenantId: string, now: Date, minimum: number): Promise<VerifiedSignatures> {
  const report = await verifyPdfSignatures(bytes, await trust.forTenant(tenantId), now, { policy: 'STRICT' });
  const refusal = refusalOf(report);
  if (refusal !== undefined) throw refusal;
  const signatures = report.signatures.filter((signature) => signature.role !== 'DOCUMENT_TIMESTAMP');
  // Two signatures are two signers: the same certificate twice (a leader who also "seals") is one signature counted twice.
  const signers = new Set(signatures.map((signature) => signature.fingerprintSha256 ?? `index:${signature.index}`));
  if (signatures.length < minimum || signers.size < minimum || signatures.some((signature) => signature.incrementalChangesAllowed !== true || signature.signedAt === null)) {
    throw new DomainError('SIGNATURE_INVALID', 422, 'file_object_key', {
      extensions: { findings: [signatures.length < minimum || signers.size < minimum ? 'SIGNATURE_MISSING' : 'INCREMENTAL_CHANGES_NOT_ALLOWED'] },
    });
  }
  const times = signatures.map((signature) => Math.min((signature.signedAt as Date).getTime(), now.getTime()));
  return { report, signatures, firstSignedAt: new Date(Math.min(...times)), lastSignedAt: new Date(Math.max(...times)) };
}

function decodeFieldText(value: string): string {
  if (value.charCodeAt(0) === BOM_BYTE_ONE && value.charCodeAt(1) === BOM_BYTE_TWO) return Buffer.from(value, 'latin1').subarray(2).swap16().toString('utf16le');
  return value;
}

/** The values of the three number fields (`doc_number`, `doc_symbol`, `doc_date`) the file carries, when it has them and they are filled. */
export function readNumberFields(pdf: Uint8Array): Partial<Record<'doc_number' | 'doc_symbol' | 'doc_date', string>> {
  const found: Partial<Record<'doc_number' | 'doc_symbol' | 'doc_date', string>> = {};
  for (const value of describePdf(pdf).objects.values()) {
    const dictionary = dictionaryOf(value);
    const name = textOf(dictionary?.get('T'));
    const shown = textOf(dictionary?.get('V'));
    if (name !== null && shown !== null && NUMBER_FIELD_NAMES.includes(name)) found[name as 'doc_number'] = decodeFieldText(shown);
  }
  return found;
}
