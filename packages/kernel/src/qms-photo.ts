import { DomainError } from './errors.ts';

/**
 * The site photo register (ST-QMS-003, QMS 3.4, BR-QMS-06): a photo that was uploaded to the storage is registered with four checks of time, place, repetition and EXIF, which are flags for a person to review and nothing
 * more. A flag never rejects a photo and never says that a photo is true or false; the thresholds are assumptions to be measured on the photos of the pilot (R-QMS-03). Everything here is a pure function of what the photo
 * says about itself, so that the same photo always gets the same flags.
 */

/** A capture within a day of the day of the diary, and a place within this many metres of the site, are in order [ASSUMPTION, R-QMS-03]. */
export const PHOTO_TIME_TOLERANCE_MS = 24 * 3_600_000;
export const PHOTO_ZONE_RADIUS_M = 500;
/** A place that is less exact than this is not judged against the site [ASSUMPTION]. */
export const PHOTO_GPS_ACCURACY_M = 50;
/** The time of the GPS and the time of the capture, in the file, are one moment within this long [ASSUMPTION]. */
export const PHOTO_EXIF_GPS_SKEW_MS = 3_600_000;
/** The clock of a camera that says nothing of its zone is taken to be the clock of Vietnam. */
const DEFAULT_OFFSET_MINUTES = 7 * 60;

export const PHOTO_CHECKS_TIME = ['OK', 'SKEW', 'MISSING'] as const;
export const PHOTO_CHECKS_GEOFENCE = ['INSIDE', 'OUTSIDE', 'LOW_ACCURACY', 'MISSING'] as const;
export const PHOTO_CHECKS_DUPLICATE = ['UNIQUE', 'DUPLICATE_SAME_SITE', 'DUPLICATE_OTHER_SITE'] as const;
export const PHOTO_CHECKS_EXIF = ['CONSISTENT', 'STRIPPED', 'INCONSISTENT'] as const;
export const PHOTO_CHECKS_SUMMARY = ['PASS', 'WARN', 'FAIL'] as const;
export type PhotoTimeCheck = (typeof PHOTO_CHECKS_TIME)[number];
export type PhotoGeofenceCheck = (typeof PHOTO_CHECKS_GEOFENCE)[number];
export type PhotoDuplicateCheck = (typeof PHOTO_CHECKS_DUPLICATE)[number];
export type PhotoExifCheck = (typeof PHOTO_CHECKS_EXIF)[number];
export type PhotoSummary = (typeof PHOTO_CHECKS_SUMMARY)[number];

export interface ExifData {
  /** Whether the file carries an EXIF block at all. */
  present: boolean;
  /** An EXIF block that cannot be read to its end. */
  malformed: boolean;
  /** When the camera says the photo was taken. */
  takenAt: Date | null;
  /** Where the camera says it was, and when the GPS says it was. */
  gps: { lat: number; lng: number } | null;
  gpsAt: Date | null;
  model: string | null;
}

const EMPTY: ExifData = { present: false, malformed: false, takenAt: null, gps: null, gpsAt: null, model: null };

const TYPE_SIZE: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

class Truncated extends Error {}

/** A reader over the TIFF block of an EXIF segment: every read is bounds-checked, so a file that lies about its sizes ends in `Truncated`, not in a crash. */
class Tiff {
  private readonly view: DataView;
  private readonly little: boolean;

  private readonly bytes: Uint8Array;
  private readonly start: number;
  private readonly end: number;

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes;
    this.start = start;
    this.end = end;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = String.fromCharCode(bytes[start] ?? 0, bytes[start + 1] ?? 0);
    if (order !== 'II' && order !== 'MM') throw new Truncated();
    this.little = order === 'II';
    if (this.u16(2) !== 0x2a) throw new Truncated();
  }

  private guard(offset: number, length: number): number {
    const at = this.start + offset;
    if (offset < 0 || length < 0 || at + length > this.end) throw new Truncated();
    return at;
  }
  u16(offset: number): number {
    return this.view.getUint16(this.guard(offset, 2), this.little);
  }
  u32(offset: number): number {
    return this.view.getUint32(this.guard(offset, 4), this.little);
  }
  ascii(offset: number, length: number): string {
    const at = this.guard(offset, length);
    let text = '';
    for (let index = 0; index < length; index += 1) {
      const code = this.bytes[at + index] ?? 0;
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text;
  }
  rational(offset: number): number {
    const denominator = this.u32(offset + 4);
    return denominator === 0 ? Number.NaN : this.u32(offset) / denominator;
  }

  /** The entries of the IFD at `offset`: tag, type, count and the offset where the value is (inline in the entry when it fits in four bytes). */
  ifd(offset: number): Array<{ tag: number; type: number; count: number; at: number }> {
    const count = this.u16(offset);
    if (count > 512) throw new Truncated();
    const entries: Array<{ tag: number; type: number; count: number; at: number }> = [];
    for (let index = 0; index < count; index += 1) {
      const entry = offset + 2 + index * 12;
      const type = this.u16(entry + 2);
      const items = this.u32(entry + 4);
      const size = (TYPE_SIZE[type] ?? 1) * items;
      entries.push({ tag: this.u16(entry), type, count: items, at: size <= 4 ? entry + 8 : this.u32(entry + 8) });
    }
    return entries;
  }
}

const find = (entries: Array<{ tag: number; type: number; count: number; at: number }>, tag: number) => entries.find((entry) => entry.tag === tag);

/** `2026:06:10 08:15:00` with an optional offset (`+07:00`), as the instant it names; a text that is not a time is null. */
function exifTime(text: string, offset: string | null): Date | null {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number) as [number, number, number, number, number, number, number];
  // The clock names an hour, a minute and a second that exist: Date.UTC would carry 08:99 into the next hour and fabricate a time.
  if (hour > 23 || minute > 59 || second > 59) return null;
  let minutes = DEFAULT_OFFSET_MINUTES;
  // A camera that does not know its zone writes blanks (EXIF 2.31); a zone that is written and is not one is a file that disagrees with itself, not the clock of Vietnam.
  const written = offset === null || /^[ :]*$/.test(offset) ? null : offset.trim();
  const zone = written === null ? null : /^([+-])(\d{2}):(\d{2})$/.exec(written);
  if (written !== null && zone === null) return null;
  if (zone !== null) {
    if (Number(zone[2]) > 14 || Number(zone[3]) > 59) return null;
    minutes = (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
  }
  const moment = Date.UTC(year, month - 1, day, hour, minute, second) - minutes * 60_000;
  const date = new Date(moment);
  // A date that rolled over (the 31st of June) was not a date.
  const local = new Date(moment + minutes * 60_000);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
  return date;
}

/** Whether the year, month and day name a day of the calendar (the 31st of June does not). */
function realDay(year: number, month: number, day: number): boolean {
  const moment = new Date(Date.UTC(year, month - 1, day));
  return moment.getUTCFullYear() === year && moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day;
}

function degrees(tiff: Tiff, entry: { type: number; count: number; at: number }, reference: string, positive: 'N' | 'E', negative: 'S' | 'W'): number | null {
  if (entry.type !== 5 || entry.count !== 3) return null;
  // The hemisphere is one of the two it can be; anything else is a file that disagrees with itself, not the north or the east.
  if (reference !== positive && reference !== negative) return null;
  const value = tiff.rational(entry.at) + tiff.rational(entry.at + 8) / 60 + tiff.rational(entry.at + 16) / 3600;
  if (!Number.isFinite(value)) return null;
  return reference === negative ? -value : value;
}

/**
 * What a JPEG says about itself: when it was taken, where, with what. Only JPEG carries EXIF here (the storage takes PNG and WebP too, which carry none that is read, so they are STRIPPED). Nothing in the file is trusted: an
 * EXIF block that does not read to its end is `malformed`, and a value that is not a date or a place is left out.
 */
export function readExif(bytes: Uint8Array): ExifData {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return EMPTY;
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 0xff) break;
    const marker = bytes[position + 1] ?? 0;
    if (marker === 0xff) {
      position += 1;
      continue;
    }
    // The start of the scan, the end of the image and the markers without a length end the headers.
    if (marker === 0xda || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) break;
    const length = ((bytes[position + 2] ?? 0) << 8) | (bytes[position + 3] ?? 0);
    if (length < 2 || position + 2 + length > bytes.length) return { ...EMPTY, present: true, malformed: true };
    const segment = position + 4;
    const end = position + 2 + length;
    const isExif = marker === 0xe1 && String.fromCharCode(...bytes.subarray(segment, segment + 6)) === 'Exif\0\0';
    if (isExif) return parseTiff(bytes, segment + 6, end);
    position = end;
  }
  return EMPTY;
}

function parseTiff(bytes: Uint8Array, start: number, end: number): ExifData {
  try {
    const tiff = new Tiff(bytes, start, end);
    const root = tiff.ifd(tiff.u32(4));
    const result: ExifData = { present: true, malformed: false, takenAt: null, gps: null, gpsAt: null, model: null };
    const model = find(root, 0x0110);
    if (model !== undefined && model.type === 2) result.model = tiff.ascii(model.at, model.count).trim() || null;
    let taken: string | null = null;
    let offset: string | null = null;
    const exifPointer = find(root, 0x8769);
    if (exifPointer !== undefined) {
      const exif = tiff.ifd(tiff.u32(exifPointer.at));
      const original = find(exif, 0x9003);
      if (original !== undefined && original.type === 2) taken = tiff.ascii(original.at, original.count);
      const zone = find(exif, 0x9011);
      if (zone !== undefined && zone.type === 2) offset = tiff.ascii(zone.at, zone.count);
    }
    if (taken === null) {
      const modified = find(root, 0x0132);
      if (modified !== undefined && modified.type === 2) taken = tiff.ascii(modified.at, modified.count);
    }
    if (taken !== null) {
      result.takenAt = exifTime(taken, offset);
      // A date that is written and is not a date is a file that disagrees with itself.
      if (result.takenAt === null) result.malformed = true;
    }
    const gpsPointer = find(root, 0x8825);
    if (gpsPointer !== undefined) {
      const gps = tiff.ifd(tiff.u32(gpsPointer.at));
      const latitude = find(gps, 2);
      const longitude = find(gps, 4);
      const latitudeRef = find(gps, 1);
      const longitudeRef = find(gps, 3);
      if (latitude !== undefined && longitude !== undefined && latitudeRef !== undefined && longitudeRef !== undefined) {
        const lat = degrees(tiff, latitude, tiff.ascii(latitudeRef.at, 1), 'N', 'S');
        const lng = degrees(tiff, longitude, tiff.ascii(longitudeRef.at, 1), 'E', 'W');
        if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) result.gps = { lat, lng };
        else result.malformed = true;
      }
      const stamp = find(gps, 7);
      const day = find(gps, 29);
      if (stamp !== undefined && day !== undefined && stamp.type === 5 && stamp.count === 3 && day.type === 2) {
        const parts = /^(\d{4}):(\d{2}):(\d{2})$/.exec(tiff.ascii(day.at, day.count).trim());
        const clock = [tiff.rational(stamp.at), tiff.rational(stamp.at + 8), tiff.rational(stamp.at + 16)] as const;
        // The GPS names a day and an hour, a minute and a second that exist; one that does not is a file that disagrees with itself, not a time to be carried over into the next day.
        const sound = parts !== null && clock.every((part) => Number.isFinite(part) && part >= 0) && clock[0] < 24 && clock[1] < 60 && clock[2] < 60 && realDay(Number(parts[1]), Number(parts[2]), Number(parts[3]));
        if (sound && parts !== null) result.gpsAt = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) + (clock[0] * 3600 + clock[1] * 60 + clock[2]) * 1000);
        else result.malformed = true;
      }
    }
    return result;
  } catch (error) {
    if (error instanceof Truncated || error instanceof RangeError) return { ...EMPTY, present: true, malformed: true };
    throw error;
  }
}

/** The distance in metres between two places on the earth (haversine). */
export function distanceMetres(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = radians(to.lat - from.lat);
  const dLng = radians(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** `YYYY-MM-DD` of an instant in Vietnam. */
const vietnamDay = (instant: Date): string => new Date(instant.getTime() + DEFAULT_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

/**
 * Time (BR-QMS-06): MISSING without a capture time; OK when the capture is no later than the moment the server received the photo and no more than a day away from the day of the diary (the day itself being the
 * span from its start to its end in Vietnam; without a diary, from the moment of reception); SKEW otherwise.
 */
export function checkTime(input: { takenAt: Date | null; receivedAt: Date; day: string | null }): PhotoTimeCheck {
  if (input.takenAt === null) return 'MISSING';
  if (input.takenAt.getTime() > input.receivedAt.getTime()) return 'SKEW';
  if (input.day === null) return input.receivedAt.getTime() - input.takenAt.getTime() <= PHOTO_TIME_TOLERANCE_MS ? 'OK' : 'SKEW';
  const startOfDay = Date.parse(`${input.day}T00:00:00Z`) - DEFAULT_OFFSET_MINUTES * 60_000;
  const endOfDay = startOfDay + 24 * 3_600_000;
  const gap = input.takenAt.getTime() < startOfDay ? startOfDay - input.takenAt.getTime() : input.takenAt.getTime() >= endOfDay ? input.takenAt.getTime() - endOfDay : 0;
  return gap <= PHOTO_TIME_TOLERANCE_MS ? 'OK' : 'SKEW';
}

/**
 * Place (BR-QMS-06): MISSING without a place or without a zone of the site to compare it to; LOW_ACCURACY when the place is less exact than 50 m; INSIDE within the radius of the zone; OUTSIDE beyond it. A place that is
 * not exact enough is not judged either way.
 */
export function checkGeofence(input: { place: { lat: number; lng: number } | null; accuracyM: number | null; zone: { lat: number; lng: number; radiusM: number } | null }): PhotoGeofenceCheck {
  if (input.place === null || input.zone === null) return 'MISSING';
  if (input.accuracyM !== null && input.accuracyM > PHOTO_GPS_ACCURACY_M) return 'LOW_ACCURACY';
  return distanceMetres(input.place, input.zone) <= input.zone.radiusM ? 'INSIDE' : 'OUTSIDE';
}

/** EXIF (BR-QMS-06): STRIPPED without any; INCONSISTENT when it cannot be read, holds a date or a place that is not one, or the GPS and the camera name moments more than an hour apart; CONSISTENT otherwise. */
export function checkExif(exif: ExifData): PhotoExifCheck {
  if (!exif.present) return 'STRIPPED';
  if (exif.malformed) return 'INCONSISTENT';
  if (exif.takenAt !== null && exif.gpsAt !== null && Math.abs(exif.takenAt.getTime() - exif.gpsAt.getTime()) > PHOTO_EXIF_GPS_SKEW_MS) return 'INCONSISTENT';
  return 'CONSISTENT';
}

/** The summary of the four: PASS when all are good, WARN when any is a flag. It is never a verdict on the photo. */
export function summariseChecks(checks: { time: PhotoTimeCheck; geofence: PhotoGeofenceCheck; duplicate: PhotoDuplicateCheck; exif: PhotoExifCheck }): PhotoSummary {
  return checks.time === 'OK' && checks.geofence === 'INSIDE' && checks.duplicate === 'UNIQUE' && checks.exif === 'CONSISTENT' ? 'PASS' : 'WARN';
}

/** The day of Vietnam a photo was received in, for the screens that group by day. */
export const photoDay = vietnamDay;

/** A decimal written as text by a device: `10.8002`, with an optional sign; anything else is not a coordinate (422 `VALIDATION_FAILED`). */
export function decimalOf(value: string, field: string, limit: number): number {
  const text = value.trim();
  if (!/^-?\d{1,3}(\.\d{1,8})?$/.test(text)) throw new DomainError('VALIDATION_FAILED', 422, field);
  const number = Number(text);
  if (!Number.isFinite(number) || Math.abs(number) > limit) throw new DomainError('VALIDATION_FAILED', 422, field);
  return number;
}

/** The accuracy of a place, in metres, written as text by a device: a non-negative number. */
export function accuracyOf(value: string, field: string): number {
  const text = value.trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(text)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return Number(text);
}
