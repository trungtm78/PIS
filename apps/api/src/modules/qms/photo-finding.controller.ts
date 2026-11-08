import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PhotoFindingStore, TenantDatabase } from '@machvon/db';
import type { PhotoFindingRow } from '@machvon/db';
import { DomainError, PHOTO_FINDING_KINDS, PHOTO_FINDING_STATUSES } from '@machvon/kernel';
import type { EffectiveAccess, PhotoFindingKind, PhotoFindingMove, PhotoFindingStatus, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertWholeTenant, oneOfQuery, pageOf, todayOf } from '../gov12-support';

const RESOURCE = 'photo_finding';

const view = (row: PhotoFindingRow): Record<string, unknown> => ({
  id: row.id,
  kind: row.kind,
  first_photo_id: row.firstPhotoId,
  second_photo_id: row.secondPhotoId,
  first_project_id: row.firstProjectId,
  second_project_id: row.secondProjectId,
  metres: row.metres,
  minutes: row.minutes,
  status: row.status,
  reviewer_id: row.reviewerId,
  reason: row.reason,
  first_flagged_at: row.firstFlaggedAt,
  rule_version: row.ruleVersion,
  // The wording of the screen: a pair for a person to explain, never a statement that a photo is false.
  is_conclusion: false,
  version: row.version,
});

/**
 * The review register of site photos across projects (G4-12): the same file, or the same place at the same moment, in two projects, and the same file on two days of one project. The scan reads the registered photos with the
 * rule `PHOTO_INTEGRITY_RULE` and writes each pair once; the review is by an auditor who did not take either photo. A finding is a signal, never a conclusion. Whole tenant only.
 */
@Controller()
export class PhotoFindingController {
  private readonly store = new PhotoFindingStore();

  @Post('photo-findings/scan')
  @HttpCode(200)
  @OperationId('scanPhotoFindings')
  @Command({ operation: 'scanPhotoFindings' })
  async scan(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.scanPhotoFindings);
    const done = await this.store.scan(scope.tx, todayOf(new Date()));
    await scope.audit({ action: 'qms.photo_findings_scanned', resourceType: 'photo_finding_scan', resourceId: scope.requestId, diff: { photos: done.photos, pairs: done.pairs, created: done.created } });
    await scope.emit({ aggregateType: 'photo_finding_scan', aggregateId: scope.requestId, aggregateVersion: 1, type: 'qms.photo_findings.scanned.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, photos: done.photos, pairs: done.pairs, created: done.created, actor_id: scope.tenant.membershipId }, eventKey: `photo_finding_scan:${scope.requestId}` });
    return commandResult(scope, 'FINISHED', 1, scope.requestId);
  }

  @Post('photo-findings/:id/move')
  @HttpCode(200)
  @OperationId('movePhotoFinding')
  @Command({ operation: 'movePhotoFinding', versioned: true })
  async move(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MovePhotoFinding']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.movePhotoFinding);
    const done = await this.store.move(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.move as PhotoFindingMove, scope.tenant.membershipId, body.reason ?? null);
    await scope.audit({ action: `qms.photo_finding_${body.move.toLowerCase()}`, resourceType: RESOURCE, resourceId: done.id, diff: { status: done.status, kind: done.kind }, ...(body.reason === undefined ? {} : { reason: body.reason.trim() }) });
    await scope.emit({ aggregateType: RESOURCE, aggregateId: done.id, aggregateVersion: done.version, type: 'qms.photo_finding.moved.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, finding_id: done.id, move: body.move, status: done.status, actor_id: scope.tenant.membershipId }, eventKey: `${RESOURCE}:${done.id}:${done.version}` });
    return commandResult(scope, done.status, done.version, done.id);
  }
}

/** The review register of site photos, reads. */
@Controller()
export class PhotoFindingReadsController {
  private readonly store = new PhotoFindingStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('photo-findings')
  @OperationId('listPhotoFindings')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('kind') kind?: unknown, @Query('limit') limit?: unknown, @Query('offset') offset?: unknown): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.listPhotoFindings);
    const page = pageOf(limit, offset);
    const filter = { status: oneOfQuery<PhotoFindingStatus>(status, PHOTO_FINDING_STATUSES, 'status'), kind: oneOfQuery<PhotoFindingKind>(kind, PHOTO_FINDING_KINDS, 'kind') };
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, async (tx) => ({ rows: await this.store.list(tx, { ...filter, limit: page.limit + 1, offset: page.offset }), policy: await this.store.policy(tx, today) }));
    return {
      as_of: today,
      items: found.rows.slice(0, page.limit).map(view),
      has_more: found.rows.length > page.limit,
      rule: { version: found.policy.version, unverified: found.policy.unverified, place_metres: found.policy.policy.place_metres, moment_minutes: found.policy.policy.moment_minutes },
    };
  }

  @Get('photo-findings/:id')
  @OperationId('getPhotoFinding')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.getPhotoFinding);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.store.find(tx, id.toLowerCase());
      return row === undefined ? undefined : { row, events: await this.store.events(tx, row.id) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    return { as_of: todayOf(new Date()), ...view(found.row), history: found.events.map((event) => ({ id: event.id, move: event.move, to_status: event.toStatus, actor_id: event.actorId, reason: event.reason, at: event.at })) };
  }
}
