import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CannedReplyStore, RoutingPolicyStore, TenantDatabase } from '@machvon/db';
import type { CannedReplyRecord, PolicyRecord } from '@machvon/db';
import { DomainError, assertCannedReply, assertPolicy, assertPublishReason } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const POLICY_RESOURCE = 'conversation_routing_policy';
const REPLY_RESOURCE = 'canned_reply';
const MANAGE = PERMISSIONS.createRoutingPolicyVersion;

/** The policies and the replies are the tenant's, not a unit's: who reads or changes them holds the permission on the whole tenant. */
function assertHolds(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, MANAGE)) throw new DomainError('SCOPE_DENIED', 403);
}

const policyView = (policy: PolicyRecord): Schemas['RoutingPolicyView'] => ({
  id: policy.id,
  revision: policy.revision,
  status: policy.status,
  rules: policy.rules.map((rule) => ({ channels: rule.channels as never, keywords: rule.keywords, queue_unit_id: rule.queueUnitId, priority: rule.priority })),
  calendar_code: policy.calendarCode,
  first_response_minutes: policy.firstResponseMinutes,
  resolution_hours: policy.resolutionHours,
  published_at: policy.publishedAt,
  version: policy.version,
});

const replyView = (reply: CannedReplyRecord): Schemas['CannedReplyView'] => ({
  id: reply.id,
  code: reply.code,
  title: reply.title,
  body_text: reply.bodyText,
  channels: reply.channels,
  classification: reply.classification as Schemas['CannedReplyView']['classification'],
  status: reply.status,
  version: reply.version,
});

/**
 * The routing policy and the canned replies of the omnichannel center (ST-OMNI-006, OMNI-07, OMNI-08): a supervisor writes the rules that put a new conversation in a queue and give it a deadline for the first answer, counted in working time, publishes
 * a version of them, and keeps the answers the agents reuse. A policy is written as a Draft and published once; a reply is public or internal text with no variable. Both are the tenant's.
 */
@Controller()
export class PolicyController {
  private readonly policies = new RoutingPolicyStore();
  private readonly replies = new CannedReplyStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('conversation-routing-policies')
  @OperationId('listRoutingPolicies')
  async listPolicies(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['RoutingPolicyList']> {
    assertHolds(access);
    const request = parsePageRequest(limit, cursor);
    const { rows, units } = await this.database.withTenant(tenant, async (tx) => ({ rows: await this.policies.list(tx, { limit: request.limit + 1, after: request.after }), units: await this.policies.units(tx) }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(policyView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, units, as_of: new Date().toISOString() };
  }

  @Post('conversation-routing-policies')
  @HttpCode(201)
  @OperationId('createRoutingPolicyVersion')
  @Command({ operation: 'createRoutingPolicyVersion' })
  async createPolicy(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RoutingPolicyDraft']): Promise<CommandResult> {
    assertHolds(access);
    const made = await this.policies.createDraft(scope.tx, assertPolicy(body as unknown as Record<string, unknown>), scope.tenant.membershipId);
    await scope.audit({
      action: 'omni.routing_policy_created',
      resourceType: POLICY_RESOURCE,
      resourceId: made.id,
      diff: { revision: made.revision, rules: made.rules.length, calendar_code: made.calendarCode, first_response_minutes: made.firstResponseMinutes, resolution_hours: made.resolutionHours },
    });
    return commandResult(scope, made.status.toUpperCase(), made.version, made.id);
  }

  @Post('conversation-routing-policies/:policyId/publish')
  @HttpCode(200)
  @OperationId('publishRoutingPolicy')
  @Command({ operation: 'publishRoutingPolicy', versioned: true })
  async publish(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body() body: Schemas['ReasonOnly'],
  ): Promise<CommandResult> {
    assertHolds(access);
    const reason = assertPublishReason(body);
    const { policy, superseded } = await this.policies.publish(scope.tx, policyId.toLowerCase(), scope.expectedVersion ?? 0, new Date());
    await scope.audit({
      action: 'omni.routing_policy_published',
      resourceType: POLICY_RESOURCE,
      resourceId: policy.id,
      reason,
      diff: { revision: policy.revision, superseded_revision: superseded?.revision ?? null },
    });
    return commandResult(scope, policy.status.toUpperCase(), policy.version, policy.id);
  }

  @Get('canned-replies')
  @OperationId('listCannedReplies')
  async listReplies(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['CannedReplyList']> {
    assertHolds(access);
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.replies.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(replyView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.code, id: last.id }) : null, as_of: new Date().toISOString() };
  }

  @Post('canned-replies')
  @HttpCode(201)
  @OperationId('createCannedReply')
  @Command({ operation: 'createCannedReply' })
  async createReply(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CannedReplyUpsert']): Promise<CommandResult> {
    assertHolds(access);
    const made = await this.replies.create(scope.tx, assertCannedReply(body as unknown as Record<string, unknown>), scope.tenant.membershipId);
    await scope.audit({ action: 'omni.canned_reply_created', resourceType: REPLY_RESOURCE, resourceId: made.id, diff: { code: made.code, channels: made.channels, classification: made.classification } });
    return commandResult(scope, made.status.toUpperCase(), made.version, made.id);
  }

  @Put('canned-replies/:replyId')
  @HttpCode(200)
  @OperationId('updateCannedReply')
  @Command({ operation: 'updateCannedReply', versioned: true })
  async updateReply(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('replyId', ParseUUIDPipe) replyId: string,
    @Body() body: Schemas['CannedReplyUpsert'],
  ): Promise<CommandResult> {
    assertHolds(access);
    const { before, after } = await this.replies.update(scope.tx, replyId.toLowerCase(), scope.expectedVersion ?? 0, assertCannedReply(body as unknown as Record<string, unknown>));
    await scope.audit({
      action: 'omni.canned_reply_updated',
      resourceType: REPLY_RESOURCE,
      resourceId: after.id,
      diff: { code: after.code, channels: after.channels, classification: after.classification, text_changed: before.bodyText !== after.bodyText },
    });
    return commandResult(scope, after.status.toUpperCase(), after.version, after.id);
  }
}
