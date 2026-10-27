import { randomUUID } from 'node:crypto';
import { AudReportStore, AuditWriter, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, ReportHead, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, REPORT_SOURCE_MODULE, parseReportSourceRef } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';

export const AUD_REPORT_CONSUMER = 'aud-follow-up-report';
export const DOC_ISSUED_EVENT = 'doc.issued.v1';
export const DOC_REJECTED_EVENT = 'doc.rejected.v1';
export const DOC_RECALLED_EVENT = 'doc.recalled.v1';
/** What became of each event of DOC that names a report of AUD: `issued`, `rejected`, `recalled`, `duplicate`, `unknown`, `mismatch`, `stale`. */
export const AUD_REPORT_EVENT_METRIC = 'aud_report_event_total';
/** The alert for a report DOC could not issue: the coordinator drafts a new revision. */
export const AUD_REPORT_REJECTED_ALERT = 'AUD_REPORT_REJECTED';
/** The alert for an answer of DOC that does not fit the report it names (another hash, an unexpected order) or an issue approved by the person who asked for it. */
export const AUD_REPORT_EXCEPTION_ALERT = 'AUD_REPORT_EXCEPTION';

const REPORT_TYPE = 'audit_follow_up_report';
const CLASSIFICATION = 'CONFIDENTIAL';

export interface ReportConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
  metrics?: MetricsSink;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'schemaVersion' | 'payload'>;
type Outcome = 'issued' | 'rejected' | 'recalled' | 'duplicate' | 'unknown' | 'mismatch' | 'stale';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (value: unknown): string | undefined => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined);

/**
 * The consumer of what DOC answers to a report of AUD (ST-AUD-005, AUD 3.6 F6, DOC 9): `doc.issued.v1` moves the report it names to ISSUED with the document, `doc.rejected.v1` to REJECTED with
 * DOC's reason, and `doc.recalled.v1` to RECALLED. An answer is believed only when it names a report of the tenant by its reference and carries the hash that was frozen with it (a different hash is
 * kept out and raised, never applied); an answer that cannot follow the report's state, or names none, changes nothing and is counted. One delivery changes the report once (the inbox row is in the
 * transaction of the work), and an answer DOC repeats finds the report already there and is a counted duplicate.
 */
export class ReportConsumer {
  private readonly reports = new AudReportStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: ReportConsumerDeps) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.audit = new AuditWriter(deps.database);
  }

  get name(): string {
    return AUD_REPORT_CONSUMER;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (![DOC_ISSUED_EVENT, DOC_REJECTED_EVENT, DOC_RECALLED_EVENT].includes(delivery.type) || delivery.schemaVersion !== 1) return 'ignored';
    if (delivery.payload.source_module !== REPORT_SOURCE_MODULE) return 'ignored';
    const ref = parseReportSourceRef(delivery.payload.source_ref);
    if (ref === undefined) {
      this.count(delivery, 'unknown');
      return 'ignored';
    }
    return consumeOnce(this.deps.database, delivery, AUD_REPORT_CONSUMER, (tx) => this.apply(tx, delivery, ref), this.deps.security);
  }

  private count(delivery: Delivery, outcome: Outcome): void {
    this.metrics.increment(AUD_REPORT_EVENT_METRIC, { event: delivery.type, outcome });
  }

  private async apply(tx: TenantTx, delivery: Delivery, ref: { id: string; revision: number }): Promise<void> {
    const head = await this.reports.lockHead(tx, ref.id);
    if (head === undefined || head.revision !== ref.revision) {
      this.count(delivery, 'unknown');
      return;
    }
    // The hash the module asked for: DOC keeps it apart from the hash of the draft, which changes when the drafter completes the place of issue.
    const sha256 = (text(delivery.payload.source_payload_sha256) ?? text(delivery.payload.payload_sha256))?.toLowerCase();
    if (sha256 !== head.payloadSha256) {
      this.count(delivery, 'mismatch');
      await this.exception(tx, delivery, head, 'HASH_MISMATCH');
      return;
    }
    if (delivery.type === DOC_ISSUED_EVENT) await this.issued(tx, delivery, head);
    else if (delivery.type === DOC_REJECTED_EVENT) await this.rejected(tx, delivery, head);
    else await this.recalled(tx, delivery, head);
  }

  private async issued(tx: TenantTx, delivery: Delivery, head: ReportHead): Promise<void> {
    const documentId = uuidOf(delivery.payload.document_id);
    if (documentId === undefined) {
      this.count(delivery, 'mismatch');
      await this.exception(tx, delivery, head, 'DOCUMENT_MISSING');
      return;
    }
    if (head.status === 'ISSUED' && head.reportDocumentId === documentId) {
      this.count(delivery, 'duplicate');
      return;
    }
    const signer = uuidOf(delivery.payload.actor_id) ?? null;
    const issuedAt = text(delivery.payload.occurred_at) ?? new Date().toISOString();
    const done = await this.attempt(tx, delivery, head, () => this.reports.markIssued(tx, head, { documentId, approvedBy: signer, issuedAt }));
    if (done === undefined) return;
    this.count(delivery, 'issued');
    await this.record(tx, delivery, head, 'issued', done.version, { document_id: documentId, approved_by: done.approved ? signer : null, self_issued: !done.approved && signer === head.createdBy });
    // The person who asked for the report is the one who signed it: DOC may allow it, AUD keeps the two apart in the record and says so.
    if (!done.approved) await this.exception(tx, delivery, head, signer === head.createdBy ? 'SELF_ISSUED' : 'SIGNER_UNKNOWN');
  }

  private async rejected(tx: TenantTx, delivery: Delivery, head: ReportHead): Promise<void> {
    const code = text(delivery.payload.reject_code);
    if (code === undefined) {
      this.count(delivery, 'mismatch');
      await this.exception(tx, delivery, head, 'REASON_MISSING');
      return;
    }
    if (head.status === 'REJECTED') {
      this.count(delivery, 'duplicate');
      return;
    }
    const done = await this.attempt(tx, delivery, head, () => this.reports.markRejected(tx, head, code));
    if (done === undefined) return;
    this.count(delivery, 'rejected');
    await this.record(tx, delivery, head, 'rejected', done.version, { reject_code: code });
    this.deps.security.alerts?.raise(AUD_REPORT_REJECTED_ALERT, { tenantId: delivery.tenantId, reportId: head.id, engagementId: head.engagementId, rejectCode: code });
  }

  private async recalled(tx: TenantTx, delivery: Delivery, head: ReportHead): Promise<void> {
    if (head.status === 'RECALLED') {
      this.count(delivery, 'duplicate');
      return;
    }
    const done = await this.attempt(tx, delivery, head, () => this.reports.markRecalled(tx, head));
    if (done === undefined) return;
    this.count(delivery, 'recalled');
    await this.record(tx, delivery, head, 'recalled', done.version, { document_id: head.reportDocumentId });
  }

  /** Runs the change; an answer that does not fit the state of the report changes nothing and is raised (the kernel's edges say which fit). */
  private async attempt<T>(tx: TenantTx, delivery: Delivery, head: ReportHead, change: () => Promise<T>): Promise<T | undefined> {
    try {
      return await change();
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'REPORT_STATE_INVALID') throw error;
      this.count(delivery, 'stale');
      await this.exception(tx, delivery, head, 'STATE_UNEXPECTED');
      return undefined;
    }
  }

  private async record(tx: TenantTx, delivery: Delivery, head: ReportHead, outcome: 'issued' | 'rejected' | 'recalled', version: number, facts: Record<string, unknown>): Promise<void> {
    const correlationId = randomUUID();
    const common = { report_id: head.id, engagement_id: head.engagementId, revision: head.revision, payload_sha256: head.payloadSha256, event_id: delivery.id };
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: `aud.report_${outcome}`,
      resourceType: REPORT_TYPE,
      resourceId: head.id,
      classification: CLASSIFICATION,
      diff: { ...common, ...facts },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: REPORT_TYPE,
      aggregateId: head.id,
      aggregateVersion: version,
      type: `aud.report.${outcome}.v1`,
      schemaVersion: 1,
      payload: { tenant_id: delivery.tenantId, ...common, ...facts, occurred_at: new Date().toISOString(), source_module: REPORT_SOURCE_MODULE },
      eventKey: `${REPORT_TYPE}:${head.id}:${outcome}`,
      correlationId,
      causationId: delivery.id,
    });
  }

  private async exception(tx: TenantTx, delivery: Delivery, head: ReportHead, reason: string): Promise<void> {
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'aud.report_exception',
      resourceType: REPORT_TYPE,
      resourceId: head.id,
      classification: CLASSIFICATION,
      diff: { report_id: head.id, engagement_id: head.engagementId, event_type: delivery.type, event_id: delivery.id, status: head.status, reason },
      correlationId: randomUUID(),
      requestId: randomUUID(),
    });
    this.deps.security.alerts?.raise(AUD_REPORT_EXCEPTION_ALERT, { tenantId: delivery.tenantId, reportId: head.id, eventType: delivery.type, eventId: delivery.id, reason });
  }
}
