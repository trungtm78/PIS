import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocTransmittalStore, TenantDatabase } from '@machvon/db';
import type { DocContainerRow, DocTransmittalReading, DocTransmittalRow } from '@machvon/db';
import { CONTAINER_STATES, DomainError } from '@machvon/kernel';
import type { ContainerState, EffectiveAccess, RecipientAnswer, TenantContext, TransmittalPurpose } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertWholeTenant, holdsAnywhere, oneOfQuery, pageOf, textOrNull, todayOf, uuidQuery } from '../gov12-support';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const CONTAINER = 'doc_container';
const TRANSMITTAL = 'doc_transmittal';

const containerView = (row: DocContainerRow): Record<string, unknown> => ({
  id: row.id,
  project_id: row.projectId,
  document_id: row.documentId,
  document_kind: row.documentKind,
  revision_label: row.revisionLabel,
  title: row.title,
  content_sha256: row.contentSha256,
  state: row.state,
  author_id: row.authorId,
  state_changed_at: row.stateChangedAt,
  version: row.version,
});

const transmittalView = (row: DocTransmittalRow): Record<string, unknown> => ({
  id: row.id,
  project_id: row.projectId,
  number: row.number,
  purpose: row.purpose,
  subject: row.subject,
  message: row.message,
  sent_on: row.sentOn,
  sent_by: row.sentBy,
  review_days: row.reviewDays,
  rule_version: row.ruleVersion,
  supersedes_id: row.supersedesId,
  superseded_by_id: row.supersededById,
  version: row.version,
});

const readingView = (reading: DocTransmittalReading, today: string): Record<string, unknown> => ({
  as_of: today,
  ...transmittalView(reading.transmittal),
  items: reading.items.map((item) => ({ id: item.id, container_id: item.containerId, document_id: item.documentId, revision_label: item.revisionLabel, title: item.title, content_sha256: item.contentSha256 })),
  recipients: reading.recipients.map((entry) => ({
    id: entry.id,
    recipient_id: entry.recipientId,
    required: entry.required,
    due_on: entry.dueOn,
    extended_due_on: entry.extendedDueOn,
    extension_reason: entry.extensionReason,
    answer: entry.answer,
    answer_comment: entry.answerComment,
    answered_on: entry.answeredOn,
    review: { state: entry.review.state, due_on: entry.review.dueOn, days_left: entry.review.daysLeft, days_late: entry.review.daysLate },
  })),
  progress: { recipients: reading.progress.recipients, required: reading.progress.required, answered: reading.progress.answered, approved: reading.progress.approved, rejected: reading.progress.rejected, overdue: reading.progress.overdue, all_required_answered: reading.progress.allRequiredAnswered },
});

/**
 * Document containers and transmittals (G4-11), commands. A document of DOC is registered as a container in WIP; a transmittal sends containers to people for information, review or approval with a due day from the rule of
 * the day of sending; once sent it never changes, a recipient answers once, and a correction is a new transmittal that supersedes it. A container is published only after every required answer is in, and not by its author.
 */
@Controller()
export class TransmittalController {
  private readonly store = new DocTransmittalStore();

  @Post('doc-containers')
  @HttpCode(200)
  @OperationId('registerDocContainer')
  @Command({ operation: 'registerDocContainer' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RegisterDocContainer']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.registerDocContainer);
    const { container, created } = await this.store.registerContainer(scope.tx, { projectId: body.project_id.toLowerCase(), documentId: body.document_id.toLowerCase(), documentKind: body.document_kind, revisionLabel: body.revision_label }, scope.tenant.membershipId);
    if (created) {
      await scope.audit({ action: 'doc.container_registered', resourceType: CONTAINER, resourceId: container.id, diff: { project_id: container.projectId, document_id: container.documentId, revision_label: container.revisionLabel, content_sha256: container.contentSha256 } });
      await scope.emit({ aggregateType: CONTAINER, aggregateId: container.id, aggregateVersion: container.version, type: 'doc.container.registered.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, container_id: container.id, document_id: container.documentId, actor_id: scope.tenant.membershipId }, eventKey: `${CONTAINER}:${container.id}:registered` });
    }
    return commandResult(scope, created ? 'REGISTERED' : 'EXISTING', container.version, container.id);
  }

  @Post('doc-containers/:id/move')
  @HttpCode(200)
  @OperationId('moveDocContainer')
  @Command({ operation: 'moveDocContainer', versioned: true })
  async move(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MoveDocContainer']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.moveDocContainer);
    // Publishing is a second right: whoever may only keep the register does not publish.
    if (body.to === 'PUBLISHED') assertWholeTenant(access, PERMISSIONS.sendDocTransmittal);
    const container = await this.store.moveContainer(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.to as ContainerState, scope.tenant.membershipId, textOrNull(body.reason), todayOf(new Date()));
    await scope.audit({ action: `doc.container_${body.to.toLowerCase()}`, resourceType: CONTAINER, resourceId: container.id, diff: { state: container.state, revision_label: container.revisionLabel }, ...(body.reason === undefined ? {} : { reason: body.reason.trim() }) });
    await scope.emit({ aggregateType: CONTAINER, aggregateId: container.id, aggregateVersion: container.version, type: 'doc.container.moved.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, container_id: container.id, state: container.state, actor_id: scope.tenant.membershipId }, eventKey: `${CONTAINER}:${container.id}:${container.version}` });
    return commandResult(scope, container.state, container.version, container.id);
  }

  @Post('doc-transmittals')
  @HttpCode(200)
  @OperationId('sendDocTransmittal')
  @Command({ operation: 'sendDocTransmittal' })
  async send(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['SendDocTransmittal']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.sendDocTransmittal);
    const sent = await this.store.send(
      scope.tx,
      {
        projectId: body.project_id.toLowerCase(),
        number: body.number,
        purpose: body.purpose as TransmittalPurpose,
        subject: body.subject,
        message: textOrNull(body.message),
        containerIds: body.container_ids.map((value) => value.toLowerCase()),
        recipients: body.recipients.map((entry) => ({ membershipId: entry.membership_id.toLowerCase(), required: entry.required })),
        supersedesId: body.supersedes_id === undefined ? null : body.supersedes_id.toLowerCase(),
      },
      scope.tenant.membershipId,
      todayOf(new Date()),
    );
    const t = sent.transmittal;
    await scope.audit({ action: 'doc.transmittal_sent', resourceType: TRANSMITTAL, resourceId: t.id, diff: { number: t.number, purpose: t.purpose, sent_on: t.sentOn, items: sent.items.map((item) => ({ document_id: item.documentId, revision_label: item.revisionLabel, content_sha256: item.contentSha256 })), recipients: sent.recipients.length, review_days: t.reviewDays, rule_version: t.ruleVersion } });
    await scope.emit({ aggregateType: TRANSMITTAL, aggregateId: t.id, aggregateVersion: t.version, type: 'doc.transmittal.sent.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, transmittal_id: t.id, number: t.number, purpose: t.purpose, recipient_ids: sent.recipients.map((entry) => entry.recipientId), actor_id: scope.tenant.membershipId }, eventKey: `${TRANSMITTAL}:${t.id}:sent` });
    return commandResult(scope, 'SENT', t.version, t.id);
  }

  @Post('doc-transmittals/:id/answer')
  @HttpCode(200)
  @OperationId('answerDocTransmittal')
  @Command({ operation: 'answerDocTransmittal' })
  async answer(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AnswerDocTransmittal']): Promise<CommandResult> {
    // A recipient needs only the right to answer, on whatever scope; the store lets a person answer only a transmittal that names them.
    if (!holdsAnywhere(access, PERMISSIONS.answerDocTransmittal)) throw new DomainError('SCOPE_DENIED', 403);
    const reading = await this.store.answer(scope.tx, id.toLowerCase(), scope.tenant.membershipId, { answer: body.answer as RecipientAnswer, comment: textOrNull(body.comment) }, todayOf(new Date()));
    await scope.audit({ action: 'doc.transmittal_answered', resourceType: TRANSMITTAL, resourceId: reading.transmittal.id, diff: { answer: body.answer, required_answered: reading.progress.allRequiredAnswered, rejected: reading.progress.rejected }, ...(body.comment === undefined ? {} : { reason: body.comment.trim() }) });
    await scope.emit({ aggregateType: TRANSMITTAL, aggregateId: reading.transmittal.id, aggregateVersion: reading.transmittal.version, type: 'doc.transmittal.answered.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, transmittal_id: reading.transmittal.id, answer: body.answer, all_required_answered: reading.progress.allRequiredAnswered, actor_id: scope.tenant.membershipId }, eventKey: `${TRANSMITTAL}:${reading.transmittal.id}:answered:${scope.tenant.membershipId}` });
    return commandResult(scope, 'ANSWERED', reading.transmittal.version, reading.transmittal.id);
  }

  @Post('doc-transmittals/:id/extension')
  @HttpCode(200)
  @OperationId('extendDocTransmittal')
  @Command({ operation: 'extendDocTransmittal' })
  async extend(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ExtendDocTransmittal']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.extendDocTransmittal);
    const reading = await this.store.extend(scope.tx, id.toLowerCase(), body.recipient_id.toLowerCase(), body.due_on, body.reason, scope.tenant.membershipId, todayOf(new Date()));
    await scope.audit({ action: 'doc.transmittal_extended', resourceType: TRANSMITTAL, resourceId: reading.transmittal.id, diff: { recipient_row_id: body.recipient_id, due_on: body.due_on }, reason: body.reason.trim() });
    await scope.emit({ aggregateType: TRANSMITTAL, aggregateId: reading.transmittal.id, aggregateVersion: reading.transmittal.version, type: 'doc.transmittal.extended.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, transmittal_id: reading.transmittal.id, due_on: body.due_on, actor_id: scope.tenant.membershipId }, eventKey: `${TRANSMITTAL}:${reading.transmittal.id}:extended:${body.recipient_id}` });
    return commandResult(scope, 'EXTENDED', reading.transmittal.version, reading.transmittal.id);
  }
}

/** Document containers and transmittals, reads. A recipient reads the transmittals that name them even without the right to read all of them. */
@Controller()
export class TransmittalReadsController {
  private readonly store = new DocTransmittalStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('doc-containers')
  @OperationId('listDocContainers')
  async containers(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('project_id') projectId?: unknown, @Query('state') state?: unknown, @Query('limit') limit?: unknown, @Query('offset') offset?: unknown): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.listDocContainers);
    const page = pageOf(limit, offset);
    const filter = { projectId: uuidQuery(projectId, 'project_id'), state: oneOfQuery<ContainerState>(state, CONTAINER_STATES, 'state') };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listContainers(tx, { ...filter, limit: page.limit + 1, offset: page.offset }));
    return { as_of: todayOf(new Date()), items: rows.slice(0, page.limit).map(containerView), has_more: rows.length > page.limit };
  }

  @Get('doc-containers/:id')
  @OperationId('getDocContainer')
  async container(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.getDocContainer);
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.store.findContainer(tx, id.toLowerCase());
      return row === undefined ? undefined : { row, moves: await this.store.moves(tx, row.id), progress: await this.store.latestProgress(tx, row, today) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    return {
      as_of: today,
      ...containerView(found.row),
      moves: found.moves.map((move) => ({ id: move.id, from_state: move.fromState, to_state: move.toState, actor_id: move.actorId, transmittal_id: move.transmittalId, reason: move.reason, at: move.at })),
      latest_review: found.progress === null ? null : { required: found.progress.required, answered: found.progress.answered, approved: found.progress.approved, rejected: found.progress.rejected, overdue: found.progress.overdue, all_required_answered: found.progress.allRequiredAnswered },
    };
  }

  @Get('doc-transmittals/inbox')
  @OperationId('getDocTransmittalInbox')
  async inbox(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    if (!holdsAnywhere(access, PERMISSIONS.getDocTransmittalInbox)) throw new DomainError('SCOPE_DENIED', 403);
    const today = todayOf(new Date());
    const rows = await this.database.withTenant(tenant, (tx) => this.store.inbox(tx, tenant.membershipId, today));
    return { as_of: today, items: rows.map((row) => ({ ...transmittalView(row.transmittal), my_due_on: row.recipient.review.dueOn, my_review: { state: row.recipient.review.state, days_left: row.recipient.review.daysLeft } })) };
  }

  @Get('doc-transmittals')
  @OperationId('listDocTransmittals')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('project_id') projectId?: unknown, @Query('limit') limit?: unknown, @Query('offset') offset?: unknown): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.listDocTransmittals);
    const page = pageOf(limit, offset);
    const project = uuidQuery(projectId, 'project_id');
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, async (tx) => {
      const rows = await this.store.list(tx, { projectId: project, limit: page.limit + 1, offset: page.offset });
      const items: Array<Record<string, unknown>> = [];
      for (const row of rows.slice(0, page.limit)) {
        const reading = await this.store.read(tx, row.id, today);
        items.push({ ...transmittalView(row), progress: reading === undefined ? null : { required: reading.progress.required, answered: reading.progress.answered, rejected: reading.progress.rejected, overdue: reading.progress.overdue, all_required_answered: reading.progress.allRequiredAnswered } });
      }
      return { items, hasMore: rows.length > page.limit };
    });
    return { as_of: today, items: found.items, has_more: found.hasMore };
  }

  @Get('doc-transmittals/:id')
  @OperationId('getDocTransmittal')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const today = todayOf(new Date());
    const wholeTenant = holdsOnWholeTenant(access, PERMISSIONS.getDocTransmittal);
    const reading = await this.database.withTenant(tenant, (tx) => this.store.read(tx, id.toLowerCase(), today));
    // Whoever cannot read every transmittal reads the ones that name them; any other is answered as if it did not exist.
    if (reading === undefined || (!wholeTenant && !reading.recipients.some((entry) => entry.recipientId === tenant.membershipId))) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    return readingView(reading, today);
  }
}
