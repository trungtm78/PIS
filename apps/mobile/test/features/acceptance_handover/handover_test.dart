import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/features/acceptance_handover/acceptance_handover_feature.dart' as acceptance;
import 'package:machvon_mobile/features/acceptance_handover/handover_models.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'fixtures.dart';

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, String location, {Locale locale = const Locale('vi')}) =>
    pumpWithServer(tester, features: <MobileFeature>[acceptance.feature], server: server, location: location, locale: locale);

void _reads(ScriptedServer server) {
  final Map<String, Object?> blocked = handover('h-1');
  server
    ..on('GET', '/resources/handover', (_) => page(<Object?>[handover('h-2', no: 'BG-002', status: 'ACCEPTED', items: 0, critical: 0, unit: 'Sở Giao thông'), blocked]))
    ..on('GET', '/warranty-obligations', (HttpCall call) {
      final String? only = call.url.queryParameters['handover_id'];
      final List<Object?> all = <Object?>[warranty('w-1'), warranty('w-2', status: 'EXPIRED', ends: '2027-01-01'), warranty('w-3', handoverId: 'h-2', ends: '2029-03-05')];
      return page(<Object?>[
        for (final Object? item in all)
          if (only == null || (item! as Map<String, Object?>)['handover'] is Map && ((item as Map<String, Object?>)['handover']! as Map<String, Object?>)['id'] == only) item,
      ]);
    })
    ..on('GET', '/handovers/h-1/trace', (_) => trace(blocked, <Map<String, Object?>>[punchItem('p-1', 1), punchItem('p-2', 2, severity: 'MINOR', status: 'VERIFIED'), punchItem('p-3', 3, severity: 'MAJOR', status: 'FIXED', overdue: true)]));
}

void main() {
  group('AC-ST-MOB-022-4 UI-MOB-66 MOB-66 the handover and warranty list', () {
    testWidgets('lists the handovers with the unit that receives, the defects left and the warranty, those with critical defects first', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      final ProviderContainer container = await _open(tester, server, '/projects/mob-66');

      expect(tester.getTopLeft(find.text('BG-001')).dy, lessThan(tester.getTopLeft(find.text('BG-002')).dy), reason: 'open critical defects first, the decided ones last');
      expect(find.text('Đơn vị nhận: Ban quản lý khai thác đường'), findsOneWidget);
      expect(find.text('Đơn vị nhận: Sở Giao thông'), findsOneWidget);
      expect(find.text('Danh sách tồn tại: 3 mục, 1 trọng yếu chưa xác nhận'), findsOneWidget);
      expect(find.text('1 tồn tại trọng yếu còn mở'), findsOneWidget);
      expect(find.text('Chờ khắc phục tồn tại'), findsOneWidget);
      expect(find.text('Đã nhận bàn giao'), findsOneWidget);
      expect(find.text('Bảo hành: 2 nghĩa vụ, đến 20/10/2028'), findsOneWidget);
      expect(find.text('Bảo hành: 1 nghĩa vụ, đến 05/03/2029'), findsOneWidget);
      expect(find.textContaining('Số liệu tại'), findsOneWidget);
      expect(server.calls.where((HttpCall call) => call.method != 'GET'), isEmpty, reason: 'the screen only reads');

      await tester.tap(find.text('BG-001'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-66?handover=h-1');
    });

    testWidgets('a reader who may not read warranties sees the handovers and is told the warranty is not shown, not that there is none', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.refuse('GET', '/warranty-obligations', 403, 'SCOPE_DENIED');
      await _open(tester, server, '/projects/mob-66');

      expect(find.text('BG-001'), findsOneWidget);
      expect(find.text('Bạn không có quyền xem nghĩa vụ bảo hành, nên phần bảo hành không được hiển thị.'), findsOneWidget);
      expect(find.text('Bảo hành: bạn không có quyền xem'), findsNWidgets(2));
      expect(find.textContaining('Chưa có nghĩa vụ bảo hành'), findsNothing);
    });

    testWidgets('an expired licence on the warranties is the licence state of the screen, not a hidden part', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.refuse('GET', '/warranty-obligations', 403, 'LICENSE_EXPIRED');
      await _open(tester, server, '/projects/mob-66');
      expect(find.text('License đã hết hạn'), findsOneWidget);
    });

    testWidgets('the filter narrows the list to the handovers with defects left, and clearing it brings the list back', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      server.on('GET', '/resources/handover', (_) => page(<Object?>[handover('h-2', no: 'BG-002', status: 'ACCEPTED', items: 0, critical: 0)]));
      await _open(tester, server, '/projects/mob-66');
      expect(find.text('BG-002'), findsOneWidget);

      await tester.tap(find.text('Chỉ bàn giao còn tồn tại'));
      await tester.pumpAndSettle();
      expect(find.text('BG-002'), findsNothing);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(find.text('BG-002'), findsOneWidget);
    });

    testWidgets('a copy kept on the device says so and the moment it describes, and nothing says it is the newest', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/projects/mob-66');
      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
      expect(find.text('BG-001'), findsOneWidget);
    });

    testWidgets('every state is drawn and the contract of the list and of the detail holds', (WidgetTester tester) async {
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-66'),
        script: StateScript(healthy: _reads, content: find.text('BG-001'), empty: (ScriptedServer server) => server.on('GET', '/resources/handover', (_) => page(<Object?>[]))),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-66'), healthy: _reads);
      await expectEveryState(
        tester,
        open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-66?handover=h-1'),
        script: StateScript(healthy: _reads, content: find.text('Tồn tại phải khắc phục')),
      );
      await expectScreenContract(tester, open: (WidgetTester tester, ScriptedServer server) => _open(tester, server, '/projects/mob-66?handover=h-1'), healthy: _reads);
    });
  });

  group('AC-ST-MOB-022-4 UI-MOB-66 MOB-66 one handover: the punch list and its warranty', () {
    testWidgets('shows the handover, the defects left to put right and the warranty with the status the server gave', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/projects/mob-66?handover=h-1');

      expect(find.text('BG-001'), findsOneWidget);
      expect(find.text('Hoàn thành'), findsOneWidget);
      expect(find.text('Ban quản lý khai thác đường'), findsOneWidget);
      expect(find.text('20/10/2026'), findsWidgets);
      expect(find.text('2 còn mở trong 3 mục, 1 trọng yếu chưa xác nhận'), findsOneWidget);
      expect(find.text('Mục 1: Nứt mặt đường đoạn km3'), findsWidgets);
      expect(find.text('Trọng yếu · Chưa khắc phục'), findsOneWidget);
      expect(find.text('Nhẹ · Đã xác nhận'), findsOneWidget);
      expect(find.text('Nặng · Đã khắc phục, chờ xác nhận'), findsOneWidget);
      expect(find.text('Quá hạn khắc phục'), findsOneWidget, reason: 'late is the word of the server, and only for a defect still open');
      expect(find.text('Vị trí: km3+200'), findsWidgets);
      expect(find.text('Nhà thầu xử lý: Công ty Minh An'), findsWidgets);
      expect(find.text('Mặt đường bê tông nhựa (Đường ĐT.A1 km0-km12)'), findsNWidgets(2));
      expect(find.text('Từ 20/10/2026 đến 20/10/2028, 24 tháng'), findsOneWidget);
      expect(find.text('Đang bảo hành · yêu cầu bảo hành: 1 đang mở trong 2'), findsOneWidget);
      expect(find.text('Đã hết hạn · yêu cầu bảo hành: 1 đang mở trong 2'), findsOneWidget, reason: 'an obligation is expired when the server says so, whatever the clock of the phone says');
      expect(server.callsTo('GET', '/warranty-obligations').single.url.queryParameters, containsPair('handover_id', 'h-1'));
    });

    testWidgets('a rejected handover says why, and a handover without defects or warranty says so', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      final Map<String, Object?> rejected = handover('h-1', status: 'REJECTED', items: 0, critical: 0, reason: 'Thiếu hồ sơ hoàn công');
      server
        ..on('GET', '/handovers/h-1/trace', (_) => trace(rejected, <Map<String, Object?>>[]))
        ..on('GET', '/warranty-obligations', (_) => page(<Object?>[]));
      await _open(tester, server, '/projects/mob-66?handover=h-1');
      expect(find.text('Lý do từ chối: Thiếu hồ sơ hoàn công'), findsOneWidget);
      expect(find.text('Chưa có mục tồn tại nào.'), findsOneWidget);
      expect(find.text('Bàn giao này chưa có nghĩa vụ bảo hành.'), findsOneWidget);
    });

    testWidgets('a handover outside the scope is the not-found state with its code and nothing of the record', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      server.refuse('GET', '/handovers/h-1/trace', 404, 'RESOURCE_NOT_FOUND');
      await _open(tester, server, '/projects/mob-66?handover=h-1');
      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
      expect(find.text('BG-001'), findsNothing);
    });

    testWidgets('the english interface', (WidgetTester tester) async {
      useDevice(tester, kTallDevice);
      final ScriptedServer server = ScriptedServer();
      _reads(server);
      await _open(tester, server, '/projects/mob-66', locale: const Locale('en'));
      expect(find.text('Receiving unit: Sở Giao thông'), findsOneWidget);
      expect(find.text('Warranty: 2 obligations, until 20/10/2028'), findsOneWidget);
    });
  });

  group('the readers of the handover data, as pure functions', () {
    test('a handover or a warranty that lacks what makes it citable is dropped, not shown half', () {
      expect(parseHandover(<String, Object?>{'id': 'x', 'handover_kind': 'PARTIAL', 'status': 'NOPE'}), isNull);
      expect(parseWarranty(<String, Object?>{'id': 'x', 'status': 'ACTIVE', 'starts_on': '2026-10-20'}), isNull);
      expect(parsePunchItem(<String, Object?>{'id': 'x', 'item_no': 1, 'severity': 'CRITICAL', 'status': 'NOPE'}), isNull);
      expect(parseHandoverRegister(<String, Object?>{'handovers': <String, Object?>{'items': 'no'}}), isNull);
      expect(parseHandoverTrace(<String, Object?>{'trace': <String, Object?>{}}), isNull);
    });

    test('the warranties of a handover are those that name it, and a punch item is open until it is verified or waived', () {
      final HandoverRegister? register = parseHandoverRegister(<String, Object?>{
        'handovers': page(<Object?>[handover('h-1')]),
        'warranties': page(<Object?>[warranty('w-1'), warranty('w-2', handoverId: 'h-9')]),
        'warranties_refused': false,
      });
      expect(register!.warrantiesOf('h-1').map((WarrantyLine w) => w.id), <String>['w-1']);
      expect(parsePunchItem(punchItem('p', 1, status: 'FIXED'))!.isOpen, isTrue);
      expect(parsePunchItem(punchItem('p', 1, status: 'WAIVED'))!.isOpen, isFalse);
      expect(parsePunchItem(punchItem('p', 1, status: 'VERIFIED'))!.isOpen, isFalse);
    });
  });
}
