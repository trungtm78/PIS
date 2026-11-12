import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall;
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/widgets/figure_info.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/dashboard/dashboard_strings.dart';
import 'package:machvon_mobile/features/dashboard/home_insight.dart';
import 'package:machvon_mobile/features/directives/directives_feature.dart' as directives;
import 'package:machvon_mobile/features/directives/directives_strings.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'dashboard_fixtures.dart';
import 'home_parity_fixtures.dart';

/// The phone leader home has what the web leader home has: the "i" of a figure, the colours with the reason for each, what changed since last week and
/// the steering directives. Each part is read on its own: one failing is named and leaves the others in place.

/// Taller than the home with every part drawn, so the lazily built list is built whole and a test can read and tap all of it.
const Size _tallDevice = Size(390, 7000);

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, {String location = '/home', Locale locale = const Locale('vi')}) =>
    pumpWithServer(tester, features: <MobileFeature>[dashboard.feature, directives.feature], server: server, location: location, locale: locale);

/// Everything healthy: the command center with its definitions, the colours, the changes and the directives (no alerts, so the page has no other retry).
void _healthy(ScriptedServer server) {
  server
    ..on('GET', '/home/command-center', (_) => commandCenterWithDefinitions())
    ..on('GET', '/home/my-work', (_) => alertWork(<Map<String, Object?>>[]))
    ..on('GET', '/home/rag', (_) => ragReading())
    ..on('GET', '/home/changes', (_) => homeChanges())
    ..on('GET', '/directives/widget', (_) => directiveWidget());
}

Finder _info(String name) => find.byTooltip('Công thức và nguồn của $name');

void main() {
  group('the new strings: both languages carry the same keys, in the shape of a key of the application', () {
    test('the home and the directive strings', () {
      expect(dashboardStrings.vi.keys.toSet(), dashboardStrings.en.keys.toSet());
      expect(directivesStrings.vi.keys.toSet(), directivesStrings.en.keys.toSet());
    });
  });

  group('G0-4 the "i" of a figure: formula, source, day, owner and version', () {
    testWidgets('a figure that has a definition has an "i" that opens it, with the numerator, the denominator and what is left out', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server);

      final Finder button = _info('Tỷ lệ giải ngân theo kế hoạch Thủ tướng giao').first;
      expect(button, findsOneWidget);
      await tester.tap(button);
      await tester.pumpAndSettle();

      final Finder sheet = find.byType(FigureInfoSheet);
      expect(sheet, findsOneWidget);
      for (final String text in <String>[
        'Tỷ lệ giải ngân theo kế hoạch Thủ tướng giao',
        'Công thức',
        'Tổng giải ngân của Kho bạc chia cho kế hoạch vốn được giao',
        'Tử số',
        'Giải ngân lũy kế theo Kho bạc',
        'Mẫu số',
        'Kế hoạch vốn được giao',
        'Không tính',
        '• Dự án đã đóng hồ sơ',
        'Nguồn',
        'Ảnh chụp số liệu đã chốt',
        'Số liệu đến ngày',
        '31/10/2026',
        'Đơn vị chịu trách nhiệm',
        'Vụ Kế hoạch tài chính',
        'Phiên bản',
        'Phiên bản 2',
      ]) {
        expect(find.descendant(of: sheet, matching: find.text(text)), findsOneWidget, reason: text);
      }
      expect(find.descendant(of: sheet, matching: find.text('Định nghĩa này là giá trị khởi điểm, chưa được chủ sở hữu số liệu xác nhận.')), findsNothing, reason: 'a confirmed definition');

      await tester.tap(find.widgetWithText(OutlinedButton, 'Đóng'));
      await tester.pumpAndSettle();
      expect(find.byType(FigureInfoSheet), findsNothing);
    });

    testWidgets('a definition that nobody confirmed says so, and the built-in version says it is the default', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server);

      await tester.tap(_info('Tỷ lệ giải ngân theo tổng kế hoạch vốn').first);
      await tester.pumpAndSettle();
      final Finder sheet = find.byType(FigureInfoSheet);
      expect(find.descendant(of: sheet, matching: find.text('Phiên bản 0 (mặc định)')), findsOneWidget);
      expect(find.descendant(of: sheet, matching: find.text('Định nghĩa này là giá trị khởi điểm, chưa được chủ sở hữu số liệu xác nhận.')), findsOneWidget);
    });

    testWidgets('the amount, a count that waits and a flag on the figure have their own words', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server);

      expect(_info('Giải ngân lũy kế theo Kho bạc'), findsWidgets);
      expect(_info('Cảnh báo sớm đang mở'), findsOneWidget);
      expect(_info('Giải trình quá hạn'), findsNothing, reason: 'the server gave no definition for this count: no empty "i"');
      expect(find.text('Định nghĩa chưa được xác nhận'), findsOneWidget, reason: 'the flag of the figure');
      await tester.tap(_info('Cảnh báo sớm đang mở'));
      await tester.pumpAndSettle();
      expect(find.descendant(of: find.byType(FigureInfoSheet), matching: find.text('Số cảnh báo sớm chưa đóng')), findsOneWidget);
      expect(find.descendant(of: find.byType(FigureInfoSheet), matching: find.text('Tử số')), findsNothing, reason: 'a count has neither numerator nor denominator');
    });

    testWidgets('a server that sends no definition leaves the figures as they were: no "i" and no empty panel', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer()..on('GET', '/home/command-center', (_) => commandCenter());
      await _open(tester, server);

      expect(find.byIcon(Icons.info_outline), findsNothing);
      expect(find.text('Số liệu và công thức'), findsOneWidget);
    });

    testWidgets('the sheet speaks English when the phone does', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server, locale: const Locale('en'));

      await tester.tap(find.byTooltip('Formula and source of Giải ngân lũy kế theo Kho bạc').first);
      await tester.pumpAndSettle();
      final Finder sheet = find.byType(FigureInfoSheet);
      for (final String text in <String>['Formula', 'Source', 'As of', 'Owner', 'Version 2']) {
        expect(find.descendant(of: sheet, matching: find.text(text)), findsOneWidget, reason: text);
      }
    });
  });

  group('G3-2 the colours of the units with the reason for each', () {
    testWidgets('a red unit says why: the factors against their lines, the points, the data there, and the week before', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server);

      expect(find.text('Màu xanh vàng đỏ của các đơn vị'), findsOneWidget);
      expect(find.text('Đỏ: 1 đơn vị'), findsOneWidget);
      expect(find.text('Vàng: 0 đơn vị'), findsOneWidget);
      expect(find.text('Xanh: 0 đơn vị'), findsOneWidget);
      expect(find.text('U-1 Sở Giao thông'), findsOneWidget);
      expect(find.text('Vì sao'), findsOneWidget);
      expect(find.text('Tỷ lệ giải ngân so với nhịp của năm: đạt 0,55 (xanh từ 0,9, vàng từ 0,6) · góp 40 điểm'), findsOneWidget);
      expect(find.text('Cảnh báo nghiêm trọng đang mở: đạt 4 (xanh đến 1, vàng đến 3) · góp 20 điểm'), findsOneWidget);
      expect(find.text('Điểm cảnh báo sớm: 71,5/100'), findsOneWidget);
      expect(find.text('Rủi ro cao hơn 11,5 điểm so với tuần trước'), findsOneWidget);
      expect(find.text('Độ bao phủ dữ liệu: 100%'), findsOneWidget);
      expect(find.text('Tuần trước: Vàng, 60/100 (tuần bắt đầu 26/10/2026)'), findsOneWidget);
      expect(find.text('Ngưỡng là giá trị khởi điểm, chưa được xác nhận'), findsOneWidget);
      expect(find.textContaining('Ghi đè màu và chấm điểm tuần làm trên máy tính'), findsOneWidget);
    });

    testWidgets('a unit with too little data is "not enough data": no score, never green', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on('GET', '/home/rag', (_) => ragReading(units: <Map<String, Object?>>[ragUnit('2', 'Sở Xây dựng', band: 'NO_DATA', score: 0, coverage: 40, reasons: <Map<String, Object?>>[], previous: <String, Object?>{})]));
      await _open(tester, server);

      expect(find.text('Chưa đủ dữ liệu: 1 đơn vị'), findsOneWidget);
      expect(find.text('Chưa đủ dữ liệu: mới có 40% dữ liệu, cần ít nhất 60%.'), findsOneWidget);
      expect(find.text('Chưa đủ dữ liệu để chấm điểm'), findsOneWidget);
      expect(find.textContaining('/100'), findsNothing, reason: 'the 0 that came with "no data" is not believed');
      expect(find.text('Vì sao'), findsNothing);
    });

    testWidgets('an override is shown beside the colour of the rules, with its reason and its last day', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on(
        'GET',
        '/home/rag',
        (_) => ragReading(
          units: <Map<String, Object?>>[
            ragUnit('3', 'Sở Tài chính', band: 'AMBER', ruleBand: 'RED', override: <String, Object?>{'band': 'AMBER', 'rule_band': 'RED', 'reason': 'Đã có cam kết giải ngân', 'until': '2026-11-30', 'by': 'Trần Thị B', 'at': '2026-11-01T00:00:00Z'}),
          ],
        ),
      );
      await _open(tester, server);

      expect(find.text('Đã ghi đè'), findsOneWidget);
      expect(find.text('Màu theo quy tắc: Đỏ'), findsOneWidget);
      expect(find.text('Màu đang hiển thị (ghi đè): Vàng'), findsOneWidget);
      expect(find.text('Lý do ghi đè: Đã có cam kết giải ngân'), findsOneWidget);
      expect(find.text('Có hiệu lực đến ngày 30/11/2026'), findsOneWidget);
      expect(find.text('Người ghi đè: Trần Thị B'), findsOneWidget);
    });

    testWidgets('only the worst units are explained, red first, and the rest are counted', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on(
        'GET',
        '/home/rag',
        (_) => ragReading(
          units: <Map<String, Object?>>[
            ragUnit('g', 'Xanh', band: 'GREEN', score: 10),
            ragUnit('a1', 'Vàng một', band: 'AMBER', score: 40),
            ragUnit('r1', 'Đỏ một'),
            ragUnit('r2', 'Đỏ hai'),
            ragUnit('r3', 'Đỏ ba'),
            ragUnit('r4', 'Đỏ bốn'),
          ],
        ),
      );
      await _open(tester, server);

      expect(find.text('U-r1 Đỏ một'), findsOneWidget);
      expect(find.text('U-r3 Đỏ ba'), findsOneWidget);
      expect(find.text('U-r4 Đỏ bốn'), findsNothing);
      expect(find.text('U-a1 Vàng một'), findsNothing);
      expect(find.text('Còn 2 đơn vị khác chưa xanh. Xem đầy đủ trên máy tính.'), findsOneWidget);
      expect(tester.getTopLeft(find.text('U-r1 Đỏ một')).dy, lessThan(tester.getTopLeft(find.text('U-r3 Đỏ ba')).dy));
    });

    testWidgets('when every unit is green it says so', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on('GET', '/home/rag', (_) => ragReading(units: <Map<String, Object?>>[ragUnit('g', 'Xanh', band: 'GREEN', score: 10)]));
      await _open(tester, server);

      expect(find.text('Không có đơn vị nào đỏ, vàng hoặc thiếu dữ liệu.'), findsOneWidget);
    });

    test('the reading drops a unit with no colour, believes no score beside "no data", and keeps red first', () {
      final RagReading? reading = parseRagReading(
        ragReading(units: <Map<String, Object?>>[
          ragUnit('g', 'Xanh', band: 'GREEN'),
          ragUnit('n', 'Thiếu', band: 'NO_DATA', score: 9),
          <String, Object?>{...ragUnit('x', 'Không màu'), 'band': 'PURPLE'},
          <String, Object?>{...ragUnit('y', 'Không mã'), 'unit_id': ''},
          ragUnit('r', 'Đỏ'),
        ]),
      );
      expect(reading!.units.map((RagUnit unit) => unit.unitId), <String>['r', 'n', 'g']);
      expect(reading.units[1].score, isNull);
      expect(parseRagReading(<String, Object?>{'snapshot_id': 'x'}), isNull);
      expect(parseRagReading(null), isNull);
    });
  });

  group('G3-4 what changed since last week', () {
    testWidgets('at most five sentences made by the server, each with its numbers and where it is checked', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      await _open(tester, server);

      expect(find.text('Thay đổi từ tuần trước'), findsOneWidget);
      expect(find.text('Tuần bắt đầu 26/10/2026, so với tuần bắt đầu 19/10/2026.'), findsOneWidget);
      expect(find.text('Tỷ lệ giải ngân theo kế hoạch Thủ tướng giao tăng 4.00 điểm phần trăm, từ 10.00% lên 14.00%.'), findsOneWidget);
      expect(find.text('2 đơn vị chuyển sang màu đỏ so với tuần trước.'), findsOneWidget);
      expect(find.text('Cảnh báo sớm đang mở giảm 2, từ 5 xuống 3.'), findsOneWidget);
      expect(find.text('Giải trình quá hạn tăng 1, từ 0 lên 1.'), findsOneWidget);
      expect(find.text('Tuần này giải ngân thêm 140.000.000 đồng.'), findsOneWidget);
      expect(find.text('Kiểm tra: xem nguồn của con số trên máy tính'), findsOneWidget);
      expect(find.text('Kiểm tra: thẻ màu xanh vàng đỏ trên trang này'), findsOneWidget);
      expect(find.text('Mở việc của tôi'), findsOneWidget);
      expect(find.byIcon(Icons.arrow_upward), findsNWidgets(4));
      expect(find.byIcon(Icons.arrow_downward), findsOneWidget);
    });

    testWidgets('the line about the work of the person opens that screen; the others open nothing that is not there', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      final ProviderContainer container = await _open(tester, server);

      await tester.tap(find.text('Giải trình quá hạn tăng 1, từ 0 lên 1.'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/home/mob-08');
    });

    testWidgets('a week with no week before says so, and a quiet week says so: neither is "no change" by silence', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on('GET', '/home/changes', (_) => homeChanges(lines: <Map<String, Object?>>[], reason: 'NO_PREVIOUS_WEEK', previousWeek: ''));
      await _open(tester, server);
      expect(find.text('Chưa có tuần trước để so sánh.'), findsOneWidget);
      expect(find.text('Tuần này không có thay đổi đáng kể.'), findsNothing);

      server = ScriptedServer();
      _healthy(server);
      server.on('GET', '/home/changes', (_) => homeChanges(lines: <Map<String, Object?>>[]));
      await _open(tester, server);
      expect(find.text('Tuần này không có thay đổi đáng kể.'), findsOneWidget);
      expect(find.text('Chưa có tuần trước để so sánh.'), findsNothing);
    });

    test('a line the phone has no sentence for, or whose numbers are not all there, is not said; five at most', () {
      final HomeChanges? changes = parseHomeChanges(
        homeChanges(
          lines: <Map<String, Object?>>[
            changeLine('NEW_KIND', 'UP', <String, Object?>{}, 'RAG'),
            changeLine('RATE_CHANGE', 'UP', <String, Object?>{'from': '1', 'to': '2'}, 'DRILL'),
            changeLine('RATE_CHANGE', 'SIDEWAYS', <String, Object?>{'from': '1', 'to': '2', 'delta': '1'}, 'DRILL'),
            changeLine('RATE_CHANGE', 'UP', <String, Object?>{'from': '1', 'to': '2', 'delta': '1'}, 'NOWHERE'),
            for (int i = 0; i < 7; i += 1) changeLine('UNITS_TO_RED', 'UP', <String, Object?>{'count': i + 1}, 'RAG'),
          ],
        ),
      );
      expect(changes!.lines, hasLength(5));
      expect(changes.lines.every((ChangeLine line) => line.kind == ChangeKind.unitsToRed), isTrue);
      expect(parseHomeChanges(<String, Object?>{'snapshot_id': 'x'}), isNull);
    });
  });

  group('DIR-1 the steering directives on the home of a leader', () {
    testWidgets('the counts, the oldest overdue directive with its clock, the policy note and the way to the list', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      final ProviderContainer container = await _open(tester, server);

      expect(find.text('Chỉ đạo giao ban'), findsOneWidget);
      expect(find.text('Chỉ đạo quá hạn'), findsOneWidget);
      expect(find.text('Đã báo lãnh đạo đơn vị'), findsOneWidget);
      expect(find.text('Sắp đến hạn'), findsOneWidget);
      expect(find.text('Chỉ đạo quá hạn lâu nhất'), findsOneWidget);
      expect(find.text('GB-2026-014/CD-01'), findsOneWidget);
      expect(find.text('Quá hạn 10 ngày, đã báo lãnh đạo đơn vị'), findsOneWidget);
      expect(find.text('Các ngưỡng nhắc hạn và báo lãnh đạo là giá trị khởi đầu, chưa kiểm chứng với khách hàng và kiểm toán.'), findsOneWidget);
      expect(find.text('Số liệu tại 08/11/2026 10:00'), findsOneWidget);

      await tester.tap(_info('Chỉ đạo quá hạn'));
      await tester.pumpAndSettle();
      final Finder sheet = find.byType(FigureInfoSheet);
      expect(find.descendant(of: sheet, matching: find.text('Chỉ đạo đang mở mà hạn trước ngày hôm nay (giờ Việt Nam).')), findsOneWidget);
      expect(find.descendant(of: sheet, matching: find.text('Chỉ đạo giao ban (phân hệ DIR), trong phạm vi của người đọc')), findsOneWidget);
      expect(find.descendant(of: sheet, matching: find.text('Định nghĩa này là giá trị khởi điểm, chưa được chủ sở hữu số liệu xác nhận.')), findsOneWidget);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Đóng'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Xem danh sách chỉ đạo'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/dir-06');
    });

    testWidgets('no overdue directive is said in words, and a confirmed policy does not say it is unconfirmed', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on('GET', '/directives/widget', (_) => directiveWidget(items: <Map<String, Object?>>[], unverified: false));
      await _open(tester, server);

      expect(find.text('Không có chỉ đạo nào quá hạn trong phạm vi của bạn.'), findsOneWidget);
      expect(find.textContaining('chưa kiểm chứng'), findsNothing);
    });

    testWidgets('a reader with no right to read directives is told so; the rest of the home stays', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.refuse('GET', '/directives/widget', 403, 'PERMISSION_DENIED');
      await _open(tester, server);

      expect(find.text('Bạn không có quyền xem chỉ đạo giao ban.'), findsOneWidget);
      expect(find.text('Màu xanh vàng đỏ của các đơn vị'), findsOneWidget);
      expect(find.text('Số liệu và công thức'), findsOneWidget);
    });
  });

  group('each added part names its own failure and leaves the others in place', () {
    testWidgets('colours failed (500): named with its code, never a colour; the changes and the directives are still there; retry reads again', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      bool failing = true;
      server.answer('GET', '/home/rag', (HttpCall call) async {
        if (failing) return FakeTransport.json(500, <String, Object?>{'type': 'about:blank', 'title': 'INTERNAL_ERROR', 'status': 500, 'code': 'INTERNAL_ERROR'});
        return FakeTransport.json(200, ragReading());
      });
      await _open(tester, server);

      expect(find.textContaining('Không đọc được màu xanh vàng đỏ (mã INTERNAL_ERROR)'), findsOneWidget);
      expect(find.text('Đỏ: 1 đơn vị'), findsNothing);
      expect(find.text('Thay đổi từ tuần trước'), findsOneWidget);
      expect(find.text('2 đơn vị chuyển sang màu đỏ so với tuần trước.'), findsOneWidget);
      expect(find.text('GB-2026-014/CD-01'), findsOneWidget);

      failing = false;
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Đỏ: 1 đơn vị'), findsOneWidget);
      expect(find.textContaining('Không đọc được màu xanh vàng đỏ'), findsNothing);
    });

    testWidgets('changes: no snapshot yet and a refusal have words of their own; a failure is not "nothing changed"', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final Map<(int, String), String> cases = <(int, String), String>{
        (404, 'RESOURCE_NOT_FOUND'): 'Chưa có ảnh chụp số liệu nào được chốt.',
        (403, 'SCOPE_DENIED'): 'Bạn không được xem thay đổi của phạm vi này.',
        (500, 'INTERNAL_ERROR'): 'Không đọc được thay đổi từ tuần trước (mã INTERNAL_ERROR). Phần này chưa có số liệu, các phần khác vẫn đúng.',
      };
      for (final MapEntry<(int, String), String> entry in cases.entries) {
        final ScriptedServer server = ScriptedServer();
        _healthy(server);
        server.refuse('GET', '/home/changes', entry.key.$1, entry.key.$2);
        await _open(tester, server);
        expect(find.text(entry.value), findsOneWidget, reason: entry.key.$2);
        expect(find.text('Tuần này không có thay đổi đáng kể.'), findsNothing);
        expect(find.text('Màu xanh vàng đỏ của các đơn vị'), findsOneWidget);
      }
    });

    testWidgets('colours: a refusal and no snapshot have words of their own', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final Map<(int, String), String> cases = <(int, String), String>{
        (404, 'RESOURCE_NOT_FOUND'): 'Chưa có ảnh chụp số liệu nào được chốt để xếp màu.',
        (403, 'SCOPE_DENIED'): 'Bạn không được xem màu của phạm vi này.',
      };
      for (final MapEntry<(int, String), String> entry in cases.entries) {
        final ScriptedServer server = ScriptedServer();
        _healthy(server);
        server.refuse('GET', '/home/rag', entry.key.$1, entry.key.$2);
        await _open(tester, server);
        expect(find.text(entry.value), findsOneWidget, reason: entry.key.$2);
        expect(find.text('Đỏ: 1 đơn vị'), findsNothing);
      }
    });

    testWidgets('an answer that is not what the phone reads is a contract mismatch of that part only', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on('GET', '/home/rag', (_) => <String, Object?>{'unexpected': true});
      await _open(tester, server);

      expect(find.textContaining('Không đọc được màu xanh vàng đỏ (mã CONTRACT_MISMATCH)'), findsOneWidget);
      expect(find.text('Số liệu và công thức'), findsOneWidget);
    });

    testWidgets('the end of the session on an added part is the end of the session of the screen, as for the rest', (WidgetTester tester) async {
      useDevice(tester, _tallDevice);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.refuse('GET', '/home/changes', 401, 'SESSION_EXPIRED');
      await _open(tester, server);

      expect(find.text('Phiên làm việc đã hết hạn'), findsOneWidget);
    });
  });

  group('the screen contract holds with every part drawn', () {
    testWidgets('three devices, 200 percent text: no overflow, tap targets (the "i" is 48 dp), labels and contrast', (WidgetTester tester) async {
      await expectScreenContract(
        tester,
        open: (WidgetTester tester, ScriptedServer server) {
          // The contract sets the device; the page is made tall at the same width and text scale so that every part of it is built and checked.
          useDevice(tester, Size(tester.view.physicalSize.width, 12000), textScale: tester.platformDispatcher.textScaleFactor);
          return _open(tester, server);
        },
        healthy: _healthy,
      );
    });

    testWidgets('the colours card in English, with an override and a unit short of data, at 200 percent text', (WidgetTester tester) async {
      useDevice(tester, const Size(360, 12000), textScale: 2.0);
      final ScriptedServer server = ScriptedServer();
      _healthy(server);
      server.on(
        'GET',
        '/home/rag',
        (_) => ragReading(
          units: <Map<String, Object?>>[
            ragUnit('3', 'Sở Tài chính', band: 'AMBER', ruleBand: 'RED', override: <String, Object?>{'band': 'AMBER', 'reason': 'Đã có cam kết giải ngân', 'until': '2026-11-30', 'by': 'Trần Thị B'}),
            ragUnit('2', 'Sở Xây dựng', band: 'NO_DATA', coverage: 40, reasons: <Map<String, Object?>>[]),
          ],
        ),
      );
      await _open(tester, server, locale: const Locale('en'));

      expect(tester.takeException(), isNull);
      expect(find.text('Colours of the units'), findsOneWidget);
      expect(find.text('Amber: 1 units'), findsOneWidget);
      expect(find.text('Overridden'), findsOneWidget);
      expect(find.text('Not enough data: 40% is there, at least 60% is needed.'), findsOneWidget);
    });
  });
}
