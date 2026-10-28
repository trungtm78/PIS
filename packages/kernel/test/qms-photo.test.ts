import { PHOTO_ZONE_RADIUS_M, accuracyOf, checkExif, checkGeofence, checkTime, decimalOf, distanceMetres, exifJpeg, readExif, strippedJpeg, summariseChecks } from '../src/index.ts';
import type { DomainError } from '../src/index.ts';

const thrown = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('did not throw');
};

const ZONE = { lat: 10.8, lng: 106.7, radiusM: PHOTO_ZONE_RADIUS_M };
const RECEIVED = new Date('2026-06-10T10:00:00Z'); // 17:00 in Vietnam

describe('the EXIF of a photo (ST-QMS-003, BR-QMS-06)', () => {
  it('reads the clock, the place, the model and the GPS time that a camera writes', () => {
    const exif = readExif(exifJpeg({ takenAt: '2026:06:10 08:15:00', model: 'Pixel 8', gps: { lat: 10.8002, lng: 106.7003 }, gpsAt: { day: '2026:06:10', h: 1, m: 15, s: 0 } }));
    expect(exif).toMatchObject({ present: true, malformed: false, model: 'Pixel 8' });
    // The clock of a camera that names no zone is the clock of Vietnam.
    expect(exif.takenAt?.toISOString()).toBe('2026-06-10T01:15:00.000Z');
    expect(exif.gps?.lat).toBeCloseTo(10.8002, 5);
    expect(exif.gps?.lng).toBeCloseTo(106.7003, 5);
    expect(exif.gpsAt?.toISOString()).toBe('2026-06-10T01:15:00.000Z');
  });

  it('honours the zone that a camera writes, and the south and the west', () => {
    const exif = readExif(exifJpeg({ takenAt: '2026:06:10 08:15:00', offset: '+09:00', gps: { lat: -33.5, lng: -70.25 } }));
    expect(exif.takenAt?.toISOString()).toBe('2026-06-09T23:15:00.000Z');
    expect(exif.gps?.lat).toBeCloseTo(-33.5, 5);
    expect(exif.gps?.lng).toBeCloseTo(-70.25, 5);
  });

  it('says that a file has no EXIF, is not a JPEG, or has an EXIF that cannot be read, and never throws on what it is given', () => {
    expect(readExif(strippedJpeg())).toMatchObject({ present: false });
    expect(readExif(Buffer.from('not an image'))).toMatchObject({ present: false });
    expect(readExif(new Uint8Array(0))).toMatchObject({ present: false });
    const good = exifJpeg({ takenAt: '2026:06:10 08:15:00', gps: { lat: 10.8, lng: 106.7 } });
    // Cut anywhere, a file is read to what it holds or is said to be malformed; nothing is thrown.
    for (let cut = 0; cut < good.length; cut += 1) expect(() => readExif(good.subarray(0, cut))).not.toThrow();
    expect(readExif(good.subarray(0, 40))).toMatchObject({ present: true, malformed: true });
    // A file that lies about the size of its table.
    const lying = Buffer.from(good);
    lying.writeUInt16LE(60000, 20 + 8);
    expect(() => readExif(lying)).not.toThrow();
    // A date that is written and is not a date.
    expect(readExif(exifJpeg({ takenAt: '2026:06:31 08:15:00' }))).toMatchObject({ present: true, malformed: true, takenAt: null });
    expect(readExif(exifJpeg({ takenAt: 'yesterday' }))).toMatchObject({ malformed: true });
    // A clock with a minute, an hour or a second that does not exist, or a zone that does not, is not carried into the next hour: it is not a time.
    for (const takenAt of ['2026:06:10 08:99:00', '2026:06:10 24:00:00', '2026:06:10 08:15:60', '2026:06:10 25:15:00']) expect(readExif(exifJpeg({ takenAt }))).toMatchObject({ present: true, malformed: true, takenAt: null });
    for (const offset of ['+15:00', '+07:99']) expect(readExif(exifJpeg({ takenAt: '2026:06:10 08:15:00', offset }))).toMatchObject({ malformed: true, takenAt: null });
    expect(checkExif(readExif(exifJpeg({ takenAt: '2026:06:10 08:99:00' })))).toBe('INCONSISTENT');
    // A zone that is written and is not one is not the clock of Vietnam; a zone of blanks is no zone.
    for (const offset of ['garbage', '07:00', '+7:00']) expect(readExif(exifJpeg({ takenAt: '2026:06:10 08:15:00', offset }))).toMatchObject({ malformed: true, takenAt: null });
    expect(readExif(exifJpeg({ takenAt: '2026:06:10 08:15:00', offset: '   :  ' })).takenAt?.toISOString()).toBe('2026-06-10T01:15:00.000Z');
    // A hemisphere that is neither of the two is not the north or the east.
    for (const hemispheres of [
      { lat: 'X', lng: 'E' },
      { lat: 'N', lng: '?' },
      { lat: 'E', lng: 'N' },
      { lat: 'n', lng: 'E' },
    ]) {
      const exif = readExif(exifJpeg({ takenAt: '2026:06:10 08:15:00', gps: { lat: 10.8, lng: 106.7 }, hemispheres }));
      expect([hemispheres.lat, hemispheres.lng, exif.malformed, exif.gps, checkExif(exif)]).toEqual([hemispheres.lat, hemispheres.lng, true, null, 'INCONSISTENT']);
    }
    // The same for the clock of the GPS: a day or a time that does not exist is not carried over into the next one.
    for (const gpsAt of [
      { day: '2026:06:31', h: 1, m: 0, s: 0 },
      { day: '2026:06:10', h: 24, m: 0, s: 0 },
      { day: '2026:06:10', h: 1, m: 60, s: 0 },
      { day: '2026:06:10', h: 1, m: 0, s: 60 },
      { day: '2026:13:10', h: 1, m: 0, s: 0 },
    ]) {
      const exif = readExif(exifJpeg({ takenAt: '2026:07:01 08:00:00', gps: { lat: 10.8, lng: 106.7 }, gpsAt }));
      expect([gpsAt.day, gpsAt.h, gpsAt.m, gpsAt.s, exif.malformed, exif.gpsAt, checkExif(exif)]).toEqual([gpsAt.day, gpsAt.h, gpsAt.m, gpsAt.s, true, null, 'INCONSISTENT']);
    }
  });

  it('keeps the distance on the earth in metres', () => {
    expect(distanceMetres({ lat: 10.8, lng: 106.7 }, { lat: 10.8, lng: 106.7 })).toBe(0);
    expect(distanceMetres({ lat: 10.8, lng: 106.7 }, { lat: 10.8002, lng: 106.7003 })).toBeGreaterThan(30);
    expect(distanceMetres({ lat: 10.8, lng: 106.7 }, { lat: 10.8002, lng: 106.7003 })).toBeLessThan(45);
    expect(distanceMetres({ lat: 10.8, lng: 106.7 }, { lat: 10.9, lng: 106.8 })).toBeGreaterThan(15_000);
  });
});

describe('the four checks and their summary (BR-QMS-06): flags to review, never a verdict', () => {
  it('AC-ST-QMS-003-1: UAT-AC359 judges time against the day of the diary and the moment the server received the photo', () => {
    const at = (iso: string): Date => new Date(iso);
    expect(checkTime({ takenAt: at('2026-06-10T01:15:00Z'), receivedAt: RECEIVED, day: '2026-06-10' })).toBe('OK');
    // The days either side are inside the tolerance of a day from the span of the day; five days away is not.
    expect(checkTime({ takenAt: at('2026-06-09T16:00:00Z'), receivedAt: RECEIVED, day: '2026-06-10' })).toBe('OK');
    expect(checkTime({ takenAt: at('2026-06-04T16:00:00Z'), receivedAt: RECEIVED, day: '2026-06-10' })).toBe('SKEW');
    expect(checkTime({ takenAt: at('2026-06-05T01:15:00Z'), receivedAt: RECEIVED, day: '2026-06-10' })).toBe('SKEW');
    // A photo taken after the server received it cannot have been.
    expect(checkTime({ takenAt: at('2026-06-10T11:00:00Z'), receivedAt: RECEIVED, day: '2026-06-10' })).toBe('SKEW');
    expect(checkTime({ takenAt: null, receivedAt: RECEIVED, day: '2026-06-10' })).toBe('MISSING');
    // Without a diary the photo is judged against the moment it was received.
    expect(checkTime({ takenAt: at('2026-06-10T01:15:00Z'), receivedAt: RECEIVED, day: null })).toBe('OK');
    expect(checkTime({ takenAt: at('2026-06-08T01:15:00Z'), receivedAt: RECEIVED, day: null })).toBe('SKEW');
  });

  it('AC-ST-QMS-003-1: UAT-AC359 judges the place against the zone of the site, and does not judge a place that is not exact', () => {
    expect(checkGeofence({ place: { lat: 10.8002, lng: 106.7003 }, accuracyM: 8, zone: ZONE })).toBe('INSIDE');
    expect(checkGeofence({ place: { lat: 10.9, lng: 106.8 }, accuracyM: 8, zone: ZONE })).toBe('OUTSIDE');
    expect(checkGeofence({ place: { lat: 10.8, lng: 106.7 }, accuracyM: 120, zone: ZONE })).toBe('LOW_ACCURACY');
    expect(checkGeofence({ place: { lat: 10.8002, lng: 106.7003 }, accuracyM: 50, zone: ZONE })).toBe('INSIDE');
    expect(checkGeofence({ place: { lat: 10.8002, lng: 106.7003 }, accuracyM: null, zone: ZONE })).toBe('INSIDE');
    expect(checkGeofence({ place: null, accuracyM: null, zone: ZONE })).toBe('MISSING');
    expect(checkGeofence({ place: { lat: 10.8, lng: 106.7 }, accuracyM: 5, zone: null })).toBe('MISSING');
  });

  it('AC-ST-QMS-003-1: UAT-AC359 says whether the EXIF is there, readable, and agrees with itself', () => {
    expect(checkExif(readExif(exifJpeg({ takenAt: '2026:06:10 08:15:00', gps: { lat: 10.8, lng: 106.7 }, gpsAt: { day: '2026:06:10', h: 1, m: 20, s: 0 } })))).toBe('CONSISTENT');
    expect(checkExif(readExif(strippedJpeg()))).toBe('STRIPPED');
    expect(checkExif(readExif(exifJpeg({ takenAt: 'yesterday' })))).toBe('INCONSISTENT');
    // The GPS says three hours after the camera.
    expect(checkExif(readExif(exifJpeg({ takenAt: '2026:06:10 08:15:00', gpsAt: { day: '2026:06:10', h: 4, m: 15, s: 0 }, gps: { lat: 10.8, lng: 106.7 } })))).toBe('INCONSISTENT');
  });

  it('summarises as PASS only when all four are good, and as WARN otherwise: never as a verdict of true or false', () => {
    const good = { time: 'OK', geofence: 'INSIDE', duplicate: 'UNIQUE', exif: 'CONSISTENT' } as const;
    expect(summariseChecks(good)).toBe('PASS');
    for (const flag of [{ time: 'SKEW' }, { time: 'MISSING' }, { geofence: 'OUTSIDE' }, { geofence: 'LOW_ACCURACY' }, { geofence: 'MISSING' }, { duplicate: 'DUPLICATE_SAME_SITE' }, { duplicate: 'DUPLICATE_OTHER_SITE' }, { exif: 'STRIPPED' }, { exif: 'INCONSISTENT' }]) {
      expect(summariseChecks({ ...good, ...flag } as never)).toBe('WARN');
    }
  });

  it('takes a place and an accuracy as a device writes them, and nothing else', () => {
    expect(decimalOf('10.8002', 'device_gps_lat', 90)).toBe(10.8002);
    expect(decimalOf('-106.7', 'device_gps_lng', 180)).toBe(-106.7);
    for (const bad of ['', 'abc', '10,8', '91', '1e3', '10.123456789', '--1', ' ']) expect(thrown(() => decimalOf(bad, 'device_gps_lat', 90)).code).toBe('VALIDATION_FAILED');
    expect(accuracyOf('8', 'device_gps_accuracy_m')).toBe(8);
    expect(accuracyOf('120.5', 'device_gps_accuracy_m')).toBe(120.5);
    for (const bad of ['', '-1', 'NaN', '1e2', '123456']) expect(thrown(() => accuracyOf(bad, 'device_gps_accuracy_m')).code).toBe('VALIDATION_FAILED');
  });
});
