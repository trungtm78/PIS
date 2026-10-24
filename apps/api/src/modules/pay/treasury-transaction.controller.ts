import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import {
  PayTreasuryTransactionStore,
  TREASURY_CALLBACK_SCHEME,
  TREASURY_CALLBACK_WINDOW_SECONDS,
  TenantDatabase,
  callbackTimestampSeconds,
  projectScope,
  treasuryCallbackPayload,
  treasuryCallbackSecretRef,
} from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid, verifyProviderCallback } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { WEBHOOK_PAYLOADS, WEBHOOK_SECRETS } from '../../notifications/delivery/webhook-support';
import type { WebhookPayloadStore, WebhookSecretResolver } from '../../notifications/delivery/webhook-support';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { PAY_METRICS } from './tokens';
import { treasuryTransactionView } from './treasury-view';

const RESOURCE_TYPE = 'treasury_transaction';
const CLASSIFICATION = 'INTERNAL';
const CONFIRMED_EVENT = 'pay.treasury_transaction.confirmed.v1';

function idOf(value: string, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

/**
 * Treasury transactions enter PAY by three routes (PAY 3.3): a statement file (ST-PAY-006, `importTreasuryStatement`), a confirmation that a
 * person makes by hand with evidence, and the callback of the Treasury. The two here end where the file ends: one transaction per provider and
 * business key, never altered, and matched to a payment later by `matchTreasuryTransaction`. No Treasury API exists for third parties, so the
 * callback adapter is MOCK (tests) and MISSING (production): without the signing keys of the provider every event is refused.
 */
@Controller()
export class TreasuryTransactionController {
  private readonly store = new PayTreasuryTransactionStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(WEBHOOK_SECRETS) private readonly secrets: WebhookSecretResolver,
    @Inject(WEBHOOK_PAYLOADS) private readonly payloads: WebhookPayloadStore,
    @Optional() @Inject(PAY_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post('treasury-transactions')
  @HttpCode(200)
  @OperationId('confirmTreasuryManually')
  @Command({ operation: 'confirmTreasuryManually', ttl: 'extended' })
  async confirmManually(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Body() body: Schemas['PayConfirmTreasuryManually'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.store.confirmManually(scope.tx, {
      paymentRequestId: idOf(body.payment_request_id, 'payment_request_id'),
      documentNo: body.document_no,
      documentDate: body.document_date,
      amountVnd: body.amount_vnd,
      confirmedAt: body.confirmed_at,
      evidenceDocumentVersionId: idOf(body.evidence_document_version_id, 'evidence_document_version_id'),
      actor: scope.tenant.membershipId,
      scope: projectScope(access, PERMISSIONS.confirmTreasuryManually, now),
      now,
    });
    const figures = {
      payment_request_id: done.paymentRequestId,
      project_id: done.projectId,
      document_no: done.documentNo,
      amount_vnd: done.amountVnd,
      net_vnd: done.netVnd,
      source_kind: 'MANUAL_CONFIRMED',
      match_status: done.matchStatus,
    };
    await scope.audit({
      action: 'pay.treasury_transaction_confirmed',
      resourceType: RESOURCE_TYPE,
      resourceId: done.transactionId,
      classification: CLASSIFICATION,
      diff: { ...figures, evidence_document_version_id: idOf(body.evidence_document_version_id, 'evidence_document_version_id'), reconciliation_item_id: done.mismatchItemId },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.transactionId,
      aggregateVersion: 1,
      type: CONFIRMED_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, transaction_id: done.transactionId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...figures },
      eventKey: `${RESOURCE_TYPE}:${done.transactionId}:confirmed`,
    });
    // A figure that is not the net of the request is not an error of the call: the transaction is recorded in EXCEPTION and the item is opened.
    return { ...commandResult(scope, done.matchStatus, 1, done.transactionId), reconciliation_item_id: done.mismatchItemId };
  }

  @Post('integrations/treasury/callbacks')
  @HttpCode(200)
  @OperationId('receiveTreasuryCallback')
  @Command({ operation: 'receiveTreasuryCallback', ttl: 'extended' })
  async receiveCallback(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Body() body: Schemas['PayReceiveTreasuryCallback'],
  ): Promise<CommandResult & Record<string, unknown>> {
    // The Treasury acts for the whole tenant through a service principal; a grant on a subtree does not make a caller the Treasury.
    if (!holdsOnWholeTenant(access, PERMISSIONS.receiveTreasuryCallback)) throw new DomainError('SCOPE_DENIED', 403);
    const fields = {
      providerEventId: body.provider_event_id.trim(),
      provider: body.provider.trim(),
      documentNo: body.document_no.trim(),
      documentDate: body.document_date,
      projectCode: body.project_code.trim(),
      amountVnd: body.amount_vnd,
      direction: body.direction,
      confirmedAt: body.confirmed_at,
    };
    const rawBody = treasuryCallbackPayload(fields);
    const keys = await this.secrets.resolve(treasuryCallbackSecretRef(fields.provider));
    // The signature is checked before a byte is stored; an event that does not verify leaves nothing but a counter.
    verifyProviderCallback({
      provider: fields.provider,
      rawBody,
      signature: body.signature,
      timestampSeconds: callbackTimestampSeconds(fields.confirmedAt),
      keys,
      scheme: TREASURY_CALLBACK_SCHEME,
      replayWindowSeconds: TREASURY_CALLBACK_WINDOW_SECONDS,
      metrics: this.metrics,
    });
    const payloadReference = await this.payloads.put(scope.tenant, fields.provider, fields.providerEventId, rawBody);
    const done = await this.store.receiveCallback(scope.tx, { ...fields, signature: body.signature, keys, payloadReference, actor: scope.tenant.membershipId, metrics: this.metrics });
    const figures = { provider: fields.provider, provider_event_id: fields.providerEventId, document_no: fields.documentNo, amount_vnd: fields.amountVnd, match_status: done.matchStatus };
    // The same event, or the same voucher, again changes nothing: the answer is the first one and the trail records only that it came back.
    await scope.audit({
      action: done.duplicate ? 'pay.treasury_callback_repeated' : 'pay.treasury_callback_received',
      resourceType: RESOURCE_TYPE,
      resourceId: done.transactionId,
      classification: CLASSIFICATION,
      diff: done.duplicate ? { provider: fields.provider, provider_event_id: fields.providerEventId } : { ...figures, source_kind: 'CALLBACK_MOCK' },
    });
    if (!done.duplicate) {
      const now = new Date();
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: done.transactionId,
        aggregateVersion: 1,
        type: CONFIRMED_EVENT,
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, transaction_id: done.transactionId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), source_kind: 'CALLBACK_MOCK', ...figures },
        eventKey: `${RESOURCE_TYPE}:${done.transactionId}:confirmed`,
      });
    }
    return { ...commandResult(scope, done.matchStatus, 1, done.transactionId), duplicate: done.duplicate };
  }
}

/**
 * The Treasury transactions of the projects in the scope of the caller (`treasury_transaction.read`): an allowlist of fields, with no key of
 * deduplication, no hash and no evidence. A transaction of a project outside the scope is indistinguishable from one that does not exist.
 */
@Controller('resources/treasury_transaction')
export class TreasuryTransactionReadsController {
  private readonly store = new PayTreasuryTransactionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_treasury_transaction')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.store.list(tx, projectScope(access, PERMISSIONS.get_resources_treasury_transaction, now), { limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(treasuryTransactionView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.confirmedAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_treasury_transaction_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const row = await this.database.withTenant(tenant, (tx) => this.store.find(tx, projectScope(access, PERMISSIONS.get_resources_treasury_transaction_id, new Date()), id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return treasuryTransactionView(row);
  }
}
