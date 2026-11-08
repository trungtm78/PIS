import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/vendor_controls/screens/contractor_screen.dart';
import 'package:machvon_mobile/features/vendor_controls/screens/risk_list_screen.dart';
import 'package:machvon_mobile/features/vendor_controls/vendor_models.dart';

import '../../support/harness.dart';
import '../support/screen_contract.dart';
import '../support/scripted_server.dart';
import 'vendor_host.dart';

/// MOB-73 and MOB-74: the grades of risk and the performance of the contractors for an officer. Read only; a grade is a signal with its explanation.

const String _list = '/vendor/risk-grades';
const String _risk = '/vendor/contractors/c-1/risk';
const String _performance = '/vendor/contractors/c-1/performance';

const Size _veryTall = Size(390, 6000);

void _registerList(ScriptedServer server, [Map<String, Object?>? page]) => server.on('GET', _list, (_) => page ?? riskPage(<Map<String, Object?>>[riskItem('c-1', 'Công ty Xây dựng An Phát', 'HIGH', 52, overdue: true, pending: 'CRITICAL'), riskItem('c-2', 'Công ty Cơ khí Bình Minh', 'LOW', 8)]));

void _registerDetail(ScriptedServer server, {Map<String, Object?>? risk, Map<String, Object?>? perf}) {
  server.on('GET', _risk, (_) => risk ?? riskGrade());
  server.on('GET', _performance, (_) => perf ?? performance());
}

void main() {
  group('the models of the contractor controls', () {
    test('a page keeps the rule, the counts and the tiers as sent; a row without a tier or a score is left out', () {
      final VendorRiskPage page = parseVendorRiskPage(riskPage(<Map<String, Object?>>[riskItem('c-1', 'A', 'CRITICAL', 91), <String, Object?>{'contractor_id': 'broken'}]))!;
      expect(page.items, hasLength(1));
      expect(page.items.single.tier, VendorTier.critical);
      expect(page.figures.single.denominator, 9);
      expect(page.policy!.unverified, isTrue);
      expect(parseVendorRiskPage(<String, Object?>{'items': <Object?>[]}), isNull, reason: 'no day, no page');
    });

    test('a contractor never graded is kept, with no tier and no score, in the list and in the detail (Codex review P1)', () {
      final Map<String, Object?> ungraded = riskItem('c-9', 'Công ty Mới', 'LOW', 0, pending: 'MEDIUM')
        ..['tier'] = null
        ..['score'] = null
        ..['next_review_on'] = null;
      final VendorRiskPage page = parseVendorRiskPage(riskPage(<Map<String, Object?>>[ungraded], next: 'c-9'))!;
      expect(page.items, hasLength(1));
      expect(page.items.single.tier, isNull);
      expect(page.items.single.score, isNull);
      expect(page.items.single.pendingTier, VendorTier.medium);
      expect(page.nextCursor, 'c-9', reason: 'the pages after a page of ungraded contractors are still reachable');
      final Map<String, Object?> grade = riskGrade()
        ..['tier'] = null
        ..['confirmed'] = null;
      final VendorRiskDetail detail = parseVendorRiskDetail(grade)!;
      expect(detail.tier, isNull);
      expect(detail.pending, isNotNull);
    });

    test('the grade of one contractor keeps the factors in the server\'s order and the readings as text; the performance is optional', () {
      final VendorDetailData data = parseVendorDetailData(<String, Object?>{'risk': riskGrade(), 'performance': performance()})!;
      expect(data.risk.tier, VendorTier.high);
      expect(data.risk.live!.factors.map((VendorFactor factor) => factor.factor), <String>['RESTRICTION', 'PROFILE_GAP', 'FINANCE_BELOW', 'LOAD_OVER']);
      expect(data.risk.live!.factors[1].reading['coverage_pct'], '60');
      expect(data.risk.live!.reasons, <String>['RESTRICTION', 'PROFILE_GAP']);
      expect(data.risk.pending!.tier, VendorTier.critical);
      expect(data.performance!.lines, hasLength(2));
      final VendorDetailData noPerformance = parseVendorDetailData(<String, Object?>{'risk': riskGrade(), 'performance_error': 'SCOPE_DENIED'})!;
      expect(noPerformance.performance, isNull);
      expect(noPerformance.performanceError, 'SCOPE_DENIED');
      expect(parseVendorDetailData(<String, Object?>{'performance': performance()}), isNull, reason: 'without the grade there is no screen');
    });
  });

  group('MOB-73 the grades of risk', () {
    testWidgets('lists the contractors with the tier in an icon and a word, the score, the next review, a review that is late and a grade waiting; says what it stands on', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      _registerList(server);
      await openVendorScreen(tester, server, const RiskListScreen());

      expect(find.text('Công ty Xây dựng An Phát'), findsOneWidget);
      expect(find.text('Công ty Cơ khí Bình Minh'), findsOneWidget);
      expect(find.text('Cao'), findsNWidgets(2), reason: 'the filter and the tier of the first contractor');
      expect(find.text('Thấp'), findsNWidgets(2), reason: 'the filter and the tier of the second contractor');
      expect(find.text('Điểm 52'), findsOneWidget);
      expect(find.text('Quá hạn xét lại, hạn là 03/02/2027'), findsOneWidget);
      expect(find.text('Xét lại vào 03/02/2027'), findsOneWidget);
      expect(find.text('Có mức đề xuất chờ xác nhận: Nghiêm trọng'), findsOneWidget);
      expect(find.text('Hiển thị 2 nhà thầu'), findsOneWidget);
      expect(find.text('VENDOR_RISK_HIGH_SHARE: 2/9'), findsOneWidget);
      expect(find.text('Quy tắc VENDOR_RISK, phiên bản 3'), findsOneWidget);
      expect(find.text('Các ngưỡng của quy tắc chưa được kiểm chứng.'), findsOneWidget);
      expect(find.textContaining('Chỉ đọc.'), findsOneWidget);
      expect(find.bySemanticsLabel('Công ty Xây dựng An Phát, Cao'), findsOneWidget);
    });

    testWidgets('a filter asks the server (tier, review overdue, waiting) and nothing is cut on the phone; "all" comes back', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      _registerList(server);
      await openVendorScreen(tester, server, const RiskListScreen());

      await tester.ensureVisible(find.text('Nghiêm trọng'));
      await tester.tap(find.text('Nghiêm trọng'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', _list).last.url.queryParameters['tier'], 'CRITICAL');
      await tester.ensureVisible(find.text('Quá hạn xét lại'));
      await tester.tap(find.text('Quá hạn xét lại'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', _list).last.url.queryParameters['review_due'], 'true');
      expect(server.callsTo('GET', _list).last.url.queryParameters.containsKey('tier'), isFalse);
      await tester.ensureVisible(find.text('Đang chờ xác nhận'));
      await tester.tap(find.text('Đang chờ xác nhận'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', _list).last.url.queryParameters['pending'], 'true');
    });

    testWidgets('a tap opens the contractor; the next page is asked with the cursor and appended; a failure says so in place', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final List<String> opened = <String>[];
      final ScriptedServer server = ScriptedServer();
      int calls = 0;
      server.on('GET', _list, (call) {
        calls += 1;
        if (call.url.queryParameters['cursor'] == null) return riskPage(<Map<String, Object?>>[riskItem('c-1', 'Công ty An Phát', 'HIGH', 52)], next: 'c-1');
        if (calls == 2) throw StateError('connection lost');
        return riskPage(<Map<String, Object?>>[riskItem('c-3', 'Công ty Hòa Bình', 'MEDIUM', 30)]);
      });
      await openVendorScreen(tester, server, RiskListScreen(open: (BuildContext context, String id) => opened.add(id)));

      await tester.tap(find.text('Công ty An Phát'));
      expect(opened, <String>['c-1']);
      await tester.tap(find.text('Xem thêm'));
      await tester.pumpAndSettle();
      expect(find.text('Chưa đọc được trang tiếp theo.'), findsOneWidget);
      expect(find.text('Công ty An Phát'), findsOneWidget, reason: 'what was shown stays');
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('Công ty Hòa Bình'), findsOneWidget);
      expect(find.text('Hiển thị 2 nhà thầu'), findsOneWidget);
    });

    testWidgets('a contractor never graded is listed and says so in a word and a shape, without a score; its detail opens (Codex review P1)', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      final Map<String, Object?> ungraded = riskItem('c-9', 'Công ty Mới', 'LOW', 0, pending: 'MEDIUM')
        ..['tier'] = null
        ..['score'] = null
        ..['next_review_on'] = null;
      _registerList(server, riskPage(<Map<String, Object?>>[ungraded]));
      await openVendorScreen(tester, server, const RiskListScreen());

      expect(find.text('Công ty Mới'), findsOneWidget);
      expect(find.text('Chưa xếp hạng'), findsOneWidget);
      expect(find.textContaining('Điểm '), findsNothing, reason: 'a score that does not exist is not drawn as 0');
      expect(find.text('Có mức đề xuất chờ xác nhận: Trung bình'), findsOneWidget);
      expect(find.bySemanticsLabel('Công ty Mới, Chưa xếp hạng'), findsOneWidget);
    });

    testWidgets('a refresh gives the list the new first page: rows and cursor of the old page are dropped (Codex review P2)', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      int reads = 0;
      server.on('GET', _list, (call) {
        reads += 1;
        return reads == 1
            ? riskPage(<Map<String, Object?>>[riskItem('c-1', 'Công ty An Phát', 'HIGH', 52)], next: 'c-1')
            : riskPage(<Map<String, Object?>>[riskItem('c-2', 'Công ty Bình Minh', 'LOW', 8)]);
      });
      await openVendorScreen(tester, server, const RiskListScreen());
      expect(find.text('Công ty An Phát'), findsOneWidget);
      expect(find.text('Xem thêm'), findsOneWidget);

      await tester.tap(find.byTooltip('Làm mới'));
      await tester.pumpAndSettle();

      expect(find.text('Công ty Bình Minh'), findsOneWidget);
      expect(find.text('Công ty An Phát'), findsNothing, reason: 'the row of the old page is gone');
      expect(find.text('Xem thêm'), findsNothing, reason: 'the cursor of the old page is gone');
      expect(find.text('Hiển thị 1 nhà thầu'), findsOneWidget);
    });

    testWidgets('the filters can be used from the screen reader: each one has a tap action (Codex review P2)', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final ScriptedServer server = ScriptedServer();
      _registerList(server);
      await openVendorScreen(tester, server, const RiskListScreen());

      final SemanticsNode node = tester.getSemantics(find.bySemanticsLabel('Quá hạn xét lại'));
      expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      await tester.ensureVisible(find.text('Quá hạn xét lại'));
      tester.semantics.tap(find.semantics.byLabel('Quá hạn xét lại'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', _list).last.url.queryParameters['review_due'], 'true');
      semantics.dispose();
    });

    testWidgets('English words', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      _registerList(server);
      await openVendorScreen(tester, server, const RiskListScreen(), locale: const Locale('en'));
      expect(find.text('Contractor risk grades'), findsOneWidget);
      expect(find.text('Review overdue, it was due 03/02/2027'), findsOneWidget);
      expect(find.text('Score 52'), findsOneWidget);
    });

    testWidgets('every state, and the screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) => openVendorScreen(tester, server, const RiskListScreen()).then((_) {});
      await expectEveryState(
        tester,
        open: open,
        script: StateScript(healthy: _registerList, content: find.text('Công ty Xây dựng An Phát'), empty: (ScriptedServer server) => _registerList(server, riskPage(<Map<String, Object?>>[]))),
      );
      await expectScreenContract(tester, open: open, healthy: _registerList);
    });
  });

  group('MOB-74 one contractor', () {
    testWidgets('the grade it carries, the grade from today\'s data and why the tier is higher, the factors with their readings in words, the reasons in order', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      _registerDetail(server);
      await openVendorScreen(tester, server, const ContractorScreen(contractorId: 'c-1'));

      expect(find.text('Công ty Xây dựng An Phát'), findsOneWidget);
      expect(find.text('Mức đã xác nhận: Cao'), findsOneWidget);
      expect(find.text('Tính từ số liệu hiện tại: Cao, 14 điểm'), findsOneWidget);
      expect(find.text('Điểm chỉ cho mức Thấp, nhưng quy tắc giữ mức cao hơn vì còn hạn chế đang hiệu lực.'), findsOneWidget);
      expect(find.text('Xét lại sau 6 tháng, lần tới vào 03/05/2027'), findsOneWidget);
      expect(find.text('Mức này cần người thứ hai xác nhận.'), findsOneWidget);
      expect(find.text('Hạn chế đang hoặc đã có hiệu lực: 10/10 điểm'), findsOneWidget);
      expect(find.text('Hồ sơ năng lực còn thiếu: 4/10 điểm'), findsOneWidget);
      expect(find.text('Hồ sơ đầy đủ (%): 60'), findsOneWidget);
      expect(find.text('Tài chính: Đạt'), findsOneWidget);
      expect(find.text('Khối lượng: Trong năng lực'), findsOneWidget);
      expect(find.text('1. Hạn chế đang hoặc đã có hiệu lực'), findsOneWidget);
      expect(find.text('2. Hồ sơ năng lực còn thiếu'), findsOneWidget);
      expect(find.text('Quy tắc VENDOR_RISK, phiên bản 3'), findsWidgets);
    });

    testWidgets('a grade that is proposed waits for a second person: the phone shows it and offers no decision; the history lists every assessment with who and why', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      _registerDetail(server);
      await openVendorScreen(tester, server, const ContractorScreen(contractorId: 'c-1'));

      expect(find.text('Mức đề xuất đang chờ'), findsOneWidget);
      expect(find.text('Người thứ hai quyết định trên máy tính; điện thoại chỉ cho xem.'), findsOneWidget);
      expect(find.text('Nghiêm trọng, 81 điểm, ngày 20/10/2026'), findsWidgets);
      expect(find.text('Người chấm: Trần Thị Bình'), findsWidgets);
      expect(find.text('Người quyết định: Lê Văn Cường'), findsWidgets);
      expect(find.text('Đã được thay bằng lần chấm mới'), findsOneWidget);
      expect(find.text('Quy tắc lúc đó chưa được kiểm chứng.'), findsWidgets);
      expect(find.byType(ElevatedButton), findsNothing);
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(OutlinedButton), findsNothing);
    });

    testWidgets('the performance: the run of poor ratings, a suggestion that is for a person, each rating with its icon and word, the clock of its posting and the review of the response', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      _registerDetail(server);
      await openVendorScreen(tester, server, const ContractorScreen(contractorId: 'c-1'));

      expect(find.text('Xếp loại kém liên tiếp: 2'), findsOneWidget);
      expect(find.textContaining('Gợi ý: yêu cầu kế hoạch khắc phục.'), findsOneWidget);
      expect(find.text('HD-001 · Giai đoạn 2'), findsOneWidget);
      expect(find.text('Kém'), findsOneWidget);
      expect(find.text('Tốt'), findsOneWidget);
      expect(find.text('Đăng tải: quá hạn'), findsOneWidget);
      expect(find.text('Đăng tải: đã đăng đúng hạn'), findsOneWidget);
      expect(find.text('Phản hồi của nhà thầu: chưa có'), findsOneWidget);
      expect(find.text('Phản hồi của nhà thầu: đã xử lý xong'), findsOneWidget);
      expect(find.text('Hạn đăng tải 10/10/2026'), findsNWidgets(2));
      expect(find.text('Đã cập nhật 1 lần sau khi đăng'), findsOneWidget);
      expect(find.text('Điểm 62.5'), findsNWidgets(2));
    });

    testWidgets('a performance that cannot be read says so with the code and the risk part stays', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      server.on('GET', _risk, (_) => riskGrade());
      server.refuse('GET', _performance, 403, 'SCOPE_DENIED');
      await openVendorScreen(tester, server, const ContractorScreen(contractorId: 'c-1'));

      expect(find.textContaining('Chưa đọc được kết quả thực hiện (mã SCOPE_DENIED)'), findsOneWidget);
      expect(find.text('Mức đã xác nhận: Cao'), findsOneWidget);
    });

    testWidgets('a contractor with no rating and no pending grade says so instead of showing empty blocks', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      final Map<String, Object?> risk = riskGrade()
        ..['pending'] = null
        ..['confirmed'] = null
        ..['history'] = <Object?>[];
      _registerDetail(server, risk: risk, perf: performance(lines: <Map<String, Object?>>[], suggestion: 'NONE', streak: 0));
      await openVendorScreen(tester, server, const ContractorScreen(contractorId: 'c-1'));

      expect(find.text('Chưa có lần chấm nào được xác nhận.'), findsOneWidget);
      expect(find.text('Chưa có lần chấm nào.'), findsOneWidget);
      expect(find.text('Chưa có xếp loại nào được chấp thuận.'), findsOneWidget);
      expect(find.text('Mức đề xuất đang chờ'), findsNothing);
      expect(find.textContaining('Gợi ý:'), findsNothing);
    });

    testWidgets('a contractor never graded opens: it says no grade was confirmed and still shows the proposal waiting (Codex review P1)', (WidgetTester tester) async {
      useDevice(tester, _veryTall);
      final ScriptedServer server = ScriptedServer();
      final Map<String, Object?> grade = riskGrade()
        ..['tier'] = null
        ..['confirmed'] = null;
      _registerDetail(server, risk: grade);
      await openVendorScreen(tester, server, const ContractorScreen(contractorId: 'c-1'));

      expect(find.text('Chưa có mức rủi ro nào được xác nhận cho nhà thầu này.'), findsOneWidget);
      expect(find.text('Chưa xếp hạng'), findsOneWidget);
      expect(find.text('Mức đề xuất đang chờ'), findsOneWidget);
    });

    testWidgets('every state, and the screen contract at the three devices and at 200 percent text', (WidgetTester tester) async {
      Future<void> open(WidgetTester tester, ScriptedServer server) => openVendorScreen(tester, server, const ContractorScreen(contractorId: 'c-1')).then((_) {});
      await expectEveryState(tester, open: open, script: StateScript(healthy: _registerDetail, content: find.text('Công ty Xây dựng An Phát')));
      await expectScreenContract(tester, open: open, healthy: _registerDetail);
    });
  });
}
