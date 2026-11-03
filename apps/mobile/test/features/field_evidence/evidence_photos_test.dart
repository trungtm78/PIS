import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/field_evidence/evidence_photos.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/field_evidence/photo_checks.dart';

import 'exif_fixtures.dart';

const DevicePosition _here = DevicePosition(latitude: 10.8, longitude: 106.7, accuracyMetres: 9);

EvidencePhoto _photo({bool gps = false, bool time = false, String path = 'a.jpg', String? original}) =>
    EvidencePhoto(id: 'p', path: path, mime: 'image/jpeg', bytes: 10, originalPath: original, keepsPlaceOrTime: gps || time, keptGps: gps, keptTime: time);

void main() {
  group('AC-ST-MOB-021-1 UAT-AC367 BR-MOB-06 the flags a photograph is registered with', () {
    test('without the consent the place of the photograph is NONE and geo_consent false, whatever the file or the phone say; the missing place is a warning only', () {
      final PhotoChecks checks = checksOf(_photo(gps: true, time: true), FieldPlace.none);
      expect(checks.gpsSource, GpsSource.none);
      expect(checks.gpsSource.code, 'NONE');
      expect(checks.geoConsent, isFalse);
      expect(checks.placeMissing, isTrue);
      expect(checks.timeMissing, isFalse);
      expect(checks.blocking, isFalse, reason: 'a photograph is never refused for what it does not say');
      expect(checks.hasWarning, isTrue);
    });

    test('with the consent the place is the position of the phone at capture, else the one inside the file, else none', () {
      final FieldPlace measured = FieldPlace.none.withConsent(true).withDevicePosition(_here);
      expect(checksOf(_photo(), measured).gpsSource.code, 'DEVICE_AT_CAPTURE');
      expect(checksOf(_photo(), measured).geoConsent, isTrue);
      expect(checksOf(_photo(), measured).placeMissing, isFalse);
      final FieldPlace consenting = FieldPlace.none.withConsent(true);
      expect(checksOf(_photo(gps: true, time: true), consenting).gpsSource.code, 'EXIF');
      expect(checksOf(_photo(gps: true, time: true), consenting).hasWarning, isFalse);
      expect(checksOf(_photo(), consenting).gpsSource.code, 'NONE');
      expect(checksOf(_photo(), consenting).timeMissing, isTrue);
    });
  });

  group('UI-MOB-62 the photographs kept for a record', () {
    test('are stored and read back whole; one that cannot be read is left out', () {
      final EvidencePhoto photo = _photo(gps: true, time: true, original: 'o.jpg').copyWith(uploadId: 'up-1');
      final List<EvidencePhoto> back = EvidencePhoto.listFromJson(<Object?>[photo.toJson(), 'nothing', <String, Object?>{'id': 'x'}]);
      expect(back, hasLength(1));
      expect(back.single.toJson(), photo.toJson());
      expect(back.single.keptGps && back.single.keptTime, isTrue);
      expect(EvidencePhoto.listFromJson('nothing'), isEmpty);
    });

    test('lose their place and time, and the original kept beside them, when the consent goes; nothing is touched while it holds', () async {
      final Directory folder = Directory.systemTemp.createTempSync('machvon-evidence-');
      addTearDown(() => folder.deleteSync(recursive: true));
      final Uint8List tagged = geotaggedJpeg();
      final File prepared = File('${folder.path}/a.jpg')..writeAsBytesSync(tagged);
      final File original = File('${folder.path}/o.jpg')..writeAsBytesSync(tagged);
      final EvidencePhoto photo = _photo(gps: true, time: true, path: prepared.path, original: original.path);

      final List<EvidencePhoto> held = <EvidencePhoto>[photo];
      expect(identical(await enforcePhotoConsent(held, consent: true), held), isTrue, reason: 'nothing is touched while the consent holds');
      expect(readJpegMetadata(prepared.readAsBytesSync()).hasGps, isTrue);

      final EvidencePhoto stripped = (await enforcePhotoConsent(<EvidencePhoto>[photo], consent: false)).single;
      expect(stripped.keptGps || stripped.keptTime || stripped.keepsPlaceOrTime, isFalse);
      expect(readJpegMetadata(prepared.readAsBytesSync()).carriesPlaceOrTime, isFalse);
      expect(readJpegMetadata(original.readAsBytesSync()).carriesPlaceOrTime, isFalse);
      expect(stripped.bytes, prepared.lengthSync());
      // A photograph that says nothing is left as it is.
      final EvidencePhoto clean = _photo(path: '${folder.path}/missing.jpg');
      expect((await enforcePhotoConsent(<EvidencePhoto>[clean], consent: false)).single.path, clean.path);
    });

    test('are deleted with their draft, the prepared file and the original', () async {
      final Directory folder = Directory.systemTemp.createTempSync('machvon-evidence-');
      addTearDown(() => folder.deleteSync(recursive: true));
      final File prepared = File('${folder.path}/a.jpg')..writeAsBytesSync(plainJpeg());
      final File original = File('${folder.path}/o.jpg')..writeAsBytesSync(plainJpeg());
      await removePreparedFiles(_photo(path: prepared.path, original: original.path));
      expect(prepared.existsSync() || original.existsSync(), isFalse);
      await removePreparedFiles(_photo(path: prepared.path));
    });
  });
}
