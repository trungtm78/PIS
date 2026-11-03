import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:machvon_mobile/features/field_evidence/annotation_canvas.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/field_issues/issue_draft.dart';
import 'package:machvon_mobile/features/field_issues/issue_providers.dart';
import 'package:machvon_mobile/features/permissions/permission_service.dart';

import '../../support/harness.dart';
import '../field_evidence/exif_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'field_world.dart';

/// The phone on MOB-29 for a draft that exists.
Future<(FieldWorld, String)> _open(WidgetTester tester, {bool consent = false, ScriptedServer? api}) async {
  final FieldWorld world = FieldWorld.create(server: FieldServer(api: api ?? (ScriptedServer()..on('GET', '/resources/project', (_) => <String, Object?>{'items': <Object?>[], 'next_cursor': null}))));
  await world.open(tester, '/projects/mob-41');
  final String id = await world.seedDraft(tester, consent: consent);
  await world.go(tester, '/projects/mob-29/$id');
  return (world, id);
}

/// Waits for the photograph the screen is preparing to be in the draft.
Future<IssuePhoto> _photoOf(WidgetTester tester, FieldWorld world, String id) async {
  await waitUntil(tester, () async {
    world.container.invalidate(issueDraftProvider(id));
    return (await world.container.read(issueDraftProvider(id).future))!.draft.photos.isNotEmpty;
  });
  return (await _draft(tester, world, id)).photos.single;
}

Future<IssueDraft> _draft(WidgetTester tester, FieldWorld world, String id) async {
  world.container.invalidate(issueDraftProvider(id));
  return (await tester.runAsync(() => world.container.read(issueDraftProvider(id).future)))!.draft;
}

void main() {
  group('AC-ST-MOB-014-4 UAT-PLAN-38 UI-MOB-29 a photograph of the wrong type or too large is refused or compressed before any upload', () {
    testWidgets('a file that is not a photograph is refused with its reason and its code, and nothing is sent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _open(tester);
      world.photos.gallery = world.file('run.jpg', <int>[0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

      await tapText(tester, 'Chọn từ thư viện');

      expect(find.textContaining('Chỉ nhận ảnh JPEG hoặc PNG'), findsOneWidget);
      expect(find.text('FILE_TYPE_NOT_ALLOWED'), findsOneWidget);
      expect(find.text('Chú thích ảnh'), findsNothing, reason: 'there is nothing to mark');
      expect(world.server.attachments.calls, isEmpty, reason: 'no upload request');
      expect((await _draft(tester, world, id)).photos, isEmpty);
    });

    testWidgets('a PDF is refused too: a document is attached on the attachment screen, not as a photograph', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      world.photos.gallery = world.file('plan.pdf', '%PDF-1.7 plan'.codeUnits);
      await tapText(tester, 'Chọn từ thư viện');
      expect(find.text('FILE_TYPE_NOT_ALLOWED'), findsOneWidget);
    });

    testWidgets('a photograph that is too large for the server is refused with FILE_TOO_LARGE', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      final File huge = world.file('huge.jpg', <int>[0xFF, 0xD8, 0xFF, 0xE0]);
      final RandomAccessFile writer = huge.openSync(mode: FileMode.write)..writeFromSync(<int>[0xFF, 0xD8, 0xFF, 0xE0]);
      writer
        ..setPositionSync(50 * 1024 * 1024)
        ..writeByteSync(0)
        ..closeSync();
      world.photos.gallery = huge;
      await tapText(tester, 'Chọn từ thư viện');
      expect(find.text('FILE_TOO_LARGE'), findsOneWidget);
      expect(find.textContaining('lớn hơn mức hệ thống nhận'), findsOneWidget);
    });

    testWidgets('a large photograph is compressed on the phone before it is kept for the upload', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _open(tester);
      final Uint8List big = noisyJpeg(width: 1600, height: 1200, quality: 100);
      expect(big.length, greaterThan(1024 * 1024));
      world.photos.gallery = world.file('wall.jpg', big);

      await tapText(tester, 'Chọn từ thư viện');
      expect(find.text('Chú thích ảnh'), findsOneWidget);
      await tapText(tester, 'Dùng ảnh này');

      final IssuePhoto photo = await _photoOf(tester, world, id);
      expect(photo.bytes, lessThanOrEqualTo(1024 * 1024));
      expect(File(photo.path).lengthSync(), photo.bytes);
      expect(photo.originalPath, isNotNull, reason: 'the retention policy keeps the photograph as it was taken');
      expect(File(photo.originalPath!).lengthSync(), greaterThan(1024 * 1024));
      expect(find.textContaining('Dung lượng:'), findsOneWidget);
    }, timeout: const Timeout(Duration(minutes: 3)));
  });

  group('AC-ST-MOB-014-2 UAT-AC367 UI-MOB-29 the place and the time of a photograph are kept only with the consent', () {
    testWidgets('without the consent they are removed before the file is kept for the upload, and the screen says so', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _open(tester);
      world.photos.gallery = world.file('gate.jpg', geotaggedJpeg());

      await tapText(tester, 'Chọn từ thư viện');
      expect(find.textContaining('sẽ được xóa trước khi tải lên'), findsOneWidget);
      await tapText(tester, 'Dùng ảnh này');

      final IssuePhoto photo = await _photoOf(tester, world, id);
      final JpegMetadata sent = readJpegMetadata(File(photo.path).readAsBytesSync());
      expect(sent.hasGps, isFalse);
      expect(sent.hasTime, isFalse);
      expect(photo.sourceHadPlaceOrTime, isTrue);
      expect(photo.keepsPlaceOrTime, isFalse);
      expect(find.text('Đã xóa vị trí và thời điểm chụp khỏi ảnh'), findsOneWidget);
    });

    testWidgets('with the consent the place and the time are kept, and the screen says so', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _open(tester, consent: true);
      world.photos.gallery = world.file('gate.jpg', geotaggedJpeg());

      await tapText(tester, 'Chọn từ thư viện');
      expect(find.textContaining('Bạn đã đồng ý lưu vị trí'), findsOneWidget);
      await tapText(tester, 'Dùng ảnh này');

      final IssuePhoto photo = await _photoOf(tester, world, id);
      final JpegMetadata sent = readJpegMetadata(File(photo.path).readAsBytesSync());
      expect(sent.hasGps && sent.hasTime, isTrue);
      expect(photo.keepsPlaceOrTime, isTrue);
      expect(find.text('Giữ vị trí và thời điểm chụp (đã đồng ý)'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-014-1 UI-MOB-29 the camera is asked for only when it is used, and has a way round', () {
    testWidgets('a camera the phone refuses leaves the gallery, and the camera is not opened', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      world.permissionsPlatform.now[AppPermission.camera] = PermissionState.blocked;
      world.photos.camera = world.file('c.jpg', plainJpeg());

      await tapText(tester, 'Chụp ảnh');
      expect(find.text('Cho phép camera'), findsNothing);
      // The rationale screen is open: the person leaves it without a camera.
      await tapText(tester, 'Để sau');

      expect(world.photos.cameraOpened, 0);
      expect(find.text('Camera chưa được cho phép. Bạn vẫn có thể chọn ảnh từ thư viện.'), findsOneWidget);
      expect(find.text('Chọn từ thư viện'), findsOneWidget);
    });

    testWidgets('choosing "attach a file" on the rationale screen opens the gallery', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      world.permissionsPlatform.now[AppPermission.camera] = PermissionState.blocked;
      world.photos.gallery = world.file('g.jpg', plainJpeg());

      await tapText(tester, 'Chụp ảnh');
      await tapText(tester, 'Đính kèm tệp có sẵn trong máy');

      expect(world.photos.galleryOpened, 1);
      expect(find.text('Chú thích ảnh'), findsOneWidget);
    });

    testWidgets('a camera that is allowed opens at once and its photograph is marked', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      world.photos.camera = world.file('c.jpg', plainJpeg());

      await tapText(tester, 'Chụp ảnh');

      expect(world.photos.cameraOpened, 1);
      expect(find.text('Chú thích ảnh'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-014-4 UI-MOB-29 the marks are drawn into the photograph that is kept', () {
    testWidgets('a stroke drawn with a finger is counted, can be taken back and drawn again, and lands in the file', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final (FieldWorld world, String id) = await _open(tester);
      world.photos.gallery = world.file('wall.jpg', plainJpeg(width: 200, height: 100));

      await tapText(tester, 'Chọn từ thư viện');
      await tester.tap(find.text('Nét dày'));
      await tester.pump();
      final Finder canvas = find.descendant(of: find.byType(AnnotationCanvas), matching: find.byType(GestureDetector)).first;
      final TestGesture finger = await tester.startGesture(tester.getCenter(canvas) - const Offset(60, 0));
      for (int step = 0; step < 12; step += 1) {
        await finger.moveBy(const Offset(10, 0));
      }
      await finger.up();
      await settleReal(tester, rounds: 4);
      expect(find.bySemanticsLabel(RegExp('đã vẽ 1 nét')), findsWidgets);

      await tester.tap(find.byTooltip('Hoàn tác nét vẽ'));
      await tester.pump();
      expect(find.bySemanticsLabel(RegExp('đã vẽ 0 nét')), findsWidgets);
      await tester.tap(find.byTooltip('Làm lại nét vẽ'));
      await tester.pump();
      expect(find.bySemanticsLabel(RegExp('đã vẽ 1 nét')), findsWidgets);

      await tester.enterText(find.widgetWithText(TextField, 'Ghi chú cho ảnh'), 'Vết nứt tường rào');
      await tapText(tester, 'Dùng ảnh này');

      final IssuePhoto photo = await _photoOf(tester, world, id);
      expect(photo.annotations.strokes, hasLength(1));
      expect(photo.annotations.caption, 'Vết nứt tường rào');
      final img.Image sent = img.decodeJpg(File(photo.path).readAsBytesSync())!;
      int red = 0;
      for (int x = 0; x < sent.width; x += 1) {
        final img.Pixel p = sent.getPixel(x, sent.height ~/ 2);
        if (p.r > 150 && p.g < 110 && p.b < 110) red += 1;
      }
      expect(red, greaterThan(20), reason: 'the stroke is in the picture');
      expect(find.text('Vết nứt tường rào'), findsWidgets);
      expect(find.text('Đã vẽ 1 nét chú thích'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a photograph can be used as it is, and removed again', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _open(tester);
      world.photos.gallery = world.file('wall.jpg', plainJpeg());
      await tapText(tester, 'Chọn từ thư viện');
      await tapText(tester, 'Dùng ảnh này');
      await _photoOf(tester, world, id);

      await tapText(tester, 'Gỡ ảnh khỏi báo cáo');
      expect((await _draft(tester, world, id)).photos, isEmpty);
    });

    testWidgets('a photograph that is dropped before it is used leaves nothing in the draft', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _open(tester);
      world.photos.gallery = world.file('wall.jpg', plainJpeg());
      await tapText(tester, 'Chọn từ thư viện');
      await tapText(tester, 'Bỏ ảnh này');
      expect(find.text('Chú thích ảnh'), findsNothing);
      expect((await _draft(tester, world, id)).photos, isEmpty);
    });
  });

  group('AC-ST-MOB-041-1 UAT-NFR-TENANCY-07 SEC-03 the copy the picker leaves in the cache does not outlive the decision about the photograph', () {
    testWidgets('a photograph that is used: the picker file (with its place and time) is deleted, the prepared one stays', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _open(tester, consent: true);
      final File picked = world.file('picked.jpg', geotaggedJpeg());
      world.photos.gallery = picked;
      await tapText(tester, 'Chọn từ thư viện');
      expect(picked.existsSync(), isTrue, reason: 'the person is still marking it');
      await tapText(tester, 'Dùng ảnh này');
      final IssuePhoto photo = await _photoOf(tester, world, id);
      expect(picked.existsSync(), isFalse);
      expect(world.photos.discarded, <String>[picked.path]);
      expect(File(photo.path).existsSync(), isTrue);
    });

    testWidgets('a photograph that is dropped before it is used is deleted too', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      final File picked = world.file('dropped.jpg', geotaggedJpeg());
      world.photos.gallery = picked;
      await tapText(tester, 'Chọn từ thư viện');
      await tapText(tester, 'Bỏ ảnh này');
      expect(picked.existsSync(), isFalse);
      expect(world.photos.discarded, <String>[picked.path]);
    });

    testWidgets('a file that is refused is deleted', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      final File picked = world.file('run.jpg', <int>[0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      world.photos.gallery = picked;
      await tapText(tester, 'Chọn từ thư viện');
      expect(find.text('FILE_TYPE_NOT_ALLOWED'), findsOneWidget);
      expect(picked.existsSync(), isFalse);
    });

    testWidgets('leaving the screen with a photograph still being marked deletes it', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      final File picked = world.file('left.jpg', geotaggedJpeg());
      world.photos.gallery = picked;
      await tapText(tester, 'Chọn từ thư viện');
      await tester.pumpWidget(const SizedBox.shrink());
      expect(picked.existsSync(), isFalse);
    });
  });

  group('UI-MOB-29 MOB-29 the states and the contract of the screen', () {
    testWidgets('a draft that is not on this phone says so with its code', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-29/not-a-draft');
      await settleReal(tester, rounds: 8);
      expect(find.text('DRAFT_NOT_FOUND'), findsOneWidget);
    });

    testWidgets('every size, text scale and platform guideline holds', (WidgetTester tester) async {
      await expectScreenContract(
        tester,
        healthy: (ScriptedServer server) {},
        open: (WidgetTester tester, ScriptedServer server) async {
          final FieldWorld world = FieldWorld.create(server: FieldServer(api: server));
          await world.open(tester, '/projects/mob-41');
          final String id = await world.seedDraft(
            tester,
            place: FieldPlace.none.withConsent(true),
            photos: <IssuePhoto>[IssuePhoto(id: 'ph-1', path: world.file('ph.jpg', plainJpeg()).path, mime: 'image/jpeg', bytes: 2048)],
          );
          await world.go(tester, '/projects/mob-29/$id');
        },
      );
    });
  });
}
