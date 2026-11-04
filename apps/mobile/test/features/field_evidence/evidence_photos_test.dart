import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/features/field_evidence/evidence_photos.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/field_evidence/photo_checks.dart';
import 'package:machvon_mobile/features/field_evidence/photo_pipeline.dart' show EvidenceLimits;
import 'package:machvon_mobile/features/field_evidence/png_metadata.dart';

import '../../core/offline/attachment_uploader_test.dart' show UploaderRig;
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

  group('AC-ST-MOB-021-1 BR-MOB-06 an upload that is finished stands for a photograph only while it says no more than the photograph may', () {
    test('a photograph that went up with its place and time, whose local copy the uploader deleted when the server found it clean, is handed over again from the stripped file once the consent is taken back', () async {
      final UploaderRig rig = await UploaderRig.create();
      final File prepared = File('${rig.folder.path}/a.jpg')..writeAsBytesSync(geotaggedJpeg());
      final AttachmentUpload up = await rig.uploader.add(file: prepared, ownerKind: 'report');
      await rig.uploader.run(up.id);
      final AttachmentUpload done = rig.uploader.upload(up.id)!;
      expect(done.state, UploadState.clean);
      expect(File(done.sourcePath).existsSync(), isFalse, reason: 'the uploader keeps no copy of a photograph that is up');
      expect(readJpegMetadata(rig.server.storedBytes(done.serverId!)!).hasGps, isTrue, reason: 'the attachment on the server says where');

      final EvidencePhoto taken = _photo(gps: true, time: true, path: prepared.path).copyWith(uploadId: up.id);
      expect(await reuseUpload(rig.uploader, up.id, currentPath: prepared.path, keepsPlaceOrTime: true), isTrue, reason: 'with the consent it stands');
      final EvidencePhoto stripped = (await enforcePhotoConsent(<EvidencePhoto>[taken], consent: false)).single;

      expect(await reuseUpload(rig.uploader, up.id, currentPath: stripped.path, keepsPlaceOrTime: stripped.keepsPlaceOrTime), isFalse, reason: 'it must not stand for the stripped file');
    });

    test('a finished upload of a photograph that says nothing, and has not changed, stands for it though its local copy is gone', () async {
      final UploaderRig rig = await UploaderRig.create();
      final File prepared = File('${rig.folder.path}/a.jpg')..writeAsBytesSync(plainJpeg());
      final AttachmentUpload up = await rig.uploader.add(file: prepared, ownerKind: 'report');
      await rig.uploader.run(up.id);
      expect(rig.uploader.upload(up.id)!.state, UploadState.clean);

      expect(await reuseUpload(rig.uploader, up.id, currentPath: prepared.path, keepsPlaceOrTime: false), isTrue);
      expect(await reuseUpload(rig.uploader, up.id, currentPath: '${rig.folder.path}/gone.jpg', keepsPlaceOrTime: false), isFalse, reason: 'a file that cannot be compared is not trusted');
    });
  });

  group('AC-ST-MOB-021-1 BR-MOB-06 a photograph whose place or time is only in its XMP or IPTC block is judged the same way when it is prepared and when it is handed over', () {
    Uint8List xmpOnly() => withBlocks(plainJpeg(), <Uint8List>[
          segment(0xE1, 'http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta><exif:GPSLatitude>10,48N</exif:GPSLatitude></x:xmpmeta>'.codeUnits),
          segment(0xED, 'Photoshop 3.0\u0000IPTC city Ho Chi Minh'.codeUnits),
        ]);

    test('prepared with the consent it is reported as keeping what it says, and the unchanged upload stands at every handover', () async {
      final UploaderRig rig = await UploaderRig.create();
      final File source = File('${rig.folder.path}/source.jpg')..writeAsBytesSync(xmpOnly());
      int next = 0;
      final EvidencePhoto photo = await prepareEvidence(source, directory: Directory('${rig.folder.path}/out'), keepPlaceAndTime: true, newId: () => 'e${next++}');
      expect(File(photo.path).readAsBytesSync(), xmpOnly(), reason: 'with the consent the file goes as it was taken');
      expect(photo.sourceHadPlaceOrTime, isTrue);
      expect(photo.keepsPlaceOrTime, isTrue, reason: 'XMP and IPTC say where and when as well as Exif');

      final List<EvidencePhoto> first = await handOverPhotos(rig.uploader, <EvidencePhoto>[photo], ownerKind: 'report', ownerRef: 'r-1');
      final List<EvidencePhoto> second = await handOverPhotos(rig.uploader, first, ownerKind: 'report', ownerRef: 'r-1');
      expect(second.single.uploadId, first.single.uploadId);
      expect(rig.uploader.uploads(), hasLength(1), reason: 'a send made again hands nothing over twice');
      expect(rig.uploader.uploads().single.state, isNot(UploadState.cancelled));
    });

    test('prepared without the consent it is stripped and reported as having lost what it said', () async {
      final UploaderRig rig = await UploaderRig.create();
      final File source = File('${rig.folder.path}/source.jpg')..writeAsBytesSync(xmpOnly());
      int next = 0;
      final EvidencePhoto photo = await prepareEvidence(source, directory: Directory('${rig.folder.path}/out'), keepPlaceAndTime: false, newId: () => 'e${next++}');
      expect(photo.sourceHadPlaceOrTime, isTrue, reason: 'the screen tells the person that something was removed');
      expect(photo.keepsPlaceOrTime, isFalse);
      final Uint8List sent = File(photo.path).readAsBytesSync();
      expect(sent, stripJpegMetadata(sent), reason: 'nothing in the file is left to strip');
      expect(sent.length, lessThan(xmpOnly().length));
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

    test('lose a place or time that only the XMP or IPTC blocks say, and a PNG original kept beside a JPEG that was made from it', () async {
      final Directory folder = Directory.systemTemp.createTempSync('machvon-evidence-');
      addTearDown(() => folder.deleteSync(recursive: true));
      final Uint8List xmp = withBlocks(plainJpeg(), <Uint8List>[
        segment(0xE1, 'http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta><exif:GPSLatitude>10,48N</exif:GPSLatitude></x:xmpmeta>'.codeUnits),
        segment(0xED, 'Photoshop 3.0\u0000IPTC city Ho Chi Minh'.codeUnits),
      ]);
      expect(readJpegMetadata(xmp).carriesPlaceOrTime, isFalse, reason: 'the Exif reader does not see them: that is the point');
      final File flagged = File('${folder.path}/x.jpg')..writeAsBytesSync(xmp);
      final File unflagged = File('${folder.path}/y.jpg')..writeAsBytesSync(xmp);
      final File pngOriginal = File('${folder.path}/o.png')..writeAsBytesSync(pngWithText());
      final File jpegPrepared = File('${folder.path}/p.jpg')..writeAsBytesSync(plainJpeg());

      final List<EvidencePhoto> out = await enforcePhotoConsent(<EvidencePhoto>[
        _photo(gps: true, path: flagged.path),
        _photo(path: unflagged.path),
        _photo(path: jpegPrepared.path, original: pngOriginal.path),
      ], consent: false);

      for (final File file in <File>[flagged, unflagged]) {
        final String text = String.fromCharCodes(file.readAsBytesSync());
        expect(text.contains('xmpmeta') || text.contains('Photoshop') || text.contains('GPSLatitude'), isFalse, reason: file.path);
      }
      expect(pngCarriesMetadata(pngOriginal.readAsBytesSync()), isFalse, reason: 'the original is a PNG whatever the prepared file is');
      expect(out[0].bytes, flagged.lengthSync());
    });

    test('a PNG over the policy size is uploaded as a JPEG, and its original, kept as the PNG it is, loses its text when the consent goes', () async {
      final Directory folder = Directory.systemTemp.createTempSync('machvon-evidence-');
      addTearDown(() => folder.deleteSync(recursive: true));
      final File source = File('${folder.path}/s.png')..writeAsBytesSync(pngWithText(width: 400, height: 300));
      int n = 0;
      final EvidencePhoto photo = await prepareEvidence(
        source,
        directory: Directory('${folder.path}/kept'),
        keepPlaceAndTime: true,
        newId: () => 'id-${n++}',
        limits: const EvidenceLimits(maxUploadBytes: 100),
      );
      expect(photo.mime, 'image/jpeg');
      expect(photo.originalPath, endsWith('.png'));
      expect(pngCarriesMetadata(File(photo.originalPath!).readAsBytesSync()), isTrue);

      await enforcePhotoConsent(<EvidencePhoto>[photo], consent: false);
      expect(pngCarriesMetadata(File(photo.originalPath!).readAsBytesSync()), isFalse);
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
