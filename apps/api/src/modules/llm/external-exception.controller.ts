import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LlmExternalExceptionStore, TenantDatabase } from '@machvon/db';
import { DomainError, AI_EXCEPTION_STATUSES, aiEditionPolicy, parseExceptionRequest } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { cursorOf, idOf, limitOf, oneOf, parseCursor } from './assist-paging';
import { exceptionView } from './assist-view';

const EXCEPTION = 'ai_external_exception';
const USES_SHOWN = 50;

/**
 * The exceptions to the processing location of an edition (lane AI-2, eng-review R5, KT.02; LLM-27): where an edition keeps AI on the servers of the customer, a provider outside them is used only under an exception that one
 * person asked for with a reason and another approved with the number of the paper, for at most 90 days; it can be revoked, and every request that went out under it is logged. The exceptions are the tenant's, not a unit's.
 * The edition policy says whether any of this applies to the process (the public edition keeps its routing policy and needs no exception).
 */
@Controller()
export class LlmExternalExceptionController {
  private readonly exceptions = new LlmExternalExceptionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private whole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Get('ai/edition-policy')
  @OperationId('getAiEditionPolicy')
  async policy(@CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getAiEditionPolicy);
    const policy = aiEditionPolicy();
    return { name: policy.name, external_routing: policy.externalRouting, attestation_required: policy.attestationRequired };
  }

  @Post('ai/external-exceptions')
  @HttpCode(200)
  @OperationId('requestAiExternalException')
  @Command({ operation: 'requestAiExternalException' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AiExternalExceptionRequest']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.requestAiExternalException);
    const asked = parseExceptionRequest({ providerId: body.provider_id, taskType: body.task_type, maxClassification: body.max_classification, reason: body.reason, validDays: body.valid_days });
    const created = await this.exceptions.request(scope.tx, { ...asked, actor: scope.tenant.membershipId });
    // The audit says what was asked and for which provider, not the words of the person: the record holds them.
    await scope.audit({ action: 'llm.external_exception_requested', resourceType: EXCEPTION, resourceId: created.id, diff: { provider_id: created.providerId, provider_code: created.providerCode, route_class: created.routeClass, task_type: created.taskType, max_classification: created.maxClassification, valid_days: created.requestedValidDays } });
    await scope.emit({
      aggregateType: EXCEPTION,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.external_exception.requested.v1',
      schemaVersion: 1,
      payload: { exception_id: created.id, provider_id: created.providerId, max_classification: created.maxClassification, valid_days: created.requestedValidDays },
      eventKey: `${EXCEPTION}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('ai/external-exceptions/:id/decision')
  @HttpCode(200)
  @OperationId('decideAiExternalException')
  @Command({ operation: 'decideAiExternalException', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AiExternalExceptionDecision']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.decideAiExternalException);
    const done = await this.exceptions.decide(scope.tx, id, { decision: body.decision, note: body.note, approvalRef: body.approval_ref, actor: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0, now: new Date() });
    await scope.audit({
      action: 'llm.external_exception_decided',
      resourceType: EXCEPTION,
      resourceId: id,
      diff: { provider_id: done.row.providerId, provider_code: done.row.providerCode, from_status: done.before, to_status: done.row.status, approval_ref: done.row.approvalRef, valid_from: done.row.validFrom, valid_until: done.row.validUntil, max_classification: done.row.maxClassification },
    });
    await scope.emit({
      aggregateType: EXCEPTION,
      aggregateId: id,
      aggregateVersion: done.row.version,
      type: 'llm.external_exception.decided.v1',
      schemaVersion: 1,
      payload: { exception_id: id, provider_id: done.row.providerId, status: done.row.status, valid_until: done.row.validUntil },
      eventKey: `${EXCEPTION}:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.status, done.row.version, id);
  }

  @Post('ai/external-exceptions/:id/revocation')
  @HttpCode(200)
  @OperationId('revokeAiExternalException')
  @Command({ operation: 'revokeAiExternalException', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AiExternalExceptionRevoke']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.revokeAiExternalException);
    const row = await this.exceptions.revoke(scope.tx, id, { reason: body.reason, actor: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0, now: new Date() });
    await scope.audit({ action: 'llm.external_exception_revoked', resourceType: EXCEPTION, resourceId: id, diff: { provider_id: row.providerId, provider_code: row.providerCode, uses: row.useCount } });
    await scope.emit({
      aggregateType: EXCEPTION,
      aggregateId: id,
      aggregateVersion: row.version,
      type: 'llm.external_exception.revoked.v1',
      schemaVersion: 1,
      payload: { exception_id: id, provider_id: row.providerId },
      eventKey: `${EXCEPTION}:${id}:${row.version}`,
    });
    return commandResult(scope, row.status, row.version, id);
  }

  @Get('ai/external-exceptions')
  @OperationId('listAiExternalExceptions')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('provider_id') providerId?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiExternalExceptions);
    const filter = { status: oneOf(status, AI_EXCEPTION_STATUSES, 'status'), providerId: providerId === undefined ? undefined : idOf(providerId, 'provider_id'), limit: limitOf(limit), after: parseCursor(cursor) };
    const now = new Date();
    const page = await this.database.withTenant(tenant, (tx) => this.exceptions.list(tx, filter));
    return { items: page.rows.map((row) => exceptionView(row, now)), next_cursor: page.next === undefined ? null : cursorOf(page.next.key, page.next.id), as_of: now.toISOString() };
  }

  @Get('ai/external-exceptions/:id')
  @OperationId('getAiExternalException')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getAiExternalException);
    const now = new Date();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.exceptions.find(tx, id);
      return row === undefined ? undefined : { row, uses: await this.exceptions.uses(tx, id, USES_SHOWN) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return exceptionView(found.row, now, found.uses);
  }
}
