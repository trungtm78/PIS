import { createHash, randomUUID } from 'node:crypto';
import { DocInteropStore, DocumentDistributionStore, IntegrationConnectorStore, OutgoingDocumentStore, WORKER_MEMBERSHIP_ID, enqueueOutbox } from '@machvon/db';
import type { AuditWriter, ConnectorRow, DistributionRecord, InteropRecord, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, assertEgressAllowed, planFailure } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { DistributionSettlement } from './distribution-settlement';
import type { SettlementScope } from './distribution-settlement';
import { INTEROP_METRIC, LGSP_CONNECTOR_MODE, adapterStatusOf, lgspSettingsOf } from './interop.service';
import type { InteropTransportPort } from './interop-port';
import type { FileService } from '../files';

export const INTEROP_DEAD_GAUGE = 'doc_interop_dead_gauge';
const RESOURCE_TYPE = 'doc_interop_message';
const CLASSIFICATION = 'INTERNAL';
/** The most messages one pass sends, and the most it asks the gateway about. */
export const INTEROP_BATCH = 50;
/** The reasons a distribution carries when its message died or was refused without a code of its own. */
const DEAD_REASON = 'INTEROP_DEAD';
const REFUSED_REASON = 'INTEROP_REJECTED';

export interface InteropPassResult {
  sent: number;
  failed: number;
  dead: number;
  acknowledged: number;
  rejected: number;
}

export interface InteropSenderDeps {
  files: Pick<FileService, 'readStored'>;
  transport: InteropTransportPort;
  audit: AuditWriter;
  metrics?: MetricsSink | undefined;
}

/** What a failed attempt leaves in `error_code`: the code of the refusal when the adapter or a rule named one, otherwise a general one. */
function failureCode(error: unknown): string {
  return error instanceof DomainError && /^[A-Z][A-Z_]{2,59}$/.test(error.code) ? error.code : 'CHANNEL_ERROR';
}

/**
 * The job that sends (ST-DOC-021, DOC.md F13, `DocInteropSendWorkflow`): for the tenant it asks about the messages the gateway took in an earlier pass and whose receiving agency has not answered, then takes the messages that
 * are due, oldest first, and hands each to the gateway of the LGSP through the connector of the tenant (a message just handed over is asked about in the next pass). Each message is handled in a transaction of its own, so one that fails changes nothing of the others. A message that cannot be sent
 * (no active connector, an address off the allowlist, the gateway down) fails with its reason and waits twice as long as the time before (one minute, two, four, up to six hours); the twentieth failure ends it as DEAD, the gauge
 * `doc_interop_dead_gauge` goes above zero and the alert of the integration team fires. Nothing but an address on the allowlist of the tenant is ever called. The distribution of a message follows it: SENT when the gateway
 * took it, ACKNOWLEDGED when the receiving agency confirmed, FAILED when it died or was refused, and the outgoing document is settled with it.
 *
 * The call to the gateway runs inside the transaction that records its outcome; if that transaction fails after the call, the next pass sends the same message again, which the gateway drops by its id.
 */
export class DocInteropSender {
  private readonly messages = new DocInteropStore();
  private readonly connectors = new IntegrationConnectorStore();
  private readonly distributions = new DocumentDistributionStore();
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly settlement = new DistributionSettlement();
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: InteropSenderDeps) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
  }

  async runPass(database: TenantDatabase, ctx: TenantContext, now: Date): Promise<InteropPassResult> {
    const result: InteropPassResult = { sent: 0, failed: 0, dead: 0, acknowledged: 0, rejected: 0 };
    const waiting = await database.withTenant(ctx, (tx) => this.messages.awaitingReceipt(tx, INTEROP_BATCH));
    for (const candidate of waiting) {
      const ended = await database.withTenant(ctx, (tx) => this.ask(tx, ctx, candidate.id, now));
      if (ended === 'ACKED') result.acknowledged += 1;
      else if (ended === 'REJECTED') result.rejected += 1;
    }
    const due = await database.withTenant(ctx, (tx) => this.messages.dueForAttempt(tx, now, INTEROP_BATCH));
    for (const candidate of due) {
      const ended = await database.withTenant(ctx, (tx) => this.attempt(tx, ctx, candidate.id, now));
      if (ended === 'SENT') result.sent += 1;
      else if (ended === 'FAILED') result.failed += 1;
      else if (ended === 'DEAD') result.dead += 1;
    }
    // The number of dead messages, as it stands after the pass: above zero fires the alert, zero resolves it.
    const dead = await database.withTenant(ctx, (tx) => this.messages.countByStatus(tx, ['DEAD']));
    this.metrics.gauge(INTEROP_DEAD_GAUGE, dead, { tenant_id: ctx.tenantId });
    return result;
  }

  /** One attempt at one message, in the transaction of the caller: what became of it, or nothing when another pass has taken it. */
  private async attempt(tx: TenantTx, ctx: TenantContext, id: string, now: Date): Promise<'SENT' | 'FAILED' | 'DEAD' | undefined> {
    let message = await this.messages.lock(tx, id);
    // The pass chose it as due; it is still to be sent unless another pass or a person took it meanwhile.
    if (message === undefined || (message.status !== 'QUEUED' && message.status !== 'FAILED')) return undefined;
    if (message.status === 'FAILED') message = await this.messages.requeue(tx, message, WORKER_MEMBERSHIP_ID);
    const connector = await this.connectors.primaryOfMode(tx, LGSP_CONNECTOR_MODE);
    const adapterStatus = adapterStatusOf(connector);
    const outcome = await this.callGateway(ctx, message, connector);
    if (outcome.kind === 'SENT') {
      message = await this.messages.markSent(tx, message, { externalMessageId: outcome.externalMessageId, adapterStatus }, WORKER_MEMBERSHIP_ID);
      this.metrics.increment(INTEROP_METRIC, { direction: 'outbound', outcome: 'sent' });
    } else {
      message = await this.messages.markFailed(tx, message, planFailure(message.attempts, now), { errorCode: outcome.errorCode, adapterStatus }, WORKER_MEMBERSHIP_ID);
      this.metrics.increment(INTEROP_METRIC, { direction: 'outbound', outcome: message.status === 'DEAD' ? 'dead' : 'failed' });
    }
    await this.settle(tx, ctx, message, now);
    return message.status === 'SENT' ? 'SENT' : message.status === 'DEAD' ? 'DEAD' : 'FAILED';
  }

  /** What the receiving agency did with a message the gateway took, in the transaction of the caller. A gateway that cannot answer leaves the message as it is: it is asked again in the next pass. */
  private async ask(tx: TenantTx, ctx: TenantContext, id: string, now: Date): Promise<'ACKED' | 'REJECTED' | undefined> {
    const message = await this.messages.lock(tx, id);
    if (message === undefined || message.status !== 'SENT' || message.externalMessageId === null) return undefined;
    const connector = await this.connectors.primaryOfMode(tx, LGSP_CONNECTOR_MODE);
    let receipt;
    try {
      const endpoint = this.endpointOf(connector);
      receipt = await this.deps.transport.receipt({ endpoint, externalMessageId: message.externalMessageId });
    } catch {
      this.metrics.increment(INTEROP_METRIC, { direction: 'outbound', outcome: 'receipt_unavailable' });
      return undefined;
    }
    if (receipt.outcome === 'PENDING') return undefined;
    const ended =
      receipt.outcome === 'ACKED'
        ? await this.messages.markAcknowledged(tx, message, now, WORKER_MEMBERSHIP_ID)
        : await this.messages.markRejected(tx, message, { errorCode: /^[A-Z][A-Z_]{2,59}$/.test(receipt.reasonCode) ? receipt.reasonCode : REFUSED_REASON, at: now }, WORKER_MEMBERSHIP_ID);
    this.metrics.increment(INTEROP_METRIC, { direction: 'outbound', outcome: ended.status === 'ACKED' ? 'acked' : 'rejected' });
    await this.settle(tx, ctx, ended, now);
    return ended.status === 'ACKED' ? 'ACKED' : 'REJECTED';
  }

  /** The address of the gateway when the tenant runs one and the system may call it; any other case is a refusal that names its reason. */
  private endpointOf(connector: ConnectorRow | undefined): string {
    if (connector === undefined || connector.status !== 'Active') throw new DomainError('INTEROP_ADAPTER_NOT_ACTIVE', 409);
    const settings = lgspSettingsOf(connector);
    return assertEgressAllowed(settings.endpoint, settings.egressAllowlist).endpoint;
  }

  private async callGateway(ctx: TenantContext, message: InteropRecord, connector: ConnectorRow | undefined): Promise<{ kind: 'SENT'; externalMessageId: string } | { kind: 'FAILED'; errorCode: string }> {
    try {
      const endpoint = this.endpointOf(connector);
      const stored = await this.deps.files.readStored(ctx, message.envelopeObjectKey);
      // The envelope is the bytes whose digest was written with the message; bytes that changed since are not sent.
      if (createHash('sha256').update(stored.bytes).digest('hex') !== message.envelopeSha256) throw new DomainError('ENVELOPE_INVALID', 422, 'envelope_sha256');
      const sent = await this.deps.transport.send({
        endpoint,
        messageId: message.id,
        senderCode: lgspSettingsOf(connector).agencyCode,
        receiverCode: message.receiverCode as string,
        envelope: stored.bytes,
        envelopeSha256: message.envelopeSha256,
      });
      return { kind: 'SENT', externalMessageId: sent.externalMessageId };
    } catch (error) {
      return { kind: 'FAILED', errorCode: failureCode(error) };
    }
  }

  /** The audit row of what happened to the message, the events of its end, and the distribution that follows it. */
  private async settle(tx: TenantTx, ctx: TenantContext, message: InteropRecord, now: Date): Promise<void> {
    const correlationId = randomUUID();
    const worker: TenantContext = { ...ctx, membershipId: WORKER_MEMBERSHIP_ID };
    await this.deps.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: `doc_interop_message.${message.status.toLowerCase()}`,
      resourceType: RESOURCE_TYPE,
      resourceId: message.id,
      classification: CLASSIFICATION,
      diff: { to_status: message.status, attempts: message.attempts, error_code: message.errorCode, adapter_status: message.adapterStatus, outgoing_document_id: message.outgoingDocumentId, distribution_id: message.distributionId },
      correlationId,
      requestId: correlationId,
    });
    if (message.status === 'ACKED' || message.status === 'REJECTED' || message.status === 'DEAD') {
      await enqueueOutbox(tx, {
        aggregateType: RESOURCE_TYPE,
        aggregateId: message.id,
        aggregateVersion: message.version,
        type: `doc.interop_${message.status.toLowerCase()}.v1`,
        schemaVersion: 1,
        payload: {
          tenant_id: ctx.tenantId,
          interop_message_id: message.id,
          outgoing_document_id: message.outgoingDocumentId,
          distribution_id: message.distributionId,
          status: message.status,
          attempts: message.attempts,
          error_code: message.errorCode,
          version: message.version,
          actor_id: WORKER_MEMBERSHIP_ID,
          occurred_at: now.toISOString(),
        },
        eventKey: `${RESOURCE_TYPE}:${message.id}:${message.version}`,
        correlationId,
      });
    }
    await this.follow({ tx, tenant: worker, emit: (event) => enqueueOutbox(tx, { ...event, correlationId }) }, message, now);
  }

  /**
   * The distribution of a message follows what became of it, and the document is settled with its rows. A row that already ended its own way (a receipt a clerk recorded by hand, a recall that called it off) is left as it
   * is: the message is the record of what the gateway did, the row the record of what the document's recipient got.
   */
  private async follow(scope: SettlementScope, message: InteropRecord, now: Date): Promise<void> {
    if (message.distributionId === null) return;
    const known = await this.distributions.find(scope.tx, message.distributionId);
    if (known === undefined) return;
    // The document first and the row after it: the order every command keeps.
    const document = await this.outgoing.lock(scope.tx, known.outgoingDocumentId);
    const row = await this.distributions.find(scope.tx, known.id, { lock: true });
    if (document === undefined || row === undefined) return;
    const actor = scope.tenant.membershipId;
    if (message.status === 'SENT' && (row.status === 'PENDING' || row.status === 'FAILED') && message.externalMessageId !== null) {
      await this.distributions.recordInterop(scope.tx, row.id, { kind: 'SENT', at: now, externalRef: message.externalMessageId, attempts: message.attempts }, actor);
    } else if (message.status === 'ACKED' && row.status === 'SENT') {
      await this.distributions.acknowledge(scope.tx, row.id, row.version, { acknowledgedAt: now, externalRef: message.externalMessageId }, actor);
    } else if ((message.status === 'DEAD' || message.status === 'REJECTED') && failable(row)) {
      await this.distributions.recordInterop(scope.tx, row.id, { kind: 'FAILED', errorCode: message.errorCode ?? (message.status === 'DEAD' ? DEAD_REASON : REFUSED_REASON), attempts: message.attempts }, actor);
    }
    await this.settlement.settle(scope, document, now);
  }
}

const failable = (row: DistributionRecord): boolean => row.status === 'PENDING' || row.status === 'SENT' || row.status === 'FAILED';
