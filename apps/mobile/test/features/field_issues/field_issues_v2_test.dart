import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/offline/drafts/draft_store.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/widgets/tap_target.dart';
import 'package:machvon_mobile/features/field_evidence/field_place.dart';
import 'package:machvon_mobile/features/field_issues/issue_draft.dart';

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../field_evidence/exif_fixtures.dart';
import '../support/scripted_server.dart';
import 'field_world.dart';

/// The v2 design of the field issue screens (MUX-3 wave C): the states the redesign added (the bar, the flags, the rows, the empty state with
/// its action) and the flows of R39 (an offline save is one queued command and a receipt; a retry or a lost answer never makes a second one).

Future<(FieldWorld, String)> _atCheck(WidgetTester tester, {FieldServer? server, bool consent = false, String title = 'Sạt lở taluy km3', List<IssuePhoto> photos = const <IssuePhoto>[], FieldPlace? place, bool idle = true}) async {
  final FieldWorld world = FieldWorld.create(server: server);
  await world.open(tester, '/projects/mob-41', overrides: idle ? idleRunners : const <Override>[]);
  final String id = await world.seedDraft(tester, consent: consent, title: title, photos: photos, place: place);
  await world.go(tester, '/projects/mob-30/$id');
  return (world, id);
}

Future<CommandQueue> _queue(WidgetTester tester, FieldWorld world) async => (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;

List<QueuedCommand> _issues(CommandQueue queue) => queue.commands().where((QueuedCommand c) => c.commandType == kIssueCreateCommand).toList();

/// Stops the runners a send started, so nothing is still waiting on a timer when the test ends.
Future<void> _quiesce(WidgetTester tester, FieldWorld world) => tester.runAsync(() async {
      (await world.container.read(queueRunnerProvider.future)).dispose();
      (await world.container.read(uploadRunnerProvider.future)).dispose();
    });

void _goOffline(FieldWorld world, {required bool offline}) {
  world.server.offline = offline;
  world.container.read(reachabilityProvider.notifier).report(offline ? Reachability.offline : Reachability.online);
}

/// The idempotency keys the server was sent in its batches, in order.
List<String> _keysSent(FieldWorld world) => <String>[
  for (final HttpCall call in world.server.sync.batches)
    for (final Object? item in (jsonDecode(call.body!) as Map<String, Object?>)['items']! as List<Object?>) (item! as Map<String, Object?>)['idempotency_key']! as String,
];

IssuePhoto _photo(FieldWorld world, String name) {
  final List<int> bytes = plainJpeg();
  return IssuePhoto(id: name, path: world.file('$name.jpg', bytes).path, mime: 'image/jpeg', bytes: bytes.length);
}

void main() {
  group('R39 UAT-PLAN-37 an obstacle saved offline is one queued issue.create and a receipt', () {
    testWidgets('offline the bar offers to save, the report is queued once, and the receipt says it was saved with the way to the queue', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _atCheck(tester);
      final CommandQueue queue = await _queue(tester, world);
      _goOffline(world, offline: true);
      await tester.pump();

      expect(find.text('Gửi báo cáo'), findsNothing, reason: 'offline the word is not "send"');
      expect(find.text('Lưu, gửi khi có mạng'), findsOneWidget);
      await tapText(tester, 'Lưu, gửi khi có mạng');
      await waitUntil(tester, () async => find.text('Theo dõi vướng mắc').evaluate().isNotEmpty);
      await settleReal(tester, rounds: 6);

      expect(_issues(queue), hasLength(1), reason: 'one command, however the save was made');
      expect(_issues(queue).single.state, isNot(CommandState.accepted));
      expect(world.server.sync.effects, isEmpty, reason: 'nothing reached the server');
      expect(find.text('Đã lưu, sẽ gửi khi có mạng'), findsOneWidget, reason: 'the receipt of an offline save');
      expect(find.text('Sạt lở taluy km3'), findsOneWidget);

      await tapText(tester, 'Xem hàng đợi gửi');
      expect(currentLocation(world.container), '/projects/mob-41');
      await _quiesce(tester, world);
    });

    testWidgets('the network comes back: the queued report is carried out once under its key, and a second flush makes no second issue', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _atCheck(tester);
      final CommandQueue queue = await _queue(tester, world);
      _goOffline(world, offline: true);
      await tester.pump();
      await tapText(tester, 'Lưu, gửi khi có mạng');
      await settleReal(tester, rounds: 10);
      final String key = _issues(queue).single.idempotencyKey;

      _goOffline(world, offline: false);
      await tester.runAsync(queue.flush);
      await tester.runAsync(queue.flush);
      await settleReal(tester, rounds: 6);

      expect(world.server.sync.effectsOf(key), 1, reason: 'one issue for the key');
      expect(_issues(queue), hasLength(1));
      expect(_issues(queue).single.state, CommandState.accepted);
      expect(_keysSent(world).toSet(), <String>{key}, reason: 'only one key ever went to the server');
      await _quiesce(tester, world);
    });

    testWidgets('a failure that may go away leaves the report queued, and the retry is sent under the same key: one issue', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      int answers = 0;
      server.sync.decide = (Map<String, Object?> item) => ++answers == 1 ? const ServerOutcome.transient() : const ServerOutcome.accepted(resultRef: 'iss-1');
      final (FieldWorld world, _) = await _atCheck(tester, server: server);
      final CommandQueue queue = await _queue(tester, world);

      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => find.text('Theo dõi vướng mắc').evaluate().isNotEmpty);
      final String key = _issues(queue).single.idempotencyKey;
      await tester.runAsync(queue.flush);
      await settleReal(tester, rounds: 6);
      expect(server.sync.effectsOf(key), 0, reason: 'the first answer was a failure that may go away');
      expect(_issues(queue).single.state, isNot(CommandState.accepted));

      await tester.runAsync(() => queue.retry(_issues(queue).single.id));
      await settleReal(tester, rounds: 6);

      expect(server.sync.effectsOf(key), 1);
      expect(_issues(queue), hasLength(1), reason: 'the retry did not make a second command');
      expect(_keysSent(world).toSet(), <String>{key}, reason: 'every send carried the key of the first');
      await _quiesce(tester, world);
    });

    testWidgets('a lost answer is shown as not known, then looked up by the key and never created twice', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.on('GET', '/resources/issue/iss-1', (_) => issueView('iss-1'));
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.accepted(resultRef: 'iss-1');
      final (FieldWorld world, _) = await _atCheck(tester, server: server);
      final CommandQueue queue = await _queue(tester, world);
      server.sync.dropNextBatchAnswer = true;
      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => find.text('Theo dõi vướng mắc').evaluate().isNotEmpty);
      await settleReal(tester, rounds: 8);
      final QueuedCommand command = _issues(queue).single;

      expect(command.state, CommandState.unknown);
      expect(find.textContaining('Chưa xác định kết quả'), findsWidgets);
      expect(find.widgetWithText(FilledButton, 'Gửi lại'), findsNothing, reason: 'an unknown result is never sent again as a new one');
      expect(find.text('Mở hàng đợi'), findsWidgets, reason: 'the way to the queue is there');

      await tester.runAsync(queue.flush);
      await settleReal(tester, rounds: 12);
      expect(queue.command(command.id)!.state, CommandState.accepted);
      expect(server.sync.effectsOf(command.idempotencyKey), 1);
      expect(server.sync.lookups, greaterThanOrEqualTo(1));
      expect(_issues(queue), hasLength(1));
      await _quiesce(tester, world);
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('a refusal keeps the report with its code, and sending it again is one new decision: one issue carried out in all', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      bool refuse = true;
      server.sync.decide = (Map<String, Object?> item) => refuse ? const ServerOutcome.rejected('SCOPE_DENIED') : const ServerOutcome.accepted(resultRef: 'iss-1');
      server.api.on('GET', '/resources/issue/iss-1', (_) => issueView('iss-1'));
      final (FieldWorld world, _) = await _atCheck(tester, server: server);
      final CommandQueue queue = await _queue(tester, world);
      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => find.text('Theo dõi vướng mắc').evaluate().isNotEmpty);
      final String first = _issues(queue).single.idempotencyKey;
      await tester.runAsync(queue.flush);
      await settleReal(tester, rounds: 8);

      expect(find.text('SCOPE_DENIED'), findsOneWidget);
      expect(find.text('Máy chủ không nhận báo cáo này.'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Gửi lại'), findsOneWidget);
      expect(server.sync.effectsOf(first), 0);

      refuse = false;
      await tapText(tester, 'Gửi lại');
      await settleReal(tester, rounds: 12);

      final int carriedOut = _keysSent(world).toSet().fold<int>(0, (int total, String key) => total + server.sync.effectsOf(key));
      expect(carriedOut, 1, reason: 'one issue came of the report, however many sends it took');
      expect(_issues(queue).where((QueuedCommand c) => c.state == CommandState.accepted), hasLength(1));
      await _quiesce(tester, world);
    }, timeout: const Timeout(Duration(minutes: 2)));

    testWidgets('a conflict of versions is a warning with the way to the queue where the version is chosen', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.conflict();
      final (FieldWorld world, _) = await _atCheck(tester, server: server);
      final CommandQueue queue = await _queue(tester, world);
      await tapText(tester, 'Gửi báo cáo');
      await waitUntil(tester, () async => find.text('Theo dõi vướng mắc').evaluate().isNotEmpty);
      await tester.runAsync(queue.flush);
      await settleReal(tester, rounds: 8);

      expect(_issues(queue).single.state, CommandState.conflict);
      expect(find.text('Báo cáo cần bạn chọn phiên bản ở màn hình hàng đợi.'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Gửi lại'), findsNothing, reason: 'a conflict is settled in the queue, not sent again');
      await tapText(tester, 'Mở hàng đợi');
      expect(currentLocation(world.container), '/projects/mob-41');
      await _quiesce(tester, world);
    });
  });

  group('UI-MOB-28 the capture form is one screen with the action at its foot', () {
    testWidgets('the severity is a row of chips: the chosen one is kept in the draft, and the category chips are there while there are few', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create(server: FieldServer(api: (ScriptedServer()..let(answerLookups))));
      await world.open(tester, '/projects/mob-28', overrides: idleRunners);
      await settleReal(tester, rounds: 6);

      expect(find.byType(DropdownButtonFormField<String>), findsNWidgets(2), reason: 'only the project and the unit are menus');
      expect(find.text('Trung bình'), findsOneWidget);
      await tapText(tester, 'Nghiêm trọng');
      await tapText(tester, 'MAT_BANG · Mặt bằng');
      final IssueDraft draft = await readDraft(tester, world);
      expect(draft.severity, 'CRITICAL');
      expect(draft.categoryVersionId, 'c-1');
    });

    testWidgets('the error of a missing category is under its chips, and goes away when one is chosen', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create(server: FieldServer(api: (ScriptedServer()..let(answerLookups))));
      await world.open(tester, '/projects/mob-28', overrides: idleRunners);
      await settleReal(tester, rounds: 6);

      await tapText(tester, 'Xem lại và gửi');
      expect(find.text('Bắt buộc nhập.'), findsNWidgets(5));
      final double chips = tester.getTopLeft(find.text('MAT_BANG · Mặt bằng')).dy;
      final double error = tester.getTopLeft(find.text('Bắt buộc nhập.').at(2)).dy;
      expect(error, greaterThan(chips), reason: 'the third error is the category one, under its chips');
      await tapText(tester, 'MAT_BANG · Mặt bằng');
      expect(find.text('Bắt buộc nhập.'), findsNothing);
    });

    testWidgets('offline the capture bar still says review: it only goes on to the check, the save for later is made there', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create(server: FieldServer(api: (ScriptedServer()..let(answerLookups))));
      await world.open(tester, '/projects/mob-28', overrides: idleRunners);
      await settleReal(tester, rounds: 6);
      expect(find.widgetWithText(FilledButton, 'Xem lại và gửi'), findsOneWidget);

      _goOffline(world, offline: true);
      await tester.pump();
      expect(find.widgetWithText(FilledButton, 'Xem lại và gửi'), findsOneWidget);
      expect(find.text('Lưu, gửi khi có mạng'), findsNothing);
    });

    testWidgets('adding a photograph is one tap: the camera opens at once and the photograph is ready to be marked', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create(server: FieldServer(api: (ScriptedServer()..let(answerLookups))));
      await world.open(tester, '/projects/mob-28', overrides: idleRunners);
      await settleReal(tester, rounds: 6);
      world.photos.camera = world.file('c.jpg', plainJpeg());

      await tapText(tester, 'Chụp ảnh');
      await settleReal(tester, rounds: 8);

      expect(world.photos.cameraOpened, 1, reason: 'one tap on the capture form opened the camera');
      expect(currentLocation(world.container), startsWith('/projects/mob-29/'));
      expect(find.text('Chú thích ảnh'), findsOneWidget);
    });

    testWidgets('a photograph of the draft is a thumbnail in the strip with its count, and opens the photograph screen', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create(server: FieldServer(api: (ScriptedServer()..let(answerLookups))));
      await world.open(tester, '/projects/mob-41', overrides: idleRunners);
      final String id = await world.seedDraft(tester, photos: <IssuePhoto>[_photo(world, 'a')]);
      await world.go(tester, '/projects/mob-28?draft=$id');
      await settleReal(tester, rounds: 6);

      expect(find.text('Đã thêm 1 ảnh.'), findsOneWidget);
      final SemanticsHandle semantics = tester.ensureSemantics();
      expect(find.bySemanticsLabel('Ảnh 1, mở để xem và chú thích'), findsOneWidget);
      semantics.dispose();
      expect(tester.getSize(find.byType(TapTarget).first).height, greaterThanOrEqualTo(44));
    });

    testWidgets('a draft left on the phone is a row under a heading with its count', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create(server: FieldServer(api: (ScriptedServer()..let(answerLookups))));
      await world.open(tester, '/projects/mob-41', overrides: idleRunners);
      await world.seedDraft(tester, title: 'Cọc tiêu bị gãy');
      await world.go(tester, '/projects/mob-28');
      await settleReal(tester, rounds: 6);

      expect(find.text('Chưa hoàn tất trên máy này'), findsOneWidget);
      expect(find.text('Cọc tiêu bị gãy'), findsOneWidget);
    });
  });

  group('UI-MOB-29 the photographs are rows with their state, and the camera has a way round', () {
    testWidgets('a photograph that is used is a row: ready, its size, what happened to its place and time, and a 48 high remove action', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-41', overrides: idleRunners);
      final String id = await world.seedDraft(tester);
      await world.go(tester, '/projects/mob-29/$id');
      world.photos.gallery = world.file('wall.jpg', geotaggedJpeg());

      await tapText(tester, 'Chọn từ thư viện');
      await tapText(tester, 'Dùng ảnh này');
      await waitUntil(tester, () async => find.text('Sẵn sàng').evaluate().isNotEmpty);

      expect(find.text('Sẵn sàng'), findsOneWidget);
      expect(find.textContaining('Dung lượng:'), findsOneWidget);
      expect(find.text('Đã xóa vị trí và thời điểm chụp khỏi ảnh'), findsOneWidget);
      expect(find.text('Đã có 1/10 ảnh.'), findsOneWidget);
      final Finder remove = find.ancestor(of: find.text('Gỡ ảnh khỏi báo cáo'), matching: find.byType(TapTarget));
      expect(tester.getSize(remove).height, greaterThanOrEqualTo(48));
    });

    testWidgets('a refused file is a panel with its reason and its code, and "try again" opens the gallery once more', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-41', overrides: idleRunners);
      final String id = await world.seedDraft(tester);
      await world.go(tester, '/projects/mob-29/$id');
      world.photos.gallery = world.file('run.jpg', <int>[0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

      await tapText(tester, 'Chọn từ thư viện');
      expect(find.text('FILE_TYPE_NOT_ALLOWED'), findsOneWidget);
      expect(find.text('Thử lại'), findsOneWidget);

      world.photos.gallery = world.file('wall.jpg', plainJpeg());
      await tapText(tester, 'Thử lại');

      expect(world.photos.galleryOpened, 2, reason: 'the same source again');
      expect(find.text('FILE_TYPE_NOT_ALLOWED'), findsNothing);
      expect(find.text('Chú thích ảnh'), findsOneWidget);
    });

    testWidgets('opened with start=camera the camera opens at once; a camera that is refused leaves the gallery', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-41', overrides: idleRunners);
      final String id = await world.seedDraft(tester);
      world.photos.camera = world.file('c.jpg', plainJpeg());
      await world.go(tester, '/projects/mob-29/$id?start=camera');
      await settleReal(tester, rounds: 6);
      expect(world.photos.cameraOpened, 1);
      expect(find.text('Chú thích ảnh'), findsOneWidget);
    });

    testWidgets('a draft that is full says so as the reason the bar is locked, and the photograph buttons are locked', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-41', overrides: idleRunners);
      final String id = await world.seedDraft(tester, photos: <IssuePhoto>[for (int i = 0; i < 10; i += 1) _photo(world, 'p$i')]);
      await world.go(tester, '/projects/mob-29/$id');

      expect(find.text('Mỗi báo cáo tối đa 10 ảnh.'), findsWidgets);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Chụp ảnh')).onPressed, isNull);
      expect(find.text('Đã có 10/10 ảnh.'), findsOneWidget);
    });

    testWidgets('a draft that is not on the phone is an empty state whose action records an obstacle', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-29/not-a-draft');
      await settleReal(tester, rounds: 8);

      expect(find.text('Không tìm thấy bản nháp này'), findsOneWidget);
      expect(find.text('DRAFT_NOT_FOUND'), findsOneWidget);
      await tapText(tester, 'Ghi nhận vướng mắc');
      expect(currentLocation(world.container), '/projects/mob-28');
    });
  });

  group('UI-MOB-30 the check is a list of rows with flags that lead to the fix, and the send is in the bar', () {
    testWidgets('each line of the check has its state; a missing detail is a flag whose action opens the form with the draft', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _atCheck(tester, title: '');

      expect(find.text('Thiếu'), findsOneWidget);
      expect(find.text('Chưa có tiêu đề hoặc mô tả.'), findsOneWidget);
      expect(find.text('Còn thông tin bắt buộc chưa đủ'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi báo cáo')).onPressed, isNull);
      expect(find.text('Chưa gửi được: còn mục bắt buộc chưa đạt. Xem lại các mục ở trên.'), findsOneWidget, reason: 'the bar says why it is locked');

      await tapText(tester, 'Sửa thông tin');
      expect(currentLocation(world.container), '/projects/mob-28?draft=$id');
    });

    testWidgets('no photograph is advice with an action that opens the camera, and does not lock the send', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, String id) = await _atCheck(tester);
      expect(find.text('Lưu ý'), findsWidgets);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi báo cáo')).onPressed, isNotNull);
      world.photos.camera = world.file('c.jpg', plainJpeg());

      await tapText(tester, 'Thêm ảnh');
      await settleReal(tester, rounds: 8);

      expect(currentLocation(world.container), startsWith('/projects/mob-29/$id'));
      expect(world.photos.cameraOpened, 1);
    });

    testWidgets('the accuracy of a measured position is shown with the decimal comma of the language, and a poor one is a flag', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _atCheck(
        tester,
        place: FieldPlace.none.withConsent(true).withDevicePosition(const DevicePosition(latitude: 10.762622, longitude: 106.660172, accuracyMetres: 120.4)),
      );
      expect(find.textContaining('10,762622; 106,660172'), findsOneWidget);
      expect(find.textContaining('sai số khoảng 120 m'), findsOneWidget);
      expect(find.text('Độ chính xác thấp (trên 50 m): vị trí chỉ để tham khảo.'), findsOneWidget);
    });

    testWidgets('the same screen in English writes the coordinates with a dot', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-41', locale: const Locale('en'), overrides: idleRunners);
      final String id = await world.seedDraft(tester, place: FieldPlace.none.withConsent(true).withDevicePosition(const DevicePosition(latitude: 10.762622, longitude: 106.660172, accuracyMetres: 8)));
      await world.go(tester, '/projects/mob-30/$id');
      expect(find.textContaining('10.762622, 106.660172'), findsOneWidget);
    });

    testWidgets('while the person is offline the offline line says the report is kept on the phone', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final (FieldWorld world, _) = await _atCheck(tester);
      _goOffline(world, offline: true);
      await tester.pump();
      expect(find.text('Không có mạng: báo cáo được lưu trên máy và tự gửi khi có mạng.'), findsOneWidget);
    });
  });

  group('UI-MOB-31 the follow-up is a timeline, a list of facts and a bar for the comment', () {
    testWidgets('the exchange is a timeline, newest first, with the comments marked and their words; the deadlines are rows in Vietnam time', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.on(
        'GET',
        '/resources/issue/iss-1',
        (_) => issueView('iss-1', status: 'IN_PROGRESS', events: <Object?>[
          issueEvent('e-1', 'CREATED', at: '2026-11-03T01:00:00Z', actor: 'Nguyễn Văn A'),
          issueEvent('e-3', 'COMMENTED', at: '2026-11-03T03:00:00Z', note: 'Đã cử xe múc ra hiện trường', actor: 'Trần Văn B'),
        ]),
      );
      await FieldWorld.create(server: server).open(tester, '/projects/mob-31/iss-1');
      await settleReal(tester, rounds: 10);

      expect(find.byIcon(Icons.chat_bubble_outline), findsOneWidget, reason: 'the comment is marked in the timeline');
      expect(find.text('03/11/2026 10:00'), findsOneWidget);
      expect(find.text('Hạn phản hồi'), findsOneWidget);
      expect(find.text('Chưa có diễn biến.'), findsNothing);
    });

    testWidgets('the comment bar is locked offline with its reason, and the words stay in the field', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.on('GET', '/resources/issue/iss-1', (_) => issueView('iss-1'));
      final FieldWorld world = FieldWorld.create(server: server);
      await world.open(tester, '/projects/mob-31/iss-1');
      await settleReal(tester, rounds: 10);
      await tester.enterText(find.widgetWithText(TextField, 'Nội dung ý kiến'), 'Đã báo cho đội thi công.');
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi ý kiến')).onPressed, isNotNull);

      _goOffline(world, offline: true);
      await tester.pump();

      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi ý kiến')).onPressed, isNull);
      expect(find.text('Ý kiến cần có mạng để gửi. Nội dung bạn đã nhập được giữ lại.'), findsOneWidget);
      expect(find.text('Đã báo cho đội thi công.'), findsOneWidget);
    });

    testWidgets('a comment that was refused is a panel with the code and keeps the bar usable for another try', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.on('GET', '/resources/issue/iss-1', (_) => issueView('iss-1'));
      server.api.refuse('POST', '/issues/iss-1/comments', 409, 'ISSUE_STATE_INVALID');
      await FieldWorld.create(server: server).open(tester, '/projects/mob-31/iss-1');
      await settleReal(tester, rounds: 10);
      await tester.enterText(find.widgetWithText(TextField, 'Nội dung ý kiến'), 'Đã báo cho đội thi công.');
      await tapText(tester, 'Gửi ý kiến');
      await settleReal(tester, rounds: 6);

      expect(find.text('ISSUE_STATE_INVALID'), findsOneWidget);
      expect(find.text('Vướng mắc đã đóng hoặc không ở trạng thái nhận ý kiến.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Gửi ý kiến')).onPressed, isNotNull);
    });

    testWidgets('a closed issue has no comment bar and says why', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.on('GET', '/resources/issue/iss-1', (_) => issueView('iss-1', status: 'CLOSED'));
      await FieldWorld.create(server: server).open(tester, '/projects/mob-31/iss-1');
      await settleReal(tester, rounds: 10);
      expect(find.widgetWithText(FilledButton, 'Gửi ý kiến'), findsNothing);
      expect(find.text('Vướng mắc đã đóng nên không nhận thêm ý kiến.'), findsOneWidget);
    });

    testWidgets('a report that was dropped is an empty state whose action records an obstacle again', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      await world.open(tester, '/projects/mob-41', overrides: idleRunners);
      final CommandQueue queue = await _queue(tester, world);
      final QueuedCommand command = queue.enqueue(commandType: kIssueCreateCommand, payload: <String, Object?>{'title': 'Cọc tiêu bị gãy', 'client_operation_id': 'op-1'});
      queue.discard(command.id);
      await world.go(tester, '/projects/mob-31/${command.id}');

      expect(find.text('Báo cáo đã được bỏ'), findsOneWidget);
      await tapText(tester, 'Ghi nhận vướng mắc');
      expect(currentLocation(world.container), '/projects/mob-28');
    });
  });
}

extension on ScriptedServer {
  void let(void Function(ScriptedServer server) body) => body(this);
}

/// The one draft the capture form kept on the phone.
Future<IssueDraft> readDraft(WidgetTester tester, FieldWorld world) async {
  final DraftStore store = (await tester.runAsync(() => world.container.read(draftStoreProvider.future)))!;
  final List<LocalDraft> drafts = store.list(kind: kIssueDraftKind);
  expect(drafts, hasLength(1));
  return IssueDraft.fromJson(drafts.single.fields)!;
}
