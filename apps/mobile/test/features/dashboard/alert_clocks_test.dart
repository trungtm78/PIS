import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall, MachvonApiClient;
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/dashboard/alert_commands.dart';
import 'package:machvon_mobile/features/dashboard/alerts.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/dashboard/widgets/alert_card.dart' show AlertCard;
import 'package:machvon_mobile/features/dashboard/widgets/alert_sheets.dart' show latestSnooze;
import 'package:machvon_mobile/features/dashboard/work_policy.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'dashboard_fixtures.dart';

const MobileFeature _approvalStub = MobileFeature(id: 'stub', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-24', pathSuffix: '/:taskId', builder: _stub)]);

Widget _stub(BuildContext context, ScreenContext screen) => Text('task ${screen.pathParameters['taskId']}');

Map<String, Object?> _person(String name) => <String, Object?>{'id': 'u-1', 'name': name};

AlertItem _item(Map<String, Object?> alert) => parseAlertFeed(alertWork(<Map<String, Object?>>[alert]))!.items.single;

SnoozePolicyView _policy({Map<String, Object?>? maxDays}) => parseSnoozePolicy(workClockPolicies(maxDays: maxDays ?? const <String, Object?>{'URGENT': 0, 'ACTION': 5, 'WATCH': 14}))!;

/// Opens the home with one alert and the policy as given (null: the policy cannot be read), then opens the snooze sheet of the alert.
Future<ScriptedServer> _openSheet(WidgetTester tester, Map<String, Object?> alert, {Object? policies, bool policyFails = false}) async {
  useDevice(tester, kTallDevice);
  final ScriptedServer server = ScriptedServer()
    ..on('GET', '/home/command-center', (_) => commandCenter())
    ..on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[alert]))
    ..on('GET', '/home/my-work/counts', (_) => alertCounts(action: 1))
    ..on('POST', '/home/work-actions/snooze', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Snoozed'});
  if (policyFails) {
    server.refuse('GET', '/home/work-clocks/policies', 500, 'INTERNAL_ERROR');
  } else {
    server.on('GET', '/home/work-clocks/policies', (_) => policies ?? workClockPolicies());
  }
  await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, _approvalStub], server: server, location: '/home');
  await tester.tap(find.byTooltip('Thao tác với việc này'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Nhắc lại sau'));
  await tester.pumpAndSettle();
  return server;
}

Finder get _submit => find.descendant(of: find.byType(BottomSheet), matching: find.widgetWithText(FilledButton, 'Hoãn việc'));

Finder get _noteField => find.descendant(of: find.byType(BottomSheet), matching: find.byType(TextField));

bool _enabled(WidgetTester tester, Finder button) => tester.widget<FilledButton>(button).onPressed != null;

Future<ScriptedServer> _openHome(WidgetTester tester, List<Map<String, Object?>> alerts) async {
  useDevice(tester, kTallDevice);
  final ScriptedServer server = ScriptedServer()
    ..on('GET', '/home/command-center', (_) => commandCenter())
    ..on('GET', '/home/my-work', (_) => alertWork(alerts))
    ..on('GET', '/home/my-work/counts', (_) => alertCounts(action: alerts.length))
    ..on('POST', '/home/work-actions/claim', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Claimed'});
  await pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, _approvalStub], server: server, location: '/home');
  return server;
}

WorkCommands _commands(ScriptedServer server) => WorkCommands(MachvonApiClient(baseUrl: testConfig.apiBaseUrl, transport: server, token: () async => 'test-token'));

void main() {
  group('the alert model reads the fields of the clocks and the alert core, and tolerates a server that lacks them', () {
    test('every new field is read', () {
      final AlertItem item = _item(alertItem('a-1', lifecycle: 'CLAIMED', claimedBy: <String, Object?>{'name': 'Lê Văn B'}, extra: <String, Object?>{
        'started_at': '2026-11-02T01:00:00Z',
        'expected_action': 'Nhận việc và gọi chủ đầu tư',
        'needs_reclaim': true,
        'snooze': <String, Object?>{'by': _person('Lê Văn B'), 'until': '2026-11-03T10:00:00Z', 'reason_code': 'WAITING_THIRD_PARTY', 'note': null, 'ordinal': 1, 'of': 2, 'final': false, 'policy_version': 3},
        'snooze_count': 1,
        'pause': <String, Object?>{'from': '2026-11-03T01:00:00Z', 'until': '2026-11-04T01:00:00Z', 'resumed_at': null, 'reason_code': 'ON_LEAVE', 'reason': null, 'allowed_by': _person('Trần C')},
        'clocks': <String, Object?>{
          'basis': 'WORKING_TIME',
          'claim': <String, Object?>{'state': 'RUNNING', 'started_at': '2026-11-02T01:00:00Z', 'due_at': '2026-11-03T05:00:00Z', 'met_at': null},
          'resolve': <String, Object?>{'state': 'MET_LATE', 'started_at': '2026-11-02T01:00:00Z', 'due_at': '2026-11-03T01:00:00Z', 'met_at': '2026-11-03T02:00:00Z'},
          'paused': false,
          'needs_reclaim': true,
        },
        'reminders': <String, Object?>{'sent': 2, 'next_at': '2026-11-03T06:00:00Z', 'due': false, 'exhausted': false},
        'notices': <Object?>[<String, Object?>{'kind': 'REMINDER', 'at': '2026-11-03T01:00:00Z'}],
        'existing_clock': null,
      }));
      expect(item.startedAt, '2026-11-02T01:00:00Z');
      expect(item.expectedAction, 'Nhận việc và gọi chủ đầu tư');
      expect(item.needsReclaim, isTrue);
      expect(item.canClaim, isTrue, reason: 'taken up and silent: it can be taken again');
      expect(item.snooze!.ordinal, 1);
      expect(item.snooze!.of, 2);
      expect(item.snooze!.reasonCode, 'WAITING_THIRD_PARTY');
      expect(item.snooze!.isFinal, isFalse);
      expect(item.snooze!.by!.name, 'Lê Văn B');
      expect(item.snooze!.policyVersion, 3);
      expect(item.snoozesUsed, 1);
      expect(item.pausedUntil, '2026-11-04T01:00:00Z');
      expect(item.clocks!.basis, ClockBasis.workingTime);
      expect(item.clocks!.claim!.state, ClockState.running);
      expect(item.clocks!.claim!.dueAt, '2026-11-03T05:00:00Z');
      expect(item.clocks!.resolve!.state, ClockState.metLate);
      expect(item.clocks!.resolve!.metAt, '2026-11-03T02:00:00Z');
      expect(item.reminders!.sent, 2);
      expect(item.reminders!.nextAt, '2026-11-03T06:00:00Z');
    });

    test('an old payload has none of them: nothing is invented, and only an item nobody holds can be taken', () {
      final AlertItem item = _item(alertItem('a-1'));
      expect(item.needsReclaim, isFalse);
      expect(item.snooze, isNull);
      expect(item.snoozesUsed, 0);
      expect(item.clocks, isNull);
      expect(item.pause, isNull);
      expect(item.pausedUntil, isNull);
      expect(item.reminders, isNull);
      expect(item.startedAt, isNull);
      expect(item.expectedAction, isNull);
      expect(item.canClaim, isTrue, reason: 'nobody holds it');
      expect(_item(alertItem('a-2', lifecycle: 'CLAIMED', claimedBy: <String, Object?>{'name': 'B'})).canClaim, isFalse);
    });

    test('malformed pieces are dropped one by one: an unknown basis or state, a resumed pause, junk types', () {
      final AlertItem item = _item(alertItem('a-1', extra: <String, Object?>{
        'needs_reclaim': 'yes',
        'snooze': <String, Object?>{'reason_code': 'OTHER'},
        'pause': <String, Object?>{'until': '2026-11-04T01:00:00Z', 'resumed_at': '2026-11-03T02:00:00Z'},
        'clocks': <String, Object?>{'basis': 'WORKING_TIME', 'claim': <String, Object?>{'state': 'MYSTERY'}, 'resolve': 'x'},
        'reminders': 7,
      }));
      expect(item.needsReclaim, isFalse, reason: 'only a true is a true');
      expect(item.snooze, isNull, reason: 'a snooze without a place in the run is not shown');
      expect(item.pause, isNotNull);
      expect(item.pausedUntil, isNull, reason: 'a pause that was resumed is over');
      expect(item.clocks!.claim, isNull);
      expect(item.clocks!.resolve, isNull);
      expect(item.reminders, isNull);
      expect(_item(alertItem('a-2', extra: <String, Object?>{'clocks': <String, Object?>{'basis': 'SOMETHING_NEW'}})).clocks, isNull);
    });

    test('needs_reclaim inside the clocks counts too', () {
      final AlertItem item = _item(alertItem('a-1', extra: <String, Object?>{
        'clocks': <String, Object?>{'basis': 'WORKING_TIME', 'needs_reclaim': true},
      }));
      expect(item.needsReclaim, isTrue);
    });
  });

  group('the snooze policy is read from the data of the server, never invented', () {
    test('the reasons, the notes, the days of each level and the run of snoozes are read; a cap of nought is no cap', () {
      final SnoozePolicyView policy = _policy();
      expect(policy.reasons, <String>['WAITING_INFORMATION', 'WAITING_THIRD_PARTY', 'SCHEDULED_ACTION', 'BLOCKED_BY_OTHER_WORK', 'ON_LEAVE', 'OTHER']);
      expect(policy.noteRequiredFor, <String>{'OTHER'});
      expect(policy.needsNote('OTHER'), isTrue);
      expect(policy.needsNote('ON_LEAVE'), isFalse);
      expect(policy.maxDaysOf(AlertSeverity.action), 5);
      expect(policy.maxDaysOf(AlertSeverity.watch), 14);
      expect(policy.maxDaysOf(AlertSeverity.urgent), isNull);
      expect(policy.maxConsecutive, 2);
      expect(policy.finalNotifies, isTrue);
      expect(policy.version, 3);
      expect(policy.unverified, isTrue);
    });

    test('an answer with no snooze policy, no reasons, no run or no cap is unusable', () {
      expect(parseSnoozePolicy(<String, Object?>{'policies': <Object?>[]}), isNull);
      expect(parseSnoozePolicy(<String, Object?>{'nope': 1}), isNull);
      expect(parseSnoozePolicy(workClockPolicies(reasons: <String>[])), isNull);
      expect(parseSnoozePolicy(workClockPolicies(maxConsecutive: 0)), isNull);
      expect(parseSnoozePolicy(workClockPolicies(maxDays: <String, Object?>{'ACTION': 'three'})), isNull);
      expect(parseSnoozePolicy('x'), isNull);
    });

    test('the latest instant of a snooze is the cap of the level or the end of the due day, whichever comes first', () {
      final DateTime now = kNow;
      final SnoozePolicyView policy = _policy();
      expect(latestSnooze(item: _item(alertItem('a', severity: 'ACTION', dueOn: '2026-11-30')), policy: policy, now: now), now.add(const Duration(days: 5)));
      expect(latestSnooze(item: _item(alertItem('a', severity: 'WATCH', dueOn: '2026-11-30')), policy: policy, now: now), now.add(const Duration(days: 14)));
      expect(latestSnooze(item: _item(alertItem('a', severity: 'ACTION', dueOn: '2026-11-04')), policy: policy, now: now), DateTime.utc(2026, 11, 4, 17), reason: 'the whole due day counts, to midnight in Vietnam');
      expect(latestSnooze(item: _item(alertItem('a', severity: 'ACTION', dueOn: '2026-11-03T08:00:00Z')), policy: policy, now: now), DateTime.utc(2026, 11, 3, 8));
      expect(latestSnooze(item: _item(alertItem('a', severity: 'ACTION', dueOn: '2026-10-31', overdue: true, daysLate: 3)), policy: policy, now: now), now, reason: 'a late item cannot be snoozed');
      expect(latestSnooze(item: _item(alertItem('a', severity: 'ACTION')), policy: _policy(maxDays: <String, Object?>{'WATCH': 14}), now: now), isNull, reason: 'no cap for the level: no guess');
    });
  });

  group('the snooze command sends the reason and maps the refusals of the server', () {
    test('the body has the instant, the reason code and the trimmed note; an empty note is not sent', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', '/home/work-actions/snooze', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Snoozed'});
      final AlertItem item = _item(alertItem('a-1', severity: 'WATCH', source: 'PERMIT'));
      final WorkCommands commands = _commands(server);
      expect((await commands.snooze(item, until: '2026-11-03T04:00:00.000Z', reasonCode: 'OTHER', note: '  Chờ ý kiến lãnh đạo  ')).ok, isTrue);
      expect(await commands.snooze(item, until: '2026-11-03T04:00:00.000Z', reasonCode: 'ON_LEAVE', note: '   '), isA<WorkActionResult>());
      final List<HttpCall> calls = server.callsTo('POST', '/home/work-actions/snooze');
      expect(jsonDecode(calls[0].body!), <String, Object?>{
        'source': 'PERMIT',
        'source_id': 'a-1',
        'snooze_until': '2026-11-03T04:00:00.000Z',
        'reason_code': 'OTHER',
        'reason': 'Chờ ý kiến lãnh đạo',
      });
      expect(jsonDecode(calls[1].body!), <String, Object?>{'source': 'PERMIT', 'source_id': 'a-1', 'snooze_until': '2026-11-03T04:00:00.000Z', 'reason_code': 'ON_LEAVE'});
    });

    test('the same intention keeps its key across a lost answer; another reason or note is a new intention', () async {
      final ScriptedServer server = ScriptedServer()..on('POST', '/home/work-actions/snooze', (_) => <String, Object?>{'operation_id': 'o', 'status': 'Snoozed'});
      final AlertItem item = _item(alertItem('a-1', severity: 'WATCH'));
      final WorkCommands commands = _commands(server);
      server.offline = true;
      expect((await commands.snooze(item, until: 'u', reasonCode: 'OTHER', note: 'Chờ ý kiến')).outcome, WorkActionOutcome.lost);
      expect((await commands.snooze(item, until: 'u', reasonCode: 'OTHER', note: 'Chờ ý kiến')).outcome, WorkActionOutcome.lost);
      expect((await commands.snooze(item, until: 'u', reasonCode: 'OTHER', note: 'Chờ ý kiến khác')).outcome, WorkActionOutcome.lost);
      expect((await commands.snooze(item, until: 'u', reasonCode: 'ON_LEAVE', note: 'Chờ ý kiến khác')).outcome, WorkActionOutcome.lost);
      final List<String> keys = server.callsTo('POST', '/home/work-actions/snooze').map((HttpCall call) => call.headers['idempotency-key']!).toList();
      expect(keys[1], keys[0], reason: 'the retry is the same intention');
      expect(keys[2], isNot(keys[1]), reason: 'another note is another intention');
      expect(keys[3], isNot(keys[2]), reason: 'another reason is another intention');
    });

    test('an urgent alert is not sent; the stable refusals of the API map to a sentence each', () async {
      final ScriptedServer server = ScriptedServer();
      final WorkCommands commands = _commands(server);
      final WorkActionResult urgent = await commands.snooze(_item(alertItem('u', severity: 'URGENT')), until: 'u', reasonCode: 'OTHER');
      expect(urgent.code, 'URGENT_NOT_SNOOZABLE');
      expect(snoozeRefusalOf(urgent), SnoozeRefusal.notAllowed);
      expect(server.callsTo('POST', '/home/work-actions/snooze'), isEmpty);

      final Map<String, SnoozeRefusal> expected = <String, SnoozeRefusal>{
        'VALIDATION_FAILED': SnoozeRefusal.validation,
        'WORK_SNOOZE_NOT_ALLOWED': SnoozeRefusal.notAllowed,
        'WORK_SNOOZE_TOO_LONG': SnoozeRefusal.tooLong,
        'WORK_SNOOZE_LIMIT': SnoozeRefusal.limit,
        'PERMISSION_DENIED': SnoozeRefusal.other,
      };
      for (final MapEntry<String, SnoozeRefusal> entry in expected.entries) {
        server.refuse('POST', '/home/work-actions/snooze', 422, entry.key);
        final WorkActionResult result = await commands.snooze(_item(alertItem('a-1', severity: 'WATCH')), until: 'u', reasonCode: 'ON_LEAVE');
        expect(result.outcome, WorkActionOutcome.refused, reason: entry.key);
        expect(result.code, entry.key);
        expect(snoozeRefusalOf(result), entry.value, reason: entry.key);
      }
    });
  });

  group('the snooze sheet', () {
    testWidgets('offers the reasons of the policy with their words (an unknown code as it is) and caps the days by the policy', (WidgetTester tester) async {
      await _openSheet(
        tester,
        alertItem('a-1', severity: 'ACTION', dueOn: '2026-11-30', title: 'Tạm ứng quá hạn'),
        policies: workClockPolicies(reasons: <String>['WAITING_INFORMATION', 'ON_LEAVE', 'MYSTERY_CODE'], maxDays: <String, Object?>{'ACTION': 5, 'WATCH': 14}),
      );
      expect(find.text('Chờ thêm thông tin'), findsOneWidget);
      expect(find.text('Đang nghỉ phép'), findsOneWidget);
      expect(find.text('MYSTERY_CODE'), findsOneWidget);
      expect(find.text('Chờ bên thứ ba'), findsNothing, reason: 'the list is the policy\'s, not the phone\'s');
      expect(find.textContaining('Mức Cần xử lý: hoãn tối đa 5 ngày.'), findsOneWidget, reason: 'the days are the policy\'s');
      expect(find.textContaining('Lần 1/2'), findsOneWidget);
      expect(find.text('Đây là lần hoãn cuối: cấp trên sẽ được báo'), findsNothing);
      expect(_noteField, findsNothing, reason: 'no note for a reason that needs none');
      expect(find.text('Sau 1 giờ'), findsOneWidget);
      expect(find.text('Sáng mai 07:00'), findsOneWidget);
      expect(find.text('Chọn ngày…'), findsOneWidget);
    });

    testWidgets('nothing is sent until a reason and a time are chosen, and a reason that needs a note needs five characters of it', (WidgetTester tester) async {
      final ScriptedServer server = await _openSheet(tester, alertItem('a-1', severity: 'WATCH', source: 'PERMIT', title: 'Giấy phép'));

      await tester.tap(_submit);
      await tester.pumpAndSettle();
      expect(find.text('Hãy chọn lý do hoãn.'), findsOneWidget);
      expect(find.text('Hãy chọn thời điểm nhắc lại.'), findsOneWidget);
      expect(server.callsTo('POST', '/home/work-actions/snooze'), isEmpty);

      await tester.tap(find.text('Lý do khác'));
      await tester.pumpAndSettle();
      expect(_noteField, findsOneWidget, reason: 'OTHER needs a note');
      await tester.tap(find.text('Sau 1 giờ'));
      await tester.pumpAndSettle();
      await tester.enterText(_noteField, ' abc ');
      await tester.tap(_submit);
      await tester.pumpAndSettle();
      expect(find.text('Hãy ghi rõ lý do, ít nhất 5 ký tự.'), findsOneWidget);
      expect(server.callsTo('POST', '/home/work-actions/snooze'), isEmpty);

      await tester.enterText(_noteField, '  Chờ ý kiến lãnh đạo ');
      await tester.tap(_submit);
      await tester.pumpAndSettle();
      final List<HttpCall> calls = server.callsTo('POST', '/home/work-actions/snooze');
      expect(calls, hasLength(1));
      final Map<String, Object?> body = jsonDecode(calls.single.body!) as Map<String, Object?>;
      expect(body['reason_code'], 'OTHER');
      expect(body['reason'], 'Chờ ý kiến lãnh đạo');
      expect(body['snooze_until'], kNow.add(const Duration(hours: 1)).toIso8601String());
      expect(find.byType(BottomSheet), findsNothing, reason: 'the sheet closes once the server recorded it');
      expect(find.textContaining('Hạn nghiệp vụ và việc leo thang không đổi'), findsOneWidget);
    });

    testWidgets('a time past the due day is offered but cannot be chosen, and says why', (WidgetTester tester) async {
      await _openSheet(tester, alertItem('a-1', severity: 'ACTION', dueOn: '2026-11-03', title: 'Hạn hôm nay'));
      final Finder tomorrow = find.widgetWithText(ListTile, 'Sáng mai 07:00');
      expect(tester.widget<ListTile>(tomorrow).enabled, isFalse);
      expect(find.descendant(of: tomorrow, matching: find.text('Vượt giới hạn')), findsOneWidget, reason: 'the reason is a word, not only a grey tile');
      expect(tester.widget<ListTile>(find.widgetWithText(ListTile, 'Sau 1 giờ')).enabled, isTrue);
    });

    testWidgets('the place in the run is "Lần n/of", and the last allowed snooze warns that the superior will be told', (WidgetTester tester) async {
      await _openSheet(tester, alertItem('a-1', severity: 'WATCH', title: 'Theo dõi', extra: <String, Object?>{'snooze_count': 1}));
      expect(find.textContaining('Lần 2/2'), findsOneWidget);
      expect(find.text('Đây là lần hoãn cuối: cấp trên sẽ được báo'), findsOneWidget);
    });

    testWidgets('a policy that does not notify says only that it is the last', (WidgetTester tester) async {
      await _openSheet(tester, alertItem('a-1', severity: 'WATCH', extra: <String, Object?>{'snooze_count': 1}), policies: workClockPolicies(finalNotifies: false));
      expect(find.text('Đây là lần hoãn cuối.'), findsOneWidget);
      expect(find.textContaining('cấp trên sẽ được báo'), findsNothing);
    });

    testWidgets('an alert already snoozed the allowed times cannot be snoozed again: the button stays off', (WidgetTester tester) async {
      await _openSheet(tester, alertItem('a-1', severity: 'WATCH', extra: <String, Object?>{'snooze_count': 2}));
      expect(find.text('Đã hoãn đủ 2 lần liên tiếp, không hoãn thêm được.'), findsOneWidget);
      expect(_enabled(tester, _submit), isFalse);
    });

    testWidgets('a policy that cannot be read is shown with its code and a retry, and the button stays off; retry reads again', (WidgetTester tester) async {
      final ScriptedServer server = await _openSheet(tester, alertItem('a-1', severity: 'WATCH'), policyFails: true);
      expect(find.textContaining('Chưa tải được quy định hoãn việc (INTERNAL_ERROR). Chưa thể hoãn.'), findsOneWidget);
      expect(find.text('Chờ thêm thông tin'), findsNothing, reason: 'no reasons and no days are invented');
      expect(find.text('Sau 1 giờ'), findsNothing);
      expect(_enabled(tester, _submit), isFalse);

      server.on('GET', '/home/work-clocks/policies', (_) => workClockPolicies());
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Chưa tải được quy định hoãn việc'), findsNothing);
      expect(find.text('Chờ thêm thông tin'), findsOneWidget);
      expect(_enabled(tester, _submit), isTrue);
    });

    testWidgets('a policy without a cap for the level of the alert is unusable for it: no number is made up', (WidgetTester tester) async {
      await _openSheet(tester, alertItem('a-1', severity: 'ACTION'), policies: workClockPolicies(maxDays: <String, Object?>{'WATCH': 14}));
      expect(find.textContaining('Chưa tải được quy định hoãn việc'), findsOneWidget);
      expect(find.text('Sau 1 giờ'), findsNothing);
      expect(_enabled(tester, _submit), isFalse);
    });

    testWidgets('each refusal of the server is said with a sentence of its own, the sheet stays open and can be sent again', (WidgetTester tester) async {
      final ScriptedServer server = await _openSheet(tester, alertItem('a-1', severity: 'WATCH'));
      await tester.tap(find.text('Đang nghỉ phép'));
      await tester.tap(find.text('Sau 1 giờ'));
      await tester.pumpAndSettle();

      final Map<String, String> sentences = <String, String>{
        'VALIDATION_FAILED': 'Thông tin hoãn chưa hợp lệ: hãy chọn lý do và ghi chú nếu cần.',
        'WORK_SNOOZE_NOT_ALLOWED': 'Việc khẩn hoặc đã quá hạn nghiệp vụ không hoãn được.',
        'WORK_SNOOZE_TOO_LONG': 'Thời gian hoãn vượt giới hạn cho mức này, hãy chọn ngắn hơn.',
        'WORK_SNOOZE_LIMIT': 'Đã hoãn đủ số lần liên tiếp cho phép, không hoãn thêm được.',
        'PERMISSION_DENIED': 'Máy chủ từ chối thao tác (PERMISSION_DENIED).',
      };
      int sent = 0;
      for (final MapEntry<String, String> entry in sentences.entries) {
        server.refuse('POST', '/home/work-actions/snooze', 422, entry.key);
        await tester.tap(_submit);
        await tester.pumpAndSettle();
        sent += 1;
        expect(find.text(entry.value), findsOneWidget, reason: entry.key);
        expect(find.byType(BottomSheet), findsOneWidget, reason: 'the sheet stays open');
        expect(_enabled(tester, _submit), isTrue, reason: 'it can be sent again');
        expect(server.callsTo('POST', '/home/work-actions/snooze'), hasLength(sent));
      }

      server.offline = true;
      await tester.tap(_submit);
      await tester.pumpAndSettle();
      expect(find.textContaining('Chưa gửi được vì mất kết nối'), findsOneWidget);
      expect(find.byType(BottomSheet), findsOneWidget);
    });

    testWidgets('while the snooze is being sent the button is off, so a second tap cannot send it twice', (WidgetTester tester) async {
      final Completer<void> hold = Completer<void>();
      final ScriptedServer server = await _openSheet(tester, alertItem('a-1', severity: 'WATCH'));
      server.answer('POST', '/home/work-actions/snooze', (HttpCall call) async {
        await hold.future;
        return FakeTransport.json(200, <String, Object?>{'operation_id': 'o', 'status': 'Snoozed'});
      });
      await tester.tap(find.text('Đang nghỉ phép'));
      await tester.tap(find.text('Sau 1 giờ'));
      await tester.pumpAndSettle();

      await tester.tap(_submit);
      await tester.pump();
      await tester.pump();
      expect(_enabled(tester, find.descendant(of: find.byType(BottomSheet), matching: find.byType(FilledButton))), isFalse);
      await tester.tap(find.descendant(of: find.byType(BottomSheet), matching: find.byType(FilledButton)), warnIfMissed: false);
      await tester.pump();
      expect(server.callsTo('POST', '/home/work-actions/snooze'), hasLength(1));

      hold.complete();
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(server.callsTo('POST', '/home/work-actions/snooze'), hasLength(1));
    });
  });

  group('the alert card shows the clocks and the state of the alert core', () {
    testWidgets('an alert taken up and then silent says so with an icon and a word, and offers "Nhận lại"', (WidgetTester tester) async {
      final ScriptedServer server = await _openHome(tester, <Map<String, Object?>>[
        alertItem('x-1', screen: 'DIS-03', title: 'Tạm ứng quá hạn', lifecycle: 'CLAIMED', claimedBy: <String, Object?>{'name': 'Lê Văn B'}, extra: <String, Object?>{'needs_reclaim': true}),
      ]);
      expect(find.descendant(of: find.byType(AlertCard), matching: find.text('Cần nhận lại')), findsOneWidget);
      expect(find.descendant(of: find.byType(AlertCard), matching: find.byIcon(Icons.replay)), findsOneWidget, reason: 'not the colour alone');
      expect(find.widgetWithText(FilledButton, 'Nhận lại'), findsOneWidget);
      expect(find.text('Nhận xử lý'), findsNothing);

      await tester.tap(find.widgetWithText(FilledButton, 'Nhận lại'));
      await tester.pumpAndSettle();
      expect(server.callsTo('POST', '/home/work-actions/claim'), hasLength(1));
      expect(find.text('Đã nhận lại: Tạm ứng quá hạn'), findsOneWidget);
    });

    testWidgets('an alert nobody holds keeps "Nhận xử lý" and no chip; a held one that is not silent offers no claim', (WidgetTester tester) async {
      await _openHome(tester, <Map<String, Object?>>[
        alertItem('x-1', screen: 'DIS-03', title: 'Chưa ai nhận'),
        alertItem('x-2', screen: 'DIS-03', title: 'Đã có người', lifecycle: 'CLAIMED', claimedBy: <String, Object?>{'name': 'B'}),
      ]);
      expect(find.text('Cần nhận lại'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Nhận xử lý'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Nhận lại'), findsNothing);
    });

    testWidgets('the two clocks are one line each with an icon and a word per state', (WidgetTester tester) async {
      await _openHome(tester, <Map<String, Object?>>[
        alertItem('x-1', title: 'Một', extra: <String, Object?>{
          'clocks': <String, Object?>{
            'basis': 'WORKING_TIME',
            'claim': <String, Object?>{'state': 'RUNNING', 'started_at': '2026-11-03T01:00:00Z', 'due_at': '2026-11-03T05:00:00Z', 'met_at': null},
            'resolve': <String, Object?>{'state': 'RUNNING', 'started_at': '2026-11-03T01:00:00Z', 'due_at': '2026-11-06T03:00:00Z', 'met_at': null},
          },
        }),
        alertItem('x-2', title: 'Hai', extra: <String, Object?>{
          'clocks': <String, Object?>{
            'basis': 'WORKING_TIME',
            'claim': <String, Object?>{'state': 'BREACHED', 'started_at': '2026-11-02T01:00:00Z', 'due_at': '2026-11-03T01:00:00Z', 'met_at': null},
            'resolve': <String, Object?>{'state': 'PAUSED', 'started_at': '2026-11-02T01:00:00Z', 'due_at': '2026-11-06T03:00:00Z', 'met_at': null},
          },
        }),
        alertItem('x-3', title: 'Ba', extra: <String, Object?>{
          'clocks': <String, Object?>{
            'basis': 'WORKING_TIME',
            'claim': <String, Object?>{'state': 'MET', 'started_at': '2026-11-02T01:00:00Z', 'due_at': '2026-11-03T05:00:00Z', 'met_at': '2026-11-03T01:30:00Z'},
            'resolve': <String, Object?>{'state': 'MET_LATE', 'started_at': '2026-11-02T01:00:00Z', 'due_at': '2026-11-03T01:00:00Z', 'met_at': '2026-11-03T02:00:00Z'},
          },
        }),
      ]);
      expect(find.text('Nhận việc: còn 2 giờ · 12:00'), findsOneWidget);
      expect(find.text('Xử lý: còn 3 ngày · 06/11'), findsOneWidget);
      expect(find.text('Nhận việc: quá hạn 2 giờ'), findsOneWidget);
      expect(find.text('Xử lý: tạm dừng · hạn 06/11/2026 10:00'), findsOneWidget);
      expect(find.text('Nhận việc: đạt lúc 03/11/2026 08:30'), findsOneWidget);
      expect(find.text('Xử lý: đạt nhưng trễ, lúc 03/11/2026 09:00'), findsOneWidget);
      for (final IconData icon in <IconData>[Icons.timer_outlined, Icons.error_outline, Icons.pause_circle_outline, Icons.check_circle_outline, Icons.watch_later_outlined]) {
        expect(find.descendant(of: find.byType(AlertCard), matching: find.byIcon(icon)), findsWidgets, reason: 'every state has an icon: $icon');
      }
    });

    testWidgets('without a published working calendar the card says so, and never says there is no due day', (WidgetTester tester) async {
      await _openHome(tester, <Map<String, Object?>>[
        alertItem('x-1', title: 'Chưa có lịch', dueOn: null, extra: <String, Object?>{
          'clocks': <String, Object?>{'basis': 'CALENDAR_UNAVAILABLE', 'claim': null, 'resolve': null, 'paused': false, 'needs_reclaim': false},
        }),
      ]);
      expect(find.text('Chưa có lịch làm việc đã công bố nên chưa tính được hạn'), findsOneWidget);
      expect(find.text('Không có hạn'), findsNothing);
      expect(find.descendant(of: find.byType(AlertCard), matching: find.byIcon(Icons.event_busy_outlined)), findsOneWidget);
    });

    testWidgets('the snooze, the pause, the reminders and the expected action are lines of the card', (WidgetTester tester) async {
      await _openHome(tester, <Map<String, Object?>>[
        alertItem('x-1', title: 'Một', extra: <String, Object?>{
          'expected_action': 'Gọi chủ đầu tư',
          'snooze': <String, Object?>{'by': _person('B'), 'until': '2026-11-03T10:00:00Z', 'reason_code': 'WAITING_THIRD_PARTY', 'note': null, 'ordinal': 1, 'of': 2, 'final': false, 'policy_version': 3},
          'pause': <String, Object?>{'until': '2026-11-04T01:00:00Z', 'resumed_at': null},
          'reminders': <String, Object?>{'sent': 2, 'next_at': '2026-11-03T06:00:00Z', 'due': false, 'exhausted': false},
        }),
        alertItem('x-2', title: 'Hai', extra: <String, Object?>{
          'snooze': <String, Object?>{'until': '2026-11-03T10:00:00Z', 'reason_code': 'PROBABLY_NEW', 'ordinal': 2, 'of': 2, 'final': true},
          'reminders': <String, Object?>{'sent': 3, 'next_at': null, 'due': false, 'exhausted': true},
        }),
      ]);
      expect(find.text('Hoãn lần 1/2 · Chờ bên thứ ba · đến 03/11/2026 17:00'), findsOneWidget);
      expect(find.text('Hoãn lần 2/2 · PROBABLY_NEW · đến 03/11/2026 17:00 · lần hoãn cuối'), findsOneWidget);
      expect(find.text('Đồng hồ tạm dừng đến 04/11/2026 08:00'), findsOneWidget);
      expect(find.text('Đã nhắc 2 lần · nhắc tiếp lúc 03/11/2026 13:00'), findsOneWidget);
      expect(find.text('Đã nhắc hết số lần (3)'), findsOneWidget);
      expect(find.text('Cần làm: Gọi chủ đầu tư'), findsOneWidget);
    });

    testWidgets('a source the phone does not know is shown with its code and does not crash; the clock source has a word of its own', (WidgetTester tester) async {
      await _openHome(tester, <Map<String, Object?>>[
        alertItem('x-1', source: 'FUTURE_SOURCE', title: 'Một'),
        alertItem('x-2', source: 'CLOCK', title: 'Hai'),
        alertItem('x-3', source: 'MONEY_CONTROL', title: 'Ba'),
      ]);
      expect(tester.takeException(), isNull);
      expect(find.textContaining('Nguồn: Nguồn khác (FUTURE_SOURCE)'), findsOneWidget);
      expect(find.textContaining('Nguồn: Đồng hồ nghĩa vụ'), findsOneWidget);
      expect(find.textContaining('Nguồn: Kiểm soát vốn'), findsOneWidget);
    });

    testWidgets('three devices, 200 percent text: no overflow, tap targets and labels with the new lines on the cards', (WidgetTester tester) async {
      await expectScreenContract(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, _approvalStub], server: server, location: '/home'),
        healthy: (ScriptedServer server) {
          server
            ..on('GET', '/home/command-center', (_) => commandCenter())
            ..on('GET', '/home/my-work/counts', (_) => alertCounts(urgent: 1, action: 1, watch: 1))
            ..on(
              'GET',
              '/home/my-work',
              (_) => alertWork(<Map<String, Object?>>[
                alertItem('r-1', severity: 'URGENT', source: 'CLOCK', title: 'Nghĩa vụ báo cáo tuần quá hạn xử lý', lifecycle: 'CLAIMED', claimedBy: <String, Object?>{'name': 'Lê Văn B', 'at': '2026-11-03T01:30:00Z'}, extra: <String, Object?>{
                  'needs_reclaim': true,
                  'expected_action': 'Nhận lại và báo cáo tiến độ cho lãnh đạo',
                  'clocks': <String, Object?>{
                    'basis': 'WORKING_TIME',
                    'claim': <String, Object?>{'state': 'BREACHED', 'due_at': '2026-11-03T01:00:00Z'},
                    'resolve': <String, Object?>{'state': 'RUNNING', 'due_at': '2026-11-06T03:00:00Z'},
                  },
                  'reminders': <String, Object?>{'sent': 3, 'next_at': null, 'due': false, 'exhausted': true},
                }),
                alertItem('r-2', severity: 'ACTION', source: 'FUTURE_SOURCE', title: 'Việc có hoãn', extra: <String, Object?>{
                  'snooze': <String, Object?>{'until': '2026-11-03T10:00:00Z', 'reason_code': 'BLOCKED_BY_OTHER_WORK', 'ordinal': 2, 'of': 2, 'final': true},
                  'pause': <String, Object?>{'until': '2026-11-04T01:00:00Z', 'resumed_at': null},
                }),
                alertItem('r-3', severity: 'WATCH', title: 'Chưa có lịch', dueOn: null, extra: <String, Object?>{
                  'clocks': <String, Object?>{'basis': 'CALENDAR_UNAVAILABLE'},
                }),
              ]),
            );
        },
      );
    });
  });
}
