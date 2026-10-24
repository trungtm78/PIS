import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase, WorkCalendarStore, calendarCursorKey } from '@machvon/db';
import type { WorkCalendarRow } from '@machvon/db';
import { DomainError, validateWorkCalendar } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from './tenant-authority';

const MANAGE_PERMISSION = PERMISSIONS.createWorkCalendarVersion;
const READ_PERMISSION = PERMISSIONS.get_resources_work_calendar_version;
const RESOURCE_TYPE = 'work_calendar_version';

/** The working calendar is tenant administration (ADM 3.8): it is not owned by one organisation unit, so only a grant on the whole tenant reaches it. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/**
 * Working calendar version commands (ST-ADM-010, ADM 3.8). A draft changes nothing; publishing makes the version the one
 * every deadline created afterwards is counted by, and supersedes the version of the same calendar year. A deadline
 * already counted never moves: the module that stored it keeps the version it was counted by.
 */
@Controller('work-calendars')
export class WorkCalendarsController {
  private readonly store = new WorkCalendarStore();

  @Post()
  @OperationId('createWorkCalendarVersion')
  @Command({ operation: 'createWorkCalendarVersion' })
  async create(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Body() body: Schemas['WorkCalendarDraft'],
  ): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    validateWorkCalendar(body);
    const created = await this.store.createDraft(scope.tx, body, scope.tenant.membershipId);
    await scope.audit({
      action: 'work_calendar.create',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: 'PUBLIC',
      diff: {
        calendar_code: body.calendar_code,
        year: body.year,
        revision: created.revision,
        working_days: body.working_days,
        holidays: body.holidays.length,
        compensated_workdays: body.compensated_workdays?.length ?? 0,
      },
    });
    return commandResult(scope, 'DRAFTED', created.version, created.id);
  }

  @Post(':calendarId/publish')
  @HttpCode(200)
  @OperationId('publishWorkCalendar')
  @Command({ operation: 'publishWorkCalendar', versioned: true })
  async publish(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('calendarId', ParseUUIDPipe) calendarId: string,
    @Body() body: Schemas['ReasonOnly'],
  ): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const draft = await this.store.lockDraft(scope.tx, calendarId, scope.expectedVersion ?? 0);
    const { version, supersededId } = await this.store.publish(scope.tx, draft, scope.tenant.membershipId);
    await scope.audit({
      action: 'work_calendar.publish',
      resourceType: RESOURCE_TYPE,
      resourceId: calendarId,
      reason: body.reason,
      classification: 'PUBLIC',
      diff: { calendar_code: draft.content.calendar_code, year: draft.content.year, revision: draft.revision, superseded_id: supersededId ?? null },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: calendarId,
      aggregateVersion: version,
      type: 'adm.work_calendar.published.v1',
      schemaVersion: 1,
      payload: { id: calendarId, calendar_code: draft.content.calendar_code, year: draft.content.year, revision: draft.revision },
      eventKey: `${RESOURCE_TYPE}:${calendarId}:${version}`,
    });
    return commandResult(scope, 'PUBLISHED', version, calendarId);
  }
}

/** openapi.json get_resources_work_calendar_version item. */
function viewOf(row: WorkCalendarRow): Record<string, unknown> {
  return {
    id: row.id,
    calendar_code: row.content.calendar_code,
    year: row.content.year,
    revision: row.revision,
    working_days: [...row.content.working_days],
    holidays: row.content.holidays.map((holiday) => ({ ...holiday })),
    compensated_workdays: [...(row.content.compensated_workdays ?? [])],
    legal_basis_ref: row.content.legal_basis_ref,
    status: row.status,
    created_by: row.createdBy,
    published_by: row.publishedBy,
    published_at: row.publishedAt,
    version: row.version,
  };
}

/** Reads of the working calendar versions (get_resources_work_calendar_version and its id form): newest year first, tenant-wide. */
@Controller('resources/work_calendar_version')
export class WorkCalendarReadsController {
  private readonly store = new WorkCalendarStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_work_calendar_version')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) return { items: [], next_cursor: null };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(viewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: calendarCursorKey(last), id: last.id }) : null,
    };
  }

  @Get(':id')
  @OperationId('get_resources_work_calendar_version_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return viewOf(row);
  }
}
