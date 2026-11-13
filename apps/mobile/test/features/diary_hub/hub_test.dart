import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/drafts/local_draft.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/command_support/command_outcome.dart';
import 'package:machvon_mobile/features/diary_hub/diary_hub_feature.dart' as hub;
import 'package:machvon_mobile/features/diary_hub/hub_commands.dart';
import 'package:machvon_mobile/features/diary_hub/hub_models.dart';
import 'package:machvon_mobile/features/diary_hub/hub_support.dart';
import 'package:machvon_mobile/features/site_diary/diary_models.dart';
import 'package:machvon_mobile/features/site_diary/diary_service.dart';
import 'package:machvon_mobile/features/site_diary/site_diary_feature.dart' as site_diary;

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../acceptance_handover/fixtures.dart' show problem, recorded;
import '../field_issues/field_world.dart';
import '../site_diary/diary_fixtures.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';

const String _hub = '/projects/qms-09';
const String _day = '2026-11-03';

FakeSession _contractor({SessionMode mode = SessionMode.full}) =>
    FakeSession(SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1', mode: mode));

Map<String, Object?> _copy(String id, {String summary = 'Bản của thiết bị B', int workforce = 9, String state = 'CONFLICT_PENDING'}) => <String, Object?>{
      'id': id,
      'diary_no': 'D-A-0003/$id',
      'state': state,
      'created_at': '2026-11-03T02:00:00Z',
      'author': <String, Object?>{'display_name': 'Trần Văn B'},
      'content': <String, Object?>{'summary': summary, 'workforce_count': workforce},
    };

/// A diary on the server as the settling and the lists show it: the reader may settle its copies and/or sign it.
Map<String, Object?> _serverDiary(
  String id, {
  List<Object?> copies = const <Object?>[],
  bool resolve = true,
  bool sign = true,
  String status = 'DRAFT',
  int version = 2,
  String date = _day,
}) =>
    <String, Object?>{
      ...diaryRow(id, status: status, version: version, conflicts: copies, sign: sign, date: date, signatures: status == 'DRAFT' ? const <Object?>[] : <Object?>[signatureRow()]),
      'actions': <String, Object?>{'revise': true, 'contractorSign': sign && status == 'DRAFT', 'correct': false, 'resolveConflict': resolve},
    };

/// The reads of the hub: the register by the filter the hub asks for, the diaries one by one and the contracts.
void _answerServer(ScriptedServer api, List<Map<String, Object?>> diaries) {
  api
    ..on('GET', '/resources/contract', (_) => page(<Object?>[contractRow('c-1', 'HD-A-001')]))
    ..on('GET', '/resources/site_diary', (HttpCall call) {
      final Map<String, String> query = call.url.queryParameters;
      return page(<Object?>[
        for (final Map<String, Object?> diary in diaries)
          if ((query['has_conflict'] != 'true' || (diary['conflicts']! as List<Object?>).isNotEmpty) && (query['status'] == null || diary['status'] == query['status'])) diary,
      ]);
    });
  for (final Map<String, Object?> diary in diaries) {
    api.on('GET', '/resources/site_diary/${diary['id']}', (_) => diary);
  }
}

Future<FieldWorld> _open(WidgetTester tester, {FieldServer? server, List<Map<String, Object?>> diaries = const <Map<String, Object?>>[], String location = _hub, FakeSession? session}) async {
  final FieldServer field = server ?? FieldServer();
  _answerServer(field.api, diaries);
  final FieldWorld world = FieldWorld.create(server: field);
  await world.open(tester, location, extra: <MobileFeature>[hub.feature, site_diary.feature], session: session ?? _contractor(), overrides: idleRunners);
  await settleReal(tester, rounds: 8);
  return world;
}

/// Writes a diary on the phone, as the person would, and (when [queue]) saves it for sending: the draft in the store and the command
/// of the diary under the key of the draft, which is what MOB-62 does when the person taps Save.
Future<String> _write(WidgetTester tester, FieldWorld world, {String contract = 'c-1', String date = _day, String summary = 'Đào móng trụ T3', bool queue = true}) async {
  final DiaryService service = world.container.read(diaryServiceProvider);
  final StoredDiaryDraft stored = (await tester.runAsync(() => service.draftFor(contract, date)))!;
  DiaryDraft draft = stored.draft.copyWith(form: DiaryForm(summary: summary));
  final String id = (await tester.runAsync(() => service.save(draft, draftId: stored.id)))!;
  if (queue) {
    final CommandQueue commands = await _queue(tester, world);
    final QueuedCommand command = commands.enqueue(commandType: kDiaryAppendCommand, payload: diaryPayload(draft), attempt: CommandAttempt(draft.operationId), draftId: id);
    draft = draft.copyWith(commandId: command.id);
    await tester.runAsync(() => service.save(draft, draftId: id));
  }
  return id;
}

Future<CommandQueue> _queue(WidgetTester tester, FieldWorld world) async => (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;

Future<void> _flush(WidgetTester tester, FieldWorld world) async {
  final CommandQueue queue = await _queue(tester, world);
  await tester.runAsync(queue.flush);
  await settleReal(tester, rounds: 6);
}

/// Lets the waits of the client (the pause before it asks again after a refusal) run out, so none is left pending when the test ends.
Future<void> _drain(WidgetTester tester) async {
  await tester.pumpAndSettle();
  await tester.pump(const Duration(seconds: 60));
}

Future<void> _tab(WidgetTester tester, String label) async {
  await tester.tap(find.text(label));
  await settleReal(tester, rounds: 8);
}

List<HttpCall> _settles(FieldWorld world, String id) => world.server.api.callsTo('POST', '/site-diaries/$id/resolve-conflict');

Finder _note() => find.widgetWithText(TextField, 'Lý do chọn cách này (bắt buộc)');
Finder _submit() => find.widgetWithText(FilledButton, 'Ghi cách giải quyết');

Future<void> _choose(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.byType(DropdownButtonFormField<Resolution>));
  await tester.tap(find.byType(DropdownButtonFormField<Resolution>));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

void main() {
  group('UI-QMS-09 FR-QMS-09 the diaries on the phone: what is written, what waits in the queue, what came back in conflict', () {
    testWidgets('shows each diary written on the phone with its day, its contract, what was written and where it stands; the ones that need the person first', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _write(tester, world, date: '2026-11-01', summary: 'Đổ bê tông lót móng T1', queue: false);
      world.server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.conflict(version: 3);
      await _write(tester, world, date: '2026-11-03', summary: 'Đào móng trụ T3');
      await _flush(tester, world);
      // Written after the last send: it waits in the queue.
      await _write(tester, world, date: '2026-11-02', summary: 'Lắp ván khuôn trụ T2');
      await world.go(tester, _hub);

      expect(find.text('Ngày 03/11/2026 · HD-A-001'), findsOneWidget);
      expect(find.text('Ngày 02/11/2026 · HD-A-001'), findsOneWidget);
      expect(find.text('Ngày 01/11/2026 · HD-A-001'), findsOneWidget);
      expect(find.text('Đào móng trụ T3'), findsOneWidget);
      expect(find.text('Xung đột đồng bộ'), findsOneWidget);
      expect(find.text('Chờ gửi'), findsOneWidget);
      expect(find.text('Bản nháp trên máy'), findsOneWidget);
      expect(tester.getTopLeft(find.text('Đào móng trụ T3')).dy, lessThan(tester.getTopLeft(find.text('Đổ bê tông lót móng T1')).dy), reason: 'the conflict first, the draft last');
      expect(find.text('Còn 2 nhật ký chưa gửi. Chưa đổi được tổ chức cho đến khi gửi xong hoặc bỏ.'), findsOneWidget, reason: 'the queue holds two: the one in conflict and the one that waits');
      expect(find.text('Đang có mạng.'), findsOneWidget);
    });

    testWidgets('a diary opens in MOB-62 on its contract and day, and one in conflict opens the choice of MOB-42', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      world.server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.conflict(version: 3);
      await _write(tester, world);
      await _flush(tester, world);
      final QueuedCommand command = (await _queue(tester, world)).commands().single;
      await world.go(tester, _hub);

      await tapText(tester, 'Mở nhật ký');
      expect(currentLocation(world.container), '/projects/mob-62/c-1?date=$_day');
      await world.go(tester, _hub);
      await tapText(tester, 'Chọn bản');
      expect(currentLocation(world.container), '/projects/mob-42/${command.id}');
    });

    testWidgets('a diary saved with no connection waits in the queue under its key and is not sent from here; the hub sends nothing', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      final FieldWorld world = await _open(tester, server: server);
      server.offline = true;
      await _write(tester, world);
      world.container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await world.go(tester, _hub);

      expect(find.text('Chờ gửi'), findsOneWidget);
      expect(find.text('Không có mạng: nhật ký được giữ trên máy và sẽ gửi khi có mạng.'), findsOneWidget);
      expect(server.sync.batchPosts, 0, reason: 'the hub never sends the queue by itself');
      final QueuedCommand command = (await _queue(tester, world)).commands().single;
      expect(command.commandType, kDiaryAppendCommand);
      expect(command.payload!['client_operation_id'], command.idempotencyKey, reason: 'the identity of the save is the key of the command');
    });

    testWidgets('a diary the server took is "sent" and no longer counts as unsent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _write(tester, world);
      await _flush(tester, world);
      await world.go(tester, _hub);
      expect(find.text('Đã gửi'), findsOneWidget);
      expect(find.text('Không có nhật ký nào chờ gửi.'), findsOneWidget);
    });

    testWidgets('a diary refused for good shows the code, and one whose answer was lost says the result is not known', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      world.server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.rejected('PERIOD_LOCKED');
      await _write(tester, world, date: '2026-11-02');
      await _flush(tester, world);
      world.server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.accepted();
      world.server.sync.dropNextBatchAnswer = true;
      await _write(tester, world, date: '2026-11-03');
      await _flush(tester, world);
      await world.go(tester, _hub);

      expect(find.text('Máy chủ từ chối'), findsOneWidget);
      expect(find.text('PERIOD_LOCKED'), findsOneWidget);
      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
    });

    testWidgets('speaks English', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _write(tester, world);
      await world.go(tester, _hub);
      await tester.pumpWidget(const SizedBox.shrink());
      final FieldWorld english = FieldWorld.create();
      _answerServer(english.server.api, <Map<String, Object?>>[]);
      await english.open(tester, _hub, extra: <MobileFeature>[hub.feature, site_diary.feature], session: _contractor(), overrides: idleRunners, locale: const Locale('en'));
      await settleReal(tester, rounds: 6);
      expect(find.text('Offline site diary'), findsOneWidget);
      expect(find.text('On this phone'), findsOneWidget);
    });

    Future<void> local(WidgetTester tester, ScriptedServer server) async {
      final FieldWorld world = FieldWorld.create(server: FieldServer(api: server));
      await world.open(tester, '/projects/mob-41', extra: <MobileFeature>[hub.feature, site_diary.feature], session: _contractor(), overrides: idleRunners);
      await settleReal(tester, rounds: 6);
      await _write(tester, world);
      await world.go(tester, _hub);
      await _drain(tester);
    }

    Future<void> onServer(WidgetTester tester, ScriptedServer server) async {
      final FieldWorld world = FieldWorld.create(server: FieldServer(api: server));
      await world.open(tester, _hub, extra: <MobileFeature>[hub.feature, site_diary.feature], session: _contractor(), overrides: idleRunners);
      await settleReal(tester, rounds: 6);
      await _tab(tester, 'Trên máy chủ');
      await _drain(tester);
    }

    Future<void> settling(WidgetTester tester, ScriptedServer server) async {
      final FieldWorld world = FieldWorld.create(server: FieldServer(api: server));
      await world.open(tester, '$_hub?diary=d-1', extra: <MobileFeature>[hub.feature, site_diary.feature], session: _contractor(), overrides: idleRunners);
      await settleReal(tester, rounds: 6);
      await _drain(tester);
    }

    void healthy(ScriptedServer server) => _answerServer(server, <Map<String, Object?>>[_serverDiary('d-1', copies: <Object?>[_copy('k-1')])]);

    testWidgets('every state of the server tab is drawn', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: onServer,
        script: StateScript(healthy: healthy, content: find.text('D-A-0003 · Ngày 03/11/2026'), empty: (ScriptedServer server) => _answerServer(server, <Map<String, Object?>>[])),
      );
    });

    testWidgets('every state of the settling is drawn', (WidgetTester tester) async {
      await expectEveryState(tester, open: settling, script: StateScript(healthy: healthy, content: find.text('Nhật ký của ngày')));
    });

    testWidgets('the server tab keeps the screen contract at the three sizes and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, open: onServer, healthy: healthy);
    });

    testWidgets('the settling keeps the screen contract at the three sizes and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, open: settling, healthy: healthy);
    });

    testWidgets('the phone tab keeps the screen contract at the three sizes and at 200 percent text', (WidgetTester tester) async {
      await expectScreenContract(tester, open: local, healthy: healthy);
      // A diary waits in the queue: the wait of the banner that counts it runs out once the screen is gone.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(minutes: 10));
    });
  });

  group('NAV-02 UI-QMS-09 UI-QMS-10 the two screens are reached from the contracts', () {
    testWidgets('the app bar of the contracts opens QMS-09 and QMS-10', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, location: '/projects/mob-61');
      await tester.tap(find.byTooltip('Nhật ký ngoại tuyến'));
      await settleReal(tester, rounds: 8);
      expect(currentLocation(world.container), _hub);
      expect(find.text('Trên máy'), findsOneWidget);
      await pressBack(tester);
      await tester.tap(find.byTooltip('Chụp ảnh hiện trường'));
      await settleReal(tester, rounds: 8);
      expect(currentLocation(world.container), '/projects/qms-10');
    });
  });

  group('UI-QMS-09 the phone tab when there is nothing, and when the store cannot be opened', () {
    testWidgets('no diary on the phone is the empty state; the way to write one is in the bar', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await tester.tap(find.byTooltip('Viết nhật ký mới'));
      await settleReal(tester, rounds: 6);
      expect(currentLocation(world.container), '/projects/mob-61');
    });

    testWidgets('a draft with nothing written is not a diary yet', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _write(tester, world, summary: '   ', queue: false);
      await world.go(tester, _hub);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
    });

    testWidgets('nobody signed in: the tab says the session ended and offers nothing of another person', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = FieldWorld.create();
      _answerServer(world.server.api, <Map<String, Object?>>[]);
      await world.open(tester, _hub, extra: <MobileFeature>[hub.feature, site_diary.feature], session: FakeSession(const SessionSnapshot(status: SessionStatus.signedOut)), overrides: idleRunners);
      await settleReal(tester, rounds: 6);
      expect(find.text('Chưa có dữ liệu'), findsNothing);
    });
  });

  group('UI-QMS-09 the diaries on the server that need the person', () {
    testWidgets('lists the diaries with copies nobody settled and the drafts that wait for the contractor, and nothing else', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, diaries: <Map<String, Object?>>[
        _serverDiary('d-1', copies: <Object?>[_copy('k-1')]),
        _serverDiary('d-2', sign: true, date: '2026-11-02'),
        _serverDiary('d-3', sign: false, date: '2026-11-01'),
        _serverDiary('d-4', status: 'CONTRACTOR_SIGNED', sign: false, date: '2026-10-31'),
        _serverDiary('d-5', copies: <Object?>[_copy('k-2', state: 'RESOLVED')], sign: false, date: '2026-10-30'),
      ]);
      await _tab(tester, 'Trên máy chủ');

      expect(find.text('Xung đột đồng bộ'), findsWidgets);
      expect(find.text('1 bản chờ giải quyết'), findsOneWidget);
      expect(find.text('Chờ nhà thầu ký'), findsOneWidget);
      expect(find.text('D-A-0003 · Ngày 03/11/2026'), findsOneWidget, reason: 'the diary with a copy waiting');
      expect(find.text('D-A-0003 · Ngày 02/11/2026'), findsOneWidget, reason: 'the draft to sign');
      expect(find.text('D-A-0003 · Ngày 01/11/2026'), findsNothing, reason: 'a draft the reader may not sign is not theirs to act on');
      expect(find.text('D-A-0003 · Ngày 31/10/2026'), findsNothing);
      expect(find.text('D-A-0003 · Ngày 30/10/2026'), findsNothing, reason: 'a copy that was settled is not waiting');
      expect(world.server.api.callsTo('GET', '/resources/site_diary').map((HttpCall call) => call.url.queryParameters['has_conflict'] ?? call.url.queryParameters['status']).toSet(), <String>{'true', 'DRAFT'});

      await tapText(tester, 'Mở để ký');
      expect(currentLocation(world.container), '/projects/mob-62/c-1?date=2026-11-02');
      expect(world.server.api.calls.where((HttpCall call) => call.method != 'GET'), isEmpty, reason: 'opening a diary signs nothing');
    });

    testWidgets('the diary with a copy opens the settling', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, diaries: <Map<String, Object?>>[_serverDiary('d-1', copies: <Object?>[_copy('k-1')])]);
      await _tab(tester, 'Trên máy chủ');
      await tapText(tester, 'Giải quyết xung đột');
      expect(currentLocation(world.container), '$_hub?diary=d-1');
      expect(find.text('Nhật ký của ngày'), findsOneWidget);
    });

    testWidgets('says when the server has more diaries than the pages read', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      int pages = 0;
      server.api.on('GET', '/resources/contract', (_) => page(<Object?>[]));
      server.api.on('GET', '/resources/site_diary', (_) {
        pages += 1;
        return <String, Object?>{'items': <Object?>[_serverDiary('d-$pages', copies: <Object?>[_copy('k')])], 'next_cursor': 'c$pages', 'as_of': '2026-11-03T02:00:00Z'};
      });
      final FieldWorld world = FieldWorld.create(server: server);
      await world.open(tester, _hub, extra: <MobileFeature>[hub.feature, site_diary.feature], session: _contractor(), overrides: idleRunners);
      await settleReal(tester, rounds: 6);
      await _tab(tester, 'Trên máy chủ');
      expect(find.text('Còn nhật ký khác chưa hiển thị trên điện thoại. Hãy xem đầy đủ trên máy tính.'), findsOneWidget);
    });
  });

  group('AC-ST-QMS-002-1 UAT-AC62 the copy a device left is settled by a person: nothing is overwritten, the choice is recorded', () {
    List<Map<String, Object?>> one({List<Object?>? copies, bool resolve = true, String status = 'DRAFT'}) =>
        <Map<String, Object?>>[_serverDiary('d-1', copies: copies ?? <Object?>[_copy('k-1')], resolve: resolve, status: status, version: 5)];

    testWidgets('both versions are shown side by side and nothing is sent until the person chooses', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, diaries: one(), location: '$_hub?diary=d-1');
      expect(find.text('Công việc: Đào móng trụ T3'), findsOneWidget);
      expect(find.text('Công việc: Bản của thiết bị B'), findsOneWidget);
      expect(find.text('Nhân lực: 12'), findsOneWidget);
      expect(find.text('Nhân lực: 9'), findsOneWidget);
      expect(find.text('D-A-0003/k-1 · Trần Văn B · 03/11/2026 09:00'), findsWidgets);
      expect(world.server.api.calls.where((HttpCall call) => call.method != 'GET'), isEmpty);
    });

    testWidgets('keeping the diary of the day: one request under the version on the screen, a key, the copy, the choice and the reason; the diary is read again', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.answer('POST', '/site-diaries/d-1/resolve-conflict', (_) => recorded('d-1', status: 'DRAFT', version: 6));
      final FieldWorld world = await _open(tester, server: server, diaries: one(), location: '$_hub?diary=d-1');
      // From now on the server holds the diary with the copy settled.
      server.api.on('GET', '/resources/site_diary/d-1', (_) => _serverDiary('d-1', copies: <Object?>[_copy('k-1', state: 'RESOLVED')], version: 6));

      await _choose(tester, 'Giữ nhật ký của ngày, bỏ bản của thiết bị');
      await tester.enterText(_note(), '  Bản của tôi đầy đủ hơn  ');
      await tester.ensureVisible(_submit());
      await tester.tap(_submit());
      await settleReal(tester, rounds: 6);

      final List<HttpCall> calls = _settles(world, 'd-1');
      expect(calls, hasLength(1));
      expect(calls.single.headers['idempotency-key'], isNotEmpty);
      expect(calls.single.headers['if-match'], '"5"');
      expect(calls.single.body, contains('"conflict_diary_id":"k-1"'));
      expect(calls.single.body, contains('"resolution":"KEEP_PRIMARY"'));
      expect(calls.single.body, contains('"note":"Bản của tôi đầy đủ hơn"'));
      expect(calls.single.body, isNot(contains('merged_content')), reason: 'a merge is made on the web');
      expect(find.text('Đã ghi nhận'), findsOneWidget);
      expect(world.server.api.callsTo('GET', '/resources/site_diary/d-1'), hasLength(2), reason: 'the diary is read again from the server');
      expect(find.text('Nhật ký này không còn bản nào chờ giải quyết.'), findsOneWidget);
    });

    testWidgets('adopting the copy of the device over a draft is its own choice', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.answer('POST', '/site-diaries/d-1/resolve-conflict', (_) => recorded('d-1', status: 'DRAFT', version: 6));
      final FieldWorld world = await _open(tester, server: server, diaries: one(), location: '$_hub?diary=d-1');
      await _choose(tester, 'Dùng bản của thiết bị thay cho nhật ký của ngày');
      await tester.enterText(_note(), 'Bản của thiết bị B đúng hơn');
      await tester.ensureVisible(_submit());
      await tester.tap(_submit());
      await settleReal(tester, rounds: 6);
      expect(_settles(world, 'd-1').single.body, contains('"resolution":"ADOPT_CONFLICT"'));
    });

    testWidgets('a signed diary can only be kept as it is: the other choice is not offered', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, diaries: one(status: 'CONTRACTOR_SIGNED'), location: '$_hub?diary=d-1');
      expect(find.text('Nhật ký đã ký nên chỉ có thể giữ nguyên.'), findsOneWidget);
      await tester.ensureVisible(find.byType(DropdownButtonFormField<Resolution>));
      await tester.tap(find.byType(DropdownButtonFormField<Resolution>));
      await tester.pumpAndSettle();
      expect(find.text('Dùng bản của thiết bị thay cho nhật ký của ngày'), findsNothing);
      expect(find.text('Giữ nhật ký của ngày, bỏ bản của thiết bị'), findsWidgets);
    });

    testWidgets('with two copies waiting the person says which one; the choice, the copy and the reason are required before anything is sent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, diaries: one(copies: <Object?>[_copy('k-1'), _copy('k-2', summary: 'Bản của thiết bị C')]), location: '$_hub?diary=d-1');
      await tester.ensureVisible(_submit());
      await tester.tap(_submit());
      await tester.pumpAndSettle();
      expect(find.text('Hãy chọn bản của thiết bị cần giải quyết.'), findsOneWidget);
      expect(find.text('Hãy chọn cách giải quyết.'), findsOneWidget);
      expect(find.text('Hãy nhập lý do.'), findsOneWidget);
      expect(world.server.api.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);

      await tester.enterText(_note(), 'x' * 2001);
      await tester.tap(_submit());
      await tester.pumpAndSettle();
      expect(find.text('Lý do tối đa 2000 ký tự.'), findsOneWidget);
    });

    testWidgets('a lost answer is "result unknown": sending the same decision again reuses the key and the version, so it is recorded once', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      int attempt = 0;
      server.api.answer('POST', '/site-diaries/d-1/resolve-conflict', (_) {
        attempt += 1;
        if (attempt == 1) throw const SocketException('lost');
        return recorded('d-1', status: 'DRAFT', version: 6);
      });
      final FieldWorld world = await _open(tester, server: server, diaries: one(), location: '$_hub?diary=d-1');
      await _choose(tester, 'Giữ nhật ký của ngày, bỏ bản của thiết bị');
      await tester.enterText(_note(), 'Bản của tôi đầy đủ hơn');
      await tester.ensureVisible(_submit());
      await tester.tap(_submit());
      await settleReal(tester, rounds: 6);

      expect(find.text('Chưa xác định kết quả'), findsOneWidget);
      await tapText(tester, 'Gửi lại cùng thao tác');
      final List<HttpCall> calls = _settles(world, 'd-1');
      expect(calls, hasLength(2));
      expect(calls[1].headers['idempotency-key'], calls[0].headers['idempotency-key']);
      expect(calls[1].headers['if-match'], calls[0].headers['if-match']);
      expect(find.text('Đã ghi nhận'), findsOneWidget);
    });

    testWidgets('a refusal keeps what was written, says why with the stable code, and reads the diary again', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldServer server = FieldServer();
      server.api.answer('POST', '/site-diaries/d-1/resolve-conflict', (_) => problem(409, 'VERSION_CONFLICT'));
      final FieldWorld world = await _open(tester, server: server, diaries: one(), location: '$_hub?diary=d-1');
      await _choose(tester, 'Giữ nhật ký của ngày, bỏ bản của thiết bị');
      await tester.enterText(_note(), 'Bản của tôi đầy đủ hơn');
      await tester.ensureVisible(_submit());
      await tester.tap(_submit());
      await settleReal(tester, rounds: 6);

      expect(find.text('Nhật ký đã thay đổi. Hãy mở lại nhật ký rồi làm lại.'), findsOneWidget);
      expect(find.text('VERSION_CONFLICT'), findsOneWidget);
      expect(tester.widget<TextField>(_note()).controller!.text, 'Bản của tôi đầy đủ hơn');
      expect(world.server.api.callsTo('GET', '/resources/site_diary/d-1'), hasLength(2));
    });

    testWidgets('each refusal of the server has its own sentence', (WidgetTester tester) async {
      const Map<String, String> sentences = <String, String>{
        'DIARY_STATE_INVALID': 'Nhật ký không còn ở trạng thái cho phép thao tác này.',
        'MFA_REQUIRED': 'Cần xác thực lại hai yếu tố. Thao tác chưa được ghi nhận; hãy xác thực rồi thử lại.',
        'LICENSE_EXPIRED': 'License đã hết hạn nên chưa thể giải quyết xung đột.',
        'PERMISSION_DENIED': 'Bạn không có quyền thực hiện thao tác này.',
        'INTERNAL_ERROR': 'Chưa thực hiện được. Hãy thử lại sau ít phút.',
      };
      for (final MapEntry<String, String> entry in sentences.entries) {
        useDevice(tester, kTall);
        final FieldServer server = FieldServer();
        server.api.answer('POST', '/site-diaries/d-1/resolve-conflict', (_) => problem(entry.key == 'INTERNAL_ERROR' ? 500 : (entry.key == 'PERMISSION_DENIED' ? 403 : 422), entry.key));
        await _open(tester, server: server, diaries: one(), location: '$_hub?diary=d-1');
        await _choose(tester, 'Giữ nhật ký của ngày, bỏ bản của thiết bị');
        await tester.enterText(_note(), 'Bản của tôi đầy đủ hơn');
        await tester.ensureVisible(_submit());
        await tester.tap(_submit());
        await settleReal(tester, rounds: 6);
        expect(find.text(entry.value), findsOneWidget, reason: entry.key);
        expect(find.text(entry.key), findsOneWidget);
        await tester.pumpWidget(const SizedBox.shrink());
      }
    });

    testWidgets('offline, in a read-only organisation, with no copy waiting, or without the right: the settling is off with the reason beside it, and nothing is sent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      FieldWorld world = await _open(tester, diaries: one(), location: '$_hub?diary=d-1');
      world.container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.text('Cần kết nối mạng để giải quyết xung đột. Việc này không bao giờ được xếp hàng đợi hay gửi từ bản lưu trên máy.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_submit()).onPressed, isNull);
      expect(world.server.api.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
      expect((await _queue(tester, world)).unsentCount, 0, reason: 'nothing was queued');
      await tester.pumpWidget(const SizedBox.shrink());

      world = await _open(tester, diaries: one(), location: '$_hub?diary=d-1', session: _contractor(mode: SessionMode.readOnly));
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa thể giải quyết xung đột.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_submit()).onPressed, isNull);
      await tester.pumpWidget(const SizedBox.shrink());

      world = await _open(tester, diaries: one(copies: <Object?>[_copy('k-1', state: 'RESOLVED')]), location: '$_hub?diary=d-1');
      expect(find.text('Nhật ký này không còn bản nào chờ giải quyết.'), findsOneWidget);
      expect(_submit(), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());

      world = await _open(tester, diaries: one(resolve: false), location: '$_hub?diary=d-1');
      expect(find.text('Bạn không có quyền giải quyết xung đột của nhật ký này.'), findsOneWidget);
      expect(tester.widget<FilledButton>(_submit()).onPressed, isNull);
    });

    testWidgets('a command whose send finds the phone offline sends nothing and queues nothing', (WidgetTester tester) async {
      final ScriptedServer server = ScriptedServer();
      final MachvonApiClient client = MachvonApiClient(baseUrl: Uri.parse('https://api.test/v1'), transport: server, token: () async => 't');
      final ResolveCommands commands = ResolveCommands(client: client, isOnline: () => false);
      expect(await commands.resolve(diaryId: 'd-1', version: 5, copyId: 'k-1', resolution: Resolution.keepPrimary, note: 'Bản của tôi đầy đủ hơn'), isA<CommandOffline>());
      expect(server.calls, isEmpty);
    });

    test('the settling is checked before anything is sent: the copy, the choice and the reason; a signed diary can only be kept', () {
      Map<String, ResolveProblem> check({String? copy = 'k-1', Resolution? resolution = Resolution.keepPrimary, String note = 'Lý do', bool draft = true}) =>
          checkResolution(copyId: copy, copies: <String>['k-1'], resolution: resolution, note: note, draft: draft);
      expect(check(), isEmpty);
      expect(check(copy: null)['copy'], ResolveProblem.noCopy);
      expect(check(copy: 'k-9')['copy'], ResolveProblem.noCopy, reason: 'a copy that is not waiting');
      expect(check(resolution: null)['resolution'], ResolveProblem.noResolution);
      expect(check(resolution: Resolution.adoptCopy), isEmpty);
      expect(check(resolution: Resolution.adoptCopy, draft: false)['resolution'], ResolveProblem.adoptSigned);
      expect(check(resolution: Resolution.keepPrimary, draft: false), isEmpty);
      expect(check(note: '  ')['note'], ResolveProblem.noteRequired);
      expect(check(note: 'x' * 2000), isEmpty);
      expect(check(note: 'x' * 2001)['note'], ResolveProblem.noteTooLong);
    });

    test('the refusals of the server map to the sentences of the web', () {
      HubProblem of(String code) => problemOf(CommandRefused(code, status: 422));
      expect(of('DIARY_STATE_INVALID'), HubProblem.diaryState);
      expect(of('VERSION_CONFLICT'), HubProblem.versionConflict);
      expect(of('MFA_REQUIRED'), HubProblem.stepUp);
      expect(of('LICENSE_EXPIRED'), HubProblem.licenseExpired);
      expect(of('VALIDATION_FAILED'), HubProblem.validation);
      expect(of('INVALID_REQUEST'), HubProblem.validation);
      expect(of('FIELD_NOT_ALLOWED'), HubProblem.validation);
      expect(of('RESOURCE_NOT_FOUND'), HubProblem.notFound);
      expect(of('SCOPE_DENIED'), HubProblem.denied);
      expect(of('PERMISSION_DENIED'), HubProblem.denied);
      expect(of('ENTITLEMENT_DENIED'), HubProblem.denied);
      expect(of('SESSION_EXPIRED'), HubProblem.sessionEnded);
      expect(of('SOMETHING_ELSE'), HubProblem.general);
      expect(isRetryable(HubProblem.general), isTrue);
      expect(isRetryable(HubProblem.diaryState), isFalse);
    });

    test('the gate puts offline and a copy before the read-only mode, then the copies, then the right', () {
      final ServerDiary waiting = parseServerDiary(_serverDiary('d-1', copies: <Object?>[_copy('k-1')]))!;
      final ServerDiary none = parseServerDiary(_serverDiary('d-1'))!;
      final ServerDiary denied = parseServerDiary(_serverDiary('d-1', copies: <Object?>[_copy('k-1')], resolve: false))!;
      const SessionSnapshot full = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u');
      const SessionSnapshot readOnly = SessionSnapshot(status: SessionStatus.signedIn, tenantId: 't', userId: 'u', mode: SessionMode.readOnly);
      ResolveGate gate(ServerDiary d, {bool offline = false, bool copy = false, SessionSnapshot session = full}) => gateOf(diary: d, offline: offline, fromCopy: copy, session: session);
      expect(gate(waiting), ResolveGate.open);
      expect(gate(none, offline: true), ResolveGate.offline);
      expect(gate(waiting, copy: true), ResolveGate.offline);
      expect(gate(waiting, session: readOnly), ResolveGate.readOnly);
      expect(gate(waiting, offline: true, session: readOnly), ResolveGate.offline, reason: 'offline wins over a read-only organisation');
      expect(gate(waiting, copy: true, session: readOnly), ResolveGate.offline);
      expect(gate(none), ResolveGate.noCopy);
      expect(gate(denied), ResolveGate.noAction);
    });
  });

  group('UI-QMS-09 the diaries of the phone are read from the draft and the queue', () {
    test('a draft is read with the command that sends it, a command whose draft is gone from its payload, and an empty draft is left out', () {
      const DiaryDraft written = DiaryDraft(contractId: 'c-1', recordDate: '2026-11-02', operationId: 'op-1', form: DiaryForm(summary: '  Lắp ván khuôn\n trụ T2  '), commandId: 'cmd-1');
      const DiaryDraft empty = DiaryDraft(contractId: 'c-1', recordDate: '2026-11-01', operationId: 'op-2');
      final DiaryDraft long = DiaryDraft(contractId: 'c-2', recordDate: '2026-10-31', operationId: 'op-3', form: DiaryForm(summary: 'x' * 200));
      QueuedCommand command(String id, CommandState state, {Map<String, Object?>? payload, String type = kDiaryAppendCommand, String? error}) => QueuedCommand(
            id: id,
            tenantId: 't',
            userId: 'u',
            commandType: type,
            payload: payload,
            payloadBytes: 0,
            baseServerVersion: 0,
            idempotencyKey: 'key-$id',
            state: state,
            createdAt: 0,
            updatedAt: 0,
            errorCode: error,
          );
      final List<LocalDiary> found = localDiaries(
        <LocalDraft>[
          for (final (String id, DiaryDraft draft) in <(String, DiaryDraft)>[('d1', written), ('d2', empty), ('d3', long)])
            LocalDraft(id: id, tenantId: 't', userId: 'u', kind: kDiaryDraftKind, fields: draft.toJson(), baseServerVersion: 0, status: DraftStatus.editing, createdAt: 0, updatedAt: 0),
          const LocalDraft(id: 'other', tenantId: 't', userId: 'u', kind: 'issue', fields: <String, Object?>{'x': 1}, baseServerVersion: 0, status: DraftStatus.editing, createdAt: 0, updatedAt: 0),
          const LocalDraft(id: 'broken', tenantId: 't', userId: 'u', kind: kDiaryDraftKind, fields: <String, Object?>{'x': 1}, baseServerVersion: 0, status: DraftStatus.editing, createdAt: 0, updatedAt: 0),
        ],
        <QueuedCommand>[
          command('cmd-1', CommandState.rejected, error: 'PERIOD_LOCKED'),
          command('cmd-2', CommandState.queued, payload: <String, Object?>{'contract_id': 'c-9', 'record_date': '2026-10-20', 'content': <String, Object?>{'summary': 'Bản gửi mà bản nháp đã mất'}}),
          command('cmd-3', CommandState.accepted, payload: <String, Object?>{'contract_id': 'c-9', 'record_date': '2026-10-19'}),
          command('cmd-4', CommandState.discarded),
          command('cmd-5', CommandState.queued, type: 'report.submit'),
          command('cmd-6', CommandState.queued, payload: <String, Object?>{'diary_id': 'd-1', 'content': <String, Object?>{}}),
        ],
      );

      expect(found.map((LocalDiary diary) => diary.key), <String>['d1', 'cmd-2', 'cmd-6', 'd3'], reason: 'rejected, queued, queued (no date), draft; nothing for the empty draft, the accepted, the discarded or the other kinds');
      expect(found.first.state, LocalState.rejected);
      expect(found.first.errorCode, 'PERIOD_LOCKED');
      expect(found.first.summary, 'Lắp ván khuôn trụ T2', reason: 'the words of the day on one line');
      expect(found[1].contractId, 'c-9');
      expect(found[1].summary, 'Bản gửi mà bản nháp đã mất');
      expect(found[2].recordDate, isNull, reason: 'a revision names the diary, not the day');
      expect(found.last.summary.runes.length, kSummaryPreview + 1);
      expect(found.last.summary, endsWith('…'));
      expect(unsentOf(found), 3, reason: 'a draft not yet saved for sending is not in the queue');
    });

    test('an answer without both lists is refused as a whole; a diary without what the screen needs is left out', () {
      expect(parseHubServer(<String, Object?>{'conflicts': <String, Object?>{'items': <Object?>[]}}), isNull);
      expect(parseHubServer(<String, Object?>{'conflicts': <String, Object?>{'items': <Object?>[]}, 'drafts': <String, Object?>{'items': <Object?>[]}})!.isEmpty, isTrue);
      expect(parseServerDiary(<String, Object?>{'id': 'x'}), isNull);
      final HubServer server = parseHubServer(<String, Object?>{
        'conflicts': <String, Object?>{'items': <Object?>[_serverDiary('d-1', copies: <Object?>[_copy('k-1')]), 'nothing']},
        'drafts': <String, Object?>{'items': <Object?>[_serverDiary('d-1', copies: <Object?>[_copy('k-1')]), _serverDiary('d-2', copies: <Object?>[_copy('k-2')], date: '2026-11-02'), _serverDiary('d-3', date: '2026-11-01')]},
        'more': true,
      })!;
      expect(server.conflicts.map((ServerDiary d) => d.record.id), <String>['d-1', 'd-2'], reason: 'a draft with a copy waiting is listed with the conflicts, once');
      expect(server.toSign.map((ServerDiary d) => d.record.id), <String>['d-3']);
      expect(server.more, isTrue);
    });
  });
}
