import { contentOf, emptyDiary, formOf } from '../diary/model';
import type { DiaryForm, DiaryLine, Problem, SaveBody } from '../diary/model';

export { READ_PERMISSION, WRITE_PERMISSION } from '../diary/model';
/** The permission to sign as the contractor (x-permission of `signSiteDiaryByContractor`); the server judges the signature again, with the role and the scope of the contract. */
export const SIGN_PERMISSION = 'diary.sign.contractor';
/** The permission to read the contracts a diary is written for. */
export const CONTRACT_PERMISSION = 'contract.read';

type Raw = Record<string, unknown>;

/** Whether the permission is held, or not yet known: the screen asks for nothing it may not read, and the server judges the scope again. */
export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

// ---- the place --------------------------------------------------------------------------------------------------------------------

const LATITUDE = /^-?\d{1,2}(\.\d{1,15})?$/;
const LONGITUDE = /^-?\d{1,3}(\.\d{1,15})?$/;
const ACCURACY = /^\d{1,6}(\.\d{1,15})?$/;

/** Where the diary was written, kept only with the consent of the person who gives it (NFR-PRIVACY-01). */
export interface Place {
  consent: boolean;
  lat: string;
  lng: string;
  accuracy: string;
}

export const NO_PLACE: Place = { consent: false, lat: '', lng: '', accuracy: '' };

/** Taking the consent back takes the place with it: nothing typed or fetched is kept without the consent. */
export const withConsent = (place: Place, given: boolean): Place => (given ? { ...place, consent: true } : NO_PLACE);

export type PlaceProblem = 'consentRequired' | 'pairRequired' | 'invalidLatitude' | 'invalidLongitude' | 'invalidAccuracy';

export function validatePlace(place: Place): Partial<Record<'consent' | 'lat' | 'lng' | 'accuracy', PlaceProblem>> {
  const problems: Partial<Record<'consent' | 'lat' | 'lng' | 'accuracy', PlaceProblem>> = {};
  const lat = place.lat.trim();
  const lng = place.lng.trim();
  const accuracy = place.accuracy.trim();
  if (lat === '' && lng === '' && accuracy === '') return problems;
  if (!place.consent) problems.consent = 'consentRequired';
  if (lat === '') problems.lat = 'pairRequired';
  else if (!LATITUDE.test(lat) || Math.abs(Number(lat)) > 90) problems.lat = 'invalidLatitude';
  if (lng === '') problems.lng = 'pairRequired';
  else if (!LONGITUDE.test(lng) || Math.abs(Number(lng)) > 180) problems.lng = 'invalidLongitude';
  if (accuracy !== '' && !ACCURACY.test(accuracy)) problems.accuracy = 'invalidAccuracy';
  return problems;
}

/** The place a diary already holds, as the form shows it; a place the diary holds without the consent to it is not shown. */
export function placeOf(content: Raw): Place {
  const place = content.location;
  const row = typeof place === 'object' && place !== null && !Array.isArray(place) ? (place as Raw) : undefined;
  if (content.geo_consent !== true || row === undefined || typeof row.lat !== 'number' || typeof row.lng !== 'number') return NO_PLACE;
  return { consent: true, lat: String(row.lat), lng: String(row.lng), accuracy: typeof row.accuracy_m === 'number' ? String(row.accuracy_m) : '' };
}

/**
 * What the device keeps of the diary: the content of the form over what the diary already held, and the place only when the person consented to it and gave one. A place that the diary held and that the form
 * no longer has (the consent was taken back) is taken out, together with the consent that kept it.
 */
export function queuedContent(form: DiaryForm, base: Raw, place: Place): Raw {
  const content = contentOf(form, base);
  delete content.location;
  delete content.geo_consent;
  const lat = place.lat.trim();
  const lng = place.lng.trim();
  const accuracy = place.accuracy.trim();
  if (!place.consent || lat === '' || lng === '') return content;
  return { ...content, geo_consent: true, location: { lat: Number(lat), lng: Number(lng), ...(accuracy === '' ? {} : { accuracy_m: Number(accuracy) }) } };
}

// ---- the queue --------------------------------------------------------------------------------------------------------------------

/** A diary written on this device that the server has not taken yet. It carries its own operation id, so that a send repeated after a lost answer is the same diary (UAT-AC358). */
export interface QueuedDiary {
  clientOperationId: string;
  contractId: string;
  contractCode: string;
  recordDate: string;
  content: Raw;
  /** The version of the diary on the server that this one was written over; none for a diary of a new day. */
  baseServerVersion: number | null;
  queuedAt: string;
  /** `REJECTED`: the server refused it for a reason the person has to act on; it stays until it is removed. */
  state: 'PENDING' | 'REJECTED';
  reason: Problem | null;
}

export const isPending = (item: QueuedDiary): boolean => item.state === 'PENDING';

export function toSaveBody(item: QueuedDiary): SaveBody {
  return {
    contract_id: item.contractId,
    record_date: item.recordDate,
    client_operation_id: item.clientOperationId,
    content: item.content,
    ...(item.baseServerVersion === null ? {} : { base_server_version: item.baseServerVersion }),
  };
}

export function queueItem(input: { form: DiaryForm; contractCode: string; base: Raw; baseServerVersion: number | null; place: Place; clientOperationId: string; now: Date }): QueuedDiary {
  return {
    clientOperationId: input.clientOperationId,
    contractId: input.form.contractId,
    contractCode: input.contractCode,
    recordDate: input.form.recordDate,
    content: queuedContent(input.form, input.base, input.place),
    baseServerVersion: input.baseServerVersion,
    queuedAt: input.now.toISOString(),
    state: 'PENDING',
    reason: null,
  };
}

// ---- writing over a diary on the server -------------------------------------------------------------------------------------------

/** What the form starts from: a new day, or the diary on the server that the person writes over (its contract and day stay as they are). */
export interface Draft {
  form: DiaryForm;
  place: Place;
  base: Raw;
  baseServerVersion: number | null;
}

export const newDraft = (today: string): Draft => ({ form: emptyDiary(today), place: NO_PLACE, base: {}, baseServerVersion: null });

export const draftOver = (line: DiaryLine): Draft => ({ form: formOf(line), place: placeOf(line.content), base: line.content, baseServerVersion: line.version });
