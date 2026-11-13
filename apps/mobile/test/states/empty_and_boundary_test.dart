import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/api/problem.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/state/empty_state_view.dart';
import 'package:machvon_mobile/core/state/screen_state.dart';
import 'package:machvon_mobile/core/state/state_boundary.dart';
import 'package:machvon_mobile/core/widgets/work_row.dart';
import 'package:machvon_mobile/features/foundation/foundation_feature.dart' as foundation;

import '../support/harness.dart';
import '../support/widget_host.dart';

const String _correlation = '3f2b6c1e-0000-4000-8000-000000000002';

void main() {
  group('UI-MOB-52 the empty state', () {
    testWidgets('without a filter it says what to do next and offers nothing to clear', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await tester.pumpWidget(hostWidget(const EmptyStateView()));

      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.text('Điều chỉnh bộ lọc hoặc tạo bản ghi đầu tiên.'), findsOneWidget);
      expect(find.text('Xóa bộ lọc'), findsNothing);
    });

    testWidgets('with filters it names them and clears them on request', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      int cleared = 0;
      await tester.pumpWidget(hostWidget(EmptyStateView(activeFilters: const <String>['Đang thực hiện', 'Cao Bằng'], onClearFilters: () => cleared += 1)));

      expect(find.text('Đang thực hiện'), findsOneWidget);
      expect(find.text('Cao Bằng'), findsOneWidget);
      await tester.tap(find.text('Xóa bộ lọc'));
      expect(cleared, 1);
    });

    testWidgets('the filters are in the announcement, and a filter without a handler offers no button', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final SemanticsHandle semantics = tester.ensureSemantics();
      await tester.pumpWidget(hostWidget(const EmptyStateView(activeFilters: <String>['Đang thực hiện'])));

      expect(find.text('Xóa bộ lọc'), findsNothing);
      final SemanticsNode node = tester.getSemantics(find.bySemanticsLabel(RegExp('Chưa có dữ liệu')));
      expect(node.label, contains('Bộ lọc đang áp dụng: Đang thực hiện'));
      expect(node.getSemanticsData().flagsCollection.isLiveRegion, isTrue);
      semantics.dispose();
    });

    for (final Size size in kDeviceSizes) {
      testWidgets('${size.width.toInt()}x${size.height.toInt()} at 200 percent text: no overflow, contrast and tap targets pass', (WidgetTester tester) async {
        useDevice(tester, size, textScale: 2.0);
        final SemanticsHandle semantics = tester.ensureSemantics();
        await tester.pumpWidget(hostWidget(EmptyStateView(activeFilters: const <String>['Đang thực hiện'], onClearFilters: () {})));

        expect(tester.takeException(), isNull);
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        semantics.dispose();
      });
    }
  });

  group('UI-MOB-52 UI-MOB-53 the screens MOB-52 and MOB-53 open from the router', () {
    testWidgets('MOB-52 opens under the Profile tab', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, features: <MobileFeature>[foundation.feature], location: '/account/mob-52');

      expect(currentLocation(container), '/account/mob-52');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
    });

    testWidgets('MOB-52 names the filter it is given', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await pumpApp(tester, features: <MobileFeature>[foundation.feature], location: '/account/mob-52?filter=Active');

      expect(find.text('Active'), findsOneWidget);
    });

    testWidgets('MOB-53 shows the failure it is given with its code and reference, and retry goes back', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, features: <MobileFeature>[foundation.feature], location: '/account');
      final router = container.read(routerProvider);

      unawaited(router.push('/account/mob-53', extra: ProblemView.from(const ApiError(status: 500, code: 'INTERNAL_ERROR', correlationId: _correlation))));
      await tester.pumpAndSettle();
      expect(find.text('INTERNAL_ERROR'), findsOneWidget);
      expect(find.text(_correlation), findsOneWidget);

      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/account');
    });

    testWidgets('MOB-53 opened without a failure shows a generic one, and retry goes back to the Profile root', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, features: <MobileFeature>[foundation.feature], location: '/account/mob-53');

      expect(find.text('CLIENT_ERROR'), findsOneWidget);
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/account');
    });

    testWidgets('a location that matches no screen shows the error with retry to Home', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, features: <MobileFeature>[foundation.feature], location: '/nowhere');

      expect(find.text('ROUTE_NOT_FOUND'), findsOneWidget);
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home');
    });
  });

  group('UI-MOB-52 UI-MOB-53 the eight states of a screen', () {
    Future<void> pumpState(WidgetTester tester, ScreenState state, {ProblemView? problem, VoidCallback? onRetry}) {
      return tester.pumpWidget(
        hostWidget(StateBoundary(state: state, problem: problem, onRetry: onRetry, child: const Text('content'))),
      );
    }

    testWidgets('default shows the content only', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await pumpState(tester, ScreenState.defaultState);

      expect(find.text('content'), findsOneWidget);
      expect(find.text('Chưa có dữ liệu'), findsNothing);
    });

    testWidgets('loading shows seven skeleton rows announced as loading, and hides the content', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final SemanticsHandle semantics = tester.ensureSemantics();
      await pumpState(tester, ScreenState.loading);

      expect(find.text('content'), findsNothing);
      expect(find.byType(WorkRowSkeleton), findsNWidgets(7));
      expect(find.bySemanticsLabel('Đang tải'), findsOneWidget);
      semantics.dispose();
    });

    for (final (ScreenState state, String title) in <(ScreenState, String)>[
      (ScreenState.empty, 'Chưa có dữ liệu'),
      (ScreenState.error, 'Chưa thể tải dữ liệu'),
      (ScreenState.denied, 'Bạn chưa có quyền truy cập'),
      (ScreenState.expired, 'License đã hết hạn'),
      (ScreenState.signedOut, 'Phiên làm việc đã hết hạn'),
      (ScreenState.offline, 'Bạn đang ngoại tuyến'),
    ]) {
      testWidgets('${state.name} shows its title and keeps the content out of sight', (WidgetTester tester) async {
        useDevice(tester, kDeviceSizes[1]);
        await pumpState(tester, state);

        expect(find.text(title), findsOneWidget);
        expect(find.text('content'), findsNothing);
        expect(find.text('Thử lại'), findsNothing, reason: 'no retry without a handler');
      });
    }

    testWidgets('a failure that is given decides the wording and offers retry', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      int retries = 0;
      await pumpState(
        tester,
        ScreenState.error,
        problem: ProblemView.from(ApiError.network(_correlation)),
        onRetry: () => retries += 1,
      );

      expect(find.text('Máy chủ phản hồi quá chậm'), findsOneWidget);
      await tester.tap(find.text('Thử lại'));
      expect(retries, 1);
    });

    testWidgets('a screen that cannot build its content before its data arrives leaves it out of the tree', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      await tester.pumpWidget(
        hostWidget(const StateBoundary(state: ScreenState.loading, keepContent: false, child: Text('content'))),
      );

      expect(find.text('content', skipOffstage: false), findsNothing);
    });
  });
}
