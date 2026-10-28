import { randomUUID } from 'node:crypto';
import { DomainError, accuracyOf, checkExif, checkGeofence, checkTime, decimalOf, distanceMetres, summariseChecks } from '@machvon/kernel';
import type { ExifData, PhotoDuplicateCheck, PhotoExifCheck, PhotoGeofenceCheck, PhotoSummary, PhotoTimeCheck } from '@machvon/kernel';
import { TIMESTAMP } from './ctr-contract-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TEXT = 2000;
const UNIQUE_VIOLATION = '23505';
const OBJECT_CONSTRAINT = 'site_photo_object_uq';
const OPERATION_CONSTRAINT = 'site_photo_op_uq';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const optionalId = (value: string | undefined, field: string): string | null => (value === undefined ? null : idOf(value, field));
const textOf = (value: string | undefined, field: string): string | null => {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};

export interface RegisterPhotoInput {
  clientOperationId: string;
  projectId: string;
  contractId?: string | undefined;
  siteDiaryId?: string | undefined;
  inspectionId?: string | undefined;
  nonconformanceId?: string | undefined;
  issueId?: string | undefined;
  objectKey: string;
  fileSha256: string;
  deviceId?: string | undefined;
  deviceModel?: string | undefined;
  deviceGpsLat?: string | undefined;
  deviceGpsLng?: string | undefined;
  deviceGpsAccuracyM?: string | undefined;
  geoConsent?: boolean | undefined;
  caption?: string | undefined;
}

/** What the register learns from the stored file, once the request has been judged: the hash it has, what the scan said, and what the file says about itself. */
export interface PhotoFile {
  sha256: string;
  exif: ExifData;
}

export interface PhotoChecks {
  time: PhotoTimeCheck;
  geofence: PhotoGeofenceCheck;
  duplicate: PhotoDuplicateCheck;
  exif: PhotoExifCheck;
  summary: PhotoSummary;
}

export interface QmsPhotoResult {
  id: string;
  projectId: string;
  contractId: string | null;
  siteDiaryId: string | null;
  inspectionId: string | null;
  nonconformanceId: string | null;
  issueId: string | null;
  checks: PhotoChecks;
  geoConsent: boolean;
  gpsSource: 'EXIF' | 'DEVICE_AT_CAPTURE' | 'MANUAL' | 'NONE';
  /** True when the command found that the photo had been registered (the client operation was seen before) and changed nothing. */
  replayed: boolean;
}

export interface QmsPhotoLine {
  id: string;
  projectId: string;
  projectCode: string;
  contractId: string | null;
  contractCode: string | null;
  siteDiaryId: string | null;
  inspectionId: string | null;
  nonconformanceId: string | null;
  issueId: string | null;
  fileSha256: string;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED';
  takenAtExif: string | null;
  receivedAt: string;
  /** Present only when the person consented to it (the database holds no place without it). */
  place: { lat: number; lng: number; accuracyM: number | null; source: 'EXIF' | 'DEVICE_AT_CAPTURE' | 'MANUAL' } | null;
  geoConsent: boolean;
  deviceId: string | null;
  deviceModel: string | null;
  checks: PhotoChecks;
  caption: string | null;
  uploadedBy: { membershipId: string; displayName: string };
  createdAt: string;
}

interface LineSql {
  id: string;
  project_id: string;
  project_code: string;
  contract_id: string | null;
  contract_code: string | null;
  site_diary_id: string | null;
  inspection_id: string | null;
  nonconformance_id: string | null;
  issue_id: string | null;
  file_sha256: string;
  scan_status: 'PENDING' | 'CLEAN' | 'INFECTED';
  taken_at_exif: string | null;
  received_at: string;
  gps_lat: string | null;
  gps_lng: string | null;
  gps_accuracy_m: string | null;
  gps_source: 'EXIF' | 'DEVICE_AT_CAPTURE' | 'MANUAL' | 'NONE';
  geo_consent: boolean;
  device_id: string | null;
  device_model: string | null;
  check_time: PhotoTimeCheck;
  check_geofence: PhotoGeofenceCheck;
  check_duplicate: PhotoDuplicateCheck;
  check_exif: PhotoExifCheck;
  check_summary: PhotoSummary;
  caption: string | null;
  uploaded_by: string;
  uploader_name: string | null;
  created_at: string;
  received_key: string;
}

/** A photo with the project and the two units its scope is judged by, and the contract when it has one: the aliases `c`, `p`, `ou` and `iu` are those of `contractScope`. */
const FROM = `machvon.site_photo s
  join machvon.project p on p.tenant_id = s.tenant_id and p.id = s.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
  left join machvon.contract c on c.tenant_id = s.tenant_id and c.id = s.contract_id
  left join machvon.tenant_user_directory u on u.tenant_id = s.tenant_id and u.membership_id = s.uploaded_by`;

const COLUMNS = `s.id, s.project_id, p.code as project_code, s.contract_id, c.code as contract_code, s.site_diary_id, s.inspection_id, s.nonconformance_id, s.issue_id, s.file_sha256, s.scan_status,
  ${TIMESTAMP('s.taken_at_exif')} as taken_at_exif, ${TIMESTAMP('s.received_at')} as received_at, s.gps_lat::text as gps_lat, s.gps_lng::text as gps_lng, s.gps_accuracy_m::text as gps_accuracy_m, s.gps_source,
  s.geo_consent, s.device_id, s.device_model, s.check_time, s.check_geofence, s.check_duplicate, s.check_exif, s.check_summary, s.caption, s.uploaded_by, u.display_name as uploader_name,
  ${TIMESTAMP('s.created_at')} as created_at, to_char(s.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_key`;

const lineOf = (row: LineSql): QmsPhotoLine => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  contractId: row.contract_id,
  contractCode: row.contract_code,
  siteDiaryId: row.site_diary_id,
  inspectionId: row.inspection_id,
  nonconformanceId: row.nonconformance_id,
  issueId: row.issue_id,
  fileSha256: row.file_sha256.trim(),
  scanStatus: row.scan_status,
  takenAtExif: row.taken_at_exif,
  receivedAt: row.received_at,
  place: row.gps_lat === null || row.gps_lng === null || row.gps_source === 'NONE' ? null : { lat: Number(row.gps_lat), lng: Number(row.gps_lng), accuracyM: row.gps_accuracy_m === null ? null : Number(row.gps_accuracy_m), source: row.gps_source },
  geoConsent: row.geo_consent,
  deviceId: row.device_id,
  deviceModel: row.device_model,
  checks: { time: row.check_time, geofence: row.check_geofence, duplicate: row.check_duplicate, exif: row.check_exif, summary: row.check_summary },
  caption: row.caption,
  uploadedBy: { membershipId: row.uploaded_by, displayName: row.uploader_name ?? '' },
  createdAt: row.created_at,
});

export interface PhotoScopes {
  /** The scope of the permission to register photos, and the scope of the permission to read them. */
  update: ScopeBuilder;
  read: ScopeBuilder;
}

/**
 * The site photo register (ST-QMS-003, QMS 3.4, BR-QMS-06). A photo is registered from a file that is in the storage and clean: its hash is the one the client says, its EXIF is read by the server, and four checks
 * (time, place, repetition, EXIF) are drawn from what the photo says about itself. They are flags for a person to review; no photo is rejected for one. A place is kept only when the person consented to it, with no exception:
 * a place that a device sends without the consent is refused (422 `GEO_CONSENT_REQUIRED`), and the place in the EXIF of a file is not kept without it either. Registered photos are not edited.
 */
export class QmsPhotoStore {
  /**
   * Registers a photo. Refusals in order: the shape (422), a place without the consent to it (422 `GEO_CONSENT_REQUIRED`), the project (404 outside the scope, 403 where it may be read and not written), a client
   * operation that was seen (it answers the photo it made), the contract and the objects it is linked to (422, they must be of the project), the file (the callback: 404, 422 `FILE_NOT_CLEAN`, 409 `SCAN_PENDING`, 422
   * `HASH_MISMATCH`), and one file registered twice (422).
   */
  async register(tx: TenantTx, input: RegisterPhotoInput, actor: string, scopes: PhotoScopes, now: Date, inspect: () => Promise<PhotoFile>): Promise<QmsPhotoResult> {
    const operationId = idOf(input.clientOperationId, 'client_operation_id');
    const projectId = idOf(input.projectId, 'project_id');
    const contractId = optionalId(input.contractId, 'contract_id');
    const links = {
      siteDiaryId: optionalId(input.siteDiaryId, 'site_diary_id'),
      inspectionId: optionalId(input.inspectionId, 'inspection_id'),
      nonconformanceId: optionalId(input.nonconformanceId, 'nonconformance_id'),
      issueId: optionalId(input.issueId, 'issue_id'),
    };
    const objectKey = input.objectKey.trim();
    if (objectKey === '' || objectKey.length > MAX_TEXT) throw invalid('object_key');
    if (!SHA256.test(input.fileSha256)) throw invalid('file_sha256');
    const deviceId = optionalId(input.deviceId, 'device_id');
    const deviceModel = textOf(input.deviceModel, 'device_model');
    const caption = textOf(input.caption, 'caption');
    const consent = input.geoConsent === true;
    if ((input.deviceGpsLat === undefined) !== (input.deviceGpsLng === undefined)) throw invalid('device_gps_lat');
    if (input.deviceGpsAccuracyM !== undefined && input.deviceGpsLat === undefined) throw invalid('device_gps_accuracy_m');
    const device =
      input.deviceGpsLat === undefined || input.deviceGpsLng === undefined
        ? null
        : { lat: decimalOf(input.deviceGpsLat, 'device_gps_lat', 90), lng: decimalOf(input.deviceGpsLng, 'device_gps_lng', 180), accuracyM: input.deviceGpsAccuracyM === undefined ? null : accuracyOf(input.deviceGpsAccuracyM, 'device_gps_accuracy_m') };
    // A place that a device sends without the consent to it is refused, not dropped: the person must know that it was not kept.
    if (device !== null && !consent) throw new DomainError('GEO_CONSENT_REQUIRED', 422, 'geo_consent');

    await this.reach(tx, projectId, contractId, scopes);
    // Two requests with one operation are told apart by who comes first: the second waits for the first to commit and is answered with the photo that it made.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('site_photo_op:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [operationId]);
    const seen = await this.seen(tx, operationId, projectId, contractId);
    if (seen !== undefined) return seen;
    const day = await this.linked(tx, projectId, contractId, links);

    const file = await inspect();
    if (file.sha256 !== input.fileSha256) throw new DomainError('HASH_MISMATCH', 422, 'file_sha256');
    const place = !consent ? null : device !== null ? { ...device, source: 'DEVICE_AT_CAPTURE' as const } : file.exif.gps !== null ? { ...file.exif.gps, accuracyM: null, source: 'EXIF' as const } : null;
    const zone = await this.nearestZone(tx, projectId, place);
    // Two copies of one file registered at once must not both be the first: the second waits for the first to commit, and sees it.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('site_photo_sha:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [input.fileSha256]);
    const duplicate = await this.duplicateOf(tx, projectId, input.fileSha256);
    const checks = {
      time: checkTime({ takenAt: file.exif.takenAt, receivedAt: now, day }),
      // The place is judged from what the person consented to keep; without the consent there is nothing to judge.
      geofence: checkGeofence({ place, accuracyM: place?.accuracyM ?? null, zone }),
      duplicate,
      exif: checkExif(file.exif),
    };
    const summary = summariseChecks(checks);
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.site_photo
           (tenant_id, id, project_id, contract_id, site_diary_id, inspection_id, nonconformance_id, issue_id, client_operation_id, object_key, file_sha256, scan_status, taken_at_exif, received_at,
            gps_lat, gps_lng, gps_accuracy_m, gps_source, geo_consent, device_id, device_model, check_time, check_geofence, check_duplicate, check_exif, check_summary, caption, uploaded_by, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10, 'CLEAN', $11::timestamptz, $12::timestamptz,
            $13::numeric, $14::numeric, $15::numeric, $16, $17, $18::uuid, $19, $20, $21, $22, $23, $24, $25, $26::uuid, $26::uuid)`,
        [
          id,
          projectId,
          contractId,
          links.siteDiaryId,
          links.inspectionId,
          links.nonconformanceId,
          links.issueId,
          operationId,
          objectKey,
          input.fileSha256,
          file.exif.takenAt === null ? null : file.exif.takenAt.toISOString(),
          now.toISOString(),
          place === null ? null : place.lat,
          place === null ? null : place.lng,
          place === null ? null : place.accuracyM,
          place === null ? 'NONE' : place.source,
          consent,
          deviceId,
          deviceModel ?? file.exif.model,
          checks.time,
          checks.geofence,
          checks.duplicate,
          checks.exif,
          summary,
          caption,
          actor,
        ],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === OBJECT_CONSTRAINT) throw invalid('object_key');
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === OPERATION_CONSTRAINT) throw invalid('client_operation_id');
      throw error;
    }
    return { id, projectId, contractId, ...links, checks: { ...checks, summary }, geoConsent: consent, gpsSource: place === null ? 'NONE' : place.source, replayed: false };
  }

  /** The project is in the scope of the caller to write to (a guest contractor reaches it through the contract). 404 outside the scope, 403 where the caller may read and not write. */
  private async reach(tx: TenantTx, projectId: string, contractId: string | null, scopes: PhotoScopes): Promise<void> {
    const probe = async (scope: ScopeBuilder): Promise<boolean> => {
      const predicate = scope(3);
      const rows = await tx.query<{ id: string }>(
        `select p.id from machvon.project p
           join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
           left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
           left join machvon.contract c on c.tenant_id = p.tenant_id and c.id = $2::uuid and c.project_id = p.id
          where p.id = $1::uuid and ${predicate.sql}`,
        [projectId, contractId, ...predicate.params],
      );
      return rows.length > 0;
    };
    if (await probe(scopes.update)) return;
    if (await probe(scopes.read)) throw new DomainError('SCOPE_DENIED', 403);
    throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }

  /** The photo that a client operation made, for a retry. It is the photo of this request or none: the project and the contract named are those it was registered for, which the caller was judged for; another's is a mistake. */
  private async seen(tx: TenantTx, operationId: string, projectId: string, contractId: string | null): Promise<QmsPhotoResult | undefined> {
    const rows = await tx.query<
      { id: string; project_id: string; contract_id: string | null; site_diary_id: string | null; inspection_id: string | null; nonconformance_id: string | null; issue_id: string | null } & Pick<
        LineSql,
        'check_time' | 'check_geofence' | 'check_duplicate' | 'check_exif' | 'check_summary' | 'geo_consent' | 'gps_source'
      >
    >('select id, project_id, contract_id, site_diary_id, inspection_id, nonconformance_id, issue_id, check_time, check_geofence, check_duplicate, check_exif, check_summary, geo_consent, gps_source from machvon.site_photo where client_operation_id = $1::uuid', [operationId]);
    const row = rows[0];
    if (row === undefined) return undefined;
    if (row.project_id !== projectId || row.contract_id !== contractId) throw invalid('client_operation_id');
    return {
      id: row.id,
      projectId: row.project_id,
      contractId: row.contract_id,
      siteDiaryId: row.site_diary_id,
      inspectionId: row.inspection_id,
      nonconformanceId: row.nonconformance_id,
      issueId: row.issue_id,
      checks: { time: row.check_time, geofence: row.check_geofence, duplicate: row.check_duplicate, exif: row.check_exif, summary: row.check_summary },
      geoConsent: row.geo_consent,
      gpsSource: row.gps_source,
      replayed: true,
    };
  }

  /**
   * The contract and the objects that a photo is evidence for must be of the project (422). Returns the day of the diary the photo is linked to, if it has one: the day that its time is judged against.
   */
  private async linked(tx: TenantTx, projectId: string, contractId: string | null, links: { siteDiaryId: string | null; inspectionId: string | null; nonconformanceId: string | null; issueId: string | null }): Promise<string | null> {
    if (contractId !== null && (await tx.query('select 1 from machvon.contract where id = $1::uuid and project_id = $2::uuid', [contractId, projectId])).length === 0) throw invalid('contract_id');
    const must = async (sql: string, id: string | null, field: string, withContract = true): Promise<Array<Record<string, string>>> => {
      if (id === null) return [];
      const rows = await tx.query<Record<string, string>>(sql, withContract ? [id, projectId, contractId] : [id, projectId]);
      if (rows.length === 0) throw invalid(field);
      return rows;
    };
    // A linked object belongs to the project, and to the contract when the photo names one.
    const diary = await must('select record_date::text as day from machvon.site_diary where id = $1::uuid and project_id = $2::uuid and ($3::uuid is null or contract_id = $3::uuid)', links.siteDiaryId, 'site_diary_id');
    await must('select 1 as ok from machvon.inspection where id = $1::uuid and project_id = $2::uuid and ($3::uuid is null or contract_id = $3::uuid)', links.inspectionId, 'inspection_id');
    await must('select 1 as ok from machvon.quality_nonconformance where id = $1::uuid and project_id = $2::uuid and ($3::uuid is null or contract_id = $3::uuid)', links.nonconformanceId, 'nonconformance_id');
    await must('select 1 as ok from machvon.issue where id = $1::uuid and project_id = $2::uuid', links.issueId, 'issue_id', false);
    return diary[0]?.day ?? null;
  }

  /** The zone of the project nearest to the place, or none; a project with no zone has no place to compare a photo to. */
  private async nearestZone(tx: TenantTx, projectId: string, place: { lat: number; lng: number } | null): Promise<{ lat: number; lng: number; radiusM: number } | null> {
    const rows = await tx.query<{ center_lat: string; center_lng: string; radius_m: number }>('select center_lat::text, center_lng::text, radius_m from machvon.project_site_zone where project_id = $1::uuid order by id', [projectId]);
    const zones = rows.map((row) => ({ lat: Number(row.center_lat), lng: Number(row.center_lng), radiusM: row.radius_m }));
    if (zones.length === 0) return null;
    if (place === null) return zones[0] ?? null;
    return zones.reduce((best, zone) => (distanceMetres(place, zone) < distanceMetres(place, best) ? zone : best));
  }

  /** A file with the same hash: in this project (DUPLICATE_SAME_SITE), in another project of the tenant (DUPLICATE_OTHER_SITE), or none (UNIQUE). */
  private async duplicateOf(tx: TenantTx, projectId: string, sha256: string): Promise<PhotoDuplicateCheck> {
    const rows = await tx.query<{ same: boolean }>('select (project_id = $1::uuid) as same from machvon.site_photo where file_sha256 = $2 order by (project_id = $1::uuid) desc limit 1', [projectId, sha256]);
    if (rows[0] === undefined) return 'UNIQUE';
    return rows[0].same ? 'DUPLICATE_SAME_SITE' : 'DUPLICATE_OTHER_SITE';
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  /** The photos in the scope of the caller, the latest first; the cursor is the moment of reception and the id of the last one. */
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    filter: { projectId?: string | undefined; contractId?: string | undefined; siteDiaryId?: string | undefined; summary?: string | undefined; limit: number; after?: { code: string; id: string } | undefined },
  ): Promise<{ lines: QmsPhotoLine[]; next: { code: string; id: string } | undefined }> {
    const projectId = filter.projectId === undefined ? null : idOf(filter.projectId, 'project_id');
    const contractId = filter.contractId === undefined ? null : idOf(filter.contractId, 'contract_id');
    const diaryId = filter.siteDiaryId === undefined ? null : idOf(filter.siteDiaryId, 'site_diary_id');
    if (filter.summary !== undefined && filter.summary !== 'PASS' && filter.summary !== 'WARN' && filter.summary !== 'FAIL') throw invalid('summary');
    if (filter.after !== undefined && (Number.isNaN(Date.parse(filter.after.code)) || !UUID.test(filter.after.id))) throw invalid('cursor');
    const predicate = scope(7);
    const rows = await tx.query<LineSql>(
      `select ${COLUMNS} from ${FROM}
        where ${predicate.sql} and ($1::uuid is null or s.project_id = $1::uuid) and ($2::uuid is null or s.contract_id = $2::uuid) and ($3::uuid is null or s.site_diary_id = $3::uuid)
          and ($4::text is null or s.check_summary = $4) and ($5::timestamptz is null or (s.received_at, s.id) < ($5::timestamptz, $6::uuid))
        order by s.received_at desc, s.id desc limit ${filter.limit + 1}`,
      [projectId, contractId, diaryId, filter.summary ?? null, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    const page = rows.slice(0, filter.limit);
    const last = page.at(-1);
    return { lines: page.map(lineOf), next: rows.length > filter.limit && last !== undefined ? { code: last.received_key, id: last.id } : undefined };
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<QmsPhotoLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(`select ${COLUMNS} from ${FROM} where s.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : lineOf(rows[0]);
  }
}
