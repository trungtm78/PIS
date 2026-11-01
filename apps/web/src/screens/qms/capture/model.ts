import { ApiError } from '@machvon/api-client';
import type { ContractLine } from '../../ctr/model';
import { validatePlace } from '../offline/model';
import type { Place, PlaceProblem } from '../offline/model';

export { NO_PLACE, withConsent } from '../offline/model';
export type { Place };

/** The permissions of QMS-10 (x-permission of `registerSitePhoto` and of the reads of the photos); the server judges each command again, with the scope of the contract. */
export const UPLOAD_PERMISSION = 'photo.upload';
export const READ_PERMISSION = 'photo.read';
/** The permission to read the contracts a photo is taken for, and the diaries it may be linked to. */
export const CONTRACT_PERMISSION = 'contract.read';
export const DIARY_PERMISSION = 'site_diary.read';

/** Whether the permission is held, or not yet known: the screen asks for nothing it may not read, and the server judges the scope again. */
export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
/** The most a site photo may weigh (the upload purpose `site_photo`) and the kinds of image it may be. */
export const MAX_BYTES = 15 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;

/** The photo the person chose, as the screen knows it: what the server needs of it, and nothing of its content. */
export interface ChosenFile {
  name: string;
  type: string;
  size: number;
  /** SHA-256 of the bytes, lower-case hex: what makes the same file the same photo. */
  sha256: string;
}

export interface CaptureForm {
  contractId: string;
  siteDiaryId: string;
  caption: string;
  /** The reference of the file in the object storage, as the upload gave it. */
  objectKey: string;
}

export const EMPTY_FORM: CaptureForm = { contractId: '', siteDiaryId: '', caption: '', objectKey: '' };

export type FormProblem = 'required' | 'tooLong' | 'notImage' | 'tooLarge' | 'invalidId';
export type CaptureField = 'file' | keyof CaptureForm;

export interface CaptureProblems {
  form: Partial<Record<CaptureField, FormProblem>>;
  place: Partial<Record<'consent' | 'lat' | 'lng' | 'accuracy', PlaceProblem>>;
}

/** What is wrong with the photo before it is sent: the file, the contract (which gives the project), the reference of the upload and the place with its consent. */
export function validateCapture(form: CaptureForm, file: ChosenFile | undefined, place: Place): CaptureProblems {
  const problems: Partial<Record<CaptureField, FormProblem>> = {};
  if (file === undefined) problems.file = 'required';
  else if (!IMAGE_TYPES.some((type) => type === file.type)) problems.file = 'notImage';
  else if (file.size > MAX_BYTES) problems.file = 'tooLarge';
  if (!UUID.test(form.contractId)) problems.contractId = 'required';
  if (form.siteDiaryId !== '' && !UUID.test(form.siteDiaryId)) problems.siteDiaryId = 'invalidId';
  const key = form.objectKey.trim();
  if (key === '') problems.objectKey = 'required';
  else if (key.length > MAX_TEXT) problems.objectKey = 'tooLong';
  if (form.caption.trim().length > MAX_TEXT) problems.caption = 'tooLong';
  return { form: problems, place: validatePlace(place) };
}

export const hasProblems = (problems: CaptureProblems): boolean => Object.keys(problems.form).length > 0 || Object.keys(problems.place).length > 0;

export interface CaptureBody {
  client_operation_id: string;
  project_id: string;
  contract_id: string;
  object_key: string;
  file_sha256: string;
  site_diary_id?: string;
  caption?: string;
  geo_consent?: boolean;
  device_gps_lat?: string;
  device_gps_lng?: string;
  device_gps_accuracy_m?: string;
}

/**
 * The body of registerSitePhoto for a form that passed `validateCapture`. Nothing of the place travels without the consent that keeps it (UAT-AC367): with the consent and both coordinates the place goes as the device gave
 * it, as text, and with the consent alone only the consent goes.
 */
export function captureBody(form: CaptureForm, contract: Pick<ContractLine, 'id' | 'projectId'>, file: ChosenFile, place: Place, clientOperationId: string): CaptureBody {
  const caption = form.caption.trim();
  const lat = place.lat.trim();
  const lng = place.lng.trim();
  const accuracy = place.accuracy.trim();
  return {
    client_operation_id: clientOperationId,
    project_id: contract.projectId,
    contract_id: contract.id,
    object_key: form.objectKey.trim(),
    file_sha256: file.sha256,
    ...(form.siteDiaryId === '' ? {} : { site_diary_id: form.siteDiaryId }),
    ...(caption === '' ? {} : { caption }),
    ...(place.consent ? { geo_consent: true } : {}),
    ...(place.consent && lat !== '' && lng !== '' ? { device_gps_lat: lat, device_gps_lng: lng, ...(accuracy === '' ? {} : { device_gps_accuracy_m: accuracy }) } : {}),
  };
}

/** The flags that can be shown before the photo is sent, from what the screen already knows: the same file already registered for the contract, and whether a place will be kept. The flags of time, zone and EXIF are read from the file by the server. */
export type PreflightFlag = 'DUPLICATE_SAME_SITE' | 'PLACE_NOT_KEPT';

export function preflightFlags(sha256: string | undefined, known: readonly { fileSha256: string }[], place: Place): PreflightFlag[] {
  return [
    ...(sha256 !== undefined && known.some((photo) => photo.fileSha256 === sha256) ? (['DUPLICATE_SAME_SITE'] as const) : []),
    ...(place.consent && place.lat.trim() !== '' && place.lng.trim() !== '' ? [] : (['PLACE_NOT_KEPT'] as const)),
  ];
}

export type Problem = 'consentRequired' | 'fileNotClean' | 'hashMismatch' | 'notFound' | 'validation' | 'denied' | 'session' | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'GEO_CONSENT_REQUIRED':
      return 'consentRequired';
    case 'FILE_NOT_CLEAN':
      return 'fileNotClean';
    case 'HASH_MISMATCH':
      return 'hashMismatch';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}
