import { PERMISSIONS } from '@machvon/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ASSIGN_CONVERSATION, ConversationLinkStore, ConversationOutboundStore, ConversationStore, TenantDatabase } from '@machvon/db';
import type { IssuePlace } from '@machvon/db';
import type { ConversationRecord, MessageRecord } from '@machvon/db';
import { CONVERSATION_STATUSES, DomainError, assertAssignment, assertConversationReason, assertConversion, assertMessageSend, assertResourceLink, asUuid, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { LinkType } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { issueEventPayload } from '../../modules/iss/issue-event';
import { renderTemplate } from '../../notifications/delivery/template-renderer';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const CONVERSATION_RESOURCE = 'conversation';
const ASSIGNED_EVENT = 'omni.conversation.assigned.v1';
const QUEUED_EVENT = 'omni.message.queued.v1';
const RESOLVED_EVENT = 'omni.conversation.resolved.v1';
const REOPENED_EVENT = 'omni.conversation.reopened.v1';
const CONVERTED_EVENT = 'omni.conversation.converted.v1';
const CONVERT = PERMISSIONS.convertConversationToIssue;
/** What it takes to read a record a conversation is linked to: the permission to read it, held at its place. */
const READ_OF: Readonly<Record<LinkType, string>> = { project: PERMISSIONS.get_resources_project_id, issue: PERMISSIONS.get_resources_issue_id, contract: PERMISSIONS.get_resources_contract_id };

function conversationView(row: ConversationRecord): Schemas['ConversationView'] {
  return {
    id: row.id,
    channel_account_id: row.channelAccountId,
    channel: row.channel,
    account_name: row.accountName,
    contact_id: row.contactId,
    contact_name: row.contactName,
    status: row.status,
    priority: row.priority as Schemas['ConversationView']['priority'],
    assignee_membership_id: row.assigneeId,
    assignee_name: row.assigneeName,
    queue_unit_id: row.queueUnitId,
    queue_unit_name: row.queueUnitName,
    last_inbound_at: row.lastInboundAt,
    window_expires_at: row.windowExpiresAt,
    sla_first_response_due_at: row.slaFirstResponseDueAt,
    sla_resolution_due_at: row.slaResolutionDueAt,
    message_count: row.messageCount,
    resource_links: row.resourceLinks.map((link) => ({ resource_type: link.resource_type, resource_id: link.resource_id, linked_at: link.linked_at, converted: link.converted === true })),
    assigned_at: row.assignedAt,
    created_at: row.createdAt,
    version: row.version,
  };
}

function messageView(row: MessageRecord): Schemas['ChannelMessageView'] {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    direction: row.direction as Schemas['ChannelMessageView']['direction'],
    kind: row.kind,
    delivery_status: row.deliveryStatus as Schemas['ChannelMessageView']['delivery_status'],
    author_membership_id: row.authorMembershipId,
    classification: row.classification as Schemas['ChannelMessageView']['classification'],
    text: row.text,
    created_at: row.createdAt,
  };
}

/** A filter that is given must be a value the filter knows: a mistyped one is refused, not read as "all". */
function uuidFilter(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, name);
  return id;
}

/**
 * The conversations of the omnichannel center (ST-OMNI-004, OMNI-01, OMNI.md 3.1, 3.2): what people wrote to the channel accounts of the tenant, in the queues of the units of whoever reads and in what is assigned to them, and the assignment by a supervisor to
 * an agent who may answer in that queue. What comes in is put into its conversation by the processing of the inbox of the provider (callback-handler), never by a request.
 */
@Controller()
export class ConversationsController {
  private readonly conversations = new ConversationStore();
  private readonly outbound = new ConversationOutboundStore();
  private readonly links = new ConversationLinkStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('resources/conversation')
  @OperationId('get_resources_conversation')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('status') status?: unknown,
    @Query('mine') mine?: unknown,
    @Query('queue_unit_id') queueUnitId?: unknown,
  ): Promise<Schemas['ConversationPage']> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && !(CONVERSATION_STATUSES as readonly unknown[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (mine !== undefined && mine !== 'true' && mine !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'mine');
    const unit = uuidFilter(queueUnitId, 'queue_unit_id');
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.conversations.list(tx, { access, membershipId: tenant.membershipId, now }, { status: status as string | undefined, mine: mine === 'true', queueUnitId: unit }, { limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(conversationView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: now.toISOString() };
  }

  @Get('resources/conversation/:id')
  @OperationId('get_resources_conversation_id')
  async read(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['ConversationView']> {
    const found = await this.database.withTenant(tenant, (tx) => this.conversations.find(tx, { access, membershipId: tenant.membershipId, now: new Date() }, id.toLowerCase()));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return conversationView(found);
  }

  @Get('resources/channel_message')
  @OperationId('get_resources_channel_message')
  async listMessages(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('conversation_id') conversationId?: unknown,
  ): Promise<Schemas['ChannelMessagePage']> {
    const request = parsePageRequest(limit, cursor);
    const conversation = uuidFilter(conversationId, 'conversation_id');
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.conversations.listMessages(tx, { access, membershipId: tenant.membershipId, now }, { conversationId: conversation }, { limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(messageView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: now.toISOString() };
  }

  @Get('resources/channel_message/:id')
  @OperationId('get_resources_channel_message_id')
  async readMessage(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['ChannelMessageView']> {
    const found = await this.database.withTenant(tenant, (tx) => this.conversations.findMessage(tx, { access, membershipId: tenant.membershipId, now: new Date() }, id.toLowerCase()));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return messageView(found);
  }

  @Get('conversations/:conversationId/assignees')
  @OperationId('listConversationAssignees')
  async assignees(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<Schemas['ConversationAssigneeList']> {
    const now = new Date();
    const items = await this.database.withTenant(tenant, async (tx) => {
      const scope = { access, membershipId: tenant.membershipId, now };
      const conversation = await this.conversations.find(tx, scope, conversationId.toLowerCase());
      if (conversation === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      // The list is the supervisor's: whoever may read the conversation but not assign it is told so.
      if ((await this.conversations.find(tx, scope, conversation.id, ASSIGN_CONVERSATION)) === undefined) throw new DomainError('SCOPE_DENIED', 403);
      return await this.conversations.eligibleAssignees(tx, conversation, now);
    });
    return { items: items.map((item) => ({ membership_id: item.membershipId, display_name: item.displayName })), as_of: now.toISOString() };
  }

  @Post('conversations/:conversationId/assign')
  @HttpCode(200)
  @OperationId('assignConversation')
  @Command({ operation: 'assignConversation', versioned: true })
  async assign(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: Schemas['ConversationAssign'],
  ): Promise<CommandResult> {
    const assignment = assertAssignment(body);
    const { before, after } = await this.conversations.assign(scope.tx, { access, membershipId: scope.tenant.membershipId, now: new Date() }, conversationId.toLowerCase(), scope.expectedVersion ?? 0, assignment);
    await scope.audit({
      action: 'conversation.assigned',
      resourceType: CONVERSATION_RESOURCE,
      resourceId: after.id,
      ...(assignment.reason === undefined ? {} : { reason: assignment.reason }),
      // From whom to whom and the state it moved from: the ids of the members, not the person who wrote to the channel.
      diff: { from_assignee_id: before.assigneeId, to_assignee_id: after.assigneeId, from_status: before.status, to_status: after.status, queue_unit_id: after.queueUnitId },
    });
    await scope.emit({
      aggregateType: CONVERSATION_RESOURCE,
      aggregateId: after.id,
      aggregateVersion: after.version,
      type: ASSIGNED_EVENT,
      schemaVersion: 1,
      payload: { conversation_id: after.id, assignee_membership_id: after.assigneeId, previous_assignee_membership_id: before.assigneeId, queue_unit_id: after.queueUnitId },
      eventKey: `${ASSIGNED_EVENT}:${after.id}:${after.version}`,
    });
    return commandResult(scope, after.status.toUpperCase(), after.version, after.id);
  }

  @Post('conversations/:conversationId/messages')
  @HttpCode(202)
  @OperationId('sendConversationMessage')
  @Command({ operation: 'sendConversationMessage', versioned: true })
  async send(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: Schemas['ConversationMessageSend'],
  ): Promise<CommandResult> {
    const draft = assertMessageSend(body as Record<string, unknown>);
    // The words of a message made from a template are written here, from the variables the agent gave; the checks that follow judge the template itself.
    const template = draft.templateVersionId === undefined ? undefined : await this.outbound.template(scope.tx, draft.templateVersionId);
    const written = template === undefined ? undefined : renderTemplate(template.contentAst, template.variableSchema, draft.templateVariables);
    const text = written === undefined ? (draft.text ?? '') : written.text;
    const done = await this.outbound.send(scope.tx, { access, membershipId: scope.tenant.membershipId, now: new Date() }, conversationId.toLowerCase(), scope.expectedVersion ?? undefined, draft, { text, subject: written?.subject, template });
    await scope.audit({
      action: done.queued ? 'conversation.message_sent' : 'conversation.note_added',
      resourceType: CONVERSATION_RESOURCE,
      resourceId: done.after.id,
      classification: 'PERSONAL',
      // What was said is in the conversation and not on the trail: the kind, the purpose, the account and what was attached.
      diff: { message_id: done.messageId, kind: draft.kind, ...(done.queued ? { purpose: draft.purpose, channel_account_id: draft.channelAccountId, template_version_id: draft.templateVersionId ?? null, attachments: draft.attachmentIds.length, links: draft.links.length } : {}) },
    });
    if (done.queued) {
      await scope.emit({
        aggregateType: CONVERSATION_RESOURCE,
        aggregateId: done.after.id,
        aggregateVersion: done.after.version,
        type: QUEUED_EVENT,
        schemaVersion: 1,
        payload: { conversation_id: done.after.id, message_id: done.messageId, channel_account_id: draft.channelAccountId, purpose: draft.purpose },
        eventKey: `${QUEUED_EVENT}:${done.messageId}`,
      });
    }
    return commandResult(scope, done.queued ? 'QUEUED' : 'RECORDED', done.after.version, done.messageId);
  }

  @Post('conversations/:conversationId/resolve')
  @HttpCode(200)
  @OperationId('resolveConversation')
  @Command({ operation: 'resolveConversation', versioned: true })
  async resolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('conversationId', ParseUUIDPipe) conversationId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    return await this.move(scope, access, conversationId, body, 'resolve');
  }

  @Post('conversations/:conversationId/reopen')
  @HttpCode(200)
  @OperationId('reopenConversation')
  @Command({ operation: 'reopenConversation', versioned: true })
  async reopen(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('conversationId', ParseUUIDPipe) conversationId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    return await this.move(scope, access, conversationId, body, 'reopen');
  }

  private async move(scope: CommandScope, access: EffectiveAccess, conversationId: string, body: { reason?: unknown }, action: 'resolve' | 'reopen'): Promise<CommandResult> {
    const reason = assertConversationReason(body);
    const { before, after } = await this.outbound.move(scope.tx, { access, membershipId: scope.tenant.membershipId, now: new Date() }, conversationId.toLowerCase(), scope.expectedVersion ?? 0, action);
    await scope.audit({
      action: action === 'resolve' ? 'conversation.resolved' : 'conversation.reopened',
      resourceType: CONVERSATION_RESOURCE,
      resourceId: after.id,
      reason,
      diff: { from_status: before.status, to_status: after.status },
    });
    const type = action === 'resolve' ? RESOLVED_EVENT : REOPENED_EVENT;
    await scope.emit({
      aggregateType: CONVERSATION_RESOURCE,
      aggregateId: after.id,
      aggregateVersion: after.version,
      type,
      schemaVersion: 1,
      payload: { conversation_id: after.id, status: after.status },
      eventKey: `${type}:${after.id}:${after.version}`,
    });
    return commandResult(scope, after.status.toUpperCase(), after.version, after.id);
  }

  @Get('conversation-conversion-options')
  @OperationId('getConversionOptions')
  async conversionOptions(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Schemas['ConversionOptions']> {
    const now = new Date();
    const options = await this.database.withTenant(tenant, (tx) => this.links.options(tx, (place) => holdsPermission(effectivePermissions(access, now, place), CONVERT)));
    return { projects: options.projects, issue_types: options.issueTypes, as_of: now.toISOString() };
  }

  @Post('conversations/:conversationId/links')
  @HttpCode(200)
  @OperationId('linkConversationResource')
  @Command({ operation: 'linkConversationResource', versioned: true })
  async link(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: Schemas['ResourceLink'],
  ): Promise<CommandResult> {
    const link = assertResourceLink(body);
    const now = new Date();
    // The agent links only what they may read themselves: the permission to read that record, held at its place (a project of another branch is not theirs to point to).
    const authorize = (type: LinkType, place: IssuePlace): void => {
      if (!holdsPermission(effectivePermissions(access, now, place), READ_OF[type])) throw new DomainError('SCOPE_DENIED', 403);
    };
    const { after } = await this.links.link(scope.tx, { access, membershipId: scope.tenant.membershipId, now }, conversationId.toLowerCase(), scope.expectedVersion ?? 0, link, authorize);
    await scope.audit({ action: 'conversation.linked', resourceType: CONVERSATION_RESOURCE, resourceId: after.id, diff: { resource_type: link.resourceType, resource_id: link.resourceId } });
    return commandResult(scope, 'LINKED', after.version, after.id);
  }

  @Post('conversations/:conversationId/issues')
  @HttpCode(201)
  @OperationId('convertConversationToIssue')
  @Command({ operation: 'convertConversationToIssue', versioned: true })
  async convert(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: Schemas['ConversationToIssue'],
  ): Promise<CommandResult> {
    const conversion = assertConversion(body);
    const now = new Date();
    // The agent turns a conversation into an issue of a project they are scoped to for the permission to convert: the same rule names the projects OMNI-09 offers.
    const authorize = (place: IssuePlace): void => {
      if (!holdsPermission(effectivePermissions(access, now, place), CONVERT)) throw new DomainError('SCOPE_DENIED', 403);
    };
    const { after, issue } = await this.links.convert(scope.tx, { access, membershipId: scope.tenant.membershipId, now }, conversationId.toLowerCase(), scope.expectedVersion ?? 0, conversion, authorize);
    // The issue is opened as the issue module opens one, with its own trail and its own event; the words of the person are in neither.
    await scope.audit({
      action: 'iss.issue_opened',
      resourceType: 'issue',
      resourceId: issue.id,
      diff: { code: issue.code, project_id: issue.projectId, owner_unit_id: issue.ownerUnitId, severity: issue.severity, source_module: issue.sourceModule, sla_policy_id: issue.policyId, response_due_at: issue.responseDueAt, due_at: issue.dueAt, geo_recorded: issue.geoRecorded },
    });
    await scope.emit({
      aggregateType: 'issue',
      aggregateId: issue.id,
      aggregateVersion: issue.version,
      type: 'iss.issue.opened.v1',
      schemaVersion: 1,
      payload: issueEventPayload(scope, issue, now, { response_due_at: issue.responseDueAt, sla_policy_id: issue.policyId, source_module: issue.sourceModule }),
      eventKey: `issue:${issue.id}:${issue.version}`,
    });
    await scope.audit({ action: 'conversation.converted_to_issue', resourceType: CONVERSATION_RESOURCE, resourceId: after.id, diff: { issue_id: issue.id, project_id: conversion.projectId, issue_type: conversion.issueType } });
    await scope.emit({
      aggregateType: CONVERSATION_RESOURCE,
      aggregateId: after.id,
      aggregateVersion: after.version,
      type: CONVERTED_EVENT,
      schemaVersion: 1,
      payload: { conversation_id: after.id, issue_id: issue.id, project_id: conversion.projectId },
      eventKey: `${CONVERTED_EVENT}:${after.id}:${after.version}`,
    });
    return commandResult(scope, 'CONVERTED', after.version, issue.id);
  }
}
