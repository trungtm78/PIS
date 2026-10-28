import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { QmsPhotoStore, TenantDatabase, contractScope } from '@machvon/db';
import type { QmsPhotoLine, QmsPhotoResult } from '@machvon/db';
import { DomainError, asUuid, parseObjectKey, readExif } from '@machvon/kernel';
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
import { FileService } from '../files';

const UPLOAD_PERMISSION = PERMISSIONS.registerSitePhoto;
const READ_PERMISSION = PERMISSIONS.getSitePhotoChecks;
const RESOURCE_TYPE = 'site_photo';
const CLASSIFICATION = 'INTERNAL';

/** The flags of the checks that are not in order, by name: what a reviewer is shown to look at. Never a verdict on the photo. */
function flagsOf(checks: QmsPhotoLine['checks']): string[] {
  const flags: string[] = [];
  if (checks.time !== 'OK') flags.push(`TIME_${checks.time}`);
  if (checks.geofence !== 'INSIDE') flags.push(`GEOFENCE_${checks.geofence}`);
  if (checks.duplicate !== 'UNIQUE') flags.push(checks.duplicate);
  if (checks.exif !== 'CONSISTENT') flags.push(`EXIF_${checks.exif}`);
  return flags;
}

/** The photo as openapi.json exposes it (x-exposure dto): an allowlist. The key of the object in the storage is not shown, and a place is shown only when the person consented to keeping it. */
function photoView(line: QmsPhotoLine): Record<string, unknown> {
  return {
    id: line.id,
    project: { id: line.projectId, code: line.projectCode },
    contract: line.contractId === null ? null : { id: line.contractId, code: line.contractCode },
    site_diary_id: line.siteDiaryId,
    inspection_id: line.inspectionId,
    nonconformance_id: line.nonconformanceId,
    issue_id: line.issueId,
    file_sha256: line.fileSha256,
    scan_status: line.scanStatus,
    taken_at_exif: line.takenAtExif,
    received_at: line.receivedAt,
    geo_consent: line.geoConsent,
    place: line.place === null ? null : { lat: line.place.lat, lng: line.place.lng, accuracy_m: line.place.accuracyM, source: line.place.source },
    device_id: line.deviceId,
    device_model: line.deviceModel,
    checks: { time: line.checks.time, geofence: line.checks.geofence, duplicate: line.checks.duplicate, exif: line.checks.exif, summary: line.checks.summary },
    flags: flagsOf(line.checks),
    // The checks are aids to review; none of them says that a photo is genuine or not.
    review_note: 'REVIEW_FLAGS_ONLY',
    caption: line.caption,
    uploaded_by: { membership_id: line.uploadedBy.membershipId, display_name: line.uploadedBy.displayName },
    created_at: line.createdAt,
  };
}

/**
 * The site photo register (ST-QMS-003, QMS 3.4). A photo that was uploaded to the storage is registered with four review flags drawn from what it says about itself: when it was taken, where, whether the same file is
 * there already, whether the EXIF holds together. A flag is for a person to look at and never rejects a photo or calls it true or false. A place is kept only with the consent to it (a place sent without the consent is
 * refused with 422 `GEO_CONSENT_REQUIRED`, and the place in the EXIF of the file is not kept without it), and a registered photo is never edited. The audit rows and the events carry ids, the flags and whether the
 * person consented, never a place.
 */
@Controller()
export class PhotoController {
  private readonly photos = new QmsPhotoStore();

  constructor(@Inject(FileService) private readonly files: FileService) {}

  @Post('site-photos')
  @HttpCode(200)
  @OperationId('registerSitePhoto')
  @Command({ operation: 'registerSitePhoto' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['QmsRegisterSitePhoto']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.photos.register(
      scope.tx,
      {
        clientOperationId: body.client_operation_id,
        projectId: body.project_id,
        contractId: body.contract_id,
        siteDiaryId: body.site_diary_id,
        inspectionId: body.inspection_id,
        nonconformanceId: body.nonconformance_id,
        issueId: body.issue_id,
        objectKey: body.object_key,
        fileSha256: body.file_sha256,
        deviceId: body.device_id,
        deviceModel: body.device_model,
        deviceGpsLat: body.device_gps_lat,
        deviceGpsLng: body.device_gps_lng,
        deviceGpsAccuracyM: body.device_gps_accuracy_m,
        geoConsent: body.geo_consent,
        caption: body.caption,
      },
      scope.tenant.membershipId,
      { update: contractScope(access, UPLOAD_PERMISSION, now), read: contractScope(access, READ_PERMISSION, now) },
      now,
      async () => {
        // The file must be a photo that this tenant uploaded for this purpose; the project is judged first, so that a reference to another tenant looks like one that does not exist.
        const parts = parseObjectKey(body.object_key);
        if (parts === undefined || parts.tenantId !== scope.tenant.tenantId || parts.kind !== 'site_photo') throw new DomainError('VALIDATION_FAILED', 422, 'object_key');
        // The file is read from the storage (404 for a key that is not this tenant's, 422 FILE_NOT_CLEAN, 409 SCAN_PENDING) and its hash is the one of the bytes, not the one the client says.
        const stored = await this.files.download(scope.tenant, body.object_key);
        return { sha256: createHash('sha256').update(stored.bytes).digest('hex'), exif: readExif(stored.bytes) };
      },
    );
    await this.written(scope, done, now);
    return commandResult(scope, done.checks.summary, 1, done.id);
  }

  /** The audit row and the event: ids, the flags, whether the person consented and where the place came from; never the place. */
  private async written(scope: CommandScope, done: QmsPhotoResult, now: Date): Promise<void> {
    const facts = {
      project_id: done.projectId,
      contract_id: done.contractId,
      site_diary_id: done.siteDiaryId,
      inspection_id: done.inspectionId,
      nonconformance_id: done.nonconformanceId,
      issue_id: done.issueId,
      check_time: done.checks.time,
      check_geofence: done.checks.geofence,
      check_duplicate: done.checks.duplicate,
      check_exif: done.checks.exif,
      check_summary: done.checks.summary,
      geo_consent: done.geoConsent,
      gps_source: done.gpsSource,
    };
    if (done.replayed) {
      await scope.audit({ action: 'site_photo.replayed', resourceType: RESOURCE_TYPE, resourceId: done.id, classification: CLASSIFICATION, diff: { check_summary: done.checks.summary } });
      return;
    }
    await scope.audit({ action: 'site_photo.registered', resourceType: RESOURCE_TYPE, resourceId: done.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: 1,
      type: 'qms.site_photo.registered.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, site_photo_id: done.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${done.id}:1`,
    });
  }
}

/** The photos of the projects and contracts in the scope of the caller (the right to read them is `photo.read`; a guest contractor holds it over its own contract). */
@Controller()
export class PhotoReadsController {
  private readonly photos = new QmsPhotoStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('resources/site_photo')
  @OperationId('get_resources_site_photo')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') projectId?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('site_diary_id') siteDiaryId?: unknown,
    @Query('summary') summary?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const uuid = (name: string, value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      const parsed = typeof value === 'string' ? asUuid(value) : undefined;
      if (parsed === undefined) throw new DomainError('VALIDATION_FAILED', 422, name);
      return parsed.toLowerCase();
    };
    if (summary !== undefined && typeof summary !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'summary');
    const page = parsePageRequest(limit, cursor);
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) =>
      this.photos.list(tx, contractScope(access, READ_PERMISSION, now), {
        projectId: uuid('project_id', projectId),
        contractId: uuid('contract_id', contractId),
        siteDiaryId: uuid('site_diary_id', siteDiaryId),
        summary: summary as string | undefined,
        limit: page.limit,
        after: page.after,
      }),
    );
    return { items: found.lines.map(photoView), next_cursor: found.next === undefined ? null : encodeCursor(found.next), as_of: now.toISOString() };
  }

  @Get('resources/site_photo/:id')
  @OperationId('get_resources_site_photo_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    return photoView(await this.found(tenant, access, id));
  }

  /** The checks of one photo: the four flags and what they were drawn from, as aids to review. */
  @Get('site-photos/:id/checks')
  @OperationId('getSitePhotoChecks')
  async checks(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const line = await this.found(tenant, access, id);
    return {
      photo_id: line.id,
      checks: { time: line.checks.time, geofence: line.checks.geofence, duplicate: line.checks.duplicate, exif: line.checks.exif, summary: line.checks.summary },
      flags: flagsOf(line.checks),
      review_note: 'REVIEW_FLAGS_ONLY',
      taken_at_exif: line.takenAtExif,
      received_at: line.receivedAt,
      geo_consent: line.geoConsent,
      place: line.place === null ? null : { lat: line.place.lat, lng: line.place.lng, accuracy_m: line.place.accuracyM, source: line.place.source },
    };
  }

  private async found(tenant: TenantContext, access: EffectiveAccess, id: string): Promise<QmsPhotoLine> {
    const now = new Date();
    const line = await this.database.withTenant(tenant, (tx) => this.photos.find(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now)));
    // A photo in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return line;
  }
}
