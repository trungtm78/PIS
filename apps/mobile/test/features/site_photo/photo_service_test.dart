import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/app/app_config.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_policy.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_uploader.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_evidence/evidence_photos.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/field_evidence/png_metadata.dart';
import 'package:machvon_mobile/features/site_photo/photo_models.dart';
import 'package:machvon_mobile/features/site_photo/photo_service.dart';

import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../field_evidence/exif_fixtures.dart';
import '../field_issues/field_world.dart';

class _Phone {
  _Phone(this.container, this.folder);

  final ProviderContainer container;
  final Directory folder;

  SitePhotoService get service => container.read(sitePhotoServiceProvider);

  Future<void> quiesce() async {
    (await container.read(uploadRunnerProvider.future)).dispose();
    await pumpEventQueue(times: 50);
  }
}

Future<_Phone> _phone() async {
  final Directory folder = Directory.systemTemp.createTempSync('machvon-photo-service-');
  addTearDown(() {
    if (folder.existsSync()) folder.deleteSync(recursive: true);
  });
  final TestStorage storage = TestStorage.create();
  final FieldServer server = FieldServer()..offline = true;
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appConfigProvider.overrideWithValue(AppConfig.parse('https://api.test/v1', allowInsecureLoopback: false)),
      sessionProvider.overrideWith(() => FakeSession()),
      httpTransportProvider.overrideWithValue(server),
      offlineStorageProvider.overrideWithValue(storage.storage),
      chunkTransportProvider.overrideWithValue(server.attachments),
    ],
  );
  addTearDown(container.dispose);
  (await container.read(localStoreProvider.future)).deviceId = kDeviceId;
  return _Phone(container, folder);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('UI-QMS-10 FR-QMS-10 the capture kept on the phone is resumed, never repeated', () {
    test('a hand-over cut between two photographs is resumed by the retry of the screen, which still holds the photographs without their upload ids: the one that is up is not added again', () async {
      final _Phone phone = await _phone();
      final EvidencePhoto first = EvidencePhoto(id: 'a', path: (File('${phone.folder.path}/a.jpg')..writeAsBytesSync(plainJpeg())).path, mime: 'image/jpeg', bytes: 3);
      final EvidencePhoto second = EvidencePhoto(id: 'b', path: '${phone.folder.path}/b.jpg', mime: 'image/jpeg', bytes: 3);
      // What the screen holds and sends again: the photographs as they were taken, never the ids the service gave them.
      PhotoRecord capture() => PhotoRecord(operationId: 'op-1', contractId: 'c-1', contractCode: 'HD-A-001', caption: '', place: FieldPlace.none, photos: <EvidencePhoto>[first, second]);

      await expectLater(phone.service.keep(capture()), throwsA(isA<AttachmentRefused>().having((AttachmentRefused e) => e.code, 'code', 'FILE_NOT_FOUND')));
      final AttachmentUploader uploader = await phone.container.read(attachmentUploaderProvider.future);
      expect(uploader.uploads(), hasLength(1));
      final String firstUpload = uploader.uploads().single.id;

      File('${phone.folder.path}/b.jpg').writeAsBytesSync(plainJpeg(width: 20));
      final PhotoRecord kept = await phone.service.keep(capture());

      expect(uploader.uploads(), hasLength(2), reason: 'only the missing photograph was added the second time');
      expect(kept.photos.first.uploadId, firstUpload, reason: 'the photograph that was up keeps its upload');
      expect(kept.photos.last.uploadId, isNotNull);
      final StoredCapture stored = (await phone.service.captures()).single;
      expect(stored.record.photos.map((EvidencePhoto photo) => photo.uploadId), <String?>[firstUpload, kept.photos.last.uploadId]);
      await phone.quiesce();
    });

    for (final (String, String, List<int> Function(), bool Function(List<int>)) kind in <(String, String, List<int> Function(), bool Function(List<int>))>[
      ('jpeg', 'image/jpeg', geotaggedJpeg, (List<int> bytes) => readJpegMetadata(Uint8List.fromList(bytes)).carriesPlaceOrTime),
      ('png', 'image/png', pngWithText, (List<int> bytes) => pngCarriesMetadata(Uint8List.fromList(bytes))),
    ]) {
      test('a photograph handed over while the consent held, then retried after the consent was taken back, is handed over again from the stripped file: no upload that still says where or when stays in the uploader (${kind.$1})', () async {
        final _Phone phone = await _phone();
        final EvidencePhoto first = EvidencePhoto(id: 'a', path: (File('${phone.folder.path}/a.${kind.$1}')..writeAsBytesSync(kind.$3())).path, mime: kind.$2, bytes: 3, keepsPlaceOrTime: true, sourceHadPlaceOrTime: true);
        final EvidencePhoto second = EvidencePhoto(id: 'b', path: '${phone.folder.path}/b.jpg', mime: 'image/jpeg', bytes: 3);
        PhotoRecord capture(FieldPlace place) => PhotoRecord(operationId: 'op-1', contractId: 'c-1', contractCode: 'HD-A-001', caption: '', place: place, photos: <EvidencePhoto>[first, second]);

        await expectLater(phone.service.keep(capture(FieldPlace.none.withConsent(true))), throwsA(isA<AttachmentRefused>()));
        final AttachmentUploader uploader = await phone.container.read(attachmentUploaderProvider.future);
        final AttachmentUpload stale = uploader.uploads().single;
        expect(kind.$4(File(stale.sourcePath).readAsBytesSync()), isTrue, reason: 'it went up with the consent: it says where');

        File('${phone.folder.path}/b.jpg').writeAsBytesSync(plainJpeg(width: 20));
        final PhotoRecord kept = await phone.service.keep(capture(FieldPlace.none));

        expect(uploader.upload(stale.id)!.state, UploadState.cancelled, reason: 'the stale copy does not go up');
        final AttachmentUpload fresh = uploader.upload(kept.photos.first.uploadId!)!;
        expect(kind.$4(File(fresh.sourcePath).readAsBytesSync()), isFalse, reason: 'the copy that stands for the photograph says neither where nor when');
        expect(uploader.uploads().where((AttachmentUpload upload) => upload.state != UploadState.cancelled), hasLength(2), reason: 'the photograph and the second one, each once');
        expect(kept.photos.first.uploadId, isNot(stale.id));
        expect(kept.photos.map((EvidencePhoto photo) => photo.uploadId), everyElement(isNotNull));
        await phone.quiesce();
      });
    }

    test('an upload that is no longer in the uploader is handed over again, not trusted', () async {
      final _Phone phone = await _phone();
      final File file = File('${phone.folder.path}/a.jpg')..writeAsBytesSync(plainJpeg());
      final EvidencePhoto photo = EvidencePhoto(id: 'a', path: file.path, mime: 'image/jpeg', bytes: 3);
      final PhotoRecord capture = PhotoRecord(operationId: 'op-2', contractId: 'c-1', contractCode: 'HD-A-001', caption: '', place: FieldPlace.none, photos: <EvidencePhoto>[photo]);
      // A record kept by an earlier run whose upload is not known to the uploader.
      (await phone.container.read(draftStoreProvider.future)).save(
        kind: kSitePhotoKind,
        fields: PhotoRecord(operationId: 'op-2', contractId: 'c-1', contractCode: 'HD-A-001', caption: '', place: FieldPlace.none, photos: <EvidencePhoto>[photo.copyWith(uploadId: 'gone')]).toJson(),
        recordId: 'c-1',
      );

      final PhotoRecord kept = await phone.service.keep(capture);

      final AttachmentUploader uploader = await phone.container.read(attachmentUploaderProvider.future);
      expect(uploader.uploads(), hasLength(1));
      expect(kept.photos.single.uploadId, uploader.uploads().single.id);
      await phone.quiesce();
    });
  });
}
