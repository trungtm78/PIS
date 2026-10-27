import { randomUUID } from 'node:crypto';
import { AuditWriter, MneReportIssueStore, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, MneReportHead, OutboxDelivery, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, MNE_SOURCE_MODULE, NOOP_METRICS, parseMneReportSourceRef } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { DOC_ISSUED_EVENT, DOC_RECALLED_EVENT, DOC_REJECTED_EVENT } from '../aud/report.consumer';

export const MNE_REPORT_CONSUMER = 'mne-report-issue';
/** What became of each event of DOC that names a report of MNE: `issued`, `rejected`, `recalled`, `duplicate`, `unknown`, `mismatch`, `stale`. */
export const MNE_REPORT_EVENT_METRIC = 'mne_report_event_total';
/** The seconds between the approval of a report and the answer of DOC that issued it (the last one). */
export const MNE_ISSUE_LATENCY_METRIC = 'mne_issue_latency_seconds';
/** The alert for a report DOC could not issue: someone mends the cause and asks again. */
export const MNE_REPORT_REJECTED_ALERT = 'MNE_REPORT_ISSUE_REJECTED';
/** The alert for an answer of DOC that does not fit the report it names (another hash, an unexpected order). */
export const MNE_REPORT_EXCEPTION_ALERT = 'MNE_REPORT_EXCEPTION';
/** The alert for a report DOC recalled after it was issued: a correction is needed. */
export const MNE_REPORT_RECALLED_ALERT = 'MNE_REPORT_RECALLED';

const REPORT_TYPE = 'mne_report';

export interface MneReportConsumerDeps {
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
 * The consumer of what DOC answers to a report of MNE (ST-MNE-003, MNE 3.1 F3, DOC 9, BR-DOC-17): doc.issued.v1 moves the report it names to ISSUED with the document, doc.rejected.v1 puts it back to APPROVED
 * with DOC's reason, and doc.recalled.v1 marks it recalled so that a correction is made. An answer is believed only when it names a report of the tenant by its reference and carries the hash that was frozen with it
 * (another hash is kept out and raised, never applied); an answer that cannot follow the report's state, or names none, changes nothing and is counted. One delivery changes the report once (the inbox row is in the
 * transaction of the work), and an answer DOC repeats finds the report already there and is a counted duplicate. The module never marks a report issued by itself.
 */
export class MneReportConsumer {
  private readonly reports = new MneReportIssueStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: MneReportConsumerDeps) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.audit = new AuditWriter(deps.database);
  }

  get name(): string {
    return MNE_REPORT_CONSUMER;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (![DOC_ISSUED_EVENT, DOC_REJECTED_EVENT, DOC_RECALLED_EVENT].includes(delivery.type) || delivery.schemaVersion !== 1) return 'ignored';
    if (delivery.payload.source_module !== MNE_SOURCE_MODULE) return 'ignored';
    const ref = parseMneReportSourceRef(delivery.payload.source_ref);
    if (ref === undefined) {
      this.count(delivery, 'unknown');
      return 'ignored';
    }
    return consumeOnce(this.deps.database, delivery, MNE_REPORT_CONSUMER, (tx) => this.apply(tx, delivery, ref), this.deps.security);
  }

  private count(delivery: Delivery, outcome: Outcome): void {
    this.metrics.increment(MNE_REPORT_EVENT_METRIC, { event: delivery.type, outcome });
  }

  private async apply(tx: TenantTx, delivery: Delivery, ref: { id: string; revision: number }): Promise<void> {
    const head = await this.reports.lockHead(tx, ref.id);
    if (head === undefined || head.revision !== ref.revision) {
      this.count(delivery, 'unknown');
      return;
    }
    // The hash the module asked for: DOC keeps it apart from the hash of the draft, which changes when the drafter completes the place of issue.
    const sha256 = (text(delivery.payload.source_payload_sha256) ?? text(delivery.payload.payload_sha256))?.toLowerCase();
    if (head.payloadSha256 === null || sha256 !== head.payloadSha256) {
      this.count(delivery, 'mismatch');
      await this.exception(tx, delivery, head, 'HASH_MISMATCH');
      return;
    }
    // An answer that names the request it answers is for that request: a refusal DOC repeats for an earlier attempt must not undo the one now in hand (the retry asks for the same payload under the same reference).
    const attempt = uuidOf(delivery.payload.source_event_id);
    if (attempt !== undefined && head.issueEventId !== null && attempt !== head.issueEventId) {
      this.count(delivery, 'stale');
      return;
    }
    if (delivery.type === DOC_ISSUED_EVENT) await this.issued(tx, delivery, head);
    else if (delivery.type === DOC_REJECTED_EVENT) await this.rejected(tx, delivery, head);
    else await this.recalled(tx, delivery, head);
  }

  private async issued(tx: TenantTx, delivery: Delivery, head: MneReportHead): Promise<void> {
    const documentId = uuidOf(delivery.payload.document_id);
    if (documentId === undefined) {
      this.count(delivery, 'mismatch');
      await this.exception(tx, delivery, head, 'DOCUMENT_MISSING');
      return;
    }
    if (head.docDocumentId === documentId) {
      this.count(delivery, 'duplicate');
      return;
    }
    const issuedAt = text(delivery.payload.occurred_at) ?? new Date().toISOString();
    const done = await this.attempt(tx, delivery, head, () => this.reports.markIssued(tx, head, { documentId, issuedAt }));
    if (done === undefined) return;
    this.count(delivery, 'issued');
    if (head.decidedAt !== null) {
      const seconds = Math.max(0, (Date.parse(issuedAt) - Date.parse(head.decidedAt)) / 1000);
      if (Number.isFinite(seconds)) this.metrics.gauge(MNE_ISSUE_LATENCY_METRIC, seconds);
    }
    await this.record(tx, delivery, head, 'issued', done.version, { document_id: documentId, issued_at: issuedAt });
  }

  private async rejected(tx: TenantTx, delivery: Delivery, head: MneReportHead): Promise<void> {
    const code = text(delivery.payload.reject_code);
    if (code === undefined) {
      this.count(delivery, 'mismatch');
      await this.exception(tx, delivery, head, 'REASON_MISSING');
      return;
    }
    if (head.status === 'APPROVED') {
      this.count(delivery, 'duplicate');
      return;
    }
    const done = await this.attempt(tx, delivery, head, () => this.reports.markIssueRejected(tx, head));
    if (done === undefined) return;
    this.count(delivery, 'rejected');
    await this.record(tx, delivery, head, 'issue_rejected', done.version, { reject_code: code });
    this.deps.security.alerts?.raise(MNE_REPORT_REJECTED_ALERT, { tenantId: delivery.tenantId, reportId: head.id, formCode: head.formCode, rejectCode: code });
  }

  private async recalled(tx: TenantTx, delivery: Delivery, head: MneReportHead): Promise<void> {
    if (head.recalledAt !== null) {
      this.count(delivery, 'duplicate');
      return;
    }
    // DOC can recall only what it issued, so a recall that comes before the answer of the issue is out of order, not wrong: the delivery fails and is tried again once the issue has been applied.
    if (head.status === 'ISSUING') throw new Error('doc.recalled.v1 arrived before doc.issued.v1: tried again later');
    const at = text(delivery.payload.occurred_at) ?? new Date().toISOString();
    const done = await this.attempt(tx, delivery, head, () => this.reports.markRecalled(tx, head, at));
    if (done === undefined) return;
    this.count(delivery, 'recalled');
    await this.record(tx, delivery, head, 'recalled', done.version, { document_id: head.docDocumentId, recalled_at: at });
    this.deps.security.alerts?.raise(MNE_REPORT_RECALLED_ALERT, { tenantId: delivery.tenantId, reportId: head.id, formCode: head.formCode });
  }

  /** Runs the change; an answer that does not fit the state of the report changes nothing and is raised (the edges of the table say which fit). */
  private async attempt<T>(tx: TenantTx, delivery: Delivery, head: MneReportHead, change: () => Promise<T>): Promise<T | undefined> {
    try {
      return await change();
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'REPORT_STATE_INVALID') throw error;
      this.count(delivery, 'stale');
      await this.exception(tx, delivery, head, 'STATE_UNEXPECTED');
      return undefined;
    }
  }

  private async record(tx: TenantTx, delivery: Delivery, head: MneReportHead, outcome: 'issued' | 'issue_rejected' | 'recalled', version: number, facts: Record<string, unknown>): Promise<void> {
    const correlationId = randomUUID();
    const common = { report_id: head.id, form_code: head.formCode, scope_unit_id: head.scopeUnitId, period_label: head.periodLabel, revision: head.revision, payload_sha256: head.payloadSha256, event_id: delivery.id };
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: `mne.report_${outcome}`,
      resourceType: REPORT_TYPE,
      resourceId: head.id,
      diff: { ...common, ...facts },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: REPORT_TYPE,
      aggregateId: head.id,
      aggregateVersion: version,
      type: `mne.report.${outcome}.v1`,
      schemaVersion: 1,
      payload: { tenant_id: delivery.tenantId, ...common, ...facts, occurred_at: new Date().toISOString(), source_module: MNE_SOURCE_MODULE },
      eventKey: `${REPORT_TYPE}:${head.id}:${outcome}:${version}`,
      correlationId,
      causationId: delivery.id,
    });
  }

  private async exception(tx: TenantTx, delivery: Delivery, head: MneReportHead, reason: string): Promise<void> {
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'mne.report_exception',
      resourceType: REPORT_TYPE,
      resourceId: head.id,
      diff: { report_id: head.id, event_type: delivery.type, event_id: delivery.id, status: head.status, reason },
      correlationId: randomUUID(),
      requestId: randomUUID(),
    });
    this.deps.security.alerts?.raise(MNE_REPORT_EXCEPTION_ALERT, { tenantId: delivery.tenantId, reportId: head.id, eventType: delivery.type, eventId: delivery.id, reason });
  }
}
