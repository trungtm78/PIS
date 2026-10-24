import { DomainError } from '@machvon/kernel';
import type { SignatureReport, SignatureResult, SignatureStatus } from '@machvon/kernel';
import { sha256Hex } from './external-signature';
import { verifyPdfSignatures } from './pades-verifier';
import type { RevocationPort } from './pades-verifier';
import type { TrustStoreProvider } from './trust-anchors';

const FIELD = 'version';
const INCREMENTAL = 'INCREMENTAL_CHANGES_NOT_ALLOWED';
const CHAIN_FINDINGS: readonly string[] = ['CHAIN_UNTRUSTED', 'CHAIN_INCOMPLETE'];
const TIME_FINDING = 'SIGNING_TIME_UNPROVEN';
const REVOCATION_FINDING = 'REVOCATION_UNKNOWN';
const NAMED_FINDINGS: readonly string[] = [INCREMENTAL, ...CHAIN_FINDINGS, TIME_FINDING, REVOCATION_FINDING];

/** The signatures a sealed document must carry, each exactly once: the leader's and the organisation's. */
const REQUIRED_ROLES = ['LEADER', 'ORGANIZATION'] as const;

export interface IssueVerification {
  report: SignatureReport;
  /** The two signatures of the document, not the document timestamps that a long-term validation appends later. */
  signatures: SignatureResult[];
}

export type IssueGateOutcome = { ok: true; verification: IssueVerification } | { ok: false; error: DomainError; overall: SignatureStatus | 'UNREADABLE' };

function extensionsOf(signatures: readonly SignatureResult[]): { findings: string[]; signatures: Array<{ index: number; role: string; status: string; revocation: string; findings: string[] }> } {
  return {
    findings: [...new Set(signatures.flatMap((signature) => signature.findings))],
    signatures: signatures.map((signature) => ({ index: signature.index, role: signature.role, status: signature.status, revocation: signature.revocationStatus, findings: [...signature.findings] })),
  };
}

function refuse(code: string, status: number, signatures: readonly SignatureResult[], overall: SignatureStatus | 'UNREADABLE', extra: Record<string, unknown> = {}): IssueGateOutcome {
  return { ok: false, overall, error: new DomainError(code, status, FIELD, { extensions: { ...extensionsOf(signatures), ...extra } }) };
}

/**
 * The gate in front of `issueOutgoingDocument` (DOC.md F7): the stored file is the one that was sealed, and both signatures are verified again from the
 * bytes, now, against the trust anchors of the tenant: integrity, the chain to a trust anchor, the proof of the signing time, the revocation status and
 * the revisions appended after each signature. Nothing is taken from the verification that ran when the document was signed or sealed.
 *
 * It is honest about what it could not establish. A revocation the port could not answer (no OCSP or CRL adapter is bound, or the responder did not
 * answer) is not "good": the document stays SEALED and the answer is 503 PROVIDER_UNAVAILABLE with the reason REVOCATION_UNAVAILABLE, never a signature
 * failure and never a silent pass. The refusals, strictest first: a signature that cannot be relied on is SIGNATURE_VERIFICATION_FAILED, changes after a
 * signature that the signature does not allow INCREMENTAL_CHANGES_NOT_ALLOWED, a chain that does not end at a trust anchor CERTIFICATE_CHAIN_UNTRUSTED, a
 * signing time that nobody proved SIGNING_TIME_UNPROVEN.
 */
export async function verifyForIssue(input: {
  bytes: Uint8Array;
  /** SHA-256 of the file as it was sealed (the checksum of the stored version). */
  expectedSha256: string;
  trust: TrustStoreProvider;
  revocation: RevocationPort;
  tenantId: string;
  now: Date;
}): Promise<IssueGateOutcome> {
  if (sha256Hex(input.bytes) !== input.expectedSha256) return refuse('SIGNATURE_VERIFICATION_FAILED', 422, [], 'INVALID', { findings: ['FILE_HASH_MISMATCH'] });
  const report = await verifyPdfSignatures(input.bytes, await input.trust.forTenant(input.tenantId), input.now, { policy: 'STRICT', revocation: input.revocation });
  const signatures = report.signatures.filter((signature) => signature.role !== 'DOCUMENT_TIMESTAMP');
  const findings = new Set<string>(signatures.flatMap((signature) => signature.findings));

  if ([...findings].some((finding) => !NAMED_FINDINGS.includes(finding))) return refuse('SIGNATURE_VERIFICATION_FAILED', 422, signatures, report.overall);
  if (findings.has(INCREMENTAL) || signatures.some((signature) => signature.incrementalChangesAllowed === false)) return refuse(INCREMENTAL, 422, signatures, report.overall);
  if (CHAIN_FINDINGS.some((finding) => findings.has(finding))) return refuse('CERTIFICATE_CHAIN_UNTRUSTED', 422, signatures, report.overall);
  if (findings.has(TIME_FINDING)) return refuse('SIGNING_TIME_UNPROVEN', 422, signatures, report.overall);

  const roles = signatures.map((signature) => signature.role);
  const complete = REQUIRED_ROLES.every((role) => roles.filter((candidate) => candidate === role).length === 1) && signatures.length === REQUIRED_ROLES.length;
  const [first, second] = signatures;
  const last = signatures.find((signature) => signature.role === 'ORGANIZATION');
  if (!complete || first === undefined || second === undefined || first.fingerprintSha256 === null || first.fingerprintSha256 === second.fingerprintSha256) {
    return refuse('SIGNATURE_VERIFICATION_FAILED', 422, signatures, report.overall, { findings: ['SIGNATURE_MISSING'] });
  }
  if (signatures.some((signature) => signature.incrementalChangesAllowed !== true)) return refuse(INCREMENTAL, 422, signatures, report.overall);
  if (last === undefined || last.coversEndOffset !== input.bytes.length) return refuse('SIGNATURE_VERIFICATION_FAILED', 422, signatures, report.overall, { findings: ['SEAL_DOES_NOT_COVER_FILE'] });

  if (findings.has(REVOCATION_FINDING) || signatures.some((signature) => signature.revocationStatus !== 'GOOD')) {
    return refuse('PROVIDER_UNAVAILABLE', 503, signatures, report.overall, { reason: 'REVOCATION_UNAVAILABLE' });
  }
  if (report.overall !== 'VALID') return refuse('SIGNATURE_VERIFICATION_FAILED', 422, signatures, report.overall);
  return { ok: true, verification: { report, signatures } };
}
