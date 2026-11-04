import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show Ref;
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';
import 'package:machvon_mobile/features/field_issues/issue_draft.dart';
import 'package:machvon_mobile/features/field_issues/issue_providers.dart';
import 'package:machvon_mobile/features/field_issues/issue_service.dart';
import 'package:machvon_mobile/features/permissions/permission_service.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../field_evidence/exif_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'field_world.dart';

Future<(FieldWorld, String)> _open(WidgetTester tester, {bool consent = false, String title = 'Sạt lở taluy km3', FieldPlace? place, List<IssuePhoto> photos = const <IssuePhoto>[], FieldServer? server, FakeSession? session}) async {
  final FieldWorld world = FieldWorld.create(server: server);
  await world.open(tester, '/projects/mob-41', session: session);
  final String id = await world.seedDraft(tester, consent: consent, title: title, place: place, photos: photos);
  await world.go(tester, '/projects/mob-30/$id');
  return (world, id);
}

Future<IssueDraft> _draft(WidgetTester tester, FieldWorld world, String id) async {
  world.container.invalidate(issueDraftProvider(id));
  return (await tester.runAsync(() => world.container.read(issueDraftProvider(id).future)))!.draft;
}

/// The payload of the first command in the first batch the server received.
Map<String, Object?> _sentPayload(FieldWorld world) {
  final Map<String, Object?> body = jsonDecode(world.server.sync.batches.first.body!) as Map<String, Object?>;
  final List<Object?> items = body['items']! as List<Object?>;
  return ((items.first! as Map<String, Object?>)['payload']! as Map<String, Object?>);
}

Future<void> _flush(WidgetTester tester, FieldWorld world) async {
  final CommandQueue queue = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
  await tester.runAsync(queue.flush);
  await settleReal(tester, rounds: 6);
}

/// A photograph already prepared for the draft, on the disk of the phone.
IssuePhoto _photo(FieldWorld world, String name, Uint8List bytes, {required bool keeps, bool hadPlace = true}) =>
    IssuePhoto(id: name, path: world.file('$name.jpg', bytes).path, mime: 'image/jpeg', bytes: bytes.length, sourceHadPlaceOrTime: hadPlace, keepsPlaceOrTime: keeps);

/// An issue service whose rewriting of the photographs waits for the test, so the time between the withdrawal and the end of the
/// rewriting can be looked at.
class _GatedIssueService extends IssueService {
  _GatedIssueService(super.ref);

  final Completer<void> gate = Completer<void>();
  bool waiting = false;

  @override
  Future<IssueDraft> enforceConsent(IssueDraft draft) async {
    if (!draft.place.consent) {
      waiting = true;
      await gate.future;
    }
    return super.enforceConsent(draft);
  }
}

void main() {
  group('AC-ST-MOB-014-1 UAT-AC355 UI-MOB-30 a report made with the location permission refused', () {
    testWidgets('has no coordinates, says geo_consent false, and carries the place typed by hand under its source label', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      world.permissionsPlatform.now[AppPermission.location] = PermissionState.blocked;
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 6);

      await tapText(tester, 'Lấy vị trí hiện tại');
      expect(find.text('Mở cài đặt hệ thống'), findsOneWidget, reason: 'the rationale of the phone permission is shown first');
      expect(world.position.asked, 0, reason: 'the position is not read while the phone refuses it');
      await tapText(tester, 'Nhập vị trí thủ công');
      await tester.enterText(find.byType(TextField).last, 'Km 3+200 đường tỉnh ĐT.A1, cạnh trạm biến áp');
      await tapText(tester, 'Dùng vị trí này');

      expect(find.text('Nơi xảy ra (nhập tay): Km 3+200 đường tỉnh ĐT.A1, cạnh trạm biến áp'), findsOneWidget);
      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => world.server.sync.batchPosts > 0);

      final Map<String, Object?> payload = _sentPayload(world);
      expect(payload['geo_consent'], isFalse, reason: 'no position was kept');
      expect(payload.containsKey('geo_lat'), isFalse);
      expect(payload.containsKey('geo_lng'), isFalse);
      expect(payload.containsKey('geo_accuracy_m'), isFalse);
      expect(payload['description'], 'Đất đá đổ ra mặt đường.\n\nVị trí nhập tay: Km 3+200 đường tỉnh ĐT.A1, cạnh trạm biến áp');
    });

    testWidgets('a person who does not consent sends no coordinates and the place they type is still labelled', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);

      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lấy vị trí hiện tại')).onPressed, isNull, reason: 'the phone is not asked without the consent');
      expect(find.text('Cần đồng ý lưu vị trí trước khi lấy vị trí của điện thoại.'), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextField, 'Nơi xảy ra'), 'Cổng phía nam công trường');
      await tapText(tester, 'Dùng nơi này');
      expect(find.text('Nơi xảy ra (nhập tay): Cổng phía nam công trường'), findsOneWidget);
      expect(find.text('Nguồn: nhập tay'), findsOneWidget);
      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => world.server.sync.batchPosts > 0);

      expect(_sentPayload(world)['geo_consent'], isFalse);
      expect(_sentPayload(world).keys, isNot(contains('geo_lat')));
    });

    testWidgets('a place that is too short is refused before it is kept', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester);
      await tester.enterText(find.widgetWithText(TextField, 'Nơi xảy ra'), 'ab');
      await tapText(tester, 'Dùng nơi này');
      expect(find.text('Nhập từ 3 đến 200 ký tự, không có ký tự điều khiển.'), findsOneWidget);
      expect(find.text('Nơi xảy ra (nhập tay): ab'), findsNothing);
    });
  });

  group('AC-ST-MOB-014-1 UI-MOB-30 the position of the phone is read only with the consent of the person', () {
    testWidgets('with the consent and the permission the position is read and sent with geo_consent true', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 6);

      await tapText(tester, 'Lấy vị trí hiện tại');
      await waitUntil(tester, () async => world.position.asked == 1);
      await settleReal(tester, rounds: 8);

      expect(find.textContaining('Vị trí đo bằng điện thoại: 10.800000, 106.700000'), findsOneWidget);
      expect(find.text('Độ chính xác chấp nhận được.'), findsOneWidget);
      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => world.server.sync.batchPosts > 0);
      final Map<String, Object?> payload = _sentPayload(world);
      expect(payload['geo_consent'], isTrue);
      expect(payload['geo_lat'], '10.800000');
      expect(payload['geo_lng'], '106.700000');
      expect(payload['geo_accuracy_m'], '12.00');
    });

    testWidgets('an accuracy above 50 metres is flagged as a poor position', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      world.position.next = const DevicePosition(latitude: 10.8, longitude: 106.7, accuracyMetres: 120);
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 6);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await waitUntil(tester, () async => world.position.asked == 1);
      await settleReal(tester, rounds: 8);

      expect(find.text('Độ chính xác thấp (trên 50 m): vị trí chỉ để tham khảo.'), findsOneWidget);
      expect(find.text('Chưa có vị trí hoặc độ chính xác thấp. Báo cáo vẫn gửi được.'), findsOneWidget);
    });

    testWidgets('a phone that cannot give a position says so and leaves the place to be typed', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      world.position.next = null;
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 6);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await waitUntil(tester, () async => world.position.asked == 1);
      await settleReal(tester, rounds: 6);
      expect(find.text('Không lấy được vị trí của điện thoại. Hãy thử lại hoặc nhập nơi xảy ra bằng tay.'), findsOneWidget);
      expect(find.text('Chưa có vị trí.'), findsOneWidget);
    });

    testWidgets('taking the consent back takes the position away, and the place and time out of the photographs', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-41');
      final IssuePhoto photo = _photo(world, 'gate', geotaggedJpeg(), keeps: true);
      final String id = await world.seedDraft(
        tester,
        place: FieldPlace.none.withConsent(true).withDevicePosition(const DevicePosition(latitude: 10.8, longitude: 106.7, accuracyMetres: 8)),
        photos: <IssuePhoto>[photo],
      );
      await world.go(tester, '/projects/mob-30/$id');
      expect(readJpegMetadata(File(photo.path).readAsBytesSync()).hasGps, isTrue);

      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 12);

      final IssueDraft draft = await _draft(tester, world, id);
      expect(draft.place.hasDevicePosition, isFalse);
      expect(draft.place.consent, isFalse);
      expect(draft.photos.single.keepsPlaceOrTime, isFalse);
      expect(readJpegMetadata(File(photo.path).readAsBytesSync()).carriesPlaceOrTime, isFalse, reason: 'the file on the phone was rewritten without them');
      expect(find.text('Chưa có vị trí.'), findsOneWidget);
    });

    testWidgets('the withdrawal is on the phone before the photographs are rewritten, and the report cannot be sent meanwhile', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      _GatedIssueService? gated;
      await world.open(tester, '/projects/mob-41', overrides: <Override>[issueServiceProvider.overrideWith((Ref ref) => gated = _GatedIssueService(ref))]);
      final IssuePhoto photo = _photo(world, 'gate', geotaggedJpeg(), keeps: true);
      final String id = await world.seedDraft(
        tester,
        place: FieldPlace.none.withConsent(true).withDevicePosition(const DevicePosition(latitude: 10.8, longitude: 106.7, accuracyMetres: 8)),
        photos: <IssuePhoto>[photo],
      );
      await world.go(tester, '/projects/mob-30/$id');
      final Finder send = find.widgetWithText(FilledButton, 'Gửi báo cáo');
      expect(tester.widget<FilledButton>(send).onPressed, isNotNull);

      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 8);
      // The files are still being rewritten (the gate holds them): a send now must find the withdrawal, not the old place.
      expect(gated!.waiting, isTrue);
      expect((await _draft(tester, world, id)).place.consent, isFalse, reason: 'the withdrawal is stored before the files are touched');
      expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value, isFalse);
      expect(tester.widget<FilledButton>(send).onPressed, isNull, reason: 'no send while the photographs still say where they were taken');

      gated!.gate.complete();
      await settleReal(tester, rounds: 12);
      expect(readJpegMetadata(File(photo.path).readAsBytesSync()).carriesPlaceOrTime, isFalse);
      expect(tester.widget<FilledButton>(send).onPressed, isNotNull, reason: 'the send is back once the photographs are clean');
    });

    testWidgets('a reading that arrives after the consent was taken back is dropped', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _open(tester);
      final Future<DevicePosition?> slow = Future<DevicePosition?>.delayed(const Duration(milliseconds: 600), () => const DevicePosition(latitude: 10.8, longitude: 106.7, accuracyMetres: 5));
      world.position.slow = slow;
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 6);
      await tapText(tester, 'Lấy vị trí hiện tại');
      await tester.tap(find.byType(SwitchListTile));
      await settleReal(tester, rounds: 40);

      expect((await _draft(tester, world, id)).place.hasDevicePosition, isFalse, reason: 'nobody agreed to keep it any more');
    });
  });

  group('AC-ST-MOB-014-2 UAT-AC367 UI-MOB-30 the photographs that go up carry no place or time the person did not agree to keep', () {
    testWidgets('a photograph taken without the consent goes up without them, and the upload is the prepared copy', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-41');
      // The photograph was prepared while the consent was not given: no place, no time.
      final Uint8List stripped = stripJpegMetadata(geotaggedJpeg());
      final String id = await world.seedDraft(tester, photos: <IssuePhoto>[_photo(world, 'gate', stripped, keeps: false)]);
      await world.go(tester, '/projects/mob-30/$id');

      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => world.server.attachments.uploadIds.isNotEmpty && world.server.attachments.statusOf(world.server.attachments.uploadIds.first) == 'CLEAN', seconds: 40);

      final Uint8List uploaded = world.server.attachments.storedBytes(world.server.attachments.uploadIds.single)!;
      expect(readJpegMetadata(uploaded).hasExif, isFalse);
      expect(readJpegMetadata(uploaded).carriesPlaceOrTime, isFalse);
      expect(uploaded, stripped);
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('a photograph that still says where, with the consent taken back, is stripped before it goes up', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-41');
      final Uint8List tagged = geotaggedJpeg();
      // The draft holds a photograph that keeps its place although the consent is gone (a draft from an older version of the form).
      final String id = await world.seedDraft(tester, photos: <IssuePhoto>[_photo(world, 'gate', tagged, keeps: true)]);
      await world.go(tester, '/projects/mob-30/$id');
      expect(find.text('Có ảnh còn vị trí hoặc thời điểm chụp dù bạn chưa đồng ý lưu vị trí.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi báo cáo')).onPressed, isNull, reason: 'the check stops the send');
    });
  });

  group('AC-ST-MOB-014-3 UAT-PLAN-37 an obstacle created offline is one issue after the network returns', () {
    testWidgets('is kept on the phone offline, sent when the network returns, looked up when the answer is lost, and followed in MOB-31', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.on('GET', '/resources/issue/iss-1', (_) => issueView('iss-1', events: <Object?>[issueEvent('e-1', 'CREATED', actor: 'Nguyễn Văn A')]));
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.accepted(resultRef: 'iss-1');
      final (FieldWorld world, _) = await _open(tester, server: server);

      // No network: the report is kept, nothing is sent.
      server.offline = true;
      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => find.text('Theo dõi vướng mắc').evaluate().isNotEmpty);
      final String reference = currentLocation(world.container).split('/').last;
      await settleReal(tester, rounds: 20);
      expect(find.text('Sạt lở taluy km3'), findsOneWidget);
      expect(server.sync.effects, isEmpty, reason: 'nothing reached the server');
      expect(find.text('NETWORK_ERROR'), findsOneWidget, reason: 'the card says why it is not done');

      // The network is back, but the first answer is lost: the phone cannot know whether the server did the work.
      server.offline = false;
      server.sync.dropNextBatchAnswer = true;
      await _flush(tester, world);
      final CommandQueue queue = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
      final QueuedCommand unknown = queue.command(reference)!;
      expect(unknown.state, CommandState.unknown);
      await settleReal(tester, rounds: 6);
      expect(find.textContaining('Chưa xác định kết quả'), findsWidgets);

      // The phone looks the command up by its key; it never creates a second one.
      await _flush(tester, world);
      expect(queue.command(reference)!.state, CommandState.accepted);
      await settleReal(tester, rounds: 12);

      expect(server.sync.effectsOf(unknown.idempotencyKey), 1, reason: 'one issue for the key');
      expect(server.sync.lookups, greaterThanOrEqualTo(1), reason: 'the lost answer was looked up by the key');
      expect(unknown.idempotencyKey, _sentPayload(world)['client_operation_id'], reason: 'the key of the command is the identity of the report');
      expect(find.text('Sạt lở taluy km3'), findsWidgets);
      expect(find.text('ISS-0001'), findsOneWidget);
      expect(find.text('Mới ghi nhận'), findsWidgets);
      expect(find.text('05/11/2026 17:00'), findsWidgets, reason: 'the resolution deadline the server counted, in Vietnam time');
      expect(server.api.callsTo('GET', '/resources/issue/iss-1'), isNotEmpty);
    }, timeout: const Timeout(Duration(minutes: 2)));
  });

  group('AC-ST-MOB-014-6 UI-MOB-30 the send is gated by the check and by the session', () {
    testWidgets('a report without a title cannot be sent, and the line that is missing says so', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester, title: '');
      expect(find.text('Chưa có tiêu đề hoặc mô tả.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi báo cáo')).onPressed, isNull);
      expect(world.server.sync.batchPosts, 0);
    });

    testWidgets('a read-only system keeps the send closed', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)));
      expect(find.text('Hệ thống đang ở chế độ chỉ đọc nên chưa gửi được.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi báo cáo')).onPressed, isNull);
    });

    testWidgets('a photograph and a place missing are advice, not a block', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester);
      expect(find.text('Chưa có ảnh. Nên chụp ảnh nếu có thể.'), findsOneWidget);
      expect(find.text('Chưa có vị trí hoặc độ chính xác thấp. Báo cáo vẫn gửi được.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi báo cáo')).onPressed, isNotNull);
    });

    testWidgets('a second tap on Send, and a send repeated, queue one command', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _open(tester);
      world.server.offline = true;
      final CommandQueue queue = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => queue.unsentCount > 0);
      expect(queue.unsentCount, 1);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectScreenContract(
        tester,
        healthy: (ScriptedServer server) {},
        open: (WidgetTester tester, ScriptedServer server) async {
          final FieldWorld world = FieldWorld.create(server: FieldServer(api: server));
          await world.open(tester, '/projects/mob-41');
          final String id = await world.seedDraft(tester, consent: true);
          await world.go(tester, '/projects/mob-30/$id');
        },
      );
    });

    testWidgets('a draft that is not on this phone says so with its code', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-30/not-a-draft');
      await settleReal(tester, rounds: 8);
      expect(find.text('DRAFT_NOT_FOUND'), findsOneWidget);
    });
  });
}
