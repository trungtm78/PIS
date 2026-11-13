import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/core/navigation/tab_badges.dart';
import 'package:machvon_mobile/core/security/device_integrity.dart';
import 'package:machvon_mobile/core/security/integrity_state.dart';
import 'package:machvon_mobile/core/sync/sync_status.dart';
import 'package:machvon_mobile/core/widgets/bottom_nav.dart';

import '../support/harness.dart';
import '../support/list_feature.dart';

const Map<AppTab, String> _viLabels = <AppTab, String>{
  AppTab.home: 'Trang chủ',
  AppTab.projects: 'Dự án',
  AppTab.approval: 'Phê duyệt',
  AppTab.inbox: 'Thông báo',
  AppTab.account: 'Cá nhân',
};

Finder _tab(AppTab tab) => find.descendant(of: find.byType(AppBottomNav), matching: find.text(_viLabels[tab]!));

double _scrollOffset(WidgetTester tester) => tester.state<ScrollableState>(find.descendant(of: find.byKey(const Key('project-list')), matching: find.byType(Scrollable))).position.pixels;

void main() {
  group('AC-ST-MOB-001-1 UI-MOB-52 the five-tab shell', () {
    for (final Size size in kDeviceSizes) {
      for (final double scale in <double>[1.0, 2.0]) {
        testWidgets('${size.width.toInt()}x${size.height.toInt()} at text scale $scale: every tab opens with no overflow and the state of a tab survives', (WidgetTester tester) async {
          useDevice(tester, size, textScale: scale);
          await pumpApp(tester, features: const [listFeature]);

          expect(find.byType(AppBottomNavItem), findsNWidgets(5));
          for (final AppTab tab in AppTab.values) {
            await tester.tap(_tab(tab));
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull, reason: '${tab.name} overflowed');
          }

          await tester.tap(_tab(AppTab.projects));
          await tester.pumpAndSettle();
          await tester.tap(find.text(filterLabel));
          await tester.drag(find.byKey(const Key('project-list')), const Offset(0, -600));
          await tester.pumpAndSettle();
          final double scrolled = _scrollOffset(tester);
          expect(scrolled, greaterThan(0));

          await tester.tap(_tab(AppTab.approval));
          await tester.pumpAndSettle();
          await tester.tap(_tab(AppTab.projects));
          await tester.pumpAndSettle();

          expect(_scrollOffset(tester), scrolled, reason: 'the scroll position is restored after another tab was open');
          expect(tester.widget<FilterChip>(find.byType(FilterChip)).selected, isTrue, reason: 'the filter is restored');
          expect(tester.takeException(), isNull);
        });
      }
    }

    testWidgets('back from a detail screen returns to the list at the same scroll position with the same filter', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, features: const [listFeature], location: '/projects');
      await tester.tap(find.text(filterLabel));
      await tester.drag(find.byKey(const Key('project-list')), const Offset(0, -900));
      await tester.pumpAndSettle();
      final double scrolled = _scrollOffset(tester);

      await tester.tap(find.text('Project 20'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-10/p20');
      expect(find.text('detail p20'), findsOneWidget);

      await pressBack(tester);

      expect(currentLocation(container), '/projects');
      expect(_scrollOffset(tester), scrolled);
      expect(tester.widget<FilterChip>(find.byType(FilterChip)).selected, isTrue);
    });

    testWidgets('back on the root of another tab goes to Home, and only back on Home leaves the application', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, features: const [listFeature]);
      await tester.tap(_tab(AppTab.inbox));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/inbox');

      await pressBack(tester);

      expect(currentLocation(container), '/home');
      expect(tester.widget<AppBottomNav>(find.byType(AppBottomNav)).selectedIndex, AppTab.home.index);
    });

    testWidgets('tapping the open tab again returns to its root', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester, features: const [listFeature], location: '/projects/mob-10/p3');
      expect(find.text('detail p3'), findsOneWidget);

      await tester.tap(_tab(AppTab.projects));
      await tester.pumpAndSettle();

      expect(currentLocation(container), '/projects');
    });

    for (final TargetPlatform platform in <TargetPlatform>[TargetPlatform.iOS, TargetPlatform.android]) {
      testWidgets('every tap target of the shell is at least ${platform == TargetPlatform.iOS ? '44 pt' : '48 dp'} on $platform', (WidgetTester tester) async {
        debugDefaultTargetPlatformOverride = platform;
        try {
          useDevice(tester, kDeviceSizes[0], textScale: 2.0);
          await pumpApp(tester, features: const [listFeature], location: '/projects');
          final double minimum = platform == TargetPlatform.iOS ? 44 : 48;

          for (final Element destination in find.byType(AppBottomNavItem).evaluate()) {
            final Size size = tester.getSize(find.byElementPredicate((Element element) => element == destination));
            expect(size.width, greaterThanOrEqualTo(minimum));
            expect(size.height, greaterThanOrEqualTo(minimum));
          }
          await expectLater(tester, platform == TargetPlatform.iOS ? meetsGuideline(iOSTapTargetGuideline) : meetsGuideline(androidTapTargetGuideline));
          await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        } finally {
          debugDefaultTargetPlatformOverride = null;
        }
      });
    }
  });

  group('AC-ST-MOB-001-1 UI-MOB-52 banners and badges of the shell', () {
    testWidgets('a badge shows the count and says it to a screen reader', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester);
      container.read(tabBadgeProvider.notifier).set(AppTab.approval, 3);
      await tester.pumpAndSettle();

      expect(find.text('3'), findsOneWidget);
      final SemanticsHandle semantics = tester.ensureSemantics();
      expect(tester.getSemantics(find.byType(AppBottomNavItem).at(AppTab.approval.index)).getSemanticsData().hint, '3 mục cần xử lý');
      semantics.dispose();
    });

    // UAT run r6, R6-PUB-03 (AC-ST-MOB-040-1, UAT-NFR-ACCESSIBILITY-02): the name of a tab with a badge began with the badge ("10 mục cần xử lý, 10, Thông báo, Tab 4 trong tổng số 5"), so the tab
    // could not be found by the name it shows (Maestro flow 10 looks for "Thông báo.*") and a screen reader said the number twice before the name.
    testWidgets('the name of a tab with a badge starts with the label on the screen and says the count once, after it', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester);
      container.read(tabBadgeProvider.notifier).set(AppTab.inbox, 10);
      await tester.pumpAndSettle();

      final SemanticsData inbox = tester.getSemantics(find.byType(AppBottomNavItem).at(AppTab.inbox.index)).getSemanticsData();
      expect(inbox.label, startsWith(_viLabels[AppTab.inbox]!), reason: 'the visible label is the first thing a reader hears and the first thing a test can match');
      expect(inbox.label, matches(RegExp('^${_viLabels[AppTab.inbox]}.*', dotAll: true)));
      expect(inbox.label, isNot(contains('10')), reason: 'the number drawn on the badge is not read as a word of its own');
      expect(inbox.label, isNot(contains('mục cần xử lý')), reason: 'what the count means is the hint, read after the name');
      expect(inbox.hint, '10 mục cần xử lý');

      // A tab with no number says nothing more than its name and its place.
      final SemanticsData projects = tester.getSemantics(find.byType(AppBottomNavItem).at(AppTab.projects.index)).getSemanticsData();
      expect(projects.label, startsWith(_viLabels[AppTab.projects]!));
      expect(projects.hint, isEmpty);
      semantics.dispose();
    });

    testWidgets('a count above 99 is drawn as 99+ and said in full', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester);
      container.read(tabBadgeProvider.notifier).set(AppTab.approval, 120);
      await tester.pumpAndSettle();

      expect(find.text('99+'), findsOneWidget);
      final SemanticsData approval = tester.getSemantics(find.byType(AppBottomNavItem).at(AppTab.approval.index)).getSemanticsData();
      expect(approval.label, startsWith(_viLabels[AppTab.approval]!));
      expect(approval.hint, '120 mục cần xử lý');
      semantics.dispose();
    });

    testWidgets('the offline banner appears while the device is offline and disappears when it is back', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester);
      expect(find.textContaining('Bạn đang ngoại tuyến'), findsNothing);

      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn đang ngoại tuyến'), findsOneWidget);

      container.read(reachabilityProvider.notifier).report(Reachability.online);
      await tester.pumpAndSettle();
      expect(find.textContaining('Bạn đang ngoại tuyến'), findsNothing);
    });

    testWidgets('the sync banner counts the pending commands, and a conflict takes its place', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester);
      container.read(syncStatusProvider.notifier).update(const SyncStatus(pendingCommands: 2));
      await tester.pumpAndSettle();
      expect(find.text('2 thay đổi đang chờ gửi'), findsOneWidget);

      container.read(syncStatusProvider.notifier).update(const SyncStatus(pendingCommands: 2, conflicts: 1));
      await tester.pumpAndSettle();
      expect(find.text('2 thay đổi đang chờ gửi'), findsNothing);
      expect(find.text('1 thay đổi cần bạn chọn cách xử lý xung đột'), findsOneWidget);
    });

    testWidgets('AC-ST-MOB-040-3 NAV-01 the sync banner is a button: it opens the send queue (MOB-41), and the offline banner is not a button', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester);
      container.read(reachabilityProvider.notifier).report(Reachability.offline);
      container.read(syncStatusProvider.notifier).update(const SyncStatus(pendingCommands: 2));
      await tester.pumpAndSettle();
      expect(find.ancestor(of: find.textContaining('Bạn đang ngoại tuyến'), matching: find.byType(InkWell)), findsNothing);
      expect(find.ancestor(of: find.text('2 thay đổi đang chờ gửi'), matching: find.byType(InkWell)), findsOneWidget);

      await tester.tap(find.text('2 thay đổi đang chờ gửi'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/account/mob-41');

      await tester.tap(find.text('2 thay đổi đang chờ gửi'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/account/mob-41');
      await pressBack(tester);
      expect(currentLocation(container), '/account', reason: 'one back press leaves the queue for the tab: the banner did not stack a second copy');
    });

    testWidgets('AC-ST-MOB-040-3 NAV-01 the conflict banner opens the queue too', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester);
      container.read(syncStatusProvider.notifier).update(const SyncStatus(conflicts: 1));
      await tester.pumpAndSettle();
      await tester.tap(find.text('1 thay đổi cần bạn chọn cách xử lý xung đột'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/account/mob-41');
    });

    testWidgets('AC-ST-MOB-041-1 INTEG-01 a phone that looks modified is told once: the notice says what changes, and closing it keeps it closed', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester);
      expect(find.textContaining('có dấu hiệu đã bị can thiệp'), findsNothing);

      container.read(integrityProvider.notifier).apply(decideIntegrity(const IntegritySignals(jailbroken: true), IntegrityMode.warn, releaseBuild: true));
      await tester.pumpAndSettle();
      expect(find.textContaining('Hãy thận trọng với dữ liệu công việc'), findsOneWidget);

      container.read(integrityProvider.notifier).apply(decideIntegrity(const IntegritySignals(jailbroken: true), IntegrityMode.restrictSensitive, releaseBuild: true));
      await tester.pumpAndSettle();
      expect(find.textContaining('Phê duyệt và ký cần xác thực hai yếu tố'), findsOneWidget);

      await tester.tap(find.text('Đã hiểu'));
      await tester.pumpAndSettle();
      expect(find.textContaining('có dấu hiệu đã bị can thiệp'), findsNothing);
    });

    testWidgets('the interface follows the language of the locale provider', (WidgetTester tester) async {
      useDevice(tester, kDeviceSizes[1]);
      final container = await pumpApp(tester);
      container.read(localeProvider.notifier).select(const Locale('en'));
      await tester.pumpAndSettle();

      expect(find.text('Projects'), findsOneWidget);
      expect(find.text('Dự án'), findsNothing);
    });
  });
}
