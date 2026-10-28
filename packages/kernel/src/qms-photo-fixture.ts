/**
 * A JPEG with an EXIF block, for the tests of the site photo register (ST-QMS-003): the camera clock, the place, the model and the moment the GPS says, written the way a camera writes them (little-endian TIFF in an APP1
 * segment), followed by a body that is the bytes given, so that two photos differ in their hash. It is a fixture, not an encoder: the body is not an image.
 */
export interface ExifJpegInput {
  /** The clock of the camera, `2026:06:10 08:15:00` (EXIF writes it with no zone). */
  takenAt?: string;
  /** The zone of the camera clock, `+07:00` (EXIF 2.31); left out by most phones. */
  offset?: string;
  /** The hemispheres a file writes for its place (`N` and `E` by the sign); only to write a file that is wrong. */
  hemispheres?: { lat: string; lng: string };
  model?: string;
  gps?: { lat: number; lng: number };
  /** `2026:06:10` and the hours, minutes and seconds of the GPS clock, in UTC. */
  gpsAt?: { day: string; h: number; m: number; s: number };
  /** The bytes after the headers: a different body is a different file. */
  body?: string;
}

type Entry = { tag: number; type: number; count: number; value: Buffer | number };

/** An IFD that starts at `base` in the TIFF block: the table, then the values that do not fit in four bytes. */
function ifd(base: number, entries: Entry[]): Buffer {
  const sorted = [...entries].sort((left, right) => left.tag - right.tag);
  const table = 2 + sorted.length * 12 + 4;
  const head = Buffer.alloc(table);
  head.writeUInt16LE(sorted.length, 0);
  const extra: Buffer[] = [];
  let used = table;
  sorted.forEach((entry, index) => {
    const at = 2 + index * 12;
    head.writeUInt16LE(entry.tag, at);
    head.writeUInt16LE(entry.type, at + 2);
    head.writeUInt32LE(entry.count, at + 4);
    if (typeof entry.value === 'number') head.writeUInt32LE(entry.value, at + 8);
    else if (entry.value.length <= 4) entry.value.copy(head, at + 8);
    else {
      head.writeUInt32LE(base + used, at + 8);
      extra.push(entry.value);
      used += entry.value.length;
    }
  });
  return Buffer.concat([head, ...extra]);
}

const text = (value: string): Entry['value'] => Buffer.from(`${value}\0`, 'ascii');
const rationals = (values: number[], scale = 1000000): Buffer => {
  const buffer = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => {
    buffer.writeUInt32LE(Math.round(value * scale), index * 8);
    buffer.writeUInt32LE(scale, index * 8 + 4);
  });
  return buffer;
};
const degreesOf = (value: number): number[] => {
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute);
  const minutes = (absolute - whole) * 60;
  return [whole, Math.floor(minutes), (minutes - Math.floor(minutes)) * 60];
};

export function exifJpeg(input: ExifJpegInput = {}): Buffer {
  const root: Entry[] = [];
  const exif: Entry[] = [];
  const gps: Entry[] = [];
  if (input.model !== undefined) root.push({ tag: 0x0110, type: 2, count: input.model.length + 1, value: text(input.model) });
  if (input.takenAt !== undefined) exif.push({ tag: 0x9003, type: 2, count: input.takenAt.length + 1, value: text(input.takenAt) });
  if (input.offset !== undefined) exif.push({ tag: 0x9011, type: 2, count: input.offset.length + 1, value: text(input.offset) });
  if (input.gps !== undefined) {
    gps.push({ tag: 1, type: 2, count: 2, value: text(input.hemispheres?.lat ?? (input.gps.lat >= 0 ? 'N' : 'S')) });
    gps.push({ tag: 2, type: 5, count: 3, value: rationals(degreesOf(input.gps.lat), 1000000) });
    gps.push({ tag: 3, type: 2, count: 2, value: text(input.hemispheres?.lng ?? (input.gps.lng >= 0 ? 'E' : 'W')) });
    gps.push({ tag: 4, type: 5, count: 3, value: rationals(degreesOf(input.gps.lng), 1000000) });
  }
  if (input.gpsAt !== undefined) {
    gps.push({ tag: 7, type: 5, count: 3, value: rationals([input.gpsAt.h, input.gpsAt.m, input.gpsAt.s], 1) });
    gps.push({ tag: 29, type: 2, count: input.gpsAt.day.length + 1, value: text(input.gpsAt.day) });
  }
  // Pass one gives the lengths, which do not depend on the pointers; pass two writes them.
  if (exif.length > 0) root.push({ tag: 0x8769, type: 4, count: 1, value: 0 });
  if (gps.length > 0) root.push({ tag: 0x8825, type: 4, count: 1, value: 0 });
  const rootLength = ifd(8, root).length;
  const exifLength = exif.length > 0 ? ifd(8 + rootLength, exif).length : 0;
  const rootFinal = root.map((entry) => (entry.tag === 0x8769 ? { ...entry, value: 8 + rootLength } : entry.tag === 0x8825 ? { ...entry, value: 8 + rootLength + exifLength } : entry));
  const parts = [ifd(8, rootFinal)];
  if (exif.length > 0) parts.push(ifd(8 + rootLength, exif));
  if (gps.length > 0) parts.push(ifd(8 + rootLength + exifLength, gps));
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const tiff = Buffer.concat([header, ...parts]);
  const exifBlock = root.length > 0 ? Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]) : null;
  const app1 = exifBlock === null ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0xff, 0xe1, (exifBlock.length + 2) >> 8, (exifBlock.length + 2) & 0xff]), exifBlock]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from(input.body ?? 'photo', 'utf8'), Buffer.from([0xff, 0xd9])]);
}

/** A JPEG that has been through something that removes EXIF: no block at all. */
export const strippedJpeg = (body = 'photo'): Buffer => exifJpeg({ body });
