import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/diary_hub/diary_hub_feature.dart' as hub;
import 'package:machvon_mobile/features/site_diary/diary_models.dart';
import 'package:machvon_mobile/features/site_diary/diary_service.dart';
import 'package:machvon_mobile/features/site_diary/site_diary_feature.dart' as site_diary;

import '../../support/fake_sync_server.dart';
import '../../support/harness.dart';
import '../field_issues/field_world.dart';
import '../site_diary/diary_fixtures.dart';

const String _hub = '/projects/qms-09';

FakeSession _contractor() => FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1'));

Map<String, Object?> _copy(String id) => <String, Object?>{
      'id': id,
      'diary_no': 'D-A-0003/$id',
      'state': 'CONFLICT_PENDING',
      'created_at': '2026-11-03T02:00:00Z',
      'author': <String, Object?>{'display_name': 'Trần Văn B'},
      'content': <String, Object?>{'summary': 'Bản của thiết bị B', 'workforce_count': 9},
    };

Map<String, Object?> _serverDiary(String id, {List<Object?> copies = const <Object?>[]}) => <String, Object?>{
      ...diaryRow(id, conflicts: copies, sign: true),
      'actions': <String, Object?>{'revise': true, 'contractorSign': true, 'correct': false, 'resolveConflict': true},
    };

Future<FieldWorld> _open(WidgetTester tester, {List<Map<String, Object?>> diaries = const <Map<String, Object?>>[], String location = _hub}) async {
  final FieldServer field = FieldServer();
  field.api
    ..on('GET', '/resources/contract', (_) => page(<Object?>[contractRow('c-1', 'HD-A-001')]))
    ..on('GET', '/resources/site_diary', (HttpCall call) {
      final Map<String, String> query = call.url.queryParameters;
      return page(<Object?>[
        for (final Map<String, Object?> diary in diaries)
          if ((query['has_conflict'] != 'true' || (diary['conflicts']! as List<Object?>).isNotEmpty) && (query['status'] == null || diary['status'] == query['status'])) diary,
      ]);
    });
  for (final Map<String, Object?> diary in diaries) {
    field.api.on('GET', '/resources/site_diary/${diary['id']}', (_) => diary);
  }
  final FieldWorld world = FieldWorld.create(server: field);
  await world.open(tester, location, extra: <MobileFeature>[hub.feature, site_diary.feature], session: _contractor(), overrides: idleRunners);
  await settleReal(tester, rounds: 8);
  return world;
}

Future<void> _write(WidgetTester tester, FieldWorld world, {String date = '2026-11-03', String summary = 'Đào móng trụ T3', bool queue = true}) async {
  final DiaryService service = world.container.read(diaryServiceProvider);
  final StoredDiaryDraft stored = (await tester.runAsync(() => service.draftFor('c-1', date)))!;
  DiaryDraft draft = stored.draft.copyWith(form: DiaryForm(summary: summary));
  final String id = (await tester.runAsync(() => service.save(draft, draftId: stored.id)))!;
  if (queue) {
    final CommandQueue commands = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
    final QueuedCommand command = commands.enqueue(commandType: kDiaryAppendCommand, payload: diaryPayload(draft), attempt: CommandAttempt(draft.operationId), draftId: id);
    draft = draft.copyWith(commandId: command.id);
    await tester.runAsync(() => service.save(draft, draftId: id));
  }
}

void main() {
  group('MUX-3C UI-QMS-09 the hub is two underline tabs of rows, with the state of the phone in one strip', () {
    testWidgets('no diary on the phone: the empty state offers to write one', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.textContaining('Chưa có nhật ký nào viết trên máy này'), findsOneWidget);
      await tapText(tester, 'Viết nhật ký');
      expect(currentLocation(world.container), '/projects/mob-61');
    });

    testWidgets('the diaries are grouped by what the person has to do, each a row with its state', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      world.server.sync.decide = (Map<String, Object?> item) => const ServerOutcome.conflict(version: 3);
      await _write(tester, world, date: '2026-11-03');
      final CommandQueue queue = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
      await tester.runAsync(queue.flush);
      await _write(tester, world, date: '2026-11-01', summary: 'Đổ bê tông lót móng T1', queue: false);
      await world.go(tester, _hub);

      expect(find.text('Cần bạn xử lý'), findsOneWidget);
      expect(find.text('Đang chờ trên máy'), findsOneWidget);
      expect(tester.getTopLeft(find.text('Cần bạn xử lý')).dy, lessThan(tester.getTopLeft(find.text('Đang chờ trên máy')).dy));
      expect(find.text('Chọn bản'), findsOneWidget);
      expect(find.text('Còn 1 nhật ký chưa gửi. Chưa đổi được tổ chức cho đến khi gửi xong hoặc bỏ.'), findsOneWidget);
    });

    testWidgets('offline the strip says so and the way to the queue is a 48 high action', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await _write(tester, world);
      world.server.offline = true;
      world.container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await world.go(tester, _hub);

      expect(find.text('Không có mạng: nhật ký được giữ trên máy và sẽ gửi khi có mạng.'), findsOneWidget);
      expect(tester.getSize(find.ancestor(of: find.text('Mở hàng đợi'), matching: find.byType(InkWell)).first).height, greaterThanOrEqualTo(48));
      await tapText(tester, 'Mở hàng đợi');
      expect(currentLocation(world.container), '/projects/mob-41');
    });

    testWidgets('nothing waits on the server: the tab says so and offers to write a diary', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      await tapText(tester, 'Trên máy chủ');
      expect(find.textContaining('Không có nhật ký nào trên máy chủ đang chờ bạn'), findsOneWidget);
      await tapText(tester, 'Viết nhật ký');
      expect(currentLocation(world.container), '/projects/mob-61');
    });
  });

  group('MUX-3C R39 the conflict of a diary is settled on the server with a sticky bar that is locked, and says why, offline', () {
    testWidgets('the settling screen has its action in the bar; offline the bar is locked with the reason and nothing is sent', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, diaries: <Map<String, Object?>>[_serverDiary('d-1', copies: <Object?>[_copy('k-1')])], location: '$_hub?diary=d-1');
      expect(find.widgetWithText(FilledButton, 'Ghi cách giải quyết'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Ghi cách giải quyết')).onPressed, isNotNull);

      world.container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Ghi cách giải quyết')).onPressed, isNull);
      expect(find.textContaining('Cần kết nối mạng để giải quyết xung đột'), findsOneWidget);
      expect(world.server.api.calls.where((HttpCall call) => call.method == 'POST'), isEmpty);
    });
  });
}
