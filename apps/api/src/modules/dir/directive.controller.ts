import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DirDirectiveStore, DirectivePolicyReader, directiveScope, directiveUnitScope, meetingScope, projectScope } from '@machvon/db';
import type { DirectiveCommandResult, MeetingCommandResult } from '@machvon/db';
import { vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';

const MEETING_RESOURCE = 'steering_meeting';
const DIRECTIVE_RESOURCE = 'directive';
const EXTENSION_RESOURCE = 'directive_extension';
const CLASSIFICATION = 'INTERNAL';

/** The audit row and the event of a command on a meeting: ids, the day, the code and the version, never the words of the title or of the summary. */
async function recordMeeting(scope: CommandScope, done: MeetingCommandResult, action: string, type: string, now: Date, extra: Record<string, unknown> = {}): Promise<void> {
  const facts = { code: done.code, unit_id: done.unitId, meeting_date: done.meetingDate, minutes_document_version_id: done.minutesDocumentVersionId, version: done.version, ...extra };
  await scope.audit({ action, resourceType: MEETING_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: facts });
  await scope.emit({
    aggregateType: MEETING_RESOURCE,
    aggregateId: done.id,
    aggregateVersion: done.version,
    type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, meeting_id: done.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
    eventKey: `${MEETING_RESOURCE}:${done.id}:${done.version}:${action}`,
  });
}

/** The audit row and the event of a command on a directive: ids, status, days and the version; the reason is the audit `reason`, the words of the directive are not repeated. */
async function recordDirective(scope: CommandScope, done: DirectiveCommandResult, action: string, type: string, now: Date, reason: string | undefined, resource: string = DIRECTIVE_RESOURCE, resourceId: string = done.id, extra: Record<string, unknown> = {}): Promise<void> {
  const facts = { directive_id: done.directiveId, meeting_id: done.meetingId, project_id: done.projectId, code: done.code, status: done.storedStatus, due_on: done.dueOn, assignee_unit_id: done.assigneeUnitId, event_id: done.eventId, ...extra };
  await scope.audit({ action, resourceType: resource, resourceId, classification: CLASSIFICATION, ...(reason === undefined ? {} : { reason }), diff: { ...facts, version: done.version } });
  await scope.emit({
    aggregateType: resource,
    aggregateId: resourceId,
    aggregateVersion: done.version,
    type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, ...facts, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
    eventKey: `${resource}:${resourceId}:${done.version}:${action}`,
  });
}

const answer = (scope: CommandScope, done: DirectiveCommandResult): CommandResult & Record<string, unknown> => ({ ...commandResult(scope, done.status, done.version, done.id), directive_id: done.directiveId, code: done.code, due_on: done.dueOn });

/**
 * The steering meetings (roadmap CN.03 and QT.02, DIR-01, DIR-02): recording a meeting, attaching its minutes, and giving the directives it decided. Every command is audited and idempotent; a meeting is recorded by
 * a person whose grant of `directive.meeting.manage` covers the unit that held it, and a directive is given in a meeting the person manages, about a project or a unit the same grant covers.
 */
@Controller()
export class SteeringMeetingController {
  private readonly store = new DirDirectiveStore();

  @Post('steering-meetings')
  @HttpCode(200)
  @OperationId('createSteeringMeeting')
  @Command({ operation: 'createSteeringMeeting' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DirMeetingCreate']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.store.createMeeting(
      scope.tx,
      { meetingDate: body.meeting_date, meetingType: body.meeting_type, title: body.title, summary: body.summary, unitId: body.unit_id, minutesDocumentVersionId: body.minutes_document_version_id },
      scope.tenant.membershipId,
      directiveUnitScope(access, PERMISSIONS.createSteeringMeeting, now),
      vietnamDateOf(now),
    );
    await recordMeeting(scope, done, 'directive.meeting_created', 'directive.meeting_created.v1', now, { meeting_type: body.meeting_type });
    return { ...commandResult(scope, done.status, done.version, done.id), code: done.code };
  }

  @Post('steering-meetings/:id/minutes')
  @HttpCode(200)
  @OperationId('attachMeetingMinutes')
  @Command({ operation: 'attachMeetingMinutes', versioned: true })
  async minutes(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DirMeetingMinutes']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.store.attachMinutes(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.document_version_id, meetingScope(access, PERMISSIONS.attachMeetingMinutes, now));
    await recordMeeting(scope, done, 'directive.meeting_minutes_attached', 'directive.meeting_minutes_attached.v1', now);
    return { ...commandResult(scope, done.status, done.version, done.id), code: done.code };
  }

  @Post('steering-meetings/:id/directives')
  @HttpCode(200)
  @OperationId('addDirective')
  @Command({ operation: 'addDirective' })
  async add(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DirDirectiveCreate']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const permission = PERMISSIONS.addDirective;
    const done = await this.store.addDirective(
      scope.tx,
      id.toLowerCase(),
      { scopeKind: body.scope_kind, projectId: body.project_id, unitId: body.unit_id, text: body.text, assigneeUnitId: body.assignee_unit_id, assigneeMembershipId: body.assignee_membership_id, dueOn: body.due_on },
      scope.tenant.membershipId,
      { meeting: meetingScope(access, permission, now), project: projectScope(access, permission, now), unit: directiveUnitScope(access, permission, now) },
    );
    await recordDirective(scope, done, 'directive.created', 'directive.created.v1', now, undefined, DIRECTIVE_RESOURCE, done.id, { scope_kind: body.scope_kind });
    return answer(scope, done);
  }
}

/**
 * What is done with a directive after it is given (DIR-04): giving it to someone else, noting progress with documents, asking for more time and deciding that, closing it with evidence, cancelling it and
 * opening it again. The history of a directive is a timeline nobody edits; closing is for someone other than who recorded the directive and who must do it, and an extension is decided by someone other than who
 * asked, within the days and the number of times the policy (`DIRECTIVE_POLICY`) gives. Every command is audited and idempotent.
 */
@Controller()
export class DirectiveController {
  private readonly store = new DirDirectiveStore();
  private readonly policy = new DirectivePolicyReader();

  @Post('directives/:id/assignment')
  @HttpCode(200)
  @OperationId('assignDirective')
  @Command({ operation: 'assignDirective', versioned: true })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DirDirectiveAssign']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.store.assign(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { assigneeUnitId: body.assignee_unit_id, assigneeMembershipId: body.assignee_membership_id, note: body.note }, scope.tenant.membershipId, directiveScope(access, PERMISSIONS.assignDirective, now));
    await recordDirective(scope, done, 'directive.assigned', 'directive.assigned.v1', now, body.note);
    return answer(scope, done);
  }

  @Post('directives/:id/progress')
  @HttpCode(200)
  @OperationId('recordDirectiveProgress')
  @Command({ operation: 'recordDirectiveProgress' })
  async progress(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DirDirectiveProgress']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.store.recordProgress(
      scope.tx,
      id.toLowerCase(),
      { note: body.note, progressPct: body.progress_pct, evidenceDocumentVersionIds: body.evidence_document_version_ids },
      scope.tenant.membershipId,
      directiveScope(access, PERMISSIONS.recordDirectiveProgress, now),
    );
    await recordDirective(scope, done, 'directive.progress_recorded', 'directive.progress_recorded.v1', now, body.note, DIRECTIVE_RESOURCE, done.id, { progress_pct: body.progress_pct ?? null, evidence_count: body.evidence_document_version_ids?.length ?? 0 });
    return answer(scope, done);
  }

  @Post('directives/:id/extension-requests')
  @HttpCode(200)
  @OperationId('requestDirectiveExtension')
  @Command({ operation: 'requestDirectiveExtension' })
  async requestExtension(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DirExtensionRequest']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const policy = await this.policy.get(scope.tx, vietnamDateOf(now));
    const done = await this.store.requestExtension(scope.tx, id.toLowerCase(), { proposedDueOn: body.proposed_due_on, reason: body.reason }, scope.tenant.membershipId, directiveScope(access, PERMISSIONS.requestDirectiveExtension, now), policy.params);
    await recordDirective(scope, done, 'directive.extension_requested', 'directive.extension_requested.v1', now, body.reason, DIRECTIVE_RESOURCE, done.id, { extension_id: done.extensionId, proposed_due_on: body.proposed_due_on, policy_version: policy.version });
    return { ...answer(scope, done), extension_id: done.extensionId };
  }

  @Post('directive-extensions/:id/decision')
  @HttpCode(200)
  @OperationId('decideDirectiveExtension')
  @Command({ operation: 'decideDirectiveExtension', versioned: true })
  async decideExtension(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DirExtensionDecision']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const policy = await this.policy.get(scope.tx, vietnamDateOf(now));
    const done = await this.store.decideExtension(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { decision: body.decision, reason: body.reason }, scope.tenant.membershipId, directiveScope(access, PERMISSIONS.decideDirectiveExtension, now), policy.params);
    await recordDirective(scope, done, `directive.extension_${body.decision === 'approve' ? 'approved' : 'rejected'}`, 'directive.extension_decided.v1', now, body.reason, EXTENSION_RESOURCE, id.toLowerCase(), { decision: body.decision, policy_version: policy.version });
    return { ...answer(scope, done), extension_id: id.toLowerCase() };
  }

  @Post('directives/:id/closure')
  @HttpCode(200)
  @OperationId('closeDirective')
  @Command({ operation: 'closeDirective', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DirDirectiveClose']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const policy = await this.policy.get(scope.tx, vietnamDateOf(now));
    const done = await this.store.close(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { note: body.note, evidenceDocumentVersionIds: body.evidence_document_version_ids }, scope.tenant.membershipId, directiveScope(access, PERMISSIONS.closeDirective, now), policy.params);
    await recordDirective(scope, done, 'directive.closed', 'directive.closed.v1', now, body.note, DIRECTIVE_RESOURCE, done.id, { evidence_count: body.evidence_document_version_ids?.length ?? 0, policy_version: policy.version });
    return answer(scope, done);
  }

  @Post('directives/:id/cancellation')
  @HttpCode(200)
  @OperationId('cancelDirective')
  @Command({ operation: 'cancelDirective', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DirDirectiveReason']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.store.cancel(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, directiveScope(access, PERMISSIONS.cancelDirective, now));
    await recordDirective(scope, done, 'directive.cancelled', 'directive.cancelled.v1', now, body.reason);
    return answer(scope, done);
  }

  @Post('directives/:id/reopening')
  @HttpCode(200)
  @OperationId('reopenDirective')
  @Command({ operation: 'reopenDirective', versioned: true })
  async reopen(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DirDirectiveReason']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.store.reopen(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, directiveScope(access, PERMISSIONS.reopenDirective, now));
    await recordDirective(scope, done, 'directive.reopened', 'directive.reopened.v1', now, body.reason);
    return answer(scope, done);
  }
}
