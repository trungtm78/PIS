import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_uploader.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/state/state_card.dart';
import 'package:machvon_mobile/features/attachments/attachments_feature.dart' as attachments;

import '../../support/fake_attachment_server.dart';
import '../../support/harness.dart';
import '../../support/offline_support.dart';
import '../offline/offline_harness.dart' show Gate, expectScreenContract, kTallDevice;

/// The application on the attachment list, with the real encrypted store and uploader and the fake attachment server as the
/// network (the API and the storage).
class AttachmentsApp {
  AttachmentsApp._(this.storage, this.server, this.folder);

  final TestStorage storage;
  final FakeAttachmentServer server;
  final Directory folder;
  late ProviderContainer container;

  static AttachmentsApp create({int chunkBytes = 16}) {
    final Directory folder = Directory.systemTemp.createTempSync('machvon-screen-');
    addTearDown(() {
      if (folder.existsSync()) folder.deleteSync(recursive: true);
    });
    return AttachmentsApp._(TestStorage.create(), FakeAttachmentServer(chunkBytes: chunkBytes), folder);
  }

  File pdf(String name, int size, {String? text}) {
    final Random random = Random(size);
    final Uint8List bytes = Uint8List.fromList(List<int>.generate(size, (int _) => random.nextInt(256)));
    bytes.setRange(0, 5, '%PDF-'.codeUnits);
    if (text != null) bytes.setRange(10, 10 + text.length, text.codeUnits);
    return File('${folder.path}/$name')..writeAsBytesSync(bytes);
  }

  Future<void> open(WidgetTester tester, {String location = '/projects/mob-19', List<Override> overrides = const <Override>[]}) async {
    (await storage.open()).deviceId = '11111111-1111-4111-8111-111111111111';
    container = await pumpApp(
      tester,
      features: <MobileFeature>[attachments.feature],
      transport: server,
      location: location,
      overrides: <Override>[offlineStorageProvider.overrideWithValue(storage.storage), chunkTransportProvider.overrideWithValue(server), ...idleRunners, ...overrides],
    );
  }

  Future<AttachmentUploader> get uploader => container.read(attachmentUploaderProvider.future);
}

/// The uploader reads real files, which the fake clock of a widget test never completes: run the action in real time.
Future<T> real<T>(WidgetTester tester, Future<T> Function() action) async => (await tester.runAsync(action)) as T;

/// Lets the file reads that a tap started finish (real time passes), and the screen catch up.
Future<void> settleIo(WidgetTester tester) async {
  for (int i = 0; i < 60; i += 1) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Future<void> press(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.text(label));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label));
  await settleIo(tester);
}

void main() {
  group('AC-ST-MOB-009-1 UI-MOB-19 MOB-19 shows the progress and resumes after a cut', () {
    testWidgets('a file cut at chunk 7 shows what was sent and Continue sends only the rest; then it is safe to attach', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final AttachmentsApp app = AttachmentsApp.create();
      await app.open(tester);
      final AttachmentUploader uploader = await app.uploader;
      final AttachmentUpload added = await real(tester, () => uploader.add(file: app.pdf('Báo cáo.pdf', 100), ownerKind: 'report', ownerRef: 'r-1'));
      app.server.cutAtChunk = 6;
      await real(tester, () => uploader.run(added.id));
      await tester.pumpAndSettle();
      expect(find.text('Báo cáo.pdf'), findsOneWidget);
      expect(find.text('Chờ tải lên'), findsOneWidget);
      expect(find.text('Đã gửi 6/7 khối'), findsOneWidget);
      expect(find.textContaining('tiếp tục từ khối đã gửi'), findsOneWidget);
      expect(find.text('Mã lỗi: NETWORK_ERROR'), findsOneWidget);
      expect(find.text('Dung lượng 100 B'), findsOneWidget);

      await press(tester, 'Tiếp tục');
      expect(find.text('Đã tải lên, an toàn'), findsOneWidget);
      expect(find.text('Tiếp tục'), findsNothing);
      for (int i = 0; i < 6; i += 1) {
        expect(app.server.chunkSends(uploader.upload(added.id)!.serverId!, i), 1);
      }
    });

    testWidgets('only the files of the record in the query are listed, and none that were cancelled', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final AttachmentsApp app = AttachmentsApp.create();
      await app.open(tester, location: '/projects/mob-19?owner=report&ref=r-1');
      final AttachmentUploader uploader = await app.uploader;
      await real(tester, () => uploader.add(file: app.pdf('mine.pdf', 8), ownerKind: 'report', ownerRef: 'r-1'));
      await real(tester, () => uploader.add(file: app.pdf('other.pdf', 9), ownerKind: 'report', ownerRef: 'r-2'));
      await real(tester, () => uploader.add(file: app.pdf('issue.pdf', 10), ownerKind: 'issue', ownerRef: 'r-1'));
      final AttachmentUpload gone = await real(tester, () => uploader.add(file: app.pdf('gone.pdf', 11), ownerKind: 'report', ownerRef: 'r-1'));
      uploader.cancel(gone.id);
      await tester.pumpAndSettle();
      expect(find.text('mine.pdf'), findsOneWidget);
      expect(find.text('other.pdf'), findsNothing);
      expect(find.text('issue.pdf'), findsNothing);
      expect(find.text('gone.pdf'), findsNothing);
      expect(find.text('1 tệp'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-009-2 UAT-AC506 UI-MOB-19 an infected file shows the reason, with a retry', () {
    testWidgets('the EICAR file says a virus was found, is not linkable, and Try again starts a new upload', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final AttachmentsApp app = AttachmentsApp.create();
      await app.open(tester);
      final AttachmentUploader uploader = await app.uploader;
      final AttachmentUpload added = await real(tester, () => uploader.add(file: app.pdf('eicar.pdf', 80, text: 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!'), ownerKind: 'report'));
      await real(tester, () => uploader.run(added.id));
      await tester.pumpAndSettle();
      expect(find.text('Phát hiện virus'), findsOneWidget);
      expect(find.textContaining('không được đính kèm vào hồ sơ'), findsOneWidget);
      expect(find.text('Mã lỗi: FILE_INFECTED'), findsOneWidget);
      expect(() => uploader.linkableId(added.id), throwsA(isA<AttachmentNotClean>()));
      await press(tester, 'Thử lại');
      expect(app.server.started, 2, reason: 'a new upload');
    });

    testWidgets('a refusal of the type, a damaged transfer and a changed file each have their own words and code', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final AttachmentsApp app = AttachmentsApp.create();
      await app.open(tester);
      final AttachmentUploader uploader = await app.uploader;
      Future<void> refuse(String name, String code) async {
        final AttachmentUpload added = await real(tester, () => uploader.add(file: app.pdf(name, 8 + name.length), ownerKind: 'report'));
        app.server.refuseNextCompletion = (status: 422, code: code);
        await real(tester, () => uploader.run(added.id));
      }

      await refuse('type.pdf', 'FILE_TYPE_NOT_ALLOWED');
      await refuse('other.pdf', 'VALIDATION_FAILED');
      // a transfer that never matches ends with the code of the checksum
      final AttachmentUpload damaged = await real(tester, () => uploader.add(file: app.pdf('sum.pdf', 33), ownerKind: 'report'));
      (await app.storage.open()).uploads.upsert(damaged.copyWith(state: UploadState.failed, errorCode: 'CHECKSUM_MISMATCH'));
      final AttachmentUpload changed = await real(tester, () => uploader.add(file: app.pdf('changed.pdf', 30), ownerKind: 'report'));
      File(changed.sourcePath).deleteSync();
      await real(tester, () => uploader.run(changed.id));
      await tester.pumpAndSettle();
      expect(find.text('Không tải lên được'), findsNWidgets(4));
      expect(find.textContaining('Chỉ nhận ảnh JPEG, PNG hoặc tệp PDF'), findsOneWidget);
      expect(find.textContaining('không khớp mã kiểm tra'), findsOneWidget);
      expect(find.textContaining('Máy chủ không nhận tệp này'), findsOneWidget);
      expect(find.textContaining('bị thay đổi hoặc bị xóa'), findsOneWidget);
      expect(find.text('Mã lỗi: FILE_TYPE_NOT_ALLOWED'), findsOneWidget);
    });
  });

  group('AC-ST-MOB-009-4 UAT-NFR-SECURITY-12 UI-MOB-19 adding files', () {
    testWidgets('a script renamed to .jpg is refused with its code before anything is sent; the good file is added and uploaded', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final AttachmentsApp app = AttachmentsApp.create();
      final File script = File('${app.folder.path}/photo.jpg')..writeAsStringSync('#!/bin/sh\nrm -rf /\n');
      final File good = app.pdf('good.pdf', 20);
      await app.open(tester, location: '/projects/mob-19?owner=report&ref=r-1', overrides: [attachmentPickerProvider.overrideWithValue(() async => <File>[script, good])]);
      expect(find.text('Thêm tệp'), findsOneWidget);
      await tester.tap(find.text('Thêm tệp'));
      await settleIo(tester);
      expect(find.textContaining('Không thêm được tệp'), findsOneWidget);
      expect(find.textContaining('Chỉ nhận ảnh JPEG, PNG hoặc tệp PDF'), findsWidgets);
      expect(find.textContaining('FILE_TYPE_NOT_ALLOWED'), findsOneWidget);
      expect(find.text('good.pdf'), findsOneWidget);
      expect(find.text('photo.jpg'), findsNothing);
      expect(find.text('Đã tải lên, an toàn'), findsOneWidget, reason: 'the runner uploaded the good file');
      expect(app.server.started, 1, reason: 'nothing of the script went to the server');
      expect((await app.uploader).uploads().single.ownerRef, 'r-1');
    });

    testWidgets('the refusal of the only file stays on the screen although the list is still empty', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final AttachmentsApp app = AttachmentsApp.create();
      final File script = File('${app.folder.path}/photo.jpg')..writeAsStringSync('#!/bin/sh\nrm -rf /\n');
      await app.open(tester, location: '/projects/mob-19?owner=report&ref=r-1', overrides: [attachmentPickerProvider.overrideWithValue(() async => <File>[script])]);
      await tester.tap(find.text('Thêm tệp'));
      await settleIo(tester);
      expect(find.text('good.pdf'), findsNothing);
      expect(find.textContaining('Không thêm được tệp'), findsOneWidget, reason: 'the empty state must not hide why the file was not added');
      expect(find.textContaining('Chỉ nhận ảnh JPEG, PNG hoặc tệp PDF'), findsOneWidget);
      expect(find.textContaining('FILE_TYPE_NOT_ALLOWED'), findsOneWidget);
      expect(app.server.started, 0);
    });

    testWidgets('without a picker the list has no Add button',(WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final AttachmentsApp app = AttachmentsApp.create();
      await app.open(tester);
      expect(find.text('Thêm tệp'), findsNothing);
    });
  });

  group('AC-ST-MOB-009-1 UI-MOB-19 the states and the screen contract', () {
    testWidgets('empty, loading, error and ended session', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      AttachmentsApp app = AttachmentsApp.create();
      await app.open(tester);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget, reason: 'empty');

      final Gate gate = Gate();
      app = AttachmentsApp.create();
      await app.open(tester, overrides: [localStoreProvider.overrideWith((Ref ref) async {
        await gate.passed;
        return app.storage.open();
      })]);
      expect(find.byType(LoadingView), findsOneWidget, reason: 'loading');
      gate.open();
      await tester.pumpAndSettle();

      app = AttachmentsApp.create();
      await app.open(tester, overrides: [localStoreProvider.overrideWith((Ref ref) async => throw StateError('disk'))]);
      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget, reason: 'error');

      app = AttachmentsApp.create();
      await app.open(tester, overrides: [localStoreProvider.overrideWith((Ref ref) async => throw const OfflineUnavailable())]);
      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget, reason: 'signed out');
      expect(find.text('Thêm tệp'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('UI-MOB-19 contract: three devices, text at 200 percent, tap targets, labels and contrast', (WidgetTester tester) async {
      await expectScreenContract(tester, (WidgetTester t) async {
        final AttachmentsApp app = AttachmentsApp.create();
        await app.open(t);
        final AttachmentUploader uploader = await app.uploader;
        final AttachmentUpload cut = await real(tester, () => uploader.add(file: app.pdf('a.pdf', 40), ownerKind: 'report'));
        app.server.cutAtChunk = 3;
        await real(tester, () => uploader.run(cut.id));
        final AttachmentUpload bad = await real(tester, () => uploader.add(file: app.pdf('eicar.pdf', 80, text: 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!'), ownerKind: 'report'));
        await real(tester, () => uploader.run(bad.id));
        await t.pumpAndSettle();
      });
    });
  });
}
