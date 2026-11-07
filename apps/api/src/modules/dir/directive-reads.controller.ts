import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DIRECTIVE_READ_LIMIT, DirDirectiveStore, DirectivePolicyReader, SCOPE_FROM, TenantDatabase, directiveScope, meetingScope, projectScope } from '@machvon/db';
import type { DirectiveFilter, DirectiveLine } from '@machvon/db';
import { DomainError, directiveStatusOf, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { reaches } from '../ctr/contract.controller';
import { directiveDetailView, directiveLineView, meetingLineView, placesOf, policyView, reportView, summaryView } from './directive-view';

const READ_PERMISSION = PERMISSIONS.getDirective;
const WIDGET_ITEMS = 5;

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new DomainError('VALIDATION_FAILED', 422, field);
}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function statusOf(value: unknown): DirectiveFilter['status'] {
  if (value === undefined) return undefined;
  const status = directiveStatusOf(value);
  if (status === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  return status;
}

const ANCHOR = /^([012])\|(\d{4}-\d{2}-\d{2})$/;

/** The position of the cursor in the order of the list: whether the directive is overdue, its due day and its id. */
function anchorOf(cursor: { code: string; id: string } | undefined): { rank: number; dueOn: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const match = ANCHOR.exec(cursor.code);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { rank: Number(match[1]), dueOn: match[2] as string, id: cursor.id };
}

interface Page {
  items: Array<Record<string, unknown>>;
  next_cursor: string | null;
  as_of: string;
}

/**
 * The directives in the scope of the caller (DIR-03, DIR-04, DIR-05; CN.03 and QT.02): a list the late ones lead, the overdue ones alone, a project's, the counts, the directives of a period as the input of the
 * next report, the data of the dashboard widget, and one directive with its timeline. A directive outside the scope, or of another tenant, does not exist for the caller (404). The status a reader sees is computed on
 * the day of the read (OVERDUE is an open directive past its due day); the numbers say how they are counted.
 */
@Controller()
export class DirectiveReadsController {
  private readonly store = new DirDirectiveStore();
  private readonly policy = new DirectivePolicyReader();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private async page(tenant: TenantContext, access: EffectiveAccess, filter: DirectiveFilter, limit: unknown, cursor: unknown): Promise<Page> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const today = vietnamDateOf(now);
    const lines = await this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policy.get(tx, today);
      return this.store.list(tx, directiveScope(access, READ_PERMISSION, now), filter, { limit: request.limit + 1, after: anchorOf(request.after) }, today, policy.params);
    });
    const shown = lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const anchor = last === undefined ? undefined : this.store.anchorOf(last, today);
    return { items: shown.map(directiveLineView), next_cursor: lines.length > request.limit && anchor !== undefined ? encodeCursor({ code: `${anchor.rank}|${anchor.dueOn}`, id: anchor.id }) : null, as_of: now.toISOString() };
  }

  @Get('directives')
  @OperationId('listDirectives')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('meeting_id') meetingId?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('assignee_membership_id') assignee?: unknown,
    @Query('assigned_to_me') assignedToMe?: unknown,
    @Query('overdue') overdue?: unknown,
    @Query('due_from') dueFrom?: unknown,
    @Query('due_to') dueTo?: unknown,
    @Query('q') q?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Page> {
    const mine = flag(assignedToMe, 'assigned_to_me');
    const filter: DirectiveFilter = {
      status: statusOf(status),
      meetingId: text(meetingId, 'meeting_id'),
      projectId: text(projectId, 'project_id'),
      unitId: text(unitId, 'unit_id'),
      assigneeMembershipId: mine === true ? tenant.membershipId : text(assignee, 'assignee_membership_id'),
      overdue: flag(overdue, 'overdue'),
      dueFrom: text(dueFrom, 'due_from'),
      dueTo: text(dueTo, 'due_to'),
      q: text(q, 'q'),
    };
    return this.page(tenant, access, filter, limit, cursor);
  }

  @Get('directives/overdue')
  @OperationId('listOverdueDirectives')
  async overdue(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('unit_id') unitId?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Page> {
    return this.page(tenant, access, { overdue: true, unitId: text(unitId, 'unit_id'), projectId: text(projectId, 'project_id') }, limit, cursor);
  }

  @Get('directives/summary')
  @OperationId('getDirectiveSummary')
  async summary(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') projectId?: unknown,
    @Query('meeting_id') meetingId?: unknown,
    @Query('unit_id') unitId?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const { summary, policy } = await this.database.withTenant(tenant, async (tx) => {
      const reading = await this.policy.get(tx, today);
      return { policy: reading, summary: await this.store.summary(tx, directiveScope(access, READ_PERMISSION, now), { projectId: text(projectId, 'project_id'), meetingId: text(meetingId, 'meeting_id'), unitId: text(unitId, 'unit_id') }, today, reading.params) };
    });
    return summaryView(summary, policy, now.toISOString());
  }

  @Get('directives/for-report')
  @OperationId('getDirectivesForReport')
  async forReport(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('unit_id') unitId?: unknown,
  ): Promise<Record<string, unknown>> {
    const start = text(from, 'from');
    const end = text(to, 'to');
    if (start === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'from');
    if (end === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'to');
    const now = new Date();
    const report = await this.database.withTenant(tenant, (tx) => this.store.forReport(tx, directiveScope(access, READ_PERMISSION, now), { from: start, to: end }, { projectId: text(projectId, 'project_id'), unitId: text(unitId, 'unit_id') }));
    return reportView(report, now.toISOString());
  }

  @Get('directives/widget')
  @OperationId('getDirectiveWidget')
  async widget(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const scope = directiveScope(access, READ_PERMISSION, now);
    const { summary, lines, policy } = await this.database.withTenant(tenant, async (tx) => {
      const reading = await this.policy.get(tx, today);
      return {
        policy: reading,
        summary: await this.store.summary(tx, scope, {}, today, reading.params),
        lines: await this.store.list(tx, scope, { overdue: true }, { limit: WIDGET_ITEMS, after: undefined }, today, reading.params),
      };
    });
    return {
      counts: { overdue: summary.byStatus.OVERDUE, due_soon: summary.dueSoon, escalated: summary.escalated, open: summary.byStatus.OPEN + summary.byStatus.IN_PROGRESS },
      items: lines.map(directiveLineView),
      truncated: summary.truncated,
      definitions: { overdue: 'Chỉ đạo đang mở hoặc đang thực hiện mà hạn trước ngày hôm nay (giờ Việt Nam), trong phạm vi của người đọc; xếp quá hạn lâu nhất trước.', due_soon: 'Chỉ đạo chưa xong có hạn trong số ngày nhắc trước hạn của chính sách.', escalated: 'Chỉ đạo quá hạn từ số ngày nâng cấp của chính sách trở lên.' },
      policy: policyView(policy),
      as_of: now.toISOString(),
    };
  }

  @Get('directives/:id')
  @OperationId('getDirective')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policy.get(tx, today);
      const detail = await this.store.detail(tx, id.toLowerCase(), directiveScope(access, READ_PERMISSION, now), today, policy.params);
      return detail === undefined ? undefined : { detail, policy };
    });
    // A directive in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const line = found.detail.directive;
    return directiveDetailView(found.detail, found.policy, actionsOf(line, found.policy.params.maxExtensions, access, tenant.membershipId, now), now.toISOString());
  }

  @Get('projects/:id/directives')
  @OperationId('listProjectDirectives')
  async byProject(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Page> {
    const now = new Date();
    const predicate = projectScope(access, READ_PERMISSION, now)(2);
    const reached = await this.database.withTenant(tenant, (tx) => tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [id.toLowerCase(), ...predicate.params]));
    // A project outside the scope of the caller does not exist for them.
    if (reached[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.page(tenant, access, { projectId: id.toLowerCase(), status: statusOf(status) }, limit, cursor);
  }
}

/** The buttons of a directive: each is a command the caller may give over the places it lies in, in the state the directive is in, and not one the rule of maker and checker would refuse. */
export function actionsOf(line: DirectiveLine, maxExtensions: number, access: EffectiveAccess, viewerId: string, now: Date): Record<string, boolean> {
  const refs: ResourceRef[] = placesOf(line);
  const may = (permission: string): boolean => reaches(access, permission, refs, now);
  const live = line.storedStatus === 'OPEN' || line.storedStatus === 'IN_PROGRESS';
  const viewer = viewerId.toLowerCase();
  const pending = line.openExtension !== null;
  return {
    assign: live && may(PERMISSIONS.assignDirective),
    record_progress: live && may(PERMISSIONS.recordDirectiveProgress),
    request_extension: live && !pending && line.extensionCount < maxExtensions && may(PERMISSIONS.requestDirectiveExtension),
    decide_extension: live && line.openExtension !== null && line.openExtension.requestedBy.toLowerCase() !== viewer && may(PERMISSIONS.decideDirectiveExtension),
    close: live && !pending && viewer !== line.createdBy.membershipId.toLowerCase() && (line.assignee === null || viewer !== line.assignee.membershipId.toLowerCase()) && may(PERMISSIONS.closeDirective),
    cancel: live && !pending && may(PERMISSIONS.cancelDirective),
    reopen: !live && may(PERMISSIONS.reopenDirective),
  };
}

/** The meetings in the scope of the caller (DIR-01) and one meeting with the directives it gave (DIR-02). */
@Controller()
export class SteeringMeetingReadsController {
  private readonly store = new DirDirectiveStore();
  private readonly policy = new DirectivePolicyReader();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('steering-meetings')
  @OperationId('listSteeringMeetings')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('unit_id') unitId?: unknown,
    @Query('meeting_type') meetingType?: unknown,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Page> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const filter = { unitId: text(unitId, 'unit_id'), meetingType: text(meetingType, 'meeting_type'), from: text(from, 'from'), to: text(to, 'to') };
    const lines = await this.database.withTenant(tenant, (tx) =>
      this.store.listMeetings(tx, meetingScope(access, READ_PERMISSION, now), filter, { limit: request.limit + 1, after: request.after }, vietnamDateOf(now)),
    );
    const shown = lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(meetingLineView), next_cursor: lines.length > request.limit && last !== undefined ? encodeCursor({ code: last.meetingDate, id: last.id }) : null, as_of: now.toISOString() };
  }

  @Get('steering-meetings/:id')
  @OperationId('getSteeringMeeting')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policy.get(tx, today);
      const detail = await this.store.meetingDetail(tx, id.toLowerCase(), meetingScope(access, READ_PERMISSION, now), directiveScope(access, READ_PERMISSION, now), today, policy.params);
      return detail === undefined ? undefined : { detail, policy };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const meeting = found.detail.meeting;
    const refs: ResourceRef[] = [{ ownerUnitId: meeting.unit.id, ownerUnitPath: meeting.unitPath }];
    return {
      meeting: meetingLineView(meeting),
      directives: found.detail.directives.map(directiveLineView),
      truncated: found.detail.truncated,
      limit: DIRECTIVE_READ_LIMIT,
      actions: { add_directive: reaches(access, PERMISSIONS.addDirective, refs, now), attach_minutes: reaches(access, PERMISSIONS.attachMeetingMinutes, refs, now) },
      policy: policyView(found.policy),
      as_of: now.toISOString(),
    };
  }
}
