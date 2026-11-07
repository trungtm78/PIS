import { Body, Controller, Get, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { HomeWorkStore, TenantDatabase, WORK_CALENDAR_CODE, WorkPolicyReader } from '@machvon/db';
import { DomainError, EXISTING_CLOCKS, WORK_POLICY_DEFAULT_CODE, WORK_POLICY_RULE_TYPES, activePause, evaluatePause, provenanceOf, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_CLOCK } from './tokens';
import { WorkActionSupport, invalid } from './work-action-support';
import { existingClockView, snoozeView } from './work-action-view';
import { canReadScope, workScopes } from './work-scope';

/**
 * The clocks of an item of the alert centre (G2-2): the clocks can be paused, but only with a reason from the policy, in words, until a day no further than the policy lets, and with the name of a person who allowed it (an active
 * member of a unit the caller may read, never the caller). A pause and its end (`resumeWorkClock`) are rows of `work_action`, so the history is whole; the clocks of the item (and the end of a native clock) move by the working time that
 * was paused. Besides, the list of what is put off now in the scope of the reader (G2-1, for the leader who watches that nothing is hidden for ever) and the policies that judge the clocks, with their version and source.
 */
@Controller()
export class WorkActionClockController {
  private readonly support = new WorkActionSupport();
  private readonly work = new HomeWorkStore();
  private readonly policies = new WorkPolicyReader();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('home/work-actions/pause')
  @HttpCode(200)
  @OperationId('pauseWorkClock')
  @Command({ operation: 'pauseWorkClock' })
  async pause(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['WorkClockPause']): Promise<CommandResult> {
    const now = this.clock();
    const until = new Date(body.paused_until);
    if (Number.isNaN(until.getTime())) throw invalid('paused_until');
    const row = await this.support.find(scope, access, body, now);
    const state = await this.support.stateOf(scope, row, now);
    if (activePause(state?.pauses ?? [], now) !== null) throw new DomainError('WORK_CLOCK_ALREADY_PAUSED', 409, 'source_id');
    const policies = await this.support.policiesAt(scope, now);
    const verdict = evaluatePause(policies.clock, { reasonCode: body.reason_code, reason: body.reason, allowedBy: body.allowed_by_id, actor: scope.tenant.membershipId, until, now });
    if (!verdict.ok) throw new DomainError(verdict.code, 422, verdict.field);
    await this.assertAllower(scope, access, body.allowed_by_id, now);
    const recorded = await this.support.actions.record(scope.tx, {
      source: row.source,
      sourceId: row.id,
      action: 'PAUSE_CLOCK',
      actor: scope.tenant.membershipId,
      reason: body.reason,
      reasonCode: body.reason_code,
      allowedBy: body.allowed_by_id.toLowerCase(),
      pausedUntil: until.toISOString(),
      policyVersion: policies.versions.clock,
    });
    return this.support.finish(scope, row, 'PAUSE_CLOCK', recorded.id, now, {
      paused_until: until.toISOString(),
      reason_code: body.reason_code,
      reason_length: body.reason.trim().length,
      allowed_by_id: body.allowed_by_id.toLowerCase(),
      policy_version: policies.versions.clock,
    });
  }

  @Post('home/work-actions/resume')
  @HttpCode(200)
  @OperationId('resumeWorkClock')
  @Command({ operation: 'resumeWorkClock' })
  async resume(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['WorkClockResume']): Promise<CommandResult> {
    const now = this.clock();
    const row = await this.support.find(scope, access, body, now);
    const state = await this.support.stateOf(scope, row, now);
    const held = activePause(state?.pauses ?? [], now);
    if (held === null) throw new DomainError('WORK_CLOCK_NOT_PAUSED', 409, 'source_id');
    const recorded = await this.support.actions.record(scope.tx, { source: row.source, sourceId: row.id, action: 'RESUME_CLOCK', actor: scope.tenant.membershipId, reason: body.reason });
    return this.support.finish(scope, row, 'RESUME_CLOCK', recorded.id, now, { paused_from: held.from, paused_until: held.until, reason_length: body.reason === undefined ? 0 : body.reason.trim().length });
  }

  /** What is put off now inside what the reader may read: who put it off, until when, why, which one of the series, and how many are allowed; the one who has no scope to read has no list to see (403 SCOPE_DENIED). */
  @Get('home/work-actions/snoozed')
  @OperationId('getSnoozedWork')
  async snoozed(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = this.clock();
    if (!canReadScope(access, now)) throw new DomainError('SCOPE_DENIED', 403);
    const today = vietnamDateOf(now);
    const { collection, policies } = await this.database.withTenant(tenant, async (tx) => ({
      collection: await this.work.collect(tx, { membershipId: tenant.membershipId, now, today, view: 'scope', mode: 'count', includeHidden: true, ...workScopes(access, now) }),
      policies: await this.policies.read(tx, today),
    }));
    const { rows, truncated, unavailableSources } = collection;
    const held = rows.filter((row) => row.snooze !== null).sort((left, right) => Date.parse(left.snooze?.until ?? '') - Date.parse(right.snooze?.until ?? '') || left.id.localeCompare(right.id, 'en'));
    return {
      items: held.map((row) => ({
        source: row.source,
        source_id: row.id,
        kind: row.kind,
        title: row.title,
        subtitle: row.subtitle,
        severity: row.severity,
        due_on: row.dueOn,
        target: row.target,
        snooze: row.snooze === null ? null : snoozeView(row.snooze, policies),
        snooze_count: row.consecutiveSnoozes,
      })),
      count: held.length,
      truncated,
      unavailable_sources: unavailableSources,
      policy_version: policies.versions.snooze,
      as_of: now.toISOString(),
    };
  }

  /** The policies that judge the clocks, as they are in force today, each with its version, whether the numbers are confirmed, the formula and the source; and the clocks the modules already keep, wrapped as they are. */
  @Get('home/work-clocks/policies')
  @OperationId('getWorkClockPolicies')
  async clockPolicies(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const year = Number(today.slice(0, 4));
    const { policies, years } = await this.database.withTenant(tenant, async (tx) => ({
      policies: await this.policies.read(tx, today),
      years: await tx.query<{ year: number }>(`select year from machvon.work_calendar_version where calendar_code = $1 and status = 'Published' and year between $2::int and $3::int order by year`, [WORK_CALENDAR_CODE, year - 1, year + 2]),
    }));
    const published = new Set(years.map((entry) => Number(entry.year)));
    const describe = (type: string, params: unknown, version: string, unverified: boolean): Record<string, unknown> => ({ type, code: WORK_POLICY_DEFAULT_CODE, version, unverified, params, ...provenanceView(type) });
    return {
      as_of: now.toISOString(),
      policies: [
        describe(WORK_POLICY_RULE_TYPES.snooze, policies.snooze, policies.versions.snooze, policies.unverified.snooze),
        describe(WORK_POLICY_RULE_TYPES.clock, policies.clock, policies.versions.clock, policies.unverified.clock),
        describe(WORK_POLICY_RULE_TYPES.reminder, policies.reminder, policies.versions.reminder, policies.unverified.reminder),
      ],
      existing_clocks: EXISTING_CLOCKS.map((clock) => ({ source: clock.source, ...existingClockView(clock) })),
      calendar: { code: WORK_CALENDAR_CODE, years: [year - 1, year, year + 1, year + 2].map((entry) => ({ year: entry, published: published.has(entry) })) },
    };
  }

  /** The person who allowed a pause: an active member of a unit the caller may read, and not the caller. */
  private async assertAllower(scope: CommandScope, access: EffectiveAccess, allowedBy: string, now: Date): Promise<void> {
    const units = workScopes(access, now).unitScope(2);
    const found = await scope.tx.query<{ id: string }>(
      `select m.id from machvon.membership m join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id
        where m.id = $1::uuid and m.status = 'Active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now()) and ${units.sql}`,
      [allowedBy.toLowerCase(), ...units.params],
    );
    if (found.length === 0) throw new DomainError('WORK_CLOCK_ALLOWER_INVALID', 422, 'allowed_by_id');
  }
}

function provenanceView(type: string): Record<string, unknown> {
  const provenance = provenanceOf(type, WORK_POLICY_DEFAULT_CODE);
  return provenance === undefined ? {} : { formula: provenance.formula, source: provenance.source, as_of_rule: provenance.asOf, legal_status: provenance.legalStatus };
}
