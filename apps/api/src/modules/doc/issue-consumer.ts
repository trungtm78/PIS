import { AuditWriter, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { normaliseIssueRequest } from './issue-request.service';
import type { DocumentIssueService, IssueRequestInput } from './issue-request.service';

export const DOC_ISSUE_CONSUMER = 'doc-issue-request';
/** The events that ask DOC to issue a document: the common one, and the one the report module of monitoring already sends (DOC.md section 9). */
export const ISSUE_REQUEST_EVENTS: readonly string[] = ['doc.issue_requested.v1', 'mne.report.issue_requested.v1'];
const DEFAULT_SOURCE_MODULE: Readonly<Record<string, string>> = { 'mne.report.issue_requested.v1': 'MNE' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export interface DocumentIssueConsumerDeps {
  database: TenantDatabase;
  service: DocumentIssueService;
  security: ConsumeSecurity;
  metrics?: MetricsSink;
}

const text = (value: unknown, min: number, max: number): string | undefined => (typeof value === 'string' && value.trim().length >= min && value.trim().length <= max ? value.trim() : undefined);

/**
 * The request of a source module as an event payload: the members of `DocIssueRequest`, with the source module defaulted for the event of a module that
 * names it by its type. A payload that does not have the shape is not a request: it is left alone (counted), because a request with no event id or no hash
 * cannot even be recorded as refused.
 */
export function issueRequestOf(delivery: Pick<OutboxDelivery, 'type' | 'payload'>): IssueRequestInput | undefined {
  const payload = delivery.payload;
  const sourceModule = text(payload.source_module, 2, 10) ?? DEFAULT_SOURCE_MODULE[delivery.type];
  const sourceRef = text(payload.source_ref, 5, 200);
  const templateCode = text(payload.template_code, 3, 80);
  const payloadRef = text(payload.payload_ref, 5, 500);
  const hash = typeof payload.payload_sha256 === 'string' ? payload.payload_sha256.toLowerCase() : '';
  const eventId = typeof payload.event_id === 'string' ? payload.event_id : '';
  const asOf = typeof payload.as_of_date === 'string' ? payload.as_of_date : '';
  const recipients = payload.recipients;
  const hint = payload.signer_hint;
  if (sourceModule === undefined || sourceRef === undefined || templateCode === undefined || payloadRef === undefined) return undefined;
  if (!SHA256.test(hash) || !UUID.test(eventId) || !DATE.test(asOf)) return undefined;
  if (recipients !== undefined && (!Array.isArray(recipients) || recipients.length > 500 || recipients.some((item) => typeof item !== 'object' || item === null))) return undefined;
  if (hint !== undefined && (typeof hint !== 'object' || hint === null || Array.isArray(hint))) return undefined;
  try {
    return normaliseIssueRequest({
      source_module: sourceModule,
      source_ref: sourceRef,
      template_code: templateCode,
      payload_ref: payloadRef,
      payload_sha256: hash,
      event_id: eventId,
      as_of_date: asOf,
      ...(recipients === undefined ? {} : { recipients: recipients as object[] }),
      ...(hint === undefined ? {} : { signer_hint: hint as object }),
    });
  } catch {
    return undefined;
  }
}

/**
 * The consumer of the issue-request events (DOC.md section 9): once per delivery, with the inbox row of `consumeOnce` in the transaction of the work, so a
 * redelivery is a counted duplicate; and once per `(source module, event id)`, so the same event that comes through two deliveries makes one request. A
 * second event for content that is still open makes no second document. The request is judged exactly as the REST port judges it.
 */
export class DocumentIssueConsumer {
  private readonly metrics: MetricsSink;
  private readonly audit: AuditWriter;

  constructor(private readonly deps: DocumentIssueConsumerDeps) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.audit = new AuditWriter(deps.database);
  }

  get name(): string {
    return DOC_ISSUE_CONSUMER;
  }

  async handle(delivery: OutboxDelivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (!ISSUE_REQUEST_EVENTS.includes(delivery.type) || delivery.schemaVersion !== 1) return 'ignored';
    const input = issueRequestOf(delivery);
    if (input === undefined) {
      this.metrics.increment('doc_issue_event_invalid_total', { event_type: delivery.type });
      return 'ignored';
    }
    return consumeOnce(
      this.deps.database,
      delivery,
      DOC_ISSUE_CONSUMER,
      async (tx) => {
        const outcome = await this.deps.service.requestIssue(tx, this.contextOf(tx, delivery), input);
        this.metrics.increment('doc_issue_event_total', { outcome: outcome.kind.toLowerCase() });
      },
      this.deps.security,
    );
  }

  private contextOf(tx: Parameters<DocumentIssueService['requestIssue']>[0], delivery: OutboxDelivery): Parameters<DocumentIssueService['requestIssue']>[1] {
    return {
      tenantId: delivery.tenantId,
      actor: WORKER_MEMBERSHIP_ID,
      audit: (entry) => this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, { ...entry, correlationId: delivery.correlationId, requestId: delivery.id }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId: delivery.correlationId }),
    };
  }
}
