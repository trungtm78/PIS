import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/session/session.dart';
import 'package:machvon_mobile/core/theme/theme_mode.dart';
import 'package:machvon_mobile/features/acceptance_handover/acceptance_handover_feature.dart' as acceptance;
import 'package:machvon_mobile/features/governance_reads/governance_reads_feature.dart' as reads;
import 'package:machvon_mobile/features/payment_tracking/payment_tracking_feature.dart' as payments;

import '../features/acceptance_handover/fixtures.dart' as acc;
import '../features/payment_tracking/fixtures.dart' as pay;
import '../features/support/scripted_server.dart';
import '../support/harness.dart';
import '../support/v2_support.dart';

/// Golden images of MUX-3 wave B for the acceptance and handover (MOB-65, 66), the payment tracking and reconciliation (MOB-27, 60) and the
/// read views of governance (MOB-75, 76, 77): each key view in the light mode, the dark mode and at 200 percent text, the empty states and the
/// copy kept on the phone (offline), and the confirmation sheet of a decision. The texts are drawn with the test font; the antialiasing
/// difference between Windows and Linux is accepted up to the tolerance of the text-heavy goldens. Layout and touch targets are proved by the
/// widget tests of the screens next to them.

class _Dark extends ThemeModeNotifier {
  @override
  ThemeMode build() => ThemeMode.dark;
}

const Size _phone = Size(390, 844);

/// A phone as tall as the longest of these screens, for the views whose point is below the fold of a normal one.
const Size _tall = Size(390, 1500);

FakeSession _accountant() => FakeSession(const SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: 'mem-1'));

Future<ScriptedServer> _open(
  WidgetTester tester,
  List<MobileFeature> features,
  String location,
  void Function(ScriptedServer server) script, {
  bool dark = false,
  double scale = 1.0,
  Size size = _phone,
}) async {
  useDevice(tester, size, textScale: scale);
  final ScriptedServer server = ScriptedServer();
  script(server);
  await pumpWithServer(
    tester,
    features: features,
    server: server,
    location: location,
    session: _accountant(),
    overrides: <Override>[if (dark) themeModeProvider.overrideWith(_Dark.new)],
  );
  return server;
}

Future<void> _offline(WidgetTester tester, ScriptedServer server) async {
  server.offline = true;
  await tester.tap(find.byTooltip('Làm mới'));
  await tester.pumpAndSettle();
  expect(find.textContaining('Đang hiển thị dữ liệu đã lưu trên máy'), findsOneWidget);
}

void _minutes(ScriptedServer server) {
  final Map<String, Object?> one = acc.minutes(signatures: <Map<String, Object?>>[acc.signature('CONTRACTOR', method: 'DIGITAL_CERT', name: 'Lê Nhà Thầu', serial: 'SN-0099'), acc.signature('SUPERVISOR')]);
  server
    ..on('GET', '/quality-acceptances', (_) => acc.minutesPage(<Map<String, Object?>>[acc.minutes(id: 'qa-2', recordNo: 'QA-W-002', canApprove: false, canReject: false), one]))
    ..on('GET', '/quality-acceptances/qa-1', (_) => one);
}

void _handover(ScriptedServer server) {
  final Map<String, Object?> blocked = acc.handover('h-1');
  server
    ..on('GET', '/resources/handover', (_) => acc.page(<Object?>[acc.handover('h-2', no: 'BG-002', status: 'ACCEPTED', items: 0, critical: 0, unit: 'Sở Giao thông'), blocked]))
    ..on('GET', '/warranty-obligations', (_) => acc.page(<Object?>[acc.warranty('w-1'), acc.warranty('w-2', status: 'EXPIRED', ends: '2027-01-01')]))
    ..on('GET', '/handovers/h-1/trace', (_) => acc.trace(blocked, <Map<String, Object?>>[acc.punchItem('p-1', 1), acc.punchItem('p-2', 2, severity: 'MINOR', status: 'VERIFIED'), acc.punchItem('p-3', 3, severity: 'MAJOR', status: 'FIXED', overdue: true)]));
}

void _payments(ScriptedServer server) {
  server
    ..on('GET', '/resources/project', (_) => pay.page(<Object?>[pay.project('p-1', 'DA-001', 'Đường vành đai 1')]))
    ..on('GET', '/payment-chain', (_) => pay.chain())
    ..on('GET', '/resources/payment_request/pr-1', (_) => pay.paymentRequest('pr-1'))
    ..on('GET', '/resources/payment_request/pr-2', (_) => pay.paymentRequest('pr-2', no: 'PR-A-002', status: 'SETTLED', kind: 'ADVANCE', gross: '1000000000', net: '1000000000', paidOn: '2026-10-20'))
    ..on('GET', '/reconciliation-items', (_) => pay.board(<Map<String, Object?>>[pay.item('i-1'), pay.item('i-2', kind: 'MISSING_CONFIRMATION', internal: '500000000', confirmed: null, difference: null, overdue: true, due: '2026-10-05T03:00:00Z')]))
    ..on('GET', '/reconciliation-items/i-1', (_) => pay.item('i-1'));
}

Map<String, Object?> _grants() => <String, Object?>{
      'items': <Object?>[
        <String, Object?>{'id': 'g-1', 'status': 'Active', 'valid_from': '2026-11-01T00:00:00.000Z', 'valid_until': '2026-12-01T00:00:00.000Z', 'permissions': <Object?>['a.read', 'b.read'], 'reason': 'Công tác nước ngoài'},
      ],
      'next_cursor': null,
      'as_of': '2026-11-03T03:00:00.000Z',
    };

Map<String, Object?> _absences() => <String, Object?>{
      'items': <Object?>[
        <String, Object?>{'id': 'a-1', 'membership_id': 'm-1', 'name': 'Trần Thị Bình', 'kind': 'LEAVE', 'valid_from': '2026-11-10', 'valid_until': '2026-11-20', 'effective_until': '2026-11-20', 'status': 'APPROVED', 'phase': 'ACTIVE', 'coverage': 'UNCOVERED', 'reason': null, 'version': 1},
      ],
      'pending_covers': <Object?>[],
      'rule': <String, Object?>{'code': 'ALERT_COVERAGE', 'version': '2', 'unverified': true, 'formula': 'f', 'source': 's', 'as_of': '2026-11-01', 'params': <String, Object?>{}},
      'as_of': '2026-11-03T03:00:00.000Z',
    };

void _governance(ScriptedServer server) {
  server
    ..on('GET', '/resources/delegation_grant', (_) => _grants())
    ..on('GET', '/home/alert-absences', (_) => _absences())
    ..on('GET', '/home/kpi-register', (_) => <String, Object?>{
          'as_of': '2026-11-03',
          'definitions': <Object?>[
            <String, Object?>{'code': 'DISB', 'name': 'Tỷ lệ giải ngân', 'version': 2, 'formula': 'a / b', 'numerator': 'đã giải ngân', 'denominator': 'kế hoạch vốn', 'unit': '%', 'period': 'MONTH', 'source': 'Kho bạc', 'owner': 'Phòng Kế hoạch', 'certification': <String, Object?>{'status': 'CERTIFIED'}},
            <String, Object?>{'code': 'LATE', 'name': 'Số việc quá hạn', 'version': 1, 'unverified': true},
          ],
        })
    ..on('GET', '/report-engine/catalogue', (_) => <String, Object?>{
          'demo_mode': false,
          'can_generate': true,
          'as_of': '2026-11-03',
          'items': <Object?>[
            <String, Object?>{'code': 'BC01', 'name': 'Báo cáo giải ngân', 'version': '1', 'edition': 'PUBLIC', 'status': 'ACTIVE', 'official': 'OFFICIAL', 'form_ref': null, 'receiver': 'UBND tỉnh', 'period_kind': 'MONTH', 'has_narrative': false, 'registered': true, 'issuable': true},
            <String, Object?>{'code': 'BC02', 'name': 'Báo cáo quý', 'version': '2', 'edition': 'PUBLIC', 'status': 'ACTIVE', 'official': 'OFFICIAL', 'form_ref': null, 'receiver': 'Sở Tài chính', 'period_kind': 'QUARTER', 'has_narrative': false, 'registered': false, 'issuable': false},
          ],
        });
}

Future<void> _golden(String name) => expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/$name.png'));

void main() {
  useTolerantGoldens('test/golden/acceptance_payment_reads_golden_test.dart', tolerance: kTextGoldenTolerance);
  final List<MobileFeature> acceptanceFeature = <MobileFeature>[acceptance.feature];
  final List<MobileFeature> paymentFeature = <MobileFeature>[payments.feature];
  final List<MobileFeature> readsFeature = <MobileFeature>[reads.feature];

  group('MUX-3 wave B acceptance minutes (MOB-65)', () {
    const String detail = '/approval/mob-65?acceptance=qa-1';

    testWidgets('detail light', (WidgetTester tester) async {
      await _open(tester, acceptanceFeature, detail, _minutes);
      expect(find.text('Duyệt biên bản'), findsOneWidget);
      await _golden('accept_detail_light');
    });

    testWidgets('detail dark', (WidgetTester tester) async {
      await _open(tester, acceptanceFeature, detail, _minutes, dark: true);
      expect(Theme.of(tester.element(find.text('Duyệt biên bản'))).brightness, Brightness.dark);
      await _golden('accept_detail_dark');
    });

    testWidgets('detail text 200 percent', (WidgetTester tester) async {
      await _open(tester, acceptanceFeature, detail, _minutes, scale: 2.0);
      await _golden('accept_detail_text200');
    });

    testWidgets('detail offline: the copy locks the decision and says why', (WidgetTester tester) async {
      final ScriptedServer server = await _open(tester, acceptanceFeature, detail, _minutes);
      await _offline(tester, server);
      expect(find.textContaining('Cần kết nối mạng để ký hoặc duyệt'), findsOneWidget);
      await _golden('accept_detail_offline');
    });

    testWidgets('the sheet that confirms an approval', (WidgetTester tester) async {
      await _open(tester, acceptanceFeature, detail, _minutes, size: const Size(390, 2600));
      await tester.enterText(find.widgetWithText(TextField, 'Ý kiến của bạn (bắt buộc)'), 'Đồng ý nghiệm thu');
      await tester.tap(find.widgetWithText(FilledButton, 'Duyệt biên bản'));
      await tester.pumpAndSettle();
      expect(find.text('Xác nhận duyệt biên bản'), findsOneWidget);
      await _golden('accept_confirm_sheet');
    });

    testWidgets('list light and empty', (WidgetTester tester) async {
      await _open(tester, acceptanceFeature, '/approval/mob-65', _minutes);
      expect(find.text('Chờ bạn xử lý'), findsOneWidget);
      await _golden('accept_list_light');
      await _open(tester, acceptanceFeature, '/approval/mob-65', (ScriptedServer server) => server.on('GET', '/quality-acceptances', (_) => acc.minutesPage(<Map<String, Object?>>[])));
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await _golden('accept_list_empty');
    });
  });

  group('MUX-3 wave B handover (MOB-66)', () {
    testWidgets('list light, dark and text 200', (WidgetTester tester) async {
      await _open(tester, acceptanceFeature, '/projects/mob-66', _handover);
      expect(find.text('BG-001'), findsOneWidget);
      await _golden('accept_handover_light');
      await _open(tester, acceptanceFeature, '/projects/mob-66', _handover, dark: true);
      await _golden('accept_handover_dark');
      await _open(tester, acceptanceFeature, '/projects/mob-66', _handover, scale: 2.0);
      await _golden('accept_handover_text200');
    });

    testWidgets('detail with its punch list and warranty', (WidgetTester tester) async {
      await _open(tester, acceptanceFeature, '/projects/mob-66?handover=h-1', _handover);
      expect(find.text('BG-001'), findsOneWidget);
      await _golden('accept_handover_detail_light');
    });
  });

  group('MUX-3 wave B payment tracking (MOB-27)', () {
    const String chain = '/projects/mob-27?project=p-1';

    testWidgets('chain light, dark and text 200', (WidgetTester tester) async {
      await _open(tester, paymentFeature, chain, _payments);
      expect(find.text('PR-A-001'), findsOneWidget);
      await _golden('payment_chain_light');
      await _open(tester, paymentFeature, chain, _payments, dark: true);
      await _golden('payment_chain_dark');
      await _open(tester, paymentFeature, chain, _payments, scale: 2.0);
      await _golden('payment_chain_text200');
    });

    testWidgets('timeline of a request that was paid, light and dark', (WidgetTester tester) async {
      await _open(tester, paymentFeature, '$chain&request=pr-2', _payments, size: _tall);
      expect(find.text('Kho bạc đã thanh toán'), findsOneWidget);
      await _golden('payment_request_light');
      await _open(tester, paymentFeature, '$chain&request=pr-2', _payments, dark: true, size: _tall);
      await _golden('payment_request_dark');
    });

    testWidgets('a chain with no request in it', (WidgetTester tester) async {
      await _open(tester, paymentFeature, chain, (ScriptedServer server) {
        _payments(server);
        server.on('GET', '/payment-chain', (_) => <String, Object?>{...pay.chain(), 'nodes': <Object?>[pay.node('project', 'p-1', 'DA-001', contract: null)]});
      });
      expect(find.text('Chưa có đề nghị thanh toán nào.'), findsOneWidget);
      await _golden('payment_chain_empty');
    });
  });

  group('MUX-3 wave B reconciliation (MOB-60)', () {
    testWidgets('board light, dark and text 200', (WidgetTester tester) async {
      await _open(tester, paymentFeature, '/projects/mob-60', _payments);
      expect(find.text('Lệch số tiền'), findsOneWidget);
      await _golden('payment_board_light');
      await _open(tester, paymentFeature, '/projects/mob-60', _payments, dark: true);
      await _golden('payment_board_dark');
      await _open(tester, paymentFeature, '/projects/mob-60', _payments, scale: 2.0);
      await _golden('payment_board_text200');
    });

    testWidgets('board empty', (WidgetTester tester) async {
      await _open(tester, paymentFeature, '/projects/mob-60', (ScriptedServer server) {
        _payments(server);
        server.on('GET', '/reconciliation-items', (_) => pay.board(<Map<String, Object?>>[], waiting: 0, overdue: 0, difference: '0'));
      });
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      await _golden('payment_board_empty');
    });

    testWidgets('item: the two figures, the mismatch with shape and words, and the form', (WidgetTester tester) async {
      await _open(tester, paymentFeature, '/projects/mob-60?item=i-1', _payments, size: _tall);
      expect(find.text('Kho bạc xác nhận ít hơn số nội bộ.'), findsOneWidget);
      await _golden('payment_item_light');
      await _open(tester, paymentFeature, '/projects/mob-60?item=i-1', _payments, dark: true, size: _tall);
      await _golden('payment_item_dark');
      await _open(tester, paymentFeature, '/projects/mob-60?item=i-1', _payments, scale: 2.0, size: _tall);
      await _golden('payment_item_text200');
    });

    testWidgets('item offline: the copy locks the form and says why', (WidgetTester tester) async {
      final ScriptedServer server = await _open(tester, paymentFeature, '/projects/mob-60?item=i-1', _payments);
      await _offline(tester, server);
      expect(find.textContaining('Cần kết nối mạng để ghi giải trình'), findsOneWidget);
      await _golden('payment_item_offline');
    });
  });

  group('MUX-3 wave B governance reads (MOB-75, 76, 77)', () {
    testWidgets('delegations light, dark and text 200', (WidgetTester tester) async {
      await _open(tester, readsFeature, '/account/mob-75', _governance);
      expect(find.textContaining('Công tác nước ngoài'), findsOneWidget);
      await _golden('reads_delegations_light');
      await _open(tester, readsFeature, '/account/mob-75', _governance, dark: true);
      await _golden('reads_delegations_dark');
      await _open(tester, readsFeature, '/account/mob-75', _governance, scale: 2.0);
      await _golden('reads_delegations_text200');
    });

    testWidgets('absences tab with the uncovered absence', (WidgetTester tester) async {
      await _open(tester, readsFeature, '/account/mob-75', _governance);
      await tester.tap(find.textContaining('Vắng mặt'));
      await tester.pumpAndSettle();
      expect(find.text('Chưa có người thay'), findsOneWidget);
      await _golden('reads_absences_light');
    });

    testWidgets('KPI register light and dark', (WidgetTester tester) async {
      await _open(tester, readsFeature, '/account/mob-76', _governance);
      expect(find.text('Tỷ lệ giải ngân'), findsOneWidget);
      await _golden('reads_kpi_light');
      await _open(tester, readsFeature, '/account/mob-76', _governance, dark: true);
      await _golden('reads_kpi_dark');
    });

    testWidgets('report catalogue light and text 200', (WidgetTester tester) async {
      await _open(tester, readsFeature, '/account/mob-77', _governance);
      expect(find.text('Báo cáo giải ngân'), findsOneWidget);
      await _golden('reads_reports_light');
      await _open(tester, readsFeature, '/account/mob-77', _governance, scale: 2.0);
      await _golden('reads_reports_text200');
    });
  });
}
