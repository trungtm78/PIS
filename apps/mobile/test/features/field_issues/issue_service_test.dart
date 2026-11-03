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
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/field_evidence/png_metadata.dart';
import 'package:machvon_mobile/features/field_issues/issue_draft.dart';
import 'package:machvon_mobile/features/field_issues/issue_service.dart';
import 'package:machvon_mobile/features/permissions/permission_service.dart';

import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../field_evidence/exif_fixtures.dart';
import 'field_world.dart';

const String _label = 'Vị trí nhập tay';

class _Phone {
  _Phone(this.container, this.server, this.folder);

  final ProviderContainer container;
  final FieldServer server;
  final Directory folder;

  IssueService get service => container.read(issueServiceProvider);

  /// Stops the runners a send started, so nothing is still talking to the server when the test ends.
  Future<void> quiesce() async {
    (await container.read(queueRunnerProvider.future)).dispose();
    (await container.read(uploadRunnerProvider.future)).dispose();
    await pumpEventQueue(times: 50);
  }

  File file(String name, List<int> bytes) => File('${folder.path}/$name')..writeAsBytesSync(bytes);

  IssuePhoto photo(String name, Uint8List bytes, {bool keeps = false}) =>
      IssuePhoto(id: name, path: file('$name.jpg', bytes).path, mime: 'image/jpeg', bytes: bytes.length, keepsPlaceOrTime: keeps);

  Future<String> save(IssueDraft draft) => service.save(draft);

  IssueDraft draft({List<IssuePhoto> photos = const <IssuePhoto>[], FieldPlace place = FieldPlace.none, String title = 'Sạt lở taluy km3'}) => service.blank().copyWith(
        projectId: 'p-1',
        ownerUnitId: 'u-1',
        categoryVersionId: 'c-1',
        title: title,
        description: 'Đất đá đổ ra mặt đường.',
        photos: photos,
        place: place,
      );
}

Future<_Phone> _phone() async {
  final Directory folder = Directory.systemTemp.createTempSync('machvon-service-');
  addTearDown(() {
    if (folder.existsSync()) folder.deleteSync(recursive: true);
  });
  final TestStorage storage = TestStorage.create();
  final FieldServer server = FieldServer();
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
  server.offline = true;
  return _Phone(container, server, folder);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AC-ST-MOB-014-3 UAT-PLAN-37 sending a report queues one command however often it is tapped', () {
    test('a second tap, and a send after a restart, give the same command and the same uploads', () async {
      final _Phone phone = await _phone();
      final String id = await phone.save(phone.draft(photos: <IssuePhoto>[phone.photo('a', plainJpeg()), phone.photo('b', plainJpeg(width: 20))]));

      final QueuedCommand first = await phone.service.send(id, manualPlaceLabel: _label);
      final QueuedCommand second = await phone.service.send(id, manualPlaceLabel: _label);

      expect(second.id, first.id);
      expect(second.idempotencyKey, first.idempotencyKey);
      final CommandQueue queue = await phone.container.read(commandQueueProvider.future);
      expect(queue.unsentCount, 1);
      final AttachmentUploader uploader = await phone.container.read(attachmentUploaderProvider.future);
      final List<AttachmentUpload> uploads = uploader.uploads();
      expect(uploads, hasLength(2), reason: 'each photograph is handed to the uploader once');
      expect(uploads.every((AttachmentUpload upload) => upload.ownerKind == 'issue' && upload.ownerRef == first.payload!['client_operation_id']), isTrue);
      final LocalDraft stored = (await phone.container.read(draftStoreProvider.future)).byId(id)!;
      expect(stored.status, DraftStatus.queued);
      expect(IssueDraft.fromJson(stored.fields)!.photos.map((IssuePhoto photo) => photo.uploadId), everyElement(isNotNull));
      await phone.quiesce();
    });

    test('a send interrupted between two photographs is resumed: the one that is up is not added again', () async {
      final _Phone phone = await _phone();
      final IssuePhoto good = phone.photo('a', plainJpeg());
      final IssuePhoto vanishing = phone.photo('b', plainJpeg(width: 20));
      final String id = await phone.save(phone.draft(photos: <IssuePhoto>[good, vanishing]));
      File(vanishing.path).deleteSync();

      await expectLater(phone.service.send(id, manualPlaceLabel: _label), throwsA(isA<AttachmentRefused>().having((AttachmentRefused e) => e.code, 'code', 'FILE_NOT_FOUND')));
      final AttachmentUploader uploader = await phone.container.read(attachmentUploaderProvider.future);
      expect(uploader.uploads(), hasLength(1));
      expect((await phone.service.load(id))!.draft.photos.first.uploadId, isNotNull, reason: 'the draft remembers the upload at once');
      final CommandQueue queue = await phone.container.read(commandQueueProvider.future);
      expect(queue.unsentCount, 0, reason: 'no report is queued before all its photographs are in hand');

      phone.file('b.jpg', plainJpeg(width: 20));
      await phone.service.send(id, manualPlaceLabel: _label);
      expect(uploader.uploads(), hasLength(2), reason: 'only the missing photograph was added');
      expect(queue.unsentCount, 1);
      await phone.quiesce();
    });

    test('a send cut after a photograph went up with the consent, then retried after the consent was taken back, hands that photograph over again from the stripped file', () async {
      final _Phone phone = await _phone();
      final IssuePhoto tagged = phone.photo('a', geotaggedJpeg(), keeps: true);
      final IssuePhoto vanishing = phone.photo('b', plainJpeg(width: 20));
      File(vanishing.path).deleteSync();
      final String id = await phone.save(phone.draft(photos: <IssuePhoto>[tagged, vanishing], place: FieldPlace.none.withConsent(true)));
      await expectLater(phone.service.send(id, manualPlaceLabel: _label), throwsA(isA<AttachmentRefused>()));
      final AttachmentUploader uploader = await phone.container.read(attachmentUploaderProvider.future);
      final AttachmentUpload stale = uploader.uploads().single;
      expect(readJpegMetadata(File(stale.sourcePath).readAsBytesSync()).carriesPlaceOrTime, isTrue, reason: 'it went up with the consent');

      // The consent is taken back before the retry.
      phone.file('b.jpg', plainJpeg(width: 20));
      final IssueDraft stored = (await phone.service.load(id))!.draft;
      await phone.service.save(stored.copyWith(place: FieldPlace.none), draftId: id);
      await phone.service.send(id, manualPlaceLabel: _label);

      expect(uploader.upload(stale.id)!.state, UploadState.cancelled);
      final List<AttachmentUpload> live = uploader.uploads().where((AttachmentUpload upload) => upload.state != UploadState.cancelled).toList();
      expect(live, hasLength(2));
      for (final AttachmentUpload upload in live) {
        expect(readJpegMetadata(File(upload.sourcePath).readAsBytesSync()).carriesPlaceOrTime, isFalse, reason: 'nothing that is live says where or when');
      }
      await phone.quiesce();
    });

    test('a report that is not ready is refused with the fields named, and nothing is queued or uploaded', () async {
      final _Phone phone = await _phone();
      final String id = await phone.save(phone.draft(title: '', photos: <IssuePhoto>[phone.photo('a', plainJpeg())]));
      await expectLater(
        phone.service.send(id, manualPlaceLabel: _label),
        throwsA(isA<IssueNotReady>().having((IssueNotReady e) => e.problems.keys, 'fields', contains('title'))),
      );
      final CommandQueue queue = await phone.container.read(commandQueueProvider.future);
      expect(queue.unsentCount, 0);
      expect((await phone.container.read(attachmentUploaderProvider.future)).uploads(), isEmpty);
      await expectLater(phone.service.send('no-such-draft', manualPlaceLabel: _label), throwsStateError);
    });

    test('the command holds the body of the draft, takes the draft as its source and keeps the identity of the report as its key', () async {
      final _Phone phone = await _phone();
      final String id = await phone.save(phone.draft(place: FieldPlace.none.withManual(ManualLocation.tryParse('Cổng phía nam')!)));
      final QueuedCommand command = await phone.service.send(id, manualPlaceLabel: _label);
      final Map<String, Object?> payload = command.payload!;
      expect(payload['description'], 'Đất đá đổ ra mặt đường.\n\nVị trí nhập tay: Cổng phía nam');
      expect(payload['geo_consent'], isFalse);
      expect(command.idempotencyKey, payload['client_operation_id']);
      expect(command.draftId, id);
      expect(command.releaseDraft, isTrue);
      await phone.quiesce();
    });
  });

  group('AC-ST-MOB-014-2 UAT-AC367 BR-MOB-06 the service takes the place and the time out of what the person did not agree to keep', () {
    test('a prepared photograph and the original kept beside it are rewritten without them, a PNG too', () async {
      final _Phone phone = await _phone();
      final Uint8List tagged = geotaggedJpeg();
      final IssuePhoto jpeg = IssuePhoto(
        id: 'a',
        path: phone.file('a.jpg', tagged).path,
        originalPath: phone.file('a-original.jpg', tagged).path,
        mime: 'image/jpeg',
        bytes: tagged.length,
        keepsPlaceOrTime: true,
        sourceHadPlaceOrTime: true,
      );
      final Uint8List png = pngWithText();
      final IssuePhoto still = IssuePhoto(id: 'b', path: phone.file('b.png', png).path, mime: 'image/png', bytes: png.length, keepsPlaceOrTime: true, sourceHadPlaceOrTime: true);
      final IssueDraft draft = phone.draft(photos: <IssuePhoto>[jpeg, still]);

      final IssueDraft stripped = await phone.service.enforceConsent(draft);

      expect(readJpegMetadata(File(jpeg.path).readAsBytesSync()).carriesPlaceOrTime, isFalse);
      expect(readJpegMetadata(File(jpeg.originalPath!).readAsBytesSync()).carriesPlaceOrTime, isFalse);
      expect(pngCarriesMetadata(File(still.path).readAsBytesSync()), isFalse);
      expect(stripped.photos.every((IssuePhoto photo) => !photo.keepsPlaceOrTime), isTrue);
      expect(stripped.photos.first.bytes, File(jpeg.path).lengthSync());
    });

    test('a photograph not flagged as carrying place or time still loses what only its XMP or IPTC blocks say, and so does a PNG original, when there is no consent', () async {
      final _Phone phone = await _phone();
      final Uint8List xmp = withBlocks(plainJpeg(), <Uint8List>[
        segment(0xE1, 'http://ns.adobe.com/xap/1.0/ <x:xmpmeta><exif:GPSLatitude>10,48N</exif:GPSLatitude></x:xmpmeta>'.codeUnits),
        segment(0xED, 'Photoshop 3.0 IPTC city Ho Chi Minh'.codeUnits),
      ]);
      final IssuePhoto unflagged = phone.photo('a', xmp);
      final Uint8List png = pngWithText();
      final IssuePhoto withPngOriginal = IssuePhoto(
        id: 'b',
        path: phone.file('b.jpg', plainJpeg(width: 20)).path,
        originalPath: phone.file('b-original.png', png).path,
        mime: 'image/jpeg',
        bytes: 3,
      );

      await phone.service.enforceConsent(phone.draft(photos: <IssuePhoto>[unflagged, withPngOriginal]));

      final String text = String.fromCharCodes(File(unflagged.path).readAsBytesSync());
      expect(text.contains('xmpmeta') || text.contains('Photoshop') || text.contains('GPSLatitude'), isFalse, reason: 'no photograph is skipped because of what the draft says about it');
      expect(pngCarriesMetadata(File(withPngOriginal.originalPath!).readAsBytesSync()), isFalse);
    });

    test('a send strips what a draft still carries without the consent before the photograph is handed to the uploader', () async {
      final _Phone phone = await _phone();
      final String id = await phone.save(phone.draft(photos: <IssuePhoto>[phone.photo('a', geotaggedJpeg(), keeps: true)]));

      await phone.service.send(id, manualPlaceLabel: _label);

      final AttachmentUploader uploader = await phone.container.read(attachmentUploaderProvider.future);
      final AttachmentUpload upload = uploader.uploads().single;
      expect(readJpegMetadata(File(upload.sourcePath).readAsBytesSync()).carriesPlaceOrTime, isFalse, reason: 'the file that goes up');
      expect((await phone.service.load(id))!.draft.photos.single.keepsPlaceOrTime, isFalse);
      await phone.quiesce();
    });

    test('with the consent nothing is touched; a file that is gone or clean is left alone', () async {
      final _Phone phone = await _phone();
      final Uint8List tagged = geotaggedJpeg();
      final IssuePhoto kept = phone.photo('a', tagged, keeps: true);
      final IssueDraft consenting = phone.draft(photos: <IssuePhoto>[kept], place: FieldPlace.none.withConsent(true));
      expect(identical(await phone.service.enforceConsent(consenting), consenting), isTrue);
      expect(File(kept.path).readAsBytesSync(), tagged);

      final IssuePhoto gone = phone.photo('b', tagged, keeps: true);
      File(gone.path).deleteSync();
      final IssuePhoto clean = phone.photo('c', plainJpeg(), keeps: true);
      final IssueDraft draft = phone.draft(photos: <IssuePhoto>[gone, clean]);
      await phone.service.enforceConsent(draft);
      expect(File(clean.path).readAsBytesSync(), plainJpeg());
    });

    test('a photograph prepared by the service lands in the private folder of the person and respects the consent', () async {
      final _Phone phone = await _phone();
      final IssuePhoto without = await phone.service.prepare(phone.file('g.jpg', geotaggedJpeg()), keepPlaceAndTime: false);
      expect(readJpegMetadata(File(without.path).readAsBytesSync()).carriesPlaceOrTime, isFalse);
      expect(without.sourceHadPlaceOrTime, isTrue);
      expect(without.path, contains('evidence'));
      final IssuePhoto with_ = await phone.service.prepare(phone.file('h.jpg', geotaggedJpeg()), keepPlaceAndTime: true);
      expect(readJpegMetadata(File(with_.path).readAsBytesSync()).carriesPlaceOrTime, isTrue);
      expect(with_.keepsPlaceOrTime, isTrue);
    });
  });

  group('UI-MOB-28 the drafts of the person', () {
    test('open drafts are listed newest first without the ones already queued, and a discarded draft takes its photographs with it', () async {
      final _Phone phone = await _phone();
      final IssuePhoto photo = phone.photo('a', plainJpeg());
      final IssuePhoto original = phone.photo('o', plainJpeg());
      final String first = await phone.save(phone.draft(title: 'Một'));
      final String second = await phone.save(phone.draft(title: 'Hai', photos: <IssuePhoto>[IssuePhoto(id: 'a', path: photo.path, mime: 'image/jpeg', bytes: 10, originalPath: original.path)]));
      final String sent = await phone.save(phone.draft(title: 'Ba'));
      await phone.service.send(sent, manualPlaceLabel: _label);

      final List<StoredIssueDraft> open = await phone.service.open();
      expect(open.map((StoredIssueDraft stored) => stored.draft.title).toSet(), <String>{'Một', 'Hai'});
      expect(open.map((StoredIssueDraft stored) => stored.id), containsAll(<String>[first, second]));
      await phone.quiesce();

      await phone.service.discard(second);
      expect(await phone.service.load(second), isNull);
      expect(File(photo.path).existsSync(), isFalse);
      expect(File(original.path).existsSync(), isFalse);
      await phone.service.discard('no-such-draft');
    });

    test('a draft of another kind is not an issue draft', () async {
      final _Phone phone = await _phone();
      final LocalDraft other = (await phone.container.read(draftStoreProvider.future)).save(kind: 'report', fields: <String, Object?>{'a': 1});
      expect(await phone.service.load(other.id), isNull);
    });
  });
}
