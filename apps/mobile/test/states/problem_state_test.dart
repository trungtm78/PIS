import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/api/problem.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/state/problem_state_view.dart';
import 'package:machvon_mobile/core/state/screen_state.dart';
import 'package:machvon_mobile/core/state/state_boundary.dart';

import '../support/harness.dart';
import '../support/widget_host.dart';

const String _correlation = '3f2b6c1e-0000-4000-8000-000000000001';

ApiError _problem(int status, String code) => ApiError(status: status, code: code, correlationId: _correlation);

void main() {
  group('AC-ST-MOB-001-2 UI-MOB-53 the failure as the user sees it', () {
    test('a service error keeps its code and the correlation id the server logged', () {
      final ProblemView view = ProblemView.from(_problem(500, 'INTERNAL_ERROR'));
      expect(view.state, ScreenState.error);
      expect(view.code, 'INTERNAL_ERROR');
      expect(view.correlationId, _correlation);
      expect(view.timedOut, isFalse);
    });

    test('a request without an answer is a time-out of the service while the device is not known to be offline', () {
      for (final Reachability reachability in <Reachability>[Reachability.unknown, Reachability.online]) {
        final ProblemView view = ProblemView.from(ApiError.network(_correlation), reachability: reachability);
        expect(view.state, ScreenState.error);
        expect(view.timedOut, isTrue);
        expect(view.code, 'NETWORK_ERROR');
        expect(view.correlationId, _correlation);
      }
    });

    test('a request without an answer is the offline state while the device is offline', () {
      final ProblemView view = ProblemView.from(ApiError.network(_correlation), reachability: Reachability.offline);
      expect(view.state, ScreenState.offline);
      expect(view.timedOut, isFalse);
    });

    test('the status and the code choose the state: session, licence, scope', () {
      expect(ProblemView.from(_problem(401, 'SESSION_EXPIRED')).state, ScreenState.signedOut);
      expect(ProblemView.from(_problem(401, 'UNAUTHENTICATED')).state, ScreenState.signedOut);
      expect(ProblemView.from(_problem(422, 'LICENSE_EXPIRED')).state, ScreenState.expired);
      expect(ProblemView.from(_problem(403, 'SCOPE_DENIED')).state, ScreenState.denied);
      expect(ProblemView.from(_problem(409, 'DRAFT_VERSION_CONFLICT')).state, ScreenState.error);
    });

    test('a response that does not match the contract and an unexpected exception are errors with their own code and no correlation id', () {
      final ProblemView mismatch = ProblemView.from(const ContractMismatch('X.id', 'is missing'));
      expect(mismatch.code, contractMismatchCode);
      expect(mismatch.correlationId, isNull);
      final ProblemView unexpected = ProblemView.from(StateError('boom'));
      expect(unexpected.code, clientErrorCode);
      expect(unexpected.state, ScreenState.error);
    });

    test('the text of the server and of an exception never reaches the view', () {
      final ProblemView view = ProblemView.from(
        const ApiError(status: 500, code: 'INTERNAL_ERROR', correlationId: _correlation, detail: 'secret stack trace at db.ts:12'),
      );
      expect(view.code, isNot(contains('secret')));
      expect(ProblemView.from(StateError('password=hunter2')).code, clientErrorCode);
    });

    test('a failed call through the client keeps the correlation id it sent and the server answered', () async {
      final FakeTransport server = FakeTransport(
        (HttpCall call) async => FakeTransport.json(
          503,
          <String, Object?>{'type': 'about:blank', 'title': 'x', 'status': 503, 'code': 'INTERNAL_ERROR'},
          headers: <String, String>{'x-correlation-id': _correlation},
        ),
      );
      final MachvonApiClient client = MachvonApiClient(baseUrl: testConfig.apiBaseUrl, transport: server, token: () async => 't');
      final Object error = await client.execute('getAuditOverview').then<Object>((Object? _) => 'no error', onError: (Object e) => e);
      expect(ProblemView.from(error).correlationId, _correlation);
    });

    test('a call that times out carries the correlation id of its own request', () async {
      final FakeTransport server = FakeTransport((HttpCall call) async => throw TimeoutException('slow'));
      final MachvonApiClient client = MachvonApiClient(baseUrl: testConfig.apiBaseUrl, transport: server, token: () async => 't');
      final Object error = await client.execute('getAuditOverview').then<Object>((Object? _) => 'no error', onError: (Object e) => e);
      final ProblemView view = ProblemView.from(error);
      expect(view.timedOut, isTrue);
      expect(view.correlationId, server.calls.single.headers['x-correlation-id']);
    });
  });

  group('AC-ST-MOB-001-2 UI-MOB-53 the shared error widget', () {
    testWidgets('a service error offers retry, shows the code and the correlation id, and retry calls back', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      int retries = 0;
      await tester.pumpWidget(
        hostWidget(ProblemStateView(problem: ProblemView.from(_problem(500, 'INTERNAL_ERROR')), onRetry: () => retries += 1)),
      );

      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget);
      expect(find.text('INTERNAL_ERROR'), findsOneWidget);
      expect(find.text(_correlation), findsOneWidget);
      await tester.tap(find.text('Thử lại'));
      expect(retries, 1);
    });

    testWidgets('a request time-out is told as a time-out, with retry and the correlation id', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await tester.pumpWidget(
        hostWidget(ProblemStateView(problem: ProblemView.from(ApiError.network(_correlation)), onRetry: () {})),
      );

      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget);
      expect(find.text('NETWORK_ERROR'), findsOneWidget);
      expect(find.text(_correlation), findsOneWidget);
      expect(find.text('Thử lại'), findsOneWidget);
    });

    testWidgets('the same words in English', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await tester.pumpWidget(
        hostWidget(ProblemStateView(problem: ProblemView.from(_problem(500, 'INTERNAL_ERROR')), onRetry: () {}), locale: const Locale('en')),
      );

      expect(find.text('Data could not be loaded'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
      expect(find.text('Error code'), findsOneWidget);
    });

    testWidgets('a failure that never reached the server shows no reference', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await tester.pumpWidget(hostWidget(const ProblemStateView(problem: ProblemView(state: ScreenState.error, code: clientErrorCode))));

      expect(find.text('Mã tham chiếu'), findsNothing);
      expect(find.text('Thử lại'), findsNothing);
    });

    testWidgets('the reference can be copied', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (MethodCall call) async {
        if (call.method == 'Clipboard.setData') copied = (call.arguments as Map<Object?, Object?>)['text'] as String?;
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      await tester.pumpWidget(hostWidget(ProblemStateView(problem: ProblemView.from(_problem(500, 'INTERNAL_ERROR')))));

      await tester.tap(find.text('Sao chép mã tham chiếu'));
      await tester.pumpAndSettle();

      expect(copied, _correlation);
      expect(find.text('Đã sao chép mã tham chiếu'), findsOneWidget);
    });

    testWidgets('it is one live region, so TalkBack and VoiceOver announce it with its code and reference', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final SemanticsHandle semantics = tester.ensureSemantics();
      await tester.pumpWidget(hostWidget(ProblemStateView(problem: ProblemView.from(_problem(500, 'INTERNAL_ERROR')), onRetry: () {})));

      final SemanticsNode node = tester.getSemantics(find.bySemanticsLabel(RegExp('Chưa thể tải dữ liệu')));
      expect(node.getSemanticsData().flagsCollection.isLiveRegion, isTrue);
      expect(node.label, contains('Chưa thể tải dữ liệu'));
      expect(node.label, contains('Mã lỗi: INTERNAL_ERROR'));
      expect(node.label, contains('Mã tham chiếu: $_correlation'));
      expect(find.bySemanticsLabel('Thử lại'), findsOneWidget, reason: 'retry stays a button of its own');
      semantics.dispose();
    });

    testWidgets('what the user typed survives an error and the retry', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      ScreenState state = ScreenState.defaultState;
      late StateSetter update;
      await tester.pumpWidget(
        hostWidget(
          StatefulBuilder(
            builder: (BuildContext context, StateSetter setState) {
              update = setState;
              return StateBoundary(
                state: state,
                problem: ProblemView.from(_problem(500, 'INTERNAL_ERROR')),
                onRetry: () => setState(() => state = ScreenState.defaultState),
                child: const Scaffold(body: TextField(key: Key('note'))),
              );
            },
          ),
        ),
      );
      await tester.enterText(find.byKey(const Key('note')), 'khối lượng 120 m3');

      update(() => state = ScreenState.error);
      await tester.pumpAndSettle();
      expect(find.text('INTERNAL_ERROR'), findsOneWidget);
      expect(find.byKey(const Key('note')), findsNothing, reason: 'hidden, not shown, behind the error');

      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('khối lượng 120 m3'), findsOneWidget, reason: 'the entered text is still in the field');
    });

    for (final Size size in kDeviceSizes) {
      testWidgets('${size.width.toInt()}x${size.height.toInt()} at 200 percent text: no overflow, contrast and tap targets pass', (WidgetTester tester) async {
        useDevice(tester, size, textScale: 2.0);
        final SemanticsHandle semantics = tester.ensureSemantics();
        await tester.pumpWidget(hostWidget(ProblemStateView(problem: ProblemView.from(_problem(500, 'INTERNAL_ERROR')), onRetry: () {})));

        expect(tester.takeException(), isNull);
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        semantics.dispose();
      });
    }
  });
}
