import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import type { SignatureMethod } from './qms-acceptance.ts';
import type { SignerRole } from './qms-inspection.ts';

/**
 * The electronic site diary (ST-QMS-001, QMS 3.1, BR-QMS-01..03): one main diary for a contract and a day, drafted by the contractor, signed by the contractor over a hash of what it says, given the opinion of the
 * supervisor and the confirmation of the owner, locked, and corrected only as a new revision with a reason. Nothing that was signed is edited.
 */
export const DIARY_STATUSES = ['DRAFT', 'CONTRACTOR_SIGNED', 'SUPERVISED', 'OWNER_CONFIRMED', 'LOCKED', 'SUPERSEDED'] as const;
export type DiaryStatus = (typeof DIARY_STATUSES)[number];

export const DIARY_COMMANDS = ['revise', 'contractorSign', 'supervise', 'ownerConfirm', 'lock', 'correct'] as const;
export type DiaryCommand = (typeof DIARY_COMMANDS)[number];

/** Where each command may be taken from and where it leads (QMS 4): the supervisor remarks on a diary the contractor signed, the owner confirms one that was remarked, and a diary is locked once it was remarked. */
const TRANSITIONS: Readonly<Record<Exclude<DiaryCommand, 'correct'>, { from: readonly DiaryStatus[]; to: DiaryStatus }>> = {
  revise: { from: ['DRAFT'], to: 'DRAFT' },
  contractorSign: { from: ['DRAFT'], to: 'CONTRACTOR_SIGNED' },
  supervise: { from: ['CONTRACTOR_SIGNED'], to: 'SUPERVISED' },
  ownerConfirm: { from: ['SUPERVISED'], to: 'OWNER_CONFIRMED' },
  lock: { from: ['SUPERVISED', 'OWNER_CONFIRMED'], to: 'LOCKED' },
};

/** 409 `DIARY_STATE_INVALID` unless the command applies to the diary as it stands: a diary that was signed is not edited, and a role does not sign out of its turn. */
export function assertDiaryTransition(command: Exclude<DiaryCommand, 'correct'>, status: DiaryStatus): DiaryStatus {
  const rule = TRANSITIONS[command];
  if (!rule.from.includes(status)) throw new DomainError('DIARY_STATE_INVALID', 409, 'status', { extensions: { diary_status: status } });
  return rule.to;
}

/** Which role signs with which command, and which permission it holds in the contract (the guard of the role): the contractor signs for the contractor, the staff for the other side. */
export const DIARY_SIGNING_ROLE: Readonly<Record<'contractorSign' | 'supervise' | 'ownerConfirm', SignerRole>> = { contractorSign: 'CONTRACTOR', supervise: 'SUPERVISOR', ownerConfirm: 'OWNER' };

/** What the regime says about the legal value of an in-app signature on a diary is not settled (CXN-EXE-05): until the business confirms it every diary says so. */
export const DIARY_SIGNATURE_VALUE = { cxn: 'CXN-EXE-05', awaitingConfirmation: true } as const;

export const MAX_DIARY_BYTES = 65_536;
const WEATHER_CODE = /^[A-Z][A-Z0-9_]{1,19}$/;

export interface DiaryContent {
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The content of a diary is what the contractor writes about the day. It is an object of at most 64 KiB; `weather_code` (a code) and `workforce_count` (a whole number) are kept with the diary for the coverage and the
 * reports, and may be left out. Anything else is the contractor's own: the work done, the equipment, the incidents.
 */
export function assertDiaryContent(content: unknown): { weatherCode: string | null; workforceCount: number | null } {
  if (!isRecord(content)) throw new DomainError('VALIDATION_FAILED', 422, 'content');
  if (Object.keys(content).length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'content');
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > MAX_DIARY_BYTES) throw new DomainError('VALIDATION_FAILED', 422, 'content');
  const weather = content.weather_code;
  if (weather !== undefined && weather !== null && !(typeof weather === 'string' && WEATHER_CODE.test(weather))) throw new DomainError('VALIDATION_FAILED', 422, 'content.weather_code');
  assertDiaryLocation(content);
  const workforce = content.workforce_count;
  if (workforce !== undefined && workforce !== null && !(typeof workforce === 'number' && Number.isInteger(workforce) && workforce >= 0 && workforce <= 1_000_000)) throw new DomainError('VALIDATION_FAILED', 422, 'content.workforce_count');
  return { weatherCode: typeof weather === 'string' ? weather : null, workforceCount: typeof workforce === 'number' ? workforce : null };
}

/**
 * A place is kept in a diary only with the consent of the person it was taken from (ST-QMS-002, the consent to the location): `location` is a latitude and a longitude and comes with `geo_consent: true`. A device
 * that has no consent sends no place, and a place that comes without it is refused, not kept and not silently dropped (422 `VALIDATION_FAILED`).
 */
function assertDiaryLocation(content: Record<string, unknown>): void {
  const place = content.location;
  if (place === undefined || place === null) return;
  if (content.geo_consent !== true) throw new DomainError('VALIDATION_FAILED', 422, 'content.geo_consent');
  const latitude = isRecord(place) ? place.lat : undefined;
  const longitude = isRecord(place) ? place.lng : undefined;
  const sound = typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  if (!sound) throw new DomainError('VALIDATION_FAILED', 422, 'content.location');
}

/** The ways a person settles the conflict of two devices (QMS 3.1): keep the main diary, take the copy of the other device, or write what both said. */
export const CONFLICT_RESOLUTIONS = ['KEEP_PRIMARY', 'ADOPT_CONFLICT', 'MERGED'] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

/** 422 `VALIDATION_FAILED` unless the resolution is one of the three, `MERGED` comes with the content that merges them and the others come with none. */
export function assertConflictResolution(input: { resolution: unknown; mergedContent: unknown }): { resolution: ConflictResolution; merged: DiaryContent | null } {
  const resolution = CONFLICT_RESOLUTIONS.find((candidate) => candidate === input.resolution);
  if (resolution === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'resolution');
  if (resolution !== 'MERGED') {
    if (input.mergedContent !== undefined && input.mergedContent !== null) throw new DomainError('VALIDATION_FAILED', 422, 'merged_content');
    return { resolution, merged: null };
  }
  assertDiaryContent(input.mergedContent);
  return { resolution, merged: input.mergedContent as DiaryContent };
}

/** JSON with sorted keys and numbers written as strings (BR-QMS-02), so that the same content always gives the same text, whatever order it was written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number') return JSON.stringify(String(value));
  return JSON.stringify(value ?? null);
}

/** What a signature binds: the contract, the day, the revision it corrects (if any) and the content, in the canonical form. */
export function diaryCanonical(input: { contractId: string; recordDate: string; correctionOfId: string | null; content: DiaryContent }): string {
  return canonical({ contract_id: input.contractId.toLowerCase(), correction_of_id: input.correctionOfId?.toLowerCase() ?? null, record_date: input.recordDate, content: input.content });
}

export const diaryHashOf = (input: Parameters<typeof diaryCanonical>[0]): string => createHash('sha256').update(diaryCanonical(input)).digest('hex');

/** 422 `SIGNATURE_METHOD_NOT_ACCEPTED` unless a certificate comes with its serial and nothing else does. */
export function assertSignatureMethod(method: SignatureMethod, certSerial: string | null): void {
  if ((method === 'DIGITAL_CERT') !== (certSerial !== null)) throw new DomainError('SIGNATURE_METHOD_NOT_ACCEPTED', 422, 'signature_method', { extensions: { signature_method: method } });
}
