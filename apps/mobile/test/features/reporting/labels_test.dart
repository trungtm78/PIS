import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/features/read_support/read_support_strings.dart';
import 'package:machvon_mobile/features/reporting/labels.dart';
import 'package:machvon_mobile/features/reporting/model/report_cells.dart';
import 'package:machvon_mobile/features/reporting/model/report_review.dart';
import 'package:machvon_mobile/features/reporting/reporting_strings.dart';

import '../../support/widget_host.dart';

/// Runs [check] with a context in the given language and the strings of the weekly report.
Future<void> inLanguage(WidgetTester tester, String language, void Function(BuildContext context) check) async {
  late BuildContext captured;
  await tester.pumpWidget(hostWidget(Builder(builder: (BuildContext context) {
    captured = context;
    return const SizedBox();
  }), locale: Locale(language), tables: const [reportingStrings, readSupportStrings]));
  check(captured);
}

Finding finding(String code, String field, [Map<String, String?> values = const <String, String?>{}]) => Finding(code: code, field: field, severity: Severity.error, values: values);

void main() {
  group('the words of the weekly report are the web\'s, in both languages', () {
    testWidgets('each cell, level, basis, status and period state has its own words', (WidgetTester tester) async {
      for (final String language in <String>['vi', 'en']) {
        await inLanguage(tester, language, (BuildContext context) {
          final Set<String> cells = <String>{for (final CellKey key in kCells) cellLabel(context, key)};
          expect(cells, hasLength(6));
          expect(cells.where((String text) => text.startsWith('mob.')), isEmpty);
          expect(levelLabel(context, 'CENTRAL'), isNot(levelLabel(context, 'LOCAL')));
          expect(<String>{for (final String basis in kBases) basisLabel(context, basis)}, hasLength(3));
          final List<String> statuses = <String>['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'];
          expect(<String>{for (final String status in statuses) reportStatusLabel(context, status)}, hasLength(8));
          expect(reportStatusLabel(context, 'SOMETHING_NEW'), 'SOMETHING_NEW', reason: 'a status this version does not know is shown as it is');
          expect(<String>{for (final String status in <String>['OPEN', 'SOFT_CLOSED', 'LOCKED']) periodStatusLabel(context, status)}, hasLength(3));
          expect(periodStatusLabel(context, null), isEmpty);
          expect(periodStatusLabel(context, 'OTHER'), isEmpty);
        });
      }
      await inLanguage(tester, 'vi', (BuildContext context) {
        expect(cellLabel(context, const CellKey('CURRENT_YEAR', 'CENTRAL')), 'Vốn năm NSTW');
        expect(cellLabel(context, const CellKey('OTHER', 'LOCAL')), 'Vốn khác NSĐP');
        expect(basisLabel(context, 'YTD'), 'Lũy kế từ đầu năm');
        expect(reportStatusLabel(context, 'SUBMITTED'), 'Đã gửi');
      });
    });

    testWidgets('an amount of millions is signed, exact, and in the language of the interface', (WidgetTester tester) async {
      await inLanguage(tester, 'vi', (BuildContext context) {
        expect(signedMillionsLabel(context, '50000000'), '+50 triệu đồng');
        expect(signedMillionsLabel(context, '-30500000'), '-30,5 triệu đồng');
        expect(signedMillionsLabel(context, null), 'Chưa có số liệu');
      });
      await inLanguage(tester, 'en', (BuildContext context) {
        expect(signedMillionsLabel(context, '-30500000'), '-30.5 million dong');
      });
    });
  });

  group('TK-MOB-011-4 a refusal of the server is told in the words of the user, from its code alone', () {
    test('the codes the weekly report meets are mapped; any other is the general message', () {
      final Map<String, ReportProblem> expected = <String, ReportProblem>{
        'DRAFT_EXISTS': ReportProblem.draftExists,
        'REPORT_STATE_INVALID': ReportProblem.reportExists,
        'PERIOD_LOCKED': ReportProblem.periodLocked,
        'PLAN_VERSION_NOT_EFFECTIVE': ReportProblem.planNotEffective,
        'PROJECT_STAGE_INVALID': ReportProblem.stageInvalid,
        'SUBSET_EXCEEDS_PARENT': ReportProblem.subsetExceeds,
        'REVISION_IMMUTABLE': ReportProblem.immutable,
        'VERSION_CONFLICT': ReportProblem.versionConflict,
        'DRAFT_VERSION_CONFLICT': ReportProblem.versionConflict,
        'SCOPE_DENIED': ReportProblem.scopeDenied,
        'PERMISSION_DENIED': ReportProblem.scopeDenied,
        'LICENSE_EXPIRED': ReportProblem.licenseExpired,
        'SESSION_EXPIRED': ReportProblem.sessionEnded,
        'VALIDATION_FAILED': ReportProblem.validation,
        'INVALID_REQUEST': ReportProblem.validation,
        'FIELD_NOT_ALLOWED': ReportProblem.validation,
        'NEGATIVE_DELTA_EXPLANATION_REQUIRED': ReportProblem.validation,
        'RESOURCE_NOT_FOUND': ReportProblem.notFound,
        'IDEMPOTENCY_CONFLICT': ReportProblem.idempotency,
      };
      for (final MapEntry<String, ReportProblem> entry in expected.entries) {
        expect(problemOfCode(entry.key), entry.value, reason: entry.key);
        expect(problemOf(ApiError(status: 409, code: entry.key, correlationId: 'c')), entry.value, reason: entry.key);
      }
      expect(problemOfCode('SOMETHING_ELSE'), ReportProblem.general);
      expect(problemOfCode(null), ReportProblem.general);
      expect(problemOf(StateError('x')), ReportProblem.general, reason: 'the text of a failure is never looked at');
    });

    testWidgets('every problem has its words in both languages and none is the key itself', (WidgetTester tester) async {
      for (final String language in <String>['vi', 'en']) {
        await inLanguage(tester, language, (BuildContext context) {
          final Set<String> texts = <String>{for (final ReportProblem problem in ReportProblem.values) problemMessage(context, problem)};
          expect(texts, hasLength(ReportProblem.values.length));
          expect(texts.where((String text) => text.startsWith('mob.')), isEmpty);
        });
      }
    });
  });

  group('every finding of the review reads as a sentence with its figures', () {
    testWidgets('the findings of the phone and of the server, in both languages', (WidgetTester tester) async {
      final List<Finding> findings = <Finding>[
        finding('CELL_REQUIRED', 'funding_lines[0].cumulative_vnd'),
        finding('CELL_INVALID', 'funding_lines[1].cumulative_vnd'),
        finding('CTMTQG_NOT_ALLOWED', 'funding_lines[4].ctmtqg_subset_vnd'),
        finding('SUBSET_EXCEEDS_PARENT', 'funding_lines[0].ctmtqg_subset_vnd', <String, String?>{'subset_vnd': '2000', 'parent_vnd': '1000'}),
        finding('SUBSET_EXCEEDS_PARENT', 'funding_lines[0].next_month_ctmtqg_subset_vnd', <String, String?>{'subset_vnd': '2000', 'parent_vnd': '1000'}),
        finding('NEGATIVE_DELTA_EXPLANATION_REQUIRED', 'negative_delta_explanation'),
        finding('EXPLANATION_INVALID', 'negative_delta_explanation'),
        finding('VOLUME_INVALID', 'progress.construction_vnd'),
        finding('PERCENT_INVALID', 'progress.physical_progress_pct'),
        finding('PERCENT_RANGE', 'progress.physical_progress_pct'),
        finding('NARRATIVE_TOO_LONG', 'narrative.results'),
        finding('VALIDATION_FAILED', 'progress'),
        finding('VALIDATION_FAILED', 'narrative.causes_text'),
        finding('REVISION_IMMUTABLE', 'status'),
        finding('PERIOD_LOCKED', 'period'),
        finding('PLAN_VERSION_NOT_EFFECTIVE', 'plan_version'),
        finding('NEGATIVE_DELTA', 'negative_delta_explanation', <String, String?>{'delta_vnd': '-5000'}),
        finding('VOLUME_EXCEEDS_ALLOCATION', 'progress.construction_vnd', <String, String?>{'construction_vnd': '2000', 'allocated_vnd': '1000', 'ratio_pct': '200.0'}),
        finding('VOLUME_EXCEEDS_ALLOCATION', 'progress.construction_vnd', <String, String?>{'construction_vnd': '2000', 'ratio_pct': null}),
        finding('TREASURY_GAP', 'funding_lines', <String, String?>{'reported_vnd': '2000', 'treasury_vnd': '1000', 'gap_pct': '100.0'}),
        finding('TREASURY_GAP', 'funding_lines', <String, String?>{'reported_vnd': '2000', 'gap_pct': null}),
        finding('NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT', 'funding_lines', <String, String?>{'remaining_vnd': '3000'}),
        finding('SOMETHING_NEW', 'x'),
      ];
      for (final String language in <String>['vi', 'en']) {
        await inLanguage(tester, language, (BuildContext context) {
          final List<String> texts = <String>[for (final Finding f in findings) findingMessage(context, f)];
          expect(texts.where((String text) => text.startsWith('mob.') || text.contains('{')), isEmpty, reason: 'every sentence is written and every figure is filled in');
          expect(texts.toSet().length, greaterThanOrEqualTo(findings.length - 1));
        });
      }
      await inLanguage(tester, 'vi', (BuildContext context) {
        expect(findingMessage(context, findings[3]), 'CTMTQG 2.000 đồng lớn hơn 1.000 đồng của ô Vốn năm NSTW.');
        expect(findingMessage(context, findings[4]), contains('đăng ký tháng sau 2.000 đồng'));
        expect(findingMessage(context, findings[17]), 'Khối lượng thi công 2.000 đồng bằng 200.0% vốn đã giao (1.000 đồng).');
        expect(findingMessage(context, findings[18]), 'Khối lượng thi công 2.000 đồng trong khi chưa có vốn giao.');
        expect(findingMessage(context, findings[19]), 'Lũy kế báo cáo 2.000 đồng lệch 100.0% so với 1.000 đồng Kho bạc đã thanh toán.');
        expect(findingMessage(context, findings[20]), contains('Kho bạc chưa thanh toán khoản nào'));
        expect(findingMessage(context, findings[22]), 'Mã SOMETHING_NEW.');
      });
      await inLanguage(tester, 'en', (BuildContext context) {
        expect(findingMessage(context, findings[3]), 'CTMTQG 2,000 dong is larger than the 1,000 dong of the cell Year plan, central budget.');
      });
    });

    testWidgets('the short text beside a box exists for the findings that are about one box and for no other', (WidgetTester tester) async {
      await inLanguage(tester, 'vi', (BuildContext context) {
        for (final String code in <String>['CELL_REQUIRED', 'CELL_INVALID', 'VOLUME_INVALID', 'SUBSET_EXCEEDS_PARENT', 'CTMTQG_NOT_ALLOWED', 'PERCENT_INVALID', 'PERCENT_RANGE', 'EXPLANATION_INVALID', 'NARRATIVE_TOO_LONG']) {
          final String? text = fieldError(context, finding(code, 'x'));
          expect(text, isNotNull, reason: code);
          expect(text!.startsWith('mob.'), isFalse, reason: code);
        }
        expect(fieldError(context, finding('VALIDATION_FAILED', 'progress')), isNull);
        expect(fieldError(context, null), isNull);
      });
    });
  });
}
