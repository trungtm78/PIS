import { Body, Controller, Get, HttpCode, Inject, Optional, Put } from '@nestjs/common';
import { AlertCoverStore, AlertGovernancePolicyReader, AlertProfileStore, AlertTraceStore, HomeWorkStore, TenantDatabase } from '@machvon/db';
import { NOTIFY_RULE_TYPE, assertValidAlertProfile, composeDigest, effectiveAlertProfile, vietnamDateOf } from '@machvon/kernel';
import type { AlertProfile, EffectiveAlertProfile, EffectiveAccess, NotifySeverity, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { coveredWork } from './alert-cover-view';
import { digestRowsOf } from './alert-notice';
import { ruleView } from './alert-support';
import { HOME_CLOCK } from './tokens';
import { workScopes } from './work-scope';

export const PROFILE_RESOURCE = 'alert_notification_profile';

const profileOf = (body: Schemas['AlertProfileInput']): AlertProfile => ({
  channels: body.channels === null || body.channels === undefined ? null : { ...(body.channels.URGENT === undefined ? {} : { URGENT: body.channels.URGENT }), ...(body.channels.ACTION === undefined ? {} : { ACTION: body.channels.ACTION }), ...(body.channels.WATCH === undefined ? {} : { WATCH: body.channels.WATCH }) },
  quiet: body.quiet === null || body.quiet === undefined ? null : { from: body.quiet.from, to: body.quiet.to, weekends: body.quiet.weekends, timeZone: body.quiet.time_zone },
  digest_enabled: body.digest_enabled,
  digest_at: body.digest_at ?? null,
  push_min_severity: (body.push_min_severity ?? null) as AlertProfile['push_min_severity'],
  push_cap_per_day: body.push_cap_per_day ?? null,
  group_same_root: body.group_same_root ?? null,
});

const profileView = (profile: AlertProfile): Record<string, unknown> => ({
  channels: profile.channels,
  quiet: profile.quiet === null ? null : { from: profile.quiet.from, to: profile.quiet.to, weekends: profile.quiet.weekends, time_zone: profile.quiet.timeZone },
  digest_enabled: profile.digest_enabled,
  digest_at: profile.digest_at,
  push_min_severity: profile.push_min_severity,
  push_cap_per_day: profile.push_cap_per_day,
  group_same_root: profile.group_same_root,
});

const effectiveView = (effective: EffectiveAlertProfile): Record<string, unknown> => ({
  channels: effective.channels,
  quiet: { from: effective.quiet.from, to: effective.quiet.to, weekends: effective.quiet.weekends, time_zone: effective.quiet.timeZone },
  digest_enabled: effective.digestEnabled,
  digest_at: effective.digestAt,
  push_min_severity: effective.pushMinSeverity,
  push_cap_per_day: effective.pushCapPerDay,
  group_same_root: effective.groupSameRoot,
  own: { channels: effective.own.channels, quiet: effective.own.quiet, digest_at: effective.own.digestAt, push_min_severity: effective.own.pushMinSeverity, push_cap_per_day: effective.own.pushCapPerDay, group_same_root: effective.own.groupSameRoot },
});

/**
 * How a person is reached about alerts (roadmap G2-5, NOT-18): their profile (channels by severity, quiet hours and weekends, the morning digest, the lowest severity pushed, the cap of the day), laid over the policy `ALERT_NOTIFY_POLICY` with the
 * values that are in force and whose they are; and the preview of the digest card. The profile is replaced whole under one version; the bell of the application cannot be switched off, an item to be watched cannot be pushed and the cap cannot be
 * raised above the policy (422 ALERT_PROFILE_INVALID, naming the field). The quiet hours of the alert profile win for alerts; the ones of NOT-03 keep serving the other notifications.
 */
@Controller()
export class AlertProfileController {
  private readonly profiles = new AlertProfileStore();
  private readonly policies = new AlertGovernancePolicyReader();
  private readonly trace = new AlertTraceStore();
  private readonly covers = new AlertCoverStore();
  private readonly work = new HomeWorkStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('me/alert-profile')
  @OperationId('getMyAlertProfile')
  async get(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const policies = await this.policies.read(tx, vietnamDateOf(now));
      const stored = await this.profiles.get(tx, tenant.membershipId);
      return {
        profile: profileView(stored.profile),
        effective: effectiveView(effectiveAlertProfile(policies.notify, stored.profile, stored.ownQuiet)),
        own_quiet: stored.ownQuiet === null ? null : { from: stored.ownQuiet.from, to: stored.ownQuiet.to, time_zone: stored.ownQuiet.timeZone },
        rule: ruleView(await this.policies.info(tx, NOTIFY_RULE_TYPE, vietnamDateOf(now))),
        version: stored.version,
        as_of: now.toISOString(),
      };
    });
  }

  @Put('me/alert-profile')
  @HttpCode(200)
  @OperationId('updateMyAlertProfile')
  @Command({ operation: 'updateMyAlertProfile', versioned: true })
  async update(@Scope() scope: CommandScope, @Body() body: Schemas['AlertProfileInput']): Promise<CommandResult> {
    const now = this.clock();
    const policies = await this.policies.read(scope.tx, vietnamDateOf(now));
    const profile = profileOf(body);
    assertValidAlertProfile(profile, policies.notify);
    const membershipId = scope.tenant.membershipId;
    const version = await this.profiles.put(scope.tx, membershipId, profile, scope.expectedVersion ?? 0);
    const channels = profile.channels === null ? 0 : Object.values(profile.channels).reduce((sum, list) => sum + (list?.length ?? 0), 0);
    await scope.audit({
      action: 'home.alert_profile_updated',
      resourceType: PROFILE_RESOURCE,
      resourceId: membershipId,
      classification: 'PERSONAL',
      diff: { channels_chosen: channels, quiet_hours: profile.quiet === null ? 'POLICY' : 'OWN', digest_enabled: profile.digest_enabled, push_min_severity: profile.push_min_severity, push_cap_per_day: profile.push_cap_per_day, group_same_root: profile.group_same_root, version, policy_version: policies.versions.notify },
    });
    await scope.emit({
      aggregateType: PROFILE_RESOURCE,
      aggregateId: membershipId,
      aggregateVersion: version,
      type: 'home.alert_profile_updated.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: membershipId, occurred_at: now.toISOString(), membership_id: membershipId, version, policy_version: policies.versions.notify },
      eventKey: `alert_profile:${membershipId}:${version}`,
    });
    return commandResult(scope, 'Updated', version, membershipId);
  }

  /** What the morning card would hold now: what is overdue, what falls due within the days of the policy, what is new since the last digest and what waits for the person as a deputy. */
  @Get('me/alert-digest')
  @OperationId('getMyAlertDigest')
  async digest(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    return this.database.withTenant(tenant, async (tx) => {
      const policies = await this.policies.read(tx, today);
      const stored = await this.profiles.get(tx, tenant.membershipId);
      const effective = effectiveAlertProfile(policies.notify, stored.profile, stored.ownQuiet);
      const collected = await this.work.collect(tx, { membershipId: tenant.membershipId, now, today, view: 'mine', mode: 'rows', ...scopes });
      const covered = await coveredWork(tx, this.work, { deputyId: tenant.membershipId, now, today, edges: await this.covers.liveEdges(tx, now), spans: await this.covers.absenceSpans(tx, now), unitScope: scopes.unitScope, projectScope: scopes.projectScope, holds: scopes.holds, mode: 'rows' });
      const last = await this.profiles.lastDigestAt(tx, tenant.membershipId);
      const firstSeen = await this.trace.firstSeenOf(tx, tenant.membershipId);
      const rows = digestRowsOf([...collected.rows, ...covered.rows], firstSeen);
      const digest = composeDigest(rows, { today, lookaheadDays: policies.notify.digest_lookahead_days, maxLines: policies.notify.digest_max_lines, newSince: last === null ? null : last.toISOString() });
      return {
        sections: digest.sections.map((section) => ({
          code: section.code,
          count: section.count,
          lines: section.lines.map((line) => ({ source: line.source, id: line.id, title: line.title, subtitle: line.subtitle, severity: line.severity as NotifySeverity, due_on: line.dueOn, consequence: line.consequence, action: line.action, on_behalf_of: line.onBehalfOf })),
        })),
        total: digest.total,
        omitted: digest.omitted,
        digest_at: effective.digestAt,
        last_digest_at: last === null ? null : last.toISOString(),
        unavailable_sources: [...new Set([...collected.unavailableSources, ...covered.unavailableSources])],
        as_of: now.toISOString(),
      };
    });
  }
}
