import { Body, Controller, Get, HttpCode, Inject, Put, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PwfDeadlinePreferenceStore, PwfMyTaskReads, TenantDatabase, projectScope } from '@machvon/db';
import { DomainError, pwfDeadlineBand } from '@machvon/kernel';
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
import { queryText } from './pwf-support';

/** The profile of alerts of a person holds their own days for the three colours (V3005); the audit and the event name the person's own row. */
export const PREFERENCE_RESOURCE = 'alert_notification_profile';

const wholeDay = (value: unknown, field: string): number | undefined => {
  const text = queryText(value, field);
  if (text === undefined) return undefined;
  if (!/^-?\d{1,5}$/.test(text)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return Number(text);
};

/** A level of the body: a whole number, or nothing (null, absent): the official one. */
const levelOf = (value: unknown, field: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new DomainError('DEADLINE_BAND_THRESHOLDS_INVALID', 422, field);
  return value;
};

/**
 * The tier of the person in the three colours of the deadlines of project tasks (PWF-15, MOB-80, MOB-82; BR-PWF-23, R40): the days at which THEY want green, yellow and red to start and their extra reminder days (earlier than the official ones,
 * never later), the preview of what a ladder does, and "my tasks" by deadline with the official colour beside the colour of their own ladder. None of it changes the official colour, the escalation or a KPI.
 */
@Controller()
export class PwfPreferenceController {
  private readonly preferences = new PwfDeadlinePreferenceStore();
  private readonly myTasks = new PwfMyTaskReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('me/deadline-preference')
  @OperationId('getDeadlinePreference')
  async get(@CurrentTenant() tenant: TenantContext): Promise<Schemas['PwfDeadlinePreference']> {
    const now = new Date();
    const reading = await this.database.withTenant(tenant, (tx) => this.preferences.read(tx, tenant.membershipId, now));
    return {
      green_days: reading.green_days,
      yellow_days: reading.yellow_days,
      red_days: reading.red_days,
      reminder_days: reading.reminder_days,
      official: reading.official,
      clamped: reading.clamped,
      version: reading.version,
      as_of: now.toISOString(),
    } as Schemas['PwfDeadlinePreference'];
  }

  @Put('me/deadline-preference')
  @HttpCode(200)
  @OperationId('setDeadlinePreference')
  @Command({ operation: 'setDeadlinePreference', versioned: true })
  async set(@Scope() scope: CommandScope, @Body() body: Schemas['PwfDeadlinePreference']): Promise<CommandResult> {
    const now = new Date();
    const reminders = body.reminder_days ?? [];
    if (!Array.isArray(reminders)) throw new DomainError('VALIDATION_FAILED', 422, 'reminder_days');
    const input: pwfDeadlineBand.PersonalPreference = {
      green_days: levelOf(body.green_days, 'green_days'),
      yellow_days: levelOf(body.yellow_days, 'yellow_days'),
      red_days: levelOf(body.red_days, 'red_days'),
      reminder_days: reminders.map((value) => {
        if (typeof value !== 'number' || !Number.isInteger(value)) throw new DomainError('DEADLINE_BAND_THRESHOLDS_INVALID', 422, 'reminder_days');
        return value;
      }),
    };
    const membershipId = scope.tenant.membershipId;
    const version = await this.preferences.save(scope.tx, membershipId, input, scope.expectedVersion ?? 0, now);
    // The audit and the event keep days only: which levels the person moved and by how many days is theirs; no words, no one else's data.
    const facts = { green_days: input.green_days, yellow_days: input.yellow_days, red_days: input.red_days, reminder_days: input.reminder_days, cleared: input.green_days === null && input.yellow_days === null && input.red_days === null && input.reminder_days.length === 0 };
    await scope.audit({ action: 'pwf.deadline_preference_set', resourceType: PREFERENCE_RESOURCE, resourceId: membershipId, classification: 'PERSONAL', diff: { ...facts, version } });
    await scope.emit({
      aggregateType: PREFERENCE_RESOURCE,
      aggregateId: membershipId,
      aggregateVersion: version,
      type: 'pwf.deadline_preference.set.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: membershipId, occurred_at: now.toISOString(), membership_id: membershipId, ...facts, version },
      eventKey: `deadline_preference:${membershipId}:${version}`,
    });
    return commandResult(scope, 'Updated', version, membershipId);
  }

  /** What a ladder does at the days that matter, before anybody saves it (PWF-08, PWF-15): pure, nothing is read or written. */
  @Get('pwf/deadline-band/preview')
  @OperationId('previewDeadlineBand')
  preview(@Query() query: Record<string, unknown>): Schemas['PwfBandPreview'] {
    const yellow = wholeDay(query.yellow_days, 'yellow_days');
    const red = wholeDay(query.red_days, 'red_days');
    if (yellow === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'yellow_days');
    if (red === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'red_days');
    const green = wholeDay(query.green_days, 'green_days');
    const unit = queryText(query.unit, 'unit') ?? 'WORKING';
    if (!(pwfDeadlineBand.DEADLINE_UNITS as readonly string[]).includes(unit)) throw new DomainError('VALIDATION_FAILED', 422, 'unit');
    const remaining = wholeDay(query.remaining_days, 'remaining_days');
    const thresholds: pwfDeadlineBand.BandThresholds = { green_days: green ?? null, yellow_days: yellow, red_days: red };
    return { unit, thresholds, examples: pwfDeadlineBand.previewBandExamples(thresholds, remaining === undefined ? [] : [remaining]), as_of: new Date().toISOString() } as Schemas['PwfBandPreview'];
  }

  @Get('me/project-tasks')
  @OperationId('getMyTasks')
  async tasks(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfMyTaskPage']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    const found = await this.database.withTenant(tenant, (tx) =>
      this.myTasks.list(tx, projectScope(access, PERMISSIONS.getMyTasks, now), tenant.membershipId, { band: queryText(query.band, 'band'), status: queryText(query.status, 'status'), dueBefore: queryText(query.due_before, 'due_before') }, { limit: page.limit, after: page.after }, now),
    );
    const { next, ...rest } = found as { next: { code: string; id: string } | null } & Record<string, unknown>;
    return { ...rest, next_cursor: next === null ? null : encodeCursor(next) } as unknown as Schemas['PwfMyTaskPage'];
  }
}
