import { OutgoingDocumentStore, SignatureStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { NOOP_ALERTS, NOOP_METRICS } from '@machvon/kernel';
import type { AlertSink, MetricsSink } from '@machvon/kernel';
import type { DocumentFilePort } from './file-port';
import { verifyPdfSignatures } from './pades-verifier';
import type { RevocationPort } from './pades-verifier';
import type { TrustStoreProvider } from './trust-anchors';

/** Raised when a certificate that signed a document in force is found revoked after the document was issued. */
export const ISSUED_SIGNATURE_REVOKED_ALERT = 'DOC_ISSUED_SIGNATURE_REVOKED';
const PAGE = 100;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RevocationRecheckDeps {
  files: DocumentFilePort;
  trust: TrustStoreProvider;
  revocation: RevocationPort;
  store?: OutgoingDocumentStore;
  signatures?: SignatureStore;
  metrics?: MetricsSink;
  alerts?: AlertSink;
  /** A verification younger than this, with every revocation status good, is not asked again; default one day. */
  maxAgeMs?: number;
}

export interface RevocationRecheckResult {
  checked: number;
  good: number;
  /** The responder could not answer (or no adapter is bound): the document stays as it is and the next run asks again. */
  unknown: number;
  revoked: string[];
  /** Files that are missing from storage or whose signatures no longer verify for another reason. */
  failed: string[];
}

/**
 * `doc.revocation-recheck` (DOC.md F7, BR-DOC-14 f): a document is issued after its certificates were asked about revocation, but a certificate can be
 * revoked the day after. For the tenant of the transaction the job asks again about the sealed file of every document in force whose revocation was not
 * good in its latest verification, or whose latest verification is older than a day, and stores the new verification next to the old ones (the report
 * of DOC-07 shows the latest). A revoked certificate raises `DOC_ISSUED_SIGNATURE_REVOKED` for the people who own the document; an answer that could
 * not be had changes nothing and is counted, never read as good. Run by the platform scheduler once per tenant.
 */
export async function recheckIssuedRevocation(tx: TenantTx, tenantId: string, now: Date, deps: RevocationRecheckDeps): Promise<RevocationRecheckResult> {
  const store = deps.store ?? new OutgoingDocumentStore();
  const signatures = deps.signatures ?? new SignatureStore();
  const metrics = deps.metrics ?? NOOP_METRICS;
  const alerts = deps.alerts ?? NOOP_ALERTS;
  const checkedBefore = new Date(now.getTime() - (deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
  const result: RevocationRecheckResult = { checked: 0, good: 0, unknown: 0, revoked: [], failed: [] };
  const trust = await deps.trust.forTenant(tenantId);
  for (let after: string | undefined; ; ) {
    const due = await store.issuedFilesDueForRevocationCheck(tx, { checkedBefore, afterVersionId: after, limit: PAGE });
    for (const item of due) {
      const file = await deps.files.get(item.objectKey);
      if (file === undefined) {
        result.failed.push(item.outgoingDocumentId);
        metrics.increment('doc_revocation_recheck_total', { outcome: 'missing' });
        continue;
      }
      const report = await verifyPdfSignatures(file.bytes, trust, now, { policy: 'STRICT', revocation: deps.revocation });
      await signatures.record(tx, { versionId: item.versionId, signatures: report.signatures, verifiedAt: report.verifiedAt, verifierVersion: report.verifierVersion, reportObjectKey: null });
      result.checked += 1;
      const states = report.signatures.map((signature) => signature.revocationStatus);
      const outcome = states.includes('REVOKED') ? 'revoked' : states.includes('UNKNOWN') ? 'unknown' : report.overall === 'VALID' ? 'good' : 'failed';
      metrics.increment('doc_revocation_recheck_total', { outcome });
      if (outcome === 'good') result.good += 1;
      else if (outcome === 'unknown') result.unknown += 1;
      else if (outcome === 'revoked') {
        result.revoked.push(item.outgoingDocumentId);
        alerts.raise(ISSUED_SIGNATURE_REVOKED_ALERT, { outgoing_document_id: item.outgoingDocumentId, version_id: item.versionId });
      } else result.failed.push(item.outgoingDocumentId);
    }
    const last = due[due.length - 1];
    if (due.length < PAGE || last === undefined) return result;
    after = last.versionId;
  }
}
