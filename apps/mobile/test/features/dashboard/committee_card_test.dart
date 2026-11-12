import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show HttpCall;
import 'package:machvon_mobile/core/l10n/string_table.dart' show isValidStringKey;
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/widgets/figure_info.dart';
import 'package:machvon_mobile/features/dashboard/committee_workspace.dart';
import 'package:machvon_mobile/features/dashboard/dashboard_feature.dart' as dashboard;
import 'package:machvon_mobile/features/dashboard/dashboard_strings.dart';
import 'package:machvon_mobile/features/dashboard/widgets/committee_card.dart' show CommitteeCard;

import '../../support/harness.dart';
import '../support/scripted_server.dart';
import 'committee_fixtures.dart';
import 'dashboard_fixtures.dart';

/// The committee workspace on the phone (BAN-1): the card of the head of the steering committee on the leader home. The figures are read from the core, there
/// is no marker of a simulation anywhere, every figure has its "i", and the server writes an audit row for every view, so the card reads once per opening and
/// once per press of its refresh button.

const String _path = '/committee/workspace';

/// The words of a simulation or of a demonstration, in both languages: none of them is on the card, in the strings or in the tree.
final RegExp _simulation = RegExp(r'm[oô] ph[oỏ]ng|simulat|demonstrat|\bdemo\b|gi[aả] l[aậ]p|sample data|fake', caseSensitive: false);

Future<ProviderContainer> _open(WidgetTester tester, ScriptedServer server, {Locale locale = const Locale('vi'), List<Override> overrides = const <Override>[]}) =>
    pumpWithServer(tester, features: <MobileFeature>[dashboard.feature], server: server, location: '/home', locale: locale, overrides: overrides);

/// The home with its command center and the committee workspace healthy.
ScriptedServer _healthy({Map<String, Object?>? workspace}) => ScriptedServer()
  ..on('GET', '/home/command-center', (_) => commandCenter())
  ..on('GET', '/home/my-work', (_) => myWork(<Map<String, Object?>>[]))
  ..on('GET', _path, (_) => workspace ?? committeeWorkspace());

/// The card alone: the home has figures of its own (rates, counts) that are not the committee's.
Finder _card(Finder inner) => find.descendant(of: find.byKey(const ValueKey<String>('committee-workspace')), matching: inner);

Finder _info(String name) => find.byTooltip('Công thức và nguồn của $name');

/// Every text that is drawn, joined.
String _allText(WidgetTester tester) => <String>[
      for (final Text widget in tester.widgetList<Text>(find.byType(Text)))
        if (widget.data != null) widget.data!,
    ].join('\n');

class _SeededRefusals extends CommitteeRefusals {
  @override
  Set<String> build() => const <String>{'tenant-a/user-1'};
}

void main() {
  group('BAN-1 the card: the figures of the committee, read from the core', () {
    testWidgets('populated: the rate, the gap with its words and shape, the plan, the amounts, the band, the counts, the top three projects and the live alerts', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final ScriptedServer server = _healthy();
      await _open(tester, server);

      expect(find.text('Bảng điều hành Ban chỉ đạo'), findsOneWidget);
      expect(find.text('Số liệu đến ngày 31/10/2026, năm 2026'), findsOneWidget);
      // The colour is a word with an icon, never a colour alone.
      expect(find.text('Vàng: chậm so với đường kỳ vọng'), findsOneWidget);
      expect(find.byIcon(Icons.warning_amber_rounded), findsWidgets);
      expect(find.text('41,20%'), findsOneWidget);
      expect(find.text('-4,10 điểm phần trăm'), findsOneWidget);
      expect(find.text('45,30%'), findsOneWidget, reason: 'the curve of today');
      expect(find.text('1.200 tỷ đồng'), findsOneWidget, reason: 'the plan');
      expect(find.text('494,4 tỷ đồng'), findsOneWidget, reason: 'disbursed');
      expect(find.text('420 tỷ đồng'), findsOneWidget, reason: 'the same period of last year');
      expect(find.text('Từ 1.000 tỷ đồng đến 1.100 tỷ đồng (83,33% đến 91,67% kế hoạch)'), findsOneWidget, reason: 'the year-end band');
      expect(find.descendant(of: find.byType(CommitteeCard), matching: find.text('7')), findsOneWidget, reason: 'projects needing attention');
      expect(find.descendant(of: find.byType(CommitteeCard), matching: find.text('2')), findsOneWidget, reason: 'units not reporting');
      expect(find.descendant(of: find.byType(CommitteeCard), matching: find.text('1')), findsOneWidget, reason: 'overdue directives');
      expect(server.callsTo('GET', _path), hasLength(1), reason: 'one read per opening');
    });

    testWidgets('the attention list is the top three by rank, with the code, the name and the reasons as words', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      await _open(tester, _healthy());

      expect(find.text('DA-001 · Đường vành đai 3'), findsOneWidget);
      expect(find.text('Lý do: Chậm tiến độ, Vướng thủ tục'), findsOneWidget);
      expect(find.text('DA-002 · Bệnh viện đa khoa'), findsOneWidget);
      expect(find.text('Lý do: Nguy cơ vượt dự toán, Giải ngân thấp xa kế hoạch'), findsOneWidget);
      expect(find.text('DA-003 · Cầu vượt sông Hồng'), findsOneWidget);
      expect(find.text('DA-004 · Trường học xã B'), findsNothing, reason: 'only three are listed');
      expect(find.text('Còn 4 dự án khác trong danh sách đầy đủ trên máy tính.'), findsOneWidget);
      expect(tester.getTopLeft(find.text('DA-001 · Đường vành đai 3')).dy, lessThan(tester.getTopLeft(find.text('DA-002 · Bệnh viện đa khoa')).dy));
      expect(tester.getTopLeft(find.text('DA-002 · Bệnh viện đa khoa')).dy, lessThan(tester.getTopLeft(find.text('DA-003 · Cầu vượt sông Hồng')).dy));
    });

    testWidgets('the live alerts say the type and the severity in words, with a shape, and a resolved alert is not live', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      await _open(tester, _healthy());

      expect(find.text('Toàn tỉnh chậm hơn đường kỳ vọng'), findsOneWidget);
      expect(find.text('Khẩn'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline), findsWidgets);
      expect(find.text('Đơn vị không báo cáo: Sở Xây dựng'), findsOneWidget);
      expect(find.text('Theo dõi'), findsOneWidget);
      expect(find.byIcon(Icons.visibility_outlined), findsOneWidget);
      expect(find.text('Chỉ đạo quá hạn'), findsOneWidget, reason: 'the label of the figure; the resolved alert of that type is not listed');
      expect(find.text('Cần xử lý'), findsNothing);
    });

    testWidgets('the words of the card in English', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      await _open(tester, _healthy(), locale: const Locale('en'));

      expect(find.text('Steering committee workspace'), findsOneWidget);
      expect(find.text('Amber: behind the expected curve'), findsOneWidget);
      expect(find.text('Gap to the expected curve'), findsOneWidget);
      expect(find.text('-4.10 percentage points'), findsOneWidget);
      expect(find.text('Urgent'), findsOneWidget);
      expect(find.text('Reasons: Behind schedule, Stuck in a procedure'), findsOneWidget);
    });

    testWidgets('the card fits a 360 pixel phone at the largest text, without overflow', (WidgetTester tester) async {
      useDevice(tester, const Size(360, 9000), textScale: 2.0);
      await _open(tester, _healthy());

      expect(find.text('Bảng điều hành Ban chỉ đạo'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('BAN-1 the "i" of every figure: formula, source and day from the answer', () {
    testWidgets('every one of the ten figures has an "i" and the one of the rate opens its definition in a sheet', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      await _open(tester, _healthy());

      for (final String name in <String>[
        kRateName,
        'Chênh lệch so với đường kỳ vọng',
        'Kế hoạch vốn của tỉnh',
        'Giải ngân của tỉnh',
        'Giải ngân cùng kỳ năm trước',
        'Dự báo cuối năm, mức thấp',
        'Dự báo cuối năm, mức cao',
        'Dự án cần quan tâm',
        'Đơn vị không báo cáo',
        'Chỉ đạo quá hạn',
      ]) {
        expect(_info(name), findsOneWidget, reason: name);
      }

      await tester.tap(_info(kRateName));
      await tester.pumpAndSettle();
      expect(find.byType(FigureInfoSheet), findsOneWidget);
      final Finder sheet = find.byType(FigureInfoSheet);
      for (final String text in <String>[kRateName, 'Công thức', 'Công thức của $kRateName', 'Nguồn', 'Lõi dữ liệu dùng chung', 'Số liệu đến ngày', '31/10/2026', 'Đơn vị chịu trách nhiệm', 'Văn phòng Ban chỉ đạo', '• Dòng vốn chưa có số liệu', 'Định nghĩa này là giá trị khởi điểm, chưa được chủ sở hữu số liệu xác nhận.']) {
        expect(find.descendant(of: sheet, matching: find.text(text)), findsOneWidget, reason: text);
      }
      await tester.tap(find.text('Đóng'));
      await tester.pumpAndSettle();
      expect(find.byType(FigureInfoSheet), findsNothing);
    });

    testWidgets('a figure the server sent without a definition has no "i" rather than an empty one', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final List<Map<String, Object?>> figures = committeeFigures();
      figures[2] = committeeFigure('COMMITTEE_DISBURSEMENT_RATE', kRateName, value: '41.2000', display: '41.20', info: false);
      await _open(tester, _healthy(workspace: committeeWorkspace(figures: figures)));

      expect(find.text('41,20%'), findsOneWidget);
      expect(_info(kRateName), findsNothing);
      expect(_info('Kế hoạch vốn của tỉnh'), findsOneWidget);
    });
  });

  group('BAN-1 unknown is never zero', () {
    testWidgets('a figure with no value says there is no figure and is not 0, and the colour is "no figure yet"', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final Map<String, Object?> workspace = committeeWorkspace(
        figures: committeeFigures(unknown: true),
        province: committeeProvince(rag: 'NO_DATA', known: 0, total: 3, band: false, outlookReason: 'NO_DATA'),
        attention: <Map<String, Object?>>[],
        attentionTotal: 0,
        alerts: <Map<String, Object?>>[],
      );
      await _open(tester, _healthy(workspace: workspace));

      expect(find.text('Chưa có số liệu'), findsWidgets);
      expect(find.text('Chưa đủ số liệu để dự báo'), findsOneWidget);
      expect(find.text('Chưa có số liệu'), findsAtLeastNWidgets(8));
      expect(_card(find.text('0%')), findsNothing);
      expect(_card(find.text('0,00%')), findsNothing);
      expect(_card(find.textContaining('0 triệu')), findsNothing);
      expect(_card(find.text('0')), findsNothing);
      expect(find.text('Không có dự án nào cần quan tâm theo các quy tắc hiện hành.'), findsOneWidget);
      expect(find.text('Không có cảnh báo nào đang mở.'), findsOneWidget);
    });

    testWidgets('a figure the register holds back says not certified, not "no data"', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final List<Map<String, Object?>> figures = committeeFigures();
      figures[2] = committeeFigure('COMMITTEE_DISBURSEMENT_RATE', kRateName, nullReason: 'NOT_CERTIFIED');
      figures[4] = committeeFigure('COMMITTEE_GAP_VS_CURVE', 'Chênh lệch so với đường kỳ vọng', nullReason: 'OBSOLETE');
      await _open(tester, _healthy(workspace: committeeWorkspace(figures: figures)));

      expect(find.text('Chưa chứng nhận'), findsOneWidget);
      expect(find.text('Định nghĩa đã lỗi thời'), findsOneWidget);
      expect(find.text('Chưa có số liệu'), findsOneWidget, reason: 'the colour of a gap that is not given is "no figure yet"');
      expect(find.text('Vàng: chậm so với đường kỳ vọng'), findsNothing, reason: 'no colour without the figure it comes from');
    });

    testWidgets('only some funding lines have a figure of last year: it says how many', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final List<Map<String, Object?>> figures = committeeFigures();
      figures[3] = committeeFigure('COMMITTEE_DISBURSED_LAST_YEAR', 'Giải ngân cùng kỳ năm trước', unit: 'VND');
      await _open(tester, _healthy(workspace: committeeWorkspace(figures: figures, province: committeeProvince(known: 2, total: 5))));

      expect(find.text('Chỉ 2/5 dòng vốn có số cùng kỳ'), findsOneWidget);
      expect(find.textContaining('420.000'), findsNothing);
    });

    testWidgets('a thin band says so', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      await _open(tester, _healthy(workspace: committeeWorkspace(province: committeeProvince(thin: true))));

      expect(find.text('Chỉ có một cách ước tính, nên dải này mỏng.'), findsOneWidget);
    });
  });

  group('BAN-1 the states of the card', () {
    testWidgets('loading: the card shows that it is loading, then the figures', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final Completer<void> slow = Completer<void>();
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/home/command-center', (_) => commandCenter())
        ..on('GET', '/home/my-work', (_) => myWork(<Map<String, Object?>>[]))
        ..answer('GET', _path, (HttpCall call) async {
          await slow.future;
          return FakeTransport.json(200, committeeWorkspace());
        });
      await _open(tester, server);

      expect(find.bySemanticsLabel('Đang tải số liệu của Ban chỉ đạo'), findsOneWidget);
      expect(find.text('41,20%'), findsNothing);

      slow.complete();
      await tester.pumpAndSettle();
      expect(find.text('41,20%'), findsOneWidget);
      expect(find.bySemanticsLabel('Đang tải số liệu của Ban chỉ đạo'), findsNothing);
    });

    testWidgets('empty: no figure has been loaded into the core yet, and the card says so once', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      await _open(tester, _healthy(workspace: committeeWorkspace(empty: true, figures: committeeFigures(unknown: true), province: committeeProvince(rag: 'NO_DATA', band: false, outlookReason: 'NO_DATA'))));

      expect(find.textContaining('Chưa có số liệu nào được nạp vào lõi dữ liệu'), findsOneWidget);
      expect(find.text('Bảng điều hành Ban chỉ đạo'), findsOneWidget);
      expect(find.text('Từ 1.000 tỷ đồng đến 1.100 tỷ đồng'), findsNothing);
      expect(find.byTooltip('Làm mới số liệu của Ban chỉ đạo'), findsOneWidget, reason: 'the head can look again');
    });

    testWidgets('error: the code is named, the home stays, and a retry reads once more', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final ScriptedServer server = _healthy()..refuse('GET', _path, 500, 'INTERNAL_ERROR');
      await _open(tester, server);

      expect(find.text('Chưa đọc được số liệu của Ban chỉ đạo (mã INTERNAL_ERROR). Các phần khác của trang vẫn đúng.'), findsOneWidget);
      expect(find.text('Tổng quan'), findsOneWidget);
      expect(find.text('Số liệu và công thức'), findsOneWidget, reason: 'the command center of the home is still there');
      expect(server.callsTo('GET', _path), hasLength(1));

      server.on('GET', _path, (_) => committeeWorkspace());
      await tester.tap(find.widgetWithText(OutlinedButton, 'Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('41,20%'), findsOneWidget);
      expect(find.textContaining('Chưa đọc được số liệu của Ban chỉ đạo'), findsNothing);
      expect(server.callsTo('GET', _path), hasLength(2));
    });

    testWidgets('error: an answer that is not the contract is named as such, never half a card', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final ScriptedServer server = _healthy(workspace: <String, Object?>{'as_of': '2026-10-31'});
      await _open(tester, server);

      expect(find.textContaining('mã CONTRACT_MISMATCH'), findsOneWidget);
      expect(find.text('41,20%'), findsNothing);
    });

    testWidgets('no connection: the card says it could not read, keeps no copy of a confidential screen, and retries on request', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final ScriptedServer server = _healthy();
      await _open(tester, server);
      expect(find.text('41,20%'), findsOneWidget);

      server.offline = true;
      await tester.tap(find.byTooltip('Làm mới số liệu của Ban chỉ đạo'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Chưa đọc được số liệu của Ban chỉ đạo'), findsOneWidget);
      expect(find.text('41,20%'), findsNothing, reason: 'the figures of the last read are not kept on screen as if they were current');
    });

    testWidgets('stale: a figure the server marks as old puts the marker on the card', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      await _open(tester, _healthy(workspace: committeeWorkspace(asOf: '2026-10-10', figures: committeeFigures(flags: <String>['STALE']))));

      expect(find.text('Số liệu đã cũ, có thể không còn phản ánh tình hình hiện tại.'), findsOneWidget);
      expect(find.text('Số liệu đến ngày 10/10/2026, năm 2026'), findsOneWidget);
      expect(find.text('Số liệu cũ'), findsNothing);
    });

    testWidgets('fresh figures carry no stale marker', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      await _open(tester, _healthy());

      expect(find.text('Số liệu đã cũ, có thể không còn phản ánh tình hình hiện tại.'), findsNothing);
    });
  });

  group('BAN-1 the card is only for the committee', () {
    for (final (int status, String code) in <(int, String)>[(403, 'SCOPE_DENIED'), (403, 'PERMISSION_DENIED'), (404, 'RESOURCE_NOT_FOUND')]) {
      testWidgets('a refusal of $status $code hides the card: no title, no retry, no figure, and the rest of the home is untouched', (WidgetTester tester) async {
        useDevice(tester, const Size(390, 6000));
        final ScriptedServer server = ScriptedServer()
          ..on('GET', '/home/command-center', (_) => commandCenter())
          ..on('GET', '/home/my-work', (_) => myWork(<Map<String, Object?>>[]))
          ..refuse('GET', _path, status, code);
        final ProviderContainer container = await _open(tester, server);

        expect(find.text('Bảng điều hành Ban chỉ đạo'), findsNothing);
        expect(find.textContaining('Ban chỉ đạo'), findsNothing);
        expect(find.byTooltip('Làm mới số liệu của Ban chỉ đạo'), findsNothing);
        expect(find.text('Số liệu và công thức'), findsOneWidget);
        expect(server.callsTo('GET', _path), hasLength(1));
        expect(container.read(committeeRefusalsProvider), <String>{'tenant-a/user-1'}, reason: 'the refusal is remembered for this person in this run');
      });
    }

    testWidgets('a person already refused in this run is not asked again', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final ScriptedServer server = _healthy();
      await _open(tester, server, overrides: <Override>[committeeRefusalsProvider.overrideWith(_SeededRefusals.new)]);

      expect(find.text('Bảng điều hành Ban chỉ đạo'), findsNothing);
      expect(server.callsTo('GET', _path), isEmpty);
    });

    testWidgets('another refusal of 403, such as a step-up, is an error with a retry and not a hidden card', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final ScriptedServer server = ScriptedServer()
        ..on('GET', '/home/command-center', (_) => commandCenter())
        ..on('GET', '/home/my-work', (_) => myWork(<Map<String, Object?>>[]))
        ..refuse('GET', _path, 403, 'MFA_REQUIRED');
      await _open(tester, server);

      expect(find.textContaining('mã MFA_REQUIRED'), findsOneWidget);
    });

    test('the permission and the refusals are the ones of the contract', () {
      expect(committeeReadPermission, 'committee.read');
    });
  });

  group('BAN-1 an audited read: once per opening, once per press, never on resume', () {
    testWidgets('resuming the application and scrolling do not read again; the refresh button reads once more', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 700));
      final ScriptedServer server = _healthy();
      await _open(tester, server);
      expect(server.callsTo('GET', _path), hasLength(1));

      // Scroll the card out of sight and back: the lazily built list keeps what it read.
      final Finder list = find.byType(Scrollable).first;
      await tester.drag(list, const Offset(0, -3000));
      await tester.pumpAndSettle();
      await tester.drag(list, const Offset(0, 3000));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', _path), hasLength(1), reason: 'scrolling does not read again');

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', _path), hasLength(1), reason: 'resuming does not read again');

      await tester.scrollUntilVisible(find.byTooltip('Làm mới số liệu của Ban chỉ đạo'), 200, scrollable: list);
      // Visible is not yet clear of the bottom navigation: bring the button to the middle of the view.
      await tester.ensureVisible(find.byTooltip('Làm mới số liệu của Ban chỉ đạo'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Làm mới số liệu của Ban chỉ đạo'));
      await tester.pumpAndSettle();
      expect(server.callsTo('GET', _path), hasLength(2), reason: 'a press is one read');
    });

    testWidgets('the read is a plain GET of the operation without a body', (WidgetTester tester) async {
      useDevice(tester, const Size(390, 6000));
      final ScriptedServer server = _healthy();
      await _open(tester, server);

      final HttpCall call = server.callsTo('GET', _path).single;
      expect(call.method, 'GET');
      expect(call.body, isNull);
      expect(call.url.query, isEmpty, reason: 'the phone asks for the whole province, with no filter');
    });
  });

  group('BAN-1 no simulation wording anywhere', () {
    test('no string of the table says simulation, demonstration or fake, in either language', () {
      for (final Map<String, String> table in <Map<String, String>>[dashboardStrings.vi, dashboardStrings.en]) {
        for (final MapEntry<String, String> entry in table.entries) {
          if (!entry.key.startsWith('mob.home.committee.')) continue;
          expect(_simulation.hasMatch(entry.value), isFalse, reason: '${entry.key}: ${entry.value}');
        }
      }
    });

    for (final String language in <String>['vi', 'en']) {
      testWidgets('nothing drawn on the card is a marker of a simulation ($language)', (WidgetTester tester) async {
        useDevice(tester, const Size(390, 6000));
        await _open(tester, _healthy(), locale: Locale(language));

        expect(_simulation.hasMatch(_allText(tester)), isFalse);
        for (final Widget widget in tester.widgetList<Widget>(find.byWidgetPredicate((Widget widget) => widget is IconButton))) {
          expect(_simulation.hasMatch((widget as IconButton).tooltip ?? ''), isFalse);
        }
      });
    }

    test('the sources of the card say nothing of a simulation either', () {
      // The files are read as bytes; the pattern is ASCII, so no decoding of the text is needed to find a word of it.
      for (final String path in <String>['lib/features/dashboard/committee_workspace.dart', 'lib/features/dashboard/widgets/committee_card.dart']) {
        final String source = String.fromCharCodes(File(path).readAsBytesSync());
        expect(RegExp(r'simulat|demonstrat|\bfake\b', caseSensitive: false).hasMatch(source), isFalse, reason: path);
      }
    });
  });

  group('BAN-1 the strings of the card', () {
    final Set<String> viKeys = <String>{for (final String key in dashboardStrings.vi.keys) if (key.startsWith('mob.home.committee.')) key};
    final Set<String> enKeys = <String>{for (final String key in dashboardStrings.en.keys) if (key.startsWith('mob.home.committee.')) key};

    test('both languages carry the same keys, each of the shape module.screen.action.state', () {
      expect(viKeys, isNotEmpty);
      expect(viKeys, enKeys);
      for (final String key in viKeys) {
        expect(isValidStringKey(key), isTrue, reason: key);
        expect(dashboardStrings.vi[key], isNotEmpty, reason: key);
        expect(dashboardStrings.en[key], isNotEmpty, reason: key);
      }
    });

    test('every key written as a literal in the card is declared, and every key declared for the card is used', () {
      final RegExp usage = RegExp(r"""\bt\(\s*'(mob\.home\.committee\.[^']+)'""");
      final Set<String> used = <String>{};
      for (final String path in <String>['lib/features/dashboard/widgets/committee_card.dart', 'lib/features/dashboard/committee_workspace.dart']) {
        for (final Match match in usage.allMatches(File(path).readAsStringSync())) {
          used.add(match.group(1)!);
        }
      }
      expect(used.difference(viKeys), isEmpty, reason: 'used but not declared');
      expect(viKeys.difference(used), isEmpty, reason: 'declared but not used');
    });
  });

  group('BAN-1 the reading of the answer', () {
    test('the top three by rank, the reasons without repeats, and a resolved alert dropped', () {
      final CommitteeWorkspace workspace = parseCommitteeWorkspace(committeeWorkspace())!;
      expect(workspace.attention.map((CommitteeAttention item) => item.code), <String>['DA-001', 'DA-002', 'DA-003']);
      expect(workspace.attention.first.reasons, <CommitteeReason>[CommitteeReason.delayed, CommitteeReason.stalled]);
      expect(workspace.attentionTotal, 7);
      expect(workspace.alerts.map((CommitteeAlert alert) => alert.type), <CommitteeAlertType>[CommitteeAlertType.provinceBehind, CommitteeAlertType.unitNotReporting]);
      expect(workspace.alerts.first.severity, CommitteeSeverity.urgent);
      expect(workspace.figure('COMMITTEE_DISBURSEMENT_RATE')!.displayValue, '41.20');
      expect(workspace.figure('COMMITTEE_DISBURSEMENT_RATE')!.info!.name, kRateName);
      expect(workspace.isStale, isFalse);
    });

    test('a figure with no value stays without one, with its reason', () {
      final CommitteeWorkspace workspace = parseCommitteeWorkspace(committeeWorkspace(figures: committeeFigures(unknown: true, nullReason: 'ZERO_DENOMINATOR')))!;
      final CommitteeFigure rate = workspace.figure('COMMITTEE_DISBURSEMENT_RATE')!;
      expect(rate.value, isNull);
      expect(rate.hasValue, isFalse);
      expect(rate.nullReason, 'ZERO_DENOMINATOR');
    });

    test('an answer without the day, the year, the feed or the province, or with a colour or an alert it does not know, is refused as a whole', () {
      expect(parseCommitteeWorkspace(null), isNull);
      for (final String missing in <String>['as_of', 'fiscal_year', 'feed', 'province']) {
        expect(parseCommitteeWorkspace(<String, Object?>{...committeeWorkspace()}..remove(missing)), isNull, reason: missing);
      }
      expect(parseCommitteeWorkspace(committeeWorkspace(province: <String, Object?>{...committeeProvince(), 'rag': 'PURPLE'})), isNull);
      final CommitteeWorkspace dropped = parseCommitteeWorkspace(committeeWorkspace(alerts: <Map<String, Object?>>[committeeAlert('x', 'COMMITTEE_NEW_KIND', 'URGENT'), committeeAlert('y', 'COMMITTEE_PROVINCE_BEHIND', 'LOUD')]))!;
      expect(dropped.alerts, isEmpty, reason: 'an alert of a kind or severity the phone does not know is not guessed at');
    });

    test('a figure with an unknown unit or no metric is not shown', () {
      final List<Map<String, Object?>> figures = <Map<String, Object?>>[
        <String, Object?>{...committeeFigure('COMMITTEE_PLAN_TOTAL', 'x', value: '1', unit: 'VND'), 'unit': 'FURLONG'},
        <String, Object?>{...committeeFigure('', 'x', value: '1')},
        committeeFigure('COMMITTEE_DISBURSED', 'x', value: '5', unit: 'VND'),
      ];
      final CommitteeWorkspace workspace = parseCommitteeWorkspace(committeeWorkspace(figures: figures))!;
      expect(workspace.figures.map((CommitteeFigure figure) => figure.metricCode), <String>['COMMITTEE_DISBURSED']);
    });
  });
}
