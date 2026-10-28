import { ApiError } from '@machvon/api-client';

/** The permission of QMS-08 (x-permission of the operations in openapi.json); the server judges each read again, with the scope of the project and of the contract. */
export const READ_PERMISSION = 'photo.read';

export const TIME_CHECKS = ['OK', 'SKEW', 'MISSING'] as const;
export const GEOFENCE_CHECKS = ['INSIDE', 'OUTSIDE', 'LOW_ACCURACY', 'MISSING'] as const;
export const DUPLICATE_CHECKS = ['UNIQUE', 'DUPLICATE_SAME_SITE', 'DUPLICATE_OTHER_SITE'] as const;
export const EXIF_CHECKS = ['CONSISTENT', 'STRIPPED', 'INCONSISTENT'] as const;
export const SUMMARIES = ['PASS', 'WARN', 'FAIL'] as const;
export type TimeCheck = (typeof TIME_CHECKS)[number];
export type GeofenceCheck = (typeof GEOFENCE_CHECKS)[number];
export type DuplicateCheck = (typeof DUPLICATE_CHECKS)[number];
export type ExifCheck = (typeof EXIF_CHECKS)[number];
export type Summary = (typeof SUMMARIES)[number];
export const PLACE_SOURCES = ['EXIF', 'DEVICE_AT_CAPTURE', 'MANUAL'] as const;
export type PlaceSource = (typeof PLACE_SOURCES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

export interface PhotoChecks {
  time: TimeCheck;
  geofence: GeofenceCheck;
  duplicate: DuplicateCheck;
  exif: ExifCheck;
  summary: Summary;
}

/** One photo as QMS-08 shows it. The flags are aids to review: nothing here says that a photo is genuine or not. */
export interface PhotoLine {
  id: string;
  projectCode: string;
  contract: { id: string; code: string } | null;
  siteDiaryId: string | null;
  fileSha256: string;
  takenAtExif: string | null;
  receivedAt: string;
  geoConsent: boolean;
  /** Kept only when the person consented to it. */
  place: { lat: number; lng: number; accuracyM: number | null; source: PlaceSource } | null;
  deviceModel: string | null;
  checks: PhotoChecks;
  flags: string[];
  caption: string | null;
  uploadedBy: string;
}

function toChecks(raw: unknown): PhotoChecks | undefined {
  const row = asRecord(raw);
  const time = oneOf(TIME_CHECKS, row?.time);
  const geofence = oneOf(GEOFENCE_CHECKS, row?.geofence);
  const duplicate = oneOf(DUPLICATE_CHECKS, row?.duplicate);
  const exif = oneOf(EXIF_CHECKS, row?.exif);
  const summary = oneOf(SUMMARIES, row?.summary);
  if (time === undefined || geofence === undefined || duplicate === undefined || exif === undefined || summary === undefined) return undefined;
  return { time, geofence, duplicate, exif, summary };
}

function toPlace(raw: unknown): PhotoLine['place'] {
  const row = asRecord(raw);
  const source = oneOf(PLACE_SOURCES, row?.source);
  if (row === undefined || source === undefined || typeof row.lat !== 'number' || typeof row.lng !== 'number') return null;
  return { lat: row.lat, lng: row.lng, accuracyM: typeof row.accuracy_m === 'number' ? row.accuracy_m : null, source };
}

export function toPhotoLine(raw: unknown): PhotoLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const checks = toChecks(row?.checks);
  const receivedAt = text(row?.received_at);
  if (row === undefined || id === undefined || checks === undefined || receivedAt === undefined) return undefined;
  const project = asRecord(row.project);
  const contract = asRecord(row.contract);
  const uploader = asRecord(row.uploaded_by);
  return {
    id,
    projectCode: text(project?.code) ?? '',
    contract: contract === undefined || text(contract.id) === undefined ? null : { id: text(contract.id) ?? '', code: text(contract.code) ?? '' },
    siteDiaryId: nullableText(row.site_diary_id),
    fileSha256: text(row.file_sha256) ?? '',
    takenAtExif: nullableText(row.taken_at_exif),
    receivedAt,
    geoConsent: row.geo_consent === true,
    // A place is shown only if the person consented to it, whatever the server sent.
    place: row.geo_consent === true ? toPlace(row.place) : null,
    deviceModel: nullableText(row.device_model),
    checks,
    flags: Array.isArray(row.flags) ? row.flags.flatMap((flag) => (typeof flag === 'string' ? [flag] : [])) : [],
    caption: nullableText(row.caption),
    uploadedBy: text(uploader?.display_name) ?? '',
  };
}

export interface PhotoPage {
  lines: PhotoLine[];
  next: string | undefined;
}

export function toPhotoPage(raw: unknown): PhotoPage {
  const body = asRecord(raw);
  return { lines: Array.isArray(body?.items) ? body.items.flatMap((entry) => toPhotoLine(entry) ?? []) : [], next: text(body?.next_cursor) };
}

/** What the checks of one photo say, read on their own (getSitePhotoChecks). */
export interface PhotoChecksView {
  photoId: string;
  checks: PhotoChecks;
  flags: string[];
  takenAtExif: string | null;
  receivedAt: string;
  geoConsent: boolean;
  place: PhotoLine['place'];
}

export function toChecksView(raw: unknown): PhotoChecksView | undefined {
  const row = asRecord(raw);
  const photoId = text(row?.photo_id);
  const checks = toChecks(row?.checks);
  const receivedAt = text(row?.received_at);
  if (row === undefined || photoId === undefined || checks === undefined || receivedAt === undefined) return undefined;
  return {
    photoId,
    checks,
    flags: Array.isArray(row.flags) ? row.flags.flatMap((flag) => (typeof flag === 'string' ? [flag] : [])) : [],
    takenAtExif: nullableText(row.taken_at_exif),
    receivedAt,
    geoConsent: row.geo_consent === true,
    place: row.geo_consent === true ? toPlace(row.place) : null,
  };
}

// ---- the filter -------------------------------------------------------------------------------------------------------------------

export interface PhotoFilter {
  contractId: string;
  summary: string;
}
export const NO_FILTER: PhotoFilter = { contractId: '', summary: '' };

/** What the filter asks the server for: only what was chosen and is well formed. */
export function filterQuery(filter: PhotoFilter): Record<string, string> {
  return {
    ...(UUID.test(filter.contractId) ? { contract_id: filter.contractId } : {}),
    ...(oneOf(SUMMARIES, filter.summary) === undefined ? {} : { summary: filter.summary }),
  };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export type Problem = 'notFound' | 'denied' | 'session' | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}
