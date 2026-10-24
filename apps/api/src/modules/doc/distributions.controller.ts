import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocumentDistributionStore, OUTGOING_SCOPE_COLUMNS, OutgoingDocumentStore, scopePredicate } from '@machvon/db';
import type { DistributionRecord } from '@machvon/db';
import { DomainError, NOOP_METRICS, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import type { EmailChannelPort } from './distribution-channel';
import { normaliseDispatch } from './distribution-rules';
import { DocumentDistributionService } from './distribution.service';
import { normaliseRecipients } from './outgoing-rules';
import { DOC_CLOCK, DOC_EMAIL_CHANNEL, DOC_METRICS } from './tokens';

function rowView(record: DistributionRecord, created?: boolean): Record<string, unknown> {
  return { distribution_id: record.id, channel: record.channel, status: record.status, error_code: record.errorCode, ...(created === undefined ? {} : { created }) };
}

/**
 * Distributing an issued outgoing document to its recipients and tracking the receipts (ST-DOC-010, DOC.md F8). The commands act on the document inside
 * the scope of the permission over its drafting unit; a distribution of a document the caller cannot see does not exist for them (404). The rows, the
 * state of each and the aggregate status of the document are decided by `DocumentDistributionService` in the transaction of the command.
 */
@Controller()
export class DocumentDistributionsController {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly rows = new DocumentDistributionStore();
  private readonly service: DocumentDistributionService;
  private readonly clock: () => Date;

  constructor(
    @Inject(DOC_EMAIL_CHANNEL) email: EmailChannelPort,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.service = new DocumentDistributionService(email, metrics ?? NOOP_METRICS);
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('outgoing-documents/:id/distributions')
  @HttpCode(200)
  @OperationId('dispatchOutgoingDocument')
  @Command({ operation: 'dispatchOutgoingDocument', versioned: true })
  async dispatch(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocDispatch'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const document = await this.outgoing.lock(scope.tx, id, (first) => scopePredicate(access, PERMISSIONS.dispatchOutgoingDocument, now, OUTGOING_SCOPE_COLUMNS, first));
    if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (document.version !== scope.expectedVersion) throw versionConflict(document.version);
    this.service.assertDistributable(document);
    const items = normaliseDispatch(body.recipients, normaliseRecipients(document.recipients as object[]));
    const done = await this.service.dispatch(scope, document, items, now);
    return {
      ...commandResult(scope, done.document.status, done.document.version, document.id),
      distributions: done.changes.map((change) => rowView(change.record, change.created)),
    };
  }

  @Post('document-distributions/:id/acknowledgement')
  @HttpCode(200)
  @OperationId('recordDistributionAcknowledgement')
  @Command({ operation: 'recordDistributionAcknowledgement', versioned: true })
  async acknowledge(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocAcknowledgement'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const { distribution, document } = await this.locked(scope, access, id, PERMISSIONS.recordDistributionAcknowledgement, now);
    const acknowledgedAt = new Date(body.acknowledged_at);
    if (Number.isNaN(acknowledgedAt.getTime())) throw new DomainError('VALIDATION_FAILED', 422, 'acknowledged_at');
    const reference = body.external_ref === undefined ? '' : body.external_ref.normalize('NFC').trim();
    const done = await this.service.acknowledge(scope, document, distribution, scope.expectedVersion ?? 0, { acknowledgedAt, externalRef: reference === '' ? null : reference }, now);
    return { ...commandResult(scope, done.record.status, done.record.version, done.record.id), document_status: done.document.status, document_version: done.document.version };
  }

  @Post('document-distributions/:id/retry')
  @HttpCode(200)
  @OperationId('retryDocumentDistribution')
  @Command({ operation: 'retryDocumentDistribution', versioned: true })
  async retry(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const { distribution, document } = await this.locked(scope, access, id, PERMISSIONS.retryDocumentDistribution, now);
    const done = await this.service.retry(scope, document, distribution, scope.expectedVersion ?? 0, now);
    return { ...commandResult(scope, done.record.status, done.record.version, done.record.id), error_code: done.record.errorCode, document_status: done.document.status, document_version: done.document.version };
  }

  /** The document locked first and the distribution after it (the order every command keeps), both inside the scope of the permission. */
  private async locked(scope: CommandScope, access: EffectiveAccess, id: string, permission: string, now: Date) {
    const found = await this.rows.find(scope.tx, id);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const document = await this.outgoing.lock(scope.tx, found.outgoingDocumentId, (first) => scopePredicate(access, permission, now, OUTGOING_SCOPE_COLUMNS, first));
    if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const distribution = await this.rows.find(scope.tx, id, { lock: true });
    if (distribution === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { distribution, document };
  }
}
