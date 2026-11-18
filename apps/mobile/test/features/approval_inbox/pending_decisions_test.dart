import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/tab_badges.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/widgets/bottom_nav.dart' show AppBottomNav;
import 'package:machvon_mobile/features/approval_inbox/approval_badge.dart';
import 'package:machvon_mobile/features/approval_inbox/approval_commands.dart';
import 'package:machvon_mobile/features/approval_inbox/approval_inbox_feature.dart' as approval;
import 'package:machvon_mobile/features/approval_inbox/approval_support.dart' show approvalsChangedProvider;
import 'package:machvon_mobile/features/approval_inbox/pending_decisions.dart';
import 'package:machvon_mobile/features/read_support/data_view.dart';
import 'package:machvon_mobile/features/read_support/loaded.dart';
import 'package:machvon_mobile/features/read_support/paged.dart' show ReadAbandoned;

import '../../support/harness.dart';
import '../support/screen_contract.dart' show kTallDevice;
import '../support/scripted_server.dart';
import 'approval_fixtures.dart';

const String _task = 'task-7';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server) => pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/approval');

/// The inbox with one task of the engine and the pending records given.
void _reads(ScriptedServer server, {List<Object?>? pending, List<String> unavailable = const <String>[]}) {
  server
    ..on('GET', '/resources/approval_task', (_) => page(<Object?>[approvalTask('t-1')]))
    ..on('GET', '/resources/organization_unit', (_) => unitsPage())
    ..on('GET', '/me/pending-decisions', (_) => pendingPage(pending ?? <Object?>[pendingCompletion(_task)], unavailable: unavailable));
}

HttpResult _decided(String status) => HttpResult(
      status: 200,
      headers: <String, String>{'content-type': 'application/json'},
      body: jsonEncode(<String, Object?>{'operation_id': '3f2b6c1e-0000-4000-8000-0000000000b2', 'status': status, 'resource_version': 5, 'resource_id': _task}),
    );

void main() {
  group('L9 the number on the Approvals tab is there as soon as the tabs are up', () {
    int reads(ScriptedServer server, String path) => server.callsTo('GET', path).length;

    testWidgets('on the home tab, before the Approvals tab was ever opened, the tab says how many wait; opening it then asks the server nothing more', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/home');
      expect(currentLocation(container), '/home');
      expect(find.text('2 việc chờ quyết định, 0 quá hạn'), findsNothing, reason: 'the inbox itself was not opened');
      expect(container.read(tabBadgeProvider)[AppTab.approval], 2, reason: 'one task of the engine and one record of PWF');
      expect(container.read(approvalBadgeProvider), 2);
      expect(find.descendant(of: find.byType(AppBottomNav), matching: find.text('2')), findsOneWidget, reason: 'the number is drawn on the tab');
      expect(<int>[reads(server, '/resources/approval_task'), reads(server, '/resources/organization_unit'), reads(server, '/me/pending-decisions')], <int>[1, 1, 1]);

      container.read(routerProvider).go('/approval');
      await tester.pumpAndSettle();
      expect(find.text('2 việc chờ quyết định, 0 quá hạn'), findsOneWidget);
      expect(find.text('Duyệt hoàn thành việc'), findsOneWidget);
      expect(<int>[reads(server, '/resources/approval_task'), reads(server, '/resources/organization_unit'), reads(server, '/me/pending-decisions')], <int>[1, 1, 1], reason: 'the inbox took the answer the tab already had');
    });

    testWidgets('it refreshes as before: a decision made on this device reads once more, for the tab and the open inbox together', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      List<Object?> pending = <Object?>[pendingCompletion(_task)];
      server
        ..on('GET', '/resources/approval_task', (_) => page(<Object?>[approvalTask('t-1')]))
        ..on('GET', '/resources/organization_unit', (_) => unitsPage())
        ..on('GET', '/me/pending-decisions', (_) => pendingPage(pending));
      final ProviderContainer container = await _open(tester, server);
      expect(container.read(tabBadgeProvider)[AppTab.approval], 2);
      expect(reads(server, '/resources/approval_task'), 1, reason: 'opening straight on the inbox is still one read');

      pending = <Object?>[];
      container.read(approvalsChangedProvider.notifier).bump();
      await tester.pumpAndSettle();
      expect(container.read(tabBadgeProvider)[AppTab.approval], 1);
      expect(find.text('1 việc chờ quyết định, 0 quá hạn'), findsOneWidget);
      expect(reads(server, '/resources/approval_task'), 2, reason: 'one read serves both');
    });

    testWidgets('a decision made while the inbox was never opened still corrects the number', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      List<Object?> tasks = <Object?>[approvalTask('t-1'), approvalTask('t-2')];
      server
        ..on('GET', '/resources/approval_task', (_) => page(tasks))
        ..on('GET', '/resources/organization_unit', (_) => unitsPage())
        ..on('GET', '/me/pending-decisions', (_) => pendingPage(<Object?>[]));
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/home');
      expect(container.read(tabBadgeProvider)[AppTab.approval], 2);
      tasks = <Object?>[approvalTask('t-2')];
      container.read(approvalsChangedProvider.notifier).bump();
      await tester.pumpAndSettle();
      expect(container.read(tabBadgeProvider)[AppTab.approval], 1);
    });

    testWidgets('a count that cannot be read shows no number (never a 0 that was not read), and the inbox then reads for itself and says why', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer()..refuse('GET', '/resources/approval_task', 500, 'INTERNAL_ERROR');
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/home');
      expect(container.read(tabBadgeProvider).containsKey(AppTab.approval), isFalse);
      expect(container.read(approvalBadgeProvider), isNull);
      expect(tester.takeException(), isNull);

      container.read(routerProvider).go('/approval');
      await tester.pumpAndSettle();
      expect(find.textContaining('INTERNAL_ERROR'), findsWidgets, reason: 'the state of the inbox is its own');
      expect(reads(server, '/resources/approval_task'), 2, reason: 'the failed early answer is not handed over');
    });

    testWidgets('the answer of the start is handed to the inbox only while it is fresh: opened later than the bound, the inbox reads for itself', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      DateTime now = DateTime.utc(2026, 11, 3, 3);
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/home', now: () => now);
      expect(container.read(tabBadgeProvider)[AppTab.approval], 2);
      expect(reads(server, '/resources/approval_task'), 1);

      now = now.add(approvalEarlyAnswerMaxAge + const Duration(seconds: 1));
      container.read(routerProvider).go('/approval');
      await tester.pumpAndSettle();
      expect(find.text('2 việc chờ quyết định, 0 quá hạn'), findsOneWidget);
      expect(<int>[reads(server, '/resources/approval_task'), reads(server, '/resources/organization_unit'), reads(server, '/me/pending-decisions')], <int>[2, 2, 2], reason: 'an answer older than the bound is not shown as the list of now');
    });

    testWidgets('at the bound itself the answer is still taken, and it is handed over once only', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      DateTime now = DateTime.utc(2026, 11, 3, 3);
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/home', now: () => now);
      now = now.add(approvalEarlyAnswerMaxAge);
      final Object? first = await container.read(approvalBadgeProvider.notifier).readForInbox(container.read(apiClientProvider));
      expect(first, isA<FetchedEarlier>());
      expect((first! as FetchedEarlier).fetchedAt, DateTime.utc(2026, 11, 3, 3), reason: 'the moment it was really fetched, not the moment it was taken');
      expect(reads(server, '/resources/approval_task'), 1);
      final Object? second = await container.read(approvalBadgeProvider.notifier).readForInbox(container.read(apiClientProvider));
      expect(second, isNot(isA<FetchedEarlier>()), reason: 'the second ask is a read of its own');
      expect(reads(server, '/resources/approval_task'), 2);
    });

    testWidgets('a screen that is handed an answer fetched earlier says and keeps the time it was fetched, not "just now"', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final DateTime fetched = DateTime.utc(2026, 11, 3, 2, 59, 40);
      DateTime? shown;
      final MobileFeature stub = MobileFeature(
        id: 'stub',
        screens: <ScreenSpec>[
          ScreenSpec(
            screenId: 'MOB-23',
            builder: (BuildContext context, ScreenContext screen) => Material(
              child: DataView<String>(
                cacheKey: 'stub.earlier',
                read: (MachvonApiClient client) async => FetchedEarlier(const <String, Object?>{'word': 'đã đọc'}, fetched),
                parse: (Object? raw) => raw is Map<String, Object?> ? raw['word'] as String? : null,
                onLoaded: (Loaded<String> loaded) => shown = loaded.fetchedAt,
                builder: (BuildContext context, Loaded<String> loaded) => Text(loaded.value),
              ),
            ),
          ),
        ],
      );
      await pumpWithServer(tester, features: <MobileFeature>[stub], server: ScriptedServer(), location: '/approval', now: () => DateTime.utc(2026, 11, 3, 3));
      expect(find.text('đã đọc'), findsOneWidget, reason: 'the answer inside the wrapper is what is parsed');
      expect(shown, fetched);
      expect(find.textContaining(formatFetched(fetched)), findsOneWidget, reason: 'the line of the screen says the moment the phone got the answer');
    });

    testWidgets('a read of several requests asks nothing more once the person signed out', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Completer<void> hold = Completer<void>();
      final ScriptedServer server = ScriptedServer()
        ..answer('GET', '/resources/approval_task', (HttpCall call) async {
          await hold.future;
          return FakeTransport.json(200, page(<Object?>[approvalTask('t-1')]));
        })
        ..on('GET', '/resources/organization_unit', (_) => unitsPage())
        ..on('GET', '/me/pending-decisions', (_) => pendingPage(<Object?>[]));
      final FakeSession session = FakeSession();
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/home', session: session);
      expect(reads(server, '/resources/approval_task'), 1, reason: 'the first request is out, the others wait for it');

      session.change(const SessionSnapshot.signedOut());
      await tester.pump();
      hold.complete();
      await tester.pumpAndSettle();
      expect(<int>[reads(server, '/resources/approval_task'), reads(server, '/resources/organization_unit'), reads(server, '/me/pending-decisions')], <int>[1, 0, 0], reason: 'neither the names of the units nor the pending records are asked for after the sign-out');
      expect(container.read(approvalBadgeProvider), isNull);
      expect(container.read(tabBadgeProvider)[AppTab.approval], 0);

      // The inbox asks for nothing either while nobody is signed in: no read of its own starts.
      await expectLater(container.read(approvalBadgeProvider.notifier).readForInbox(container.read(apiClientProvider)), throwsA(isA<ReadAbandoned>()));
      expect(reads(server, '/resources/approval_task'), 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('after a change of organisation the read of the old one stops, its answer counts for nothing, and the new one is read whole', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final Completer<void> hold = Completer<void>();
      int taskReads = 0;
      final ScriptedServer server = ScriptedServer()
        ..answer('GET', '/resources/approval_task', (HttpCall call) async {
          taskReads += 1;
          if (taskReads == 1) {
            await hold.future;
            return FakeTransport.json(200, page(<Object?>[approvalTask('t-1'), approvalTask('t-2'), approvalTask('t-3')]));
          }
          return FakeTransport.json(200, page(<Object?>[approvalTask('t-9')]));
        })
        ..on('GET', '/resources/organization_unit', (_) => unitsPage())
        ..on('GET', '/me/pending-decisions', (_) => pendingPage(<Object?>[]));
      final FakeSession session = FakeSession();
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/home', session: session);
      session.change(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-b', userId: 'user-1', membershipId: 'm-b'));
      await tester.pumpAndSettle();
      expect(container.read(tabBadgeProvider)[AppTab.approval], 1, reason: 'the count of the new organisation');
      hold.complete();
      await tester.pumpAndSettle();
      expect(container.read(tabBadgeProvider)[AppTab.approval], 1, reason: 'the late answer of the old organisation (3) changes nothing');
      expect(<int>[reads(server, '/resources/approval_task'), reads(server, '/resources/organization_unit'), reads(server, '/me/pending-decisions')], <int>[2, 1, 1], reason: 'the old read asked for nothing after its first request');

      // The inbox opened now takes the answer of the new organisation, never the old one.
      container.read(routerProvider).go('/approval');
      await tester.pumpAndSettle();
      expect(find.text('1 việc chờ quyết định, 0 quá hạn'), findsOneWidget);
      expect(reads(server, '/resources/approval_task'), 2);
    });

    testWidgets('a sign-out clears the number', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final FakeSession session = FakeSession();
      final ProviderContainer container = await pumpWithServer(tester, features: <MobileFeature>[approval.feature], server: server, location: '/home', session: session);
      expect(container.read(tabBadgeProvider)[AppTab.approval], 2);
      session.change(const SessionSnapshot.signedOut());
      await tester.pump();
      expect(container.read(tabBadgeProvider)[AppTab.approval], 0);
      expect(container.read(approvalBadgeProvider), isNull);
    });
  });

  group('PWF 20.9 the unified approval inbox on the phone', () {
    testWidgets('lists the records of PWF beside the tasks of the engine, counts them in the badge and the line of counts', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server);

      expect(find.text('Việc khác chờ bạn quyết định'), findsOneWidget);
      expect(find.text('Duyệt hoàn thành việc'), findsOneWidget);
      expect(find.textContaining('Đường vành đai 1'), findsOneWidget, reason: 'the row says the project');
      expect(find.textContaining('Người trình: Nguyễn Văn An'), findsOneWidget);
      expect(find.text('2 việc chờ quyết định, 0 quá hạn'), findsOneWidget);
      expect(container.read(tabBadgeProvider)[AppTab.approval], 2);
      expect(server.callsTo('GET', '/me/pending-decisions'), hasLength(1));
    });

    testWidgets('the sheet reads the record in full and approving calls the command of PWF under the version of the item, once', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/project-tasks/$_task/approve-completion', (HttpCall call) => _decided('DONE'));
      await _open(tester, server);

      await tester.tap(find.text('Duyệt hoàn thành việc'));
      await tester.pumpAndSettle();
      expect(find.text('Lập hồ sơ dự toán'), findsOneWidget, reason: 'the task');
      expect(find.text('20/11/2026'), findsOneWidget, reason: 'the day is a day, not a code');
      expect(find.text('Đã đủ chứng từ, đề nghị duyệt hoàn thành.'), findsOneWidget);
      expect(find.text('Nguyễn Văn An'), findsWidgets);

      await tester.tap(find.widgetWithText(FilledButton, 'Duyệt'));
      await tester.pumpAndSettle();

      final List<HttpCall> calls = server.callsTo('POST', '/project-tasks/$_task/approve-completion');
      expect(calls, hasLength(1));
      expect(calls.single.headers['if-match'], '"4"');
      expect(calls.single.headers['idempotency-key'], isNotEmpty);
      expect(jsonDecode(calls.single.body!), <String, Object?>{'decision': 'APPROVE'});
      expect(find.text('Đã ghi nhận quyết định'), findsOneWidget);
    });

    testWidgets('a return asks for its reason first, then goes to returnProjectTask with the words', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.answer('POST', '/project-tasks/$_task/return', (HttpCall call) => _decided('IN_PROGRESS'));
      await _open(tester, server);

      await tester.tap(find.text('Duyệt hoàn thành việc'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.widgetWithText(OutlinedButton, 'Trả lại'));
      await tester.tap(find.widgetWithText(OutlinedButton, 'Trả lại'));
      await tester.pumpAndSettle();
      expect(find.text('Hãy ghi lý do.'), findsOneWidget);
      expect(server.callsTo('POST', '/project-tasks/$_task/return'), isEmpty, reason: 'nothing is sent without the reason');

      await tester.enterText(find.byType(TextField), 'Thiếu chữ ký của tư vấn giám sát');
      await tester.tap(find.widgetWithText(OutlinedButton, 'Trả lại'));
      await tester.pumpAndSettle();
      expect(jsonDecode(server.callsTo('POST', '/project-tasks/$_task/return').single.body!), <String, Object?>{'reason': 'Thiếu chữ ký của tư vấn giám sát'});
    });

    testWidgets('the refusal of a maker is said in words and the record stays; a source that failed is named, not shown as nothing waiting', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server, unavailable: <String>['PWF']);
      server.refuse('POST', '/project-tasks/$_task/approve-completion', 403, 'MAKER_IS_APPROVER');
      await _open(tester, server);

      expect(find.byKey(const ValueKey<String>('pending-unavailable')), findsOneWidget);
      await tester.tap(find.text('Duyệt hoàn thành việc'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Duyệt'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn đã tham gia làm việc này nên không thể duyệt'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Duyệt'), findsOneWidget, reason: 'a refusal never removes the form: the record stays to be decided by someone else');
    });

    testWidgets('an inbox of pending records only is not empty, and a failed read of them is named', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/resources/approval_task', (_) => page(<Object?>[]))
        ..on('GET', '/resources/organization_unit', (_) => unitsPage())
        ..refuse('GET', '/me/pending-decisions', 500, 'INTERNAL_ERROR');
      await _open(tester, server);
      expect(find.byKey(const ValueKey<String>('pending-unavailable')), findsOneWidget);
    });
  });

  group('the model of the pending records', () {
    test('reads an item with its summary and the commands it names, and drops what it cannot name', () {
      final PendingDecision? item = parsePendingDecision(pendingCompletion(_task));
      expect(item, isNotNull);
      expect(item!.version, 4);
      expect(item.actions.map((PendingAction one) => one.operationId), <String>['approveProjectTaskCompletion', 'returnProjectTask']);
      expect(item.summary.projectName, 'Đường vành đai 1');
      final Map<String, Object?> other = <String, Object?>{
        ...pendingCompletion(_task),
        'actions': <Object?>[
          <String, Object?>{'decision': 'approve', 'operation_id': 'somethingElse', 'reason_required': false},
        ],
      };
      expect(parsePendingDecision(other)!.actions, isEmpty, reason: 'an operation the phone does not know offers no button');
      expect(parsePendingDecision(<String, Object?>{'id': 'x'}), isNull);
    });

    test('checks the words against the limits of the command', () {
      const PendingAction back = PendingAction(choice: PendingChoice.returnBack, operationId: 'returnProjectTask', reasonRequired: true, reasonMin: 20, reasonMax: 500);
      const PendingAction ok = PendingAction(choice: PendingChoice.approve, operationId: 'approveProjectTaskCompletion', reasonRequired: false, reasonMin: 5, reasonMax: 500);
      expect(checkPendingWords(back, '  '), PendingWords.required);
      expect(checkPendingWords(back, 'ngắn quá'), PendingWords.tooShort);
      expect(checkPendingWords(ok, ''), isNull);
      expect(checkPendingWords(ok, 'x' * 501), PendingWords.tooLong);
    });

    test('maps the refusals of the commands of PWF', () {
      expect(pendingProblemOf('MAKER_IS_APPROVER'), DecisionProblem.maker);
      expect(pendingProblemOf('PWF_SCHEDULE_VERSION_CONFLICT'), DecisionProblem.moved);
      expect(pendingProblemOf('SELF_APPROVAL_DENIED'), DecisionProblem.selfApproval);
    });
  });
}
