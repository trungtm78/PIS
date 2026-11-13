import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/connectivity/reachability.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/features/attachments/attachments_feature.dart' as attachments;
import 'package:machvon_mobile/features/command_support/field_contract.dart';
import 'package:machvon_mobile/features/site_photo/site_photo_feature.dart' as photo;

import '../../support/harness.dart';
import '../field_evidence/exif_fixtures.dart';
import '../field_issues/field_world.dart';
import '../site_diary/diary_fixtures.dart';
import '../support/scripted_server.dart';

const String _screen = '/projects/qms-10';

FakeSession _contractor({SessionMode mode = SessionMode.full}) =>
    FakeSession(SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1', mode: mode));

void _answer(ScriptedServer api, {bool noContracts = false}) {
  api
    ..on('GET', '/resources/contract', (_) => page(noContracts ? <Object?>[] : <Object?>[contractRow('c-1', 'HD-A-001')]))
    ..on('GET', '/resources/site_diary', (_) => page(<Object?>[diaryRow('d-1')]))
    ..on('GET', '/resources/site_photo', (_) => page(<Object?>[]));
}

Future<FieldWorld> _open(WidgetTester tester, {String location = _screen, FakeSession? session, bool noContracts = false}) async {
  final FieldServer server = FieldServer();
  _answer(server.api, noContracts: noContracts);
  final FieldWorld world = FieldWorld.create(server: server);
  await world.open(tester, location, extra: <MobileFeature>[photo.feature, attachments.feature], session: session ?? _contractor());
  await settleReal(tester, rounds: 8);
  return world;
}

void main() {
  group('MUX-3C UI-QMS-10 the photograph comes first and the action is in the sticky bar', () {
    testWidgets('the photographs are the first block, then the contract with the caption, the place and the flags', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester);
      final double photos = tester.getTopLeft(find.text('Ảnh')).dy;
      final double contract = tester.getTopLeft(find.text('Hợp đồng').first).dy;
      final double place = tester.getTopLeft(find.text('Vị trí (khi đồng ý)')).dy;
      final double flags = tester.getTopLeft(find.text('Cờ kiểm tra trước khi lưu')).dy;
      expect(photos, lessThan(contract));
      expect(contract, lessThan(place));
      expect(place, lessThan(flags));
      expect(find.widgetWithText(FilledButton, 'Lưu và tải ảnh lên'), findsOneWidget);
    });

    testWidgets('the contract of the form is the one the quick report offers next', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, location: '$_screen?contract=c-1');
      await tester.pump();
      expect(world.container.read(lastFieldContractProvider), 'c-1');
    });

    testWidgets('the flags of a photograph without place and time are one warning panel, a note for review', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester);
      world.photos.gallery = world.file('g.jpg', plainJpeg());
      await tapText(tester, 'Chọn từ thư viện');
      await waitUntil(tester, () async => find.textContaining('Dung lượng').evaluate().isNotEmpty);
      await settleReal(tester, rounds: 6);
      expect(find.text('Cần rà soát trước khi lưu'), findsOneWidget);
      expect(find.text('1 ảnh chưa có vị trí.'), findsOneWidget);
      expect(find.text('1 ảnh không có thời gian chụp.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Lưu và tải ảnh lên')).onPressed, isNotNull, reason: 'a flag never stops a photograph');
    });

    testWidgets('offline the bar offers to save for later, and the capture is kept with a receipt', (WidgetTester tester) async {
      useDevice(tester, kTall);
      final FieldWorld world = await _open(tester, location: '$_screen?contract=c-1');
      world.photos.gallery = world.file('g.jpg', plainJpeg());
      await tapText(tester, 'Chọn từ thư viện');
      await waitUntil(tester, () async => find.textContaining('Dung lượng').evaluate().isNotEmpty);
      await settleReal(tester, rounds: 6);
      world.server.offline = true;
      world.container.read(reachabilityProvider.notifier).report(Reachability.offline);
      await tester.pumpAndSettle();

      expect(find.widgetWithText(FilledButton, 'Lưu, gửi khi có mạng'), findsOneWidget);
      await tapText(tester, 'Lưu, gửi khi có mạng');
      await waitUntil(tester, () async => find.text('Đã lưu 1 ảnh trên máy').evaluate().isNotEmpty);
      await settleReal(tester, rounds: 6);
      expect(find.text('Đã lưu 1 ảnh trên máy'), findsOneWidget, reason: 'the receipt');
      expect(find.text('Chờ tải lên'), findsOneWidget, reason: 'the upload of the capture, waiting for the network');
      expect(find.text('Xem tải lên'), findsOneWidget);
    });

    testWidgets('without a contract the empty state offers to try again', (WidgetTester tester) async {
      useDevice(tester, kTall);
      await _open(tester, noContracts: true);
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.textContaining('Bạn chưa được giao hợp đồng nào nên chưa có nơi để gắn ảnh'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Thử lại'), findsOneWidget);
    });
  });
}
