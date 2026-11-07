import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/navigation/mobile_routes.generated.dart';
import 'package:machvon_mobile/core/navigation/route_catalogue.dart';
import 'package:machvon_mobile/features/directives/directives_feature.dart' as directives;
import 'package:machvon_mobile/features/directives/directives_strings.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'directive_fixtures.dart';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, {DateTime Function()? now}) =>
    pumpWithServer(tester, features: <MobileFeature>[directives.feature], server: server, location: '/projects/dir-06', now: now);

void _register(ScriptedServer server, {List<Map<String, Object?>>? items, Map<String, Object?>? summary}) {
  server
    ..on('GET', '/directives', (_) => directivePage(items ?? threeDirectives))
    ..on('GET', '/directives/summary', (_) => summary ?? directiveSummary());
}

Finder _chip(String label) => find.widgetWithText(ChoiceChip, label);

void main() {
  group('DIR-06 is a screen of the Projects tab that the catalogue and the feature agree on', () {
    test('the route is in the catalogue on the Projects tab and the feature builds it', () {
      final MobileRoute route = kMobileRoutes.firstWhere((MobileRoute r) => r.id == 'DIR-06');
      expect(route.tab, AppTab.projects);
      expect(route.requirement, 'FR-DIR-06');
      expect(directives.feature.screens.map((ScreenSpec s) => s.screenId), <String>['DIR-06']);
    });

    test('both languages carry the same keys, each in the shape of a key of the application', () {
      expect(directivesStrings.vi.keys.toSet(), directivesStrings.en.keys.toSet());
      expect(directivesStrings.vi.keys.every((String key) => key.startsWith('mob.dir.')), isTrue);
    });
  });

  group('AC-DIR-06-1 UI-DIR-06 the counts and the list of the directives', () {
    testWidgets('opens on what is given to the reader, asks the server for it, and shows the counts with how they are counted', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server);

      expect(server.callsTo('GET', '/directives').single.url.queryParameters, <String, String>{'limit': '50', 'assigned_to_me': 'true'});
      expect(find.text('Chỉ đạo trong phạm vi của bạn'), findsOneWidget);
      expect(find.text('Quá hạn'), findsWidgets);
      expect(find.text('Sắp đến hạn'), findsOneWidget);
      expect(find.text('Đã báo lãnh đạo đơn vị'), findsOneWidget);
      expect(find.text('Đang mở hoặc đang thực hiện'), findsOneWidget);
      expect(find.text('Hiển thị 3 chỉ đạo'), findsOneWidget);
      expect(find.text('Số liệu tại 08/11/2026 10:00'), findsWidgets);

      await tester.tap(find.text('Cách tính các số'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Chỉ đạo đang mở mà hạn trước ngày hôm nay'), findsOneWidget);
      expect(find.textContaining('Chỉ đạo quá hạn từ 7 ngày trở lên.'), findsOneWidget);
      expect(find.textContaining('chưa kiểm chứng với khách hàng và kiểm toán'), findsOneWidget);
      expect(find.textContaining('mới nhất'), findsNothing);
    });

    testWidgets('a confirmed policy does not say it is unconfirmed', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server, summary: directiveSummary(unverified: false));
      await _open(tester, server);

      await tester.tap(find.text('Cách tính các số'));
      await tester.pumpAndSettle();
      expect(find.textContaining('chưa kiểm chứng'), findsNothing);
    });

    testWidgets('each row says the directive, who does it, the day and the clock the server counted: late and raised, due soon, in progress', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server);

      expect(find.text('GB-2026-014/CD-01'), findsOneWidget);
      expect(find.text('Hoàn thành thủ tục giải phóng mặt bằng đoạn km3.'), findsOneWidget);
      expect(find.text('Quá hạn 10 ngày, đã báo lãnh đạo đơn vị'), findsOneWidget);
      expect(find.text('Hạn 29/10/2026'), findsOneWidget);
      expect(find.text('Còn 2 ngày'), findsOneWidget);
      expect(find.text('Đang chờ quyết định gia hạn'), findsOneWidget);
      expect(find.text('Đang thực hiện'), findsOneWidget);
      expect(find.text('Người thực hiện: Nguyễn Văn An'), findsNWidgets(2));
      expect(find.text('Chưa giao cho một người cụ thể'), findsOneWidget);
      expect(find.text('Dự án DA-001'), findsNWidgets(2));
      expect(find.text('Đơn vị thực hiện: Ban QLDA giao thông'), findsNWidgets(3));
      expect(find.text('Màn hình này chỉ để xem. Ghi tiến độ, gia hạn và đóng chỉ đạo làm trên máy tính.'), findsOneWidget);
    });

    testWidgets('keeps the order the server gave (the late ones first) and never sorts by the clock of the phone', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server);

      final double late = tester.getTopLeft(find.text('GB-2026-014/CD-01')).dy;
      final double soon = tester.getTopLeft(find.text('GB-2026-014/CD-02')).dy;
      final double progress = tester.getTopLeft(find.text('GB-2026-014/CD-03')).dy;
      expect(late, lessThan(soon));
      expect(soon, lessThan(progress));
    });

    testWidgets('the views ask the server: overdue narrows by the server, all asks for nothing, and each view is its own read', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      await _open(tester, server);

      await tester.tap(_chip('Quá hạn'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/directives').last.url.queryParameters, <String, String>{'limit': '50', 'overdue': 'true'});
      await tester.tap(_chip('Tất cả'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', '/directives').last.url.queryParameters, <String, String>{'limit': '50'});
      expect(tester.widget<ChoiceChip>(_chip('Tất cả')).selected, isTrue);
      expect(tester.widget<ChoiceChip>(_chip('Giao cho tôi')).selected, isFalse);
    });

    testWidgets('reads the pages by cursor until the end and shows one list', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/directives/summary', (_) => directiveSummary())
        ..on('GET', '/directives', (call) => call.url.queryParameters['cursor'] == 'c2' ? directivePage(<Object?>[threeDirectives[2]]) : directivePage(<Object?>[threeDirectives[0], threeDirectives[1]], next: 'c2'));
      await _open(tester, server);

      expect(server.callsTo('GET', '/directives'), hasLength(2));
      expect(server.callsTo('GET', '/directives').last.url.queryParameters['cursor'], 'c2');
      expect(find.text('Hiển thị 3 chỉ đạo'), findsOneWidget);
      expect(find.text('GB-2026-014/CD-03'), findsOneWidget);
      expect(find.textContaining('còn nhiều chỉ đạo hơn mức hiển thị'), findsNothing);
    });

    testWidgets('a list that is cut at the pages the phone reads says there is more', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      int page = 0;
      server
        ..on('GET', '/directives/summary', (_) => directiveSummary())
        ..on('GET', '/directives', (_) {
          page += 1;
          return directivePage(<Object?>[directiveRow('d-p$page', 'GB-2026-014/CD-$page', 'Chỉ đạo số $page.')], next: 'c${page + 1}');
        });
      await _open(tester, server);

      expect(server.callsTo('GET', '/directives'), hasLength(4));
      expect(find.textContaining('còn nhiều chỉ đạo hơn mức hiển thị'), findsOneWidget);
    });

    testWidgets('the counts that cannot be read do not take the list down, and say so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/directives', (_) => directivePage(threeDirectives))
        ..refuse('GET', '/directives/summary', 500, 'INTERNAL_ERROR');
      await _open(tester, server);

      expect(find.text('Chưa đọc được số liệu tổng hợp. Danh sách bên dưới vẫn đọc được.'), findsOneWidget);
      expect(find.text('GB-2026-014/CD-01'), findsOneWidget);
      expect(find.text('Sắp đến hạn'), findsNothing, reason: 'no figure is invented for the counts that were not read');
    });

    testWidgets('a list that cannot be read is an error with a retry, never "no directive"', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..refuse('GET', '/directives', 500, 'INTERNAL_ERROR')
        ..on('GET', '/directives/summary', (_) => directiveSummary());
      await _open(tester, server);

      expect(find.text('Chưa thể tải dữ liệu'), findsOneWidget);
      expect(find.text('Chưa có dữ liệu'), findsNothing);
      _register(server);
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('GB-2026-014/CD-01'), findsOneWidget);
    });

    testWidgets('no directive in the view is the empty state that names the view and clears it', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server
        ..on('GET', '/directives/summary', (_) => directiveSummary(overdue: 0, dueSoon: 0, escalated: 0, open: 1))
        ..on('GET', '/directives', (call) => directivePage(call.url.queryParameters.containsKey('assigned_to_me') ? <Object?>[] : threeDirectives));
      await _open(tester, server);

      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.text('Xóa bộ lọc'), findsOneWidget);
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(find.text('GB-2026-014/CD-01'), findsOneWidget);
    });

    testWidgets('a device that loses its connection keeps the list it has with the moment it describes, and does not say it is the newest', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      DateTime now = kNow;
      final ScriptedServer server = ScriptedServer();
      _register(server);
      final ProviderContainer container = await _open(tester, server, now: () => now);

      server.offline = true;
      now = kNow.add(const Duration(days: 2));
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(container.read(reachabilityProvider), Reachability.offline);
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy, số liệu tại 08/11/2026 10:00'), findsOneWidget);
      expect(find.text('GB-2026-014/CD-01'), findsOneWidget);
      expect(find.textContaining('mới nhất'), findsNothing);
    });
  });

  group('AC-DIR-06-2 UI-DIR-06 the timeline of one directive, read only', () {
    testWidgets('a row opens its timeline, the requests to move the day and the evidence, and offers no command', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      server.on('GET', '/directives/d-1', (_) => directiveDetailJson());
      await _open(tester, server);

      await tester.tap(find.text('GB-2026-014/CD-01'));
      await tester.pumpAndSettle();

      expect(server.callsTo('GET', '/directives/d-1'), hasLength(1));
      expect(find.text('Chỉ đạo GB-2026-014/CD-01'), findsOneWidget);
      expect(find.text('Dòng thời gian'), findsOneWidget);
      expect(find.text('Giao chỉ đạo'), findsOneWidget);
      expect(find.text('Ghi tiến độ'), findsOneWidget);
      expect(find.text('Tiến độ 40%'), findsOneWidget);
      expect(find.text('Đã gửi hồ sơ cho sở.'), findsOneWidget);
      expect(find.text('Duyệt gia hạn'), findsOneWidget);
      expect(find.text('Hạn 20/10/2026 thành 29/10/2026'), findsOneWidget);
      expect(find.text('Nguyễn Văn An · 10/10/2026 10:30'), findsOneWidget);
      expect(find.text('Đề nghị gia hạn'), findsOneWidget);
      expect(find.text('Từ 20/10/2026 đến 29/10/2026: Chờ ý kiến của sở xây dựng.'), findsOneWidget);
      expect(find.text('Trần Thị Bình quyết định: Đồng ý.'), findsOneWidget);
      expect(find.text('Hạn ban đầu: 20/10/2026'), findsOneWidget);
      expect(find.textContaining('Biên bản bàn giao mặt bằng · Nguyễn Văn An'), findsOneWidget);
      expect(find.byType(ElevatedButton), findsNothing);
      expect(find.byType(FilledButton), findsNothing);

      await tester.tap(find.byTooltip('Đóng'));
      await tester.pumpAndSettle();
      expect(find.text('Dòng thời gian'), findsNothing);
      expect(find.text('GB-2026-014/CD-01'), findsOneWidget);
    });

    testWidgets('a directive out of the scope is the state of a record that cannot be had, inside the sheet', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _register(server);
      server.refuse('GET', '/directives/d-1', 403, 'SCOPE_DENIED');
      await _open(tester, server);

      await tester.tap(find.text('GB-2026-014/CD-01'));
      await tester.pumpAndSettle();
      expect(find.text('Bạn chưa có quyền truy cập'), findsOneWidget);
      expect(find.text('SCOPE_DENIED'), findsOneWidget);
    });
  });

  group('AC-DIR-06-3 UI-DIR-06 DIR-06 every state is drawn and the contract of the screen holds', () {
    testWidgets('loading, empty, error, denied, expired licence, ended session, no connection; tap targets, labels and contrast at three devices and 200 percent text', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server),
        script: StateScript(
          healthy: _register,
          content: find.text('GB-2026-014/CD-01'),
          empty: (ScriptedServer server) => server.on('GET', '/directives', (_) => directivePage(<Object?>[])),
        ),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server), healthy: _register);
    });
  });
}
