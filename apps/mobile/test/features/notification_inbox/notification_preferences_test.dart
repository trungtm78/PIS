import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/notification_inbox/notification_inbox_feature.dart' as notifications;
import 'package:machvon_mobile/features/notification_inbox/preference_models.dart';
import 'package:machvon_mobile/features/notification_inbox/push_registration.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'notification_fixtures.dart';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, {FakeSession? session, FakePush? push}) => pumpWithServer(
      tester,
      features: <MobileFeature>[notifications.feature],
      server: server,
      location: '/inbox/mob-34',
      session: session,
      overrides: <Override>[if (push != null) pushPlatformProvider.overrideWithValue(push)],
    );

/// The test opens the app twice; taking the tree down and letting the providers dispose leaves no timer of theirs pending when the test ends.
Future<void> _closeApp(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(milliseconds: 1));
  await tester.pump(const Duration(milliseconds: 1));
}

void _healthy(ScriptedServer server) => server.on(
      'GET',
      '/me/notification-preferences',
      (_) => preferenceView(
        isDefault: false,
        quietStart: '21:00',
        quietEnd: '07:00',
        items: <Map<String, Object?>>[prefItem('*', 'EMAIL', false), prefItem('report_reminder', 'PUSH', true, digest: 'DAILY')],
        locked: <Map<String, Object?>>[<String, Object?>{'event_category': 'warning', 'channel': 'IN_APP'}],
      ),
    );

void main() {
  group('UI-MOB-34 AC-ST-MOB-015-7 AC-ST-MOB-015-3 UAT-AC186 MOB-34 the notification settings', () {
    testWidgets('shows the channels of every kind of event, the digest of each, the quiet hours and the time zone; an urgent kind keeps its inbox on', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server, push: FakePush(state: PushPermission.granted));

      expect(find.text('Mọi loại sự kiện'), findsOneWidget);
      expect(find.text('report_reminder'), findsOneWidget);
      expect(find.text('warning'), findsOneWidget);
      expect(find.text('Kênh này luôn bật vì có sự kiện khẩn cấp.'), findsWidgets);
      expect(tester.widget<SwitchListTile>(find.widgetWithText(SwitchListTile, 'Trong ứng dụng').last).onChanged, isNull, reason: 'the locked inbox cannot be switched off');
      expect(find.text('Thiết bị cho phép nhận thông báo đẩy.'), findsOneWidget);
      expect(find.text('Gộp theo ngày'), findsOneWidget);
      expect(find.text('Trong giờ yên lặng, tin thường được hoãn theo chính sách; tin ưu tiên cao vẫn gửi ngay.'), findsOneWidget);
      expect(find.text('Tin ưu tiên cao luôn được gửi ngay, không bị gộp hay hoãn.'), findsOneWidget);
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Từ (giờ:phút)')).controller!.text, '21:00');
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Đến (giờ:phút)')).controller!.text, '07:00');
    });

    testWidgets('saving sends the whole set under the version seen: only what is off or in a digest, the quiet hours and the zone', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on('PUT', '/me/notification-preferences', (_) => <String, Object?>{'operation_id': 'o', 'status': 'SAVED', 'resource_version': 4});
      await _open(tester, server, push: FakePush());

      await tester.tap(find.widgetWithText(SwitchListTile, 'Zalo').first);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();

      final List<HttpCall> saves = server.callsTo('PUT', '/me/notification-preferences');
      expect(saves, hasLength(1));
      expect(saves.single.headers['if-match'], '"3"');
      expect(saves.single.headers['idempotency-key'], isNotEmpty);
      final Map<String, Object?> body = jsonDecode(saves.single.body!) as Map<String, Object?>;
      expect(body['quiet_start'], '21:00');
      expect(body['quiet_end'], '07:00');
      expect(body['time_zone'], 'Asia/Ho_Chi_Minh');
      final List<Object?> items = body['items']! as List<Object?>;
      expect(items.map((Object? item) => '${(item! as Map<String, Object?>)['event_category']}|${(item as Map<String, Object?>)['channel']}|${item['enabled']}'), containsAll(<String>['*|EMAIL|false', '*|ZALO|false']));
      expect(find.text('Đã lưu cài đặt thông báo.'), findsOneWidget);
    });

    testWidgets('REVIEW-r8 saving after a change of the quiet hours only does not move a channel into the digest of another', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/me/notification-preferences', (_) => preferenceView(quietStart: '21:00', quietEnd: '07:00', items: <Map<String, Object?>>[prefItem('report_reminder', 'EMAIL', true, digest: 'DAILY'), prefItem('report_reminder', 'PUSH', true, digest: 'IMMEDIATE'), prefItem('report_reminder', 'SMS', false)]));
      server.on('PUT', '/me/notification-preferences', (_) => <String, Object?>{'operation_id': 'o', 'status': 'SAVED', 'resource_version': 4});
      await _open(tester, server, push: FakePush());

      await tester.enterText(find.widgetWithText(TextField, 'Từ (giờ:phút)'), '22:00');
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();

      final Map<String, Object?> body = jsonDecode(server.callsTo('PUT', '/me/notification-preferences').single.body!) as Map<String, Object?>;
      final List<String> cells = <String>[for (final Object? item in body['items']! as List<Object?>) '${(item! as Map<String, Object?>)['event_category']}|${(item as Map<String, Object?>)['channel']}|${item['enabled']}|${item['digest_mode']}'];
      expect(cells, unorderedEquals(<String>['report_reminder|EMAIL|true|DAILY', 'report_reminder|PUSH|true|IMMEDIATE', 'report_reminder|SMS|false|IMMEDIATE']));
    });

    testWidgets('REVIEW-r7 saving an unrelated change keeps the explicit enabled row of a category beside a wildcard that is off, and its switch stays on', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', '/me/notification-preferences', (_) => preferenceView(items: <Map<String, Object?>>[prefItem('*', 'SMS', false), prefItem('report', 'SMS', true)]));
      server.on('PUT', '/me/notification-preferences', (_) => <String, Object?>{'operation_id': 'o', 'status': 'SAVED', 'resource_version': 4});
      await _open(tester, server, push: FakePush());

      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();

      final Map<String, Object?> body = jsonDecode(server.callsTo('PUT', '/me/notification-preferences').single.body!) as Map<String, Object?>;
      final List<String> cells = <String>[for (final Object? item in body['items']! as List<Object?>) '${(item! as Map<String, Object?>)['event_category']}|${(item as Map<String, Object?>)['channel']}|${item['enabled']}'];
      expect(cells, unorderedEquals(<String>['*|SMS|false', 'report|SMS|true']));
    });

    testWidgets('quiet hours that are not clock times, or are the same time, block the save', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server, push: FakePush());

      await tester.enterText(find.widgetWithText(TextField, 'Từ (giờ:phút)'), '25:00');
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();
      expect(find.text('Giờ phải có dạng giờ:phút, ví dụ 21:00.'), findsOneWidget);

      await tester.enterText(find.widgetWithText(TextField, 'Từ (giờ:phút)'), '07:00');
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();
      expect(find.text('Giờ bắt đầu và kết thúc không được trùng nhau.'), findsOneWidget);
      expect(server.callsTo('PUT', '/me/notification-preferences'), isEmpty);
    });

    testWidgets('a save the server refuses says why and keeps the form: a version that moved, a channel that is locked', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.refuse('PUT', '/me/notification-preferences', 409, 'VERSION_CONFLICT');
      await _open(tester, server, push: FakePush());
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();
      expect(find.text('Cài đặt vừa được đổi ở nơi khác. Hãy mở lại màn hình này rồi lưu.'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Lưu cài đặt'), findsOneWidget);

      server.refuse('PUT', '/me/notification-preferences', 422, 'MANDATORY_CHANNEL_LOCKED');
      await tester.tap(find.widgetWithText(FilledButton, 'Lưu cài đặt'));
      await tester.pumpAndSettle();
      expect(find.text('Kênh này không thể tắt vì có sự kiện khẩn cấp.'), findsOneWidget);
    });

    testWidgets('offline or on a copy, and in a read-only organisation, the settings can be read but not saved', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server, push: FakePush());
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.text('Cần kết nối mạng để lưu cài đặt.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu cài đặt')).onPressed, isNull);
      expect(tester.widget<SwitchListTile>(find.widgetWithText(SwitchListTile, 'Zalo').first).onChanged, isNull);

      final ScriptedServer other = ScriptedServer();
      _healthy(other);
      await _open(tester, other, session: FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', mode: SessionMode.readOnly)), push: FakePush());
      expect(find.text('Tổ chức đang ở chế độ chỉ đọc nên chưa thể lưu cài đặt.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu cài đặt')).onPressed, isNull);
      await _closeApp(tester);
    });

    testWidgets('the push state of the device is said, and a blocked push leaves the inbox working', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer denied = ScriptedServer();
      _healthy(denied);
      await _open(tester, denied, push: FakePush(state: PushPermission.denied));
      expect(find.text('Thông báo đẩy đang bị chặn trên thiết bị. Thông báo trong ứng dụng vẫn hoạt động.'), findsOneWidget);

      final ScriptedServer unknown = ScriptedServer();
      _healthy(unknown);
      await _open(tester, unknown, push: FakePush(state: PushPermission.unknown));
      expect(find.text('Chưa đăng ký thông báo đẩy trên thiết bị này. Thông báo trong ứng dụng vẫn hoạt động.'), findsOneWidget);
      await _closeApp(tester);

      // FIXAE-1: a build without a push provider says so (it was "not registered", which it no longer is: it is registered without a token).
      final ScriptedServer none = ScriptedServer();
      _healthy(none);
      await _open(tester, none);
      expect(find.text('Bản ứng dụng hoặc thiết bị này không có thông báo đẩy. Thông báo trong ứng dụng vẫn hoạt động.'), findsOneWidget);
      await _closeApp(tester);
    });

    testWidgets('every state is drawn and the contract of the screen holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server),
        script: StateScript(healthy: _healthy, content: find.text('Thông báo đẩy trên thiết bị')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server), healthy: _healthy);
    });
  });

  group('the preferences as pure rules', () {
    test('a reading that cannot be trusted is refused as a whole, because the version in it decides what a save overwrites', () {
      expect(parsePreferences(<String, Object?>{'version': 1, 'time_zone': 'UTC', 'items': <Object?>[<String, Object?>{'event_category': 'a', 'channel': 'FAX', 'enabled': true}]}), isNull);
      expect(parsePreferences(<String, Object?>{'version': -1, 'time_zone': 'UTC', 'items': <Object?>[]}), isNull);
      expect(parsePreferences(<String, Object?>{'version': 1, 'items': <Object?>[]}), isNull);
      expect(parsePreferences(<String, Object?>{'version': 0, 'time_zone': 'UTC', 'items': <Object?>[<String, Object?>{'event_category': 'a', 'channel': 'PUSH', 'enabled': 'yes'}]}), isNull);
      expect(parsePreferences(<String, Object?>{'version': 0, 'time_zone': 'UTC', 'items': <Object?>[]})!.version, 0);
    });

    test('the body of a save: a cell is sent when it is off or its kind has a digest; everything else is on by default', () {
      final PreferenceView view = parsePreferences(preferenceView(items: <Map<String, Object?>>[prefItem('a', 'PUSH', false), prefItem('b', 'EMAIL', true, digest: 'HOURLY')]))!;
      final PreferenceDraft draft = PreferenceDraft.of(view);
      final List<Object?> items = preferenceBody(draft)['items']! as List<Object?>;
      expect(items, hasLength(7), reason: 'the push of a, and the six channels of b');
      expect(preferenceBody(draft).containsKey('quiet_start'), isFalse);
      draft
        ..quietOn = true
        ..quietStart = '22:00'
        ..quietEnd = '06:30';
      expect(preferenceBody(draft)['quiet_end'], '06:30');
      expect(quietProblem(draft), isNull);
      draft.quietEnd = '22:00';
      expect(quietProblem(draft), QuietProblem.empty);
      draft.quietEnd = '6:30';
      expect(quietProblem(draft), QuietProblem.clock);
    });

    test('REVIEW-r8 a category whose channels are in different digests keeps each channel in its own digest until the person chooses one for the kind', () {
      final PreferenceView view = parsePreferences(preferenceView(items: <Map<String, Object?>>[prefItem('report', 'EMAIL', true, digest: 'DAILY'), prefItem('report', 'PUSH', false), prefItem('b', 'EMAIL', true, digest: 'HOURLY')]))!;
      final PreferenceDraft draft = PreferenceDraft.of(view);
      draft.quietOn = true; // an unrelated change
      List<String> cells() => <String>[for (final Object? item in preferenceBody(draft)['items']! as List<Object?>) '${(item! as Map<String, Object?>)['event_category']}|${(item as Map<String, Object?>)['channel']}|${item['enabled']}|${item['digest_mode']}'];
      expect(cells(), containsAll(<String>['report|EMAIL|true|DAILY', 'report|PUSH|false|IMMEDIATE']), reason: 'the push of the kind was not in a digest and stays so');
      expect(cells().where((String cell) => cell.startsWith('report|')), hasLength(2), reason: 'no other channel of the kind is put in the digest of the email');
      expect(cells().where((String cell) => cell.startsWith('b|')), hasLength(6), reason: 'a kind with one digest for its channels still has it on all of them');

      draft.setDigest('report', 'HOURLY');
      expect(cells().where((String cell) => cell.startsWith('report|')).toSet(), <String>{
        for (final String channel in preferenceChannels) 'report|$channel|${channel == 'PUSH' ? 'false' : 'true'}|HOURLY',
      }, reason: 'the choice of the person is for every channel of the kind');
      draft.setDigest('report', 'IMMEDIATE');
      expect(cells().where((String cell) => cell.startsWith('report|')), unorderedEquals(<String>['report|EMAIL|true|IMMEDIATE', 'report|PUSH|false|IMMEDIATE']));
    });

    test('REVIEW-r7 the server resolves the row of the category before the row of every category, so a save keeps an explicit enabled row beside a wildcard that is off', () {
      final PreferenceView view = parsePreferences(preferenceView(items: <Map<String, Object?>>[prefItem('*', 'SMS', false), prefItem('report', 'SMS', true)]))!;
      final PreferenceDraft draft = PreferenceDraft.of(view);
      draft.timeZone = 'Asia/Tokyo'; // an unrelated change
      final List<String> cells = <String>[for (final Object? item in preferenceBody(draft)['items']! as List<Object?>) '${(item! as Map<String, Object?>)['event_category']}|${(item as Map<String, Object?>)['channel']}|${item['enabled']}'];
      expect(cells, unorderedEquals(<String>['*|SMS|false', 'report|SMS|true']));
    });

    test('REVIEW-r7 a category cell under a wildcard that is off shows off until the person turns it on, and then is sent as an explicit enabled row', () {
      final PreferenceView view = parsePreferences(preferenceView(items: <Map<String, Object?>>[prefItem('*', 'SMS', false), prefItem('report', 'EMAIL', false)]))!;
      final PreferenceDraft draft = PreferenceDraft.of(view);
      expect(draft.isOn('report', 'SMS'), isFalse, reason: 'it inherits the wildcard');
      expect(draft.isOn('report', 'PUSH'), isTrue);
      draft.toggle('report', 'SMS');
      expect(draft.isOn('report', 'SMS'), isTrue);
      final List<String> cells = <String>[for (final Object? item in preferenceBody(draft)['items']! as List<Object?>) '${(item! as Map<String, Object?>)['event_category']}|${(item as Map<String, Object?>)['channel']}|${item['enabled']}'];
      expect(cells, unorderedEquals(<String>['*|SMS|false', 'report|EMAIL|false', 'report|SMS|true']));
      draft.toggle('report', 'SMS');
      expect(draft.isOn('report', 'SMS'), isFalse);
      draft.toggle('*', 'SMS');
      expect(draft.isOn('report', 'SMS'), isFalse, reason: 'the cell was switched off by the person');
      expect(draft.isOn('report', 'PUSH'), isTrue);
    });

    test('too many entries are refused before the server does, and each refusal code has its problem', () {
      final PreferenceView view = parsePreferences(preferenceView())!;
      final PreferenceDraft draft = PreferenceDraft.of(view);
      for (int index = 0; index < 40; index += 1) {
        draft.categories.add('kind_$index');
        draft.digest['kind_$index'] = 'DAILY';
      }
      expect(tooManyItems(draft), isTrue);
      expect(preferenceProblemOf('MANDATORY_CHANNEL_LOCKED'), PreferenceProblem.locked);
      expect(preferenceProblemOf('VERSION_CONFLICT'), PreferenceProblem.stale);
      expect(preferenceProblemOf('VALIDATION_FAILED'), PreferenceProblem.invalid);
      expect(preferenceProblemOf('SCOPE_DENIED'), PreferenceProblem.denied);
      expect(preferenceProblemOf('SESSION_EXPIRED'), PreferenceProblem.session);
      expect(preferenceProblemOf('x'), PreferenceProblem.general);
    });
  });
}
