import { DomainError } from './errors.ts';
import { distanceMetres } from './qms-photo.ts';

/**
 * The review register of site photos across projects (G4-12, should-have part): the check of one photo in QMS (time, place, EXIF, repeat of the file) is a flag, and this is the second look that no single photo can give:
 * the same file, or the same place at the same moment, in more than one project. A photo cannot be in two projects at once, so such a pair is something for a person to explain. Like the flags of QMS it is a signal and
 * never a statement that a photo is false. The distances and times are the governance rule `PHOTO_INTEGRITY_RULE` (UNVERIFIED); everything here is a pure function of what the photos say about themselves.
 */

export const PHOTO_INTEGRITY_RULE_TYPE = 'PHOTO_INTEGRITY_RULE';

export interface PhotoIntegrityPolicy {
  /** Two photos taken within this many metres of each other count as the same place. */
  place_metres: number;
  /** Two photos taken within this many minutes of each other count as the same moment. */
  moment_minutes: number;
}

export const photoIntegrityDefaults = (): PhotoIntegrityPolicy => ({ place_metres: 30, moment_minutes: 10 });

export function photoIntegrityPolicyOf(params: Readonly<Record<string, unknown>>): PhotoIntegrityPolicy {
  const metres = params.place_metres;
  const minutes = params.moment_minutes;
  if (typeof metres !== 'number' || !Number.isInteger(metres) || metres < 1 || metres > 5000) throw new DomainError('VALIDATION_FAILED', 422, 'place_metres');
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new DomainError('VALIDATION_FAILED', 422, 'moment_minutes');
  return { place_metres: metres, moment_minutes: minutes };
}

export const PHOTO_FINDING_KINDS = ['SAME_FILE_OTHER_PROJECT', 'SAME_PLACE_AND_MOMENT_OTHER_PROJECT', 'SAME_FILE_OTHER_DAY'] as const;
export type PhotoFindingKind = (typeof PHOTO_FINDING_KINDS)[number];

export interface PhotoFact {
  id: string;
  projectId: string;
  sha256: string;
  /** The day of the diary the photo belongs to, or null. */
  diaryDay: string | null;
  takenAt: Date | null;
  lat: number | null;
  lng: number | null;
}

export interface PhotoPair {
  kind: PhotoFindingKind;
  /** The two photo ids in the canonical order (the smaller id first), so one pair is one finding whoever is looked at first. */
  firstId: string;
  secondId: string;
  /** What the pair measured: metres and minutes for the place and moment kind, null otherwise. */
  metres: number | null;
  minutes: number | null;
}

const ordered = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/**
 * The pairs that need a person's explanation. A pair is reported once, with the kind that fits it best (the same file outranks the same place and moment). The place and moment kind needs both photos to carry a place
 * and a time and to be in different projects; a photo with neither is never paired by it, so a missing EXIF is not turned into a finding (QMS already flags the missing EXIF).
 */
export function findPhotoPairs(photos: readonly PhotoFact[], policy: PhotoIntegrityPolicy): PhotoPair[] {
  const found = new Map<string, PhotoPair>();
  const put = (pair: PhotoPair): void => {
    const key = `${pair.firstId}:${pair.secondId}`;
    const known = found.get(key);
    if (known === undefined || PHOTO_FINDING_KINDS.indexOf(pair.kind) < PHOTO_FINDING_KINDS.indexOf(known.kind)) found.set(key, pair);
  };
  const byHash = new Map<string, PhotoFact[]>();
  for (const photo of photos) {
    const list = byHash.get(photo.sha256);
    if (list === undefined) byHash.set(photo.sha256, [photo]);
    else list.push(photo);
  }
  for (const group of byHash.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i] as PhotoFact;
        const b = group[j] as PhotoFact;
        const [firstId, secondId] = ordered(a.id, b.id);
        if (a.projectId !== b.projectId) put({ kind: 'SAME_FILE_OTHER_PROJECT', firstId, secondId, metres: null, minutes: null });
        else if (a.diaryDay !== null && b.diaryDay !== null && a.diaryDay !== b.diaryDay) put({ kind: 'SAME_FILE_OTHER_DAY', firstId, secondId, metres: null, minutes: null });
      }
    }
  }
  const located = photos.filter((photo): photo is PhotoFact & { takenAt: Date; lat: number; lng: number } => photo.takenAt !== null && photo.lat !== null && photo.lng !== null);
  for (let i = 0; i < located.length; i += 1) {
    for (let j = i + 1; j < located.length; j += 1) {
      const a = located[i] as (typeof located)[number];
      const b = located[j] as (typeof located)[number];
      if (a.projectId === b.projectId) continue;
      const minutes = Math.abs(a.takenAt.getTime() - b.takenAt.getTime()) / 60_000;
      if (minutes > policy.moment_minutes) continue;
      const metres = distanceMetres(a, b);
      if (metres > policy.place_metres) continue;
      const [firstId, secondId] = ordered(a.id, b.id);
      put({ kind: 'SAME_PLACE_AND_MOMENT_OTHER_PROJECT', firstId, secondId, metres: Math.round(metres), minutes: Math.round(minutes * 10) / 10 });
    }
  }
  return [...found.values()].sort((a, b) => (a.firstId + a.secondId < b.firstId + b.secondId ? -1 : 1));
}

export const PHOTO_FINDING_STATUSES = ['OPEN', 'IN_REVIEW', 'EXPLAINED', 'REFERRED'] as const;
export type PhotoFindingStatus = (typeof PHOTO_FINDING_STATUSES)[number];
export type PhotoFindingMove = 'TAKE' | 'EXPLAIN' | 'REFER' | 'REOPEN';

const EDGES: Readonly<Record<PhotoFindingStatus, Readonly<Partial<Record<PhotoFindingMove, PhotoFindingStatus>>>>> = {
  OPEN: { TAKE: 'IN_REVIEW' },
  IN_REVIEW: { EXPLAIN: 'EXPLAINED', REFER: 'REFERRED' },
  EXPLAINED: { REOPEN: 'IN_REVIEW' },
  REFERRED: {},
};

export function nextPhotoFindingStatus(from: PhotoFindingStatus, move: PhotoFindingMove): PhotoFindingStatus {
  const to = EDGES[from][move];
  if (to === undefined) throw new DomainError('PHOTO_FINDING_STATE_INVALID', 409, 'status');
  return to;
}

/** An explanation or a referral gives its reason; the person who explains a pair is neither the author of one of its photos nor the person who reported it, which the store checks with the photo authors. */
export function assertPhotoFindingMove(input: { move: PhotoFindingMove; reason: string | null; actorId: string; photoAuthorIds: readonly string[] }): void {
  if ((input.move === 'EXPLAIN' || input.move === 'REFER' || input.move === 'REOPEN') && (input.reason === null || input.reason.trim().length < 10)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  if (input.move !== 'TAKE' && input.photoAuthorIds.includes(input.actorId)) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
}
