import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/core/offline/queue/command_queue.dart';
import 'package:machvon_mobile/core/offline/queue/queued_command.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/attachments/attachments_feature.dart' as attachments;
import 'package:machvon_mobile/features/diary_hub/diary_hub_feature.dart' as hub;
import 'package:machvon_mobile/features/site_diary/diary_models.dart';
import 'package:machvon_mobile/features/site_diary/diary_service.dart';
import 'package:machvon_mobile/features/site_diary/site_diary_feature.dart' as site_diary;
import 'package:machvon_mobile/features/site_photo/site_photo_feature.dart' as photo;

import '../features/field_issues/field_world.dart';
import '../features/site_diary/diary_fixtures.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of the field screens of MUX-3 wave C, on the real screens with their real data: the contracts (MOB-61), the diary form
/// (MOB-62), the diary hub, local tab (QMS-09) and the site photograph form (QMS-10), each in the light mode, in the dark mode, at 200
/// percent text, in its empty state and offline. They are new, so no earlier image changes with them; a later change to a screen changes
/// its images knowingly (the diff is reviewed, never refreshed to pass).
const Size _phone = Size(390, 844);
const String _day = '2026-11-03';

enum _Screen { contracts, diary, hub, photo }

FakeSession _contractor() => FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1'));

String _location(_Screen screen) {
  switch (screen) {
    case _Screen.contracts:
      return '/projects/mob-61';
    case _Screen.diary:
      return '/projects/mob-62/c-1?date=$_day';
    case _Screen.hub:
      return '/projects/qms-09';
    case _Screen.photo:
      return '/projects/qms-10?contract=c-1';
  }
}

/// Opens [screen] on a phone that knows one contract (none when [empty] is set; a hub without a diary on the phone), in the given look.
Future<FieldWorld> _open(
  WidgetTester tester,
  _Screen screen, {
  Brightness brightness = Brightness.light,
  double scale = 1.0,
  bool empty = false,
  bool offline = false,
}) async {
  useDevice(tester, _phone, textScale: scale);
  final FieldServer server = FieldServer();
  server.api
    ..on('GET', '/resources/contract', (_) => page(empty ? <Object?>[] : <Object?>[contractRow('c-1', 'HD-A-001')]))
    ..on('GET', '/resources/contract/c-1', (_) => contractRow('c-1', 'HD-A-001'))
    ..on('GET', '/resources/site_diary', (_) => page(<Object?>[]))
    ..on('GET', '/resources/site_photo', (_) => page(<Object?>[]));
  final FieldWorld world = FieldWorld.create(server: server);
  await world.open(
    tester,
    _location(screen),
    extra: <MobileFeature>[site_diary.feature, hub.feature, photo.feature, attachments.feature],
    session: _contractor(),
    overrides: idleRunners,
  );
  await settleReal(tester, rounds: 8);
  if (screen == _Screen.hub && !empty) await _seedHub(tester, world);
  // A diary with nothing written: the form says what is missing under its field.
  if (screen == _Screen.diary && empty) await tapText(tester, 'Lưu nhật ký');
  if (brightness == Brightness.dark) {
    await tester.runAsync(() => world.container.read(themeModeProvider.notifier).select(ThemeMode.dark));
  }
  if (offline) world.container.read(reachabilityProvider.notifier).report(Reachability.offline);
  await settleReal(tester, rounds: 8);
  return world;
}

/// Two diaries written on the phone: one waiting in the queue and one still a draft, as the hub lists them.
Future<void> _seedHub(WidgetTester tester, FieldWorld world) async {
  final DiaryService service = world.container.read(diaryServiceProvider);
  final CommandQueue queue = (await tester.runAsync(() => world.container.read(commandQueueProvider.future)))!;
  for (final (String date, String summary, bool queued) in <(String, String, bool)>[
    ('2026-11-03', 'Đào móng trụ T3 và đổ bê tông lót', true),
    ('2026-11-02', 'Lắp ván khuôn trụ T2', false),
  ]) {
    final StoredDiaryDraft stored = (await tester.runAsync(() => service.draftFor('c-1', date)))!;
    DiaryDraft draft = stored.draft.copyWith(form: DiaryForm(summary: summary));
    final String id = (await tester.runAsync(() => service.save(draft, draftId: stored.id)))!;
    if (queued) {
      final QueuedCommand command = queue.enqueue(commandType: kDiaryAppendCommand, payload: diaryPayload(draft), attempt: CommandAttempt(draft.operationId), draftId: id);
      draft = draft.copyWith(commandId: command.id);
      await tester.runAsync(() => service.save(draft, draftId: id));
    }
  }
  await world.go(tester, '/projects/qms-09');
}

Future<void> _snap(WidgetTester tester, String name) async {
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/site_diary_$name.png'));
  // The screen is closed so no wait of the queue or of the uploads outlives the test.
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(minutes: 10));
}

void main() {
  useTolerantGoldens('test/golden/site_diary_golden_test.dart', tolerance: kTextGoldenTolerance);

  const Map<_Screen, String> names = <_Screen, String>{_Screen.contracts: 'contracts', _Screen.diary: 'diary', _Screen.hub: 'hub_local', _Screen.photo: 'photo'};

  group('MUX-3C golden images of the field screens', () {
    for (final MapEntry<_Screen, String> entry in names.entries) {
      final _Screen screen = entry.key;
      final String name = entry.value;

      testWidgets('$name in the light mode', (WidgetTester tester) async {
        await _open(tester, screen);
        await _snap(tester, '${name}_light');
      });

      testWidgets('$name in the dark mode', (WidgetTester tester) async {
        await _open(tester, screen, brightness: Brightness.dark);
        await _snap(tester, '${name}_dark');
      });

      testWidgets('$name at 200 percent text', (WidgetTester tester) async {
        await _open(tester, screen, scale: 2.0);
        await _snap(tester, '${name}_text200');
      });

      testWidgets('$name empty', (WidgetTester tester) async {
        await _open(tester, screen, empty: true);
        await _snap(tester, '${name}_empty');
      });

      testWidgets('$name offline', (WidgetTester tester) async {
        await _open(tester, screen, offline: true);
        await _snap(tester, '${name}_offline');
      });
    }
  });
}
