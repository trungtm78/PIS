import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { NumberRegisterStore, OUTGOING_SCOPE_COLUMNS, OutgoingDocumentStore, OutgoingDraftStore, OutgoingRecallStore, loadAccessIn, scopePredicate } from '@machvon/db';
import type { OutgoingDocumentRecord } from '@machvon/db';
import { DomainError, NOOP_METRICS, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import type { SigningProvider } from './signing-port';
import type { SigningPort } from './signing-port';
import { DOC_CLOCK, DOC_METRICS, DOC_SIGNING_PORT } from './tokens';
import { mayActOnUnit } from './unit-scope';

const OUTGOING_TYPE = 'outgoing_document';
const MIN_REASON_CHARS = 10;
const VOID_REJECT_CODE = 'NUMBER_VOIDED';

/** The reason as it is kept: NFC and trimmed, and still the ten characters the contract asks for (blanks pass the length of the schema and say nothing). */
function reasonOf(raw: string): string {
  const reason = raw.normalize('NFC').trim();
  if (reason.length < MIN_REASON_CHARS) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return reason;
}

/**
 * Recalling an issued document and voiding the number of a document that cannot be sealed (ST-DOC-012, DOC.md F6 and F9, BR-DOC-03, BR-DOC-21). A recall
 * makes the document no longer the one in force (effect RECALLED), tells its recipients, and tells the source module through `doc.recalled.v1` with the
 * reference and the hash it asked with; its number stays in the ledger as taken. Voiding is for a document numbered or sealed whose seal cannot be completed:
 * the number is VOIDED with a reason and a second person who is not the one who allocated it, the document ends CANCELLED, and the numbers go on from the
 * last one. Both run in the transaction of the command with the audit row, the history row and the events.
 */
@Controller()
export class OutgoingRecallController {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly recalls = new OutgoingRecallStore();
  private readonly registers = new NumberRegisterStore();
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(DOC_SIGNING_PORT) private readonly signing: SigningPort,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('outgoing-documents/:id/recall')
  @HttpCode(200)
  @OperationId('recallOutgoingDocument')
  @Command({ operation: 'recallOutgoingDocument', versioned: true })
  async recall(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocRecall'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.recallOutgoingDocument, now);
    if (document.version !== scope.expectedVersion) throw versionConflict(document.version);
    const reason = reasonOf(body.reason);
    const basis = body.recall_basis_document_id === undefined ? null : body.recall_basis_document_id.toLowerCase();
    const result = await this.recalls.recall(scope.tx, document, { reason, basisDocumentId: basis, notifyRecipients: body.notify_recipients ?? true, actor, now });
    const recalled = result.document;
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: document.id,
      kind: 'RECALLED',
      fromStatus: result.from,
      toStatus: 'RECALLED',
      actor,
      comment: reason,
      documentVersion: recalled.version,
      occurredAt: now,
      details: { basis_document_id: basis, notified: result.notified.length, called_off: result.cancelled.length },
    });
    await scope.audit({
      action: 'outgoing_document.recall',
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      reason,
      diff: { from_status: result.from, number: document.documentNumber, symbol: document.symbol, basis_document_id: basis, notified: result.notified.length, called_off: result.cancelled.length },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: recalled.version,
      type: 'doc.recalled.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        document_id: document.documentId,
        outgoing_document_id: document.id,
        version: recalled.version,
        actor_id: actor,
        occurred_at: now.toISOString(),
        source_module: document.sourceModule,
        source_ref: document.sourceRef,
        payload_sha256: document.payloadSha256,
        reason,
        document_number: document.documentNumber,
        symbol: document.symbol,
        basis_document_id: basis,
        // The recipients who have to be told: the notification module reads these from the event, the rows carry the instant of the notice.
        notified_recipients: result.notified.map((row) => ({ distribution_id: row.id, recipient_kind: row.recipientKind, recipient_unit_id: row.recipientUnitId, recipient_name: row.recipientName, channel: row.channel })),
      },
      // One recall, one event: a document is recalled once.
      eventKey: `${OUTGOING_TYPE}:${document.id}:recalled`,
    });
    this.metrics.increment('doc_recalled_total', { notified: String(result.notified.length > 0) });
    return {
      ...commandResult(scope, 'RECALLED', recalled.version, document.id),
      document_id: document.documentId,
      effect_status: recalled.effectStatus,
      recalled_at: now.toISOString(),
      notified_count: result.notified.length,
      called_off_count: result.cancelled.length,
    };
  }

  @Post('outgoing-documents/:id/number-voiding')
  @HttpCode(200)
  @OperationId('voidOutgoingDocumentNumber')
  @Command({ operation: 'voidOutgoingDocumentNumber', versioned: true })
  async voidNumber(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocNumberVoid'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.voidOutgoingDocumentNumber, now);
    if (document.version !== scope.expectedVersion) throw versionConflict(document.version);
    const reason = reasonOf(body.reason);
    const approver = body.approver_user_id.toLowerCase();
    // The two-person rule comes first: it is the answer for the person who allocated the number and names themselves.
    const result = await this.recalls.voidNumber(scope.tx, document, { reason, voidedBy: actor, approvedBy: approver, now });
    // The approver is a person who may void numbers over the unit of the document: judged after the void, in the same transaction, so a refusal leaves nothing behind.
    await this.assertApprover(scope, document, approver, now);
    const cancelled = result.document;
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: document.id,
      kind: 'NUMBER_VOIDED',
      fromStatus: result.from,
      toStatus: 'CANCELLED',
      actor,
      comment: reason,
      documentVersion: cancelled.version,
      occurredAt: now,
      details: { register_id: document.registerId, number: result.entry.number, symbol: result.entry.symbol, approved_by: approver },
    });
    await scope.audit({
      action: 'outgoing_document.number_void',
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      reason,
      diff: { from_status: result.from, register_id: document.registerId, allocation_id: result.entry.allocationId, number: result.entry.number, symbol: result.entry.symbol, approved_by: approver },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: cancelled.version,
      type: 'doc.number_voided.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        document_id: document.documentId,
        outgoing_document_id: document.id,
        version: cancelled.version,
        actor_id: actor,
        occurred_at: now.toISOString(),
        register_id: document.registerId,
        allocation_id: result.entry.allocationId,
        number: result.entry.number,
        symbol: result.entry.symbol,
        reason,
        approved_by: approver,
        from_status: result.from,
      },
      eventKey: `${OUTGOING_TYPE}:${document.id}:number-voided`,
    });
    if (document.sourceModule !== null && document.sourceRef !== null) {
      // The module that asked for the document is told it will not come (BR-DOC-17); it does not mark its record issued.
      await scope.emit({
        aggregateType: OUTGOING_TYPE,
        aggregateId: document.id,
        aggregateVersion: cancelled.version,
        type: 'doc.rejected.v1',
        schemaVersion: 1,
        payload: { source_module: document.sourceModule, source_ref: document.sourceRef, payload_sha256: document.payloadSha256, reject_code: VOID_REJECT_CODE },
        eventKey: `${OUTGOING_TYPE}:${document.id}:${cancelled.version}:rejected`,
      });
    }
    this.afterCancel(scope, result.sessions);
    this.metrics.increment('doc_number_voided_total', { route: document.route.toLowerCase() });
    return {
      ...commandResult(scope, 'CANCELLED', cancelled.version, document.id),
      document_id: document.documentId,
      allocation_id: result.entry.allocationId,
      number: result.entry.number,
      allocation_status: result.entry.status,
    };
  }

  /** The approver is an active member who holds the right to void numbers over the unit that drafted the document. */
  private async assertApprover(scope: CommandScope, document: OutgoingDocumentRecord, approverId: string, now: Date): Promise<void> {
    const approver = await loadAccessIn(scope.tx, approverId);
    const unit = await this.registers.unitRef(scope.tx, document.draftingUnitId);
    if (!approver.membershipActive || unit === undefined || !mayActOnUnit(approver, PERMISSIONS.voidOutgoingDocumentNumber, unit, now)) {
      throw new DomainError('VALIDATION_FAILED', 422, 'approver_user_id', { extensions: { reason: 'APPROVER_NOT_AUTHORISED' } });
    }
  }

  private afterCancel(scope: CommandScope, sessions: ReadonlyArray<{ id: string; adapterCode: string; providerTxnRef: string | null; expiresAt: Date }>): void {
    for (const session of sessions) {
      if (session.providerTxnRef === null) continue;
      const ref = { provider: session.adapterCode as SigningProvider, sessionId: session.providerTxnRef, expiresAt: session.expiresAt };
      scope.afterCommit(async () => {
        await this.signing.cancel(ref).catch(() => this.metrics.increment('doc_signing_cancel_failed_total', { role: 'void' }));
      });
    }
  }

  private async lockDocument(scope: CommandScope, access: EffectiveAccess, id: string, permission: string, now: Date): Promise<OutgoingDocumentRecord> {
    // A document the caller cannot see is indistinguishable from one that does not exist.
    const document = await this.outgoing.lock(scope.tx, id, (first) => scopePredicate(access, permission, now, OUTGOING_SCOPE_COLUMNS, first));
    if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return document;
  }
}
