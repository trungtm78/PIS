import { Body, Controller, Get, HttpCode, Inject, Optional, Param, Post, Query } from '@nestjs/common';
import { AlertCoverStore, AlertGovernancePolicyReader, TenantDatabase, WORK_SOURCES } from '@machvon/db';
import type { AbsenceRecord, CoverRecord } from '@machvon/db';
import { ABSENCE_RULE_TYPE, DomainError, absencePhaseAt, assertValidAbsence, assertValidCover, coverInForce, vietnamDateOf } from '@machvon/kernel';
import type { CoverEdge, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { edgeOf } from '@machvon/db';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { ALERT_COVER_PERMISSION, bodyId, denied, holdsPermission, invalid, notFound, pathId, person, personNames, reaches, ruleView, unitScopeOf } from './alert-support';
import { HOME_CLOCK } from './tokens';

export const ABSENCE_RESOURCE = 'alert_absence';
export const COVER_RESOURCE = 'alert_absence_cover';

/**
 * Absences, deputies and their coverage (roadmap G2-7, ADM-28). A person declares that they are away (or a person who manages covers does it for somebody in the units they may read); a deputy takes over their alerts for a period, for all sources or for
 * some, on a proposal of the absent person or of a manager; a third person allows it (never the proposer, the absent person or the deputy: 403 SELF_APPROVAL_DENIED). A cover routes attention only, never authority: what a deputy may decide in a module stays what
 * that module grants them. The rules (window, loop, depth, rank, sources) are the kernel's and are refused with the field and every defect; every change is audited (ADM-11), idempotent under its key, and under the version of the row.
 */
@Controller()
export class AlertCoverController {
  private readonly covers = new AlertCoverStore();
  private readonly policies = new AlertGovernancePolicyReader();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  /** The reader may act for the person: it is themselves, or they manage covers and the person works in a unit they may read. */
  private async mayAct(tx: CommandScope['tx'], access: EffectiveAccess, now: Date, actor: string, who: string): Promise<boolean> {
    if (who.toLowerCase() === actor.toLowerCase()) return true;
    return holdsPermission(access, now, ALERT_COVER_PERMISSION) && (await reaches(tx, access, now, ALERT_COVER_PERMISSION, who));
  }

  @Get('home/alert-absences')
  @OperationId('listAlertAbsences')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('state') stateQuery?: unknown, @Query('mine') mineQuery?: unknown): Promise<Record<string, unknown>> {
    const state = stateQuery === undefined ? 'current' : stateQuery;
    if (state !== 'current' && state !== 'all') throw invalid('state');
    if (mineQuery !== undefined && mineQuery !== 'true' && mineQuery !== 'false') throw invalid('mine');
    const mine = mineQuery === 'true';
    const now = this.clock();
    const manager = holdsPermission(access, now, ALERT_COVER_PERMISSION);
    // The absences of other people are for those who manage covers, in the units they may read; everybody sees their own and the ones they stand in for.
    if (!mine && !manager) throw denied();
    return this.database.withTenant(tenant, async (tx) => {
      const me = tenant.membershipId;
      const unitScope = mine ? () => ({ sql: 'true', params: [] }) : unitScopeOf(access, ALERT_COVER_PERMISSION, now);
      let absences = await this.covers.listAbsences(tx, { unitScope, state, now, ...(mine ? { membershipId: me } : {}) });
      if (mine) {
        const standing = await tx.query<{ absence_id: string }>(`select distinct absence_id from machvon.alert_absence_cover where deputy_membership_id = $1::uuid and status in ('PENDING', 'APPROVED') and valid_until > $2::timestamptz`, [me, now.toISOString()]);
        for (const row of standing) {
          if (absences.some((absence) => absence.id === row.absence_id)) continue;
          const found = await this.covers.findAbsence(tx, row.absence_id);
          if (found !== undefined) absences = [...absences, found];
        }
      }
      const covers = await this.covers.coversOf(tx, absences.map((absence) => absence.id));
      const pending = manager ? await this.covers.pendingCovers(tx, unitScopeOf(access, ALERT_COVER_PERMISSION, now)) : [];
      const names = await personNames(tx, [...absences.flatMap((absence) => [absence.membershipId]), ...[...covers, ...pending].flatMap((cover) => [cover.absentId, cover.deputyId])]);
      return {
        items: absences.map((absence) => absenceView(absence, covers.filter((cover) => cover.absenceId === absence.id), names, now)),
        pending_covers: pending.map((cover) => coverView(cover, names, now)),
        rule: ruleView(await this.policies.info(tx, ABSENCE_RULE_TYPE, vietnamDateOf(now))),
        as_of: now.toISOString(),
      };
    });
  }

  @Post('home/alert-absences')
  @HttpCode(200)
  @OperationId('declareAlertAbsence')
  @Command({ operation: 'declareAlertAbsence' })
  async declare(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AlertAbsenceInput']): Promise<CommandResult> {
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const target = body.membership_id === undefined ? actor : bodyId(body.membership_id, 'membership_id');
    if (!(await this.mayAct(scope.tx, access, now, actor, target))) throw denied();
    const policies = await this.policies.read(scope.tx, vietnamDateOf(now));
    const from = new Date(body.valid_from);
    const until = new Date(body.valid_until);
    assertValidAbsence({ kind: body.kind, from, until }, now, policies.absence);
    const reason = body.reason === undefined ? undefined : body.reason.trim() === '' ? undefined : body.reason.trim();
    const absence = await this.covers.declareAbsence(scope.tx, { membershipId: target, kind: body.kind, from, until, reason, declaredBy: actor });
    const facts = { membership_id: target, kind: body.kind, valid_from: absence.validFrom, valid_until: absence.validUntil, declared_for_other: target !== actor.toLowerCase(), policy_version: policies.versions.absence };
    await scope.audit({ action: 'home.alert_absence_declared', resourceType: ABSENCE_RESOURCE, resourceId: absence.id, diff: { ...facts, reason_length: reason?.length ?? 0 } });
    await scope.emit({
      aggregateType: ABSENCE_RESOURCE,
      aggregateId: absence.id,
      aggregateVersion: 1,
      type: 'home.alert_absence_declared.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: actor, occurred_at: now.toISOString(), absence_id: absence.id, ...facts },
      eventKey: `alert_absence:${absence.id}:1`,
    });
    return commandResult(scope, 'Declared', 1, absence.id);
  }

  @Post('home/alert-absences/:id/end')
  @HttpCode(200)
  @OperationId('endAlertAbsence')
  @Command({ operation: 'endAlertAbsence', versioned: true })
  async end(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id') idParam: string, @Body() body: Schemas['AlertAbsenceEnd']): Promise<CommandResult> {
    const id = pathId(idParam);
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const current = await this.covers.findAbsence(scope.tx, id);
    if (current === undefined || !(await this.mayAct(scope.tx, access, now, actor, current.membershipId))) throw notFound();
    const reason = body.reason.trim();
    if (reason.length < 3) throw invalid('reason');
    const done = await this.covers.endAbsence(scope.tx, id, scope.expectedVersion ?? 0, { actor, status: body.status, reason, now });
    const facts = { membership_id: done.absence.membershipId, status: done.absence.status, revoked_covers: done.revokedCovers.length };
    await scope.audit({ action: 'home.alert_absence_ended', resourceType: ABSENCE_RESOURCE, resourceId: id, diff: { ...facts, reason_length: reason.length, version: done.absence.version } });
    await scope.emit({
      aggregateType: ABSENCE_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.absence.version,
      type: 'home.alert_absence_ended.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: actor, occurred_at: now.toISOString(), absence_id: id, ...facts },
      eventKey: `alert_absence:${id}:${done.absence.version}`,
    });
    return commandResult(scope, done.absence.status, done.absence.version, id);
  }

  @Post('home/alert-absences/:id/covers')
  @HttpCode(200)
  @OperationId('proposeAlertCover')
  @Command({ operation: 'proposeAlertCover' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id') idParam: string, @Body() body: Schemas['AlertCoverInput']): Promise<CommandResult> {
    const id = pathId(idParam);
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const absence = await this.covers.findAbsence(scope.tx, id);
    if (absence === undefined || !(await this.mayAct(scope.tx, access, now, actor, absence.membershipId))) throw notFound();
    if (absence.status !== 'DECLARED' || new Date(absence.effectiveUntil).getTime() <= now.getTime()) throw new DomainError('ALERT_ABSENCE_STATE_INVALID', 409, 'status');
    const deputyId = bodyId(body.deputy_id, 'deputy_id');
    const policies = await this.policies.read(scope.tx, vietnamDateOf(now));
    const facts = await this.covers.personFacts(scope.tx, [absence.membershipId, deputyId], now);
    const sources = body.sources ?? [];
    const request = { deputyId, from: new Date(body.valid_from), until: new Date(body.valid_until), scopeKind: body.scope_kind, sources };
    assertValidCover(request, {
      policy: policies.absence,
      now,
      absent: facts.get(absence.membershipId) as NonNullable<ReturnType<typeof facts.get>>,
      deputy: facts.get(deputyId) as NonNullable<ReturnType<typeof facts.get>>,
      absence: { from: new Date(absence.validFrom), until: new Date(absence.effectiveUntil) },
      existing: await this.covers.liveEdges(scope.tx, now),
      knownSources: WORK_SOURCES,
    });
    const cover = await this.covers.proposeCover(scope.tx, { absence, deputyId, from: request.from, until: request.until, scopeKind: body.scope_kind, sources, requestedBy: actor });
    const diff = { absence_id: id, absent_id: absence.membershipId, deputy_id: deputyId, scope_kind: body.scope_kind, sources, valid_from: cover.validFrom, valid_until: cover.validUntil, policy_version: policies.versions.absence };
    await scope.audit({ action: 'home.alert_cover_proposed', resourceType: COVER_RESOURCE, resourceId: cover.id, diff });
    await scope.emit({
      aggregateType: COVER_RESOURCE,
      aggregateId: cover.id,
      aggregateVersion: 1,
      type: 'home.alert_cover_proposed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: actor, occurred_at: now.toISOString(), cover_id: cover.id, ...diff },
      eventKey: `alert_cover:${cover.id}:1`,
    });
    return commandResult(scope, 'Proposed', 1, cover.id);
  }

  @Post('home/alert-covers/:id/decision')
  @HttpCode(200)
  @OperationId('decideAlertCover')
  @Command({ operation: 'decideAlertCover', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id') idParam: string, @Body() body: Schemas['AlertCoverDecision']): Promise<CommandResult> {
    const id = pathId(idParam);
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw invalid('decision');
    const current = await this.covers.findCover(scope.tx, id);
    // Only a manager who reaches the unit of the absent person decides, and a cover of a unit they do not read does not exist for them.
    if (current === undefined || !(await reaches(scope.tx, access, now, ALERT_COVER_PERMISSION, current.absentId))) throw notFound();
    const note = body.note === undefined || body.note.trim() === '' ? undefined : body.note.trim();
    const done = await this.covers.moveCover(scope.tx, id, scope.expectedVersion ?? 0, body.decision, { actor, note, now });
    const facts = { absence_id: done.cover.absenceId, absent_id: done.cover.absentId, deputy_id: done.cover.deputyId, decision: body.decision, status: done.cover.status };
    await scope.audit({ action: 'home.alert_cover_decided', resourceType: COVER_RESOURCE, resourceId: id, diff: { ...facts, note_length: note?.length ?? 0, version: done.cover.version } });
    await scope.emit({
      aggregateType: COVER_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.cover.version,
      type: 'home.alert_cover_decided.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: actor, occurred_at: now.toISOString(), cover_id: id, ...facts },
      eventKey: `alert_cover:${id}:${done.cover.version}`,
    });
    return commandResult(scope, done.cover.status, done.cover.version, id);
  }

  @Post('home/alert-covers/:id/revoke')
  @HttpCode(200)
  @OperationId('revokeAlertCover')
  @Command({ operation: 'revokeAlertCover', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id') idParam: string, @Body() body: Schemas['AlertCoverRevoke']): Promise<CommandResult> {
    const id = pathId(idParam);
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const current = await this.covers.findCover(scope.tx, id);
    // The absent person (they are back), the deputy (they hand it over) or a manager who reaches the unit of the absent person.
    const party = current !== undefined && [current.absentId, current.deputyId].some((who) => who.toLowerCase() === actor.toLowerCase());
    if (current === undefined || !(party || (await this.mayAct(scope.tx, access, now, actor, current.absentId)))) throw notFound();
    const reason = body.reason.trim();
    if (reason.length < 3) throw invalid('reason');
    const done = await this.covers.moveCover(scope.tx, id, scope.expectedVersion ?? 0, 'REVOKE', { actor, note: reason, now });
    const facts = { absence_id: done.cover.absenceId, absent_id: done.cover.absentId, deputy_id: done.cover.deputyId, previous_status: done.before };
    await scope.audit({ action: 'home.alert_cover_revoked', resourceType: COVER_RESOURCE, resourceId: id, diff: { ...facts, reason_length: reason.length, version: done.cover.version } });
    await scope.emit({
      aggregateType: COVER_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.cover.version,
      type: 'home.alert_cover_revoked.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: actor, occurred_at: now.toISOString(), cover_id: id, ...facts },
      eventKey: `alert_cover:${id}:${done.cover.version}`,
    });
    return commandResult(scope, 'REVOKED', done.cover.version, id);
  }
}

/** How well an absence is covered at the later of now and its first day: all sources (an allowed cover for all in force), some sources, or none; an absence that is over or withdrawn is not judged. */
function coverageOf(absence: AbsenceRecord, covers: readonly CoverRecord[], now: Date): 'COVERED' | 'PARTIAL' | 'UNCOVERED' | 'NOT_APPLICABLE' {
  const window = { from: new Date(absence.validFrom), until: new Date(absence.effectiveUntil) };
  if (absence.status !== 'DECLARED' || absencePhaseAt(window, now) === 'OVER') return 'NOT_APPLICABLE';
  const at = new Date(Math.max(now.getTime(), window.from.getTime()));
  const edges: CoverEdge[] = covers.map(edgeOf).filter((edge) => edge.status === 'APPROVED' && edge.from.getTime() <= at.getTime() && at.getTime() < edge.until.getTime());
  if (edges.some((edge) => edge.scopeKind === 'ALL')) return 'COVERED';
  return edges.length > 0 ? 'PARTIAL' : 'UNCOVERED';
}

function coverView(cover: CoverRecord, names: ReadonlyMap<string, string | null>, now: Date): Record<string, unknown> {
  return {
    id: cover.id,
    absence_id: cover.absenceId,
    absent: person(cover.absentId, names),
    deputy: person(cover.deputyId, names),
    valid_from: cover.validFrom,
    valid_until: cover.validUntil,
    scope_kind: cover.scopeKind,
    sources: cover.sources,
    status: cover.status,
    in_force: coverInForce(edgeOf(cover), now),
    requested_by: cover.requestedBy,
    decided_by: cover.decidedBy,
    decided_at: cover.decidedAt,
    decision_note: cover.decisionNote,
    revoke_reason: cover.revokeReason,
    version: cover.version,
  };
}

function absenceView(absence: AbsenceRecord, covers: readonly CoverRecord[], names: ReadonlyMap<string, string | null>, now: Date): Record<string, unknown> {
  return {
    id: absence.id,
    membership_id: absence.membershipId,
    name: names.get(absence.membershipId) ?? absence.name,
    kind: absence.kind,
    valid_from: absence.validFrom,
    valid_until: absence.validUntil,
    effective_until: absence.effectiveUntil,
    reason: absence.reason,
    status: absence.status,
    phase: absencePhaseAt({ from: new Date(absence.validFrom), until: new Date(absence.effectiveUntil) }, now),
    coverage: coverageOf(absence, covers, now),
    covers: covers.map((cover) => coverView(cover, names, now)),
    version: absence.version,
  };
}
