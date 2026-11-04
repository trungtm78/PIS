import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_uploader.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/attachments/attachments_feature.dart' as attachments;
import 'package:machvon_mobile/features/field_evidence/evidence_photos.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/site_photo/photo_models.dart';
import 'package:machvon_mobile/features/site_photo/photo_service.dart';
import 'package:machvon_mobile/features/site_photo/screens/photo_screen.dart';
import 'package:machvon_mobile/features/site_photo/site_photo_feature.dart' as photo;

import '../../support/harness.dart';
import '../field_evidence/exif_fixtures.dart';
import '../field_issues/field_world.dart';
import '../site_diary/diary_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';

const String _screen = '/projects/qms-10';

FakeSession _contractor({SessionMode mode = SessionMode.full}) =>
    FakeSession(SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1', mode: mode));

void _answer(ScriptedServer api, {List<Object?> registered = const <Object?>[], bool refuseRegister = false}) {
  api
    ..on('GET', '/resources/contract', (_) => page(<Object?>[contractRow('c-1', 'HD-A-001'), contractRow('c-2', 'HD-A-002', title: 'Cầu vượt km5')]))
    ..on('GET', '/resources/site_diary', (_) => page(<Object?>[diaryRow('d-1'), diaryRow('d-0', date: '2026-11-02', status: 'LOCKED')]));
  if (refuseRegister) {
    api.refuse('GET', '/resources/site_photo', 403, 'PERMISSION_DENIED');
  } else {
    api.on('GET', '/resources/site_photo', (_) => page(registered));
  }
}

Future<FieldWorld> _open(WidgetTester tester, {String location = _screen, FakeSession? session, FieldServer? server, List<Object?> registered = const <Object?>[], bool refuseRegister = false}) async {
  final FieldServer field = server ?? FieldServer();
  _answer(field.api, registered: registered, refuseRegister: refuseRegister);
  final FieldWorld world = FieldWorld.create(server: field);
  await world.open(tester, location, extra: <MobileFeature>[photo.feature, attachments.feature], session: session ?? _contractor());
  await settleReal(tester, rounds: 8);
  return world;
}

Future<void> _chooseContract(WidgetTester tester, {String label = 'HD-A-001 · Đường tỉnh ĐT.A1 km0-km12'}) async {
  await tester.ensureVisible(find.byType(DropdownButtonFormField<String>).first);
  await tester.tap(find.byType(DropdownButtonFormField<String>).first);
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await settleReal(tester, rounds: 8);
}

Future<void> _takeFromGallery(WidgetTester tester, FieldWorld world, List<int> bytes, {String name = 'g.jpg'}) async {
  world.photos.gallery = world.file(name, bytes);
  await tapText(tester, 'Chọn từ thư viện');
  await waitUntil(tester, () async => find.textContaining('Dung lượng').evaluate().isNotEmpty);
  // The fingerprint of the file is being made: let it end before the test does (it holds the file open).
  await settleReal(tester, rounds: 6);
}

/// The captures on the phone, read inside a wait of real time (which is already outside the fake clock).
Future<List<StoredCapture>> _storedCaptures(FieldWorld world) => world.container.read(sitePhotoServiceProvider).captures();

Future<List<StoredCapture>> _captures(WidgetTester tester, FieldWorld world) async => (await tester.runAsync(() => world.container.read(sitePhotoServiceProvider).captures()))!;

/// The capture is kept and its photographs are handed to the uploader: the screen says so.
Future<void> _untilSaved(WidgetTester tester) async {
  await waitUntil(tester, () async => find.textContaining('Đã lưu').evaluate().isNotEmpty);
  await settleReal(tester, rounds: 4);
}

Future<void> _consent(WidgetTester tester) async {
  await tester.ensureVisible(find.byType(SwitchListTile));
  await tester.tap(find.byType(SwitchListTile));
  await settleReal(tester, rounds: 8);
}

Finder _save() => find.widgetWithText(FilledButton, 'Lưu và tải ảnh lên');

void main() {
  group('UI-QMS-10 FR-QMS-10 the site photograph: the contract, the diary, the caption, the place and the flags before it is kept', () {
    testWidgets('shows the fields of the screen and the contracts of the person; a diary of the contract can be linked', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);

      expect(find.text('Chụp ảnh hiện trường'), findsOneWidget);
      expect(find.text('Hợp đồng'), findsWidgets);
      expect(find.text('Chú thích'), findsOneWidget);
      expect(find.text('Ảnh'), findsOneWidget);
      expect(find.text('Vị trí (khi đồng ý)'), findsOneWidget);
      expect(find.text('Cờ kiểm tra trước khi lưu'), findsOneWidget);
      expect(find.text('Chưa có ảnh để kiểm tra.'), findsOneWidget);
      expect(find.text('Nhật ký (không bắt buộc)'), findsNothing, reason: 'a diary is chosen after the contract');
      expect(world.server.api.calls.where((HttpCall call) => call.method != 'GET'), isEmpty);

      await _chooseContract(tester);
      expect(find.text('Nhật ký (không bắt buộc)'), findsOneWidget);
      await tester.tap(find.byType(DropdownButtonFormField<String?>));
      await tester.pumpAndSettle();
      expect(find.text('Ngày 03/11/2026 · D-A-0003'), findsOneWidget);
      expect(find.text('Không gắn nhật ký'), findsWidgets);
    });

    testWidgets('opened with a contract and a diary (from the diary), they are chosen', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, location: '$_screen?contract=c-1&diary=d-1');
      expect(find.text('HD-A-001 · Đường tỉnh ĐT.A1 km0-km12'), findsWidgets);
      expect(find.text('Ngày 03/11/2026 · D-A-0003'), findsWidgets);
    });

    testWidgets('speaks English', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      _answer(server.api);
      final FieldWorld world = FieldWorld.create(server: server);
      await world.open(tester, _screen, extra: <MobileFeature>[photo.feature], session: _contractor(), locale: const Locale('en'));
      await settleReal(tester, rounds: 8);
      expect(find.text('Site photograph'), findsOneWidget);
      expect(find.text('Checks before saving'), findsOneWidget);
    });

    testWidgets('every state of the screen is drawn and the screen keeps the contract at the three sizes and at 200 percent text', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) async {
        final FieldWorld world = FieldWorld.create(server: FieldServer(api: server));
        await world.open(tester, _screen, extra: <MobileFeature>[photo.feature, attachments.feature], session: _contractor());
        await settleReal(tester, rounds: 6);
      }

      void healthy(ScriptedServer server) => _answer(server);
      await expectEveryState(
        tester,
        open: open,
        script: StateScript(healthy: healthy, content: find.text('Chú thích'), empty: (ScriptedServer server) => server.on('GET', '/resources/contract', (_) => page(<Object?>[]))),
      );
      await expectScreenContract(tester, open: open, healthy: healthy);
    });
  });

  group('AC-ST-QMS-003-1 UAT-AC359 the flags are shown before the photograph is kept, as notes for review and never as a refusal', () {
    testWidgets('a photograph with no place and no time is flagged for both and is still kept', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _takeFromGallery(tester, world, plainJpeg());

      expect(find.text('1 ảnh chưa có vị trí.'), findsOneWidget);
      expect(find.text('1 ảnh không có thời gian chụp.'), findsOneWidget);
      expect(find.textContaining('Cờ chỉ để rà soát, không kết luận ảnh thật hay giả'), findsOneWidget);
      expect(_save(), findsOneWidget);
      expect(tester.widget<FilledButton>(_save()).onPressed, isNotNull, reason: 'a flag never stops a photograph');
    });

    testWidgets('with the consent and a place the flags of place and time are gone', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _consent(tester);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await _takeFromGallery(tester, world, geotaggedJpeg());

      expect(find.text('Chưa thấy cờ nào cần rà soát.'), findsOneWidget);
      expect(find.text('Giữ vị trí và thời điểm chụp (đã đồng ý)'), findsOneWidget);
    });

    testWidgets('the same file twice in one capture, or a file already registered for the contract, is flagged as a repeat', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _chooseContract(tester);
      await _takeFromGallery(tester, world, plainJpeg());
      expect(find.textContaining('trùng với ảnh đã đăng ký'), findsNothing);

      await _takeFromGallery(tester, world, plainJpeg(), name: 'again.jpg');
      await waitUntil(tester, () async => find.textContaining('trùng với ảnh đã đăng ký').evaluate().isNotEmpty);
      expect(find.text('1 ảnh trùng với ảnh đã đăng ký cho hợp đồng này.'), findsOneWidget, reason: 'the second of two identical files');

      // The first one is also registered: both are repeats.
      final Directory evidence = (await tester.runAsync(() => world.container.read(evidenceDirectoryProvider.future)))!;
      final String hash = (await tester.runAsync(() => fileSha256(evidence.listSync().whereType<File>().first.path)))!;
      world.server.api.on('GET', '/resources/site_photo', (_) => page(<Object?>[<String, Object?>{'file_sha256': hash.toUpperCase()}]));
      world.container.invalidate(registeredHashesProvider('c-1'));
      await settleReal(tester, rounds: 8);
      expect(find.text('2 ảnh trùng với ảnh đã đăng ký cho hợp đồng này.'), findsOneWidget);
    });

    testWidgets('when the registered photographs cannot be read the screen says that repeats were not checked, and goes on', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, refuseRegister: true);
      await _chooseContract(tester);
      await _takeFromGallery(tester, world, plainJpeg());
      expect(find.text('Chưa kiểm tra được ảnh trùng: cần có mạng và quyền xem ảnh hiện trường.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_save()).onPressed, isNotNull);
    });

    test('the flags count what the person is told, over all the photographs', () {
      const EvidencePhoto bare = EvidencePhoto(id: 'a', path: 'a.jpg', mime: 'image/jpeg', bytes: 1);
      const EvidencePhoto tagged = EvidencePhoto(id: 'b', path: 'b.jpg', mime: 'image/jpeg', bytes: 1, keepsPlaceOrTime: true, keptGps: true, keptTime: true);
      final FieldPlace place = FieldPlace.none.withConsent(true);
      final CaptureFlags flags = flagsOf(<EvidencePhoto>[bare, tagged], place, duplicateIds: <String>{'b'}, duplicatesChecked: true);
      expect(flags.photos, 2);
      expect(flags.placeMissing, 1);
      expect(flags.timeMissing, 1);
      expect(flags.duplicates, 1);
      expect(flags.hasAny, isTrue);
      expect(flagsOf(<EvidencePhoto>[tagged], place, duplicateIds: const <String>{}, duplicatesChecked: true).hasAny, isFalse);
      expect(flagsOf(<EvidencePhoto>[tagged], FieldPlace.none, duplicateIds: const <String>{}, duplicatesChecked: true).placeMissing, 1, reason: 'without the consent the place is not kept, whatever the file says');
    });

    test('the registered files and the diaries are read as the server gives them; what lacks an id is left out', () {
      expect(parseRegisteredHashes(<String, Object?>{'nothing': 1}), isNull);
      expect(parseRegisteredHashes(<String, Object?>{'items': <Object?>[<String, Object?>{'file_sha256': 'ABCD'}, <String, Object?>{'id': 'x'}, 'nothing']}), <String>{'abcd'});
      expect(parseDiaryOptions(<String, Object?>{'nothing': 1}), isNull);
      final List<DiaryOption> options = parseDiaryOptions(<String, Object?>{
        'items': <Object?>[diaryRow('d-1', date: '2026-11-01'), diaryRow('d-2', status: 'SUPERSEDED'), diaryRow('d-3', date: '2026-11-03'), <String, Object?>{'id': 'broken'}],
      })!;
      expect(options.map((DiaryOption option) => option.id), <String>['d-3', 'd-1'], reason: 'the newest first, a set-aside diary and a broken row left out');
    });
  });

  group('AC-ST-QMS-003-2 UAT-AC367 BR-QMS-06 the place is kept only with the consent: no coordinate reaches the phone\'s storage or an upload without it', () {
    testWidgets('without the consent the place and the time are removed from the photograph the moment it is prepared', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _takeFromGallery(tester, world, geotaggedJpeg());

      final Directory evidence = (await tester.runAsync(() => world.container.read(evidenceDirectoryProvider.future)))!;
      final JpegMetadata kept = readJpegMetadata(evidence.listSync().whereType<File>().single.readAsBytesSync());
      expect(kept.hasGps, isFalse);
      expect(kept.hasTime, isFalse);
      expect(find.text('Đã xóa vị trí và thời điểm chụp khỏi ảnh'), findsOneWidget);
    });

    testWidgets('taking the consent back takes the place and the time out of the photographs already prepared, at once', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _consent(tester);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await _takeFromGallery(tester, world, geotaggedJpeg());
      final Directory evidence = (await tester.runAsync(() => world.container.read(evidenceDirectoryProvider.future)))!;
      File prepared() => evidence.listSync().whereType<File>().firstWhere((File file) => !file.path.contains('original'));
      expect(readJpegMetadata(prepared().readAsBytesSync()).hasGps, isTrue, reason: 'kept while the consent holds');

      await _consent(tester);
      expect(readJpegMetadata(prepared().readAsBytesSync()).hasGps, isFalse);
      expect(readJpegMetadata(prepared().readAsBytesSync()).hasTime, isFalse);
      expect(find.text('Chưa có vị trí.'), findsOneWidget);
      expect(find.text('1 ảnh chưa có vị trí.'), findsOneWidget);
    });

    testWidgets('the consent is taken back at once and the capture cannot be kept until the photographs have lost their place and time', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _chooseContract(tester);
      await _consent(tester);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await _takeFromGallery(tester, world, geotaggedJpeg());
      expect(tester.widget<FilledButton>(_save()).onPressed, isNotNull);
      expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value, isTrue);

      await tester.ensureVisible(find.byType(SwitchListTile));
      await tester.tap(find.byType(SwitchListTile));
      await tester.pump();
      // The files are still being rewritten (real input and output has not run): the place already says no, and nothing can keep the capture with the old place.
      expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value, isFalse, reason: 'the withdrawal is applied before the files are rewritten');
      expect(tester.widget<FilledButton>(_save()).onPressed, isNull, reason: 'no save while the photographs still say where they were taken');

      await settleReal(tester, rounds: 8);
      expect(tester.widget<FilledButton>(_save()).onPressed, isNotNull, reason: 'the save is back once the photographs are clean');
      final Directory evidence = (await tester.runAsync(() => world.container.read(evidenceDirectoryProvider.future)))!;
      final File prepared = evidence.listSync().whereType<File>().firstWhere((File file) => !file.path.contains('original'));
      expect(readJpegMetadata(prepared.readAsBytesSync()).hasGps, isFalse);
    });

    testWidgets('a capture kept without the consent has no coordinate in the store and none in the file that goes up', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server);
      await _chooseContract(tester);
      await _takeFromGallery(tester, world, geotaggedJpeg());
      // With no connection the copy that goes up is still on the phone to be looked at (a clean upload deletes it).
      server.offline = true;
      await tester.ensureVisible(_save());
      await tapText(tester, 'Lưu và tải ảnh lên');
      await _untilSaved(tester);

      final StoredCapture capture = (await _captures(tester, world)).single;
      expect(capture.record.place.consent, isFalse);
      expect(capture.record.place.hasPlace, isFalse);
      final String stored = jsonEncode(capture.record.toJson());
      expect(stored, isNot(contains('latitude')));
      expect(stored, isNot(contains('longitude')));
      final AttachmentUploader uploader = (await tester.runAsync(() => world.container.read(attachmentUploaderProvider.future)))!;
      final AttachmentUpload upload = uploader.uploads().single;
      expect(readJpegMetadata(File(upload.sourcePath).readAsBytesSync()).hasGps, isFalse, reason: 'the file that goes up says nothing of where it was taken');
      expect(find.text('Không kèm vị trí'), findsOneWidget);
    });

    testWidgets('the service strips a photograph prepared under a consent that is gone before it keeps it, whatever the screen did', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server);
      server.offline = true;
      final Directory evidence = (await tester.runAsync(() => world.container.read(evidenceDirectoryProvider.future)))!;
      // Prepared while the consent held: the file still says where and when.
      final EvidencePhoto tagged = (await tester.runAsync(() => prepareEvidence(world.file('tagged.jpg', geotaggedJpeg()), directory: evidence, keepPlaceAndTime: true, newId: newUuidV4)))!;
      expect(readJpegMetadata(File(tagged.path).readAsBytesSync()).hasGps, isTrue);

      unawaited(world.container.read(sitePhotoServiceProvider).keep(PhotoRecord(operationId: 'op-1', contractId: 'c-1', contractCode: 'HD-A-001', caption: '', place: FieldPlace.none, photos: <EvidencePhoto>[tagged])));
      await waitUntil(tester, () async => (await _storedCaptures(world)).any((StoredCapture capture) => capture.record.photos.every((EvidencePhoto photo) => photo.uploadId != null)));

      final StoredCapture capture = (await _captures(tester, world)).single;
      final JpegMetadata sent = readJpegMetadata(File(capture.record.photos.single.path).readAsBytesSync());
      expect(sent.hasGps, isFalse);
      expect(sent.hasTime, isFalse);
      expect(capture.record.photos.single.keepsPlaceOrTime, isFalse);
      final AttachmentUploader uploader = (await tester.runAsync(() => world.container.read(attachmentUploaderProvider.future)))!;
      expect(readJpegMetadata(File(uploader.uploads().single.sourcePath).readAsBytesSync()).hasGps, isFalse, reason: 'the copy that goes up says nothing of where it was taken');
    });

    testWidgets('a capture kept with the consent keeps the place the phone measured, and says so', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _chooseContract(tester);
      await _consent(tester);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await _takeFromGallery(tester, world, geotaggedJpeg());
      await tester.ensureVisible(_save());
      await tapText(tester, 'Lưu và tải ảnh lên');
      await _untilSaved(tester);

      final StoredCapture capture = (await _captures(tester, world)).single;
      expect(capture.record.place.consent, isTrue);
      expect(capture.record.place.position!.latitude, closeTo(10.8, 0.0001));
      expect(find.text('Có kèm vị trí (bạn đã đồng ý)'), findsOneWidget);
    });
  });

  group('UI-QMS-10 the capture is kept on the phone with no connection and goes up when there is one', () {
    testWidgets('saved with no connection: kept in the store under one operation id, its photographs wait to upload, and nothing is registered', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, location: '$_screen?contract=c-1&diary=d-1');
      await _takeFromGallery(tester, world, plainJpeg());
      server.offline = true;
      await tester.enterText(find.widgetWithText(TextField, 'Chú thích'), '  Móng trụ T3 sau khi đổ bê tông  ');
      await tester.ensureVisible(_save());
      await tapText(tester, 'Lưu và tải ảnh lên');
      await _untilSaved(tester);

      expect(find.text('Đã lưu 1 ảnh trên máy'), findsOneWidget);
      expect(find.text('Ảnh đã chụp trên máy'), findsOneWidget);
      expect(find.text('HD-A-001 · 1 ảnh'), findsOneWidget);
      expect(find.text('Nhật ký ngày 03/11/2026'), findsOneWidget);
      expect(find.text('Móng trụ T3 sau khi đổ bê tông'), findsOneWidget);
      final StoredCapture capture = (await _captures(tester, world)).single;
      expect(capture.record.contractId, 'c-1');
      expect(capture.record.siteDiaryId, 'd-1');
      expect(capture.record.caption, 'Móng trụ T3 sau khi đổ bê tông');
      expect(capture.record.photos.single.uploadId, isNotNull, reason: 'handed to the uploader once');
      final AttachmentUploader uploader = (await tester.runAsync(() => world.container.read(attachmentUploaderProvider.future)))!;
      final AttachmentUpload upload = uploader.uploads().single;
      expect(upload.ownerKind, 'site_photo');
      expect(upload.ownerRef, capture.record.operationId);
      expect(upload.state.isFinal, isFalse, reason: 'it waits for the network');
      expect(world.server.api.callsTo('POST', '/site-photos'), isEmpty, reason: 'the register needs a file key the server does not give the phone');
      expect(find.text('Ảnh trong khung ảnh'), findsNothing);
      expect(find.text('Chưa có ảnh.'), findsOneWidget, reason: 'the form starts over for the next capture');
    });

    testWidgets('when the network is back the photograph goes up, is scanned and the capture says all its photographs are clean', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, location: '$_screen?contract=c-1');
      await _takeFromGallery(tester, world, plainJpeg());
      await tester.ensureVisible(_save());
      await tapText(tester, 'Lưu và tải ảnh lên');
      await waitUntil(tester, () async {
        final AttachmentUploader uploader = await world.container.read(attachmentUploaderProvider.future);
        return uploader.uploads().isNotEmpty && uploader.uploads().every((AttachmentUpload u) => u.state == UploadState.clean);
      });
      await settleReal(tester, rounds: 6);
      expect(find.text('Cả 1 ảnh đã tải lên và quét sạch'), findsOneWidget);
    });

    testWidgets('the uploads of a capture open on the attachment screen for that capture', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, location: '$_screen?contract=c-1');
      await _takeFromGallery(tester, world, plainJpeg());
      server.offline = true;
      await tester.ensureVisible(_save());
      await tapText(tester, 'Lưu và tải ảnh lên');
      await _untilSaved(tester);
      final StoredCapture capture = (await _captures(tester, world)).single;

      await tapText(tester, 'Xem tải lên');
      expect(currentLocation(world.container), '/projects/mob-19?owner=site_photo&ref=${capture.record.operationId}');
    });

    testWidgets('dropping a capture cancels its uploads that have not finished and removes its files and its record', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, location: '$_screen?contract=c-1');
      await _takeFromGallery(tester, world, plainJpeg());
      server.offline = true;
      await tester.ensureVisible(_save());
      await tapText(tester, 'Lưu và tải ảnh lên');
      await _untilSaved(tester);
      final StoredCapture capture = (await _captures(tester, world)).single;
      final File prepared = File(capture.record.photos.single.path);
      expect(prepared.existsSync(), isTrue);

      await tapText(tester, 'Bỏ');
      expect(find.text('Bỏ ảnh đã chụp?'), findsOneWidget);
      await tapText(tester, 'Giữ lại');
      expect((await _captures(tester, world)), hasLength(1), reason: 'keeping it changes nothing');
      await tapText(tester, 'Bỏ');
      await tapText(tester, 'Bỏ ảnh');
      await waitUntil(tester, () async => (await _storedCaptures(world)).isEmpty);

      expect(prepared.existsSync(), isFalse);
      final AttachmentUploader uploader = (await tester.runAsync(() => world.container.read(attachmentUploaderProvider.future)))!;
      expect(uploader.uploads().single.state, UploadState.cancelled);
      expect(find.text('Ảnh đã chụp trên máy'), findsNothing);
    });

    testWidgets('leaving after a save that failed half way keeps the files of the capture that is kept on the phone', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, location: '$_screen?contract=c-1');
      await _takeFromGallery(tester, world, plainJpeg());
      await _takeFromGallery(tester, world, plainJpeg(width: 20), name: 'second.jpg');
      await settleReal(tester, rounds: 30);
      final Directory evidence = (await tester.runAsync(() => world.container.read(evidenceDirectoryProvider.future)))!;
      final List<File> prepared = evidence.listSync().whereType<File>().toList()..sort((File a, File b) => a.lastModifiedSync().compareTo(b.lastModifiedSync()));
      expect(prepared.length, greaterThanOrEqualTo(2));
      await tester.runAsync(() async {
        for (int attempt = 0; attempt < 40 && prepared.last.existsSync(); attempt += 1) {
          try {
            prepared.last.deleteSync();
          } on FileSystemException {
            await Future<void>.delayed(const Duration(milliseconds: 50));
          }
        }
      });
      expect(prepared.last.existsSync(), isFalse);

      await tester.ensureVisible(_save());
      await tapText(tester, 'Lưu và tải ảnh lên');
      await waitUntil(tester, () async => find.textContaining('Chưa lưu được ảnh').evaluate().isNotEmpty);
      final StoredCapture capture = (await _captures(tester, world)).single;
      final List<File> owned = <File>[for (final EvidencePhoto photo in capture.record.photos) File(photo.path)].where((File file) => file.existsSync()).toList();
      expect(owned, isNotEmpty, reason: 'the capture that is kept refers to a file that is still there');

      await world.go(tester, '/projects/mob-41');
      await settleReal(tester, rounds: 8);
      for (final File file in owned) {
        expect(file.existsSync(), isTrue, reason: 'the capture kept on the phone still refers to ${file.path}');
      }
    });

    testWidgets('a capture needs a contract and a photograph, and a caption the server takes; nothing is kept before it has them', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await tester.ensureVisible(_save());
      await tapText(tester, 'Lưu và tải ảnh lên');
      expect(find.text('Hãy chọn hợp đồng.'), findsOneWidget);
      expect(find.text('Hãy chụp hoặc chọn ít nhất một ảnh.'), findsOneWidget);

      await tester.enterText(find.widgetWithText(TextField, 'Chú thích'), 'x' * 2001);
      await tapText(tester, 'Lưu và tải ảnh lên');
      expect(find.text('Chú thích tối đa 2000 ký tự.'), findsOneWidget);
      expect(await _captures(tester, world), isEmpty);
      final AttachmentUploader uploader = (await tester.runAsync(() => world.container.read(attachmentUploaderProvider.future)))!;
      expect(uploader.uploads(), isEmpty);
    });

    testWidgets('a read-only organisation cannot keep or upload photographs, and the reason is written beside the button', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, session: _contractor(mode: SessionMode.readOnly));
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa thể lưu và tải ảnh lên.'), findsOneWidget);
      await tester.ensureVisible(_save());
      expect(tester.widget<FilledButton>(_save()).onPressed, isNull);
    });

    testWidgets('the capture screen names the gap: the register is not reached from the phone yet', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server, location: '$_screen?contract=c-1');
      await _takeFromGallery(tester, world, plainJpeg());
      server.offline = true;
      await tester.ensureVisible(_save());
      await tapText(tester, 'Lưu và tải ảnh lên');
      await _untilSaved(tester);
      expect(find.textContaining('chưa làm được từ điện thoại'), findsOneWidget);
    });

    test('a record of a capture is read back whole; one that lacks its contract is left out', () {
      final PhotoRecord record = PhotoRecord(
        operationId: 'op-1',
        contractId: 'c-1',
        contractCode: 'HD-A-001',
        siteDiaryId: 'd-1',
        diaryDate: '2026-11-03',
        caption: 'Móng T3',
        place: FieldPlace.none.withConsent(true).withDevicePosition(const DevicePosition(latitude: 10.8, longitude: 106.7, accuracyMetres: 12)),
        photos: const <EvidencePhoto>[EvidencePhoto(id: 'a', path: 'a.jpg', mime: 'image/jpeg', bytes: 3, uploadId: 'up-1')],
      );
      final PhotoRecord back = PhotoRecord.fromJson(record.toJson())!;
      expect(back.toJson(), record.toJson());
      expect(back.place.consent, isTrue);
      expect(back.photos.single.uploadId, 'up-1');
      expect(PhotoRecord.fromJson(<String, Object?>{'operation_id': 'op'}), isNull);
      final Map<String, Object?> damaged = record.toJson()..['place'] = <String, Object?>{'source': 'device', 'consent': false, 'latitude': 1.0, 'longitude': 2.0, 'accuracy_m': 3.0};
      expect(PhotoRecord.fromJson(damaged)!.place.hasPlace, isFalse, reason: 'a measured place stored without the consent is not trusted');
    });

    test('the capture is checked before anything is kept', () {
      expect(checkCapture(contractId: 'c-1', photos: 1, caption: ''), isEmpty);
      expect(checkCapture(contractId: null, photos: 1, caption: '')['contract'], CaptureProblem.contractRequired);
      expect(checkCapture(contractId: '', photos: 1, caption: '')['contract'], CaptureProblem.contractRequired);
      expect(checkCapture(contractId: 'c-1', photos: 0, caption: '')['photos'], CaptureProblem.noPhoto);
      expect(checkCapture(contractId: 'c-1', photos: 1, caption: 'x' * 2000), isEmpty);
      expect(checkCapture(contractId: 'c-1', photos: 1, caption: 'x' * 2001)['caption'], CaptureProblem.captionTooLong);
    });

    test('how the uploads of a capture stand: clean, waiting, failed, and the other captures and the cancelled left out', () {
      AttachmentUpload upload(String id, UploadState state, {String owner = 'op-1', String kind = 'site_photo'}) => AttachmentUpload(
            id: id,
            tenantId: 't',
            userId: 'u',
            ownerKind: kind,
            ownerRef: owner,
            fileName: 'a.jpg',
            sourcePath: 'a.jpg',
            sizeBytes: 1,
            state: state,
            startKey: 's$id',
            completeKey: 'c$id',
            createdAt: 0,
            updatedAt: 0,
          );
      final UploadSummary summary = summaryOf(<AttachmentUpload>[
        upload('1', UploadState.clean),
        upload('2', UploadState.uploading),
        upload('3', UploadState.failed),
        upload('4', UploadState.infected),
        upload('5', UploadState.pending),
        upload('6', UploadState.scanning),
        upload('7', UploadState.cancelled),
        upload('8', UploadState.clean, owner: 'op-2'),
        upload('9', UploadState.clean, kind: 'issue'),
      ], 'op-1');
      expect(summary.total, 6);
      expect(summary.clean, 1);
      expect(summary.waiting, 3);
      expect(summary.problems, 2);
      expect(summary.isDone, isFalse);
      expect(summaryOf(<AttachmentUpload>[upload('1', UploadState.clean)], 'op-1').isDone, isTrue);
      expect(summaryOf(const <AttachmentUpload>[], 'op-1').isDone, isFalse);
    });
  });
}
