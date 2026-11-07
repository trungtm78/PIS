import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/di/providers.dart' show routerProvider;
import 'package:machvon_mobile/features/site_diary/contract_models.dart';

import '../../support/harness.dart';
import '../field_issues/field_world.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'diary_fixtures.dart';

Future<FieldWorld> _open(WidgetTester tester, void Function(ScriptedServer api) answers, {String location = '/projects/mob-61'}) async {
  final FieldServer server = FieldServer();
  answers(server.api);
  final FieldWorld world = FieldWorld.create(server: server);
  await openDiaryApp(tester, world, location);
  return world;
}

void _guestSees(ScriptedServer api) {
  api
    ..on('GET', '/resources/contract', (_) => page(<Object?>[contractRow('c-1', 'HD-A-001')]))
    ..refuse('GET', '/resources/contract/c-2', 404, 'RESOURCE_NOT_FOUND')
    ..on('GET', '/resources/boq_line', (_) => page(<Object?>[
          boqRow('l-3', milestone: 'GD3', due: '2027-01-15', description: 'Hoàn thiện'),
          boqRow('l-1', milestone: 'GD1', due: '2026-12-01', description: 'Đào đất'),
          boqRow('l-2', description: 'Không có mốc'),
          boqRow('l-4', milestone: 'GD9', due: '2027-06-01', revision: 'PENDING'),
          boqRow('l-5', milestone: 'GD2'),
        ]));
}

void main() {
  group('AC-ST-MOB-020-1 UAT-AC365 UI-MOB-61 a contractor sees only the contract they were invited to', () {
    testWidgets('lists HD-A-001 and nothing else, with its status, project, contractor and completion day', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, _guestSees);

      expect(find.text('HD-A-001 · Đường tỉnh ĐT.A1 km0-km12'), findsOneWidget);
      expect(find.textContaining('HD-A-002'), findsNothing);
      expect(find.text('Đang thực hiện'), findsOneWidget);
      expect(find.text('Công ty TNHH Xây dựng Minh An'), findsOneWidget);
      expect(find.text('31/03/2027'), findsOneWidget);
      expect(world.server.api.callsTo('GET', '/resources/contract'), hasLength(1));
    });

    testWidgets('an attempt to open HD-A-002 is a 404 RESOURCE_NOT_FOUND with its code, and nothing of that contract is shown', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, _guestSees, location: '/projects/mob-61?contract=c-2');

      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
      expect(find.textContaining('HD-A-002'), findsNothing);
      expect(find.text('Viết nhật ký công trường'), findsNothing);
    });

    testWidgets('the diary of a contract the reader may not open is a 404 too', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, _guestSees, location: '/projects/mob-62/c-2');
      expect(find.text('RESOURCE_NOT_FOUND'), findsOneWidget);
      expect(find.text('Lưu nhật ký'), findsNothing);
    });

    testWidgets('one contract opened by its id shows only that contract', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, (ScriptedServer api) {
        _guestSees(api);
        api.on('GET', '/resources/contract/c-1', (_) => contractRow('c-1', 'HD-A-001'));
      }, location: '/projects/mob-61?contract=c-1');
      expect(find.text('HD-A-001 · Đường tỉnh ĐT.A1 km0-km12'), findsOneWidget);
    });
  });

  group('UI-MOB-61 the milestones of a contract', () {
    testWidgets('open on request: the lines of the revision in force that name a milestone, by due day, a line without one last', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, _guestSees);
      expect(world.server.api.callsTo('GET', '/resources/boq_line'), isEmpty, reason: 'nothing is read until the milestones are asked for');

      await tapText(tester, 'Xem các mốc');

      expect(world.server.api.callsTo('GET', '/resources/boq_line').single.url.queryParameters, containsPair('contract_id', 'c-1'));
      expect(find.text('GD1'), findsOneWidget);
      expect(find.text('GD3'), findsOneWidget);
      expect(find.text('GD2'), findsOneWidget);
      expect(find.text('GD9'), findsNothing, reason: 'a line of a revision that is not in force is not a milestone');
      expect(find.text('Không có mốc'), findsNothing);
      expect(find.text('Hạn 01/12/2026'), findsOneWidget);
      expect(find.text('Chưa có hạn'), findsOneWidget);
      final double first = tester.getTopLeft(find.text('GD1')).dy;
      final double second = tester.getTopLeft(find.text('GD3')).dy;
      final double last = tester.getTopLeft(find.text('GD2')).dy;
      expect(first, lessThan(second));
      expect(second, lessThan(last), reason: 'the one without a due day comes last');

      await tapText(tester, 'Ẩn các mốc');
      expect(find.text('GD1'), findsNothing);
    });

    testWidgets('a contract with no milestone says so; a failed read says so with its code and can be tried again', (WidgetTester tester) async {
      useDevice(tester, kTall);
      int calls = 0;
      await _open(tester, (ScriptedServer api) {
        api.on('GET', '/resources/contract', (_) => page(<Object?>[contractRow('c-1', 'HD-A-001')]));
        api.answer('GET', '/resources/boq_line', (HttpCall call) {
          calls += 1;
          return calls == 1 ? FakeTransport.json(500, <String, Object?>{'type': 'about:blank', 'title': 'x', 'status': 500, 'code': 'INTERNAL_ERROR'}) : FakeTransport.json(200, page(<Object?>[boqRow('l-1')]));
        });
      });
      await tapText(tester, 'Xem các mốc');
      expect(find.text('Chưa đọc được các mốc của hợp đồng.'), findsOneWidget);
      expect(find.text('INTERNAL_ERROR'), findsOneWidget);

      await tapText(tester, 'Thử lại');
      expect(find.text('Hợp đồng này chưa có mốc nào.'), findsOneWidget);
    });

    testWidgets('a contract opens the quantity and the quality check of its site, with its id in the path', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, _guestSees);
      await tapText(tester, 'Ghi nhận khối lượng');
      expect(currentLocation(world.container), '/projects/mob-63/c-1');
      world.container.read(routerProvider).pop();
      await tester.pumpAndSettle();
      await tapText(tester, 'Kiểm tra chất lượng');
      expect(currentLocation(world.container), '/projects/mob-64/c-1');
    });

    testWidgets('a contract opens the site diary', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, _guestSees);
      await tapText(tester, 'Viết nhật ký công trường');
      expect(currentLocation(world.container), '/projects/mob-62/c-1');
    });
  });

  group('AC-ST-MOB-020-5 UI-MOB-61 MOB-61 the states and the contract of the screen', () {
    testWidgets('every state is drawn and the guidelines hold', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) async {
        await openDiaryApp(tester, FieldWorld.create(server: FieldServer(api: server)), '/projects/mob-61');
      }

      void healthy(ScriptedServer server) => server.on('GET', '/resources/contract', (_) => page(<Object?>[contractRow('c-1', 'HD-A-001')]));
      await expectEveryState(
        tester,
        open: open,
        script: StateScript(healthy: healthy, content: find.text('HD-A-001 · Đường tỉnh ĐT.A1 km0-km12'), empty: (ScriptedServer server) => server.on('GET', '/resources/contract', (_) => page(<Object?>[]))),
      );
      await expectScreenContract(tester, open: open, healthy: healthy);
    });
  });

  group('AC-ST-MOB-020-1 the readers of the contract register', () {
    test('a contract needs its identity and its status; the milestones are the lines of the revision in force', () {
      expect(parseContracts(page(<Object?>[contractRow('c-1', 'HD-A-001'), <String, Object?>{'id': 'x'}, 'nothing']))!.map((ContractLine c) => c.code), <String>['HD-A-001']);
      expect(parseContracts('x'), isNull);
      expect(parseContracts(<String, Object?>{'items': 'x'}), isNull);
      expect(parseContract(<String, Object?>{'id': 'c-1', 'code': 'A'}), isNull);
      expect(parseContract(contractRow('c-1', 'HD-A-001', title: '')) !.label, 'HD-A-001');
      expect(parseMilestones(page(<Object?>[boqRow('l-1', milestone: 'GD1', due: 'not a day')]))!.single.dueOn, isNull);
      expect(parseMilestones('x'), isNull);
    });
  });
}
